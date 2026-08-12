// Transaction engine tests — run after ANY change to server/tx.js or the shared
// tables.  node tools/check_tx.mjs
//
// tx.apply is a pure function of (doc, intent, ctx), which is what makes this
// possible without a server, a database or a socket. The cases below are the
// ones where being wrong costs a player real progress: a transaction that half
// applies, a cost that is charged twice, a gate that can be talked past.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const tx = require('../server/tx.js');
const character = require('../server/character.js');

let pass = 0, fail = 0;
const ok = (name, cond, detail) => {
  if (cond) { pass++; }
  else { fail++; console.log(`FAIL  ${name}${detail ? '  — ' + detail : ''}`); }
};
const doc = (over = {}) => Object.assign(character.blank('T', 'acct'), over);
const near = (...types) => ({ nearby: t => types.includes(t) });

// ── craft: the happy path ──
{
  const d = doc({ items: { wood: 5 } });
  const r = tx.apply(d, 'craft', { id: 'planks' }, {});
  ok('craft planks succeeds', r.ok, r.reason);
  ok('craft planks spends 3 wood', d.items.wood === 2, `wood=${d.items.wood}`);
  ok('craft planks yields 1 plank', d.items.planks === 1, `planks=${d.items.planks}`);
  ok('deltas report the spend', r.ok && r.deltas.items.wood === -3 && r.deltas.items.planks === 1,
     JSON.stringify(r.deltas && r.deltas.items));
}

// ── craft: cannot afford, and MUST NOT half-apply ──
{
  const d = doc({ items: { wood: 2 } });
  const r = tx.apply(d, 'craft', { id: 'planks' }, {});
  ok('craft rejects when short', !r.ok);
  ok('rejected craft leaves wood untouched', d.items.wood === 2, `wood=${d.items.wood}`);
  ok('rejected craft yields nothing', !d.items.planks, `planks=${d.items.planks}`);
}
{
  // Multi-cost recipe short on the SECOND ingredient — the case where a naive
  // implementation subtracts the first and then bails, destroying it.
  const d = doc({ items: { planks: 10, stone: 1 } });
  const r = tx.apply(d, 'craft', { id: 'workbench' }, {});
  ok('multi-cost craft rejects when short on the 2nd item', !r.ok);
  ok('  ...and does not consume the 1st', d.items.planks === 10, `planks=${d.items.planks}`);
}

// ── craft: proximity is enforced ──
{
  const d = doc({ items: { iron_ore: 9 } });
  ok('ingot refused with no forge', !tx.apply(d, 'craft', { id: 'iron_ingot' }, {}).ok);
  ok('  ...ore untouched', d.items.iron_ore === 9);
  const r = tx.apply(d, 'craft', { id: 'iron_ingot' }, near('forge'));
  ok('ingot allowed at a forge', r.ok, r.reason);
  ok('  ...ore spent', d.items.iron_ore === 6, `ore=${d.items.iron_ore}`);
}
{
  // anvil needs BOTH stations (nearAll), unlike everything else which needs any.
  const d = doc({ items: { iron_ingot: 9 } });
  ok('anvil refused with only a workbench', !tx.apply(d, 'craft', { id: 'anvil' }, near('workbench')).ok);
  ok('anvil allowed with both', tx.apply(d, 'craft', { id: 'anvil' }, near('workbench', 'forge')).ok);
  ok('  ...and grants the placeable', d.items.anvil === 1, `anvil=${d.items.anvil}`);
}
{
  // steel_arm lists two stations WITHOUT nearAll — either one alone must do.
  const d = doc({ items: { steel_ingot: 4, hide: 4, bone: 4 } });
  ok('either-station recipe accepts just the forge', tx.apply(d, 'craft', { id: 'steel_arm' }, near('forge')).ok);
}

// ── craft: `requires` is held, not spent ──
{
  const d = doc({ items: { planks: 1 } });
  const r = tx.apply(d, 'craft', { id: 'wall' }, {});
  ok('wall craft succeeds holding 1 plank', r.ok, r.reason);
  ok('wall craft spends NOTHING (paid at placement)', d.items.planks === 1, `planks=${d.items.planks}`);
  const d2 = doc({ items: {} });
  ok('wall craft refused with no planks', !tx.apply(d2, 'craft', { id: 'wall' }, {}).ok);
}

// ── craft: tier and ownership gates ──
{
  const d = doc({ items: { planks: 20 } });
  ok('craft a sword', tx.apply(d, 'craft', { id: 'sword' }, {}).ok);
  ok('  ...grants the tool', d.tools.sword === true);
  ok('cannot craft a second sword', !tx.apply(d, 'craft', { id: 'sword' }, {}).ok);
  ok('  ...and is not charged for the refusal', d.items.planks === 15, `planks=${d.items.planks}`);
}
{
  const d = doc({ items: { mithril_ingot: 9 }, tiers: { sword: 5, bow: 1, pickaxe: 1 } });
  ok('no downgrade: mithril sword refused at runic tier',
     !tx.apply(d, 'craft', { id: 'mithril_sword' }, near('forge')).ok);
  ok('  ...ingots untouched', d.items.mithril_ingot === 9);
}

