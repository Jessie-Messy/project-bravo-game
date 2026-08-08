// quality.js — graphics quality tiers, detection and the auto-demote watchdog.
// Deliberately import-free (not even three.js): game3d.js pulls this in before
// the renderer exists, and the map editor / dev tooling read the same table
// without ever touching WebGL. Keep it pure logic + browser APIs.

export const TIERS = ['low', 'medium', 'high', 'ultra'];

const STORE_KEY = 'bravoQuality_v1';

// ── The tier table ────────────────────────────────────────────────
// Values are the ones that survived side-by-side testing on the dev boxes;
// per-knob notes live next to the entries that aren't obvious.
//
//   pixelRatio     — hard cap, not a target. devicePixelRatio on a 4K laptop
//                    is 2.0 and rendering 8.3M pixels for a top-down game buys
//                    nothing you can see, so even ultra stops at 2.0.
//   composer       — false on low means the renderer draws straight to the
//                    canvas: no extra full-screen buffer, which is most of the
//                    win on integrated GPUs and phones.
//   aa             — FXAA before SMAA on medium purely for cost; SMAA's edge
//                    search is noticeably heavier and medium is the tier that
//                    is already scraping by.
//   bloom.div      — the resolution divisor for the bloom pass. 4 (quarter-res)
//                    on medium is blurrier but roughly a quarter of the fill.
//   bloom.threshold— 1.0 on medium so only genuine emissives (fire, glowing
//                    ore) bloom; at 0.9 lit stone started hazing over.
//   composerScale  — render-target scale. 1.0 everywhere today; it exists so a
//                    future upscale path has a single knob to turn instead of
//                    threading a new value through every pass.
//   shadowMapSize  — 0 on low is the signal that shadows are off entirely, so
//                    callers never allocate a map they will not sample.
//   skyRebakeSec   — seconds between PMREM re-bakes of the sky as the day
//                    cycle turns. The bake is a stall, so low trades colour
//                    accuracy at dawn/dusk for not hitching.
//   anisotropy     — 0 means "ask the renderer for its max". High-end drivers
//                    report 16; hardcoding 16 on an Intel part that caps at 8
//                    silently clamps anyway, but the two low tiers get an
//                    explicit lower number because the ground plane is the
//                    single biggest texture-fetch cost in the frame.
//   obsWindow      — half-extent, in tiles, of the wall/roof occlusion probe.
//                    Wider windows cost raycasts, so only ultra pays for 40.
export const QUALITY = {
  low: Object.freeze({
    pixelRatio: 1.0,
    composer: false,
    aa: 'none',
    gtao: false,
    bloom: null,
    composerScale: 1.0,
    shadows: false,
    shadowMapSize: 0,
    shadowSoft: false,
    skyRebakeSec: 30,
    skyPmremSize: 64,
    waterLayers: 1,
    waterGlint: false,
    waterFresnel: false,
    waterFoam: false,
    embers: 0,
    anisotropy: 4,
    obsWindow: 28,
  }),
  medium: Object.freeze({
    pixelRatio: 1.25,
    composer: true,
    aa: 'fxaa',
    gtao: false,
    bloom: Object.freeze({ strength: 0.35, radius: 0.4, threshold: 1.0, div: 4 }),
    composerScale: 1.0,
    shadows: true,
    shadowMapSize: 1024,
    shadowSoft: false,
    skyRebakeSec: 15,
    skyPmremSize: 128,
    waterLayers: 2,
    waterGlint: true,
    waterFresnel: false,
    waterFoam: false,
    embers: 32,
    anisotropy: 8,
    obsWindow: 32,
  }),
  high: Object.freeze({
    pixelRatio: 1.5,
    composer: true,
    aa: 'smaa',
    gtao: false,
    bloom: Object.freeze({ strength: 0.45, radius: 0.5, threshold: 0.9, div: 2 }),
    composerScale: 1.0,
    shadows: true,
    shadowMapSize: 2048,
    shadowSoft: false,
    skyRebakeSec: 8,
    skyPmremSize: 128,
    waterLayers: 2,
    waterGlint: true,
    waterFresnel: true,
    waterFoam: true,
    embers: 96,
    anisotropy: 0,
    obsWindow: 32,
  }),
  ultra: Object.freeze({
    pixelRatio: 2.0,
    composer: true,
    aa: 'smaa',
    gtao: true,
    bloom: Object.freeze({ strength: 0.45, radius: 0.5, threshold: 0.9, div: 2 }),
    composerScale: 1.0,
    shadows: true,
    shadowMapSize: 3072,
    shadowSoft: true,
    skyRebakeSec: 4,
    skyPmremSize: 256,
    waterLayers: 2,
    waterGlint: true,
    waterFresnel: true,
    waterFoam: true,
    embers: 192,
    anisotropy: 0,
    obsWindow: 40,
  }),
};
Object.freeze(QUALITY);

