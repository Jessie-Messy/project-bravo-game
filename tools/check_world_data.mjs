// Is server/world-data.json stale?   node tools/check_world_data.mjs
//
// ── Why ─────────────────────────────────────────────────────────────────────
// The server's picture of the world is a BUILD ARTEFACT, generated from the
// client's map modules plus world_edits.json. Edit the world and forget to
// regenerate, and the two silently disagree:
//
//   • the resource layer says "grass" where the client draws a tree, so every
//     chop there is refused with "nothing to harvest there"
//   • the walkability bitmap sends mobs walking into walls, or stops them dead
//     in open ground
//   • portals and spawns point at the old map
//
// None of that raises an error. /health reports `resourceLayer: true` because
// the layer EXISTS — it cannot tell you it is describing a different world.
//
// This rebuilds in memory from the same buildWorldData() the deploy script uses
// and compares. Reusing that function rather than reimplementing the packing is
// the point: a checker with its own copy of the logic drifts, and then it passes
// on a file that is wrong.
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWorldData } from '../server/build-world-data.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const file = join(root, 'server', 'world-data.json');

if (!existsSync(file)) {
  console.error('server/world-data.json is MISSING.\n' +
    'The server runs with mob AI disabled and refuses every gather.\n' +
    'Fix: node server/build-world-data.mjs');
  process.exit(1);
}

const onDisk = JSON.parse(readFileSync(file, 'utf8'));
const { out: fresh } = await buildWorldData({ quiet: true });

const problems = [];
const cmpScalar = k => {
  if (JSON.stringify(onDisk[k]) !== JSON.stringify(fresh[k]))
    problems.push(`${k}: file has ${JSON.stringify(onDisk[k])}, the world says ${JSON.stringify(fresh[k])}`);
};
['mapW', 'mapH', 'tile'].forEach(cmpScalar);

// Bitmaps: report HOW MANY tiles differ, not just that they do. "3 tiles moved"
// and "the whole map shifted" need very different responses, and the count is
// the fastest way to tell them apart.
const bitCounts = (a, b, bitsPerTile) => {
  if (a === b) return 0;
  const A = Buffer.from(a || '', 'base64'), B = Buffer.from(b || '', 'base64');
  const n = Math.max(A.length, B.length);
  let diff = 0;
  const per = 8 / bitsPerTile;
  for (let i = 0; i < n; i++) {
    const x = (A[i] || 0) ^ (B[i] || 0);
    if (!x) continue;
    for (let s = 0; s < per; s++) if ((x >> (s * bitsPerTile)) & ((1 << bitsPerTile) - 1)) diff++;
  }
  return diff;
};

const walkDiff = bitCounts(onDisk.walkB64, fresh.walkB64, 1);
if (walkDiff) problems.push(`walkability differs on ${walkDiff} tile(s) — mobs will path against the old map`);

if (!onDisk.resB64) {
  problems.push('NO RESOURCE LAYER at all — this file predates the gather transaction, ' +
                'so every gather is refused. Regenerate.');
} else {
  const resDiff = bitCounts(onDisk.resB64, fresh.resB64, 2);
  if (resDiff) problems.push(`resource layer differs on ${resDiff} tile(s) — players will chop trees ` +
                             `the server does not believe are there ("nothing to harvest there")`);
}

for (const k of ['portals', 'wolfSpawns', 'banditSpawns', 'healers']) {
  const a = JSON.stringify(onDisk[k] || []), b = JSON.stringify(fresh[k] || []);
  if (a !== b) problems.push(`${k} differs (${(onDisk[k] || []).length} on file vs ${(fresh[k] || []).length} fresh)`);
}
if (JSON.stringify(onDisk.city) !== JSON.stringify(fresh.city))
  problems.push('city bounds differ — the safe zone is in the wrong place');

if (problems.length) {
  console.error('server/world-data.json is STALE\n');
  for (const p of problems) console.error('  ✖ ' + p);
  console.error('\nFix: node server/build-world-data.mjs   (then commit the result)');
  console.error('This never raises an error at runtime — the server just quietly');
  console.error('disagrees with every client about where the world is.');
  process.exit(1);
}
console.log(`server/world-data.json is current — ${fresh.mapW}x${fresh.mapH}, ` +
            `${(fresh.portals || []).length} portals, resource layer present`);
