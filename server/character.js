// character.js — the server-side character document.
//
// PHASE 0 of docs/SERVER_AUTHORITY.md. Additive on purpose: this builds and
// persists the document and logs where it disagrees with the client's save, but
// NOTHING here is authoritative yet. The client still writes its own save and
// still wins. Flipping that is Phase 2, and it must not happen until the
// divergence log below is quiet.
//
// Why a document at all: today the client streams its whole character and the
// server writes it verbatim, so the client IS the source of truth. Adding
// validation to gathering or loot changes nothing while that is true — a
// modified client just posts the inventory it wants. The work is inverting
// ownership, and this file is the thing ownership moves TO.
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const JSON_FILE = path.join(DATA_DIR, 'characters.json');

// Bump when the shape changes and add a migration step. A character written by
// an older server must keep loading — beta players will have documents from
// every version we ship.
const SCHEMA_VERSION = 2;

let db = null;
try {
  const Database = require('better-sqlite3');
  db = new Database(path.join(DATA_DIR, 'bravo.db'));
  db.pragma('journal_mode = WAL');
  db.exec(`CREATE TABLE IF NOT EXISTS characters_doc (
    name TEXT PRIMARY KEY,
    account TEXT,
    version INTEGER,
    doc TEXT NOT NULL,
    updated_at INTEGER
  )`);
} catch (e) {
  db = null;   // JSON fallback, same as storage.js/accounts.js
}

let jsonStore = null;
function jsonLoad() {
  if (jsonStore) return jsonStore;
  try { jsonStore = JSON.parse(fs.readFileSync(JSON_FILE, 'utf8')); }
  catch (e) { jsonStore = {}; }
  return jsonStore;
}
function jsonFlush() {
  try { fs.writeFileSync(JSON_FILE, JSON.stringify(jsonStore || {})); }
  catch (e) { console.warn('[character] json write failed:', e.message); }
}

// ── The document ──────────────────────────────────────────────────
// Deliberately NOT a mirror of everything on player{} and G{}. Those two are
// edited by many sessions and accumulate ad-hoc fields; mirroring them would
// make this document a second dumping ground and guarantee churn. Only what the
// server must arbitrate lives here — the economy and progression. Presentation
// and preferences stay client-side.
function blank(name, account) {
  return {
    schemaVersion: SCHEMA_VERSION,
    name, account,
    createdAt: Date.now(),
    vitals:   { hp: 100, maxHp: 100 },
    position: { x: 310 * 48 + 24, y: 360 * 48 + 24 },
    progress: { level: 1, xp: 0, xpMax: 100, statPoints: 0, skillPoints: 0,
                stats: { str: 10, dex: 10, int: 10, vit: 10 },
                skillXp: { tactics: 0, archery: 0, hiding: 0, healing: 0, wrestling: 0 } },
    // ⚠ THE STARTING KIT MUST MATCH THE CLIENT'S. It did not, and it was not
    // cosmetic: the client hands every new character an axe (`hasAxe: true`,
    // weapon 'axe'), 20 gold, 10 arrows and 2 bandages, while this said no axe
    // and an empty purse. Two consequences, both real:
    //   1. `gather` refused every tree chop with "need an axe" for any character
    //      whose document existed before its first save — i.e. every new player.
    //   2. The first save of every new character logged a divergence on gold,
    //      arrows and bandages — noise in the exact log that gates Phase 2.
    // Pinned against the client's own starting-kit line by tools/check_tables.mjs.
    wallet:   { gold: 20, bank: 0 },
    items:    { arrows: 10, bandages: 2 },   // stackables: key -> count
    tiers:    { sword: 1, bow: 1, pickaxe: 1 },
    tools:    { axe: true, sword: false, bow: false, pickaxe: false, houseTool: false },
    armor:    {},
    // ⚠ ARPG items need STABLE IDS before trade or chests can reference them.
    // Retrofitting identity onto a live item table after beta is genuinely
    // painful, so ids are assigned on import here even though nothing consumes
    // them yet.
    gear:     { items: [], equipped: { weapon: null, armor: null } },
    artifacts:{ inv: [], equipped: {} },
    flags:    { dungeonBest: 1, floorBossesDown: {}, chestsLooted: {}, contractRank: 0 },
    // ⚠ Server-owned from the start, and deliberately here before anything reads
    // it. Kills and deaths feed a notoriety/stature system where guards and NPCs
    // react to who you are, which makes them REPUTATION, not statistics — the
    // one category a client must never be able to author, since posting your own
    // kill count would be posting your own standing with every faction.
    // Modelling them now costs nothing; retrofitting them after players have
    // histories means either discarding those histories or trusting client
    // numbers to seed them.
    standing: { kills: 0, deaths: 0, notoriety: 0 },
  };
}

