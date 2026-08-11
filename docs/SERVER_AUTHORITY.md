# Server Authority — migration plan for production

Status: **plan agreed, not yet implemented.** Written 2026-08-11, at the point
the project moved from prototype to pre-beta.

The goal is stated as: build it so we do not have to go back and redo anything.
That constrains the design more than "make it authoritative" does — the ordering
below exists specifically so no step has to be undone by a later one.

---

## The one finding that shapes everything

**`save` is a blanket override and it defeats every other measure.**

Today the client calls `buildSave()` and streams the whole character — inventory,
gold, XP, skills, equipment — and `bravo-room.js` stores it verbatim:

```js
this.onMessage('save', (client, blob) => { ... storage.saveBlob(p.name, str); });
```

Validating resource gathering, or moving loot rolls to the server, buys nothing
while this exists: a modified client posts a save with 10^9 gold and the server
writes it down. There is no partial version of this — as long as the client can
author the record, the client is authoritative no matter what else we add.

So the work is not "add checks". It is **inverting ownership of the character
record**, and everything else follows from that.

---

## Target model

**The server owns a character document. The client owns nothing but input and
presentation.**

```
character {
  id, account, name, createdAt, schemaVersion
  vitals   { hp, maxHp, dead }
  position { x, y, floor }          // validated, already partly done
  progress { xp, level, statPoints, skillPoints, skills{} }
  wallet   { gold }
  items    { <key>: count }         // stackables
  gear     { slots -> itemInstance } // ARPG items with affixes/gems
  flags    { questsDone, chestsLooted, floorBossesDown, ... }
}
```

Every change to it happens through a **transaction** the server validates and
applies. The client never states an outcome; it states an *intent*.

```
client -> server   intent            server -> client
─────────────────────────────────────────────────────
gather{tx,ty}      chop/mine a tile   inv_delta{+wood:4} | reject{reason}
pickup{dropId}     take a ground drop inv_delta | reject
craft{recipeId}    make a thing       inv_delta (spend AND gain, atomic)
chest_move{...}    deposit/withdraw   chest_state + inv_delta
equip{itemId,slot} wear a thing       gear_state
sell/buy{...}      shop trade         inv_delta + wallet_delta
```

**Client-side prediction stays.** The client applies the expected result
immediately and reconciles when the server answers, exactly as `move` already
works today (client moves, server validates, only a rejection rubber-bands).
That is what keeps it feeling responsive — see the latency note at the bottom.

---

## Ordering — each step is safe to ship on its own

**Phase 0 — foundation, additive, breaks nothing**
1. `server/character.js`: the document above, with `schemaVersion` and a
   migration function. Persisted per (account, character).
2. Import existing save blobs into it once, on first load of each character.
   Keep the blob column as a frozen backup — do not delete it.
3. Server sends `character_state` on join. Client renders from it but still
   writes its own save. Nothing is authoritative yet; this is a shadow copy.
4. **Divergence logging**: compare the client's save against the server document
   on every save and log the differences. This is the cheap way to discover
   every place the client mutates state that we have not modelled yet — do NOT
   skip it, it is what stops Phase 2 being a long tail of "oh, and also…".

**Phase 1 — transactions, still with the old path live**
5. Implement the intent messages above. Server validates and applies to the
   document, and answers with deltas.
6. Client switches to sending intents and applying server deltas, keeping
   prediction. The old `save` still runs in parallel.
7. Watch the divergence log until it is quiet. A noisy log here means an
   unmodelled mutation, and shipping on top of it is how rework happens.

**Phase 2 — flip authority**
8. `save` is reduced to non-authoritative data only: camera, UI prefs, hotbar
   layout. Rename it (`prefs`) so nothing can accidentally post a character to
   it again.
9. Server document becomes the source of truth on join. The local save becomes
   a cache for offline play only.

**Phase 3 — the systems that need the document to exist first**
10. Chest contents server-owned (deferred once already, blocked on this).
11. Loot rolls and XP grants moved server-side. Mobs are ALREADY server-side
    (`MobSim`), so the kill event is already authoritative — the reward is the
    only client-side half.
