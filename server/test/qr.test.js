// QR из веб-приложения проверяется независимым декодером (Python): zxing-cpp, если установлен (движок как у многих сканеров),
// иначе OpenCV. Детектор OpenCV 5.0 изредка не находит корректный код (напр. 2000807493018, zxing его читает), поэтому zxing предпочтительнее.
// Если Python/декодеров нет — тест пропускается.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { qrMatrix } from '../../web/qr.js';
import { generateCardNumber } from '../src/loyalty.js';

const hasCv = spawnSync('python3', ['-c', 'import cv2, numpy']).status === 0;
test('QR: 40+ разных номеров карт и строк декодируются независимым декодером без ошибок', { skip: !hasCv && 'нет python3 + opencv' }, () => {
  const texts = Array.from({ length: 30 }, () => generateCardNumber('2000', 13)).concat(['2000807493018', 'A', '1', 'Дея карта 123', 'x'.repeat(60), 'https://example.com/?a=1&b=2', '0000000000000', '9999999999999', 'x'.repeat(100), 'ab', 'z'.repeat(14)]);
  const py = `
import sys, json, cv2, numpy as np
try:
    import zxingcpp
    def decode(img):
        r = zxingcpp.read_barcodes(img)
        return r[0].text if r else ''
except ImportError:
    def decode(img):
        return cv2.QRCodeDetector().detectAndDecode(img)[0]
bad = 0
for t, m in json.load(sys.stdin):
    a = np.array([[int(c) for c in r] for r in m], dtype=np.uint8)
    img = np.kron(np.pad(1 - a, 4, constant_values=1) * 255, np.ones((8, 8), dtype=np.uint8)).astype(np.uint8)
    v = decode(img)
    if v != t: bad += 1; print('BAD', repr(t[:20]), repr(v[:20]))
print('bad', bad)`;
  const input = JSON.stringify(texts.map((t) => [t, qrMatrix(t).map((r) => r.map((v) => (v ? 1 : 0)).join(''))]));
  const r = spawnSync('python3', ['-c', py], { input, encoding: 'utf8' });
  assert.match(r.stdout, /bad 0/, r.stdout + r.stderr);
});
test('QR: слишком длинный текст — понятная ошибка', () => assert.throws(() => qrMatrix('x'.repeat(200)), /слишком длинный/i));
