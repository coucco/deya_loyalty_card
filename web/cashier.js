// Страница кассира: начисление / списание баллов вручную. Для точек без интеграции и для проверки.
import { $, h, store, fmt, api, pctText } from './lib.js';

const app = $('#app');
let key = store.get('deya_point_key') || '';
let client = null, info = null, mode = 'accrual', attemptKey = null;
const newKey = () => (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random());

function header(sub) { return h('div', { class: 'hdr' }, h('b', null, sub || 'Касса'), key ? h('a', { href: '#', style: 'color:#fff;font-size:13px', onclick: (e) => { e.preventDefault(); store.del('deya_point_key'); key = ''; client = null; draw(); } }, 'Сменить ключ') : ''); }
const post = (p, body) => api('POST', p, { body, token: key });

function drawKey() {
  const input = h('input', { type: 'password', placeholder: 'Ключ точки', autocomplete: 'off', style: 'border:0;outline:0;flex:1;font-size:17px;background:transparent' });
  const err = h('div', { class: 'err' });
  app.replaceChildren(header('Вход кассира'), h('div', { class: 'content' },
    h('p', { class: 'lead' }, 'Введите ключ вашей точки. Его выдаёт администратор.'), h('div', { class: 'field' }, input), err,
    h('button', { class: 'btn green', onclick: async () => {
      key = input.value.trim();
      try { await post('/api/v1/cashier/lookup', { card: '0' }); } catch (e) { if (e.status === 401) { err.textContent = 'Неверный ключ'; key = ''; return; } }
      store.set('deya_point_key', key); draw();
    } }, 'Войти')));
}

async function find(query) {
  const body = /^\d{13}$/.test(query) ? { card: query } : { phone: query };
  info = await post('/api/v1/cashier/lookup', body);
  client = body; attemptKey = newKey();
  mode = info.kind === 'spend' ? 'redeem' : 'accrual';
}

function draw() {
  if (!key) return drawKey();
  if (!client) return drawFind();
  drawOperation();
}

function drawFind(msg = '') {
  const q = h('input', { type: 'text', inputmode: 'numeric', placeholder: 'Номер карты или телефон', style: 'border:0;outline:0;flex:1;font-size:19px;background:transparent' });
  const err = h('div', { class: 'err' }, msg);
  const video = h('video', { playsinline: true, muted: true, hidden: true });
  let stream = null, stop = false;
  const done = async (value) => { stop = true; stream?.getTracks().forEach((t) => t.stop()); try { await find(value); draw(); } catch (e) { drawFind(e.message); } };
  const scanBtn = h('button', { class: 'btn green', onclick: async () => {
    if (!('BarcodeDetector' in window)) { err.textContent = 'Сканер не поддерживается в этом браузере — введите номер'; return; }
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } });
      video.srcObject = stream; video.hidden = false; await video.play();
      const det = new BarcodeDetector({ formats: ['qr_code'] });
      const loop = async () => { if (stop) return; try { const r = await det.detect(video); if (r[0]) return done(r[0].rawValue); } catch { /* кадр не готов */ } requestAnimationFrame(loop); };
      loop();
    } catch { err.textContent = 'Нет доступа к камере — введите номер'; }
  } }, 'Сканировать QR клиента');
  app.replaceChildren(header(), h('div', { class: 'content' },
    h('label', null, 'Клиент'), h('div', { class: 'field' }, q), err, video, scanBtn,
    h('button', { class: 'btn', onclick: () => q.value.trim() && done(q.value.trim().replace(/[^\d]/g, '')) }, 'Найти клиента')));
}

function drawOperation() {
  const total = h('input', { type: 'text', inputmode: 'decimal', placeholder: '0', style: 'border:0;outline:0;flex:1;font-size:28px;background:transparent;min-width:0' });
  const points = h('input', { type: 'text', inputmode: 'numeric', placeholder: '0', style: 'border:0;outline:0;flex:1;font-size:22px;background:transparent;min-width:0' });
  const preview = h('div', { class: 'preview' });
  const err = h('div', { class: 'err' });
  const act = h('button', { class: 'btn green' }, mode === 'accrual' ? 'Начислить' : 'Списать');
  const num = (v) => Number(String(v).replace(',', '.').replace(/\s/g, ''));
  const showPreview = async () => {
    err.textContent = ''; const t = num(total.value);
    if (!(t > 0)) { preview.replaceChildren(); act.disabled = true; return; }
    if (mode === 'accrual') {
      const pts = Math.round(t * info.accrualPct / 100);
      preview.replaceChildren(h('small', null, 'Клиенту начислится'), h('div', { class: 'n' }, fmt(pts) + ' баллов'), h('small', null, `${pctText(info.accrualPct)} от суммы чека`));
      act.disabled = pts <= 0 && info.accrualPct > 0 ? false : false;
    } else {
      try {
        const q = await post('/api/v1/redeem/quote', { ...client, checkTotal: t.toFixed(2) });
        points.value = String(q.maxPoints); act.disabled = q.maxPoints <= 0;
        preview.replaceChildren(h('small', null, 'Можно списать не больше'), h('div', { class: 'n' }, fmt(q.maxPoints) + ' баллов'), h('small', null, `доступно у клиента: ${fmt(q.available)}`));
      } catch (e) { err.textContent = e.message; }
    }
  };
  total.addEventListener('input', showPreview);
  act.disabled = true;
  act.addEventListener('click', async () => {
    act.disabled = true; err.textContent = '';
    try {
      const t = num(total.value).toFixed(2);
      if (mode === 'accrual') {
        const r = await post('/api/v1/cashier/accrual', { ...client, total: t, idempotencyKey: attemptKey });
        finish(`Начислено ${fmt(r.accrued)} баллов`, `Баланс клиента: ${fmt(r.balance)}`);
      } else {
        const hold = await post('/api/v1/redeem/hold', { ...client, checkTotal: t, points: Number(points.value), idempotencyKey: attemptKey });
        const c = await post(`/api/v1/redeem/${hold.holdId}/commit`, {});
        finish(`Списано ${fmt(hold.points)} баллов`, `Скидка ${hold.discount} ₽. Баланс клиента: ${fmt(c.balance)}`);
      }
    } catch (e) { err.textContent = e.message; act.disabled = false; }   // ключ попытки сохраняем: повтор не удвоит операцию
  });
  const seg = info.kind === 'both' ? h('div', { class: 'seg' }, [['accrual', 'Начисление'], ['redeem', 'Списание']].map(([m, t]) => h('button', { class: mode === m ? 'on' : '', onclick: () => { mode = m; attemptKey = newKey(); drawOperation(); } }, t))) : '';
  app.replaceChildren(header(info.pointName), h('div', { class: 'content' },
    h('div', { class: 'preview' }, h('div', { style: 'font-weight:700' }, info.name || 'Клиент'), h('small', null, `${info.phone} · на счёте ${fmt(info.balance)} баллов`)),
    seg, h('label', null, 'Сумма чека, ₽'), h('div', { class: 'field' }, total),
    mode === 'redeem' ? [h('label', null, 'Списать баллов'), h('div', { class: 'field' }, points)] : '',
    preview, err, act, h('button', { class: 'btn ghost', onclick: () => { client = null; draw(); } }, 'Другой клиент')));
}

function finish(title, sub) {
  app.replaceChildren(header(info.pointName), h('div', { class: 'content success' }, h('div', { class: 'big', style: 'font-size:30px' }, title), h('p', { class: 'lead' }, sub),
    h('button', { class: 'btn green', style: 'margin-top:20px', onclick: () => { client = null; draw(); } }, 'Следующий клиент')));
}
draw();
