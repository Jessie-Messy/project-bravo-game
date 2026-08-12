# Hotfix runbook

For the person (or model) fixing this in production at speed. Symptom → cause →
fix. Written because most of the failures below are **silent**: the deploy log is
green, the page loads, and the thing that is broken looks fine from the outside.

Read `HANDOFF.md` for where the project stands. This file is only "it is broken,
what now".

---

## 0. First five minutes

```bash
curl -s https://orionsyndicateguild.org/health | jq     # or localhost:2567/health
ssh …vps  'pm2 describe bravo | grep -E "status|restarts"'
ssh …vps  'pm2 logs bravo --lines 80 --nostream'
```

`/health` is deliberately verbose. Read every field:

| field | bad value | means |
|---|---|---|
| `ok` | absent / no response | server down or nginx not proxying |
| `uptime` | keeps resetting | **crash loop** — read the logs, it is almost always a missing file |
| `resourceLayer` | `false` | `world-data.json` is stale/old → **every gather is refused** |
| `worldData` | `false` | world-data.json missing → mob AI off too |
| `storage` | `json` | `better-sqlite3` failed to build → running on the JSON fallback |
| `schemaVersion` | not 2 | old `character.js` deployed |
| `oplog.disabled` | `true` | not recording — the Phase 2 evidence is being lost |
| `oplog.dropped` | `> 0` | log hit its daily size cap |

Then the operations log, which outlives the console:

```bash
cd /home/ubuntu/bravo-server/data
node ../../tools/oplog_report.mjs oplog-$(date +%F).jsonl   # summary
grep '"ok":false'        oplog-*.jsonl | tail -50           # refusals
grep '"t":"divergence"'  oplog-*.jsonl | tail -50           # Phase 2 gate
grep '"name":"Gideon"'   oplog-*.jsonl                      # one character's session
```

---

## 1. Deploying

```
deploy_server_to_vps.bat     world server  (node/pm2 on the VPS)
deploy_to_vps.bat            game client   (static files under /var/www)
```

Both run `tools/check_deploy.mjs` first and **abort if it fails**. That preflight
reads the deploy scripts themselves and proves every `require()` and boot-time
`fetch()` is actually copied.

> ⚠ It exists because both scripts listed their files **by hand** and went stale
> the moment a file was added. The server script never learned about
> `accounts.js`, `character.js`, `tx.js` or `shared/`; the client script never
> learned about `shared/`. Neither failure shows up as a red line at deploy time.
> **Never replace the wildcards with a hand-written list again.**

### Two nginx blocks, not one

Nothing in the repo can verify these — they live on the VPS.

- `/bravo-ws/` → the websocket world server. Missing: nobody connects at all.
- `/auth/` → `register` / `login` / `characters`. Missing: **every login 404s in
  production while working perfectly on localhost**, because dev talks to
  `:2567` directly and production expects a same-origin proxy
  (`authOrigin()` in `js/net.js`).

### After ANY world edit

```bash
node server/build-world-data.mjs      # the deploy script does this for you
```
Skip it and the server's resource layer disagrees with the client's map: players
chop a tree the server does not believe is there, and **gather is silently
refused**. `/health` reports `resourceLayer` but cannot tell you it is *stale* —
only that it exists.

---

## 2. Failure modes seen at least once

### "Crafting does nothing / says I can't afford it"
`shared/recipes.json` did not load. The client fetches it at boot; a 404 leaves
the table empty and **every** recipe is refused.
- Check: `curl -I https://…/shared/recipes.json` → must be 200.
- Cause: `shared/` not deployed (see §1).
- ⚠ Do **not** "fix" this by hard-coding costs back into `game3d.js`. That
  duplication is what the shared table removed — the costs were previously
  stated twice in that file alone (`canCraft` gate + `doCraft` subtraction) with
  nothing keeping them in step, and the server now reads the same file.

### Server crash-loops immediately after deploy
Almost always a missing local file — `require()` throws at load. pm2 reports the
restart as successful and `/health` may still answer from the stale process for
a few seconds.
- `pm2 logs bravo --lines 50 --nostream` names the module.
- Run `node tools/check_deploy.mjs` locally; it will name it too.

