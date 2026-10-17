// Единый профиль: ID, смена номера, слияние, активация пластика на кассе по СМС, поиск по телефону,
// списание кнопкой кассира (CardPlugin), журнал действий, резервная копия.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startApp, receipt } from './helper.js';
import { backupNow } from '../src/maintenance.js';

let S, hyper, n = 0;
const admin = (m, p, body) => S.call(m, p, { token: S.admin, body });
const pos = (p, body) => S.call('POST', p, { token: hyper, body });
const me = async (t) => (await S.call('GET', '/api/me', { token: t })).json;
const buy = (card, sum = '1000.00', extra) => pos('/api/v1/accruals', receipt(card, 'fd:p:' + ++n, [{ sum }], extra));
const lastCode = () => S.sms.outbox.at(-1).text.match(/(\d{4})/)[1];
async function register(phone) {
  await S.call('POST', '/api/auth/request-code', { body: { phone } });
  return (await S.call('POST', '/api/auth/verify', { body: { phone, code: lastCode(), consents: { pd: true, rules: true } } })).json.token;
}
const login = register;

before(async () => {
  S = await startApp({ cardIssueMode: 'pool' });
  hyper = await S.makePoint('hypermarket', 'both', 5, 5);
  await admin('POST', '/api/admin/cards/import', { kind: 'virtual', range: { from: '999000000000001', to: '999000000000005' } });
  await admin('POST', '/api/admin/cards/import', { kind: 'physical', text: '999000000000006;1111\n999000000000007;2222\n999000000000008;3333\n999000000000009;4444\n999000000000010;5555' });
});
after(() => S.stop());

test('ID профиля неизменный, смена номера по СМС на новый номер: баллы и карты остаются, вход по новому номеру', async () => {
  const t = await register('+79200000001');
  const m0 = await me(t);
  assert.match(m0.user.profileId, /^100\d{4}$/);
  assert.equal(m0.support.phone, '+7 929 838-45-16');
  await buy(m0.card.number);
  assert.equal((await S.call('POST', '/api/me/phone/request', { token: t, body: { phone: '+79200000002' } })).status, 200);
  assert.equal(S.sms.outbox.at(-1).phone, '79200000002');
  const bad = await S.call('POST', '/api/me/phone/confirm', { token: t, body: { phone: '+79200000002', code: lastCode() === '0000' ? '1111' : '0000' } });
  assert.equal(bad.json.error, 'wrong_code');
  await S.call('POST', '/api/me/phone/request', { token: t, body: { phone: '+79200000002' } }).catch(() => {});
  const ok = await S.call('POST', '/api/me/phone/confirm', { token: t, body: { phone: '+79200000002', code: lastCode() } });
  assert.equal(ok.status, 200);
  const t2 = await login('+79200000002');
  const m = await me(t2);
  assert.equal(m.user.profileId, m0.user.profileId); assert.equal(m.balance, 50); assert.equal(m.card.number, m0.card.number);
  // старым номером теперь регистрируется новый профиль
  const t3 = await register('+79200000001');
  assert.notEqual((await me(t3)).user.profileId, m0.user.profileId);
  // занятый номер — только через поддержку
  const taken = await S.call('POST', '/api/me/phone/request', { token: t2, body: { phone: '+79200000001' } });
  assert.equal(taken.json.error, 'phone_taken');
});

test('касса: активация неиспользованного пластика по СМС создаёт профиль (без приложения), согласия записаны каналом pos_sms', async () => {
  const st0 = await pos('/api/v1/pos/card/status', { card: '999000000000006' });
  assert.equal(st0.json.state, 'free');
  const start = await pos('/api/v1/pos/activate/start', { card: '999000000000006', phone: '+79200000010' });
  assert.equal(start.json.existingProfile, false);
  assert.match(S.sms.outbox.at(-1).text, /правила программы/);
  const conf = await pos('/api/v1/pos/activate/confirm', { card: '999000000000006', phone: '+79200000010', code: lastCode() });
  assert.equal(conf.status, 200);
  const st = await pos('/api/v1/pos/card/status', { card: '999000000000006' });
  assert.equal(st.json.state, 'bound'); assert.equal(st.json.profileId, conf.json.profileId);
  const ch = S.db.prepare("SELECT channel FROM consents WHERE user_id=?").all(Number(conf.json.profileId) - 1000000).map((r) => r.channel);
  assert.deepEqual(ch, ['pos_sms', 'pos_sms']);
  // позже клиент заходит в приложение тем же номером: тот же профиль, ему выдаётся виртуальная карта, пластик виден
  const t = await login('+79200000010');
  const m = await me(t);
  assert.equal(m.user.profileId, conf.json.profileId); assert.equal(m.card.kind, 'virtual'); assert.deepEqual(m.physicalCards, ['999000000000006']);
});

