// tools/bake.mjs — turn raw Meshy exports into shippable game assets.
//
// Replaces compress_models.ps1, which only touched files over 2 MB (so 19 of 39 models
// were never processed at all), required a global CLI install, and ran by hand on
// Windows. This runs everywhere Node runs, processes every asset, and is driven by
// assets/budgets.json.
//
//   node tools/bake.mjs              # bake models_src/ -> models/
//   node tools/bake.mjs --dry-run    # report what would change, write nothing
//   node tools/bake.mjs --only wolf  # bake just the models matching a substring
//
// SOURCE OF TRUTH: models_src/ holds the untouched exports. models/ is build output and
// is overwritten on every run. On first run, if models_src/ does not exist, the current
// contents of models/ are copied into it -- baking is lossy, so the originals have to
// live somewhere before that happens.

import { mkdir, readdir, stat, copyFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import sharp from 'sharp';
import {
  dedup, prune, weld, join as joinPrims, flatten,
  resample, textureCompress, draco, simplify,
} from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import { classify } from './lib/classify.mjs';
import { getIO } from './lib/io.mjs';

const SRC = 'models_src';
const OUT = 'models';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const onlyIdx = args.indexOf('--only');
const only = onlyIdx !== -1 ? args[onlyIdx + 1] : null;

const MB = (b) => (b / 1048576).toFixed(2);
const exists = (p) => access(p).then(() => true, () => false);

// ── first run: preserve the originals before we start overwriting models/ ──
if (!(await exists(SRC))) {
  console.log(`\n${SRC}/ does not exist -- treating the current ${OUT}/ as the originals.`);
  await mkdir(SRC, { recursive: true });
  const originals = (await readdir(OUT)).filter((f) => f.toLowerCase().endsWith('.glb'));
  for (const f of originals) await copyFile(join(OUT, f), join(SRC, f));
  console.log(`copied ${originals.length} originals into ${SRC}/ -- keep this directory.\n`);
}

const io = await getIO();
const files = (await readdir(SRC))
  .filter((f) => f.toLowerCase().endsWith('.glb'))
  .filter((f) => !only || f.toLowerCase().includes(only.toLowerCase()))
  .sort();

if (!files.length) {
  console.error(`no .glb files in ${SRC}/${only ? ` matching "${only}"` : ''}`);
  process.exit(1);
}

await mkdir(OUT, { recursive: true });

let before = 0;
let after = 0;
const results = [];

for (const file of files) {
  const srcPath = join(SRC, file);
  const outPath = join(OUT, file);
  const cls = classify(file);
  const srcBytes = (await stat(srcPath)).size;
  before += srcBytes;

  process.stdout.write(`${file.padEnd(34)} ${cls.name.padEnd(13)}`);

  let doc;
  try {
    doc = await io.read(srcPath);
  } catch (err) {
    console.log(`SKIPPED — unreadable: ${err.message}`);
    results.push({ file, cls: cls.name, srcBytes, outBytes: srcBytes, skipped: true });
    continue;
  }

  // Count triangles up front so we know whether this model needs decimating.
  const root = doc.getRoot();
  let tris = 0;
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const idx = prim.getIndices();
      const pos = prim.getAttribute('POSITION');
      tris += Math.floor((idx ? idx.getCount() : pos ? pos.getCount() : 0) / 3);
    }
  }
  const animated = root.listAnimations().length > 0;
  const overBudget = tris > cls.maxTriangles;

  // Only decimate static meshes. Simplifying a skinned mesh can pull vertices away from
  // the joints that drive them, and the damage shows up as a deformed character in
  // motion rather than as an error here -- not worth it for the bytes.
  const needsSimplify = overBudget && !animated;
  const simplifyRatio = needsSimplify ? Math.max(0.05, cls.maxTriangles / tris) : 1;

  const transforms = [
    // Geometry hygiene. flatten+join collapse the node soup Meshy emits into far fewer
    // draw calls; weld+dedup+prune remove duplicate vertices, accessors and unused data.
    flatten(),
    dedup(),
    weld(),
    joinPrims(),

    // Animation keyframes are uncompressed float streams straight out of the exporter.
    // On the mob models this is the single biggest win -- wolf.glb is 964 KB for 1,962
    // triangles and no textures, because 502 KB of it is redundant keyframes.
    resample(),

    // Textures down to the class budget, re-encoded as WebP. This is where the VRAM
    // goes: a 2048px map costs ~22 MB resident, a 256px map costs ~0.35 MB.
    textureCompress({
      encoder: sharp,
      targetFormat: 'webp',
      resize: [cls.maxTexture, cls.maxTexture],
      resizeFilter: 'lanczos3',
    }),

    // Decimate static meshes that blow their triangle budget. heavy crossbow.glb ships
    // 67,726 triangles for something held in a hand at ~30 px on screen.
    ...(needsSimplify
      ? [simplify({ simplifier: MeshoptSimplifier, ratio: simplifyRatio, error: 0.005 })]
      : []),

    // Drop anything the above orphaned, then compress geometry.
    prune(),
    draco({ method: 'edgebreaker' }),
  ];

  try {
    await doc.transform(...transforms);
  } catch (err) {
    console.log(`FAILED — ${err.message}`);
    results.push({ file, cls: cls.name, srcBytes, outBytes: srcBytes, failed: true, err: err.message });
    continue;
  }

  const bytes = await io.writeBinary(doc);
  after += bytes.byteLength;

  if (!dryRun) {
    const { writeFile } = await import('node:fs/promises');
    await writeFile(outPath, bytes);
  }

  const pct = srcBytes ? Math.round((1 - bytes.byteLength / srcBytes) * 100) : 0;
  const note = needsSimplify
    ? `  decimated ${tris.toLocaleString()}->~${cls.maxTriangles.toLocaleString()} tris`
    : overBudget ? `  OVER TRIANGLE BUDGET (${tris.toLocaleString()}) but animated — left alone` : '';
  console.log(`${MB(srcBytes).padStart(7)} MB -> ${MB(bytes.byteLength).padStart(7)} MB  (${String(pct).padStart(3)}% smaller)${note}`);
  results.push({ file, cls: cls.name, srcBytes, outBytes: bytes.byteLength });
}

console.log('\n' + '='.repeat(72));
console.log(`${files.length} models   ${MB(before)} MB -> ${MB(after)} MB   (${Math.round((1 - after / before) * 100)}% smaller)`);
if (dryRun) console.log('DRY RUN — nothing was written.');
console.log('='.repeat(72) + '\n');

const failed = results.filter((r) => r.failed);
if (failed.length) {
  console.log('failed:');
  for (const f of failed) console.log(`  ${f.file}: ${f.err}`);
  process.exitCode = 1;
}
