// build-world-data.mjs — regenerates server/world-data.json from the game's
// own map modules + world_edits.json, so the server's mob AI walks the same
// world the clients render. Re-run after editing the world:
//   node server/build-world-data.mjs
import { writeFileSync, readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

// minimal browser shims so the pure-data game modules import cleanly in Node
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
globalThis.window = globalThis;
const fakeCtx = new Proxy(function(){}, {
  get: (t, k) => k === 'measureText' ? (() => ({ width: 0 })) : fakeCtx,
  apply: () => fakeCtx, set: () => true,
});
const fakeCanvas = new Proxy({ getContext: () => fakeCtx, style: {}, width: 0, height: 0 }, {
  get: (t, k) => k in t ? t[k] : (() => fakeCanvas), set: (t, k, v) => (t[k] = v, true),
});
globalThis.document = {
  createElement: () => fakeCanvas, getElementById: () => null,
  addEventListener: () => {}, body: { appendChild: () => {} }, head: { appendChild: () => {} },
};

const { map, HEALER, WORLD_HEALERS, customTileDefs } = await import(pathToUrl('js/state.js'));
const { T, BLOCKING, MAP_W, MAP_H, CITY,
        COAST_Y0, NOTO_BAD_AT, NOTO_DECAY_MS, COMBAT_WINDOW_MS,
      } = await import(pathToUrl('js/constants.js'));
const { WOLF_SPAWNS, BANDIT_SPAWNS, COAST_SAFE_ZONE, PORTAL_ARRIVALS } = await import(pathToUrl('js/world.js'));

function pathToUrl(p) { return 'file:///' + path.join(root, p).replace(/\\/g, '/'); }

// apply world_edits.json the same way the client does (map overrides)
const wePath = path.join(root, 'world_edits.json');
if (existsSync(wePath)) {
  try {
    const we = JSON.parse(readFileSync(wePath, 'utf8'));
    if (we.map) for (const [key, t] of Object.entries(we.map)) {
      const [x, y] = key.split(',').map(Number);
      if (map[y] && typeof map[y][x] === 'number') map[y][x] = t;
    }
    console.log('applied world_edits.json map overrides:', we.map ? Object.keys(we.map).length : 0);
  } catch (e) { console.warn('world_edits.json not applied:', e.message); }
}

const custom = customTileDefs || {};
const bits = new Uint8Array(Math.ceil(MAP_W * MAP_H / 8));
for (let y = 0; y < MAP_H; y++) for (let x = 0; x < MAP_W; x++) {
  const t = map[y][x];
  const blocked = BLOCKING[t] === true || (t >= 100 && custom[t] && custom[t].boxH > 0);
  if (blocked) { const i = y * MAP_W + x; bits[i >> 3] |= (1 << (i & 7)); }
}
const portals = [];
for (let y = 0; y < MAP_H; y++) for (let x = 0; x < MAP_W; x++)
  if (map[y][x] === T.TELEPORT) portals.push([x, y]);

const out = {
  mapW: MAP_W, mapH: MAP_H, tile: 48,
  walkB64: Buffer.from(bits).toString('base64'),
  wolfSpawns: WOLF_SPAWNS, banditSpawns: BANDIT_SPAWNS,
  portals,
  // Landing points that are not beside a portal tile (dungeon floor 1's entry,
  // the city square). The 'portal' teleport check accepts these too.
  portalArrivals: PORTAL_ARRIVALS.map(p => [p.x, p.y]),
  healers: [[HEALER.x, HEALER.y]].concat(WORLD_HEALERS.map(h => [h.x, h.y])),
  city: CITY,
  // ── Region rules, copied straight out of js/constants.js ──
  // The server reads these from here rather than retyping them, for the same
  // reason it stopped retyping MAP_H: two sources for one number means the
  // second goes stale and the disagreement is silent. COAST_SAFE_ZONE comes from
  // world.js because only the generator knows where the village ended up.
  rules: {
    coastY0: COAST_Y0,
    notoBadAt: NOTO_BAD_AT,
    notoDecayMs: NOTO_DECAY_MS,
    combatWindowMs: COMBAT_WINDOW_MS,
    coastSafeZone: { ...COAST_SAFE_ZONE },
  },
};
writeFileSync(path.join(here, 'world-data.json'), JSON.stringify(out));
console.log('wrote server/world-data.json —',
  `${portals.length} portals, ${out.wolfSpawns.length} wolf + ${out.banditSpawns.length} bandit spawns`);
console.log('  rules: coast from y' + out.rules.coastY0 +
  ', bad at ' + out.rules.notoBadAt + ' kills, safe zone ' +
  JSON.stringify(out.rules.coastSafeZone));
