// constants.js — pure compile-time constants, no imports
export const TILE = 48, MAP_W = 480, MAP_H = 554;
export const T = {
  GRASS:0, PATH:1, WATER:2, TREE:3, STONE:4,
  WALL:5, BRIDGE:6, CAVE_FLOOR:7, CAVE_WALL:8, CAVE_ENTRANCE:9,
  TELEPORT:10, ORE_IRON:11, STAINED_GLASS:12,
};
export const BLOCKING = {
  [0]:false,[1]:false,[2]:true,[3]:true,[4]:true,
  [5]:true,[6]:false,[7]:false,[8]:true,[9]:false,
  [10]:false,[11]:true,[12]:true,
};
export const CITY = { x1:280, y1:332, x2:340, y2:392 };  // Lunar

// Dungeon zone — sits below the overworld on the same map
// overworld: y 0–479 | separator (CAVE_WALL): y 480–489 | dungeon: y 490–553
export const DUNGEON_X0 = 208; // dungeon left edge (tile x)
export const DUNGEON_Y0 = 490; // dungeon top edge  (tile y)
export const DUNGEON_W  = 64;
export const DUNGEON_H  = 64;

// Combat
export const HARVEST_RANGE = TILE * 1.6;
export const SWORD_RANGE   = TILE * 1.8;
export const SWORD_ARC     = Math.PI / 2;

// World resources
export const TREE_HP  = 4, STONE_HP  = 5, IRON_HP = 8;
export const RESPAWN_TREE = 30, RESPAWN_STONE = 120, RESPAWN_IRON = 180;
// 24 real minutes per in-game day (1 real minute = 1 in-game hour), so a
// tester sees roughly one night per session instead of one every few minutes.
// Night proper (20:00-04:00) is ~8 of those minutes.
export const DAY_CYCLE_SEC = 1440;

// Enemy population
export const ENEMY_RESPAWN_DELAY      = 45;
export const WOLF_TARGET              = 32;
export const BANDIT_TARGET            = 16;
export const ENEMY_POP_CHECK_INTERVAL = 20;

// Champ system
export const CHAMP_KILLS_PER_CANDLE = [5, 8, 12, 16, 20, 24];
export const CHAMP_MAX_MOBS         = [4, 6,  8, 10, 12, 14];
// Rat-dungeon altar spawns a full wave across the whole dungeon per stage
export const CHAMP_DUNGEON_MAX      = [12, 14, 16, 18, 20, 22];

// Skills
export const XP_LEVELS    = [0, 100, 300, 700, 1500, 3000, 5500, 9000, 14000, 20000];
export const TACTICS_DMG  = [25, 28, 33, 40, 50, 62, 76, 92, 110, 130];
export const ARCHERY_DMG  = [15, 18, 22, 28, 35, 43, 53, 65, 78, 92];
export const HIDING_DUR   = [3, 6, 10, 16, 25, 30, 36, 43, 51, 60];
export const HEAL_AMT     = [20, 30, 45, 60, 80, 105, 135, 170, 210, 260];
export const WRESTLE_STUN = [1, 1.5, 2.5, 3.5, 5, 6, 7, 8, 9, 10];
export const WRESTLE_DMG  = [10, 15, 22, 32, 45, 60, 78, 100, 125, 155];

// Skill panel
export const SKILL_PANEL_W   = 290;
export const SKILL_PANEL_ROW = 72;
export const SKILL_PANEL_H   = 36 + 5 * 72 + 14; // 410

// Craft panel
export const PANEL_W   = 500, PANEL_PAD = 12;
export const BTN_H     = 32,  HEADER_H  = 32, BTN_GAP = 4;

// Trade panel
export const TRADE_W      = 390, TRADE_PAD    = 14;
export const TRADE_ROW_H  = 40,  TRADE_HEADER = 44, TRADE_SECT_H = 20;

// Bank panel
export const BANK_W = 280, BANK_H = 248, BANK_PAD = 14;
export const BANK_HEADER = 30, BANK_BTN_W = 78, BANK_BTN_H = 34;

// Guards + minimap
export const GUARD_CALL_COOLDOWN = 30;
export const MINIMAP_BASE        = 160;

// Character Races & Attributes
export const STARTING_STAT_POINTS = 15;
export const BASE_STAT_MIN = 5;
export const BASE_STAT_MAX = 30;

