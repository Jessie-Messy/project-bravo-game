// storage.js — player persistence. Prefers SQLite (better-sqlite3); falls
// back to a JSON file automatically if the native module isn't available,
// so a failed native build never takes the world server down.
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });

const JSON_FILE = path.join(DATA_DIR, 'players.json');
const LEGACY_POS = path.join(DATA_DIR, 'positions.json');

let db = null;
try {
  const Database = require('better-sqlite3');
  db = new Database(path.join(DATA_DIR, 'bravo.db'));
  db.pragma('journal_mode = WAL');
  db.exec(`CREATE TABLE IF NOT EXISTS players (
    name TEXT PRIMARY KEY,
    x REAL NOT NULL, y REAL NOT NULL,
    hp INTEGER DEFAULT 100,
    kills INTEGER DEFAULT 0, deaths INTEGER DEFAULT 0,
    updated_at INTEGER
  )`);
  try { db.exec('ALTER TABLE players ADD COLUMN token TEXT'); } catch (e) { /* column exists */ }
  try { db.exec('ALTER TABLE players ADD COLUMN blob TEXT'); } catch (e) { /* column exists */ }
  console.log('[storage] SQLite (data/bravo.db)');
} catch (e) {
  console.warn('[storage] better-sqlite3 unavailable (' + e.message.split('\n')[0] + ') — using JSON fallback');
}

// JSON fallback store
let jsonStore = null;
function jsonLoad() {
  if (jsonStore) return jsonStore;
  try { jsonStore = JSON.parse(fs.readFileSync(JSON_FILE, 'utf8')); }
  catch (e) { jsonStore = {}; }
  return jsonStore;
}
function jsonFlush() {
  try { fs.writeFileSync(JSON_FILE, JSON.stringify(jsonStore || {})); }
  catch (e) { console.warn('[storage] json write failed:', e.message); }
}

// one-time import of the Phase A positions.json
(function migrateLegacy() {
  try {
    if (!fs.existsSync(LEGACY_POS)) return;
    const old = JSON.parse(fs.readFileSync(LEGACY_POS, 'utf8'));
    for (const [name, p] of Object.entries(old)) {
      if (!load(name)) save(name, { x: p.x, y: p.y, hp: 100, kills: 0, deaths: 0 });
    }
    fs.renameSync(LEGACY_POS, LEGACY_POS + '.imported');
    console.log('[storage] imported legacy positions.json');
  } catch (e) { /* non-fatal */ }
})();

function load(name) {
  if (db) return db.prepare('SELECT x,y,hp,kills,deaths FROM players WHERE name=?').get(name) || null;
  return jsonLoad()[name] || null;
}

// ── Name-claim tokens ──
// First join with a name claims it: the client's secret token is stored and
// every later join must present the same token. null = unclaimed.
function getToken(name) {
  if (db) { const r = db.prepare('SELECT token FROM players WHERE name=?').get(name); return (r && r.token) || null; }
  const p = jsonLoad()[name];
  return (p && p.token) || null;
}
// Full save blob (gold/inventory/skills/etc as an opaque JSON string) — the
// server is the source of truth for it while a player is online.
function loadBlob(name) {
  if (db) { const r = db.prepare('SELECT blob FROM players WHERE name=?').get(name); return (r && r.blob) || null; }
  const p = jsonLoad()[name];
  return (p && p.blob) || null;
}
function saveBlob(name, blobStr) {
  if (typeof blobStr !== 'string' || blobStr.length > 200000) return;
  if (db) {
    db.prepare(`INSERT INTO players (name,x,y,blob,updated_at) VALUES (?,?,?,?,?)
      ON CONFLICT(name) DO UPDATE SET blob=excluded.blob, updated_at=excluded.updated_at`)
      .run(name, 310 * 48 + 24, 360 * 48 + 24, blobStr, Date.now());
    return;
  }
  const s = jsonLoad();
  s[name] = s[name] || { x: 310 * 48 + 24, y: 360 * 48 + 24, hp: 100, kills: 0, deaths: 0 };
  s[name].blob = blobStr;
  jsonFlush();
}

function setToken(name, token) {
  if (db) {
    db.prepare(`INSERT INTO players (name,x,y,token,updated_at) VALUES (?,?,?,?,?)
      ON CONFLICT(name) DO UPDATE SET token=excluded.token`)
      .run(name, 310 * 48 + 24, 360 * 48 + 24, token, Date.now());
    return;
  }
  const s = jsonLoad();
  s[name] = s[name] || { x: 310 * 48 + 24, y: 360 * 48 + 24, hp: 100, kills: 0, deaths: 0 };
  s[name].token = token;
  jsonFlush();
}

function save(name, p) {
  if (db) {
    db.prepare(`INSERT INTO players (name,x,y,hp,kills,deaths,updated_at)
      VALUES (@name,@x,@y,@hp,@kills,@deaths,@t)
      ON CONFLICT(name) DO UPDATE SET x=@x,y=@y,hp=@hp,kills=@kills,deaths=@deaths,updated_at=@t`)
      .run({ name, x: p.x, y: p.y, hp: p.hp | 0, kills: p.kills | 0, deaths: p.deaths | 0, t: Date.now() });
    return;
  }
  const s = jsonLoad();
  s[name] = Object.assign(s[name] || {}, { x: p.x, y: p.y, hp: p.hp | 0, kills: p.kills | 0, deaths: p.deaths | 0 });
  jsonFlush();   // merge, never replace — the record also carries the name-claim token
}

module.exports = { load, save, getToken, setToken, loadBlob, saveBlob, backend: db ? 'sqlite' : 'json' };
