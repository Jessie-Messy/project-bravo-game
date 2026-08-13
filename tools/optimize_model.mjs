// Shrink a character GLB for the web.
//   node tools/optimize_model.mjs <in.glb> <out.glb> [--tris 12000] [--tex 1024]
//
// Needs (dev-only, deliberately NOT repo dependencies — this runs once per asset):
//   npm i @gltf-transform/core @gltf-transform/extensions @gltf-transform/functions \
//         meshoptimizer sharp
//
// ── What it does, and why each step earns its place ─────────────────────────
// Source characters land here at 15–20MB. Almost all of it is two things: 2K PNG
// textures, and a film-grade triangle count. Both are free to fix and neither is
// visible at this game's camera distance.
//
//   1. KILL THE SELF-LIT MATERIAL. This is a correctness fix, not a size one, and
//      it is FIRST because it also deletes a whole texture. Assets exported from
//      Blender routinely carry emissiveFactor [1,1,1] plus an emissive texture
//      pointing at the same image as base colour. Three.js then ADDS that texture
//      on top of the lit result, so the model ignores the scene and glows at
//      night — it reads as a lit sticker pasted over the world. This exact bug
//      already shipped once here on the protagonist and the horse and cost a
//      session to find, because every theory about the LIGHTING was wrong: the
//      fault was in the asset. Stripping it drops the emissive texture with it,
//      which on this zombie was 6MB of the 18MB.
//   3. OPAQUE + single-sided. Exporters default characters to alphaMode BLEND and
//      doubleSided, which costs a sorted transparent pass and double the fragment
//      work for a model with no transparency at all.
//   4. Resize + recompress textures. 2048² PNG → 1024² (or smaller) JPEG/WebP.
//   5. Weld and simplify the mesh. 100k triangles is a film asset; a mob seen at
//      ~30 world units needs a fraction of that.
//   6. Resample animation tracks (drops keyframes that interpolate exactly).
//   7. Quantize positions/normals/UVs to integers.
//
// ⚠ NOT Draco. The game loads Draco from a CDN and that decoder has already
// failed silently once in this project (wrong host → GLBs never decoded while
// fallback rigs drew a plausible scene, so nothing looked broken). Quantization
// needs no decoder at all and gets most of the win. Add Draco later if the size
// genuinely demands it, with a test that proves the mesh decoded.
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { dedup, prune, resample, weld, simplify, quantize, textureCompress } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import { statSync } from 'node:fs';

const args = process.argv.slice(2);
const [inPath, outPath] = args.filter(a => !a.startsWith('--'));
const flag = (name, dflt) => {
  const i = args.indexOf('--' + name);
  return i >= 0 ? Number(args[i + 1]) : dflt;
};
if (!inPath || !outPath) {
  console.error('usage: node tools/optimize_model.mjs <in.glb> <out.glb> [--tris N] [--tex N]');
  process.exit(2);
}
const TARGET_TRIS = flag('tris', 12000);
const TEX_SIZE = flag('tex', 1024);

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const doc = await io.read(inPath);
const root = doc.getRoot();

const before = statSync(inPath).size;
const countTris = () => root.listMeshes().reduce((n, m) => n + m.listPrimitives()
  .reduce((k, p) => k + (p.getIndices() ? p.getIndices().getCount() / 3 : 0), 0), 0);
const trisBefore = countTris();

console.log(`in : ${(before / 1048576).toFixed(2)}MB · ${Math.round(trisBefore)} tris · ` +
            `${root.listTextures().length} textures · ${root.listAnimations().length} animations`);

// ── 1. de-glow ──
let stripped = 0, demetalled = 0;
for (const mat of root.listMaterials()) {
  const e = mat.getEmissiveFactor();
  const hasEmissiveTex = !!mat.getEmissiveTexture();
  if (hasEmissiveTex || (e[0] || e[1] || e[2])) {
    mat.setEmissiveFactor([0, 0, 0]);
    if (hasEmissiveTex) { mat.setEmissiveTexture(null); stripped++; }
  }
  // ── 2. de-metal ──
  // ⚠ glTF defaults metallicFactor to 1.0 when the exporter omits it, and Blender
  // routinely omits it. A fully METALLIC character with no environment map to
  // reflect renders very nearly BLACK — which is what this zombie did: four
  // silhouettes standing in bright noon sun. Skin, cloth and leather are
  // dielectric, so 0 is right for any character; a genuinely metal asset states
  // its own factor and keeps it.
  const mr = mat.getMetallicRoughnessTexture && mat.getMetallicRoughnessTexture();
  if (!mr && mat.getMetallicFactor() > 0.5) {
    mat.setMetallicFactor(0);
    demetalled++;
  }

  // ── 3. opaque, single-sided ──
  if (mat.getAlphaMode() === 'BLEND') mat.setAlphaMode('OPAQUE');
  mat.setDoubleSided(false);
  // An over-bright specular reads as wet plastic under the game's sun.
  const spec = mat.getExtension('KHR_materials_specular');
  if (spec && spec.setSpecularColorFactor) spec.setSpecularColorFactor([1, 1, 1]);
}
if (stripped) console.log(`  · stripped ${stripped} emissive texture(s) — the self-lit bug`);
if (demetalled) console.log(`  · set metalness 0 on ${demetalled} material(s) — glTF defaults it to 1, which renders black`);

// ── drop anything now unreferenced (the emissive image), then de-duplicate ──
await doc.transform(
  prune({ keepAttributes: false, keepLeaves: false }),
  dedup(),
);

// ── 4. textures ──
await doc.transform(textureCompress({
  encoder: sharp,
  targetFormat: 'webp',
  resize: [TEX_SIZE, TEX_SIZE],
  quality: 88,
}));

// ── 5. geometry ──
// ⚠ weld() FIRST. simplify() collapses edges, and an unwelded mesh has no shared
// edges to collapse — it silently achieves almost nothing and reports success.
await MeshoptSimplifier.ready;
const ratio = Math.min(1, TARGET_TRIS / Math.max(1, trisBefore));
await doc.transform(
  weld(),
  simplify({ simplifier: MeshoptSimplifier, ratio, error: 0.01, lockBorder: true }),
);

// ── 6 + 7. animation keyframes, then quantization ──
await doc.transform(
  resample(),
  quantize({ quantizePosition: 14, quantizeNormal: 10, quantizeTexcoord: 12, quantizeWeight: 8 }),
);

await io.write(outPath, doc);

const after = statSync(outPath).size;
const trisAfter = countTris();
console.log(`out: ${(after / 1048576).toFixed(2)}MB · ${Math.round(trisAfter)} tris · ` +
            `${root.listTextures().length} textures · ${root.listAnimations().length} animations`);
console.log(`     ${(100 - after * 100 / before).toFixed(1)}% smaller (${(before / 1048576).toFixed(1)}MB → ${(after / 1048576).toFixed(2)}MB)`);
for (const a of root.listAnimations()) console.log(`     clip: ${a.getName()}`);