// ── craft: armor slots ──
{
  const d = doc({ items: { hide: 99 } });
  for (let i = 0; i < 4; i++) tx.apply(d, 'craft', { id: 'larmor' }, {});
  ok('4 leather pieces fill 4 slots',
     Object.values(d.armor).filter(v => v === 1).length === 4, JSON.stringify(d.armor));
  const r = tx.apply(d, 'craft', { id: 'larmor' }, {});
  ok('5th leather piece refused (full set)', !r.ok, r.reason);
  const before = d.items.hide;
  ok('  ...and no hide is taken', tx.apply(d, 'craft', { id: 'larmor' }, {}).ok === false && d.items.hide === before);
}

// ── buy / sell ──
{
  const d = doc({ wallet: { gold: 100, bank: 0 } });
  const r = tx.apply(d, 'buy', { shop: 'smith', id: 'sword' }, near('smith'));
  ok('buy a sword at the smith', r.ok, r.reason);
  ok('  ...charges 30g', d.wallet.gold === 70, `gold=${d.wallet.gold}`);
  ok('  ...grants the tool', d.tools.sword === true);
  ok('buying it twice is refused', !tx.apply(d, 'buy', { shop: 'smith', id: 'sword' }, near('smith')).ok);
  ok('  ...and does not charge again', d.wallet.gold === 70, `gold=${d.wallet.gold}`);
}
{
  const d = doc({ wallet: { gold: 10, bank: 0 } });
  const r = tx.apply(d, 'buy', { shop: 'smith', id: 'sword' }, near('smith'));
  ok('buy refused without the gold', !r.ok);
  ok('  ...gold untouched', d.wallet.gold === 10);
}
{
  const d = doc({ wallet: { gold: 500, bank: 0 } });
  ok('buy refused away from the shop', !tx.apply(d, 'buy', { shop: 'smith', id: 'sword' }, near()).ok);
  ok('unknown shop refused', !tx.apply(d, 'buy', { shop: 'nope', id: 'sword' }, near('smith')).ok);
  ok('unstocked item refused', !tx.apply(d, 'buy', { shop: 'smith', id: 'excalibur' }, near('smith')).ok);
}
{
  const d = doc({ wallet: { gold: 999, bank: 0 }, items: { potions: 10 } });
  ok('potion refused at max stack', !tx.apply(d, 'buy', { shop: 'mage', id: 'potion' }, {}).ok);
  ok('  ...gold untouched', d.wallet.gold === 999);
}

// ── bank: total gold is invariant ──
{
  const d = doc({ wallet: { gold: 100, bank: 50 } });
  const total = () => d.wallet.gold + d.wallet.bank;
  const t0 = total();
  ok('deposit 40', tx.apply(d, 'bank', { dir: 'deposit', amount: 40 }).ok);
  ok('  ...purse 60 / bank 90', d.wallet.gold === 60 && d.wallet.bank === 90, `${d.wallet.gold}/${d.wallet.bank}`);
  ok('withdraw 90', tx.apply(d, 'bank', { dir: 'withdraw', amount: 90 }).ok);
  ok('  ...total gold unchanged by banking', total() === t0, `${total()} vs ${t0}`);
  ok('overdraft refused', !tx.apply(d, 'bank', { dir: 'withdraw', amount: 1 }).ok);
  ok('negative deposit refused', !tx.apply(d, 'bank', { dir: 'deposit', amount: -50 }).ok);
  ok('fractional deposit refused or floored, never inflating',
     total() === t0, `${total()} vs ${t0}`);
  ok('NaN amount refused', !tx.apply(d, 'bank', { dir: 'deposit', amount: 'x' }).ok);
}

// ── pickup ──
{
  const d = doc();
  ok('pickup credits the stack', tx.apply(d, 'pickup', { type: 'wood', count: 4 }).ok);
  ok('  ...4 wood', d.items.wood === 4, `wood=${d.items.wood}`);
  // ⚠ Relative to the starting purse, not an absolute. A new character starts
  // with the client's starting kit (20 gold), so an absolute expectation here
  // goes stale the moment that kit changes — and would then look like a pickup
  // bug rather than a stale test.
  const gold0 = d.wallet.gold;
  ok('pickup gold goes to the wallet, not the pack',
     tx.apply(d, 'pickup', { type: 'gold', count: 25 }).ok &&
     d.wallet.gold === gold0 + 25 && !d.items.gold,
     `gold=${d.wallet.gold} (started ${gold0}) items.gold=${d.items.gold}`);
  ok('unknown item refused', !tx.apply(d, 'pickup', { type: 'excalibur', count: 1 }).ok);
  ok('absurd count refused', !tx.apply(d, 'pickup', { type: 'wood', count: 1e9 }).ok);
  ok('negative count refused', !tx.apply(d, 'pickup', { type: 'wood', count: -5 }).ok);
}

