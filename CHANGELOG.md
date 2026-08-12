# Changelog

Everything on branch `claude/read-handoff-docs-mks17r`, newest first. Written for
someone who has to deploy this, break it, or fix it later — so each entry says
what changed, **why**, and what to watch when it goes live.

⚠ **None of this has been played yet.** It is verified by automated tests, a
headless browser boot, and end-to-end runs against a real server — but no human
has held the controls. The "watch for" notes under each entry are what to check
on the first real session.

---

## PHASE 2 — authority flipped for the economy

The server now owns **items, wallet, tools, tiers, armor and standing**. A client
save can no longer author any of them. The attack the whole migration plan exists
to stop — "a modified client posts a save with 10⁹ gold and the server writes it
down" — no longer works, and there is an end-to-end test that proves it.

### The line is "what the server can validate", not "everything"
The plan describes a total flip. A total flip is **not safe yet**: it would not
secure the rest, it would DELETE it. Authority can only move for state the server
can author, which today means state with a transaction — craft, buy, bank,
pickup, gather. XP, HP, skills, quests and contract progress have none, so making
the document authoritative for them would leave the client unable to write what
the server cannot yet produce, and every session would reset them.

So `character.AUTHORITATIVE` lists six fields, and progression keeps coming from
the save until Phase 3 models it. Moving a field across later is one entry in
that list plus its transaction — the mechanism does not change, which is what
stops this being rework.

### Prerequisite: the 12 unmodelled fields, closed first (schema v3)
`check_coverage.mjs` had already found them. Flipping with quests, contracts,
bounty, antiquarian stock, the armor flag and the whole mount unmodelled would
have been data loss with a release date, so they were modelled first, with an
additive v2→v3 migration. Coverage is now 0 unmodelled, 0 uncompared.

### What shipped
- `character.AUTHORITATIVE` + `adoptFromBlob` keeps the server's values for those
  six and discards the client's. The blob is still stored verbatim as a frozen
  backup, so a mistake here destroys nothing.
- A **new `prefs` message** (not a rename of `save`) for camera/UI/hotbar/gambits.
  A rename would have left one endpoint accepting both a character and settings.
- Client applies the document after `loadGame()`, replacing rather than merging —
  a merge would let a tampered save keep items the server has since removed.
  A weapon the server says you no longer own leaves your hand.
- **Rollback is ON.** Safe only because the flip landed with it: while `save` was
  a blanket override, acting on a rejection would have turned every modelling gap
  into a visible item loss.

### Two functions were untestable, and one test passed vacuously
`applyAuthoritative` and `reconcileTx` were both written inside the net-wiring
function, so they only existed once a socket was open. `reconcileTx` is the one
code path that **removes items from a player's pack**, and the first browser test
of it called a null handler and reported success. Both are at module scope now,
and `tools/check_client.mjs` exercises them in a real browser: 14 assertions
covering the document overwrite, item clearing, weapon demotion, and rollback of
item, plank and gold predictions.

**Watch for:** on a player's first join after this ships, the document wins — so
a local save that disagreed will appear to "lose" items. That is the flip working.
The blob backup is intact if a document turns out to be genuinely wrong.

---

## Operations & deploy

### Deploy scripts were shipping a broken server — fixed
`deploy_server_to_vps.bat` listed its files **by hand**, so every file added
after it was written was silently left behind: `accounts.js`, `character.js`,
`tx.js`, and the whole `shared/` folder. The server would have `require()`d a
missing module and crash-looped, while pm2 reported a successful restart and
`/health` could still be answered by the stale process for a few seconds.

`deploy_to_vps.bat` had the same class of bug for the client: it never copied
`shared/`, and `js/game3d.js` fetches `shared/recipes.json` at boot — so
**crafting would refuse everything in production while working perfectly on
localhost.**

- Both now copy by wildcard/directory instead of a hand list.
- Both run `tools/check_deploy.mjs` first and abort if it fails.
- The server script now verifies the process is actually up after restarting
  (status, restart count, health, last log lines) instead of trusting pm2.

**Watch for:** the preflight output at the top of a deploy. If it fails, do not
deploy — the failure it describes is silent once it is live.

### `tools/check_deploy.mjs` — new preflight
Reads the **actual deploy scripts** and proves every local `require()` and
boot-time `fetch()` is covered. Reading the real scripts rather than a separate
manifest is deliberate: a manifest is a second list to forget to update.

