// state.js — all shared mutable state, exported by reference
// Objects and arrays are mutated in-place; G wraps mutable primitives.

// ── World ──────────────────────────────────────────────────────────
export const map             = [];  // filled by world.js on import
export const resourceHp      = [];
export const respawnAt       = [];
export const origTile        = [];
export const playerPlacedWalls = [];

// ── Entities ───────────────────────────────────────────────────────
export const player = {
  x: 240 * 48 + 24, y: 300 * 48 + 24,
  r: 13, speed: 190,
  hp: 100, maxHp: 100, iframes: 0,
  dead: false, ghost: false, hasArmor: false,
  hasAxe: true, hasSword: false, hasBow: false, hasPickaxe: false, weapon: 'axe',
  hasHouseTool: false,
  bandageTimer: 0,
  stunTimer: 0, webTimer: 0,
  poisonTimer: 0, poisonDmg: 0, poisonTick: 0,
  charmed: false, charmTimer: 0,
  hasHorse: false, onHorse: false,
  isRat: false, ratTimer: 0,
  name: 'Traveler',
  gender: 'male',           // 'male' | 'female'
  race: 'Human',            // 'Human' | 'Gargoyle' | 'Zombie' | 'Vampire' | 'Centaur'
  stats: { str: 10, dex: 10, int: 10, vit: 10 },
  level: 1,
  xp: 0,
  xpMax: 100,
  statPoints: 0,
  skillPoints: 0,
  equipmentItems: [],       // ARPG item instances held or equipped
  equippedItems: { weapon: null, armor: null },
  equippedArtifacts: { neck:null, ring1:null, ring2:null, brac1:null, brac2:null },  // defId per jewelry slot
  artifactInv: [],          // held artifacts: {defId, identified}
  artifactBonus: {},        // stat key -> summed bonus, recomputed on equip/unequip
  dollGender: 'm',          // paper doll art variant: 'm' | 'f'
  pickaxeTier: 1,           // 1 = basic, 2 = iron
};
export const enemies      = [];
export const guards       = [];
export const drops        = [];
export const projectiles  = [];
export const eProjList    = [];
export const placedObjects= [];
export const floaters     = [];
export const hitFlash     = {};

// ── Inventory / skills ──────────────────────────────────────────────
export const inv = { wood:0, stone:0, planks:0, arrows:10, hide:0, gold:20, bandages:0, potions:0, skull:0, relics:0, iron_ore:0, iron_ingot:0, steel_ingot:0, mithril_ore:0, mithril_ingot:0, runic_ore:0, runic_ingot:0, siege_ram:0, torch:0, lantern:0, ruby:0, sapphire:0, emerald:0, diamond:0 };

export const skills = {
  tactics:   { xp:0 },
  archery:   { xp:0 },
  hiding:    { xp:0, active:false, timer:0, cooldown:0 },
  healing:   { xp:0 },
  wrestling: { xp:0, cooldown:0 },
};

// ── Economy ────────────────────────────────────────────────────────
export const bank = { gold:0, interestAccum:0 };

// ── Combat helpers ─────────────────────────────────────────────────
export const swordSwing = { active:false, angle:0, lifetime:0, duration:0.18 };

// ── Input state ────────────────────────────────────────────────────
export const keys   = {};
export const stick  = { active:false, baseX:0, baseY:0, dx:0, dy:0, id:null };
export const action = { active:false, id:null, sx:0, sy:0 };
export const mouse  = { down:false, sx:0, sy:0, hasPos:false };
export const rmb    = { down:false };

// ── Viewport / minimap ─────────────────────────────────────────────
export const tileViewport = {
  canvas: document.createElement('canvas'),
  dirty: true, camTileX: -9999, camTileY: -9999,
};

