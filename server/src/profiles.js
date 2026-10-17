/**
 * Профиль клиента — единица учёта баллов. Карты (одна виртуальная + одна пластиковая) лишь указывают на профиль.
 *
 * ID профиля неизменный (users.id, показывается как 1000000 + id), телефон можно сменить (сам клиент — по СМС на новый номер,
 * или поддержка). Профиль появляется: при регистрации в приложении; при активации пластика на кассе по СМС;
 * «гостевой» (без телефона) — при первой покупке по неактивированному пластику.
 */
import crypto from 'node:crypto';
import { tx, one, all, run } from './db.js';
import { HttpError, normalizePhone, nowIso } from './util.js';
import { bindPhysicalCard, findCard, getAccount, ensureCard, profileId } from './loyalty.js';

export { profileId };
const BASE = 1000000;
export const userIdFromProfile = (pid) => {
  const n = Number(String(pid ?? '').replace(/\D/g, ''));
  return Number.isInteger(n) && n > BASE ? n - BASE : null;
};
const maskPhone = (p) => (p ? `+${p[0]} ${p.slice(1, 4)} ***-**-${p.slice(-2)}` : null);
const hmac = (cfg, s) => crypto.createHmac('sha256', cfg.secret).update(s).digest('hex');

/* ---------------- коды подтверждения (смена номера, активация на кассе) ---------------- */

/** Отправляет 4-значный код на телефон для операции purpose над subject. Лимиты общие со входом: раз в минуту, 5 в час на номер. */
export async function startVerification(db, cfg, sms, { purpose, subject, phone, text }) {
  const now = Date.now();
  const prev = one(db, 'SELECT * FROM verifications WHERE purpose=? AND subject=?', purpose, subject);
  if (prev && prev.phone === phone && now - prev.sent_at < cfg.otpResendSec * 1000) throw new HttpError(429, 'resend_too_soon', 'Повторный код можно запросить позже');
  if (one(db, 'SELECT COUNT(*) c FROM otp_log WHERE phone=? AND ts>?', phone, now - 3600_000).c >= cfg.otpPerHour) {
    throw new HttpError(429, 'too_many_codes', 'Слишком много запросов кода, попробуйте позже');
  }
  const code = String(crypto.randomInt(0, 10000)).padStart(4, '0');
  tx(db, () => {
    run(db, `INSERT INTO verifications(purpose,subject,phone,code_hash,expires_at,attempts,sent_at) VALUES(?,?,?,?,?,0,?)
      ON CONFLICT(purpose,subject) DO UPDATE SET phone=excluded.phone, code_hash=excluded.code_hash, expires_at=excluded.expires_at, attempts=0, sent_at=excluded.sent_at`,
    purpose, subject, phone, hmac(cfg, `${purpose}:${subject}:${phone}:${code}`), now + cfg.otpTtlSec * 1000, now);
    run(db, 'INSERT INTO otp_log(phone,ts) VALUES(?,?)', phone, now);
  });
  try { await sms.send(phone, text(code)); }
  catch { run(db, 'DELETE FROM verifications WHERE purpose=? AND subject=?', purpose, subject); throw new HttpError(502, 'sms_failed', 'Не удалось отправить СМС'); }
}

/** Проверяет код; при успехе удаляет его. Неудачная попытка сохраняется (поэтому без внешней транзакции). */
export function checkVerification(db, cfg, { purpose, subject, phone, code }) {
  const v = one(db, 'SELECT * FROM verifications WHERE purpose=? AND subject=?', purpose, subject);
  if (!v || v.phone !== phone || v.expires_at < Date.now()) throw new HttpError(400, 'code_expired', 'Код устарел, запросите новый');
  if (v.attempts >= cfg.otpMaxAttempts) throw new HttpError(429, 'too_many_attempts', 'Слишком много попыток, запросите новый код');
  const ok = /^\d{4}$/.test(String(code ?? '')) &&
    crypto.timingSafeEqual(Buffer.from(hmac(cfg, `${purpose}:${subject}:${phone}:${code}`)), Buffer.from(v.code_hash));
  if (!ok) {
    run(db, 'UPDATE verifications SET attempts=attempts+1 WHERE purpose=? AND subject=?', purpose, subject);
    throw new HttpError(400, 'wrong_code', 'Неверный код');
  }
  run(db, 'DELETE FROM verifications WHERE purpose=? AND subject=?', purpose, subject);
}

/* ---------------- профиль ---------------- */

const activeByPhone = (db, phone) => one(db, 'SELECT * FROM users WHERE phone=? AND deleted_at IS NULL', phone);

/**
 * Смена телефона профиля (после проверки кода на новом номере или поддержкой). Номер, занятый другим профилем, — только через слияние.
 * dropSessions: поддержка меняет номер, потому что старый утерян, — все входы по старому номеру завершаются.
 */
