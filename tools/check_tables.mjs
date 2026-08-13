// Cross-check the client and the server agree about the economy.
//   node tools/check_tables.mjs
//
// ── Why ─────────────────────────────────────────────────────────────────────
// The two sides now share shared/recipes.json and shared/shop.json, but they
// still hold separate lists of what an ITEM is — the client's `inv` object in
// js/state.js, and the server's ITEM_KEYS whitelist in server/tx.js. A key in one
// and not the other is not a crash; it is a silent refusal. The player picks
// something up, the client shows it, the server declines to record it, and the
// only trace is one line in the oplog.
//
// This walks every list on both sides and fails on any disagreement. It is
// static analysis — no server, no browser, under a second.
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const tx = require(join(root, 'server', 'tx.js'));
const read = p => readFileSync(join(root, p), 'utf8');

let problems = [];
const bad = m => problems.push(m);
const list = s => [...s].sort().join(', ');

// ── The client's inventory keys ──
// Parsed from the literal rather than imported: js/state.js pulls in browser
// globals, and a static read cannot go stale in a way this check would miss.
const invSrc = read('js/state.js').match(/export const inv\s*=\s*\{([^}]*)\}/);
if (!invSrc) bad('cannot find the `inv` literal in js/state.js');
const clientInv = new Set((invSrc ? invSrc[1] : '').match(/(\w+)\s*:/g)?.map(s => s.replace(/\s*:$/, '')) || []);

// Placeables are added to `inv` at runtime by gainPlaceable, so they are not in
// the literal. Their inventory key equals the placeable type.
const placeSrc = read('js/game3d.js');
const placeables = new Set([...placeSrc.matchAll(/invKey\s*:\s*'([a-z_]+)'/g)].map(m => m[1]));
for (const p of placeables) clientInv.add(p);

// `bone` is real (recipes spend it, mobs drop it) but has never been in the
// literal — it is created on first pickup. Same for anything else a drop can
// introduce; the drop table below is the authority for those.
const dropSrc = read('server/bravo-room.js').match(/const DROP_TYPES = new Set\(\[([^\]]*)\]/);
const dropTypes = new Set([...(dropSrc ? dropSrc[1] : '').matchAll(/'([a-z_]+)'/g)].map(m => m[1]));
for (const d of dropTypes) if (d !== 'gold') clientInv.add(d);

const serverKeys = tx.ITEM_KEYS;

// ── 1. every client item must be recordable by the server ──
for (const k of [...clientInv].sort()) {
  if (k === 'gold') continue;                       // wallet, not an item
  if (!serverKeys.has(k))
    bad(`item "${k}" exists on the client but is NOT in server ITEM_KEYS — the server ` +
        `will silently refuse to record it (pickup/craft/buy all reject unknown keys)`);
}

// ── 2. and nothing in the whitelist should be a typo ──
for (const k of [...serverKeys].sort())
  if (!clientInv.has(k))
    bad(`server ITEM_KEYS has "${k}" which the client never holds — dead entry or typo`);

// ── 3. every drop type must be creditable ──
for (const d of [...dropTypes].sort())
  if (d !== 'gold' && !serverKeys.has(d))
    bad(`drop type "${d}" cannot be credited: not in ITEM_KEYS. Picking one up ` +
        `shows in the client and never reaches the document.`);

// ── 4. every recipe input/output must be a known item ──
for (const [id, rec] of Object.entries(tx.RECIPES)) {
  const keys = [
    ...Object.keys(rec.cost || {}), ...Object.keys(rec.requires || {}),
    ...Object.keys(rec.gain || {}), ...(rec.placeable ? [rec.placeable] : []),
  ];
  for (const k of keys) {
    if (!serverKeys.has(k)) bad(`recipe "${id}" uses item "${k}" which is not in ITEM_KEYS`);
    if (!clientInv.has(k))  bad(`recipe "${id}" uses item "${k}" which the client never holds`);
  }
  if (rec.armor && !(rec.armor >= 1 && rec.armor <= 6)) bad(`recipe "${id}" has armor rank ${rec.armor}`);
  if (rec.placeable && !placeables.has(rec.placeable))
    bad(`recipe "${id}" grants placeable "${rec.placeable}" which is not in PLACEABLES`);
}

