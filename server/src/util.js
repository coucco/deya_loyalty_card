import crypto from 'node:crypto';

export const nowIso = () => new Date().toISOString();
export const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

export class HttpError extends Error {
  constructor(status, code, message) { super(message || code); this.status = status; this.code = code; }
}

/** Телефон -> 7XXXXXXXXXX. Принимает +7, 8, пробелы, скобки. */
export function normalizePhone(raw) {
  const d = String(raw ?? '').replace(/\D/g, '');
  let n = d;
  if (n.length === 11 && n[0] === '8') n = '7' + n.slice(1);
  if (n.length === 10) n = '7' + n;
  if (!/^7\d{10}$/.test(n)) throw new HttpError(400, 'bad_phone', 'Неверный номер телефона');
  return n;
}

/** Контрольная цифра Луна для номеров карт. */
export function luhnDigit(body) {
  let sum = 0;
  for (let i = body.length - 1, alt = true; i >= 0; i--, alt = !alt) {
    let d = body.charCodeAt(i) - 48;
    if (alt) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return String((10 - (sum % 10)) % 10);
}
export const luhnValid = (num) => /^\d{8,19}$/.test(num) && luhnDigit(num.slice(0, -1)) === num.slice(-1);

/** Деньги строкой "1234.50" -> копейки (целое). Без float. */
export function parseKop(v) {
  if (typeof v === 'number') v = String(v);
  if (typeof v !== 'string' || !/^-?\d+(\.\d{1,6})?$/.test(v.trim())) throw new HttpError(400, 'bad_amount', 'Неверная сумма: ' + v);
  const t = v.trim(); const neg = t.startsWith('-');
  const [i, f = ''] = t.replace('-', '').split('.');
  const kop = Number(i) * 100 + divRound(Number((f + '000').slice(0, 3)), 10);
  return neg ? -kop : kop;
}
export const formatKop = (k) => (k / 100).toFixed(2);

/** Округление a/b до целого, half-up (для неотрицательных), симметрично для отрицательных. */
export function divRound(a, b, mode = 'half_up') {
  const sign = a < 0 ? -1 : 1; a = Math.abs(a);
  let q = Math.floor(a / b); const r = a - q * b;
  if (mode === 'half_up' && r * 2 >= b) q += 1;
  else if (mode === 'ceil' && r > 0) q += 1;
  return sign * q;
}

export function tsEq(a, b) {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
