// config.js — quality tiers, tuning constants and device detection for the
// snowboard game. Deliberately import-free (not even three.js) so the menu can
// read the tier table before a WebGL context exists, exactly like the medieval
// prototype's render/quality.js does.

export const TIERS = ['low', 'medium', 'high', 'ultra'];

const STORE_KEY = 'bravoSnowQuality_v1';

// ── Tier table ────────────────────────────────────────────────────
//   pixelRatio    — hard cap, not a target. A 3x phone screen rendering a
//                   full-res frame is the single fastest way to drop to 20fps,
//                   and at this camera distance nobody can see the difference
//                   between 2.0 and 3.0.
//   shadowMapSize — 0 means shadows are off entirely, so callers never build a
//                   shadow camera they will not sample.
//   viewDist      — how far down the hill terrain chunks are kept alive. Fog is
//                   pinned to this so the cull never pops into view.
//   chunkAhead    — chunks built in front of the rider, 40 m each. This is what
//                   sets how far down the run you can actually see, so the fog
//                   floor in main.js is derived from it. Cheap to raise on
//                   desktop, expensive on a phone because each one is a fresh
//                   BufferGeometry upload.
//   bloom.threshold— in HDR scene units, BEFORE tone mapping: sunlit snow sits
//                   around 1.5–2.5 there, so anything under ~2 blooms the whole
//                   slope into a white halo instead of just the glints.
//   msaa / smaa    — stated per tier rather than inferred from shadowMapSize,
//                   which is how a phone ended up paying for 4x MSAA AND an
//                   SMAA pass at the same time. They are alternatives; only
//                   the top desktop tier is allowed to buy both.
//   treeBudget    — instanced conifers alive at once across all chunks.
//   sprayMax      — particles in the board-spray pool.
//   snowfall      — ambient falling-snow particle count.
export const QUALITY = {
  low: Object.freeze({
    pixelRatio: 1.0, composer: false, bloom: null, shadows: false,
    shadowMapSize: 0, viewDist: 240, chunkAhead: 6, terrainRes: 0.55,
    treeBudget: 420, sprayMax: 220, snowfall: 500, anisotropy: 4,
    msaa: 0, smaa: false,
    sparkle: false, groomDetail: false, speedLines: false,
  }),
  medium: Object.freeze({
    pixelRatio: 1.5, composer: true, bloom: Object.freeze({ strength: 0.34, radius: 0.5, threshold: 2.4 }),
    shadows: true, shadowMapSize: 1024, viewDist: 320, chunkAhead: 8, terrainRes: 0.75,
    treeBudget: 900, sprayMax: 420, snowfall: 900, anisotropy: 8,
    msaa: 0, smaa: false,
    sparkle: true, groomDetail: true, speedLines: true,
  }),
  high: Object.freeze({
    pixelRatio: 1.75, composer: true, bloom: Object.freeze({ strength: 0.40, radius: 0.55, threshold: 2.3 }),
    shadows: true, shadowMapSize: 2048, viewDist: 440, chunkAhead: 11, terrainRes: 1.0,
    treeBudget: 1700, sprayMax: 700, snowfall: 1400, anisotropy: 16,
    msaa: 0, smaa: true,
    sparkle: true, groomDetail: true, speedLines: true,
  }),
  ultra: Object.freeze({
    pixelRatio: 2.0, composer: true, bloom: Object.freeze({ strength: 0.46, radius: 0.6, threshold: 2.2 }),
    shadows: true, shadowMapSize: 4096, viewDist: 600, chunkAhead: 15, terrainRes: 1.25,
    treeBudget: 2600, sprayMax: 1100, snowfall: 2200, anisotropy: 16,
    msaa: 4, smaa: true,
    sparkle: true, groomDetail: true, speedLines: true,
  }),
};

// ── Device detection ──────────────────────────────────────────────
// Decided up front rather than on the first touch event, so a phone gets the
// touch HUD and the mobile tier on the very first frame instead of a desktop
// layout that reflows a second later.
export const IS_TOUCH = (typeof window !== 'undefined') &&
  (('ontouchstart' in window) || (navigator.maxTouchPoints || 0) > 0);

export const IS_MOBILE = IS_TOUCH && Math.min(
  window.screen?.width || 9999, window.screen?.height || 9999) <= 900;

function guessTier() {
  const mem = navigator.deviceMemory || (IS_MOBILE ? 4 : 8);
  const cores = navigator.hardwareConcurrency || (IS_MOBILE ? 4 : 8);
  if (IS_MOBILE) {
    // Phones get MEDIUM at best on a first run, and it is worth being explicit
    // about why, because the detection here used to say `high`.
    //
    // Safari does not implement deviceMemory, so `mem` falls back to 4 on
    // every iPhone, and every modern iPhone reports 6 cores — which meant the
    // check below passed on all of them and handed a phone the desktop tier:
    // 1.75 pixel ratio, 2048 shadows, 4x MSAA and SMAA on top. That is a
    // multi-second first frame on hardware that could have run the game fine,
    // and the player sees a game that will not start.
    //
    // Nothing here can measure a GPU, so guessing upward is the wrong bet: the
    // watchdog can only demote, and every second spent above the device's real
    // ceiling is a second of unplayable game. Start conservative; a player who
    // wants more can raise it in Settings and it is remembered.
    return cores >= 6 ? 'medium' : 'low';
  }
  if (cores >= 8 && mem >= 8) return 'ultra';
  if (cores >= 4) return 'high';
  return 'medium';
}

