# Changelog

Everything on branch `claude/read-handoff-docs-mks17r`, newest first. Written for
someone who has to deploy this, break it, or fix it later — so each entry says
what changed, **why**, and what to watch when it goes live.

⚠ **None of this has been played yet.** It is verified by automated tests, a
headless browser boot, and end-to-end runs against a real server — but no human
has held the controls. The "watch for" notes under each entry are what to check
on the first real session.

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
