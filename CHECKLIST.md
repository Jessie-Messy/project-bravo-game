# CHECKLIST — v0.20 "portals, mountains, and a graphics critic pass"

**Read this first after a compaction.** It is the stepping stone: the next unchecked
box is the next thing to do. HANDOFF.md holds the *why* of finished work; this file
holds the *what's next*. Critic findings get appended as new boxes under the phase
they belong to (tagged `[critic]`) rather than fixed silently.

Brief (user, 2026-09-26): Blender-made immersive portals you walk through — **red =
PvP rulesets and dungeons, blue = cities and non-PvP lands**. Critic-loop the
graphics: grass, background trees, buildings. A layer of **mountains in the
background**, and the **map edge becomes an impassable wall** that matches the
terrain instead of the world just ending. Work to the usage limits, set timers to
resume, keep this list current.

Standing rules: backups before any deploy · never deploy secrets or extra files ·
the repo is PUBLIC (never write the origin IP anywhere tracked) · annotate every
change in HANDOFF.md · run a critic on every change · `npm test` must stay green.

Tooling: headless Blender 5.2 at `C:/Program Files/Blender Foundation/Blender 5.2/blender.exe`
(`--background --factory-startup --python <script>`). The Blender MCP GUI bridge is
NOT running; use the CLI. Blender sources live in `tools/blender/`, their GLB output
goes to `models_src/` and then `npm run assets` bakes it into `models/`.
Local game: `.claude/launch.json` → `bravo-dev` on :8127.

---

## Phase 0 — orientation
- [x] Survey portal code (`makePortal`, TELEPORT handler, `COAST_PORTALS`), terrain, sky
- [x] Confirm headless Blender works
- [x] Baseline screenshots (fixed camera spots) saved to scratchpad for the critic A/B:
      city gate, dungeon mouth A, map west edge, map north edge, a forest, the city,
      Saltmere village

## Phase A — portals (Blender)
- [x] A1 `tools/blender/portal.py` → `models_src/portal_gate.glb`: standing rune-stone
      arch, walk-through opening ~1 tile wide, vertex-coloured / neutral stone so ONE
      mesh serves both colours (glow comes from the runtime material, not the GLB)
- [x] A2 Classify every TELEPORT tile red/blue by DESTINATION ruleset:
      red = coast (PvP) or dungeon; blue = city / mainland / back above ground.
      One function (`portalKind(tx,ty)`), unit-tested, no second copy
- [x] A3 Runtime: arch GLB + animated vortex ShaderMaterial (swirl, fresnel rim,
      inward-drifting motes), coloured point light, oriented to face the approach
- [x] A4 Walk-through feel: colour flash / fade on transit, sound
- [x] A5 Minimap + floating labels use the red/blue kind
- [x] A6 Tests: every TELEPORT tile has a kind; kinds match destinations
- [x] A7 Critic pass on portals — fixed: server refused EVERY dungeon entry online
      (landing 11 tiles from any portal; now world-data `portalArrivals`); fallback exit
      no longer drops you in gate A's membrane; `w===0` re-trigger removed; client cooldown
      2.6 s > server 2.5 s; pillar colliders only once drawn; vortex tone-maps on the low
      tier; atan eps; time wrapped; flare by time; motes culled; Shadowstep crosses gates;
      /__shot needs X-Bravo-Shot + 16 MB cap; dungeonEntryGate reset on new character
- [x] A-fix: coast gate sent netTp(x,y,'portal') → server refused every online use (now netTp('portal'))
- [x] A-fix: gates beside a cave wall slide half a tile away from it (dungeon mouth B)
- [x] A-fix: bake prune() strips unreferenced UVs → vortex uses object-space position
- [x] A-fix: Blender exported a white COLOR_0 → set 'Col' as the active colour attribute
- [x] [critic] camera boom ends inside tree canopies — CAM_FADE screen-door dither 40–110u
- [ ] [critic-low] minimap 3x3 gate dots erased by updateMiniPx on neighbour edits
- [ ] [critic-low] rideFerry sends no netTp → same desync class as the gate bug (pre-existing)
- [ ] [critic-low] remote players glide across the map on any teleport (no snap threshold)

## Phase B — map edge wall + background mountains
- [x] B1 Audit: outer ring had grass/water/paths; NW corner is a designer cave (world_edits);
      the SE block east of the coast was 33 600 CAVE_WALL tiles; coast "sea" is a BAY on its
      north side
