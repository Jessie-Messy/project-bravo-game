// jewelry.js — procedural models for the artifacts you wear.
//
// The twelve artifacts were stat sticks with an emoji. They equipped into five
// jewelry slots, they changed your numbers, and nothing about your character
// showed it — which for the rarest drops in the game is the wrong way round.
// These give each one a body.
//
// ── WHY PROCEDURAL AND NOT GLB ───────────────────────────────────────────────
// Armor pieces attach through setSlotModel(), which loads a GLB. That is right
// for a breastplate: it is a big surface with a texture worth authoring. A ring
// is a torus and a stone. Twelve files, twelve fetches and twelve texture
// uploads for shapes describable in four lines each would cost real load time
// for no fidelity, and every one would need its own placement tuned by hand.
// Built here, they cost nothing to load and they all share one material.
//
// ── THE SCALE PROBLEM, AND WHY THESE ARE OVERSIZED ───────────────────────────
// An anatomically-sized ring on a character this height is under a pixel at the
// distance you actually play at, and a bracelet is not much better. They are
// therefore drawn at roughly 2.5x life — chunky bands, big bezels, pendants that
// sit proud of the chest. That is the same argument humanoid.js makes for the
// eyes: at this scale, correct proportions render as nothing at all, and every
// stylised game does this.
//
// ── ONE MESH, ONE MATERIAL ───────────────────────────────────────────────────
// Every piece merges to a single vertex-coloured geometry, so a fully decked
// character costs five draw calls rather than fifteen. mergeGeometries returns
// NULL rather than throwing when the parts disagree on attributes, so every
// primitive here has its `uv` deleted — the same trap documented in humanoid.js,
// and the same reason tools/test/jewelry.mjs exists.

import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

let THREE = null;

// Vertex colours live in the renderer's LINEAR working space, while a hex
// literal is authored as sRGB. Let THREE.Color do the conversion — dividing by
// 255 washes every metal out to pastel. Same note as humanoid.js.
function paint(geo, hex) {
  const c = new THREE.Color().setHex(hex, THREE.SRGBColorSpace);
  const n = geo.attributes.position.count, arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c.r; arr[i * 3 + 1] = c.g; arr[i * 3 + 2] = c.b; }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(arr, 3));
  geo.deleteAttribute('uv');          // ⚠ or the merge silently returns null
  return geo;
}
const torus = (r, t, hex, seg = 14) => paint(new THREE.TorusGeometry(r, t, 6, seg), hex);
const box   = (w, h, d, hex) => paint(new THREE.BoxGeometry(w, h, d), hex);
const ball  = (r, hex, seg = 8) => paint(new THREE.SphereGeometry(r, seg, seg >> 1), hex);
const cone  = (r, h, hex, seg = 8) => paint(new THREE.ConeGeometry(r, h, seg), hex);

function place(g, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0) {
  if (rx) g.rotateX(rx); if (ry) g.rotateY(ry); if (rz) g.rotateZ(rz);
  g.translate(x, y, z);
  return g;
}

// ── The three forms ─────────────────────────────────────────────────────────

// A necklace: a cord that hangs round the throat, and the thing on the end of
// it. The cord is a torus laid flat; the pendant hangs BELOW and in FRONT, so it
// reads against the chest rather than disappearing into the collarbone.
function necklace(parts, metal, pendant) {
  parts.push(place(torus(2.6, 0.22, metal, 16), 0, 0, 0, Math.PI / 2));
  // The drop connecting cord to pendant — without it the pendant floats.
  parts.push(place(box(0.3, 1.5, 0.3, metal), 0, -2.6, -0.5));
  pendant(parts, 0, -3.9, -0.6);
}

// A ring: a band, and a bezel raised off it. Drawn thick on purpose.
function ring(parts, metal, stone, stoneShape) {
  parts.push(place(torus(1.15, 0.34, metal, 12), 0, 0, 0, Math.PI / 2));
  if (stoneShape) stoneShape(parts, 0, 1.35, 0);
  else parts.push(place(ball(0.55, stone), 0, 1.35, 0));
}

// A bracelet: an open cuff with a charm hanging off it.
function bracelet(parts, metal, charm) {
  parts.push(place(torus(1.7, 0.3, metal, 14), 0, 0, 0, Math.PI / 2));
  parts.push(place(box(0.28, 0.9, 0.28, metal), 0, -1.7, 0));
  if (charm) charm(parts, 0, -2.5, 0);
}

