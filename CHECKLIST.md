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
- [ ] [critic] camera boom ends inside tree canopies (dungeonA, forest) — fade canopies near the camera
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
- [ ] B8 Critic pass on Phase B → append findings
- [x] B9 Perf: skirt ~50k tris, +0.4 ms/frame on the long vista, ~0 at iso (desktop ultra)
      [ ] still to check on the LOW tier / mobile

## Phase C — graphics critic loop (grass, background trees, buildings)
- [ ] C1 Critic reviews baseline screenshots → ranked findings list appended below
- [~] C2 Grass — tufts of 3 (grass.js makeTuftGeometry, TUFT_BLADES), live camera-distance
      fade (uFadeNear/Far), per-tuft hue jitter, boundary tiles 62% height, ground GRASS colour
      [66,101,38]. Done: C-2, C-3, C-4, C-5, C-12. Re-shoot + critic still to do
- [ ] C3 Background / far trees
- [ ] C4 Buildings
- [ ] C5 Re-shoot the same camera spots, critic A/B, iterate until no major findings

- [x] Fog keyed past the camera boom (near = boom + 0.55 RD) — a high camera washed the
      ground milky when fog was a fraction of the whole camera distance
- [x] `_dev.cam({mode:'iso'|'third'|'far'|'top'|'shoulder'|'first'})` pins the preset —
      a stored first-person mode silently ignored pitch/zoom in the shot tour
- NEXT: C4 buildings (city = bare WALL boxes, no roofs). Plan: read rebuildWalls; find the
      small enclosed WALL rectangles = buildings → roofed house kit (gable/hip roofs, timber
      frame, doors, windows) + merlons/coping/plinth on curtain walls + world-space brick UVs

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
- [ ] [critic] C-6 Far trees are lollipops: TRUNKH 0.42→~0.26 of TREE_H, per-instance
      height 0.75–1.3 / yaw / lean, greyer trunks #4b3d31, canopy colour jitter
- [ ] [critic] C-7 Canopy shading flat & dark (#1d3f1a); leaf texture has fish-scale outline
      rings; add wrap lighting + outward normals; raise albedo ~#3d6a2a
- [ ] [critic] C-8 Black slabs on the horizon (horizon_field, vista, grass_close) — unfogged
      far wall/bridge boxes? Identify and fix
- [ ] [critic] C-9 City walls: per-tile random tilt/yaw/offset/height opens seams and a stepped
      top — zero it for T.WALL; world-space UVs so brick courses continue; merlons +
      coping + plinth; interior building kit (gable timber-frame, stone hall, tower)
- [ ] [critic] C-10 Water edge: white foam wash ghosts blades (edge_west); hard seam y≈485
- [ ] [critic] C-11 Contact darkening under trees/walls (AO in the terrain splat)
- [x] [critic] C-12 Grass on biome boundaries keeps full height (ragged cliffs)
Mountain guidance (critic): 3 rings (foothills #6f8575 haze .35, mid #8d9fae .55, far
#a9b9c9 .75 w/ snow #dde5ee above 70%), peaks 1–6° above horizon never >8°, base 25% fades
into horizon colour, rendered before terrain, ~3 draws. Edge: raise heightAt over a 6–10 tile
band to a ridge, band blocking, low-res skirt beyond the map so no sky shows under it, conifers
on the band's lower half, slope-based rock blend.

## Phase D — ship
- [ ] D1 `npm test` + `npm run verify` green, budgets respected
- [ ] D2 Perf check on the ultra and low tiers (draw calls, frame time)
- [ ] D3 HANDOFF entry, version bump, commit + push
- [ ] D4 Backups on the VPS, then deploy (only if the user asks / confirms)
