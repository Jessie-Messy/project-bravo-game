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
- ⚠ **Never commit ANY deploy `.bat` helper.** All six — `VPS_GIT_PULL.bat`,
  `VPS_SETUP_AND_DEPLOY.bat`, `COMMIT_AND_DEPLOY.bat`, `DEPLOY.bat`, and as of
  2026-09-19 also **`deploy_to_vps.bat`** and **`deploy_server_to_vps.bat`** — are
  gitignored. Two carry the VPS password in plaintext (that password has **never** been
  in git history, verified across all refs); the other four carry the **origin IP and
  SSH user**, and **this repo is public**. The last two were deleted from the remote on
  2026-09-12 as part of the response to the origin-exposure incident; a branch cut
  before that date will silently re-add them. **`git fetch` before you branch, and read
  `git status` before you `git add -A`.**

### 2026-09-20 — DEPLOYED v0.19.0 to production

Live at `orionsyndicateguild.org/games/medieval/`. First deploy since v0.12.5 (2026-09-11),
so this shipped everything from the NPC models through to the coast bosses in one go.

**Backups taken first**, on the VPS at `/home/ubuntu/bravo-backups/`:
`bravo-server-20260920-212150.tgz` and `medieval-client-20260920-212150.tgz`.
⚠ `/home/ubuntu/backups/` is **root-owned** and not writable by `ubuntu` — use
`bravo-backups`.

**Order:** asset budgets → build → server → client. Server before client so the new schema
was live before new clients arrived; the gap is survivable either way because a missing
`noto` reads as 0 (non-outlaw).

**The two production guards both proved themselves in the boot log:**
- `[orion-auth] ticket verification active` — a real secret is configured, so **the dev
  auth bypass is OFF in production**, exactly as the three-condition guard intends.
- `listening on 0.0.0.0:2567` — it binds loopback *only* when the bypass is active, so the
  bind address is a second, independent confirmation.

**The SQLite migration ran on the live database.** `players` columns are now
`name,x,y,hp,kills,deaths,updated_at,token,blob,noto` — `noto` added, every existing
column and row intact. That migration is why notoriety survives a reconnect.

