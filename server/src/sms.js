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
        smsRuCheck(await r.text(), phone);
      },
    };
  }
  return { // console / тесты: код виден в логе и в outbox
    outbox,
    async send(phone, text) { outbox.push({ phone, text }); log.log(`[SMS→${phone}] ${text}`); },
  };
}

/**
 * SMS.ru (и похожие) отвечают HTTP 200 даже при ошибке; при `json=1` в ссылке смотрим статус в теле:
 * {"status":"OK","sms":{"79991234567":{"status":"OK",...}}} или {"status":"ERROR","status_text":"..."}.
 * Тело не JSON (другой провайдер) — считаем, что HTTP 200 достаточно.
 */
export function smsRuCheck(body, phone) {
  let j;
  try { j = JSON.parse(body); } catch { return; }
  if (!j || typeof j !== 'object' || !('status' in j)) return;
  if (j.status !== 'OK') throw new Error('SMS provider: ' + (j.status_text || j.status));
  const one = j.sms && j.sms[phone];
  if (one && one.status !== 'OK') throw new Error('SMS provider: ' + (one.status_text || one.status));
}
