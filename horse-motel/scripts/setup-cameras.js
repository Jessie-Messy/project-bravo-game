// Adds one camera per stall, pointing at MediaMTX's HLS streams, and maps each to its
// stall. Safe to run again: cameras that already exist (same name) are left alone.
//   npm run cameras:setup                      → stall1..stallN at http://127.0.0.1:8888
//   npm run cameras:setup -- --base http://127.0.0.1:8888 --count 6
import { buildConfig } from '../src/config.js';
import { openDb, audit } from '../src/db.js';
import { randomToken } from '../src/security/crypto.js';
import { initSecretBox, seal } from '../src/security/secretbox.js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const cfg = buildConfig();
const base = arg('base', 'http://127.0.0.1:8888').replace(/\/$/, '');
const count = Number(arg('count', cfg.inventory.stalls));
const host = new URL(base).hostname;
if (cfg.cameraAccess.allowedHosts.length && !cfg.cameraAccess.allowedHosts.includes(host)) {
  console.error(`Add ${host} to CAMERA_ALLOWED_HOSTS in .env first.`);
  process.exit(1);
}
initSecretBox(cfg);
const db = openDb(cfg);
let added = 0;
for (let n = 1; n <= count; n++) {
  const name = `Stall ${n} camera`;
  const stall = db.prepare("SELECT id FROM units WHERE kind = 'stall' AND number = ? AND active = 1").get(n);
  if (!stall) { console.warn(`No stall ${n}; skipped.`); continue; }
  if (db.prepare('SELECT 1 FROM cameras WHERE name = ?').get(name)) { console.log(`${name} already exists.`); continue; }
  const info = db.prepare("INSERT INTO cameras (public_id, name, source_type, source_url) VALUES (?, ?, 'hls', ?)")
    .run(randomToken(12), name, seal(`${base}/stall${n}/index.m3u8`));
  db.prepare('INSERT INTO camera_units (camera_id, unit_id) VALUES (?, ?)').run(info.lastInsertRowid, stall.id);
  added++;
}
audit(db, { action: 'admin.cameras_setup', detail: `${added} added from ${base}` });
console.log(`Added ${added} camera(s). Check each one with Admin → Cameras → Test.`);