**Client build:** `build.mjs` matched every patch anchor first time despite the large
`net.js` and `game3d.js` changes, picked up the new `js/render/jewelry.js`, rewrote bare
specifiers in 26 files and vendored 27 addon modules. Verified in the built output before
upload: no bare specifiers, no external URLs (the site's CSP is `script-src 'self'`), and
`index.html` / `save-bridge.js` — which are **platform-owned** — preserved.

**Verified through nginx** (the real player path, `Host:` header set):
`build-info.js` → v0.19.0 · `jewelry.js` → 200, 9857 B · `game3d.js` → 200, 830 823 B.

**Verified in a real browser on the live domain:** boots to `tier ultra`, full composer
chain (`RenderPass → GTAOPass → UnrealBloomPass → OutputPass → SMAAPass`), world generated
(8234 tiles flooded by river widening), **no game errors**. The only console error is CSP
refusing an *injected* inline script — i.e. the CSP the vendoring exists to satisfy, doing
its job.

⚠ **Fetching the live URL with `curl` from the dev machine returns `000`** while the same
request from the VPS succeeds. Not a deploy problem — check from the box with
`curl -sk https://127.0.0.1/... -H 'Host: orionsyndicateguild.org'` rather than chasing it.

---

### 2026-09-20 — v0.19.0: coast bosses and the drop tables

The coast was risky but not worth it. This is the reward half, and the loop is now closed:
**risk (open PvP) → reward (tier 6 + sigils) → progression (permanent, capped)**.

**Two named bosses**, at opposite ends and both **well away from Saltmere** — the village
is the only safe ground on this map, and a boss that could be pulled into it would be
farmed from safety while the PvP rules never came into play.
- **The Tidewrack** — a vast reef serpent in the shallows, western end. You fight it
  standing in water with nowhere to back into.
- **Drowned Kessel** — a wrecker chieftain on the eastern beach.

**⚠ THEY RESPAWN (240s), unlike the dungeon's one-time kills.** A dungeon is a thing you
clear; the coast is a thing you *live on*. It is the only source of tier 6 and sigils, and
a permanent track you can exhaust in two kills is not a reason to stay anywhere. A
respawning boss is also a place people gather — and people gathering is the point of a PvP
map.

| source | drop |
|---|---|
| coast trash | 6% abyssal ingot (wreckers 14%) |
| boss kill | 3–5 abyssal ingots · **1–2 sigils** · ~24 gold · 400g bounty · high artifact roll |

Measured: one boss kill → 3 ingots + a fortitude sigil + 24 gold. Sixty wreckers → 8
ingots (**13.3%** against the 14% target).

Thin on trash **on purpose** — a steady trickle makes the bosses pointless, and the bosses
are where the risk lives. A guaranteed sigil per boss is the design: **capped at 10 each ×
4 kinds = forty boss kills is the ENTIRE permanent-progression track**, on a map where
other players can interrupt it.

**Sigils apply on pickup**, not into the pack — there is nothing to decide about a
permanent capped stat, and a slot for something you'd always use immediately exists only
to be clicked.

**Abyssal recipes:** sword / bow / pickaxe / armour, 4 ingots each. **⚠ There is no ore and
no smelting recipe.** Ingots drop on the coast and nowhere else — that is what makes tier 6
unobtainable on the safe map at any price.

**⚠ FIXED IN PASSING: `mithril_ingot`, `mithril_ore`, `runic_ingot` and `runic_ore` were
missing from `BAG_ITEMS`.** They exist in `inv`, are craftable, and drop from dungeon
bosses — but with no entry the pack never displayed them and `itemLabel()` fell through to
the raw key, so a pickup floated "+1 runic_ingot". Pre-existing. **If you add an inventory
item, add it to `BAG_ITEMS` or it is invisible.**

---

### 2026-09-20 — v0.18.0: wearable artifacts, tier 6, permanent stats

**The twelve artifacts have bodies now.** `js/render/jewelry.js` builds each one
procedurally — necklaces, rings, bracelets — and hangs it on the skeleton.

- **Why not GLBs:** armour attaches via `setSlotModel()`, which loads a file. Right for a
  breastplate; a ring is a torus and a stone. Twelve files for shapes describable in four
  lines each costs load time for no fidelity, and each would need placement tuned by hand.
- **⚠ They are ~2.5x life size on purpose.** An anatomically-sized ring on a character
  this height is **under a pixel** at play distance. Same argument `humanoid.js` makes for
  the eyes.
- One merged vertex-coloured geometry each → 5 draw calls for a fully decked character,
  not 15. Cached per artifact id.
- **⚠ There is a SECOND neck anchor** (`jewelNeck`). The gorget owns the first, and
  sharing it means equipping a breastplate silently removes your amulet.
- **⚠ The bracelet bone must be asked for BY NAME.** A regex for `/(left).*arm/` matches
  **`LeftArm` — the bicep** — so every bracelet was worn above the elbow until it asked
  for `LeftForeArm`. Verified on the real skeleton: neck y102, forearms y82, hands y64.
- `updateArtifactVisuals()` hangs off **`recomputeArtifactBonus()`** — the one function
  every equip, unequip, consume and save-load already funnels through, so the models
  cannot drift out of step with the stats.

**Tier 6 — Abyssal.** Coast-only; it does not exist on the mainland at any price.

| | melee | arrow | DR |
|---|---|---|---|
| steel | 42 | 25 | 0.40 |
| mithril | 53 | 32 | 0.56 |
| runic | 66 | 40 | 0.72 |
| **abyssal** | **82** | **49** | **0.85** |

**⚠⚠ `tools/test/tiers.mjs` EXISTS BECAUSE THIS HANDOFF ALREADY RECORDS THE BUG.** The
Mithril/Runic work added recipes and drops referencing tiers the lookup arrays did not
reach, and every endgame weapon **silently produced NaN**. An out-of-range index gives
`undefined`; `undefined` in arithmetic gives NaN; nothing is loud about it. The test
parses the arrays out of `game3d.js` and asserts they agree, are monotonic, cover every
tier the source references, and that every material above bronze has a `matTint` entry.
**Proven by reproducing the original bug.** Run it before shipping any tier change.

**Permanent stats — Abyssal Sigils.** Consumed, not worn: cannot be unequipped, swapped
or traded, so it is *progress* rather than loadout. **⚠ Capped at 10 each, and the cap is
the design** — permanent uncapped stacking stats turn an open-PvP map into a
whoever-farmed-longest map, and the rules that make the coast interesting stop mattering.
Clamped on **load** as well as on use (a save blob is client-authored). `armorDR()` is now
clamped below 1.0 for when a fortitude line stacks on a full abyssal set; existing runic
characters (0.72) are untouched.

**`tools/test/jewelry.mjs` parses `ARTIFACT_DEFS` out of `game3d.js` rather than mirroring
it** — a mirror is the thing that goes stale, and going stale is the failure it is for.
Adding an artifact and forgetting its model otherwise renders a grey fallback band nobody
notices on a rare drop.

`_dev.wear()` puts artifacts on without farming twelve boss drops. `npm test` now runs
**four** harnesses: 41 + 71 + 24 + 7.

#### ⚠ Still open on the coast
Sigils and abyssal gear **exist and work, but nothing drops them yet** — no coast bosses,
no loot tables wired to either. `useSigil(kind)` and the tier-6 recipes are ready for
whatever drops them.

---

### 2026-09-20 — v0.17.0: two regions, two rulesets, notoriety, and the dev auth bypass

#### The rules
| | MAINLAND | COAST |
|---|---|---|
| safe ground | city (throughout) | **Saltmere village only** |
| who you may strike | **outlaws only** | anyone, outside the village |
| outlaw may swing first? | **no** — only answers a recent attacker | yes |
| notoriety earned here? | no | **yes**, +1 per PvP kill |

That split is the loop: notoriety is **earned on the coast and paid for on the
mainland**, where it makes you huntable and takes away your ability to start a fight.
It also resolves the bootstrap — "you may only kill outlaws" and "outlaws are made by
killing" cannot both hold on one map.

**⚠ THE SERVER DECIDES, ALWAYS.** `attackBlockedReason()` in `bravo-room.js` is the only
answer that counts. The client's `attackBlockedClient()` is a **prediction**, so a refused
swing can say *why* rather than vanishing — a blocked swing that reads as the game eating
your input is worse than one that says "safe ground". Both read the same constants:
`js/constants.js` is the source, `build-world-data.mjs` copies them into
`world-data.json`, and the server reads them from there. **Same discipline that stopped
`bravo-room.js` retyping `MAP_H`.** The coast safe zone comes from `world.js`, because
only the generator knows where the village ended up — a literal rectangle would have gone
stale exactly the way the village's own position did.

#### Notoriety
- +1 per PvP kill **on the coast only**. A mainland kill can only ever be lawful, so
  crediting it would punish the person enforcing the rules.
- Outlaw at **2**. Decays one point per 30 min of **connected** time (not wall-clock, so
  it cannot be waited out by logging off). `NOTO_DECAY_MS = 0` makes it permanent.
- **⚠ PERSISTED IN BOTH STORAGE BACKENDS.** In memory only, the whole system would be
  defeated by pressing reconnect. Added to SQLite as a **migration** — the `CREATE TABLE`
  is `IF NOT EXISTS` and every existing database has already run it.
- Outlaws are marked **☠** on the nameplate; the mainland rule turns on knowing who is
  lawful game *before* you swing.
- **Retaliation is keyed by attacker, not "last person who hit me"** — otherwise a gang
  locks an outlaw out of fighting back by taking turns.

#### Guards hunt people now
The call is refereed server-side, and a mustered guard's damage goes through `netPvp` so
the server validates it like any other hit. **Guards enforce the rules; they are not a
way around them.** Everyone nearby musters them, so a hunt is public.

#### The Saltmere gate
An arch in Lunar City and its twin in the village. **⚠ Checked BEFORE the dungeon branch**
in the TELEPORT handler — that branch only asks whether you are currently underground, so
a bare TELEPORT tile in the city drops you down a hole instead of onto the coast. Both
ends register together so neither can point at something that was never built. The plaza
refuses to carve `WALL`/`STAINED_GLASS` (verified: 0 city wall tiles lost).

#### ⚠ The dev auth bypass — read the guards before touching it
`ORION_DEV_AUTH=1` accepts a join with **no ticket at all**. It exists because a clean
clone could not run multiplayer in any form. **Three conditions, all required:** the env
var, `NODE_ENV !== 'production'`, **and no secret configured**. The third is the one that
matters — production resolves a secret, so the bypass *cannot* engage there even if the
var leaks in. A fourth guard is outside the auth module: `index.js` binds **127.0.0.1**
while it is active; LAN testing is a second explicit opt-in (`ORION_DEV_AUTH_HOST`).
Verified as a matrix, including that a configured secret disables it.

```
cd server && ORION_DEV_AUTH=1 node index.js
```

#### Verified live, every branch
mainland vs citizen → `target-not-outlaw` · mainland vs outlaw → allowed · in Lunar City
vs outlaw → `safe-zone` · coast beach → allowed · Saltmere village → `safe-zone` ·
mainland as outlaw → `outlaw-cannot-initiate` · **after they hit me first → allowed** ·
coast as outlaw → allowed.

`_dev.pvp()` reports who you may lawfully strike and why not; `{noto}` / `{myNoto}`
override so the outlaw branch can be tested without murdering two people first.

#### ⚠ Still missing: the reward half
The ruleset that makes the coast **risky** is in. The rewards that make it **worth the
risk** are not — no coast bosses, no coast-exclusive character upgrades, no richer loot
tables. Deliberately not guessed at.

---

### 2026-09-20 — v0.16.1: how far the multiplayer actually stretches

**There is now a way to ask the question.** `_dev.mpLoad(n[,radius])` puts *n* synthetic
players straight into `net.remotes` — exactly what `syncRemotePlayers` reads —
and `_dev.mpBench(frames)` drives `update()` / `render3D()` **by hand** and times them.

⚠ **Driving the frame function directly is the trick that makes this measurable at all.**
A backgrounded pane throttles rAF to nothing (see the preview-pane gotcha), so any timing
loop built on frames never runs. A synchronous call does identical work and can be timed
anywhere — including from a hidden tab.

⚠ **`renderer.info.render` RESETS ON EVERY `render()` CALL**, and the composer makes
several per frame. The first version of the harness read it afterwards and reported
**`drawCalls: 1`** for a 150-player crowd — it was seeing the final fullscreen quad.
`info.autoReset = false`, reset once, then divide by frames.

#### What it measured (desktop, standing in the city, everyone inside the animation radius)

| remotes | draw calls/frame | median ms |
|---|---|---|
| 0 | 164 | 3.2 |
| 50 | 455 | 4.0 |
| 100 | 749 | 5.5 |
| 150 | 1043 | 6.3 |

≈ **5.9 draw calls per visible player** — a body plus a weapon, times the ~3 scene renders
the composer performs. **Triangles barely moved** (481k → 590k), so this is
*submission*-bound, not geometry-bound. And **animation was never the cost**:
`MAX_ANIMATED_REMOTES` held it at 20 throughout.

#### The cap was on the wrong thing
There was a ceiling on how many remotes **animate** and none on how many are **drawn** —
backwards for the case that hurts, a crowd. `MAX_VISIBLE_REMOTES = 60` draws the nearest
60 and hides the rest; they keep their position and nameplate, so nothing gameplay-facing
changes.

| remotes | calls before → after | ms before → after |
|---|---|---|
| 100 | 749 → 516 | 5.5 → 4.2 |
| 150 | 1043 → 519 | 6.3 → 4.2 |
| 250 | — → 521 | — → 4.9 |

**Cost is now flat in crowd size: 250 players cost what 60 do.** The client is bounded.

#### ⚠ THE NEXT CEILING IS THE SERVER, AND IT IS O(N²)
`bravo-room.js` has **no interest management** — its own `maxClients = 120` comment says
so. Every player's state syncs to every player, so message volume grows with N². At 120
players that is ~14 400 player-updates per patch tick across the room. `x`, `y` and `dir`
are declared `'number'`, which in `@colyseus/schema` is **float64** — 8 bytes each where
`float32` would do (0.002 precision at the map's far corner) and `int16` would do with
scaling.

Two fixes, in order of value: **interest management** (only sync players near you), then
**narrower field types**. Neither is done.

#### ⚠⚠ AND YOU CANNOT TEST EITHER ONE LOCALLY RIGHT NOW
**A clean clone cannot run local multiplayer.** The repo's `js/net.js` joins with
`{ name, token }` — a localStorage device token. The repo's `server/bravo-room.js`
`onAuth` requires a **signed Orion ticket**, and `verifyGameTicket` returns `null`
whenever no secret is configured, so **every join is rejected**:

  client sends device token → server wants signed ticket → `throw new Error('bad-ticket')`

This is a consequence of the 2026-09-19 Phase 0 fix that pulled the live server into the
repo, and it was still the right call — the alternative was a repo whose server could
overwrite production's auth with a version any browser can spoof. But it means **setting
up a working local MP environment is the actual prerequisite for the next multiplayer
work**, not an afterthought. The options are: run the Orion platform locally so the built
client gets real tickets, or give `orion-auth.js` an explicit, loudly-logged dev mode —
which is an auth bypass and should not be added casually.

---

### 2026-09-20 — v0.16.0: Saltmere moved onto the shore, and got a population

**⚠⚠ THE VILLAGE WAS FORTY TILES INLAND, AND IT LOOKED CORRECT.** `COAST_VILLAGE.y`
was the literal `COAST_Y0 + 78` while the coastline is a **function of x** — at the
village's own x-range the beach is at local ly **26–45**. So a fishing village with
piers generated in the middle of the woods. What hid it: the footprint-clearing pass
turns trees and rock into SAND, so the village **manufactured its own small desert and
sat in it**, and every check of it showed huts on sand exactly as designed.

**The lesson worth keeping: when one value is derived and a related one is a literal,
the literal is wrong the moment the derivation changes — and a generator will happily
build something self-consistent and plausible around it.** `.y` is now
`shore(centre) + 4`. The house plots moved inland for the same reason: east of the
village is half sea once the village is against the water, and 3 of 6 plots were being
silently rejected.

**⚠ `makeEnemy` could not place a beach mob at all.** It chose between exactly two
ground types — `CAVE_FLOOR` for cave dwellers, `GRASS` for everything else — so a crab
aimed at the sand searched outward for grass and either landed inland or returned null.
`ENEMY_CFG` entries may now declare **`spawnTiles`**; without one the old two-way choice
applies unchanged. Verified: 10 crabs on SAND, 7 serpents on SHALLOWS, 4 wreckers on
SAND.

**Population.** 5 NPCs (harbourmaster, fishwife, shipwright, 2 villagers) and 21 mobs
(shore crab, reef serpent, wrecker). NPC positions are **derived in world.js from the
village the generator placed**, so they follow the shoreline rather than being written
down beside it. They spawn through the same `spawnNPC` path as every town NPC, so they
animate and cull with the same loop. Each named one has an `[E]` prompt *and a line* — a
silent NPC with a prompt is worse than no prompt, because the prompt promises something.

Crabs are the **quadruped rig made broader than it is long**; serpents are the
**bodyless blob**. Neither needed a model. Five new rig styles; the dressing harness now
covers 18 (41 checks).

#### Still open on the coast
No shops (the harbourmaster, fishwife and shipwright only talk), `COAST_HOUSE_PLOTS` is
still only read by `_dev.house(null)` — nothing steers a player to the plots or reserves
them — and coast mobs are **client-side**, like every type except wolf and bandit, which
are the only two the server simulates.

---

### 2026-09-20 — v0.14.1 the Saltmere crossing, v0.15.0 housing

**The ferry (v0.14.1).** A ferryman at each end and an `[E]` prompt. Until this, the
coast was sealed on every side and the only way in was `_dev.coast()`.
  - ⚠ **The mainland jetty is DOCK tiles all the way to the bank, including the
    approach, and that is load-bearing.** `game3d.js` widens every river by 3 tiles
    **after** `world.js` has run, and the widener floods GRASS and PATH. A jetty with a
    path approach would have had its approach turn into river and left the ferryman on
    an island. DOCK is not in the floodable set. Result after widening: water to y363,
    planks from y364 — the head sits exactly on the new waterline.
  - The crossing is a hard cut on purpose. The ends are ~14 000 units apart with sealed
    rock between, so there is no route to animate and a fake voyage is a loading screen
    with a boat on it. **Deliberately no sound** — `snd.cave()` is the enclosed-space
    echo and firing it on an open beach tells the player something false.
  - `FERRY_FARE` exists and is 0. A toll on a region with nothing to sell is a wall.

---

**Housing (v0.15.0).** It was *one* 9x9 cabin that could only stand on grass.

**⚠ THE GRASS-ONLY RULE MADE THE COAST PLOTS UNBUILDABLE THE MOMENT THEY EXISTED** —
they are SAND. A house type now declares the ground it may stand on, checked **per
tile**, so a footprint may span sand + shallows + grass as long as every tile is
allowed. Measured on the generated coast: **308** legal cabin footprints touching sand,
**808** stilt footprints touching shallows — all impossible before.

Four types: 7x7 Crofter's Hut · 9x9 Cabin · 13x13 Longhouse (windows set into the walls
as STAINED_GLASS, which is blocking, so walkability is unchanged) · 9x9 Stilt House
(builds over the shallows, plank floor). ⚠ Keep sizes within **3..15** — the world
server rejects anything outside that range, and a rejected placement is a desync, not an
error message. Keep `id: 'house_9x9'` — saved houses reference it.

**Doors are no longer always on the south wall.** `houseDoorSide` picks a side whose
outside tile you can actually stand on, preferring south so nothing moves for existing
inland houses — a stilt house facing the sea would otherwise have opened into deeper
water. `houseDoorTile`, the signpost and the hinged door mesh all follow (a doorway in
an E/W wall runs the other way, so the pivot turns a quarter and the hinge moves to the
north edge).

#### ⚠⚠ FOUR OF THE FIVE BUGS FIXED HERE WERE PRE-EXISTING
1. **The client never checked house-to-house adjacency.** The server rejects anything
   within one tile of another house; the client checked only tile type — which happens
   to prevent overlap (a built house is WALL, not GRASS) but **not adjacency**. Building
   flush against your own cabin succeeded locally and was silently dropped by the
   server, so the house existed on one machine only. Same numbers both sides now.
2. **`clearHouseTiles` restored every tile to `T.GRASS`.** Demolishing a stilt house
   left **a 9x9 lawn in the middle of the sea**; a beach hut left grass on sand. Same
   family as the coloured-squares-under-trees bug. It now takes the majority ground from
   the ring just outside the footprint — derived, not remembered, because server houses
   carry no build history.
3. **The save/load path held a SECOND COPY of `applyHouseTiles`, inline**, with the door
   hard-coded south and the floor to PATH. Two implementations of one thing, and only
   one got updated: a stilt house saved with a plank floor reloaded with a beaten path.
   **If you change how a house is built, grep for every place that lays house tiles.**
4. **`applyServerHouses` dropped `type` and `doorSide`**, and `netHousePlace` never sent
   them, so every sync reverted a stilt house to a cabin with a south door. Both ends
   carry them now; the server bounds them.
5. The placement preview called `canPlaceHouseAt` without the type, greening sand for a
   house that then refused it.

⚠ **Every new house field is optional on read.** Houses saved before this release have
no `type` and no `doorSide`, and neither does anything an older client broadcasts. All
fallbacks are "behave exactly like the old single house type".

**Dev:** `_dev.house()` reports what could be built where you stand *and why not*;
`_dev.house(id)` builds one; `_dev.house(null)` lists the coast plots.

#### Still open on the coast
No coast NPCs (a harbourmaster and a shopkeeper are the obvious two), no coast-specific
mobs, and `COAST_HOUSE_PLOTS` is exported and used only by `_dev.house(null)` — nothing
steers the player to the plots or reserves them.

---

### 2026-09-20 — v0.14.0: the Saltmere coast, the second surface region

A 200x120 coastal region below the dungeon band — open sea, wadeable shallows, beach,
inland woods, a cliff ridge, Saltmere village with three piers, and six cleared house
plots. Generated from a fixed seed into the same tile array the dungeon floors use, so
nothing in the engine had to learn what a "map" is.

**⚠ MAP_H AND TERRAIN_MAP_H ARE NOW TWO DIFFERENT NUMBERS. Do not collapse them.**
`MAP_H` (680) is how many tile rows exist. `TERRAIN_MAP_H` (554) is how many rows the
SHARED ground texture covers, and it is frozen. The overworld+dungeon ground is one
canvas uploaded as a single texture — 3840x4432, ~65 MB, and already past the 4096
`MAX_TEXTURE_SIZE` that older phones report. Growing `MAP_H` alone would have grown that
texture for **every player on every device**, including the ones it already does not fit
on, to pay for a region most of them are not standing in.

So a region below `TERRAIN_MAP_H` **brings its own ground surface**. `paintTerrainRegion`
now takes a `surface` ({ctx, tx0, ty0, tx1, ty1, tex, mesh}) and defaults to the shared
one, so every old caller is unchanged. Saltmere's is 1600x960, about 6 MB, and **does not
exist until somebody sails there** (`ensureCoastSurface`). Built once and kept — re-baking
24 000 tiles every trip to reclaim 6 MB is the wrong trade.
  - ⚠ The painter keeps GLOBAL tile-pixel coords for the noise and the warp even when the
    destination canvas starts elsewhere. Only the destination offset is surface-relative.
    Make them surface-local and the coast gets a different grain from the mainland at the
    same world position.
  - The **water surface needed nothing**. It is one camera-following quad driven by a
    mask, so adding SHALLOWS and DOCK to `_isWaterTile` was the entire change. Worth
    remembering for the next region: water is free, ground is not.

**Four new tile types** — SAND, SHALLOWS, DOCK, CLIFF. Adding one means touching, at
minimum: `T`, `BLOCKING`, `TILE_COLORS`, `GROUND_TILE`, `_flatSet`, `_isWaterTile`,
`npcWalkable`, and the palette override in `_buildPalette` if it sits under water.

#### ⚠⚠ TWO BUGS THIS TURNED UP THAT WOULD HAVE SHIPPED SILENTLY
1. **The world server hardcoded `MAP_H = 554`** and clamps every player's y to
   `MAP_H * TILE`. The coast spans world y 26880-32640, so the server would have clamped
   every coast position back to 26592 and dragged players off the region the moment they
   moved — **while single-player worked perfectly.** `world-data.json` already carried
   `mapW`/`mapH` and `mobs.js` already read them from there; only `bravo-room.js` retyped
   them. It derives them now. **Regenerate `world-data.json` after any world change:**
   `node --experimental-default-type=module server/build-world-data.mjs`
2. **`G.inDungeon` was `player.y >= DUNGEON_Y0*TILE` with no upper bound** — correct only
   while the dungeon was the last band on the map. The coast is below it, so the whole
   beach counted as dungeon: cave ambience, the floor readout, everything gated on that
   flag, in daylight on a beach. **Any new band below an existing one will hit this class
   of bug — grep for bare `>=` comparisons against a band's Y0.**

#### Five more caught by review before commit
- `updateTerrPx`'s null-surface guard was an early `return`, which took `buildWaterField()`
  and the mask dirty flags with it. It skips only the paint now.
- `_mainSurface.tex` was never assigned, so the dirty-flag branch worked purely because the
  field stayed null. Every surface carries its texture now.
- `wadeableAt` returned true for **any** `T.WATER` — written when all water was rivers. The
  coast is flat (`terrainFlatAt` returns 0 below y484) so `riverDepth` never carves a bed
  and the drowning check can never fire: you could stroll across the ocean. Deep water is
  wadeable only above `COAST_Y0` now; SHALLOWS is the coast's wadeable water.
- **SHALLOWS painted its own blue on the ground UNDER a blue water surface** — exactly the
  "vivid cobalt collar" the `GROUND_WATER_RGB` comment exists to prevent, on the one
  waterline players actually look at. It paints wet sand (`GROUND_SHALLOWS_RGB`).
- `G.onCoast` is declared in `state.js` beside `G.inDungeon`.

**Known edge, deliberately unfixed:** the warp samples neighbouring tiles without knowing
about surface boundaries, so the coast's first row can pull a colour from the separator
above it. Invisible today (those rows are sealed CLIFF). Revisit when a region puts
walkable ground against a band edge. Noted at `_surfaceAt`.

#### Testing
`npm test` now runs both harnesses. **`tools/test/world.mjs` — 71 checks**: array shape;
every tile id in the map is declared AND has a `BLOCKING` entry (a missing one reads
`undefined`, which is falsy, so the tile is silently walkable); overworld and dungeon still
intact after the coast generator writes into the same array; separators solid; region
sealed; tile mix; and a flood fill from the boat landing proving the village, piers and
every house plot are reachable and that the coast does **not** leak into the overworld.
Proven to fail: dropping CLIFF from `BLOCKING`, and punching a hole in the separator.
It stubs `document.createElement` because `state.js` makes an offscreen canvas at import.

#### ⚠ WHAT IS NOT DONE YET — the region is not reachable in normal play
`COAST_MAINLAND_DOCK` (150,372) is declared and **nothing uses it**. There is no boat, no
travel UI, no arrival. Today the only way in is `_dev.coast()` / `_dev.coast('village')` /
`_dev.coast('home')`. Also still to do: coast NPCs (a harbourmaster and a ferryman are the
obvious two), coast-specific mobs, and wiring `COAST_HOUSE_PLOTS` into the housing tool so
the six plots can actually be built on.

---

### 2026-09-19 — v0.13.0: every NPC is a different person now

**The problem was the BUILD, not the outfits.** `RIG_STYLES` already dressed thirteen
roles differently, but `spawnNPC()` handed every one of them the same
`configureRig(g, color, 15,48,10, 4.3, …)` and the same `0xcaa472` face. One height, one
width, one head, one skin. At the distance you actually play at the outfit is a colour
and the silhouette is the person, so thirteen colours of the same figure still read as
thirteen copies.

A style now carries `build {bw,bh,bd,hr}` and `skin`. ⚠ **The build must go to
`configureRig` AND `applyProp`** — applyProp derives the hand position from bw/bh/bd
itself, so handing it the old 15/48/10 while the body is 19/50/13 leaves the hammer
floating beside the arm. Smith 19×50×13 against grave robber 13×44×9 is a difference you
read before you can make out a face.

**Eighteen new dressing pieces** in `render/humanoid.js`, all from the existing tube/slab
primitives, still one draw call per style: tabard, sash, mantle, collar, gorget,
medallion, pouch, scrollCase, quiver, toolLoop, backpack · longHair, topknot, coif,
circlet, spectacles, maskScarf, plume, mustache. `slab()` gained free-axis rotation
(a number is still rotX, so old callers are untouched) and `oriented()` places a built
tube at an angle.

- **The fletcher had no stand-in at all** (`fallback:null`). On hardware where
  `SKINNING_OK` is false — the whole reason stand-ins exist — his corner of the market
  was permanently empty, and on every device it was empty for the first second of every
  load. Fixed, with a quiver.
- **Bandits are dressed.** `ESTYLE`, wired into the `syncEntities` rig path beside `PROP`.
  Bandit is the **only** enemy type with no entry in `MOB_MODELS`, so unlike every other
  mob its procedural rig *is* the mob, on all hardware.
- **Twenty guards were twenty identical men.** Now three builds × five skins.
  ⚠ Three and not twenty because `dressGeo()` caches the merged outfit by style AND body
  size — continuous jitter would mint twenty helmet+tabard+cloak buffers, which is what
  that cache exists to prevent. Skin varies freely; it is a material colour and free.

#### `npm run test:dressing` — and why it had to exist
`mergeGeometries()` returns **null** instead of throwing when parts disagree on
attributes. A null merge is invisible: `dressRig` sets `visible=false` and the NPC stands
there undressed, which looks exactly like "the GLB has not loaded yet" — the precise
state stand-ins exist to cover, so nobody would look twice. `tools/test/dressing.mjs`
builds all thirteen outfits headless and asserts the merge survived, the colour attribute
is present and full-length, no NaN, no stray `uv`, and the three shared body geometries
still fit their unit spaces. **29 checks.** Proven by sabotage: removing
`slab()`'s `deleteAttribute('uv')` produced 25 failures, restoring it produced 0.
It borrows the platform build's vendored three (there is none in `node_modules` — the
game gets three from a CDN import map) and stages copies in a temp dir with its own
`package.json` `{"type":"module"}`, because `three.module.js` is a `.js` file node
otherwise parses as CommonJS.

