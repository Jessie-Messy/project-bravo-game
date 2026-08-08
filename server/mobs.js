// mobs.js — server-authoritative overworld mob simulation (wolves + bandits).
// Mirrors the client's enemies.js AI for these two types: wander, aggro,
// chase (walkability-checked via world-data.json), melee attack, bandit
// flee, wolf pack-howl, death + respawn. Clients render these mobs through
// their normal enemy pipeline and send damage intents ('mob_hit') that are
// clamped and rate-limited here. Dungeon/champ/custom mobs remain client-
// side until Phase C part 2.
//
// Regenerate world-data.json after editing the world:
//   node --experimental-default-type=module server/build-world-data.mjs
const fs = require('fs');
const path = require('path');

const TILE = 48;
const CFG = {
  wolf:   { maxHp: 30, speed: 140, damage: 8,  attackRange: TILE * 1.1, aggroRange: TILE * 4, attackCooldown: 1.1, count: 32 },
  bandit: { maxHp: 50, speed: 75,  damage: 15, attackRange: TILE * 1.3, aggroRange: TILE * 6, attackCooldown: 1.4, count: 16 },
};
const RESPAWN_DELAY = 45, CORPSE_TIME = 3;
const HIT_MAX_DMG = 60, HIT_MIN_INTERVAL = 180 /*ms*/, HIT_MAX_RANGE = TILE * 18;

let world = null;
try {
  world = JSON.parse(fs.readFileSync(path.join(__dirname, 'world-data.json'), 'utf8'));
  world.bits = Buffer.from(world.walkB64, 'base64');
  console.log('[mobs] world-data loaded:', world.wolfSpawns.length, 'wolf +', world.banditSpawns.length, 'bandit spawns');
} catch (e) {
  console.warn('[mobs] world-data.json missing — server mobs DISABLED (' + e.message.split('\n')[0] + ')');
}

function blockedTile(x, y) {
  const tx = Math.floor(x / TILE), ty = Math.floor(y / TILE);
  if (tx < 0 || ty < 0 || tx >= world.mapW || ty >= world.mapH) return true;
  const i = ty * world.mapW + tx;
  return ((world.bits[i >> 3] >> (i & 7)) & 1) === 1;
}

class MobSim {
  constructor(room, MobState) {
    this.room = room;
    this.MobState = MobState;
    this.meta = new Map();       // id -> server-only fields (timers, aggro, spawn)
    this.hitAt = new Map();      // sessionId -> last accepted mob_hit ms
    if (!world) return;
    let n = 0;
    for (const type of ['wolf', 'bandit']) {
      const spawns = type === 'wolf' ? world.wolfSpawns : world.banditSpawns;
      for (let i = 0; i < CFG[type].count; i++) {
        const [sx, sy] = spawns[i % spawns.length];
        this.spawn('m' + (n++), type, sx * TILE + TILE / 2, sy * TILE + TILE / 2);
      }
    }
    console.log('[mobs] spawned', n, 'server mobs');
  }

  spawn(id, type, x, y) {
    const cfg = CFG[type];
    const m = new this.MobState();
    m.type = type; m.x = x; m.y = y; m.hp = cfg.maxHp; m.maxHp = cfg.maxHp; m.dead = false;
    this.room.state.mobs.set(id, m);
    this.meta.set(id, { spawnX: x, spawnY: y, attackCd: 1, iframes: 0, respawn: 0,
      wanderT: 0, wanderA: 0, aggroId: null, fleeing: false });
  }

  eligiblePlayers() {
    const out = [];
    this.room.state.players.forEach((p, id) => {
      if (!p.dead && !p.ghost && !p.hidden) out.push({ id, p });
    });
    return out;
  }

