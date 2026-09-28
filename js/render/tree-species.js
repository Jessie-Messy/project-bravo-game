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

  // Lighter than it was (#6b5842): the near trunks sit in their own canopy's
  // shade and read near-black, and jumped in colour at the far-LOD handoff.
  x.fillStyle = '#8f7a60';
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

  // Every shape is drawn twice: first fat and nearly transparent (well under
  // the material's alphaTest, so never visible), then for real. The canvas is
  // transparent BLACK around the leaves, and mipmapping averaged that black
  // into every edge — each leaf wore a dark outline, "oval scales" (tree
  // critic r3). The halo puts the leaf's own colour under its edges instead.
  const halo = (draw) => { x.save(); x.globalAlpha = 0.05; draw(2.2); x.restore(); draw(1); };

  if (kind === 'needle') {
    // Tufts, not a frond. This was a central rachis with needles either side
    // — a fern frond, and a branch of them read as tree-ferns and palms at
    // close range (tree critic r4, r5). Now a column of bottle-brush tufts
    // (short needles radiating from each), narrowing toward the tip, with no
    // line down the middle for the eye to read as a stem.
    const tufts = 26;
    for (let i = 0; i < tufts; i++) {
      const t = i / tufts;                                   // 0 at base, 1 at tip
      const w = S * 0.30 * (1 - t * 0.75);                   // the spray narrows to a point
      const cx = S * 0.5 + rand(-w, w) * 0.55, cy = S * (0.96 - t * 0.9);
      const r = S * rand(0.07, 0.12) * (1 - t * 0.5);
      for (let j = 0; j < 14; j++) {
        const a = rand(0, Math.PI * 2), l = r * rand(0.5, 1.0);
        // shade remapped into 0.62..1.0 of a light neutral green, so the
        // variation survives the multiply by the species colour
        const v = 0.62 + 0.38 * Math.random();
        x.strokeStyle = `rgb(${Math.round(206 * v)},${Math.round(228 * v)},${Math.round(182 * v)})`;
        const lw = S * rand(0.010, 0.018), ex = cx + Math.cos(a) * l, ey = cy + Math.sin(a) * l * 0.8 + l * 0.25;
        halo((k) => { x.lineWidth = lw * k; x.beginPath(); x.moveTo(cx, cy); x.lineTo(ex, ey); x.stroke(); });
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
      const ew = leafW * rand(0.6, 1.1) * 0.5, eh = leafH * rand(0.7, 1.15) * 0.5;
      halo((k) => { x.beginPath(); x.ellipse(0, 0, ew * (k > 1 ? 1.35 : 1), eh * (k > 1 ? 1.35 : 1), 0, 0, Math.PI * 2); x.fill(); });
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
    barkColor: 0xa4876a,   // (lifted: it multiplies the #8f7a60 bark texture, and landed near-black — tree critic r1)
    leafColor: 0x7fa254,
    leafKind: 'needle',
    params: {
      levels: 2,
      length:     [250, 86, 24],
      radius:     [9, 2.6, 1.1],
      taper:      [0.88, 0.94, 0.95],
      sections:   [9, 5, 3],
      segments:   [7, 5, 4],
      children:   [34, 0, 0],     // (22: a sparse bottle-brush once the crown was a cone, tree r4)
      start:      [0.30, 0.3, 0.2],
      profile:    ['cone', 'flat'],   // ('pine' — widest a third up — read as a column; tree critic r4)
      // Pine branches sit close to horizontal and sweep up at the ends; the
      // growth force below does the sweeping.
      angle:      [1.25, 0.6, 0.7],
      gnarliness: [0.03, 0.10, 0.18],
      twist:      [0.03, 0.05, 0],
      force: { direction: [0, 1, 0], strength: 0.10 },
      leaves: { count: 16, size: 34, angle: 0.16, start: 0.06, cross: true },   // (4x66, 7x40 fronds — r2, r3; 12x26 tufts skeletal — r6)
    },
  },
  {
    id: 'spruce',
    label: 'Spruce',
    biome: 'highland',
    seed: 55127,
    barkColor: 0x957c62,
    leafColor: 0x5f8c48,
    leafKind: 'needle',
    params: {
      levels: 2,
      length:     [230, 104, 26],
      radius:     [8.5, 2.8, 1.2],
      taper:      [0.9, 0.94, 0.95],
      sections:   [10, 5, 3],
      segments:   [7, 5, 4],
      children:   [38, 0, 0],
      start:      [0.10, 0.25, 0.2],
      profile:    ['cone', 'flat'],
      // Spruce droops: branches angle DOWN past horizontal, and the growth
      // force is weak so they stay drooping.
      angle:      [1.55, 0.5, 0.6],
      gnarliness: [0.03, 0.09, 0.16],
      twist:      [0.04, 0.05, 0],
      force: { direction: [0, 1, 0], strength: 0.035 },
      leaves: { count: 16, size: 36, angle: 0.16, start: 0.05, cross: true },
    },
  },
  {
    id: 'oak',
    label: 'Oak',
    biome: 'lowland',
    seed: 7731,
    barkColor: 0x9c8466,
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
      // The crown is the top half: limbs start halfway up the trunk and spread
      // wide. With them low and the width capped (tree-lod.js) every oak was
      // a tall narrow column — "poplars" (tree critic r3).
      start:      [0.50, 0.25, 0.2, 0.2],
      // Wide, spreading crown: big branch angles and a weak upward force, so
      // limbs go out before they go up.
      angle:      [1.0, 0.8, 0.7, 0.6],
      gnarliness: [0.10, 0.16, 0.22, 0.28],
      twist:      [0.06, 0.08, 0.06, 0],
      force: { direction: [0, 1, 0], strength: 0.05 },
      leaves: { count: 9, size: 28, angle: 0.42, start: 0.35, cross: true },
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
      start:      [0.50, 0.25, 0.2],
      profile:    ['round', 'flat'],
      angle:      [0.72, 0.7, 0.65],
      // Birch is the whippy one: high gnarliness on the thin upper branches
      // and a strong upward force, so it reads as light and springy.
      gnarliness: [0.09, 0.20, 0.3],
      twist:      [0.05, 0.07, 0],
      force: { direction: [0, 1, 0], strength: 0.13 },
      leaves: { count: 9, size: 24, angle: 0.38, start: 0.08, cross: true },
    },
  },
];

export const SPECIES_BY_ID = Object.fromEntries(SPECIES.map(s => [s.id, s]));

// Species grouped by biome, in the order the per-tile hash indexes them.
export const SPECIES_BY_BIOME = SPECIES.reduce((m, s) => {
  (m[s.biome] || (m[s.biome] = [])).push(s);
  return m;
}, {});