#### Six defects caught by review before commit — three were INVISIBLE GEOMETRY
Worth reading, because the test suite could not have found any of the first three:
1. **The coif was wider than the helm over it**, so mail swelled through the steel on all
   twenty guards. Shrinking the crown was not enough — measuring the live buffer showed
   the side drape still at r 1.27 against a helm flare of 0.84. It now ends **below the
   rim**, where there is no helm at any radius. Tune the helm rings and you must retune
   these together.
2. **`hood` was a closed tube** whose front face sat at z −0.84, ahead of the nose
   (−0.73) and the eyes (−0.54). It never "left the face in shadow" — it sealed the head
   in a bag, which is why the scholar's new spectacles and the cryptologist's mask
   rendered as *nothing*. Rebuilt open-fronted (crown cap + back/side slabs + a brow
   overhang), the same construction `coif` and `longHair` use.
   **⚠ THE GENERAL RULE, now written at the top of the head-dressing section: anything
   that wraps the head is slabs at the back and sides, never a closed tube.**
3. **The healer's pouch was inside her floor-length robe** — robe half-width ≈6.9 at that
   height against a pouch reaching 6.2. It rides at the belt on full-robe styles now.
4. Quiver fletchings were placed from the tube's *pre-rotation* anchor, so they sat beside
   the mouth instead of in it (`oriented()` rotates then translates).
