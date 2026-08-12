// Summarise an operations log.  node tools/oplog_report.mjs <oplog-*.jsonl ...>
//
// The raw JSONL is grep-able but not readable at volume — a busy session is tens
// of thousands of lines. This answers the questions that actually get asked:
//
//   1. Is the Phase 2 gate open? (are divergences quiet, and which fields)
//   2. What is the server refusing, and is any of it wrong?
//   3. Where did a player's items come from?
//
// It reads files given on the command line, or every oplog-*.jsonl in
// server/data if none are given. Tolerates truncated final lines — a log from a
// server that was killed mid-write is exactly when you most want to read it.
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
let files = process.argv.slice(2);
if (!files.length) {
  const dir = join(root, 'server', 'data');
  files = existsSync(dir)
    ? readdirSync(dir).filter(f => /^oplog-.*\.jsonl$/.test(f)).sort().map(f => join(dir, f))
    : [];
}
if (!files.length) {
  console.error('no log files given and none found in server/data/');
  console.error('usage: node tools/oplog_report.mjs [oplog-YYYY-MM-DD.jsonl ...]');
  process.exit(2);
}

const rows = [];
let badLines = 0;
for (const f of files) {
  for (const line of readFileSync(f, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch (e) { badLines++; }
  }
}

const by = (arr, key) => {
  const m = new Map();
  for (const r of arr) { const k = key(r); m.set(k, (m.get(k) || 0) + 1); }
  return [...m.entries()].sort((a, b) => b[1] - a[1]);
};
const pct = (n, d) => d ? (n * 100 / d).toFixed(1) + '%' : '—';
const head = t => console.log(`\n${'═'.repeat(70)}\n${t}\n${'═'.repeat(70)}`);

console.log(`read ${rows.length} events from ${files.length} file(s)` +
            (badLines ? `  (${badLines} unparseable line(s) — truncated write?)` : ''));
if (rows.length) console.log(`window: ${rows[0].ts}  →  ${rows[rows.length - 1].ts}`);

// ── 1. The Phase 2 gate ──
const div = rows.filter(r => r.t === 'divergence');
const saves = rows.filter(r => r.t === 'save' || r.t === 'divergence');
head('PHASE 2 GATE — divergence (docs/SERVER_AUTHORITY.md step 7)');
if (!saves.length) {
  console.log('No saves recorded. The gate cannot be assessed without real play.');
} else {
  console.log(`${div.length} of ${saves.length} saves diverged  (${pct(div.length, saves.length)})`);
  if (!div.length) {
    console.log('\n✅ QUIET. Every save agreed with the server document.');
    console.log('   This is the condition Phase 2 waits for.');
  } else {
    console.log('\n⚠ NOT QUIET. Each field below is a client mutation the server does not');
    console.log('  model. Shipping Phase 2 while these appear is the rework the plan exists');
    console.log('  to avoid — model them as transactions first.\n');
    // Field names carry values ("gold: doc=5 client=9"); group by the name alone.
    const fields = [];
    for (const d of div) for (const f of (d.fields || [])) fields.push(String(f).split(':')[0]);
    for (const [f, n] of by(fields, x => x).slice(0, 25)) console.log(`   ${String(n).padStart(6)}  ${f}`);
    console.log('\n  worst-affected characters:');
    for (const [n, c] of by(div, r => r.name).slice(0, 10)) console.log(`   ${String(c).padStart(6)}  ${n}`);
  }
}

// ── 2. Transactions ──
const txs = rows.filter(r => r.t === 'tx');
const bad = txs.filter(r => r.ok === false);
head('TRANSACTIONS');
console.log(`${txs.length} total, ${bad.length} refused (${pct(bad.length, txs.length)})`);
if (txs.length) {
  console.log('\nby kind:');
  for (const [k, n] of by(txs, r => r.kind)) {
    const f = txs.filter(r => r.kind === k && r.ok === false).length;
    console.log(`   ${String(n).padStart(6)}  ${k.padEnd(10)} ${f ? `${f} refused (${pct(f, n)})` : ''}`);
  }
}
if (bad.length) {
  console.log('\nrefusal reasons — anything here that a player would call a BUG is the');
  console.log('signal to look at; "not enough X" and "already owned" are normal:');
  for (const [r, n] of by(bad, x => x.reason).slice(0, 20)) console.log(`   ${String(n).padStart(6)}  ${r}`);
  const limited = bad.filter(r => /slow down/.test(r.reason || ''));
  if (limited.length) {
    console.log(`\n   ⚠ ${limited.length} hit the rate limit. A legitimate player should never`);
    console.log('     see this — check whether a client loop is spamming intents.');
    for (const [n, c] of by(limited, r => r.name).slice(0, 5)) console.log(`       ${String(c).padStart(5)}  ${n}`);
  }
}

// ── 3. Item flow, per character ──
head('ITEM FLOW (accepted transactions only)');
const flow = new Map();
for (const r of txs) {
  if (r.ok !== true || !r.deltas) continue;
  const acc = flow.get(r.name) || { items: {}, gold: 0, n: 0 };
  for (const k of Object.keys(r.deltas.items || {})) acc.items[k] = (acc.items[k] || 0) + r.deltas.items[k];
  acc.gold += r.deltas.gold || 0;
  acc.n++;
  flow.set(r.name, acc);
}
if (!flow.size) console.log('none');
for (const [name, a] of [...flow.entries()].sort((x, y) => y[1].n - x[1].n).slice(0, 15)) {
  const gains = Object.entries(a.items).filter(([, v]) => v).sort((p, q) => Math.abs(q[1]) - Math.abs(p[1]));
  console.log(`\n  ${name}  (${a.n} transactions, net gold ${a.gold >= 0 ? '+' : ''}${a.gold})`);
  console.log('    ' + (gains.length
    ? gains.slice(0, 14).map(([k, v]) => `${v > 0 ? '+' : ''}${v} ${k}`).join('  ')
    : 'no net item change'));
}

// ── 4. Sessions ──
head('SESSIONS');
const joins = rows.filter(r => r.t === 'join');
console.log(`${joins.length} joins, ${rows.filter(r => r.t === 'leave').length} leaves`);
for (const [n, c] of by(joins, r => r.name).slice(0, 15)) console.log(`   ${String(c).padStart(4)}  ${n}`);

head('NEXT');
if (!saves.length)      console.log('Play the game while connected, then re-run this. Nothing here yet.');
else if (!div.length)   console.log('Divergence is quiet → Phase 2 is unblocked. See docs/SERVER_AUTHORITY.md.');
else                    console.log('Model the divergent fields above as transactions, then re-run this.');
