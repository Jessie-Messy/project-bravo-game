// tree-species.js — species presets for tree-gen.js, plus procedural textures.
//
// WHY THE TEXTURES ARE DRAWN RATHER THAN LOADED: models/ is already 22MB and is
// implicated in slow loads on weaker machines. Foliage atlases are exactly the
// kind of asset that would add several more megabytes for art that is, at the
// scale trees are actually seen, a green blob with a silhouette. Drawing them
// on a canvas at load costs a few milliseconds and nothing to download — the
// same trade grass.js already makes with makeBladeTexture.
//
// Leaf textures are drawn with the stem at the BOTTOM CENTRE and growth upward,
// because tree-gen.js roots each leaf quad at its base edge and extends it along
// +Y in leaf-local space. Draw them centred and every cluster looks like it is
// floating a half-quad away from its twig.

// ── Textures ──────────────────────────────────────────────────────

/**
 * Streaky vertical bark. Deliberately low contrast: this tiles up long trunks
 * and any strong feature repeats visibly.
 */
export function makeBarkTexture(THREE, { w = 64, h = 128 } = {}) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const x = c.getContext('2d');

  x.fillStyle = '#6b5842';
  x.fillRect(0, 0, w, h);

  // Vertical fissures. Random width and darkness, wrapped in X so the seam
  // does not show when the texture repeats around the trunk.
  for (let i = 0; i < 90; i++) {
    const px = Math.random() * w;
    const lw = 0.6 + Math.random() * 3.2;
    const dark = Math.random() < 0.6;
    x.strokeStyle = dark
      ? `rgba(38,28,18,${0.10 + Math.random() * 0.30})`
      : `rgba(150,128,98,${0.06 + Math.random() * 0.18})`;
    x.lineWidth = lw;
    x.beginPath();
    // Wander slightly so the fissures are not perfectly straight.
    let cx = px;
    x.moveTo(cx, 0);
    for (let y = 0; y <= h; y += 8) {
      cx += (Math.random() - 0.5) * 2.2;
      x.lineTo(cx, y);
    }
    x.stroke();
  }

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/**
 * Foliage cutout. `kind` selects the silhouette:
 *   'needle'    — conifer spray: needles along a central rachis
 *   'broadleaf' — a cluster of rounded leaves
 *   'birch'     — smaller, sparser, lighter leaves
 * Background is transparent; the material alpha-tests against it.
 *
 * THIS TEXTURE IS A TINT, NOT A COLOUR. material.color carries the species hue
 * (sp.leafColor) and MULTIPLIES what is painted here. Anything with real green
 * in it therefore gets multiplied by green a second time: the canopy measured
 * (29, 69, 17) against grass at (116, 148, 61) before this was fixed, which is
 * dark enough that no lighting can recover a shape from it. Paint light values
 * and let the material supply the colour.
 */