5. `_dev.rig()` previewed every role at a hard-coded 16/36/11 with hr 6.5 — a genuinely
   different dressing buffer from the shipped one, in the one tool meant for judging
   outfits. It reads the real build and skin now; 4th arg overrides for close-ups.
6. A superseded comment header above `RIG_STYLES`.

**How the invisible ones were proven fixed:** by classifying the merged head-dressing
buffer's vertices **by colour** in the live scene (`_dev.scene`, sRGB→linear on the hex to
match) and asking whether any hood-coloured vertex lands inside the eyes' own footprint.
Zero, on all three hooded roles. That technique is worth reusing — a merged single-mesh
outfit has no other way to ask "which piece is this vertex".

#### ⚠ NOT VISUALLY SIGNED OFF — one thing for Jessie
Everything above is verified geometrically and against the live scene, but nobody has
*looked* at it. Screenshots need the Browser pane **displayed**: a hidden pane pauses rAF
and the game loop stops, and `#headless` did not restart it this time either (see the
Preview-pane note under "Known gotchas"). To do the pass in one step:

```
_dev.rig()      // all thirteen in a row, at their real builds and skins
_dev.rig(null)  // clear
```

Worth a specific look at: the guard's coif under the helm, the three hooded faces
(scholar / cipher / robber) now that they have faces, and whether the smith reads as
genuinely heavier than the townsfolk rather than just taller.