- [x] B2 `T.RIDGE` (17, blocking) via `ridgeZone()` in world.js: 5-tile overworld band,
      separators, SE block, 4-tile coast W/E/S band. Edits still win (designer cave kept)
- [x] B2-fix: `blockedAt` now reads BLOCKING — CLIFF / ORE_IRON / STAINED_GLASS were walkable
- [x] B2-fix: 4 wolf/bandit spawns inside the ridge + [410,120] inside a cave moved to grass
      (server spawns exactly on the tile); saved positions inside rock step out on load
- [x] B3 `ridgeLift` (chamfer distance into the rock, crag noise, deep ranges) + foothills
      (12 tiles; coast gets its own `footFlat` rule); snow + world-space strata in the shader
- [x] B4 `skirtMesh` (1 draw, ~57k tris) carries the land 72 tiles past every edge and fills
      the unmeshed separator/SE block; `farRange` camera-following ring at 11.4 km
- [x] B4b Global aerial perspective: fog_fragment override adds a capped exponential haze
      (HAZE_CAP define, NO_RANGE_FOG for the skirt/range); range fog 0.55–1.5 × camFar
- [x] B5 Coast: bay closed by the separator ridge; W/E/S bands + foothills
- [x] B6 Walked into every wall with live key input: stops at the band edge on all sides
      (note: a GHOST — dead player — walks through, by the existing ghost design)
- [x] B7 Tests: every ridge-zone tile is RIDGE; outermost ring solid WITH edits applied;
      spawns on grass; nothing placed in the ridge
- [x] B8 Critic pass on Phase B — findings (fix in this order):
  - [x] [critic] B8-1 server wolf [35,50] is CAVE_WALL after world_edits (frozen in rock); run
        ALL spawn/placement checks in world.mjs on the EDITED map; [120,90] becomes PATH
  - [x] [critic] B8-2 world.mjs "nothing placed in ridge" passes COAST_NPCS world coords as tiles
  - [x] [critic] B8-3 haze order backwards: in-map ridge gets range fog, skirt/range don't →
        near ridge paler than mountains behind, hard contour at terrMesh edge (worse on mobile).
        Cap range fog (e.g. min 0.7) for all materials and let the skirt take it too
  - [x] [critic] B8-4 camBoomFloor samples heightAt (clamped at the edge) — boom end can sit
        inside the skirt past the edge; max it with the skirt's heightOf
  - [x] [critic] B8-5 one shared snow line (terrain 430-560 vs skirt 1050-1250 vs range)
  - [x] [critic] B8-6 ORE_IRON now solid: ore respawn only checks the LOCAL player — ore that
        respawns under a mob/remote traps it; coast CLIFF seals small pockets (fine) and 18
        one-tile passages (check the important ones)
  - [x] [critic] B8-7 rivers (x=5/474, rows 87-89, 205-208, 352-355) and 6 PATH tiles run into
        the ridge — fade the lift near water into a gorge; trim the dead-end path
  - [x] [critic] B8-8 global haze also hits ADDITIVE glows (portal pools, motes, VFX) → greyish
        by day; fog:false on additive materials
  - [x] separators (above dungeon + above coast) lifted 2x: from Saltmere you could see over
        the old one into the dungeon floors
  - [ ] [critic-low] load rescue moves a mid-river save to the bank (WADE off) and never netTp's
  - [ ] [critic-low] skirt snow brighter than the foreground at night; far range fine
  - [ ] [critic-low] js/editor.js has no colours for tiles 13-17 and still uses MAP_H=554
  - [ ] [critic-visual] ridge still a smooth dune: stronger crevices/detail normal, higher crag,
        scree band + boulders/pines on foothills, forest belt at skirt base, sharper peaks
- [x] B9 Perf: skirt ~50k tris, +0.4 ms/frame on the long vista, ~0 at iso (desktop ultra)
      [ ] still to check on the LOW tier / mobile

## User feedback (2026-09-26)
- [x] U1 Distant wolves froze mid-stride and "supermanned" across the field: past the
      animation-LOD radius the mixer was skipped entirely. Now `farMixerStep` / `farTick` step
      the right clip at FAR_ANIM_HZ (10 Hz), phase-jittered — mobs, rig mobs, NPCs, remote
      players, horses
