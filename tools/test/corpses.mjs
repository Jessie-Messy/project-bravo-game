// corpses.mjs — mob corpses, harvesting, meat.
//
// WHY THIS EXISTS. Every piece of this feature fails silently when it is wrong:
//   * a harvest yield whose item is not in `inv` adds NaN to nothing and the
//     player gets "+2 undefined";
//   * an item missing from BAG_ITEMS never appears in the pack (HANDOFF gotcha —
//     mithril and runic ingots were invisible for exactly this reason);
//   * a knife that is bought but not saved is gone after the next login;
//   * a HARVEST key that is not a real mob type is dead data nobody notices;
//   * if the death path calls onCorpse BEFORE the kill hook, the kill hook's
//     drops (artifacts, gear) land on the ground instead of in the body.
//
// Usage: node tools/test/corpses.mjs   (or npm run test:corpses)
import fs from 'node:fs';

globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ({}) }) };
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const CD = await import('../../js/corpse-data.js');
const S  = await import('../../js/state.js');
const E  = await import('../../js/enemies.js');

let fail = 0, checked = 0;
const bad = (m) => { console.log('  FAIL  ' + m); fail++; };
const check = (name, cond, detail) => { checked++; if (!cond) bad(name + (detail ? ' — ' + detail : '')); };

const game = fs.readFileSync('js/game3d.js', 'utf8');
const enemies = fs.readFileSync('js/enemies.js', 'utf8');

// ── The harvest table points at real things ─────────────────────────
for (const [type, yields] of Object.entries(CD.HARVEST)) {
  check(`HARVEST.${type} is a real mob type`, !!E.ENEMY_CFG[type] || type === 'cat');
  for (const k of Object.keys(yields)) {
    check(`HARVEST.${type} yields '${k}', which inv knows`, k in S.inv, 'inv has no ' + k + ' — the harvest would add to undefined');
    check(`'${k}' has a BAG_ITEMS entry`, new RegExp("\\{k:'" + k + "'").test(game), 'it would never show in the pack');
  }
}
for (const k of ['raw_meat', 'cooked_meat']) {
  check(`inv starts with ${k}`, S.inv[k] === 0);
  check(`${k} is in BAG_ITEMS`, new RegExp("\\{k:'" + k + "'").test(game));
  check(`${k} can be traded`, new RegExp("key:'" + k + "'").test(game));
}
check('cats are never harvestable', CD.rollHarvest('cat') === null && CD.NEVER_HARVEST.has('cat'));

// ── Rolls stay inside their ranges ──────────────────────────────────
for (const [type, yields] of Object.entries(CD.HARVEST)) {
  const lo = CD.rollHarvest(type, () => 0), hi = CD.rollHarvest(type, () => 0.9999);
  for (const [k, [a, b]] of Object.entries(yields)) {
    check(`${type} ${k} low roll = ${a}`, lo[k] === a, 'got ' + lo[k]);
    check(`${type} ${k} high roll = ${b}`, hi[k] === b, 'got ' + hi[k]);
  }
}

// ── The blade rule ──────────────────────────────────────────────────
check('bare bow cannot harvest', !CD.canHarvestWith({ weapon: 'bow' }));
check('pickaxe cannot harvest', !CD.canHarvestWith({ weapon: 'pickaxe' }));
check('sword can harvest', CD.canHarvestWith({ weapon: 'sword' }));
check('axe can harvest', CD.canHarvestWith({ weapon: 'axe' }));
check('a knife in the pack harvests with a bow in hand', CD.canHarvestWith({ weapon: 'bow', hasKnife: true }));
check('the knife is sold', /id:'knife'[^}]*pkey:'hasKnife'/.test(game));
check('buying the knife does not swap the weapon in hand', !/id:'knife'[^}]*wpn:/.test(game));
check('the knife is saved', /hasKnife:!!player\.hasKnife/.test(game));
check('the knife is loaded', /player\.hasKnife=!!s\.hasKnife/.test(game));
check('a new character starts without a knife', S.player.hasKnife === false);

// ── Special corpses ─────────────────────────────────────────────────
check('an ordinary wolf is not special', !CD.isSpecialKill({ type: 'wolf' }));
check('a coast boss is special', CD.isSpecialKill({ type: 'wolf', coastBoss: 'tidewrack' }));
check('a floor boss is special', CD.isSpecialKill({ type: 'troll', floorBoss: 3 }));
check('a champion is special', CD.isSpecialKill({ type: 'goblin', isChampBoss: true }));
for (const t of CD.SPECIAL_TYPES) check(`special type ${t} is a real mob`, !!E.ENEMY_CFG[t]);

// ── Order in the death path ─────────────────────────────────────────
{
  const i = enemies.indexOf('spawnDrops(e); snd.enemyDie();');
  const k = enemies.indexOf('if (hooks.onKill) hooks.onKill(e);', i);
  const c = enemies.indexOf('if (hooks.onCorpse) hooks.onCorpse(e, n0);', i);
  check('local deaths hand their drops to the corpse AFTER the kill hook', i > 0 && k > i && c > k,
        'onCorpse must run after onKill or the kill hook\'s drops land on the ground');
  check('server-mob deaths make a corpse on every client', /if\(hooks\.onCorpse\) hooks\.onCorpse\(e, n0\);\s*\n\s*\};/.test(game));
}
check('boss gold stays on the ground', /if\(special && d\.type === 'gold'\)\{ drops\.push\(d\)/.test(game));
check('a pelt is skinned, not looted', /if\(pelt && d\.type === 'hide'\) continue;/.test(game));

// ── Food ────────────────────────────────────────────────────────────
check('cooked meat heals over time', CD.FOOD.cooked_meat.heal > 0 && CD.FOOD.cooked_meat.secs > 1);
check('cooking needs a campfire', /id==='cook_meat'\) return \(inv\.raw_meat\|\|0\)>=1 && nearbyObject\('campfire',3\)/.test(game));

console.log('\n' + checked + ' checks, ' + fail + ' failure' + (fail === 1 ? '' : 's'));
process.exit(fail ? 1 : 0);
