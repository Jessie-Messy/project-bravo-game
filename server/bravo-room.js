// bravo-room.js — the persistent world room.
// Phase A: presence + chat. Phase B adds the authoritative layer for
// contested state: server-validated PvP (range/cooldown/safe-zone/damage),
// movement speed enforcement (anti-speed-hack), kill/death tracking, and
// SQLite persistence (storage.js). Mob AI stays client-side until Phase C.
const { Room } = require('colyseus');
const { Schema, MapSchema, defineTypes } = require('@colyseus/schema');
const storage = require('./storage.js');
const accounts = require('./accounts.js');
const character = require('./character.js');
const tx = require('./tx.js');
const { MobSim, world } = require('./mobs.js');

// Must match the client's constants.js
const TILE = 48, MAP_W = 480, MAP_H = 554;
const CITY = { x1: 280, y1: 332, x2: 340, y2: 392 };   // Lunar = safe zone
// Must match js/state.js. The forge recipes accept the town blacksmith in place
// of a placed forge, so the server needs to know where it stands to validate them.
const BLACKSMITH = { x: 319 * TILE + 24, y: 357 * TILE + 24 };

// ── Anti-cheat / combat tuning ──
const MAX_SPEED   = 700;    // u/s — base 190, horse 2.2x, sprint 1.4x ≈ 585 max legit
const MOVE_SLACK  = 60;     // u of jitter allowance per update
const TP_COOLDOWN = 2500;   // ms between accepted teleports
const KILL_CREDIT_MS = 10000;
const PVP = {
  sword: { dmg: 22, cooldownMs: 450, range: 220 },   // range has 10Hz-staleness slack
  bow:   { dmg: 15, cooldownMs: 600, range: TILE * 16 },
};

function inCity(x, y) {
  const tx = x / TILE, ty = y / TILE;
  return tx >= CITY.x1 && tx <= CITY.x2 && ty >= CITY.y1 && ty <= CITY.y2;
}

// ── Resource layer (for the `gather` transaction) ──
// 2 bits per tile, packed by build-world-data.mjs. The walkability bitmap cannot
// stand in for this: it only says "blocked", and a tree, a boulder, a wall and
// deep water are all equally blocked — so without this the server could not tell
// a real chop from a claim against a city wall.
const RES_NAME = [null, 'tree', 'stone', 'iron'];
let resBits = null;
if (world && world.resB64) {
  try { resBits = Buffer.from(world.resB64, 'base64'); }
  catch (e) { console.warn('[bravo] resource layer unreadable:', e.message); }
}
if (!resBits) console.warn('[bravo] world-data has no resource layer — gather transactions will be refused.' +
                           ' Regenerate with: node server/build-world-data.mjs');
function resourceAt(tx_, ty_) {
  if (!resBits) return null;
  if (!(tx_ >= 0 && ty_ >= 0 && tx_ < MAP_W && ty_ < MAP_H)) return null;
  const i = ty_ * MAP_W + tx_;
  return RES_NAME[(resBits[i >> 2] >> ((i & 3) * 2)) & 3] || null;
}

// Harvest reach, matching the client's HARVEST_RANGE, plus a tile of slack for
// the 10Hz position staleness the server sees. Too tight and legitimate chops
// get rejected on a laggy connection, which reads as the game being broken.
const GATHER_RANGE = TILE * 1.6 + TILE;

class PlayerState extends Schema {}
defineTypes(PlayerState, {
  name:    'string',
  x:       'number',
  y:       'number',
  dir:     'number',
  weapon:  'string',
  hp:      'number',
  maxHp:   'number',
  kills:   'number',
  deaths:  'number',
  dead:    'boolean',
  ghost:   'boolean',
  onHorse: 'boolean',
  hidden:  'boolean',
  horseDown: 'boolean',   // their horse stands in the world at horseX/Y
  horseX:  'number',
  horseY:  'number',
});

class MobState extends Schema {}
defineTypes(MobState, {
  type:  'string',
  x:     'number',
  y:     'number',
  hp:    'number',
  maxHp: 'number',
  dead:  'boolean',
});

class WorldState extends Schema {
  constructor() { super(); this.players = new MapSchema(); this.mobs = new MapSchema(); }
}
defineTypes(WorldState, { players: { map: PlayerState }, mobs: { map: MobState } });