- [x] U1b verified: 80 synthetic remotes at night, 20 animated + rest at 10 Hz, 11.6 ms median
      (86 fps, 568 draws, 3.5M tris). FOUND A LIVE BUG doing it: remote players (and parked
      horses, your rider, corpse, NPCs, guards, contract board, falling trees) were placed at
      y=0 from the flat-world days — anyone on a hill rendered sunk to the chest for others.
      All grounded with heightAt; `npm run test:grounding` pins it. ⚠ fix is in v0.20.0 LIVE

## Phase M — mob corpses, looting, harvesting meat & hides (user, 2026-09-26)
Must land BEFORE P3 (taming needs meat). Today: no meat item, no cooking; mobs throw loot
straight onto the ground at death (`spawnDrops`, enemies.js ~164 — includes 'hide'); a
corpse + loot window exists for dead PLAYERS only (game3d "Player corpse" ~6872, "Corpse
loot" ~9027) — reuse its UI pattern.
DECISIONS (user, 2026-09-26):
  * NORMAL mob corpses: open to EVERYONE, one shared (singular) loot set — first come.
  * SPECIAL corpses (bosses / named / champions): open ONLY to players who dealt damage to
    it; EACH damager gets their OWN roll for the special drop (if that mob has one).
    → needs a per-corpse damager set (server mobs: server tracks who hit; client mobs:
    local player + any remote whose hits we saw — decide authority when building M6).
  * Bosses KEEP the gold shower on the ground.
  * Harvest has NO skill: it just requires an appropriate weapon — a knife or any bladed
    item (sword, axe, dagger…; NOT bow, pickaxe, bare hands). Add a knife item if none
    exists (shop/craft), since it is the obvious harvesting tool.
- [x] M1 mob corpses: a killed mob leaves its body (death pose / last frame, or a lie-down
      tilt) for CORPSE_TTL (~90 s, then fades); pooled, capped (oldest despawns first);
      respawn timers unchanged. Server mobs (wolf/bandit) die on the server — corpse is a
      client-side record keyed by mob id at the death position
- [x] M2 search: [E] on a corpse opens a loot window listing what the kill dropped (gold,
      gear, ARPG items, artifacts, sigils…) instead of scattering it; "take all"; bosses
      ALSO keep their gold shower on the ground
- [x] M3 harvest: [E]/hold on a searched corpse holding a knife/bladed weapon → progress bar →
      yields per species (wolf: meat + hide; bandit: nothing to harvest; crab/serpent: meat,
      shell/scales?; cat: never harvestable). Corpse marked harvested (visual: shrinks/pelt
      removed). No skill — weapon gate only (see DECISIONS)
- [x] M4 items: raw_meat, (cooked_meat via campfire cooking → heals), hide already exists;
      BAG_ITEMS entries (⚠ HANDOFF gotcha: a new pickup missing from BAG_ITEMS never shows in
      the bag), icons, stack sizes, bank/trade support, save/load
- [x] M5 cooking: use raw_meat at a lit campfire/placed fire → cooked_meat (food heal over
      time); burnt chance at low skill (optional)
- [x] M-impl notes: js/corpse-data.js (pure tables: HARVEST, SPECIAL_TYPES, isSpecialKill,
      canHarvestWith, rollHarvest, FOOD); game3d "Mob corpses" section: hooks.onCorpse moves
      a death's drops into the body (boss gold stays on the ground, pelts held back for
      skinning); GLB mobs clone + play Death once; rig mobs lie on their backs; [E] search,
      Take All, Harvest (2.2 s, needs knife or bladed weapon in hand); Skinning Knife sold by
      the merchant (no weapon swap); raw/cooked meat in bag + trade; cook at a campfire
      (craft menu); Eat action heals 36 HP over 12 s; _dev.kill(type), _dev.corpses
