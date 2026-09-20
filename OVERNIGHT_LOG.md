# Overnight work log

Every scheduled run is a **cold start** with no memory of previous runs. This file is the
only continuity between them. Read it first; append to it last.

## Ground rules for overnight runs

- **Do not touch the VPS.** No SSH mutations, no deploys, no nginx/ufw/pm2/systemd
  changes, no Cloudflare changes. Read-only SSH is fine for diagnosis. Production changes
  happen with Jessie awake, not at 03:00.
- **Do not commit or push.** Leave work as uncommitted local changes for review.
- **Do not delete `models_src/`** — it is the only copy of the original model exports.
- Work in small, self-contained increments that end in a verifiable state. Half-finished
  refactors across a cold-start boundary are worse than nothing.
- After any asset change: `npm run assets` must pass (bake → compare → verify).
- After any client JS change: `node --check` the file at minimum.
- If something is ambiguous or risky, **write it down here and stop** rather than guessing.

## Where things stand

Plan and full audit: https://claude.ai/code/artifact/6519ab30-9f4e-4b7e-ad0d-6f786f67e079

- **Phase 00 — security. DONE, deployed 2026-09-08.** Origin locked to Cloudflare ranges,
  SSH key-only, fail2ban, journald capped, nightly backups.
- **Phase 01 — caching/capacity. COMPLETE as of 2026-09-09.** Per-asset-class cache
  headers in `orion-platform/server/index.js:150`, 2 GB swap, maxClients 120, nginx
  worker_connections 4096. The Cloudflare Cache Rule is now deployed and **all models
  return `cf-cache-status: HIT`**; `index.html` correctly stays DYNAMIC so deploys still
  reach players. Nothing outstanding here.
  NOTE: models are edge-cached for 30 days now, so after re-baking a `.glb` it will not
  reach players until it is purged in Cloudflare (Custom Purge, not Purge Everything).
- **Phase 02 — asset pipeline. BUILT, not deployed.** `npm run assets`. Payload
  21.90 MB → 7.06 MB, VRAM ~922 MB → ~107 MB, all 39 models pass the integrity check.
  Baked models are sitting in `models/` awaiting Jessie's visual review before deploy.
- **Deploy scripts:** `deploy_to_vps.bat` was rewritten (it had been shipping to
  `/var/www/orion-syndicate`, which nothing has served since 2026-08-31).
  `VPS_GIT_PULL.bat` and `VPS_SETUP_AND_DEPLOY.bat` still point at that dead path and
  should not be used.

- **HOW THE CLIENT ACTUALLY DEPLOYS — read before touching `js/`.** The live client is a
  **build**, not a copy of this repo. `ORION_GUILD_WEBSITE_WORKING_FOLDER/orion-platform/
  games-src/medieval/build.mjs` copies this repo's `js/ models/ sounds/ img/`, then patches
  it: Orion account identity + ticket refresh into `net.js`, and vendored three.js / Draco /
  KTX2 / colyseus paths (platform CSP is `script-src 'self'`, so CDN imports are blocked).
  Each patch asserts its anchor matches **exactly once**, then the build verifies no
  localStorage identity and no external URLs survive.
  - **Keep this repo in "upstream" form**: bare `three` specifiers, CDN paths, and the
    localStorage identity in `net.js`. Those are the build's anchors. Pasting built output
    back into the repo destroys them and the build fails loudly.
  - `deploy_to_vps.bat` now runs: `npm run verify` → `npm run build` → upload the built
    tree. A failed build aborts before anything is uploaded.

## Next up — Phase 03, then 04

**Phase 03 — load path and loading screen** (client-only, safe to do overnight):
- Real loading screen gated on a "boot set", progress driven by a manifest.
- Split asset loading into boot set (blocks) vs stream set (background, low priority).
- Service worker → Cache Storage, so assets land once and never re-download.
- ~~Vendor three.js / Draco / KTX2 / colyseus.js~~ **ALREADY DONE** by `build.mjs` +
  `vendor.mjs`. Production has zero external dependencies. Do not redo this, and do NOT
  hardcode vendored paths into this repo — that breaks the build's patch anchors.

**Phase 04 — touch controls** (client-only, safe; requested 2026-09-09):
- **Touch cannot rotate the camera at all.** `camAngle`/`camPitch` are only set by the
  keyboard (`[`/`]`, game3d.js ~10261) and pointer-locked mouse (~8673). Pinch is bound to
  zoom only. One-finger drag on empty ground should orbit; two-finger vertical should pitch.
- **`[` and `]` are double-bound** — they cycle camera presets (~8178) AND rotate
  continuously (~10261). Fix this first or every preset change also spins the view.
- `applyMobileHudMode()` (~line 76) is a stub that only hides one hint element.
- Touch targets are phone-sized and fixed; a tablet needs them to track viewport size.

**Phase 05 — client render path** (client-only, safe):
- Apply the existing `RD`/`AD` culling from `syncEntities` to `syncRemotePlayers`
  in `js/game3d.js`.
- Re-enable `frustumCulled` on remote meshes; nameplate-only LOD past `RD`.
- Cap animated remotes at the nearest ~20; stop cloning materials per remote.

## Run history

<!-- Newest entry at the bottom. One short block per run: what changed, what was verified,
     what the next run should pick up, and anything that needs Jessie. -->

### 2026-09-08 — setup
Log created. Phases 00–02 complete as above.