// ── NPC data ───────────────────────────────────────────────────────
export const MERCHANT = { x:301*48+24, y:357*48+24, r:13 };  // NW shop
export const BANKER   = { x:310*48+24, y:367*48+24, r:13 };  // bank S entrance
export const HEALER   = { x:310*48+24, y:344*48+24, r:13 };  // healer house
export const WORLD_HEALERS = [
  { x: 60*48+24,  y:210*48+24, r:13, healCooldown:0 },
  { x:400*48+24,  y: 92*48+24, r:13, healCooldown:0 },
  { x:118*48+24,  y:410*48+24, r:13, healCooldown:0 },
  { x:448*48+24,  y:295*48+24, r:13, healCooldown:0 },
  { x:195*48+24,  y:148*48+24, r:13, healCooldown:0 },
  { x:193*48+24,  y:234*48+24, r:13, healCooldown:0 },  // dungeon entrance (near PORTAL_A)
];

export const BLACKSMITH = { x:319*48+24, y:357*48+24, r:13 };  // NE shop
export const MAGE       = { x:301*48+24, y:367*48+24, r:13 };  // SW shop
export const FARRIER    = { x:319*48+24, y:367*48+24, r:13 };  // SE shop

// Artifact-system NPCs — one column added on each side of the shop square
export const ANTIQUARIAN  = { x:292*48+24, y:357*48+24, r:13 };  // W, north row
export const CRYPTOLOGIST = { x:292*48+24, y:367*48+24, r:13 };  // W, south row
export const CURATOR      = { x:328*48+24, y:357*48+24, r:13 };  // E, north row
export const GRAVE_ROBBER = { x:328*48+24, y:367*48+24, r:13 };  // E, south row

// ── Mutable primitive state (wrapped so modules can update them) ────
export const G = {
  gameTime: 0, camX: 0, camY: 0,
  swingTimer: 0, bowCooldown: 0,
  craftOpen: false, buildMode: false, buildItem: 'wall',
  tradeOpen: false, skillOpen: false, bankOpen: false,
  corpseLootOpen: false, corpse: null,
  minimapOpen: true, minimapX: null, minimapY: null,
  minimapZoom: 1.0, minimapSz: null,
  minimapDrag: null, minimapResize: null, minimapHover: false,
  guardCallCooldown: 0, enemyRespawnClock: 0,
  _stepAcc: 0, _lastTileType: -1,
  inDungeon: false,
  smithOpen: false, mageOpen: false, farrierOpen: false,
  antiqOpen: false, cryptoOpen: false, curatorOpen: false, robberOpen: false,
  hotbarSel: 0, hotbarEditOpen: false,
  packScroll: 0,            // backpack grid scroll row
  packSel: null,            // selected backpack cell index
  dollPick: null,           // open jewelry picker: slotKey string or null
  antiqStock: null, antiqStockAt: 0,   // Antiquarian shop stock + last-refresh gameTime
  bounty: null, bountyAt: 0,           // Museum Curator's current bounty + last-refresh gameTime
  contracts: null,                     // 3 active job-board contracts (endless, self-rerolling)
  contractRank: 0,                     // total contracts completed — drives difficulty tier
  contractsOpen: false,
  charOpen: false,                     // character sheet (L): level, attributes, ARPG gear
  charSel: null,                       // selected bag item index in the character sheet
  worldChestOpen: false,               // treasure-chest loot panel
  activeWorldChest: null,
  chestsLooted: {},                    // "tx,ty" -> true once emptied
  dungeonFloor: 0,                     // 0 = above ground, 1-5 = dungeon depth
  dungeonBest: 1,                      // deepest floor ever reached (contract/bragging target)
  floorBossesDown: {},                 // floorNum -> true once its named boss is slain
  dungeonEntryX: null, dungeonEntryY: null,
  portalCooldown: 0,
  hint: '', ctx: null, canvas: null,
  houseMenuOpen: false,
  housePlacementMode: false,
  placingHouse: null,
  prePlacementPos: null,
  placedHouses: [],
  houseSettingsOpen: false,
  activeHouseIndex: -1,
  devGuiOpen: false,
  charSelectOpen: false,
  charCreatorOpen: false,
};