- [x] server DROP_TYPES lacked mithril/runic/abyssal (untradeable between players) + meat added
- [x] M8 two-client check (2 tabs vs local server: 2nd player saw the body, harvested first
      (+3 meat +1 hide), 1st player's copy flipped to harvested). Fix from it: bodies landed
      ~2 tiles apart per client → mob_dead now carries the server's x/y. second player sees the body, first-come take, harvest refused to the
      second claimant ("someone got to it first"); a joiner mid-corpse gets corpse_new
- [x] M9 critic pass on Phase M — fixed: server dropped gems from corpse loot; eviction deleted
      unlooted bodies (now empties first, spills loot, never special; server deaths >30 tiles
      get no body); harvest shortened a loot-holding body's life; offline could take a server
      body's loot locally (dupe); ARPG items from corpse_fill passed through unchecked into
      other players' saves (now rebuilt from a whitelist, server cleanItem); E on a spent body
      stole the key from NPCs and opened over the bank; Escape didn't close the panel; ghosts
      could loot; clone skeletons leaked; harvest not mirrored on other screens; _hitByMe
      survived respawn.
  - [ ] [critic-low] makeRig materials of bandit corpses not disposed (check makeRig sharing)
  - [ ] [critic-low] knife nearly pointless: players start with the axe (a blade) — design call
- [x] bandits dropped STONE (no spawnDrops entry) → now 3-8 gold, 15% bandage
- [x] M6 multiplayer (verified online against the local dev server: kill → server corpse c1 →
      killer posts loot → server echoes → Take All via server → harvest claim ok): corpses of SERVER mobs visible to everyone; normal = shared first-come
      loot; special = damagers only, per-damager special roll (see DECISIONS); PvP player
      corpses unchanged
- [x] M7 tests (tools/test/corpses.mjs, 95 checks; critic pass still to do): every mob type has a corpse/loot/harvest table (no silent 'undefined' drops),
      BAG_ITEMS covers every new item, save round-trip; critic pass

## Phase P — cats: wild mobs that can become pets (user, 2026-09-26; interleave with C)
Asset: `models_src/Calico_Cat_Pet.glb` (user-supplied) → baked `models/Calico_Cat_Pet.glb`
0.31 MB, class `character`, 27-bone skin, ONE clip "Armature|Unreal Take" (1 s loop, hips
translate → almost certainly walk/trot). Authored at ~0.003 units tall → needs runtime scale.
⚠ Model payload is now 7.96 / 8.00 MB — the next model needs a budget decision (raise the
cap or KTX2 textures). Ask the user before raising it.
- [x] P1 asset into models_src + budgets.json (`^Calico_Cat`) + bake; animation/skin intact
- [x] P1b clip confirmed in-engine: a walk cycle (idle = paused copy; model h:52 — the rig's
      bind pose measures ~4x taller than it stands). Was: (headless Blender frames); decide idle = slowed/paused
      clip + procedural tail/breath, or cut an idle in Blender
- [x] P2 wild cat mob (8 spawns: city gates/fields + Saltmere; passive, bolts at 3.5 tiles,
      curious toward anyone carrying meat) — client-side wildlife: ENEMY_CFG 'cat' (skittish, low HP, flees, never aggressive), MOB_MODELS
      entry + scale/yaw fit, a few spawns near forest edges / Saltmere; server mobs? (decide:
      client-only wildlife like the dungeon mobs vs server-authoritative like wolves)
- [x] P3 taming ([E] feed: raw +1 / cooked +2 trust, 3 = tamed; achievement first_pet): [E] on a wild cat holding raw/cooked meat,
      chance-based with feedback; tamed cat despawns from the wild pool and becomes `player.pet`
      {type, name, hp, maxHp, lvl, xp}; ONE active pet; saved in the save blob
- [x] P4 pet AI (hunt/follow/stay; assists what you hit or what aggroes you; faints 20 s at
      0 HP and returns; levels: +8 HP +2 dmg; leash teleport 14 tiles): follow ~1.5 tiles behind, path around obstacles (boxBlocked), catch up /
      teleport when > 12 tiles or after a portal/ferry; HUNT: attacks whatever the player
      attacks or whatever attacks the player; small damage scaling with pet level; kill credit
      + loot go to the player; flees to the player at low HP, regenerates out of combat;
      respects region rules (never damages players; PvP untouched)
- [x] P5 UI (pet frame bottom-left: click = stance, ✕ = release; rename not done): pet panel (name, HP, level, stance: follow / hunt / stay, dismiss / rename);
      pet HP bar; floaters
- [x] P6 multiplayer (PlayerState pet/petX/petY, validated near the owner; remote pets built by
      buildMobModel; verified with 2 players — the watcher saw the pet at the owner's pet spot): other players see your pet (PlayerState petType/petX/petY or piggyback on
      the move message) — server validation minimal (cosmetic position)
- [x] P7 tests (tools/test/pets.mjs, 26 checks)
- [x] P8 critic pass on Phase P — fixed: the player's own sword arcs/arrows/aggro swings hit the
      pet (an endless XP/loot farm via faint+return) → isHostile() gates damageEnemy and every
      target picker (nearestEnemy, guards, guard threat check); the mob AI also ticked the pet
      (double attack rate); summon used makeEnemy's grass search (no pet in dungeon/caves); a
      shrine could splice the pet; faint spliced the record (shifted slotModel indices) → now
      revived in place; remote players saw a fainted pet standing still; wild cats lured toward
      pet owners and E-feed stole [E]; no pet XP from server-mob kills; remote/slot model
      skeletons leaked (_disposeModel). Wild cats are now immune (wildlife, not a target).
  - [x] [critic-low] cat idle held at 0.84 s of the walk clip (`idleAt`), where all four paws sit
        lowest (measured in-engine: frame 0 was among the WORST — a paw lifted)
  - [ ] [critic-low] server accepts pet:'cat' without the owner having one (cosmetic) (cfg sane, save/load round-trip, pet never targets players) + critic pass

## Phase C — graphics critic loop (grass, background trees, buildings)
- [ ] C1 Critic reviews baseline screenshots → ranked findings list appended below
- [~] C2 Grass — tufts of 3 (grass.js makeTuftGeometry, TUFT_BLADES), live camera-distance
      fade (uFadeNear/Far), per-tuft hue jitter, boundary tiles 62% height, ground GRASS colour
      [66,101,38]. Done: C-2, C-3, C-4, C-5, C-12. Re-shoot + critic still to do
- [~] C3 Background / far trees — TRUNKH 0.42→0.30 of TREE_H (canopy 0.70), far trunk tint 0xb8aa98.
      Still to do: C-7 canopy shading (wrap lighting, leaf texture outline rings, albedo lift)
- [ ] C4 Buildings
- [ ] C5 Re-shoot the same camera spots, critic A/B, iterate until no major findings

- [x] Fog keyed past the camera boom (near = boom + 0.55 RD) — a high camera washed the
      ground milky when fog was a fraction of the whole camera distance
- [x] `_dev.cam({mode:'iso'|'third'|'far'|'top'|'shoulder'|'first'})` pins the preset —
      a stored first-person mode silently ignored pitch/zoom in the shot tour
- NEXT: C4 buildings. Facts: walls are 1-tile instanced boxes (`rebuildWalls`, game3d ~3073,
      WALL_H=168, one material wallTex). City (world.js ~118): outer ring 280-340 x 332-392 with
      3x3 corner towers + 3-wide gates; keep ring 296-324 x 348-376, 2 thick; 9 `buildHouse`
      5x5 HOLLOW rooms (WALL border, PATH inside, 1 door gap) with shopkeepers INSIDE; bank
      9x7 hollow at 306-314 x 359-365; Saltmere huts 3x2 ("WWW"/"W=W").
      Plan:
      [x] C4a boot-time WALL component pass on the static map → per-tile flag: 0 plain (incl.
          later player-placed walls), 1 fortification (bbox > 12), 2 building (bbox <= 10)
      [x] C4b buildings: second instanced mesh with a plaster + timber-frame canvas texture
          and stone footing; merged gable roofs (shingle texture, overhang, gable ends,
          chimney on some); lintel over each door gap; roof HIDDEN while the player is inside
          its bbox (NPCs stand inside); warm emissive windows at night
      [x] C4c fortifications: zero the per-tile jitter; merlons + coping + plinth (instanced);
          world-space UVs so brick courses run across tiles; corner towers taller + conical roof
      [x] C4-impl: game3d "What each wall tile IS" (wallKind, BUILDINGS, TOWER_CENTRES, BLDG_H,
          TOWER_H), houseWallMesh + per-building roof meshes (hidden while you are inside),
          lintels, night windows (_windowMat), merlonMesh in rebuildWalls, world-space UVs on
          wallMesh (customProgramCacheKey 'wall-worlduv-v1'), updateBuildings() per frame
      [ ] C4e critic pass on buildings (shots .shots/b1_*.jpg)
      [ ] C4d tests: every buildHouse/bank/hut classified as building; outer + keep = fort

### Critic findings (append here)
Round 1 (baseline shots `.shots/base_*.jpg`), ranked worst first:
- [x] [critic] C-1 Aerial perspective is OFF: `fog.near = _camFar*1.05` (~game3d 13417) puts fog
      past everything on screen. Try near≈0.35·camFar, far≈1.3·camFar; cap at 0.85 on silhouettes
- [x] [critic] C-2 Hard line where grass instancing ends (vista_north y≈490, vista diagonal,
      iso cliff). Fade blade height by LIVE camera distance in the vertex shader; widen
      GRASS_MARGIN 0.16→~0.35; taper boundary-tile blades
- [x] [critic] C-3 Ground between blades is pale mint (#86b486) vs blades #3f5a24–#a8c25c —
      pull terrain grass albedo to blade-root colour (~#506d2c–#5e7c34)
- [x] [critic] C-4 Grass drawn over the void past the map edge: `_grassClassAt` has no
      x-bounds check (row wrap). Reject tx outside 0..MAP_W-1
- [x] [critic] C-5 Blades look like "a bed of knives": width 0.22→~0.12, per-blade hue jitter,
      bend normals toward terrain normal (tufts of 3 crossed strips = fewer instances)
- [x] [critic] C-6 Far trees are lollipops: TRUNKH 0.42→~0.26 of TREE_H, per-instance
      height 0.75–1.3 / yaw / lean, greyer trunks #4b3d31, canopy colour jitter
- [x] [critic] C-7 Canopy shading flat & dark (leaf normal 1.8→0.8 killed the rings; albedo lifted;
      wrap lighting NOT done) (#1d3f1a); leaf texture has fish-scale outline
      rings; add wrap lighting + outward normals; raise albedo ~#3d6a2a
- [x] [critic] C-8 Black slabs on the horizon — identified by raycast: the CAVE walls (21k box
      tiles, windowed to the fog edge) range-fogged to fog colour = a pale slab, in front of land
      that only hazes. Fix: `RANGE_DISSOLVE` fog define (dissolve in the last 30% of the range)
      on caveMesh + a smooth +-18% height swell. Fort walls/merlons now drawn whole
      (`fortMesh`, `rebuildForts`) with NO_RANGE_FOG, and the town too, so the city hazes like
      the land. Follow-up: cave EXTERIORS still read as stacked boxes up close — needs a rock mesh
- [x] [critic] C-9 City walls: per-tile random tilt/yaw/offset/height opens seams and a stepped
      top — zero it for T.WALL; world-space UVs so brick courses continue; merlons +
      coping + plinth; interior building kit (gable timber-frame, stone hall, tower)
- [x] [critic] C-10 Water edge: grass no longer grows within half a tile of water/shallows
      (`_WET_PROBE` in `_bladeOnGrass`), so no blades ghost through the foam. The river now
      thins out over the last ~3 tiles before the edge ridge (mask BLUE = `_ridgeFade`, water.js
      cov *= mask.b). The band's inner edge now wanders 0-3 tiles (world.js `ridgeRagged`,
      natural ground only, so roads/rivers/portals keep their tiles and rivers leave a gorge
      notch). server/world-data.json rebuilt — ⚠ ships with the next SERVER deploy too
- [x] [critic] C-11 Contact darkening baked into the ground AND carried into the grass blades
      standing on it (`_aoOccluders`/`_aoAt`): walls/cave walls box falloff 0.7 tile, trees
      round 0.78, stones 0.52
- [x] [critic] C-12 Grass on biome boundaries keeps full height (ragged cliffs)
Mountain guidance (critic): 3 rings (foothills #6f8575 haze .35, mid #8d9fae .55, far
#a9b9c9 .75 w/ snow #dde5ee above 70%), peaks 1–6° above horizon never >8°, base 25% fades
into horizon colour, rendered before terrain, ~3 draws. Edge: raise heightAt over a 6–10 tile
band to a ridge, band blocking, low-res skirt beyond the map so no sky shows under it, conifers
on the band's lower half, slope-based rock blend.

## NEXT UP (in order, as of 2026-09-26 afternoon)
1. C4e critic pass on buildings (.shots/b1_*.jpg) — then a round-2
   graphics critic on the whole tour (window.TOUR in the page; see HANDOFF dev tooling)
2. [x] camera boom inside canopies: CAM_FADE dither in alphatest_fragment (canopy + near leaf mats)
3. C-8 black slabs on the horizon (identify), C-10 water edge foam wash, C-11 contact AO
4. [x] cat idle frame; [x] U1b 10 Hz far-anim check; [x] B9 low-tier perf check —
   low: ~5 ms/frame, 180-260 draws, ~500k tris; ultra: ~11 ms, 590-820 draws, 1.9-3.8M tris
   (desktop, 1280x720). Found + fixed on the way: ultra-only BLACK HORIZON BAND = GTAOPass
   reading the far mountains (at the 12000 far plane) as fully occluded → AO faded out
   6000-10000 view units (composer.js); tree/stone AO baked into the ground left crop-mark
   blotches where far trees are culled (low tier) → ground AO is walls-only now
5. [x] deployed v0.20.0; await the user's test feedback

## Phase D — ship
- [ ] D1 `npm test` + `npm run verify` green, budgets respected
- [ ] D2 Perf check on the ultra and low tiers (draw calls, frame time)
- [ ] D3 HANDOFF entry, version bump, commit + push
- [x] D4 Backups on the VPS, then deployed v0.20.0 (user asked 2026-09-26) — verified live
- [x] D5 model budget raised 8 → 12 MB (user asked)

### C4e building rebuild — status 2026-09-26 (limit reached mid-loop)
- [x] js/render/buildings.js rewritten to critic spec (types A/B/C/HUT, 150 doors, facade-wide framing, closed gables, thick roofs, thatch/weatherboard huts, ridge chimneys); wired in game3d.js (TOWN merge, new mats boards/thatch/floor/glass/glassLit)
- [x] page loads with no errors; r1_ tour shots written to .shots/r1_bld_*.jpg (NOT yet reviewed)
- [x] critic r3 (5.5/10): all 12 items applied except half-hips + merlon UV scale (commit a7a0fa9)
- [x] roof dither fade + waist-high cutaway (shadows too); night spill light; tower caps merged
- [x] commit + HANDOFF entry; npm run test:buildings (42 checks)
- [x] critic r5 (6.5/10) → 8 fixes (commit a7aa5a2); half-hips done
- [x] critic r6: **PASS 7.5/10**; its 2 leftovers fixed (door glow material at the back of the
      reveal; door leaf hides with the roof)
- [x] street props (critic PASS after 2 rounds): hanging shop signs with lanterns on 7 shop
      doors (atlas `_signTex`, `SHOP_SIGNS`), barrels + crates at trades, flower boxes, benches;
      props are player colliders (buildTown returns `props`). Merlon UVs: already world-space via wallMesh's shader — the
      critic's "stretched" note looks mistaken; recheck only if seen in game.

### Round-2 whole-tour critic (2026-09-27): 6.5/10 — items (g3_* shots)
- [x] G2-3 trunks: bark albedo was very dark (not shadows — measured); lighter bark, far-trunk tint e8d8c0 + no received shadow
- [x] G2-2 haze distance now subtracts the camera's height above ground (fog_fragment `_hazeD`)
- [x] G2-5 ragged ridge edge takes PATH too, so roads end at the foot (world-data rebuilt)
- [x] G2-8 boulders jittered off tile centre, 0.6-1.35 size, lighter warm grey
- [x] G2-6 the 'snow triangles' were SKY through a crack: skirt edge vertices sat ~26 above the terrain's
      edge (outerGroundAt clamps half a tile in) and a 3-tile skirt spanned 2-tile gorge dips. Edge vertices
      now take the terrain's own min height across their span (-2) + polygonOffset. Skirt snow also per-pixel.
- [x] G2-4 paths: blurred path field (4/2/1 kernel, diagonal links bridged) inside _warpedTileAt; grass follows
- [x] G2-7 (interim) cave rock lighter + mossy tops (`cave-moss-v1`); real rock mesh still TODO
- [~] G2-1 mountain band: horizontal strata striping replaced with soft fall-line gullies (ridge + skirt).
      Tiers broken: `_edgeSpur(along)` spurs shared by ridgeLift (band) and outerGroundAt (skirt), so a
      spur climbs from the band crest into the high range
- [x] G2-dusk haze colour clamped to ~2.5x the surface's own brightness (fogColor = bright horizon at dusk
      lit the hills paler than the sky); range fog keeps the true horizon colour; far range dims to 7% at night
- [ ] minor: far grass dark specks; near-plane clip in city_street; wall-top streaks

### Round-3 whole-tour critic (2026-09-27): 7.0/10 — fixes applied
- [x] G3-1 black cave slabs: cave texture averages ~45/255 (built for the torchlit dungeon) → surface caves
      (not the dungeon strip) lifted ~6x in the shader; haze only (NO_RANGE_FOG)
- [x] G3-2 dotted horizon band (the dither dissolve): cave walls now SINK into the ground over the last
      stretch of the range (`_caveFade`, vertex shader) instead of stippling
- [x] G3-3 edge spurs: warped spacing, 0.35-1.45 height variety, taller in the band (380)
- [x] G3-4 gully smears: half strength, wider
- [x] G3-5 near trunks: bark #6b5842 → #8f7a60; far tint desaturated to d4c6b0
- [x] G3-6 boulders: jitter ±0.35 tile
- [x] G3-7 dusk warmth: sky turbidity/rayleigh/mie pushed harder by horizonF² — amber sun-side glow, noon untouched
- [ ] minor: Saltmere pale sand smear under a tree; trunk stubs through canopy sides (top view);
      near-plane clipping in first person (city_street)

### SHORT LIST (owner, 2026-09-28)
- [x] water blinking black (v0.21.0): water sheet re-windowed 6th in the obstacle stagger → every frame now
- [x] ultra "grass shadows way too much": GTAO treated blades as occluders → grass out of the AO prepass
- [x] cave exteriors: surface caves are one continuous rock heightfield (js/render/cave-rock.js, 3 samples/tile,
      talus foot, crags, mossy ledges); dungeon keeps its boxes; torches still mount; test:caverock
- [x] TORCHES — critic loop PASS 8/10 (3 → 5 → 6.5 → 7.5 → 8). Lights at the flame (were buried at a
      fixed y), physical falloff + jitter; procedural flame card + glow/embers (render/flame.js), model's own
      flame collapsed (fire.js hide); held torch upright, flame drawn (fog chunk + mirrored-bone culling bugs).
      Polish left: pale rim on the torch head at point-blank range
- [x] minor: sand warmer/darker (184,156,106 — lit beaches read as snow); first-person near plane 3
      (props and door leaves sliced open at 10); top-view trunk "stubs" are perspective (trunks of trees
      at the frame edge seen from the side) — correct geometry, left as is
- [x] v0.22.0 deployed (client only) + pushed
- [x] v0.23.0 deployed (client only): bridges, trees, cave mouths. ⏸ PAUSED — owner will send feedback before more work
- [x] BRIDGES — remade (critic 6.5 → 7.2 → PASS 7.6). They were rafts stranded mid-river since the boot-time
      river widening skipped them; now planned bank to bank (js/render/bridges.js), stone approach ramps +
      pier heads, arched plank deck, trestle bents with X + knee braces, railings (colliders), lanterns at
      night. heightAt wraps the deck; bed carved under bridges; widening drowns island trees. test:bridges
      Left: submerged pier head faintly visible through shore foam (it IS under the water); bare deck edge
      where one bridge meets the cliff (no kicker board)
- [x] TREES — critic 4.5 → 6.0 → 7.0 → 7.2 → 7.3 → 7.3 → PASS 7.7. Pale "ghost" groves were RANGE FOG (far trees
      now haze-only and sink over the last 13% of the tree draw distance); near crowns were 5 tiles wide (now width-
      normalised) so groves were one hedge; ~20% of broadleaf tiles are low understory bushes; crown normals on leaf
      cards (lit/shaded sides); leaf textures redrawn (clusters; halo against black mip fringe); conifers get a needle
      texture, 6 bowed scalloped tiers and NEVER near-LOD (generated conifers failed 6 rounds); broadleaf crowns in
      the top half on longer trunks; per-tree tint; leaf cards out of GTAO (bark back IN — out, it drew black slabs).
      Left (minor): first person under a canopy is dusky + dither stipple; horizon grove strips (sink toggle test)
- [x] CAVE ENTRANCES — critic 6.8 → 7.1 → 7.3 → PASS 7.6. js/render/cave-mouth.js: rock portal across the whole
      gap in the cliffs' material (soffit 148→172, 1.8 tiles deep, seamless shared edges), two mine-prop frames
      under it with lagging + a boarded sheet, torch sconces on the jambs (flame cards + light pool). Replaces a
      58-tall box arch. test:cavemouth. Left (minor): portal rock could take strata / flat shading
- [x] cave rock mesh critic review — folded into the cave-mouth loop: face-plane noise printed contour rings and
      wood grain; the rock material is now triplanar with more contrast
- [ ] polish: pale rim on the torch head at point-blank range
- [ ] polish (from the tree loop): first person under a canopy is dusky + dither stipple; horizon grove strips
- [ ] iron-ore nodes render near-black and read as holes (cave critic) — gameplay resource, owner's call on look
