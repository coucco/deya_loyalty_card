// Пул карт Set10, пластиковые карты, согласия, списание в чеке гипермаркета, подтверждение кодом, метрики.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, receipt } from './helper.js';

let S, hyper, cinema;
const admin = (m, p, body) => S.call(m, p, { token: S.admin, body });
before(async () => {
  S = await startApp({ cardIssueMode: 'pool' });
  hyper = await S.makePoint('hypermarket', 'both', 5, 0);
  cinema = await S.makePoint('cinema', 'spend', 0, 50);
});
after(() => S.stop());

async function register(phone, consents = { pd: true, rules: true }) {
  await S.call('POST', '/api/auth/request-code', { body: { phone } });
  const code = S.sms.outbox.at(-1).text.match(/(\d{4})/)[1];
  return S.call('POST', '/api/auth/verify', { body: { phone, code, consents } });
}
const me = async (t) => (await S.call('GET', '/api/me', { token: t })).json;
const accrue = (body) => S.call('POST', '/api/v1/accruals', { token: hyper, body });

test('регистрация без обязательных согласий отклоняется, рассылки — по желанию', async () => {
  const r = await register('+79000000001', { pd: true });
  assert.equal(r.status, 400); assert.equal(r.json.error, 'consent_required');
  const ok = await register('+79000000001', { pd: true, rules: true, marketing: true });
  assert.equal(ok.status, 200);
  const m = await me(ok.json.token);
  assert.equal(m.settings.marketing, true);
  const consents = S.db.prepare('SELECT kind, granted, version FROM consents ORDER BY id').all();
  assert.deepEqual(consents.map((c) => c.kind + c.granted), ['pd1', 'rules1', 'marketing1']);
  const off = await S.call('PATCH', '/api/me', { token: ok.json.token, body: { marketing: false } });
  assert.equal(off.status, 200);
  assert.equal((await me(ok.json.token)).settings.marketing, false);
  assert.throws(() => S.db.exec('UPDATE consents SET granted=1'), /append-only/);
});

test('пул пуст: клиент без карты; после загрузки номеров карта выдаётся при открытии приложения', async () => {
  const r = await register('+79000000002');
  const m0 = await me(r.json.token);
  assert.equal(m0.card, null); assert.equal(m0.qr, null);
  const imp = await admin('POST', '/api/admin/cards/import', { kind: 'virtual', range: { from: '7770000000001', to: '7770000000010' } });
  assert.deepEqual([imp.json.added, imp.json.skipped], [10, 0]);
  const again = await admin('POST', '/api/admin/cards/import', { kind: 'virtual', text: '7770000000010\n7770000000011\nплохой' });
  assert.deepEqual([again.json.added, again.json.skipped, again.json.invalid.length], [1, 1, 1]);
  const m1 = await me(r.json.token);
  assert.equal(m1.card.number, '7770000000001'); assert.equal(m1.qr.value, '7770000000001');
  const r2 = await register('+79000000003');
  assert.equal((await me(r2.json.token)).card.number, '7770000000002');
  const pool = await admin('GET', '/api/admin/cards/pool');
  assert.equal(pool.json.pool.find((p) => p.kind === 'virtual' && p.status === 'free').n, 9);
});

test('карта из пула, ещё не выданная клиенту, на кассе не принимается (422)', async () => {
  const r = await accrue(receipt('7770000000011', 'fd:free:1', [{ sum: '100.00' }]));
  assert.equal(r.status, 422);
});