let _nextItemId = 1;
function assignId(it) {
  if (it && typeof it === 'object' && !it.iid) it.iid = 'i' + (Date.now().toString(36)) + '_' + (_nextItemId++);
  return it;
}

// ── Import from the legacy save blob ──────────────────────────────
// Runs ONCE per character, the first time we see it. The blob column stays
// exactly where it is afterwards — it is the only copy of anything we failed to
// model, and deleting it would make a modelling mistake unrecoverable.
function fromLegacyBlob(name, account, blob) {
  const d = blank(name, account);
  if (!blob || typeof blob !== 'object') return d;
  const n = (v, dflt) => (typeof v === 'number' && isFinite(v)) ? v : dflt;

  if (typeof blob.px === 'number') d.position.x = blob.px;
  if (typeof blob.py === 'number') d.position.y = blob.py;
  // ⚠ HP arrives as a FLOAT: regeneration ticks accumulate fractions, so a
  // healthy character saves as 100.09985000000003. Stored raw, that logs a
  // divergence on literally every save and drowns the signal this log exists
  // for. A health value with 14 decimal places is a client-side artifact, not
  // state worth arbitrating, so the document holds an integer.
  d.vitals.hp = Math.round(n(blob.hp, 100));

  d.items = Object.assign({}, blob.inv || {});
  // Gold lives in `inv.gold` in the blob but is a wallet concept — separating it
  // now means the transaction API can treat currency distinctly (shops, bank,
  // trade) instead of special-casing an inventory key forever.
  d.wallet.gold = n(d.items.gold, 0); delete d.items.gold;
  d.wallet.bank = n(blob.bank && blob.bank.gold, 0);

  d.progress.level      = n(blob.level, 1);
  d.progress.xp         = n(blob.xp, 0);
  d.progress.xpMax      = n(blob.xpMax, 100);
  d.progress.statPoints = n(blob.statPoints, 0);
  d.progress.skillPoints= n(blob.skillPoints, 0);
  if (blob.stats)   Object.assign(d.progress.stats, blob.stats);
  if (blob.skillXp) Object.assign(d.progress.skillXp, blob.skillXp);

  d.tiers = { sword: n(blob.swordTier, 1), bow: n(blob.bowTier, 1), pickaxe: n(blob.pickaxeTier, 1) };
  d.tools = { axe: !!blob.hasAxe, sword: !!blob.hasSword, bow: !!blob.hasBow,
              pickaxe: !!blob.hasPickaxe, houseTool: !!blob.hasHouseTool };
  d.armor = Object.assign({}, blob.armor || {});

  d.gear.items = (blob.equipmentItems || []).map(it => assignId(Object.assign({}, it)));
  // ⚠ The equipped weapon/armor are SEPARATE OBJECT COPIES of items that also
  // appear in equipmentItems. Assigning ids naively gives one logical sword two
  // identities, and every later system that moves an item by id — trade, chests,
  // the bank — then has to guess which copy it meant. Alias the equipped entry
  // onto the matching inventory item so there is exactly one id per item.
  const sig = it => JSON.stringify([it && it.type, it && it.name, it && it.tier, it && it.rarity]);
  const bySig = new Map(d.gear.items.map(it => [sig(it), it]));
  const linkEquipped = src => {
    if (!src) return null;
    const found = bySig.get(sig(src));
    if (found) return { ...src, iid: found.iid };   // same item, same identity
    // Equipped but not in the list: still a real item, so it gets its own id
    // AND joins the list, or it would be invisible to anything id-addressed.
    const own = assignId(Object.assign({}, src));
    d.gear.items.push(own);
    bySig.set(sig(own), own);
    return { ...own };
  };
  d.gear.equipped = {
    weapon: linkEquipped(blob.equippedItems && blob.equippedItems.weapon),
    armor:  linkEquipped(blob.equippedItems && blob.equippedItems.armor),
  };
  d.artifacts.inv = (blob.artifactInv || []).map(it => assignId(Object.assign({}, it)));
  d.artifacts.equipped = Object.assign({}, blob.equippedArtifacts || {});

  d.flags.dungeonBest     = n(blob.dungeonBest, 1);
  d.flags.floorBossesDown = Object.assign({}, blob.floorBossesDown || {});
  d.flags.chestsLooted    = Object.assign({}, blob.chestsLooted || {});
  d.flags.contractRank    = n(blob.contractRank, 0);
  return d;
}

