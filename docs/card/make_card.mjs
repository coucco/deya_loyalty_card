// Макет пластиковой карты ДЕЯ: лицо и оборот в SVG (мм, с вылетами 2 мм).
// Запуск: node docs/card/make_card.mjs [номер карты]   → docs/card/card_front.svg, card_back.svg
// Штрихкод и QR - теми же генераторами, что и в приложении (web/barcode.js, web/qr.js), проверены на считывание.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { qrMatrix } from '../../web/qr.js';
import { code128Codes } from '../../web/barcode.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const NUMBER = process.argv[2] || '999100000000001';
const SITE = 'loyalty.tc-deya.ru';
const SUPPORT = 'support@tc-deya.ru';
const ADDRESS = 'г. Нальчик, ул. Кирова 320';

// Геометрия: ISO/IEC 7810 ID-1, 85,60 × 53,98 мм; вылет 2 мм; безопасная зона 3 мм от реза
const W = 85.6, H = 53.98, B = 2, SAFE = 3;
const CW = W + 2 * B, CH = H + 2 * B;
const ORANGE = '#EE741E', MARK = '#E04A27', WHITE = '#FFFFFF', STRIPE = '#2B2B2B';
const FONT = "Montserrat, 'Inter', 'Segoe UI', Arial, sans-serif";

const fmtNumber = (n) => n.replace(/^(\d{4})(\d{4})(\d{4})(\d+)$/, '$1 $2 $3 $4');

/** Фон из «!» в стиле брендбука (детерминированный, для оборота). */
function pattern() {
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const out = [];
  const step = 10.5;
  for (let row = -1; row < CH / step + 1; row++) {
    for (let col = -1; col < CW / step + 1; col++) {
      const x = col * step + (row % 2 ? step / 2 : 0) + (rnd() - 0.5) * 2.5;
      const y = row * step + (rnd() - 0.5) * 2.5;
      const a = Math.round(rnd() * 360);
      const s = 0.9 + rnd() * 0.3;
      // «!»: трапеция со скруглением + точка
      out.push(`<g transform="translate(${x.toFixed(2)} ${y.toFixed(2)}) rotate(${a}) scale(${s.toFixed(2)})" fill="${MARK}">`
        + '<path d="M-1.35 -5.4 L1.35 -5.4 L0.7 1.5 L-0.7 1.5 Z" stroke="' + MARK + '" stroke-width="0.7" stroke-linejoin="round"/>'
        + '<circle cx="0" cy="3.7" r="1.3"/></g>');
    }
  }
  return out.join('');
}

/** Code128 как набор прямоугольников. module - ширина модуля, мм. */
function barcode(x, y, module, height) {
  const src = fs.readFileSync(path.join(here, '../../web/barcode.js'), 'utf8');
  const P = eval(src.match(/const P = (\([\s\S]*?\)\.split\(' '\));/)[1]);   // таблица ширин из генератора приложения
  const widths = code128Codes(NUMBER).flatMap((c) => P[c].split('').map(Number));
  let cx = x; const rects = [];
  widths.forEach((w, i) => { if (i % 2 === 0) rects.push(`<rect x="${cx.toFixed(3)}" y="${y}" width="${(w * module).toFixed(3)}" height="${height}"/>`); cx += w * module; });
  return { svg: `<g fill="#000">${rects.join('')}</g>`, width: cx - x };
}

function qr(x, y, size) {
  const m = qrMatrix('https://' + SITE);
  const n = m.length, cell = size / n; const rects = [];
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (m[r][c]) rects.push(`<rect x="${(x + c * cell).toFixed(3)}" y="${(y + r * cell).toFixed(3)}" width="${(cell + 0.01).toFixed(3)}" height="${(cell + 0.01).toFixed(3)}"/>`);
  return `<g fill="#000">${rects.join('')}</g>`;
}

const head = (title) => `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${CW}mm" height="${CH}mm" viewBox="0 0 ${CW} ${CH}">
<title>${title}</title>`;
const guides = `<g id="guides" fill="none" stroke-width="0.12" stroke-dasharray="0.8 0.6">
  <rect x="${B}" y="${B}" width="${W}" height="${H}" rx="3.18" stroke="#00A0FF"/>
  <rect x="${B + SAFE}" y="${B + SAFE}" width="${W - 2 * SAFE}" height="${H - 2 * SAFE}" rx="1" stroke="#FF00C8"/>
</g>`;

