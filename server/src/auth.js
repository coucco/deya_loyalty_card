import crypto from 'node:crypto';
import { tx, one, run } from './db.js';
import { HttpError, normalizePhone, sha256, randomToken, nowIso } from './util.js';
import { createUserWithCard } from './loyalty.js';

const hmac = (cfg, s) => crypto.createHmac('sha256', cfg.secret).update(s).digest('hex');

export async function requestOtp(db, cfg, sms, rawPhone) {
  const phone = normalizePhone(rawPhone);
  const now = Date.now();
  const existing = one(db, 'SELECT * FROM otp WHERE phone=?', phone);
  if (existing && now - existing.sent_at < cfg.otpResendSec * 1000) {
    throw new HttpError(429, 'resend_too_soon', 'Повторный код можно запросить позже');
  }
  const hour = one(db, 'SELECT COUNT(*) c FROM otp_log WHERE phone=? AND ts>?', phone, now - 3600_000).c;
  if (hour >= cfg.otpPerHour) throw new HttpError(429, 'too_many_codes', 'Слишком много запросов кода, попробуйте позже');
  const code = String(crypto.randomInt(0, 10000)).padStart(4, '0');
  tx(db, () => {
    run(db, 'INSERT INTO otp(phone,code_hash,expires_at,attempts,sent_at) VALUES(?,?,?,0,?) ON CONFLICT(phone) DO UPDATE SET code_hash=excluded.code_hash, expires_at=excluded.expires_at, attempts=0, sent_at=excluded.sent_at',
      phone, hmac(cfg, phone + ':' + code), now + cfg.otpTtlSec * 1000, now);
    run(db, 'INSERT INTO otp_log(phone,ts) VALUES(?,?)', phone, now);
    run(db, 'DELETE FROM otp_log WHERE ts<?', now - 86400_000);
  });
  try { await sms.send(phone, `Код входа в Дея: ${code}`); }
  catch (e) { run(db, 'DELETE FROM otp WHERE phone=?', phone); throw new HttpError(502, 'sms_failed', 'Не удалось отправить код'); }
  return { phone, resendInSec: cfg.otpResendSec };
}

/**
 * Согласия при регистрации: pd (обработка ПДн) и rules (правила программы) обязательны, marketing (рассылки) — по желанию.
 * Старые клиенты присылают consent:true — это pd+rules.
 */
export function normalizeConsents(body) {
  const c = body && typeof body.consents === 'object' && body.consents ? body.consents : {};
  const legacy = body?.consent === true;
  return { pd: c.pd === true || legacy, rules: c.rules === true || legacy, marketing: c.marketing === true };
}

/** Запись в журнал согласий (только добавление) и отметка в профиле. */
export function recordConsent(db, cfg, userId, kind, granted, ip, channel = 'app') {
  const t = nowIso();
  run(db, 'INSERT INTO consents(user_id,kind,version,granted,ip,created_at,channel) VALUES(?,?,?,?,?,?,?)', userId, kind, cfg.docsVersion, granted ? 1 : 0, ip ?? null, t, channel);
  if (kind === 'marketing') run(db, 'UPDATE users SET marketing_at=? WHERE id=?', granted ? t : null, userId);
}

export function verifyOtp(db, cfg, rawPhone, code, consents, ip) {
  const r = verifyOtpInner(db, cfg, rawPhone, code, consents, ip);
  if (r.fail) throw new HttpError(400, 'wrong_code', 'Неверный код');
  return r;
}

function verifyOtpInner(db, cfg, rawPhone, code, consents, ip) {
  const phone = normalizePhone(rawPhone);
  return tx(db, () => {
    const o = one(db, 'SELECT * FROM otp WHERE phone=?', phone);
    if (!o || o.expires_at < Date.now()) throw new HttpError(400, 'code_expired', 'Код устарел, запросите новый');
    if (o.attempts >= cfg.otpMaxAttempts) throw new HttpError(429, 'too_many_attempts', 'Слишком много попыток, запросите новый код');
    const ok = typeof code === 'string' && /^\d{4}$/.test(code) &&
      crypto.timingSafeEqual(Buffer.from(hmac(cfg, phone + ':' + code)), Buffer.from(o.code_hash));
    if (!ok) {
      run(db, 'UPDATE otp SET attempts=attempts+1 WHERE phone=?', phone);
      // счётчик попыток должен сохраниться, поэтому ошибка бросается снаружи tx
      return { fail: true };
    }
    run(db, 'DELETE FROM otp WHERE phone=?', phone);
    let user = one(db, 'SELECT * FROM users WHERE phone=? AND deleted_at IS NULL', phone);
    let isNew = false;
    if (!user) {
      if (!consents.pd || !consents.rules) throw new HttpError(400, 'consent_required', 'Нужно согласие на обработку персональных данных и с правилами программы');
      createUserWithCard(db, cfg, phone, true);
      user = one(db, 'SELECT * FROM users WHERE phone=?', phone);
      recordConsent(db, cfg, user.id, 'pd', true, ip);
      recordConsent(db, cfg, user.id, 'rules', true, ip);
      recordConsent(db, cfg, user.id, 'marketing', consents.marketing, ip);
      isNew = true;
    }
    const token = randomToken();
    run(db, 'INSERT INTO sessions(token_hash,user_id,expires_at,created_at) VALUES(?,?,?,?)',
      sha256(token), user.id, Date.now() + cfg.sessionDays * 86400_000, Date.now());
    return { token, isNew };
  });
}

export function authUser(db, cfg, token) {
  if (!token) throw new HttpError(401, 'unauthorized', 'Нужен вход');
  const s = one(db, 'SELECT * FROM sessions WHERE token_hash=?', sha256(token));
  if (!s || s.expires_at < Date.now()) throw new HttpError(401, 'unauthorized', 'Сессия истекла');
  const u = one(db, 'SELECT * FROM users WHERE id=? AND deleted_at IS NULL', s.user_id);
  if (!u) throw new HttpError(401, 'unauthorized', 'Нужен вход');
  const fresh = Date.now() + cfg.sessionDays * 86400_000;
  if (fresh - s.expires_at > 86400_000) run(db, 'UPDATE sessions SET expires_at=? WHERE token_hash=?', fresh, s.token_hash);
  return u;
}

export function logout(db, token) { run(db, 'DELETE FROM sessions WHERE token_hash=?', sha256(token)); }
