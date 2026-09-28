// buildings.mjs — the procedural town (js/render/buildings.js).
//
// WHY THIS EXISTS. The buildings are pure geometry with nothing to catch a
// mistake but eyes: round 1 shipped doors lower than the character and glass
// buried INSIDE the solid walls (never visible, never lit at night), and both
// looked "fine" in code review. These checks pin the things a screenshot tour
// only catches by luck.
//
// Usage: node tools/test/buildings.mjs   (or npm run test:buildings)
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildTown } from '../../js/render/buildings.js';   // takes THREE as an argument; imports nothing

// No three in node_modules (the game uses a CDN import map): borrow the platform
// build's vendored copy, staged beside a {"type":"module"} package.json — see
// dressing.mjs for why.
const VENDOR = 'C:/Users/Arnol/Desktop/Server Migration/ORION_GUILD_WEBSITE_WORKING_FOLDER/orion-platform/public/games/medieval/vendor';
if (!fs.existsSync(VENDOR + '/three.module.js')) { console.error('SKIP: vendored three not found at ' + VENDOR); process.exit(0); }
const tmp = path.join(os.tmpdir(), 'bravo-buildings-test');
fs.mkdirSync(tmp, { recursive: true });
fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}');
fs.copyFileSync(VENDOR + '/three.module.js', path.join(tmp, 'three.module.js'));
const THREE = await import(pathToFileURL(path.join(tmp, 'three.module.js')).href);

let fail = 0, checked = 0;
const check = (name, cond, detail) => { checked++; if (!cond) { console.log('  FAIL  ' + name + (detail ? ' — ' + detail : '')); fail++; } };

const TILE = 48, CHAR_H = 126;
const ground = (x, z) => Math.sin(x * 0.01) * 6 + Math.cos(z * 0.013) * 4;   // gently uneven
const ring = (x0, y0, x1, y1, doors) => ({ x0, y0, x1, y1, doors });
const buildings = [
  ring(10, 10, 15, 14, [{ tx: 12, ty: 14, side: 's' }]),                  // town house
  ring(30, 10, 38, 16, [{ tx: 34, ty: 10, side: 'n' }, { tx: 34, ty: 16, side: 's' }]),   // bank-sized
  ring(50, 10, 53, 13, [{ tx: 50, ty: 12, side: 'w' }]),                  // small
  ring(10, 200, 14, 204, [{ tx: 12, ty: 204, side: 's' }]),               // coast hut
];
const G = buildTown(THREE, { buildings, TILE, groundAt: ground, coastY0: 150, signs: [{ tx: 12, ty: 14, icon: 4 }] });

for (const k of ['stone', 'plaster', 'timber', 'boards', 'glass', 'glassLit', 'roof', 'thatch', 'floor', 'shadow', 'spill', 'doorGlow'])
  check(`geometry "${k}" is produced`, !!G[k]);

// No NaN anywhere; every face's winding agrees with its normal.
for (const [k, g] of Object.entries(G)) {
  if (!g || !g.isBufferGeometry) continue;
  const p = g.attributes.position.array, n = g.attributes.normal.array, idx = g.index.array;
  check(`${k}: no NaN positions`, !p.some(Number.isNaN));
  let bad = 0;
  for (let i = 0; i < idx.length; i += 3) {
    const [a, b, c] = [idx[i], idx[i + 1], idx[i + 2]].map(j => new THREE.Vector3(p[j*3], p[j*3+1], p[j*3+2]));
    const cr = new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a));
    if (cr.lengthSq() < 1e-6) continue;                                 // degenerate (gable apex pair)
    const nn = new THREE.Vector3(n[idx[i]*3], n[idx[i]*3+1], n[idx[i]*3+2]);
    if (cr.dot(nn) < 0) bad++;
  }
  check(`${k}: winding matches normals`, bad === 0, bad + ' faces inside out');
}

// Doors: the timber posts either side of every doorway reach DOOR height,
// which must clear the character with headroom.
{
  const p = G.timber.attributes.position.array;
  let maxY = -1e9;
  const d = buildings[0].doors[0], x0 = d.tx * TILE, x1 = x0 + TILE, z = (d.ty + 1) * TILE;
  for (let i = 0; i < p.length; i += 3)
    if (p[i] > x0 && p[i] < x0 + 8 && Math.abs(p[i + 2] - z) < 8) maxY = Math.max(maxY, p[i + 1]);
  const G0 = Math.max(...[0, 1, 2, 3, 4, 5, 6].flatMap(i => [0, 1, 2, 3, 4].map(j => ground((10 + i) * TILE, (10 + j) * TILE))));
  check('door posts clear the character by 20+', maxY - G0 >= CHAR_H + 20, 'post top ' + (maxY - G0).toFixed(0) + ' above floor');
}