// ---------- лицо ----------
const front = () => {
  const img = fs.readFileSync(path.join(here, 'brand_front_example.jpg')).toString('base64');
  return `${head('ДЕЯ: лицевая сторона')}
<rect width="${CW}" height="${CH}" fill="${ORANGE}"/>
<!-- фон и логотип из примера брендбука (в печать - векторный исходник дизайнера) -->
<image x="0" y="0" width="${CW}" height="${CH}" preserveAspectRatio="xMidYMid slice" xlink:href="data:image/jpeg;base64,${img}"/>
${guides}
</svg>`;
};

// ---------- оборот ----------
const back = () => {
  const stripeTop = B + 5.0, stripeH = 12.7;                // ISO/IEC 7811: полоса у верхнего края (точное положение - по шаблону типографии)
  const y0 = stripeTop + stripeH;
  const left = B + SAFE + 1.5;
  // штрихкод: X = 0,25 мм, высота 9 мм, тихие зоны 3 мм
  const bcX = left + 3, bcY = y0 + 11.2;
  const bc = barcode(bcX, bcY, 0.25, 9);
  const boxW = bc.width + 6, boxH = 9 + 2 + 3.6;
  const qrSize = 12.5, right = B + W - SAFE - 1, qrX = right - 1.2 - qrSize, qrY = y0 + 3.4;
  const t = (x, y, s, w, txt, anchor = 'start') => `<text x="${x.toFixed(2)}" y="${y.toFixed(2)}" font-family="${FONT}" font-weight="${w}" font-size="${s}" fill="${WHITE}" text-anchor="${anchor}">${txt}</text>`;
  const capY = qrY + qrSize + 1.2 + 2.8;
  return `${head('ДЕЯ: оборот')}
<rect width="${CW}" height="${CH}" fill="${ORANGE}"/>
<g id="pattern">${pattern()}</g>
<!-- магнитная полоса HiCo, 3 дорожки (дорожка 2 записана) -->
<rect id="magstripe" x="0" y="${stripeTop}" width="${CW}" height="${stripeH}" fill="${STRIPE}"/>
<!-- активация -->
${t(left, y0 + 4.6, 2.55, 700, 'Активируйте карту на кассе -')}
${t(left, y0 + 7.9, 2.55, 700, 'назовите кассиру номер телефона')}
<!-- штрихкод с номером -->
<rect x="${left}" y="${bcY - 1}" width="${boxW.toFixed(2)}" height="${boxH.toFixed(2)}" rx="0.8" fill="${WHITE}"/>
${bc.svg}
<text x="${(left + boxW / 2).toFixed(2)}" y="${(bcY + 9 + 2.6).toFixed(2)}" font-family="${FONT}" font-weight="600" font-size="2.3" letter-spacing="0.25" fill="#000" text-anchor="middle">${fmtNumber(NUMBER)}</text>
<!-- приложение: маленький QR и подпись под ним -->
<rect x="${(qrX - 1.2).toFixed(2)}" y="${(qrY - 1.2).toFixed(2)}" width="${(qrSize + 2.4).toFixed(2)}" height="${(qrSize + 2.4).toFixed(2)}" rx="0.8" fill="${WHITE}"/>
${qr(qrX, qrY, qrSize)}
${t(right, capY, 2.05, 700, SITE, 'end')}
${t(right, capY + 2.4, 1.7, 500, 'правила программы лояльности,', 'end')}
${t(right, capY + 4.6, 1.7, 500, 'баланс, история операций', 'end')}
<!-- правовая строка, поддержка, адрес -->
${t(left, B + H - SAFE - 2.6, 1.6, 500, 'Карта участника программы лояльности ТРЦ ДЕЯ. Правила - ' + SITE)}
${t(left, B + H - SAFE - 0.2, 1.6, 500, ADDRESS + '   ·   Поддержка: ' + SUPPORT)}
${guides}
</svg>`;
};

fs.writeFileSync(path.join(here, 'card_front.svg'), front());
fs.writeFileSync(path.join(here, 'card_back.svg'), back());
console.log('ok', NUMBER);
