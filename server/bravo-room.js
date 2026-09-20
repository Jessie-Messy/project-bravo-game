// bravo-room.js — the persistent world room.
// Phase A: presence + chat. Phase B adds the authoritative layer for
// contested state: server-validated PvP (range/cooldown/safe-zone/damage),
// movement speed enforcement (anti-speed-hack), kill/death tracking, and
// SQLite persistence (storage.js). Mob AI stays client-side until Phase C.
const { Room } = require('colyseus');
const { Schema, MapSchema, defineTypes } = require('@colyseus/schema');
const storage = require('./storage.js');
const { verifyGameTicket, devAuthClaims } = require('./orion-auth.js');
const { MobSim, world } = require('./mobs.js');

// World metrics. DERIVED from world-data.json (which build-world-data.mjs
// generates straight out of the client's constants.js) rather than retyped here.
//
// ⚠ THEY USED TO BE RETYPED, AND IT WAS A LIVE BUG WAITING. This file hardcoded
// MAP_H = 554 and clamps every player's y to MAP_H * TILE. When the Saltmere
// coast was added below that band — world y 26880 to 32640 — the server would
// have clamped every coast position back to 26592 and dragged players off the
// region the instant they moved, while single-player worked perfectly. Two
// sources for one number, and the second one silently wins.
//
// mobs.js already read mapW/mapH from world-data.json; this now does the same.
// The fallbacks only apply when world-data.json is missing, in which case mobs
// are already disabled and the server is running degraded anyway.
const TILE  = (world && world.tile)  || 48;
const MAP_W = (world && world.mapW)  || 480;
const MAP_H = (world && world.mapH)  || 554;
const CITY = { x1: 280, y1: 332, x2: 340, y2: 392 };   // Lunar = safe zone

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

// ── Region rules ────────────────────────────────────────────────────────────
//
// Read from world-data.json, which build-world-data.mjs generates out of
// js/constants.js and js/world.js. NOT retyped here — see the MAP_H note above
// for what happens when a number lives in two places.
//
//   MAINLAND  safe zones throughout; you may attack ONLY an already-`bad`
//             player, and a `bad` player may not swing first — they may only
//             answer somebody who has just hit them.
//   COAST     open PvP outside Saltmere village. Kills here earn notoriety.
//
// Notoriety is EARNED on the coast and PAID FOR on the mainland. The server is
// the only thing that decides any of this; the client merely predicts it so it
// can grey out a prompt.
const R = (world && world.rules) || {};
const COAST_Y0        = R.coastY0        !== undefined ? R.coastY0        : 560;
const NOTO_BAD_AT     = R.notoBadAt      !== undefined ? R.notoBadAt      : 2;
const NOTO_DECAY_MS   = R.notoDecayMs    !== undefined ? R.notoDecayMs    : 30 * 60 * 1000;
const COMBAT_WINDOW_MS= R.combatWindowMs !== undefined ? R.combatWindowMs : 30 * 1000;
const COAST_SAFE      = R.coastSafeZone  || { x1:0, y1:0, x2:0, y2:0 };

const onCoast = y => (y / TILE) >= COAST_Y0;
function inCoastVillage(x, y) {
  const tx = x / TILE, ty = y / TILE;
  return tx >= COAST_SAFE.x1 && tx <= COAST_SAFE.x2 && ty >= COAST_SAFE.y1 && ty <= COAST_SAFE.y2;
}
// The mainland is safe ground wherever the old city rule said so; the coast is
// safe ONLY inside the village.
function inSafeZone(x, y) {
  return onCoast(y) ? inCoastVillage(x, y) : inCity(x, y);
}
const isBad = p => (p.noto | 0) >= NOTO_BAD_AT;

