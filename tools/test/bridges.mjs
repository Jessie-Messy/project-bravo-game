// bridges.mjs — river bridges (js/render/bridges.js).
//
// Pins what went wrong before the remake and what the remake promises:
// a bridge that stops short of the bank after the rivers are widened (the
// "raft mid-river" of v0.22.0), a deck that starts under the water, a step
// where the deck meets the road, a trunk left standing on the deck, and a
// railing that lets you walk off the side.
//
// Usage: node tools/test/bridges.mjs   (or npm run test:bridges)
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { findBridgeSpans, extendBridgeSpans, shapeBridgeSpans, makeDeckLookup, deckY, buildBridges } from '../../js/render/bridges.js';

let fail = 0, checked = 0;
const check = (name, cond, detail) => { checked++; if (!cond) { console.log('  FAIL  ' + name + (detail ? ' — ' + detail : '')); fail++; } };

const T = { GRASS: 0, PATH: 1, WATER: 2, TREE: 3, STONE: 4, BRIDGE: 6, SHALLOWS: 14 };
const TILE = 48, W = 60, H = 50, WATER_Y = 2;

// A river running east-west at rows 20-22, a road north-south in columns
// 30-31 crossing it on bridge tiles, and a one-tile footbridge at column 45.
const map = [];
for (let y = 0; y < H; y++) map.push(new Array(W).fill(T.GRASS));
for (let y = 0; y < H; y++) { map[y][30] = T.PATH; map[y][31] = T.PATH; }
for (let y = 20; y <= 22; y++) for (let x = 0; x < W; x++)
  map[y][x] = (x === 30 || x === 31 || x === 45) ? T.BRIDGE : T.WATER;
map[16][32] = T.TREE;                               // beside the north ramp
const src = map.map(r => r.slice());
// "Widen" the river three tiles a bank, skipping bridges (what game3d does).
for (let y = 17; y <= 25; y++) for (let x = 0; x < W; x++)
  if (map[y][x] === T.GRASS || map[y][x] === T.PATH) map[y][x] = T.WATER;
map[23][29] = T.TREE;                               // an island tree beside the span

const spans = findBridgeSpans(map, T, src);
check('two spans found', spans.length === 2, spans.length + '');
const road = spans.find(s => s.c0 <= 30 && s.c1 >= 31), foot = spans.find(s => s !== road);
check('the road bridge crosses north-south', road && road.axis === 'y', road && road.axis);
extendBridgeSpans(map, T, spans);
check('the road bridge reaches both banks', road.a0 === 17 && road.a1 === 25, road.a0 + '..' + road.a1);
let wetUnder = 0;
for (let y = 17; y <= 25; y++) for (const x of [30, 31]) if (map[y][x] !== T.BRIDGE) wetUnder++;
check('every tile under the road bridge is BRIDGE', wetUnder === 0, wetUnder + ' tiles');
check('the landings are dry road', [15, 16, 26, 27].every(y => map[y][30] === T.PATH && map[y][31] === T.PATH));
check('the footbridge is widened to three tiles (v0.24 ×1.5)', foot && foot.c1 - foot.c0 === 2, foot && (foot.c0 + '..' + foot.c1));
check('the road bridge is widened to three tiles', road.c1 - road.c0 === 2, road.c0 + '..' + road.c1);
check('no tree beside the span', map[23][29] !== T.TREE && map[16][32] !== T.TREE);

// Ground: the banks slope down to -6 at the water's edge (below the surface,
// as they do in game), the bed drops to -90 mid-river.
const ground = (wx, wz) => {
  const ty = wz / TILE;
  if (ty < 17) return Math.min(30, -6 + (17 - ty) * 6);
  if (ty > 26) return Math.min(30, -6 + (ty - 26) * 6);
  const m = Math.min(ty - 17, 26 - ty);
  return -6 - Math.min(84, m * 30);
};
shapeBridgeSpans(spans, { TILE, groundAt: ground, waterY: WATER_Y });
const deckAt = makeDeckLookup(spans, { TILE, W, H });
const cx = road.cc;                                  // road bridge centre line
check('the deck meets the road with no step (north)', Math.abs(deckAt(cx, road.S0 + 0.01) - ground(cx, road.S0)) < 0.5,
  deckAt(cx, road.S0 + 0.01) + ' vs ' + ground(cx, road.S0));
