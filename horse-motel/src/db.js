// SQLite storage. One file, WAL mode, foreign keys on.
//
// The double-booking guarantee lives in the schema, not in application code:
// `allocations` has UNIQUE(unit_id, night), so two bookings can never hold the same
// stall, RV site or house on the same night, whatever races happen above it.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id              INTEGER PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name            TEXT NOT NULL DEFAULT '',
  phone           TEXT NOT NULL DEFAULT '',
  password_hash   TEXT,
  role            TEXT NOT NULL DEFAULT 'guest' CHECK (role IN ('guest','admin')),
  totp_secret     TEXT,
  totp_enabled    INTEGER NOT NULL DEFAULT 0,
  totp_last_step  INTEGER NOT NULL DEFAULT 0,
  failed_logins   INTEGER NOT NULL DEFAULT 0,
  mfa_failures    INTEGER NOT NULL DEFAULT 0,
  lock_level      INTEGER NOT NULL DEFAULT 0,
  locked_until    INTEGER NOT NULL DEFAULT 0,
  created_at      INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token_hash   TEXT PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  csrf_token   TEXT NOT NULL,
  mfa_passed   INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  last_seen    INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);

-- Pending second factor: password was right, TOTP code still owed.
CREATE TABLE IF NOT EXISTS mfa_challenges (
  token_hash  TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  attempts    INTEGER NOT NULL DEFAULT 0,
  expires_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_tokens (
  token_hash  TEXT PRIMARY KEY,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  purpose     TEXT NOT NULL CHECK (purpose IN ('setup','reset')),
  expires_at  INTEGER NOT NULL,
  used_at     INTEGER
);

CREATE TABLE IF NOT EXISTS units (
  id      INTEGER PRIMARY KEY,
  kind    TEXT NOT NULL CHECK (kind IN ('house','stall','rv')),
  number  INTEGER NOT NULL,
  label   TEXT NOT NULL,
  sewer   INTEGER NOT NULL DEFAULT 0,
  active  INTEGER NOT NULL DEFAULT 1,
  UNIQUE (kind, number)
);

CREATE TABLE IF NOT EXISTS bookings (
  id                 INTEGER PRIMARY KEY,
  ref                TEXT NOT NULL UNIQUE,
  kind               TEXT NOT NULL DEFAULT 'guest' CHECK (kind IN ('guest','block')),
  status             TEXT NOT NULL CHECK (status IN ('pending','confirmed','cancelled','expired','needs_attention')),
  user_id            INTEGER REFERENCES users(id),
  email              TEXT NOT NULL DEFAULT '',
  name               TEXT NOT NULL DEFAULT '',
  phone              TEXT NOT NULL DEFAULT '',
  check_in           TEXT NOT NULL,
  check_out          TEXT NOT NULL,
  house              INTEGER NOT NULL DEFAULT 0,
  stalls             INTEGER NOT NULL DEFAULT 0,
  rv_sites           INTEGER NOT NULL DEFAULT 0,
  rv_sewer           INTEGER NOT NULL DEFAULT 0,
  guests             INTEGER NOT NULL DEFAULT 0,
  horses             INTEGER NOT NULL DEFAULT 0,
  notes              TEXT NOT NULL DEFAULT '',
  amount_cents       INTEGER NOT NULL DEFAULT 0,
  currency           TEXT NOT NULL DEFAULT 'usd',
  stripe_session_id  TEXT UNIQUE,
  stripe_payment_intent TEXT,
  hold_expires_at    INTEGER,
  hold_key           TEXT,
  refund_cents       INTEGER NOT NULL DEFAULT 0,
  source             TEXT NOT NULL DEFAULT 'web',
  external_uid       TEXT,
  status_token_hash  TEXT,
  created_at         INTEGER NOT NULL,
  confirmed_at       INTEGER
);
CREATE INDEX IF NOT EXISTS bookings_user ON bookings(user_id);
CREATE INDEX IF NOT EXISTS bookings_status ON bookings(status, hold_expires_at);

CREATE TABLE IF NOT EXISTS allocations (
  booking_id  INTEGER NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  unit_id     INTEGER NOT NULL REFERENCES units(id),
  night       TEXT NOT NULL,
  UNIQUE (unit_id, night)
);
CREATE INDEX IF NOT EXISTS allocations_booking ON allocations(booking_id);
CREATE INDEX IF NOT EXISTS allocations_night ON allocations(night);

CREATE TABLE IF NOT EXISTS cameras (
  id           INTEGER PRIMARY KEY,
  public_id    TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  source_type  TEXT NOT NULL CHECK (source_type IN ('hls','snapshot','demo')),
  source_url   TEXT NOT NULL DEFAULT '',
  active       INTEGER NOT NULL DEFAULT 1
);

-- Which stalls (or other units) a camera shows. A camera can cover two stalls.
CREATE TABLE IF NOT EXISTS camera_units (
  camera_id  INTEGER NOT NULL REFERENCES cameras(id) ON DELETE CASCADE,
  unit_id    INTEGER NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  PRIMARY KEY (camera_id, unit_id)
);

CREATE TABLE IF NOT EXISTS webhook_events (
  id            TEXT PRIMARY KEY,
  received_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS audit_log (
  id       INTEGER PRIMARY KEY,
  at       INTEGER NOT NULL,
  user_id  INTEGER,
  action   TEXT NOT NULL,
  detail   TEXT NOT NULL DEFAULT '',
  ip       TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS audit_at ON audit_log(at);
`;

export function openDb(cfg, { memory = false } = {}) {
  let file = ':memory:';
  if (!memory) {
    fs.mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });
    file = path.join(cfg.dataDir, 'ranch.db');
  }
  const db = new Database(file);
  if (!memory) { try { fs.chmodSync(file, 0o600); } catch { /* not fatal on Windows */ } }
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  db.exec(SCHEMA);
  migrate(db);
  seedUnits(db, cfg);
  return db;
}

// Adds columns introduced after a database was first created.
function migrate(db) {
  const add = [
    ['users', 'lock_level', 'INTEGER NOT NULL DEFAULT 0'],
    ['users', 'mfa_failures', 'INTEGER NOT NULL DEFAULT 0'],
    ['bookings', 'hold_key', 'TEXT'],
    ['bookings', 'rv_sewer', 'INTEGER NOT NULL DEFAULT 0'],
    ['bookings', 'refund_cents', 'INTEGER NOT NULL DEFAULT 0'],
    ['bookings', 'source', "TEXT NOT NULL DEFAULT 'web'"],
    ['bookings', 'external_uid', 'TEXT'],
    ['units', 'sewer', 'INTEGER NOT NULL DEFAULT 0'],
  ];
  for (const [table, col, ddl] of add) {
    const cols = db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name);
    if (!cols.includes(col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${ddl}`);
  }
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS bookings_external_uid ON bookings(external_uid) WHERE external_uid IS NOT NULL');
}