class BravoRoom extends Room {
  onCreate() {
    this.maxClients = 16;
    this.autoDispose = false;          // the world stays up even when empty
    this.setState(new WorldState());
    this.meta = new Map();             // sessionId -> per-connection tracking

    this.onMessage('move', (client, m) => {
      const p = this.state.players.get(client.sessionId);
      const mt = this.meta.get(client.sessionId);
      if (!p || !mt || typeof m !== 'object' || m === null) return;
      const now = Date.now();
      const x = +m.x, y = +m.y;
      if (isFinite(x) && isFinite(y)) {
        const cx = Math.max(0, Math.min(MAP_W * TILE, x));
        const cy = Math.max(0, Math.min(MAP_H * TILE, y));
        // speed enforcement: reject displacements no legit movement produces
        // (recent accepted teleports exempt the next update)
        const dt = Math.max(0.03, (now - mt.lastMoveAt) / 1000);
        const dist = Math.hypot(cx - p.x, cy - p.y);
        const allowed = MAX_SPEED * dt + MOVE_SLACK;
        if (dist <= allowed || now - mt.lastTpAt < 1500) {
          p.x = cx; p.y = cy;
        } else if (++mt.speedFlags % 10 === 1) {
          console.warn(`[bravo] speed reject ${p.name}: ${Math.round(dist)}u in ${Math.round(dt*1000)}ms (x${mt.speedFlags})`);
        }
        mt.lastMoveAt = now;
      }
      if (typeof m.dir === 'number' && isFinite(m.dir)) p.dir = m.dir;
      if (typeof m.weapon === 'string' && m.weapon.length <= 12) p.weapon = m.weapon;
      const wasDead = p.dead;
      p.dead    = !!m.dead;
      p.ghost   = !!m.ghost;
      p.onHorse = !!m.onHorse;
      p.hidden  = !!m.hidden;
      p.horseDown = !!m.horseDown;
      if (typeof m.horseX === 'number' && isFinite(m.horseX)) p.horseX = m.horseX;
      if (typeof m.horseY === 'number' && isFinite(m.horseY)) p.horseY = m.horseY;
      if (typeof m.hp === 'number' && isFinite(m.hp)) {
        const newHp = Math.max(0, Math.min(9999, m.hp | 0));
        // observed hp drops pay down the PvP-damage accumulator (integrity check)
        if (newHp < p.hp) mt.pvpTaken = Math.max(0, (mt.pvpTaken || 0) - (p.hp - newHp));
        p.hp = newHp;
      }
      if (typeof m.maxHp === 'number' && isFinite(m.maxHp)) p.maxHp = Math.max(1, Math.min(9999, m.maxHp | 0));
      // death transition → credit the killer if a player hit them recently
      if (!wasDead && p.dead) {
        p.deaths++;
        if (mt.lastHitBy && now - mt.lastHitAt < KILL_CREDIT_MS) {
          const killer = this.state.players.get(mt.lastHitBy);
          if (killer) {
            killer.kills++;
            this.broadcast('feed', { text: `⚔ ${killer.name} slew ${p.name}!` });
            console.log(`[bravo] PVP KILL: ${killer.name} -> ${p.name}`);
          }
        }
        mt.lastHitBy = null;
      }
    });

    // teleports are declared with a reason, rate-limited, and validated
    // against real locations: 'portal' must land near an actual portal (or
    // the fixed city arrival); anything else is refused → moves rubber-band
    this.onMessage('tp', (client, m) => {
      const p = this.state.players.get(client.sessionId);
      const mt = this.meta.get(client.sessionId);
      if (!p || !mt || typeof m !== 'object' || m === null) return;
      const now = Date.now();
      if (now - mt.lastTpAt < TP_COOLDOWN) return;   // spam → ignored, moves get rejected
      const x = +m.x, y = +m.y;
      if (!isFinite(x) || !isFinite(y)) return;
      const reason = ('' + m.reason).slice(0, 12);
      const nearTile = (tx, ty, r) => Math.hypot(x - (tx * TILE + TILE / 2), y - (ty * TILE + TILE / 2)) < TILE * r;
      let ok = false;
      if (reason === 'portal' && world) {
        ok = world.portals.some(([tx, ty]) => nearTile(tx, ty, 6)) || nearTile(305, 351, 6);
      } else if (reason === 'unstuck') {
        // rescue to the city square; 5-min cooldown enforced here too
        if (now - (mt.lastUnstuckAt || 0) < 300000) { console.warn(`[bravo] unstuck refused (cooldown) ${p.name}`); return; }
        ok = nearTile(305, 351, 8);
        if (ok) mt.lastUnstuckAt = now;
      } else if (reason === 'dev') {
        // the game ships dev tools to everyone, so allow but count + log
        mt.devTp = (mt.devTp || 0) + 1;
        ok = true;
      }
      if (!ok) { console.warn(`[bravo] tp REFUSED ${p.name} -> ${Math.round(x/TILE)},${Math.round(y/TILE)} (${reason})`); return; }
      mt.lastTpAt = now;
      p.x = Math.max(0, Math.min(MAP_W * TILE, x));
      p.y = Math.max(0, Math.min(MAP_H * TILE, y));
      console.log(`[bravo] tp ${p.name} -> ${Math.round(p.x/TILE)},${Math.round(p.y/TILE)} (${reason}${mt.devTp ? ' x' + mt.devTp : ''})`);
    });

    // PvP attack intent — the server is the referee: existence, life state,
    // self-target, safe zone, cooldown, range, and damage are all decided here
    this.onMessage('pvp', (client, m) => {
      if (typeof m !== 'object' || m === null) return;
      const atk = this.state.players.get(client.sessionId);
      const mt  = this.meta.get(client.sessionId);
      const tgt = this.state.players.get('' + m.t);
      const tmt = this.meta.get('' + m.t);
      const cfg = PVP[m.w];
      if (!atk || !tgt || !mt || !tmt || !cfg) return;
      if ('' + m.t === client.sessionId) return;
      if (atk.dead || atk.ghost || tgt.dead || tgt.ghost) return;
      if (inCity(atk.x, atk.y) || inCity(tgt.x, tgt.y)) return;   // town = safe
      const now = Date.now();
      if (now - (mt.lastAtkAt || 0) < cfg.cooldownMs) return;
      if (Math.hypot(tgt.x - atk.x, tgt.y - atk.y) > cfg.range) return;
      mt.lastAtkAt = now;
      tmt.lastHitBy = client.sessionId;
      tmt.lastHitAt = now;
      // integrity accumulator — only count hits the victim's iframes wouldn't eat
      if (now - (tmt.lastCountedHit || 0) >= 800) {
        tmt.lastCountedHit = now;
        tmt.pvpTaken = (tmt.pvpTaken || 0) + cfg.dmg;
      }
      this.broadcast('pvp_hit', { from: client.sessionId, to: '' + m.t, w: m.w, dmg: cfg.dmg });
    });

    // Explicit save fetch. onJoin also pushes the blob, but that send happens
    // while the client is still inside joinOrCreate() and has not yet attached
    // its onMessage handlers — the message lands with nobody listening and is
    // dropped. Measured: the server stored the right save and logged the join,
    // and the joining client still showed a default character. The client asks
    // for it once its handlers are up, which removes the race entirely.
    this.onMessage('request_save', (client) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      const blob = storage.loadBlob(p.name);
      if (blob) { client.send('save', blob); console.log(`[bravo] save sent on request: ${p.name}`); }
      else console.log(`[bravo] no stored save for ${p.name} (new character)`);
    });