// ── Migration ─────────────────────────────────────────────────────
function migrate(d) {
  if (!d || typeof d !== 'object') return null;
  // v1 is the first shape; future steps append here and bump SCHEMA_VERSION.
  // Never mutate in place without raising the version — a half-migrated
  // document that still claims the old version is unrecoverable.
  d.schemaVersion = d.schemaVersion || 1;
  // v1 → v2: standing (kills/deaths/notoriety). Purely additive, so existing
  // documents take the zeroed record. Deliberately NOT seeded from the client
  // save even though the client has been counting kills locally — see the note
  // on `standing` in blank(): seeding reputation from a client number is the
  // same trust hole as letting the client post it.
  if (d.schemaVersion < 2) {
    d.standing = { kills: 0, deaths: 0, notoriety: 0 };
    d.schemaVersion = 2;
  }
  return d;
}

function load(name) {
  if (db) {
    const r = db.prepare('SELECT doc FROM characters_doc WHERE name=?').get(name);
    if (!r) return null;
    try { return migrate(JSON.parse(r.doc)); } catch (e) { return null; }
  }
  const s = jsonLoad();
  return s[name] ? migrate(s[name]) : null;
}

function save(name, doc) {
  const str = JSON.stringify(doc);
  // Same guard as storage.saveBlob, but LOUD. A silently dropped character is
  // the worst failure this system can have.
  if (str.length > 400000) {
    console.error(`[character] REFUSING to save ${name}: ${str.length} bytes — document too large, investigate`);
    return false;
  }
  if (db) {
    db.prepare(`INSERT INTO characters_doc (name,account,version,doc,updated_at) VALUES (?,?,?,?,?)
      ON CONFLICT(name) DO UPDATE SET account=excluded.account, version=excluded.version,
        doc=excluded.doc, updated_at=excluded.updated_at`)
      .run(name, doc.account || '', doc.schemaVersion || SCHEMA_VERSION, str, Date.now());
    return true;
  }
  const s = jsonLoad(); s[name] = doc; jsonFlush();
  return true;
}

// ── Live documents ────────────────────────────────────────────────
// One in-memory instance per character while it is loaded, with writes batched
// on a timer. Three reasons, and the first is a correctness one:
//
//   1. IDENTITY. Transactions mutate the document. Re-reading it from disk on
//      every message would hand each transaction its own copy, so two in the
//      same tick would each write over the other — the classic lost update, and
//      it duplicates or destroys items depending on which lands last.
//   2. `better-sqlite3` writes are SYNCHRONOUS and share the thread with the mob
//      AI, so a write per transaction puts a disk write in the path of every
//      pickup during a fight.
//   3. Reads stop hitting the disk at all.
//
// ⚠ The batch window is a loss window: anything not yet flushed dies with the
// process. Hence flush on leave and on dispose, and hence 2s rather than
// something more efficient — see the decision note in docs/SERVER_AUTHORITY.md.
const FLUSH_MS = 2000;
const live = new Map();          // name -> { doc, dirty, timer }

function scheduleFlush(name) {
  const e = live.get(name);
  if (!e || e.timer) return;
  e.timer = setTimeout(() => { e.timer = null; flush(name); }, FLUSH_MS);
  if (e.timer.unref) e.timer.unref();   // never hold the process open for a save
}

// Call after mutating a document. Cheap and idempotent — the write itself is
// coalesced into the next flush.
function touch(name) {
  const e = live.get(name);
  if (!e) return;
  e.dirty = true;
  scheduleFlush(name);
}

function flush(name) {
  const e = live.get(name);
  if (!e || !e.dirty) return false;
  e.dirty = false;
  return save(name, e.doc);
}

function flushAll() {
  let n = 0;
  for (const name of live.keys()) if (flush(name)) n++;
  return n;
}

// Drop a character from memory, flushing first. ⚠ Always flush before deleting;
// dropping a dirty entry silently discards up to FLUSH_MS of play.
function close(name) {
  const e = live.get(name);
  if (!e) return;
  if (e.timer) { clearTimeout(e.timer); e.timer = null; }
  flush(name);
  live.delete(name);
}

