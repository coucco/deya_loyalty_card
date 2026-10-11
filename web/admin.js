// Минимальная админка: проценты по точкам, ключи, настройки, поиск клиентов, корректировка, выгрузка карт.
import { $, h, store, fmt, api } from './lib.js';

const app = $('#app');
let token = store.get('deya_admin') || '';
const call = (m, p, body) => api(m, p, { body, token });

function login(msg = '') {
  const t = h('input', { type: 'password', placeholder: 'Токен администратора', style: 'max-width:300px' });
  app.replaceChildren(h('h1', null, 'Администрирование'), h('section', null,
    h('p', null, 'Токен задаётся переменной ADMIN_TOKEN на сервере.'), h('p', { style: 'margin:10px 0' }, t),
    h('button', { class: 'sbtn o', onclick: () => { token = t.value.trim(); store.set('deya_admin', token); load(); } }, 'Войти'),
    h('div', { class: 'err' }, msg)));
}

async function load() {
  try {
    const [pts, stats, audit] = await Promise.all([call('GET', '/api/admin/points'), call('GET', '/api/admin/stats'), call('GET', '/api/admin/audit')]);
    draw(pts, stats, audit.items);
  } catch (e) { if (e.status === 401) { token = ''; store.del('deya_admin'); login('Неверный токен'); } else app.replaceChildren(h('p', null, e.message)); }
}

function draw(pts, stats, audit) {
  const keyBox = h('div');
  const rows = pts.points.map((p) => {
    const a = h('input', { type: 'number', step: '0.01', min: 0, max: 100, value: p.accrualPct });
    const r = h('input', { type: 'number', step: '0.01', min: 0, max: 100, value: p.redeemPct });
    const act = h('input', { type: 'checkbox' }); act.checked = p.active;
    return h('tr', null, h('td', null, h('b', null, p.name), h('div', { style: 'color:var(--muted);font-size:12px' }, p.id + ' · ' + { earn: 'начисляет', spend: 'списывает', both: 'и то и другое' }[p.kind])),
      h('td', null, a), h('td', null, r), h('td', null, act), h('td', null, p.hasKey ? 'есть' : 'нет'),
      h('td', null,
        h('button', { class: 'sbtn o', onclick: async () => { try { await call('PATCH', '/api/admin/points/' + p.id, { accrualPct: Number(a.value), redeemPct: Number(r.value), active: act.checked }); load(); } catch (e) { alert(e.message); } } }, 'Сохранить'),
        h('button', { class: 'sbtn', onclick: async () => { if (!confirm('Выпустить новый ключ? Старый перестанет работать.')) return; const k = await call('POST', `/api/admin/points/${p.id}/rotate-key`); keyBox.replaceChildren(h('div', { class: 'keybox' }, `Ключ точки «${p.name}» (показывается один раз): `, h('b', null, k.apiKey))); } }, 'Новый ключ')));
  });
  const nid = h('input', { type: 'text', placeholder: 'id (latin)' }), nname = h('input', { type: 'text', placeholder: 'Название' });
  const nkind = h('select', null, h('option', { value: 'spend' }, 'списывает'), h('option', { value: 'earn' }, 'начисляет'), h('option', { value: 'both' }, 'оба'));
  const st = pts.settings;
  const rpp = h('input', { type: 'number', step: '0.01', min: 0.01, value: st.rubPerPoint });
  const rnd = h('select', null, h('option', { value: 'half_up' }, 'до ближайшего (half-up)'), h('option', { value: 'floor' }, 'вниз'));
  rnd.value = st.rounding;
  const q = h('input', { type: 'text', placeholder: 'телефон или карта' });
  const found = h('div');
  const search = async () => {
    const r = await call('GET', '/api/admin/users?q=' + encodeURIComponent(q.value));
    found.replaceChildren(h('table', null, h('tr', null, ['Телефон', 'Имя', 'Карта', 'Баллы', 'В резерве', ''].map((x) => h('th', null, x))),
      r.users.map((u) => h('tr', null, h('td', null, u.phone), h('td', null, u.name || ''), h('td', null, u.card), h('td', null, fmt(u.balance)), h('td', null, fmt(u.held)),
        h('td', null, h('button', { class: 'sbtn', onclick: async () => {
          const v = prompt('На сколько изменить баллы? (например 100 или -50)'); if (!v) return;
          const why = prompt('Причина?') || '';
          try { await call('POST', `/api/admin/users/${u.id}/adjust`, { points: Number(v), reason: why }); search(); } catch (e) { alert(e.message); }
        } }, 'Корректировка'))))));
  };
  app.replaceChildren(
    h('h1', null, 'Дея — администрирование'),
    h('section', null, h('h3', null, 'Сводка'), h('div', { class: 'stats' },
      [['Клиентов', stats.users], ['Баллов на счетах', stats.totalBalance], ['Начислено сегодня', stats.accruedToday], ['Списано сегодня', stats.redeemedToday], ['Расхождений журнала', stats.mismatches]]
        .map(([t, v]) => h('div', { class: 'stat' }, h('b', null, fmt(v)), t)))),
    h('section', null, h('h3', null, 'Точки и проценты'),
      h('table', null, h('tr', null, ['Точка', 'Начисление, %', 'Макс. оплата баллами, % чека', 'Активна', 'Ключ', ''].map((x) => h('th', null, x))), rows), keyBox,
      h('p', { style: 'margin-top:12px' }, nid, ' ', nname, ' ', nkind, ' ', h('button', { class: 'sbtn', onclick: async () => { try { await call('POST', '/api/admin/points', { id: nid.value.trim(), name: nname.value.trim(), kind: nkind.value }); load(); } catch (e) { alert(e.message); } } }, 'Добавить точку'))),
    h('section', null, h('h3', null, 'Правила расчёта'),
      h('p', null, '1 балл = ', rpp, ' ₽ · округление: ', rnd, ' ', h('button', { class: 'sbtn o', onclick: async () => { try { await call('PUT', '/api/admin/settings', { rub_per_point: rpp.value, rounding: rnd.value }); load(); } catch (e) { alert(e.message); } } }, 'Сохранить'))),
    h('section', null, h('h3', null, 'Клиенты'), h('p', null, q, ' ', h('button', { class: 'sbtn o', onclick: search }, 'Найти'), ' ',
      h('button', { class: 'sbtn', onclick: async () => {
        const r = await fetch('/api/admin/cards.csv', { headers: { Authorization: 'Bearer ' + token } });
        const a = h('a', { href: URL.createObjectURL(await r.blob()), download: 'cards.csv' }); a.click();
      } }, 'Выгрузить карты (CSV)')), found),
    h('section', null, h('h3', null, 'Журнал действий администратора'),
      h('table', null, audit.slice(0, 15).map((a) => h('tr', null, h('td', null, a.created_at.replace('T', ' ').slice(0, 19)), h('td', null, a.action), h('td', { style: 'color:var(--muted);font-size:12px' }, (a.detail || '').slice(0, 120)))))));
  search();
}
token ? load() : login();
