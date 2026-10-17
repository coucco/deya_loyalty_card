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
  migrate(db);
  return db;
}

/** Колонки, добавленные после первой версии схемы: в старых БД их создаём через ALTER TABLE. */
const ADDED_COLUMNS = {
  users: ['stub INTEGER NOT NULL DEFAULT 0', 'auto_redeem INTEGER NOT NULL DEFAULT 0', 'marketing_at TEXT'],
  cards: ["kind TEXT NOT NULL DEFAULT 'virtual'", 'activation_hash TEXT', 'bound_at TEXT'],
  points: ['confirm_redeem INTEGER NOT NULL DEFAULT 0'],
  holds: ['ref TEXT', 'confirm_code TEXT', 'confirm_attempts INTEGER NOT NULL DEFAULT 0'],
};

function migrate(db) {
  for (const [table, cols] of Object.entries(ADDED_COLUMNS)) {
    const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    for (const col of cols) if (!have.has(col.split(' ')[0])) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col}`);
  }
  db.exec(`
    CREATE INDEX IF NOT EXISTS cards_pool ON cards(status, kind);
    CREATE INDEX IF NOT EXISTS holds_ref ON holds(point_id, ref);
    -- журнал баллов только добавляется: правка и удаление записей запрещены на уровне БД
    CREATE TRIGGER IF NOT EXISTS ledger_no_update BEFORE UPDATE ON ledger BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS ledger_no_delete BEFORE DELETE ON ledger BEGIN SELECT RAISE(ABORT, 'ledger is append-only'); END;
    CREATE TRIGGER IF NOT EXISTS consents_no_update BEFORE UPDATE ON consents BEGIN SELECT RAISE(ABORT, 'consents are append-only'); END;
  `);
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
