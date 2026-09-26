// portals.mjs — every gate is the right colour, leads where it says, and the
// art and the code agree on its shape.
//
// WHY THIS EXISTS. A gate's colour is a promise: red means the far side is
// dangerous (the open-PvP coast, the dungeon), blue means it is safe. A blue
// gate that drops you onto the coast is worse than no colour at all, and it is
// exactly the kind of mistake nobody notices until someone dies to it.
//
// It also pins two "two sources for one number" hazards this project has been
// bitten by before:
//   * the gate's dimensions live in tools/blender/portal.py (which builds the
//     mesh) AND in game3d.js's PORTAL_GEOM (which the vortex rim and the pillar
//     colliders are computed from) — if they drift, the rim glows in mid-air
//     and the colliders stand beside the pillars instead of in them;
//   * the server's world-data.json keeps its own list of portal tiles to
//     validate teleports against — a gate the server does not know about
//     rubber-bands everyone who uses it.
//
// Usage: node tools/test/portals.mjs   (or npm run test:portals)
import fs from 'node:fs';

globalThis.document = {
  createElement: () => ({ width: 0, height: 0, getContext: () => ({}) }),
};
const C = await import('../../js/constants.js');
const W = await import('../../js/world.js');
const S = await import('../../js/state.js');
const { T, DUNGEON_Y0, COAST_Y0 } = C;
const map = S.map;

let fail = 0, checked = 0;
const bad = (m) => { console.log('  FAIL  ' + m); fail++; };
const check = (name, cond, detail) => { checked++; if (!cond) bad(name + (detail ? ' — ' + detail : '')); };

const gates = [];
for (let y = 0; y < map.length; y++)
  for (let x = 0; x < map[y].length; x++)
    if (map[y][x] === T.TELEPORT) gates.push([x, y]);

check('the map has gates', gates.length > 0);

// ── Every gate has a colour ─────────────────────────────────────────
for (const [x, y] of gates) {
  const k = W.portalKind(x, y);
  check(`gate ${x},${y} has a kind`, k === 'red' || k === 'blue', 'got ' + k);
}

// ── ...and the colour tells the truth about the far side ────────────
const region = (y) => y >= COAST_Y0 ? 'coast' : y >= DUNGEON_Y0 ? 'dungeon' : 'mainland';
for (const [k, g] of Object.entries(W.COAST_PORTALS)) {
  const [x, y] = k.split(',').map(Number);
  const kind = W.portalKind(x, y), dest = region(g.sy);
  check(`coast gate ${k} leads to ${g.to}`, (g.to === 'coast') === (dest === 'coast'),
        'its destination tile ' + g.sx + ',' + g.sy + ' is in ' + dest);
  check(`coast gate ${k} is ${dest === 'coast' ? 'red' : 'blue'}`,
        kind === (dest === 'coast' ? 'red' : 'blue'), 'it is ' + kind);
  // arriveNear() looks for a gate within 2 tiles of the landing tile; without
  // one you land on the raw tile, which may be inside the far gate's pillar.
  const near = gates.some(([gx, gy]) => Math.max(Math.abs(gx - g.sx), Math.abs(gy - g.sy)) <= 2);
  check(`coast gate ${k} lands beside a gate`, near, 'no gate within 2 tiles of ' + g.sx + ',' + g.sy);
}
for (const [x, y] of gates) {
  if (W.COAST_PORTALS[x + ',' + y]) continue;
  const kind = W.portalKind(x, y);
  if (y < DUNGEON_Y0)
    check(`overworld cave mouth ${x},${y} is red`, kind === 'red', 'it is ' + kind);
  else if (W.DUNGEON_STAIRS[x + ',' + y])
    check(`dungeon stair ${x},${y} is red`, kind === 'red', 'it is ' + kind);
  else
    check(`dungeon exit ${x},${y} is blue`, kind === 'blue', 'it is ' + kind);
}
check('there is at least one gate of each colour',
      gates.some(([x, y]) => W.portalKind(x, y) === 'red') && gates.some(([x, y]) => W.portalKind(x, y) === 'blue'));

