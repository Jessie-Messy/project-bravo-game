// tools/verify.mjs — the gate. Fails the build if any shipped model breaks its budget.
//
//   node tools/verify.mjs          # check models/
//   node tools/verify.mjs --json   # machine-readable, for CI annotations
//
// This is the part that matters long-term. Baking the assets once is easy; the reason
// 19 of 39 models were unoptimised is that nothing ever *checked*. A gate turns "we
// should compress that" into a build failure, so the next twenty assets cannot quietly
// undo this work.
//
// Exit codes:  0 = within budget   1 = over budget   2 = could not run

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { classify, budgets } from './lib/classify.mjs';
import { getIO } from './lib/io.mjs';

const DIR = process.argv.find((a) => !a.startsWith('--') && a.endsWith('models')) ?? 'models';
const asJson = process.argv.includes('--json');

const KB = (b) => `${(b / 1024).toFixed(0)} KB`;
const MB = (b) => `${(b / 1048576).toFixed(2)} MB`;

let io;
try {
  io = await getIO();
} catch (err) {
  console.error(`verify: cannot initialise glTF reader — ${err.message}`);
  process.exit(2);
}

let files;
try {
  files = (await readdir(DIR)).filter((f) => f.toLowerCase().endsWith('.glb')).sort();
} catch (err) {
  console.error(`verify: cannot read ${DIR}/ — ${err.message}`);
  process.exit(2);
}

const violations = [];
const rows = [];
let totalBytes = 0;

for (const file of files) {
  const path = join(DIR, file);
  const cls = classify(file);
  const bytes = (await stat(path)).size;
  totalBytes += bytes;

  let root;
  try {
    root = (await io.read(path)).getRoot();
  } catch (err) {
    violations.push({ file, rule: 'readable', detail: err.message });
    continue;
  }

  let tris = 0;
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const idx = prim.getIndices();
      const pos = prim.getAttribute('POSITION');
      tris += Math.floor((idx ? idx.getCount() : pos ? pos.getCount() : 0) / 3);
    }
  }

  let maxTex = 0;
  for (const tex of root.listTextures()) {
    const size = tex.getSize();
    if (size) maxTex = Math.max(maxTex, size[0], size[1]);
  }

  if (bytes > cls.maxBytes) {
    violations.push({ file, rule: 'maxBytes', detail: `${KB(bytes)} > ${KB(cls.maxBytes)} for class "${cls.name}"` });
  }
  if (tris > cls.maxTriangles) {
    violations.push({ file, rule: 'maxTriangles', detail: `${tris.toLocaleString()} > ${cls.maxTriangles.toLocaleString()} for class "${cls.name}"` });
  }
  if (maxTex > cls.maxTexture) {
    violations.push({ file, rule: 'maxTexture', detail: `${maxTex}px > ${cls.maxTexture}px for class "${cls.name}"` });
  }

  rows.push({ file, cls: cls.name, bytes, tris, maxTex });
}

if (totalBytes > budgets.totals.maxTotalBytes) {
  violations.push({ file: '(total)', rule: 'maxTotalBytes', detail: `${MB(totalBytes)} > ${MB(budgets.totals.maxTotalBytes)}` });
}
if (files.length > budgets.totals.maxModelCount) {
  violations.push({ file: '(total)', rule: 'maxModelCount', detail: `${files.length} > ${budgets.totals.maxModelCount}` });
}

if (asJson) {
  console.log(JSON.stringify({ ok: violations.length === 0, totalBytes, count: files.length, violations, rows }, null, 2));
} else {
  console.log();
  console.log(`verify: ${files.length} models in ${DIR}/ — ${MB(totalBytes)} of ${MB(budgets.totals.maxTotalBytes)} budget`);
  if (violations.length) {
    console.log(`\n${violations.length} budget violation(s):\n`);
    for (const v of violations) console.log(`  ${v.file.padEnd(32)} ${v.rule.padEnd(14)} ${v.detail}`);
    console.log('\nFix by re-running `npm run bake`, or adjust assets/budgets.json if the');
    console.log('budget itself is wrong for this asset class. Do not ship over budget.\n');
  } else {
    console.log('all models within budget.\n');
  }
}

process.exit(violations.length ? 1 : 0);
