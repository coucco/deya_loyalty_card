import test from 'node:test';
import assert from 'node:assert/strict';
import { smsRuCheck } from '../src/sms.js';

test('SMS.ru: ошибка внутри ответа HTTP 200 распознаётся', () => {
  assert.doesNotThrow(() => smsRuCheck('{"status":"OK","sms":{"79991234567":{"status":"OK","sms_id":"1"}}}', '79991234567'));
  assert.throws(() => smsRuCheck('{"status":"ERROR","status_code":200,"status_text":"Неправильный api_id"}', '79991234567'), /api_id/);
  assert.throws(() => smsRuCheck('{"status":"OK","sms":{"79991234567":{"status":"ERROR","status_text":"Недостаточно средств"}}}', '79991234567'), /средств/);
  assert.doesNotThrow(() => smsRuCheck('100\n201523-1000007', '79991234567'));   // не JSON — другой провайдер
});
