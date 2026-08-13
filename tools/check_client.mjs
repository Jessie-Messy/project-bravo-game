// PHASE 2 on the client: does it honour the server's document, and roll back?
//   node tools/check_client.mjs      (needs playwright + a static server on :5173)
//
// Covers the two client behaviours the flip introduced, both of which CHANGE A
// PLAYER'S PACK and so must not be left to a live server to exercise:
//   • applyAuthoritative — the server's document overwrites local economy state
//   • reconcileTx        — a refused transaction undoes its predicted change
//
// ⚠ Both were originally written inside the net-wiring function, so they only
// existed once a socket was open. The first version of this test called them and
// passed VACUOUSLY against nulls. They are at module scope now for that reason.
import { withGame } from './rig.mjs';
await withGame(async (page, ctx) => {
  page.setDefaultTimeout(180000);
  const r = await page.evaluate(() => {
    const d = window._dev, out = {};


    // Local state claims riches; the server's document says otherwise.
    d.inv.gold = 999999; d.inv.wood = 500; d.player.hasSword = true; d.player.swordTier = 5;
    d.player.armor = { head: 6, chest: 6, legs: 6, boots: 6 };
    d.applyDoc({
      items: { wood: 3, planks: 1 }, wallet: { gold: 42, bank: 7 },
      tools: { axe: true, sword: false, bow: false, pickaxe: false, houseTool: false },
      tiers: { sword: 1, bow: 1, pickaxe: 1 },
      armor: { head: 0, chest: 1, legs: 0, boots: 0 },
    });
    out.gold = d.inv.gold; out.wood = d.inv.wood; out.planks = d.inv.planks;
    out.hasSword = d.player.hasSword; out.swordTier = d.player.swordTier;
    out.armorHead = d.player.armor.head; out.armorChest = d.player.armor.chest;
    out.weapon = d.player.weapon;          // must not still be a sword we don't own

    // An item the document does NOT list must be cleared, not merged.
    out.clearedStone = d.inv.stone;

    // Rollback: a rejected transaction must undo its predicted change.
    d.inv.wood = 10;
    const before = d.inv.wood;
    d.txResult({ seq: 999999, kind: 'craft', ok: false, reason: 'test refusal' });
    out.rollbackNoPending = d.inv.wood === before;   // unknown seq → nothing to undo

    // A REAL pending entry: the client predicted -3 wood +1 plank, the server
    // refused, so both must be undone exactly.
    d.inv.wood = 7; d.inv.planks = 5; d.inv.gold = 100;
    d.txPending().set(4242, { kind:'craft', intent:{id:'planks'},
                              predicted:{ items:{ wood:-3, planks:1 } }, at: Date.now() });
    d.txResult({ seq: 4242, kind:'craft', ok:false, reason:'not enough wood' });
    out.rolledWood = d.inv.wood;      // 7 - (-3) = 10
    out.rolledPlanks = d.inv.planks;  // 5 - 1 = 4
    out.pendingCleared = !d.txPending().has(4242);

    // A gold-only prediction (buy) must roll the wallet back too.
    d.txPending().set(4243, { kind:'buy', intent:{shop:'smith',id:'sword'},
                              predicted:{ gold:-30 }, at: Date.now() });
    d.txResult({ seq: 4243, kind:'buy', ok:false, reason:'not at the blacksmith' });
    out.rolledGold = d.inv.gold;      // 100 - (-30) = 130

    // An ACCEPTED result must change nothing and still clear the entry.
    d.inv.wood = 9;
    d.txPending().set(4244, { kind:'craft', predicted:{ items:{ wood:-3 } }, at: Date.now() });
    d.txResult({ seq: 4244, kind:'craft', ok:true, deltas:{ items:{ wood:-3 } } });
    out.acceptedLeavesWood = d.inv.wood;   // still 9
    out.acceptedCleared = !d.txPending().has(4244);
    return out;
  });
  const errs = ctx.errors.filter(e => !/glb|matchmake|colyseus/.test(e));
  const expect = {
    gold: 42, wood: 3, planks: 1, hasSword: false, swordTier: 1,
    armorHead: 0, armorChest: 1, clearedStone: 0,
    rolledWood: 10, rolledPlanks: 4, pendingCleared: true, rolledGold: 130,
    acceptedLeavesWood: 9, acceptedCleared: true,
  };
  let fail = 0;
  for (const [k, v] of Object.entries(expect))
    if (r[k] !== v) { fail++; console.log(`FAIL  ${k}: expected ${v}, got ${r[k]}`); }
  if (errs.length) { fail++; console.log('FAIL  page errors: ' + errs.slice(0, 4).join(' ~ ')); }
  console.log(fail ? `\n${fail} failed` : `\n${Object.keys(expect).length} passed, 0 failed`);
  process.exit(fail ? 1 : 0);
}, {});