export function makeLeafTexture(THREE, kind = 'broadleaf', { size = 128 } = {}) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const x = c.getContext('2d');
  x.clearRect(0, 0, size, size);

  const S = size;
  const rand = (a, b) => a + Math.random() * (b - a);

  if (kind === 'needle') {
    // Central rachis running bottom-centre to top-centre, needles fanning off
    // it. Needles shorten toward the tip so the spray comes to a point.
    x.strokeStyle = '#b9c9a6';                 // rachis — a tint, see the header
    x.lineWidth = S * 0.022;
    x.beginPath();
    x.moveTo(S * 0.5, S);
    x.lineTo(S * 0.5, S * 0.06);
    x.stroke();

    for (let i = 0; i < 62; i++) {
      const t = i / 62;                       // 0 at base, 1 at tip
      const y = S * (1 - t * 0.94);
      const len = S * 0.30 * (1 - t * 0.70) * rand(0.7, 1.15);
      const droop = S * 0.10 * t;
      // shade 0.55..1.0 remapped into 0.62..1.0 of a light neutral-green, so the
      // per-needle variation survives the multiply instead of being crushed.
      const shade = 0.55 + Math.random() * 0.45;
      const v = 0.62 + 0.38 * ((shade - 0.55) / 0.45);
      x.strokeStyle = `rgb(${Math.round(206 * v)},${Math.round(228 * v)},${Math.round(182 * v)})`;
      x.lineWidth = S * rand(0.012, 0.022);
      for (const dir of [-1, 1]) {
        x.beginPath();
        x.moveTo(S * 0.5, y);
        x.lineTo(S * 0.5 + dir * len, y + droop + rand(-2, 6));
        x.stroke();
      }
    }
  } else {
    const broad = kind !== 'birch';
    const n = broad ? 16 : 11;
    const leafW = S * (broad ? 0.30 : 0.20);
    const leafH = S * (broad ? 0.34 : 0.24);

    // A short stem so the cluster reads as attached rather than hovering.
    x.strokeStyle = '#a8b892';                 // stem — a tint, see the header
    x.lineWidth = S * 0.02;
    x.beginPath();
    x.moveTo(S * 0.5, S);
    x.lineTo(S * 0.5, S * 0.62);
    x.stroke();

    for (let i = 0; i < n; i++) {
      // Cluster toward the upper half, spreading outward.
      const a = rand(0, Math.PI * 2);
      const rad = rand(0, S * (broad ? 0.30 : 0.26));
      const cx = S * 0.5 + Math.cos(a) * rad;
      const cy = S * 0.42 + Math.sin(a) * rad * 0.85;
      const rot = rand(-Math.PI, Math.PI);
      const shade = 0.6 + Math.random() * 0.4;
      const v = 0.62 + 0.38 * ((shade - 0.6) / 0.4);
      // Birch keeps a slightly paler base than the broadleaves, which is the
      // difference the species table describes it by.
      const g = broad
        ? `rgb(${Math.round(198 * v)},${Math.round(222 * v)},${Math.round(176 * v)})`
        : `rgb(${Math.round(216 * v)},${Math.round(234 * v)},${Math.round(196 * v)})`;

      x.save();
      x.translate(cx, cy);
      x.rotate(rot);
      x.fillStyle = g;
      x.beginPath();
      x.ellipse(0, 0, leafW * rand(0.6, 1.1) * 0.5, leafH * rand(0.7, 1.15) * 0.5, 0, 0, Math.PI * 2);
      x.fill();
      // Midrib, so a leaf is not a flat blob when it fills the screen.
      // Was rgba(30,52,20) — nearly black, and multiplied by the leaf colour it
      // became a black vein across every leaf. It only has to read as slightly
      // darker than the blade it sits on.
      x.strokeStyle = `rgba(120,140,104,0.45)`;
      x.lineWidth = S * 0.008;
      x.beginPath();
      x.moveTo(0, -leafH * 0.5 * 0.9);
      x.lineTo(0, leafH * 0.5 * 0.9);
      x.stroke();
      x.restore();
    }
  }

  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  t.generateMipmaps = true;
  return t;
}

// ── Species ───────────────────────────────────────────────────────
//
// `biome` is the key the placement code matches on; see biomeAt() in game3d.js.
// Several species can share a biome, in which case the per-tile hash picks
// between them, which is what keeps a forest from looking like a plantation.
//
// Heights are in world units. TILE is 48 and the old tree was ~250 tall, so
// these are sized to sit in the same landscape.

