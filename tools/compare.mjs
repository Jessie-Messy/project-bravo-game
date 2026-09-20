// tools/compare.mjs — integrity check: does the baked model still contain what the
// original did? Size reduction is worthless if the bake silently dropped an animation
// clip or a skin, and that is exactly the kind of damage that only shows up in-game.
//
//   node tools/compare.mjs
//
// Exits non-zero if any model lost animations, skins, meshes, or more than a small
// fraction of its triangles.

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { getIO } from './lib/io.mjs';
import { classify } from './lib/classify.mjs';

const SRC = 'models_src';
const OUT = 'models';
const TRI_TOLERANCE = 0.02; // geometry should be preserved; weld/join may shift it slightly

const io = await getIO();
const MB = (b) => (b / 1048576).toFixed(2);

async function summarise(path) {
  const doc = await io.read(path);
  const root = doc.getRoot();
  let tris = 0;
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const idx = prim.getIndices();
      const pos = prim.getAttribute('POSITION');
      const count = idx ? idx.getCount() : pos ? pos.getCount() : 0;
      tris += Math.floor(count / 3);
    }
  }
  // Channels matter more than clip count: a clip that kept its name but lost its
  // channels animates nothing.
  const channels = root.listAnimations().reduce((n, a) => n + a.listChannels().length, 0);

  // Skin COUNT is not a health signal -- dedup legitimately merges identical skins
  // (slime.glb ships three identical 7-joint skins, one per mesh part, and correctly
  // comes out with one shared between all three). What actually breaks rendering is a
  // mesh with joint weights whose node has no skin attached, so measure that instead.
  const nodes = root.listNodes();
  const orphanedSkinnedMeshes = nodes.filter(
    (n) => n.getMesh()
      && n.getMesh().listPrimitives().some((p) => p.getAttribute('JOINTS_0'))
      && !n.getSkin(),
  ).length;

  return {
    bytes: (await stat(path)).size,
    tris,
    meshes: root.listMeshes().length,
    anims: root.listAnimations().length,
    channels,
    skinnedNodes: nodes.filter((n) => n.getSkin()).length,
    orphanedSkinnedMeshes,
    textures: root.listTextures().length,
  };
}

const files = (await readdir(SRC)).filter((f) => f.toLowerCase().endsWith('.glb')).sort();
const problems = [];
let beforeTotal = 0;
let afterTotal = 0;

console.log();
console.log('MODEL'.padEnd(32), 'ANIM'.padStart(9), 'CHANNELS'.padStart(11), 'SKINNED'.padStart(9), 'TRIS'.padStart(15), '  VERDICT');
console.log('-'.repeat(100));

for (const file of files) {
  let a, b;
  try {
    a = await summarise(join(SRC, file));
    b = await summarise(join(OUT, file));
  } catch (err) {
    problems.push(`${file}: unreadable after bake — ${err.message}`);
    console.log(file.padEnd(32), ' '.repeat(40), '  UNREADABLE');
    continue;
  }
  beforeTotal += a.bytes;
  afterTotal += b.bytes;

  const issues = [];
  if (b.anims < a.anims) issues.push(`lost ${a.anims - b.anims} animation(s)`);
  if (b.channels < a.channels) issues.push(`lost ${a.channels - b.channels} channel(s)`);
  if (b.skinnedNodes < a.skinnedNodes) issues.push(`${a.skinnedNodes - b.skinnedNodes} node(s) lost their skin`);
  if (b.orphanedSkinnedMeshes > 0) issues.push(`${b.orphanedSkinnedMeshes} skinned mesh(es) have no skin — would render broken`);
  if (b.meshes < a.meshes) issues.push(`lost ${a.meshes - b.meshes} mesh(es)`);
  // A model over its triangle budget is decimated on purpose, so allow a reduction
  // down to that budget. Anything below it is unexplained loss.
  const budget = classify(file).maxTriangles;
  const floor = a.tris > budget ? budget * 0.9 : a.tris * (1 - TRI_TOLERANCE);
  if (a.tris && b.tris < floor) {
    issues.push(`triangles ${a.tris.toLocaleString()} -> ${b.tris.toLocaleString()} (below floor ${Math.round(floor).toLocaleString()})`);
  }
  if (b.textures === 0 && a.textures > 0) issues.push('lost all textures');

  const verdict = issues.length ? 'FAIL: ' + issues.join('; ') : 'ok';
  if (issues.length) problems.push(`${file}: ${issues.join('; ')}`);

  console.log(
    file.slice(0, 32).padEnd(32),
    `${a.anims}->${b.anims}`.padStart(9),
    `${a.channels}->${b.channels}`.padStart(11),
    `${a.skinnedNodes}->${b.skinnedNodes}`.padStart(9),
    `${a.tris.toLocaleString()}->${b.tris.toLocaleString()}`.padStart(15),
    '  ' + verdict,
  );
}

console.log('-'.repeat(100));
console.log(`${files.length} models   ${MB(beforeTotal)} MB -> ${MB(afterTotal)} MB`);

if (problems.length) {
  console.log(`\n${problems.length} model(s) lost content in the bake:`);
  for (const p of problems) console.log('  ' + p);
  process.exit(1);
}
console.log('\nintegrity ok — every model kept its animations, channels, skins, meshes and geometry.\n');
