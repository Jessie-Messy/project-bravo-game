// dressing.mjs — headless check of every NPC outfit in render/humanoid.js.
//
// WHY THIS EXISTS. The dressing builders end in mergeGeometries(parts), and
// mergeGeometries returns **null** — no throw, no warning — when the parts do
// not share an identical attribute set. humanoid.js already carries a comment
// about this: BoxGeometry ships a `uv` that the ring-stitched tubes never
// produce, which is why slab() deletes it. Get that wrong in a new piece and
// the outfit does not break loudly, it simply DISAPPEARS: dressRig sets
// `dress.visible = false` on a null geometry and the NPC stands there
// undressed, looking like a stand-in whose model never arrived. That is
// indistinguishable from "the GLB has not loaded yet" — which is exactly the
// state these figures exist to cover for, so nobody would ever look twice.
//
// So: build every style, assert the merge survived, and assert the result
// carries the vertex colours the dressing material needs. Runs in node against
// the vendored three — no browser, no GPU.
//
// Usage: node tools/test/dressing.mjs   (or npm run test:dressing)
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

// The game loads three from a CDN import map, so there is no copy in
// node_modules. The platform build vendors one; borrow it.
const VENDOR = 'C:/Users/Arnol/Desktop/Server Migration/ORION_GUILD_WEBSITE_WORKING_FOLDER/orion-platform/public/games/medieval/vendor';
if (!fs.existsSync(VENDOR + '/three.module.js')) {
  console.error('SKIP: vendored three not found at ' + VENDOR);
  process.exit(0);
}

// Two things stop node importing this directly, and both are solved by staging
// copies in one temp directory:
//
//   1. The vendored three is `three.module.js` — a .js file whose nearest
//      package.json does not say "type": "module", so node parses it as
//      CommonJS and dies on its first `export`. A package.json of our own in
//      the staging directory fixes that for every file we put beside it.
//   2. humanoid.js imports the BARE specifier 'three/addons/...', which only
//      the browser's import map resolves. Rewritten to a sibling here.
//
// The geometry code under test is byte-identical either way — only import
// specifiers change.
const tmp = path.join(os.tmpdir(), 'bravo-dressing-test');
fs.mkdirSync(tmp, { recursive: true });
fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}');
fs.copyFileSync(VENDOR + '/three.module.js', path.join(tmp, 'three.module.js'));
fs.writeFileSync(path.join(tmp, 'BufferGeometryUtils.js'),
  fs.readFileSync(VENDOR + '/addons/utils/BufferGeometryUtils.js', 'utf8')
    .replace("'../../three.module.js'", "'./three.module.js'"));
fs.writeFileSync(path.join(tmp, 'humanoid.js'),
  fs.readFileSync('js/render/humanoid.js', 'utf8')
    .replace("'three/addons/utils/BufferGeometryUtils.js'", "'./BufferGeometryUtils.js'"));

const THREE = await import(pathToFileURL(path.join(tmp, 'three.module.js')).href);
const H = await import(pathToFileURL(path.join(tmp, 'humanoid.js')).href);

// Mirrors RIG_STYLES in game3d.js. A literal rather than something parsed out
// of that 13k-line module, because this harness must not import the game.
// If you add a style there, add it here — `npm run test:dressing` is the only
// thing that will tell you an outfit silently vanished.
const STYLES = {
  guard:    { build:{bw:17,bh:51,bd:11,hr:4.3}, helm:0x8e949c, plume:0x8c2f2f, coif:0x70757c, gorget:0x9aa1aa, pauldron:0x9aa1aa, tabard:0x243352, tabardTrim:0xd8c060, belt:0x4a3524, buckle:0xd8c060, cloak:0x243352 },
  merchant: { build:{bw:16,bh:46,bd:12,hr:4.5}, cap:0x6b3f2a, plume:0x7a5a30, belt:0x4a3524, satchel:0x6b4a2a, pouch:0x5a4020, robe:0x8a4030, robeShort:true, hair:0x3a2a1a, mustache:0x3a2a1a },
  banker:   { build:{bw:15,bh:47,bd:10,hr:4.4}, cap:0x4a4038, belt:0x3a2a1c, robe:0xd0a020, robeShort:true, collar:0x4a3a2a, medallion:0xd8c060, chain:0xd8c060, hair:0x2a2018 },
  smith:    { build:{bw:19,bh:50,bd:13,hr:4.4}, apron:0x5c4028, belt:0x4a3524, toolLoop:0x4a4a50, hair:0x2a1c12, beard:0x2a1c12 },
  healer:   { build:{bw:13,bh:48,bd:9,hr:4.2}, hat:0x2f5c3a, hatBand:0xc8a25a, robe:0x40a060, belt:0x4a3524, beard:0xe8e4dc, pouch:0x3a5c40 },
  mage:     { build:{bw:13,bh:50,bd:9,hr:4.3}, hat:0x2a2f5c, hatBand:0xc8a25a, robe:0x4040a0, belt:0x4a3524, beard:0xe0dcd4, scrollCase:0x5a4a8a },
  scholar:  { build:{bw:13,bh:45,bd:9,hr:4.5}, hood:0x4a3a6a, robe:0x6a4a9a, belt:0x3a2a1c, beard:0xd8d0c4, spectacles:0xb8a878, scrollCase:0x4a3a6a },
  cipher:   { build:{bw:13,bh:46,bd:9,hr:4.2}, hood:0x24485e, maskScarf:0x1e3a4a, robe:0x2a5a7a, belt:0x3a2a1c, backpack:0x24485e, strap:0x3a2a1c },
  robber:   { build:{bw:13,bh:44,bd:9,hr:4.0}, hood:0x24242a, maskScarf:0x1a1a1e, cloak:0x1e1e22, belt:0x3a2a1c, pouch:0x2a2a30, eyes:false },
  farrier:  { build:{bw:17,bh:47,bd:12,hr:4.3}, apron:0x5c4028, belt:0x4a3524, cap:0x6b5a3a, toolLoop:0x4a4a50, mustache:0x4a3418 },
  curator:  { build:{bw:16,bh:44,bd:11,hr:4.6}, cap:0x7a5a20, plume:0xb08030, robe:0xb08030, robeShort:true, belt:0x4a3524, beard:0xd0c8b8, medallion:0xb87333, chain:0xb87333, circlet:0xb87333 },
  bandit:   { hood:0x3a2f28, maskScarf:0x2a221c, sash:0x6a2a24, belt:0x3a2a1c },
  ferryman: { build:{bw:17,bh:48,bd:12,hr:4.3}, cap:0x3a4a52, mantle:0x46545c, belt:0x4a3524, collar:0x2e3a40, beard:0x6a5a4a, toolLoop:0x5a4a3a },
  fletcher: { build:{bw:15,bh:48,bd:10,hr:4.3}, cap:0x4a5c34, belt:0x4a3524, quiver:0x5a3a20, fletching:0xe4e0d4, hair:0x6a5030 },
};
const DEFAULT_BUILD = { bw:15, bh:48, bd:10, hr:4.3 };
const OBJ_SCALE = 1, RIG_LEG_FRAC = 0.45;   // mirrors constants.js

