// Файл персонализации для типографии: node docs/card/numbers.mjs <тираж> [первый номер] → docs/card/numbers.csv
// Колонки: n, number (15 цифр), track2 (;номер?), barcode (Code128), printed (4-4-4-3). Разделитель - запятая.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const count = Number(process.argv[2]);
const first = BigInt(process.argv[3] || '999100000000001');
if (!Number.isInteger(count) || count <= 0) { console.error('Укажите тираж: node docs/card/numbers.mjs 500'); process.exit(1); }

const rows = ['n,number,track2,barcode,printed'];
for (let i = 0; i < count; i++) {
  const num = String(first + BigInt(i));
  if (!/^\d{15}$/.test(num)) throw new Error('номер не 15 цифр: ' + num);
  const printed = num.replace(/^(\d{4})(\d{4})(\d{4})(\d{3})$/, '$1 $2 $3 $4');
  rows.push(`${i + 1},${num},";${num}?",${num},"${printed}"`);
}
const file = path.join(path.dirname(fileURLToPath(import.meta.url)), 'numbers.csv');
fs.writeFileSync(file, rows.join('\n') + '\n');
console.log(`${count} карт: ${first} - ${first + BigInt(count - 1)} → ${file}`);