export const RACES = {
  Human: {
    name: 'Human',
    icon: '👤',
    desc: 'Adaptable and balanced survivors of Lunar.',
    passive: 'Versatile: +2 to all base attributes.',
    bonus: { str: 2, dex: 2, int: 2, vit: 2 },
    color: '#e8dcc0',
    tint: 0xffffff,
  },
  Gargoyle: {
    name: 'Gargoyle',
    icon: '🗿',
    desc: 'Carved from ancient stone, nearly unbreakable.',
    passive: 'Stone Skin: +15% damage reduction.',
    bonus: { str: 5, dex: 0, int: 0, vit: 3 },
    color: '#a0aab8',
    tint: 0x8894a4,
  },
  Zombie: {
    name: 'Zombie',
    icon: '🧟',
    desc: 'Relentless undead corpse powered by necrotic energy.',
    passive: 'Undead Resilience: Regenerates 1 HP every 3 seconds.',
    bonus: { str: 3, dex: 0, int: 0, vit: 5 },
    color: '#8cb870',
    tint: 0x6e9658,
  },
  Vampire: {
    name: 'Vampire',
    icon: '🦇',
    desc: 'Nocturnal predator of the night.',
    passive: 'Night Vision: Sees in the dark + 5% Melee Lifesteal.',
    bonus: { str: 0, dex: 4, int: 4, vit: 0 },
    color: '#e06060',
    tint: 0xc85060,
  },
  Centaur: {
    name: 'Centaur',
    icon: '🐴',
    desc: 'Half-human, half-beast with legendary woodland speed.',
    passive: 'Swift Gallop: +25 base movement speed.',
    bonus: { str: 3, dex: 5, int: 0, vit: 0 },
    color: '#d4a050',
    tint: 0xb88038,
  },
};

// Leveling XP Formula: XP needed to advance from level L to L+1
export function getXpForLevel(lvl) {
  if (lvl >= 50) return 999999;
  return Math.floor(100 * Math.pow(lvl, 1.45));
}

// ARPG Loot Rarities
export const ITEM_RARITIES = {
  common:    { name: 'Common',    color: '#ffffff', bg: 'rgba(255,255,255,0.1)', affixes: 0, sockets: 0, chance: 0.60 },
  uncommon:  { name: 'Uncommon',  color: '#60ff60', bg: 'rgba(96,255,96,0.15)',  affixes: 1, sockets: 0, chance: 0.25 },
  rare:      { name: 'Rare',      color: '#50b0ff', bg: 'rgba(80,176,255,0.2)',  affixes: 2, sockets: 1, chance: 0.10 },
  epic:      { name: 'Epic',      color: '#d060ff', bg: 'rgba(208,96,255,0.25)', affixes: 3, sockets: 1, chance: 0.04 },
  legendary: { name: 'Legendary', color: '#ff9900', bg: 'rgba(255,153,0,0.3)',   affixes: 4, sockets: 2, chance: 0.01 },
};

// Item Stat Affixes
export const AFFIX_PREFIXES = [
  { key: 'str',       name: 'Heavy',      min: 2, max: 6,  stat: 'str',       unit: 'STR' },
  { key: 'dex',       name: 'Swift',      min: 2, max: 6,  stat: 'dex',       unit: 'DEX' },
  { key: 'int',       name: 'Arcane',     min: 2, max: 6,  stat: 'int',       unit: 'INT' },
  { key: 'vit',       name: 'Stout',      min: 2, max: 6,  stat: 'vit',       unit: 'VIT' },
  { key: 'fireDmg',   name: 'Flaming',    min: 4, max: 12, stat: 'fireDmg',   unit: 'Fire Dmg' },
  { key: 'critChance',name: 'Sharpened',  min: 3, max: 8,  stat: 'critChance',unit: '% Crit' },
  { key: 'lifesteal', name: 'Vampiric',   min: 2, max: 5,  stat: 'lifesteal', unit: '% Life Steal' },
];

export const AFFIX_SUFFIXES = [
  { key: 'maxHp',     name: 'of Vitality', min: 10, max: 40, stat: 'maxHp',     unit: 'Max HP' },
  { key: 'speed',     name: 'of the Wind', min: 8,  max: 20, stat: 'speed',     unit: 'Speed' },
  { key: 'allDmg',    name: 'of Power',    min: 5,  max: 15, stat: 'allDmg',    unit: '% All Dmg' },
  { key: 'armor',     name: 'of Iron',     min: 5,  max: 15, stat: 'armor',     unit: '% Armor' },
];

// Socketable Gems
export const GEMS = {
  ruby:     { key: 'ruby',     name: 'Ruby',     icon: '🔴', color: '#ff4444', bonusText: '+8 Attack Damage',      stat: 'allDmg',    val: 0.08 },
  sapphire: { key: 'sapphire', name: 'Sapphire', icon: '🔷', color: '#44aaff', bonusText: '+4 INT & -10% CDs',     stat: 'int',       val: 4 },
  emerald:  { key: 'emerald',  name: 'Emerald',  icon: '🟢', color: '#44ff66', bonusText: '+4 DEX & +5% Crit',     stat: 'critChance',val: 5 },
  diamond:  { key: 'diamond',  name: 'Diamond',  icon: '⚪', color: '#ffffff', bonusText: '+5 VIT & +20 Max HP',   stat: 'vit',       val: 5 },
};


