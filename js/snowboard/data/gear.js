// gear.js — boards and riders.
//
// Nothing here is a downloaded asset. Every board and every rider is built from
// these numbers at runtime by rider.js: the topsheet is painted into a canvas
// texture from `art`, and the rider's body is lathed from `build` + `fit`. That
// keeps the whole game a couple of hundred KB over the wire and means a new
// board is a dozen lines of data rather than a modelling session.
//
// Stats are 1–10 and feed physics.js directly:
//   speed   — top-end and how quickly drag gives up
//   edge    — carve grip; high edge holds a line on ice
//   float   — how far the board sits above deep snow (powder drag)
//   pop     — ollie height
//   agility — turn rate; short boards spin fast and track badly

export const BOARDS = [
  {
    id: 'cornice',
    name: 'Cornice 156',
    kind: 'All-Mountain',
    blurb: 'Directional twin, medium flex. Does everything competently and nothing stupidly — the board you learn the mountain on.',
    stats: { speed: 6, edge: 6, float: 5, pop: 6, agility: 6 },
    length: 1.56, waist: 0.252, taper: 0.04, camber: 0.012, nose: 0.30,
    art: { base: '#1b2a4a', accent: '#e8552f', ink: '#f5f7fb', pattern: 'ridge' },
  },
  {
    id: 'parkrat',
    name: 'Park Rat 149',
    kind: 'Freestyle',
    blurb: 'True twin, soft flex, centred stance. Built to spin, press and land switch. It will not thank you at 90 km/h.',
    stats: { speed: 4, edge: 5, float: 3, pop: 9, agility: 9 },
    length: 1.49, waist: 0.248, taper: 0.00, camber: 0.016, nose: 0.26,
    art: { base: '#12121a', accent: '#c6f24e', ink: '#ff3ea5', pattern: 'splatter' },
  },
  {
    id: 'powfish',
    name: 'Powder Fish 162',
    kind: 'Powder',
    blurb: 'Swallowtail, huge nose rocker, set-back stance. Surfs the deep like it is on rails and hates a groomer.',
    stats: { speed: 7, edge: 4, float: 10, pop: 5, agility: 4 },
    length: 1.62, waist: 0.266, taper: 0.11, camber: -0.008, nose: 0.40,
    art: { base: '#0d3b3e', accent: '#f2c14e', ink: '#8ee6d8', pattern: 'wave' },
  },
  {
    id: 'kandahar',
    name: 'Kandahar GS 168',
    kind: 'Carve / Race',
    blurb: 'Narrow, stiff, aggressively cambered alpine plate. Absurd edge hold, zero forgiveness, and the fastest thing on the hill.',
    stats: { speed: 10, edge: 10, float: 2, pop: 4, agility: 3 },
    length: 1.68, waist: 0.234, taper: 0.06, camber: 0.020, nose: 0.24,
    art: { base: '#8b0f1d', accent: '#f7f7f7', ink: '#111318', pattern: 'race' },
  },
  {
    id: 'splitridge',
    name: 'Split Ridge 159',
    kind: 'Backcountry',
    blurb: 'Splitboard with a stiff tail and a hunting nose. Chatter-proof through crud and happiest a long way from a lift.',
    stats: { speed: 7, edge: 7, float: 7, pop: 6, agility: 5 },
    length: 1.59, waist: 0.258, taper: 0.07, camber: 0.006, nose: 0.34,
    art: { base: '#2f3a2c', accent: '#d9a441', ink: '#e7ede4', pattern: 'topo' },
  },
  {
    id: 'aurora',
    name: 'Aurora 154',
    kind: 'Freeride',
    blurb: 'Hybrid camber, carbon stringers, a nose that pivots out of trouble. Quick edge-to-edge in tight trees.',
    stats: { speed: 7, edge: 8, float: 6, pop: 7, agility: 8 },
    length: 1.54, waist: 0.250, taper: 0.05, camber: 0.010, nose: 0.32,
    art: { base: '#241a3d', accent: '#7ad3ff', ink: '#c9a6ff', pattern: 'aurora' },
  },
];

