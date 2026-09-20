// tree-lod.js — the near half of the forest's two-level LOD.
//
// The forest draws at two levels of detail:
//
//   FAR  the merged stacked-cone canopy from trees.js, ~250 triangles, one
//        shared geometry for the whole forest. This is what every tree used to
//        be and it is still what most trees are.
//   NEAR full procedural branch geometry from tree-gen.js, ~2000 triangles,
//        one pair of meshes (bark + leaves) per species.
//
// The split is a BUDGET, not a radius: quality.nearTrees says how many trees
// may draw branch geometry, and rebuildTrees spends that budget on the closest
// ones. Forest cost is therefore bounded by a number in the tier table rather
// than by how much forest is on screen — which is the only way this is safe on
// a weak GPU, where nearTrees is 0 and none of this is ever built.
//
// SIZE MATCHING IS LOAD-BEARING. Every generated species is scaled so its total
// height equals the game's TREE_H. If near and far geometry differ in size, a
// tree visibly jumps as it crosses the budget boundary while you walk, which is
// far more distracting than never having had branch geometry at all.

import { generateTree } from './tree-gen.js';
import { SPECIES, makeBarkTexture, makeLeafTexture } from './tree-species.js';

/**
 * Build the near-LOD mesh set: one bark mesh and one leaf mesh per species.
 *
 * @param THREE
 * @param opts.makeMesh      game3d's InstancedMesh helper (adds to scene,
 *                           disables frustum culling, sets count 0)
 * @param opts.targetHeight  TREE_H — every species is normalised to this
 * @param opts.capacity      instances per species mesh
 * @param opts.windUniform   the shared { value } uniform driving canopy sway
 * @param opts.anisotropy    from the quality tier
 * @returns {{ species: Array, meshes: Array, dispose: Function }}
 */
export function buildNearForest(THREE, opts) {
  const { makeMesh, targetHeight, capacity, windUniform, anisotropy = 4 } = opts;

  const barkTex = makeBarkTexture(THREE);
  barkTex.anisotropy = anisotropy || 4;
  // Bark repeats up the trunk; tree-gen already emits a V that grows with
  // branch length, so this only has to allow wrapping.
  barkTex.repeat.set(1, 1);

  const leafTexCache = new Map();
  const leafTexFor = (kind) => {
    if (!leafTexCache.has(kind)) {
      const t = makeLeafTexture(THREE, kind);
      t.anisotropy = anisotropy || 4;
      leafTexCache.set(kind, t);
    }
    return leafTexCache.get(kind);
  };

  const species = [];
  const meshes = [];

  for (const sp of SPECIES) {
    const g = generateTree(THREE, sp.params, sp.seed);

    // Normalise height. See the header — near and far must match in size.
    const k = targetHeight / Math.max(1, g.height);
    g.bark.scale(k, k, k);
    g.leaf.scale(k, k, k);
    g.bark.computeBoundingSphere();
    g.leaf.computeBoundingSphere();

    const barkMat = new THREE.MeshStandardMaterial({
      map: barkTex, color: sp.barkColor, roughness: 0.95, metalness: 0.0,
    });
    const leafMat = new THREE.MeshStandardMaterial({
      map: leafTexFor(sp.leafKind), color: sp.leafColor,
      roughness: 0.85, metalness: 0.0,
      // Foliage cards are flat quads seen from both sides, and the texture is
      // a cutout: without alphaTest they draw as opaque squares.
      alphaTest: 0.45, side: THREE.DoubleSide,
    });

    applyWind(THREE, leafMat, windUniform, targetHeight, 'leaf-' + sp.id);
    // Branches sway too, just far less — a canopy that moves while the limbs
    // holding it stay rigid reads as the leaves sliding off the tree.
    applyWind(THREE, barkMat, windUniform, targetHeight, 'bark-' + sp.id, 0.35);

    const bark = makeMesh(g.bark, barkMat, capacity);
    const leaf = makeMesh(g.leaf, leafMat, capacity);
    // Per-mesh instance→tile maps. The forest used to be two meshes sharing one
    // array indexed by instanceId; with a mesh per species that array would be
    // read with another mesh's index, and chopping would hit the wrong tree.
    bark.userData.instTile = [];
    leaf.userData.instTile = [];

    species.push({ id: sp.id, def: sp, bark, leaf, height: targetHeight });
    meshes.push(bark, leaf);
  }

  return {
    species,
    meshes,
    byId: Object.fromEntries(species.map(s => [s.id, s])),
    dispose() {
      for (const s of species) {
        s.bark.geometry.dispose(); s.leaf.geometry.dispose();
        s.bark.material.dispose(); s.leaf.material.dispose();
      }
      barkTex.dispose();
      for (const t of leafTexCache.values()) t.dispose();
    },
  };
}

// Same sway the cone canopy uses, re-derived for base-anchored geometry.
//
// The old canopy spanned -TOPH/2..+TOPH/2 and had to add TOPH*0.5 to find its
// height fraction. Generated trees start at y=0 and grow up, so the fraction is
// just y/height — simpler, and correct all the way down to the roots, where the
// old version was only ever correct within the canopy.
function applyWind(THREE, material, windUniform, height, cacheKey, scale = 1.0) {
  const AMP = 7.0 * scale;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uWindTime = windUniform;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uWindTime;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
      {
        #ifdef USE_INSTANCING
          vec3 wInst = instanceMatrix[3].xyz;
        #else
          vec3 wInst = vec3(0.0);
        #endif
        float hFrac = clamp(transformed.y / ${height.toFixed(2)}, 0.0, 1.0);
        float phase = (wInst.x + wInst.z) * 0.0035;
        float sway  = sin(uWindTime * 1.30 + phase) * 0.60
                    + sin(uWindTime * 2.10 + phase * 1.7) * 0.25;
        float w = hFrac * hFrac * ${AMP.toFixed(2)};
        transformed.x += sway * w;
        transformed.z += sway * w * 0.6;
      }`);
  };
  // Materials that differ only by a patch must not share a compiled program.
  material.customProgramCacheKey = () => 'tree-wind-' + cacheKey;
}

// ── Biome ─────────────────────────────────────────────────────────
//
// The world has no biome layer — tiles are GRASS/PATH/WATER/TREE/STONE and
// nothing else. Rather than add one to world generation (which would change
// saved maps), biome is DERIVED from signals that already exist and are already
// deterministic: terrain elevation, a low-frequency noise field, and whether
// there is water nearby. Same seed in, same forest out, on every client.
//
// Returns one of the `biome` keys used in tree-species.js.
export function makeBiomeSampler({ heightAt, isWaterNear, noise, TILE, amplitude = 90 }) {
  return function biomeAt(tx, ty) {
    // Water wins outright: a birch stand on a riverbank is the most legible
    // biome cue there is, and it costs one lookup.
    if (isWaterNear(tx, ty)) return 'riverside';

    const wx = tx * TILE + TILE * 0.5, wz = ty * TILE + TILE * 0.5;
    const h = heightAt(wx, wz) / Math.max(1, amplitude);   // roughly 0..1

    // A slow noise field so the boundary between forest types wanders instead
    // of following a contour line exactly — contour-aligned species changes
    // read as a bug.
    const n = noise(tx * 0.021, ty * 0.021);

    // Elevation dominates, noise shifts the treeline by about ±15%.
    return (h + (n - 0.5) * 0.30) > 0.46 ? 'highland' : 'lowland';
  };
}
