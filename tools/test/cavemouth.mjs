// cavemouth.mjs — the cave-mouth portals (js/render/cave-mouth.js).
//
// Pins what the old arch got wrong and what the portal promises: the way in
// clears the character's head across the whole gap (the old lintel sat at 58
// against a 126-tall character), the torches stand outside on the jambs, the
// rock faces point the way they're seen from (a single-sided soffit wound
// upward was culled, and showed sky), and nothing is NaN.
//
// Usage: node tools/test/cavemouth.mjs   (or npm run test:cavemouth)
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildCaveMouths } from '../../js/render/cave-mouth.js';

const VENDOR = 'C:/Users/Arnol/Desktop/Server Migration/ORION_GUILD_WEBSITE_WORKING_FOLDER/orion-platform/public/games/medieval/vendor';
if (!fs.existsSync(VENDOR + '/three.module.js')) { console.error('SKIP: vendored three not found at ' + VENDOR); process.exit(0); }
const tmp = path.join(os.tmpdir(), 'bravo-cavemouth-test');
fs.mkdirSync(tmp, { recursive: true });
fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}');
fs.copyFileSync(VENDOR + '/three.module.js', path.join(tmp, 'three.module.js'));
const THREE = await import(pathToFileURL(path.join(tmp, 'three.module.js')).href);

let fail = 0, checked = 0;
const check = (name, cond, detail) => { checked++; if (!cond) { console.log('  FAIL  ' + name + (detail ? ' — ' + detail : '')); fail++; } };

const TILE = 48, CHAR_H = 126, grey = [0.5, 0.5, 0.5];
const noise = (x, y) => Math.sin(x * 12.9898 + y * 78.233) * 0.5 + 0.5;
// A three-tile mouth facing south (into +z) and a one-tile mouth facing east.
const mouths = [
  { mx: 1000, mz: 2000, dx: 0, dz: 1, halfW: TILE * 1.5, gy: 4 },
  { mx: 3000, mz: 800, dx: 1, dz: 0, halfW: TILE * 0.5, gy: -6 },
];
const out = buildCaveMouths(THREE, mouths, { TILE, height: 168, noise, colors: { post: grey, beam: grey, iron: grey } });
const rp = out.rock.attributes.position.array, rn = out.rock.attributes.normal.array;
check('rock is built', rp.length > 1000);
check('no NaN in the rock', !rp.some(Number.isNaN) && !rn.some(Number.isNaN));
check('no NaN in the timber', !out.wood.attributes.position.array.some(Number.isNaN));
check('two torches per mouth', out.flames.length === 4, out.flames.length + '');

// Headroom: every rock vertex over the walkable gap (inside the jambs, within
// the portal's depth) is well above the head of a character standing there.
for (const [mi, m] of mouths.entries()) {
  let low = Infinity, down = 0, soffitN = 0;
  for (let i = 0; i < rp.length; i += 3) {
    const rx = rp[i] - m.mx, rz = rp[i + 2] - m.mz;
    const u = -m.dz * rx + m.dx * rz, v = m.dx * rx + m.dz * rz;   // across, along
    if (Math.abs(u) > m.halfW - 8 || v < -TILE * 0.7 || v > TILE * 0.9) continue;
    low = Math.min(low, rp[i + 1] - m.gy);
    // anything clearly horizontal down there (under the crest, which never
    // drops below 172) is the soffit, and must face down; the faces' bottom
    // rows are vertical walls and don't count
    if (rp[i + 1] - m.gy < 165 && Math.abs(rn[i + 1]) > 0.5) { soffitN++; if (rn[i + 1] < 0) down++; }
  }
  check('mouth ' + mi + ': clears the head across the gap', low > CHAR_H + 10, 'lowest ' + low.toFixed(0));
  check('mouth ' + mi + ': the soffit faces down', soffitN > 0 && down / soffitN >= 0.9, down + '/' + soffitN);   // (a few noisy face-bottom vertices count too)
  // torches: outside the cave (v < 0) and beside the gap, not in it
  for (const f of out.flames.slice(mi * 2, mi * 2 + 2)) {
    const rx = f.x - m.mx, rz = f.z - m.mz, u = -m.dz * rx + m.dx * rz, v = m.dx * rx + m.dz * rz;
    check('mouth ' + mi + ': torch outside, on a jamb', v < 0 && Math.abs(u) > m.halfW, 'u ' + u.toFixed(0) + ' v ' + v.toFixed(0));
  }
}

console.log('\n' + checked + ' checks, ' + fail + ' failure' + (fail === 1 ? '' : 's'));
process.exit(fail ? 1 : 0);