let _tier = (() => {
  try {
    const saved = localStorage.getItem(STORE_KEY);
    if (saved && TIERS.includes(saved)) return saved;
  } catch { /* private browsing — fall through to detection */ }
  return guessTier();
})();

const _tierListeners = new Set();

export function getTier() { return _tier; }
export function getSettings() { return QUALITY[_tier]; }
export function onTierChange(fn) { _tierListeners.add(fn); return () => _tierListeners.delete(fn); }

export function setTier(t, { persist = true } = {}) {
  if (!TIERS.includes(t) || t === _tier) return;
  _tier = t;
  if (persist) { try { localStorage.setItem(STORE_KEY, t); } catch { /* ignore */ } }
  for (const fn of _tierListeners) fn(QUALITY[_tier], _tier);
}

// ── Auto-demote watchdog ──────────────────────────────────────────
// A phone that thermally throttles three minutes into a run is the common
// case, not the exception. Sustained slow frames drop the tier; we never
// promote back up automatically, because oscillating between tiers looks far
// worse than simply staying on the lower one.
//
// MUST be fed REAL elapsed time, not the simulation's clamped dt. With the
// clamp, a device rendering at 0.7 fps reports 0.25 s per frame, so a one
// second sampling window took four real seconds to close and a demotion took
// half a minute — by which point the player has already put the phone down.
//
// A really bad frame rate also demotes more than one step at once. There is no
// value in stepping politely down from ultra to high on hardware that is
// managing two frames a second.
let _slow = 0, _frames = 0, _acc = 0;

export function frameTick(realDt) {
  _frames++; _acc += realDt;
  if (_acc < 0.8) return;
  const fps = _frames / _acc;
  _frames = 0; _acc = 0;
  if (fps >= 26) { _slow = Math.max(0, _slow - 1); return; }

  _slow++;
  // One bad window is enough when it is catastrophic; otherwise wait for two,
  // so a single hitch (a chunk build, a shader compile) never costs a tier.
  const steps = fps < 8 ? 2 : fps < 16 ? 1 : 0;
  if (_slow >= 2 || steps >= 2) {
    _slow = 0;
    const i = TIERS.indexOf(_tier);
    const target = Math.max(0, i - Math.max(1, steps));
    if (target < i) setTier(TIERS[target], { persist: false });
  }
}

// ── Physics tuning ────────────────────────────────────────────────
// One place for every number the ride feel depends on. Values are metric:
// metres, seconds, radians. GRAVITY is deliberately above 9.81 — real gravity
// with a real board on a real slope produces speeds that read as sluggish on a
// 6-inch screen, and every arcade snowboard game since 1080° has cheated it.
export const PHYS = Object.freeze({
  GRAVITY: 15.5,
  MAX_SPEED: 46,          // m/s ceiling before drag hard-limits (~165 km/h)
  BASE_FRICTION: 0.055,   // groomed corduroy, board flat
  EDGE_FRICTION: 0.24,    // scrubbing speed on a hard carve — only the SLIPPING
                          // part of a turn should cost speed; a clean carve
                          // should come out of it as fast as it went in
  POWDER_DRAG: 0.16,      // extra drag off-piste, scaled by board float
  AIR_DRAG: 0.0016,       // quadratic, dominates above ~30 m/s
  TURN_RATE: 2.35,        // rad/s at full edge, before board/rider modifiers
  EDGE_RESPONSE: 7.5,     // how fast edge angle chases input (1/s)
  CARVE_GRIP: 0.92,       // 1 = rails on a track, 0 = pure drift
  AIR_SPIN_RATE: 4.6,     // rad/s of yaw while airborne
  LAND_TOLERANCE: 0.62,   // max |cos| mismatch between board and slope on land
  JUMP_POP: 7.4,          // m/s upward from a full ollie
  CRASH_SPEED_KEEP: 0.22, // fraction of speed retained through a crash
  RIDER_HEIGHT: 1.72,
});

// Scoring — trick points, combo multipliers and the medal thresholds the
// results screen grades against.
export const SCORE = Object.freeze({
  SPIN_180: 120, SPIN_360: 300, SPIN_540: 620, SPIN_720: 1000, SPIN_900: 1500,
  GRAB_PER_SEC: 90,
  AIR_PER_SEC: 60,
  CARVE_PER_SEC: 22,      // held at high edge angle and high speed
  BIG_AIR_BONUS: 250,     // airtime over 1.6s
  CRASH_PENALTY: 0.45,    // fraction of the pending combo lost on a crash
  COMBO_STEP: 0.25,       // each landed trick adds this to the multiplier
  COMBO_MAX: 5,
});
