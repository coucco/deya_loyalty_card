// Генератор QR-кода без зависимостей. Режим байтов, коррекция ошибок M, версии 1–6 (до 106 байт).
// Алгоритм по спецификации ISO/IEC 18004; проверяется тестом декодером OpenCV.
const DATA_CW = [0, 16, 28, 44, 64, 86, 108];   // кодовых слов данных, версии 1..6, уровень M
const EC_CW   = [0, 10, 16, 26, 18, 24, 16];    // слов коррекции на блок
const BLOCKS  = [0, 1, 1, 1, 2, 2, 4];          // число блоков (все блоки равные)

const EXP = new Uint8Array(512), LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 256) x ^= 0x11d; }
for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
const gmul = (a, b) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

function rsRemainder(data, degree) {
  let gen = [1];
  for (let i = 0; i < degree; i++) {            // умножаем на (x - a^i)
    const next = new Array(gen.length + 1).fill(0);
    gen.forEach((c, j) => { next[j] ^= c; next[j + 1] ^= gmul(c, EXP[i]); });
    gen = next;
  }
  const res = new Array(degree).fill(0);
  for (const b of data) {
    const f = b ^ res.shift(); res.push(0);
    for (let i = 0; i < degree; i++) res[i] ^= gmul(gen[i + 1], f);
  }
  return res;
}

export function qrMatrix(text) {
  const bytes = new TextEncoder().encode(text);
  let ver = 1;
  while (ver <= 6 && bytes.length + 2 > DATA_CW[ver]) ver++;     // 4+8 бит заголовка + 4 бита терминатор ≈ 2 байта
  if (ver > 6) throw new Error('Текст слишком длинный для QR');
  const size = 17 + 4 * ver;

  // 1. битовый поток
  const bits = [];
  const put = (v, n) => { for (let i = n - 1; i >= 0; i--) bits.push((v >>> i) & 1); };
  put(4, 4); put(bytes.length, 8); bytes.forEach((b) => put(b, 8));
  const cap = DATA_CW[ver] * 8;
  put(0, Math.min(4, cap - bits.length));
  while (bits.length % 8) bits.push(0);
  for (let pad = 0xec; bits.length < cap; pad ^= 0xec ^ 0x11) put(pad, 8);
  const data = []; for (let i = 0; i < bits.length; i += 8) data.push(parseInt(bits.slice(i, i + 8).join(''), 2));

  // 2. блоки + коррекция + перемежение
  const nb = BLOCKS[ver], per = DATA_CW[ver] / nb;
  const dBlocks = [], eBlocks = [];
  for (let b = 0; b < nb; b++) { const d = data.slice(b * per, (b + 1) * per); dBlocks.push(d); eBlocks.push(rsRemainder(d, EC_CW[ver])); }
  const cw = [];
  for (let i = 0; i < per; i++) dBlocks.forEach((d) => cw.push(d[i]));
  for (let i = 0; i < EC_CW[ver]; i++) eBlocks.forEach((e) => cw.push(e[i]));

  // 3. матрица
  const mod = Array.from({ length: size }, () => new Array(size).fill(false));
  const fn = Array.from({ length: size }, () => new Array(size).fill(false));
  const setFn = (x, y, v) => { mod[y][x] = v; fn[y][x] = true; };
  for (let i = 0; i < size; i++) { setFn(6, i, i % 2 === 0); setFn(i, 6, i % 2 === 0); }
  const finder = (cx, cy) => {
    for (let dy = -4; dy <= 4; dy++) for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx, y = cy + dy, d = Math.max(Math.abs(dx), Math.abs(dy));
      if (x >= 0 && x < size && y >= 0 && y < size) setFn(x, y, d !== 2 && d !== 4);
    }
  };
  finder(3, 3); finder(size - 4, 3); finder(3, size - 4);
  if (ver > 1) {
    const pos = [6, size - 7];
    for (const cy of pos) for (const cx of pos) {
      if ((cx === 6 && cy === 6) || (cx === 6 && cy === size - 7) || (cx === size - 7 && cy === 6)) continue;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) setFn(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
  const drawFormat = (mask) => {
    let rem = mask;                                   // уровень M = 00, поэтому данные = mask
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bitsF = ((mask << 10) | rem) ^ 0x5412;
    const bit = (i) => ((bitsF >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) setFn(8, i, bit(i));
    setFn(8, 7, bit(6)); setFn(8, 8, bit(7)); setFn(7, 8, bit(8));
    for (let i = 9; i < 15; i++) setFn(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) setFn(size - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) setFn(8, size - 15 + i, bit(i));
    setFn(8, size - 8, true);
  };
  drawFormat(0);                                      // резервируем область под формат

  // 4. размещение данных зигзагом
  let k = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < size; vert++) for (let j = 0; j < 2; j++) {
      const x = right - j, y = ((right + 1) & 2) === 0 ? size - 1 - vert : vert;
      if (!fn[y][x] && k < cw.length * 8) { mod[y][x] = ((cw[k >>> 3] >>> (7 - (k & 7))) & 1) !== 0; k++; }
    }
  }

  // 5. выбор маски по штрафу
  const maskFn = [(x, y) => (x + y) % 2 === 0, (x, y) => y % 2 === 0, (x, y) => x % 3 === 0, (x, y) => (x + y) % 3 === 0,
    (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0, (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
    (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0, (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0];
  const applyMask = (m) => { for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) if (!fn[y][x] && maskFn[m](x, y)) mod[y][x] = !mod[y][x]; };
  const penalty = () => {
    let p = 0;
    const lines = [];
    for (let i = 0; i < size; i++) { lines.push(mod[i]); lines.push(mod.map((r) => r[i])); }
    for (const l of lines) {
      let run = 1;
      for (let i = 1; i <= size; i++) { if (i < size && l[i] === l[i - 1]) run++; else { if (run >= 5) p += run - 2; run = 1; } }
      const s = l.map((v) => (v ? 1 : 0)).join('');
      for (const pat of ['10111010000', '00001011101']) { let at = s.indexOf(pat); while (at !== -1) { p += 40; at = s.indexOf(pat, at + 1); } }
    }
    for (let y = 0; y < size - 1; y++) for (let x = 0; x < size - 1; x++) if (mod[y][x] === mod[y][x + 1] && mod[y][x] === mod[y + 1][x] && mod[y][x] === mod[y + 1][x + 1]) p += 3;
    const dark = mod.flat().filter(Boolean).length;
    p += Math.floor(Math.abs((dark * 20) - size * size * 10) / (size * size)) * 10;
    return p;
  };
  let best = 0, bestP = Infinity;
  for (let m = 0; m < 8; m++) { applyMask(m); const p = penalty(); if (p < bestP) { bestP = p; best = m; } applyMask(m); }
  applyMask(best); drawFormat(best);
  return mod;
}

/** Рисует QR на canvas с «тихой зоной» в 4 модуля. */
export function drawQr(canvas, text, px = 240) {
  const m = qrMatrix(text), n = m.length + 8, scale = Math.floor(px / n) || 1;
  canvas.width = canvas.height = n * scale;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = '#1A1A1A';
  m.forEach((row, y) => row.forEach((v, x) => { if (v) ctx.fillRect((x + 4) * scale, (y + 4) * scale, scale, scale); }));
}
