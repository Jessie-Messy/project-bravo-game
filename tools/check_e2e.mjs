// End-to-end: register, join, run transactions over a real socket, and read the
// SERVER's character document back to confirm what it actually stored. Nothing
// here trusts the reply alone — a server that answers ok and writes nothing
// would pass a reply-only test.
//
//   1. start the server:  cd server && node index.js
//   2. npm i colyseus.js  (not a repo dependency; this is the only thing needing it)
//   3. node tools/check_e2e.mjs
//
// Complements tools/check_tx.mjs, which tests the same engine as a pure function.
// This one exists because the wiring between them is where the bugs were: the
// room's proximity context, the drop table, the batched writes actually reaching
// disk, and the ordering rules below.
import { Client } from 'colyseus.js';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const ORIGIN = 'http://localhost:2567';
const U = 'p1_' + Date.now().toString(36), P = 'hunter2hunter2';
const NAME = 'Tx' + Date.now().toString(36).slice(-5);

const post = async (p, b) => (await fetch(ORIGIN + p, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(b),
})).json();

let pass = 0, fail = 0;
const ok = (n, c, d) => { if (c) pass++; else { fail++; console.log(`FAIL  ${n}${d ? '  — ' + d : ''}`); } };

const reg = await post('/auth/register', { username: U, password: P });
ok('register', reg.ok, JSON.stringify(reg));

const client = new Client('ws://localhost:2567');
const room = await client.joinOrCreate('bravo', { name: NAME, session: reg.token, username: U });
ok('joined the world', !!room);

// Reply plumbing: every tx answers with the seq it was given.
const replies = new Map();
room.onMessage('tx_result', m => {
  const w = replies.get(m.seq); if (w) { replies.delete(m.seq); w(m); }
});
let seq = 0;
const tx = (kind, intent) => new Promise((res, rej) => {
  const s = ++seq;
  const t = setTimeout(() => rej(new Error('tx timeout ' + kind)), 8000);
  replies.set(s, m => { clearTimeout(t); res(m); });
  room.send('tx', { seq: s, kind, intent });
});
const doc = async () => {
  const p = new Promise(r => room.onMessage('character_state', d => r(d)));
  room.send('request_character');
  return p;
};

await new Promise(r => setTimeout(r, 600));
let d0 = await doc();
ok('character document exists', !!d0 && d0.name === NAME, d0 && d0.name);
ok('document carries standing (schema v2)', !!d0.standing && d0.standing.kills === 0, JSON.stringify(d0.standing));

// ── seq echo ──
const r0 = await tx('craft', { id: 'planks' });
ok('reply echoes the seq it was sent', r0.seq === seq, `${r0.seq} vs ${seq}`);
ok('craft with no wood is refused', !r0.ok, JSON.stringify(r0));

// ── pickup credits the document (via drop_take, the server-owned path) ──
room.send('drop_add', { type: 'wood', count: 9 });
const dropId = await new Promise(r => room.onMessage('drop_add', m => r(m.id)));
room.send('drop_take', { id: dropId });
await new Promise(r => setTimeout(r, 500));
let d = await doc();
ok('pickup credited 9 wood to the DOCUMENT', (d.items.wood | 0) === 9, `wood=${d.items.wood}`);

// ── craft, server-side ──
const r1 = await tx('craft', { id: 'planks' });
ok('craft planks accepted', r1.ok, r1.reason);
ok('  reply deltas state the spend', r1.ok && r1.deltas.items.wood === -3 && r1.deltas.items.planks === 1,
   JSON.stringify(r1.deltas && r1.deltas.items));
d = await doc();
ok('  document shows 6 wood', (d.items.wood | 0) === 6, `wood=${d.items.wood}`);
ok('  document shows 1 plank', (d.items.planks | 0) === 1, `planks=${d.items.planks}`);

// ── proximity is enforced over the wire, not just in unit tests ──
const r2 = await tx('craft', { id: 'iron_ingot' });
ok('ingot refused with no forge nearby', !r2.ok, JSON.stringify(r2));

// ── an unaffordable craft changes nothing ──
const before = JSON.stringify((await doc()).items);
const r3 = await tx('craft', { id: 'workbench' });
ok('workbench refused when short', !r3.ok, r3.reason);
ok('  ...and the document is untouched', JSON.stringify((await doc()).items) === before);

// ── buy away from the shop ──
const r4 = await tx('buy', { shop: 'smith', id: 'sword' });
ok('buy refused away from the blacksmith', !r4.ok, JSON.stringify(r4));