  tick(dt) {
    if (!world || this.room.state.players.size === 0) return;   // empty world sleeps
    const players = this.eligiblePlayers();
    this.room.state.mobs.forEach((m, id) => {
      const mt = this.meta.get(id);
      const cfg = CFG[m.type];
      if (m.dead) {
        mt.respawn -= dt;
        if (mt.respawn <= 0) {
          m.x = mt.spawnX; m.y = mt.spawnY; m.hp = cfg.maxHp; m.dead = false;
          mt.aggroId = null; mt.fleeing = false; mt.attackCd = cfg.attackCooldown;
        }
        return;
      }
      if (mt.attackCd > 0) mt.attackCd -= dt;
      if (mt.iframes > 0) mt.iframes -= dt;
      mt.wanderT -= dt;

      // target: keep the current one while in extended range, else nearest
      let tgt = null, tdist = Infinity;
      if (mt.aggroId) {
        const cur = players.find(e => e.id === mt.aggroId);
        if (cur) { const d = Math.hypot(cur.p.x - m.x, cur.p.y - m.y);
          if (d < cfg.aggroRange * 1.6) { tgt = cur; tdist = d; } }
        if (!tgt) mt.aggroId = null;
      }
      if (!tgt) for (const e of players) {
        const d = Math.hypot(e.p.x - m.x, e.p.y - m.y);
        if (d <= cfg.aggroRange && d < tdist) { tgt = e; tdist = d; }
      }
      if (tgt && !mt.aggroId) {
        mt.aggroId = tgt.id;
        if (m.type === 'wolf') this.howl(m, id);   // pack up!
      }

      // bandit courage fails below 30% hp
      if (m.type === 'bandit' && !mt.fleeing && m.hp / m.maxHp < 0.3) mt.fleeing = true;
      if (mt.fleeing) {
        if (tgt && tdist < TILE * 20) this.step(m, m.x - (tgt.p.x - m.x) / tdist, m.y - (tgt.p.y - m.y) / tdist, cfg.speed * 1.3 * dt, tgt, tdist);
        return;
      }

      if (tgt) {
        if (tdist > cfg.attackRange * 0.8)
          this.step(m, tgt.p.x, tgt.p.y, cfg.speed * dt, tgt, tdist);
        if (tdist <= cfg.attackRange && mt.attackCd <= 0) {
          mt.attackCd = cfg.attackCooldown;
          this.room.broadcast('mob_atk', { id, to: tgt.id, dmg: cfg.damage });
        }
      } else {
        if (mt.wanderT <= 0) { mt.wanderA = Math.random() * Math.PI * 2; mt.wanderT = 2 + Math.random() * 2; }
        const ws = cfg.speed * 0.38 * dt;
        const nx = m.x + Math.cos(mt.wanderA) * ws, ny = m.y + Math.sin(mt.wanderA) * ws;
        if (!blockedTile(nx, m.y)) m.x = nx; else mt.wanderT = 0;
        if (!blockedTile(m.x, ny)) m.y = ny; else mt.wanderT = 0;
      }
    });
  }

  // axis-separated move toward (tx,ty), respecting walkability
  step(m, tx, ty, dist, tgtWrap, tdist) {
    const dx = tx - m.x, dy = ty - m.y, len = Math.hypot(dx, dy) || 1;
    const nx = m.x + (dx / len) * dist, ny = m.y + (dy / len) * dist;
    if (!blockedTile(nx, m.y)) m.x = nx;
    if (!blockedTile(m.x, ny)) m.y = ny;
  }

  howl(wolf, selfId) {
    this.room.state.mobs.forEach((o, oid) => {
      if (oid === selfId || o.type !== 'wolf' || o.dead) return;
      const mt = this.meta.get(oid);
      if (!mt.aggroId && Math.hypot(o.x - wolf.x, o.y - wolf.y) < TILE * 8)
        mt.aggroId = this.meta.get(selfId).aggroId;
    });
  }

  // client damage intent — clamped, rate-limited, range-checked
  onHit(client, msg) {
    if (!world || typeof msg !== 'object' || msg === null) return;
    const m = this.room.state.mobs.get('' + msg.id);
    const mt = this.meta.get('' + msg.id);
    const p = this.room.state.players.get(client.sessionId);
    if (!m || !mt || !p || m.dead || p.dead || p.ghost) return;
    const now = Date.now();
    if (now - (this.hitAt.get(client.sessionId) || 0) < HIT_MIN_INTERVAL) return;
    if (mt.iframes > 0) return;
    if (Math.hypot(m.x - p.x, m.y - p.y) > HIT_MAX_RANGE) return;
    let dmg = +msg.dmg;
    if (!isFinite(dmg)) return;
    dmg = Math.max(1, Math.min(HIT_MAX_DMG, dmg | 0));
    this.hitAt.set(client.sessionId, now);
    mt.iframes = 0.3;
    m.hp -= dmg;
    mt.aggroId = mt.aggroId || client.sessionId;   // fight back
    if (m.hp <= 0) {
      m.hp = 0; m.dead = true;
      mt.respawn = RESPAWN_DELAY + CORPSE_TIME;
      this.room.broadcast('mob_dead', { id: '' + msg.id, killer: client.sessionId });
    }
  }
}

module.exports = { MobSim, world };   // world-data shared with tp validation
