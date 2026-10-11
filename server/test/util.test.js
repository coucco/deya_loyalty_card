import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhone, luhnDigit, luhnValid, parseKop, divRound } from '../src/util.js';
import { generateCardNumber } from '../src/loyalty.js';

test('телефон: форматы приводятся к 7XXXXXXXXXX', () => {
  for (const p of ['+7 (999) 123-45-67', '89991234567', '9991234567', '7 999 123 45 67']) assert.equal(normalizePhone(p), '79991234567');
  for (const bad of ['', '123', '+1 202 555 0100', '899912345']) assert.throws(() => normalizePhone(bad), /Неверный номер/);
});
test('Luhn: известные значения и генератор карт', () => {
  assert.equal(luhnDigit('7992739871'), '3');                // эталон из Wikipedia
  assert.ok(luhnValid('79927398713'));
  assert.ok(!luhnValid('79927398710'));
  for (let i = 0; i < 200; i++) { const n = generateCardNumber('2000', 13); assert.equal(n.length, 13); assert.ok(n.startsWith('2000')); assert.ok(luhnValid(n)); }
});
test('суммы: строки -> копейки без float-ошибок', () => {
  assert.equal(parseKop('1234.50'), 123450);
  assert.equal(parseKop('0.07'), 7);
  assert.equal(parseKop('19.99'), 1999);
  assert.equal(parseKop('100'), 10000);
  assert.equal(parseKop('0.005'), 1);        // половина копейки округляется вверх
  assert.equal(parseKop('-5.25'), -525);
  assert.throws(() => parseKop('abc'));
  assert.throws(() => parseKop('1,5'));
});
test('округление half-up и floor', () => {
  assert.equal(divRound(5, 10), 1); assert.equal(divRound(4, 10), 0); assert.equal(divRound(15, 10), 2);
  assert.equal(divRound(-5, 10), -1); assert.equal(divRound(19, 10, 'floor'), 1);
});
