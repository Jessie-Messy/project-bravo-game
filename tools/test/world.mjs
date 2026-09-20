// world.mjs — headless checks on the generated world.
//
// WHY THIS EXISTS. world.js generates the whole map at import time from fixed
// seeds, so it is completely testable without a browser — and the failures it
// can produce are exactly the kind you do not notice by walking around:
//
//   * a tile id with no BLOCKING entry reads `undefined`, which is falsy, so a
//     wall you meant to be solid is quietly walkable everywhere in the game;
//   * a region whose landing point is not connected to its own content is a
//     player stranded on a pier with no way off, and you only find out by
//     sailing there;
//   * a generator tweak that eats the village, or seals the plots behind rock,
//     changes nothing that throws.
//
// Usage: node tools/test/world.mjs   (or npm run test:world)

// state.js touches document.createElement for an offscreen canvas. Stub the
// two calls it makes rather than pulling in a DOM: nothing under test draws.
globalThis.document = {
  createElement: () => ({ width: 0, height: 0, getContext: () => ({}) }),
};

const C = await import('../../js/constants.js');
const W = await import('../../js/world.js');
const S = await import('../../js/state.js');

const { T, BLOCKING, MAP_W, MAP_H, TERRAIN_MAP_H,
        COAST_X0, COAST_Y0, COAST_W, COAST_H, COAST_LANDING,
        DUNGEON_X0, DUNGEON_Y0, CITY } = C;
const map = S.map;

let fail = 0, checked = 0;
const bad  = (m) => { console.log('  FAIL  ' + m); fail++; };
const check = (name, cond, detail) => { checked++; if (!cond) bad(name + (detail ? ' — ' + detail : '')); };

const NAME = Object.fromEntries(Object.entries(T).map(([k, v]) => [v, k]));

// ── The array itself ────────────────────────────────────────────────
check('map has MAP_H rows', map.length === MAP_H, map.length + ' rows, expected ' + MAP_H);
let ragged = 0;
for (let y = 0; y < MAP_H; y++) if (!map[y] || map[y].length !== MAP_W) ragged++;
check('every row is MAP_W wide', ragged === 0, ragged + ' ragged rows');
check('TERRAIN_MAP_H <= MAP_H', TERRAIN_MAP_H <= MAP_H);

// ── Every tile id in the world is declared, and has a BLOCKING entry ──
// This is the one that bites silently: an id with no BLOCKING entry reads
// undefined, which is falsy, so the tile is walkable no matter what it is.
const seen = new Map();
for (let y = 0; y < MAP_H; y++) for (let x = 0; x < MAP_W; x++) {
  const t = map[y][x];
  seen.set(t, (seen.get(t) || 0) + 1);
}
for (const id of seen.keys()) {
  check('tile id ' + id + ' is declared in T', NAME[id] !== undefined,
        'found ' + seen.get(id) + ' of it');
  check('tile ' + (NAME[id] || id) + ' has a BLOCKING entry',
        Object.prototype.hasOwnProperty.call(BLOCKING, id),
        'undefined reads as falsy, so it would be walkable');
}

// ── The overworld and the dungeon are still there ───────────────────
// The coast generator writes into the same array; a bad loop bound would
// scribble over them and nothing would complain.
let cityWall = 0;
for (let y = CITY.y1; y <= CITY.y2; y++)
  for (let x = CITY.x1; x <= CITY.x2; x++) if (map[y][x] === T.WALL) cityWall++;
check('Lunar City walls intact', cityWall > 200, 'only ' + cityWall + ' WALL tiles in the city box');

let dungeonFloor = 0;
for (let y = DUNGEON_Y0; y < DUNGEON_Y0 + 64; y++)
  for (let x = DUNGEON_X0; x < DUNGEON_X0 + 64; x++) if (map[y][x] === T.CAVE_FLOOR) dungeonFloor++;
check('dungeon floor 1 intact', dungeonFloor > 300, 'only ' + dungeonFloor + ' CAVE_FLOOR tiles');

// ── Band separation ─────────────────────────────────────────────────
let sep = 0, sepBad = 0;
for (let y = TERRAIN_MAP_H; y < COAST_Y0; y++)
  for (let x = 0; x < MAP_W; x++) { sep++; if (map[y][x] !== T.CAVE_WALL) sepBad++; }
check('separator rows are solid', sepBad === 0, sepBad + ' of ' + sep + ' rows 554-559 are walkable');

let outside = 0;
for (let y = COAST_Y0; y < COAST_Y0 + COAST_H; y++)
  for (let x = COAST_X0 + COAST_W; x < MAP_W; x++) if (map[y][x] !== T.CAVE_WALL) outside++;
check('coast band is sealed east of the region', outside === 0,
      outside + ' unauthored open tiles east of x' + (COAST_X0 + COAST_W));

// ── The coast has the mix it is supposed to have ────────────────────
const coastCount = {};
for (let y = COAST_Y0; y < COAST_Y0 + COAST_H; y++)
  for (let x = COAST_X0; x < COAST_X0 + COAST_W; x++) {
    const n = NAME[map[y][x]] || map[y][x];
    coastCount[n] = (coastCount[n] || 0) + 1;
  }