12. Trade and shops become two-sided server transactions.

---

## Decisions taken

Recorded because each one removes a constraint the plan above was written to
respect, and a later session that does not know they were decided will pay for
the constraint again.

**Offline play is a demo/tutorial only.** This retires the "Traps" bullet below
that demanded the transaction functions be pure over the document so the same
code could run on both sides. Offline is now a tutorial sandbox whose result is
not imported into a real character, so transactions can live on the server
alone, in whatever form suits the server. That is a large simplification and it
should be taken: a dual-side transaction layer is roughly twice the code and
every divergence between the two halves is an exploit.

*Consequence to hold on to:* nothing a player does offline may ever be promoted
into an online character. The moment that becomes a feature request, the purity
constraint comes back with it.

**Kills and deaths are server-owned, and they are reputation.** They feed a
notoriety/stature system where guards and NPCs treat you according to who you
are. That makes them the one category the client must never author — posting
your own kill count would be posting your own standing with every faction. They
are in the document now (`standing: { kills, deaths, notoriety }`, schema v2)
even though nothing reads them yet, because retrofitting them once players have
histories means either discarding those histories or seeding them from client
numbers, and the second is the trust hole the whole plan exists to close.

*Not yet decided, and does not need to be:* how notoriety is computed. The
document holds the raw counts; any curve over them can change later without a
migration.

**Document writes batch on a timer (2s), not per transaction.** Delegated, and
chosen for playtesting: `better-sqlite3` writes are synchronous on the same
thread as the mob AI, so per-transaction writes would put a disk write in the
path of every pickup during a fight. 2s bounds the worst-case loss to a couple
of actions — acceptable while testing, and small enough that a tester will not
notice a rollback — while collapsing a busy fight's writes into one. It must be
paired with a flush on disconnect and on room dispose, or the batch window
becomes a reliable way to lose the last two seconds of every session.

---

## Traps specific to this codebase

- ~~**Offline play must keep working.**~~ **RETIRED** — see Decisions above.
  Offline is a demo/tutorial only, so the transactions do not need to be pure
  over the document and there is no second implementation to keep in step. A
  dropped connection still has to fail gracefully; it just no longer has to keep
  authoring a real character.
- **`state.js` is edited by multiple sessions** and both `player{}` and `G{}`
  accumulate fields. The character document must not become a mirror of every
  ad-hoc field added there — model deliberately, and keep the rest local.
- **The autosave interval is frame-rate dependent** (`adt` clamped to 0.1/frame,
  measured at 0.02/sec under software rendering) and there is **no save on tab
  close**. Transactions make this mostly moot, but position/vitals still need a
  wall-clock flush and a `beforeunload`.
- **Colyseus messages sent from `onJoin` are dropped** — the client has not
  attached its handlers yet. `character_state` must be sent in response to an
  explicit client request, exactly like `request_save` (this already bit us).
- **The server stores the blob as a JSON string** and sends it back as a string;
  `loadGame()` expects an object. Any new payload must have its shape agreed at
  both ends (this also already bit us).
- **`storage.saveBlob` silently drops payloads over 200KB.** The document must
  either stay well under that or move to a real row-per-field model. Silent
  truncation of a player's character is the worst possible failure.

---

## Does this cause lag?

No, if we keep prediction. Latency only hurts when the player waits on a round
trip to see their own action.

- **Safe to move server-side** — inventory, loot, XP, gold, crafting, chests.
  Nobody notices 80ms on picking up a plank, and with prediction they do not
  wait for it at all: the item appears immediately and a rejection removes it.
  Ground drops already work exactly this way (`onDropGot`).
- **Keep predicted on the client** — own movement, melee swings, animation.
  Blocking these on the server is what produces input lag.

The real cost is throughput, not frame latency: Node is single-threaded, mob AI
already runs on it, and `better-sqlite3` writes are synchronous. Batch document
writes on a timer rather than writing per transaction.
