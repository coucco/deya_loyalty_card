// Штрихкод Code 128 (SVG) с номером карты: для кассовых сканеров, которые не читают QR (1D-лазерные).
// Только цифры чётной длины кодируются набором C (компактнее), остальное — набором B.
const P = ('212222 222122 222221 121223 121322 131222 122213 122312 132212 221213 221312 231212 112232 122132 122231 113222 123122 123221 223211 221132 '
  + '221231 213212 223112 312131 311222 321122 321221 312212 322112 322211 212123 212321 232121 111323 131123 131321 112313 132113 132311 211313 '
  + '231113 231311 112133 112331 132131 113123 113321 133121 313121 211331 231131 213113 213311 213131 311123 311321 331121 312113 312311 332111 '
  + '314111 221411 431111 111224 111422 121124 121421 141122 141221 112214 112412 122114 122411 142112 142211 241211 221114 413111 241112 134111 '
  + '111242 121142 121241 114212 124112 124211 411212 421112 421211 212141 214121 412121 111143 111341 131141 114113 114311 411113 411311 113141 '
  + '114131 311141 411131 211412 211214 211232 2331112').split(' ');
const START_B = 104, START_C = 105, STOP = 106;

export function code128Codes(text) {
  const s = String(text);
  const codes = [];
  if (/^\d+$/.test(s) && s.length % 2 === 0) {
    codes.push(START_C);
    for (let i = 0; i < s.length; i += 2) codes.push(Number(s.slice(i, i + 2)));
  } else {
    codes.push(START_B);
    for (const ch of s) { const c = ch.charCodeAt(0) - 32; if (c < 0 || c > 95) throw new Error('Code128B: недопустимый символ'); codes.push(c); }
  }
  let sum = codes[0];
  for (let i = 1; i < codes.length; i++) sum += codes[i] * i;
  codes.push(sum % 103, STOP);
  return codes;
}

/** SVG-элемент штрихкода. module — ширина узкой полосы в px (тихие зоны по 10 модулей). */
export function drawCode128(text, { module = 2, height = 70 } = {}) {
  const widths = code128Codes(text).flatMap((c) => P[c].split('').map(Number));
  const total = widths.reduce((a, b) => a + b, 0) + 20;
  const ns = 'http://www.w3.org/2000/svg';
  const svgEl = document.createElementNS(ns, 'svg');
  svgEl.setAttribute('viewBox', `0 0 ${total} 1`);
  svgEl.setAttribute('preserveAspectRatio', 'none');
  svgEl.setAttribute('width', String(total * module));
  svgEl.setAttribute('height', String(height));
  svgEl.setAttribute('role', 'img');
  svgEl.style.background = '#fff';
  svgEl.style.maxWidth = '100%';
  let x = 10;
  widths.forEach((w, i) => {
    if (i % 2 === 0) {
      const r = document.createElementNS(ns, 'rect');
      r.setAttribute('x', String(x)); r.setAttribute('y', '0'); r.setAttribute('width', String(w)); r.setAttribute('height', '1');
      svgEl.append(r);
    }
    x += w;
  });
  return svgEl;
}
