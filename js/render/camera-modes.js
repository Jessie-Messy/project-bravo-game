// camera-modes.js — the fixed camera presets.
//
// The camera has always been a single free orbit: camAngle spins, camPitch
// tilts from ground level to overhead, camZoom pulls in and out, all at a
// constant radius. That is flexible and completely undiscoverable — nobody
// middle-drags their way to a good framing by accident, and there was no way to
// get back to one once you left it.
//
// These are named stops on that same orbit. Cycling with [ and ] snaps pitch
// and zoom to a preset; middle-drag still works afterwards, so a preset is a
// starting point rather than a cage.
//
// FIRST PERSON IS THE EXCEPTION and does not use the orbit at all: the camera
// sits in the character's head and looks along camAngle, with its own pitch.
// It gets `fp: true` and game3d.js branches on it — see the camera block at the
// end of the frame update.
//
// A note on why WASD needed no work: movement was ALREADY rotated by camAngle
// before being applied, so "forward" has always meant "away from the camera".
// First person inherits that for free, and the two can never disagree.

/**
 * @param CAM_PITCH0 the game's default tilt (~57°), so the isometric preset is
 *        exactly the framing the game has always opened with rather than an
 *        approximation of it.
 */
export function cameraModes(CAM_PITCH0) {
  return [
    {
      id: 'first', label: 'First person', fp: true, fov: 75,
      // pitch/zoom unused in fp; kept so every entry has the same shape.
      pitch: 0, zoom: 0,
    },
    {
      id: 'shoulder', label: 'Over the shoulder', fp: false, fov: 64,
      // Low and close. Below about 0.30 the camera starts clipping into rising
      // ground on slopes, which is why this stops where it does.
      pitch: 0.34, zoom: 0.30,
    },
    {
      id: 'third', label: 'Third person', fp: false, fov: 58,
      pitch: 0.62, zoom: 0.55,
    },
    {
      id: 'iso', label: 'Isometric', fp: false, fov: 52,
      // The original framing. Deliberately the default index below.
      pitch: CAM_PITCH0, zoom: 0.72,
    },
    {
      id: 'far', label: 'Third person · far', fp: false, fov: 46,
      pitch: CAM_PITCH0, zoom: 1.45,
    },
    {
      id: 'top', label: 'Top down', fp: false, fov: 42,
      // Not quite 1.54: at true vertical the lookAt direction becomes parallel
      // to the camera's up vector and the roll is undefined, so the view
      // snaps unpredictably as you turn.
      pitch: 1.50, zoom: 1.10,
    },
  ];
}

// Which preset a fresh player starts in — the framing the game always had.
export const DEFAULT_MODE_ID = 'iso';

export const CAM_MODE_STORE_KEY = 'bravoCamMode_v1';

// Eye height as a fraction of the character's height. Slightly under the top of
// the head: at 1.0 the camera sits on the scalp and the horizon reads too high.
export const FP_EYE_FRAC = 0.86;

// How far first-person look can tilt, in radians either side of the horizon.
//
// 1.55 rad ≈ 88.8°, so you can look very nearly straight up and straight down —
// which is what "look all around" means in a first-person view. It was 1.25
// (≈72°), and that ceiling was low enough to feel like the view was fighting you
// when you tried to look up at anything.
//
// Deliberately NOT π/2. At exactly 90° the look target sits directly above the
// camera, parallel to its up vector, and lookAt() has no way to resolve roll —
// the view snaps. Stopping a hair short keeps a small horizontal component and
// avoids that entirely. Yaw has no such problem and is already unlimited.
export const FP_PITCH_LIMIT = 1.55;

// ── LOD tuning by camera angle ────────────────────────────────────
//
// Branch geometry is worth very different amounts depending on where the camera
// is. At ground level you are looking THROUGH the trunks and the structure is
// most of what you see; from straight overhead you are looking at the tops of
// the canopies and the branches underneath them are literally not visible.
// Spending the same triangle budget on both is waste at one end and a missed
// opportunity at the other.
//
// These derive from the LIVE camPitch and camZoom rather than from the preset,
// deliberately: middle-drag moves you off a preset without changing which mode
// you are in, and LOD that ignored that would be tuned for an angle you are no
// longer at.

const clamp01 = v => v < 0 ? 0 : v > 1 ? 1 : v;

// 0 at ground level, 1 looking straight down. Matches camPitch's own range.
export function overheadness(camPitch) {
  return clamp01((camPitch - 0.06) / (1.54 - 0.06));
}

/**
 * Multiplier on the tier's nearTrees budget, 0..1.
 * Squared falloff with overheadness: the value of branch detail drops away
 * slowly as you tilt down from the horizon and then collapses near vertical,
 * which is roughly how much of the structure stays visible.
 * Zoom is folded in because a tree twenty metres further away is smaller on
 * screen whatever the angle.
 */
export function nearBudgetFactor(fp, camPitch, camZoom) {
  if (fp) return 1;
  const o = overheadness(camPitch);
  const zoomK = Math.max(0.35, Math.min(1, 1.15 - camZoom * 0.35));
  return (1 - 0.9 * o * o) * zoomK;
}

/**
 * Radius, in tiles, within which a tree is a candidate for branch geometry.
 * Wider when looking down (more ground in frame, trees spread further from the
 * player) and tighter at ground level, where the budget should go to the few
 * trees actually looming over you.
 */
export function nearRadiusTiles(fp, camPitch) {
  if (fp) return 12;
  return 11 + 6 * overheadness(camPitch);
}
