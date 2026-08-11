// trees.js — canopy and trunk geometry.
//
// The forest was a cylinder plus one 9-sided cone. That silhouette is the most
// obviously primitive thing left in the landscape: a real conifer is a stack of
// drooping skirts that overlap and thin toward the leader, and the gaps between
// those skirts are most of what makes it read as a tree at distance.
//
// Everything here MERGES DOWN TO A SINGLE BufferGeometry. That constraint is
// the whole design: `topMesh` is one InstancedMesh drawing thousands of trees in
// one call, so a canopy built from several separate meshes would multiply draw
// calls by the tier count. Merged, a four-tier canopy costs exactly what the
// single cone did.
//
// Local-space convention is load-bearing and must not change: the canopy is
// centred on the origin and spans -height/2 .. +height/2. game3d.js positions it
// at `trunkHeight + canopyHeight/2`, and the wind shader derives its bend
// weight from `(transformed.y + TOPH*0.5) / TOPH`. Move the origin and both
// break silently — the tree will still draw, it will just bend from the wrong
// place.

import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// Small deterministic PRNG. Shape variation has to be reproducible: the tree
// meshes are rebuilt whenever the instance window slides, and a canopy that
// reshuffled its own vertices would shimmer.
function rng(seed){
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Perturb a cone's rings so the outline stops being a perfect circle. Done on
// the geometry rather than in a shader because it's free at runtime and it
// survives into the shadow and depth passes, which a vertex-shader wobble
// would not.
function roughenCone(geo, rand, amount){
  const pos = geo.attributes.position;
  // One radial offset per ANGLE, shared by every ring at that angle — otherwise
  // rings wander independently and the cone looks crumpled rather than ragged.
  const lobes = 7 + Math.floor(rand() * 4);
  const phase = rand() * Math.PI * 2;
  const k2 = 0.55 + rand() * 0.5;
  for(let i = 0; i < pos.count; i++){
    const x = pos.getX(i), z = pos.getZ(i);
    const r = Math.hypot(x, z);
    if(r < 1e-4) continue;                       // leave the apex alone
    const a = Math.atan2(z, x);
    const w = 1 + amount * (Math.sin(a * lobes + phase) * 0.6
                          + Math.sin(a * (lobes * 2 + 1) + phase * k2) * 0.4);
    pos.setX(i, x * w);
    pos.setZ(i, z * w);
  }
  pos.needsUpdate = true;
  return geo;
}

/**
 * A stacked-skirt conifer canopy, merged to one geometry.
 * `height` and `radius` are in WORLD units — this geometry is not normalised,
 * matching the single cone it replaces.
 */
export function makeConiferCanopy(THREE, { height = 100, radius = 34, tiers = 4, seed = 1337 } = {}){
  const rand = rng(seed);
  const parts = [];

  for(let i = 0; i < tiers; i++){
    const t = tiers === 1 ? 0 : i / (tiers - 1);   // 0 at the bottom skirt, 1 at the leader

    // Radius falls off faster than linearly, so the lower skirts stay broad and
    // the top tapers to a point. A linear falloff just rebuilds a cone.
    // The bottom skirt splays slightly past the nominal radius.
    const r = radius * (1.10 - t * t * 0.92) * (0.88 + rand() * 0.24);

    // Skirts are WIDE AND FLAT — roughly as tall as they are wide, not taller.
    // The first attempt used 0.46*height falling to 0.33, which made each tier a
    // tall narrow cone; stacked, they read as a row of spikes rather than a
    // tree. A conifer's branch whorls are shallow, and it's the horizontal
    // spread that makes the silhouette.
    const h = height * (0.34 - t * 0.08) * (0.9 + rand() * 0.2);

    // Spread over the lower 62% so the tiers stay inside -height/2..+height/2
    // and the leader still has room above the last skirt. Anything larger
    // pushes the top tier out past the bounds the wind shader assumes.
    const y = -height * 0.5 + t * height * 0.62 + h * 0.5;

    // Fewer facets higher up — those tiers are small on screen and the polygons
    // are wasted there.
    const seg = Math.max(6, 11 - i);
    const g = new THREE.ConeGeometry(r, h, seg, 1, true);   // open-ended: the base cap is never visible
    roughenCone(g, rand, 0.11 + t * 0.05);
    g.rotateY(rand() * Math.PI * 2);                        // decorrelate tier outlines
    g.translate(0, y, 0);
    parts.push(g);
  }

  const merged = mergeGeometries(parts, false);
  for(const g of parts) g.dispose();
  if(!merged) throw new Error('makeConiferCanopy: mergeGeometries failed');
  merged.computeVertexNormals();
  merged.computeBoundingSphere();
  return merged;
}

// Coherent hull warp for a foliage clump.
//
// ⚠ The first version jittered every vertex independently by ±15%. That frosts
// the lobe with high-frequency spikes: from the game's ~57° camera the whole
// forest reads as cauliflower, and — worse — it destroys the smooth rounded cap
// that the baked lighting below needs in order to separate one clump from the
// next. A few LOW-frequency sinusoids in direction space dent the lobe in three
// or four big places instead, which is what a clump of foliage actually does,
// and it leaves the cap intact.
function warpLobe(geo, rand, amount){
  const pos = geo.attributes.position;
  const fA = 2 + Math.floor(rand() * 2);      // lobes around the equator
  const fB = 2 + Math.floor(rand() * 3);      // lobes pole-to-pole
  const pA = rand() * Math.PI * 2, pB = rand() * Math.PI * 2;
  for(let i = 0; i < pos.count; i++){
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const len = Math.hypot(x, y, z) || 1e-6;
    const th = Math.atan2(z, x);
    const ph = Math.acos(Math.max(-1, Math.min(1, y / len)));
    const w = 1 + amount * (Math.sin(th * fA + pA) * 0.6 + Math.sin(ph * fB + pB) * 0.4);
    pos.setXYZ(i, x * w, y * w, z * w);
  }
  pos.needsUpdate = true;
}

// Compress a clump's underside. Foliage grows toward the light, so a clump
// presents a full rounded cap upward and a flatter, cut-off belly downward —
// squashing y<0 is the cheapest way to say that, and it also stops the lower
// half of every clump poking out of the crown's silhouette from below.
function squashBelly(geo, k){
  const pos = geo.attributes.position;
  for(let i = 0; i < pos.count; i++){
    const y = pos.getY(i);
    if(y < 0) pos.setY(i, y * k);
  }
  pos.needsUpdate = true;
}

/**
 * BROADLEAF canopy — clustered lobes, not stacked skirts.
 *
 * A conifer reads as a silhouette of gaps between drooping tiers. A broadleaf
 * reads as MASS: several overlapping rounded clumps that together make one
 * irregular blob, with the lobes deep enough that the lit tops and shaded
 * undersides separate. That separation is what gives a painted-looking tree its
 * volume, and a single sphere never has it however you shade it.
 *
 * Lobes are low-poly icosahedra: at this camera distance the facets read as
 * brush planes rather than as a low-poly artifact, and they cost a fraction of
 * a smooth sphere. Detail 1 (80 tris) for the clumps that carry the silhouette,
 * detail 0 (20 tris) for the small ones that only break the outline — which is
 * why this crown holds ~12 clumps for the same triangle count the old 7 cost.
 *
 * Same two constraints as the conifer, both load-bearing:
 *   • merged to ONE BufferGeometry — topMesh is a single InstancedMesh
 *   • centred on the origin, spanning -height/2 .. +height/2, or the wind
 *     shader's `(transformed.y + TOPH*0.5) / TOPH` bends from the wrong place
 */
export function makeBroadleafCanopy(THREE, { height = 100, radius = 34, lobes = 10, seed = 5150,
                                             lean = 0, spreadBias = 1, topHeavy = 0.5,
                                             droop = 0.35, hue = 0, value = 0 } = {}){
  const rand = rng(seed);

  // ── Pass 1: lay out clump centres ───────────────────────────────
  // Centres are computed before any geometry exists so the whole crown can be
  // fitted to the height box afterwards (see pass 2). Building the lobes first
  // and moving them later would mean re-walking every vertex.
  const spec = [];
  const RX = radius * spreadBias;
  // RY has to make the clump ring nearly as tall as the height box on its own.
  // ⚠ Measured trap: at RY = 0.24·height the natural crown filled barely half the
  // box, the fit below hit its 1.70 clamp, and the clumps ended up stretched far
  // apart vertically — a holey crown that still didn't reach the top of the box.
  const RY = height * (0.42 + topHeavy * 0.20);
  const nOuter = Math.max(4, lobes - 1);
  // Fewer, bigger majors. Painted foliage has a SCALE HIERARCHY — two or three
  // masses that carry the form and a scatter of small accents on top of them.
  // An even mix of middling clumps averages back out into one bumpy surface.
  const nMajor = Math.max(2, Math.ceil(nOuter * 0.40));

  // The core: one broad mass low in the crown that everything else sits on.
  spec.push({ x: 0, y: -height * 0.10, z: 0,
              r: radius * (0.58 + (1 - topHeavy) * 0.12), det: 1, flat: 0.86 });

  for(let i = 0; i < nOuter; i++){
    // Golden-angle spiral over the dome. The old placement put every lobe on one
    // ring (`ang = i/(n-1) * 2π`), which from a 57° camera reads as a torus of
    // bumps with a bald patch on top; a spiral spreads clumps over the whole
    // upper surface, so the crown has clumps against the sky AND clumps at the
    // skirt, which is what makes it read as a dome of separate masses.
    const u  = (i + 0.5) / nOuter;
    const cy = 1 - u * (1.25 + droop * 0.55);        // +1 crown .. ~-0.6 skirt
    const sy = Math.sqrt(Math.max(0, 1 - cy * cy));
    const th = i * 2.399963 + rand() * 0.55;         // golden angle, jittered

    // Big and small clumps INTERLEAVED around the spiral (Bresenham-style), not
    // big-then-small: a crown whose large masses are all on one side reads as a
    // mistake rather than as character.
    const major = ((i * nMajor) % nOuter) < nMajor;

    // ⚠ Clump radius is the knob that decides whether the crown reads as MASSES
    // or as SPECKLE, and 0.36/0.23 was on the wrong side of it. On a shell of
    // ~11 clumps the mean centre-to-centre spacing is about 0.7·radius, so any
    // clump narrower than that leaves its neighbours standing apart: the render
    // came back as a pepper of small pale caps over dark gaps rather than a few
    // big lobes. These overlap by roughly a third, which is what fuses them into
    // one lobed surface while still leaving a crease between.
    const r = radius * (major ? 0.50 : 0.26) * (1 + (1 - cy) * 0.18) * (0.86 + rand() * 0.28);
    // Sit the clump most of the way out along the crown surface so it BULGES
    // past the core rather than sinking into it — the gap between neighbouring
    // bulges is the shadow that separates them.
    const place = 0.62 + rand() * 0.16;
    // One clump in five breaks ranks and stands proud of the crown surface. A
    // crown whose lobes all sit on one shell has a circular outline however
    // lumpy it is, and a wood of circles is the repetition the eye catches from
    // the game camera — where you mostly see crowns from ABOVE, so the outline
    // is nearly all of what a tree is.
    const rogue = rand() < 0.20;
    const out   = place * (cy < 0 ? 1 + droop * 0.34 : 1) * (rogue ? 1.26 : 1);
    spec.push({
      x: Math.cos(th) * sy * RX * out,
      y: cy * RY * place * (0.92 + rand() * 0.16) + (rogue ? r * 0.30 : 0),
      z: Math.sin(th) * sy * RX * out,
      // Skirt clumps keep their bellies. Squashing the underside is right for
      // the clumps you see from above, but doing it to the skirt as well cut the
      // whole crown off flat and made the tree a mushroom cap on a pole — very
      // obvious from any low camera angle.
      r: r * (rogue ? 0.84 : 1), det: major ? 1 : 0, flat: cy < 0 ? 0.95 : 0.74,
    });
  }

  // Fit the crown to the height box. Parameter combinations that fill only two
  // thirds of it made the tree look stunted (game3d still positions the canopy
  // as if it were TOPH tall), and combinations that overflow push clumps past
  // the bounds the wind shader assumes. Rescaling the CENTRES rather than the
  // lobes keeps every clump round; the spread factor is clamped so an extreme
  // shape stretches its gaps a little rather than turning into a string.
  // The half-extents below must match what pass 2 actually builds: y is scaled
  // 0.88, the belly is squashed by s.flat, and warpLobe can push the hull out by
  // its amplitude (≈1.12). Estimating the bottom at a flat 0.62·r is what let the
  // deep-bellied core lobe hang 6 units below the box.
  //
  // ⚠ Solve the stretch on the CENTRES ALONE, discounting the two extreme lobes'
  // radii. The obvious version — kY = wantSpan / (yHi - yLo) — is wrong, because
  // scaling the centres by kY does not scale the lobe radii with them, so the
  // crown always came out (kY-1)·radii SHORT: measured 54 units of a 67-unit
  // target at the top, which looked like the clamp binding and was not.
  let loI = spec[0], hiI = spec[0], loV = Infinity, hiV = -Infinity;
  const belowOf = s => s.r * 0.88 * s.flat * 1.12;
  const aboveOf = s => s.r * 0.88 * 1.12;
  for(const s of spec){
    const lo = s.y - belowOf(s), hi = s.y + aboveOf(s);
    if(lo < loV){ loV = lo; loI = s; }
    if(hi > hiV){ hiV = hi; hiI = s; }
  }
  // ⚠ The crown deliberately hangs BELOW its own box. At -0.52 the skirt stopped
  // level with the top of the trunk, which from a low camera is a cap on a pole:
  // 40% of every tree was bare bole. A broadleaf's foliage starts around a third
  // of the way up, so the skirt drops past the box and swallows the fork.
  // Nothing breaks — the wind shader's hFrac clamps to 0 down there, and a
  // skirt clump that doesn't sway is correct anyway.
  const wantLo = -height * 0.64, wantHi = height * 0.46;
  const span  = (wantHi - aboveOf(hiI)) - (wantLo + belowOf(loI));
  const kY = Math.max(0.70, Math.min(2.20, span / Math.max(1e-3, hiI.y - loI.y)));
  const offY = wantLo + belowOf(loI) - kY * loI.y;
  for(const s of spec) s.y = s.y * kY + offY;

  // ── Pass 2: build and place the lobes ───────────────────────────
  const parts = [], meta = [];
  let vOff = 0;
  for(const s of spec){
    const g = new THREE.IcosahedronGeometry(s.r, s.det);
    warpLobe(g, rand, s.det ? 0.16 : 0.24);
    g.scale(1, 0.88, 1);                       // crowns are wider than they are tall
    squashBelly(g, s.flat);
    g.rotateY(rand() * Math.PI * 2);           // decorrelate warp directions
    // Lean grows with height, so the crown drifts rather than shearing off the
    // trunk. Real trees rarely sit plumb over their own base.
    const leanK = lean * (s.y + height * 0.5) / height * radius;
    const x = s.x + leanK, z = s.z + leanK * 0.4;
    g.translate(x, s.y, z);
    // ⚠ mergeGeometries concatenates in array order, so these vertex ranges line
    // up with the merged buffer. If that ever stops holding, the lighting bake
    // below silently shades every clump with its neighbour's centre.
    const n = g.attributes.position.count;
    meta.push({ x, y: s.y, z, r: s.r, tint: 0.95 + rand() * 0.10, start: vOff, end: vOff + n });
    vOff += n;
    parts.push(g);
  }

  const merged = mergeGeometries(parts, false);
  for(const g of parts) g.dispose();
  if(!merged) throw new Error('makeBroadleafCanopy: mergeGeometries failed');
  merged.computeVertexNormals();

  // ── Bake the light into vertex colours ──────────────────────────
  // Sunlight alone cannot do this. The clump undersides face down and away from
  // every light, so lit only by the scene they render as one flat dark mass with
  // no read of the clumps inside it. Painting it into the geometry costs nothing
  // per frame and survives instancing, which a per-object tint could not.
  //
  // THREE terms, and it's the second and third that turn a blob into clumps:
  //   1. crown height   — pale at the top of the tree, deep at the skirt
  //   2. clump-local up — every clump gets its OWN lit cap and shaded belly, so
  //      the eye reads a dozen rounded masses instead of one gradient. A single
  //      global ramp (what this used to be) cannot do that at any contrast.
  //   3. occlusion      — a vertex buried inside a neighbouring clump goes dark,
  //      which is what carves the crevices BETWEEN clumps. Without it the
  //      clumps touch at full brightness and merge back into one surface.
  const pos = merged.attributes.position;
  const col = new Float32Array(pos.count * 3);
  for(const m of meta){
    for(let v = m.start; v < m.end; v++){
      const px = pos.getX(v), py = pos.getY(v), pz = pos.getZ(v);

      const gH = Math.max(0, Math.min(1, (py + height * 0.5) / height));
      const lUp = Math.max(0, Math.min(1, (py - m.y) / (m.r * 0.86) * 0.5 + 0.5));

      let occ = 0;
      for(const o of meta){
        if(o === m) continue;
        const d = Math.hypot(px - o.x, py - o.y, pz - o.z);
        if(d < o.r) occ += 1 - d / o.r;
      }
      occ = Math.min(0.9, occ * 0.70);

      // ⚠ Occlusion is a CREASE, not a dimmer. At 0.30 with the clumps now
      // overlapping properly, nearly every vertex had a neighbour inside it and
      // the whole wood sank a stop — dark and flat, worse than the blob it
      // replaced. 0.22 still carves the gaps between clumps and leaves the mass
      // in the sunlit range where the leaf texture reads.
      const k = (0.60 + Math.pow(gH, 0.75) * 0.62) * (0.82 + lUp * 0.28)
              * (1 - occ * 0.22) * m.tint * (1 + value);

      // Warm in the light, cool in the shade. A flat grey ramp reads as dirt on
      // the leaves rather than as light on them, and `hue` shifts a whole
      // variant toward lime or toward blue-green so a wood is not one colour.
      // ⚠ The hue swing was ±0.06 and invisible in-game: the leaf MAP is a
      // saturated green and it multiplies this, so a subtle tint is swallowed.
      // ±0.11 is what it takes to read as two species standing side by side.
      const warm = Math.max(0, Math.min(1, (k - 0.45) / 0.75));
      col[v*3]   = k * (0.93 + warm * 0.13 + hue * 0.11);
      col[v*3+1] = k * (1.00 + hue * 0.03);
      col[v*3+2] = k * (0.99 - warm * 0.20 - hue * 0.13);
    }
  }
  merged.setAttribute('color', new THREE.BufferAttribute(col, 3));
  merged.computeBoundingSphere();
  return merged;
}

// TEN recipes, not five. The table is deliberately longer than the caller's
// `count` so that raising TREE_VARIANTS in game3d.js buys genuinely new trees
// instead of re-cutting the same five; `pickShape` spreads the selection evenly
// across the table so count=5 takes 5 MAXIMALLY different entries rather than
// the first five (which would hand out two narrow crowns and no wide one).
const BROADLEAF_SHAPES = [
  // hMul/rMul are per-shape, not an `i % 3` pattern: the proportions have to
  // match the shape or a "broad spreading oak" comes out as tall as the column.
  { lobes:12, spreadBias:1.12, topHeavy:0.24, lean: 0.00, droop:0.55, hue: 0.22, value:  0.04, hMul:0.92, rMul:1.10 }, // broad low oak
  { lobes: 8, spreadBias:0.70, topHeavy:0.82, lean: 0.05, droop:0.15, hue:-0.35, value: -0.04, hMul:1.06, rMul:0.80 }, // tall and narrow
  { lobes:11, spreadBias:1.02, topHeavy:0.48, lean:-0.16, droop:0.40, hue: 0.00, value:  0.00, hMul:1.00, rMul:0.98 }, // full, leaning
  { lobes: 6, spreadBias:0.94, topHeavy:0.60, lean: 0.16, droop:0.30, hue: 0.45, value:  0.09, hMul:0.98, rMul:0.90 }, // sparse and open
  { lobes:13, spreadBias:1.06, topHeavy:0.40, lean:-0.05, droop:0.35, hue:-0.18, value: -0.07, hMul:0.96, rMul:1.02 }, // dense round
  { lobes:10, spreadBias:1.20, topHeavy:0.18, lean: 0.08, droop:0.62, hue: 0.10, value:  0.05, hMul:0.86, rMul:1.14 }, // wide flat-topped
  { lobes: 7, spreadBias:0.62, topHeavy:0.92, lean:-0.06, droop:0.10, hue:-0.50, value: -0.05, hMul:1.10, rMul:0.74 }, // upright column
  { lobes:10, spreadBias:1.00, topHeavy:0.55, lean: 0.28, droop:0.45, hue: 0.30, value: -0.02, hMul:1.02, rMul:0.94 }, // windblown, lopsided
  { lobes: 9, spreadBias:0.86, topHeavy:0.52, lean: 0.00, droop:0.22, hue:-0.28, value:  0.07, hMul:0.94, rMul:0.88 }, // compact ball
  { lobes:12, spreadBias:1.08, topHeavy:0.32, lean:-0.22, droop:0.58, hue: 0.16, value: -0.04, hMul:0.90, rMul:1.08 }, // big old spreader
];
const pickShape = (i, count) => Math.round(i * BROADLEAF_SHAPES.length / Math.max(1, count))
                                % BROADLEAF_SHAPES.length;

/**
 * A set of genuinely different crowns.
 *
 * ⚠ An InstancedMesh draws ONE geometry, so every tree sharing `topMesh` is
 * literally the same crown — jitter, spin and scale cannot hide that, and a
 * wood of one repeated silhouette is the thing that reads as artificial. Real
 * trees of a species look alike, not identical. Each variant here gets its own
 * InstancedMesh (a handful of draw calls for the whole forest), and trees pick
 * one by tile hash.
 *
 * Two things multiply what `count` variants buy, and both are why the shapes
 * below are deliberately ASYMMETRIC: game3d spins every tree about Y by a tile
 * hash, and scales girth and height independently. A lopsided crown therefore
 * presents a different outline depending which way the hash spun it; a
 * rotationally symmetric one looks the same from every angle and wastes the
 * spin entirely.
 */
export function makeBroadleafCanopySet(THREE, { height = 100, radius = 34, count = 5, seed = 5150 } = {}){
  const out = [];
  for(let i = 0; i < count; i++){
    const { hMul, rMul, ...sh } = BROADLEAF_SHAPES[pickShape(i, count)];
    out.push(makeBroadleafCanopy(THREE, {
      height: height * hMul,
      radius: radius * rMul,
      seed: seed + i * 7919, ...sh,
    }));
  }
  return out;
}

/**
 * Matching trunk variants — different taper, flare, limb counts and BEND.
 *
 * Indexed with the same `pickShape`, so variant n's trunk belongs to variant n's
 * crown: the column crown gets a slim tall bole, the spreading oak gets a thick
 * one that forks low, and the trunk leans the same way the crown does. Trunk and
 * canopy are separate InstancedMeshes but share the tile's Y-spin, so a matched
 * lean stays matched.
 */
export function makeBroadleafTrunkSet(THREE, { height = 72, top = 7, bottom = 13, count = 5, seed = 777 } = {}){
  const out = [];
  for(let i = 0; i < count; i++){
    const si = pickShape(i, count);
    const sh = BROADLEAF_SHAPES[si];
    const slim = sh.spreadBias;                       // narrow crown → narrow bole
    out.push(makeBroadleafTrunk(THREE, {
      height: height * sh.hMul,
      // A hard taper: the bole above the fork is a LEADER, not a continuation of
      // the bole. Carrying full girth to the top is what made these read as
      // telegraph poles with a bush on top.
      top:    top    * (0.40 + slim * 0.26),
      bottom: bottom * (0.78 + slim * 0.36),
      limbs:  2 + (si % 3),
      // Fork low. The crown skirt now hangs to about a third of tree height, so
      // a fork above that is invisible; these sit just under it.
      forkAt: -0.10 + (si % 4) * 0.07,
      bend:   sh.lean * 1.5,                          // bole drifts the way the crown does
      seed:   seed + i * 104729,
    }));
  }
  return out;
}

/**
 * Trunk that FORKS. A broadleaf's trunk splits into a few leaning limbs that
 * disappear into the crown; a bare cylinder under a round canopy reads as a
 * lollipop. The limbs only have to exist where the crown does not quite cover
 * them — mostly the lower half — so they are cheap cylinders, leaned and
 * merged in with the shaft.
 */
export function makeBroadleafTrunk(THREE, { height = 72, top = 7, bottom = 13, limbs = 3, seed = 777,
                                            forkAt = 0.16, bend = 0, roots = 4 } = {}){
  const rand = rng(seed);
  const parts = [];

  // The bole is no longer a perfectly straight post. Three height segments and a
  // smooth drift give it a slight sweep — cheap (2 extra rings = 32 tris) and
  // it's the difference between a tree and a telegraph pole at close range.
  // The drift is weighted by height^1.6 so the BASE stays put: it has to stay
  // centred on the tile or the trunk walks out of the square that blocks
  // movement, and it has to meet the ground square or the flare shows daylight.
  const shaft = new THREE.CylinderGeometry(top, bottom, height, 8, 3, true);
  // ⚠ Roughen BEFORE bending. roughenCone scales x/z about the axis, so run on a
  // bent shaft it would scale the bend offset too and drag the rings sideways.
  roughenCone(shaft, rand, 0.07);      // out-of-round bole; bark is not a lathe turning
  {
    const pos = shaft.attributes.position;
    const bx = bend * height * 0.30, bz = bend * height * 0.12;
    for(let i = 0; i < pos.count; i++){
      const f = Math.pow(Math.max(0, (pos.getY(i) + height * 0.5) / height), 1.6);
      pos.setX(i, pos.getX(i) + bx * f);
      pos.setZ(i, pos.getZ(i) + bz * f);
    }
    pos.needsUpdate = true;
  }
  parts.push(shaft);

  const flareH = height * 0.18;
  const flare = new THREE.CylinderGeometry(bottom, bottom * 1.6, flareH, 8, 1, true);
  flare.translate(0, -height * 0.5 + flareH * 0.5, 0);
  roughenCone(flare, rand, 0.10);
  parts.push(flare);

  // Root spurs. The flare alone still meets the grass on a clean circle; a few
  // short cones leaning out of the base break that line where the eye is closest
  // to it. 5 tris each — the cheapest detail in the file.
  for(let i = 0; i < roots; i++){
    const rl = bottom * (1.5 + rand() * 1.1);
    const g = new THREE.ConeGeometry(bottom * 0.34, rl, 5, 1, true);
    g.translate(0, rl * 0.5, 0);
    g.rotateZ(1.15 + rand() * 0.30);                 // nearly flat to the ground
    g.rotateY((i / roots) * Math.PI * 2 + rand() * 0.8);
    g.translate(0, -height * 0.5 + rl * 0.10, 0);
    parts.push(g);
  }

  // Limbs FORK. A single straight limb per direction is still a stick; a real
  // broadleaf splits, and the second segment sweeps back toward vertical, which
  // is what gives the vase shape you see under the crown. Two segments plus the
  // occasional twig, all merged into the same geometry.
  //
  // `forkAt` is where the crotch sits as a fraction of trunk height above the
  // middle — a low fork reads as an old spreading tree, a high one as a young
  // straight one, and that difference is visible from the game camera because
  // the crown does not cover the trunk below its skirt.
  const attach0 = height * forkAt;
  for(let i = 0; i < limbs; i++){
    const ang  = (i / limbs) * Math.PI * 2 + rand() * 0.7;
    const y0   = attach0 + rand() * height * 0.10;
    const len1 = height * (0.34 + rand() * 0.14);
    const lean1 = 0.46 + rand() * 0.28;              // radians from vertical
    // ⚠ Limb radius comes off `bottom`, not `top`. The bole's top is now a thin
    // leader (see makeBroadleafTrunkSet), and limbs sized from it came out as
    // twigs that vanished at any distance — the fork simply didn't read.
    const r1 = bottom * 0.40, r2 = bottom * 0.24;

    const g1 = new THREE.CylinderGeometry(r2, r1, len1, 6, 1, true);
    g1.translate(0, len1 * 0.5, 0);                  // pivot at the limb's base
    g1.rotateZ(lean1); g1.rotateY(ang);
    g1.translate(0, y0, 0);
    parts.push(g1);

    // Where segment 1 ended, in the same frame — computed rather than eyeballed,
    // because a fork with a visible gap at the joint is worse than no fork.
    // ⚠ Sign matters: rotateZ(+θ) swings +y toward −x, and rotateY(+φ) then maps
    // (x,0) to (x·cosφ, −x·sinφ). Get either backwards and the second segment
    // sprouts from thin air on the OPPOSITE side of the trunk.
    const ex = -Math.sin(lean1) * len1;
    const jx = Math.cos(ang) * ex, jz = -Math.sin(ang) * ex;
    const jy = y0 + Math.cos(lean1) * len1;

    const nSub = 1 + (rand() < 0.55 ? 1 : 0);        // one limb, sometimes two
    for(let s = 0; s < nSub; s++){
      const len2 = len1 * (0.62 + rand() * 0.30);
      const lean2 = lean1 * (s === 0 ? 0.42 : 1.25) + (rand() - 0.5) * 0.25;  // sweeps back up
      const ang2  = ang + (s === 0 ? (rand() - 0.5) * 0.5 : 0.7 + rand() * 0.7);
      const g2 = new THREE.CylinderGeometry(r2 * 0.55, r2, len2, 5, 1, true);
      g2.translate(0, len2 * 0.5, 0);
      g2.rotateZ(lean2); g2.rotateY(ang2);
      g2.translate(jx, jy, jz);
      parts.push(g2);
    }
  }

  const merged = mergeGeometries(parts, false);
  for(const g of parts) g.dispose();
  if(!merged) throw new Error('makeBroadleafTrunk: mergeGeometries failed');
  merged.computeVertexNormals();
  merged.computeBoundingSphere();
  return merged;
}

/**
 * Trunk with a root flare. The old cylinder met the ground at a hard edge,
 * which is very visible now that grass is dense enough to sit against it.
 * Also merged to one geometry.
 */
export function makeTrunk(THREE, { height = 72, top = 9, bottom = 12, seed = 99 } = {}){
  const rand = rng(seed);
  const shaft = new THREE.CylinderGeometry(top, bottom, height, 9, 1, true);
  // Short flared skirt at the base, wider than the shaft, blending into the
  // ground plane.
  const flareH = height * 0.16;
  const flare = new THREE.CylinderGeometry(bottom, bottom * 1.55, flareH, 9, 1, true);
  flare.translate(0, -height * 0.5 + flareH * 0.5, 0);
  roughenCone(flare, rand, 0.09);

  const merged = mergeGeometries([shaft, flare], false);
  shaft.dispose(); flare.dispose();
  if(!merged) throw new Error('makeTrunk: mergeGeometries failed');
  merged.computeVertexNormals();
  merged.computeBoundingSphere();
  return merged;
}
