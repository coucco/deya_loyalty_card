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
    // pool — карты выдаются из пула номеров, заранее заведённых в Set10 (админка → «Пул карт»);
    // generate — сервер сам генерирует номер (только для пробного запуска: Set10 такие карты не знает)
    cardIssueMode: env.CARD_ISSUE_MODE || (env.NODE_ENV === 'production' ? 'pool' : 'generate'),
    posHoldTtlSec: int('POS_HOLD_TTL_SEC', 1800),   // резерв баллов под чек гипермаркета (от подытога до оплаты)
    redeemConfirmAttempts: int('REDEEM_CONFIRM_ATTEMPTS', 5),
    // юридические документы: версия попадает в журнал согласий; ссылки показываются на экране входа
    docsVersion: env.DOCS_VERSION || '1',
    publicUrl: (env.PUBLIC_URL || (env.DOMAIN ? 'https://' + env.DOMAIN : '')).replace(/\/$/, ''),   // для ссылок в СМС
    support: { phone: env.SUPPORT_PHONE || '+7 929 838-45-16', email: env.SUPPORT_EMAIL || 'timurshokarov1001@gmail.com' },
    backupDir: env.BACKUP_DIR || '',                 // ежедневная копия БД (пусто = выключено)
    backupKeepDays: int('BACKUP_KEEP_DAYS', 14),
    auditKeepDays: int('AUDIT_KEEP_DAYS', 1095),     // журнал действий хранится 3 года
    docs: {
      rules: env.DOC_RULES_URL || '/legal/rules.html',
      privacy: env.DOC_PRIVACY_URL || '/legal/privacy.html',
      pd: env.DOC_PD_CONSENT_URL || '/legal/pd-consent.html',
      marketing: env.DOC_MARKETING_URL || '/legal/marketing-consent.html',
    },
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
  if (!['pool', 'generate'].includes(c.cardIssueMode)) throw new Error('CARD_ISSUE_MODE: pool | generate');
  if (c.isProd) {
    if (c.adminToken.length < 24) throw new Error('В production нужен ADMIN_TOKEN (не короче 24 символов)');
    if (c.smsProvider === 'console') throw new Error('В production нельзя SMS_PROVIDER=console: коды уходили бы в лог. Настройте SMS_PROVIDER=http');
  }
  if (!c.adminToken) c.adminToken = crypto.randomBytes(16).toString('hex'); // dev: случайный, печатается при старте
  return c;
}
