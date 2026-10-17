/**
 * Ядро лояльности: правила начисления/списания, журнал, баланс.
 * Все изменения баланса идут через tx() (BEGIN IMMEDIATE), баланс = сумма ledger.
 */
import crypto from 'node:crypto';
import { tx, one, all, run } from './db.js';
import { HttpError, nowIso, parseKop, divRound, luhnDigit, formatKop } from './util.js';

const DEFAULT_SETTINGS = {
  rub_per_point: '1', rounding: 'half_up', currency: '₽',
  // «Цена 3» (скидка Set10 по карте) и баллы. Строка считается «со скидкой Set10», если на ней есть скидка
  // не от нашего плагина; если задан список price3_action_ids — только скидка с этими id/guid акций Set10.
  accrue_on_discounted: '1',   // начислять баллы на строки со скидкой Set10 (цена 3): 1 — да, 0 — нет
  redeem_on_discounted: '0',   // разрешать списание баллов на строки со скидкой Set10: 1 — да, 0 — нет
  price3_action_ids: '',       // id или guid акций Set10 «цена 3» через запятую (пусто = любая скидка Set10)
};
const BOOL_SETTINGS = ['accrue_on_discounted', 'redeem_on_discounted'];

export function getSettings(db) {
  const s = { ...DEFAULT_SETTINGS };
  for (const r of all(db, 'SELECT key,value FROM settings')) s[r.key] = r.value;
  return { rubPerPoint: Number(s.rub_per_point), rounding: s.rounding, currency: s.currency,
    accrueOnDiscounted: s.accrue_on_discounted === '1', redeemOnDiscounted: s.redeem_on_discounted === '1',
    price3ActionIds: s.price3_action_ids.split(',').map((x) => x.trim()).filter(Boolean) };
}
export function setSetting(db, key, value) {
  if (!(key in DEFAULT_SETTINGS)) throw new HttpError(400, 'bad_setting', 'Неизвестная настройка');
  if (key === 'rub_per_point' && !(Number(value) > 0)) throw new HttpError(400, 'bad_value', 'rub_per_point > 0');
  if (key === 'rounding' && !['half_up', 'floor'].includes(value)) throw new HttpError(400, 'bad_value', 'half_up | floor');
  if (BOOL_SETTINGS.includes(key)) value = value === true || value === '1' || value === 1 ? '1' : '0';
  if (key === 'price3_action_ids' && String(value).length > 2000) throw new HttpError(400, 'bad_value', 'Слишком длинный список');
  run(db, 'INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value', key, String(value));
}

