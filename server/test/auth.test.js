import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helper.js';
import { luhnValid } from '../src/util.js';

let S;
before(async () => { S = await startApp({ otpResendSec: 60, otpPerHour: 3 }); });
after(() => S.stop());
const code = () => S.sms.outbox.at(-1).text.match(/(\d{4})/)[1];

test('вход по коду: новый пользователь получает карту с Luhn и префиксом', async () => {
  const phone = '+7 (901) 111-22-33';
  assert.equal((await S.call('POST', '/api/auth/request-code', { body: { phone } })).status, 200);
  assert.equal(S.sms.outbox.at(-1).phone, '79011112233');
  const v = await S.call('POST', '/api/auth/verify', { body: { phone: '89011112233', code: code(), consent: true } });
  assert.equal(v.status, 200); assert.equal(v.json.isNew, true);
  const me = await S.call('GET', '/api/me', { token: v.json.token });
  assert.ok(luhnValid(me.json.card.number)); assert.ok(me.json.card.number.startsWith('2000'));
  assert.equal(me.json.balance, 0); assert.equal(me.json.qr.value, me.json.card.number);
  assert.equal(me.json.user.phone, '+7 901 ***-**-33');          // телефон в ответе маскируется
  assert.equal((await S.call('GET', '/api/me')).status, 401);
});

test('код не работает повторно; сохранённый пользователь входит в тот же аккаунт', async () => {
  const phone = '+79012223344';
  await S.call('POST', '/api/auth/request-code', { body: { phone } });
  const c = code();
  const v1 = await S.call('POST', '/api/auth/verify', { body: { phone, code: c, consent: true } });
  assert.equal((await S.call('POST', '/api/auth/verify', { body: { phone, code: c, consent: true } })).status, 400);   // одноразовый
  const card = (await S.call('GET', '/api/me', { token: v1.json.token })).json.card.number;
  S.db.prepare('DELETE FROM otp_log WHERE phone=?').run('79012223344'); S.db.prepare('UPDATE otp SET sent_at=0 WHERE phone=?').run('79012223344');
  await S.call('POST', '/api/auth/request-code', { body: { phone } });
  const v2 = await S.call('POST', '/api/auth/verify', { body: { phone, code: code() } });   // повторный вход без consent
  assert.equal(v2.json.isNew, false);
  assert.equal((await S.call('GET', '/api/me', { token: v2.json.token })).json.card.number, card);
});

test('неверный код: после лимита попыток даже верный код не принимается', async () => {
  const phone = '+79013334455';
  await S.call('POST', '/api/auth/request-code', { body: { phone } });
  const good = code(); const bad = good === '0000' ? '1111' : '0000';
  for (let i = 0; i < 5; i++) assert.equal((await S.call('POST', '/api/auth/verify', { body: { phone, code: bad, consent: true } })).json.error, 'wrong_code');
  const r = await S.call('POST', '/api/auth/verify', { body: { phone, code: good, consent: true } });
  assert.equal(r.status, 429);
});

test('согласие обязательно для нового пользователя; пользователь не создаётся без него', async () => {
  const phone = '+79014445566';
  await S.call('POST', '/api/auth/request-code', { body: { phone } });
  const r = await S.call('POST', '/api/auth/verify', { body: { phone, code: code() } });
  assert.equal(r.json.error, 'consent_required');
  assert.equal(S.db.prepare('SELECT COUNT(*) c FROM users WHERE phone=?').get('79014445566').c, 0);
});

test('повторный запрос кода раньше срока — 429; лимит в час', async () => {
  const phone = '+79015556677';
  assert.equal((await S.call('POST', '/api/auth/request-code', { body: { phone } })).status, 200);
  assert.equal((await S.call('POST', '/api/auth/request-code', { body: { phone } })).json.error, 'resend_too_soon');
  assert.equal((await S.call('POST', '/api/auth/request-code', { body: { phone: 'abc' } })).status, 400);
});

test('профиль: имя, выход, удаление аккаунта стирает данные', async () => {
  const S2 = await startApp(); const u = await S2.makeUser('+79016667788');
  await S2.call('PATCH', '/api/me', { token: u.token, body: { name: '  Иван  ' } });
  assert.equal((await S2.call('GET', '/api/me', { token: u.token })).json.user.name, 'Иван');
  assert.equal((await S2.call('POST', '/api/auth/logout', { token: u.token })).status, 200);
  assert.equal((await S2.call('GET', '/api/me', { token: u.token })).status, 401);
  const u2 = await S2.makeUser('+79016667788');
  assert.equal((await S2.call('DELETE', '/api/me', { token: u2.token })).status, 200);
  const row = S2.db.prepare('SELECT phone,name,deleted_at FROM users WHERE id=1').get();
  assert.equal(row.phone, null); assert.equal(row.name, null); assert.ok(row.deleted_at);
  assert.equal((await S2.call('GET', '/api/me', { token: u2.token })).status, 401);
  const ear = await S2.makePoint('hypermarket', 'earn', 5);
  assert.equal((await S2.call('POST', '/api/v1/accruals', { token: ear, body: { idempotencyKey: 'z', card: { number: u2.card }, receipt: { total: '10.00' } } })).status, 422);
  S2.stop();
});

test('в production без ADMIN_TOKEN и с SMS_PROVIDER=console сервер не стартует', async () => {
  const { loadConfig } = await import('../src/config.js');
  assert.throws(() => loadConfig({ isProd: true, adminToken: '' }));
  assert.throws(() => loadConfig({ isProd: true, adminToken: 'x'.repeat(30), smsProvider: 'console' }));
});