### 2026-09-08 — Phase 03, part 1: boot loading screen (DONE, verified)
**Changed:**
- NEW `js/render/loading.js` — boot loading screen. Injects its own overlay DOM and CSS at
  runtime (deliberately: the local `medieval_prototype.html` and the deployed
  `games/medieval/index.html` have diverged, so shipping the screen inside `js/` reaches
  players without touching either HTML file).
- `js/game3d.js` — 3 edits: import at line 48; `createLoadingScreen` + pass its manager to
  `new GLTFLoader(bootScreen.manager)` at ~2981; `bootScreen.settle(...)` in the
  protagonist load callback at ~3317. Also `if (!SKINNING_OK) bootScreen.dismiss()`.
- NEW `.claude/launch.json` — static server on :8123 for local verification.

**Boot set is just `Protag_animations_basic.glb`.** Everything else (mobs, armour, NPCs,
horse) keeps the existing pop-in behaviour and streams behind the game.

**Verified in a real browser** at `http://localhost:8123/medieval_prototype.html`:
overlay appears at 0% "preparing the world…", reaches 100% "ready" at ~4.6 s, fades, and
removes itself from the DOM at ~4.8 s; game canvas live at 1280x720. `node --check` passes
on both files. One bug found and fixed during verification: `onProgress` kept firing for
background streams after dismissal and overwrote the final status text — now guarded.

**Next run should pick up Phase 03, part 2:**
- Service worker → Cache Storage, so assets land once and never re-download. This is the
  "standalone client without the client" item. Put it in `js/` and register it from
  `game3d.js` so no HTML edit is needed, same reasoning as above.
- Vendoring: local `medieval_prototype.html` still imports three@0.160.0 from **jsdelivr
  CDN**, but the deployed `index.html` already uses a vendored importmap and a `vendor/`
  directory exists on the server. Check what is already vendored before doing any work —
  this may be done already for players and only the local file is stale.
- Draco decoder is still loaded from `gstatic` and the KTX2 transcoder from `jsdelivr`
  (`js/game3d.js` ~2968–2973). Those are real third-party dependencies on the critical
  path in BOTH copies.

Then Phase 04 (remote-player culling in `syncRemotePlayers`), which is the highest-impact
remaining item.

### 2026-09-09 — multiplayer auth fixed; two open items closed; deploy pipeline corrected
**Root cause of "objects don't sync / torches never die":** the platform signed game
tickets with a key decoded as utf8 while the world server verified with the same string
decoded as hex — 64 bytes vs 32. **Every join was rejected** (`bad-ticket`), so everyone
was in single-player. Fixed in `orion-platform/server/auth.js` `loadSecret()` (hex is
decoded as hex); applied to the local working copy AND the VPS, backup at
`auth.js.pre-secretfix`. Verified live: `[bravo] + SuperUser` and `[net] online as SuperUser`.

**Closed both open items:**
- `js/game3d.js:7953` — `placedObjects` is no longer mirrored into the save blob while
  online (`net.status==='online'?undefined:...`), matching what `placedHouses` on the same
  line already did. Offline single-player still persists what it builds.
- Swept the 10 stamp-less immortal torches from `bravo-server/data/placed_objects.json`
  (backup `placed_objects.json.pre-sweep-*`), then restarted bravo so it reloaded.
  The campfire (has `litAt`) and workbench (no `burn` field, eternal by design) were kept.

**IMPORTANT correction:** an earlier attempt to "reconcile" this repo with production by
copying built files back into `js/` was WRONG and has been reverted. See the deploy
section above — the live client is a build, and this repo must stay in upstream form.
`npm run build` in `games-src/medieval` was run and succeeds: all 6 patches applied, 41
vendored files, loading screen included, baked models (7.06 MB) included.

**Next run:** Phase 04 touch controls (see above), starting with the `[`/`]` double-binding.

### 2026-09-09 — deployed loading screen + deferred connect + baked models
Ran the real pipeline (`npm run verify` -> `npm run build` -> upload built tree). Live now:
boot loading screen, network connect deferred until the boot screen lifts
(`bootScreen.whenReady`), the placedObjects save-blob fix, and the 7.06 MB baked models
on disk. **The baked models are NOT reaching players until Cloudflare is purged** — the
edge still had the 21.9 MB set (`wolf.glb` served 986,712 bytes vs 410,944 on disk).

### MOBILE / TABLET UX BACKLOG — reported by Jessie 2026-09-09 after playing on both
Priority order is roughly as listed. All client-only, all safe overnight.
1. **No sprint.** The left stick is single-speed. Convention: push past a radius threshold
   to sprint, or double-tap the stick. (`stick` in state.js:70; `stickVec()` game3d.js ~8329.)
2. **No viewpoint button.** Camera presets exist (`camera-modes.js`, cycled with `[`/`]`)
   but have no touch affordance. **`[` and `]` are also double-bound** — they cycle presets
   (~8178) AND rotate continuously (~10261). Fix the double-binding first.
   Touch cannot rotate the camera at all: `camAngle`/`camPitch` are keyboard+pointerlock only.
3. **Hotbar:** no configuration menu wanted — drag and drop instead. **Never show items the
   player does not have**, in the hotbar or the pack.
4. **Key legend at the top is pointless on touch** (no keyboard) and eats screen. Hide it
   whenever `G.isTouch`.
5. **No chat on touch.** Wanted: a button that focuses a real text input so the device's
   native keyboard (and its own voice-to-text) opens. Do NOT build custom speech recognition
   — the OS keyboard already provides it.
