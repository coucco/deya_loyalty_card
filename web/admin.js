// Минимальная админка: проценты по точкам, ключи, настройки, пул карт Set10, метрики, поиск клиентов, корректировка, выгрузка карт.
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
    const [pts, stats, audit, pool, mx] = await Promise.all([call('GET', '/api/admin/points'), call('GET', '/api/admin/stats'), call('GET', '/api/admin/audit'),
      call('GET', '/api/admin/cards/pool'), call('GET', '/api/admin/metrics?days=30')]);
    draw(pts, stats, audit.items, pool, mx);
  } catch (e) { if (e.status === 401) { token = ''; store.del('deya_admin'); login('Неверный токен'); } else app.replaceChildren(h('p', null, e.message)); }
}

const POOL_NAMES = { virtual: 'виртуальные (QR)', physical: 'пластиковые' };
const STATUS_NAMES = { free: 'свободны', active: 'выданы', closed: 'закрыты', blocked: 'заблокированы' };
function poolSection(pool) {
  const kind = h('select', null, h('option', { value: 'virtual' }, 'виртуальные (для QR в приложении)'), h('option', { value: 'physical' }, 'пластиковые'));
  const text = h('textarea', { rows: 4, placeholder: 'По одному номеру в строке. Для пластиковых можно «номер;код активации»', style: 'width:100%;max-width:520px' });
  const from = h('input', { type: 'text', placeholder: 'диапазон: с', style: 'width:160px' }), to = h('input', { type: 'text', placeholder: 'по', style: 'width:160px' });
  const out = h('div');
  const send = async (body) => {
    try { const r = await call('POST', '/api/admin/cards/import', { kind: kind.value, ...body }); out.textContent = `Добавлено: ${r.added}, уже были: ${r.skipped}` + (r.invalid.length ? `, неверные: ${r.invalid.join(', ')}` : '')
      + (r.conflicts.length ? `. ОШИБКА: уже загружены с другим типом (диапазоны виртуальных и пластиковых не должны пересекаться): ${r.conflicts.slice(0, 10).join(', ')}` : '')
      + (r.withoutCode ? `. Внимание: ${r.withoutCode} пластиковых без кода активации — их сможет привязать любой, кто знает номер` : ''); setTimeout(load, 1500); }
    catch (e) { out.textContent = e.message; }
  };
  const blk = h('input', { type: 'text', placeholder: 'номер карты (утеря)', style: 'width:200px' }), bout = h('div');
  const block = async (on) => {
    try { const r = await call('POST', `/api/admin/cards/${encodeURIComponent(blk.value.trim())}/block`, { blocked: on, reason: on ? prompt('Причина?') || '' : '' }); bout.textContent = `Карта ${r.card}: ${r.status === 'blocked' ? 'заблокирована' : 'активна'}`; }
    catch (e) { bout.textContent = e.message; }
  };
  const free = pool.pool.find((p) => p.kind === 'virtual' && p.status === 'free')?.n || 0;
  return h('section', null, h('h3', null, 'Пул карт Set10'),
    h('p', { style: 'color:var(--muted);font-size:13px' }, `Режим выдачи: ${pool.mode === 'pool' ? 'из пула (номера должны быть заведены в Set10 как карты нужного типа)' : 'генерация номеров (только для пробы без Set10)'}.`),
    pool.mode === 'pool' && free < 20 ? h('div', { class: 'err' }, `Свободных виртуальных карт: ${free}. Загрузите новые номера, иначе новые клиенты останутся без карты.`) : '',
    h('table', null, h('tr', null, ['Тип', 'Статус', 'Карт'].map((x) => h('th', null, x))),
      pool.pool.map((p) => h('tr', null, h('td', null, POOL_NAMES[p.kind] || p.kind), h('td', null, STATUS_NAMES[p.status] || p.status), h('td', null, fmt(p.n))))),
    h('p', { style: 'margin-top:10px' }, kind), h('p', null, text), h('p', null, h('button', { class: 'sbtn o', onclick: () => send({ text: text.value }) }, 'Загрузить список')),
    h('p', null, from, ' ', to, ' ', h('button', { class: 'sbtn', onclick: () => send({ range: { from: from.value.trim(), to: to.value.trim() } }) }, 'Загрузить диапазон')), out,
    h('p', { style: 'margin-top:14px' }, blk, ' ', h('button', { class: 'sbtn', onclick: () => block(true) }, 'Заблокировать карту'), ' ',
      h('button', { class: 'sbtn', onclick: () => block(false) }, 'Разблокировать')), bout);
}
function metricsSection(mx) {
  const t = mx.totals;
  return h('section', null, h('h3', null, 'Метрики за 30 дней'),
    h('div', { class: 'stats' }, [['Активных за 30 дней', t.active30], ['Новых покупателей', t.newBuyers], ['Повторная покупка, %', t.repeatRatePct],
      ['Обязательства, баллов', t.liabilityPoints], ['Согласий на рассылки', t.marketingConsents], ['Списание в гипере включено', t.autoRedeemOn], ['Пластик без привязки', t.unboundPhysicalCards]]
      .map(([n, v]) => h('div', { class: 'stat' }, h('b', null, fmt(v)), n))),
    h('table', { style: 'margin-top:10px' }, h('tr', null, ['День', 'Регистрации', 'Чеков', 'Покупателей', 'Продажи, ₽', 'Начислено', 'Списано'].map((x) => h('th', null, x))),
      mx.daily.slice(0, 31).map((d) => h('tr', null, [d.day, d.registrations, d.receipts, d.buyers, Math.round(d.salesKop / 100), d.accrued, d.redeemed].map((v, i) => h('td', null, i ? fmt(v) : v))))));
}

