import crypto from 'node:crypto';
import { openDb, one, all, run } from './db.js';
import { Router, createServer, makeLimiter } from './http.js';
import { HttpError, normalizePhone, sha256, tsEq, parseKop, formatKop, randomToken, nowIso } from './util.js';
import * as L from './loyalty.js';
import * as A from './auth.js';
import { makeSms } from './sms.js';

/** QR в приложении. Единственное место, где решается, что именно зашито в QR (режим static: номер карты). */
export const qrPayload = (card) => card.number;

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

  /* ---- проверка ключей ---- */
  const pointAuth = (req) => {
    const token = bearer(req);
    if (!token) throw new HttpError(401, 'unauthorized', 'Нужен ключ доступа');
    const p = one(db, 'SELECT * FROM points WHERE api_key_hash=?', sha256(token));
    if (!p) throw new HttpError(401, 'unauthorized', 'Неверный ключ доступа');
    const claimed = req.headers['x-point-id'];
    if (claimed && claimed !== p.id) throw new HttpError(403, 'point_mismatch', 'Ключ не от этой точки');
    return p;
  };
  const adminAuth = (req) => { if (!cfg.adminToken || !tsEq(bearer(req), cfg.adminToken)) throw new HttpError(401, 'unauthorized', 'Нужен токен администратора'); };
  const userAuth = (req) => A.authUser(db, cfg, bearer(req));

  router.add('GET', '/healthz', () => { one(db, 'SELECT 1'); return { ok: true }; });

  /* ================= публичное / клиент ================= */
  router.add('POST', '/api/auth/request-code', async ({ body, ip }) => {
    authLimit('a:' + ip);
    const r = await A.requestOtp(db, cfg, smsSender, body.phone);
    return { ok: true, resendInSec: r.resendInSec };
  });
  router.add('POST', '/api/auth/verify', ({ body, ip }) => {
    authLimit('v:' + ip);
    const r = A.verifyOtp(db, cfg, body.phone, String(body.code ?? ''), body.consent === true);
    return { token: r.token, isNew: r.isNew };
  });
  router.add('POST', '/api/auth/logout', ({ req }) => { A.logout(db, bearer(req)); return { ok: true }; });

  router.add('GET', '/api/points', ({ ip }) => {      // для страницы «Как можно тратить баллы»
    apiLimit('p:' + ip);
    const act = all(db, 'SELECT id,name,kind,accrual_bp,redeem_bp FROM points WHERE active=1');
    return {
      points: act.filter((p) => p.kind !== 'earn').map((p) => ({ id: p.id, name: p.name, redeemPct: p.redeem_bp / 100 })),
      earn: act.filter((p) => p.kind !== 'spend').map((p) => ({ id: p.id, name: p.name, accrualPct: p.accrual_bp / 100 })),
    };
  });

  router.add('GET', '/api/me', ({ req, ip }) => {
    apiLimit('m:' + ip);
    const u = userAuth(req);
    const card = one(db, "SELECT * FROM cards WHERE user_id=? AND status='active'", u.id);
    const acc = L.getAccount(db, u.id);
    const last = L.history(db, u.id, { limit: 1 })[0] || null;
    return { user: { name: u.name, phone: maskPhone(u.phone) }, card: { number: card.number }, qr: { mode: 'static', value: qrPayload(card) },
      balance: acc.balance, available: acc.available, currency: L.getSettings(db).currency, last };
  });
  router.add('GET', '/api/me/history', ({ req, query }) => {
    const u = userAuth(req);
    return { items: L.history(db, u.id, { before: query.before, limit: query.limit }) };
  });
  router.add('PATCH', '/api/me', ({ req, body }) => {
    const u = userAuth(req);
    const name = String(body.name ?? '').trim().slice(0, 60);
    run(db, 'UPDATE users SET name=? WHERE id=?', name || null, u.id);
    return { ok: true };
  });
  router.add('DELETE', '/api/me', ({ req }) => {   // удаление аккаунта: персональные данные стираются, журнал баллов остаётся обезличенным
    const u = userAuth(req);
    db.exec('BEGIN IMMEDIATE');
    try {
      run(db, 'UPDATE users SET phone=NULL, name=NULL, deleted_at=? WHERE id=?', nowIso(), u.id);
      run(db, "UPDATE cards SET status='closed' WHERE user_id=?", u.id);
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
  router.add('POST', '/api/v1/redeem/:id/commit', ({ req, params }) => L.commitRedeem(db, pointAuth(req), params.id));
  router.add('POST', '/api/v1/redeem/:id/cancel', ({ req, params }) => L.cancelRedeem(db, pointAuth(req), params.id));
  router.add('POST', '/api/v1/redeem/:id/reverse', ({ req, params }) => L.reverseRedeem(db, pointAuth(req), params.id));

  /* ================= администратор ================= */
  const pointView = (p) => ({ id: p.id, name: p.name, kind: p.kind, accrualPct: p.accrual_bp / 100, redeemPct: p.redeem_bp / 100, active: !!p.active, hasKey: !!p.api_key_hash });
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
      r: body.redeemPct === undefined ? p.redeem_bp : L.pctToBp(body.redeemPct), active: body.active === undefined ? p.active : (body.active ? 1 : 0) };
    if (!['earn', 'spend', 'both'].includes(n.kind)) throw new HttpError(400, 'bad_kind', 'kind');
    run(db, 'UPDATE points SET name=?,kind=?,accrual_bp=?,redeem_bp=?,active=? WHERE id=?', n.name, n.kind, n.a, n.r, n.active, p.id);
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
    const q = String(query.q || '').replace(/\D/g, '');
    const rows = q ? all(db, 'SELECT u.id,u.phone,u.name,u.created_at,c.number card,a.balance,a.held FROM users u JOIN accounts a ON a.user_id=u.id LEFT JOIN cards c ON c.user_id=u.id WHERE u.deleted_at IS NULL AND (u.phone LIKE ? OR c.number LIKE ?) LIMIT 50', `%${q}%`, `%${q}%`)
      : all(db, 'SELECT u.id,u.phone,u.name,u.created_at,c.number card,a.balance,a.held FROM users u JOIN accounts a ON a.user_id=u.id LEFT JOIN cards c ON c.user_id=u.id WHERE u.deleted_at IS NULL ORDER BY u.id DESC LIMIT 50');
    return { users: rows };
  });
  router.add('GET', '/api/admin/users/:id', ({ req, params, query }) => {
    adminAuth(req);
    const u = one(db, 'SELECT id,phone,name,created_at FROM users WHERE id=?', Number(params.id));
    if (!u) throw new HttpError(404, 'not_found', 'Пользователь не найден');
    return { user: u, account: L.getAccount(db, u.id), history: L.history(db, u.id, { limit: query.limit || 50 }) };
  });
  router.add('POST', '/api/admin/users/:id/adjust', ({ req, params, body }) => {
    adminAuth(req);
    const acc = L.adjust(db, Number(params.id), body.points, String(body.reason || '').slice(0, 200), 'admin');
    audit(db, 'admin', 'adjust', { user: params.id, points: body.points, reason: body.reason });
    return acc;
  });
  router.add('GET', '/api/admin/cards.csv', ({ req }) => {  // выгрузка карт для загрузки в Set10
    adminAuth(req);
    const rows = all(db, "SELECT c.number, u.phone, c.status FROM cards c LEFT JOIN users u ON u.id=c.user_id WHERE c.status='active' ORDER BY c.created_at");
    const csv = 'card_number;phone;status\n' + rows.map((r) => `${r.number};${r.phone ?? ''};${r.status}`).join('\n') + '\n';
    return { raw: Buffer.from('﻿' + csv, 'utf8'), headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="cards.csv"' } };
  });
  router.add('GET', '/api/admin/stats', ({ req }) => {
    adminAuth(req);
    const today = new Date().toISOString().slice(0, 10);
    return {
      users: one(db, 'SELECT COUNT(*) c FROM users WHERE deleted_at IS NULL').c,
      totalBalance: one(db, 'SELECT COALESCE(SUM(balance),0) s FROM accounts').s,
      accruedToday: one(db, "SELECT COALESCE(SUM(points),0) s FROM ledger WHERE type='ACCRUAL' AND created_at>=?", today).s,
      redeemedToday: one(db, "SELECT COALESCE(SUM(-points),0) s FROM ledger WHERE type='REDEEM' AND created_at>=?", today).s,
      mismatches: L.reconcile(db).length,
    };
  });
  router.add('GET', '/api/admin/audit', ({ req }) => { adminAuth(req); return { items: all(db, 'SELECT * FROM audit ORDER BY id DESC LIMIT 100') }; });

  const clientIp = (req) => (cfg.trustProxy && req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',')[0].trim() : req.socket.remoteAddress || '?');
  const server = createServer({ router, publicDir: cfg.publicDir, log, clientIp });
  const sweeper = setInterval(() => { try { L.releaseExpiredHolds(db); } catch (e) { log.error('sweeper', e); } }, 60_000);
  sweeper.unref();
  return { server, db, sms: smsSender, close: () => { clearInterval(sweeper); server.close(); db.close(); } };
}
