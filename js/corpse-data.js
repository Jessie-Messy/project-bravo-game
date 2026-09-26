// corpse-data.js — what a dead mob leaves, and what a blade can take from it.
//
// Pure data, no imports, so tools/test/corpses.mjs can check it without a DOM.
//
// Owner's rules (2026-09-26):
//   * An ORDINARY mob's corpse is open to everyone: one shared set of loot, first
//     come first served.
//   * A SPECIAL corpse (boss / named / champion) opens only for players who dealt
//     damage, and each of them rolls the special drop for themselves.
//   * Bosses keep their shower of gold on the ground — that is spectacle, not loot.
//   * Harvesting has no skill. It needs the right tool: a knife, or a bladed
//     weapon in hand.

// How long a body lies there, how many can at once, and how close you must be.
export const CORPSE_TTL     = 90;     // seconds
export const CORPSE_MAX     = 14;     // oldest goes first past this
export const CORPSE_REACH   = 1.8;    // tiles
export const HARVEST_SECS   = 2.2;    // seconds of kneeling with a knife
export const HARVESTED_TTL  = 12;     // a picked-over carcass does not linger

// What skinning / butchering yields, per mob type: item -> [min, max].
// A type that is not listed has nothing to harvest (bandits, goblins, slimes…).
// ⚠ A species listed with `hide` does NOT also put hide in its loot: the pelt is
// what the knife is for. Before corpses existed wolves dropped hide straight onto
// the ground; now you skin it.
export const HARVEST = {
  wolf:         { raw_meat: [1, 3], hide: [1, 2] },
  hellhound:    { raw_meat: [1, 2], hide: [1, 2] },
  giant_rat:    { raw_meat: [1, 1] },
  troll:        { raw_meat: [2, 3], hide: [1, 2] },
  troll_l:      { raw_meat: [3, 5], hide: [3, 4] },
  silver_serp:  { raw_meat: [1, 2], hide: [1, 1] },
  shore_crab:   { raw_meat: [1, 2] },
  reef_serpent: { raw_meat: [2, 3], hide: [1, 2] },
};
// Never harvestable, even though they are animals. Pets are not food.
export const NEVER_HARVEST = new Set(['cat']);

// Mob types that are always special corpses. Bosses spawned from ordinary types
// (floor bosses, coast bosses, champions) are flagged on the enemy object
// instead — see isSpecialKill.
export const SPECIAL_TYPES = new Set(['piper', 'goblin_k', 'troll_l', 'spider_q']);
export function isSpecialKill(e) {
  return !!(e && (e.isChampBoss || e.floorBoss || e.coastBoss || SPECIAL_TYPES.has(e.type)));
}

// The weapons that count as a blade for harvesting. A knife in the pack always
// counts; otherwise it is whatever is in hand.
export const BLADED = new Set(['sword', 'axe', 'dagger', 'knife']);
export function canHarvestWith(player) {
  return !!(player && (player.hasKnife || BLADED.has(player.weapon)));
}

// Roll one harvest. `rand` is injectable so the test can pin it.
export function rollHarvest(type, rand = Math.random) {
  const t = HARVEST[type];
  if (!t || NEVER_HARVEST.has(type)) return null;
  const out = {};
  for (const [k, [lo, hi]] of Object.entries(t)) out[k] = lo + Math.floor(rand() * (hi - lo + 1));
  return out;
}

// Cooked meat heals over time rather than at once, so it is food, not a potion.
export const FOOD = {
  cooked_meat: { heal: 36, secs: 12 },
};