// ── Riders ────────────────────────────────────────────────────────
// `mods` are multiplicative trims on top of the board, kept deliberately small
// (±12%) so board choice stays the dominant decision and rider choice is
// flavour plus a nudge. `style` scales trick scoring.
export const RIDERS = [
  {
    id: 'kai',
    name: 'Kai Nakamura',
    home: 'Niseko, JP',
    tag: 'Powder Surfer',
    blurb: 'Grew up riding waist-deep birch glades in the dark. Reads a fall line before the light does.',
    mods: { speed: 1.00, control: 1.06, style: 1.10, balance: 1.04 },
    build: { height: 1.74, mass: 68, shoulders: 0.44, chest: 0.31 },
    fit: {
      jacket: '#e8402f', jacketAlt: '#1c2333', pants: '#20263a', boots: '#141821',
      skin: '#e2b48a', hair: '#141014', helmet: null, beanie: '#f6c445',
      goggle: '#ff8a3d', goggleFrame: '#f4f7ff', scarf: null,
    },
  },
  {
    id: 'noa',
    name: 'Noa Lindqvist',
    home: 'Åre, SE',
    tag: 'Park Technician',
    blurb: 'Nine years of contest runs. Counts rotations out loud and lands switch without looking.',
    mods: { speed: 0.98, control: 1.04, style: 1.12, balance: 1.08 },
    build: { height: 1.68, mass: 60, shoulders: 0.41, chest: 0.29 },
    fit: {
      jacket: '#c6f24e', jacketAlt: '#16181f', pants: '#2b2f3a', boots: '#101216',
      skin: '#f0cdaa', hair: '#e8dfa0', helmet: '#16181f', beanie: null,
      goggle: '#ff3ea5', goggleFrame: '#c6f24e', scarf: null,
    },
  },
  {
    id: 'mateo',
    name: 'Mateo Rivas',
    home: 'Bariloche, AR',
    tag: 'Speed Freak',
    blurb: 'Came up through alpine racing and never really stopped. Tucks on cat tracks. Wins.',
    mods: { speed: 1.10, control: 1.02, style: 0.96, balance: 0.98 },
    build: { height: 1.83, mass: 82, shoulders: 0.49, chest: 0.35 },
    fit: {
      jacket: '#f7f7f7', jacketAlt: '#8b0f1d', pants: '#8b0f1d', boots: '#1a1c22',
      skin: '#c08b5c', hair: '#2a1d16', helmet: '#8b0f1d', beanie: null,
      goggle: '#2ab7ff', goggleFrame: '#111318', scarf: null,
    },
  },
  {
    id: 'sylvie',
    name: 'Sylvie Renaud',
    home: 'Chamonix, FR',
    tag: 'Alpinist',
    blurb: 'Guides the Vallée Blanche in the morning and rides it for herself in the afternoon. Unbothered by exposure.',
    mods: { speed: 1.02, control: 1.10, style: 1.02, balance: 1.10 },
    build: { height: 1.71, mass: 63, shoulders: 0.42, chest: 0.30 },
    fit: {
      jacket: '#f2c14e', jacketAlt: '#2f3a2c', pants: '#2f3a2c', boots: '#191c18',
      skin: '#efc39c', hair: '#7a4a22', helmet: '#f2c14e', beanie: null,
      goggle: '#ffd166', goggleFrame: '#2f3a2c', scarf: '#b23a2e',
    },
  },
  {
    id: 'darius',
    name: 'Darius Boone',
    home: 'Jackson, WY',
    tag: 'Cliff Hunter',
    blurb: 'Measures a run in how many things he can drop off it. Has a hinge for a set of knees.',
    mods: { speed: 1.04, control: 0.98, style: 1.08, balance: 1.06 },
    build: { height: 1.86, mass: 88, shoulders: 0.51, chest: 0.37 },
    fit: {
      jacket: '#2b6ef2', jacketAlt: '#0e1524', pants: '#12182a', boots: '#0d1017',
      skin: '#7a4d31', hair: '#12100f', helmet: '#0e1524', beanie: null,
      goggle: '#9dfbe0', goggleFrame: '#2b6ef2', scarf: null,
    },
  },
  {
    id: 'ines',
    name: 'Inés Oyarzún',
    home: 'Portillo, CL',
    tag: 'All-Mountain',
    blurb: 'Southern-hemisphere season, then northern. Twelve winters in a row and counting.',
    mods: { speed: 1.03, control: 1.05, style: 1.04, balance: 1.02 },
    build: { height: 1.70, mass: 62, shoulders: 0.42, chest: 0.30 },
    fit: {
      jacket: '#7ad3ff', jacketAlt: '#241a3d', pants: '#241a3d', boots: '#15121f',
      skin: '#d9a273', hair: '#1c1410', helmet: null, beanie: '#c9a6ff',
      goggle: '#c9a6ff', goggleFrame: '#f2f6ff', scarf: '#f2f6ff',
    },
  },
];

export function boardById(id) { return BOARDS.find(b => b.id === id) || BOARDS[0]; }
export function riderById(id) { return RIDERS.find(r => r.id === id) || RIDERS[0]; }

// Collapse board stats + rider mods into the handful of scalars physics.js
// actually reads, so the sim never has to know what a swallowtail is.
export function deriveHandling(board, rider) {
  const s = board.stats, m = rider.mods;
  return {
    topSpeed:   (0.72 + s.speed * 0.048) * m.speed,     // × PHYS.MAX_SPEED
    turnRate:   (0.62 + s.agility * 0.052) * m.control, // × PHYS.TURN_RATE
    grip:       (0.58 + s.edge * 0.050) * m.control,    // × PHYS.CARVE_GRIP
    float:      0.20 + s.float * 0.085,                 // reduces powder drag
    pop:        (0.55 + s.pop * 0.055) * m.balance,     // × PHYS.JUMP_POP
    spinRate:   (0.60 + s.agility * 0.050) * m.balance, // × PHYS.AIR_SPIN_RATE
    stability:  (0.55 + s.edge * 0.030 + s.speed * 0.020) * m.balance,
    styleMult:  m.style,
    drag:       1.18 - s.speed * 0.026,
  };
}
