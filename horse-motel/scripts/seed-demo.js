// Local development only: adds a demo camera for every stall so the camera page has
// something to show without real hardware.
import { buildConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { randomToken } from '../src/security/crypto.js';

const cfg = buildConfig();
if (cfg.production) { console.error('Not in production.'); process.exit(1); }
const db = openDb(cfg);
const stalls = db.prepare("SELECT id, number FROM units WHERE kind = 'stall' AND active = 1").all();
for (const s of stalls) {
  const name = `Stall ${s.number} camera`;
  if (db.prepare('SELECT 1 FROM cameras WHERE name = ?').get(name)) continue;
  const info = db.prepare("INSERT INTO cameras (public_id, name, source_type, source_url) VALUES (?, ?, 'demo', '')").run(randomToken(12), name);
  db.prepare('INSERT INTO camera_units (camera_id, unit_id) VALUES (?, ?)').run(info.lastInsertRowid, s.id);
}
console.log(`Demo cameras ready for ${stalls.length} stalls.`);