// ── 5. shop items ──
for (const [shop, items] of Object.entries(tx.SHOP)) {
  if (shop.startsWith('_')) continue;
  for (const [id, it] of Object.entries(items)) {
    if (!(it.price > 0)) bad(`shop ${shop}.${id} has no price`);
    if (it.kind === 'item' && !serverKeys.has(it.item))
      bad(`shop ${shop}.${id} sells "${it.item}" which is not in ITEM_KEYS`);
    if (it.kind === 'tier' && !it.needTool) bad(`shop ${shop}.${id} is a tier upgrade with no needTool`);
    if (!['item', 'tool', 'tier', 'armor'].includes(it.kind)) bad(`shop ${shop}.${id} has unknown kind "${it.kind}"`);
  }
}

// ── 6. the client's shop UI must offer exactly what the server stocks ──
// A button the server does not know about takes the player's gold locally and is
// then refused; a stocked item with no button is simply unreachable.
for (const [shop, re] of [['smith', /const SMITH_ITEMS=\[([\s\S]*?)\n\];/],
                          ['mage',  /const MAGE_ITEMS=\[([\s\S]*?)\];/]]) {
  const m = placeSrc.match(re);
  if (!m) { bad(`cannot find the client's ${shop} item list in js/game3d.js`); continue; }
  const uiIds = new Set([...m[1].matchAll(/\{id:'([a-z0-9_]+)'/g)].map(x => x[1]));
  const srvIds = new Set(Object.keys(tx.SHOP[shop] || {}));
  for (const id of [...uiIds].sort())
    if (!srvIds.has(id)) bad(`client ${shop} shop offers "${id}" which the server does not stock — ` +
                             `the buy will be charged locally and refused by the server`);
  for (const id of [...srvIds].sort())
    if (!uiIds.has(id)) bad(`server stocks ${shop}."${id}" which the client never shows`);
}

// ── 7. the client's recipe UI must match the shared table ──
const uiRecipes = new Set([...placeSrc.matchAll(/\{id:'([a-z_]+)',\s*top:/g)].map(m => m[1]));
for (const id of [...uiRecipes].sort())
  if (!tx.RECIPES[id]) bad(`the craft panel lists "${id}" but shared/recipes.json has no such recipe — ` +
                           `the button is dead (recipeBlocker returns "unknown recipe")`);
for (const id of Object.keys(tx.RECIPES).sort())
  if (!uiRecipes.has(id)) bad(`shared/recipes.json defines "${id}" which the craft panel never shows`);

// ── 8. the server's blank document must match the client's starting kit ──
// ⚠ This drifted once and it was not cosmetic. The client hands a new character
// an axe, 20 gold, 10 arrows and 2 bandages; the server's blank() had no axe and
// an empty purse, so `gather` refused every tree chop with "need an axe" until
// the first save, and that first save logged a divergence on three fields —
// noise in the exact log the Phase 2 decision is read from.
{
  const kitLine = placeSrc.match(/inv\.wood = 0;[^\n]*\n[^\n]*hasAxe = true[^\n]*/);
  if (!kitLine) bad('cannot find the starting-kit block in js/game3d.js (char creator)');
  else {
    const kit = {};
    for (const m of kitLine[0].matchAll(/inv\.(\w+)\s*=\s*(\d+)/g)) kit[m[1]] = +m[2];
    const tools = {};
    for (const m of kitLine[0].matchAll(/player\.has(\w+)\s*=\s*(true|false)/g))
      tools[m[1][0].toLowerCase() + m[1].slice(1)] = m[2] === 'true';

    const blank = require(join(root, 'server', 'character.js')).blank('x', 'y');
    const srvItems = Object.assign({}, blank.items);
    const srvGold = blank.wallet.gold;

    if (srvGold !== (kit.gold || 0))
      bad(`starting gold: client gives ${kit.gold || 0}, server blank() gives ${srvGold}`);
    for (const [k, v] of Object.entries(kit)) {
      if (k === 'gold') continue;
      const got = srvItems[k] || 0;
      if (got !== v) bad(`starting kit: client gives ${v} ${k}, server blank() gives ${got}`);
      delete srvItems[k];
    }
    for (const [k, v] of Object.entries(srvItems))
      if (v) bad(`server blank() starts with ${v} ${k} which the client's starting kit does not give`);
    for (const [t, v] of Object.entries(tools)) {
      const got = !!blank.tools[t];
      if (got !== v) bad(`starting tools: client sets has${t[0].toUpperCase()}${t.slice(1)}=${v}, ` +
                         `server blank() has tools.${t}=${got}` +
                         (t === 'axe' && !got ? '  → every tree chop refused with "need an axe"' : ''));
    }
  }
}

// ── 9. world constants duplicated on the server ──
// The server cannot import js/constants.js (ESM, browser globals), so it restates
// TILE, MAP_W, MAP_H, CITY and the blacksmith's position by hand. Every one of
// those is a silent, total failure if it drifts:
//   • TILE/MAP_* → every tile↔world conversion is wrong, so the resource layer,
//     the walkability bitmap and every range check address the wrong tiles
//   • CITY       → the PvP safe zone is in the wrong place
//   • BLACKSMITH → forge recipes are refused in the shop and allowed in a field
// A comment saying "must match the client's constants.js" is not a mechanism.
{
  const cSrc = read('js/constants.js'), sSrc = read('server/bravo-room.js'), stSrc = read('js/state.js');
  const num = (src, re, label) => {
    const m = src.match(re);
    if (!m) { bad(`cannot read ${label}`); return null; }
    return Number(m[1]);
  };
  const cmp = (label, a, b) => {
    if (a === null || b === null) return;
    if (a !== b) bad(`${label}: client says ${a}, server says ${b} — ` +
                     `every tile/world conversion on one side is wrong`);
  };
  cmp('TILE',  num(cSrc, /export const TILE = (\d+)/, 'client TILE'),
               num(sSrc, /const TILE = (\d+)/, 'server TILE'));
  cmp('MAP_W', num(cSrc, /MAP_W = (\d+)/, 'client MAP_W'), num(sSrc, /MAP_W = (\d+)/, 'server MAP_W'));
  cmp('MAP_H', num(cSrc, /MAP_H = (\d+)/, 'client MAP_H'), num(sSrc, /MAP_H = (\d+)/, 'server MAP_H'));

  const cityOf = (src, re) => {
    const m = src.match(re); if (!m) return null;
    const o = {};
    for (const p of m[1].matchAll(/(x1|y1|x2|y2)\s*:\s*(\d+)/g)) o[p[1]] = +p[2];
    return JSON.stringify(o);
  };
  const cCity = cityOf(cSrc, /export const CITY = \{([^}]*)\}/);
  const sCity = cityOf(sSrc, /const CITY = \{([^}]*)\}/);
  if (cCity && sCity && cCity !== sCity)
    bad(`CITY safe zone differs — client ${cCity} vs server ${sCity}; the PvP safe zone ` +
        `would be in a different place on each side`);

  // BLACKSMITH: client states it in world units, the server as tile*TILE+24.
  const cb = stSrc.match(/export const BLACKSMITH = \{\s*x:(\d+)\*(\d+)\+(\d+),\s*y:(\d+)\*(\d+)\+(\d+)/);
  const sb = sSrc.match(/const BLACKSMITH = \{ x: (\d+) \* TILE \+ (\d+), y: (\d+) \* TILE \+ (\d+)/);
  if (!cb || !sb) bad('cannot compare the BLACKSMITH position');
  else if (cb[1] !== sb[1] || cb[4] !== sb[3] || cb[3] !== sb[2] || cb[6] !== sb[4])
    bad(`BLACKSMITH position differs — client tile (${cb[1]},${cb[4]}) vs server (${sb[1]},${sb[3]}); ` +
        `forge recipes would be refused at the shop and allowed somewhere else`);

  // The server's gather reach must be at least the client's harvest range, or
  // legitimate chops are refused; the extra tile absorbs 10Hz position staleness.
  const hr = num(cSrc, /HARVEST_RANGE = TILE \* ([\d.]+)/, 'client HARVEST_RANGE');
  const gr = sSrc.match(/const GATHER_RANGE = TILE \* ([\d.]+) \+ TILE/);
  if (hr !== null && gr && Number(gr[1]) < hr)
    bad(`GATHER_RANGE (TILE*${gr[1]}+TILE) is tighter than the client's HARVEST_RANGE ` +
        `(TILE*${hr}) — legitimate chops at the edge of reach will be refused`);
}

if (problems.length) {
  console.error(`TABLE CROSS-CHECK FAILED — ${problems.length} disagreement(s)\n`);
  for (const p of problems) console.error('  ✖ ' + p);
  console.error('\nThese do not crash. They present as "I picked it up and it did not save"');
  console.error('or "the shop took my gold and gave me nothing".');
  process.exit(1);
}
console.log(`tables agree — ${clientInv.size} item keys, ${Object.keys(tx.RECIPES).length} recipes, ` +
            `${Object.values(tx.SHOP).filter(v => typeof v === 'object' && !Array.isArray(v)).reduce((n, s) => n + Object.keys(s).length, 0)} shop entries`);