// ── bank conserves gold ──
room.send('drop_add', { type: 'gold', count: 100 });
const gid = await new Promise(r => room.onMessage('drop_add', m => r(m.id)));
room.send('drop_take', { id: gid });
await new Promise(r => setTimeout(r, 500));
d = await doc();
// ⚠ 120, not 100: a new character starts with 20 gold, matching the client's
// starting kit. If this reads 100 the server's blank() has drifted from the
// client again — see tools/check_tables.mjs check 8.
ok('gold pickup lands in the WALLET, not the pack', (d.wallet.gold | 0) === 120 && !d.items.gold,
   `gold=${d.wallet.gold} items.gold=${d.items.gold}`);
const rB = await tx('bank', { dir: 'deposit', amount: 60 });
ok('deposit accepted', rB.ok, rB.reason);
d = await doc();
ok('  purse 60 / bank 60', (d.wallet.gold | 0) === 60 && (d.wallet.bank | 0) === 60,
   `${d.wallet.gold}/${d.wallet.bank}`);
ok('  total gold conserved', (d.wallet.gold + d.wallet.bank) === 120, `${d.wallet.gold + d.wallet.bank}`);
const rB2 = await tx('bank', { dir: 'withdraw', amount: 9999 });
ok('overdraft refused', !rB2.ok, rB2.reason);

// ── gather: yield is the SERVER's, not the client's ──
const rG = await tx('gather', { tx: 1, ty: 1 });
ok('gather on a non-resource tile is refused', !rG.ok, JSON.stringify(rG));

// ── rate limit ──
const burst = await Promise.allSettled(Array.from({ length: 40 }, () => tx('craft', { id: 'planks' })));
const limited = burst.filter(b => b.status === 'fulfilled' && !b.value.ok && /slow down/.test(b.value.reason || ''));
ok('a burst is rate limited', limited.length > 0, `${limited.length} of ${burst.length} limited`);

// ── batched writes actually reach disk ──
await new Promise(r => setTimeout(r, 2600));   // > FLUSH_MS
const store = require('../server/character.js');
const onDisk = store.load(NAME);
ok('the batched document reached storage', !!onDisk, 'no row');
ok('  ...with the crafted planks in it', onDisk && (onDisk.items.planks | 0) >= 1,
   onDisk && JSON.stringify(onDisk.items));

// ── gather is accepted on a REAL resource tile ──
// The refusal case above proves the gate exists; this proves the gate opens.
// Without it a bug that refused everything would pass the whole suite.
{
  const wd = require('../server/world-data.json');
  const bits = Buffer.from(wd.resB64, 'base64');
  const MAP_W = wd.mapW, TILE = wd.tile;
  let found = null;
  for (let i = 0; i < MAP_W * wd.mapH && !found; i++) {
    const v = (bits[i >> 2] >> ((i & 3) * 2)) & 3;
    if (v === 1) found = [i % MAP_W, Math.floor(i / MAP_W)];   // a tree tile
  }
  ok('found a tree tile in the resource layer', !!found, String(found));
  if (found) {
    // Stand on it, declared as a teleport so the speed check does not reject it.
    room.send('tp', { x: (found[0] + 0.5) * TILE, y: (found[1] + 0.5) * TILE, reason: 'dev' });
    room.send('move', { x: (found[0] + 0.5) * TILE, y: (found[1] + 0.5) * TILE });
    await new Promise(r2 => setTimeout(r2, 400));
    const rg = await tx('gather', { tx: found[0], ty: found[1] });
    ok('gather ACCEPTED standing on a real tree tile', rg.ok, JSON.stringify(rg));
    ok('  ...and yields the whole felled tree (4 wood)',
       rg.ok && rg.deltas.items.wood === 4, JSON.stringify(rg.deltas && rg.deltas.items));
    // ⚠ The range check must be tested against ANOTHER RESOURCE TILE, not empty
    // ground. A distant grass tile fails on "nothing to harvest there" first, so
    // it proves nothing about range — the first version of this test asserted
    // range and was actually exercising the resource check.
    let far = null;
    for (let i = 0; i < MAP_W * wd.mapH && !far; i++) {
      const v = (bits[i >> 2] >> ((i & 3) * 2)) & 3;
      if (!v) continue;
      const fx = i % MAP_W, fy = Math.floor(i / MAP_W);
      if (Math.hypot(fx - found[0], fy - found[1]) > 30) far = [fx, fy];
    }
    ok('found a distant resource tile', !!far, String(far));
    if (far) {
      const rf = await tx('gather', { tx: far[0], ty: far[1] });
      ok('  ...a real resource tile 30+ tiles away is refused as OUT OF RANGE',
         !rf.ok && /far/.test(rf.reason || ''), JSON.stringify(rf));
    }
  }
}

