// settings.js — the player's preferences, and the keybind indirection that makes
// rebinding possible without rewriting the input handler.
//
// Two things live here:
//
//   1. `prefs` — a flat, persisted key/value store. Defaults are the values the
//      game shipped with, so a player who never opens the menu is unaffected.
//
//   2. `canonKey()` — the reason rebinding is a small change instead of a large
//      one. The keydown handler in game3d.js is a wall of `if(k==='c')` tests
//      written against the DEFAULT keys, and the movement code reads `keys['w']`
//      directly. Rather than route ~30 call sites through a binding lookup, the
//      key is translated once on the way in: press whatever you bound to Craft
//      and the rest of the game is told 'c' was pressed. Every existing test
//      keeps working untouched.

const PREFS_KEY = 'bravoPrefs_v1';
const BINDS_KEY = 'bravoBinds_v1';

export const PREF_DEFAULTS = {
  // video
  fov:          0,      // offset in degrees applied to the camera mode's own FOV
  renderScale:  1.0,    // multiplies the vision / animation radii
  // controls
  lookSens:     1.0,    // multiplies first-person mouse look
  invertY:      false,
  // touch controls
  stickSize:    60,     // movement stick radius, px (was the STICK_MAX constant)
  stickZone:    1.0,    // multiplies the width of the left-hand thumb zone
  // hud
  showNames:    true,   // name tags above other players
  nameDist:     46,     // ...out to this many tiles
  showFps:      false,
  // audio
  volume:       0.65,
};

function _load(key, fallback) {
  try { return { ...fallback, ...(JSON.parse(localStorage.getItem(key) || '{}') || {}) }; }
  catch (_) { return { ...fallback }; }
}

export const prefs = _load(PREFS_KEY, PREF_DEFAULTS);

// Listeners fire on every change so the live scene can follow a slider as it
// moves, rather than only on close.
const _subs = [];
export function onPrefChange(fn) { _subs.push(fn); }

export function savePrefs() {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (_) {}
}
export function setPref(k, v) {
  prefs[k] = v; savePrefs();
  for (const fn of _subs) { try { fn(k, v); } catch (_) {} }
}
export function resetPrefs() {
  for (const k in PREF_DEFAULTS) prefs[k] = PREF_DEFAULTS[k];
  savePrefs();
  for (const fn of _subs) { try { fn(null, null); } catch (_) {} }
}

// ── Keybinds ────────────────────────────────────────────────────────────────
// `id` is the ACTION. `key` is the default physical key, and is also the token
// the rest of the game compares against — see canonKey(). Movement is included
// because onKey() writes into the `keys` map under the canonical name too.
export const BIND_DEFS = [
  { id:'fwd',      key:'w',     label:'Move Forward' },
  { id:'back',     key:'s',     label:'Move Back' },
  { id:'left',     key:'a',     label:'Strafe Left' },
  { id:'right',    key:'d',     label:'Strafe Right' },
  { id:'sprint',   key:'shift', label:'Sprint' },
  { id:'interact', key:'e',     label:'Interact' },
  { id:'special',  key:' ',     label:'Special Attack' },
  { id:'use',      key:'z',     label:'Use Selected' },
  { id:'potion',   key:'p',     label:'Drink Potion' },
  { id:'bandage',  key:'b',     label:'Bandage' },
  { id:'weapon',   key:'q',     label:'Swap Weapon' },
  { id:'aggro',    key:'x',     label:'Toggle Aggro' },
  { id:'hide',     key:'h',     label:'Hide' },
  { id:'shadow',   key:'v',     label:'Shadowstep' },
  { id:'wrestle',  key:'f',     label:'Wrestle' },
  { id:'guards',   key:'g',     label:'Call Guards' },
  { id:'horse',    key:'r',     label:'Mount / Dismount' },
  { id:'pack',     key:'o',     label:'Backpack' },
  { id:'equip',    key:'i',     label:'Equipment' },
  { id:'craft',    key:'c',     label:'Crafting' },
  { id:'skills',   key:'k',     label:'Skills' },
  { id:'quests',   key:'j',     label:'Quest Journal' },
  { id:'gambits',  key:'y',     label:'Gambits' },
  { id:'map',      key:'m',     label:'Map' },
  { id:'howto',    key:'t',     label:'How To Play' },
  { id:'mute',     key:'n',     label:'Mute Sound' },
];

const DEFAULT_BY_KEY = {};
for (const b of BIND_DEFS) DEFAULT_BY_KEY[b.key] = b.id;

export const binds = _load(BINDS_KEY, Object.fromEntries(BIND_DEFS.map(b => [b.id, b.key])));

let _byKey = {};
function _reindex() { _byKey = {}; for (const id in binds) _byKey[binds[id]] = id; }
_reindex();

export function saveBinds() {
  try { localStorage.setItem(BINDS_KEY, JSON.stringify(binds)); } catch (_) {}
}
export function setBind(id, key) {
  // A key can only drive one action. Whatever held it becomes unbound rather
  // than silently firing two things at once.
  for (const other in binds) if (other !== id && binds[other] === key) binds[other] = '';
  binds[id] = key;
  _reindex(); saveBinds();
}
export function resetBinds() {
  for (const b of BIND_DEFS) binds[b.id] = b.key;
  _reindex(); saveBinds();
}
export function bindOf(id) { return binds[id] || ''; }

// Human-readable key name for the settings list.
export function keyLabel(k) {
  if (!k) return '—';
  if (k === ' ') return 'SPACE';
  if (k.length === 1) return k.toUpperCase();
  return k.replace(/^arrow/, '').toUpperCase();
}

// The translation. Called once, on the way in.
//   - a key that is bound to an action  → that action's DEFAULT key
//   - a default key whose action has been rebound elsewhere → inert
//   - anything else (Escape, Enter, digits, arrows, F-keys) → unchanged
export function canonKey(k) {
  const id = _byKey[k];
  if (id) return DEFAULT_BY_KEY[k] === id ? k : BIND_DEFS.find(b => b.id === id).key;
  if (DEFAULT_BY_KEY[k]) return '\u0000';   // moved away; this key now does nothing
  return k;
}

// The inverse of canonKey(), for code that SYNTHESISES a keypress -- the mobile
// touch buttons dispatch a real KeyboardEvent so they run the same handler as a
// keyboard. They are written against the default keys, and canonKey() would
// treat a default key whose action has been rebound as inert, silently breaking
// the on-screen button. Translating on the way out keeps them in step.
export function keyForDefault(k) {
  const id = DEFAULT_BY_KEY[k];
  return id ? (binds[id] || k) : k;
}

// True while the menu is waiting for the player to press a key to bind.
export let capturing = null;
export function setCapturing(id) { capturing = id; }