export const SPECIES = [
  {
    id: 'pine',
    label: 'Pine',
    biome: 'highland',
    seed: 10241,
    barkColor: 0x7a6247,
    leafColor: 0x7fa254,
    leafKind: 'needle',
    params: {
      levels: 2,
      length:     [250, 86, 24],
      radius:     [9, 2.6, 1.1],
      taper:      [0.88, 0.94, 0.95],
      sections:   [9, 5, 3],
      segments:   [7, 5, 4],
      children:   [22, 0, 0],
      start:      [0.30, 0.3, 0.2],
      profile:    ['pine', 'flat'],
      // Pine branches sit close to horizontal and sweep up at the ends; the
      // growth force below does the sweeping.
      angle:      [1.25, 0.6, 0.7],
      gnarliness: [0.03, 0.10, 0.18],
      twist:      [0.03, 0.05, 0],
      force: { direction: [0, 1, 0], strength: 0.10 },
      leaves: { count: 4, size: 66, angle: 0.16, start: 0.06, cross: true },
    },
  },
  {
    id: 'spruce',
    label: 'Spruce',
    biome: 'highland',
    seed: 55127,
    barkColor: 0x6a5540,
    leafColor: 0x5f8c48,
    leafKind: 'needle',
    params: {
      levels: 2,
      length:     [230, 104, 26],
      radius:     [8.5, 2.8, 1.2],
      taper:      [0.9, 0.94, 0.95],
      sections:   [10, 5, 3],
      segments:   [7, 5, 4],
      children:   [26, 0, 0],
      start:      [0.10, 0.25, 0.2],
      profile:    ['cone', 'flat'],
      // Spruce droops: branches angle DOWN past horizontal, and the growth
      // force is weak so they stay drooping.
      angle:      [1.55, 0.5, 0.6],
      gnarliness: [0.03, 0.09, 0.16],
      twist:      [0.04, 0.05, 0],
      force: { direction: [0, 1, 0], strength: 0.035 },
      leaves: { count: 4, size: 74, angle: 0.16, start: 0.05, cross: true },
    },
  },
  {
    id: 'oak',
    label: 'Oak',
    biome: 'lowland',
    seed: 7731,
    barkColor: 0x6f5a41,
    leafColor: 0x6f9440,
    leafKind: 'broadleaf',
    params: {
      levels: 4,
      length:     [130, 88, 52, 30],
      radius:     [13, 6.5, 3.0, 1.4],
      taper:      [0.62, 0.7, 0.8, 0.92],
      sections:   [7, 6, 4, 3],
      segments:   [8, 6, 5, 4],
      children:   [4, 3, 4, 0],
      profile:    ['round', 'round', 'flat'],
      start:      [0.35, 0.25, 0.2, 0.2],
      // Wide, spreading crown: big branch angles and a weak upward force, so
      // limbs go out before they go up.
      angle:      [0.85, 0.75, 0.7, 0.6],
      gnarliness: [0.10, 0.16, 0.22, 0.28],
      twist:      [0.06, 0.08, 0.06, 0],
      force: { direction: [0, 1, 0], strength: 0.05 },
      leaves: { count: 5, size: 48, angle: 0.42, start: 0.08, cross: true },
    },
  },
  {
    id: 'birch',
    label: 'Birch',
    biome: 'riverside',
    seed: 30809,
    barkColor: 0xd8d2c4,
    leafColor: 0x93b757,
    leafKind: 'birch',
    params: {
      levels: 3,
      length:     [210, 74, 38],
      radius:     [5.5, 2.4, 1.0],
      taper:      [0.75, 0.82, 0.92],
      sections:   [9, 5, 3],
      segments:   [7, 5, 4],
      children:   [9, 4, 0],
      start:      [0.42, 0.25, 0.2],
      profile:    ['round', 'flat'],
      angle:      [0.72, 0.7, 0.65],
      // Birch is the whippy one: high gnarliness on the thin upper branches
      // and a strong upward force, so it reads as light and springy.
      gnarliness: [0.09, 0.20, 0.3],
      twist:      [0.05, 0.07, 0],
      force: { direction: [0, 1, 0], strength: 0.13 },
      leaves: { count: 5, size: 40, angle: 0.38, start: 0.08, cross: true },
    },
  },
];

export const SPECIES_BY_ID = Object.fromEntries(SPECIES.map(s => [s.id, s]));

// Species grouped by biome, in the order the per-tile hash indexes them.
export const SPECIES_BY_BIOME = SPECIES.reduce((m, s) => {
  (m[s.biome] || (m[s.biome] = [])).push(s);
  return m;
}, {});
