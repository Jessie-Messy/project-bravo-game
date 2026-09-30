// city.mjs — Lunar City ×2.5 and the map expansion (js/city.js, js/world.js).
//
// Pins what the move and the rescale must never break:
// - constants.js's CITY rect agrees with the city plan (both are read; one
//   going stale moves the safe zone off the city);
// - you can walk from the spawn to every shopkeeper, into every building, out
//   of every gate, to the coast gate and back into the original map;
// - every building's walls are ONE ring (two doors in line cut the bank in two,
//   and the builder drew two houses side by side);
// - the east strip is really there: the map is wider and the road reaches it.
//
// Usage: node tools/test/city.mjs   (or npm run test:city)
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.window = globalThis;
const fakeCtx = new Proxy(function(){}, { get: (t, k) => k === 'measureText' ? (() => ({ width: 0 })) : fakeCtx, apply: () => fakeCtx, set: () => true });
const fakeCanvas = new Proxy({ getContext: () => fakeCtx, style: {}, width: 0, height: 0 }, { get: (t, k) => k in t ? t[k] : (() => fakeCanvas), set: (t, k, v) => (t[k] = v, true) });
globalThis.document = { createElement: () => fakeCanvas, getElementById: () => null, addEventListener() {}, body: { appendChild() {} } };
globalThis.Image = function () {};

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const imp = p => import(pathToFileURL(path.join(root, p)).href);
const { map } = await imp('js/state.js');
const C = await imp('js/constants.js');
await imp('js/world.js');
const city = await imp('js/city.js');
const { T, BLOCKING, CITY, MAP_W, MAP_H, MAIN_W } = C;

let fail = 0, checked = 0;
const check = (name, cond, detail) => { checked++; if (!cond) { console.log('  FAIL  ' + name + (detail ? ' — ' + detail : '')); fail++; } };

check('the map grew east', MAP_W === 680 && MAIN_W === 480 && map[0].length === MAP_W, MAP_W + ' / ' + map[0].length);
const R = city.CITY_RECT;
check('constants CITY equals the city plan', CITY.x1 === R.x1 && CITY.y1 === R.y1 && CITY.x2 === R.x2 && CITY.y2 === R.y2,
  JSON.stringify(CITY) + ' vs ' + JSON.stringify(R));
check('the city is in the east strip', R.x1 >= MAIN_W && R.x2 < MAP_W - 5, R.x1 + '..' + R.x2);
check('the city is ×2.5 (≥150 across)', R.x2 - R.x1 + 1 >= 150);

const walk = (x, y) => map[y] && map[y][x] !== undefined && !BLOCKING[map[y][x]];
const sp = city.CITY_SPOTS.spawn;
check('the spawn is walkable', walk(sp.x, sp.y));

// Everything reachable on foot from the spawn.
const seen = new Uint8Array(MAP_W * MAP_H), q = [[sp.x, sp.y]]; seen[sp.y * MAP_W + sp.x] = 1;
while (q.length) {
  const [x, y] = q.pop();
  for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const nx = x + dx, ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= MAP_W || ny >= MAP_H || seen[ny * MAP_W + nx] || !walk(nx, ny)) continue;
    seen[ny * MAP_W + nx] = 1; q.push([nx, ny]);
  }
}
const reach = p => seen[p.y * MAP_W + p.x] === 1;
for (const [role, p] of Object.entries(city.CITY_SPOTS)) {
  if (role === 'coastGate') continue;   // the gate tile itself is a TELEPORT (walkable), checked below
  check('reach ' + role, reach(p), JSON.stringify(p));
}
for (const b of city.CITY_BUILDINGS) {
  check('into the ' + b.role + ' at ' + b.x0 + ',' + b.y0, reach(b.doorIn));
  // a shopkeeper stands inside their own house
  const s = city.CITY_SPOTS[b.role === 'bank' ? 'banker' : b.role];
  if (s) check(b.role + ' stands inside their building', s.x > b.x0 && s.x < b.x1 && s.y > b.y0 && s.y < b.y1, JSON.stringify(s));
  // the wall ring is one piece
  const isW = (x, y) => x >= b.x0 && x <= b.x1 && y >= b.y0 && y <= b.y1 && map[y][x] === T.WALL;
  let start = null; for (let x = b.x0; x <= b.x1 && !start; x++) if (isW(x, b.y0)) start = [x, b.y0];
  const vis = new Set([start + '']), st = [start]; let total = 0;
  for (let y = b.y0; y <= b.y1; y++) for (let x = b.x0; x <= b.x1; x++) if (isW(x, y)) total++;
  while (st.length) { const [x, y] = st.pop();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const k = (x + dx) + ',' + (y + dy);
      if (isW(x + dx, y + dy) && !vis.has(k)) { vis.add(k); st.push([x + dx, y + dy]); } } }
  check(b.role + ' walls are one ring', vis.size === total, vis.size + '/' + total);
}
const c = city.CITY_C, H = city.CITY_HALF;
for (const [n, g] of [['north gate', { x: c.x, y: R.y1 - 1 }], ['south gate', { x: c.x, y: R.y2 + 1 }], ['west gate', { x: R.x1 - 1, y: c.y }]])
  check('out of the ' + n, reach(g), JSON.stringify(g));
const cg = city.CITY_SPOTS.coastGate;
check('the coast gate is a portal', map[cg.y][cg.x] === T.TELEPORT);
check('reach the coast gate', [[1, 0], [-1, 0], [0, 1], [0, -1]].some(([dx, dy]) => reach({ x: cg.x + dx, y: cg.y + dy })));
check('walk back into the original map', reach({ x: 460, y: 300 }) || reach({ x: 460, y: 301 }) || reach({ x: 460, y: 299 }));

console.log('\n' + checked + ' checks, ' + fail + ' failure' + (fail === 1 ? '' : 's'));
process.exit(fail ? 1 : 0);
