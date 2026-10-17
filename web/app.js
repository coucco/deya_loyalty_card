import { $, h, svg, store, fmt, rub, plural, pctText, api } from './lib.js';
import { drawQr } from './qr.js';
import { drawCode128 } from './barcode.js';

const app = $('#app');
const state = { token: store.get('deya_token'), me: null, points: null, phone: '', resendAt: 0, consents: { pd: false, rules: false, marketing: false }, legal: null };
let timers = [];
const clearTimers = () => { timers.forEach(clearInterval); timers = []; };
const every = (fn, ms) => { timers.push(setInterval(fn, ms)); };

/* ---------- маршрутизация ---------- */
const routes = { login: viewLogin, code: viewCode, home: viewHome, qr: viewQr, success: viewSuccess, spend: viewSpend, history: viewHistory, profile: viewProfile };
export function go(name) { if (location.hash !== '#/' + name) location.hash = '#/' + name; else render(); }
async function render() {
  clearTimers();
  let name = location.hash.replace('#/', '') || (state.token ? 'home' : 'login');
  if (!routes[name]) name = state.token ? 'home' : 'login';
  const needAuth = !['login', 'code'].includes(name);
  if (needAuth && !state.token) return go('login');
  if (!needAuth && state.token) return go('home');
  app.replaceChildren();
  try { await routes[name](); }
  catch (e) {
    if (e.status === 401) { state.token = null; store.del('deya_token'); return go('login'); }
    app.replaceChildren(h('div', { class: 'content' }, logoEl(), h('p', { class: 'lead' }, e.message || 'Что-то пошло не так'), h('button', { class: 'btn', onclick: render }, 'Повторить')));
  }
}
window.addEventListener('hashchange', render);

/* ---------- общие части ---------- */
const logoEl = (cls = '') => h('div', { class: 'logo ' + cls }, h('img', { src: '/assets/logo.png', alt: 'ДЕЯ' }));
const ICONS = {
  home: '<path d="M3 11l9-8 9 8v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z"/>',
  history: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  profile: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>',
};
const NAMES = { home: 'Главная', history: 'История', profile: 'Профиль' };
const tabbar = (on) => h('nav', { class: 'tabbar' }, Object.keys(NAMES).map((k) =>
  h('button', { class: 'tab' + (k === on ? ' on' : ''), onclick: () => go(k) }, svg(ICONS[k], 24), NAMES[k])));
const page = (...kids) => app.replaceChildren(...kids);
const toast = (t) => { const el = h('div', { class: 'toast' }, t); document.body.append(el); setTimeout(() => el.remove(), 2500); };
const fetchMe = async () => (state.me = await api('GET', '/api/me', { token: state.token }));
const fetchPoints = async () => (state.points = await api('GET', '/api/points'));
const timeOf = (iso) => new Date(iso).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
function dayLabel(iso) {
  const d = new Date(iso), t = new Date(); const y = new Date(); y.setDate(t.getDate() - 1);
  if (d.toDateString() === t.toDateString()) return 'Сегодня';
  if (d.toDateString() === y.toDateString()) return 'Вчера';
  return d.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', ...(d.getFullYear() !== t.getFullYear() ? { year: 'numeric' } : {}) });
}
const CART = '<path d="M3 4h2l2.4 11h11l2-8H6"/><circle cx="9" cy="20" r="1.4"/><circle cx="17" cy="20" r="1.4"/>';
function entryItem(e) {
  const plus = e.points >= 0;
  let title = e.point_name, sub = timeOf(e.created_at);
  if (e.type === 'ACCRUAL') sub = `чек ${rub(e.base_kop)} ₽ · ${sub}`;
  else if (e.type === 'ACCRUAL_REVERSAL') { title = 'Возврат покупки'; sub = `${e.point_name} · ${sub}`; }
  else if (e.type === 'REDEEM') { title = 'Оплата баллами'; sub = `${e.point_name} · ${sub}`; }
  else if (e.type === 'REDEEM_REVERSAL') { title = 'Баллы вернулись'; sub = `${e.point_name} · ${sub}`; }
  return h('div', { class: 'item' }, h('div', { class: 'ic' }, svg(CART, 18, '#EE741C')), h('div', { class: 'tx' }, title, h('small', null, sub)),
    h('div', { class: 'pl' + (plus ? '' : ' minus') }, (plus ? '+' : '−') + fmt(Math.abs(e.points))));
}