6. **Crafting menu is unusable on a phone** (fills the screen). Quest journal too. Both need
   device-appropriate sizing.
7. **Backpack should be a grid on mobile.** The button itself is good — keep it.
8. **All menus must be draggable by touch.**
9. **"Return to hub" and similar menu items are too crowded.**

Research already done (2026-09-09), apply it: WCAG 2.5.8 minimum target is 24x24 CSS px,
but **44x44 is the practical floor** — error rates are ~15% at 24px vs ~3% at 44px. iOS
says 44x44pt, Android 48x48dp. Landscape thumbs comfortably reach the lower-left and
lower-right quadrants only; keep primary controls radial from the grip and out of the
centre. Give every control a pressed state.

### 2026-09-09 — mobile item 1 shipped: touch HUD + camera keybinding
- `applyMobileHudMode()` rewritten (game3d.js ~76). It had been hiding `#hint`, an element
  that **does not exist in either page** — a no-op since it was written. Now it hides the
  keyboard-shortcut span in the `#hud` header, shrinks the version banner, and shrinks the
  platform `#orion-bar` ("Hub") on touch. Uses `matchMedia('(pointer: coarse)')` so it
  applies on first paint rather than after the first touchstart; re-runs on resize for
  orientation changes. Sets `body.touch-mode` for future CSS.
- **Fixed the `[`/`]` double-binding** (game3d.js ~10296): they now ONLY cycle camera
  presets. Rotation stays on `,`/`.` (and `<`/`>`), which is also now documented in the
  help panel — it never was.
- Verified in-browser at 375x812 with a coarse pointer: legend `display:none`, title 11px,
  `body.touch-mode` set. On desktop the legend stays `inline`. Deployed and confirmed live.

