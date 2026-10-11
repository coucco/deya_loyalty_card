// Горячая копия БД (без остановки сервера): node scripts/backup.mjs <файл БД> <куда сохранить>
import { DatabaseSync, backup } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const [src, dst] = process.argv.slice(2);
if (!src || !dst) { console.error('Использование: node scripts/backup.mjs data/deya.db backups/deya-2026-10-09.db'); process.exit(2); }
fs.mkdirSync(path.dirname(path.resolve(dst)), { recursive: true });
const db = new DatabaseSync(src, { readOnly: true });
await backup(db, dst);
db.close();
const chk = new DatabaseSync(dst, { readOnly: true });
const ok = chk.prepare('PRAGMA integrity_check').get().integrity_check;
chk.close();
if (ok !== 'ok') { console.error('Копия повреждена:', ok); process.exit(1); }
console.log(`Копия готова и проверена: ${dst}`);