// Get the document, importing from the legacy blob the first time. Returns the
// LIVE instance — callers may mutate it, and must call touch() when they do.
//
// ⚠ `legacyBlob` may be a FUNCTION, and on the hot path it should be. It is only
// consulted the first time a character is ever seen, but an eager argument is
// evaluated on every call — so passing `storage.loadBlob(name)` directly put a
// synchronous SQLite read in front of every single transaction, defeating the
// whole point of the live cache. Pass `() => storage.loadBlob(name)` instead.
function ensure(name, account, legacyBlob) {
  const held = live.get(name);
  if (held) {
    if (account && !held.doc.account) { held.doc.account = account; touch(name); }
    return held.doc;
  }
  let d = load(name);
  let created = false;
  if (!d) {
    let blob = null;
    const legacyBlobStr = typeof legacyBlob === 'function' ? legacyBlob() : legacyBlob;
    if (legacyBlobStr) { try { blob = JSON.parse(legacyBlobStr); } catch (e) {} }
    d = blob ? fromLegacyBlob(name, account, blob) : blank(name, account);
    save(name, d);
    console.log(`[character] created document for ${name}` + (blob ? ' (imported from legacy save)' : ' (new)'));
    created = true;
  }
  live.set(name, { doc: d, dirty: false, timer: null });
  if (!created && account && !d.account) { d.account = account; touch(name); }
  return d;
}

// Replace the live document wholesale (the Phase 0 adopt path). Goes through the
// cache so the instance every transaction holds is the one that gets updated —
// writing straight to disk here would leave the in-memory copy stale and the
// next transaction would resurrect the old values.
function replace(name, doc) {
  const e = live.get(name);
  if (e) { e.doc = doc; touch(name); return doc; }
  live.set(name, { doc, dirty: true, timer: null });
  scheduleFlush(name);
  return doc;
}

// ── Divergence logging ────────────────────────────────────────────
// The point of Phase 0. Every client save is compared against the document; the
// differences name exactly which mutations we have not modelled yet. Phase 1
// should not start on a field until this is quiet for it, otherwise the
// transaction API gets built around an incomplete picture and has to be redone
// — which is the specific outcome this plan exists to avoid.
function diff(doc, blob) {
  const out = [];
  const n = v => (typeof v === 'number' && isFinite(v)) ? v : 0;
  // ⚠ A field the client did NOT SEND is not a divergence — it is silence.
  // Coercing absent to 0 makes every optional field report a fake delta, and a
  // log that cries wolf on correct behaviour is worse than no log: the real
  // signal (an unmodelled mutation) gets lost in it.
  const cmp = (label, a, b, raw) => {
    if (raw === undefined || raw === null) return;
    if (a !== b) out.push(`${label}: doc=${a} client=${b}`);
  };

  const rawGold = blob.inv ? blob.inv.gold : undefined;
  const rawBank = blob.bank ? blob.bank.gold : undefined;
  cmp('gold', n(doc.wallet.gold), n(rawGold), rawGold);
  cmp('bank', n(doc.wallet.bank), n(rawBank), rawBank);
  cmp('level', n(doc.progress.level), n(blob.level), blob.level);
  cmp('xp', n(doc.progress.xp), n(blob.xp), blob.xp);
  // Compare vitals at integer resolution for the same reason.
  cmp('hp', Math.round(n(doc.vitals.hp)), Math.round(n(blob.hp)), blob.hp);

  if (!blob.inv) return out;          // no inventory sent → nothing to compare
  const bi = Object.assign({}, blob.inv || {}); delete bi.gold;
  const keys = new Set([...Object.keys(doc.items || {}), ...Object.keys(bi)]);
  for (const k of keys) {
    const a = n(doc.items[k]), b = n(bi[k]);
    if (a !== b) out.push(`item.${k}: doc=${a} client=${b}`);
  }
  const dg = (doc.gear.items || []).length, bg = (blob.equipmentItems || []).length;
  if (dg !== bg) out.push(`gear.count: doc=${dg} client=${bg}`);
  return out;
}

// Adopt the client's values into the document. Phase 0 ONLY — the client is
// still authoritative here, so this keeps the shadow copy current while the
// divergence log records what it had to absorb. This function is what Phase 2
// deletes.
function adoptFromBlob(doc, blob) {
  const merged = fromLegacyBlob(doc.name, doc.account, blob);
  merged.createdAt = doc.createdAt;
  merged.schemaVersion = SCHEMA_VERSION;
  // Preserve ids already handed out so an item does not change identity every
  // save — trade and chests will depend on that stability.
  const byKey = new Map((doc.gear.items || []).map(it => [JSON.stringify([it.type, it.name, it.tier, it.rarity]), it.iid]));
  for (const it of merged.gear.items) {
    const k = JSON.stringify([it.type, it.name, it.tier, it.rarity]);
    if (byKey.has(k)) it.iid = byKey.get(k);
  }
  return merged;
}

module.exports = { ensure, load, save, diff, adoptFromBlob, blank, fromLegacyBlob,
                   touch, flush, flushAll, close, replace,
                   SCHEMA_VERSION, backend: db ? 'sqlite' : 'json' };
