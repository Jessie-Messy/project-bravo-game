// Guards the four playtest fixes from the pre-beta test round, plus the two
// regressions the fixes themselves introduced.
//   node tools/check_playtest.mjs      (needs playwright + a static server on 5173)
//
//   1. a new character spawns inside the city, not in open grassland
//   2. the first tutorial panel does not overlap the hotbar
//   3. the city is lit by civic street lamps for a night arrival, and those
//      lamps survive every path that replaces placedObjects, stay out of the
//      save blob, and cannot be picked up
//   4. campfire/forge emit light AT DUSK, not only at midnight
//
// Assertions are matched to positions rather than counted globally: the player
// stands in a city with sixteen lamps, so "some light is bright" is satisfied by
// the street lighting and proves nothing about the campfire under test.
import { withGame } from './rig.mjs';

let pass = 0, fail = 0;
const ok = (name, cond, detail = '') => {
  if (cond) { pass++; console.log(`  ok   ${name}${detail ? ' — ' + detail : ''}`); }
  else { fail++; console.log(`  FAIL ${name}${detail ? ' — ' + detail : ''}`); }
};

await withGame(async (page, { ready, errors }) => {
  if (!ready) { console.log('game never booted'); process.exit(1); }

  // ── 3. civic lanterns, seeded at boot ──
  const lanterns = await page.evaluate(() =>
    window._dev.placedObjects.filter(o => o.civic && o.type === 'lantern').length);
  ok('city seeded with civic lanterns', lanterns >= 12, `${lanterns} lanterns`);

  // ── 1. city spawn, on the REAL new-character path ──
  // The rig boots straight past the character creator, so reading player.x at
  // boot proves nothing about where a new hero starts. Drive the actual reset.
  const spawn = await page.evaluate(() => {
    const d = window._dev, TILE = 48;
    d.player.x = 240 * TILE; d.player.y = 300 * TILE;   // the old world default
    d.resetForNewCharacter();
    return { tx: Math.floor(d.player.x / TILE), ty: Math.floor(d.player.y / TILE) };
  });
  // The city block sits around tile 310,362. Anything within ~30 tiles is inside it.
  const dTiles = Math.hypot(spawn.tx - 310, spawn.ty - 362);
  ok('a new character spawns in the city', dTiles < 30,
     `tile ${spawn.tx},${spawn.ty} · ${dTiles.toFixed(1)} tiles from centre`);

  // Each civic lantern rides a post, and its light must ride up with it — a
  // street lamp glowing at ankle height is the bug this replaced.
  const posts = await page.evaluate(async () => {
    const d = window._dev;
    d.setHour(1);
    d.markPlacedDirty();
    await new Promise(r => setTimeout(r, 900));
    const lp = d.lightProbe();
    const lamp = d.placedObjects.find(o => o.civic);
    const mine = lp.lights.filter(l => Math.hypot(l.x - lamp.x, l.y - lamp.y) < 48);
    return { posts: d.lampPostCount ? d.lampPostCount() : -1,
             lanterns: d.placedObjects.filter(o => o.civic).length,
             headH: mine.length ? Math.max(...mine.map(l => l.h)) : 0 };
  });
  ok('every civic lantern gets a post', posts.posts === posts.lanterns,
     `${posts.posts} posts for ${posts.lanterns} lanterns`);
  ok('street lamp light sits up the post', posts.headH >= 120, `light height ${posts.headH}`);

  // A lamp buried in a building is invisible AND spends a light slot.
  const buried = await page.evaluate(() =>
    window._dev.placedObjects.filter(o => o.civic && window._dev.blocked(o.x, o.y, 10))
      .map(o => `${Math.floor(o.x / 48)},${Math.floor(o.y / 48)}`));
  ok('no lamp is buried in a wall', buried.length === 0, buried.join(' '));

  // ── 3b. the lanterns must SURVIVE every path that replaces the list ──
  // placedObjects is wiped wholesale by three different paths. Seeding once at
  // boot lasts only until the first of them runs — online, a couple of seconds.
  const survive = await page.evaluate(() => {
    const d = window._dev;
    const count = () => d.placedObjects.filter(o => o.civic).length;
    const out = { afterReset: count() };                 // reset ran just above
    // The server's authoritative broadcast: replaces the list with its own rows.
    out.applied = d.applyServerPlaced([{ id: 'srv1', type: 'torch', x: 100, y: 100 }]);
    out.afterBroadcast = count();
    out.keptServerRow = d.placedObjects.some(o => o.id === 'srv1');
    // And the save blob must not carry them (or it bakes today's layout in).
    out.inSave = (d.buildSave().placedObjects || []).filter(o => o.civic).length;
    return out;
  });
  ok('lanterns survive a new character', survive.afterReset >= 12, `${survive.afterReset} left`);
  ok('lanterns survive the server broadcast', survive.applied && survive.afterBroadcast >= 12,
     `${survive.afterBroadcast} left`);
  ok('server rows still adopted', survive.keptServerRow);
  ok('lanterns stay out of the save blob', survive.inSave === 0, `${survive.inSave} in blob`);

  // Nor can a player pocket one.
  const pocket = await page.evaluate(() => {
    const d = window._dev;
    const before = d.placedObjects.filter(o => o.civic).length;
    const lamp = d.placedObjects.find(o => o.civic);
    const held = d.inv.lantern || 0;
    d.removePlaced(lamp);
    return { before, after: d.placedObjects.filter(o => o.civic).length,
             gained: (d.inv.lantern || 0) - held };
  });
  ok('city lanterns cannot be picked up', pocket.after === pocket.before && pocket.gained === 0,
     `${pocket.before} → ${pocket.after}, gained ${pocket.gained}`);

  // ── 4. fire light, at dusk and at midnight ──
  // ⚠ Match each light to ITS OWN fire by position. The player now stands in a
  // city with sixteen lanterns, so "some light is bright" is satisfied by the
  // street lamps and proves nothing about the campfire — which is the exact
  // thing reported broken.
  //
  // Dusk is the case that actually failed: campfire/forge fell through to an
  // ungated `baseInt * nightFactor * 0.5`, so at nightFactor 0.3 a campfire put
  // out 0.2 and was invisible. Torches and hearths already had a 0.35 floor.
  for (const [label, hour, minInt] of [['dusk', 19.5, 0.4], ['midnight', 1, 0.8]]) {
    const probe = await page.evaluate(async (h) => {
      const d = window._dev, TILE = 48;
      d.setHour(h);
      // Drop one of each fire beside the player, then force the instanced
      // rebuild (the dirty dispatch is an else-if chain and rarely gets a turn
      // at ~2fps). The player is standing in the CITY here, which is the point:
      // sixteen civic lanterns sit closer than these do, and a straight
      // nearest-first light budget would hand them every slot.
      const ox = d.player.x + TILE * 5, oy = d.player.y + TILE * 5;
      for (const [i, t] of ['campfire', 'forge'].entries())
        if (!d.placedObjects.some(o => o.type === t && o.probe))
          d.placedObjects.push({ type: t, x: ox + i * TILE * 3, y: oy, id: 'probe_' + t, probe: true });
      d.markPlacedDirty();
      await new Promise(r => setTimeout(r, 1200));
      const lp = d.lightProbe();
      const out = { nightFactor: lp.nightFactor, fires: {} };
      for (const t of ['campfire', 'forge']) {
        const src = d.placedObjects.find(o => o.type === t && o.probe);
        const mine = lp.lights.filter(l => Math.hypot(l.x - src.x, l.y - src.y) < TILE);
        out.fires[t] = mine.length ? { int: Math.max(...mine.map(l => l.int)),
                                       dist: Math.max(...mine.map(l => l.dist)) } : null;
      }
      return out;
    }, hour);
    for (const t of ['campfire', 'forge']) {
      const f = probe.fires[t];
      ok(`${t} emits light at ${label}`, f && f.int >= minInt,
         `nightFactor ${probe.nightFactor} · ` + (f ? `intensity ${f.int}` : 'NO light at its position'));
    }
  }

  // …and it must reach past the grass, or it lights nothing the player can see.
  for (const [t, minDist] of [['campfire', 48 * 6], ['forge', 48 * 6]]) {
    const reach = await page.evaluate((type) => {
      const d = window._dev, TILE = 48;
      const src = d.placedObjects.find(o => o.type === type && o.probe);
      const mine = d.lightProbe().lights.filter(l => Math.hypot(l.x - src.x, l.y - src.y) < TILE);
      return mine.length ? Math.max(...mine.map(l => l.dist)) : 0;
    }, t);
    ok(`${t} light reaches past the grass`, reach >= minDist, `distance ${reach}`);
  }

  // ── 2. tutorial panel vs hotbar ──
  const overlap = await page.evaluate(async () => {
    const d = window._dev;
    d.G.tutorialOpen = true;
    await new Promise(r => setTimeout(r, 1500));
    const p = d.panelRect('tutorial'), h = d.hotbarRect();
    if (!p) return { drew: false };
    const stale = d.G.gameTime - (p.t || 0) > 1.0;
    return { drew: true, stale, p: { x: p.x, y: p.y, w: p.w, h: p.h }, h,
             gap: h.y - (p.y + p.h), canvasH: d.G.canvas.height };
  });
  if (!overlap.drew) {
    ok('tutorial panel rendered', false, 'panelRect("tutorial") never registered');
  } else {
    ok('tutorial panel rect is fresh', !overlap.stale);
    ok('tutorial panel clears the hotbar', overlap.gap >= 0,
       `panel bottom ${overlap.p.y + overlap.p.h}, hotbar top ${overlap.h.y}, gap ${overlap.gap}px`);
    ok('tutorial panel still on screen', overlap.p.y >= 0 && overlap.p.y + overlap.p.h <= overlap.canvasH,
       `y ${overlap.p.y}..${overlap.p.y + overlap.p.h} of ${overlap.canvasH}`);
  }

  const real = errors.filter(e => !/favicon|colyseus|ws:/i.test(e));
  ok('no page errors', real.length === 0, real.slice(0, 3).join(' | '));
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