    // The document, on request. Same reason request_save exists: a send from
    // onJoin lands before the client has attached its handlers and is dropped.
    this.onMessage('request_character', (client) => {
      const p = this.state.players.get(client.sessionId);
      if (!p) return;
      try {
        const doc = character.ensure(p.name, (client.auth && client.auth.username) || '', storage.loadBlob(p.name));
        client.send('character_state', doc);
      } catch (e) {
        console.warn(`[character] request failed for ${p.name}: ${e.message}`);
      }
    });

    // ── Transactions (PHASE 1 of docs/SERVER_AUTHORITY.md) ──
    // The client states an INTENT; the server decides the outcome and answers
    // with deltas. Runs ALONGSIDE the legacy `save`, which is still a blanket
    // override — so this is not yet the last word, it is the server proving it
    // can author every one of these correctly before Phase 2 flips authority.
    //
    // ⚠ Every reply carries the client's `seq` back. Without it a client cannot
    // tell which of several in-flight intents a rejection belongs to, and would
    // roll back the wrong predicted action — which looks exactly like an item
    // vanishing at random.
    this.onMessage('tx', (client, m) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || typeof m !== 'object' || m === null) return;
      const seq = (m.seq | 0);
      const kind = ('' + m.kind).slice(0, 24);
      const reject = reason => client.send('tx_result', { seq, kind, ok: false, reason });

      if (p.dead) return reject('you are dead');

      const mt = this.meta.get(client.sessionId);
      // Blanket rate limit. Not a balance knob — it is the backstop for every
      // validation gap, present and future: whatever a modified client finds to
      // ask for, it cannot ask faster than this.
      const now = Date.now();
      if (mt) {
        if (!mt.txWindow || now - mt.txWindow > 1000) { mt.txWindow = now; mt.txCount = 0; }
        if (++mt.txCount > 25) return reject('slow down');
      }

      let doc;
      try {
        doc = character.ensure(p.name, (client.auth && client.auth.username) || '', storage.loadBlob(p.name));
      } catch (e) { return reject('character unavailable'); }

      // Proximity, answered from state the SERVER owns: it tracks every placed
      // object and the player's own position, so none of this is a client claim.
      const nearObj = (type, tiles) => this.placedObjects.some(o =>
        o.type === type && Math.hypot(o.x - p.x, o.y - p.y) <= TILE * tiles);
      const ctx = {
        nearby: (what) => {
          if (what === 'workbench') return nearObj('workbench', 3);
          // The town blacksmith counts as a forge, matching the client's rule.
          if (what === 'forge') return nearObj('forge', 3) ||
            Math.hypot(BLACKSMITH.x - p.x, BLACKSMITH.y - p.y) < TILE * 2.5;
          if (what === 'smith') return Math.hypot(BLACKSMITH.x - p.x, BLACKSMITH.y - p.y) < TILE * 3;
          return false;
        },
        resourceAt,
        inRange: (tx_, ty_) =>
          Math.hypot((tx_ + 0.5) * TILE - p.x, (ty_ + 0.5) * TILE - p.y) <= GATHER_RANGE,
      };

