// oplog.js — the operations log. Append-only JSONL, one line per event.
//
// ── Why this exists ─────────────────────────────────────────────────────────
// Phase 1 ships a lot of server-side decision-making that nobody has played
// against yet, and the gate on Phase 2 (docs/SERVER_AUTHORITY.md step 7) is
// "watch the divergence log until it is quiet" — which is only possible if the
// log SURVIVES. Console output does not: pm2 rotates it, it interleaves with
// mob-AI chatter, and by the time a player says "my planks vanished" the lines
// that would explain it are gone.
//
// So every state-changing decision the server makes is written here as one JSON
// object per line, and the file is what gets read after a play session. It is
// designed to be handed to someone else verbatim.
//
// ── Reading it ──────────────────────────────────────────────────────────────
//   cd /home/ubuntu/bravo-server/data
//   grep '"t":"divergence"' oplog-*.jsonl | tail -50      # what Phase 2 blocks on
//   grep '"ok":false'       oplog-*.jsonl | tail -50      # refused transactions
//   grep '"name":"Gideon"'  oplog-*.jsonl                 # one player's whole session
//   node ../tools/oplog_report.mjs oplog-2026-08-12.jsonl # summary
//
// ── Deliberate limits ───────────────────────────────────────────────────────
// • Writes are appended SYNCHRONOUSLY, same as every other write in this server
//   (better-sqlite3 is synchronous too). Logging is best-effort and must never
//   throw into a transaction: a failed log line must not fail a player's craft.
// • Rotated by DAY and capped by size. An unbounded log on a small VPS fills the
//   disk, and a full disk takes the whole game down — a worse outcome than
//   losing old log lines.
// • Never logs passwords, tokens or session ids. Player NAMES are logged because
//   without them the log cannot answer "what happened to this character", which
//   is the question it exists for.
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, 'data');
const MAX_BYTES = 32 * 1024 * 1024;   // per-day cap
const KEEP_DAYS = 14;

let stream = null, streamDay = null, written = 0, dropped = 0, disabled = false;

function today() { return new Date().toISOString().slice(0, 10); }
function fileFor(day) { return path.join(DIR, `oplog-${day}.jsonl`); }

function prune() {
  try {
    const cutoff = Date.now() - KEEP_DAYS * 86400000;
    for (const f of fs.readdirSync(DIR)) {
      if (!/^oplog-\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)) continue;
      const st = fs.statSync(path.join(DIR, f));
      if (st.mtimeMs < cutoff) fs.unlinkSync(path.join(DIR, f));
    }
  } catch (e) { /* pruning is housekeeping; never let it break logging */ }
}

function ensureStream() {
  const day = today();
  if (stream && streamDay === day) return stream;
  if (stream) { try { stream.end(); } catch (e) {} stream = null; }
  try {
    fs.mkdirSync(DIR, { recursive: true });
    streamDay = day;
    written = 0;
    try { written = fs.statSync(fileFor(day)).size; } catch (e) {}
    stream = fs.createWriteStream(fileFor(day), { flags: 'a' });
    stream.on('error', e => {
      // ⚠ An unhandled 'error' on a write stream is an uncaught exception, which
      // would take the whole world server down because a log file could not be
      // written. Disable logging instead — the game keeps running.
      if (!disabled) console.error('[oplog] DISABLED after write error:', e.message);
      disabled = true; stream = null;
    });
    prune();
  } catch (e) {
    if (!disabled) console.error('[oplog] cannot open log file, logging disabled:', e.message);
    disabled = true;
  }
  return stream;
}

// Trim anything unbounded before it reaches the file. A client controls parts of
// these payloads, so an intent could otherwise write megabytes per line.
function clip(v, depth = 0) {
  if (v === null || v === undefined) return v;
  if (typeof v === 'string') return v.length > 200 ? v.slice(0, 200) + '…' : v;
  if (typeof v === 'number' || typeof v === 'boolean') return v;
  if (depth >= 3) return '…';
  if (Array.isArray(v)) return v.slice(0, 20).map(x => clip(x, depth + 1));
  if (typeof v === 'object') {
    const out = {};
    for (const k of Object.keys(v).slice(0, 30)) out[k] = clip(v[k], depth + 1);
    return out;
  }
  return String(v).slice(0, 200);
}

const counters = Object.create(null);

/**
 * Record one event. `t` is the event type — grep-able, so keep the set small
 * and stable. Never throws.
 */
function write(t, fields) {
  counters[t] = (counters[t] || 0) + 1;
  if (disabled) return;
  const s = ensureStream();
  if (!s) return;
  if (written > MAX_BYTES) {
    if (dropped++ === 0) console.error(`[oplog] ${fileFor(streamDay)} hit ${MAX_BYTES} bytes — dropping further lines today`);
    return;
  }
  try {
    const line = JSON.stringify(Object.assign({ ts: new Date().toISOString(), t }, clip(fields || {}))) + '\n';
    written += line.length;
    s.write(line);
  } catch (e) { /* best effort, always */ }
}

// Counters for /health, so a single curl says whether anything is going wrong
// without SSHing in and reading files.
function stats() {
  return { file: streamDay ? path.basename(fileFor(streamDay)) : null,
           bytes: written, dropped, disabled, events: Object.assign({}, counters) };
}

function close() { try { if (stream) stream.end(); } catch (e) {} stream = null; }

module.exports = { write, stats, close, DIR };
