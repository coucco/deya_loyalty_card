import crypto from 'node:crypto';
import { openDb, one, all, run } from './db.js';
import { Router, createServer, makeLimiter } from './http.js';
import { HttpError, normalizePhone, sha256, tsEq, parseKop, formatKop, randomToken, nowIso } from './util.js';
import * as L from './loyalty.js';
import * as A from './auth.js';
import { makeSms } from './sms.js';
import { metrics } from './analytics.js';
import * as P from './profiles.js';
import { scheduleBackups, pruneAudit } from './maintenance.js';

/** QR в приложении. Единственное место, где решается, что именно зашито в QR (режим static: номер карты). */
export const qrPayload = (card) => (card ? card.number : null);

const bearer = (req) => {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
};
const maskPhone = (p) => (p ? `+${p[0]} ${p.slice(1, 4)} ***-**-${p.slice(-2)}` : null);
const audit = (db, actor, action, detail) => run(db, 'INSERT INTO audit(actor,action,detail,created_at) VALUES(?,?,?,?)', actor, action, detail ? JSON.stringify(detail) : null, nowIso());

export function buildApp(cfg, { log = console, sms } = {}) {
  cfg.secret = cfg.secret || process.env.APP_SECRET || (cfg.isProd ? '' : crypto.randomBytes(16).toString('hex'));
  if (!cfg.secret) throw new Error('В production нужен APP_SECRET');
  const db = openDb(cfg.dbFile);
  L.seedPoints(db, process.env.SEED_DEMO === '1' || !cfg.isProd);
  const smsSender = sms || makeSms(cfg, log);
  const router = new Router();
  const authLimit = makeLimiter(30);
  const apiLimit = makeLimiter(cfg.rateLimitPerMin);
  const bindLimit = makeLimiter(10);   // подбор кода активации пластиковой карты

  /* ---- проверка ключей ---- */
  const pointAuth = (req) => {
    const p = pointAuthInner(req); req.actor = 'point:' + p.id; return p;
  };
  const pointAuthInner = (req) => {
    const token = bearer(req);
    if (!token) throw new HttpError(401, 'unauthorized', 'Нужен ключ доступа');
    const p = one(db, 'SELECT * FROM points WHERE api_key_hash=?', sha256(token));
    if (!p) throw new HttpError(401, 'unauthorized', 'Неверный ключ доступа');
    const claimed = req.headers['x-point-id'];
    if (claimed && claimed !== p.id) throw new HttpError(403, 'point_mismatch', 'Ключ не от этой точки');
    return p;
  };
  const adminAuth = (req) => { if (!cfg.adminToken || !tsEq(bearer(req), cfg.adminToken)) throw new HttpError(401, 'unauthorized', 'Нужен токен администратора'); req.actor = 'admin'; };
  const userAuth = (req) => { const u = A.authUser(db, cfg, bearer(req)); req.actor = 'user:' + u.id; return u; };
  const phoneLimit = makeLimiter(10);

  router.add('GET', '/healthz', () => { one(db, 'SELECT 1'); return { ok: true }; });

  /* ================= публичное / клиент ================= */
  router.add('POST', '/api/auth/request-code', async ({ body, ip }) => {
    authLimit('a:' + ip);
    const r = await A.requestOtp(db, cfg, smsSender, body.phone);
    return { ok: true, resendInSec: r.resendInSec };
  });
  router.add('POST', '/api/auth/verify', ({ body, ip }) => {
    authLimit('v:' + ip);
    const r = A.verifyOtp(db, cfg, body.phone, String(body.code ?? ''), A.normalizeConsents(body), ip);
    return { token: r.token, isNew: r.isNew };
  });
  router.add('GET', '/api/legal', () => ({ version: cfg.docsVersion, docs: cfg.docs, support: cfg.support }));
  router.add('POST', '/api/auth/logout', ({ req }) => { A.logout(db, bearer(req)); return { ok: true }; });

  router.add('GET', '/api/points', ({ ip }) => {      // для страницы «Как можно тратить баллы»
    apiLimit('p:' + ip);
    const act = all(db, 'SELECT id,name,kind,accrual_bp,redeem_bp FROM points WHERE active=1');
    return {
      points: act.filter((p) => p.kind !== 'earn').map((p) => ({ id: p.id, name: p.name, redeemPct: p.redeem_bp / 100 })),
      earn: act.filter((p) => p.kind !== 'spend').map((p) => ({ id: p.id, name: p.name, accrualPct: p.accrual_bp / 100, redeemPct: p.kind === 'both' ? p.redeem_bp / 100 : 0 })),
    };
  });

  router.add('GET', '/api/me', ({ req, ip }) => {
    apiLimit('m:' + ip);
    const u = userAuth(req);
    const virtual = L.ensureCard(db, cfg, u.id);   // null: пул карт пуст, карта появится, когда админ загрузит номера
    const physical = all(db, "SELECT number FROM cards WHERE user_id=? AND status='active' AND kind='physical'", u.id).map((c) => c.number);
    // в QR — виртуальная карта; если её ещё нет, а пластик привязан — номер пластика (обе карты заведены в Set10)
    const card = virtual || (physical.length ? { number: physical[0] } : null);
    const acc = L.getAccount(db, u.id);
    const last = L.history(db, u.id, { limit: 1 })[0] || null;
    return { user: { name: u.name, phone: maskPhone(u.phone), profileId: P.profileId(u.id) }, support: cfg.support, card: card ? { number: card.number, kind: virtual ? 'virtual' : 'physical' } : null, physicalCards: physical,
      qr: card ? { mode: 'static', value: qrPayload(card) } : null,
      settings: { autoRedeem: !!u.auto_redeem, marketing: !!u.marketing_at },
      pending: L.pendingConfirmations(db, u.id).map((h) => ({ id: h.id, pointName: h.point_name, points: h.points, code: h.code, expiresAt: h.expires_at })),
      balance: acc.balance, available: acc.available, currency: L.getSettings(db).currency, last };
  });
  router.add('GET', '/api/me/history', ({ req, query }) => {
    const u = userAuth(req);
    return { items: L.history(db, u.id, { before: query.before, limit: query.limit }) };
  });
  router.add('PATCH', '/api/me', ({ req, body, ip }) => {
    const u = userAuth(req);
    if (body.name !== undefined) run(db, 'UPDATE users SET name=? WHERE id=?', String(body.name ?? '').trim().slice(0, 60) || null, u.id);
    if (body.autoRedeem !== undefined) run(db, 'UPDATE users SET auto_redeem=? WHERE id=?', body.autoRedeem === true ? 1 : 0, u.id);
    if (body.marketing !== undefined && (body.marketing === true) !== !!u.marketing_at) A.recordConsent(db, cfg, u.id, 'marketing', body.marketing === true, ip);
    return { ok: true };
  });
  /* смена номера телефона: код уходит на НОВЫЙ номер; профиль, баллы и карты не меняются */
  router.add('POST', '/api/me/phone/request', async ({ req, body }) => {
    const u = userAuth(req);
    phoneLimit('ph:' + u.id);
    const phone = normalizePhone(body.phone);
    if (phone === u.phone) throw new HttpError(400, 'same_phone', 'Это ваш текущий номер');
    if (one(db, 'SELECT 1 FROM users WHERE phone=? AND deleted_at IS NULL', phone)) throw new HttpError(409, 'phone_taken', 'Этот номер уже привязан к другому профилю. Обратитесь в поддержку: профили можно объединить');
    await P.startVerification(db, cfg, smsSender, { purpose: 'phone_change', subject: String(u.id), phone, text: (c) => `Код ${c} для смены номера в программе ДЕЯ` });
    return { ok: true, resendInSec: cfg.otpResendSec };
  });
  router.add('POST', '/api/me/phone/confirm', ({ req, body }) => {
    const u = userAuth(req);
    const phone = normalizePhone(body.phone);
    P.checkVerification(db, cfg, { purpose: 'phone_change', subject: String(u.id), phone, code: String(body.code ?? '') });
    const r = P.changePhone(db, u.id, phone);
    audit(db, 'user:' + u.id, 'phone_changed', { from: maskPhone(u.phone), to: maskPhone(phone) });
    return r;
  });
  router.add('POST', '/api/me/cards/bind', ({ req, body }) => {   // привязка пластиковой карты
    const u = userAuth(req);
    bindLimit('b:' + u.id);
    const r = L.bindPhysicalCard(db, cfg, u.id, body.number, body.code, body.replace === true);
    audit(db, 'user:' + u.id, 'card_bound', { card: r.card.slice(-4), transferred: r.transferred, replaced: r.replaced ? r.replaced.slice(-4) : null });
    return r;
  });
  router.add('DELETE', '/api/me', ({ req }) => {   // удаление аккаунта: персональные данные стираются, журнал баллов остаётся обезличенным
    const u = userAuth(req);
    db.exec('BEGIN IMMEDIATE');
    try {
      run(db, 'UPDATE users SET phone=NULL, name=NULL, deleted_at=? WHERE id=?', nowIso(), u.id);
      L.releaseCardsOnDelete(db, u.id);
      run(db, 'DELETE FROM sessions WHERE user_id=?', u.id);
      audit(db, 'user:' + u.id, 'account_deleted');
      db.exec('COMMIT');
    } catch (e) { db.exec('ROLLBACK'); throw e; }
    return { ok: true };
  });

  /* ================= касса / плагин / страница кассира ================= */
  router.add('POST', '/api/v1/accruals', ({ req, body }) => {
    const point = pointAuth(req);
    if (!body.idempotencyKey && req.headers['idempotency-key']) body.idempotencyKey = req.headers['idempotency-key'];
    const r = L.processReceipt(db, point, body);
    return { http: r.duplicate ? 409 : 200, body: { ...r, accrued: r.accrued } };
  });

  const resolveCard = (b) => {
    if (b.card) return String(b.card).trim();
    if (b.phone) {
      const u = one(db, 'SELECT id FROM users WHERE phone=? AND deleted_at IS NULL', normalizePhone(b.phone));
      const c = u && one(db, "SELECT number FROM cards WHERE user_id=? AND status='active'", u.id);
      if (c) return c.number;
    }
    throw new HttpError(422, 'unknown_card', 'Карта не найдена');
  };
  router.add('POST', '/api/v1/cashier/lookup', ({ req, body }) => {
    const point = pointAuth(req);
    const { user, card } = L.cardOwner(db, resolveCard(body));
    return { card: card.number, name: user.name, phone: maskPhone(user.phone), balance: L.getAccount(db, user.id).balance, pointName: point.name, kind: point.kind, accrualPct: point.accrual_bp / 100, redeemPct: point.redeem_bp / 100 };
  });
  router.add('POST', '/api/v1/cashier/accrual', ({ req, body }) => {  // ручное начисление на странице кассира
    const point = pointAuth(req);
    const total = formatKop(Math.abs(parseKop(String(body.total))));
    if (!body.idempotencyKey) throw new HttpError(400, 'no_idempotency_key', 'Нужен idempotencyKey');
    const r = L.processReceipt(db, point, { schemaVersion: 1, idempotencyKey: 'manual:' + point.id + ':' + body.idempotencyKey, operation: 'SALE',
      card: { number: resolveCard(body) }, receipt: { key: 'manual:' + body.idempotencyKey, total } });
    return r;
  });

  router.add('POST', '/api/v1/redeem/quote', ({ req, body }) => {
    const point = pointAuth(req);
    const q = L.quoteRedeem(db, point, resolveCard(body), parseKop(String(body.checkTotal)));
    return { available: q.available, maxPoints: q.maxPoints, maxDiscount: formatKop(q.discountKop) };
  });
  router.add('POST', '/api/v1/redeem/hold', ({ req, body }) => {
    const point = pointAuth(req);
    const r = L.holdRedeem(db, cfg, point, { card: resolveCard(body), checkKop: parseKop(String(body.checkTotal)), points: body.points, idemKey: body.idempotencyKey });
    return { http: r.duplicate ? 200 : 201, body: { ...r, discount: r.discountKop === undefined ? undefined : formatKop(r.discountKop) } };
  });

  /* ---- списание в чеке кассы гипермаркета (плагин Set10: подытог → резерв, пробитие → подтверждение в /accruals) ---- */
  router.add('POST', '/api/v1/pos/redeem/reserve', ({ req, body }) => {
    const point = pointAuth(req);
    try { return L.reservePos(db, cfg, point, { ref: body.ref, card: body.card?.number ?? body.card, lines: body.lines, mode: body.mode, points: body.points }); }
    catch (e) { if (e instanceof HttpError && e.status === 422) return { points: 0, discount: '0.00', lines: [], reason: e.code }; throw e; }
  });
  router.add('POST', '/api/v1/pos/redeem/quote', ({ req, body }) => L.quotePos(db, pointAuth(req), { card: body.card?.number ?? body.card, lines: body.lines }));
  router.add('POST', '/api/v1/pos/redeem/writeoff', ({ req, body }) => L.writeoffPos(db, pointAuth(req), { ref: body.ref, points: body.points, card: body.card?.number ?? body.card }));
  router.add('POST', '/api/v1/pos/redeem/rollback', ({ req, body }) => L.rollbackPos(db, pointAuth(req), body.txId));

  /* ---- касса: карта, поиск по телефону, активация пластика по СМС (плагин карт Set10) ---- */
  router.add('POST', '/api/v1/pos/card/status', ({ req, body }) => { pointAuth(req); return P.cardStatus(db, body.card?.number ?? body.card); });
  router.add('POST', '/api/v1/pos/card/by-phone', ({ req, body }) => { pointAuth(req); return P.cardByPhone(db, cfg, body.phone); });
  router.add('POST', '/api/v1/pos/activate/start', async ({ req, body }) => {
    pointAuth(req); phoneLimit('pa:' + String(body.card ?? ''));
    return P.activateStart(db, cfg, smsSender, String(body.card ?? ''), body.phone);
  });
  router.add('POST', '/api/v1/pos/activate/confirm', ({ req, body, ip }) => {
    const point = pointAuth(req);
    const r = P.activateConfirm(db, cfg, String(body.card ?? ''), body.phone, body.code, ip);
    audit(db, 'point:' + point.id, 'card_activated_pos', { card: String(body.card).slice(-4), profileId: r.profileId, transferred: r.transferred, replaced: r.replaced });
    return r;
  });
  router.add('POST', '/api/v1/pos/redeem/cancel', ({ req, body }) => L.cancelPos(db, pointAuth(req), body.ref));
  router.add('POST', '/api/v1/redeem/:id/commit', ({ req, params, body }) => L.commitRedeem(db, cfg, pointAuth(req), params.id, body.code));
  router.add('POST', '/api/v1/redeem/:id/cancel', ({ req, params }) => L.cancelRedeem(db, pointAuth(req), params.id));
  router.add('POST', '/api/v1/redeem/:id/reverse', ({ req, params }) => L.reverseRedeem(db, pointAuth(req), params.id));

  /* ================= администратор ================= */
  const pointView = (p) => ({ id: p.id, name: p.name, kind: p.kind, accrualPct: p.accrual_bp / 100, redeemPct: p.redeem_bp / 100, active: !!p.active, hasKey: !!p.api_key_hash, confirmRedeem: !!p.confirm_redeem });
  router.add('GET', '/api/admin/points', ({ req }) => { adminAuth(req); return { points: all(db, 'SELECT * FROM points ORDER BY created_at, id').map(pointView), settings: L.getSettings(db) }; });
  router.add('POST', '/api/admin/points', ({ req, body }) => {
    adminAuth(req);
    if (!/^[a-z0-9_-]{2,32}$/.test(body.id || '')) throw new HttpError(400, 'bad_id', 'id: латиница, цифры, _ -');
    if (!['earn', 'spend', 'both'].includes(body.kind)) throw new HttpError(400, 'bad_kind', 'kind: earn | spend | both');
    if (one(db, 'SELECT 1 FROM points WHERE id=?', body.id)) throw new HttpError(409, 'exists', 'Такая точка уже есть');
    run(db, 'INSERT INTO points(id,name,kind,accrual_bp,redeem_bp,active,created_at) VALUES(?,?,?,?,?,1,?)', body.id, String(body.name || body.id).slice(0, 80), body.kind, L.pctToBp(body.accrualPct ?? 0), L.pctToBp(body.redeemPct ?? 0), nowIso());
    audit(db, 'admin', 'point_created', { id: body.id });
    return { http: 201, body: pointView(L.getPoint(db, body.id)) };
  });
  router.add('PATCH', '/api/admin/points/:id', ({ req, params, body }) => {
    adminAuth(req);
    const p = L.getPoint(db, params.id); if (!p) throw new HttpError(404, 'not_found', 'Точка не найдена');
    const n = { name: body.name ?? p.name, kind: body.kind ?? p.kind, a: body.accrualPct === undefined ? p.accrual_bp : L.pctToBp(body.accrualPct),
      r: body.redeemPct === undefined ? p.redeem_bp : L.pctToBp(body.redeemPct), active: body.active === undefined ? p.active : (body.active ? 1 : 0),
      c: body.confirmRedeem === undefined ? p.confirm_redeem : (body.confirmRedeem ? 1 : 0) };
    if (!['earn', 'spend', 'both'].includes(n.kind)) throw new HttpError(400, 'bad_kind', 'kind');
    run(db, 'UPDATE points SET name=?,kind=?,accrual_bp=?,redeem_bp=?,active=?,confirm_redeem=? WHERE id=?', n.name, n.kind, n.a, n.r, n.active, n.c, p.id);
    audit(db, 'admin', 'point_updated', { id: p.id, before: pointView(p), after: body });
    return pointView(L.getPoint(db, p.id));
  });
  router.add('POST', '/api/admin/points/:id/rotate-key', ({ req, params }) => {
    adminAuth(req);
    if (!L.getPoint(db, params.id)) throw new HttpError(404, 'not_found', 'Точка не найдена');
    const key = 'pk_' + randomToken(24);
    run(db, 'UPDATE points SET api_key_hash=? WHERE id=?', sha256(key), params.id);
    audit(db, 'admin', 'point_key_rotated', { id: params.id });
    return { apiKey: key, note: 'Ключ показывается один раз' };
  });
  router.add('PUT', '/api/admin/settings', ({ req, body }) => {
    adminAuth(req);
    for (const [k, v] of Object.entries(body)) L.setSetting(db, k, v);
    audit(db, 'admin', 'settings_updated', body);
    return L.getSettings(db);
  });
  router.add('GET', '/api/admin/users', ({ req, query }) => {
    adminAuth(req);
    const q = String(query.q || '').replace(/[^0-9A-Za-z]/g, '');
    const byProfile = P.userIdFromProfile(q);   // поиск и по ID профиля
    const sel = "SELECT u.id,u.phone,u.name,u.created_at,u.stub,(SELECT group_concat(number,', ') FROM cards WHERE user_id=u.id AND status='active') card,a.balance,a.held FROM users u JOIN accounts a ON a.user_id=u.id WHERE u.deleted_at IS NULL";
    const rows = q ? all(db, sel + ' AND (u.id=? OR u.phone LIKE ? OR EXISTS (SELECT 1 FROM cards c WHERE c.user_id=u.id AND c.number LIKE ?)) ORDER BY u.id DESC LIMIT 50', byProfile ?? -1, `%${q}%`, `%${q}%`)
      : all(db, sel + ' ORDER BY u.id DESC LIMIT 50');
    return { users: rows.map((r) => ({ ...r, profileId: P.profileId(r.id) })) };
  });
  router.add('GET', '/api/admin/users/:id', ({ req, params, query }) => {
    adminAuth(req);
    const u = one(db, 'SELECT id,phone,name,created_at,stub,auto_redeem,marketing_at,deleted_at,merged_into FROM users WHERE id=?', Number(params.id));
    if (!u) throw new HttpError(404, 'not_found', 'Пользователь не найден');
    // карточка клиента для поддержки: всё в одном месте (просмотр сам пишется в журнал)
    return { user: { ...u, profileId: P.profileId(u.id) }, account: L.getAccount(db, u.id), history: L.history(db, u.id, { limit: query.limit || 50 }),
      cards: all(db, 'SELECT number,kind,status,bound_at,created_at FROM cards WHERE user_id=? ORDER BY created_at', u.id),
      consents: all(db, 'SELECT kind,version,granted,channel,created_at FROM consents WHERE user_id=? ORDER BY id DESC LIMIT 50', u.id),
      audit: all(db, "SELECT actor,action,detail,created_at FROM audit WHERE actor=? OR detail LIKE ? OR detail LIKE ? ORDER BY id DESC LIMIT 100",
        'user:' + u.id, `%"user":"${u.id}"%`, `%/api/admin/users/${u.id}/%`) };
  });
  router.add('POST', '/api/admin/users/:id/phone', ({ req, params, body }) => {   // поддержка: клиент потерял номер / сменил
    adminAuth(req);
    const r = P.changePhone(db, Number(params.id), body.phone, { dropSessions: true });
    audit(db, 'admin', 'phone_changed_by_support', { user: params.id, to: r.phone, reason: String(body.reason || '').slice(0, 200) });
    return r;
  });
  router.add('POST', '/api/admin/users/:id/merge', ({ req, params, body }) => {    // объединить профиль from в этот
    adminAuth(req);
    const from = P.userIdFromProfile(body.from) ?? Number(body.fromUserId);
    const r = P.mergeProfiles(db, Number(params.id), from);
    audit(db, 'admin', 'profiles_merged', { user: params.id, from, ...r, reason: String(body.reason || '').slice(0, 200) });
    return r;
  });
  router.add('POST', '/api/admin/cards/:number/unbind', ({ req, params, body }) => {
    adminAuth(req);
    const r = P.unbindCard(db, params.number);
    audit(db, 'admin', 'card_unbound', { card: r.card, reason: String(body.reason || '').slice(0, 200) });
    return r;
  });
  router.add('POST', '/api/admin/users/:id/adjust', ({ req, params, body }) => {
    adminAuth(req);
    const acc = L.adjust(db, Number(params.id), body.points, String(body.reason || '').slice(0, 200), 'admin');
    audit(db, 'admin', 'adjust', { user: params.id, points: body.points, reason: body.reason });
    return acc;
  });
  router.add('GET', '/api/admin/cards.csv', ({ req }) => {  // выгрузка карт для загрузки в Set10
    adminAuth(req);
    const rows = all(db, "SELECT c.number, u.phone, c.status, c.kind FROM cards c LEFT JOIN users u ON u.id=c.user_id WHERE c.status IN ('active','free') ORDER BY c.created_at");
    const csv = 'card_number;phone;status;kind\n' + rows.map((r) => `${r.number};${r.phone ?? ''};${r.status};${r.kind}`).join('\n') + '\n';
    return { raw: Buffer.from('﻿' + csv, 'utf8'), headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="cards.csv"' } };
  });
  /* пул карт: номера, заранее заведённые в Set10 (виртуальные — для QR, пластиковые — печатаются) */
  router.add('GET', '/api/admin/cards/pool', ({ req }) => { adminAuth(req); return { pool: L.poolStats(db), mode: cfg.cardIssueMode }; });
  router.add('POST', '/api/admin/cards/import', ({ req, body }) => {
    adminAuth(req);
    // {kind, range:{from,to}} или {kind, text:"номер[;код]\n..."} или {kind, items:[{number, code}]}
    let items = body.items;
    if (body.range) items = L.expandRange(body.range.from, body.range.to);
    else if (typeof body.text === 'string') items = body.text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => { const [number, code] = l.split(/[;,\t ]+/); return { number, code }; });
    const r = L.importCards(db, cfg, body.kind || 'virtual', items);
    audit(db, 'admin', 'cards_imported', { kind: body.kind || 'virtual', added: r.added, skipped: r.skipped, invalid: r.invalid.length });
    return r;
  });
  router.add('POST', '/api/admin/cards/:number/block', ({ req, params, body }) => {
    adminAuth(req);
    const r = L.setCardBlocked(db, params.number, body.blocked !== false);
    audit(db, 'admin', r.status === 'blocked' ? 'card_blocked' : 'card_unblocked', { card: r.card, reason: String(body.reason || '').slice(0, 200) });
    return r;
  });
  router.add('GET', '/api/admin/metrics', ({ req, query }) => { adminAuth(req); return metrics(db, query.days); });
  router.add('GET', '/api/admin/stats', ({ req }) => {
    adminAuth(req);
    const today = new Date().toISOString().slice(0, 10);
    return {
      users: one(db, 'SELECT COUNT(*) c FROM users WHERE deleted_at IS NULL AND stub=0').c,
      freeCards: one(db, "SELECT COUNT(*) c FROM cards WHERE status='free' AND kind='virtual'").c,
      totalBalance: one(db, 'SELECT COALESCE(SUM(balance),0) s FROM accounts').s,
      accruedToday: one(db, "SELECT COALESCE(SUM(points),0) s FROM ledger WHERE type='ACCRUAL' AND created_at>=?", today).s,
      redeemedToday: one(db, "SELECT COALESCE(SUM(-points),0) s FROM ledger WHERE type='REDEEM' AND created_at>=?", today).s,
      mismatches: L.reconcile(db).length,
    };
  });
  router.add('GET', '/api/admin/audit', ({ req }) => { adminAuth(req); return { items: all(db, 'SELECT * FROM audit ORDER BY id DESC LIMIT 100') }; });

  const clientIp = (req) => (cfg.trustProxy && req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',')[0].trim() : req.socket.remoteAddress || '?');
  // журнал всех изменяющих запросов и всех обращений к админке (кто, что, откуда, результат); тела запросов не пишем — в них ПДн
  const onApiDone = ({ req, method, path, status, ms, ip, err }) => {
    if (method === 'GET' && !path.startsWith('/api/admin/')) return;
    run(db, 'INSERT INTO audit(actor,action,detail,created_at) VALUES(?,?,?,?)', req.actor || 'anon', 'http',
      JSON.stringify({ m: method, p: path, s: status, ms, ip, err: err || undefined }), nowIso());
  };
  const server = createServer({ router, publicDir: cfg.publicDir, log, clientIp, onApiDone });
  const sweeper = setInterval(() => { try { L.releaseExpiredHolds(db); } catch (e) { log.error('sweeper', e); } }, 60_000);
  sweeper.unref();
  const daily = setInterval(() => { try { pruneAudit(db, cfg); } catch (e) { log.error('prune', e); } }, 86400_000);
  daily.unref();
  const backups = scheduleBackups(db, cfg, log);
  return { server, db, sms: smsSender, close: () => { clearInterval(sweeper); clearInterval(daily); backups.stop(); server.close(); db.close(); } };
}