Verified against the original broken script — it names all five missing files.
It also strips `rem`/`echo` lines before matching, because in its first version a
*comment* naming `server/tx.js` made it declare that file covered. A false
negative in a preflight is worse than no preflight.

### `server/oplog.js` — operations log
Append-only JSONL, one line per state-changing decision: every transaction
(accepted **and** refused, with the intent and the resulting deltas), every
divergence, saves, joins, leaves. `server/data/oplog-YYYY-MM-DD.jsonl`, rotated
daily, capped at 32MB/day, pruned after 14 days.

Console output was not enough: pm2 rotates it, it interleaves with mob-AI
chatter, and the Phase 2 gate ("watch the divergence log until it is quiet")
needs evidence that survives a session. Logging is best-effort and can never
throw into a transaction — a failed log line must not fail a player's craft, and
a stream error disables logging rather than taking the server down.

Never logs passwords, tokens or session ids. Does log character names, because
without them it cannot answer "what happened to this character".

### `tools/oplog_report.mjs` — read the log
Summarises: the Phase 2 gate (divergence rate, which fields, worst-affected
characters), transactions by kind with refusal reasons, per-character item flow
from accepted deltas, and sessions. Tolerates a truncated final line — a log from
a server killed mid-write is exactly when you most want to read it.

Building it immediately found a hole in the logging: rate-limit and dead-player
refusals returned before the log line, so the one refusal reason the report tells
you to investigate never appeared. Every refusal path now logs.

### `/health` now reports enough to diagnose
`schemaVersion`, `storage` backend, `worldData`, `resourceLayer`, and oplog
stats. It is the only thing a deploy can check without SSHing in, and a server
with a stale world-data or disabled logging looks completely fine otherwise.

### `docs/HOTFIX.md` — new runbook
First-five-minutes checks, deploy procedure, every failure mode seen at least
once (symptom → cause → fix), the invariants that must hold, and the two nginx
blocks nothing in the repo can verify.

---

## Third pass — closing a hole in the Phase 2 gate itself

### `tools/check_coverage.mjs` — what the divergence log will say, before anyone plays
Compares what the client SAVES (`buildSave`) against what the document MODELS
(`fromLegacyBlob`). Most of what the log will eventually report is knowable from
that difference, so the Phase 2 worklist no longer has to wait for play data. It
produced a concrete list of **12 unmodelled fields** (quests, contracts, bounty
and antiquarian stock *including their roll timers* — which the client currently
owns, so it can re-roll shop stock at will — the armor flag, and the whole
mount), 10 deliberately client-side fields for the `prefs` payload, and 2 the
server already owns through other messages.

### The gate had a hole: `diff()` compared 6 of 29 modelled fields
The other 23 could drift without ever producing a log line — so a quiet log meant
"the six compared fields agree", not "the document agrees". Since Phase 2 is
gated on that log, the gate was measuring almost nothing.

All 29 are compared now (tools, tiers, stats, skill xp, stat/skill points,
xpMax, armor slots, gear and artifact counts, contract rank, dungeon best, and
the chest/boss maps by size). `check_coverage.mjs` reports 0 uncompared, and 22
mutation cases prove each is actually detected rather than merely referenced.

`px`/`py` are excluded deliberately: the client changes position continuously and
the document does not model movement, so comparing them would report a divergence
on every save and bury every real finding. `hp` stays compared and **will be
noisy** — combat is not a transaction yet, so it genuinely diverges. That is a
true finding, not a defect in the log.

Verified end to end: the E2E suite's synthetic save now produces exactly the
expected divergence lines, and `oplog_report.mjs` groups them by field.

---

## Second hardening pass — the same technique, applied wider

The cross-check found real bugs, so it was pointed at the other two places the
client and the server duplicate knowledge.

### World constants are now verified, not commented
The server cannot import `js/constants.js` (ESM, browser globals), so it restates
`TILE`, `MAP_W`, `MAP_H`, `CITY` and the blacksmith's position by hand. Every one
is a silent, total failure if it drifts — a wrong `TILE` makes every tile↔world
conversion wrong on one side, so the resource layer, the walkability bitmap and
every range check address the wrong tiles. "Must match the client's constants.js"
in a comment is not a mechanism. `check_tables.mjs` now compares them, and also
fails if the server's gather reach is tighter than the client's harvest range
(which would refuse legitimate chops at the edge). Mutation-tested: a changed
TILE, a moved city and a moved blacksmith are each caught.