// ── Persistence ───────────────────────────────────────────────────
// Every localStorage touch is wrapped: Safari private browsing throws on
// setItem, and a couple of privacy extensions throw on the getter too. A
// storage failure must never take the renderer down with it.
function readStored() {
  try {
    const v = localStorage.getItem(STORE_KEY);
    return TIERS.includes(v) ? v : null;
  } catch (_) { return null; }
}
function writeStored(name) {
  try { localStorage.setItem(STORE_KEY, name); } catch (_) {}
}

// ── Detection ─────────────────────────────────────────────────────
// Integrated and mobile parts, plus the two software rasterisers. SwiftShader
// and llvmpipe show up when a browser falls back off the GPU entirely — they
// are far slower than any real integrated chip, but 'medium' is as low as this
// list goes because 'low' is reserved for the touch path where the whole HUD
// changes shape too.
const WEAK_GPU = /Intel|UHD|Iris|Mali|Adreno|PowerVR|SwiftShader|llvmpipe/i;

let detectReason = 'not yet run';

export function detectTier(opts) {
  const o = opts || {};
  const stored = readStored();
  // An explicit choice outranks anything we can guess. Someone who forced
  // ultra on a laptop knows their machine better than a renderer string does.
  if (stored) {
    detectReason = 'stored override: ' + stored;
    return stored;
  }

  // Touch is the one signal worth trusting on its own. Phone GPUs that
  // benchmark fine still cook the battery and thermal-throttle within a
  // couple of minutes, and the renderer string on mobile is useless anyway.
  if (o.isTouch) {
    detectReason = 'touch device';
    return 'low';
  }

  const gl = o.gl;
  if (!gl) {
    detectReason = 'no GL context supplied; conservative default';
    return 'medium';
  }

  let name = '';
  try {
    // WEBGL_debug_renderer_info is gated behind privacy settings in Firefox
    // (privacy.resistFingerprinting) and blocked outright by several
    // extensions, in which case getExtension returns null or the getParameter
    // throws. Either way we land in the catch.
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    if (!ext) {
      detectReason = 'WEBGL_debug_renderer_info unavailable; conservative default';
      console.log('[quality] ' + detectReason);
      return 'medium';
    }
    name = String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) || '');
  } catch (err) {
    detectReason = 'renderer probe threw (' + (err && err.message ? err.message : err) + '); conservative default';
    console.log('[quality] ' + detectReason);
    return 'medium';
  }

  if (!name) {
    detectReason = 'renderer string empty; conservative default';
    console.log('[quality] ' + detectReason);
    return 'medium';
  }
  if (WEAK_GPU.test(name)) {
    detectReason = 'integrated/mobile GPU: ' + name;
    return 'medium';
  }
  detectReason = 'discrete GPU: ' + name;
  return 'high';
}

// Why detection picked what it picked — the dev panel surfaces this, and it's
// the first thing worth reading when someone reports "the game looks worse on
// my good PC" (almost always a blocked renderer-info extension).
export function getDetectReason() { return detectReason; }

// ── Current tier ──────────────────────────────────────────────────
// Seeded from storage so getSettings() is usable before the renderer has
// booted and had a chance to call detectTier with a real GL context.
let current = readStored() || 'medium';

