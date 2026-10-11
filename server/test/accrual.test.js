import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, receipt } from './helper.js';

let S, key, user;
before(async () => { S = await startApp(); key = await S.makePoint('hypermarket', 'earn', 5, 0); user = await S.makeUser(); });
after(() => S.stop());
const post = (body, k = key) => S.call('POST', '/api/v1/accruals', { token: k, body });
const balance = async () => (await S.call('GET', '/api/me', { token: user.token })).json.balance;

test('пример из контракта плагина: чек 1234.50 при 5% = 62 балла (61.725 округляется вверх)', async () => {
  const r = await post({ schemaVersion: 1, idempotencyKey: 'fd:9999078900001234:777', pointId: 'hypermarket', registerId: '9999078900001234', operation: 'SALE',
    card: { number: user.card, type: 'INTERNAL' },
    receipt: { key: 'fd:9999078900001234:777', registerId: '9999078900001234', number: 42, shiftNo: 5, fiscalDocId: 777, fiscalSign: 123456789, fiscalizedAt: '2025-10-09T11:55:00+03:00', createdAt: '2025-10-09T11:53:20+03:00', total: '1234.50', fnNumber: '9999078900001234', registerFactoryNumber: '0012345678' },
    payments: [{ type: 'cash', sum: '1234.50', annulling: false }],
    lines: [{ number: 1, name: 'Молоко "Дея" 1л', barcode: '4600000000011', marking: null, groupCode: 'G1', quantity: '1.500', price: '100.00', sum: '150.00', discount: '0.00', accrueAllowed: true },
            { number: 2, name: 'Остальное', barcode: '1', quantity: '1.000', price: '1084.50', sum: '1084.50', discount: '0.00', accrueAllowed: true }] });
  assert.equal(r.status, 200); assert.equal(r.json.accrued, 62); assert.equal(await balance(), 62);
});

test('повтор того же чека: 409 и баллы не удваиваются', async () => {
  const b = receipt(user.card, 'fd:1:1', [{ sum: '200.00' }]);
  assert.equal((await post(b)).json.accrued, 10);
  const again = await post(b);
  assert.equal(again.status, 409); assert.equal(again.json.duplicate, true); assert.equal(again.json.accrued, 10);
  assert.equal(await balance(), 72);
});

test('ключ идемпотентности можно передать заголовком, как делает плагин', async () => {
  const b = receipt(user.card, 'x', [{ sum: '100.00' }]); delete b.idempotencyKey;
  const r = await S.call('POST', '/api/v1/accruals', { token: key, body: b, headers: { 'Idempotency-Key': 'fd:hdr:1', 'X-Point-Id': 'hypermarket' } });
  assert.equal(r.status, 200); assert.equal(r.json.accrued, 5);
});

test('позиции с accrueAllowed=false не участвуют в базе', async () => {
  const r = await post(receipt(user.card, 'fd:2:1', [{ sum: '100.00' }, { sum: '900.00', accrueAllowed: false }]));
  assert.equal(r.json.accrued, 5);
});

test('база — сумма строк ПОСЛЕ скидок, а не итог чека', async () => {
  const b = receipt(user.card, 'fd:3:1', [{ sum: '80.00', discount: '20.00', price: '100.00' }]);
  assert.equal((await post(b)).json.accrued, 4);
});

test('смена процента в админке действует сразу, без перезапуска; старые начисления не меняются', async () => {
  const before = await balance();
  const p = await S.call('PATCH', '/api/admin/points/hypermarket', { token: S.admin, body: { accrualPct: 7.5 } });
  assert.equal(p.json.accrualPct, 7.5);
  const r = await post(receipt(user.card, 'fd:4:1', [{ sum: '1000.00' }]));
  assert.equal(r.json.accrued, 75);
  assert.equal(await balance(), before + 75);
  await S.call('PATCH', '/api/admin/points/hypermarket', { token: S.admin, body: { accrualPct: 5 } });
});

test('правила округления: floor вместо half-up настраивается', async () => {
  await S.call('PUT', '/api/admin/settings', { token: S.admin, body: { rounding: 'floor' } });
  assert.equal((await post(receipt(user.card, 'fd:5:1', [{ sum: '119.00' }]))).json.accrued, 5);   // 5.95 -> 5
  await S.call('PUT', '/api/admin/settings', { token: S.admin, body: { rounding: 'half_up' } });
  assert.equal((await post(receipt(user.card, 'fd:5:2', [{ sum: '119.00' }]))).json.accrued, 6);
});

test('1 балл = 2 ₽: настройка rub_per_point', async () => {
  await S.call('PUT', '/api/admin/settings', { token: S.admin, body: { rub_per_point: 2 } });
  assert.equal((await post(receipt(user.card, 'fd:6:1', [{ sum: '1000.00' }]))).json.accrued, 25);
  await S.call('PUT', '/api/admin/settings', { token: S.admin, body: { rub_per_point: 1 } });
});

