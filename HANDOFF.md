# Project Bravo — Session Handoff

Shared notepad between work sessions (human + AI). **Read this first. Update it
before you stop.** The rule that bit us once already: *commit your work and jot
your stopping point here before ending a session* — uncommitted work with no
handoff is invisible to the next session and causes collisions.

- Repo is **on GitHub**: `Jessie-Messy/project-bravo-game`, remote `origin`, base branch
  **`master`**. (It used to be local-only and VPS-deployed; that note was stale.) VPS
  deployment is unchanged and still a separate path — `deploy_to_vps.bat` /
  `deploy_server_to_vps.bat`. ⚠ `VPS_INFO.md` is **gitignored on purpose** (it holds the
  server details), so it exists only on the owner's machine — don't expect it in a fresh
  clone, and don't commit it.
- Run locally: `start_game.bat` (serves on http://localhost:5173, opens `medieval_prototype.html`).
- Main game code is one big module: `js/game3d.js`. Shared state: `js/state.js`. Tunables: `js/constants.js`.

---

## Alpenglow — the snowboard game (`snowboard.html`)

A second, self-contained game in this repo. It shares the repo, the conventions
and nothing else: no imports cross between `js/snowboard/` and `js/`, no shared
state, no shared save key. You can work on either without reading the other.

- **Run it:** serve the repo root and open `/snowboard.html`. `start_game.bat`
  still opens the medieval prototype; point a browser at `snowboard.html`
  manually, or use any static server (`npx serve -l 5173 .`).
- **three.js is VENDORED** at `vendor/three/` (r160, 15 modules, MIT). The
  medieval prototype still uses the jsDelivr CDN — that is deliberate, not an
  inconsistency. A phone game should not block first paint on a third-party
  host. `vendor/three/README.md` says how to refresh it.

### The one idea worth knowing

`js/snowboard/course.js` is a **single analytic height function**, `height(x,z)`.
It is the only source of truth for where the snow is:

- `terrain.js` evaluates it to build chunk geometry
- `physics.js` evaluates it four times a frame to stand the rider on it
- `scenery.js` evaluates it once at load to sit trees on it

Nothing can disagree about the ground, which is the entire bug class that a
separate collision mesh introduces. **If you change the shape of the mountain,
change it there and everything follows.** A run is authored as a pitch profile,
a corridor width profile and a list of feature zones (moguls, kickers, halfpipe,
crevasses…) in `data/runs.js`.

Physics is ballistic-first: every frame integrates full 3D velocity under
gravity, then asks whether the board ended up below the snow. Going airborne off
a roller, a mogul, a kicker lip or a cliff band all fall out of those three
lines — `physics.js` does not know features exist.

### Files

| File | What it owns |
| --- | --- |
| `config.js` | quality tiers, device detect, auto-demote, all physics/scoring tunables |
| `data/runs.js` | the ten mountains — pitch, width, weather, feature zones |
| `data/gear.js` | six boards, six riders, and the stats→physics mapping |
| `course.js` | the height function, the props list |
| `terrain.js` | snow shader + 40 m chunk streamer + the distant shell |
| `scenery.js` | procedural trees/rocks/seracs/piste furniture, all instanced |
| `sky.js` | Preetham sky, snow-tuned lighting, the three-ring skyline |
| `rider.js` | procedural rider and board, posed from one `pose` object |
| `physics.js` | the ride |
| `fx.js` | spray and snowfall particles |
| `post.js` | bloom → tone map → grade (speed streaks, vignette) |
| `ui.js` / `css/snowboard.css` | screens, HUD, saved bests |
| `input.js` | touch / keyboard / tilt / gamepad, one output struct |
| `main.js` | boot, world assembly, camera, frame loop |

### Gotchas this cost real time

- **Backticks inside the GLSL template literals.** `terrain.js` builds shader
  chunks in `` `...` `` strings. A backtick in a *comment* inside one silently
  ends the literal and the module fails to parse with "missing ) after argument
  list", pointing at a line several above the real one. Parse every file
  (`node --check`) after editing a shader.
- **`normal` is in VIEW space** inside `#include <normal_fragment_maps>`.
  Perturbing it with a world-space vector tilts it in whatever direction the
  camera faces — the corduroy was invisible for exactly this reason. Rotate
  offsets with `viewMatrix` first.
- **The sky dome will paint over the skyline.** Ridge materials must have
  `depthWrite: true` and the Sky mesh needs a very negative `renderOrder`;
  otherwise the dome draws afterwards, passes the depth test against geometry
  that never wrote depth, and erases the mountains.
- **Bloom threshold is in HDR scene units**, before tone mapping. Sunlit snow
  sits around 1.5–2.5 there, so the "sensible" 0.9 blooms the entire slope into
  a white halo. It is 2.2–2.4.
- **Particle sizes are metres**, converted with `viewportHeight / (2·tan(fov/2))`.
  The first version used a magic constant with unitless sizes and a single spray
  particle rendered over a thousand pixels wide — on screen it read as a white
  sheet hanging off the board.
- **The terrain mesh's own lateral edge is visible** from the chase camera.
  It is 155 m out, not 42, for that reason — widening it costs nothing because
  the column warp keeps the vertex count on the piste.
- **Two clocks in the frame loop.** `dt` is clamped to 1/4 s so a backgrounded
  tab cannot teleport the rider; `realDt` is not. Anything measuring the
  *world* uses the clamp, anything measuring the *device* (the quality
  watchdog) must use real time, and anything the player is waiting on (the
  countdown) runs on `performance.now()` directly. Fed clamped time, a phone
  rendering at 1 fps advanced the countdown at a quarter speed and sat on "3"
  for ten seconds — a game that visibly would not start.
- **Sound must never be able to stop the game.** `new AudioContext()` throws
  outright in some browsers and frames, and it used to sit unguarded inside the
  DROP IN handler: the exception propagated out of the click listener and the
  run never started, on a device where everything else worked. Every entry
  point in `audio.js` now no-ops rather than throwing, including the ones fired
  from `setTimeout` (whose exceptions land on `window.onerror`, not on the
  caller).
- **Mobile tier detection cannot see a GPU.** Safari does not implement
  `deviceMemory` and every modern iPhone reports 6 cores, so a "cores ≥ 6 and
  memory ≥ 4" check passed on all of them and handed phones the desktop tier.
  Phones start at `medium` at most; the watchdog can only demote, so guessing
  upward costs the player real seconds of unplayable game.
- **Exposure is the whole ballgame on snow.** Sunlit snow has to land near 0.8,
  not 1.0. `TIME_PRESETS[*].exposure` in `sky.js` is where that lives, and the
  values are low (0.24–0.40) on purpose.

### Playing it without a server

`npm install && npm run build:snowboard` inlines every module and every byte of
CSS into one ~705 kB page at `dist/alpenglow.html` (gitignored). That form is
for handing someone a link or a file, and for hosts that refuse external
requests entirely; `snowboard.html` stays the maintained form you develop
against. The build is a resolver plugin over esbuild — three.js's bare
specifiers come from `vendor/`, since esbuild has no importmap — and it refuses
to emit if either inlined payload contains its own closing tag.

### Not done yet

- No multiplayer, no ghosts, no leaderboard. Bests are `localStorage` only
  (`bravoSnowSave_v1`).
- Rails/boxes are ridable and score a grind, but there is no dedicated grind
  balance mechanic.
- Verified in Chromium (desktop and emulated phone, portrait and landscape).
  Not yet run on real iOS/Android hardware — tilt steering in particular is
  implemented and permission-gated but untested on a physical device.

---

## Graphics overhaul — COMMITTED and on `master`

⚠ This section used to read "IN PROGRESS — branch `graphics-overhaul`, UNCOMMITTED".
That is stale and was **not** a warning about lost work: there is no `graphics-overhaul`
branch anywhere (local or remote), and all of this landed in `master` — `js/render/` is
committed with all seven modules. Nothing here is at risk; read it as history, not as a
pile of uncommitted changes to be careful around.

Everything below is verified in-page unless marked otherwise. The sky is now
working (see "sky exposure" below); it renders correctly at every hour.

New `js/render/` (none of these ever import `game3d.js` — deps are passed in,
which is what keeps the graph acyclic): `quality.js` (4 tiers, auto-detect,
localStorage override, auto-demote watchdog), `sky.js`, `water.js`,
`composer.js`.

**Landed and working:**
- **Lambert → Standard, 2678 → 314 meshes.** The big one was `makeRig()`, which
  mints 4 materials per pooled character rig — the blocky fallback rigs were
  ignoring the env map while GLB NPCs beside them used it. Also terrain (the
  single largest surface in the game), houses, bridges, campfire/workbench.
- **Camera near/far 1/60000 → 10/12000.** Min zoom still leaves the camera ~390u
  out. ~5000x the depth precision, and the prerequisite for any AO later.
- **Shadow box now scales with zoom** (`fitSunShadow`): `half = clamp(camDist *
  1.25, 900, 2200)` instead of a fixed ±1200, so it stops clipping when you zoom
  out. `normalBias = 2.0` — **world units, and this scene is 48u/tile**, so the
  ~0.02 you see in three.js examples does nothing here.
  - ⚠⚠ **A fitted shadow frustum silently killed ALL cast shadows.** The first
    version transformed a camera-biased centre into light space, snapped it to
    texels, and derived `far` from its depth. Every number it produced looked
    correct in isolation — half 1247, centre [-15.8, 336.2], near 1, far 5946,
    1.22 units/texel — and there was not a single cast shadow anywhere in the
    world, at any hour. No error, no warning. Caught only because a reviewer
    looked at a screenshot and said "there are no shadows."
  - **`_dev.shadowFit(false)`** restores the original fixed ±1200 box for A/B.
    That is how it was isolated, and how any future change here must be
    checked: stand near a wall at 10:00 and confirm the shadow is still there.
    Do not trust the `shadowBox()` numbers alone — they looked fine while
    completely broken.
  - Only the zoom adaptivity survived. The offset centre, the texel snap and the
    computed `far` are gone. Reinstate them one at a time, with an A/B each.
- **Canopy wind** on `topMesh` via `onBeforeCompile`, weighted by height² (so
  trunks stay planted) and phase-offset per instance (so the forest doesn't sway
  in lockstep).
- **Dev capture rig:** `_dev.freezeTime()` (verified 0.0000s drift vs 0.808s
  running — without it the sun moves between before/after shots),
  `_dev.cam({angle,pitch,zoom})` (these were module-scoped with no handle),
  `_dev.shot()`, `_dev.matAudit()`, `_dev.shadowBox()`, `_dev.skyProbe()`,
  `_dev.gfxTier()`, `_dev.perf()`. New **GFX** dev-panel page.

**Sky exposure — FIXED, and the reasoning matters.** Sky.js is built for the
three.js example, which renders it straight to screen at exposure ~0.5. Here it
arrived far too hot and clipped to flat white, which also drove
`scene.fog.color` and the clear colour white — so it presented as a fog bug.
The fix is a **radiance multiply** (`DEFAULT_SKY_GAIN = 0.35`, patched in via
`onBeforeCompile`, live-tunable with `_dev.skyGain(n)`). It applies to the PMREM
bake too, since that renders the same material, so the sky and the light it
casts stay consistent by construction.
- **Do NOT try to cancel Sky.js's built-in `pow(texColor, 1/(1.2+1.2*sunfade))`
  with a `pow(rgb, 2.2)`.** Tried; strictly worse. That output exceeds 1.0 near
  the horizon, where a >1 exponent amplifies instead of attenuating. Scale the
  level, don't reshape the curve.
- Verified horizon sample by hour: noon `[0.56,0.72,0.84]` (correctly
  blue-shifted), dusk `[0.90,0.92,0.86]`, midnight `[0.026,0.022,0.022]`.
  Previously it pinned to exactly `[1.4,1.4,1.4]` at both noon AND dusk.
- ⚠ Still to tune: **dusk is too bright and not warm enough** — 19:00 should be
  amber at the horizon and currently reads near-neutral.

**Water — the coverage range is NOT 0..1.** `buildWaterField` blurs with
`WFIELD_R=1` then floors real water tiles at `WFIELD_KEEP=0.52`, so a 2-3 tile
river sits at roughly **0.52-0.75 across its whole width** and never approaches
1.0. Both the foam band (was 0.50-0.94) and the depth ramp (was 0.34-0.90) were
written assuming open water reaches ~1.0, which put the *entire river* inside
the foam band — it rendered white like pack ice. Now foam is 0.16-0.54 (i.e.
below the 0.5 contour, on the shallow ramp) and depth is 0.30-0.66. Anything
else keyed off coverage must respect this range.

**Gotchas paid for the hard way:**
- **A raw `ShaderMaterial` with `fog: true` MUST merge `THREE.UniformsLib.fog`.**
  `refreshFogUniforms()` reaches for `uniforms.fogColor.value` with no guard, so
  the `<fog_*>` chunks alone throw once per draw per frame, which aborts the
  render loop and leaves **the entire canvas black**. Cost an hour; the symptom
  looks nothing like the cause.
- **Lighting is now triple-counted if you're not careful.** `AmbientLight` was
  0.65 purely to fake skylight when nothing received IBL. With a real sky env
  map that double-counts and blows the scene out. Now `DAY_AMB = 0.20`,
  `_envIntensity` scaled to `0.10 + 0.42*dayF`, exposure 1.25 → 0.85. Only the
  DAY end moved — at night `dayF` is 0, so the tuned new-moon 0.09 / full-moon
  0.34 values are unchanged.
- **`#headless` poisons the quality watchdog.** Its 33ms `setTimeout` is above
  the 22ms demote threshold, so the harness reads as a slow GPU and silently
  turned shadows off mid-test. `frameTick` is now skipped under `HEADLESS`.
  Corollary: **framerate numbers from `#headless` are meaningless** (~30fps cap).
- **`Object3D.lookAt()` swaps its arguments for non-camera/non-light objects.**
  A plain Object3D points **+Z** at the target. Used as a light-space proxy it
  put every frustum corner at positive Z and pinned the shadow `far` to its
  floor. Use `Matrix4.lookAt()`, which uses the camera convention.
- **`composer.rebuild()` cannot resurrect a passthrough** — the addons are
  dynamically imported, so low→high must re-`await createComposer`. Without it,
  one trip through `low` (which the watchdog can do by itself) left the session
  permanently unable to get bloom or AA back.
- **This machine's browser reports `Intel(R) UHD Graphics`**, so auto-detect
  picks `medium`, not `high`. Measured ~29fps / 34.7ms at `high` with the
  composer on. The 50fps merge gate in the plan is not currently met.

- **Terrain macro variation.** The baked ground canvas is 8px/tile, so it has
  tile-scale colour but nothing at landscape scale — a field read as flat felt.
  `terrMesh.material.onBeforeCompile` now modulates albedo with low-frequency
  value noise (~1 cycle per 40 tiles) plus a warm/cool hue swing, which is the
  part that actually sells it; pure value variation still reads as noise over
  paint. Costs no memory and no texture fetch. `_dev.macro(n)`, default 0.35.

- **Instanced grass** (`js/render/grass.js` + the pool in game3d.js). Pooled and
  re-windowed around the player like the trees. Wind is applied in
  `<project_vertex>` **after** `instanceMatrix`, deliberately — each blade has a
  random Y rotation, so bending in blade-local space pushes every blade a
  different way and reads as jitter rather than wind. Blades receive shadows but
  do **not** cast them (an alpha-tested depth pass over 180k blades costs a
  fortune and buys ground noise). `_dev.grass({wind,gust,rebuild})`.
  - **Two things made this work, and both were failures first.** (1) Density:
    at 34 blades/tile it read as scattered weeds on a lawn, which is worse than
    no grass because it advertises the flat ground it fails to hide. 120/tile is
    where blades overlap and the eye stops resolving them. (2) **The placement
    hash.** The first one multiplied by big constants in float arithmetic and
    only then applied 32-bit bitwise ops, truncating the entropy — consecutive
    blade indices came out correlated and the field rendered as discrete tufts
    on a visible lattice. Use `Math.imul` throughout. This looked like a density
    bug and was not one.
  - Rim blending fades blade **height**, not just density. Thinning density
    alone ends in a ring of full-height blades against bare ground.

- **Per-tree variation** in `rebuildTrees`. Trees are one per tile, so without
  it a forest is a rectangular lattice of clones. Position jitter, girth, height
  and Y-spin are all hashed from the TILE (not `Math.random()`) — `rebuildTrees`
  re-runs every time the window slides, so anything non-deterministic makes the
  whole forest twitch as you walk. Jitter stays under a third of a tile so the
  trunk remains in the tile that blocks movement; **collision is tile-based and
  is deliberately not jittered**.
- **Emissive stripped from prop materials that have no `emissiveMap`.** These
  GLBs ship `emissive=#ffffff` at full intensity and `simplifyPropMaterial`
  strips the emissiveMap meant to mask it, so models were **100% self-lit** —
  NPCs stood at full daylight saturation in a pitch-black midnight city because
  they weren't being lit at all, they were emitting. Keeping emissive was a
  workaround for these exports rendering near-black under the old two-light rig;
  with a real sky and IBL it costs more than it buys. Materials that genuinely
  glow keep their `emissiveMap` and are untouched (19 remain, correctly).

- **VIEW-CONE CULLING** replaced the radial instance window. The old circle
  centred on the player spent ~half its budget on ground behind the camera that
  is never drawn. `updateViewCone` / `tileInView` build a wedge aligned to the
  camera heading, and the recovered budget goes into reach: grass radius went
  21 → 38 tiles at ultra.
  - A cone test, not six frustum planes — this camera always looks at the player
    across near-flat ground, so an angle test plus a distance cap captures the
    same set far cheaper. `VIEW_MARGIN` (0.42 rad) is the safety slack.
  - **`camera.fov` is VERTICAL.** It must go through `aspect` to get the
    horizontal half-angle; using it directly gives a wedge far too narrow on a
    wide window and clips scenery at the screen edges.
  - **A near bubble around the PLAYER is always resident** (`VIEW_NEAR_TILES`),
    regardless of angle — otherwise spinning the camera strips the props you're
    standing next to, and things behind you still cast shadows into frame.
  - **Turning the camera must re-window.** The window now depends on where the
    camera looks, so `updateObstacles` triggers on heading and zoom change as
    well as position. Threshold is coarse (~11°) because the wedge carries
    margin; rebuilding on every mouse tremor reintroduces the stutter the
    staggered rebuild exists to avoid.
  - **Grass is distance-banded** (BOTW-style layering). Calibration trap: the
    first pass used 1.00/0.55/0.28/0.14 and rendered as a *rug* — past ~60% of
    the radius, sparse blades plus shortened height left nothing visible and the
    field ended on a hard rim in clear view. Perspective already thins the far
    field for free, so the bands must fall much more slowly than intuition
    suggests. Now 1.00/0.78/0.52/0.34, with the height falloff held back to
    dr>0.86 so only the last blades sink out.
  - Measured: 213k blades over a 38-tile radius at 144.9fps/6.9ms — same frame
    time as the old 182k blades over 21 tiles.
- **TERRAIN ELEVATION** (`js/render/terrain.js`). The ground was one flat plane
  at y=0 and everything in the game assumed it.
  - **Elevation is purely VISUAL. Collision is untouched and still 2D.**
    `boxBlocked`, the tile map, the server's `walkB64` bitmap and every
    multiplayer position check work exactly as before. The field is
    deterministic from a fixed seed, so all clients derive identical ground with
    nothing synced. **Do not make collision height-aware without revisiting the
    server** — it validates x/z only.
  - Baked to a `Float32Array` grid once at boot, then sampled bilinearly.
    Not evaluated as noise per query: grass alone asks ~190k heights every time
    the instance window slides.
  - **`terrainFlatAt` is what makes it safe.** Water/bridge tiles flatten (the
    river is one flat quad — slope under it and it clips through its own banks),
    the city flattens (buildings are axis-aligned boxes that would hover at one
    corner), and caves/dungeon flatten. Each fades over a few tiles. The hard
    flatten is re-applied AFTER the smoothing blur, because the blur bleeds
    relief back in and tilts the water plane by a few units.
  - **Relief is amplitude ÷ wavelength, and both must move together.** 96 over a
    46-tile wavelength gave gradients so gentle the surface normal never left
    vertical: the ground moved but read as flat and the slope-based rock
    blending never triggered anywhere. Now 210 over ~29 tiles.
  - Slope/height texture blending patches `terrMesh`'s shader. It passes
    **world** normal and height as custom varyings — three's own `vNormal` is in
    VIEW space, so its Y swings with the camera and hillsides would change
    material as you orbit.
  - Cost: 142.9fps/7.0ms, identical before and after.
  - **⚠ NOT YET WIRED to `heightAt` — these still assume y=0 and will float or
    sink on slopes:** placed objects (campfires/torches/lanterns and their
    flames), dropped loot, boss telegraph ground decals, house props/doors/signs,
    portals, altars, and the arch/cave-mouth props. Wired so far: terrain mesh,
    camera, grass, trees, stones/iron, walls, caves, mob + NPC + remote-player
    rigs.
- **Tree geometry** (`js/render/trees.js`). Was a cylinder plus one 9-sided
  cone. Now a 4-tier stacked-skirt conifer canopy and a trunk with a root flare.
  - **Both MERGE to a single BufferGeometry each** (`mergeGeometries`), which is
    the entire design constraint: `topMesh` is one InstancedMesh drawing the
    whole forest in one call, so building the canopy from separate meshes would
    multiply draw calls by the tier count. Merged, 4 tiers cost what 1 cone did
    — measured 142.9fps/7.0ms before and after, unchanged.
  - **Local-space convention is load-bearing.** The canopy is centred on the
    origin spanning `-height/2 .. +height/2`. game3d.js places it at
    `trunkHeight + canopyHeight/2` and the wind shader derives its bend weight
    from `(transformed.y + TOPH*0.5) / TOPH`. Move the origin and the tree still
    draws but bends from the wrong place, silently.
  - **Skirts must be WIDE AND FLAT.** First attempt used tier heights of
    0.46→0.33 of total height, making each tier a tall narrow cone; stacked,
    they read as a row of spikes, not trees. Now 0.34→0.26 and spread over the
    lower 62% (which also keeps the top tier inside the bounds the wind shader
    assumes). A conifer's whorls are shallow — horizontal spread makes the
    silhouette.
  - `roughenCone` perturbs rings on the GEOMETRY, not in a shader, so the ragged
    outline survives into the shadow and depth passes.
- **Clouds** (`sky.js`). Camera-following dome carrying animated fbm, projected
  through `vDir.xz / vDir.y` so they compress toward the horizon instead of
  tiling flat across the dome. A dome, not a plane: this camera pitches to near
  ground level and a plane's edge would swing into frame as a straight line.
  Tinted from the same horizon colour that drives fog, so they go amber at dusk
  with everything else. `_dev.clouds(n)`, 0 = clear, 1 = overcast.
  - **Two calibration traps, both hit.** (1) Coverage threshold: this fbm sums
    amplitudes to a 0.97 max with a mean near 0.48, so the obvious
    `smoothstep(1.0 - cover, …)` put the cut out in the tail and discarded
    essentially every pixel — the sky stayed empty and looked like the layer
    wasn't running. Map coverage onto the band the noise actually occupies.
    (2) Brightness: started at 0.55 lit / 0.32 core, which made every cloud
    *darker* than the sky behind it and read as smog. Daylit cumulus are
    brighter than the sky; only deep cores go grey.
  - The horizon fade must stay shallow (`smoothstep(0.010, 0.11, vDir.y)`).
    Fading from 0.30 pushed the whole layer above the top of the frame, because
    this camera can never pitch up to look at the zenith.
- **HDR flame glow** (`hdrGlow`, `FLAME_GAIN = 2.6`). 0xffa040 converts to about
  (1.0, 0.36, 0.05) linear, so its brightest channel landed exactly ON the bloom
  threshold and flames barely glowed — a lit torch at midnight looked like an
  orange sticker. The scene renders to a half-float target, so values above 1
  are legal and pushing emitters past the threshold is the whole point of bloom.
  **Only ever apply to additive emitters** — doing it to a lit surface just
  blows the surface out.
- **Dusk warmth.** `horizonF` in sky.js divided the sun's elevation by 0.30,
  which meant that at 19:00 — sun at y=0.24, about 14 degrees, unmistakably
  golden hour — `horizonF` was only 0.20 and the warm ramp was effectively off.
  The whole 18:00-20:00 dusk window sampled a near-neutral horizon. Divisor is
  now 0.55. Verified horizon by hour: noon `[0.56,0.74,0.89]` blue → 18:00
  `[0.74,0.86,0.91]` cool → 19:00 `[1.21,1.17,1.00]` warm → 20:00
  `[0.32,0.16,0.08]` deep amber. Noon still clamps to 0 and is unchanged.
- **GTAO now excludes FX from its normal/depth prepass** (301 meshes). `fxGroup`
  in game3d.js is **not a real THREE.Group** — it's an object exposing only
  `.visible`, which is the entire contract composer.js uses. Reparenting ~300
  meshes created across dozens of sites would have touched far more code and
  reordered the transparent queue as a side effect. The list is built by scene
  traversal (`refreshFxList`), so effects added later are picked up without
  anyone remembering to register them.
  - Filter is **`blending === AdditiveBlending`, deliberately not
    `transparent`** — the ~2400 character-rig materials are transparent but are
    solid figures that SHOULD occlude, so filtering on transparency would drop
    every NPC out of AO.

**⚠ NOT A BUG — the red cast on stone at night is Vampire Night Vision.** A
review flagged it as a rendering fault. It is `playerLight` at `#e06075`,
intensity 0.85, radius 14 tiles, switched on by
`player.race === 'Vampire'` in `updateEnvironmentCycle` — the character's
documented racial trait. Do not "fix" it. It only looks like a lighting bug
because the test character (Gideon Bloodfang) is a vampire; roll a human and it
disappears.

**GPU — RESOLVED.** This is a hybrid laptop: RTX 2050 + Intel UHD. The browser
defaulted to the iGPU and rendered at ~20-24fps. `powerPreference:
'high-performance'` is set on the renderer **and** the tier-detect probe
context, but it is only a hint — the actual fix was the OS setting
(**Settings > System > Display > Graphics > [app] > High performance**).
**Confirm with `_dev.gpu()` before trusting any perf number**; anything measured
on the Intel path is a floor, not a reading.

**Measured on the RTX 2050** (freeze 11:00, tile 280,200, open country):
| tier | passes | blades | fps / frame |
|---|---|---|---|
| high | Render+Bloom+Output+SMAA | 75,385 | 144.9 / 6.9ms |
| ultra | Render+**GTAO**+Bloom+Output+SMAA | 182,100 | 142.9 / 7.0ms |

Both are vsync-capped at 144Hz, i.e. there is real headroom left at ultra. The
plan's original 50fps merge gate is comfortably met.

**Not started:** GTAO (needs the additive-FX reparent under an `fxGroup` — the
plan assumed ~8 materials, the real count is **297 additive meshes**).

**Open, from the critic pass (verify each before acting — one of its findings
was a misdiagnosis):** characters reportedly don't attenuate at night while the
world goes black; masonry reportedly picks up a red cast at night (suspicious,
since night ambient `0x0c102b` is blue, so the stated cause can't be right);
dusk reads neutral where it should be amber; the forest is a visible rectangular
grid of identical clones (cheap fix: jitter position/rotation/scale per
instance). Its claim that `calls:1, tris:1` means "dead instrumentation" is
**wrong** — that's `renderer.info` reflecting the composer's final fullscreen
pass, which is expected once EffectComposer is in play.

---

## Current state (works, in-game, verified)

### Rendering / assets
- **20 new GLB models integrated** (armor, jester, wizard, campfire/torch/lantern, arrows, backpack). All compressed (Draco + WebP, ~5.2 MB total). Originals backed up outside the repo in `../models_backup_originals/`.
- AI-model exports render **near-black** under this game's simple lighting — `simplifyPropMaterial()` strips metalness/roughness/normal maps and keeps albedo+emissive. Apply it to any future model from that generator.
- **NPCs**: Wizzard → Mage shop, Jester → busks in the courtyard cycling dance clips.
- **Ground Restoration & Smooth River Shorelines**:
  - **Ground Color Restored (actually fixed 2026-07-25)**: `buildTerrainImage()` filled R/G/B into a `createImageData` buffer but **never wrote `d[i+3]`**. `createImageData` returns *transparent* black, so `putImageData` stamped the whole 3840×4432 terrain canvas at alpha 0 and the ground sampled as pure black. Now sets `d[i+3]=255`. Verified in-page (alpha 0→255, colours 0,0,0 → grass `54,98,41` / path `98,122,63`) **and visually at noon**.
    ⚠ The earlier note here — "removed self-`drawImage` call" — was a **misdiagnosis**; that removal never addressed the alpha. Classic case of the "verify handoff claims" gotcha below.
    The other three `createImageData` sites (`buildMiniImage`, `normalFromTex`, `_bakeLootThumb`) all set alpha correctly — terrain was the only one.
  - ~~**Smooth Diagonal Rivers**: shoreline tiles scaled to `1.32x`~~ — **superseded 2026-07-25** by the warp/mask system below. Scaling square quads only overlapped the corners; the silhouette was still squares.
  - **Per-Mob Motion Tracking (Jitter-Free Wolf Animations)**: Attached `_lx`, `_lz`, and `_atkUntil` directly to individual mob objects (`e`) in `animModel()`. Eliminates cross-mob pool slot distance calculations, making wolf movement and galloping 100% silk smooth.
  - **Gait rate-matching (2026-07-25)**: `animModel()` set `walk.timeScale` from `e.speed` — the *configured max* in `ENEMY_CFG`, a constant. A wolf (speed 140) played its gallop at a fixed **1.75× always**: sprinting at 140 u/s, wandering at `speed*0.38` (~53 u/s), or stopped dead against geometry. Legs sprinted while it crossed a couple of tiles.
    Now tracks real ground speed from the per-frame displacement `animModel` already computes (`dist/adt`), smoothed with a 0.25 EMA onto **`e._spd`**, and drives `timeScale` off that. Frames after a cull/teleport (`dist >= TILE*3`) are skipped so a re-entry jump can't read as a sprint.
    Verified by driving a wolf at known speeds (measured within ~3%): **53→0.67, 90→1.16, 140→1.73** (all were 1.75). Full sprint unchanged, so the chase reads the same; only slow gaits are corrected.
    **`GAIT_REF`** (the speed that plays at 1.0×, default 80) is tunable live: **`_dev.gait(110)`** raises it (slower legs), `_dev.gait()` reports `GAIT_REF` plus actual speed + timeScale per nearby mob.
- **De-blockified terrain — warped boundaries + mask-driven water (2026-07-25, Headline)**:
  The grid made every path edge and river bank a run of axis-aligned 90° steps. Both causes now go through **one shared warp field**, so a river's painted bank and its 3D surface agree exactly.
  - **Ground**: `paintTerrainRegion()` (was `buildTerrainImage`) no longer paints tile squares — it displaces the *lookup*. Each pixel asks which tile sits at its position pushed by a two-octave noise field (`_warpedTileAt`): broad 9-tile meander + 3-tile wander + per-pixel raggedness.
  - **Excluded from warping**: structural tiles (`WALL/TREE/STONE/ORE/CAVE_WALL`, via `_isSoft`) and any tile carrying a custom `groundStamps` pixel-art skin. Their 3D meshes are pinned to the grid — warping their paint slides it off the geometry. This is why buildings and bridges stay crisp.
  - **Water**: was one square quad per tile (`InstancedMesh`). Now **a single quad covering the render window**, shaped entirely by an alpha coverage mask (`wMaskCanvas`, 4 texels/tile). 1 draw call instead of thousands of instances.
  - **The 45° staircase needed more than warping** — those steps are a whole tile, and noise can only wobble them. The mask samples a **blurred water field** (`buildWaterField`) whose 0.5 contour is a smooth diagonal, *then* warps that contour.
  - ⚠ **Blur-then-threshold erodes thin features.** Measured: 0.6% of water tiles (41/6405) fall below the contour. Rather than weaken the blur, real water tiles are floored at `WFIELD_KEEP=0.52` — corners still round off, but a water tile can never render dry. **This is not cosmetic**: `map`/collision are untouched, so a visual gap would be water you still can't walk through.
  - **Editor-safe**: `paintTerrainRegion`/`paintWaterMask` are region-capable, and `updateTerrPx` repaints the neighbourhood the warp reaches (plus rebuilds the water field) instead of stamping one hard square into terrain that curves around it.
  - **Tune live**: `_dev.warp({ampC:0.8, ampF:0.4, cellC:12, cellF:3, hash:0.1})` re-bakes in place (~1s) and reports `reachTiles`. Raising amplitudes wanders further but starts breaking up 1-tile features — **watch a narrow path while raising them**.
  - ⚠ **`WARP_R` must stay ≥ the real reach** (`ceil(ampC+ampF+hash)`); `_buildWarpGrids()` derives it. It sets the radius of the "interior" fast-path uniformity check — understate it and boundary tiles get misclassified as interior and clip.
  - Verified in-game at four sites (river bend, narrow 45° stretch, bridge crossing, city road junction). Load 480ms vs 494ms baseline, 49 fps, no console errors.
- **Organic World Smoothing (Anti-Blocky Upgrades)**:
  - **Stone Wall Masonry**: Applied seed-based height (+/- 2.5u), yaw rotation (+/- 0.08 rad), and position micro-jitter in `rebuildWalls()` and `rebuildCave()`. Stone walls look like natural hand-chiseled masonry rather than rigid square boxes.
  - **Soft Terrain Tile Boundaries**: Added 1-px canvas blur feathering on `terrCanvas` in `buildTerrainImage()`. Ground tile transitions (Grass, Dirt, Path, Sand, Mountain) blend seamlessly together into natural terrain without harsh square tile edges.
- **Server-Authoritative Placed Object Persistence & Pickup**:
  - The world server owns all placed items (`this.placedObjects`), persisted to `server/data/placed_objects.json`.
  - When players join or reconnect, the server streams all standing torches, lanterns, campfires, chests, forges, and structures (`client.send('placed_objects', ...)`).
  - Placing an item (RMB or build mode) emits `object_place` to the server, adding it to disk and syncing all players in real time.
  - Right-clicking an existing placed torch/lantern/object within range picks it up (`object_remove`), returning the item (`+1 torch`, `+1 lantern`, etc.) to inventory.
  - Attacking/breaking structures (`HP <= 0`) emits `object_remove` to the server and drops or returns the item.
  - Capped WebGL pixel ratio to `1.0` on mobile devices (`G.isTouch`), eliminating severe GPU fill-rate throttling on high-DPI phone screens.
  - Automatically disabled WebGL directional light shadows on mobile boot (`renderer.shadowMap.enabled = !G.isTouch`), eliminating shadow depth map passes on mobile GPUs.
  - Reduced mobile mob cull radius (`RD`) to `1200` (~25 tiles) and animation LOD radius (`AD`) to `600` (~12 tiles) in `syncEntities()`.
  - Fixed touch event routing in `touchstart` so touches on open modal panels always `continue` and never fall through to activate movement or attack triggers (`action.active`).
  - Guarded `doAttack()` calls in `update()` with `!uiBlocking() && !modalOpen()`, guaranteeing no attacks can occur while character sheets, select screens, or any menus are open.
  - Fixed responsive portrait scaling in `char_creator.js` (`vw < vh`) and adjusted portrait design height to `640`, ensuring character selection cards and buttons fit legibly on mobile screens.
- **Engine & Shadow Performance Optimization**:
  - Reverted experimental sun matrix throttling to restore 100% solid lighting and rendering on PC and mobile devices.
  - Replaced heavy `PCFSoftShadowMap` with standard `PCFShadowMap` (5x-10x faster shadow pass rendering).
  - Disabled `moon.castShadow` (eliminated 2nd shadow map pass per frame).
  - Tightened `sun.shadow.camera` frustum (-1200 to 1200) and tracked `sun.target` to `player` coordinates, concentrating shadow map resolution around the player.
  - Reduced `OBS_WIN` instancing window from `56` to `32` tiles (67% reduction in grid loop iterations from 12,769 to 4,225 per rebuild).
  - Capped pixel ratio to `1.5` on 4K/high-DPI monitors (`1.0` on mobile).
  - Replaced software 2D `ctx.filter` API calls in the UI canvas with lightweight RGBA translucent fills.
  - Added `window.toggleShadows()` and a **"Shadows: ON/OFF"** dev panel toggle.
  - Reduced `OBS_WIN` instancing window from `56` to `32` tiles (67% reduction in grid loop iterations from 12,769 to 4,225 per rebuild).
  - Capped pixel ratio to `1.5` on 4K/high-DPI monitors.
  - Replaced software 2D `ctx.filter` API calls in the UI canvas with lightweight RGBA translucent fills.
  - Added `window.toggleShadows()` and a **"Shadows: ON/OFF"** dev panel toggle.
- **Stained Glass Performance Optimization**: Removed the automatic instanced stained glass window mesh updates on city wall faces (`rebuildWindows()` and related Three.js textures/materials) which was causing severe frame rate lag. Replaced this with a manually placeable **Stained Glass** custom block type (`T.STAINED_GLASS = 12`) added to both the game code and map editor palettes, rendering as a semi-transparent colored 3D block.

### Object scale — `OBJ_SCALE` and what still hasn't caught up (2026-07-25)
- `OBJ_SCALE = 2` is the global knob (`game3d.js` ~line 428). It was applied to the hero, mobs, NPCs, trees, walls and rocks — **but not to placed props**, so anything with a hardcoded size is still at half the intended scale against the 126u character.
- **Fixed this session**: `CAVEH` 86u → **`WALL_H` (168u)** — dungeon walls sat below head height, so a cave read as floor pattern rather than rock (same mistake the city walls had before 168). Stained glass 41u → `WALL_H`; it's a wall material.
- **Occlusion was checked, not assumed**: a 168u wall hides ~2.2 tiles toward the camera vs ~1.1 at 86u, and dungeon corridors are much tighter than city streets. Only **28 of 12,523** cave floor tiles are 1-wide pinch points (0.2%), and standing on the worst case (wall directly N *and* S) the character still clears the wall top — same as the city already behaves. ⚠ If `CAM_H`/`CAM_D` (1100/700, ~57.5°) is ever flattened, re-check this: the head clears by only a few units.
- **DECISION (owner, 2026-07-25): scale props individually — no bulk `OBJ_SCALE` pass.** Size each against `CHAR_H` deliberately and note the number.
- ✅ **Backlog cleared (2026-07-25).** The reference scale: **`CHAR_H` 126u = a ~1.8m person, so 1m ≈ 70u.** Every `PLACEABLES` row now carries a `scale` plus a comment naming the real-world size it targets — campfire ×3.0 (0.86m across) · workbench ×3.5 (1.6×0.7m) · forge ×3.0 (1.37×1.03m) · chest ×3.0 (0.94×0.51m) · torch ×1.6 (0.64m, 27% of a wall) · hearth ×3.5 (1.2×1m) · anvil ×2.2 (0.57m) · lantern ×3.0 (0.34m). World treasure chests aren't in the registry (map features) so they carry their own **×2.6** in `rebuildWorldChests`.
- `scale` moves the mesh, its mount height *and* its flame offset together, so a resize is genuinely one number: `_dev.placeScale(type, n)`.
- ⚠ The **held** torch/lantern props are *not* these meshes — those are the procedural objects tuned via the Gear Tuner into `WEAPON_ADJUST` (scales ~1.5–3, not 20–40, because they aren't GLB imports). Changing a placed prop's scale does nothing to the carried one, and vice versa.
- ⚠ **Load time in a no-server environment reads ~2.9s, and it is not the bake.** A Colyseus room join runs during module eval and blocks ~2.3s when nothing is listening (`net.status` stuck `connecting`). Subtract it before blaming a change — measure `performance.getEntriesByType('resource')` for the `bravo` entry. Real script time is ~500-650ms.
- **`STONE_R` is already scaled** (`TILE*0.28*OBJ_SCALE`) — don't double-scale it.

### Boss mechanics — telegraphed abilities (2026-07-25, Headline)
- `BOSS_ABILITIES` in `enemies.js`, keyed by `floorBoss` id. Design brief from the owner: **stronger abilities, hard unless you know the telegraph.** So every ability roots the boss, paints a danger zone, and lands a beat later — generous wind-ups (1.2–2.0s) precisely *because* the payloads are heavy (2–3× a normal hit).
  - **Gravebinder**: GRAVE SLAM (1.3s, circle locked where you stood, 2.2× + stun) · BONE CAGE (1.6s, 0.8× + 3s root) · MARROW QUAKE (2.0s, circle **on the boss** — run OUT, 2.8× + stun, only below 55% hp).
  - **Molloch**: PIERCING SHRIEK (1.2s, **lane** from boss through where you stood, 2.4× + stun) · PLAGUE WAVE (1.5s, on-boss circle, 2.0× + poison) · THE SWARM ANSWERS (summons 4, below 70% hp).
- `at:'player'` locks the zone where you were → step off it. `at:'self'` centres on the boss (`follow:true`) → get out of its reach. `shape:'line'` is a lane → step aside.
- **Counterplay**: a stun mid-wind-up **interrupts** the cast outright, so wrestling / Ground Slam trades a stun for a whole telegraph. Below 25% hp the boss enrages — tells ×0.75, cooldowns ×0.6.
- Telegraphs are flat meshes that **fill in as the cast completes** — opacity *is* the countdown. Plain meshes not instanced, because opacity varies per zone (`TG_POOL` of 4 each in `game3d.js`).
- ⚠ The hit test and the mesh must agree: the lane's `perp` uses `(-sin, cos)` of the cast angle, and the mesh sets `rotation.y = -ang` (since `rotation.y=θ` sends +X to `(cosθ,0,-sinθ)`). Change one and you must change the other or the zone lies about where it hits.
- **Bug fixed alongside**: activating a dungeon champion altar wiped every non-champ enemy in the dungeon box, and `spawnFloorBoss` sets `isChampBoss` **without** `isChamp` — so walking near a shrine deleted the floor boss. Cull now also skips `floorBoss`.
- Dev: `_dev.boss('gravebinder'|'molloch')` spawns one beside you (needs CAVE_FLOOR within 6 tiles — both bases are cave-spawn types), `_dev.cast()`, `_dev.forceCast(id, hold)` (hold pins the telegraph up for inspection), `_dev.resolveCast()`, `_dev.bossPicks(hpFrac)` (what the picker can choose at that hp), `_dev.bossHp(frac)`.
- ⚠ **Testing gotcha**: entering the game with a mouse click can leave the attack input held, and a geared test character then auto-swings a 1080 hp boss to death in ~10s. If a boss keeps "dying on its own", dispatch a `mouseup` before blaming the AI.

### Placeable objects — `PLACEABLES` registry (2026-07-25)
- **One row per placeable** (`game3d.js`, just above the dirty flags). Carries `mesh, y, scale, flame, light, invKey, refund, source, surfaces`. Placement, render, lighting, refunds and build labels all read from it.
- **Why**: each item used to be special-cased in *six* places — craft handler, `tryPlace`, two copy-pasted RMB blocks, `rebuildPlacedObjects`' if/else chain, the lighting filter, and `removePlacedObject`. Six edits per new item, and coverage had drifted: only torch/lantern were RMB-placeable, and **picking up a workbench/forge/chest/hearth/anvil refunded nothing at all** — destroyed for free.
- **Now**: every row refunds its full craft cost. ⚠ That makes place/remove **lossless** — a deliberate balance knob, tune per row if it turns out to be exploitable.
- `scale` is **per-item on purpose** (see the object-scale decision above): mesh height *and* flame offset ride that one number, so rescaling a prop is one edit. `_dev.placeScale('torch',2)` does it live.
- ⚠ `rebuildPlacedObjects` must mark **every** registry mesh each pass, including ones that drew nothing — a mesh that isn't marked keeps the previous window's instance count and leaves ghosts on screen.
- Dev: `_dev.placeables()` (all rows + what's on the map + any unknown types), `_dev.placeAt(type)`, `_dev.removePlaced(i)`, `_dev.placeScale(type,s)`.
- ✅ **Phase 2 done (2026-07-25)** — one placement path for all 8. The loop is now: **craft → pack → select on the hotbar (puts it in hand) → right-click to place → right-click in range to pick up**.
  - `placementBlocker(type,tx,ty)` is the single "can this go here" rule, shared by build mode and RMB (they used to disagree — a torch could sit on path, a workbench couldn't). Returns the *reason*, so the floater explains itself.
  - `placePlaceable()` is the single commit point: pack, world list, net sync and save happen together or not at all.
  - All 8 are in `BAG_ITEMS` + `ITEM_EQUIP`, so they drag to the hotbar with a count badge.
  - **Pickup returns the object, not its materials** (Phase 1 refunded materials). Lossless, but you can't cycle a forge back into stone.
  - Bugs fixed: crafting a workbench then pressing ESC **destroyed 5 planks + 3 stone** (cost spent, build mode cancelled, nothing placed); unbounded object stacking on one tile (pickup could only ever return the first); and `CAVE_FLOOR` is now a valid surface — you couldn't put a torch down in a dungeon before.
- ✅ **Phase 3 done (2026-07-25)** — torches + lanterns mount on walls (city walls, cave walls, glass), via `surfaces:['ground','wall']` + `wallY`.
  - **Face comes from the player's position, not the click.** The click ray hits the ground plane and never the wall, so the clicked point genuinely cannot tell faces apart. Stand north of a wall → north face.
  - Mount sits 21u out from tile centre at `WALL_H*0.62`, tilted `WALL_TILT` (0.45rad) out of the stone so it reads as a bracket. `placementSpot()` derives all of it; `FACE_DIR` maps face→outward vector.
  - **One mount per face, four per wall.** The occupancy half-extent (`TILE*0.4`) is under half a tile, so opposite faces (~42u) and adjacent (~21u/axis) both clear while a second on the same face is refused. ⚠ Don't widen it past ~0.43 or adjacent faces start colliding.
  - ⚠⚠ **A wall is NOT a neat axis-aligned half-tile block.** `rebuildCave` gives every block a **random yaw** (`n2*Math.PI*2`) plus scale (`TILE*0.96..1.04`) and position jitter (±1.5); `rebuildWalls` jitters too. Measured over 1140 cave-wall faces, the surface sits **23.3–35.1u** from tile centre — so the original flat `TILE/2-3 = 21u` mount buried **100%** of wall torches, some by 2u and some by 14u (fully swallowed). `wallSurfaceOffset()` mirrors the rebuild maths (half-extents, `|cos|`/`|sin|` of the yaw, jitter) so a bracket sits on *that* block's real surface, `WALL_GAP` (2.5u) proud. **If you ever change the wall/cave rebuild geometry, this function has to change with it** — it is a deliberate duplicate of that maths.
  - ⚠ **Clicks only ever hit the y=0 plane**, so aiming at a wall's visible face (metres up) used to resolve to the tile *behind* it — measured one tile off — and you had to aim at the wall's ground footprint instead. `pickWallTile()` raycasts the wall/cave/custom instanced meshes and maps `instanceId` back to a tile, the same trick `pickTreeTile` uses for canopies. Needs `wallInstTile`/`caveInstTile` filled during rebuild **and** a `computeBoundingSphere()` per rebuild, or the raycast early-outs on a stale sphere and silently misses. The clicked point also chooses the face, so you mount where you aimed.
  - ⚠ **Pickup is screen-space now** (`pickPlacedObject`). The old test compared object x/y to the click's *ground-plane* hit point, which is meaningless for something 104u up — measured, the ground ray lands **84u** from a wall torch and the old test found nothing. Ground-plane matching is kept as a fallback for non-wall objects (measured 9u off, still fine).
  - ⚠ **Two places rebuild placed objects field-by-field** and silently dropped the new data — server `object_place` (now whitelists `face`; whitelisted not spread, so clients can't inject fields) and client `net.onPlacedObjects`. `mountY` is derived from the registry, so only `face` crosses the wire. **If you add another per-object field, both of these need updating.**
  - Server `object_remove` radius tightened `TILE*1.5` → `12`: the old 72u was wider than the gap between two torches on opposite faces, so picking one up removed the other.
- ✅ **Phase 4 done (2026-07-25) — burnout.** Owner's spec: **torch** = 1 day then gone for good · **campfire** = 1 day then doused, relightable for 1 wood · **lantern** = never burns out.
  - **Fuel is derived, never ticked.** An object stamps `litAt` from `worldNow()` at placement; remaining = `fuelSec - (worldNow()-litAt)`. Because `worldNow()` is absolute and server-synced, every client computes the same answer with zero extra sync, it survives reload, works offline, and a torch lit 20 min ago is correctly dead on return. One day = `DAY_CYCLE_SEC` (1440s).
  - Registry field: `burn:{fuelSec, spent:'consume'|'douse', relight:{...}}`. No `burn` = eternal.
  - `sweepBurnouts()` runs every 2s; `isLit()` gates **both** the light pool and the flame blob, so a doused campfire actually goes dark. Flames gutter to 45% through the last tenth of fuel as a warning.
  - ⚠ **Relight must take precedence over pickup** on a spent object, and must count as *handled* even when you lack the wood — otherwise right-clicking to relight empty-handed silently pockets the campfire instead. Not a dead end: relight, then right-click again to pick the lit one up.
  - ⚠ **Objects saved before burnout existed have no `litAt`** and are deliberately treated as eternal (`burnRemaining` returns Infinity). Don't "fix" that to 0 or every pre-existing torch dies on first sweep.
  - `litAt` crosses the wire alongside `face` — same three sites as Phase 3.
- Dev: `_dev.burns()` (state of everything), `_dev.burn(i,sec)` (back-date so it expires in `sec`, negative = overdue), `_dev.sweep()`, `_dev.relight(i)`, `_dev.pickTest(i)`.
- Dev: `_dev.craft(id)`, `_dev.hold(type)`, `_dev.placeAt(type,dtx,dty)`, `_dev.placeBlocker(type,dtx,dty)`, `_dev.removePlaced(i)` — these drive the *real* functions, so a green result means the real path works.

### Worn armor (paper-doll)
- Only **helms, gorgets, chest pieces** render on the animated player (the limb pieces deformed badly worn — see "Lootable gear" below for where they went instead).
- Anchors: helm→head bone, gorget→neck, chest→spine. Gorget auto-pairs with the equipped chest tier.
- Tune placement live with the **Gear Tuner: press `P`**. Values live in `ARMOR_ADJUST` / `WEAPON_ADJUST` in `game3d.js`. "Copy Config JSON" exports both; paste back into those consts.

### Lootable gear (treasure, not worn)
- 6 pieces: `loot_arms, loot_gloves, loot_bgloves, loot_gauntlets, loot_greaves, loot_boots` (registry `LOOT_GEAR` in `game3d.js`).
- Drop from enemies (tiered chance in `enemies.js` `rollGearDrop`), render as **real 3D models on the ground**, show **rendered thumbnails** in pack/chest/corpse, and **sell from the pack near the merchant**.
- Live in `inv` as stackable keys; flow through `BAG_ITEMS`.

### ARPG progression (was a dormant scaffold; now wired)
- `js/loot_system.js` (leveling, rarity loot, gem sockets) + `js/char_creator.js` (account/char-select/creator) + `RACES/AFFIXES/GEMS/getXpForLevel` in `constants.js` were written by an earlier session but **not connected**. This session connected them:
  - **XP on kill** → levels (to 50) → +3 stat points, +1 skill point. `killXp()` scales off enemy toughness; ×2.2 champ, ×6 boss.
  - **STR/DEX/INT/VIT** + equipped **affix/gem** bonuses feed `meleeDmg()/arrowDmg()/recomputeDerivedStats()`. `_eqStats` cached, refreshed via `refreshEquipStats()`.
  - **Rarity loot** drops from kills (`rollArpgLoot`, source tiers boss/champ/elite/basic) as `{type:'arpg_item', item}` ground drops, tinted by rarity.
  - **Character sheet: press `L`** — level/XP bar, spend stat points, equip bag items, socket gems. `renderCharPanel` / `handleCharPanelClick`.
  - **Gems** drop as stackable currency (`ruby/sapphire/emerald/diamond`).

### Skill Level 10 Expansion & Perks (Headline Feature)
- **Skills extended from 5 to 10**: `XP_LEVELS` array extended to `[0, 100, 300, 700, 1500, 3000, 5500, 9000, 14000, 20000]`.
- All 5 core skills (Tactics, Archery, Hiding, Healing, Wrestling) now scale damage/healing/stuns up to level 10.
- **Level 6–10 Perks**:
  - **Tactics**: Master Stance (+10% Crit), Cleave (Arc attack), Executioner (+50% vs low HP), Whirlwind Mastery (360° Special & 4s CD), Weaponmaster (+25% Melee Dmg).
  - **Archery**: Eagle Eye (+15% Crit), Longshot (+30% Range/Speed), Piercing Volley (Pierces 3 targets), Rapid Fire (-40% Bow CD), Deadeye (2.5x Crit Dmg).
  - **Hiding**: Shadow Stalker (+20% Speed), Ambush (Guaranteed 2x Crit), Vanish (-5s CD), Smoke Screen (1.5s Stun on hide), Ghostwalker (1-hit Stealth Shield).
  - **Healing**: Quick Patch (-30% Bandage time), Rejuvenation (Instant +25% HP on apply), Purification (Cleanse Stuns/Webs), Field Medic (Out-of-combat Regen), Divine Grace (Death Ward CD 45s & 3s invulnerability).
  - **Wrestling**: Heavy Fists (+25% Dmg), Iron Grip (+1.5s Stun & Slow), Counter-Punch (20% Counter), Ground Slam (AOE Stun), Brawler's Might (Usable Armed & 6s CD).
- **Skill Panel (`K`)**: Displays level 1–10 progress, MAX level 10 badge, and active perk labels.

### Mithril (Tier 4) & Runic (Tier 5) Equipment Tiers (Headline Feature)
- **Weapon & Pickaxe Tiers**: Extended damage multipliers (`TIER_MULT = [0, 1, 1.3, 1.6, 2.0, 2.5]`). Pickaxe mining speeds scale up to 5x.
- **Armor Tiers & DR**: Mithril armor grants 14% DR per piece (56% set), Runic armor grants 18% DR per piece (72% set).
- **Visual Tints**: Applied cyan glow (`0x40e0ff`) for Mithril weapons & paper-doll armor, and purple glow (`0xdf80ff`) for Runic.
- **Economy & Crafting**:
  - `mithril_ore`, `mithril_ingot`, `runic_ore`, `runic_ingot` added to inventory & forge smelting.
  - Full crafting recipes added for Mithril & Runic Pickaxes, Swords, Bows, and Armor pieces.
  - Blacksmith NPC shop updated to offer Mithril and Runic upgrades.
  - Bosses (Goblin King, Troll Leader, Spider Queen, Piper) drop Mithril & Runic ingots.

### Multi-floor dungeon & named bosses (Headline Feature)
- **5 floors**, descended via stair tiles. Floor 1 is the original hand-authored sunken lake; floors 2–5 are generated room-and-corridor caves packed into the free `y490+` band either side of it (`DUNGEON_FLOORS` in `world.js`).
  1 The Sunken Warren · 2 Gnawed Tunnels · 3 **The Ossuary** (boss) · 4 The Fungal Deep · 5 **Molloch's Throne** (boss)
- **Generation is room-and-corridor, not cellular automata**, so floors are *guaranteed traversable* up-stair → down-stair. Verified by flood-fill: every floor fully connected (780–1500 walkable tiles, all stairs reachable).
- `DUNGEON_STAIRS` maps `"tx,ty" → {to, sx, sy}` — both directions wired (F1↔F2↔F3↔F4↔F5). Arrival lands one tile beside the target stair so you never spawn on a portal.
- **Named bosses** reuse existing AI/models with buffed stats + name + tint (no bespoke AI): *The Gravebinder* (troll_l base, 1080 HP / 87 dmg) on F3, *Ratking Molloch* (piper base) on F5. Flagged `isChampBoss` for boss-tier loot/XP; **one kill per save** via `G.floorBossesDown` (verified: flag set → no respawn; cleared → respawns).
- Boss kill pays **+250g bounty + champion tribute, an artifact skewed high-tier, and boss-table ARPG loot**.
- **Depth-gated loot**: `lootSourceFor()` upgrades the rarity table by depth — floor 2–3 trash rolls `elite`, floor 4+ rolls `champ`.
- HUD shows `💀 F3 THE OSSUARY`; `G.dungeonFloor` / `G.dungeonBest` persisted in the save.
- **Contracts wired to it**: new `delve` ("Reach dungeon floor N") and `floorboss` ("Slay The Gravebinder") templates, so the board actively sends players into the deep at higher tiers.

### World treasure chests (Headline Feature)
- **23 pre-placed chests** across the 5 dungeon floors (`WORLD_CHESTS` in `world.js`), including a **guaranteed hoard in each boss arena** (F3 tier-5, F5 tier-7). Positions are deterministic map features from the world seed — only the "already looted" flags (`G.chestsLooted`) go in the save.
- **Placement is validated, not assumed**: deep-floor chests sit in carved room interiors; floor 1's chests are chosen by *scanning* the hand-authored map for real `CAVE_FLOOR` tiles rather than hardcoded spots. Verified: 0 of 23 chests on a non-walkable tile.
- **Contents roll lazily on first open**, so a chest found at level 30 pays out for level 30 (not for whenever the world generated). Tier drives the table: gold, bandages/potions, iron→steel→mithril→runic ingots, gems, `LOOT_GEAR` treasure, and rolled ARPG items (`elite`/`champ`/`boss` source by depth; hoards roll 2).
  Verified: tier-7 hoard = 263g + mithril/runic ingots + diamond + gear + **2 Rare ARPG items**; a floor-1 chest = 112g.
- `[E]` opens a loot panel with **Take All**; emptied chests vanish from the world and stay looted across saves. `nearbyWorldChest()` picks the *closest* chest (chests can sit near each other).
- New **`chest` contract** ("Tomb Robber — loot N treasure chests underground").

### Stained-glass windows on buildings
- Wall faces that front open ground get an **arched (lancet) stained-glass window**: leaded panes in 8 glass colours, a rose motif at the apex, stone tracery and a sill. `drawStainedGlass()` renders both the day texture and the emissive mask from one function so the leadwork lines up exactly.
- **Sparse and level.** ~1 face in 4 (`_terrNoise > 0.26`), all at a fixed `WALL_H*0.56`. The first pass was ~55% at jittered heights and read as an office block — dense, uneven windows look like a bug, not architecture.
- **Glows in colour at night**: the emissive map carries the glass colours and `emissive` is near-white, so panes light up red/blue/gold rather than a uniform orange. Driven by `nightFactor`.
- Own instanced mesh rebuilt alongside `rebuildWalls`; placement is a **deterministic hash of tile+face**, so windows never flicker or reshuffle as the render window slides.
- **Player-placed walls are skipped** — those get used as fences and keeps, and punching windows in them unasked would be worse than plain.

### Shared world clock (server-authoritative time)
- `G.gameTime` was a **per-session counter starting at 0**, so every browser began its own day at 00:00 on load — two players side by side saw different skies, and a reload reset your day.
- Now derived from **wall-clock seconds** (`worldNow()` = `Date.now()/1000 + worldTimeOffset + _timeShift`), re-derived every frame. Epoch seconds tick at exactly the rate the cycle wants (`DAY_CYCLE_SEC` real seconds = one game day) and, being absolute, make the **moon phase agree for everyone** too.
- **Server is authoritative**: `bravo-room.js` sends `worldtime {t}` on join and re-broadcasts every 60s (drift from sleeping tabs / clock skew). Client adopts it via `net.onWorldTime` → `setServerWorldTime()`.
- Offline play still works — offset stays 0, so the clock is local wall time.
- Dev day/night + moon buttons now shift `_timeShift` instead of assigning `gameTime` (a direct write would be overwritten next frame). **`window.advanceMoon` was referenced by the dev panel but never defined — clicking it threw**; now implemented.
- Verified: fresh load reads 07:51 not 00:00; a simulated server 3h ahead is adopted exactly; dev shift of +720s persists across frames.
- ⚠ **Assigning `_dev.G.gameTime` no longer does anything** — it's re-derived every frame. Use **`_dev.setHour(22)`** to jump to a time of day, or `window.toggleTime()` / `window.advanceMoon()`.

### Textures & building height ⚠ NEEDS VISUAL SIGN-OFF
- **All obstacle textures regenerated at 256²** (were 64²) with tiling fBm weathering + a **normal map derived from each texture's own luminance** (`normalFromTex`, Sobel on luminance). Walls/rocks/caves/trees moved from `MeshLambertMaterial` to `MeshStandardMaterial` so they use those normals and the new env map.
  - **wall** — cut ashlar with bevelled block edges (lit top/left, shadowed bottom/right), damp streaks. This bevel is what makes it read as carved stone rather than a painted grid.
  - **cave** — clustered lumps with top-lit lips · **rock** — mottled granite, mica flecks, fissures with a lit lower lip
  - **bark** (new) — vertical fissured ridges · **foliage** (new) — clumped needle masses. Trees previously had *no texture at all*, just flat brown/green.
  - **ground** — the terrain colour is one baked ~3840² canvas (too big to re-bake), so a fine tiling **detail normal map** is laid over it instead (`groundNrm`, repeats ~3 tiles).
- **`WALL_H` 91 → 168.** It was *below* `CHAR_H` (126), so you looked straight over every building and the city read as low boxes. Now a storey and a half. `wallTex` repeats 1.75× vertically to keep courses square (~16u, matching block width) instead of smearing.
- Falling-tree actors share the bark/leaf maps; their tint was switched to white (colour multiplies the map, so the old flat hexes would have darkened it).
- `_dev.texProbe()` reports size/contrast per texture + WALL_H vs CHAR_H.
- ✅ **Visually signed off 2026-07-25** (city courtyard, noon): walls clearly overtop the character at a storey and a half, ashlar courses read as carved stone with visible bevels, ground/wall/grass all legible. Not yet eyeballed up close: bark/foliage on trees, rock fissures, and the cave texture.

### Rendering pipeline — PBR environment & tone mapping ⚠ NEEDS VISUAL SIGN-OFF
- **The game had no `scene.environment`**, so every `MeshStandardMaterial` with metalness had nothing to reflect and metal rendered flat black. That's why `simplifyPropMaterial()` used to strip the metalness/roughness/normal maps off every GLB import. Root cause, not taste.
- Added: **ACES Filmic tone mapping** (`toneMappingExposure` 1.25 to compensate for its darker midtones), and a **PMREM environment** built from a procedural sky/ground gradient (verified: 336×64 CubeUV texture).
- **IBL fades with the sky** so the new-moon darkness still reads: `envIntensity` = 1.0 at noon → 0.34 full-moon midnight → 0.12 new-moon midnight. Applied via a quantised scene walk (only runs when the value moves).
- `simplifyPropMaterial()` now **keeps** the PBR maps (that's the payoff) with metalness held at 0.70 so a fully-metal texel doesn't go pure mirror. Only Standard materials are affected — Lambert terrain/walls/trees are untouched, so the world's base look is unchanged.
- Loot thumbnails share the same env; brightness re-checked after the change (all still legible, mostly slightly brighter).
- **Tune live**: `_dev.gfx({exposure:1.4, metalness:0.5, roughness:0.7, env:0.8})`, or `_dev.gfx({toneMapping:'none'})` to A/B the whole thing. `_dev.sceneEnv()` inspects the map.
- ◐ **Partially signed off 2026-07-25**: at noon the scene is neither blown out nor muddy, so the 1.25 exposure is not obviously wrong. **Still wants a proper A/B** (`_dev.gfx({toneMapping:'none'})`) and a look at metal props under night lighting before it ships to testers.

### Tree chopping — lean & topple
- Trees no longer shrink or drop wood per hit. Each chop **leans** the standing tree further toward a fixed per-tile fall direction (`rebuildTrees`), and the felling blow drops the **whole log at once** (`TREE_WOOD=4`, matching the old 1/hit × 4) and spawns a **toppling actor** that pivots at the base, falls flat, rests, and fades (`spawnFallingTree`/`updateFallingTrees`, pool of 10). `depleteNode` tree branch reworked; ore still yields per swing.
- Verified: hits 1-3 give 0 wood, hit 4 gives +4 and clears the tile; the actor animates 0.26→1.57 rad (accelerating), base stays planted while the canopy swings from y=173 to y=0 ~179u out, then fades. `_dev.fellTree()/fallingTrees()/stepFalls()/probeFall()` for testing.

### Mobile / HUD ergonomics
- **Flick control (radial hotwell)** was pinned to one spot and crowded phone screens. Now: **long-press (450ms) the ◉ button to pick it up and drag it anywhere**; a normal press-and-flick still casts as before. Position + hidden state persist in `localStorage['bravoRadialPos_v1']`. Dev panel (`` ` ``) has **"Flick Ctrl: shown/HIDDEN"** to hide it outright (for when controller support lands) and **"Reset Flick Pos"**.
- **Character select** is authored at a fixed design size and uniformly scaled to fit, with a **portrait layout that stacks the two slots**. Hit rects are mapped design→screen after drawing, so clicks still line up. Verified all controls land inside the viewport at 375×812 and 1280×800.
- Movement-stick thumb zone widened on narrow screens (30% → 42% of width).

### Dev panel — five tabbed pages (`` ` `` to open, 2026-07-25)
- `DEV_PAGES` in `game3d.js`. **GIVE** (resources, +5 of every placeable) · **PLAYER** (god/revive/skills, tier-5 weapons, armor sets, teleports incl. dungeon, stat readouts) · **WORLD** (day/night, moon, 4 time presets, shadows, flick control, terrain rebake, texture/env probes) · **BUILD** (hold any of the 8 placeables then right-click to place, pick up / burn out / relight nearest) · **BOSS** (spawn either boss, force any of the 6 abilities, set hp incl. the 20% enrage line, kill, cast dump).
- **Adding a command = one entry** in the relevant page's `buttons()`. Panel height derives from the busiest page (`devPanelH`), so nothing clips or leaves dead space; labels auto-shrink to fit.
- `label` may be a **function** — that's how live state shows on the button (`Shadows: ON/OFF`, `Flick Ctrl: shown/HIDDEN`).
- Readouts go to the console as JSON via `devLog()`. ⚠ When a helper returns a plain sentence rather than JSON (e.g. `could not spawn at 326,359` — bosses need `CAVE_FLOOR` nearby), that sentence is shown on the floater instead, because it *is* the answer.
- Actions are wrapped in try/catch so a throwing helper reports rather than killing the click handler; clicks inside the panel no longer fall through and close it.

### Dev helpers (all in `game3d.js`)
- `window._dev` — `player, inv, G, skills, drops`, `simulateKill(type,opts)`, `spawnLoot(key)`, `equipBagItem(i)`, `setSkillXp(key, xp)`, `setTier(sword, bow, pick)`, `equipFullArmor(mat)`, `armorDR()`, `meleeDmg()/arrowDmg()`, `showArmorPiece/hideArmorPurpose`.
- `window._tune(key, {pos,rot,scale})` — nudge gear placement from the console.
- `model_viewer.html` — grid viewer for any GLB: `/model_viewer.html?m=Jester,Iron_Chest_Armor&cols=3`.

---

## Known gotchas / things that bit us
- **`constants.js` crash**: an unclosed object literal in `RACES` (missing `}`) took the whole game down (every module failed to import). If the game shows a blank page, syntax-check `constants.js` first: `node --input-type=module -e "import('./js/constants.js').then(()=>console.log('ok')).catch(e=>console.log(e.message))"`.
- **Naming collisions across sessions**: my char-panel `CHAR_W/CHAR_H` collided with the existing character-model-height `CHAR_H`. Renamed panel consts to `CHARP_W/CHARP_H`. Grep before adding top-level consts.
- **`state.js` is edited by multiple sessions** — merge its `player{}` and `G{}` carefully; both sessions add fields there.
- **Preview pane**: in some environments the browser tab backgrounds itself and pauses `requestAnimationFrame`, so screenshots time out and `_dev.G.gameTime` freezes. **If the pane is not displayed, the whole game loop is stopped** — you are not measuring a running game. Two ways through:
  1. Ask the human to display the Browser pane. Then rAF runs and screenshots work (confirmed 2026-07-25).
  2. Load `medieval_prototype.html#headless` — swaps rAF for `setTimeout(...,33)` so the loop runs in a hidden tab. **Caveat:** frame gaps spike to 78–85 ms under background throttling, which by itself makes animation look broken. Fine for logic/state checks, **useless for judging animation smoothness**.
- **Don't diagnose animation from `mixer._actions` weights.** `_actions` contains every action ever *created* by `clipAction()`, and an unplayed action still reports `getEffectiveWeight() === 1`. It looks exactly like "three clips blending at full weight". Filter on **`a.isRunning()`** or you will chase a bug that isn't there (this cost a session ~20 minutes).
- **Mob animation state lives on the pool slot, motion state lives on the enemy.** `inst.cur` + the `AnimationMixer` are per-slot (`slotModel[si]`), while `_lx/_lz/_spd/_atkUntil` are per-enemy. Slot index is just the position in the `enemies` array (`syncEntities`, ~line 8374), so **any splice from `enemies` shifts every later mob down a slot** and hands it the previous occupant's clip state. Same-type neighbours don't even trigger a `buildSlotModel` rebuild, so the crosstalk is silent. Not currently known to cause a visible bug, but it's the first place to look if mob animation desyncs again.
- **Polluted test save**: this session's testing left a **level-9 character with test gear + rank-7 contracts** in `localStorage['medievalSave_v06']`. For a clean tester run, delete that character slot on the select screen (trash icon).
- **Tier lookup arrays must stay in sync with the recipes** (this bit us hard). The Mithril/Runic session added crafting, shop entries and boss drops that set `swordTier/bowTier` to 4–5 and call `equipArmorPiece(5|6)`, but never extended the arrays those index into. Result: **every endgame weapon and armor piece silently produced `NaN`** damage / damage-reduction. Fixed by extending `TIER_NAMES`, `TIER_MULT`, `ARMOR_MATS`, `ARMOR_DR`, `ARMOR_COLS`. **If you add a tier, grep for every array indexed by that tier.**
- **Mining yield vs. speed**: ore is granted *per swing* while the node loses `dmgAmt` HP per swing, so scaling only `dmgAmt` makes better pickaxes yield *less* per node. `depleteNode()` now scales yield *and* damage together (same total ore, fewer swings). Verified: wooden = 5 swings/5 stone, runic = 1 swing/5 stone.
- **Verify handoff claims against the code.** Several items previously marked done here (cyan/purple tier tints, 5× pickaxe speed) were not actually implemented — the hex values appeared nowhere in the source. Spot-check before building on top of a "done" line.
- ✅ **FIXED — coloured squares on the ground under trees / rocks / ore.** Was: `TILE_COLORS`
  did double duty for the minimap (where a green blob for a tree is correct) *and* the 3D
  ground canvas (where it is not). Obstacle meshes don't cover their whole tile footprint, so
  the tile colour showed around the base as a hard square — tree `30,75,25`, stone
  `111,106,99`, and iron ore `2,2,2` because `TILE_COLORS` had no `ORE_IRON` entry and hit the
  `|| [0,0,0]` fallback.
  - **The fix, as predicted here, was not to warp them.** A tree stands *on grass*, so
    `buildGroundUnder()` runs a multi-source BFS out from every walkable tile and fills each
    obstacle tile with its **nearest ground type** into `groundUnder` (a `Uint16Array`).
    `paintTerrainRegion` paints `groundUnder`, never `map`. `TILE_COLORS` is untouched, so the
    minimap still shows a green blob per tree — and `ORE_IRON` gained an entry (`106,86,77`,
    matching `ironMesh`) so it's no longer a black dot there either.
  - **This also freed the warp.** No tile carries a structural colour on the ground any more,
    so boundaries can bend everywhere; the old `_isSoft` structural-exclusion no longer exists.
    (⚠ the de-blockify section above still mentions `_isSoft` — that text is stale.)
  - `buildGroundUnder()` is called at boot before the first bake, from `updateTerrPx` (so every
    chop / wall placement / respawn / editor edit re-derives it — it's a full-map BFS, but only
    a couple of ms), and from `_dev.warp()`.
  - **Verified 2026-08-08** by running the real painter source against the real generated map:
    tree/stone tiles bake to grass `79,122,58` (reference grass `79,122,58`); all **363** ore
    tiles are in caves and bake to `CAVE_FLOOR` `25,19,17`; **0 of 11,541** obstacle tiles paint
    their own obstacle colour. Runtime mutation holds too — growing a TREE, STONE then WALL on
    an open grass tile and chopping back leaves the ground at `78,121,57` throughout.
  - ⚠ Full-cover tiles (`WALL`/`CAVE_WALL`/`STAINED_GLASS`, via `_isFullCover`) take the flat
    fill and skip the per-pixel warp — their mesh hides the ground, and the BFS's Voronoi seams
    through solid rock would otherwise be treated as boundaries and cost the full warp for
    nothing. **Trees/rocks/ore are deliberately NOT full-cover**, which is the whole reason
    `groundUnder` exists. Don't add them to that set.

---

## Roadmap — where we're going (retention depth for testers)

Chosen direction (from the depth discussion): **contract board → progression ceiling → dungeon depth**. Contract board and Progression Ceiling are **done**. Remaining, in priority order:

1. ✅ **Raise the progression ceiling** (DONE):
   - ✅ Character levels 1→50 with attribute points.
   - ✅ **Skills extended to 10** with 25 unique perks (Cleave, Executioner, Piercing Volley, Ghostwalker, Ground Slam, Brawler's Might, etc.).
   - ✅ **Mithril (Tier 4) & Runic (Tier 5) tiers** added for weapons, armor, pickaxes, crafting recipes, Blacksmith shop, and boss drops.
2. ✅ **Dungeon depth & bosses** (DONE): 5 floors, generated + connectivity-verified, two named bosses, depth-gated loot, wired as `delve`/`floorboss` contract targets.
   ✅ **Boss mechanics added 2026-07-25** — see the section below; they're no longer just buffed stats.
3. ✅ **World loot chests** (DONE): 23 seeded chests + boss-arena hoards across the dungeon floors, lazily-rolled depth-scaled contents, Take-All panel, looted state saved, plus a `chest` contract. (Player-built secure chests are unchanged — these are separate world containers.)
4. *(Not selected, backlog)* Achievements & museum-collection meta for completionists.

### Systems that already exist but testers rarely find (surface them via contracts/quests)
- Champion altars (wave defense) · Museum Curator rotating artifact bounty · Antiquarian rotating shop · Gambit engine (rule-based auto-combat) · Housing.

---

## Conventions
- **End every session**: commit, then update this file's "Current state" + "Roadmap" with your stopping point.
- **Before big edits to `game3d.js`**: re-read the region right before editing (it's ~8k lines and shared).
- **Verify behavior**, not just load — drive the real flow (`_dev.simulateKill`, open the panel, check `localStorage`). Load-without-error ≠ works.
- New full-screen panels must be added to `uiBlocking()` and `modalOpen()`, get a render call in the draw list, and a click route in the mouse handler.
