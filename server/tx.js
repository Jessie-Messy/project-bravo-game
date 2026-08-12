// tx.js — the transaction engine. PHASE 1 of docs/SERVER_AUTHORITY.md.
//
// The client states an INTENT ("craft an iron sword"), never an outcome. This
// file decides whether that is allowed, applies it to the server's character
// document, and returns the DELTAS the client should apply. A modified client
// can ask for anything; it cannot state what it received.
//
// ── What is and is not authoritative yet ────────────────────────────────────
// Phase 1 runs ALONGSIDE the legacy `save`, which is still a blanket override
// (that is Phase 2's job to remove). So nothing here is the last word yet —
// the point of Phase 1 is that the server can now author every one of these
// mutations correctly, and the divergence log gets quiet, so Phase 2 is a
// switch rather than a rewrite.
//
// ⚠ `gather` is the one transaction whose validation is incomplete, and the gap
// is named rather than hidden: the server checks that the target really is a
// resource tile (world-data's resource layer), that the player is genuinely in
// range of it (server-known position, not a client claim), and rate-limits it —
// but it does NOT yet track per-node HP or respawn, so a client can re-harvest a
// node it has already exhausted, bounded by the rate limit. Closing that needs
// server-side node state, which is Phase 3. The intent signature does not change
// when it lands, so this is not rework.
//
// Everything here is a PURE function of (doc, intent, ctx) -> result. It never
// touches the network, the room, or the clock, which is what makes it testable
// without a server (see tools/check_tx.mjs).
const path = require('path');

const RECIPES = Object.assign({}, require(path.join(__dirname, '..', 'shared', 'recipes.json')));
delete RECIPES._doc;
const SHOP = require(path.join(__dirname, '..', 'shared', 'shop.json'));

const ARMOR_SLOTS = ['head', 'chest', 'legs', 'boots'];

// Stackables the document will accept. A whitelist, not a passthrough: without
// it a client could name any key at all and grow the document unboundedly, which
// is both an exploit and the 200KB silent-truncation failure waiting to happen.
//
// ⚠ This list must match the client's `inv` in js/state.js plus the placeables.
// A key here and not there is a typo; a key there and not here is a SILENT
// REFUSAL — the player picks it up, the client shows it, and the server declines
// to record it with nothing but one oplog line to show for it. The four gems
// were exactly that: present in `inv` since gems were added, missing here, so
// they would never have reached a character document.
// `tools/check_tables.mjs` enforces the correspondence in both directions.
const ITEM_KEYS = new Set([
  'wood', 'stone', 'planks', 'arrows', 'hide', 'bone', 'bandages', 'potions',
  'iron_ore', 'mithril_ore', 'runic_ore', 'iron_ingot', 'mithril_ingot',
  'runic_ingot', 'steel_ingot', 'siege_ram', 'skull', 'relics',
  'ruby', 'sapphire', 'emerald', 'diamond',
  // placeables — the inventory key equals the placeable type
  'campfire', 'workbench', 'forge', 'secure_chest', 'torch', 'hearth', 'anvil', 'lantern',
]);
const MAX_STACK = 99999;

const fail = reason => ({ ok: false, reason });

// ── Delta bookkeeping ───────────────────────────────────────────────
// Built up, validated, and only then applied. A transaction that fails halfway
// must leave the document untouched — a craft that spent the ore and then
// rejected the tier would destroy the ore, and the player would rightly call it
// theft. Nothing below mutates `doc` until every check has passed.
function emptyDelta() {
  // ⚠ No `weapon` field. An earlier version carried one from buy(), but commit()
  // never applied it and the document has no weapon at all — which hand a player
  // holds is presentation, and belongs in the Phase 2 `prefs` payload, not here.
  // A delta field nothing reads is a promise the server does not keep.
  return { items: {}, gold: 0, bank: 0, tools: {}, tiers: {}, armor: [] };
}
function addItem(d, k, n) { d.items[k] = (d.items[k] || 0) + n; }

function canPay(doc, cost) {
  for (const k of Object.keys(cost || {})) if ((doc.items[k] || 0) < cost[k]) return k;
  return null;
}

// Apply a validated delta. Split from validation deliberately: every transaction
// below produces a delta and hands it here, so there is exactly one place where
// the document changes and exactly one place to audit.
function commit(doc, d) {
  for (const k of Object.keys(d.items)) {
    const v = Math.max(0, Math.min(MAX_STACK, (doc.items[k] || 0) + d.items[k]));
    if (v === 0) delete doc.items[k]; else doc.items[k] = v;
  }
  if (d.gold) doc.wallet.gold = Math.max(0, doc.wallet.gold + d.gold);
  if (d.bank) doc.wallet.bank = Math.max(0, doc.wallet.bank + d.bank);
  for (const k of Object.keys(d.tools)) doc.tools[k] = true;
  for (const k of Object.keys(d.tiers)) doc.tiers[k] = Math.max(doc.tiers[k] || 1, d.tiers[k]);
  for (const mat of d.armor) equipArmor(doc, mat);
  return d;
}