// Why `atk` may not hit `tgt` right now — or null when the swing is legal.
// One function, one place, used by both the pvp handler and the guard call.
function attackBlockedReason(atk, tgt, tgtSid, amt, now) {
  if (atk.dead || atk.ghost || tgt.dead || tgt.ghost) return 'dead';
  if (inSafeZone(atk.x, atk.y) || inSafeZone(tgt.x, tgt.y)) return 'safe-zone';
  // Cross-region swings are not a thing: the two bands are 14k units apart with
  // sealed rock between, so a hit spanning them is a spoofed position.
  if (onCoast(atk.y) !== onCoast(tgt.y)) return 'cross-region';

  if (onCoast(atk.y)) return null;             // coast: open PvP outside the village

  // ── mainland ──
  if (!isBad(tgt)) return 'target-not-outlaw';
  if (isBad(atk)) {
    // An outlaw cannot start a fight here. They may answer anyone who has hit
    // them inside the combat window — anyone, not just the last one, or a gang
    // could lock them out by taking turns.
    const rec = amt && amt.recentAttackers;
    if (!rec) return 'outlaw-cannot-initiate';
    const at = rec.get(tgtSid);
    if (!at || now - at > COMBAT_WINDOW_MS) return 'outlaw-cannot-initiate';
  }
  return null;
}

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
  // Notoriety. Broadcast because every client needs it: it decides who may be
  // attacked, whether guards will answer a call, and what colour the nameplate
  // is. Derived entirely on the server.
  noto:    'number',
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
    this.maxClients = 120;   // raised for load testing (Phase 01); real capacity needs interest management
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
            // ⚠ NOTORIETY IS EARNED ON THE COAST ONLY. A mainland kill can only
            // ever be a lawful one — the rules do not permit any other kind —
            // so crediting notoriety for it would punish the person enforcing
            // them. The victim's position decides, not the killer's: they are
            // in the same region anyway (cross-region swings are refused) and
            // the victim is the one who just died there.
            if (onCoast(p.y)) {
              killer.noto = (killer.noto | 0) + 1;
              const kmt = this.meta.get(mt.lastHitBy);
              if (kmt) kmt.notoAt = now;
              if (killer.noto === NOTO_BAD_AT)
                this.broadcast('feed', { text: `☠ ${killer.name} is now an outlaw.` });
              console.log(`[bravo] noto ${killer.name} -> ${killer.noto}`);
            }
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
      const now = Date.now();
      // Region rules decide legality. The client greys the prompt out, but the
      // client is not trusted — this is the only check that counts.
      const blocked = attackBlockedReason(atk, tgt, '' + m.t, mt, now);
      if (blocked) {
        // Tell the attacker why, so a refused swing reads as a rule rather than
        // as the game eating an input. Only to them: broadcasting it would leak
        // everyone's position and state to everyone.
        client.send('pvp_blocked', { reason: blocked, t: '' + m.t });
        return;
      }
      if (now - (mt.lastAtkAt || 0) < cfg.cooldownMs) return;
      if (Math.hypot(tgt.x - atk.x, tgt.y - atk.y) > cfg.range) return;
      mt.lastAtkAt = now;
      tmt.lastHitBy = client.sessionId;
      tmt.lastHitAt = now;
      // Remember who hit them, so an outlaw can answer back on the mainland.
      if (!tmt.recentAttackers) tmt.recentAttackers = new Map();
      tmt.recentAttackers.set(client.sessionId, now);
      // Prune on write — this only ever holds people from the last window.
      for (const [sid, at] of tmt.recentAttackers)
        if (now - at > COMBAT_WINDOW_MS) tmt.recentAttackers.delete(sid);
      // integrity accumulator — only count hits the victim's iframes wouldn't eat
      if (now - (tmt.lastCountedHit || 0) >= 800) {
        tmt.lastCountedHit = now;
        tmt.pvpTaken = (tmt.pvpTaken || 0) + cfg.dmg;
      }
      this.broadcast('pvp_hit', { from: client.sessionId, to: '' + m.t, w: m.w, dmg: cfg.dmg });
    });

    // full-save sync: the client streams its whole save blob; we persist it
    // and mirror x/y/hp/kills/deaths onto the schema so they survive here too
    this.onMessage('save', (client, blob) => {
      const p = this.state.players.get(client.sessionId);
      if (!p || typeof blob !== 'object' || blob === null) return;
      try {
        const str = JSON.stringify(blob);
        if (str.length > 200000) return;
        storage.saveBlob(p.name, str);
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

    // ── Notoriety decay ──
    // Without it an outlaw is hunted forever with no way back, which turns a
    // punishment into a dead character. One point falls off per NOTO_DECAY_MS of
    // CONNECTED time — connected, not wall-clock, so it cannot be waited out by
    // logging off and coming back tomorrow. Set NOTO_DECAY_MS to 0 in
    // constants.js to make notoriety permanent.
    if (NOTO_DECAY_MS > 0) {
      this.notoTimer = this.clock.setInterval(() => {
        const now = Date.now();
        this.state.players.forEach((p, sid) => {
          if ((p.noto | 0) <= 0) return;
          const mt = this.meta.get(sid);
          if (!mt) return;
          if (now - (mt.notoAt || now) < NOTO_DECAY_MS) return;
          mt.notoAt = now;
          const was = p.noto | 0;
          p.noto = was - 1;
          if (was === NOTO_BAD_AT && p.noto < NOTO_BAD_AT)
            this.broadcast('feed', { text: `${p.name} is no longer an outlaw.` });
          console.log(`[bravo] noto decay ${p.name} ${was} -> ${p.noto}`);
        });
      }, 60000);
    }

    // ── Calling the guards on an outlaw ──
    // The client already musters guards against MOBS by itself. This is the
    // player case, and it is refereed here for the same reason the swing is: the
    // question "is that person lawfully attackable" must have exactly one
    // answer, and the client is not it.
    this.onMessage('call_guards', (client, m) => {
      const caller = this.state.players.get(client.sessionId);
      const mt = this.meta.get(client.sessionId);
      if (!caller || !mt || typeof m !== 'object' || m === null) return;
      const now = Date.now();
      if (now - (mt.lastGuardCallAt || 0) < 15000) return;      // rate limit
      const tgt = this.state.players.get('' + m.t);
      if (!tgt) return;
      if (!isBad(tgt)) { client.send('guards_refused', { reason: 'not-an-outlaw' }); return; }
      if (Math.hypot(tgt.x - caller.x, tgt.y - caller.y) > TILE * 14) {
        client.send('guards_refused', { reason: 'too-far' }); return;
      }
      mt.lastGuardCallAt = now;
      // Everyone nearby sees them arrive, so a hunt is a public event rather
      // than a private one. The outlaw is told too — being hunted should be
      // legible to the person it is happening to.
      this.broadcast('guards_called', { t: '' + m.t, by: caller.name, x: tgt.x, y: tgt.y });
      console.log(`[bravo] guards called on ${tgt.name} by ${caller.name}`);
    });

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
      // Both are cosmetic and client-chosen, so they are bounded rather than
      // trusted: an unknown type falls back to the default house on every
      // client, and an unknown side falls back to the south wall.
      const type = (typeof m.type === 'string') ? m.type.slice(0, 24) : undefined;
      const doorSide = (m.doorSide === 'N' || m.doorSide === 'E' || m.doorSide === 'W') ? m.doorSide : 'S';
      this.houses.push({ x0, y0, size, type, doorSide,
                         isPublic: !!m.isPublic, friends: [], doorOpen: false, owner: p.name });
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
      this.placedObjects = this.placedObjects.filter(o => Math.hypot(o.x - x, o.y - y) > 6);
      this.placedObjects.push({ id, type, x: Math.round(x), y: Math.round(y), owner: p.name,
        ...(face ? { face } : {}), ...(litAt ? { litAt } : {}) });
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

  // Name claiming: the first join with a name stores the client's secret
  // token; later joins must present the same token or they're rejected.
  // Stops anyone from logging in as another playtester and inheriting
  // their position/stats.
  // Identity comes from a signed Orion platform ticket, not from the client.
  //
  // This replaced a first-come name claim: whoever joined a name first stored a
  // per-device secret and kept it. That bound a character to a browser, and any
  // unclaimed name could be taken by anyone. Now the ticket is HMAC-signed by
  // the platform, lives 60 seconds, and carries the real account id.
  //
  // The name is read from the ticket's claims and `options.name` is ignored
  // entirely — otherwise a player could present a valid ticket and still ask to
  // be someone else.
  onAuth(client, options) {
    const ticket = (options && typeof options.token === 'string') ? options.token : '';
    // A real ticket first, always. devAuthClaims returns null on any server that
    // has a secret configured, so this cannot weaken production — see the guard
    // conditions in orion-auth.js.
    const claims = verifyGameTicket(ticket, 'medieval') || devAuthClaims(options);

    if (!claims) {
      console.warn('[bravo] REJECTED join: invalid, expired or missing ticket');
      throw new Error('bad-ticket');
    }
    if (claims.dev) console.warn(`[bravo] DEV AUTH join as "${claims.name}" — no ticket was checked`);

    // Returned from onAuth, so it arrives as client.auth in onJoin.
    return { uid: claims.uid, name: BravoRoom.cleanName(claims.name), slot: claims.slot | 0 };
  }

  static cleanName(raw) {
    let name = (typeof raw === 'string') ? raw : '';
    return name.replace(/[^\w \-']/g, '').trim().slice(0, 16) || 'Traveler';
  }

  onJoin(client, options) {
    // client.auth is what onAuth returned — the verified account, not anything
    // the browser asked to be called.
    const name = (client.auth && client.auth.name) || 'Traveler';
    const p = new PlayerState();
    p.name = name;
    const saved = storage.load(name);
    p.x = saved ? saved.x : 310 * TILE + 24;   // default spawn: Lunar town square
    p.y = saved ? saved.y : 360 * TILE + 24;
    p.kills = saved ? saved.kills : 0;
    p.deaths = saved ? saved.deaths : 0;
    p.noto   = saved && saved.noto ? saved.noto | 0 : 0;
    p.dir = Math.PI; p.weapon = 'sword'; p.hp = 100; p.maxHp = 100;
    this.state.players.set(client.sessionId, p);
    const blob = storage.loadBlob(name);   // server-side save (source of truth online)
    if (blob) client.send('save', blob);
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
      notoAt: Date.now(), recentAttackers: new Map(),
      pvpTaken: 0, lastCountedHit: 0, strikes: 0, devTp: 0,
    });
    console.log(`[bravo] + ${name} (${client.sessionId}) — ${this.state.players.size} online`);
  }

  onLeave(client) {
    const p = this.state.players.get(client.sessionId);
    if (p) {
      storage.save(p.name, p);
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

  onDispose() { this.persistAll(); }
}

module.exports = { BravoRoom };