### `tools/check_world_data.mjs` — is the server's world stale?
`server/world-data.json` is a build artefact generated from the client's map.
Edit the world, forget to regenerate, and the two disagree with **no error
anywhere**: the resource layer says grass where the client draws a tree, so chops
are refused with "nothing to harvest there", and mobs path against the old map.
`/health` reports `resourceLayer: true` because the layer *exists* — it cannot
tell you it describes a different world.

The checker rebuilds in memory and compares, reporting **how many tiles** differ
(3 moved and the whole map shifted need different responses). To make that
possible without a second copy of the packing logic — which would drift and then
start passing on a wrong file — `build-world-data.mjs` now exports
`buildWorldData()` and only writes when run directly. Verified byte-identical
output after the refactor, and verified the checker catches a corrupted layer.

Both deploy scripts now run it. The server deploy already regenerated; the client
deploy did not, and ships the map the client renders from.

### `npm run check`
One command for the fast checks (tables, transactions, world data, deploy).
`check:canopy` and `check:e2e` stay separate — they need a three.js build and a
running server respectively.

---

## Hardening pass — bugs found by cross-checking the two sides

Adding `tools/check_tables.mjs` (client and server must agree about the economy)
immediately found two real bugs. Neither crashes; both present as the game quietly
not doing what it said.

### A new character had no axe → every tree chop refused
The client hands every new character an axe, 20 gold, 10 arrows and 2 bandages.
The server's `blank()` document had **no axe and an empty purse**. So for any
character whose document existed before its first save — i.e. every new player —
`gather` refused every tree chop with "need an axe", and that first save logged a
divergence on three fields, putting noise in the exact log the Phase 2 decision is
read from.

Fixed, and pinned: `check_tables.mjs` parses the client's own starting-kit line
and fails if the two drift again.

### The four gems could never be recorded
`ruby`, `sapphire`, `emerald` and `diamond` are in the client's inventory and were
missing from the server's `ITEM_KEYS` whitelist — so picking one up would show in
the client and be silently declined by the server, with one oplog line as the only
trace. Now whitelisted, and the correspondence is enforced in both directions.

### A synchronous DB read in front of every transaction
`character.ensure(name, account, storage.loadBlob(name))` evaluates its third
argument eagerly, so every transaction did a synchronous SQLite read even when the
document was already cached — defeating the point of the live cache. It now takes
a thunk and only reads when a character is genuinely new.

### Craft rejections would have rolled back to nothing
Craft intents were sent without their predicted delta, so when Phase 2 turns
rollback on, the most common transaction in the game would have reconciled
silently to nothing. The prediction is now built and sent with the intent — it is
impossible to reconstruct after the fact, because by the time a rejection lands
the inventory has moved on.

### A dead delta field
`buy()` set a `weapon` field on the delta that `commit()` never applied and the
document has no place for. Removed rather than implemented: which hand a player
holds is presentation, and belongs in the Phase 2 `prefs` payload. A delta field
nothing reads is a promise the server does not keep.

### Tests added
- `tools/check_tables.mjs` — the cross-check above, plus shop/recipe UI parity.
- `tools/check_e2e.mjs` — moved into the repo (31 assertions over a real socket),
  now including **gather accepted on a real tree tile**, and a range refusal
  tested against another *resource* tile. The first version of that range test
  used empty ground, which fails on "nothing to harvest there" first — it was
  asserting range while actually exercising the resource check.
- `check_tx.mjs` grew to 79: schema v1→v2 migration, gather acceptance per
  resource kind, the 4-logs-on-felling rule, and the gems.

### One documented sharp edge
A **partial** save is destructive: `fromLegacyBlob` coerces absent fields to
`false`/`0`, so a blob missing `hasAxe` strips the axe from the document. Real
clients always send a complete `buildSave()`, so this is not a live bug — but
anything hand-crafting a save must send the whole thing. Found because a test's
synthetic save did exactly this.

---

## Server authority — Phase 1 (`docs/SERVER_AUTHORITY.md`)

### Validated transactions over the character document
The client now states an **intent**; the server decides the outcome and answers
with deltas. Covers `craft`, `buy`, `bank`, `pickup`, `gather`.

Runs **alongside** the legacy `save`, which is still a blanket override — so
nothing is authoritative yet. Phase 1's job is proving the server can author
every one of these correctly before Phase 2 flips the switch.

- `server/tx.js` — pure `(doc, intent, ctx) → result`. No network, no clock, no
  database, which is what makes it testable without a server.