test('пластиковая карта: баллы копятся до привязки и переходят клиенту; код активации обязателен', async () => {
  await admin('POST', '/api/admin/cards/import', { kind: 'physical', text: '5550000000001;4821\n5550000000002;1111' });
  const a = await accrue(receipt('5550000000001', 'fd:pl:1', [{ sum: '1000.00' }]));
  assert.equal(a.status, 200); assert.equal(a.json.accrued, 50);
  const u = await register('+79000000004');
  const bad = await S.call('POST', '/api/me/cards/bind', { token: u.json.token, body: { number: '5550000000001', code: '0000' } });
  assert.equal(bad.status, 400); assert.equal(bad.json.error, 'wrong_code');
  const ok = await S.call('POST', '/api/me/cards/bind', { token: u.json.token, body: { number: '5550 0000 0000 1', code: '4821' } });
  assert.equal(ok.status, 200); assert.equal(ok.json.transferred, 50);
  const m = await me(u.json.token);
  assert.equal(m.balance, 50); assert.deepEqual(m.physicalCards, ['5550000000001']);
  // следующие покупки по пластику идут сразу на счёт клиента
  await accrue(receipt('5550000000001', 'fd:pl:2', [{ sum: '200.00' }]));
  assert.equal((await me(u.json.token)).balance, 60);
  const other = await register('+79000000005');
  const taken = await S.call('POST', '/api/me/cards/bind', { token: other.json.token, body: { number: '5550000000001', code: '4821' } });
  assert.equal(taken.status, 409);
  // гостевой счёт непривязанной карты не может списывать
  await accrue(receipt('5550000000002', 'fd:pl:3', [{ sum: '200.00' }]));
  const q = await S.call('POST', '/api/v1/redeem/quote', { token: cinema, body: { card: '5550000000002', checkTotal: '100' } });
  assert.equal(q.status, 422); assert.equal(q.json.error, 'card_not_bound');
});

test('журнал баллов нельзя изменить или удалить даже напрямую в БД', () => {
  assert.throws(() => S.db.exec('UPDATE ledger SET points=1000000'), /append-only/);
  assert.throws(() => S.db.exec('DELETE FROM ledger'), /append-only/);
});

test('списание в гипермаркете: резерв на подытоге, цена 3 исключена, подтверждение при пробитии, возврат', async () => {
  const u = await register('+79000000006');
  const card = (await me(u.json.token)).card.number;
  await accrue(receipt(card, 'fd:r:0', [{ sum: '4000.00' }]));        // +200
  await admin('PATCH', '/api/admin/points/hypermarket', { redeemPct: 5 });
  const lines = [
    { number: 1, sum: '1000.00', discount: '0.00' },
    { number: 2, sum: '900.00', discount: '100.00' },                     // цена 3 (скидка Set10)
    { number: 3, sum: '500.00', discount: '0.00', payBonusAllowed: false },
  ];
  const reserve = (ref = 'rc:K1:1:7:1') => S.call('POST', '/api/v1/pos/redeem/reserve', { token: hyper, body: { ref, card: { number: card }, lines } });
  assert.equal((await reserve()).json.reason, 'not_opted_in');            // клиент не включил списание
  await S.call('PATCH', '/api/me', { token: u.json.token, body: { autoRedeem: true } });
  const r1 = await reserve();
  assert.equal(r1.json.points, 50);                                       // 5% от 1000 (строки 2 и 3 исключены)
  assert.deepEqual(r1.json.lines, [{ number: 1, discount: '50.00' }]);
  const r2 = await reserve();                                             // повторный подытог: резерв не удваивается
  assert.equal(r2.json.holdId, r1.json.holdId);
  assert.equal((await me(u.json.token)).available, 150);
  // чек пробит: строка 1 = 950 после списания (ownDiscount=50), начисление от суммы после всех скидок
  const sale = receipt(card, 'fd:r:1', [{ sum: '950.00', discount: '50.00', ownDiscount: '50.00' }, { sum: '900.00', discount: '100.00' }, { sum: '500.00' }],
    { redemption: { ref: 'rc:K1:1:7:1', points: 50 } });
  const a = await accrue(sale);
  assert.equal(a.json.redeemed, 50); assert.equal(a.json.accrued, 118);  // 2350 × 5% = 117.5 → 118
  let m = await me(u.json.token);
  assert.equal(m.balance, 200 - 50 + 118); assert.equal(m.available, m.balance);
  assert.equal((await accrue(sale)).status, 409);                         // повтор не списывает второй раз
  // полный возврат: списанные баллы вернулись, начисленные отменены
  const refund = receipt(card, 'fd:r:2', [{ sum: '950.00' }, { sum: '900.00' }, { sum: '500.00' }],
    { operation: 'REFUND', originalReceipt: { key: 'fd:r:1', total: '2350.00' } });
  const rf = await accrue(refund);
  assert.equal(rf.json.redeemReturned, 50); assert.equal(rf.json.accrued, -118);
  m = await me(u.json.token);
  assert.equal(m.balance, 200);
  // отмена расчёта: резерв снимается
  await reserve('rc:K1:1:8:1');
  assert.equal((await me(u.json.token)).available, 150);
  await S.call('POST', '/api/v1/pos/redeem/cancel', { token: hyper, body: { ref: 'rc:K1:1:8:1' } });
  assert.equal((await me(u.json.token)).available, 200);
  // чек пробит без скидки списанием (касса отбросила скидку): висящий резерв снимается сразу
  await reserve('rc:K1:1:9:1');
  assert.equal((await me(u.json.token)).available, 150);
  await accrue(receipt(card, 'fd:r:3', [{ sum: '100.00' }], { receipt: { key: 'fd:r:3', ref: 'rc:K1:1:9:1', total: '100.00' } }));
  m = await me(u.json.token);
  assert.equal(m.available, m.balance);
});

