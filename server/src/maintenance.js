/**
 * Обслуживание: ежедневная копия БД с проверкой целостности и ротацией, очистка старого журнала действий.
 * Копия делается «на горячую» (VACUUM INTO), сервер не останавливается. Копии на том же сервере защищают
 * от ошибок и порчи файла, но не от потери сервера: папку BACKUP_DIR нужно дополнительно увозить (см. DEPLOY.md).
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { run } from './db.js';

export function backupNow(db, dir) {
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const file = path.join(dir, `deya-${stamp}.db`);
  db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  const chk = new DatabaseSync(file, { readOnly: true });
  const ok = chk.prepare('PRAGMA integrity_check').get().integrity_check;
  chk.close();
  if (ok !== 'ok') { fs.rmSync(file, { force: true }); throw new Error('копия БД повреждена: ' + ok); }
  return file;
}

export function pruneBackups(dir, keepDays) {
  const limit = Date.now() - keepDays * 86400_000;
  for (const f of fs.readdirSync(dir)) {
    if (/^deya-.*\.db$/.test(f) && fs.statSync(path.join(dir, f)).mtimeMs < limit) fs.rmSync(path.join(dir, f), { force: true });
  }
}

export function scheduleBackups(db, cfg, log) {
  if (!cfg.backupDir) return { stop() {} };
  const job = () => {
    try { const f = backupNow(db, cfg.backupDir); pruneBackups(cfg.backupDir, cfg.backupKeepDays); log.log(`резервная копия: ${f}`); }
    catch (e) { log.error('РЕЗЕРВНАЯ КОПИЯ НЕ СДЕЛАНА', e); }
  };
  const first = setTimeout(job, 60_000); first.unref();          // через минуту после старта, затем раз в сутки
  const t = setInterval(job, 86400_000); t.unref();
  return { stop() { clearTimeout(first); clearInterval(t); } };
}

/** Журнал действий хранится AUDIT_KEEP_DAYS (по умолчанию 3 года), журнал баллов и согласий — бессрочно. */
export function pruneAudit(db, cfg) {
  run(db, 'DELETE FROM audit WHERE created_at < ?', new Date(Date.now() - cfg.auditKeepDays * 86400_000).toISOString());
}