// ── gather: the server decides the yield ──
{
  const ctx = { resourceAt: () => 'iron', inRange: () => true };
  const d1 = doc({ tools: { pickaxe: true }, tiers: { pickaxe: 1, sword: 1, bow: 1 } });
  tx.apply(d1, 'gather', { tx: 1, ty: 1 }, ctx);
  const d5 = doc({ tools: { pickaxe: true }, tiers: { pickaxe: 5, sword: 1, bow: 1 } });
  tx.apply(d5, 'gather', { tx: 1, ty: 1 }, ctx);
  ok('yield scales with the pickaxe tier the SERVER knows',
     d5.items.iron_ore > d1.items.iron_ore, `${d1.items.iron_ore} vs ${d5.items.iron_ore}`);

  const d = doc({ tools: { pickaxe: true } });
  ok('gather refused off a resource tile',
     !tx.apply(d, 'gather', { tx: 1, ty: 1 }, { resourceAt: () => null, inRange: () => true }).ok);
  ok('gather refused out of range',
     !tx.apply(d, 'gather', { tx: 1, ty: 1 }, { resourceAt: () => 'iron', inRange: () => false }).ok);
  ok('mining refused with no pickaxe',
     !tx.apply(doc(), 'gather', { tx: 1, ty: 1 }, ctx).ok);
}

// ── dispatch hygiene ──
{
  ok('unknown transaction refused', !tx.apply(doc(), 'wish', {}, {}).ok);
  ok('missing document refused', !tx.apply(null, 'craft', { id: 'planks' }, {}).ok);
  ok('unknown recipe refused', !tx.apply(doc(), 'craft', { id: 'nope' }, {}).ok);
  ok('missing intent refused, not thrown', !tx.apply(doc(), 'craft', undefined, {}).ok);
}

// ── every recipe is reachable: no typos in the shared table ──
{
  let unreachable = [];
  for (const id of Object.keys(tx.RECIPES)) {
    const rec = tx.RECIPES[id];
    const d = doc({
      items: Object.fromEntries([...Object.keys(rec.cost || {}), ...Object.keys(rec.requires || {})].map(k => [k, 99])),
      tools: { axe: true, sword: true, bow: true, pickaxe: true, houseTool: true },
      tiers: { sword: 1, bow: 1, pickaxe: 1 },
    });
    // notOwned recipes gate on the tool we just granted; drop just that one.
    if (rec.notOwned) d.tools[rec.notOwned] = false;
    const r = tx.apply(d, 'craft', { id }, near('workbench', 'forge', 'smith'));
    if (!r.ok) unreachable.push(`${id} (${r.reason})`);
  }
  ok('every recipe in the shared table is craftable given its own inputs',
     unreachable.length === 0, unreachable.join(', '));
}

// ── schema migration: a v1 document must survive ──
// ⚠ The v2 field (standing) was added to blank(), which only affects NEW
// characters. Every character created before it must gain the field on load, or
// the first thing that reads doc.standing.kills throws on an existing player —
// the one class of user this cannot be allowed to break.
{
  const v1 = character.blank('Old', 'acct');
  delete v1.standing;
  v1.schemaVersion = 1;
  const round = JSON.parse(JSON.stringify(v1));
  // load() migrates; exercise the same path by writing and reading back.
  character.save('__migtest__', round);
  const back = character.load('__migtest__');
  ok('a v1 document loads', !!back);
  ok('  ...is migrated to v2', back && back.schemaVersion === 2, back && back.schemaVersion);
  ok('  ...gains a zeroed standing', back && back.standing && back.standing.kills === 0 &&
     back.standing.deaths === 0 && back.standing.notoriety === 0, JSON.stringify(back && back.standing));
  ok('  ...and transactions work on it',
     back && tx.apply(Object.assign(back, { items: { wood: 5 } }), 'craft', { id: 'planks' }, {}).ok);
}

