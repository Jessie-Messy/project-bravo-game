// jewelry.mjs — headless check on the artifact models.
//
// Same failure this repo has now been bitten by twice: mergeGeometries returns
// NULL instead of throwing when the parts disagree on attributes, and a null
// geometry does not look like a bug — the artifact simply does not appear, which
// is exactly what it did BEFORE it had a model. A broken ring and an unmodelled
// ring are indistinguishable in game.
//
// It also checks that every artifact the GAME defines has a design here. Adding
// an artifact to ARTIFACT_DEFS and forgetting this file gives you a grey
// fallback band, which is easy to miss on a rare drop.
//
// Usage: node tools/test/jewelry.mjs   (or npm run test:jewelry)
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const VENDOR = 'C:/Users/Arnol/Desktop/Server Migration/ORION_GUILD_WEBSITE_WORKING_FOLDER/orion-platform/public/games/medieval/vendor';
if (!fs.existsSync(VENDOR + '/three.module.js')) {
  console.error('SKIP: vendored three not found at ' + VENDOR);
  process.exit(0);
}

// Same staging trick as tools/test/dressing.mjs: three.module.js is a .js file
// node would otherwise parse as CommonJS, and the bare 'three/addons/...'
// specifier only resolves through the browser's import map.
const tmp = path.join(os.tmpdir(), 'bravo-jewelry-test');
fs.mkdirSync(tmp, { recursive: true });
fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}');
fs.copyFileSync(VENDOR + '/three.module.js', path.join(tmp, 'three.module.js'));
fs.writeFileSync(path.join(tmp, 'BufferGeometryUtils.js'),
  fs.readFileSync(VENDOR + '/addons/utils/BufferGeometryUtils.js', 'utf8')
    .replace("'../../three.module.js'", "'./three.module.js'"));
fs.writeFileSync(path.join(tmp, 'jewelry.js'),
  fs.readFileSync('js/render/jewelry.js', 'utf8')
    .replace("'three/addons/utils/BufferGeometryUtils.js'", "'./BufferGeometryUtils.js'"));

const THREE = await import(pathToFileURL(path.join(tmp, 'three.module.js')).href);
const J = await import(pathToFileURL(path.join(tmp, 'jewelry.js')).href);

// The artifact list is parsed out of game3d.js rather than mirrored, because a
// mirror is the thing that goes stale — and going stale is the failure this
// test is for.
const src = fs.readFileSync('js/game3d.js', 'utf8');
const block = src.match(/const ARTIFACT_DEFS=\[([\s\S]*?)\n\];/);
if (!block) { console.error('FAIL: could not find ARTIFACT_DEFS in js/game3d.js'); process.exit(1); }
const defs = [...block[1].matchAll(/\{id:'([a-z_]+)'[^}]*?slot:'(neck|ring|brac)'/g)]
  .map(m => ({ id: m[1], slot: m[2] }));

let fail = 0, checked = 0;
const bad = m => { console.log('  FAIL  ' + m); fail++; };

console.log(defs.length + ' artifacts defined in the game');
if (defs.length < 12) bad('only parsed ' + defs.length + ' artifacts — did ARTIFACT_DEFS change shape?');

const designed = new Set(J.designedArtifactIds());
for (const d of defs) {
  checked++;
  if (!designed.has(d.id)) { bad(d.id + ' has no design in jewelry.js (would render a grey fallback band)'); continue; }

  const g = J.buildArtifactGeometry(THREE, d);
  checked++;
  if (g === null) { bad(d.id + ' merged to NULL — an attribute mismatch between its parts'); continue; }

  const pos = g.attributes.position, col = g.attributes.color;
  if (!pos || pos.count === 0) { bad(d.id + ' has no vertices'); continue; }
  if (!col || col.count !== pos.count) {
    bad(d.id + ' colour attribute missing or short (' + (col ? col.count : 0) + ' vs ' + pos.count + ')');
    continue;
  }
  if (g.attributes.uv) bad(d.id + ' kept a uv — it will refuse to merge with the others');

  let nan = -1;
  for (let i = 0; i < pos.count * 3; i++)
    if (!Number.isFinite(pos.array[i])) { nan = i; break; }
  if (nan >= 0) { bad(d.id + ' contains NaN at position[' + nan + ']'); continue; }

  // Sane size. These are deliberately oversized (see the note in jewelry.js),
  // but a piece bigger than the character's head is a units mistake.
  const b = new THREE.Box3().setFromBufferAttribute(pos);
  const size = Math.max(b.max.x - b.min.x, b.max.y - b.min.y, b.max.z - b.min.z);
  const lim = d.slot === 'neck' ? [3, 14] : [2, 9];
  if (size < lim[0] || size > lim[1])
    bad(d.id + ' bounding size ' + size.toFixed(2) + ' outside ' + lim[0] + '..' + lim[1]);
}

// And the reverse: a design here for an artifact the game no longer has is dead
// weight, and usually means an id was renamed on one side only.
for (const id of designed)
  if (!defs.some(d => d.id === id)) bad('jewelry.js designs "' + id + '", which is not in ARTIFACT_DEFS');

console.log('\n' + checked + ' checks, ' + fail + ' failure' + (fail === 1 ? '' : 's'));
process.exit(fail ? 1 : 0);