for (const want of ['WATER', 'SHALLOWS', 'SAND', 'GRASS', 'CLIFF', 'TREE', 'DOCK', 'WALL', 'PATH'])
  check('coast contains ' + want, (coastCount[want] || 0) > 0, 'none generated');
check('coast beach is a beach, not a token strip', (coastCount.SAND || 0) > 400,
      'only ' + (coastCount.SAND || 0) + ' SAND tiles');
check('coast sea is a sea', (coastCount.WATER || 0) > 1500, 'only ' + (coastCount.WATER || 0) + ' WATER tiles');

// ── The landing is a pier head, and you can get off it ──────────────
const landTile = map[COAST_LANDING.y] && map[COAST_LANDING.y][COAST_LANDING.x];
check('COAST_LANDING is a DOCK tile', landTile === T.DOCK,
      'it is ' + (NAME[landTile] || landTile) + ' at ' + COAST_LANDING.x + ',' + COAST_LANDING.y);

// Flood fill from the landing over everything a player may stand on.
const walkable = t => BLOCKING[t] === false;
const key = (x, y) => y * MAP_W + x;
const reach = new Set();
{
  const q = [[COAST_LANDING.x, COAST_LANDING.y]];
  if (walkable(landTile)) reach.add(key(COAST_LANDING.x, COAST_LANDING.y));
  while (q.length) {
    const [x, y] = q.pop();
    for (const [dx, dy] of [[1,0],[-1,0],[0,1],[0,-1]]) {
      const nx = x + dx, ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= MAP_W || ny >= MAP_H) continue;
      const k = key(nx, ny);
      if (reach.has(k)) continue;
      if (!walkable(map[ny][nx])) continue;
      reach.add(k); q.push([nx, ny]);
    }
  }
}
check('the landing reaches a real amount of the region', reach.size > 2000,
      'flood fill from the pier head reached only ' + reach.size + ' tiles — the player would be stranded');

// It must NOT reach the mainland: the bands are supposed to be separate, and a
// leak would let you walk to the coast and skip the boat entirely.
let leaked = 0;
for (const k of reach) if (Math.floor(k / MAP_W) < COAST_Y0) leaked++;
check('the coast does not leak into the overworld or dungeon', leaked === 0,
      leaked + ' reachable tiles above y' + COAST_Y0 + ' — the band separator has a hole');

// ── The village is reachable from the landing ───────────────────────
const V = W.COAST_VILLAGE;
let villagePath = 0, villageReached = 0;
for (let y = V.y; y < V.y + V.h; y++) for (let x = V.x; x < V.x + V.w; x++) {
  if (map[y][x] !== T.PATH) continue;
  villagePath++;
  if (reach.has(key(x, y))) villageReached++;
}
check('Saltmere village has paths', villagePath > 20, 'only ' + villagePath);
check('the village is reachable from the boat', villageReached > 20,
      villageReached + ' of ' + villagePath + ' village path tiles reachable from the pier');

let huts = 0;
for (let y = V.y; y < V.y + V.h; y++) for (let x = V.x; x < V.x + V.w; x++) if (map[y][x] === T.WALL) huts++;
check('village huts were built', huts > 60, 'only ' + huts + ' WALL tiles in the village');

// ── House plots ─────────────────────────────────────────────────────
check('house plots were placed', W.COAST_HOUSE_PLOTS.length >= 3,
      'only ' + W.COAST_HOUSE_PLOTS.length);
for (const p of W.COAST_HOUSE_PLOTS) {
  let blockedIn = 0, reachedEdge = 0;
  for (let ly = 0; ly < p.size; ly++) for (let lx = 0; lx < p.size; lx++) {
    const t = map[p.y + ly][p.x + lx];
    if (BLOCKING[t] !== false) blockedIn++;
    if (reach.has(key(p.x + lx, p.y + ly))) reachedEdge++;
  }
  check('plot ' + p.x + ',' + p.y + ' is clear', blockedIn === 0, blockedIn + ' blocking tiles inside it');
  check('plot ' + p.x + ',' + p.y + ' is reachable', reachedEdge > 0, 'walled off from the landing');
}

// ── Piers ───────────────────────────────────────────────────────────
check('pier tiles were recorded', W.COAST_DOCK_TILES.length > 15,
      'only ' + W.COAST_DOCK_TILES.length);
let dockMismatch = 0;
for (const d of W.COAST_DOCK_TILES) if (map[d.y][d.x] !== T.DOCK) dockMismatch++;
check('every recorded pier tile is still DOCK', dockMismatch === 0,
      dockMismatch + ' were overwritten after being recorded');

console.log('\ncoast tile mix: ' + JSON.stringify(coastCount));
console.log('reachable from the landing: ' + reach.size + ' tiles');
console.log('\n' + checked + ' checks, ' + fail + ' failure' + (fail === 1 ? '' : 's'));
process.exit(fail ? 1 : 0);