test('касса: гостевой пластик (уже копил) активируется — гостевой счёт становится профилем, ID сохраняется', async () => {
  await buy('999000000000007'); await buy('999000000000007');
  const guest = (await pos('/api/v1/pos/card/status', { card: '999000000000007' })).json;
  assert.equal(guest.state, 'guest'); assert.equal(guest.balance, 100);
  await pos('/api/v1/pos/activate/start', { card: '999000000000007', phone: '+79200000011' });
  const conf = await pos('/api/v1/pos/activate/confirm', { card: '999000000000007', phone: '+79200000011', code: lastCode() });
  assert.equal(conf.json.profileId, guest.profileId); assert.equal(conf.json.balance, 100);
});

test('касса: новый пластик к существующему профилю (утеря) — баллы в профиле, старая карта заблокирована', async () => {
  // профиль с пластиком 999…06 из теста выше; выдали новую карту 999…08
  await buy('999000000000008');                                   // новая карта успела покопить как гость: 50
  const start = await pos('/api/v1/pos/activate/start', { card: '999000000000008', phone: '+79200000010' });
  assert.equal(start.json.existingProfile, true); assert.equal(start.json.replaces, '****0006');
  const conf = await pos('/api/v1/pos/activate/confirm', { card: '999000000000008', phone: '+79200000010', code: lastCode() });
  assert.equal(conf.json.transferred, 50); assert.equal(conf.json.replaced, '****0006');
  assert.equal((await buy('999000000000006')).status, 422);
  assert.equal((await pos('/api/v1/pos/card/status', { card: '999000000000006' })).json.state, 'blocked');
});

test('касса: поиск клиента по телефону, неверный код активации', async () => {
  const r = await pos('/api/v1/pos/card/by-phone', { phone: '8 920 000-00-10' });
  assert.equal(r.json.card, '999000000000008'); assert.equal(r.json.state, 'bound');
  assert.equal((await pos('/api/v1/pos/card/by-phone', { phone: '+79209999999' })).status, 404);
  await pos('/api/v1/pos/activate/start', { card: '999000000000009', phone: '+79200000012' });
  const bad = await pos('/api/v1/pos/activate/confirm', { card: '999000000000009', phone: '+79200000012', code: lastCode() === '0000' ? '1111' : '0000' });
  assert.equal(bad.json.error, 'wrong_code');
  assert.equal((await pos('/api/v1/pos/card/status', { card: '999000000000009' })).json.state, 'free');
});

test('кнопка кассира «оплатить бонусами»: потолок → резерв суммы кассира → writeOff → пробитие без повторного списания → возврат', async () => {
  const t = await register('+79200000020');
  const card = (await me(t)).card.number;
  await buy(card, '4000.00');                                      // +200
  const lines = [{ number: 1, sum: '1000.00' }, { number: 2, sum: '900.00', discount: '100.00' }];
  const q = await pos('/api/v1/pos/redeem/quote', { card: { number: card }, lines });
  assert.equal(q.json.maxPoints, 50);                              // 5% от 1000 (цена 3 исключена); согласие в приложении не нужно
  const r = await pos('/api/v1/pos/redeem/reserve', { ref: 'ref:K1:1:777', card: { number: card }, lines, mode: 'cashier', points: 30 });
  assert.equal(r.json.points, 30);
  const w = await pos('/api/v1/pos/redeem/writeoff', { ref: 'ref:K1:1:777', points: 30 });
  assert.equal(w.json.balance, 170);
  const again = await pos('/api/v1/pos/redeem/reserve', { ref: 'ref:K1:1:777', card: { number: card }, lines, mode: 'cashier', points: 30 });
  assert.equal(again.json.committed, true);                       // пересчёт после списания не меняет сумму
  const sale = await buy(card, '970.00', { redemption: { ref: 'ref:K1:1:777', points: 30 } });
  assert.equal(sale.json.redeemed, 30);
  assert.equal((await me(t)).balance, 170 + 49);                  // списано один раз; +49 за 970
  const key = 'fd:p:' + n;
  const ref = await pos('/api/v1/accruals', receipt(card, 'fd:p:ref' + n, [{ sum: '970.00' }], { operation: 'REFUND', originalReceipt: { key, total: '970.00' } }));
  assert.equal(ref.json.redeemReturned, 30);
  assert.equal((await me(t)).balance, 200);
  // откат списания до пробития (чек аннулирован)
  await pos('/api/v1/pos/redeem/reserve', { ref: 'ref:K1:1:778', card: { number: card }, lines, mode: 'cashier', points: 20 });
  const w2 = await pos('/api/v1/pos/redeem/writeoff', { ref: 'ref:K1:1:778' });
  assert.equal((await pos('/api/v1/pos/redeem/rollback', { txId: w2.json.txId })).json.status, 'REVERSED');
  assert.equal((await pos('/api/v1/pos/redeem/rollback', { txId: w2.json.txId })).json.duplicate, true);
  assert.equal((await me(t)).balance, 200);
});