check('the deck meets the road with no step (south)', Math.abs(deckAt(cx, road.S1 - 0.01) - ground(cx, road.S1)) < 0.5);
let low = Infinity, jump = 0, prev = null;
for (let s = road.S0; s <= road.S1; s += 1) {
  const d = deckAt(cx, s); if (prev !== null) jump = Math.max(jump, Math.abs(d - prev)); prev = d;
  if (s >= road.sA && s <= road.sB) low = Math.min(low, d);
}
check('the deck is clear of the water over the whole river', low >= WATER_Y + 12 - 1e-6, 'lowest ' + low.toFixed(1));
check('the deck is smooth (no step over 2 per unit)', jump < 2, jump.toFixed(2));
check('no deck beyond the rails', deckAt(cx + road.hw + 2, (road.sA + road.sB) / 2) === null);
check('deckY and the lookup agree', Math.abs(deckAt(cx, road.sA + 30) - deckY(road, road.sA + 30)) < 1e-9);

// Build needs three; it is vendored with the platform build.
const VENDOR = 'C:/Users/Arnol/Desktop/Server Migration/ORION_GUILD_WEBSITE_WORKING_FOLDER/orion-platform/public/games/medieval/vendor';
if (!fs.existsSync(VENDOR + '/three.module.js')) {
  console.log('  (skipping the build checks: vendored three not found)');
} else {
  const tmp = path.join(os.tmpdir(), 'bravo-bridges-test');
  fs.mkdirSync(tmp, { recursive: true });
  fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}');
  fs.copyFileSync(VENDOR + '/three.module.js', path.join(tmp, 'three.module.js'));
  const THREE = await import(pathToFileURL(path.join(tmp, 'three.module.js')).href);
  const grey = [0.5, 0.5, 0.5];
  const b = buildBridges(THREE, spans, { TILE, groundAt: ground, waterY: WATER_Y,
    colors: { plank: grey, beam: grey, post: grey, rail: grey, stone: grey } });
  const wp = b.wood.attributes.position.array, sp = b.stone.attributes.position.array;
  check('timber and stone are built', wp.length > 3000 && sp.length > 300, wp.length + ' / ' + sp.length);
  check('no NaN in the geometry', !wp.some(Number.isNaN) && !sp.some(Number.isNaN));
  // railings: colliders sit outside the walkway on both sides, along the whole deck
  const rc = b.colliders.filter(c => Math.abs(c.x - cx) < road.hw + 10);
  const inside = rc.filter(c => Math.abs(c.x - cx) < road.hw);
  check('rail colliders on both sides', rc.some(c => c.x < cx) && rc.some(c => c.x > cx), rc.length + '');
  check('no collider inside the walkway', inside.length === 0, inside.length + '');
  // a 13-radius player walking the centre line is never blocked
  const blocks = rc.filter(c => Math.abs(c.x - cx) < c.r + 13);
  check('a player fits between the rails', blocks.length === 0);
  let gap = 0; const north = rc.filter(c => c.x < cx).map(c => c.y).sort((a, b) => a - b);
  for (let i = 1; i < north.length; i++) gap = Math.max(gap, north[i] - north[i - 1]);
  check('no gap in the rail a player could slip through', gap < 2 * (4 + 13), gap + '');
}

console.log('\n' + checked + ' checks, ' + fail + ' failure' + (fail === 1 ? '' : 's'));
process.exit(fail ? 1 : 0);