test('отказы по контракту плагина', async () => {
  assert.equal((await post(receipt('2000999999999', 'fd:7:1', [{ sum: '1.00' }]))).status, 422);   // неизвестная карта
  assert.equal((await post({ ...receipt(user.card, 'fd:7:2', [{ sum: '1.00' }]), idempotencyKey: '' })).status, 400);
  assert.equal((await post(receipt(user.card, 'fd:7:3', [{ sum: '1.00' }]), 'wrong')).status, 401);
  assert.equal((await S.call('POST', '/api/v1/accruals', { body: {} })).status, 401);
  assert.equal((await post({ ...receipt(user.card, 'fd:7:4', [{ sum: 'abc' }]) })).status, 400);
  const spend = await S.makePoint('cinema', 'spend', 0, 10);
  assert.equal((await post(receipt(user.card, 'fd:7:5', [{ sum: '100.00' }]), spend)).status, 403);   // точка списания не начисляет
  const w = await S.call('POST', '/api/v1/accruals', { token: key, headers: { 'X-Point-Id': 'cinema' }, body: receipt(user.card, 'fd:7:6', [{ sum: '1.00' }]) });
  assert.equal(w.status, 403);
});

test('отключённая точка не начисляет (403 — касса повторит позже)', async () => {
  await S.call('PATCH', '/api/admin/points/hypermarket', { token: S.admin, body: { active: false } });
  assert.equal((await post(receipt(user.card, 'fd:8:1', [{ sum: '100.00' }]))).status, 403);
  await S.call('PATCH', '/api/admin/points/hypermarket', { token: S.admin, body: { active: true } });
  assert.equal((await post(receipt(user.card, 'fd:8:1', [{ sum: '100.00' }]))).status, 200);   // тот же ключ после включения — обрабатывается
});

test('возврат: полный, частичный, повторный и больше начисленного', async () => {
  const u = await S.makeUser('+7 900 000-00-01');
  const sale = receipt(u.card, 'fd:R:1', [{ sum: '1000.00' }]);                         // 50 баллов
  assert.equal((await post(sale)).json.accrued, 50);
  const ref = (k, sum) => ({ ...receipt(u.card, k, [{ sum }]), operation: 'REFUND', originalReceipt: { key: 'fd:R:1' } });
  assert.equal((await post(ref('fd:R:2', '400.00'))).json.accrued, -20);                // частичный
  assert.equal((await post(ref('fd:R:2', '400.00'))).status, 409);                      // повтор
  assert.equal((await post(ref('fd:R:3', '900.00'))).json.accrued, -30);                // просили 45, осталось 30
  const me = await S.call('GET', '/api/me', { token: u.token });
  assert.equal(me.json.balance, 0);
});

test('возврат по ставке исходного начисления, даже если процент потом изменили', async () => {
  const u = await S.makeUser('+7 900 000-00-02');
  await post(receipt(u.card, 'fd:P:1', [{ sum: '1000.00' }]));                          // 5% = 50
  await S.call('PATCH', '/api/admin/points/hypermarket', { token: S.admin, body: { accrualPct: 10 } });
  const r = await post({ ...receipt(u.card, 'fd:P:2', [{ sum: '1000.00' }]), operation: 'REFUND', originalReceipt: { key: 'fd:P:1' } });
  assert.equal(r.json.accrued, -50);
  await S.call('PATCH', '/api/admin/points/hypermarket', { token: S.admin, body: { accrualPct: 5 } });
});

test('возврат, когда баллы уже потрачены: уходим в 0, недостача фиксируется, баланс не отрицательный', async () => {
  const u = await S.makeUser('+7 900 000-00-03');
  await post(receipt(u.card, 'fd:Q:1', [{ sum: '1000.00' }]));                          // 50
  const spend = await S.makePoint('bowling', 'spend', 0, 100);
  const h = await S.call('POST', '/api/v1/redeem/hold', { token: spend, body: { card: u.card, checkTotal: '40.00', points: 40, idempotencyKey: 'h-q' } });
  await S.call('POST', `/api/v1/redeem/${h.json.holdId}/commit`, { token: spend });      // осталось 10
  const r = await post({ ...receipt(u.card, 'fd:Q:2', [{ sum: '1000.00' }]), operation: 'REFUND', originalReceipt: { key: 'fd:Q:1' } });
  assert.equal(r.json.accrued, -10); assert.equal(r.json.shortfall, 40);
  assert.equal((await S.call('GET', '/api/me', { token: u.token })).json.balance, 0);
});

test('возврат без найденного исходного чека не меняет баланс', async () => {
  const r = await post({ ...receipt(user.card, 'fd:N:1', [{ sum: '100.00' }]), operation: 'REFUND', originalReceipt: { key: 'fd:NOPE' } });
  assert.equal(r.status, 200); assert.equal(r.json.accrued, 0);
});
