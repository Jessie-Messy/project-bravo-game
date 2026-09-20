// tools/inspect.mjs — report what is actually inside every GLB.
//
// Read-only. Run it before and after `bake` to see what changed, and to justify the
// numbers in assets/budgets.json rather than guessing at them.
//
//   node tools/inspect.mjs            # table for models/
//   node tools/inspect.mjs models_src # or any other directory

import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { classify } from './lib/classify.mjs';
import { getIO } from './lib/io.mjs';

const dir = process.argv[2] ?? 'models';
const io = await getIO();

const MB = (b) => (b / 1048576).toFixed(2);

const files = (await readdir(dir)).filter((f) => f.toLowerCase().endsWith('.glb')).sort();
if (!files.length) {
  console.error(`no .glb files in ${dir}/`);
  process.exit(1);
}

const rows = [];
let totalBytes = 0;

for (const file of files) {
  const path = join(dir, file);
  const bytes = (await stat(path)).size;
  totalBytes += bytes;

  let doc;
  try {
    doc = await io.read(path);
  } catch (err) {
    rows.push({ file, cls: '?', bytes, tris: 0, tex: 0, maxTex: 0, texBytes: 0, anims: 0, err: err.message });
    continue;
  }
  const root = doc.getRoot();

  // Triangles: sum over every primitive, using indices where present.
  let tris = 0;
  for (const mesh of root.listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      const idx = prim.getIndices();
      const pos = prim.getAttribute('POSITION');
      const count = idx ? idx.getCount() : pos ? pos.getCount() : 0;
      tris += Math.floor(count / 3);
    }
  }

  // Textures: count, largest edge, and total embedded bytes.
  let maxTex = 0;
  let texBytes = 0;
  const textures = root.listTextures();
  for (const tex of textures) {
    const img = tex.getImage();
    if (img) texBytes += img.byteLength;
    const size = tex.getSize();          // [w, h] or null if undecodable
    if (size) maxTex = Math.max(maxTex, size[0], size[1]);
  }

  rows.push({
    file,
    cls: classify(file).name,
    bytes,
    tris,
    tex: textures.length,
    maxTex,
    texBytes,
    anims: root.listAnimations().length,
  });
}

rows.sort((a, b) => b.bytes - a.bytes);

const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);

console.log();
console.log(
  pad('MODEL', 32), lpad('MB', 7), lpad('TRIS', 8), lpad('TEX', 4),
  lpad('MAX', 6), lpad('TEX MB', 8), lpad('ANIM', 5), ' CLASS',
);
console.log('-'.repeat(96));
for (const r of rows) {
  console.log(
    pad(r.file.slice(0, 32), 32),
    lpad(MB(r.bytes), 7),
    lpad(r.tris.toLocaleString(), 8),
    lpad(r.tex, 4),
    lpad(r.maxTex || '-', 6),
    lpad(MB(r.texBytes), 8),
    lpad(r.anims, 5),
    ' ' + r.cls,
    r.err ? ` !! ${r.err}` : '',
  );
}
console.log('-'.repeat(96));

const texTotal = rows.reduce((s, r) => s + r.texBytes, 0);
console.log(`${rows.length} models · ${MB(totalBytes)} MB total · ${MB(texTotal)} MB of it texture data`);

// Resident VRAM estimate: every texture is decoded to RGBA and mipmapped (+1/3).
const vram = rows.reduce((sum, r) => sum + (r.maxTex ? r.tex * r.maxTex * r.maxTex * 4 * 1.333 : 0), 0);
console.log(`rough resident GPU texture memory if all loaded at once: ~${MB(vram)} MB`);
console.log();
