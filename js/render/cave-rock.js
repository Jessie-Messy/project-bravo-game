// cave-rock.js — the outside of the surface caves as one continuous rock mass.
//
// The caves were drawn as one box per CAVE_WALL tile. Up close that was a wall
// of stacked crates; from the fields it was a flat-topped slab (black, then
// pale, then dotted, through three rounds of critic fixes to its shading). No
// shading fixes a silhouette, so this replaces the geometry: a heightfield over
// every wall tile and its neighbours, sampled SUB times per tile, that stands
// up where the walls are, falls away steeply at their edges, and carries
// crags, saddles and a broken skyline on top.
//
// Occupancy is sampled bilinearly between tile centres, so the rock's foot runs
// between a wall tile and its open neighbour (collision stays per tile, and is
// untouched), and a stair-stepped tile outline comes out as a rough diagonal
// instead of a staircase. Where there is no wall the surface is sunk under the
// terrain, so it can never show as a skin over the ground.
//
// Pure geometry: no scene, no game state. game3d.js supplies the map lookups.

export const CAVE_ROCK_SUB = 3;

/**
 * @param opts.isWall   (tx, ty) => boolean — a CAVE_WALL tile this mesh covers
 * @param opts.tiles    [[tx, ty], ...] those tiles
 * @param opts.TILE
 * @param opts.height   nominal wall height (the old box height)
 * @param opts.groundAt (wx, wz) => ground height
 * @param opts.noise    (x, y) => 0..1 smooth value noise
 * @param opts.ridged   (x, y) => 0..1 ridged noise
 * @returns BufferGeometry (position, normal) or null
 */
export function buildCaveRock(THREE, { isWall, tiles, TILE, height, groundAt, noise, ridged, nearMouth = () => false }) {
  if (!tiles.length) return null;
  const S = CAVE_ROCK_SUB;
  // Occupancy at a point in TILE units: bilinear over tile centres.
  const occ = (fx, fy) => {
    const x = fx - 0.5, y = fy - 0.5, x0 = Math.floor(x), y0 = Math.floor(y), ax = x - x0, ay = y - y0;
    const o = (tx, ty) => isWall(tx, ty) ? 1 : 0;
    return (o(x0, y0) * (1 - ax) + o(x0 + 1, y0) * ax) * (1 - ay) + (o(x0, y0 + 1) * (1 - ax) + o(x0 + 1, y0 + 1) * ax) * ay;
  };
  const sstep = (a, b, v) => { const t = Math.min(1, Math.max(0, (v - a) / (b - a))); return t * t * (3 - 2 * t); };
  // The silhouette (v0.24, nature critic r5: from the fields a ring read as an
  // even wall with sheer-cut ends). Each wall tile gets a rim factor: stepped
  // down toward the ends and corners of a run (0.35, then 0.6), and varied
  // tile to tile by up to a quarter. Blended between tile centres like `occ`.
  const run = (tx, ty, dx, dy) => { let k = 0; while (k < 3 && isWall(tx + dx * (k + 1), ty + dy * (k + 1))) k++; return k; };
  const rimCache = new Map();
  const rimOf = (tx, ty) => {
    const key = tx + ',' + ty; let f = rimCache.get(key);
    if (f !== undefined) return f;
    if (!isWall(tx, ty)) f = 1;
    else {
      const e = Math.max(Math.min(run(tx, ty, -1, 0), run(tx, ty, 1, 0)), Math.min(run(tx, ty, 0, -1), run(tx, ty, 0, 1)));
      // (never beside a cave mouth: its portal rides up to the cliff tops)
      const step = e >= 2 || nearMouth(tx, ty) ? 1 : e === 1 ? 0.6 : 0.35;
      f = step * (1 - 0.25 * noise(tx * 0.83 + 17.7, ty * 0.83 + 3.9));
    }
    rimCache.set(key, f); return f;
  };
  const rim = (fx, fy) => {
    const x = fx - 0.5, y = fy - 0.5, x0 = Math.floor(x), y0 = Math.floor(y), ax = x - x0, ay = y - y0;
    return (rimOf(x0, y0) * (1 - ax) + rimOf(x0 + 1, y0) * ax) * (1 - ay) + (rimOf(x0, y0 + 1) * (1 - ax) + rimOf(x0 + 1, y0 + 1) * ax) * ay;
  };

  // Every tile within one of a wall: the rock's foot spills half a tile out.
  const cover = new Set();
  for (const [tx, ty] of tiles) for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) cover.add((tx + ox) + ',' + (ty + oy));

  const pos = [], idx = [], vid = new Map();
  const vertex = (gx, gy) => {            // grid coords, S per tile
    const key = gx + ',' + gy;
    let i = vid.get(key);
    if (i !== undefined) return i;
    const fx = gx / S, fy = gy / S;
    // A talus foot, not a sheer sheet: the face leans back over most of a tile.
    // (v0.24: at ×1.5 the cliffs read as extruded fortress walls, nature
    // critic r3 — the foot now flares out from further down the occupancy
    // ramp, a battered base under a steep upper face, same footprint)
    const s = Math.pow(sstep(0.03, 0.86, occ(fx, fy)), 1.9);
    // Massing: broad swells and saddles, then crags, then a fine break-up.
    const mass = 0.70 + 0.85 * noise(fx / 7 + 3.3, fy / 7 + 1.1);
    const crag = 0.55 * ridged(fx / 2.6 + 9.1, fy / 2.6 + 4.7) + 0.18 * noise(fx * 1.3, fy * 1.3);
    // The foot is jittered sideways a little so faces are not planar sheets.
    const j = s > 0.02 && s < 0.98 ? 9 : 0;
    const wx = fx * TILE + (noise(fx * 2.1 + 7, fy * 2.1) - 0.5) * j * 2;
    const wz = fy * TILE + (noise(fx * 2.1, fy * 2.1 + 5) - 0.5) * j * 2;
    const g = groundAt(wx, wz);
    const y = s <= 0.001 ? g - 4 : g - 4 * (1 - s) + height * s * (mass + crag * s) * rim(fx, fy);
    i = pos.length / 3;
    pos.push(wx, y, wz);
    vid.set(key, i);
    return i;
  };
  for (const k of cover) {
    const [tx, ty] = k.split(',').map(Number);
    for (let sy = 0; sy < S; sy++) for (let sx = 0; sx < S; sx++) {
      const gx = tx * S + sx, gy = ty * S + sy;
      // skip quads with no rock at any corner
      const c = [[gx, gy], [gx + 1, gy], [gx, gy + 1], [gx + 1, gy + 1]];
      if (!c.some(([a, b]) => occ(a / S, b / S) > 0.2)) continue;
      const a = vertex(gx, gy), b = vertex(gx + 1, gy), d = vertex(gx, gy + 1), e = vertex(gx + 1, gy + 1);
      idx.push(a, d, b, b, d, e);
    }
  }
  if (!idx.length) return null;
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  geo.computeBoundingSphere();
  return geo;
}