// ── The server knows every gate ─────────────────────────────────────
{
  const wd = JSON.parse(fs.readFileSync('server/world-data.json', 'utf8'));
  const srv = new Set((wd.portals || []).map(([x, y]) => x + ',' + y));
  for (const [x, y] of gates)
    check(`server world-data knows gate ${x},${y}`, srv.has(x + ',' + y),
          'run `node server/build-world-data.mjs` — teleports through it will be refused online');
  check('server world-data has no phantom gates', srv.size === gates.length,
        srv.size + ' on the server vs ' + gates.length + ' in the map');

  // Every place a gate can land you must pass the server's 'portal' rule
  // (bravo-room.js: within 6 tiles of a portal tile or a portalArrivals
  // point). The dungeon entry failed this for as long as it existed.
  const T6 = (x, y, [tx, ty]) => Math.hypot(x - tx, y - ty) < 6;
  const accepted = (x, y) => (wd.portals || []).some(p => T6(x, y, p)) || (wd.portalArrivals || []).some(p => T6(x, y, p));
  const lands = [
    ...Object.values(W.COAST_PORTALS).map(g => ['coast gate to ' + g.to, g.sx, g.sy]),
    ...Object.values(W.DUNGEON_STAIRS).map(s => ['stair to floor ' + s.to, s.sx, s.sy]),
    ['dungeon entry', W.DUNGEON_ENTRY_TILE.x, W.DUNGEON_ENTRY_TILE.y],
    ['city arrival', W.CITY_ARRIVAL.x, W.CITY_ARRIVAL.y],
  ];
  for (const [what, x, y] of lands)
    check(`server accepts landing: ${what} (${x},${y})`, accepted(x, y), 'the teleport would be refused online');
}

// ── The Blender script and the runtime agree on the gate's shape ─────
{
  const py = fs.readFileSync('tools/blender/portal.py', 'utf8');
  const js = fs.readFileSync('js/game3d.js', 'utf8');
  const pyNum = (name) => { const m = py.match(new RegExp('^' + name + '\\s*=\\s*([\\d.]+)', 'm')); return m ? +m[1] : NaN; };
  const geo = js.match(/const PORTAL_GEOM\s*=\s*\{([^}]*)\}/);
  check('game3d.js declares PORTAL_GEOM', !!geo);
  if (geo) {
    const jsNum = (k) => { const m = geo[1].match(new RegExp('\\b' + k + '\\s*:\\s*([\\d.]+)')); return m ? +m[1] : NaN; };
    const A = pyNum('A'), HS = pyNum('HS'), PW = pyNum('PW');
    for (const [k, v] of [['A', A], ['HS', HS], ['PW', PW], ['R', 2 * A]])
      check(`PORTAL_GEOM.${k} matches portal.py`, Math.abs(jsNum(k) - v) < 1e-6, `js ${jsNum(k)} vs blender ${v}`);
  }
}

// ── The baked model exists and carries what the runtime looks up ────
{
  const f = 'models/portal_gate.glb';
  check('models/portal_gate.glb is baked', fs.existsSync(f), 'run `npm run assets`');
  if (fs.existsSync(f)) {
    const b = fs.readFileSync(f), len = b.readUInt32LE(12);
    const j = JSON.parse(b.subarray(20, 20 + len).toString());
    const names = new Set(j.nodes.map(n => n.name));
    for (const n of ['Stone', 'Runes', 'Surface', 'Shards'])
      check(`portal_gate.glb has a ${n} node`, names.has(n), 'the runtime adds meshes by these names');
    const stone = j.meshes.find(m => m.name === 'Stone');
    check('portal_gate Stone carries vertex colours',
          !!(stone && stone.primitives[0].attributes.COLOR_0),
          'without COLOR_0 the stone renders white');
  }
}

console.log(gates.length + ' gates: ' + gates.map(([x, y]) => x + ',' + y + ':' + W.portalKind(x, y)[0]).join(' '));
console.log('\n' + checked + ' checks, ' + fail + ' failure' + (fail === 1 ? '' : 's'));
process.exit(fail ? 1 : 0);