**Discovery for the hotbar item:** drag-and-drop onto/around the hotbar **already exists**
(help panel: "drag — pull bag items onto the hotbar, another cell to rearrange, or the
world to drop them; Shift = whole stack; drag a slot off the bar to unbind"). Touch is
forwarded to the canvas as synthetic mouse events (`_fwdMouse`), so it may already work on
a phone. Confirm with Jessie what feels menu-driven before rebuilding anything.

**Next:** sprint on the left stick + an on-screen viewpoint button.

### 2026-09-09 — hotbar/pack decluttered (mobile item 3), deployed
Jessie clarified: drag already works and should stay; what should go is the reorder MENU
and the pre-set/unowned entries. Done:
- **Removed the U-key hotbar loadout editor entirely** (71 lines): `renderHotbarEdit`,
  `handleHotbarEditClick`, `hotbarEditPanelXY`, `hbHit`, `HB_EDIT_W`, the `u` binding, the
  `uiBlocking`/`modalOpen` refs and `G.hotbarEditOpen` in state.js. Drag-and-drop already
  did everything it did. No dangling references remain.
- **Hotbar no longer draws unowned bindings.** They used to render ghosted at 0.3 alpha;
  now the slot is simply empty. The BINDING is kept, so the icon returns by itself when
  the item is acquired — nothing to re-bind.
- **Backpack lists only what is carried** (`packItems()` filters `n>0`). It used to list
  every one of ~28 item types at count 0.
- **Bug caught during this work:** `packReorder` spliced a VISIBLE-list index into
  `packOrderKeys()` (the full unfiltered list). Those were the same length before the
  filter; afterwards a drag would drop the item in the wrong slot. Now it reorders the
  visible keys and appends uncarried ones after.

Drag paths verified intact: pack→hotbar bind, pack reorder, hotbar↔hotbar swap,
drag-off-to-unbind, drop-to-world. All verified live after deploy.

**Local-dev gotcha:** `python -m http.server` heuristically caches `js/*.js`, so module
imports can silently run STALE code while a cache-busted `fetch()` shows the new file.
If a change appears not to take effect locally, check that before suspecting the code.
Production is unaffected (JS is `max-age=300, must-revalidate`).

**Next:** sprint on the left stick + on-screen viewpoint button.

### 2026-09-09 — mobile items 1 & 2 shipped: sprint + viewpoint button
- **Sprint on the left stick.** Push past the ring (>78px, ring is 60px) to sprint at
  **1.4x**. No new button — the right edge is already eight deep. 1.4x was chosen because
  `server/bravo-room.js:16` budgets for exactly it: `MAX_SPEED = 700 — base 190, horse
  2.2x, sprint 1.4x ≈ 585 max legit`. It is also the multiplier a long right-click run
  already gives on desktop, so the anti-cheat sees no new speed. Feedback: the stick ring
  turns gold and thickens, with a faint outer ring at the threshold.
- **Viewpoint button** (👁, second column). Dispatches the same `']'` the keyboard uses,
  so camera presets have one code path. **Verified working live** — pitch 1.004→1.5,
  zoom 1.45→1.1 on press.
- **Removed the dead 🎛 loadout button**, which still fired `u` after the editor it opened
  was deleted. It was occupying prime thumb space and doing nothing.

**NOT verified end-to-end: the sprint speed ratio.** The Browser pane reports
`visibilityState: hidden`, which throttles `requestAnimationFrame`, so the game loop does
not advance and any timing-based movement measurement reads 0. The code path is verified
present and correct by inspection, but the 1.4x has not been confirmed against a moving
character. **Jessie to confirm on a real phone.** (Also note: `G.charSelectOpen` blocks
movement until a character is picked — an easy false negative when testing.)

**Next:** chat button that focuses a real text input (native keyboard gives voice-to-text
for free — do NOT build Web Speech). Then menu sizing/dragging for phone vs tablet.

### 2026-09-09 — connect gate CORRECTED (the first version was incomplete)
Jessie caught this: the earlier "connect only once loaded" change gated `initNet` on the
boot screen alone. But `G.charSelectOpen = true` runs at game3d.js:11801 — AFTER the
connect at ~11684 — so a player still joined the shared world while sitting on the
character-select screen: visible and attackable, and unable to move because that screen
blocks input. Exactly the window originally described.

Now BOTH gates must clear. `maybeStartNet()` is called once per frame from `loop()` and
returns early while `G.charSelectOpen || G.charCreatorOpen`; when both are false it calls
`bootScreen.whenReady(startNet)`. Polling per frame rather than hooking the three places
that dismiss those screens, so a future fourth exit path cannot silently reopen the hole.
Ordering verified: `maybeStartNet` defined 11686, `charSelectOpen=true` 11801, `loop()`
11912 — so the first frame correctly declines.

**TESTING GOTCHA (cost two false results today):** JS is served `max-age=300,
must-revalidate`. `must-revalidate` only applies AFTER expiry, so for 5 minutes the
browser serves cached JS WITHOUT asking the server — a page loaded right after a deploy
runs the OLD code. Always compare `fetch('js/x.js')` against
`fetch('js/x.js?cb='+Date.now())` before concluding a change did not work. The local
`python -m http.server` has the same trap for a different reason.

### 2026-09-09 — FOUND: Cloudflare overrides the JS cache TTL to 4 hours
Chasing why a freshly deployed `game3d.js` would not load, the real cause turned up:

    origin sends     Cache-Control: public, max-age=300, must-revalidate
    Cloudflare sends Cache-Control: public, max-age=14400, must-revalidate

Cloudflare's **Browser Cache TTL** setting is rewriting the origin header, so browsers
hold client JS for **4 hours**. Consequences beyond testing:
- a client deploy does not reach a returning player for up to 4 hours;
- players can run 4-hour-old client code against a freshly deployed server, which for a
  game with a wire protocol is a genuine correctness risk, not just staleness.

The edge itself is fine — it revalidates and had the new build immediately
(`cf-cache-status: EXPIRED` then `HIT`, correct content). It is only what Cloudflare
tells the BROWSER that is wrong.

**FIX (Jessie, dashboard):** Caching → Configuration → **Browser Cache TTL** →
**"Respect Existing Headers"**. Then the origin's 300s applies and deploys land within
5 minutes. The per-asset-class headers set in `orion-platform/server/index.js` were
designed for exactly this and are currently being ignored for browsers.
Models are unaffected in practice (30-day intent, and they are purged on change).

**Still unverified at runtime:** the character-select connect gate. The code is confirmed
present at the edge (2 `maybeStartNet` matches) and the ordering was checked statically,
but this browser holds a 4-hour-cached copy so it cannot exercise the new path. Verify on
a device that has not loaded the game recently, or after the TTL fix above.

### 2026-09-09 — first person: mouse-look is now recoverable
Jessie asked for "mouse controls viewpoint, WASD moves forward/reverse/strafe" in first
person. **WASD was never broken** — movement is already rotated by `camAngle`, so W maps
to `(-sin, -cos)`, exactly the camera's forward. Forward/reverse/strafe all worked.

The mouse was the problem, specifically GETTING IT BACK. `requestPointerLock()` was called
in exactly ONE place — the moment you switch into first person (setCamMode). Nothing
re-acquired it. So Esc, alt-tab, or clicking off the window killed mouse-look until you
cycled the camera all the way out of first person and back. Nothing listened for
`pointerlockchange`, so the game never knew. Worse at boot: `setCamMode()` runs on load to
apply the stored mode, and a lock request outside a user gesture is REFUSED — so anyone
whose saved camera mode was first person started with no mouse-look and no explanation.

Fixed:
- `requestLook()` — one helper, swallows both the throw and the promise rejection.
- `pointerlockchange` listener keeps `_lookLocked` accurate and refreshes the chrome.
- **A left click while in FP without the lock re-takes it** instead of swinging at
  something you cannot aim at. Once held, clicks behave normally.
- A `#fp-hint` under the crosshair reads **"click to look around"** whenever FP is active
  without the lock — the crosshair alone was a lie, promising aim you could not use.

**Verified** on a clean origin (port 8124 — a different port is a different origin and
therefore a clean HTTP cache; this is the reliable way to dodge a stale cached module):
entering FP shows crosshair + hint with `pointerLocked:false`; leaving FP hides both.
Declaration ordering checked for TDZ — `_lookLocked` (287) and `_fpCross/_fpHint` (306)
both initialise before `setCamMode()` runs at 341.

**Connect gate, partial verification:** with character select open, NO connection is
attempted (no net console output at all, where the old build logged attempts immediately).
The post-selection connect could not be exercised — the pane reports
`visibilityState: hidden`, rAF is throttled, `G.gameTime` does not advance, so `loop()`
never calls `maybeStartNet()`. Not a code fault. Confirm on a real device.

### 2026-09-09 — verified in MOBILE emulation; everything works; phone was on stale cache
Jessie reported from a phone: no load bar, sprint not fixed, still loads into the world
behind the character menu. **All three were the 4-hour cached JS from before the Browser
Cache TTL fix.** The server had the new code the whole time. Verified properly at 375x812
on a clean origin (port 8124), with the pane VISIBLE so rAF actually runs:

- **Load bar works.** 0% "preparing the world…" → 66% "loading assets…" → gone at 2.6 s.
- **Sprint works, and the analog curve is correct:** offset 30→95 u/s, 45→142, 59→186,
  70→190 (clamped), **95→266 u/s = exactly 1.4 × 190**.
- **Connect gate fully confirmed at last:** 0 connection attempts while character select is
  open, exactly 1 the moment the world is entered.

An earlier reading of `walk45 = 0 u/s` was a FIRST-TOUCH artifact, not a bug — the very
first synthetic touch after load does not move the player. Re-running in a different order
gave the clean curve above. Worth remembering when testing touch input.

**rAF note that finally unblocked all of this:** the Browser pane must be VISIBLE
(`document.visibilityState === 'visible'`) or the frame loop is throttled, `G.gameTime`
stops advancing and every timing measurement reads 0. `preview_start` fronts its own tab,
which is what made the difference.

### 2026-09-09 — guard call reachable on touch
`callGuards()` has existed all along, bound to `g`, and is even documented in the help
panel — but there was no touch button, so on a phone the single most useful
"get me out of this" action was unreachable. Added 🛡 to the second column
(`bx-gap, by-gap*2`). Buttons are TB_R=30 → 60 px diameter, over the 44 px floor.

**STILL OPEN (Jessie's design request, NOT built):** townspeople should auto-call guards
when they witness something suspicious. That is new NPC AI — witness radius, line of
sight, what counts as suspicious (PvP in a safe zone? theft?), cooldown so a crowd does
not summon eight guard waves. Needs a design decision before code.

### 2026-09-09 — the version number now actually moves  ← BUMP IT EVERY PATCH
The HUD showed a hand-edited `v0.6.1` that had not changed in many releases, so a device
on hours-old cached JS looked identical to one running the newest build. That ambiguity is
what made today's cache problem take three rounds to identify.

**`js/build-info.js` is now the single source of the version.** The HUD title row AND the
browser tab title are both rewritten from it at startup (`applyVersion()` in game3d.js),
so bumping that one constant moves the version everywhere it appears. `build.mjs` step 3
echoes the version it is shipping and fails if the export is missing.

**BUMP `VERSION` IN `js/build-info.js` ON EVERY PATCH.** Currently **0.6.2**.

Implementation notes for whoever touches this next:
- The HUD row is edited at the TEXT NODE, not via innerHTML. The row also holds a `<b>` and
  the keyboard-hints `<span>` that `applyMobileHudMode()` finds with
  `querySelector('span')`; rebuilding the row's HTML would break that.
- It is written from JS rather than fixed in the markup because the deployed `index.html`
  is platform-owned and deliberately not overwritten by a deploy — a literal there could
  never track a release.
- An earlier attempt stamped a build timestamp + commit hash instead. Jessie asked for a
  plain version number; simpler and it is the thing being bumped deliberately.

**How to use it:** after deploying, look at the top-left on the device. Not showing the
version you just shipped? That device is on cached JS — hard-refresh, do not debug the
feature.

### 2026-09-09 — v0.6.3: first-person look opened up to nearly straight up/down
Jessie: "the mouse needs to be the dictator of where the camera is looking… I want to be
able to look all around in fps, up down left right… only in this mode."

State of each part before the change:
- **Yaw** was already unlimited (`camAngle` wraps mod 2π). Left/right was never the issue.
- **Pitch** was clamped to `FP_PITCH_LIMIT = 1.25` rad = **±71.6°**, which is low enough
  that looking up at anything felt like the view was fighting you. **Raised to 1.55 rad
  = ±88.8°.**
- **Deliberately NOT π/2**: at exactly 90° the look target is directly above the camera,
  parallel to its up vector, and `lookAt()` cannot resolve roll — the view snaps. Stopping
  just short keeps a small horizontal component.
- **Already first-person-only**, as asked: `fpPitch` is touched in exactly three places,
  all FP-gated (pointer-lock mousemove, `if(camMode().fp)` middle-drag, and the FP camera
  block). Orbit modes use `camPitch` and are untouched.
- **Movement follows the crosshair's horizontal direction** — W maps to
  `(-sin(camAngle), -cos(camAngle))`, the same forward the camera looks along. Pitch does
  not feed movement, which is correct: looking up should not make you fly.

If FPS still feels dead, the cause is almost certainly that pointer lock is not held —
click once (the crosshair shows "click to look around" when it is not).

**Version is now 0.6.3.** Note it was v0.6.2 that shipped the click-to-look fix, so a
device showing v0.6.1 has none of the first-person work at all.

**Caching gotcha, seen again and worth internalising:** during this change the page had a
FRESH `game3d.js`/`build-info.js` (title read v0.6.3) but a STALE `camera-modes.js` still
reporting 1.25. **Files cache independently — the version number tells you build-info.js
is current, not that every module is.** Always cache-bust the specific file you are
checking before concluding an edit did not land.

### 2026-09-09 — v0.6.4: two real bugs behind the phone's black screen
Reported: phone black, desktop fine at the same moment; later "showing during day time but
really lagging, I think it lagged out and the screen went black".

`gpu-check.html` ruled out the obvious suspect — the phone reports **isWebGL2 true,
floatVertexTextures true, float textures core, highp, maxTextureSize 16383**. Nothing is
missing. Detected tier is `low`, and the reason is literally **"touch device"** — not a
capability test. Reproduced in 375x812 emulation at both `low` and `high`: identical.
So the tier is not the cause. Noon renders perfectly on the same device/tier, which rules
out a broken render path.

**Bug 1 — `moon.target` was never set or updated.** A DirectionalLight shines from its
position toward its TARGET, and an unparented target sits at the world origin. `sun` does
`scene.add(sun.target)` and re-aims it at the player every frame (game3d.js ~2415); the
moon did neither. Its position was moved to follow the player, but the direction it lit
from was still "toward 0,0,0" — tens of thousands of units away. So moonlight raked the
world at a wrong near-constant angle, which is much of why a **full moon** (verified
`moonPhase 4`, `moonBright 1`, ambient 0.34 — the brightest night) still read as black.
Fixed: `scene.add(moon.target)` + per-frame aim, mirroring the sun.

**Bug 2 — nothing handled WebGL context loss.** No `webglcontextlost` listener existed
anywhere. A browser drops the context under GPU memory pressure — routine on phones —
and unhandled the canvas is presented empty **forever** while the 2D HUD keeps drawing
over it. That is indistinguishable from the game dying, and it matches "lagged out and the
screen went black" exactly. Fixed with a listener that calls **`preventDefault()`** —
without it the browser never fires `webglcontextrestored` at all, the default action being
to abandon the context permanently — plus a `#ctx-lost` overlay ("Graphics restarting…")
with a Reload button, and an auto-reload on restore.

**Verified** by actually losing the context via `WEBGL_lose_context.loseContext()`:
console logged `[gfx] WebGL context lost`, overlay appeared at z-index 10000 with the
reload button. (My first check said "no overlay" — the selector was wrong: CSS serialises
`z-index:10000` back as `z-index: 10000` WITH a space. The code was fine.)

**Still open — the underlying lag.** Context loss is the symptom of memory/GPU pressure,
not the cause. Phase 05 (remote-player culling, `frustumCulled=false`, per-frame mixer
updates) is the real work. Also worth revisiting: tier detection assigns `low` to every
touch device regardless of capability, and this phone is clearly better than `low`.

**Local-dev note:** `python -m http.server` caches per-port, and once a port has served a
stale module it keeps doing so. `.claude/launch.json` now has `bravo-fresh-a` (8125) and
`bravo-fresh-b` (8126) to rotate through when verifying.

### 2026-09-09 — v0.6.5: PHASE 05, remote-player culling (the lag work)
Remote players were the only entity type with no level of detail at all: a full protagonist
clone (12,874 tris, 18 clips, its own AnimationMixer) each, `frustumCulled=false` so they
were submitted to the GPU even behind the camera, and a mixer update every frame at any
distance. `syncEntities` had solved all of this for mobs years ago; players never got it.

- **`viewRadii()`** extracted from `syncEntities` and now shared with
  `syncRemotePlayers`, so a wolf and a player standing together cull at the same distance
  and the two can never drift apart. Phones already get a much tighter bubble.
- **Distance cull** past RD — model hidden outright (also gates the horse and the
  weapon-prop swap, which was running for invisible players).
- **Animation LOD** past AD — the mixer stops updating, so the pose freezes. Skinning is
  the expensive half.
- **`MAX_ANIMATED_REMOTES = 20`.** AD alone is not a bound: a hundred players in one town
  square are all inside it. Remotes are ranked by distance each frame and only the nearest
  20 animate. This is the change that makes a crowd survivable.
- **`frustumCulled` back ON for remote meshes** — with care. It was almost certainly
  disabled because three tests a SkinnedMesh against its BIND-POSE bounds, so an animating
  character can vanish while still on screen. Fixed properly by inflating the bounding
  sphere ×1.75 instead of abandoning culling. **`SkeletonUtils.clone` SHARES geometry
  between clones**, so the inflation is guarded by `geometry.userData._skinBoundsInflated`
  — unguarded, every join would re-inflate the same sphere and it would grow until nothing
  ever culled again.
- **Materials deliberately still cloned per remote.** The plan said to stop, but opacity is
  per-player (ghost 0.45, hidden 0.25) — sharing them would fade every player out when one
  dies. It is a per-join cost, not per-frame, so it is not what was hurting.

Blast radius is small: the only `frustumCulled` line changed is inside `buildRemoteModel`.
The local player and every other model are untouched.

**VERIFIED:** no regression — v0.6.5 renders, protagonist visible, 71.9 fps / 13.9 ms
median at noon on desktop.

**NOT VERIFIED: the culling under actual multiplayer load.** Injecting synthetic entries
into `net.remotes` did not reach the render path in this harness and chasing it further was
not worth the time. The logic is small and reviewed but has not been exercised with real
remote players. **Jessie has two devices and two characters — that is the test.** Watch
whether a second player far away still costs frames, and whether anyone pops in/out
wrongly at the edge of vision (that would mean the ×1.75 bounds inflation is too small).

### 2026-09-09 — v0.6.6: NPCs were never actually hidden (Jessie spotted this)
"NPCs render even when across the map, some angles allowed me to see them from afar."
Correct, and it was a one-word omission. Mobs and guards both do
`visible=false; continue;` past RD. **Both NPC loops did only `continue`** — which skipped
the ANIMATION but left the mesh visible, so every town NPC was submitted to the GPU from
anywhere on the map. Fixed in both `npcs` (rig) and `glbNpcs` (GLB) loops. Checked first
that nothing else manages NPC visibility, so nothing is being clobbered.

### MOBILE MENUS — measured, NOT yet fixed
Jessie: "we need all of the menus fixed in mobile", with a crafting-panel screenshot.
Numbers, so the next run does not have to re-derive them:

    crafting panel   500 x 700   (PANEL_W=500, 35 recipes / 2 cols = 18 rows)
    phone viewport   375 x 812
    width overflow   125px  -> the right column is off-screen
    panel x origin   375-500-12 = -137  -> it also starts off the LEFT edge
    column width     234px, for lines like "3 iron ingots + 2 planks -> iron sword"
                     (~40 chars ~= 290px at 12px monospace) — so text does not fit either

Desktop is 1920 wide, which is why this was never visible before.

**Panels sharing the same fixed-width pattern** (js/constants.js): `PANEL_W=500` (craft),
`TRADE_W=390`, `SKILL_PANEL_W=290`, `BANK_W=280`. Quest journal and backpack likewise.

**This is a design job, not a constant tweak.** Two columns cannot work at 375px — the
recipe strings alone need ~290px. One column at 35 rows is ~1260px tall, so it needs
scrolling, which the craft panel does not have (the backpack already has `packScroll`, so
there is a pattern to copy). Panels are canvas-drawn at absolute coordinates and hit-tested
against the same numbers, so any change has to move layout AND hit-testing together —
`panelAt()` is the single choke point for position, but width/height are read straight from
the constants at draw time.

Options worth weighing before writing code: (a) per-panel responsive layout, most work,
best result; (b) a uniform canvas-space scale applied to every panel plus the inverse on
hit-testing, one change covers all panels but small text gets smaller; (c) mobile-specific
single-column layouts for the few panels that matter most (craft, quest, pack).
**Ask Jessie which before building.**

### 2026-09-09 — v0.6.7-0.6.9: mobile panels, option A. Audit + craft panel done.
**Full audit of all 21 canvas panels against a 375px phone.** Six were wider than the
device: craft 500, charsheet 440, contracts 430, trade 390, dev_panel 388, trade_p 380.
The other fifteen already fit.

**Why a systematic fix was possible:** every panel derives its whole internal layout from
its own width constant — column widths, progress bars, centred text, row rects AND the
hit-test rectangles all read the same number. So clamping the constant reflows the panel
correctly, clicks included, instead of cropping it. Added `fitPanelW`/`fitPanelH` in
constants.js and wrapped all 21 width constants plus the craft height. No-ops on desktop
(verified: PANEL_W still 500 there).

**Craft panel needed real layout work on top of that.** Even at 351px, two columns of
~160px cannot hold "3 iron ingots + 2 planks -> iron sword" (~290px), so the columns
overlapped. Below 420px it now uses ONE column and scrolls: 35 recipes, 15 visible,
▲▼ buttons, "rows 1-15 of 35" readout. Verified: clamps at 20, returns to 0, panel stays
open throughout.

**Two traps worth remembering:**
1. `panelDragStart()` claims the top **PANEL_GRIP (26px)** of EVERY panel and is tested
   BEFORE any panel's own click handler. Controls placed in a panel header are therefore
   unreachable — the click starts a drag instead. The scroll arrows had to move below the
   header. Anyone adding buttons to a panel header will hit this.
2. `recipeRects()` is the single source for drawing AND hit-testing, which is what kept
   this contained. Rows scrolled out of view are marked `vis:false` rather than filtered,
   so a hidden row can never be clicked and both consumers stay index-free.

**NEW: `tools/devserver.mjs`** replaces `python -m http.server` for local testing. Python
sends no Cache-Control, so browsers heuristically cache ES modules and silently run stale
code after an edit — this cost real time repeatedly, including a stretch where a fix
looked undeployed when it was fine. The new server sends `Cache-Control: no-store`.
`.claude/launch.json` runs it on **port 8127** (deliberately fresh — ports the python
server already touched still hold browser cache entries that no-store cannot evict).

**STILL TO DO — the other five over-wide panels now fit but have NOT been checked for
internal layout quality:** charsheet (440->351), contracts, trade, dev_panel, trade_p.
Width clamping stops them running off-screen; whether their contents still read well at
351px needs the same eyes-on pass the craft panel got. Quest journal and backpack were
already within width but Jessie has not confirmed they are usable.

### 2026-09-10 — v0.7.0: character SELECT screen fixed (js/char_creator.js)
Jessie's screenshot: title clipped at both ends, cards overflowing, and "PLAY AS GROM"
drawn ON TOP of the RACIAL TRAIT text. Note this is `renderCharSelect` in
**js/char_creator.js** — a different file from the canvas panels in game3d.js, and it
already had its own portrait/landscape scale-to-fit design. Two arithmetic faults:

**1. The card was shorter than the content it drew.** Portrait `cardH` was derived from
leftover vertical space and came out at **239** design px. But the card's contents are
fixed-size and run to **cardY+282** (four attribute rows ending at +228, then a 54px
trait box). The Play button is positioned from the BOTTOM — `cardY + cardH - 52` = +187 —
so it landed *above* where the trait box starts, hence the overlap, and the box itself
spilled 43px past the card edge. Vitality was pushed out of view entirely.
Fixed: `CARD_H_PORTRAIT = 342` (a constant, because the content is), and portrait
`DESIGN_H` 640 → **860** so two of them plus header and gap fit (last card ends at 822).
Scale-to-fit still constrains on width (375/420 = 0.89), so 860 renders as ~768 of 812.

**2. The title was wider than the design space.** 'PROJECT BRAVO — CHARACTER SELECTION'
is 35 chars; at bold 24px monospace (~0.6em/char) that is **~504px**, centred in a 420px
portrait design — clipped at BOTH ends no matter what the scale worked out to. Portrait
now uses 'CHARACTER SELECT' at 20px (~192px) with a shorter subtitle.

Landscape path is byte-identical to before. Hit-testing needed no change: `charSelectHits`
is built from the same `cardH`/`btnY` values, so buttons move with the boxes.

**Verified** at 375x812 with two characters injected into `bravo_account_v1`: title fits,
all four attributes visible, trait box intact, Play button below it, both cards on screen.

**Method note for the remaining panels:** the useful move here was computing the content's
required height and comparing it to the container, rather than eyeballing the screenshot.
Both faults were arithmetic and provable before touching the browser.

### 2026-09-10 — v0.7.1: who owns the mouse (+ flick control off on desktop)
First slice of Jessie's UI request. All four changes answer one question — is the mouse the
game's or the UI's — which is why they were done together rather than as four fixes.

- **"click to look around" is gone.** It only existed because pointer lock was requested
  once and never re-acquired. Any world click now re-takes it, so the hint was telling you
  to do the thing you were already doing.
- **Opening any menu releases the mouse** (`releaseLookForUI()`, called once per frame from
  `loop()`). Checked per frame rather than hooked into each of the ~25 panel flags, so a
  panel added later cannot forget. Closing the menu hands the mouse back on the next world
  click.
- **HARD BROWSER LIMIT, do not try to design around it:** Pointer Lock cannot be ENTERED
  without a user gesture. "Look around with no click at all" is not achievable; re-taking
  on the next click is as close as the platform permits.
- **Hotbar drag only while the pack is open.** Dragging rearranges, and rearranging is what
  the pack is for. Side benefit: a click that moved a few px mid-fight can no longer
  silently unbind a slot. Populated slots now fire on PRESS rather than release — checked
  for double-fire: `finishUiDrag` only runs when a `uiDrag` exists, and none is created
  with the pack closed.
- **Flick Control (the "thumb kicker") defaults to touch only.** `radialCfg.hidden` now
  starts as `null` = "not chosen", resolving to hidden unless `isTouchPrimary()`. An
  explicit preference still wins. It was drawn on desktop over the play area doing nothing
  — visible in Jessie's screenshot right of the hotbar. Its toggle currently lives ONLY in
  the dev panel (~line 11370); it belongs in the settings menu below.

Verified on desktop at v0.7.1: flick circle gone, no hint element, first person entered,
and with the pack shut a press+drag on the bar fires slot 0 instead of rebinding it.

### STILL OPEN from the same request — NOT started
1. **ESC settings menu.** Minecraft-breadth: nameplates above players, FOV, controls,
   keybinds, controller mapping. Pull the useful toggles out of the dev panel — Flick
   Control show/hide and Reset Flick Pos are already there and are the obvious first
   entries. This is also where the phone/tablet thumb-stick configuration belongs.
2. **Distance rendering** (screenshot received 2026-09-10). Visible faults: grass has a
   hard cutoff band well inside the view; distant terrain reads dark and flat; distant
   trees go blocky. Start at `js/render/grass.js` draw distance and `js/render/tree-lod.js`,
   and check the quality-tier knobs (`nearTrees`, `obsWindow`) — the phone is on tier `low`
   but this screenshot is DESKTOP, so it is not just a tier problem.

### 2026-09-10 — v0.7.2: backpack is now just the grid
Jessie sent a reference image: a plain 6x6 slot grid in a wooden frame, nothing else.

**What was actually wrong:** the panel drew a 1408x768 backpack ILLUSTRATION and mapped the
usable grid into a sub-rectangle of it (`PACK_GRID = [538,218,872,566]`). The grid was
538..872 of 1408 across — about **24% of the panel width was clickable**, the rest was a
picture of a bag. Panel was 860x469 for a 6x6 grid.

Rebuilt grid-first: `PACK_CELL=46`, `PACK_FRAME=12`, `PACK_GUTTER=26` (scroll arrows),
`PACK_FOOTER=54` (selected label + drop/sell buttons). **326x354 at scale 1**, and it fits
a 375px phone. Empty cells now draw their own sockets — the illustration had been providing
that for free.

**Move / resize / scroll all already existed and were NOT rewritten.** They are anchored to
`backpackXY()` and `packGridRect()`, so redefining those two carried the scroll arrows, the
resize grip and every hit-test with them. That is why this was a contained change.

Two leftovers found by looking at it rather than by reading: the title (`H*0.115`) and the
selected-item label (`H*0.825`) were positioned as fractions of the ILLUSTRATION, so both
landed on top of the grid. Title removed entirely (the reference has none); label and the
artifact hint moved into the footer, anchored to the grid instead of the panel.

**Verified live at 375-wide and desktop:** move (offset x60 y30 persisted), resize
(scale 1 -> 1.625), scroll (0->1->2->1). Storage key is `bravoPanelPos_v1`.

**Worth knowing:** there are only 28 resource types, so with 36 cells the pack does not
scroll on resources alone — scrolling only kicks in once artifacts are carried. That is why
a scroll test looks like it fails until you add artifacts.