- `tx` message in `bravo-room.js`, with a blanket 25/sec rate limit as the
  backstop for every validation gap.
- Replies echo the client's `seq`. Without it a client cannot tell which of
  several in-flight intents a rejection belongs to, and would roll back the
  wrong predicted action — which presents as an item vanishing at random.

**Nothing half-applies.** A transaction builds a delta, validates completely, and
only then commits. A craft that spent the ore and then rejected the tier would
destroy the ore, and the player would rightly call it theft.

**Watch for:** `[tx] … REJECTED` lines with reasons a player would call a bug.
"not enough X" and "already owned" are normal; "too far away" on an obvious
target is not.

### Economy tables moved to `shared/` — one source of truth
Recipe costs were already stated **twice** inside `game3d.js`: a `>=` gate in
`canCraft` and a subtraction in `doCraft`, with nothing keeping them in step.
Writing the server against those would have made a third copy, and a
disagreement is either an exploit or a rejection the player cannot understand
("it says I can afford it").

`shared/recipes.json` and `shared/shop.json` are now read by the client (fetched
at boot) and the server (`require`d). `canCraft`/`doCraft` are table-driven,
which deletes the pre-existing duplication as a side effect.

The transcription was verified by **parsing the numbers back out of the live
source** before the refactor landed: all 35 recipes matched, and the two client
functions turned out to already agree, so no balance moved.

⚠ Do not re-add a copy of these costs to either side.

### `gather` needed a resource layer in `world-data.json`
The walkability bitmap could not stand in: it only says "blocked", and a tree, a
boulder, a wall and deep water are all equally blocked — so the server could not
tell a chop from a claim against a city wall. 2 bits per tile (none/tree/stone/
iron), +89KB, verified to decode identically to the client's map across all
265,920 tiles.

**Watch for:** `resourceLayer: false` in `/health`, and remember to regenerate
after any world edit or the server refuses gathers on tiles the client draws as
trees.

### Yields are the server's
A better pickaxe scales ore per swing, from the tier the server holds. The tile a
client names is a claim; what it is worth is not negotiable. Trees pay their
whole 4 logs on the felling blow only — sending an intent per chop would ask for
four times the wood.

### Live documents with batched writes (2s)
`character.js` now holds one in-memory instance per loaded character. This is a
**correctness** fix as much as a performance one: re-reading the document per
message would hand each transaction its own copy, so two in the same tick would
overwrite each other — the classic lost update, which duplicates or destroys
items depending on which lands last.

Flushed on leave and on dispose, because the batch window is a loss window.

**Watch for:** anything that mutates a document must call `character.touch()`,
and must never write a fresh object straight to disk (`character.replace()`
exists for that).

### Client sends intents, rollback written but OFF
`netTx()` in `js/net.js` carries a monotonic seq and the predicted change.
`net.onTxResult` reconciles.

⚠ `_txRollback = false` in `game3d.js` **on purpose**. While `save` is still a
blanket override the server is not the last word, so acting on a rejection would
turn every server-side modelling gap into a visible item loss. Phase 2 flips it
in the same commit that reduces `save` — the plumbing is already there.

### Deliberately left for Phase 3
`chest_move` and `equip` — the document does not own chest contents or authored
equipment yet, so a transaction over them would be theatre that Phase 3 has to
undo. And `gather` has no per-node HP or respawn, so a modified client can
re-harvest an exhausted node up to the rate limit.

### Tests
`tools/check_tx.mjs` — 64 cases, mutation-tested against three injected bugs
(skipping the affordability check, spending `requires`, ignoring proximity),
caught by 6, 1 and 5 failures respectively. Plus 24 assertions end-to-end over a
real socket that read the **stored** document back rather than trusting the reply.

---

## Server authority — Phase 0

### The character document
`server/character.js` — server-side character record with `schemaVersion` and a
migration function, imported once from the legacy save blob. The blob column
stays as a frozen backup; deleting it would make a modelling mistake
unrecoverable.

Gold split out of `items` into `wallet` so currency can be handled distinctly by
shops, bank and trade instead of special-casing an inventory key forever. ARPG
items got stable ids on import, with the equipped weapon/armor **aliased** onto
the matching inventory item — assigning ids naively gave one logical sword two
identities, and every later system that moves an item by id would have to guess.

### Divergence logging
Every client save is compared against the document and the differences logged.
This is the cheap way to discover every place the client mutates state that is
not modelled yet, and it is the gate on Phase 2.

