import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, receipt } from './helper.js';

let S, earn, spend, u;
before(async () => {
  S = await startApp();
  earn = await S.makePoint('hypermarket', 'earn', 10, 0);
  spend = await S.makePoint('cinema', 'spend', 0, 20);          // не больше 20% чека
  u = await S.makeUser();
  await S.call('POST', '/api/v1/accruals', { token: earn, body: receipt(u.card, 'fd:S:1', [{ sum: '1000.00' }]) });   // 100 баллов
});
after(() => S.stop());
const rd = (p, body, k = spend) => S.call('POST', '/api/v1/redeem/' + p, { token: k, body });
const me = async () => (await S.call('GET', '/api/me', { token: u.token })).json;

test('quote: лимит = min(баланс, доля чека)', async () => {
  assert.equal((await rd('quote', { card: u.card, checkTotal: '300.00' })).json.maxPoints, 60);   // 20% от 300
  assert.equal((await rd('quote', { card: u.card, checkTotal: '5000.00' })).json.maxPoints, 100);  // упёрлись в баланс
  assert.equal((await rd('quote', { phone: u.phone, checkTotal: '300.00' })).json.maxPoints, 60);  // поиск по телефону
});

test('hold резервирует, commit списывает, повтор commit безопасен', async () => {
  const h = await rd('hold', { card: u.card, checkTotal: '300.00', points: 50, idempotencyKey: 'k1' });
  assert.equal(h.status, 201); assert.equal(h.json.discount, '50.00');
  let m = await me(); assert.equal(m.balance, 100); assert.equal(m.available, 50);
  const again = await rd('hold', { card: u.card, checkTotal: '300.00', points: 50, idempotencyKey: 'k1' });
  assert.equal(again.json.holdId, h.json.holdId); assert.equal((await me()).available, 50);   // не зарезервировали дважды
  assert.equal((await rd(`${h.json.holdId}/commit`, {})).json.balance, 50);
  assert.equal((await rd(`${h.json.holdId}/commit`, {})).json.duplicate, true);
  m = await me(); assert.equal(m.balance, 50); assert.equal(m.available, 50);
  assert.equal(m.last.type, 'REDEEM'); assert.equal(m.last.points, -50);
});

test('нельзя списать больше лимита и больше доступного (с учётом чужих резервов)', async () => {
  assert.equal((await rd('hold', { card: u.card, checkTotal: '100.00', points: 21, idempotencyKey: 'k2' })).status, 422);
  const h = await rd('hold', { card: u.card, checkTotal: '250.00', points: 40, idempotencyKey: 'k3' });     // доступно 50 → 10
  assert.equal(h.status, 201);
  assert.equal((await rd('hold', { card: u.card, checkTotal: '250.00', points: 11, idempotencyKey: 'k4' })).status, 422);
  assert.equal((await rd(`${h.json.holdId}/cancel`, {})).json.status, 'CANCELLED');
  assert.equal((await me()).available, 50);
});

test('возврат подтверждённого списания возвращает баллы; повтор безопасен', async () => {
  const h = await rd('hold', { card: u.card, checkTotal: '100.00', points: 20, idempotencyKey: 'k5' });
  await rd(`${h.json.holdId}/commit`, {});
  assert.equal((await me()).balance, 30);
  assert.equal((await rd(`${h.json.holdId}/reverse`, {})).json.balance, 50);
  assert.equal((await rd(`${h.json.holdId}/reverse`, {})).json.duplicate, true);
  assert.equal((await me()).balance, 50);
  assert.equal((await rd(`${h.json.holdId}/cancel`, {})).status, 409);
});

test('резерв истекает и освобождает баллы; commit просроченного — 410', async () => {
  const S2 = await startApp({ holdTtlSec: -1 });
  const e = await S2.makePoint('hypermarket', 'earn', 10, 0), s = await S2.makePoint('cinema', 'spend', 0, 50);
  const u2 = await S2.makeUser();
  await S2.call('POST', '/api/v1/accruals', { token: e, body: receipt(u2.card, 'a1', [{ sum: '1000.00' }]) });
  const h = await S2.call('POST', '/api/v1/redeem/hold', { token: s, body: { card: u2.card, checkTotal: '100.00', points: 30, idempotencyKey: 'x' } });
  assert.equal(h.status, 201);
  const c = await S2.call('POST', `/api/v1/redeem/${h.json.holdId}/commit`, { token: s });
  assert.equal(c.status, 410);
  const m = await S2.call('GET', '/api/me', { token: u2.token });
  assert.equal(m.json.balance, 100); assert.equal(m.json.available, 100);
  S2.stop();
});

test('точка начисления не списывает; чужой резерв недоступен', async () => {
  assert.equal((await rd('quote', { card: u.card, checkTotal: '100.00' }, earn)).status, 403);
  const other = await S.makePoint('bowling', 'spend', 0, 20);
  const h = await rd('hold', { card: u.card, checkTotal: '100.00', points: 5, idempotencyKey: 'k6' });
  assert.equal((await rd(`${h.json.holdId}/commit`, {}, other)).status, 404);
});
