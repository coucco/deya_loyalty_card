import test from 'node:test';
import assert from 'node:assert/strict';
import { smsRuCheck, makeSms } from '../src/sms.js';
import http from 'node:http';

test('SMS.ru: ошибка внутри ответа HTTP 200 распознаётся', () => {
  assert.doesNotThrow(() => smsRuCheck('{"status":"OK","sms":{"79991234567":{"status":"OK","sms_id":"1"}}}', '79991234567'));
  assert.throws(() => smsRuCheck('{"status":"ERROR","status_code":200,"status_text":"Неправильный api_id"}', '79991234567'), /api_id/);
  assert.throws(() => smsRuCheck('{"status":"OK","sms":{"79991234567":{"status":"ERROR","status_text":"Недостаточно средств"}}}', '79991234567'), /средств/);
  assert.doesNotThrow(() => smsRuCheck('100\n201523-1000007', '79991234567'));   // не JSON — другой провайдер
});

test('ошибка провайдера пишется в лог с причиной, без api_id и полного номера', async () => {
  const srv = http.createServer((req, res) => { res.writeHead(200); res.end('{"status":"ERROR","status_text":"Недостаточно средств на лицевом счету"}'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const lines = [];
  const sms = makeSms({ smsProvider: 'http', smsHttpUrl: `http://127.0.0.1:${srv.address().port}/send?api_id=SECRET&to={phone}&msg={text}&json=1` },
    { log() {}, error: (m) => lines.push(m) });
  await assert.rejects(() => sms.send('79991234567', 'Код 1234'), /средств/);
  srv.close();
  assert.equal(lines.length, 1);
  assert.match(lines[0], /СМС НЕ ОТПРАВЛЕНО.*Недостаточно средств/);
  assert.ok(!lines[0].includes('SECRET') && !lines[0].includes('79991234567'));
});
