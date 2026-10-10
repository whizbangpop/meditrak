const path = require('path');
const Database = require('better-sqlite3');
const { dataDir } = require('./config');

const dbPath = process.env.DATABASE_PATH || path.join(dataDir, 'medtrack.db');
const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  issuer TEXT NOT NULL,
  subject TEXT NOT NULL,
  email TEXT,
  name TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  last_login_at TEXT,
  UNIQUE (issuer, subject)
);

CREATE TABLE IF NOT EXISTS profiles (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  timezone TEXT NOT NULL DEFAULT 'UTC',
  date_of_birth TEXT,
  notes TEXT,
  expiry_warning_days INTEGER NOT NULL DEFAULT 30,
  reminder_followup_minutes INTEGER NOT NULL DEFAULT 30,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT
);

-- strength = per tablet/capsule, or the typical concentration per ml for vials
CREATE TABLE IF NOT EXISTS medications (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  form TEXT NOT NULL CHECK (form IN ('tablet','capsule','vial')),
  strength REAL NOT NULL,
  strength_unit TEXT NOT NULL DEFAULT 'mg',
  default_dose REAL NOT NULL,
  low_stock_threshold REAL,
  instructions TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_med_user ON medications(user_id);

-- One row per box / packet / vial received. remaining is tablets for solids, ml for vials.
CREATE TABLE IF NOT EXISTS stock_items (
  id INTEGER PRIMARY KEY,
  medication_id INTEGER NOT NULL REFERENCES medications(id) ON DELETE CASCADE,
  batch TEXT,
  expiry_date TEXT,
  received_date TEXT,
  quantity REAL,
  concentration REAL,
  volume_ml REAL,
  remaining REAL NOT NULL DEFAULT 0,
  opened_at TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','finished','disposed')),
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_stock_med ON stock_items(medication_id);

CREATE TABLE IF NOT EXISTS schedules (
  id INTEGER PRIMARY KEY,
  medication_id INTEGER NOT NULL REFERENCES medications(id) ON DELETE CASCADE,
  dose REAL NOT NULL,
  frequency TEXT NOT NULL CHECK (frequency IN ('daily','every_n_days','weekly','as_needed')),
  interval_days INTEGER,
  days_of_week TEXT NOT NULL DEFAULT '[]',
  times TEXT NOT NULL DEFAULT '[]',
  start_date TEXT NOT NULL,
  end_date TEXT,
  notify INTEGER NOT NULL DEFAULT 1,
  active INTEGER NOT NULL DEFAULT 1,
  notes TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX IF NOT EXISTS ix_sched_med ON schedules(medication_id);

CREATE TABLE IF NOT EXISTS disposables (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  category TEXT,
  unit TEXT NOT NULL DEFAULT 'items',
  quantity REAL NOT NULL DEFAULT 0,
  low_stock_threshold REAL,
  notes TEXT,
  archived INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS medication_disposables (
  medication_id INTEGER NOT NULL REFERENCES medications(id) ON DELETE CASCADE,
  disposable_id INTEGER NOT NULL REFERENCES disposables(id) ON DELETE CASCADE,
  quantity_per_dose REAL NOT NULL DEFAULT 1,
  PRIMARY KEY (medication_id, disposable_id)
);

CREATE TABLE IF NOT EXISTS dose_logs (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  medication_id INTEGER NOT NULL REFERENCES medications(id) ON DELETE CASCADE,
  schedule_id INTEGER REFERENCES schedules(id) ON DELETE SET NULL,
  scheduled_for TEXT,
  status TEXT NOT NULL CHECK (status IN ('taken','skipped')),
  dose REAL,
  taken_at TEXT NOT NULL,
  shortfall REAL NOT NULL DEFAULT 0,
  notes TEXT,
  created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_dose_occurrence ON dose_logs(schedule_id, scheduled_for)
  WHERE schedule_id IS NOT NULL AND scheduled_for IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_dose_user ON dose_logs(user_id, taken_at);

-- Which stock items a dose came out of (lets doses be undone accurately)
CREATE TABLE IF NOT EXISTS dose_stock_usage (
  dose_log_id INTEGER NOT NULL REFERENCES dose_logs(id) ON DELETE CASCADE,
  stock_item_id INTEGER NOT NULL REFERENCES stock_items(id) ON DELETE CASCADE,
  amount REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS disposable_transactions (
  id INTEGER PRIMARY KEY,
  disposable_id INTEGER NOT NULL REFERENCES disposables(id) ON DELETE CASCADE,
  change REAL NOT NULL,
  reason TEXT NOT NULL CHECK (reason IN ('restock','dose','manual','adjustment')),
  dose_log_id INTEGER REFERENCES dose_logs(id) ON DELETE SET NULL,
  batch TEXT,
  expiry_date TEXT,
  note TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS push_subscriptions (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL UNIQUE,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS notification_log (
  schedule_id INTEGER NOT NULL REFERENCES schedules(id) ON DELETE CASCADE,
  scheduled_for TEXT NOT NULL,
  kind TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  PRIMARY KEY (schedule_id, scheduled_for, kind)
);
`);

module.exports = db;