// Mirrors the client's equipArmorPiece: fill an empty slot first, otherwise
// upgrade the weakest slot that this material actually improves.
function equipArmor(doc, mat) {
  let pick = null;
  for (const sl of ARMOR_SLOTS) if (!(doc.armor[sl] || 0)) { pick = sl; break; }
  if (!pick) {
    let low = 99;
    for (const sl of ARMOR_SLOTS) {
      const v = doc.armor[sl] || 0;
      if (v < mat && v < low) { low = v; pick = sl; }
    }
  }
  if (!pick) return false;
  doc.armor[pick] = mat;
  return true;
}
function hasUpgradeSlot(doc, mat) {
  return ARMOR_SLOTS.some(sl => (doc.armor[sl] || 0) < mat);
}

// ── craft ───────────────────────────────────────────────────────────
function craft(doc, intent, ctx) {
  const rec = RECIPES[intent && intent.id];
  if (!rec) return fail('unknown recipe');

  // Proximity. `near` is satisfied by ANY listed station unless nearAll is set.
  // This is real validation, not a courtesy check: the server tracks every
  // placed object, so it independently knows whether a workbench is within
  // reach of the player's server-known position.
  if (rec.near && rec.near.length) {
    const hits = rec.near.map(t => !!(ctx && ctx.nearby && ctx.nearby(t)));
    const ok = rec.nearAll ? hits.every(Boolean) : hits.some(Boolean);
    if (!ok) return fail('need ' + rec.near.join(rec.nearAll ? ' and ' : ' or ') + ' nearby');
  }
  if (rec.notOwned && doc.tools[rec.notOwned]) return fail('already own a ' + rec.notOwned);
  if (rec.needTool && !doc.tools[rec.needTool]) return fail('need a ' + rec.needTool + ' first');
  if (rec.maxTier) for (const k of Object.keys(rec.maxTier))
    if ((doc.tiers[k] || 1) >= rec.maxTier[k]) return fail(k + ' is already that tier or better');
  if (rec.armorSlot && !hasUpgradeSlot(doc, rec.armorSlot)) return fail('full set already');

  // `requires` is held-not-spent; `cost` is spent. Both must be affordable.
  const short = canPay(doc, rec.cost) || canPay(doc, rec.requires);
  if (short) return fail('not enough ' + short);

  const d = emptyDelta();
  for (const k of Object.keys(rec.cost || {})) addItem(d, k, -rec.cost[k]);
  for (const k of Object.keys(rec.gain || {})) addItem(d, k, rec.gain[k]);
  if (rec.placeable) addItem(d, rec.placeable, rec.placeCount || 1);
  if (rec.tool) d.tools[rec.tool] = true;
  if (rec.tier) Object.assign(d.tiers, rec.tier);
  if (rec.armor) d.armor.push(rec.armor);
  // `build` recipes yield nothing here — the cost is paid when the thing is
  // actually placed, so crafting a wall and cancelling must not charge for it.
  return { ok: true, deltas: commit(doc, d) };
}

// ── buy / sell ──────────────────────────────────────────────────────
function buy(doc, intent, ctx) {
  const shop = SHOP[intent && intent.shop];
  if (!shop) return fail('unknown shop');
  const it = shop[intent.id];
  if (!it) return fail('not stocked');
  if (ctx && ctx.nearby && intent.shop === 'smith' && !ctx.nearby('smith'))
    return fail('not at the blacksmith');
  if (doc.wallet.gold < it.price) return fail('need ' + it.price + 'g');

  if (it.kind === 'tool' && doc.tools[it.tool]) return fail('already owned');
  if (it.kind === 'tier') {
    if (!doc.tools[it.needTool]) return fail('need a ' + it.needTool + ' first');
    for (const k of Object.keys(it.tier)) if ((doc.tiers[k] || 1) >= it.tier[k]) return fail('already that tier');
  }
  if (it.kind === 'armor' && !hasUpgradeSlot(doc, it.armor)) return fail('full set already');
  if (it.kind === 'item') {
    if (!ITEM_KEYS.has(it.item)) return fail('unsellable item');
    if (it.maxStack && (doc.items[it.item] || 0) >= it.maxStack) return fail('already full');
  }

  const d = emptyDelta();
  d.gold = -it.price;
  if (it.kind === 'item')  addItem(d, it.item, it.count || 1);
  if (it.kind === 'tool')  d.tools[it.tool] = true;
  if (it.kind === 'tier')  Object.assign(d.tiers, it.tier);
  if (it.kind === 'armor') d.armor.push(it.armor);
  return { ok: true, deltas: commit(doc, d) };
}

