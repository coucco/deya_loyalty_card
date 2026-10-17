// Виртуальная и пластиковая карта у одного телефона: любой порядок появления, замена, удаление аккаунта.
// Номера в формате тестового диапазона Set10 (99900000000000NN): виртуальные и пластиковые — разные диапазоны.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, receipt } from './helper.js';

let S, hyper, n = 0;
const admin = (m, p, body) => S.call(m, p, { token: S.admin, body });
const me = async (t) => (await S.call('GET', '/api/me', { token: t })).json;
const buy = (card, sum = '1000.00') => S.call('POST', '/api/v1/accruals', { token: hyper, body: receipt(card, 'fd:o:' + ++n, [{ sum }]) });
const bind = (t, number, code, replace) => S.call('POST', '/api/me/cards/bind', { token: t, body: { number, code, replace } });
async function register(phone) {
  await S.call('POST', '/api/auth/request-code', { body: { phone } });
  const code = S.sms.outbox.at(-1).text.match(/(\d{4})/)[1];
  return (await S.call('POST', '/api/auth/verify', { body: { phone, code, consents: { pd: true, rules: true } } })).json.token;
}

before(async () => {
  S = await startApp({ cardIssueMode: 'pool' });
  hyper = await S.makePoint('hypermarket', 'both', 5, 0);
  await admin('POST', '/api/admin/cards/import', { kind: 'virtual', range: { from: '9990000000000001', to: '9990000000000005' } });
  await admin('POST', '/api/admin/cards/import', { kind: 'physical', text: '9990000000000006;1111\n9990000000000007;2222\n9990000000000008;3333\n9990000000000009;4444\n9990000000000010;5555' });
});
after(() => S.stop());

test('диапазоны не смешиваются: номер виртуальной карты нельзя загрузить как пластиковый и привязать как пластик', async () => {
  const r = await admin('POST', '/api/admin/cards/import', { kind: 'physical', text: '9990000000000001;9999' });
  assert.deepEqual(r.json.conflicts, ['9990000000000001']);
  const t = await register('+79100000001');
  assert.equal((await bind(t, '9990000000000002', '')).status, 404);
});

test('сначала приложение, потом пластик: одна учётная запись, две карты, один баланс', async () => {
  const t = await register('+79100000002');
  const m0 = await me(t);
  assert.equal(m0.card.kind, 'virtual');
  await buy(m0.card.number);                                   // +50 по QR
  assert.equal((await bind(t, '9990000000000006', '1111')).status, 200);
  await buy('9990000000000006');                               // +50 по пластику
  const m = await me(t);
  assert.equal(m.balance, 100);
  assert.equal(m.card.number, m0.card.number);                 // в QR по-прежнему виртуальная
  assert.deepEqual(m.physicalCards, ['9990000000000006']);
});

test('сначала пластик (покупки без регистрации), потом приложение и привязка: баллы переходят', async () => {
  await buy('9990000000000007'); await buy('9990000000000007');   // гостевой счёт: 100
  const t = await register('+79100000003');
  assert.equal((await me(t)).card.kind, 'virtual');            // виртуальная выдаётся при регистрации в любом случае
  const r = await bind(t, '9990000000000007', '2222');
  assert.equal(r.json.transferred, 100);
  assert.equal((await me(t)).balance, 100);
});

test('вторая пластиковая карта — только заменой, старая блокируется', async () => {
  const t = await register('+79100000004');
  await bind(t, '9990000000000008', '3333');
  const second = await bind(t, '9990000000000009', '4444');
  assert.equal(second.status, 409); assert.equal(second.json.error, 'physical_exists');
  const rep = await bind(t, '9990000000000009', '4444', true);
  assert.equal(rep.status, 200); assert.equal(rep.json.replaced, '9990000000000008');
  assert.equal((await buy('9990000000000008')).status, 422);  // старая карта на кассе больше не работает
  assert.deepEqual((await me(t)).physicalCards, ['9990000000000009']);
});

test('пул виртуальных пуст, а пластик привязан: в QR показывается номер пластика', async () => {
  // виртуальные 9990000000000001..5: 4 выданы выше; забираем последнюю
  await register('+79100000005');
  const t = await register('+79100000006');
  assert.equal((await me(t)).card, null);
  await bind(t, '9990000000000010', '5555');
  const m = await me(t);
  assert.equal(m.card.number, '9990000000000010'); assert.equal(m.card.kind, 'physical'); assert.equal(m.qr.value, '9990000000000010');
});

test('удаление аккаунта: виртуальная закрыта, пластик снова свободен (новый гостевой счёт)', async () => {
  const t = await register('+79100000007');
  await admin('POST', '/api/admin/cards/import', { kind: 'virtual', text: '9990000000000011' });
  await admin('POST', '/api/admin/cards/import', { kind: 'physical', text: '9990000000000012;6666' });
  const v = (await me(t)).card.number;
  await bind(t, '9990000000000012', '6666');
  await S.call('DELETE', '/api/me', { token: t });
  assert.equal((await buy(v)).status, 422);
  const r = await buy('9990000000000012');
  assert.equal(r.status, 200); assert.equal(r.json.balance, 50);   // новый гостевой счёт, старые баллы не вернулись
});

test('админ блокирует утерянную карту и разблокирует', async () => {
  const t = await register('+79100000008');
  await admin('POST', '/api/admin/cards/import', { kind: 'physical', text: '9990000000000013;7777' });
  await bind(t, '9990000000000013', '7777');
  assert.equal((await admin('POST', '/api/admin/cards/9990000000000013/block', { reason: 'утеря' })).json.status, 'blocked');
  assert.equal((await buy('9990000000000013')).status, 422);
  assert.equal((await admin('POST', '/api/admin/cards/9990000000000013/block', { blocked: false })).json.status, 'active');
  assert.equal((await buy('9990000000000013')).status, 200);
});