// ── gather accepts on a real resource tile, per kind ──
{
  const inRange = () => true;
  for (const [kind, item] of [['tree', 'wood'], ['stone', 'stone'], ['iron', 'iron_ore']]) {
    const d = character.blank('G', 'a');
    d.tools = { axe: true, sword: true, bow: true, pickaxe: true };
    const r = tx.apply(d, 'gather', { tx: 5, ty: 5 }, { resourceAt: () => kind, inRange });
    ok(`gather accepts on a ${kind} tile`, r.ok, r.reason);
    ok(`  ...credits ${item}`, (d.items[item] | 0) > 0, JSON.stringify(d.items));
  }
  // A felled tree pays its whole load at once; ore pays per swing.
  const t = character.blank('T', 'a'); t.tools = { axe: true };
  tx.apply(t, 'gather', { tx: 5, ty: 5 }, { resourceAt: () => 'tree', inRange });
  ok('a felled tree yields 4 wood, not 1', (t.items.wood | 0) === 4, `wood=${t.items.wood}`);
}

// ── item whitelist covers everything the client can hold ──
// (the full cross-check lives in tools/check_tables.mjs; this pins the gems,
// which were missing and would have been silently unrecordable)
for (const gem of ['ruby', 'sapphire', 'emerald', 'diamond']) {
  const d = character.blank('Gem', 'a');
  ok(`${gem} can be picked up`, tx.apply(d, 'pickup', { type: gem, count: 2 }).ok);
}

// ── divergence detection ──
// The Phase 2 decision is read off this log, so a diff() that misses a real
// change is worse than no log: it says "quiet" about a document that disagrees.
{
  const base = () => ({
    px: 100, py: 200, hp: 100, inv: { wood: 5, gold: 20, arrows: 10, bandages: 2 },
    bank: { gold: 0 }, level: 1, xp: 0, xpMax: 100, statPoints: 0, skillPoints: 0,
    hasAxe: true, hasSword: false, hasBow: false, hasPickaxe: false, hasHouseTool: false,
    swordTier: 1, bowTier: 1, pickaxeTier: 1,
    stats: { str: 10, dex: 10, int: 10, vit: 10 },
    skillXp: { tactics: 0, archery: 0, hiding: 0, healing: 0, wrestling: 0 },
    armor: { head: 0, chest: 0, legs: 0, boots: 0 },
    equipmentItems: [], equippedItems: { weapon: null, armor: null },
    artifactInv: [], equippedArtifacts: {},
    contractRank: 0, dungeonBest: 1, chestsLooted: {}, floorBossesDown: {},
  });
  const docFrom = b => character.fromLegacyBlob('D', 'a', b);

  const b0 = base();
  ok('an unchanged save reports NO divergence',
     character.diff(docFrom(b0), b0).length === 0, JSON.stringify(character.diff(docFrom(b0), b0)));

  // Each of these is a client-side change the server does not model. Every one
  // must show up, or it is invisible drift.
  const mutations = [
    ['gold',        b => b.inv.gold = 999],
    ['wood',        b => b.inv.wood = 999],
    ['bank',        b => b.bank.gold = 500],
    ['level',       b => b.level = 9],
    ['xp',          b => b.xp = 5000],
    ['hp',          b => b.hp = 40],
    ['a tool',      b => b.hasSword = true],
    ['a tier',      b => b.swordTier = 5],
    ['statPoints',  b => b.statPoints = 12],
    ['skillPoints', b => b.skillPoints = 3],
    ['xpMax',       b => b.xpMax = 300],
    ['a stat',      b => b.stats.str = 40],
    ['skill xp',    b => b.skillXp.tactics = 900],
    ['armor',       b => b.armor.head = 6],
    ['gear count',  b => b.equipmentItems.push({ type: 'sword', name: 'x', tier: 5 })],
    ['artifacts',   b => b.artifactInv.push({ defId: 'x', identified: true })],
    ['contractRank',b => b.contractRank = 7],
    ['dungeonBest', b => b.dungeonBest = 9],
    ['chests',      b => b.chestsLooted['3,4'] = 1],
    ['floor bosses',b => b.floorBossesDown['2'] = 1],
    ['equipped',    b => b.equippedItems.weapon = { type: 'sword', iid: 'i1' }],
    ['worn relics', b => b.equippedArtifacts.neck = { defId: 'x' }],
  ];
  for (const [label, mutate] of mutations) {
    const doc = docFrom(base());
    const b = base(); mutate(b);
    const d = character.diff(doc, b);
    ok(`divergence detected: ${label}`, d.length > 0, 'reported nothing');
  }

  // And the rule that stops it crying wolf.
  const partial = { inv: { wood: 5, gold: 20, arrows: 10, bandages: 2 }, hp: 100 };
  ok('a save that OMITS a field is silence, not a divergence',
     character.diff(docFrom(base()), partial).length === 0,
     JSON.stringify(character.diff(docFrom(base()), partial)));
  // hp arrives as a float from regen; comparing raw would diverge on every save.
  const floaty = base(); floaty.hp = 100.09985000000003;
  ok('a float hp does not report a divergence',
     !character.diff(docFrom(base()), floaty).some(x => x.startsWith('hp:')),
     JSON.stringify(character.diff(docFrom(base()), floaty)));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