export function changePhone(db, userId, rawPhone, { dropSessions = false } = {}) {
  const phone = normalizePhone(rawPhone);
  return tx(db, () => {
    const other = activeByPhone(db, phone);
    if (other && other.id !== userId) throw new HttpError(409, 'phone_taken', 'Этот номер уже привязан к другому профилю. Обратитесь в поддержку: профили можно объединить');
    const u = one(db, 'SELECT * FROM users WHERE id=? AND deleted_at IS NULL', userId);
    if (!u) throw new HttpError(404, 'no_user', 'Профиль не найден');
    run(db, 'UPDATE users SET phone=?, stub=0 WHERE id=?', phone, userId);
    if (dropSessions) run(db, 'DELETE FROM sessions WHERE user_id=?', userId);
    return { profileId: profileId(userId), phone: maskPhone(phone) };
  });
}

/**
 * Объединение профилей (поддержка): баллы и карты source переходят в target, source закрывается.
 * Правило 1+1: если у target уже есть карта того же типа, карта source блокируется (виртуальная — закрывается).
 */
export function mergeProfiles(db, targetId, sourceId) {
  if (targetId === sourceId) throw new HttpError(400, 'same_profile', 'Это один и тот же профиль');
  return tx(db, () => {
    const t = one(db, 'SELECT * FROM users WHERE id=? AND deleted_at IS NULL', targetId);
    const s = one(db, 'SELECT * FROM users WHERE id=? AND deleted_at IS NULL', sourceId);
    if (!t || !s) throw new HttpError(404, 'no_user', 'Профиль не найден');
    const sa = one(db, 'SELECT balance, held FROM accounts WHERE user_id=?', sourceId);
    if (sa.held > 0) throw new HttpError(409, 'has_holds', 'У объединяемого профиля есть незавершённое списание, повторите позже');
    const moved = [];
    for (const c of all(db, "SELECT * FROM cards WHERE user_id=? AND status='active'", sourceId)) {
      const has = one(db, "SELECT 1 FROM cards WHERE user_id=? AND status='active' AND kind=?", targetId, c.kind);
      if (has) run(db, 'UPDATE cards SET status=? WHERE number=?', c.kind === 'virtual' ? 'closed' : 'blocked', c.number);
      else { run(db, 'UPDATE cards SET user_id=? WHERE number=?', targetId, c.number); moved.push(c.number); }
    }
    if (sa.balance > 0) {
      const t0 = nowIso();
      run(db, "INSERT INTO ledger(user_id,point_id,type,points,idem_key,meta,created_at) VALUES(?,'admin','ADJUST',?,?,?,?)",
        sourceId, -sa.balance, `merge-out:${sourceId}:${targetId}`, JSON.stringify({ reason: 'profile_merge', to: targetId }), t0);
      run(db, "INSERT INTO ledger(user_id,point_id,type,points,idem_key,meta,created_at) VALUES(?,'admin','ADJUST',?,?,?,?)",
        targetId, sa.balance, `merge-in:${sourceId}:${targetId}`, JSON.stringify({ reason: 'profile_merge', from: sourceId }), t0);
      run(db, 'UPDATE accounts SET balance=balance-? WHERE user_id=?', sa.balance, sourceId);
      run(db, 'UPDATE accounts SET balance=balance+? WHERE user_id=?', sa.balance, targetId);
    }
    run(db, 'UPDATE users SET deleted_at=?, merged_into=?, phone=NULL WHERE id=?', nowIso(), targetId, sourceId);
    if (!t.phone && s.phone) run(db, 'UPDATE users SET phone=?, stub=0 WHERE id=?', s.phone, targetId);
    run(db, 'DELETE FROM sessions WHERE user_id=?', sourceId);
    return { profileId: profileId(targetId), transferred: sa.balance, movedCards: moved };
  });
}

/** Отвязать пластиковую карту от профиля (ошибочная привязка). Баллы остаются в профиле, карта снова свободна. */
export function unbindCard(db, number) {
  const c = findCard(db, number);
  if (!c || c.kind !== 'physical' || !c.user_id) throw new HttpError(404, 'card_not_found', 'Привязанная пластиковая карта не найдена');
  const u = one(db, 'SELECT stub FROM users WHERE id=?', c.user_id);
  if (u?.stub) throw new HttpError(409, 'not_bound', 'Карта не привязана к телефону');
  run(db, "UPDATE cards SET status='free', user_id=NULL, bound_at=NULL WHERE number=?", c.number);
  return { card: c.number, status: 'free' };
}

/* ---------------- касса: состояние карты, поиск по телефону, активация пластика ---------------- */