### "My items vanished" / duplicated
Read the accepted-transaction stream, not just the refusals:
```bash
node tools/oplog_report.mjs        # ITEM FLOW section, per character
grep '"name":"<char>"' server/data/oplog-*.jsonl | grep '"ok":true'
```
Invariants that must hold — if one is violated, that is the bug:
- **Nothing half-applies.** `server/tx.js` builds a delta, validates completely,
  and only then commits. A craft that spent the ore and then failed the tier
  check would destroy the ore.
- **Banking never changes total gold.** `wallet.gold + wallet.bank` is invariant
  across any `bank` transaction.
- **`requires` is held, not spent** (only `wall` uses it — the plank is consumed
  when the wall is placed, not when it is crafted).

### Gathering refused on obvious trees
1. `resourceLayer: false` in `/health` → regenerate `world-data.json`.
2. Otherwise `"too far away"` in the oplog → the server's idea of the player's
   position is stale. Reach is `HARVEST_RANGE + 1 tile` (`GATHER_RANGE` in
   `bravo-room.js`) precisely to absorb 10Hz staleness; widen it there, not by
   removing the check.

### Login works locally, 404s in production
The `/auth/` nginx block. See §1.

### A player hits "slow down"
The blanket rate limit (25 tx/sec, `bravo-room.js`). A legitimate player should
never see it — it is the backstop for every validation gap. If real players hit
it, find the client loop spamming intents rather than raising the cap.

### Trees look wrong after touching `js/render/trees.js`
```bash
node tools/check_canopy.mjs /path/to/three/build
```
Asserts each canopy is **one connected blob** and fits its height box. Overhead
renders cannot catch a detached lobe — from above it still lands on the crown's
footprint. Four of five variants once shipped in pieces.

---

## 3. Where things live

```
js/game3d.js         the game (~12k lines). Crafting, UI, rendering, input.
js/net.js            client networking + accounts + netTx()
js/render/*.js       trees, grass, water, sky, terrain
shared/*.json        ⚠ economy tables read by BOTH sides. One source of truth.
server/index.js      express: /health, /auth/*
server/bravo-room.js the Colyseus room. All message handlers.
server/tx.js         transaction engine — pure (doc, intent, ctx) → result
server/character.js  the character document, live cache, batched writes
server/oplog.js      append-only JSONL operations log
server/data/         ⚠ gitignored. SQLite DB, accounts, oplog. NEVER deployed.
tools/check_*.mjs    fast renderer-free checks — run before committing
```

### Things that will bite you

- **`server/data/` is gitignored and must never be shipped.** It is the live
  database. The deploy scripts do not touch it; keep it that way.
- **`VPS_INFO.md` is gitignored on purpose** (server details). It does not exist
  in a fresh clone. Do not commit it.
- **Document writes are batched (2s).** `character.js` holds ONE live instance
  per character; mutate it and call `character.touch(name)`. Never write a fresh
  object straight to disk — use `character.replace()`, or the in-memory copy
  goes stale and the next transaction resurrects old values.
- **Colyseus messages sent from `onJoin` are dropped** — the client has not
  attached handlers yet. Send in response to an explicit request
  (`request_save`, `request_character`).
- **The server stores the save blob as a STRING** and sends it back as one;
  `loadGame()` expects an object. `net.onSave` handles both.
- **`storage.saveBlob` silently drops payloads over 200KB.** `character.save`
  refuses over 400KB but logs loudly. Silent truncation of a character is the
  worst failure this system has.

---

## 4. Before you commit

```bash
node tools/check_tx.mjs                      # 64 transaction cases
node tools/check_deploy.mjs                  # deploy covers every dependency
node tools/check_canopy.mjs <three/build>    # only if trees changed
node --check js/game3d.js                    # syntax only — NOT sufficient
```

⚠ `node --check` passing is **not** evidence the game boots. A renamed
identifier once passed the syntax check and broke boot with
`_trunkGeo is not defined`. If you changed client code, load the page and
confirm `typeof window._dev === 'object'` with no console errors.

---

## 5. Turning on Phase 2 (when the divergence log is quiet)

Two switches, and they must flip **together**:

1. `_txRollback = false` → `true` in `js/game3d.js` (the client acts on
   rejections).
2. Reduce `save` in `bravo-room.js` to non-authoritative data only and rename it
   `prefs`, so nothing can post a character to it again.

Flipping (1) alone turns every server-side modelling gap into a **visible item
loss** for players. That is why it ships off. See `docs/SERVER_AUTHORITY.md`.