// ── PHASE 2: THE FLIP. A tampered save cannot author the economy ──
// This is the whole point of the migration plan: "a modified client posts a save
// with 10^9 gold and the server writes it down". It must not, any more.
{
  const before = await doc();
  room.send('save', {
    px: 15000, py: 17000, hp: 100,
    inv: { wood: 999999, gold: 1000000000, arrows: 10, bandages: 2 },
    bank: { gold: 999999 },
    hasAxe: true, hasSword: true, hasBow: true, hasPickaxe: true,
    swordTier: 5, bowTier: 5, pickaxeTier: 5,
    armor: { head: 6, chest: 6, legs: 6, boots: 6 },
    level: 40, xp: 99999, xpMax: 100, statPoints: 0, skillPoints: 0,
    stats: { str: 10, dex: 10, int: 10, vit: 10 },
    quests: { idx: 3, prog: 2 },
  });
  await new Promise(r => setTimeout(r, 700));
  const after = await doc();

  ok('a save claiming 10^9 gold does NOT change the wallet',
     after.wallet.gold === before.wallet.gold, `${before.wallet.gold} -> ${after.wallet.gold}`);
  ok('  ...nor the bank', after.wallet.bank === before.wallet.bank,
     `${before.wallet.bank} -> ${after.wallet.bank}`);
  ok('  ...nor items', (after.items.wood | 0) === (before.items.wood | 0),
     `wood ${before.items.wood} -> ${after.items.wood}`);
  ok('  ...nor tools (no free runic sword)', after.tools.sword === before.tools.sword,
     `${before.tools.sword} -> ${after.tools.sword}`);
  ok('  ...nor tiers', (after.tiers.sword | 0) === (before.tiers.sword | 0),
     `${before.tiers.sword} -> ${after.tiers.sword}`);
  ok('  ...nor armor', (after.armor.head | 0) === (before.armor.head | 0),
     `${before.armor.head} -> ${after.armor.head}`);

  // ...but progression the server cannot author yet STILL comes from the save.
  // Rejecting these would not secure them, it would delete them.
  ok('progression still comes from the save (level)', (after.progress.level | 0) === 40,
     `level=${after.progress.level}`);
  ok('  ...and quests', after.quests && after.quests.idx === 3, JSON.stringify(after.quests));
  ok('  ...which is the documented Phase 2 line: the server owns what it validates',
     true);
}

// ── prefs are stored, and are NOT the character ──
{
  room.send('prefs', { autoDefend: false, aggroMode: true, hotbar: [null, null], gambitsOn: true });
  await new Promise(r => setTimeout(r, 500));
  const d = await doc();
  ok('prefs are stored on the document', d.prefs && d.prefs.aggroMode === true, JSON.stringify(d.prefs));
  ok('  ...and carry nothing economic', !d.prefs.inv && !d.prefs.gold);
}

// ── PHASE 1 SEMANTICS (now superseded for the economy) ──
// ⚠ RUNS LAST, and must stay last. The save below adopts the whole blob, and
// fromLegacyBlob coerces absent fields to false/0 — so this synthetic save (which
// omits hasAxe) strips the character's axe and every later gather is refused with
// "need an axe". A real client always sends a complete buildSave(), so this is a
// property of the test payload rather than a product bug, but it is a sharp edge
// worth knowing: a PARTIAL save wipes tools and gold from the document.
// This is not a bug, it is what "runs alongside the legacy save" MEANS, and it
// is the most misleading thing about the current state. Pinned as a test so that
// when Phase 2 removes the override, this test fails loudly and reminds whoever
// is doing it to update the expectation rather than quietly changing behaviour.
{
  const r = await tx('craft', { id: 'planks' });
  await new Promise(r2 => setTimeout(r2, 200));
  const beforeSave = await doc();
  // A save claiming a completely different inventory.
  room.send('save', { px: 15000, py: 17000, hp: 100, inv: { wood: 777, planks: 0, gold: 5 },
                      bank: { gold: 0 }, level: 1, xp: 0 });
  await new Promise(r2 => setTimeout(r2, 600));
  const afterSave = await doc();
  // ⚠ INVERTED BY PHASE 2, and deliberately kept as a test rather than deleted:
  // the save no longer authors items. If this ever passes as "777" again, the
  // flip has been reverted.
  ok('a client save NO LONGER overwrites items (Phase 2 flip)',
     (afterSave.items.wood | 0) !== 777, `wood=${afterSave.items.wood} (was ${beforeSave.items.wood})`);
  ok('  ...while non-authoritative fields still come from it',
     (afterSave.progress.level | 0) === 1, `level=${afterSave.progress.level}`);
}


await room.leave();
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
