import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, receipt } from './helper.js';

let S;
before(async () => { S = await startApp(); });
after(() => S.stop());

test('админ-API закрыт без токена и с чужим токеном; клиентский токен не подходит', async () => {
  const u = await S.makeUser();
  for (const t of [undefined, 'nope', u.token]) assert.equal((await S.call('GET', '/api/admin/points', { token: t })).status, 401);
  assert.equal((await S.call('GET', '/api/admin/points', { token: S.admin })).status, 200);
});

test('ключ точки показывается один раз, в БД хранится только хэш; ротация отзывает старый', async () => {
  const k1 = await S.makePoint('hypermarket', 'earn', 5);
  assert.ok(!JSON.stringify(S.db.prepare('SELECT * FROM points').all()).includes(k1));
  const u = await S.makeUser('+79990000001');
  const ok = (k, key) => S.call('POST', '/api/v1/accruals', { token: k, body: receipt(u.card, key, [{ sum: '100.00' }]) });
  assert.equal((await ok(k1, 'rot1')).status, 200);
  const k2 = await S.makePoint('hypermarket', 'earn', 5);
  assert.equal((await ok(k1, 'rot2')).status, 401);
  assert.equal((await ok(k2, 'rot2')).status, 200);
});

test('проценты: валидация диапазона, аудит изменений', async () => {
  assert.equal((await S.call('PATCH', '/api/admin/points/hypermarket', { token: S.admin, body: { accrualPct: 101 } })).status, 400);
  assert.equal((await S.call('PATCH', '/api/admin/points/hypermarket', { token: S.admin, body: { accrualPct: -1 } })).status, 400);
  assert.equal((await S.call('PATCH', '/api/admin/points/hypermarket', { token: S.admin, body: { accrualPct: 3.25 } })).json.accrualPct, 3.25);
  const a = await S.call('GET', '/api/admin/audit', { token: S.admin });
  assert.ok(a.json.items.some((i) => i.action === 'point_updated'));
});

test('публичный список точек трат отдаёт только активные spend/both и без ключей', async () => {
  await S.makePoint('cinema', 'spend', 0, 15);
  const r = await S.call('GET', '/api/points');
  const ids = r.json.points.map((p) => p.id);
  assert.ok(ids.includes('cinema')); assert.ok(!ids.includes('hypermarket'));
  assert.equal(r.json.points.find((p) => p.id === 'cinema').redeemPct, 15);
  assert.ok(!r.text.includes('api_key'));
});

test('корректировка баланса админом попадает в историю; сверка журнала с балансом чистая', async () => {
  const u = await S.makeUser('+79990000002');
  const id = S.db.prepare('SELECT id FROM users WHERE phone=?').get('79990000002').id;
  assert.equal((await S.call('POST', `/api/admin/users/${id}/adjust`, { token: S.admin, body: { points: 40, reason: 'тест' } })).json.balance, 40);
  assert.equal((await S.call('POST', `/api/admin/users/${id}/adjust`, { token: S.admin, body: { points: -100, reason: 'x' } })).status, 422);
  const h = await S.call('GET', '/api/me/history', { token: u.token });
  assert.equal(h.json.items[0].points, 40); assert.equal(h.json.items[0].point_name, 'Корректировка');
  assert.equal((await S.call('GET', '/api/admin/stats', { token: S.admin })).json.mismatches, 0);
});

test('выгрузка карт CSV', async () => {
  const r = await S.call('GET', '/api/admin/cards.csv', { token: S.admin });
  assert.equal(r.status, 200); assert.match(r.headers.get('content-type'), /text\/csv/);
  assert.match(r.text, /card_number;phone;status/); assert.match(r.text, /2000\d{9};7999/);
});

test('статика и заголовки безопасности; неизвестные API-пути — JSON 404', async () => {
  const idx = await S.call('GET', '/');
  assert.equal(idx.status, 200); assert.match(idx.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(idx.headers.get('x-content-type-options'), 'nosniff');
  assert.equal((await S.call('GET', '/nonexistent.js')).status, 404);
  assert.equal((await S.call('GET', '/api/nope')).json.error, 'not_found');
  for (const evil of ['/..%2f..%2fetc/passwd', '/%2e%2e/%2e%2e/etc/passwd', '/..%2f..%2f..%2f..%2fetc%2fhostname.txt'])
    assert.ok(!(await S.call('GET', evil)).text.includes('root:'), 'выход за пределы public: ' + evil);
  assert.equal((await S.call('GET', '/..%2fserver%2fpackage.json')).status, 404);
  assert.equal((await S.call('POST', '/api/me')).status, 405);
  const big = await fetch(S.base + '/api/auth/request-code', { method: 'POST', body: JSON.stringify({ phone: 'x'.repeat(400000) }) });
  assert.equal(big.status, 413);
  assert.equal((await S.call('GET', '/healthz')).json.ok, true);
});