// ── bank ────────────────────────────────────────────────────────────
// Gold moves between the purse and the bank and NOWHERE else. Modelled as its
// own transaction rather than two inventory edits so the invariant "banking
// never changes total gold" is stated in one place and cannot drift.
function bank(doc, intent) {
  const amt = Math.floor(Number(intent && intent.amount));
  if (!isFinite(amt) || amt <= 0) return fail('bad amount');
  const dep = intent.dir === 'deposit';
  if (dep && doc.wallet.gold < amt) return fail('not enough gold');
  if (!dep && doc.wallet.bank < amt) return fail('not enough in the bank');
  const d = emptyDelta();
  d.gold = dep ? -amt : amt;
  d.bank = dep ? amt : -amt;
  return { ok: true, deltas: commit(doc, d) };
}

// ── pickup ──────────────────────────────────────────────────────────
// The drop itself is already server-owned (the room holds `drops` and decides
// who gets it first), so the only missing half was crediting the document. The
// room resolves the drop and passes the resulting stack in as `intent`.
function pickup(doc, intent) {
  const k = '' + (intent && intent.type);
  const n = Math.floor(Number(intent && intent.count));
  if (!ITEM_KEYS.has(k) && k !== 'gold') return fail('unknown item');
  if (!isFinite(n) || n <= 0 || n > 9999) return fail('bad count');
  const d = emptyDelta();
  if (k === 'gold') d.gold = n; else addItem(d, k, n);
  return { ok: true, deltas: commit(doc, d) };
}

// ── gather ──────────────────────────────────────────────────────────
// Yield is decided HERE, from the tool tier the server knows. That is the half
// that matters: the tile the client names is only a claim, but what it is worth
// is not negotiable. See the caveat at the top of this file for what is still
// missing (per-node HP and respawn — Phase 3).
// ⚠ Trees and ore pay out on DIFFERENT schedules, and getting that wrong would
// quietly multiply or starve a resource. Ore yields every swing, scaled by the
// pickaxe tier (a better pick pulls the same total ore out in fewer swings —
// mirrors depleteNode). A tree yields NOTHING per swing and its whole 4 logs at
// the moment it falls, so the client sends a gather intent for a tree only on
// the felling blow.
const TREE_WOOD = 4;
const GATHER_YIELD = {
  tree:  { item: 'wood',     base: TREE_WOOD, tierKey: null },
  stone: { item: 'stone',    base: 1, tierKey: 'pickaxe' },
  iron:  { item: 'iron_ore', base: 1, tierKey: 'pickaxe' },
};
function gather(doc, intent, ctx) {
  const kind = ctx && ctx.resourceAt && ctx.resourceAt(intent.tx, intent.ty);
  if (!kind) return fail('nothing to harvest there');
  if (ctx.inRange && !ctx.inRange(intent.tx, intent.ty)) return fail('too far away');
  if (kind !== 'tree' && !doc.tools.pickaxe) return fail('need a pickaxe');
  if (kind === 'tree' && !doc.tools.axe && !doc.tools.sword) return fail('need an axe');

  const g = GATHER_YIELD[kind];
  // Better picks pull the same total ore out in fewer swings, so the per-swing
  // yield scales with the tier. Mirrors depleteNode() on the client.
  const tier = g.tierKey ? Math.max(1, Math.min(5, doc.tiers[g.tierKey] || 1)) : 1;
  const d = emptyDelta();
  addItem(d, g.item, g.base * tier);
  return { ok: true, deltas: commit(doc, d) };
}

// ── dispatch ────────────────────────────────────────────────────────
const HANDLERS = { craft, buy, bank, pickup, gather };

function apply(doc, kind, intent, ctx) {
  const h = HANDLERS['' + kind];
  if (!h) return fail('unknown transaction');
  if (!doc || typeof doc !== 'object') return fail('no character');
  try {
    return h(doc, intent || {}, ctx || {});
  } catch (e) {
    // A throw here means a bug in validation, not a cheating client. Never let
    // it half-apply: the delta is only committed on the success path, so the
    // document is still intact whatever went wrong.
    return fail('internal: ' + e.message);
  }
}

module.exports = { apply, RECIPES, SHOP, ITEM_KEYS, ARMOR_SLOTS, equipArmor, hasUpgradeSlot };