      // ⚠ `pickup` is NOT accepted here. It is driven by `drop_take` above,
      // because the drop table is already server-owned there — the server picks
      // the winner and decides the stack, and the client only ever names an id.
      // Exposing it on this message too would mean a client could post a type
      // and a count of its own choosing, which is a free item printer.
      if (kind === 'pickup') return reject('use drop_take');

      const r = tx.apply(doc, kind, m.intent || {}, ctx);
      if (!r.ok) {
        // A rejection is normal (you cannot afford it), so this is not an error
        // log — but it IS the signal that the client and server disagree about
        // what is possible, so it stays visible while Phase 1 beds in.
        console.log(`[tx] ${p.name} ${kind} REJECTED: ${r.reason}`);
        return reject(r.reason);
      }
      character.touch(p.name);
      client.send('tx_result', { seq, kind, ok: true, deltas: r.deltas });
    });

    // full-save sync: the client streams its whole save blob; we persist it
    // and mirror x/y/hp/kills/deaths onto the schema so they survive here too
    this.onMessage('save', (client, blob) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || typeof blob !== 'object' || blob === null) return;
      try {
        const str = JSON.stringify(blob);
        // ⚠ This used to `return` silently on an oversized blob, and
        // storage.saveBlob has the same guard. A player's progress could be
        // dropped on every single save with no error anywhere — the character
        // simply never persisted, which is indistinguishable from "the feature
        // does not work". Log both outcomes so the path is observable.
        if (str.length > 200000) {
          console.warn(`[bravo] SAVE REJECTED for ${p.name}: ${str.length} bytes exceeds 200000`);
          client.send('save_result', { ok: false, error: 'save too large', bytes: str.length });
          return;
        }
        storage.saveBlob(p.name, str);
        console.log(`[bravo] save ok: ${p.name} (${str.length} bytes)`);
        client.send('save_result', { ok: true, bytes: str.length });
        // PHASE 0 divergence log. Every field listed here is a mutation the
        // client performed that the server did not model -- which is exactly
        // the list Phase 1's transaction API has to cover. Phase 1 should not
        // start on a field while it is still noisy here.
        try {
          const doc = character.ensure(p.name, (client.auth && client.auth.username) || '', null);
          const d = character.diff(doc, blob);
          if (d.length) console.log(`[character] DIVERGENCE ${p.name}: ${d.slice(0, 12).join(' | ')}`
            + (d.length > 12 ? ` (+${d.length - 12} more)` : ''));
          // ⚠ Through replace(), not save(): the transaction path holds the LIVE
          // document instance, and writing a fresh object straight to disk would
          // leave that instance stale — the next transaction would then commit
          // against the pre-adopt values and resurrect them.
          character.replace(p.name, character.adoptFromBlob(doc, blob));
        } catch (e) {
          console.warn(`[character] shadow update failed for ${p.name}: ${e.message}`);
        }
        if (typeof blob.px === 'number' && isFinite(blob.px)) p.x = Math.max(0, Math.min(MAP_W * TILE, blob.px));
        if (typeof blob.py === 'number' && isFinite(blob.py)) p.y = Math.max(0, Math.min(MAP_H * TILE, blob.py));
        if (typeof blob.hp === 'number' && isFinite(blob.hp)) p.hp = Math.max(0, Math.min(9999, blob.hp | 0));
      } catch (e) { /* ignore malformed */ }
    });

    this.onMessage('chat', (client, text) => {
      const mt = this.meta.get(client.sessionId);
      if (typeof text !== 'string' || !mt) return;
      const now = Date.now();
      if (now - (mt.lastChatAt || 0) < 600) return;   // flood guard
      mt.lastChatAt = now;
      text = text.slice(0, 140).replace(new RegExp('[\\u0000-\\u001f]', 'g'), '').trim();
      if (!text) return;
      const p = this.state.players.get(client.sessionId);
      this.broadcast('chat', { name: p ? p.name : '???', text, t: now });
    });

    // server-authoritative overworld mobs (wolves + bandits)
    this.mobSim = new MobSim(this, MobState);
    this.onMessage('mob_hit', (client, msg) => this.mobSim.onHit(client, msg));
    this.setSimulationInterval(ms => this.mobSim.tick(Math.min(ms, 250) / 1000), 100);

    // Re-sync the world clock every 60s so long sessions can't drift apart
    // (sleeping tabs, throttled timers, clock skew between machines).
    this.worldTimeTimer = this.clock.setInterval(() => {
      this.broadcast('worldtime', { t: Date.now() / 1000 });
    }, 60000);

    // ── Shared houses ──
    // The server owns the house list (persisted to data/houses.json) and
    // broadcasts the full list on any change; clients reconcile their maps.
    this.houses = this.loadHouses();
    this.onMessage('house_place', (client, m) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || typeof m !== 'object' || m === null) return;
      const x0 = m.x0 | 0, y0 = m.y0 | 0, size = m.size | 0;
      if (size < 3 || size > 15) return;
      if (x0 < 1 || y0 < 1 || x0 + size >= MAP_W - 1 || y0 + size >= MAP_H - 1) return;
      // no overlap with existing houses (1-tile buffer)
      for (const h of this.houses) {
        if (x0 < h.x0 + h.size + 1 && h.x0 < x0 + size + 1 &&
            y0 < h.y0 + h.size + 1 && h.y0 < y0 + size + 1) return;
      }
      // never trap another player inside a new house
      const wx0 = (x0 - 1) * TILE, wy0 = (y0 - 1) * TILE, wx1 = (x0 + size + 1) * TILE, wy1 = (y0 + size + 1) * TILE;
      for (const [sid, other] of this.state.players) {
        if (sid === client.sessionId || other.dead) continue;
        if (other.x >= wx0 && other.x < wx1 && other.y >= wy0 && other.y < wy1) {
          console.warn(`[bravo] house placement blocked — would trap ${other.name}`);
          return;
        }
      }
      this.houses.push({ x0, y0, size, isPublic: !!m.isPublic, friends: [], doorOpen: false, owner: p.name });
      this.saveHouses(); this.broadcastHouses();
      console.log(`[bravo] house placed by ${p.name} at ${x0},${y0} (${size})`);
    });
    this.onMessage('house_update', (client, m) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || typeof m !== 'object' || m === null) return;
      const h = this.houses[m.idx | 0];
      if (!h) return;
      const isOwner = !h.owner || h.owner === p.name;
      const isFriend = h.isPublic || (h.friends || []).includes(p.name);
      
      if (typeof m.doorHp === 'number') {
        const currentHp = h.doorHp === undefined ? 200 : h.doorHp;
        if (m.doorHp < currentHp || isOwner) {
          h.doorHp = m.doorHp;
          if (h.doorHp <= 0) {
            h.doorHp = 0;
            h.doorOpen = true;
          }
        }
      }
      if (typeof m.doorOpen === 'boolean' && (isOwner || isFriend || (h.doorHp !== undefined && h.doorHp <= 0))) {
        h.doorOpen = m.doorOpen;
      }
      if (isOwner) {
        if (typeof m.isPublic === 'boolean') h.isPublic = m.isPublic;
        if (Array.isArray(m.friends)) h.friends = m.friends.map(f => ('' + f).slice(0, 16)).slice(0, 12);
      }
      this.saveHouses(); this.broadcastHouses();
    });
    this.onMessage('house_remove', (client, m) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || typeof m !== 'object' || m === null) return;
      const idx = m.idx | 0, h = this.houses[idx];
      if (!h || (h.owner && h.owner !== p.name)) return;
      this.houses.splice(idx, 1);
      this.saveHouses(); this.broadcastHouses();
      console.log(`[bravo] house removed by ${p.name}`);
    });

    // ── Persistent Placed Objects (Torches, Lanterns, Campfires, Chests, Forges) ──
    this.placedObjects = this.loadPlacedObjects();
    this.onMessage('object_place', (client, m) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || typeof m !== 'object' || m === null) return;
      const type = ('' + m.type).slice(0, 32);
      const x = +m.x, y = +m.y;
      if (!isFinite(x) || !isFinite(y)) return;
      const id = ('' + (m.id || (type + '_' + Math.round(x) + '_' + Math.round(y)))).slice(0, 48);
      // Wall mounts carry the face they're bracketed to. Whitelisted rather than
      // spread, so a client can't inject arbitrary fields; without it a mounted
      // torch comes back from the server lying flat on the floor.
      const face = ['n','s','e','w'].includes(m.face) ? m.face : null;
      // litAt is an absolute world-clock stamp; burnout is derived from it, so
      // every client agrees without the server ticking anything.
      const litAt = isFinite(+m.litAt) && +m.litAt > 0 ? +m.litAt : 0;
      // Chest lock. A boolean is all that crosses — chest CONTENTS are never
      // stored here, so there is nothing item-shaped for a client to inject.
      const locked = m.locked === true;
      // Re-sending an object at the same spot is also the UPDATE path (that is
      // how toggling a chest lock propagates), so preserve the previous owner
      // instead of reassigning it to whoever last touched it.
      const prev = this.placedObjects.find(o => Math.hypot(o.x - x, o.y - y) <= 6);
      this.placedObjects = this.placedObjects.filter(o => Math.hypot(o.x - x, o.y - y) > 6);
      this.placedObjects.push({ id, type, x: Math.round(x), y: Math.round(y),
        owner: (prev && prev.owner) || p.name,
        ...(face ? { face } : {}), ...(litAt ? { litAt } : {}), ...(locked ? { locked } : {}) });
      this.savePlacedObjects(); this.broadcastPlacedObjects();
      console.log(`[bravo] object placed by ${p.name}: ${type} at ${Math.round(x)},${Math.round(y)}`);
    });
    this.onMessage('object_remove', (client, m) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || typeof m !== 'object' || m === null) return;
      const x = +m.x, y = +m.y;
      if (!isFinite(x) || !isFinite(y)) return;
      // Tight radius: the client sends the object's own coords and we stored them
      // rounded, so the gap is under a unit. The old TILE*1.5 (72u) spanned wider
      // than the ~42u between two torches on opposite faces of the same wall, so
      // picking one up could remove the other.
      const idx = this.placedObjects.findIndex(o => Math.hypot(o.x - x, o.y - y) <= 12);
      if (idx !== -1) {
        const removed = this.placedObjects.splice(idx, 1)[0];
        this.savePlacedObjects(); this.broadcastPlacedObjects();
        console.log(`[bravo] object removed by ${p.name}: ${removed.type} at ${removed.x},${removed.y}`);
      }
    });

    // PvP integrity sweep: a client that keeps ignoring validated PvP damage
    // (god-mode) accumulates un-paid damage; two dirty windows = kick.
    // Honest clients pay the accumulator down instantly via their hp reports,
    // so false positives need >120 fully-masked damage twice in a row.
    this.clock.setInterval(() => {
      for (const client of this.clients) {
        const mt = this.meta.get(client.sessionId);
        const p = this.state.players.get(client.sessionId);
        if (!mt || !p) continue;
        if ((mt.pvpTaken || 0) > 120 && !p.dead) {
          mt.strikes = (mt.strikes || 0) + 1;
          console.warn(`[bravo] INTEGRITY strike ${mt.strikes} for ${p.name} (ignored ~${mt.pvpTaken} PvP dmg)`);
          if (mt.strikes >= 2) {
            this.broadcast('feed', { text: `🚫 ${p.name} was removed (damage tampering)` });
            client.leave(4001);
          }
        }
        mt.pvpTaken = 0;   // window reset
      }
    }, 15000);

    // ── Ground drops (shared, first-come pickup) ──
    this.drops = new Map();   // dropId -> {type,count,x,y,expire}
    this.dropSeq = 0;
    const DROP_TYPES = new Set(['wood','stone','planks','arrows','hide','bone','gold','skull','bandages','potions','iron_ore','iron_ingot','steel_ingot','siege_ram','torch','lantern']);
    this.onMessage('drop_add', (client, m) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || p.dead || typeof m !== 'object' || m === null) return;
      const type = '' + m.type; let count = m.count | 0;
      if (!DROP_TYPES.has(type) || count < 1 || count > 9999) return;
      const id = 'd' + (this.dropSeq++);
      const d = { type, count, x: p.x, y: p.y, expire: Date.now() + 180000 };
      this.drops.set(id, d);
      this.broadcast('drop_add', { id, type, count, x: d.x, y: d.y });
    });
    this.onMessage('drop_take', (client, m) => {
      const p = this.state.players.get(client.sessionId);
      const d = this.drops.get('' + (m && m.id));
      if (!p || p.dead || !d) return;
      if (Math.hypot(d.x - p.x, d.y - p.y) > TILE * 3) return;   // must be close
      this.drops.delete('' + m.id);
      this.broadcast('drop_gone', { id: '' + m.id });
      client.send('drop_got', { type: d.type, count: d.count });   // only the taker gains it
      // PHASE 1: credit the document too. This path is left as the client's
      // pickup route rather than moving it onto the `tx` message, because the
      // drop table was ALREADY server-owned — the server decides who gets it and
      // what it is worth, and the client only ever names an id. Routing it
      // through a second message would have been two code paths for one rule.
      try {
        const doc = character.ensure(p.name, (client.auth && client.auth.username) || '', storage.loadBlob(p.name));
        const r = tx.apply(doc, 'pickup', { type: d.type, count: d.count }, {});
        if (r.ok) character.touch(p.name);
        else console.log(`[tx] ${p.name} pickup REJECTED: ${r.reason}`);
      } catch (e) { console.warn('[tx] pickup credit failed:', e.message); }
    });
    this.clock.setInterval(() => {
      const now = Date.now();
      for (const [id, d] of this.drops) if (d.expire < now) { this.drops.delete(id); this.broadcast('drop_gone', { id }); }
    }, 10000);

    // ── Player trading (server-brokered escrow) ──
    // Each session is between two players; both post an offer (gold + items),
    // both confirm the *current* offers, then the server tells each client to
    // subtract what they gave and add what they got — an atomic swap.
    this.trades = new Map();   // tradeId -> {a,b, offerA, offerB, confA, confB}
    this.tradeOf = new Map();  // sessionId -> tradeId
    const cleanOffer = o => {
      const out = { gold: 0, items: {} };
      if (o && typeof o === 'object') {
        out.gold = Math.max(0, Math.min(1e7, o.gold | 0));
        if (o.items && typeof o.items === 'object') for (const k of Object.keys(o.items))
          if (DROP_TYPES.has(k)) out.items[k] = Math.max(0, Math.min(9999, o.items[k] | 0));
      }
      return out;
    };
    this.onMessage('trade_req', (client, m) => {
      const p = this.state.players.get(client.sessionId);
      const tgt = this.state.players.get('' + (m && m.to));
      if (!p || !tgt || '' + m.to === client.sessionId) return;
      if (this.tradeOf.has(client.sessionId) || this.tradeOf.has('' + m.to)) return;
      if (Math.hypot(p.x - tgt.x, p.y - tgt.y) > TILE * 5) return;
      this.clients.find(c => c.sessionId === '' + m.to)?.send('trade_invite', { from: client.sessionId, name: p.name });
    });
    this.onMessage('trade_accept', (client, m) => {
      const aId = '' + (m && m.from), bId = client.sessionId;
      const a = this.state.players.get(aId), b = this.state.players.get(bId);
      if (!a || !b || this.tradeOf.has(aId) || this.tradeOf.has(bId)) return;
      const tid = 't' + (this.dropSeq++);
      this.trades.set(tid, { a: aId, b: bId, offerA: { gold: 0, items: {} }, offerB: { gold: 0, items: {} }, confA: false, confB: false });
      this.tradeOf.set(aId, tid); this.tradeOf.set(bId, tid);
      this.clients.find(c => c.sessionId === aId)?.send('trade_start', { with: bId, name: b.name });
      this.clients.find(c => c.sessionId === bId)?.send('trade_start', { with: aId, name: a.name });
    });
    const tradeSend = (tr, ev, extra) => {
      for (const sid of [tr.a, tr.b]) {
        const other = sid === tr.a ? 'B' : 'A';
        this.clients.find(c => c.sessionId === sid)?.send(ev, Object.assign({
          yourOffer: sid === tr.a ? tr.offerA : tr.offerB,
          theirOffer: sid === tr.a ? tr.offerB : tr.offerA,
          youConfirmed: sid === tr.a ? tr.confA : tr.confB,
          theyConfirmed: sid === tr.a ? tr.confB : tr.confA,
        }, extra || {}));
      }
    };
    this.onMessage('trade_offer', (client, m) => {
      const tid = this.tradeOf.get(client.sessionId); const tr = tid && this.trades.get(tid);
      if (!tr) return;
      if (client.sessionId === tr.a) tr.offerA = cleanOffer(m); else tr.offerB = cleanOffer(m);
      tr.confA = tr.confB = false;   // any change resets confirmations
      tradeSend(tr, 'trade_update');
    });
    this.onMessage('trade_confirm', (client, m) => {
      const tid = this.tradeOf.get(client.sessionId); const tr = tid && this.trades.get(tid);
      if (!tr) return;
      if (client.sessionId === tr.a) tr.confA = true; else tr.confB = true;
      if (tr.confA && tr.confB) {
        this.clients.find(c => c.sessionId === tr.a)?.send('trade_done', { give: tr.offerA, get: tr.offerB });
        this.clients.find(c => c.sessionId === tr.b)?.send('trade_done', { give: tr.offerB, get: tr.offerA });
        this.endTrade(tid);
      } else tradeSend(tr, 'trade_update');
    });
    this.onMessage('trade_cancel', (client, m) => {
      const tid = this.tradeOf.get(client.sessionId); if (tid) this.endTrade(tid, client.sessionId);
    });

    this.clock.setInterval(() => this.persistAll(), 30000);
    console.log(`[bravo] world room created (storage: ${storage.backend})`);
  }

  // Character identity is an ACCOUNT now, not a browser-local token.
  //
  // The old scheme stored a random token in localStorage and treated it as the
  // identity. That token could not leave the machine that generated it, so a
  // player logging in from a second computer presented a new token, failed the
  // match against their own claimed name, and was refused — the exact thing
  // accounts are here to fix. See accounts.js.
  //
  // The client logs in over HTTP first (POST /auth/login) and passes the
  // resulting session here. Legacy tokened names are migrated on first
  // account login below, so existing characters are not stranded.
  onAuth(client, options) {
    const name = BravoRoom.cleanName(options && options.name);
    const session = (options && typeof options.session === 'string') ? options.session : '';
    const user = accounts.sessionUser(session);
    if (!user) {
      console.warn(`[bravo] REJECTED join as "${name}" — no valid session`);
      throw new Error('not-logged-in');
    }
    // Claim on first use; refuse if the name belongs to a different account.
    if (!accounts.claimCharacter(name, user)) {
      console.warn(`[bravo] REJECTED "${user}" joining as "${name}" — owned by another account`);
      throw new Error('character-owned');
    }
    // The character's legacy browser token is now meaningless — the account
    // owns it. Clearing it stops the old check from ever rejecting the owner.
    if (storage.getToken(name)) storage.setToken(name, '');
    return { username: user, character: name };
  }

  static cleanName(raw) {
    let name = (typeof raw === 'string') ? raw : '';
    return name.replace(/[^\w \-']/g, '').trim().slice(0, 16) || 'Traveler';
  }

  onJoin(client, options) {
    const name = BravoRoom.cleanName(options && options.name);
    const p = new PlayerState();
    p.name = name;
    const saved = storage.load(name);
    p.x = saved ? saved.x : 310 * TILE + 24;   // default spawn: Lunar town square
    p.y = saved ? saved.y : 360 * TILE + 24;
    p.kills = saved ? saved.kills : 0;
    p.deaths = saved ? saved.deaths : 0;
    p.dir = Math.PI; p.weapon = 'sword'; p.hp = 100; p.maxHp = 100;
    this.state.players.set(client.sessionId, p);
    const blob = storage.loadBlob(name);   // server-side save (source of truth online)
    if (blob) client.send('save', blob);
    // PHASE 0 (docs/SERVER_AUTHORITY.md): build the server-side character
    // document, importing from the legacy blob the first time we see this
    // character. Nothing is authoritative yet -- the client still writes its own
    // save and still wins. This is a shadow copy whose only job right now is to
    // exist and to be compared against, so Phase 1 is built on a complete
    // picture rather than on guesses about what the client mutates.
    try {
      character.ensure(name, (client.auth && client.auth.username) || '', blob);
    } catch (e) {
      console.warn(`[character] ensure failed for ${name}: ${e.message}`);
    }
    // Authoritative world clock, so every client shares one sky. Clients used
    // to start their own day at 00:00 on page load, meaning two players stood
    // side by side in different lighting.
    client.send('worldtime', { t: Date.now() / 1000 });
    client.send('houses', this.houses);   // current shared houses
    client.send('placed_objects', this.placedObjects);   // current shared placed items (torches, lanterns, etc.)
    for (const [id, d] of this.drops) client.send('drop_add', { id, type: d.type, count: d.count, x: d.x, y: d.y });
    this.meta.set(client.sessionId, {
      lastMoveAt: Date.now(), lastTpAt: Date.now(),   // join placement counts as a tp
      lastAtkAt: 0, lastChatAt: 0, lastHitBy: null, lastHitAt: 0, speedFlags: 0,
      pvpTaken: 0, lastCountedHit: 0, strikes: 0, devTp: 0,
    });
    console.log(`[bravo] + ${name} (${client.sessionId}) — ${this.state.players.size} online`);
  }

  onLeave(client) {
    const p = this.state.players.get(client.sessionId);
    if (p) {
      storage.save(p.name, p);
      // ⚠ Document writes are batched on a timer, so a leaver can be holding up
      // to that window of unwritten play. Closing flushes it — without this the
      // batching quietly eats the last couple of seconds of every session, which
      // is the exact failure the batching decision was warned about.
      try { character.close(p.name); } catch (e) { console.warn('[character] close failed:', e.message); }
      console.log(`[bravo] - ${p.name} (${client.sessionId})`);
    }
    const tid = this.tradeOf && this.tradeOf.get(client.sessionId);
    if (tid) this.endTrade(tid, client.sessionId);   // a leaver cancels their trade
    this.state.players.delete(client.sessionId);
    this.meta.delete(client.sessionId);
  }

  persistAll() {
    this.state.players.forEach(p => storage.save(p.name, p));
  }

  loadHouses() {
    try { return JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'data', 'houses.json'), 'utf8')); }
    catch (e) { return []; }
  }
  saveHouses() {
    try {
      const fs = require('fs'), path = require('path');
      fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
      fs.writeFileSync(path.join(__dirname, 'data', 'houses.json'), JSON.stringify(this.houses));
    } catch (e) { console.warn('[bravo] houses persist failed:', e.message); }
  }
  broadcastHouses() { this.broadcast('houses', this.houses); }

  loadPlacedObjects() {
    try { return JSON.parse(require('fs').readFileSync(require('path').join(__dirname, 'data', 'placed_objects.json'), 'utf8')); }
    catch (e) { return []; }
  }
  savePlacedObjects() {
    try {
      const fs = require('fs'), path = require('path');
      fs.mkdirSync(path.join(__dirname, 'data'), { recursive: true });
      fs.writeFileSync(path.join(__dirname, 'data', 'placed_objects.json'), JSON.stringify(this.placedObjects));
    } catch (e) { console.warn('[bravo] placed objects persist failed:', e.message); }
  }
  broadcastPlacedObjects() { this.broadcast('placed_objects', this.placedObjects); }

  endTrade(tid, cancellerId) {
    const tr = this.trades.get(tid); if (!tr) return;
    this.trades.delete(tid);
    this.tradeOf.delete(tr.a); this.tradeOf.delete(tr.b);
    if (cancellerId) for (const sid of [tr.a, tr.b])
      this.clients.find(c => c.sessionId === sid)?.send('trade_end', {});
  }

  onDispose() {
    this.persistAll();
    // Same reason as onLeave: the batch window is a loss window, and a room
    // going away must not take unflushed documents with it.
    try { const n = character.flushAll(); if (n) console.log(`[character] flushed ${n} document(s) on dispose`); }
    catch (e) { console.warn('[character] dispose flush failed:', e.message); }
  }
}

module.exports = { BravoRoom };