// ── The twelve ──────────────────────────────────────────────────────────────
// Keyed by the artifact id in game3d.js's ARTIFACT_DEFS. Anything missing falls
// back to a plain band, so a new artifact is never invisible — it is just
// undesigned, which is a thing you can see and fix.
const BUILDERS = {
  // ── T1: worn, tarnished, cheap metal ──
  worn_pendant: p => necklace(p, 0x8a7c62, (q, x, y, z) =>
    q.push(place(ball(1.0, 0x9c8e70, 6), x, y, z))),                    // a dull bead
  rusted_ring: p => ring(p, 0x7a5a42, 0x6a4a34),                        // rust, no stone worth the name
  cracked_charm: p => bracelet(p, 0x6a5a48, (q, x, y, z) => {
    // a little bow-stave charm, snapped — the "cracked" in the name
    q.push(place(box(0.35, 2.0, 0.35, 0x8a6a42), x, y, z, 0, 0, 0.3));
    q.push(place(box(0.25, 0.9, 0.25, 0x8a6a42), x + 0.5, y - 1.1, z, 0, 0, -0.8));
  }),
  faded_charm: p => bracelet(p, 0x6a6a5a, (q, x, y, z) => {
    for (let i = 0; i < 4; i++)                                          // a four-leaf clover
      q.push(place(ball(0.5, 0x6a9a58, 6), x + Math.cos(i * Math.PI / 2) * 0.5,
                   y + Math.sin(i * Math.PI / 2) * 0.5, z));
  }),

  // ── T2: real silver, real stones ──
  silver_locket: p => necklace(p, 0xd8d8e0, (q, x, y, z) => {
    q.push(place(box(1.6, 2.0, 0.45, 0xe4e4ec), x, y, z));              // the locket face
    q.push(place(box(0.25, 1.7, 0.5, 0x9a9aa4), x, y, z - 0.05));       // its seam
  }),
  knights_signet: p => ring(p, 0xc8c8d2, 0x8a2f2f, (q, x, y, z) => {
    q.push(place(box(1.1, 1.1, 0.5, 0xc8c8d2), x, y, z));               // a flat signet face
    q.push(place(box(0.5, 0.5, 0.2, 0x8a2f2f), x, y, z - 0.3));         // the device on it
  }),
  hawks_talisman: p => bracelet(p, 0xbda86a, (q, x, y, z) => {
    q.push(place(ball(0.8, 0xf0e8d0, 8), x, y, z));                     // the eye
    q.push(place(ball(0.36, 0x2a1c14, 6), x, y, z - 0.55));             // its pupil
  }),
  sage_medallion: p => necklace(p, 0xbda86a, (q, x, y, z) => {
    q.push(place(torus(1.2, 0.3, 0xd8c070, 14), x, y, z, Math.PI / 2));
    q.push(place(box(0.28, 1.9, 0.28, 0xd8c070), x, y, z));             // a wheel/sun disc
    q.push(place(box(1.9, 0.28, 0.28, 0xd8c070), x, y, z));
  }),

  // ── T3: the ones worth dying for ──
  titans_heart: p => necklace(p, 0x8a2f3a, (q, x, y, z) => {
    // A heart read as two lobes and a point, not a valentine.
    q.push(place(ball(0.95, 0xd8304a, 8), x - 0.55, y + 0.35, z));
    q.push(place(ball(0.95, 0xd8304a, 8), x + 0.55, y + 0.35, z));
    q.push(place(cone(1.15, 1.9, 0xd8304a, 8), x, y - 0.85, z, Math.PI));
  }),
  berserkers_fang: p => bracelet(p, 0x4a3a2a, (q, x, y, z) => {
    q.push(place(cone(0.55, 2.6, 0xf0e8d8, 8), x, y - 0.6, z, Math.PI));  // the tooth
    q.push(place(torus(0.42, 0.14, 0x8a2f2f, 8), x, y + 0.5, z, Math.PI / 2));
  }),
  phoenix_down: p => bracelet(p, 0xb8863a, (q, x, y, z) => {
    // A feather: a spine with barbs, angled so it reads as a plume.
    q.push(place(box(0.22, 2.8, 0.22, 0xd8a040), x, y - 0.5, z, 0, 0, 0.18));
    for (let i = 0; i < 4; i++) {
      const yy = y + 0.4 - i * 0.7;
      q.push(place(box(1.5 - i * 0.22, 0.4, 0.14, 0xff9a30), x, yy, z, 0, 0, 0.5));
    }
  }),
  crown_of_kings: p => ring(p, 0xd8c060, 0x40c0ff, (q, x, y, z) => {
    // Not a band with a stone — an actual little crown standing on the finger.
    q.push(place(torus(0.85, 0.22, 0xd8c060, 12), x, y - 0.1, z, Math.PI / 2));
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      q.push(place(cone(0.26, 0.95, 0xd8c060, 6),
                   x + Math.cos(a) * 0.8, y + 0.5, z + Math.sin(a) * 0.8));
    }
    q.push(place(ball(0.42, 0x40c0ff, 8), x, y + 0.95, z));
  }),
};

/**
 * Build the mesh for one artifact.
 *
 * @param three  the game's THREE, passed in for the same reason humanoid.js
 *               takes it: this file must not decide which three is in use.
 * @param def    an ARTIFACT_DEFS entry — needs `id` and `slot`.
 * @returns      a BufferGeometry, or null if the merge failed (which the test
 *               exists to make impossible).
 */
export function buildArtifactGeometry(three, def) {
  THREE = three;
  const parts = [];
  const build = BUILDERS[def && def.id];
  if (build) build(parts);
  else {
    // Unknown id: a plain band rather than nothing, so an undesigned artifact
    // is visibly undesigned instead of silently invisible.
    const form = def && def.slot === 'neck' ? necklace : def && def.slot === 'ring' ? ring : bracelet;
    form(parts, 0x9a9a9a, (q, x, y, z) => q.push(place(ball(0.7, 0xb0b0b0, 6), x, y, z)));
  }
  if (!parts.length) return null;
  const merged = mergeGeometries(parts, false);
  for (const g of parts) g.dispose();
  return merged;
}

// Every id this module has a real design for — the test uses it to notice when
// an artifact is added to the game and not to here.
export function designedArtifactIds() { return Object.keys(BUILDERS); }
