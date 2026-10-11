import crypto from 'node:crypto';

const env = process.env;
const int = (k, d) => (env[k] !== undefined && env[k] !== '' ? Number(env[k]) : d);

export function loadConfig(overrides = {}) {
  const c = {
    port: int('PORT', 3000),
    dbFile: env.DB_FILE || './data/deya.db',
    isProd: env.NODE_ENV === 'production',
    adminToken: env.ADMIN_TOKEN || '',
    publicDir: env.PUBLIC_DIR || new URL('../../web/', import.meta.url).pathname,
    cardPrefix: env.CARD_PREFIX || '2000',        // префикс номеров карт приложения
    cardLength: int('CARD_LENGTH', 13),
    smsProvider: env.SMS_PROVIDER || 'console',   // console | http
    smsHttpUrl: env.SMS_HTTP_URL || '',           // шаблон URL: {phone} {text}
    smsHttpAuth: env.SMS_HTTP_AUTH || '',         // значение заголовка Authorization (если нужно)
    otpTtlSec: int('OTP_TTL_SEC', 300),
    otpMaxAttempts: int('OTP_MAX_ATTEMPTS', 5),
    otpResendSec: int('OTP_RESEND_SEC', 60),
    otpPerHour: int('OTP_PER_HOUR', 5),
    sessionDays: int('SESSION_DAYS', 90),
    holdTtlSec: int('HOLD_TTL_SEC', 600),
    rateLimitPerMin: int('RATE_LIMIT_PER_MIN', 120),
    trustProxy: env.TRUST_PROXY === '1',
  };
  Object.assign(c, overrides);
  if (c.isProd) {
    if (c.adminToken.length < 24) throw new Error('В production нужен ADMIN_TOKEN (не короче 24 символов)');
    if (c.smsProvider === 'console') throw new Error('В production нельзя SMS_PROVIDER=console: коды уходили бы в лог. Настройте SMS_PROVIDER=http');
  }
  if (!c.adminToken) c.adminToken = crypto.randomBytes(16).toString('hex'); // dev: случайный, печатается при старте
  return c;
}
