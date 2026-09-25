// Creates (or promotes) an owner account and prints a one-time link to set its password.
//   npm run create-admin -- owner@example.com
//   npm run create-admin -- owner@example.com --reset-mfa   (lost phone)
import { buildConfig } from '../src/config.js';
import { openDb, audit } from '../src/db.js';
import { randomToken, sha256 } from '../src/security/crypto.js';

const email = (process.argv[2] || '').trim().toLowerCase();
if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
  console.error('Usage: npm run create-admin -- you@example.com [--reset-mfa]');
  process.exit(1);
}
const cfg = buildConfig();
const db = openDb(cfg);
let user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
if (!user) {
  const info = db.prepare("INSERT INTO users (email, role, created_at) VALUES (?, 'admin', ?)").run(email, Date.now());
  user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
} else {
  db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(user.id);
  // Existing sessions were created as a guest; make them sign in again as an admin.
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
}
if (process.argv.includes('--reset-mfa')) {
  db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?').run(user.id);
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(user.id);
  console.log('Two-step verification cleared; it must be set up again on next sign-in.');
}
const token = randomToken();
db.prepare("INSERT INTO auth_tokens (token_hash, user_id, purpose, expires_at) VALUES (?, ?, 'reset', ?)")
  .run(sha256(token), user.id, Date.now() + 60 * 60e3);
audit(db, { userId: user.id, action: 'admin.created_via_cli' });
console.log(`\nAdmin: ${email}\nOpen this link within 1 hour to set the password:\n\n  ${cfg.origin}/setup#token=${token}\n`);
console.log('Then sign in, go to Account → Two-step verification, and turn it on. The admin page requires it.');
