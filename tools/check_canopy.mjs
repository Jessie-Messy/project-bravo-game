// Canopy integrity check — run after ANY change to js/render/trees.js.
//
//   node tools/check_canopy.mjs [/path/to/three/build]
//
// It needs a local copy of three.module.js + addons/utils/BufferGeometryUtils.js
// (the game itself loads three from a CDN importmap, so there is nothing in the
// repo to point at by default). Give it the directory containing `three.module.js`
// with an `addons/utils/` beside it, or set THREE_DIR. It exits non-zero on
// failure so it can gate a commit.
//
// ── Why this exists ─────────────────────────────────────────────────────────
// A canopy is a merged pile of lobes. If a lobe ends up too far from the rest it
// renders as a leaf ball hanging in the sky with nothing under it — and that bug
// is close to invisible in testing, because from the game's usual overhead 3/4
// camera a detached lobe still lands on the crown's footprint and looks fine.
// It shipped that way: four of the five variants had detached lobes (one was in
// three pieces) and every overhead render looked correct. Only a deliberate
// low-angle shot showed it, and only for whichever trees happened to be in frame.
//
// So this checks it exactly, in a second, with no renderer:
//   1. every canopy is ONE connected blob
//   2. every canopy fits the height box the wind shader and game3d assume
//
// ⚠ The segmentation below relies on makeBroadleafCanopy emitting all its masses
// (IcosahedronGeometry detail 1) before all its accents (detail 0), which is what
// gives fixed 240- and 60-vertex runs in the merged buffer. If that build order
// ever changes, this tool silently mis-cuts the lobes — fix the tool with it.
import { readFileSync, mkdtempSync, writeFileSync, copyFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const D1 = 240, D0 = 60;                       // non-indexed icosahedron vert counts
const HEIGHT = 146, RADIUS = 41.3, COUNT = 5;  // what game3d builds (TOPH, TILE*0.86)
const SEED = 20260801;

const threeDir = resolve(process.argv[2] || process.env.THREE_DIR || 'node_modules/three/build');
let threeSrc, bguSrc;
try {
  threeSrc = readFileSync(join(threeDir, 'three.module.js'), 'utf8');
  bguSrc   = readFileSync(join(threeDir, 'addons/utils/BufferGeometryUtils.js'), 'utf8');
} catch {
  console.error(`could not read three from ${threeDir}\n` +
    `pass the directory holding three.module.js (with addons/utils/ beside it), or set THREE_DIR`);
  process.exit(2);
}

// trees.js imports through the game's importmap aliases, which Node cannot
// resolve. Stage a copy with the two specifiers rewritten to relative paths.
const dir = mkdtempSync(join(tmpdir(), 'canopy-'));
writeFileSync(join(dir, 'three.module.js'), threeSrc);
writeFileSync(join(dir, 'BufferGeometryUtils.js'),
  bguSrc.replace(/from ['"]three['"]/g, "from './three.module.js'"));
writeFileSync(join(dir, 'trees.js'),
  readFileSync(new URL('../js/render/trees.js', import.meta.url), 'utf8')
    .replace(/from ['"]three\/addons\/utils\/BufferGeometryUtils\.js['"]/g,
             "from './BufferGeometryUtils.js'"));

const THREE = await import(join(dir, 'three.module.js'));
const { makeBroadleafCanopySet } = await import(join(dir, 'trees.js'));

// Recover the individual lobes from the merged buffer as exact vertex runs.
function lobesOf(geo){
  const pos = geo.attributes.position, n = pos.count;
  let nMass = -1;
  for(let m = 1; m * D1 <= n; m++) if((n - m * D1) % D0 === 0){ nMass = m; break; }
  if(nMass < 0) throw new Error(`cannot segment merged canopy (${n} verts)`);
  const sizes = Array(nMass).fill(D1)
    .concat(Array((n - nMass * D1) / D0).fill(D0));
  const out = []; let o = 0;
  for(const sz of sizes){
    let cx = 0, cy = 0, cz = 0;
    for(let v = o; v < o + sz; v++){ cx += pos.getX(v); cy += pos.getY(v); cz += pos.getZ(v); }
    cx /= sz; cy /= sz; cz /= sz;
    let r = 0;
    for(let v = o; v < o + sz; v++)
      r = Math.max(r, Math.hypot(pos.getX(v)-cx, pos.getY(v)-cy, pos.getZ(v)-cz));
    out.push({ x:cx, y:cy, z:cz, r, big: sz === D1 });
    o += sz;
  }
  return out;
}

// Mirrors makeBroadleafCanopySet: each variant is built at height*hMul, so each
// is measured against its OWN box, not the nominal one.
const HMUL = [0.92, 1.06, 1.00, 0.98, 0.96, 0.86, 1.10, 1.02, 0.94, 0.90];
const pickShape = (i, count) => Math.round(i * HMUL.length / Math.max(1, count)) % HMUL.length;

const set = makeBroadleafCanopySet(THREE, { height:HEIGHT, radius:RADIUS, count:COUNT, seed:SEED });
let fails = 0;

for(let i = 0; i < set.length; i++){
  const g = set[i], L = lobesOf(g);

  // ── connectivity: union-find over lobe overlap ──
  const parent = L.map((_, k) => k);
  const find = a => { while(parent[a] !== a){ parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
  for(let a = 0; a < L.length; a++) for(let b = a + 1; b < L.length; b++){
    const d = Math.hypot(L[a].x-L[b].x, L[a].y-L[b].y, L[a].z-L[b].z);
    // Overlap, not tangency: two lobes kissing at a point still read as detached.
    if(d < (L[a].r + L[b].r) * 0.96) parent[find(a)] = find(b);
  }
  const counts = new Map();
  L.forEach((_, k) => { const r = find(k); counts.set(r, (counts.get(r) || 0) + 1); });
  const connected = counts.size === 1;

  // ── height box ──
  const h = HEIGHT * HMUL[pickShape(i, COUNT)];
  const wantLo = -h * 0.64, wantHi = h * 0.46;
  g.computeBoundingBox();
  const { min, max } = g.boundingBox;
  // A crown a little short of its box only shows a little more trunk; one that
  // OVERFLOWS breaks the wind shader's hFrac assumption, so the two ends get
  // different tolerances.
  const fitOk = min.y > wantLo - 3 && max.y < wantHi + 3 &&
                min.y < wantLo + h * 0.09 && max.y > wantHi - h * 0.09;

  const ok = connected && fitOk;
  if(!ok) fails++;
  console.log(
    `variant ${i}: ${String(L.length).padStart(2)} lobes  ` +
    `y[${min.y.toFixed(1)}, ${max.y.toFixed(1)}] want[${wantLo.toFixed(1)}, ${wantHi.toFixed(1)}]  ` +
    (connected ? 'connected' : `${counts.size} PIECES`) + '  ' +
    (fitOk ? 'fits' : 'OUT OF BOX') + (ok ? '' : '   <-- FAIL')
  );
  if(!connected){
    const main = [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
    for(let k = 0; k < L.length; k++) if(find(k) !== main){
      const l = L[k];
      console.log(`    detached ${l.big ? 'mass  ' : 'accent'} at ` +
                  `(${l.x.toFixed(0)}, ${l.y.toFixed(0)}, ${l.z.toFixed(0)}) r=${l.r.toFixed(1)}`);
    }
  }
}

console.log(fails ? `\nFAIL: ${fails}/${set.length} variants` : `\nPASS: ${set.length}/${set.length} variants`);
process.exit(fails ? 1 : 0);