---

### 2026-09-19 — history scrub: the origin IP is out of the branches, NOT out of the PR refs

Jessie authorised a force-push over published history to remove the VPS origin IP rather
than leave it exposed until an IP rotation can be scheduled. Done, with one limitation
that is **not fixable from a git client** — read to the end.

⚠ **This file is tracked in the public repo, so the IP itself is not written here.** An
earlier draft of this very entry quoted it, which would have re-published the exact string
the scrub had just removed. Refer to it, never print it — that goes for every tracked file.

**Backup first.** A `git bundle create --all` of the whole pre-scrub repo (81 MB) is at
`Desktop\GIT_HISTORY_BACKUPravo-pre-scrub-20260919-220917ull-repo.bundle`, with
`refs-before.txt` beside it. Everything below is recoverable from that bundle.

**What carried it.** A scan of every commit on every ref found the IP in three paths across
7 commits: `deploy_to_vps.bat`, `deploy_server_to_vps.bat`, and **`tools/vps_audit.sh`** —
that third one lived on `claude/medieval-game-optimization-7kqbe2` and would have been
missed by scrubbing only the two obvious scripts. **Scan, do not assume you know which
files.** No passwords, private keys or `ORION_SECRET` values were found anywhere in history.

**The rewrite.** `git filter-branch --index-filter` removing those three paths from all
branches and tags, `--prune-empty`, then force-pushed. Every SHA in the repo changed.
  - `claude/read-handoff-docs-mks17r` (45 commits) and `claude/snowboard-game-ski-runs-qzzygi`
    (9 commits) came through **complete** — same commits, new SHAs.
  - `claude/medieval-game-optimization-7kqbe2` **collapsed to the master base**, because its
    one unique commit contained nothing but `tools/vps_audit.sh`. The script was rescued to
    `tools/vps_audit.sh` on disk, is now gitignored, and a copy sits in the backup folder.
    No work was lost.
  - The two 2026-09-12 "Delete deploy_*.bat" commits vanished as empty, which is correct —
    there is nothing left for them to delete.

