// accounts.js — server-owned player accounts.
//
// WHY THIS EXISTS: character identity used to be a random token generated in
// the browser and kept in localStorage. That token IS the account, so it never
// left the machine that made it — logging in from a second computer produced a
// fresh token, the server saw a mismatch against the claimed name, and refused
// the join. A player literally could not reach their own character from
// another machine. Accounts replace that with something a person can carry:
// a username and a password they know.
//
// Storage mirrors storage.js: SQLite when better-sqlite3 is available, a JSON
// file otherwise, so a failed native build degrades instead of taking the world
// server down. The two modules share the same data dir but own separate tables.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const JSON_FILE = path.join(DATA_DIR, 'accounts.json');

let db = null;
try {
  const Database = require('better-sqlite3');
  db = new Database(path.join(DATA_DIR, 'bravo.db'));
  db.pragma('journal_mode = WAL');
  db.exec(`CREATE TABLE IF NOT EXISTS accounts (
    username TEXT PRIMARY KEY,
    salt TEXT NOT NULL,
    hash TEXT NOT NULL,
    created_at INTEGER
  )`);
  // Characters belong to an account. `name` stays globally unique because it is
  // what other players see in the world, and the world has always keyed saves
  // by character name.
  db.exec(`CREATE TABLE IF NOT EXISTS characters (
    name TEXT PRIMARY KEY,
    owner TEXT NOT NULL,
    created_at INTEGER
  )`);
} catch (e) {
  db = null;
}

let jsonStore = null;
function jsonLoad() {
  if (jsonStore) return jsonStore;
  try { jsonStore = JSON.parse(fs.readFileSync(JSON_FILE, 'utf8')); }
  catch (e) { jsonStore = { accounts: {}, characters: {} }; }
  jsonStore.accounts = jsonStore.accounts || {};
  jsonStore.characters = jsonStore.characters || {};
  return jsonStore;
}
function jsonFlush() {
  try { fs.writeFileSync(JSON_FILE, JSON.stringify(jsonStore || {})); }
  catch (e) { console.warn('[accounts] json write failed:', e.message); }
}

// ── Password hashing ──────────────────────────────────────────────
// scrypt from node's own crypto — no dependency, and deliberately slow so a
// stolen database is not a list of passwords. Never store the password itself.
function hashPassword(password, salt) {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}
// Constant-time compare so a wrong password can't be narrowed down by timing.
function safeEqual(a, b) {
  const ba = Buffer.from('' + a), bb = Buffer.from('' + b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

const USER_RE = /^[A-Za-z0-9_\-.]{3,24}$/;
function cleanUsername(raw) {
  const u = ('' + (raw || '')).trim();
  return USER_RE.test(u) ? u.toLowerCase() : null;
}

function getAccount(username) {
  if (db) return db.prepare('SELECT * FROM accounts WHERE username=?').get(username) || null;
  return jsonLoad().accounts[username] || null;
}

// Returns {ok:true} or {ok:false, error:'...'} — never throws, so callers can
// report the reason straight to the login screen.
function register(username, password) {
  const u = cleanUsername(username);
  if (!u) return { ok: false, error: 'username must be 3-24 chars (letters, digits, _ - .)' };
  if (typeof password !== 'string' || password.length < 6) return { ok: false, error: 'password must be at least 6 characters' };
  if (getAccount(u)) return { ok: false, error: 'that username is taken' };
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = hashPassword(password, salt);
  const now = Date.now();
  if (db) db.prepare('INSERT INTO accounts (username,salt,hash,created_at) VALUES (?,?,?,?)').run(u, salt, hash, now);
  else { const s = jsonLoad(); s.accounts[u] = { username: u, salt, hash, created_at: now }; jsonFlush(); }
  return { ok: true, username: u };
}

function verify(username, password) {
  const u = cleanUsername(username);
  if (!u) return { ok: false, error: 'bad username' };
  const acc = getAccount(u);
  // Hash anyway on a missing account so "no such user" and "wrong password"
  // take the same time and return the same message.
  const salt = acc ? acc.salt : 'no-such-account';
  const attempt = hashPassword(typeof password === 'string' ? password : '', salt);
  if (!acc || !safeEqual(attempt, acc.hash)) return { ok: false, error: 'wrong username or password' };
  return { ok: true, username: u };
}

// ── Character ownership ───────────────────────────────────────────
function characterOwner(name) {
  if (db) { const r = db.prepare('SELECT owner FROM characters WHERE name=?').get(name); return (r && r.owner) || null; }
  const c = jsonLoad().characters[name];
  return (c && c.owner) || null;
}
function listCharacters(username) {
  if (db) return db.prepare('SELECT name FROM characters WHERE owner=? ORDER BY created_at').all(username).map(r => r.name);
  const s = jsonLoad();
  return Object.keys(s.characters).filter(n => s.characters[n].owner === username);
}
// Claim an unowned character name for an account. Returns false if someone
// else already owns it — the caller must refuse the join in that case.
function claimCharacter(name, username) {
  const owner = characterOwner(name);
  if (owner) return owner === username;
  const now = Date.now();
  if (db) db.prepare('INSERT OR IGNORE INTO characters (name,owner,created_at) VALUES (?,?,?)').run(name, username, now);
  else { const s = jsonLoad(); s.characters[name] = { name, owner: username, created_at: now }; jsonFlush(); }
  return true;
}

// ── Sessions ──────────────────────────────────────────────────────
// The login endpoint hands back a short-lived session token; the room's onAuth
// checks it. In memory on purpose: a restart forcing a re-login is a fair
// trade for not persisting bearer tokens to disk.
const sessions = new Map();
const SESSION_MS = 1000 * 60 * 60 * 24 * 7;
function newSession(username) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { username, expires: Date.now() + SESSION_MS });
  return token;
}
function sessionUser(token) {
  const s = sessions.get(token);
  if (!s) return null;
  if (s.expires < Date.now()) { sessions.delete(token); return null; }
  return s.username;
}
setInterval(() => {
  const now = Date.now();
  for (const [t, s] of sessions) if (s.expires < now) sessions.delete(t);
}, 1000 * 60 * 30).unref?.();

module.exports = { register, verify, listCharacters, characterOwner, claimCharacter,
                   newSession, sessionUser, cleanUsername, backend: db ? 'sqlite' : 'json' };
