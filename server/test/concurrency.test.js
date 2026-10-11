// Два отдельных процесса сервера работают с одним файлом БД, на них идёт параллельная нагрузка.
// Проверяем главное: баланс не расходится с журналом, дубли не задваиваются, резерв не уходит выше баланса.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { tmpDbFile, receipt } from './helper.js';
import { DatabaseSync } from 'node:sqlite';

const ADMIN = 'concurrency-admin-token-0123456789';
const procs = []; let dbFile, bases = [], hkey, ckey, card, userToken;

async function boot(port) {
  const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', new URL('../src/index.js', import.meta.url).pathname],
    { env: { ...process.env, PORT: String(port), DB_FILE: dbFile, ADMIN_TOKEN: ADMIN, SEED_DEMO: '1', OTP_RESEND_SEC: '0', RATE_LIMIT_PER_MIN: '100000' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; p.stdout.on('data', (d) => (log += d)); p.stderr.on('data', (d) => (log += d));
  p.log = () => log; procs.push(p);
  for (let i = 0; i < 100; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/healthz`)).ok) return; } catch { /* ещё не поднялся */ } await new Promise((r) => setTimeout(r, 50)); }
  throw new Error('не стартовал: ' + log);
}
const call = async (base, method, path, body, token) => {
  const r = await fetch(base + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => ({})) };
};

before(async () => {
  dbFile = tmpDbFile();
  await boot(3931); await boot(3932);
  bases = ['http://127.0.0.1:3931', 'http://127.0.0.1:3932'];
  hkey = (await call(bases[0], 'POST', '/api/admin/points/hypermarket/rotate-key', null, ADMIN)).json.apiKey;
  ckey = (await call(bases[1], 'POST', '/api/admin/points/cinema/rotate-key', null, ADMIN)).json.apiKey;
  const phone = '+79997776655';
  await call(bases[0], 'POST', '/api/auth/request-code', { phone });
  // код читаем из БД-независимого лога процесса
  const code = procs[0].log().match(/Код входа в Дея: (\d{4})/)[1];
  userToken = (await call(bases[0], 'POST', '/api/auth/verify', { phone, code, consent: true })).json.token;
  card = (await call(bases[0], 'GET', '/api/me', null, userToken)).json.card.number;
});
after(() => procs.forEach((p) => p.kill('SIGTERM')));

test('300 параллельных чеков (100 уникальных ×3 повтора) через 2 процесса: ровно 100 начислений', async () => {
  const jobs = [];
  for (let rep = 0; rep < 3; rep++) for (let i = 0; i < 100; i++) {
    jobs.push(call(bases[(i + rep) % 2], 'POST', '/api/v1/accruals', receipt(card, 'fd:C:' + i, [{ sum: '100.00' }]), hkey));   // 100 ₽ × 5% = 5 баллов
  }
  const res = await Promise.all(jobs);
  const codes = res.reduce((m, r) => ((m[r.status] = (m[r.status] || 0) + 1), m), {});
  assert.deepEqual(codes, { 200: 100, 409: 200 }, JSON.stringify(codes));
  const me = await call(bases[0], 'GET', '/api/me', null, userToken);
  assert.equal(me.json.balance, 500);
});

test('резервы: баланс 500, 80 параллельных резервов по 10 баллов (лимит 50% чека) -> ровно 50 проходят', async () => {
  await call(bases[0], 'PATCH', '/api/admin/points/cinema', { redeemPct: 100 }, ADMIN);
  const res = await Promise.all(Array.from({ length: 80 }, (_, i) => call(bases[i % 2], 'POST', '/api/v1/redeem/hold', { card, checkTotal: '100.00', points: 10, idempotencyKey: 'hold-' + i }, ckey)));
  const ok = res.filter((r) => r.status === 201).length, over = res.filter((r) => r.status === 422).length;
  assert.equal(ok, 50); assert.equal(over, 30);
  const me = await call(bases[1], 'GET', '/api/me', null, userToken);
  assert.equal(me.json.balance, 500); assert.equal(me.json.available, 0);
  // подтверждаем все параллельно, дважды каждый
  const holds = res.filter((r) => r.status === 201).map((r) => r.json.holdId);
  const commits = await Promise.all(holds.flatMap((id, i) => [0, 1].map((k) => call(bases[(i + k) % 2], 'POST', `/api/v1/redeem/${id}/commit`, {}, ckey))));
  assert.ok(commits.every((c) => c.status === 200));
  const after = await call(bases[0], 'GET', '/api/me', null, userToken);
  assert.equal(after.json.balance, 0);
});

test('итоговая сверка: баланс = сумма журнала, отрицательных значений нет, дублей ключей нет', async () => {
  const db = new DatabaseSync(dbFile);
  assert.equal(db.prepare('SELECT COUNT(*) c FROM ledger').get().c, 150);   // 100 начислений + 50 списаний
  assert.equal(db.prepare('SELECT COUNT(*) c FROM (SELECT idem_key FROM ledger GROUP BY idem_key HAVING COUNT(*)>1)').get().c, 0);
  const a = db.prepare('SELECT balance, held FROM accounts').get();
  assert.deepEqual({ ...a }, { balance: 0, held: 0 });
  assert.equal(db.prepare('SELECT COALESCE(SUM(points),0) s FROM ledger').get().s, 0);
  db.close();
});