**Two traps in the local cleanup, both of which made the purge silently incomplete:**
  1. **`git stash` anchors the old history.** The in-progress work was stashed across the
     rewrite, and a stash commit's parent is the pre-rewrite HEAD — so the entire old chain
     stayed reachable and `gc` kept every leaked blob alive. Pop the stash before pruning.
  2. **A stale `.keep` file on a packfile defeats `gc`, `prune` and `repack` entirely.**
     `.git/objects/pack/*.keep` marks a pack as permanently retained. `git fsck` cheerfully
     reported the blobs as *unreachable* while every prune left them in place, which reads
     exactly like a git bug. Delete the `.keep`, then
     `git repack -a -d -f --unpack-unreachable=now`. Also delete `.git/ORIG_HEAD` and
     `.git/FETCH_HEAD`, which prune treats as roots.
  - Verify by walking **every object in the store** (`git cat-file --batch-all-objects`),
    not with `git log`: a `rev-list --all` scan cannot see unreachable objects and reported
    "clean" while three leaked blobs were still sitting in the pack.

**⚠⚠ WHAT IS STILL EXPOSED, AND WHY GIT CANNOT FIX IT.** A fresh `--mirror` clone confirms
all four branches are clean — and that **GitHub's pull-request refs still hold the old
commits**: `refs/pull/1/head` and `refs/pull/4/head` (PRs #1 merged, #4 closed), plus
`refs/pull/2/merge` and `refs/pull/3/merge` (PRs #2 and #3, both open).

`refs/pull/*` is created and owned by GitHub. **No client can delete or force-push it**, so
the IP stays fetchable from a public repo by anyone who clones those refs or knows the SHA.
The rewrite did not finish the job and could not. Remaining options, most complete first:
  1. **Rotate the origin IP** — Jessie's stated plan, and the only fix that does not depend
     on GitHub. Makes every surviving copy worthless.
  2. Ask **GitHub Support** to purge the stale refs and unreachable objects — the documented
     route, and the only one that removes the data itself.
  3. Make the repo **private**, which stops anonymous fetches of `refs/pull/*`.
  4. Delete and recreate the repo — total, but loses issues, PRs and history.

Until one of those happens, **treat the origin IP as public.** The Cloudflare-range lock and
the SSH hardening from 2026-09-08 are what is actually protecting that box, and they always
were — the scrub reduces casual discovery and nothing more.

---

### Stopping point — 2026-09-19 (Phase 0: safety baseline)

**~3.3k lines of source and 12 new modules were uncommitted, on one disk only.** The
last local commit was 2026-08-26 (v0.7.x era) but `build-info.js` read **v0.12.5** and
the VPS had been serving v0.12.5 since 2026-09-11. Everything between those two points
— mobile panel layout, the character-select rebuild, `settings.js`, the whole
procedural tree system, `humanoid.js`, `fire.js`, `camera-modes.js`, `loading.js`,
`spider-gait.js`, and the `tools/` asset pipeline — had no backup anywhere. Now
committed as `1610624`, tag `baseline-v0.12.5`, pushed to `origin/master`.

**Local matched the VPS exactly.** Verified file-by-file before committing, not
assumed: the deployed client differs from `js/` ONLY by `build.mjs`'s documented
patches (vendored three.js / Draco / KTX2 import paths; Orion identity in `net.js`).
All 41 GLBs are md5-identical to the deployed set. 20 of 27 modules are byte-identical.
Nothing on the server was newer than this tree — so no work was lost in either
direction.

#### ⚠⚠ THREE THINGS THIS TURNED UP. Read these before any deploy.

**1. `origin/master` was AHEAD of local, and the two commits it had were security
deletions.** On 2026-09-12 `deploy_to_vps.bat` and `deploy_server_to_vps.bat` were
deleted from the remote (`cc03caf`, `8cd0f0f`) — four days after the origin had to be
locked to Cloudflare ranges because 82% of traffic was bypassing the CDN and hitting it
directly. **This repo is public** (`"visibility": "public"`), and both scripts carry
the VPS origin IP and SSH user. A branch cut from `bf4c4fe` — which is what this
session started on — does not contain those deletions, so committing the working tree
and pushing *resurrects both files and republishes the origin IP*. That very nearly
happened here.
  - **Both scripts are now in `.gitignore`.** They stay on disk and keep working; they
    just never get tracked again. **Do not `git add -A` and assume it is safe — check
    `git status` for them, and always `git fetch` before branching.**
  - The IP is still in the history of `9dca81c` and `cc03caf^`. Scrubbing that is a
    force-push over published history and is **Jessie's call, not a thing to do
    unprompted**. Rotating the origin IP would be the more complete fix.

**2. `deploy_server_to_vps.bat` would have broken live multiplayer auth.** It `scp`s
`server/` **raw** — there is no patch step, unlike the client. But the repo's
`bravo-room.js` was the **pre-Orion-auth** version: `maxClients = 16`, first-come
localStorage name claim, no `verifyGameTicket`. Live runs signed-ticket auth at
`maxClients = 120`. Running that script would have replaced signed-ticket auth with a
version any browser can spoof and cut capacity 120 → 16, with no error anywhere. Same
failure class as the ticket-secret encoding bug that once rejected 100% of joins.
  - Fixed: the repo now holds the copies the live server actually runs
    (`server/bravo-room.js`, plus `server/orion-auth.js`, which was missing from the
    repo entirely). `orion-auth.js` reads its key from `ORION_SECRET` /
    `ORION_SECRET_FILE`, so no secret is committed.
  - ⚠ `orion-auth.js` decodes `ORION_SECRET` as **utf8** but `ORION_SECRET_FILE` as
    **hex**. Production uses the FILE path and works. If anyone ever switches to the
    env var, the mismatch rejects every join — that has already cost one outage.

**3. Local-only deploy-script fixes (they are gitignored, so this note IS the record):**
  - `deploy_to_vps.bat` pointed at
    `Desktop\ORION_GUILD_WEBSITE_WORKING_FOLDER\orion-platform`, which no longer
    exists — the platform repo moved under **`Desktop\Server Migration\`**. The client
    deploy aborted at step 2 as written. Path corrected.
  - `deploy_server_to_vps.bat` now (a) includes `orion-auth.js` in the `scp` list, since
    the room `require`s it at startup and the server would crash on boot without it, and
    (b) refuses to deploy a `bravo-room.js` that does not call `verifyGameTicket`, so
    fault 2 above becomes a loud abort instead of a silent auth downgrade.

---

### Stopping point — 2026-08-26
Achievement system / boss HP bar / NPC minimap dots committed and pushed; client and
world server redeployed to the VPS. See the session note in "Known gotchas" about the
stale `HEAD.lock` — that was why the 2026-08-08 session could not push.

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

**GTAO: DONE.** The `fxGroup` virtual group is live (`game3d.js` ~lines
11266-11286), populated by a `refreshFxList()` traversal at boot and passed into
`createComposer`. Ultra tier carries `gtao:true` in `quality.js`; the pass itself
is implemented in `composer.js` with fxGroup hide/restore in a `try/finally`.
Measured 142.9fps / 7.0ms on an RTX 2050 (vsync-capped).

**Critic-pass items — all resolved 2026-08-08.** Three of the four turned out to
be misdiagnoses, which is why the warning above said to verify before acting:
- **Characters don't attenuate at night** — ✅ NOT A BUG. `makeRig()` already uses
  `MeshStandardMaterial` for all four materials; IBL dims via `applyEnvIntensity`,
  ambient and directional dim via `updateEnvironmentCycle`.
- **Red cast at night** — ✅ NOT A BUG. It is **Vampire Night Vision**
  (`playerLight` at `#e06075`, intensity 0.85, gated on `player.race==='Vampire'`
  in `updateEnvironmentCycle`). The suspicion recorded above was right: the blue
  night ambient was never the cause.
- **Dusk reads neutral** — ✅ FIXED AND VERIFIED. `horizonF` divisor 0.30 → 0.55
  in `sky.js` (~line 539). Verified: 19:00 reads `[1.21,1.17,1.00]` warm, 20:00
  reads `[0.32,0.16,0.08]` deep amber.
- **Forest is a grid of clones** — ✅ NOT A BUG. Per-tree position/girth/height/
  Y-spin jitter is already live, hashed from tile coords in `rebuildTrees`.
The `calls:1, tris:1` claim was wrong for the reason stated above (that's
`renderer.info` reflecting the composer's final fullscreen pass).

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
- ⚠ **A stale `.git/HEAD.lock` silently blocks every commit and push.** The 2026-08-08
  session ended with a crashed git process that left a **zero-byte `.git/HEAD.lock`**
  behind. Git then refused every ref write for 18 days with *"Another git process seems
  to be running"* — which is why that session's work sat uncommitted and "we couldn't
  push". The existing `.bat` helpers only delete `index.lock`, **not `HEAD.lock`**, so
  they never cleared it. If a commit or push fails with that message, check for **both**:
  `ls .git/*.lock`. A `git fsmonitor--daemon` process in the process list is normal and
  is *not* the culprit — check the lock file's timestamp instead; if it is old and
  zero-byte, delete it.
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
4. ✅ **Achievement system** (DONE 2026-08-08): 15 permanent per-character milestones across combat, progression, dungeon, and world categories. `G.achiev` (a Set, serialised as an array). `grantAchiev(id)` is idempotent. Gold trophy toast top-right (4.4s, fade in/out, **queued** so back-to-back grants don't overlap). Achievements are listed in the quest journal (J). Wired to: kill count (1/100/500), champ/boss kills (Gravebinder/Molloch), levels (10/25/50), dungeon entry + floor 5, relic spend, curator bounty, first house, any skill at 10. Save/load/reset wired. `G.totalKills` and `G.gambitHinted` are now correctly persisted too (they previously were not).
   *(Not selected for future)* Museum-collection meta for completionists.

### Systems that already exist but testers rarely find (surface them via contracts/quests)
✅ **DONE 2026-08-08 — all five are now surfaced.**
- **Hidden NPCs**: all four (Antiquarian, Museum Curator, Cryptologist, Grave Robber) now have `[E]` proximity labels and coloured ♦ dots on the minimap, plus an entry in the TOWN & GOLD help section.
- **Contracts**: `antiq` and `bounty` added to the board template pool. `questEvent('relic')` fires on an antiquarian purchase; `questEvent('bounty')` fires on curator bounty fulfilment.
- **New quest — Relic Seeker** (spend a relic at the antiquarian), appended to the chain as the bridge between the altar boss drop and the artifact system. The "all quests complete" floater now points players at the contract board.
- **Boss HP bar**: named floor bosses now show a top-centre HP bar with an enrage tag — a 1080 HP fight with no readout was disorienting.
- Champion altars (wave defense) — surfaced via the quest chain + `altar` contract ✓
- Museum Curator (rotating bounty) — minimap dot + label + `bounty` contract ✓
- Antiquarian (relic shop) — minimap dot + label + `antiq` contract + Relic Seeker quest ✓
- Gambit engine — in the Y-key help text; hint floater fires after the 5th career kill (`G.gambitHinted`) ✓
- Housing — in the quest chain (wall quest) + HOUSING help section ✓

---

## Conventions
- **End every session**: commit, then update this file's "Current state" + "Roadmap" with your stopping point.
- **Before big edits to `game3d.js`**: re-read the region right before editing (it's ~8k lines and shared).
- **Verify behavior**, not just load — drive the real flow (`_dev.simulateKill`, open the panel, check `localStorage`). Load-without-error ≠ works.
- New full-screen panels must be added to `uiBlocking()` and `modalOpen()`, get a render call in the draw list, and a click route in the mouse handler.