let fail = 0, checked = 0;
const bad = (s, m) => { console.log('  FAIL  ' + s + ': ' + m); fail++; };

// The three shared body geometries first. Every rig in the game scales these,
// so a broken unit space breaks every character at once — not just the NPCs.
const UNIT_SPANS = { torso:[-0.5,0.5], head:[-1,1], limb:[-1,0] };
for (const [name, make] of [['torso', H.makeTorsoGeometry],
                            ['head',  H.makeHeadGeometry],
                            ['limb',  H.makeLimbGeometry]]) {
  checked++;
  const g = make(THREE);
  const p = g.attributes.position;
  if (!p || p.count === 0) { bad(name, 'empty geometry'); continue; }
  const b = new THREE.Box3().setFromBufferAttribute(p);
  const [lo, hi] = UNIT_SPANS[name];
  // The nose and the limb cuff push a little past the nominal box on purpose.
  const tol = 0.14;
  if (b.min.y < lo - tol || b.max.y > hi + tol)
    bad(name, 'Y span ' + b.min.y.toFixed(2) + '..' + b.max.y.toFixed(2) +
              ' escapes its unit space ' + lo + '..' + hi);
}

for (const [name, S] of Object.entries(STYLES)) {
  const bl = S.build || DEFAULT_BUILD;
  const bw = bl.bw * OBJ_SCALE, bh = bl.bh * OBJ_SCALE, bd = bl.bd * OBJ_SCALE;
  const legH = bh * RIG_LEG_FRAC, torso = bh - legH;
  const dims = { bw, bh, bd, legH, torso };

  const pieces = [['body', H.buildBodyDressing(THREE, S, dims)],
                  ['head', H.buildHeadDressing(THREE, S)]];
  for (const [which, built] of pieces) {
    checked++;
    // The silent failure this whole file exists for.
    if (built === null) {
      bad(name, which + ' dressing merged to NULL — an attribute mismatch between parts');
      continue;
    }
    const pos = built.attributes.position, col = built.attributes.color;
    if (!pos || pos.count === 0) { bad(name, which + ' has no vertices'); continue; }
    // The dressing material is vertexColors:true; with no colour attribute the
    // whole outfit renders undefined.
    if (!col || col.count !== pos.count) {
      bad(name, which + ' colour attribute missing or short (' +
                (col ? col.count : 0) + ' vs ' + pos.count + ')');
      continue;
    }
    if (built.attributes.uv)
      bad(name, which + ' kept a uv — it will refuse to merge with tube parts');
    let nan = -1;
    for (let i = 0; i < pos.count * 3; i++)
      if (!Number.isFinite(pos.array[i])) { nan = i; break; }
    if (nan >= 0) { bad(name, which + ' contains NaN at position[' + nan + ']'); continue; }
    // An outfit that is somehow tiny or enormous is a units mistake.
    const box = new THREE.Box3().setFromBufferAttribute(pos);
    const size = Math.max(box.max.x - box.min.x, box.max.y - box.min.y, box.max.z - box.min.z);
    const lim = which === 'head' ? [0.2, 6] : [bw * 0.2, bh * 2.2];
    if (size < lim[0] || size > lim[1])
      bad(name, which + ' bounding size ' + size.toFixed(2) +
                ' outside the sane range ' + lim[0].toFixed(2) + '..' + lim[1].toFixed(2));
  }
}

console.log('\n' + checked + ' checks, ' + fail + ' failure' + (fail === 1 ? '' : 's'));
process.exit(fail ? 1 : 0);