// Keeps the units table in step with the configured inventory. Units are only ever
// deactivated, never deleted, so past bookings keep pointing at real rows.
function seedUnits(db, cfg) {
  const want = { house: 1, stall: cfg.inventory.stalls, rv: cfg.inventory.rvSites };
  const sewer = (kind, n) => (kind === 'rv' && n <= cfg.inventory.rvSewerSites ? 1 : 0);
  const label = {
    house: () => 'Ranch house',
    stall: (n) => `Stall ${n}`,
    rv: (n) => `RV site ${n}${sewer('rv', n) ? ' (full hookup)' : ''}`,
  };
  const upsert = db.prepare(`INSERT INTO units (kind, number, label, sewer, active) VALUES (?, ?, ?, ?, 1)
    ON CONFLICT(kind, number) DO UPDATE SET active = 1, label = excluded.label, sewer = excluded.sewer`);
  const deactivate = db.prepare('UPDATE units SET active = 0 WHERE kind = ? AND number > ?');
  db.transaction(() => {
    for (const [kind, count] of Object.entries(want)) {
      for (let n = 1; n <= count; n++) upsert.run(kind, n, label[kind](n), sewer(kind, n));
      deactivate.run(kind, count);
    }
  })();
}

export function audit(db, { userId = null, action, detail = '', ip = '' }) {
  db.prepare('INSERT INTO audit_log (at, user_id, action, detail, ip) VALUES (?, ?, ?, ?, ?)')
    .run(Date.now(), userId, action, String(detail).slice(0, 500), String(ip).slice(0, 64));
}