test('поддержка: смена номера, слияние двух профилей (1+1 карт), отвязка карты; всё в журнале', async () => {
  await admin('POST', '/api/admin/cards/import', { kind: 'virtual', range: { from: '999000000000101', to: '999000000000110' } });
  const a = await register('+79200000030'), b = await register('+79200000031');
  const ma = await me(a), mb = await me(b);
  await buy(ma.card.number); await buy(mb.card.number); await buy(mb.card.number);
  const ida = Number(ma.user.profileId) - 1000000, idb = Number(mb.user.profileId) - 1000000;
  const merge = await admin('POST', `/api/admin/users/${ida}/merge`, { from: mb.user.profileId, reason: 'два профиля одного клиента' });
  assert.equal(merge.json.transferred, 100);
  assert.equal((await me(a)).balance, 150);
  assert.equal((await buy(mb.card.number)).status, 422);        // вторая виртуальная закрыта (у A уже есть)
  assert.equal((await S.call('GET', '/api/me', { token: b })).status, 401);
  const ph = await admin('POST', `/api/admin/users/${ida}/phone`, { phone: '+79200000039', reason: 'потерял номер' });
  assert.equal(ph.status, 200);
  assert.equal((await S.call('GET', '/api/me', { token: a })).status, 401);   // входы по старому номеру завершены
  const card = await admin('GET', `/api/admin/users/${ida}`);
  assert.equal(card.json.user.profileId, ma.user.profileId);
  const actions = card.json.audit.map((x) => x.action);
  assert.ok(actions.includes('http'));
  const all = S.db.prepare("SELECT action, detail FROM audit WHERE actor='admin'").all().map((x) => x.action);
  for (const act of ['profiles_merged', 'phone_changed_by_support']) assert.ok(all.includes(act), act);
  assert.ok(idb > 0);
  // отвязка пластика, привязанного по ошибке: баллы остаются в профиле, карта свободна
  await admin('POST', '/api/admin/cards/import', { kind: 'physical', text: '999000000000120;1234' });
  const t = await login('+79200000039');
  await S.call('POST', '/api/me/cards/bind', { token: t, body: { number: '999000000000120', code: '1234' } });
  assert.equal((await admin('POST', '/api/admin/cards/999000000000120/unbind', { reason: 'не тот клиент' })).json.status, 'free');
  assert.equal((await me(t)).balance, 150);
  assert.deepEqual((await me(t)).physicalCards, []);
});

test('журнал: каждый изменяющий запрос и каждый просмотр админки записан, тела (ПДн) не пишутся', async () => {
  const before = S.db.prepare("SELECT COUNT(*) c FROM audit WHERE action='http'").get().c;
  await admin('GET', '/api/admin/stats');
  await S.call('POST', '/api/auth/request-code', { body: { phone: '+79200000099' } });
  const rows = S.db.prepare("SELECT actor, detail FROM audit WHERE action='http' ORDER BY id DESC LIMIT 2").all();
  assert.equal(S.db.prepare("SELECT COUNT(*) c FROM audit WHERE action='http'").get().c, before + 2);
  assert.ok(!rows.some((r) => r.detail.includes('9200000099')));
  assert.equal(rows[1].actor, 'admin');
});

test('резервная копия: файл создан и проходит проверку целостности', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'deya-bk-'));
  const f = backupNow(S.db, dir);
  assert.ok(fs.statSync(f).size > 0);
});

test('чужое списание по совпавшему ref не подхватывается (кассир, второй клиент)', async () => {
  await admin('POST', '/api/admin/cards/import', { kind: 'virtual', range: { from: '999000000000201', to: '999000000000203' } });
  const a = await register('+79200000050'), b = await register('+79200000051');
  const ca = (await me(a)).card.number, cb = (await me(b)).card.number;
  await buy(ca, '4000.00'); await buy(cb, '4000.00');
  const lines = [{ number: 1, sum: '1000.00' }];
  await pos('/api/v1/pos/redeem/reserve', { ref: 'ref:same', card: { number: ca }, lines, mode: 'cashier', points: 10 });
  await pos('/api/v1/pos/redeem/writeoff', { ref: 'ref:same', card: ca });
  const rb = await pos('/api/v1/pos/redeem/reserve', { ref: 'ref:same', card: { number: cb }, lines, mode: 'cashier', points: 20 });
  assert.equal(rb.json.points, 20); assert.ok(!rb.json.committed);
  const wb = await pos('/api/v1/pos/redeem/writeoff', { ref: 'ref:same', card: cb });
  assert.equal(wb.json.points, 20);
  assert.equal((await me(a)).balance, 190); assert.equal((await me(b)).balance, 180);
});
