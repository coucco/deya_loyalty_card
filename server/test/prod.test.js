// Запуск в режиме production с HTTP-провайдером СМС (фейковый провайдер на localhost)
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { tmpDbFile } from './helper.js';

test('production: код уходит провайдеру по HTTP и НЕ попадает в лог сервера; запуск без секретов отклоняется', async () => {
  const got = [];
  const sms = http.createServer((req, res) => { got.push({ url: req.url, auth: req.headers.authorization }); res.end('ok'); });
  await new Promise((r) => sms.listen(0, '127.0.0.1', r));
  const smsPort = sms.address().port;
  const base = { ...process.env, NODE_ENV: 'production', PORT: '3951', DB_FILE: tmpDbFile(), ADMIN_TOKEN: 'p'.repeat(30), APP_SECRET: 's'.repeat(30),
    SMS_PROVIDER: 'http', SMS_HTTP_URL: `http://127.0.0.1:${smsPort}/send?to={phone}&text={text}`, SMS_HTTP_AUTH: 'Bearer prov-key' };
  const p = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', new URL('../src/index.js', import.meta.url).pathname], { env: base });
  let log = ''; p.stdout.on('data', (d) => (log += d)); p.stderr.on('data', (d) => (log += d));
  try {
    for (let i = 0; i < 100; i++) { try { if ((await fetch('http://127.0.0.1:3951/healthz')).ok) break; } catch { /* ждём */ } await new Promise((r) => setTimeout(r, 50)); }
    const r = await fetch('http://127.0.0.1:3951/api/auth/request-code', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: '+7 999 111-22-33' }) });
    assert.equal(r.status, 200);
    assert.equal(got.length, 1);
    const u = new URL('http://x' + got[0].url);
    assert.equal(u.searchParams.get('to'), '79991112233');
    const code = u.searchParams.get('text').match(/(\d{4})/)[1];
    assert.equal(got[0].auth, 'Bearer prov-key');
    assert.ok(!log.includes(code) || !/Код входа/.test(log), 'код не должен печататься в лог в production');
    assert.ok(!log.includes('SMS→'));
    const v = await fetch('http://127.0.0.1:3951/api/auth/verify', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ phone: '79991112233', code, consent: true }) });
    assert.equal(v.status, 200);
    // production без демо-данных: проценты нулевые, пока админ не задал настоящие
    const pts = await (await fetch('http://127.0.0.1:3951/api/points')).json();
    assert.ok(pts.earn.every((e) => e.accrualPct === 0) && pts.points.every((e) => e.redeemPct === 0));
  } finally { p.kill('SIGTERM'); sms.close(); }

  const bad = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', new URL('../src/index.js', import.meta.url).pathname], { env: { ...base, ADMIN_TOKEN: '', PORT: '3952' } });
  const code = await new Promise((r) => bad.on('exit', r));
  assert.notEqual(code, 0);
});
