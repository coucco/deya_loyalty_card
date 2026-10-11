// Общие мелочи для всех страниц (без фреймворков)
export const $ = (sel, root = document) => root.querySelector(sel);

/** Безопасное создание DOM: текст всегда через textContent, поэтому имя пользователя не может внедрить разметку. */
export function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'html') throw new Error('html запрещён');
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
export function svg(inner, size = 20, stroke = 'currentColor', sw = 2) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('width', size); s.setAttribute('height', size); s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('fill', 'none'); s.setAttribute('stroke', stroke); s.setAttribute('stroke-width', sw);
  s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
  s.innerHTML = inner; // только наши константы
  return s;
}
export const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* приватный режим */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* */ } },
};
export const fmt = (n) => Number(n).toLocaleString('ru-RU').replace(/ /g, ' ');
export const rub = (kop) => fmt(Math.round(kop / 100));
export function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}
export const pctText = (p) => String(p).replace('.', ',') + '%';

export async function api(method, path, { body, token } = {}) {
  let r;
  try {
    r = await fetch(path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  } catch { const e = new Error('Нет связи. Проверьте интернет'); e.code = 'network'; throw e; }
  let json = {}; try { json = await r.json(); } catch { /* не json */ }
  if (!r.ok) { const e = new Error(json.message || 'Ошибка ' + r.status); e.status = r.status; e.code = json.error; throw e; }
  return json;
}