Two early fixes stopped it crying wolf: HP arrives as a float (regeneration
accumulates fractions, so a healthy character saves as `100.09985000000003`) and
was logging a divergence on literally every save; and a field the client did not
send is silence, not a divergence — coercing absent to 0 made every optional
field report a fake delta.

### `standing` — kills, deaths, notoriety (schema v2)
Server-owned from the start, before anything reads it. These feed a
notoriety/stature system where guards and NPCs react, which makes them
**reputation, not statistics** — the one category a client must never author,
since posting your own kill count would be posting your own standing with every
faction. Deliberately not seeded from the client save.

### Three architecture decisions recorded
In `docs/SERVER_AUTHORITY.md` under "Decisions taken", because each removes a
constraint the plan was written to respect:
- **Offline is demo/tutorial only** → retires the dual-side-purity requirement
  (roughly half the transaction layer, and every divergence between the halves).
  Condition that brings it back: nothing done offline may be promoted into an
  online character.
- **Kills/deaths are server-owned reputation** (above).
- **Document writes batch on a 2s timer** — chosen for playtesting; must be
  paired with a flush on disconnect and dispose.

---

## Accounts

Server-owned username/password accounts (`server/accounts.js`, `js/login.js`),
scrypt-hashed with a per-account salt and constant-time compare. Identity used to
be a random per-device token in localStorage — that token **was** the identity
and could not leave the browser that made it, so logging in from a second
computer generated a new one and the server refused the join. You could not reach
your own character from another machine.

The login overlay is deliberately DOM, not canvas, for password masking,
autofill and mobile keyboards.

**Watch for:** the `/auth/` nginx block. Without it every login 404s in
production while working perfectly on localhost.

### Three cross-machine bugs found in one chain
- The join name read `bravoName`, a key nothing ever wrote except the random
  fallback — so picking "Gideon" still joined as "Traveler1234" and loaded
  Traveler's empty save.
- The save pushed from `onJoin` was dropped: the client had not attached its
  handlers yet. It is now requested explicitly.
- The save was sent as a **string** into `loadGame()`, which expects an object —
  swallowed by a `try/catch`, so it looked like the feature simply did not work.

---

## Art

### Trees — canopies were built in pieces
Four of five canopy variants were **disconnected** — one was in three parts — so
the wood had leaf balls hanging in the sky with nothing under them. Every
overhead render looked correct, because from above a detached lobe still lands on
the crown's footprint. Only a low-angle shot showed it.

Not a tuning problem: the canopy box is ~146 units tall while a lobe is ~46
across, so a crown must bridge ~160 units with a handful of masses. A mass count
below what that needs makes a crown *physically unable* to hold together at any
placement. The count is now **solved** from height, radius and weld distance;
masses are welded to the nearest already-placed one; the chain builds bottom-up
so it climbs from the core instead of dragging the top mass down.

Also fixed the "broccoli" read (a dozen similar-sized lobes each with its own lit
cap) with a real scale hierarchy, and rebalanced the bake so the crown-height
ramp dominates — lighter on top, darker underneath. Per-tree crown colour via
`instanceColor`, because five variants gave enough silhouette variety but every
crown was the same *value* and a stand fused into one green mat from above.

`tools/check_canopy.mjs` asserts both invariants with no renderer.

### Grass, water
Finer blades with a real alpha silhouette and travelling wind; a real shore
gradient for water via wider mask sampling. (The handoff's own note about water
coverage turned out to be wrong and was corrected.)

### Lighting
The hero and horse rendered as self-lit stickers at night. Cause was in the GLB
itself: `emissiveFactor [1,1,1]` with the emissive texture pointing at the same
image as base colour. Found by parsing the GLB JSON chunk after two wrong
theories were falsified by measurement.

⚠ A layer-confined fill light does **not** work in three.js — lights are filtered
by *camera* layers, not per-object. That attempt was reverted.

---

## Placeables

Chest and workbench: placeable anywhere, 5000-slot chest that works like the
pack, lockable when inside a house you own. Ground under placed objects is
cleared so props are visible.

Two failures worth remembering: the chest panel was **taller than the viewport**,
so the lock button was off-screen and unclickable while every functional test
passed (now clamped, with wheel scroll); and "the chest is invisible" turned out
to be contrast, not geometry — it *was* rendering, and a magenta-tint probe
settled that in seconds.