export function getTier() { return current; }
export function getSettings() { return QUALITY[current]; }

export function setTier(name) {
  if (!TIERS.includes(name)) return;
  // The player has expressed a preference. Even if they picked the tier we
  // would have chosen anyway, the watchdog stays out of it for the rest of the
  // session — nothing is more infuriating than a settings panel that keeps
  // undoing itself while you're looking at it.
  watchdogArmed = false;
  if (name === current) { writeStored(name); return; }
  current = name;
  writeStored(name);
  emit();
}

// Used by the boot path and the watchdog to move tiers without persisting or
// silencing the watchdog, both of which are reserved for a deliberate choice.
function applyTier(name) {
  if (!TIERS.includes(name) || name === current) return;
  current = name;
  emit();
}

// ── Listeners ─────────────────────────────────────────────────────
const listeners = new Set();

export function onTierChange(fn) {
  if (typeof fn !== 'function') return () => {};
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function emit() {
  const settings = QUALITY[current];
  // Iterate a copy: several subscribers unsubscribe from inside their own
  // handler when the pass they own gets torn down at a lower tier.
  for (const fn of Array.from(listeners)) {
    try { fn(current, settings); } catch (err) { console.log('[quality] tier listener failed:', err); }
  }
}

// ── Auto-demote watchdog ──────────────────────────────────────────
// Detection guesses from a driver string; this measures. The rules are all
// about not being obnoxious: it fires once, it only ever goes down, and any
// visit to the settings panel switches it off permanently.
const WINDOW = 120;          // frames kept; ~2s at 60fps, ~4s at 30fps
const WARMUP_MS = 5000;      // shader compiles and the first GLB loads make
                             // the opening seconds meaningless as a sample
const MIN_SAMPLES = 60;
const MEDIAN_LIMIT_MS = 22;  // ~45fps. Below the 16.7ms ideal but above the
                             // point where mouse-look starts to feel sticky.
const MAX_FRAME_MS = 500;    // anything longer is a tab-switch or a zone load,
                             // not a frame we should judge the GPU on

const frames = [];
let elapsedMs = 0;
let watchdogArmed = true;    // false once it fires, or once setTier is called

export function frameTick(dtMs) {
  if (!watchdogArmed) return;
  const dt = +dtMs;
  if (!isFinite(dt) || dt <= 0 || dt > MAX_FRAME_MS) return;

  elapsedMs += dt;
  frames.push(dt);
  if (frames.length > WINDOW) frames.shift();

  if (elapsedMs < WARMUP_MS || frames.length < MIN_SAMPLES) return;

  // Median rather than mean: one 300ms chunk-build stall would drag an average
  // over the limit and demote a machine that is otherwise running fine.
  const sorted = frames.slice().sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  if (median <= MEDIAN_LIMIT_MS) return;

  const idx = TIERS.indexOf(current);
  if (idx <= 0) { watchdogArmed = false; return; }  // already on low, nothing left to give

  const next = TIERS[idx - 1];
  // Disarm before applying: listeners rebuild render targets, which spikes the
  // very frame times we are measuring, and we are not doing this twice.
  watchdogArmed = false;
  console.log('[quality] auto-demote ' + current + ' → ' + next +
    ' (median frame ' + median.toFixed(1) + 'ms over ' + frames.length + ' frames, limit ' + MEDIAN_LIMIT_MS + 'ms)');
  // Note the deliberate absence of a writeStored() here. This is a reaction to
  // one session on one machine — a laptop on battery, a background export, a
  // browser mid-update — and baking it into localStorage would leave the
  // player permanently downgraded with no idea why.
  applyTier(next);
}

// Boot helper: run detection, adopt the result, and hand the tier back.
// Kept here rather than in game3d.js so the ordering (detect, then apply
// without persisting) lives next to the rules it has to respect.
export function initQuality(opts) {
  applyTier(detectTier(opts));
  console.log('[quality] tier ' + current + ' (' + detectReason + ')');
  return current;
}