function draw(pts, stats, audit, pool, mx) {
  const keyBox = h('div');
  const rows = pts.points.map((p) => {
    const a = h('input', { type: 'number', step: '0.01', min: 0, max: 100, value: p.accrualPct });
    const r = h('input', { type: 'number', step: '0.01', min: 0, max: 100, value: p.redeemPct });
    const act = h('input', { type: 'checkbox' }); act.checked = p.active;
    const conf = h('input', { type: 'checkbox', title: 'Списание подтверждается кодом из приложения клиента' }); conf.checked = p.confirmRedeem;
    return h('tr', null, h('td', null, h('b', null, p.name), h('div', { style: 'color:var(--muted);font-size:12px' }, p.id + ' · ' + { earn: 'начисляет', spend: 'списывает', both: 'и то и другое' }[p.kind])),
      h('td', null, a), h('td', null, r), h('td', null, conf), h('td', null, act), h('td', null, p.hasKey ? 'есть' : 'нет'),
      h('td', null,
        h('button', { class: 'sbtn o', onclick: async () => { try { await call('PATCH', '/api/admin/points/' + p.id, { accrualPct: Number(a.value), redeemPct: Number(r.value), active: act.checked, confirmRedeem: conf.checked }); load(); } catch (e) { alert(e.message); } } }, 'Сохранить'),
        h('button', { class: 'sbtn', onclick: async () => { if (!confirm('Выпустить новый ключ? Старый перестанет работать.')) return; const k = await call('POST', `/api/admin/points/${p.id}/rotate-key`); keyBox.replaceChildren(h('div', { class: 'keybox' }, `Ключ точки «${p.name}» (показывается один раз): `, h('b', null, k.apiKey))); } }, 'Новый ключ')));
  });
  const nid = h('input', { type: 'text', placeholder: 'id (latin)' }), nname = h('input', { type: 'text', placeholder: 'Название' });
  const nkind = h('select', null, h('option', { value: 'spend' }, 'списывает'), h('option', { value: 'earn' }, 'начисляет'), h('option', { value: 'both' }, 'оба'));
  const st = pts.settings;
  const rpp = h('input', { type: 'number', step: '0.01', min: 0.01, value: st.rubPerPoint });
  const rnd = h('select', null, h('option', { value: 'half_up' }, 'до ближайшего (half-up)'), h('option', { value: 'floor' }, 'вниз'));
  rnd.value = st.rounding;
  const accD = h('input', { type: 'checkbox' }); accD.checked = st.accrueOnDiscounted;
  const redD = h('input', { type: 'checkbox' }); redD.checked = st.redeemOnDiscounted;
  const p3 = h('input', { type: 'text', value: st.price3ActionIds.join(', '), placeholder: 'пусто = любая скидка Set10', style: 'width:300px' });
  const q = h('input', { type: 'text', placeholder: 'телефон или карта' });
  const found = h('div');
  const search = async () => {
    const r = await call('GET', '/api/admin/users?q=' + encodeURIComponent(q.value));
    found.replaceChildren(h('table', null, h('tr', null, ['Телефон', 'Имя', 'Карта', 'Баллы', 'В резерве', ''].map((x) => h('th', null, x))),
      r.users.map((u) => h('tr', null, h('td', null, u.stub ? 'пластик без привязки' : u.phone), h('td', null, u.name || ''), h('td', null, u.card), h('td', null, fmt(u.balance)), h('td', null, fmt(u.held)),
        h('td', null, h('button', { class: 'sbtn', onclick: async () => {
          const v = prompt('На сколько изменить баллы? (например 100 или -50)'); if (!v) return;
          const why = prompt('Причина?') || '';
          try { await call('POST', `/api/admin/users/${u.id}/adjust`, { points: Number(v), reason: why }); search(); } catch (e) { alert(e.message); }
        } }, 'Корректировка'))))));
  };
  app.replaceChildren(
    h('h1', null, 'Дея — администрирование'),
    h('section', null, h('h3', null, 'Сводка'), h('div', { class: 'stats' },
      [['Клиентов', stats.users], ['Свободных карт в пуле', stats.freeCards], ['Баллов на счетах', stats.totalBalance], ['Начислено сегодня', stats.accruedToday], ['Списано сегодня', stats.redeemedToday], ['Расхождений журнала', stats.mismatches]]
        .map(([t, v]) => h('div', { class: 'stat' }, h('b', null, fmt(v)), t)))),
    h('section', null, h('h3', null, 'Точки и проценты'),
      h('table', null, h('tr', null, ['Точка', 'Начисление, %', 'Макс. оплата баллами, % чека', 'Код подтверждения', 'Активна', 'Ключ', ''].map((x) => h('th', null, x))), rows), keyBox,
      h('p', { style: 'margin-top:12px' }, nid, ' ', nname, ' ', nkind, ' ', h('button', { class: 'sbtn', onclick: async () => { try { await call('POST', '/api/admin/points', { id: nid.value.trim(), name: nname.value.trim(), kind: nkind.value }); load(); } catch (e) { alert(e.message); } } }, 'Добавить точку'))),
    h('section', null, h('h3', null, 'Правила расчёта'),
      h('p', null, '1 балл = ', rpp, ' ₽ · округление: ', rnd),
      h('p', null, h('label', null, accD, ' начислять баллы на товары со скидкой Set10 («цена 3»)')),
      h('p', null, h('label', null, redD, ' разрешать оплату баллами товаров со скидкой Set10 («цена 3»)')),
      h('p', null, 'Акции Set10 «цена 3» (id или guid через запятую): ', p3),
      h('p', null, h('button', { class: 'sbtn o', onclick: async () => { try { await call('PUT', '/api/admin/settings', { rub_per_point: rpp.value, rounding: rnd.value,
        accrue_on_discounted: accD.checked, redeem_on_discounted: redD.checked, price3_action_ids: p3.value.split(',').map((x) => x.trim()).filter(Boolean).join(',') }); load(); } catch (e) { alert(e.message); } } }, 'Сохранить'))),
    poolSection(pool), metricsSection(mx),
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
