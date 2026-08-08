// loot_system.js — RPG Leveling (1-50), ARPG Procedural Loot Generator, & Gem Socketing
import { getXpForLevel, ITEM_RARITIES, AFFIX_PREFIXES, AFFIX_SUFFIXES, GEMS } from './constants.js';
import { player, inv, floaters } from './state.js';
import { snd } from './audio.js';

// ── 1. RPG Leveling & Character Experience ──────────────────────────────────
export function addPlayerXp(amount) {
  if (!amount || amount <= 0 || player.level >= 50) return false;
  player.xp += Math.round(amount);

  let leveledUp = false;
  while (player.xp >= player.xpMax && player.level < 50) {
    player.xp -= player.xpMax;
    player.level++;
    player.xpMax = getXpForLevel(player.level);
    player.statPoints += 3;
    player.skillPoints += 1;
    leveledUp = true;

    // Recalculate Max HP & Speed
    const vit = (player.stats?.vit || 10);
    player.maxHp = 100 + (vit - 10) * 10;
    player.hp = player.maxHp;

    try { snd.heal(); } catch (_) {}
    if (typeof floaters !== 'undefined') {
      floaters.push({
        x: player.x, y: player.y - 40,
        text: `✨ LEVEL UP! LEVEL ${player.level} (+3 Stat Pts)`,
        life: 2.5
      });
    }
  }
  return leveledUp;
}

// ── 2. ARPG Procedural Loot Generator ─────────────────────────────────────
const BASE_EQUIPMENT_TYPES = [
  { type: 'weapon', slot: 'weapon', baseKey: 'sword', name: 'Longsword', reqStat: 'str', baseDmg: 20 },
  { type: 'weapon', slot: 'weapon', baseKey: 'bow',   name: 'War Bow',   reqStat: 'dex', baseDmg: 16 },
  { type: 'armor',  slot: 'armor',  baseKey: 'chest', name: 'Cuirass',   reqStat: 'str', baseDef: 15 },
  { type: 'armor',  slot: 'armor',  baseKey: 'helm',  name: 'Greathelm',reqStat: 'vit', baseDef: 10 },
  { type: 'armor',  slot: 'armor',  baseKey: 'boots', name: 'Greaves',  reqStat: 'dex', baseDef: 8  },
];

export function rollRarity(sourceType = 'basic') {
  const roll = Math.random();
  if (sourceType === 'boss' || sourceType === 'champ') {
    if (roll < 0.20) return 'legendary';
    if (roll < 0.55) return 'epic';
    return 'rare';
  } else if (sourceType === 'elite') {
    if (roll < 0.05) return 'legendary';
    if (roll < 0.15) return 'epic';
    if (roll < 0.40) return 'rare';
    return 'uncommon';
  } else {
    if (roll < 0.01) return 'legendary';
    if (roll < 0.05) return 'epic';
    if (roll < 0.15) return 'rare';
    if (roll < 0.45) return 'uncommon';
    return 'common';
  }
}

export function generateLootDrop(sourceType = 'basic', targetLevel = player.level || 1) {
  const rarityKey = rollRarity(sourceType);
  const rarity = ITEM_RARITIES[rarityKey];
  const base = BASE_EQUIPMENT_TYPES[Math.floor(Math.random() * BASE_EQUIPMENT_TYPES.length)];

  const item = {
    id: 'item_' + Date.now() + '_' + Math.floor(Math.random() * 10000),
    slot: base.slot,
    baseKey: base.baseKey,
    rarity: rarityKey,
    rarityName: rarity.name,
    color: rarity.color,
    levelReq: Math.max(1, Math.min(50, targetLevel)),
    statReq: { [base.reqStat]: Math.max(8, 8 + Math.floor(targetLevel * 0.4)) },
    baseStat: base.baseDmg ? { dmg: Math.round(base.baseDmg + targetLevel * 1.5) } : { def: Math.round(base.baseDef + targetLevel * 1.2) },
    affixes: [],
    sockets: [],
    name: '',
  };

  // Roll Affixes
  let prefixName = '';
  let suffixName = '';

  const availPrefixes = [...AFFIX_PREFIXES];
  const availSuffixes = [...AFFIX_SUFFIXES];

  for (let i = 0; i < rarity.affixes; i++) {
    if (i % 2 === 0 && availPrefixes.length > 0) {
      const idx = Math.floor(Math.random() * availPrefixes.length);
      const pref = availPrefixes.splice(idx, 1)[0];
      const val = Math.round(pref.min + Math.random() * (pref.max - pref.min) + (targetLevel * 0.2));
      item.affixes.push({ key: pref.key, stat: pref.stat, val, name: pref.name, unit: pref.unit });
      if (!prefixName) prefixName = pref.name;
    } else if (availSuffixes.length > 0) {
      const idx = Math.floor(Math.random() * availSuffixes.length);
      const suff = availSuffixes.splice(idx, 1)[0];
      const val = Math.round(suff.min + Math.random() * (suff.max - suff.min) + (targetLevel * 0.3));
      item.affixes.push({ key: suff.key, stat: suff.stat, val, name: suff.name, unit: suff.unit });
      if (!suffixName) suffixName = suff.name;
    }
  }

  // Construct Name
  let fullName = base.name;
  if (prefixName) fullName = `${prefixName} ${fullName}`;
  if (suffixName) fullName = `${fullName} ${suffixName}`;
  item.name = fullName;

  // Add Open Gem Sockets
  for (let s = 0; s < rarity.sockets; s++) {
    item.sockets.push({ gem: null });
  }

  return item;
}

// ── 3. Aggregated Equipment & Gem Stat Calculator ────────────────────────
export function getEquipmentStats(playerObj = player) {
  const totals = {
    str: 0, dex: 0, int: 0, vit: 0,
    maxHp: 0, speed: 0, fireDmg: 0,
    allDmg: 0, critChance: 0, lifesteal: 0, armor: 0,
  };

  const equipped = playerObj.equippedItems || {};
  ['weapon', 'armor'].forEach((slotKey) => {
    const item = equipped[slotKey];
    if (!item) return;

    // Item affixes
    if (Array.isArray(item.affixes)) {
      item.affixes.forEach((a) => {
        if (totals[a.stat] !== undefined) totals[a.stat] += a.val;
      });
    }

    // Socketed Gems
    if (Array.isArray(item.sockets)) {
      item.sockets.forEach((s) => {
        if (s && s.gem && GEMS[s.gem]) {
          const gem = GEMS[s.gem];
          if (totals[gem.stat] !== undefined) totals[gem.stat] += gem.val;
        }
      });
    }
  });

  return totals;
}

// ── 4. Gem Socketing ──────────────────────────────────────────────────────
export function socketGem(item, socketIdx, gemKey) {
  if (!item || !Array.isArray(item.sockets) || !item.sockets[socketIdx]) return false;
  if (!gemKey || !GEMS[gemKey] || (inv[gemKey] || 0) <= 0) return false;
  if (item.sockets[socketIdx].gem !== null) return false; // already socketed

  inv[gemKey]--;
  item.sockets[socketIdx].gem = gemKey;
  return true;
}
