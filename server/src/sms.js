/** Отправка кодов. Интерфейс: send(phone, text). Реальный провайдер подключается через SMS_PROVIDER=http. */
export function makeSms(cfg, log = console) {
  const outbox = [];
  if (cfg.smsProvider === 'http') {
    return {
      outbox,
      async send(phone, text) {
        const url = cfg.smsHttpUrl.replace('{phone}', encodeURIComponent(phone)).replace('{text}', encodeURIComponent(text));
        const r = await fetch(url, { headers: cfg.smsHttpAuth ? { Authorization: cfg.smsHttpAuth } : {}, signal: AbortSignal.timeout(10000) });
        if (!r.ok) throw new Error('SMS provider HTTP ' + r.status);
      },
    };
  }
  return { // console / тесты: код виден в логе и в outbox
    outbox,
    async send(phone, text) { outbox.push({ phone, text }); log.log(`[SMS→${phone}] ${text}`); },
  };
}