// Glass must be at or in front of the wall face, never buried in it: the walls
// are solid, so no glass vertex may lie strictly inside any footprint — except
// the glow panel set back inside each open doorway, which is in the door TILE
// (a passage, not wall).
for (const k of ['glass', 'glassLit']) {
  const p = G[k].attributes.position.array;
  let buried = 0;
  for (let i = 0; i < p.length; i += 3) for (const b of buildings) {
    const X0 = b.x0 * TILE, X1 = (b.x1 + 1) * TILE, Z0 = b.y0 * TILE, Z1 = (b.y1 + 1) * TILE;
    const inDoorTile = b.doors.some(d => p[i] >= d.tx*TILE && p[i] <= (d.tx + 1)*TILE && p[i + 2] >= d.ty*TILE && p[i + 2] <= (d.ty + 1)*TILE);
    if (!inDoorTile && p[i] > X0 + 0.3 && p[i] < X1 - 0.3 && p[i + 2] > Z0 + 0.3 && p[i + 2] < Z1 - 0.3) buried++;
  }
  check(`${k}: no glass buried inside a solid wall`, buried === 0, buried + ' vertices');
}

// The coast hut is thatched: thatch geometry lies over it, and no tiled roof does.
{
  const b = buildings[3], X0 = b.x0 * TILE, X1 = (b.x1 + 1) * TILE, Z0 = b.y0 * TILE, Z1 = (b.y1 + 1) * TILE;
  const over = (g) => { const p = g.attributes.position.array; let n = 0;
    for (let i = 0; i < p.length; i += 3) if (p[i] >= X0 - 40 && p[i] <= X1 + 40 && p[i + 2] >= Z0 - 40 && p[i + 2] <= Z1 + 40) n++; return n; };
  check('the coast hut is thatched', over(G.thatch) > 0);
  check('the coast hut has no tiled roof', over(G.roof) === 0);
}

// The shop sign: exactly one board (two faces, 8 vertices), its UVs inside the
// icon's atlas cell (4 = row 1, col 1 of 3x2), hung above head height.
{
  const g = G.sign, uv = g.attributes.uv.array, p = g.attributes.position.array;
  check('one shop sign is built', g.attributes.position.count === 8, g.attributes.position.count + ' vertices');
  let inCell = true;
  for (let i = 0; i < uv.length; i += 2) if (uv[i] < 1/3 - 1e-6 || uv[i] > 2/3 + 1e-6 || uv[i + 1] > 0.5 + 1e-6) inCell = false;
  check('the sign samples only its own atlas cell', inCell);
  let minY = Infinity; for (let i = 1; i < p.length; i += 3) minY = Math.min(minY, p[i]);
  check('the sign hangs clear of a walking head', minY - ground(12 * TILE, 14 * TILE) > CHAR_H - 20);
}

// Street furniture comes back as colliders, and none of it blocks a doorway.
{
  check('props are returned as colliders', Array.isArray(G.props) && G.props.every(q => q.r > 0 && Number.isFinite(q.x)));
  let blocked = 0;
  for (const b of buildings) for (const d of b.doors) {
    const cx = (d.tx + 0.5) * TILE, cz = (d.ty + 0.5) * TILE;
    for (const q of G.props) if (Math.hypot(q.x - cx, q.z - cz) < q.r + TILE * 0.5) blocked++;
  }
  check('no prop stands in a doorway', blocked === 0, blocked + ' props');
}

// Roof pieces carry their building id (so they can be lifted off); walls do not.
{
  const bid = G.roof.attributes.aBid.array;
  check('every roof vertex carries a building id', !Array.prototype.some.call(bid, v => v < 0));
  const sb = G.stone.attributes.aBid.array;
  check('some stone (the walls) is never hidden', Array.prototype.some.call(sb, v => v === -1));
}

console.log('\n' + checked + ' checks, ' + fail + ' failure' + (fail === 1 ? '' : 's'));
process.exit(fail ? 1 : 0);
