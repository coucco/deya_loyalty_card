-- Схема БД (SQLite). Деньги — целые копейки, баллы — целые числа.
CREATE TABLE IF NOT EXISTS points (          -- точки ТРЦ (гипермаркет, кино, боулинг...)
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('earn','spend','both')),
  accrual_bp  INTEGER NOT NULL DEFAULT 0,    -- % начисления в сотых долях процента (500 = 5%)
  redeem_bp   INTEGER NOT NULL DEFAULT 0,    -- макс. доля чека, оплачиваемая баллами (1000 = 10%)
  active      INTEGER NOT NULL DEFAULT 1,
  api_key_hash TEXT,                         -- sha256 ключа доступа точки/плагина
  created_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  phone TEXT UNIQUE,                         -- NULL после удаления аккаунта
  name TEXT,
  consent_at TEXT,
  created_at TEXT NOT NULL,
  deleted_at TEXT
);
CREATE TABLE IF NOT EXISTS cards (
  number TEXT PRIMARY KEY,
  user_id INTEGER REFERENCES users(id),      -- NULL = карта выпущена, но ещё не привязана
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS cards_user ON cards(user_id);
CREATE TABLE IF NOT EXISTS accounts (        -- кэш баланса; источник правды — ledger
  user_id INTEGER PRIMARY KEY REFERENCES users(id),
  balance INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
  held    INTEGER NOT NULL DEFAULT 0 CHECK (held >= 0)
);
CREATE TABLE IF NOT EXISTS ledger (          -- журнал операций, только добавление
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  point_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('ACCRUAL','ACCRUAL_REVERSAL','REDEEM','REDEEM_REVERSAL','ADJUST')),
  points INTEGER NOT NULL,                   -- со знаком
  base_kop INTEGER,                          -- сумма, от которой считали
  pct_bp INTEGER,                            -- какой процент применили
  receipt_key TEXT,
  idem_key TEXT UNIQUE,
  meta TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ledger_user ON ledger(user_id, id DESC);
CREATE INDEX IF NOT EXISTS ledger_receipt ON ledger(receipt_key);
CREATE TABLE IF NOT EXISTS holds (           -- резерв баллов под оплату
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id),
  point_id TEXT NOT NULL,
  points INTEGER NOT NULL,
  check_kop INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('HELD','COMMITTED','CANCELLED','EXPIRED','REVERSED')),
  idem_key TEXT UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS otp (
  phone TEXT PRIMARY KEY, code_hash TEXT NOT NULL, expires_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0, sent_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS otp_log (phone TEXT NOT NULL, ts INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS otp_log_phone ON otp_log(phone, ts);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
  expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT, actor TEXT NOT NULL, action TEXT NOT NULL,
  detail TEXT, created_at TEXT NOT NULL
);