test('настройка: разрешить списание и на цену 3 / по списку акций Set10', async () => {
  const u = await register('+79000000007');
  const card = (await me(u.json.token)).card.number;
  await accrue(receipt(card, 'fd:s:0', [{ sum: '10000.00' }]));
  await S.call('PATCH', '/api/me', { token: u.json.token, body: { autoRedeem: true } });
  const lines = [{ number: 1, sum: '1000.00' }, { number: 2, sum: '1000.00', discount: '200.00', discounts: [{ id: 'PROMO_X', amount: '200.00' }] }];
  const reserve = async (ref) => (await S.call('POST', '/api/v1/pos/redeem/reserve', { token: hyper, body: { ref, card: { number: card }, lines } })).json.points;
  assert.equal(await reserve('a'), 50);
  await admin('PUT', '/api/admin/settings', { price3_action_ids: 'PRICE3' });   // скидка PROMO_X — не цена 3
  assert.equal(await reserve('b'), 100);
  await admin('PUT', '/api/admin/settings', { price3_action_ids: '', redeem_on_discounted: true });
  assert.equal(await reserve('c'), 100);
  await admin('PUT', '/api/admin/settings', { redeem_on_discounted: false });
  for (const ref of ['a', 'b', 'c']) await S.call('POST', '/api/v1/pos/redeem/cancel', { token: hyper, body: { ref } });
});

test('3 этаж: списание с подтверждением кодом из приложения клиента', async () => {
  const u = await register('+79000000008');
  const card = (await me(u.json.token)).card.number;
  await accrue(receipt(card, 'fd:c:0', [{ sum: '2000.00' }]));        // +100
  await admin('PATCH', '/api/admin/points/cinema', { confirmRedeem: true });
  const h = await S.call('POST', '/api/v1/redeem/hold', { token: cinema, body: { card, checkTotal: '500', points: 60, idempotencyKey: 'c1' } });
  assert.equal(h.json.confirmRequired, true);
  const code = (await me(u.json.token)).pending[0].code;
  const noCode = await S.call('POST', `/api/v1/redeem/${h.json.holdId}/commit`, { token: cinema, body: {} });
  assert.equal(noCode.json.error, 'confirm_required');
  const wrong = await S.call('POST', `/api/v1/redeem/${h.json.holdId}/commit`, { token: cinema, body: { code: code === '0000' ? '1111' : '0000' } });
  assert.equal(wrong.json.error, 'wrong_code');
  const ok = await S.call('POST', `/api/v1/redeem/${h.json.holdId}/commit`, { token: cinema, body: { code } });
  assert.equal(ok.json.status, 'COMMITTED');
  const m = await me(u.json.token);
  assert.equal(m.balance, 40); assert.equal(m.pending.length, 0);
  await admin('PATCH', '/api/admin/points/cinema', { confirmRedeem: false });
});

test('метрики админки', async () => {
  const r = await admin('GET', '/api/admin/metrics?days=7');
  assert.equal(r.status, 200);
  assert.ok(r.json.totals.users >= 7);
  assert.equal(r.json.totals.unboundPhysicalCards, 1);
  assert.ok(r.json.daily[0].receipts > 0);
  assert.equal((await S.call('GET', '/api/admin/metrics')).status, 401);
});
