// What will the divergence log say?   node tools/check_coverage.mjs
//
// ── Why this exists ─────────────────────────────────────────────────────────
// Phase 2 is gated on the divergence log going quiet (docs/SERVER_AUTHORITY.md
// step 7), and that log only fills up during real play. But most of what it will
// say is already knowable: it is the difference between what the client SAVES
// (buildSave) and what the character document MODELS (fromLegacyBlob).
//
// A field the client saves and the document never reads is state the server does
// not own. Every one is either:
//   • deliberately client-side (UI prefs, hotbar layout) — fine, and Phase 2's
//     `prefs` payload is where it belongs, or
//   • unmodelled character state — which is Phase 2 rework if it ships unnoticed.
//
// Running this before the first play session turns "wait and see" into a list.
// It does NOT replace watching the real log: it cannot see mutations that never
// reach a save field, and it cannot tell you which ones actually change in play.
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(root, p), 'utf8');

// ── what the client saves ──
const g = read('js/game3d.js');
const bs = g.slice(g.indexOf('function buildSave(){'));
// ⚠ Slice from the `return {`, not from the function header. Counting braces from
// the header puts the object's own keys at depth 2, and the first version of this
// looked for depth 1 and confidently reported "0 fields saved" — a parser that
// finds nothing looks exactly like a codebase with nothing to find.
const objStart = bs.indexOf('return {') + 'return '.length;
const body = bs.slice(objStart, bs.indexOf('\n}'));
// top-level keys only: `key:` at a position not nested inside a brace we opened
const saved = new Set();
{
  let depth = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '{' || c === '[') depth++;
    else if (c === '}' || c === ']') depth--;
    else if (depth === 1) {
      const m = /^([A-Za-z_$][\w$]*)\s*:/.exec(body.slice(i));
      // ⚠ Skip `undefined` — it is the ternary in
      // `placedHouses: net.status==='online' ? undefined : G.placedHouses`,
      // not a saved field, and it showed up in the worklist as a phantom gap.
      if (m && m[1] !== 'undefined' && !/[\w$.]/.test(body[i - 1] || '')) {
        saved.add(m[1]); i += m[0].length - 1;
      }
    }
  }
}

// ── what the document reads ──
const ch = read('server/character.js');
const fb = ch.slice(ch.indexOf('function fromLegacyBlob('));
const fbBody = fb.slice(0, fb.indexOf('\nfunction ', 1));
const modelled = new Set([...fbBody.matchAll(/blob\.([A-Za-z_$][\w$]*)/g)].map(m => m[1]));

// ── fields that are deliberately client-side ──
// Presentation and preferences. Phase 2 moves these to a `prefs` payload rather
// than into the character document — the plan is explicit that the document must
// not become a mirror of every ad-hoc field on player{} and G{}.
const CLIENT_SIDE = new Set([
  'autoDefend', 'aggroMode', 'gambits', 'gambitsOn', 'hotbar', 'macros',
  'dollGender', 'gender', 'race', 'name', 'weapon',
]);
// Shared world state the SERVER already owns through other messages, so the save
// copy is redundant rather than unmodelled.
const SERVER_OWNED_ELSEWHERE = new Set([
  'placedObjects',   // object_place / object_remove
  'placedHouses',    // house_place / house_update / house_remove (undefined when online)
]);

const gaps = [], prefs = [], elsewhere = [];
for (const k of [...saved].sort()) {
  if (modelled.has(k)) continue;
  if (CLIENT_SIDE.has(k)) prefs.push(k);
  else if (SERVER_OWNED_ELSEWHERE.has(k)) elsewhere.push(k);
  else gaps.push(k);
}

const line = '─'.repeat(70);
console.log(`${line}\nSAVE COVERAGE — what the divergence log will show\n${line}`);
console.log(`client saves ${saved.size} top-level fields; the document models ${modelled.size}\n`);

console.log(`UNMODELLED CHARACTER STATE (${gaps.length}) — the Phase 2 worklist:`);
if (!gaps.length) console.log('  none — everything the client saves is either modelled or deliberately client-side');
for (const k of gaps) console.log('  ✖ ' + k);

console.log(`\nDELIBERATELY CLIENT-SIDE (${prefs.length}) — Phase 2 moves these to \`prefs\`:`);
console.log('  ' + (prefs.join(', ') || 'none'));

console.log(`\nOWNED BY THE SERVER ELSEWHERE (${elsewhere.length}) — redundant in the save:`);
console.log('  ' + (elsewhere.join(', ') || 'none'));

// The diff() function is what actually WRITES divergence lines, and it covers
// far less than fromLegacyBlob reads. Anything modelled but not compared is a
// field that can drift without ever appearing in the log — a silent gap in the
// very signal Phase 2 is gated on.
const df = ch.slice(ch.indexOf('function diff('));
const dfBody = df.slice(0, df.lastIndexOf('\n}'));
// ⚠ Count BOTH `blob.foo` and quoted 'foo' — diff() compares the tool flags and
// tiers through a lookup table (`blob[toolBlobKey[t]]`), which no amount of
// regexing `blob.` will ever see. Without this the report listed eight fields as
// uncompared that are compared on the very next line, and a report that is wrong
// about its own subject gets ignored.
const compared = new Set([
  ...[...dfBody.matchAll(/blob\.([A-Za-z_$][\w$]*)/g)].map(m => m[1]),
  ...[...dfBody.matchAll(/'([A-Za-z_$][\w$]*)'/g)].map(m => m[1]),
]);
// Deliberately never compared: the client changes both continuously and the
// document models neither, so comparing them would report a divergence on
// essentially every save and bury the real findings. Position is validated on
// the `move` message instead.
const EXCLUDED = new Map([
  ['px', 'movement — validated on the `move` message, not here'],
  ['py', 'movement — validated on the `move` message, not here'],
]);
const uncompared = [...modelled].filter(k => !compared.has(k) && !EXCLUDED.has(k)).sort();
console.log(`\n${line}\nMODELLED BUT NOT COMPARED (${uncompared.length})\n${line}`);
console.log('These ARE in the document but diff() never checks them, so they can drift');
console.log('without ever appearing in the divergence log. The log is the Phase 2 gate,');
console.log('so a quiet log does not prove these agree:\n');
console.log('  ' + (uncompared.join(', ') || 'none'));
console.log('\nexcluded on purpose:');
for (const [k, why] of EXCLUDED) console.log(`  · ${k} — ${why}`);

console.log(`\n${line}`);
console.log('This is static analysis and does NOT replace watching the real log.');
console.log('It cannot see mutations that never reach a save field, and it cannot');
console.log('tell you which of these actually change during play.');
// Informational: never fails a build. The gaps are a worklist, not a defect.