/* ---------------- точки ---------------- */
export function seedPoints(db, demo) {
  const def = [
    // both: в гипермаркете баллы и начисляются, и (если задан % списания) списываются через плагин кассы
    ['hypermarket', 'Гипермаркет', 'both', demo ? 500 : 0, 0],
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
/** Неизменный ID профиля для клиента, кассы и поддержки (телефон и карты могут меняться). */
export const profileId = (userId) => String(1000000 + Number(userId));
export function generateCardNumber(prefix, length) {
  const bodyLen = length - 1 - prefix.length;
  if (bodyLen < 4) throw new Error('CARD_LENGTH слишком мал для префикса');
  let body = '';
  while (body.length < bodyLen) body += crypto.randomInt(0, 10);
  return prefix + body + luhnDigit(prefix + body);
}

/**
 * Выдаёт клиенту виртуальную карту (её номер зашит в QR).
 * pool: берётся свободный номер из пула карт, заведённых в Set10 (только такие касса узнает и даст «цену 3»);
 * generate: номер генерируется (пробный запуск без Set10).
 * @return номер карты или null, если пул пуст (карта будет выдана позже, при следующем открытии приложения)
 */
export function issueCard(db, cfg, userId) {
  return tx(db, () => {
    const t = nowIso();
    if (cfg.cardIssueMode === 'pool') {
      const free = one(db, "SELECT number FROM cards WHERE status='free' AND kind='virtual' ORDER BY rowid LIMIT 1");
      if (!free) return null;
      run(db, "UPDATE cards SET user_id=?, status='active', bound_at=? WHERE number=? AND status='free'", userId, t, free.number);
      return free.number;
    }
    for (let i = 0; i < 20; i++) {
      const num = generateCardNumber(cfg.cardPrefix, cfg.cardLength);
      if (!one(db, 'SELECT 1 FROM cards WHERE number=?', num)) {
        run(db, "INSERT INTO cards(number,user_id,status,kind,created_at,bound_at) VALUES(?,?,'active','virtual',?,?)", num, userId, t, t);
        return num;
      }
    }
    throw new Error('не удалось выдать номер карты');
  });
}

/** Виртуальная карта клиента; если её нет (пул был пуст при регистрации) — пробует выдать сейчас. */
export function ensureCard(db, cfg, userId) {
  const c = one(db, "SELECT * FROM cards WHERE user_id=? AND status='active' AND kind='virtual' ORDER BY rowid LIMIT 1", userId);
  if (c) return c;
  const num = issueCard(db, cfg, userId);
  return num ? findCard(db, num) : null;
}

export function createUserWithCard(db, cfg, phone, consent) {
  return tx(db, () => {
    const t = nowIso();
    const u = run(db, 'INSERT INTO users(phone,consent_at,created_at) VALUES(?,?,?)', phone, consent ? t : null, t);
    const userId = Number(u.lastInsertRowid);
    run(db, 'INSERT INTO accounts(user_id) VALUES(?)', userId);
    issueCard(db, cfg, userId);
    return userId;
  });
}

const CARD_RE = /^[0-9A-Za-z]{4,32}$/;
export const activationHash = (cfg, number, code) => crypto.createHmac('sha256', cfg.secret).update(number + ':' + String(code).trim()).digest('hex');

/**
 * Загрузка номеров карт в пул (номера должны уже существовать в Set10 как карты нужного типа).
 * items: [{number, code?}] — code: код активации, напечатанный на пластиковой карте (для привязки в приложении).
 */
export function importCards(db, cfg, kind, items) {
  if (!['virtual', 'physical'].includes(kind)) throw new HttpError(400, 'bad_kind', 'kind: virtual | physical');
  if (!Array.isArray(items) || !items.length) throw new HttpError(400, 'no_cards', 'Нет номеров карт');
  if (items.length > 100000) throw new HttpError(400, 'too_many', 'Не больше 100 000 карт за раз');
  // conflicts: номер уже загружен с другим типом (виртуальные и пластиковые диапазоны не должны пересекаться)
  const res = { added: 0, skipped: 0, invalid: [], conflicts: [], withoutCode: 0 };
  tx(db, () => {
    const t = nowIso();
    for (const it of items) {
      const number = String(it.number ?? '').trim();
      if (!CARD_RE.test(number)) { if (res.invalid.length < 20) res.invalid.push(number); continue; }
      const code = it.code == null || it.code === '' ? null : String(it.code).trim();
      const ex = one(db, 'SELECT kind FROM cards WHERE number=?', number);
      if (ex) { if (ex.kind !== kind) res.conflicts.push(number); else res.skipped++; continue; }
      run(db, "INSERT INTO cards(number,user_id,status,kind,activation_hash,created_at) VALUES(?,NULL,'free',?,?,?)",
        number, kind, code ? activationHash(cfg, number, code) : null, t);
      res.added++;
      if (kind === 'physical' && !code) res.withoutCode++;
    }
  });
  return res;
}

/** Диапазон номеров (одинаковой длины, ведущие нули сохраняются). */
export function expandRange(from, to) {
  from = String(from ?? '').trim(); to = String(to ?? '').trim();
  if (!/^\d{4,32}$/.test(from) || !/^\d{4,32}$/.test(to) || from.length !== to.length) throw new HttpError(400, 'bad_range', 'Диапазон: два номера из цифр одинаковой длины');
  const a = BigInt(from), b = BigInt(to);
  if (b < a || b - a >= 100000n) throw new HttpError(400, 'bad_range', 'Диапазон: «с» ≤ «по», не больше 100 000 номеров');
  const out = [];
  for (let n = a; n <= b; n++) out.push({ number: n.toString().padStart(from.length, '0') });
  return out;
}

/** Блокировка карты администратором (утеря, мошенничество). Баллы остаются на счёте клиента. */
export function setCardBlocked(db, number, blocked) {
  const c = findCard(db, number);
  if (!c) throw new HttpError(404, 'card_not_found', 'Карта не найдена');
  if (blocked && c.status !== 'active') throw new HttpError(409, 'bad_status', 'Заблокировать можно только выданную карту');
  if (!blocked && c.status !== 'blocked') throw new HttpError(409, 'bad_status', 'Карта не заблокирована');
  if (!blocked && c.kind === 'physical' && c.user_id && one(db, "SELECT 1 FROM cards WHERE user_id=? AND kind='physical' AND status='active'", c.user_id)) {
    throw new HttpError(409, 'physical_exists', 'У клиента уже есть другая активная пластиковая карта');
  }
  run(db, 'UPDATE cards SET status=? WHERE number=?', blocked ? 'blocked' : 'active', c.number);
  return { card: c.number, status: blocked ? 'blocked' : 'active' };
}

/**
 * Удаление аккаунта: виртуальная карта закрывается навсегда; пластиковая возвращается в «свободные» —
 * пластик у человека на руках, при следующей покупке на ней начнёт копиться новый гостевой счёт.
 */
export function releaseCardsOnDelete(db, userId) {
  run(db, "UPDATE cards SET status='closed' WHERE user_id=? AND kind='virtual'", userId);
  run(db, "UPDATE cards SET status='free', user_id=NULL, bound_at=NULL WHERE user_id=? AND kind='physical' AND status='active'", userId);
  run(db, "UPDATE cards SET status='closed' WHERE user_id=? AND kind='physical'", userId);   // заблокированные ранее
}

export function poolStats(db) {
  return all(db, "SELECT kind, status, COUNT(*) n FROM cards GROUP BY kind, status ORDER BY kind, status");
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

/**
 * Владелец карты для начисления. Пластиковая карта из пула, которую ещё никто не привязал, при первой покупке
 * получает «гостевой» счёт (пользователь без телефона): баллы копятся на нём и переходят клиенту при привязке.
 */
export function accrualOwner(db, number) {
  const c = findCard(db, number);
  if (c && c.kind === 'physical' && c.status === 'free') {
    const t = nowIso();
    const u = run(db, 'INSERT INTO users(phone,created_at,stub) VALUES(NULL,?,1)', t);
    const userId = Number(u.lastInsertRowid);
    run(db, 'INSERT INTO accounts(user_id) VALUES(?)', userId);
    run(db, "UPDATE cards SET user_id=?, status='active' WHERE number=?", userId, c.number);
  }
  return cardOwner(db, number);
}

/**
 * Привязка пластиковой карты к клиенту (в приложении: номер с карты + код активации, если он печатается).
 * Баллы, накопленные на карте до привязки, переносятся на счёт клиента.
 * Правило: у телефона не больше одной виртуальной и одной пластиковой карты, порядок появления любой.
 * Вторую пластиковую можно привязать только заменой (replace=true): старая блокируется (утеря, новая карта).
 */
export function bindPhysicalCard(db, cfg, userId, number, code, replace = false, { skipCode = false } = {}) {
  number = String(number ?? '').replace(/\s/g, '');
  return tx(db, () => {
    const c = findCard(db, number);
    if (!c || c.kind !== 'physical' || !['free', 'active'].includes(c.status)) throw new HttpError(404, 'card_not_found', 'Карта не найдена. Проверьте номер');
    if (!skipCode && c.activation_hash && !(code && tsEqHex(activationHash(cfg, number, code), c.activation_hash))) throw new HttpError(400, 'wrong_code', 'Неверный код активации');
    if (c.user_id === userId) return { card: number, transferred: 0 };
    const mine = one(db, "SELECT number FROM cards WHERE user_id=? AND kind='physical' AND status='active' AND number<>?", userId, number);
    if (mine && !replace) throw new HttpError(409, 'physical_exists', `У вас уже есть пластиковая карта ****${mine.number.slice(-4)}. Заменить её новой?`);
    let transferred = 0;
    if (c.user_id) {
      const owner = one(db, 'SELECT * FROM users WHERE id=?', c.user_id);
      if (!owner.stub) throw new HttpError(409, 'card_bound', 'Карта уже привязана к другому номеру телефона');
      const acc = one(db, 'SELECT balance, held FROM accounts WHERE user_id=?', owner.id);
      transferred = acc.balance - acc.held;
      if (transferred > 0) {
        insertLedger(db, { userId: owner.id, pointId: 'admin', type: 'ADJUST', points: -transferred, idemKey: `bind-out:${number}:${owner.id}`, meta: { reason: 'card_bind_transfer', card: number, to: userId } });
        insertLedger(db, { userId, pointId: 'admin', type: 'ADJUST', points: transferred, idemKey: `bind-in:${number}:${owner.id}`, meta: { reason: 'card_bind_transfer', card: number, from: owner.id } });
        run(db, 'UPDATE accounts SET balance=balance-? WHERE user_id=?', transferred, owner.id);
        run(db, 'UPDATE accounts SET balance=balance+? WHERE user_id=?', transferred, userId);
      }
      run(db, 'UPDATE users SET deleted_at=? WHERE id=?', nowIso(), owner.id);
    }
    if (mine) run(db, "UPDATE cards SET status='blocked' WHERE number=?", mine.number);
    run(db, "UPDATE cards SET user_id=?, status='active', bound_at=? WHERE number=?", userId, nowIso(), number);
    return { card: number, transferred, replaced: mine ? mine.number : null };
  });
}
const tsEqHex = (a, b) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

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

/**
 * Строка чека со скидкой Set10 («цена 3» и др. акции Set10)? Скидку нашего плагина (списание баллов, ownDiscount) не считаем.
 * Если в настройках заданы id/guid акций «цены 3», то только они.
 */
export function hasSet10Discount(line, settings) {
  if (settings.price3ActionIds.length) {
    const ids = new Set(settings.price3ActionIds);
    return (line.discounts || []).some((d) => (d.id != null && ids.has(String(d.id))) || (d.guid != null && ids.has(String(d.guid))));
  }
  const total = Math.abs(parseKop(line.discount ?? '0')), own = Math.abs(parseKop(line.ownDiscount ?? '0'));
  return total - own > 0;
}

/** База начисления: строки с accrueAllowed!==false (и без цены 3, если так настроено), сумма уже после скидок. Нет строк — итог чека. */
export function accrualBase(payload, settings = { accrueOnDiscounted: true, price3ActionIds: [] }) {
  const lines = Array.isArray(payload.lines) ? payload.lines : [];
  if (lines.length) {
    return lines.filter((l) => l.accrueAllowed !== false && (settings.accrueOnDiscounted || !hasSet10Discount(l, settings)))
      .reduce((s, l) => s + Math.abs(parseKop(l.sum ?? '0')), 0);
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
 * Если в чеке были списаны баллы (payload.redemption от плагина), списание подтверждается в той же транзакции.
 * Возвращает {duplicate, accrued, redeemed, balance, ...}; ошибки — HttpError с кодами контракта плагина.
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
    const baseKop = accrualBase(payload, settings);
    const receiptKey = payload.receipt?.key || key;

    if (op === 'SALE') {
      const { user } = accrualOwner(db, payload.card?.number);
      const redeemed = commitReceiptRedemption(db, point, user.id, payload.redemption, receiptKey, key);
      if (!redeemed && payload.receipt?.ref) releaseReceiptHold(db, point, String(payload.receipt.ref)); // скидки в чеке не было: резерв не нужен
      const points = calcPoints(baseKop, point.accrual_bp, settings);
      insertLedger(db, { userId: user.id, pointId: point.id, type: 'ACCRUAL', points, baseKop, pctBp: point.accrual_bp, receiptKey, idemKey: key,
        meta: { total: payload.receipt?.total ?? null, registerId: payload.registerId ?? null, ref: payload.redemption?.ref ?? payload.receipt?.ref ?? null } });
      run(db, 'UPDATE accounts SET balance=balance+? WHERE user_id=?', points, user.id);
      return { duplicate: false, accrued: points, redeemed, balance: getAccount(db, user.id).balance };
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
    const returned = returnReceiptRedemption(db, point, orig, payload, key);   // сначала вернуть списанные в чеке баллы
    const acc = one(db, 'SELECT balance, held FROM accounts WHERE user_id=?', orig.user_id);
    const take = Math.min(want, acc.balance - acc.held > 0 ? acc.balance - acc.held : 0); // не уходим в минус и не трогаем резерв
    insertLedger(db, { userId: orig.user_id, pointId: point.id, type: 'ACCRUAL_REVERSAL', points: -take, baseKop, pctBp: orig.pct_bp, receiptKey: origKey, idemKey: key,
      meta: { wanted: want, shortfall: want - take } });
    run(db, 'UPDATE accounts SET balance=balance-? WHERE user_id=?', take, orig.user_id);
    return { duplicate: false, accrued: -take, redeemReturned: returned, shortfall: want - take, balance: getAccount(db, orig.user_id).balance };
  });
}

/* ---------------- списание баллов в чеке кассы (плагин гипермаркета) ----------------
 * 1) подытог: плагин вызывает reservePos — сервер считает лимит, резервирует баллы и раскладывает скидку по строкам;
 * 2) чек пробит: плагин присылает начисление с redemption {ref, points} — списание подтверждается (commitReceiptRedemption);
 * 3) отмена расчёта/чека: cancelPos (или резерв истекает сам через POS_HOLD_TTL_SEC).
 */

/** Сколько можно списать на строках чека и как разложить скидку. */
function posEligible(lines, settings) {
  return (Array.isArray(lines) ? lines : []).filter((l) => l && l.payBonusAllowed !== false && (settings.redeemOnDiscounted || !hasSet10Discount(l, settings)))
    .map((l) => {
      const sum = Math.abs(parseKop(l.sum ?? '0')), min = l.minSum != null ? Math.abs(parseKop(l.minSum)) : 0;
      return { number: l.number, sum, cap: Math.max(0, sum - Math.max(min, 1)) }; // на строке остаётся хотя бы 1 копейка
    }).filter((l) => l.sum > 0);
}

/** Раскладка скидки (копейки) пропорционально суммам строк, не больше «ёмкости» строки. */
export function spreadDiscount(lines, discountKop) {
  const total = lines.reduce((s, l) => s + l.sum, 0);
  const out = lines.map((l) => ({ number: l.number, kop: Math.min(l.cap, Math.floor((discountKop * l.sum) / (total || 1))) }));
  let left = discountKop - out.reduce((s, x) => s + x.kop, 0);
  for (let i = 0; left > 0 && i < out.length; i++) {
    const add = Math.min(left, lines[i].cap - out[i].kop);
    out[i].kop += add; left -= add;
  }
  return { lines: out.filter((x) => x.kop > 0), unplaced: left };
}

/**
 * Потолок списания по чеку без резерва (режим «кассир»: касса показывает его, кассир вводит сумму по просьбе клиента).
 * Согласие клиента в приложении здесь не требуется — клиент просит списать сам, но карта должна быть привязана к телефону.
 */
export function quotePos(db, point, { card, lines }) {
  const { user } = cardOwner(db, card);
  const acc = getAccount(db, user.id);
  const res = { profileId: profileId(user.id), balance: acc.balance, available: acc.available, maxPoints: 0 };
  if (!point.active || point.kind === 'earn' || point.redeem_bp <= 0) return { ...res, reason: 'point_no_redeem' };
  if (user.stub) return { ...res, reason: 'card_not_bound' };
  const settings = getSettings(db);
  const eligible = posEligible(lines, settings);
  const kopPerPoint = settings.rubPerPoint * 100;
  const baseKop = eligible.reduce((x, l) => x + l.sum, 0), capKop = eligible.reduce((x, l) => x + l.cap, 0);
  const maxPoints = Math.max(0, Math.min(acc.available, Math.floor((baseKop * point.redeem_bp) / (10000 * kopPerPoint)), Math.floor(capKop / kopPerPoint)));
  return { ...res, maxPoints, rubPerPoint: settings.rubPerPoint };
}

/**
 * Резерв и раскладка скидки по чеку.
 * mode=auto: максимум по правилам, только если клиент включил списание в приложении;
 * mode=cashier: сумма, которую ввёл кассир (points), не больше потолка.
 */
export function reservePos(db, cfg, point, { ref, card, lines, mode = 'auto', points: requested }) {
  if (typeof ref !== 'string' || !ref || ref.length > 200) throw new HttpError(400, 'no_ref', 'Нужен ref чека');
  const none = (reason) => ({ points: 0, discount: '0.00', lines: [], reason });
  if (!point.active) return none('point_inactive');
  if (point.kind === 'earn' || point.redeem_bp <= 0) { cancelPos(db, point, ref); return none('point_no_redeem'); }
  const settings = getSettings(db);
  const { user } = cardOwner(db, card);
  if (user.stub) return none('card_not_bound');
  if (mode !== 'cashier' && !user.auto_redeem) { cancelPos(db, point, ref); return none('not_opted_in'); }
  if (mode === 'cashier' && !(Number.isInteger(requested) && requested > 0)) { cancelPos(db, point, ref); return none('nothing_requested'); }
  releaseExpiredHolds(db);
  const eligible = posEligible(lines, settings);
  const baseKop = eligible.reduce((s, l) => s + l.sum, 0);
  const kopPerPoint = settings.rubPerPoint * 100;
  const done = one(db, "SELECT * FROM holds WHERE point_id=? AND ref=? AND status='COMMITTED' AND user_id=?", point.id, ref, user.id);
  if (done) {   // уже списано кнопкой кассира (writeOff): пересчёт скидок не меняет сумму
    const spread = spreadDiscount(eligible, Math.round(done.points * kopPerPoint));
    return { holdId: done.id, points: done.points, committed: true, discount: formatKop(Math.round(done.points * kopPerPoint)), lines: spread.lines.map((l) => ({ number: l.number, discount: formatKop(l.kop) })) };
  }
  return tx(db, () => {
    const ex = one(db, "SELECT * FROM holds WHERE point_id=? AND ref=? AND status='HELD'", point.id, ref);
    const acc = one(db, 'SELECT balance, held FROM accounts WHERE user_id=?', user.id);
    const available = acc.balance - acc.held + (ex && ex.user_id === user.id ? ex.points : 0);
    const capKop = eligible.reduce((s, l) => s + l.cap, 0);
    let points = Math.max(0, Math.min(available, Math.floor((baseKop * point.redeem_bp) / (10000 * kopPerPoint)), Math.floor(capKop / kopPerPoint)));
    if (mode === 'cashier') points = Math.min(points, requested);
    if (ex) { run(db, 'UPDATE accounts SET held=held-? WHERE user_id=?', ex.points, ex.user_id); }
    if (points <= 0) {
      if (ex) run(db, "UPDATE holds SET status='CANCELLED' WHERE id=?", ex.id);
      return none(available <= 0 ? 'no_balance' : 'nothing_eligible');
    }
    const spread = spreadDiscount(eligible, Math.round(points * kopPerPoint));
    const exp = new Date(Date.now() + cfg.posHoldTtlSec * 1000).toISOString();
    let id = ex?.id;
    if (ex) run(db, 'UPDATE holds SET user_id=?, points=?, check_kop=?, expires_at=? WHERE id=?', user.id, points, baseKop, exp, ex.id);
    else {
      id = 'h_' + crypto.randomBytes(9).toString('base64url');
      run(db, "INSERT INTO holds(id,user_id,point_id,points,check_kop,status,idem_key,expires_at,created_at,ref) VALUES(?,?,?,?,?,'HELD',?,?,?,?)",
        id, user.id, point.id, points, baseKop, 'pos:' + id, exp, nowIso(), ref);
    }
    run(db, 'UPDATE accounts SET held=held+? WHERE user_id=?', points, user.id);
    return { holdId: id, points, discount: formatKop(Math.round(points * kopPerPoint)), lines: spread.lines.map((l) => ({ number: l.number, discount: formatKop(l.kop) })), expiresAt: exp };
  });
}

/** Кнопка «оплатить бонусами» (CardPlugin.writeOff): списать зарезервированное под чек сразу. txId = id резерва. */
export function writeoffPos(db, point, { ref, points, card }) {
  const owner = card ? cardOwner(db, card).user.id : null;   // плагин передаёт карту: резерв должен быть её владельца
  return tx(db, () => {
    const h = one(db, "SELECT * FROM holds WHERE point_id=? AND ref=? AND status IN ('HELD','COMMITTED') AND (? IS NULL OR user_id=?) ORDER BY created_at DESC LIMIT 1",
      point.id, String(ref ?? ''), owner, owner);
    if (!h) throw new HttpError(409, 'no_reserve', 'Нет резерва баллов по этому чеку: пересчитайте чек');
    if (h.status === 'COMMITTED') return { txId: h.id, points: h.points, duplicate: true, balance: getAccount(db, h.user_id).balance };
    const take = Number.isInteger(points) && points > 0 ? Math.min(points, h.points) : h.points;
    run(db, 'UPDATE accounts SET held=held-?, balance=balance-? WHERE user_id=?', h.points, take, h.user_id);
    run(db, "UPDATE holds SET status='COMMITTED', points=? WHERE id=?", take, h.id);
    insertLedger(db, { userId: h.user_id, pointId: point.id, type: 'REDEEM', points: -take, baseKop: h.check_kop, receiptKey: 'pos:' + h.ref, idemKey: 'redeem:' + h.id, meta: { ref: h.ref, via: 'writeOff' } });
    return { txId: h.id, points: take, balance: getAccount(db, h.user_id).balance };
  });
}

/** Откат списания (CardPlugin.rollback): чек аннулирован или кассир отменил оплату бонусами. Идемпотентно. */
export function rollbackPos(db, point, txId) {
  return tx(db, () => {
    const h = one(db, 'SELECT * FROM holds WHERE id=? AND point_id=?', String(txId ?? ''), point.id);
    if (!h) throw new HttpError(404, 'hold_not_found', 'Списание не найдено');
    if (h.status === 'HELD') {
      run(db, "UPDATE holds SET status='CANCELLED' WHERE id=?", h.id);
      run(db, 'UPDATE accounts SET held=held-? WHERE user_id=?', h.points, h.user_id);
      return { status: 'CANCELLED' };
    }
    if (h.status !== 'COMMITTED') return { status: h.status, duplicate: true };
    run(db, "UPDATE holds SET status='REVERSED' WHERE id=?", h.id);
    run(db, 'UPDATE accounts SET balance=balance+? WHERE user_id=?', h.points, h.user_id);
    insertLedger(db, { userId: h.user_id, pointId: point.id, type: 'REDEEM_REVERSAL', points: h.points, receiptKey: 'pos:' + h.ref, idemKey: 'redeem-rev:' + h.id, meta: { via: 'rollback' } });
    return { status: 'REVERSED', balance: getAccount(db, h.user_id).balance };
  });
}

export function cancelPos(db, point, ref) {
  return tx(db, () => {
    const h = one(db, "SELECT * FROM holds WHERE point_id=? AND ref=? AND status='HELD'", point.id, String(ref ?? ''));
    if (!h) return { cancelled: false };
    run(db, "UPDATE holds SET status='CANCELLED' WHERE id=?", h.id);
    run(db, 'UPDATE accounts SET held=held-? WHERE user_id=?', h.points, h.user_id);
    return { cancelled: true, points: h.points };
  });
}

/**
 * Подтверждение списания при пробитии чека. Чек уже фискализирован со скидкой, поэтому списывается столько, сколько
 * реально дано в чеке (redemption.points), даже если резерв истёк; если баллов не хватает — списываем остаток, недостачу пишем в журнал.
 */
function commitReceiptRedemption(db, point, userId, redemption, receiptKey, key) {
  const want = Number(redemption?.points);
  if (!redemption || !Number.isInteger(want) || want <= 0) return 0;
  const h = redemption.ref ? one(db, 'SELECT * FROM holds WHERE point_id=? AND ref=? ORDER BY created_at DESC LIMIT 1', point.id, String(redemption.ref)) : null;
  if (h && h.status === 'COMMITTED' && h.user_id === userId) return h.points;   // уже списано кнопкой кассира (writeOff)
  if (h && h.status === 'HELD') {
    run(db, "UPDATE holds SET status='COMMITTED' WHERE id=?", h.id);
    run(db, 'UPDATE accounts SET held=held-? WHERE user_id=?', h.points, h.user_id);
  }
  const acc = one(db, 'SELECT balance, held FROM accounts WHERE user_id=?', userId);
  const take = Math.max(0, Math.min(want, acc.balance - acc.held));
  insertLedger(db, { userId, pointId: point.id, type: 'REDEEM', points: -take, receiptKey, idemKey: 'redeem:' + key,
    meta: { ref: redemption.ref ?? null, holdId: h?.id ?? null, wanted: want, shortfall: want - take } });
  run(db, 'UPDATE accounts SET balance=balance-? WHERE user_id=?', take, userId);
  return take;
}

function releaseReceiptHold(db, point, ref) {
  const h = one(db, "SELECT * FROM holds WHERE point_id=? AND ref=? AND status='HELD'", point.id, ref);
  if (!h) return;
  run(db, "UPDATE holds SET status='CANCELLED' WHERE id=?", h.id);
  run(db, 'UPDATE accounts SET held=held-? WHERE user_id=?', h.points, h.user_id);
}

/** Возврат товара по чеку, где списывались баллы: возвращаем списанное пропорционально сумме возврата. */
function returnReceiptRedemption(db, point, orig, payload, key) {
  let ref = payload.originalReceipt?.ref ?? null;
  try { ref = JSON.parse(orig.meta || '{}').ref || ref; } catch { /* старые записи без meta.ref */ }
  const keys = [orig.receipt_key, 'pos:' + (ref ?? '-')];   // списание при пробитии или кнопкой кассира до пробития
  const spent = one(db, "SELECT COALESCE(SUM(-points),0) s FROM ledger WHERE type='REDEEM' AND receipt_key IN (?,?) AND point_id=?", ...keys, point.id).s;
  if (spent <= 0) return 0;
  const back = one(db, "SELECT COALESCE(SUM(points),0) s FROM ledger WHERE type='REDEEM_REVERSAL' AND receipt_key IN (?,?) AND point_id=?", ...keys, point.id).s;
  let origTotal = 0;
  try { origTotal = Math.abs(parseKop(String(payload.originalReceipt?.total ?? JSON.parse(orig.meta || '{}').total ?? '0'))); } catch { origTotal = 0; }
  const refundTotal = Math.abs(parseKop(String(payload.receipt?.total ?? '0')));
  const share = origTotal > 0 ? Math.min(1, refundTotal / origTotal) : 1;
  const ret = Math.min(spent - back, Math.round(spent * share));
  if (ret <= 0) return 0;
  insertLedger(db, { userId: orig.user_id, pointId: point.id, type: 'REDEEM_REVERSAL', points: ret, receiptKey: orig.receipt_key, idemKey: 'redeem-rev:' + key, meta: { share } });
  run(db, 'UPDATE accounts SET balance=balance+? WHERE user_id=?', ret, orig.user_id);
  return ret;
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
  if (user.stub) throw new HttpError(422, 'card_not_bound', 'Карта не привязана к телефону: списание недоступно. Привяжите карту в приложении');
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
    if (prev) return { duplicate: true, holdId: prev.id, points: prev.points, status: prev.status, confirmRequired: !!prev.confirm_code };
    const q = quoteRedeem(db, point, card, checkKop);
    if (!Number.isInteger(points) || points <= 0) throw new HttpError(400, 'bad_points', 'Баллы — целое число больше нуля');
    if (points > q.maxPoints) throw new HttpError(422, 'over_limit', `Можно списать не больше ${q.maxPoints}`);
    const id = 'h_' + crypto.randomBytes(9).toString('base64url');
    const exp = new Date(Date.now() + cfg.holdTtlSec * 1000).toISOString();
    // если точка требует подтверждения, код видит только клиент (в приложении) и называет его кассиру
    const code = point.confirm_redeem ? String(crypto.randomInt(0, 10000)).padStart(4, '0') : null;
    run(db, 'INSERT INTO holds(id,user_id,point_id,points,check_kop,status,idem_key,expires_at,created_at,confirm_code) VALUES(?,?,?,?,?,?,?,?,?,?)',
      id, q.userId, point.id, points, checkKop, 'HELD', idemKey, exp, nowIso(), code);
    run(db, 'UPDATE accounts SET held=held+? WHERE user_id=?', points, q.userId);
    return { duplicate: false, holdId: id, points, discountKop: points * q.rubPerPoint * 100, expiresAt: exp, status: 'HELD', confirmRequired: !!code };
  });
}

function loadHold(db, point, id) {
  const h = one(db, 'SELECT * FROM holds WHERE id=?', id);
  if (!h || h.point_id !== point.id) throw new HttpError(404, 'hold_not_found', 'Резерв не найден');
  return h;
}

export function commitRedeem(db, cfg, point, holdId, code) {
  const r = tx(db, () => {
    const h = loadHold(db, point, holdId);
    if (h.status === 'COMMITTED') return { duplicate: true, points: h.points, status: h.status };
    if (h.status === 'HELD' && h.expires_at <= nowIso()) {
      run(db, "UPDATE holds SET status='EXPIRED' WHERE id=?", h.id);
      run(db, 'UPDATE accounts SET held=held-? WHERE user_id=?', h.points, h.user_id);
      throw new HttpError(410, 'hold_expired', 'Резерв истёк');
    }
    if (h.status !== 'HELD') throw new HttpError(409, 'hold_' + h.status.toLowerCase(), 'Резерв в состоянии ' + h.status);
    if (h.confirm_code && String(code ?? '') !== h.confirm_code) {
      // счётчик попыток должен сохраниться, поэтому ошибка бросается снаружи tx
      const attempts = h.confirm_attempts + 1;
      if (attempts >= cfg.redeemConfirmAttempts) {
        run(db, "UPDATE holds SET status='CANCELLED', confirm_attempts=? WHERE id=?", attempts, h.id);
        run(db, 'UPDATE accounts SET held=held-? WHERE user_id=?', h.points, h.user_id);
        return { fail: 'confirm_failed' };
      }
      run(db, 'UPDATE holds SET confirm_attempts=? WHERE id=?', attempts, h.id);
      return { fail: code ? 'wrong_code' : 'confirm_required' };
    }
    run(db, 'UPDATE accounts SET balance=balance-?, held=held-? WHERE user_id=?', h.points, h.points, h.user_id);
    run(db, "UPDATE holds SET status='COMMITTED', confirm_code=NULL WHERE id=?", h.id);
    insertLedger(db, { userId: h.user_id, pointId: point.id, type: 'REDEEM', points: -h.points, baseKop: h.check_kop, receiptKey: h.id, idemKey: 'redeem:' + h.id });
    return { duplicate: false, points: h.points, status: 'COMMITTED', balance: getAccount(db, h.user_id).balance };
  });
  if (r.fail === 'confirm_failed') throw new HttpError(409, 'confirm_failed', 'Слишком много неверных кодов: списание отменено');
  if (r.fail === 'confirm_required') throw new HttpError(400, 'confirm_required', 'Нужен код подтверждения из приложения клиента');
  if (r.fail) throw new HttpError(400, 'wrong_code', 'Неверный код подтверждения');
  return r;
}

/** Ожидающие подтверждения списания клиента (код показывается в приложении). */
export function pendingConfirmations(db, userId) {
  return all(db, "SELECT h.id, h.points, h.confirm_code code, h.expires_at, p.name point_name FROM holds h JOIN points p ON p.id=h.point_id WHERE h.user_id=? AND h.status='HELD' AND h.confirm_code IS NOT NULL AND h.expires_at>?", userId, nowIso());
}

export function cancelRedeem(db, point, holdId) {
  return tx(db, () => {
    const h = loadHold(db, point, holdId);
    if (h.status === 'CANCELLED' || h.status === 'EXPIRED') return { duplicate: true, status: h.status };
    if (h.status !== 'HELD') throw new HttpError(409, 'hold_' + h.status.toLowerCase(), 'Нельзя отменить: ' + h.status);
    run(db, "UPDATE holds SET status='CANCELLED', confirm_code=NULL WHERE id=?", h.id);
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
