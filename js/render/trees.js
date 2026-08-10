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
 * a smooth sphere. Flattened slightly (y*0.82) because real crowns are wider
 * than they are tall, and a stack of true spheres reads as grapes.
 *
 * Same two constraints as the conifer, both load-bearing:
 *   • merged to ONE BufferGeometry — topMesh is a single InstancedMesh
 *   • centred on the origin, spanning -height/2 .. +height/2, or the wind
 *     shader's `(transformed.y + TOPH*0.5) / TOPH` bends from the wrong place
 */
export function makeBroadleafCanopy(THREE, { height = 100, radius = 34, lobes = 7, seed = 5150 } = {}){
  const rand = rng(seed);
  const parts = [];

  // One broad lobe low and central carries the mass; the rest ring it and climb,
  // which is what makes the crown read as one clump rather than a bouquet.
  for(let i = 0; i < lobes; i++){
    const first = i === 0;
    // Normalised height: lower lobes are bigger, upper ones smaller and tighter.
    const t = first ? 0.18 : 0.15 + (i / lobes) * 0.85;
    const r = radius * (first ? 0.74 : 0.40 + (1 - t) * 0.34) * (0.85 + rand() * 0.3);

    // Ring placement, jittered. Upper lobes pull toward the axis so the crown
    // closes at the top instead of staying a torus.
    const ang = first ? 0 : (i / (lobes - 1)) * Math.PI * 2 + rand() * 0.9;
    const spread = first ? 0 : radius * (0.52 - t * 0.34) * (0.7 + rand() * 0.6);

    const g = new THREE.IcosahedronGeometry(r, 1);   // detail 1: 42 verts, plenty
    g.scale(1, 0.82, 1);                             // crowns are wider than tall
    // Perturb the hull so no two lobes share an outline and the merged
    // silhouette stops looking like assembled primitives.
    const pos = g.attributes.position;
    for(let v = 0; v < pos.count; v++){
      const k = 1 + (rand() - 0.5) * 0.30;
      pos.setXYZ(v, pos.getX(v) * k, pos.getY(v) * k, pos.getZ(v) * k);
    }
    pos.needsUpdate = true;

    g.translate(Math.cos(ang) * spread,
                -height * 0.5 + t * height * 0.86,
                Math.sin(ang) * spread);
    parts.push(g);
  }

  const merged = mergeGeometries(parts, false);
  for(const g of parts) g.dispose();
  if(!merged) throw new Error('makeBroadleafCanopy: mergeGeometries failed');
  merged.computeVertexNormals();
  merged.computeBoundingSphere();
  return merged;
}

/**
 * Trunk that FORKS. A broadleaf's trunk splits into a few leaning limbs that
 * disappear into the crown; a bare cylinder under a round canopy reads as a
 * lollipop. The limbs only have to exist where the crown does not quite cover
 * them — mostly the lower half — so they are cheap cylinders, leaned and
 * merged in with the shaft.
 */
export function makeBroadleafTrunk(THREE, { height = 72, top = 7, bottom = 13, limbs = 3, seed = 777 } = {}){
  const rand = rng(seed);
  const parts = [];
  const shaft = new THREE.CylinderGeometry(top, bottom, height, 8, 1, true);
  parts.push(shaft);

  const flareH = height * 0.18;
  const flare = new THREE.CylinderGeometry(bottom, bottom * 1.6, flareH, 8, 1, true);
  flare.translate(0, -height * 0.5 + flareH * 0.5, 0);
  roughenCone(flare, rand, 0.10);
  parts.push(flare);

  // Limbs spring from the upper third and lean outward, ending where the crown
  // will swallow them.
  for(let i = 0; i < limbs; i++){
    const len = height * (0.40 + rand() * 0.22);
    const g = new THREE.CylinderGeometry(top * 0.42, top * 0.78, len, 6, 1, true);
    const ang = (i / limbs) * Math.PI * 2 + rand() * 0.7;
    const lean = 0.52 + rand() * 0.28;               // radians from vertical
    g.translate(0, len * 0.5, 0);                    // pivot at the limb's base
    g.rotateZ(lean);
    g.rotateY(ang);
    g.translate(0, height * 0.16 + rand() * height * 0.12, 0);
    parts.push(g);
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