/** Что знает сервер о карте: для экрана кассира и решения «предложить активацию». */
export function cardStatus(db, number) {
  const c = findCard(db, String(number ?? '').trim());
  if (!c) return { known: false, state: 'unknown' };
  const base = { known: true, card: c.number, kind: c.kind };
  if (c.status === 'free') return { ...base, state: 'free' };                  // пластик ещё не использовался
  if (c.status !== 'active') return { ...base, state: c.status };              // blocked | closed
  const u = one(db, 'SELECT * FROM users WHERE id=?', c.user_id);
  const acc = getAccount(db, u.id);
  return { ...base, state: u.stub ? 'guest' : 'bound', profileId: profileId(u.id), name: u.name || null, phone: maskPhone(u.phone),
    balance: acc.balance, available: acc.available };
}

/** Поиск карты по телефону (для кассы): пластик, если есть, иначе виртуальная. */
export function cardByPhone(db, cfg, rawPhone) {
  const u = activeByPhone(db, normalizePhone(rawPhone));
  if (!u) throw new HttpError(404, 'not_found', 'Клиент с таким телефоном не найден');
  const phys = one(db, "SELECT number FROM cards WHERE user_id=? AND status='active' AND kind='physical'", u.id);
  const card = phys || ensureCard(db, cfg, u.id);
  if (!card) throw new HttpError(404, 'no_card', 'У клиента ещё нет карты');
  return { ...cardStatus(db, card.number) };
}

/** Активация пластика на кассе, шаг 1: проверяем карту, отправляем код на телефон покупателя. */
export async function activateStart(db, cfg, sms, number, rawPhone) {
  const phone = normalizePhone(rawPhone);
  const st = cardStatus(db, number);
  if (!st.known || st.kind !== 'physical') throw new HttpError(404, 'card_not_found', 'Это не пластиковая карта ДЕЯ');
  if (st.state === 'bound') throw new HttpError(409, 'card_bound', 'Карта уже активирована');
  if (!['free', 'guest'].includes(st.state)) throw new HttpError(409, 'card_' + st.state, 'Карта заблокирована');
  const existing = activeByPhone(db, phone);
  const other = existing && one(db, "SELECT number FROM cards WHERE user_id=? AND status='active' AND kind='physical'", existing.id);
  await startVerification(db, cfg, sms, { purpose: 'pos_activate', subject: st.card, phone,
    text: (code) => `Код ${code} для активации карты ДЕЯ. Сообщая код кассиру, вы принимаете правила программы и даёте согласие на обработку персональных данных: ${cfg.publicUrl}/legal/rules.html` });
  return { sent: true, existingProfile: !!existing, replaces: other ? '****' + other.number.slice(-4) : null };
}

/**
 * Шаг 2: код верный → карта привязана к профилю телефона. Нет профиля — профилем становится гостевой счёт карты
 * (ID профиля сохраняется) или создаётся новый. Есть профиль — баллы карты переносятся в него, прежний пластик блокируется.
 * Согласия фиксируются с каналом «касса, СМС-код».
 */
export function activateConfirm(db, cfg, number, rawPhone, code, ip) {
  const phone = normalizePhone(rawPhone);
  const card = findCard(db, String(number ?? '').trim());
  if (!card) throw new HttpError(404, 'card_not_found', 'Карта не найдена');
  checkVerification(db, cfg, { purpose: 'pos_activate', subject: card.number, phone, code });
  return tx(db, () => {
    const existing = activeByPhone(db, phone);
    let userId, transferred = 0, replaced = null;
    if (existing) {
      const r = bindPhysicalCard(db, cfg, existing.id, card.number, null, true, { skipCode: true });
      userId = existing.id; transferred = r.transferred; replaced = r.replaced;
    } else {
      const t = nowIso();
      if (card.user_id) {          // гостевой счёт становится профилем
        userId = card.user_id;
        run(db, 'UPDATE users SET phone=?, stub=0, consent_at=? WHERE id=?', phone, t, userId);
      } else {
        userId = Number(run(db, 'INSERT INTO users(phone,consent_at,created_at) VALUES(?,?,?)', phone, t, t).lastInsertRowid);
        run(db, 'INSERT INTO accounts(user_id) VALUES(?)', userId);
      }
      run(db, "UPDATE cards SET user_id=?, status='active', bound_at=? WHERE number=?", userId, t, card.number);
      for (const kind of ['pd', 'rules']) {
        run(db, 'INSERT INTO consents(user_id,kind,version,granted,ip,created_at,channel) VALUES(?,?,?,1,?,?,?)', userId, kind, cfg.docsVersion, ip ?? null, t, 'pos_sms');
      }
    }
    return { profileId: profileId(userId), transferred, replaced: replaced ? '****' + replaced.slice(-4) : null, balance: getAccount(db, userId).balance };
  });
}