/* ---------- вход ---------- */
function formatPhoneInput(raw) {
  let d = raw.replace(/\D/g, '');
  if (d.length === 11 && (d[0] === '7' || d[0] === '8')) d = d.slice(1);
  d = d.slice(0, 10);
  let out = d.slice(0, 3);
  if (d.length > 3) out += ' ' + d.slice(3, 6);
  if (d.length > 6) out += '-' + d.slice(6, 8);
  if (d.length > 8) out += '-' + d.slice(8, 10);
  return { text: out, digits: d };
}
const docLink = (href, text) => h('a', { href, target: '_blank', rel: 'noopener' }, text);
const telHref = (p) => 'tel:' + String(p || '').replace(/[^\d+]/g, '');
/** Контакты поддержки: телефон и почта (в письмо подставляется ID профиля, чтобы поддержка сразу нашла клиента). */
function supportLine(sup, profileId) {
  if (!sup) return '';
  const subject = encodeURIComponent('Карта ДЕЯ' + (profileId ? ', профиль ' + profileId : ''));
  return h('p', { class: 'lead support', style: 'text-align:center;margin-top:14px;font-size:13px' }, 'Поддержка: ',
    h('a', { href: telHref(sup.phone) }, sup.phone), ' · ', h('a', { href: `mailto:${sup.email}?subject=${subject}` }, sup.email));
}
/** Галочка согласия. Обязательные согласия не отмечены заранее (152-ФЗ), рекламное — отдельно и по желанию (38-ФЗ). */
function consentBox(key, ...label) {
  const box = h('input', { type: 'checkbox', 'aria-label': key });
  box.checked = state.consents[key];
  box.addEventListener('change', () => { state.consents[key] = box.checked; box.dispatchEvent(new Event('consent', { bubbles: true })); });
  return h('label', { class: 'consent' }, box, h('span', null, ...label));
}
async function viewLogin() {
  if (!state.legal) { try { state.legal = await api('GET', '/api/legal'); } catch { state.legal = { docs: {} }; } }
  const d = state.legal.docs;
  const err = h('div', { class: 'err' }, state.loginError || '');
  state.loginError = '';
  const input = h('input', { type: 'tel', inputmode: 'numeric', autocomplete: 'tel-national', placeholder: '999 123-45-67', 'aria-label': 'Номер телефона' });
  if (state.phone) input.value = formatPhoneInput(state.phone).text;
  const btn = h('button', { class: 'btn', disabled: true }, 'Получить код');
  // на этом устройстве уже входили: согласия даны при регистрации, галочки не показываем
  const known = store.get('deya_registered') === '1';
  const ready = () => formatPhoneInput(input.value).digits.length === 10 && (known || (state.consents.pd && state.consents.rules));
  const consents = known ? h('div') : h('div', { class: 'consents' },
    consentBox('rules', 'Принимаю ', docLink(d.rules, 'правила программы лояльности')),
    consentBox('pd', 'Даю ', docLink(d.pd, 'согласие на обработку персональных данных'), ' в соответствии с ', docLink(d.privacy, 'политикой конфиденциальности')),
    consentBox('marketing', 'Хочу получать персональные предложения и рекламные рассылки (', docLink(d.marketing, 'согласие'), '), необязательно'));
  consents.addEventListener('consent', () => { btn.disabled = !ready(); });
  input.addEventListener('input', () => { const f = formatPhoneInput(input.value); input.value = f.text; btn.disabled = !ready(); err.textContent = ''; });
  const submit = async () => {
    btn.disabled = true; err.textContent = '';
    try {
      const digits = formatPhoneInput(input.value).digits;
      state.phone = '7' + digits;
      const r = await api('POST', '/api/auth/request-code', { body: { phone: state.phone } });
      state.resendAt = Date.now() + r.resendInSec * 1000;
      go('code');
    } catch (e) { err.textContent = e.code === 'resend_too_soon' ? 'Код уже отправлен. Подождите немного' : e.message; btn.disabled = false; }
  };
  btn.addEventListener('click', submit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !btn.disabled) submit(); });
  page(h('div', { class: 'content' },
    logoEl('big'),
    h('h2', { style: 'margin-top:28px' }, 'Баллы с каждой покупки в гипермаркете'),
    h('div', { class: 'field', style: 'margin-top:28px' }, h('span', { class: 'cc' }, '+7'), input),
    consents, err, h('div', null, btn),
    known ? h('p', { class: 'lead', style: 'text-align:center;margin-top:12px;font-size:12px' }, docLink(d.rules, 'Правила программы'), ' · ', docLink(d.privacy, 'Политика конфиденциальности')) : '',
    supportLine(state.legal.support)));
  btn.disabled = !ready();
  input.focus();
}
function fmtPhoneFull(p) { const d = p.slice(1); return `+7 ${d.slice(0, 3)} ${d.slice(3, 6)}-${d.slice(6, 8)}-${d.slice(8, 10)}`; }
function viewCode() {
  if (!state.phone) return go('login');
  const err = h('div', { class: 'err' });
  const boxes = [0, 1, 2, 3].map(() => h('div', { class: 'box' }));
  const input = h('input', { type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 4, 'aria-label': 'Код из СМС' });
  const resend = h('button', { class: 'btn ghost', disabled: true }, '');
  const paint = () => boxes.forEach((b, i) => { b.textContent = input.value[i] || ''; b.className = 'box' + (i === input.value.length ? ' cur' : ''); });
  const verify = async () => {
    try {
      const r = await api('POST', '/api/auth/verify', { body: { phone: state.phone, code: input.value, consents: state.consents } });
      state.token = r.token; store.set('deya_token', r.token); store.set('deya_registered', '1'); go('home');
    } catch (e) {
      if (e.code === 'consent_required') { store.del('deya_registered'); state.loginError = 'Для регистрации отметьте согласия ниже'; return go('login'); }
      err.textContent = e.code === 'wrong_code' ? 'Неверный код' : e.message;
      input.value = ''; paint();
    }
  };
  input.addEventListener('input', () => { input.value = input.value.replace(/\D/g, '').slice(0, 4); err.textContent = ''; paint(); if (input.value.length === 4) verify(); });
  const tick = () => {
    const left = Math.max(0, Math.ceil((state.resendAt - Date.now()) / 1000));
    resend.disabled = left > 0;
    resend.textContent = left > 0 ? `Отправить код ещё раз через ${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : 'Отправить код ещё раз';
  };
  resend.addEventListener('click', async () => {
    try { const r = await api('POST', '/api/auth/request-code', { body: { phone: state.phone } }); state.resendAt = Date.now() + r.resendInSec * 1000; tick(); }
    catch (e) { err.textContent = e.message; }
  });
  every(tick, 1000); tick();
  page(h('div', { class: 'content' }, h('div', { class: 'topbar' }, logoEl()),
    h('div', { style: 'margin-top:24px' }, h('h2', null, 'Введите код'),
      h('p', { class: 'lead' }, 'Отправили код в СМС на номер ', h('span', { style: 'white-space:nowrap' }, fmtPhoneFull(state.phone)))),
    h('div', { class: 'code', onclick: () => input.focus() }, boxes, input), err, resend,
    h('button', { class: 'btn ghost', style: 'color:var(--muted)', onclick: () => go('login') }, 'Изменить номер')));
  paint(); input.focus();
}

/** Код подтверждения списания (3 этаж): клиент называет его кассиру. */
const pendingBanner = (me) => (me.pending || []).map((p) => h('div', { class: 'pending' },
  h('small', null, `Подтвердите списание ${fmt(p.points)} ${plural(p.points, 'балла', 'баллов', 'баллов')} · ${p.pointName}`),
  h('b', null, p.code), h('small', null, 'Назовите код кассиру')));

/* ---------- главная ---------- */
async function viewHome() {
  const [me, pts, hist] = await Promise.all([fetchMe(), fetchPoints(), api('GET', '/api/me/history?limit=3', { token: state.token })]);
  const earn = pts.earn.find((p) => p.accrualPct > 0);
  const items = hist.items;
  page(h('div', { class: 'content' },
    h('div', { class: 'topbar' }, logoEl()),
    h('p', { style: 'margin:0 0 10px;font-size:15px' }, 'Здравствуйте', me.user.name ? [', ', h('b', null, me.user.name)] : ''),
    pendingBanner(me),
    h('div', { class: 'balance' }, h('div', { class: 'lbl' }, 'Ваши баллы'),
      h('div', { class: 'sum' }, fmt(me.balance), h('span', null, plural(me.balance, 'балл', 'балла', 'баллов'))),
      earn ? h('div', { class: 'rule' }, `${pctText(earn.accrualPct)} баллами с каждой покупки`) : ''),
    h('button', { class: 'btn qrbtn', onclick: () => go('qr') }, svg('<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><path d="M14 14h3v3h-3zM20 14v7M14 20h3"/>', 22, '#F5C84B', 2.2), 'Показать QR на кассе'),
    h('button', { class: 'spend-btn', onclick: () => go('spend') },
      h('div', { class: 'ic2' }, svg('<path d="M19 5L5 19"/><circle cx="7" cy="7" r="2.4"/><circle cx="17" cy="17" r="2.4"/>', 20, '#fff', 2.2)),
      h('span', null, 'Как можно тратить баллы?'), h('span', { class: 'arr' }, '›')),
    h('div', { class: 'sect' }, h('b', null, 'Последние операции'), items.length ? h('a', { onclick: () => go('history') }, 'Все') : ''),
    items.length ? items.map(entryItem) : h('div', { class: 'empty' }, 'Здесь появятся ваши начисления')),
    tabbar('home'));
  // обновление при возврате в приложение
  every(async () => { if (document.visibilityState === 'visible') { try { const m = await fetchMe(); if (m.last?.id !== me.last?.id || (m.pending || []).length !== (me.pending || []).length) render(); } catch { /* */ } } }, 5000);
}

/* ---------- QR ---------- */
async function viewQr() {
  const me = await fetchMe();
  const startId = me.last?.id ?? 0;
  const close = h('button', { class: 'back', 'aria-label': 'Закрыть', onclick: () => go('home') }, '✕');
  if (!me.qr) {   // пул карт пуст: карта будет выдана, когда администратор загрузит номера
    page(h('div', { class: 'content' }, h('div', { class: 'topbar' }, logoEl(), close), h('h2', null, 'Карта готовится'),
      h('p', { class: 'lead' }, 'Мы выпускаем для вас карту. Загляните сюда чуть позже — QR появится автоматически.')));
    every(async () => { try { if ((await fetchMe()).qr) render(); } catch { /* */ } }, 10000);
    return;
  }
  const canvas = h('canvas', { 'aria-label': 'QR-код карты' });
  drawQr(canvas, me.qr.value, 320);
  // штрихкод для кассовых сканеров, которые не читают QR; переключатель запоминается
  let useBar = store.get('deya_code') === 'bar';
  const holder = h('div', { class: 'codebox' });
  const toggle = h('button', { class: 'btn ghost' });
  const paintCode = () => {
    holder.replaceChildren(useBar ? drawCode128(me.qr.value, { module: 2, height: 110 }) : canvas);
    toggle.textContent = useBar ? 'Показать QR-код' : 'Касса не читает QR? Показать штрихкод';
  };
  toggle.addEventListener('click', () => { useBar = !useBar; store.set('deya_code', useBar ? 'bar' : 'qr'); paintCode(); });
  paintCode();
  const banner = h('div');
  page(h('div', { class: 'content' },
    h('div', { class: 'topbar' }, logoEl(), close),
    h('h2', null, 'Покажите кассиру'), banner,
    h('div', { class: 'qrcard' }, holder,
      h('div', { class: 'who' }, me.user.name || 'Карта лояльности'),
      h('div', { class: 'num' }, me.card.number.replace(/(\d{4})(?=\d)/g, '$1 '))),
    toggle,
    h('p', { class: 'lead', style: 'text-align:center;margin-top:6px' }, 'Не считывается? Кассир может ввести номер карты вручную.')));
  try { await navigator.wakeLock?.request('screen'); } catch { /* не критично */ }
  every(async () => {
    try {
      const m = await fetchMe();
      banner.replaceChildren(...pendingBanner(m));
      if (m.last && m.last.id !== startId) { state.justNow = m.last; state.balanceNow = m.balance; go('success'); }
    } catch { /* сеть моргнула — следующий опрос */ }
  }, 2500);
}
function viewSuccess() {
  const e = state.justNow; if (!e) return go('home');
  const plus = e.points >= 0;
  const chips = [h('span', { class: 'chip' }, e.point_name)];
  if (e.type === 'ACCRUAL') { chips.push(h('span', { class: 'chip' }, `чек ${rub(e.base_kop)} ₽`)); if (e.pct_bp) chips.push(h('span', { class: 'chip' }, `${pctText(e.pct_bp / 100)} от чека`)); }
  page(h('div', { class: 'content success' },
    h('div', { class: 'badge' }, svg('<path d="M5 12.5l4.5 4.5L19 7"/>', 48, '#fff', 3)),
    h('div', { class: 'big' }, (plus ? '+' : '−') + fmt(Math.abs(e.points))),
    h('div', { style: 'font-weight:700;font-size:17px;margin-top:4px' }, e.type === 'REDEEM' ? 'баллов списано' : plus ? 'баллов начислено' : 'баллов отменено'),
    h('div', { class: 'chips' }, chips),
    h('div', { class: 'lead', style: 'margin-bottom:20px' }, `Теперь у вас ${fmt(state.balanceNow)} ${plural(state.balanceNow, 'балл', 'балла', 'баллов')}`),
    h('button', { class: 'btn green', onclick: () => { state.justNow = null; go('home'); } }, 'Отлично')));
}

/* ---------- как тратить ---------- */
const PLACES = {
  cinema: { title: 'Кинотеатр', label: 'Скидка на билеты', img: '/assets/cinema.jpg', x: 'X%' },
  bowling: { title: 'Боулинг', label: 'Скидка на бронь до', img: '/assets/bowling.jpg', x: 'Y%' },
};
async function viewSpend() {
  const pts = await fetchPoints();
  const list = pts.points.filter((p) => PLACES[p.id]);
  const track = h('div', { class: 'car-track' }, list.map((p) => {
    const m = PLACES[p.id];
    return h('div', { class: 'place' }, h('img', { src: m.img, alt: m.title }), h('span', { class: 'nm' }, m.title),
      h('div', { class: 'off' }, h('small', null, p.redeemPct > 0 ? m.label : 'Скидка баллами'), h('b', null, p.redeemPct > 0 ? pctText(p.redeemPct) : 'Скоро')));
  }));
  const dots = h('div', { class: 'dots' }, list.map((_, i) => h('i', { class: i === 0 ? 'on' : '' })));
  const slide = (dir) => track.scrollBy({ left: dir * (track.firstChild?.offsetWidth + 12 || 250), behavior: 'smooth' });
  track.addEventListener('scroll', () => {
    const w = (track.firstChild?.offsetWidth || 1) + 12, i = Math.round(track.scrollLeft / w);
    [...dots.children].forEach((d, k) => d.classList.toggle('on', k === i));
  });
  page(h('div', { class: 'content' },
    h('div', { class: 'topbar' }, h('button', { class: 'back', 'aria-label': 'Назад', onclick: () => go('home') }, '←'), logoEl('mini')),
    h('h2', null, 'Где можно потратить баллы'),
    list.length ? [h('div', { class: 'car' }, h('button', { class: 'nav l', 'aria-label': 'Назад', onclick: () => slide(-1) }, '‹'), h('button', { class: 'nav r', 'aria-label': 'Вперёд', onclick: () => slide(1) }, '›'), track), dots]
      : h('p', { class: 'lead' }, 'Скоро здесь появятся места, где можно платить баллами')));
}

/* ---------- история ---------- */
async function viewHistory() {
  const first = await api('GET', '/api/me/history?limit=50', { token: state.token });
  let items = first.items;
  const box = h('div');
  const more = h('button', { class: 'btn ghost', onclick: async () => {
    const r = await api('GET', `/api/me/history?limit=50&before=${items.at(-1).id}`, { token: state.token });
    items = items.concat(r.items); paint(r.items.length === 50);
  } }, 'Показать ещё');
  const monthName = new Date().toLocaleDateString('ru-RU', { month: 'long' });
  const ofMonth = (d) => d.getMonth() === new Date().getMonth() && d.getFullYear() === new Date().getFullYear();
  const totalEl = h('b');
  function paint(hasMore) {
    const m = items.filter((e) => e.type === 'ACCRUAL' && ofMonth(new Date(e.created_at))).reduce((s, e) => s + e.points, 0);
    totalEl.textContent = '+' + fmt(m);
    box.replaceChildren();
    let last = '';
    for (const e of items) { const d = dayLabel(e.created_at); if (d !== last) { box.append(h('div', { class: 'day' }, d)); last = d; } box.append(entryItem(e)); }
    if (!items.length) box.append(h('div', { class: 'empty' }, 'Пока нет операций'));
    more.hidden = !hasMore;
  }
  page(h('div', { class: 'content' }, h('div', { class: 'topbar' }, h('h2', null, 'История'), logoEl('mini')),
    h('div', { class: 'total' }, h('span', { style: 'font-size:13px;color:var(--muted)' }, `За ${monthName} начислено`), totalEl), box, more), tabbar('history'));
  paint(items.length === 50);
}

/* ---------- профиль ---------- */
function switchRow(title, sub, on, save) {
  const box = h('input', { type: 'checkbox', class: 'switch', 'aria-label': title });
  box.checked = on;
  box.addEventListener('change', async () => { try { await save(box.checked); toast('Сохранено'); } catch (e) { box.checked = !box.checked; toast(e.message); } });
  return h('label', { class: 'row-set' }, h('span', null, title, h('small', null, sub)), box);
}
/** Смена номера: код приходит на новый номер. Профиль (ID), баллы и карты остаются. */
function phoneSheet() {
  const phone = h('input', { type: 'tel', inputmode: 'numeric', placeholder: 'Новый номер: 999 123-45-67', autocomplete: 'off' });
  const code = h('input', { type: 'text', inputmode: 'numeric', placeholder: 'Код из СМС', maxlength: 4, autocomplete: 'one-time-code' });
  const codeField = h('div', { class: 'field', hidden: true }, code);
  const err = h('div', { class: 'err' });
  const digits = () => '7' + formatPhoneInput(phone.value).digits;
  phone.addEventListener('input', () => { phone.value = formatPhoneInput(phone.value).text; });
  const btn = h('button', { class: 'btn' }, 'Получить код');
  btn.addEventListener('click', async () => {
    err.textContent = '';
    try {
      if (codeField.hidden) {
        await api('POST', '/api/me/phone/request', { token: state.token, body: { phone: digits() } });
        codeField.hidden = false; phone.disabled = true; btn.textContent = 'Подтвердить'; code.focus();
      } else {
        await api('POST', '/api/me/phone/confirm', { token: state.token, body: { phone: digits(), code: code.value.trim() } });
        m.remove(); toast('Номер изменён'); render();
      }
    } catch (e) { err.textContent = e.message; }
  });
  const m = h('div', { class: 'modal', onclick: (e) => { if (e.target === m) m.remove(); } }, h('div', { class: 'sheet' },
    h('h2', null, 'Сменить номер'), h('p', null, 'Пришлём код на новый номер. Ваш профиль, баллы и карты останутся прежними.'),
    h('div', { class: 'field', style: 'margin-bottom:8px' }, h('span', { class: 'cc' }, '+7'), phone), codeField, err, btn,
    h('p', { style: 'margin-top:10px;font-size:13px' }, 'Нет доступа к старому номеру или новый номер уже зарегистрирован — обратитесь в поддержку.'),
    h('button', { class: 'btn light', style: 'margin-top:8px', onclick: () => m.remove() }, 'Отмена')));
  document.body.append(m); phone.focus();
}

function bindSheet(current) {
  const num = h('input', { type: 'text', inputmode: 'numeric', placeholder: 'Номер с лицевой стороны', autocomplete: 'off' });
  const code = h('input', { type: 'text', inputmode: 'numeric', placeholder: 'Код активации (на обороте)', autocomplete: 'off', maxlength: 12 });
  const err = h('div', { class: 'err' });
  const m = h('div', { class: 'modal', onclick: (e) => { if (e.target === m) m.remove(); } }, h('div', { class: 'sheet' },
    h('h2', null, current ? 'Заменить пластиковую карту' : 'Привязать карту'),
    h('p', null, current ? `Сейчас привязана карта ****${current.slice(-4)}. После привязки новой старая будет заблокирована, баллы останутся на вашем счёте.`
      : 'Введите номер пластиковой карты ДЕЯ и код активации. Баллы, накопленные на карте, перейдут на ваш счёт.'),
    h('div', { class: 'field', style: 'margin-bottom:8px' }, num), h('div', { class: 'field' }, code), err,
    h('button', { class: 'btn', onclick: async () => {
      err.textContent = '';
      const body = { number: num.value.replace(/\s/g, ''), code: code.value.trim(), replace: !!current };
      try {
        let r;
        try { r = await api('POST', '/api/me/cards/bind', { token: state.token, body }); }
        catch (e) {
          // у клиента уже есть пластик: одна пластиковая карта на телефон, вторая — только заменой
          if (e.code !== 'physical_exists' || !confirm(e.message + ' Старая карта будет заблокирована.')) throw e;
          r = await api('POST', '/api/me/cards/bind', { token: state.token, body: { ...body, replace: true } });
        }
        m.remove(); toast(r.transferred ? `Карта привязана, перенесено ${fmt(r.transferred)} баллов` : 'Карта привязана'); render();
      } catch (e) { err.textContent = e.message; }
    } }, 'Привязать'),
    h('button', { class: 'btn light', style: 'margin-top:8px', onclick: () => m.remove() }, 'Отмена')));
  document.body.append(m); num.focus();
}
function sheet(title, ...body) {
  const m = h('div', { class: 'modal', onclick: (e) => { if (e.target === m) m.remove(); } }, h('div', { class: 'sheet' }, h('h2', null, title), body, h('button', { class: 'btn', onclick: () => m.remove() }, 'Понятно')));
  document.body.append(m);
}
async function viewProfile() {
  const [me, pts] = await Promise.all([fetchMe(), fetchPoints()]);
  const initial = (me.user.name || '★').trim()[0].toUpperCase();
  const nameInput = h('input', { type: 'text', maxlength: 60, placeholder: 'Как к вам обращаться', value: me.user.name || '', style: 'border:0;outline:0;font-size:15px;width:100%;background:transparent' });
  nameInput.addEventListener('change', async () => { try { await api('PATCH', '/api/me', { token: state.token, body: { name: nameInput.value } }); toast('Сохранено'); } catch (e) { toast(e.message); } });
  const earn = pts.earn.find((p) => p.accrualPct > 0);
  const hyper = pts.earn.find((p) => p.id === 'hypermarket');
  if (!state.legal) { try { state.legal = await api('GET', '/api/legal'); } catch { state.legal = { docs: {} }; } }
  const docs = state.legal.docs;
  page(h('div', { class: 'content' }, h('div', { class: 'topbar' }, h('h2', null, 'Профиль'), logoEl('mini')),
    h('div', { class: 'avatar' }, initial),
    h('div', { style: 'text-align:center;color:var(--muted);font-size:13px;margin-bottom:14px' }, me.user.phone, h('br'), `ID профиля ${me.user.profileId}`),
    h('div', { class: 'row-set static' }, h('span', { style: 'flex:1' }, h('small', null, 'Имя'), nameInput)),
    h('button', { class: 'row-set', onclick: () => phoneSheet() }, h('span', null, 'Номер телефона', h('small', null, me.user.phone + ' · баллы и карты сохранятся')), h('span', null, 'Сменить ›')),
    h('div', { class: 'row-set static' }, h('span', null, 'Карта в приложении', h('small', null, me.card && me.card.kind === 'virtual' ? me.card.number : 'выпускается…'))),
    me.physicalCards.map((n) => h('div', { class: 'row-set static' }, h('span', null, 'Пластиковая карта', h('small', null, n)))),
    h('button', { class: 'row-set', onclick: () => bindSheet(me.physicalCards[0]) }, me.physicalCards.length
      ? h('span', null, 'Заменить пластиковую карту', h('small', null, 'если карта утеряна или выдана новая'))
      : h('span', null, 'Привязать пластиковую карту', h('small', null, 'баллы с карты перейдут на ваш счёт')), h('span', null, '›')),
    switchRow('Списывать баллы в гипермаркете', hyper && hyper.redeemPct > 0 ? `до ${pctText(hyper.redeemPct)} чека, автоматически на кассе` : 'когда списание заработает, оно будет автоматическим',
      me.settings.autoRedeem, (v) => api('PATCH', '/api/me', { token: state.token, body: { autoRedeem: v } })),
    switchRow('Персональные предложения', 'рекламные рассылки, можно отключить в любой момент',
      me.settings.marketing, (v) => api('PATCH', '/api/me', { token: state.token, body: { marketing: v } })),
    h('button', { class: 'row-set', onclick: () => sheet('Как работают баллы',
      h('p', null, earn ? `За покупки в гипермаркете начисляется ${pctText(earn.accrualPct)} от суммы чека баллами.` : 'За покупки в гипермаркете начисляются баллы.'),
      h('p', null, 'Покажите QR из приложения на кассе до оплаты. Баллы не сгорают.'),
      h('p', null, 'Тратить баллы можно в кино и боулинге на 3 этаже' + (hyper && hyper.redeemPct > 0 ? `, а в гипермаркете — до ${pctText(hyper.redeemPct)} чека (если включено в профиле).` : '.')),
      h('p', null, docLink(docs.rules, 'Правила программы'), ' · ', docLink(docs.privacy, 'Политика конфиденциальности'))) }, h('span', null, 'Как работают баллы', h('small', null, 'правила программы')), h('span', null, '›')),
    h('div', { class: 'row-set static' }, h('span', null, 'Поддержка', h('small', null, 'вопросы по баллам, картам, смене номера')),
      h('span', { style: 'text-align:right;font-size:14px' }, h('a', { href: telHref(me.support.phone) }, me.support.phone), h('br'),
        h('a', { href: `mailto:${me.support.email}?subject=${encodeURIComponent('Карта ДЕЯ, профиль ' + me.user.profileId)}` }, 'написать на почту'))),
    h('button', { class: 'row-set', style: 'color:var(--danger)', onclick: async () => { await api('POST', '/api/auth/logout', { token: state.token }).catch(() => {}); state.token = null; store.del('deya_token'); go('login'); } }, h('span', null, 'Выйти')),
    h('button', { class: 'btn danger', onclick: () => {
      const m = h('div', { class: 'modal' }, h('div', { class: 'sheet' }, h('h2', null, 'Удалить аккаунт?'),
        h('p', null, 'Ваши данные будут стёрты, а накопленные баллы пропадут. Это нельзя отменить.'),
        h('button', { class: 'btn', style: 'background:var(--danger);margin-bottom:8px', onclick: async () => { await api('DELETE', '/api/me', { token: state.token }); state.token = null; store.del('deya_token'); m.remove(); go('login'); } }, 'Удалить навсегда'),
        h('button', { class: 'btn light', onclick: () => m.remove() }, 'Отмена')));
      document.body.append(m);
    } }, 'Удалить аккаунт')), tabbar('profile'));
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
render();
