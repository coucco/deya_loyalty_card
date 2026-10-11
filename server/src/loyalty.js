/**
 * Ядро лояльности: правила начисления/списания, журнал, баланс.
 * Все изменения баланса идут через tx() (BEGIN IMMEDIATE), баланс = сумма ledger.
 */
import crypto from 'node:crypto';
import { tx, one, all, run } from './db.js';
import { HttpError, nowIso, parseKop, divRound, luhnDigit, formatKop } from './util.js';

const DEFAULT_SETTINGS = { rub_per_point: '1', rounding: 'half_up', currency: '₽' };

export function getSettings(db) {
  const s = { ...DEFAULT_SETTINGS };
  for (const r of all(db, 'SELECT key,value FROM settings')) s[r.key] = r.value;
  return { rubPerPoint: Number(s.rub_per_point), rounding: s.rounding, currency: s.currency };
}
export function setSetting(db, key, value) {
  if (!(key in DEFAULT_SETTINGS)) throw new HttpError(400, 'bad_setting', 'Неизвестная настройка');
  if (key === 'rub_per_point' && !(Number(value) > 0)) throw new HttpError(400, 'bad_value', 'rub_per_point > 0');
  if (key === 'rounding' && !['half_up', 'floor'].includes(value)) throw new HttpError(400, 'bad_value', 'half_up | floor');
  run(db, 'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, String(value));
}

/* ---------------- точки ---------------- */
export function seedPoints(db, demo) {
  const def = [
    ['hypermarket', 'Гипермаркет', 'earn', demo ? 500 : 0, 0],
    ['cinema', 'Кино', 'spend', 0, demo ? 1000 : 0],
    ['bowling', 'Боулинг', 'spend', 0, demo ? 1000 : 0],
  ];
  for (const [id, name, kind, a, r] of def) {
    run(db, 'INSERT OR IGNORE INTO points(id,name,kind,accrual_bp,redeem_bp,active,created_at) VALUES(?,?,?,?,?,1,?)', id, name, kind, a, r, nowIso());
  }
}
export const getPoint = (db, id) => one(db, 'SELECT * FROM points WHERE id=?', id);
export const pctToBp = (pct) => {
  const n = Number(pct);
  if (!Number.isFinite(n) || n < 0 || n > 100) throw new HttpError(400, 'bad_percent', 'Процент от 0 до 100');
  return Math.round(n * 100);
};

/* ---------------- пользователи и карты ---------------- */
export function generateCardNumber(prefix, length) {
  const bodyLen = length - 1 - prefix.length;
  if (bodyLen < 4) throw new Error('CARD_LENGTH слишком мал для префикса');
  let body = '';
  while (body.length < bodyLen) body += crypto.randomInt(0, 10);
  return prefix + body + luhnDigit(prefix + body);
}

export function createUserWithCard(db, cfg, phone, consent) {
  return tx(db, () => {
    const t = nowIso();
    const u = run(db, 'INSERT INTO users(phone,consent_at,created_at) VALUES(?,?,?)', phone, consent ? t : null, t);
    const userId = Number(u.lastInsertRowid);
    run(db, 'INSERT INTO accounts(user_id) VALUES(?)', userId);
    for (let i = 0; i < 20; i++) {
      const num = generateCardNumber(cfg.cardPrefix, cfg.cardLength);
      if (!one(db, 'SELECT 1 FROM cards WHERE number=?', num)) {
        run(db, 'INSERT INTO cards(number,user_id,created_at) VALUES(?,?,?)', num, userId, t);
        return userId;
      }
    }
    throw new Error('не удалось выдать номер карты');
  });
}

export function findCard(db, number) {
  const c = one(db, 'SELECT * FROM cards WHERE number=?', String(number ?? '').trim());
  return c || null;
}
export function cardOwner(db, number) {
  const c = findCard(db, number);
  if (!c || c.status !== 'active' || !c.user_id) throw new HttpError(422, 'unknown_card', 'Карта не найдена или заблокирована');
  const u = one(db, 'SELECT * FROM users WHERE id=? AND deleted_at IS NULL', c.user_id);
  if (!u) throw new HttpError(422, 'unknown_card', 'Карта не найдена или заблокирована');
  return { card: c, user: u };
}

export function getAccount(db, userId) {
  releaseExpiredHolds(db);
  const a = one(db, 'SELECT balance, held FROM accounts WHERE user_id=?', userId);
  return { balance: a.balance, held: a.held, available: a.balance - a.held };
}

/* ---------------- начисление ---------------- */
export function calcPoints(baseKop, bp, settings) {
  const mode = settings.rounding === 'floor' ? 'floor' : 'half_up';
  return divRound(baseKop * bp, 10000 * 100 * settings.rubPerPoint, mode);
}

/** База начисления: строки с accrueAllowed!==false, сумма уже после скидок. Нет строк — итог чека. */
export function accrualBase(payload) {
  const lines = Array.isArray(payload.lines) ? payload.lines : [];
  if (lines.length) {
    return lines.filter((l) => l.accrueAllowed !== false).reduce((s, l) => s + Math.abs(parseKop(l.sum ?? '0')), 0);
  }
  return Math.abs(parseKop(payload.receipt?.total ?? '0'));
}

function insertLedger(db, e) {
  const r = run(db,
    'INSERT INTO ledger(user_id,point_id,type,points,base_kop,pct_bp,receipt_key,idem_key,meta,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)',
    e.userId, e.pointId, e.type, e.points, e.baseKop ?? null, e.pctBp ?? null, e.receiptKey ?? null, e.idemKey ?? null,
    e.meta ? JSON.stringify(e.meta) : null, nowIso());
  return Number(r.lastInsertRowid);
}

/**
 * Обработка чека от кассы/страницы кассира. Идемпотентно по payload.idempotencyKey.
 * Возвращает {duplicate, accrued, balance, ...}; ошибки — HttpError с кодами контракта плагина.
 */
export function processReceipt(db, point, payload) {
  if (!payload || typeof payload !== 'object') throw new HttpError(400, 'bad_body', 'Нет тела запроса');
  const key = payload.idempotencyKey;
  if (typeof key !== 'string' || !key || key.length > 200) throw new HttpError(400, 'no_idempotency_key', 'Нет idempotencyKey');
  if (payload.schemaVersion !== undefined && payload.schemaVersion !== 1) throw new HttpError(400, 'bad_schema', 'Неподдерживаемая schemaVersion');
  const op = payload.operation || 'SALE';
  if (op !== 'SALE' && op !== 'REFUND') throw new HttpError(400, 'bad_operation', 'operation: SALE | REFUND');
  if (point.kind === 'spend') throw new HttpError(403, 'point_cannot_accrue', 'Эта точка не начисляет баллы');
  const settings = getSettings(db);

  return tx(db, () => {
    const prev = one(db, 'SELECT * FROM ledger WHERE idem_key=?', key);
    if (prev) return { duplicate: true, accrued: prev.points, balance: getAccount(db, prev.user_id).balance };
    if (!point.active) throw new HttpError(403, 'point_inactive', 'Точка отключена');
    const baseKop = accrualBase(payload);
    const receiptKey = payload.receipt?.key || key;

    if (op === 'SALE') {
      const { user } = cardOwner(db, payload.card?.number);
      const points = calcPoints(baseKop, point.accrual_bp, settings);
      insertLedger(db, { userId: user.id, pointId: point.id, type: 'ACCRUAL', points, baseKop, pctBp: point.accrual_bp, receiptKey, idemKey: key,
        meta: { total: payload.receipt?.total ?? null, registerId: payload.registerId ?? null } });
      run(db, 'UPDATE accounts SET balance=balance+? WHERE user_id=?', points, user.id);
      return { duplicate: false, accrued: points, balance: getAccount(db, user.id).balance };
    }

    // REFUND: найти исходное начисление
    const origKey = payload.originalReceipt?.key;
    const orig = origKey ? one(db, "SELECT * FROM ledger WHERE receipt_key=? AND type='ACCRUAL' AND point_id=?", origKey, point.id) : null;
    if (!orig) { // чек до внедрения плагина или без начисления: баллы не трогаем, но запоминаем ключ
      const { user } = payload.card?.number ? cardOwner(db, payload.card.number) : { user: null };
      if (!user) throw new HttpError(422, 'original_not_found', 'Исходное начисление не найдено, карты нет');
      insertLedger(db, { userId: user.id, pointId: point.id, type: 'ACCRUAL_REVERSAL', points: 0, baseKop, receiptKey: origKey ?? key, idemKey: key, meta: { note: 'original_not_found' } });
      return { duplicate: false, accrued: 0, balance: getAccount(db, user.id).balance, note: 'original_not_found' };
    }
    const already = one(db, "SELECT COALESCE(SUM(-points),0) s FROM ledger WHERE type='ACCRUAL_REVERSAL' AND receipt_key=? AND point_id=?", origKey, point.id).s;
    let want = calcPoints(baseKop, orig.pct_bp, settings);          // по ставке исходного начисления
    want = Math.min(want, Math.max(0, orig.points - already));       // не больше, чем начислили
    const acc = one(db, 'SELECT balance, held FROM accounts WHERE user_id=?', orig.user_id);
    const take = Math.min(want, acc.balance - acc.held > 0 ? acc.balance - acc.held : 0); // не уходим в минус и не трогаем резерв
    insertLedger(db, { userId: orig.user_id, pointId: point.id, type: 'ACCRUAL_REVERSAL', points: -take, baseKop, pctBp: orig.pct_bp, receiptKey: origKey, idemKey: key,
      meta: { wanted: want, shortfall: want - take } });
    run(db, 'UPDATE accounts SET balance=balance-? WHERE user_id=?', take, orig.user_id);
    return { duplicate: false, accrued: -take, shortfall: want - take, balance: getAccount(db, orig.user_id).balance };
  });
}

/* ---------------- списание: резерв → подтверждение → отмена/возврат ---------------- */
export function releaseExpiredHolds(db) {
  const now = nowIso();
  const exp = all(db, "SELECT id,user_id,points FROM holds WHERE status='HELD' AND expires_at<=?", now);
  if (!exp.length) return 0;
  tx(db, () => {
    for (const h of exp) {
      const r = run(db, "UPDATE holds SET status='EXPIRED' WHERE id=? AND status='HELD'", h.id);
      if (r.changes) run(db, 'UPDATE accounts SET held=held-? WHERE user_id=?', h.points, h.user_id);
    }
  });
  return exp.length;
}

function requireSpendPoint(point) {
  if (point.kind === 'earn') throw new HttpError(403, 'point_cannot_redeem', 'Эта точка не списывает баллы');
  if (!point.active) throw new HttpError(403, 'point_inactive', 'Точка отключена');
}

/** Сколько баллов можно списать на этом чеке. */
export function quoteRedeem(db, point, cardNumber, checkKop) {
  requireSpendPoint(point);
  if (!Number.isInteger(checkKop) || checkKop <= 0) throw new HttpError(400, 'bad_amount', 'Сумма чека должна быть больше нуля');
  const { user } = cardOwner(db, cardNumber);
  const s = getSettings(db);
  const acc = getAccount(db, user.id);
  const byShare = Math.floor((checkKop * point.redeem_bp) / (10000 * 100 * s.rubPerPoint));
  const maxPoints = Math.max(0, Math.min(acc.available, byShare));
  return { userId: user.id, available: acc.available, maxPoints, discountKop: maxPoints * s.rubPerPoint * 100, rubPerPoint: s.rubPerPoint };
}

export function holdRedeem(db, cfg, point, { card, checkKop, points, idemKey }) {
  requireSpendPoint(point);
  if (!idemKey) throw new HttpError(400, 'no_idempotency_key', 'Нужен idempotencyKey');
  releaseExpiredHolds(db);
  return tx(db, () => {
    const prev = one(db, 'SELECT * FROM holds WHERE idem_key=?', idemKey);
    if (prev) return { duplicate: true, holdId: prev.id, points: prev.points, status: prev.status };
    const q = quoteRedeem(db, point, card, checkKop);
    if (!Number.isInteger(points) || points <= 0) throw new HttpError(400, 'bad_points', 'Баллы — целое число больше нуля');
    if (points > q.maxPoints) throw new HttpError(422, 'over_limit', `Можно списать не больше ${q.maxPoints}`);
    const id = 'h_' + crypto.randomBytes(9).toString('base64url');
    const exp = new Date(Date.now() + cfg.holdTtlSec * 1000).toISOString();
    run(db, 'INSERT INTO holds(id,user_id,point_id,points,check_kop,status,idem_key,expires_at,created_at) VALUES(?,?,?,?,?,?,?,?,?)',
      id, q.userId, point.id, points, checkKop, 'HELD', idemKey, exp, nowIso());
    run(db, 'UPDATE accounts SET held=held+? WHERE user_id=?', points, q.userId);
    return { duplicate: false, holdId: id, points, discountKop: points * q.rubPerPoint * 100, expiresAt: exp, status: 'HELD' };
  });
}

function loadHold(db, point, id) {
  const h = one(db, 'SELECT * FROM holds WHERE id=?', id);
  if (!h || h.point_id !== point.id) throw new HttpError(404, 'hold_not_found', 'Резерв не найден');
  return h;
}

export function commitRedeem(db, point, holdId) {
  return tx(db, () => {
    const h = loadHold(db, point, holdId);
    if (h.status === 'COMMITTED') return { duplicate: true, points: h.points, status: h.status };
    if (h.status === 'HELD' && h.expires_at <= nowIso()) {
      run(db, "UPDATE holds SET status='EXPIRED' WHERE id=?", h.id);
      run(db, 'UPDATE accounts SET held=held-? WHERE user_id=?', h.points, h.user_id);
      throw new HttpError(410, 'hold_expired', 'Резерв истёк');
    }
    if (h.status !== 'HELD') throw new HttpError(409, 'hold_' + h.status.toLowerCase(), 'Резерв в состоянии ' + h.status);
    run(db, 'UPDATE accounts SET balance=balance-?, held=held-? WHERE user_id=?', h.points, h.points, h.user_id);
    run(db, "UPDATE holds SET status='COMMITTED' WHERE id=?", h.id);
    insertLedger(db, { userId: h.user_id, pointId: point.id, type: 'REDEEM', points: -h.points, baseKop: h.check_kop, receiptKey: h.id, idemKey: 'redeem:' + h.id });
    return { duplicate: false, points: h.points, status: 'COMMITTED', balance: getAccount(db, h.user_id).balance };
  });
}

export function cancelRedeem(db, point, holdId) {
  return tx(db, () => {
    const h = loadHold(db, point, holdId);
    if (h.status === 'CANCELLED' || h.status === 'EXPIRED') return { duplicate: true, status: h.status };
    if (h.status !== 'HELD') throw new HttpError(409, 'hold_' + h.status.toLowerCase(), 'Нельзя отменить: ' + h.status);
    run(db, "UPDATE holds SET status='CANCELLED' WHERE id=?", h.id);
    run(db, 'UPDATE accounts SET held=held-? WHERE user_id=?', h.points, h.user_id);
    return { duplicate: false, status: 'CANCELLED' };
  });
}

/** Возврат уже подтверждённого списания (отмена покупки): баллы возвращаются клиенту. */
export function reverseRedeem(db, point, holdId) {
  return tx(db, () => {
    const h = loadHold(db, point, holdId);
    if (h.status === 'REVERSED') return { duplicate: true, status: 'REVERSED' };
    if (h.status !== 'COMMITTED') throw new HttpError(409, 'hold_' + h.status.toLowerCase(), 'Вернуть можно только подтверждённое списание');
    run(db, 'UPDATE accounts SET balance=balance+? WHERE user_id=?', h.points, h.user_id);
    run(db, "UPDATE holds SET status='REVERSED' WHERE id=?", h.id);
    insertLedger(db, { userId: h.user_id, pointId: point.id, type: 'REDEEM_REVERSAL', points: h.points, receiptKey: h.id, idemKey: 'redeem-rev:' + h.id });
    return { duplicate: false, status: 'REVERSED', balance: getAccount(db, h.user_id).balance };
  });
}

/** Ручная корректировка администратором (журналируется). */
export function adjust(db, userId, points, reason, actor) {
  if (!Number.isInteger(points) || points === 0) throw new HttpError(400, 'bad_points', 'Целое число, не ноль');
  return tx(db, () => {
    const acc = one(db, 'SELECT balance,held FROM accounts WHERE user_id=?', userId);
    if (!acc) throw new HttpError(404, 'no_user', 'Пользователь не найден');
    if (acc.balance + points < acc.held) throw new HttpError(422, 'below_hold', 'Баланс не может стать меньше резерва');
    insertLedger(db, { userId, pointId: 'admin', type: 'ADJUST', points, idemKey: 'adj:' + crypto.randomUUID(), meta: { reason, actor } });
    run(db, 'UPDATE accounts SET balance=balance+? WHERE user_id=?', points, userId);
    return getAccount(db, userId);
  });
}

export function history(db, userId, { before, limit = 30 } = {}) {
  limit = Math.min(Math.max(Number(limit) || 30, 1), 100);
  const rows = before
    ? all(db, 'SELECT l.id,l.type,l.points,l.base_kop,l.pct_bp,l.created_at,l.point_id,p.name point_name FROM ledger l LEFT JOIN points p ON p.id=l.point_id WHERE l.user_id=? AND l.id<? ORDER BY l.id DESC LIMIT ?', userId, Number(before), limit)
    : all(db, 'SELECT l.id,l.type,l.points,l.base_kop,l.pct_bp,l.created_at,l.point_id,p.name point_name FROM ledger l LEFT JOIN points p ON p.id=l.point_id WHERE l.user_id=? ORDER BY l.id DESC LIMIT ?', userId, limit);
  return rows.map((r) => ({ ...r, point_name: r.point_name || (r.point_id === 'admin' ? 'Корректировка' : r.point_id) }));
}

/** Сверка: баланс в accounts должен равняться сумме журнала. Возвращает расхождения. */
export function reconcile(db) {
  return all(db, `SELECT a.user_id, a.balance, COALESCE(SUM(l.points),0) ledger_sum
    FROM accounts a LEFT JOIN ledger l ON l.user_id=a.user_id GROUP BY a.user_id
    HAVING a.balance != COALESCE(SUM(l.points),0)`);
}
export { formatKop };
