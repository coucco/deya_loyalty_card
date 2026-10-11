import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;');
  db.exec(fs.readFileSync(path.join(here, 'schema.sql'), 'utf8'));
  return db;
}

const depth = new WeakMap();
/** Транзакция с немедленной блокировкой записи (BEGIN IMMEDIATE); вложенные вызовы — через SAVEPOINT. */
export function tx(db, fn) {
  const d = depth.get(db) || 0;
  const sp = 'sp' + d;
  db.exec(d === 0 ? 'BEGIN IMMEDIATE' : `SAVEPOINT ${sp}`);
  depth.set(db, d + 1);
  try {
    const r = fn();
    depth.set(db, d);
    db.exec(d === 0 ? 'COMMIT' : `RELEASE ${sp}`);
    return r;
  } catch (e) {
    depth.set(db, d);
    try { db.exec(d === 0 ? 'ROLLBACK' : `ROLLBACK TO ${sp}; RELEASE ${sp}`); } catch { /* уже откатилось */ }
    throw e;
  }
}

export const one = (db, sql, ...p) => db.prepare(sql).get(...p);
export const all = (db, sql, ...p) => db.prepare(sql).all(...p);
export const run = (db, sql, ...p) => db.prepare(sql).run(...p);
