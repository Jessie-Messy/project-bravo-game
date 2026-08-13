// enemies.js — enemy config, factory, AI, champion system
import { TILE, MAP_W, MAP_H, T,
  ENEMY_RESPAWN_DELAY, WOLF_TARGET, BANDIT_TARGET, ENEMY_POP_CHECK_INTERVAL,
  CHAMP_KILLS_PER_CANDLE, CHAMP_MAX_MOBS, CHAMP_DUNGEON_MAX,
  DUNGEON_X0, DUNGEON_Y0, DUNGEON_W, DUNGEON_H,
} from './constants.js';
import { G, map, player, enemies, drops, floaters, hitFlash, eProjList, skills, inv } from './state.js';
import { CHAMP_ALTARS, WOLF_SPAWNS, BANDIT_SPAWNS, CAVE_MOBS } from './world.js';
import { snd } from './audio.js';

// ── Enemy config ───────────────────────────────────────────────────
export const ENEMY_CFG = {
  wolf:        { maxHp:30,  speed:140, damage:8,  attackRange:TILE*1.1, aggroRange:TILE*4,  attackCooldown:1.1, r:11 },
  bandit:      { maxHp:50,  speed:75,  damage:15, attackRange:TILE*1.3, aggroRange:TILE*6,  attackCooldown:1.4, r:13 },
  goblin:      { maxHp:22,  speed:160, damage:10, attackRange:TILE*0.9, aggroRange:TILE*5,  attackCooldown:0.9, r:9  },
  troll:       { maxHp:90,  speed:48,  damage:26, attackRange:TILE*1.5, aggroRange:TILE*4,  attackCooldown:2.0, r:16 },
  spider:      { maxHp:35,  speed:130, damage:12, attackRange:TILE*1.0, aggroRange:TILE*5,  attackCooldown:1.2, r:11 },
  goblin_k:    { maxHp:220, speed:85,  damage:32, attackRange:TILE*1.4, aggroRange:TILE*9,  attackCooldown:1.4, r:20 },
  troll_l:     { maxHp:450, speed:32,  damage:58, attackRange:TILE*2.0, aggroRange:TILE*9,  attackCooldown:2.6, r:28 },
  spider_q:    { maxHp:280, speed:100, damage:40, attackRange:TILE*1.5, aggroRange:TILE*9,  attackCooldown:1.6, r:24 },
  slime:       { maxHp:20,  speed:52,  damage:5,  attackRange:TILE*0.8, aggroRange:TILE*3,  attackCooldown:1.6, r:10 },
  slime_mini:  { maxHp:8,   speed:70,  damage:3,  attackRange:TILE*0.7, aggroRange:TILE*3,  attackCooldown:1.4, r:6  },
  ratman:      { maxHp:38,  speed:115, damage:11, attackRange:TILE*0.9, aggroRange:TILE*5,  attackCooldown:1.0, r:10 },
  ratman_wiz:  { maxHp:30,  speed:85,  damage:16, attackRange:TILE*5.5, aggroRange:TILE*6,  attackCooldown:2.2, r:9  },
  hellhound:   { maxHp:58,  speed:170, damage:18, attackRange:TILE*1.1, aggroRange:TILE*6,  attackCooldown:0.9, r:12 },
  silver_serp: { maxHp:75,  speed:135, damage:14, attackRange:TILE*1.2, aggroRange:TILE*6,  attackCooldown:1.3, r:13 },
  piper:       { maxHp:520, speed:65,  damage:42, attackRange:TILE*1.6, aggroRange:TILE*12, attackCooldown:2.0, r:26 },
  giant_rat:   { maxHp:15,  speed:120, damage:4,  attackRange:TILE*0.9, aggroRange:TILE*4,  attackCooldown:1.2, r:8  },
  ratman_archer: { maxHp:34, speed:100, damage:10, attackRange:TILE*5.0, aggroRange:TILE*6,  attackCooldown:1.8, r:10 },
  // Slow, tanky, relentless. Tuned around the model's own animation set: it has a
  // shambling walk AND a run, so the aggro range is long and the speed low —
  // a zombie that noticed you from a long way off and then shuffled after you is
  // the fantasy, and the run clip only appears once it is close and committed.
  zombie:      { maxHp:70,  speed:44,  damage:14, attackRange:TILE*1.1, aggroRange:TILE*7,  attackCooldown:1.7, r:12 },
};

// ── Utility: tileAt / blockedAt / boxBlocked ───────────────────────
function tileAt(px, py) {
  const tx=Math.floor(px/TILE), ty=Math.floor(py/TILE);
  if (tx<0||ty<0||tx>=MAP_W||ty>=MAP_H) return T.STONE;
  return map[ty][tx];
}
// Custom tile ids (from the world editor) that should block movement
export const extraBlocking = new Set();
// Water is solid for everything EXCEPT a wading player. game3d.js flips this
// for the duration of the player's own collision test and restores it
// immediately, so mobs keep their banks and won't follow you into a river.
// It lives here because blockedAt hardcodes its tile test rather than reading
// BLOCKING, so there was no other seam to open water through.
export const WADE = { on: false };
function blockedAt(px, py, isPlayerCheck) {
  const t = tileAt(px,py);
  if (t===T.WATER && !WADE.on) return true;
  if (t===T.TREE||t===T.STONE||t===T.WALL||t===T.CAVE_WALL||extraBlocking.has(t)) return true;
  if (!isPlayerCheck && G.placedHouses) {
    const tx = Math.floor(px/TILE), ty = Math.floor(py/TILE);
    for (const h of G.placedHouses) {
      if (h.isPublic) continue;
      if (tx >= h.x0 && tx < h.x0 + h.size && ty >= h.y0 && ty < h.y0 + h.size) return true;
    }
  }
  return false;
}
export function boxBlocked(cx, cy, r, isPlayerCheck) {
  const isPlr = isPlayerCheck !== undefined ? isPlayerCheck : (Math.hypot(cx - player.x, cy - player.y) < player.r * 1.5);
  return blockedAt(cx-r,cy-r,isPlr)||blockedAt(cx+r,cy-r,isPlr)||blockedAt(cx-r,cy+r,isPlr)||blockedAt(cx+r,cy+r,isPlr);
}

// ── makeEnemy ──────────────────────────────────────────────────────
export function makeEnemy(type, tx, ty) {
  const cfg0 = ENEMY_CFG[type];
  if (!cfg0) return null;                 // unknown/deleted custom type
  const isCave = cfg0.spawnCave!==undefined ? cfg0.spawnCave :
    (type==='goblin'||type==='troll'||type==='spider'||type==='goblin_k'
    ||type==='troll_l'||type==='spider_q'||type==='slime'||type==='slime_mini'
    ||type==='ratman'||type==='ratman_wiz'||type==='hellhound'||type==='silver_serp'||type==='piper'
    ||type==='giant_rat'||type==='ratman_archer');
  const validTile = isCave ? T.CAVE_FLOOR : T.GRASS;
  let etx=-1, ety=-1;
  outer: for (let r=0;r<=6;r++) {
    for (let dy=-r;dy<=r;dy++) for (let dx=-r;dx<=r;dx++) {
      if (Math.abs(dx)!==r&&Math.abs(dy)!==r) continue;
      const nx=tx+dx, ny=ty+dy;
      if (nx<0||ny<0||nx>=MAP_W||ny>=MAP_H) continue;
      if (map[ny][nx]===validTile) { etx=nx; ety=ny; break outer; }
    }
  }
  if (etx<0) return null;
  const cfg=ENEMY_CFG[type], sx=etx*TILE+TILE/2, sy=ety*TILE+TILE/2;
  return { type, x:sx, y:sy, spawnX:sx, spawnY:sy,
    hp:cfg.maxHp, maxHp:cfg.maxHp, r:cfg.r,
    speed:cfg.speed, damage:cfg.damage,
    attackRange:cfg.attackRange, aggroRange:cfg.aggroRange,
    attackCooldown:cfg.attackCooldown, attackTimer:Math.random()*cfg.attackCooldown,
    iframes:0, state:'idle', deadTimer:0, respawnTimer:0, stunTimer:0,
    wanderAngle:Math.random()*Math.PI*2, wanderTimer:Math.random()*2,
    rangedTimer:0, abilityTimer:2+Math.random()*3,
    fleeing:false, isMini:type==='slime_mini', piperPhase:0,
  };
}

// ── Gear treasure drops ───────────────────────────────────────────
// The armor pieces that don't animate on the player drop here as loot.
// Tougher foes roll better pools, more often.
const GEAR_POOL = {
  weak:   ['loot_gloves', 'loot_arms'],
  mid:    ['loot_bgloves', 'loot_greaves', 'loot_arms'],
  strong: ['loot_gauntlets', 'loot_boots', 'loot_greaves'],
};
const GEAR_TIER = {
  goblin_k:'strong', troll_l:'strong', spider_q:'strong',
  goblin:'mid', troll:'mid', ratman:'mid', ratman_wiz:'mid', ratman_archer:'mid',
  hellhound:'mid', silver_serp:'mid', bandit:'mid',
};
const GEAR_CHANCE = { strong:0.22, mid:0.10, weak:0.06 };
function rollGearDrop(e) {
  const tier = GEAR_TIER[e.type] || 'weak';
  if (Math.random() >= GEAR_CHANCE[tier]) return;
  const pool = GEAR_POOL[tier];
  const key = pool[Math.floor(Math.random()*pool.length)];
  drops.push({ type:key, x:e.x, y:e.y, lifetime:90 });
}

// ── Loot drops ────────────────────────────────────────────────────
// (exported: multiplayer drops these for the server-decided killer only)
export function spawnDrops(e) {
  let resource, count;
  if(e.type==='wolf')       { resource='hide';  count=1+Math.floor(Math.random()*2); }
  else if(e.type==='goblin'){ resource='gold';  count=2+Math.floor(Math.random()*4); }
  else if(e.type==='spider'){ resource='hide';  count=1+Math.floor(Math.random()*2); }
  else if(e.type==='troll') { resource='stone'; count=2+Math.floor(Math.random()*3); }
  else if(e.type==='goblin_k')   { resource='gold';  count=12+Math.floor(Math.random()*8); }
  else if(e.type==='troll_l')    { resource='stone'; count=10+Math.floor(Math.random()*6); }
  else if(e.type==='spider_q')   { resource='hide';  count=8+Math.floor(Math.random()*6); }
  else if(e.type==='slime'||e.type==='slime_mini') { resource='stone'; count=1; }
  else if(e.type==='ratman')     { resource='gold';  count=1+Math.floor(Math.random()*2); }
  else if(e.type==='ratman_wiz') { resource='gold';  count=2+Math.floor(Math.random()*3); }
  else if(e.type==='ratman_archer') { resource='gold'; count=1+Math.floor(Math.random()*2); }
  else if(e.type==='giant_rat')  { resource='gold';  count=1; }
  else if(e.type==='hellhound')  { resource='hide';  count=1+Math.floor(Math.random()*2); }
  else if(e.type==='silver_serp'){ resource='hide';  count=2+Math.floor(Math.random()*2); }
  else if(e.type==='piper')      {
    // Massive gold explosion + unique skull drop on corpse
    for (let i=0;i<50;i++) {
      const ang=Math.random()*Math.PI*2, dist=16+Math.random()*96;
      drops.push({ type:'gold', x:e.x+Math.cos(ang)*dist, y:e.y+Math.sin(ang)*dist, lifetime:45 });
    }
    drops.push({ type:'skull', x:e.x, y:e.y, lifetime:90 });
    drops.push({ type:'loot_gauntlets', x:e.x+20, y:e.y, lifetime:120 });   // boss: guaranteed fine gear
    return;
  }
  else { resource='stone'; count=1+Math.floor(Math.random()*2); }
  // beasts leave bones behind ~40% of the time (bone armor material)
  if((e.type==='wolf'||e.type==='giant_rat'||e.type==='hellhound'||e.type==='silver_serp')&&Math.random()<0.4){
    resource='bone'; count=1+Math.floor(Math.random()*2);
  }
  for (let i=0;i<count;i++) {
    const ang=Math.random()*Math.PI*2, dist=8+Math.random()*14;
    drops.push({ type:resource, x:e.x+Math.cos(ang)*dist, y:e.y+Math.sin(ang)*dist, lifetime:30 });
  }
  if(e.type==='goblin_k'||e.type==='troll_l'||e.type==='spider_q'||e.type==='piper'){
    drops.push({ type:'steel_ingot', x:e.x-10, y:e.y, lifetime:90 });
    drops.push({ type:'mithril_ingot', x:e.x+10, y:e.y, lifetime:90 });
    if(Math.random()<0.5) drops.push({ type:'runic_ingot', x:e.x, y:e.y-10, lifetime:90 });
  }
  rollGearDrop(e);
}

// ── Champion system ────────────────────────────────────────────────
export function champOnKill(e) {
  if (e.altarIdx===undefined) return;
  const altar=CHAMP_ALTARS[e.altarIdx]; if (!altar) return;
  altar.decayTimer=0;
  if (e.isChampBoss) {
    floaters.push({ x:altar.x, y:altar.y-80, text:'*** CHAMPION SLAIN ***', life:0.9 });
    altar.state='idle'; altar.level=0; altar.whiteCandles=0; altar.killsThisCandle=0;
    return;
  }
  if (altar.state!=='active') return;
  altar.killsThisCandle++;
  const kpc=CHAMP_KILLS_PER_CANDLE[altar.level-1]||8;
  if (altar.killsThisCandle<kpc) return;
  altar.killsThisCandle=0; altar.whiteCandles++;
  floaters.push({ x:altar.x, y:altar.y-60, text:'shrine pulses…', life:0.9 });
  if (altar.whiteCandles%4!==0) return;
  const newLevel=Math.floor(altar.whiteCandles/4)+1;
  // Advancing a stage does NOT wipe the field — any surviving lower-stage
  // mobs stay; the higher raised mob cap simply lets new-stage mobs spawn
  // alongside them until the old ones are cleared out by the player.
  const maxWhite = altar.dungeon ? 24 : 16;
  if (altar.whiteCandles>=maxWhite) {
    altar.state='boss';
    floaters.push({ x:altar.x, y:altar.y-80, text:'⚠ BOSS AWAKENS ⚠', life:0.9 });
    const boss=makeEnemy(altar.bossType,altar.atx,altar.aty);
    if (boss) { boss.altarIdx=altar.idx; boss.isChamp=true; boss.isChampBoss=true; enemies.push(boss); }
  } else {
    altar.level=newLevel;
    floaters.push({ x:altar.x, y:altar.y-60, text:'TIER '+altar.level+'!', life:0.9 });
  }
}

export function champSpawnTick(dt) {
  for (const altar of CHAMP_ALTARS) {
    if (altar.state==='idle') {
      if (!player.dead&&Math.hypot(player.x-altar.x,player.y-altar.y)<altar.rx) {
        altar.state='active'; altar.level=1;
        altar.whiteCandles=0; altar.killsThisCandle=0;
        altar.decayTimer=0; altar.spawnTimer=2;
        floaters.push({ x:altar.x, y:altar.y-50, text:'the shrine awakens…', life:0.9 });
        if (altar.dungeon) {
          // Clear preexisting dungeon enemies to make room for waves — but NOT a
          // named floor boss. spawnFloorBoss sets isChampBoss without isChamp, so
          // this used to delete the floor's boss outright just because the player
          // wandered within range of an unrelated shrine.
          for (let i = enemies.length - 1; i >= 0; i--) {
            const em = enemies[i];
            if (em.x >= DUNGEON_X0 * TILE && em.x <= (DUNGEON_X0 + DUNGEON_W) * TILE &&
                em.y >= DUNGEON_Y0 * TILE && em.y <= (DUNGEON_Y0 + DUNGEON_H) * TILE &&
                !em.isChamp && !em.floorBoss) {
              enemies.splice(i, 1);
            }
          }
        }
      }
      continue;
    }
    if (altar.state==='boss') {
      const hasBoss=enemies.some(e=>e.altarIdx===altar.idx&&e.isChampBoss);
      if (!hasBoss) {
        altar.state='idle'; altar.level=0; altar.whiteCandles=0;
      }
      continue;
    }
    altar.decayTimer+=dt;
    if (altar.decayTimer>=altar.decayInterval) {
      altar.decayTimer=0;
      if (altar.whiteCandles>0) {
        altar.whiteCandles--;
        if (altar.whiteCandles===0) {
          altar.state='idle'; altar.level=0; altar.whiteCandles=0; altar.killsThisCandle=0;
          floaters.push({ x:altar.x, y:altar.y-60, text:'shrine deactivated…', life:0.9 });
          for (const em of enemies) {
            if (em.altarIdx===altar.idx&&!em.isChampBoss&&em.state!=='dead'&&em.state!=='respawning') {
              em.state='dead'; em.deadTimer=0;
            }
          }
        } else if (altar.whiteCandles<(altar.level-1)*4) {
          altar.level=Math.max(1,altar.level-1);
          floaters.push({ x:altar.x, y:altar.y-60, text:'shrine dims…', life:0.9 });
        }
      } else {
        altar.state='idle'; altar.level=0; altar.whiteCandles=0; altar.killsThisCandle=0;
        floaters.push({ x:altar.x, y:altar.y-60, text:'shrine deactivated…', life:0.9 });
        for (const em of enemies) {
          if (em.altarIdx===altar.idx&&!em.isChampBoss&&em.state!=='dead'&&em.state!=='respawning') {
            em.state='dead'; em.deadTimer=0;
          }
        }
      }
    }
    altar.spawnTimer-=dt;
    if (altar.spawnTimer>0) continue;
    altar.spawnTimer=altar.spawnCooldown;
    const activeMobs=enemies.filter(e=>e.altarIdx===altar.idx&&!e.isChampBoss
      &&e.state!=='dead'&&e.state!=='respawning').length;
    const maxMobs = altar.dungeon
      ? (CHAMP_DUNGEON_MAX[altar.level-1]||CHAMP_DUNGEON_MAX[CHAMP_DUNGEON_MAX.length-1])
      : (CHAMP_MAX_MOBS[altar.level-1]||4);
    // Dungeon fills quickly & throughout (batch); overworld altars trickle one.
    let toSpawn = altar.dungeon ? Math.min(maxMobs-activeMobs, 5) : (activeMobs<maxMobs ? 1 : 0);
    while (toSpawn-- > 0) {
      let spawnType=altar.type;
      if (altar.mobPool) {
        const pool=altar.mobPool[Math.min(altar.level-1,altar.mobPool.length-1)];
        spawnType=pool[Math.floor(Math.random()*pool.length)];
      }
      let spawnTx = altar.atx, spawnTy = altar.aty;
      if (altar.dungeon) {
        for (let attempt = 0; attempt < 100; attempt++) {
          const rx = DUNGEON_X0 + Math.floor(Math.random() * DUNGEON_W);
          const ry = DUNGEON_Y0 + Math.floor(Math.random() * DUNGEON_H);
          if (map[ry]?.[rx] === T.CAVE_FLOOR) { spawnTx = rx; spawnTy = ry; break; }
        }
      }
      const em=makeEnemy(spawnType,spawnTx,spawnTy);
      if (em) { em.altarIdx=altar.idx; em.isChamp=true; enemies.push(em); }
    }
  }
}

// ── fireEnemyProj ──────────────────────────────────────────────────
export function fireEnemyProj(e, dmg, speed, col, size) {
  const pdx=player.x-e.x, pdy=player.y-e.y, dist=Math.hypot(pdx,pdy);
  if(dist<1) return;
  eProjList.push({ x:e.x, y:e.y, vx:(pdx/dist)*speed, vy:(pdy/dist)*speed,
    dmg, col:col||'#c8a060', r:size||4, life:2.5 });
}

// ── damagePlayer/damageEnemy ───────────────────────────────────────
export function damagePlayer(dmg, attacker) {
  if (player.iframes>0||player.dead||G.housePlacementMode) return;
  player._lastDmgTime = G.gameTime || 0;
  if (skills.hiding && skills.hiding.active) {
    if (player._ghostShield) {
      delete player._ghostShield;
      floaters.push({ x:player.x, y:player.y-40, text:'🛡 GHOSTWALKER SHIELD!', life:0.9 });
      player.iframes = 0.5;
      return;
    } else {
      skills.hiding.active = false;
      skills.hiding.cooldown = 30;
      floaters.push({ x:player.x, y:player.y-40, text:'stealth broken (damaged)', life:0.9 });
    }
  }
  let wLv = 1;
  if (skills.wrestling && skills.wrestling.xp) {
    const xps = [0, 100, 300, 700, 1500, 3000, 5500, 9000, 14000, 20000];
    for (let i=1; i<xps.length; i++) if (skills.wrestling.xp >= xps[i]) wLv = i+1;
    wLv = Math.min(wLv, 10);
  }
  if (attacker && wLv >= 4 && Math.hypot(attacker.x-player.x, attacker.y-player.y) < TILE*2.5 && Math.random() < 0.20) {
    attacker.stunTimer = wLv >= 7 ? 3.5 : 2.0;
    const counterDmg = wLv >= 8 ? Math.round(15 + wLv * 4) : 0;
    if (counterDmg > 0) damageEnemy(attacker, counterDmg);
    floaters.push({ x:attacker.x, y:attacker.y-24, text:(wLv>=8?'🥊 COUNTER-PUNCH! ':'COUNTER THROW! ')+(counterDmg?'-'+counterDmg+' ':'')+'stunned', life:0.9 });
    snd.hit();
  }
  if (hooks.playerDR) {            // slot-based armor (paper doll)
    const dr=hooks.playerDR();
    if (dr>0) dmg=Math.max(1,Math.ceil(dmg*(1-dr)));
  } else if (player.hasArmor) dmg=Math.max(1,Math.ceil(dmg*0.75));
  snd.hurt();
  player.hp-=dmg; player.iframes=0.8;
  floaters.push({ x:player.x, y:player.y-22, text:'-'+dmg, life:0.9 });
  if (player.hp<=0) {
    if (hooks.playerAutoRevive && hooks.playerAutoRevive()) return;   // Death Ward intercept
    player.hp=0; player.dead=true; player.ghost=true; snd.die();
    G.corpse={ x:player.x, y:player.y, inv:{...inv} };
    Object.keys(inv).forEach(k=>inv[k]=0);
    floaters.push({ x:player.x, y:player.y-40, text:'you died — find the healer', life:0.9 });
    for (const e of enemies) if (e.state!=='dead'&&e.state!=='respawning') { e.state='idle'; e.attackTimer=1; }
  }
}

// Optional listeners set by the entry point (e.g. quest system)
export const hooks = { onKill: null };

export function damageEnemy(e, dmg) {
  if (e.iframes>0||e.state==='dead'||e.state==='respawning') return;
  if (e.srv) {                       // server-authoritative mob: send the intent,
    e.iframes=0.3;                   // the server decides hp/death (state syncs back)
    floaters.push({ x:e.x, y:e.y-18, text:'-'+Math.round(dmg), life:0.9 });
    snd.enemyHit();
    if (hooks.srvMobHit) hooks.srvMobHit(e, dmg);
    return;
  }
  e.hp-=dmg; e.iframes=0.3;
  floaters.push({ x:e.x, y:e.y-18, text:'-'+dmg, life:0.9 });
  if (e.hp<=0) {
    e.hp=0; e.state='dead'; e.deadTimer=0; spawnDrops(e); snd.enemyDie();
    if (hooks.onKill) hooks.onKill(e);
    if (e.isChamp) champOnKill(e);
    if (e.type==='slime'&&!e.isMini) {
      for (let i=0;i<2;i++) {
        const mini=makeEnemy('slime_mini',Math.floor(e.x/TILE),Math.floor(e.y/TILE));
        if (mini) {
          mini.x=e.x+(i===0?-TILE*0.5:TILE*0.5); mini.y=e.y;
          mini.spawnX=mini.x; mini.spawnY=mini.y; mini.state='aggro';
          if (e.isChamp) { mini.isChamp=true; mini.altarIdx=e.altarIdx; }
          enemies.push(mini);
        }
      }
    }
  } else snd.enemyHit();
}

// ── Piper summon ───────────────────────────────────────────────────
function _piperSummon(piper, count) {
  for (let i=0;i<count;i++) {
    const em=makeEnemy('ratman',Math.floor(piper.x/TILE),Math.floor(piper.y/TILE));
    if (em) { em.state='aggro'; if(piper.isChamp){em.isChamp=true;em.altarIdx=piper.altarIdx;} enemies.push(em); }
  }
}

// ── Floor-boss abilities ───────────────────────────────────────────
// The named bosses used to be buffed stats with a tint — the only "mechanic"
// they had was the piper's inherited summon. These give them real attacks, and
// every one is TELEGRAPHED: the boss roots itself, a danger zone appears on the
// ground, and the blow lands a beat later. Standing in it is brutal; reading it
// costs one sidestep. That's the whole design — hard until you learn the tells,
// not hard because it's twitchy, so the wind-ups are deliberately generous
// (1.2-2.0s) precisely because the payloads are heavy (2-3x a normal hit).
//
//   at:'player'  zone locks where you WERE — step off it
//   at:'self'    zone is centred on the boss — get out of its reach
//   shape:'line' a lane from the boss through where you were — step aside
//   dmg is a multiplier on the boss's own damage.
export const BOSS_ABILITIES = {
  gravebinder: [
    { id:'grave_slam',  name:'GRAVE SLAM',    tell:1.3, cd:9,  range:TILE*8,
      shape:'circle', r:TILE*2.6, at:'player', dmg:2.2, stun:1.6 },
    { id:'bone_cage',   name:'BONE CAGE',     tell:1.6, cd:15, range:TILE*9,
      shape:'circle', r:TILE*1.9, at:'player', dmg:0.8, web:3.0 },
    // Phase move: only once it's wounded, and it's the one you run OUT of.
    { id:'marrow_quake',name:'MARROW QUAKE',  tell:2.0, cd:17, range:TILE*99, belowHp:0.55,
      shape:'circle', r:TILE*5.2, at:'self',   dmg:2.8, stun:1.0 },
  ],
  molloch: [
    { id:'shriek',      name:'PIERCING SHRIEK', tell:1.2, cd:10, range:TILE*10,
      shape:'line', len:TILE*9, w:TILE*1.7, at:'player', dmg:2.4, stun:1.2 },
    { id:'plague_wave', name:'PLAGUE WAVE',     tell:1.5, cd:12, range:TILE*99,
      shape:'circle', r:TILE*4.6, at:'self',   dmg:2.0, poison:5 },
    { id:'swarm',       name:'THE SWARM ANSWERS',tell:1.0, cd:22, range:TILE*12, belowHp:0.7,
      shape:'circle', r:TILE*1.2, at:'self',   summon:{type:'ratman', n:4} },
  ],
};
// Exported for the dev harness: forcing a specific ability beats waiting on the
// random picker when you're testing one telegraph.
export function bossForceCast(e, id){
  const a=(BOSS_ABILITIES[e.floorBoss]||[]).find(x=>x.id===id);
  if(!a) return false;
  _bossStartCast(e, a);
  return true;
}
export function bossResolveNow(e){ if(e.cast) _bossResolveCast(e); }
export function bossPickForTest(e){ const a=_bossPickAbility(e); return a?a.id:null; }
const BOSS_ENRAGE_HP = 0.25;        // below this: shorter tells, shorter cooldowns
function _bossEnraged(e){ return e.hp/e.maxHp < BOSS_ENRAGE_HP; }
function _bossPickAbility(e){
  const list=BOSS_ABILITIES[e.floorBoss]; if(!list) return null;
  const hpPct=e.hp/e.maxHp, cds=e._cd||(e._cd={});
  const d=Math.hypot(player.x-e.x, player.y-e.y);
  const ready=list.filter(a=>
    (a.belowHp===undefined || hpPct<=a.belowHp) && !(cds[a.id]>0) && d<=a.range);
  if(!ready.length) return null;
  return ready[Math.floor(Math.random()*ready.length)];   // vary the order
}
function _bossStartCast(e, a){
  const tell = a.tell * (_bossEnraged(e)?0.75:1);
  const c = { id:a.id, name:a.name, t:0, dur:tell, shape:a.shape };
  if(a.shape==='line'){
    c.x=e.x; c.y=e.y; c.len=a.len; c.w=a.w;
    c.ang=Math.atan2(player.y-e.y, player.x-e.x);        // locked at cast time
  } else {
    c.r=a.r;
    if(a.at==='self'){ c.x=e.x; c.y=e.y; c.follow=true; } // stays on the boss
    else { c.x=player.x; c.y=player.y; }                  // locked where you were
  }
  e.cast=c;
  floaters.push({ x:e.x, y:e.y-60, text:'⚠ '+a.name, life:Math.max(1.0, tell) });
}
function _bossResolveCast(e){
  const c=e.cast; e.cast=null;
  const a=(BOSS_ABILITIES[e.floorBoss]||[]).find(x=>x.id===c.id);
  if(!a) return;
  const cds=e._cd||(e._cd={});
  cds[a.id] = a.cd * (_bossEnraged(e)?0.6:1);
  if(a.summon){
    for(let i=0;i<a.summon.n;i++){
      const em=makeEnemy(a.summon.type, Math.floor(e.x/TILE), Math.floor(e.y/TILE));
      if(em){ em.state='aggro'; enemies.push(em); }
    }
    return;
  }
  let inside;
  if(c.shape==='circle'){
    const cx = c.follow ? e.x : c.x, cy = c.follow ? e.y : c.y;
    inside = Math.hypot(player.x-cx, player.y-cy) <= c.r;
  } else {
    const dx=player.x-c.x, dy=player.y-c.y;
    const along = dx*Math.cos(c.ang) + dy*Math.sin(c.ang);
    const perp  = -dx*Math.sin(c.ang) + dy*Math.cos(c.ang);
    inside = along>=0 && along<=c.len && Math.abs(perp)<=c.w/2;
  }
  if(player.dead) return;
  if(!inside){ floaters.push({ x:player.x, y:player.y-34, text:'dodged!', life:0.7 }); return; }
  damagePlayer(Math.round(e.damage*(a.dmg||1)), e);
  if(a.stun && player.stunTimer<=0){ player.stunTimer=a.stun; floaters.push({x:player.x,y:player.y-24,text:'STUNNED!',life:0.9}); }
  if(a.web && player.webTimer<=0){ player.webTimer=a.web; floaters.push({x:player.x,y:player.y-24,text:'BOUND!',life:0.9}); }
  if(a.poison && player.poisonTimer<=0){ player.poisonTimer=a.poison; player.poisonDmg=5; player.poisonTick=0;
    floaters.push({x:player.x,y:player.y-24,text:'PLAGUED!',life:0.9}); }
}

// ── updateEnemy ────────────────────────────────────────────────────
export function updateEnemy(e, dt) {
  if (e.state==='dead') { e.deadTimer+=dt; if(e.deadTimer>=3){e.state='respawning';e.respawnTimer=ENEMY_RESPAWN_DELAY;} return; }
  if (e.state==='respawning') {
    e.respawnTimer-=dt;
    if(e.respawnTimer<=0){e.x=e.spawnX;e.y=e.spawnY;e.hp=e.maxHp;e.iframes=0;e.attackTimer=e.attackCooldown;e.state='idle';e.wanderTimer=1+Math.random()*2;e.fleeing=false;e.piperPhase=0;}
    return;
  }
  if(e.stunTimer>0){
    e.stunTimer=Math.max(0,e.stunTimer-dt);
    // Stunning a boss mid-wind-up INTERRUPTS it. That's the counterplay: a
    // wrestling stun or Ground Slam spends the whole telegraph for free.
    if(e.cast){ floaters.push({x:e.x,y:e.y-60,text:'INTERRUPTED!',life:1.0}); e.cast=null; }
    return;
  }
  if(e.attackTimer>0) e.attackTimer-=dt;
  if(e.iframes>0) e.iframes-=dt;
  if(e.rangedTimer>0) e.rangedTimer-=dt;
  if(e.abilityTimer>0) e.abilityTimer-=dt;
  e.wanderTimer-=dt;
  const pdx=player.x-e.x, pdy=player.y-e.y, dist=Math.hypot(pdx,pdy);
  const playerVisible=!player.dead&&!skills.hiding.active&&!G.housePlacementMode;

  // ── Boss wind-up ──
  // Rooted while a telegraph is up: no chasing, no melee. The boss standing
  // stock still IS the tell, and it's what gives you the window to move.
  if(e.floorBoss){
    const cds=e._cd||(e._cd={});
    for(const k in cds) if(cds[k]>0) cds[k]=Math.max(0,cds[k]-dt);
    if(e.cast){
      e.cast.t+=dt;
      if(e.cast.t>=e.cast.dur) _bossResolveCast(e);
      return;
    }
    if(e.state==='aggro' && playerVisible){
      if(e._openDelay===undefined) e._openDelay=2.5;      // don't open with a nuke
      if(e._openDelay>0) e._openDelay-=dt;
      else {
        const a=_bossPickAbility(e);
        if(a){ _bossStartCast(e,a); return; }
      }
    }
  }

  if(e.type==='bandit'&&!e.fleeing&&e.hp/e.maxHp<0.3) e.fleeing=true;
  if(e.fleeing){
    if(dist<TILE*20){ const nx=e.x-(pdx/dist)*e.speed*1.3*dt; if(!boxBlocked(nx,e.y,e.r))e.x=nx; const ny=e.y-(pdy/dist)*e.speed*1.3*dt; if(!boxBlocked(e.x,ny,e.r))e.y=ny; }
    return;
  }

  if(playerVisible&&dist<=e.aggroRange) e.state='aggro';
  else if(skills.hiding.active) e.state='idle';
  else if(dist>e.aggroRange*1.6) e.state='idle';

  if(e.state==='aggro') {
    if(e.type==='wolf'&&e.abilityTimer<=0){
      e.abilityTimer=8;
      for(const o of enemies){ if(o!==e&&o.type==='wolf'&&o.state==='idle'&&Math.hypot(o.x-e.x,o.y-e.y)<TILE*8) o.state='aggro'; }
    }
    if(e.type==='bandit'&&dist>TILE*3&&dist<TILE*9&&e.rangedTimer<=0){
      e.rangedTimer=2.2; fireEnemyProj(e,8,340,'#886644',3);
    }
    if(e.type==='goblin'&&dist>TILE*2.5&&dist<TILE*7&&e.rangedTimer<=0){
      e.rangedTimer=2.8; fireEnemyProj(e,6,240,'#888878',4);
    }
    if(e.type==='ratman'&&dist>TILE*2&&dist<TILE*6&&e.rangedTimer<=0){
      e.rangedTimer=2.0; fireEnemyProj(e,9,320,'#b0a070',3);
    }
    if(e.type==='ratman_archer'&&dist>TILE*2.5&&dist<TILE*8&&e.rangedTimer<=0){
      e.rangedTimer=1.8; fireEnemyProj(e,10,360,'#a09070',3);
    }
    if(e.type==='ratman_wiz'){
      if(dist<TILE*3){ const nx=e.x-(pdx/dist)*e.speed*dt; if(!boxBlocked(nx,e.y,e.r))e.x=nx; const ny=e.y-(pdy/dist)*e.speed*dt; if(!boxBlocked(e.x,ny,e.r))e.y=ny; }
      else if(dist<TILE*6){ const nx=e.x+(pdx/dist)*e.speed*0.3*dt; if(!boxBlocked(nx,e.y,e.r))e.x=nx; const ny=e.y+(pdy/dist)*e.speed*0.3*dt; if(!boxBlocked(e.x,ny,e.r))e.y=ny; }
      if(dist<TILE*6&&e.rangedTimer<=0){ e.rangedTimer=2.0; fireEnemyProj(e,14,280,'#9040e0',5); }
      return;
    }
    if(e.type==='hellhound'&&dist<TILE*1.5&&e.abilityTimer<=0){
      e.abilityTimer=1.0; damagePlayer(4);
      floaters.push({ x:player.x, y:player.y-20, text:'🔥', life:0.9 });
    }
    if(e.type==='piper'){
      const hpPct=e.hp/e.maxHp;
      if(e.piperPhase===0&&hpPct<0.75){ e.piperPhase=1; _piperSummon(e,3); floaters.push({ x:e.x, y:e.y-50, text:'♪ PIPER CALLS ♪', life:0.9 }); }
      if(e.piperPhase===1&&hpPct<0.50){ e.piperPhase=2; _piperSummon(e,4); floaters.push({ x:e.x, y:e.y-50, text:'♪♪ PIPER CALLS ♪♪', life:0.9 }); }
      if(e.piperPhase===2&&hpPct<0.25){ e.piperPhase=3; _piperSummon(e,5); floaters.push({ x:e.x, y:e.y-50, text:'♪♪♪ ENRAGED ♪♪♪', life:0.9 }); }
      if(e.abilityTimer<=0){
        e.abilityTimer=14;
        if(!player.dead){
          const distToPlayer = Math.hypot(player.x - e.x, player.y - e.y);
          if (distToPlayer < TILE * 8) {
            player.isRat = true;
            player.ratTimer = 6.0;
            player.onHorse = false;
            floaters.push({ x:player.x, y:player.y-30, text:'🐀 RAT CURSE! 🐀', life:1.2 });
            snd.hurt();
          }
        }
      }
    }
    const keepDist=(e.type==='ratman_wiz'||e.type==='ratman_archer')?TILE*4:e.attackRange*0.8;
    if(dist>keepDist){ const nx=e.x+(pdx/dist)*e.speed*dt; if(!boxBlocked(nx,e.y,e.r))e.x=nx; const ny=e.y+(pdy/dist)*e.speed*dt; if(!boxBlocked(e.x,ny,e.r))e.y=ny; }
    if(dist<=e.attackRange&&e.attackTimer<=0){
      e.attackTimer=e.attackCooldown; damagePlayer(e.damage, e);
      if((e.type==='troll'||e.type==='troll_l')&&Math.random()<0.25&&player.stunTimer<=0){ player.stunTimer=1.5; floaters.push({ x:player.x, y:player.y-24, text:'STUNNED!', life:0.9 }); }
      if((e.type==='spider'||e.type==='spider_q')&&player.webTimer<=0){ player.webTimer=2.5; floaters.push({ x:player.x, y:player.y-24, text:'WEBBED!', life:0.9 }); }
      if(e.type==='silver_serp'&&player.poisonTimer<=0){ player.poisonTimer=5; player.poisonDmg=3; player.poisonTick=0; floaters.push({ x:player.x, y:player.y-24, text:'POISONED!', life:0.9 }); }
    }
  } else {
    if(e.wanderTimer<=0){e.wanderAngle=Math.random()*Math.PI*2;e.wanderTimer=2+Math.random()*2;}
    const ws=e.speed*0.38*dt;
    const nx=e.x+Math.cos(e.wanderAngle)*ws; if(!boxBlocked(nx,e.y,e.r))e.x=nx; else e.wanderTimer=0;
    const ny=e.y+Math.sin(e.wanderAngle)*ws; if(!boxBlocked(e.x,ny,e.r))e.y=ny; else e.wanderTimer=0;
  }
}

// ── Population management ──────────────────────────────────────────
export function spawnRandomEnemy(type, CITY) {
  for (let attempts=0;attempts<150;attempts++) {
    const tx=Math.floor(Math.random()*480), ty=Math.floor(Math.random()*480);
    const wx=tx*TILE+TILE/2, wy=ty*TILE+TILE/2;
    if (Math.hypot(wx-player.x,wy-player.y)<TILE*12) continue;
    if (CITY&&tx>=CITY.x1-5&&tx<=CITY.x2+5&&ty>=CITY.y1-5&&ty<=CITY.y2+5) continue;
    const e=makeEnemy(type,tx,ty);
    if (e) { enemies.push(e); return; }
  }
}

// ── Initial enemy population (runs on module import) ──────────────
export function populateWorld() {
  for (const [tx,ty] of WOLF_SPAWNS)   { const e=makeEnemy('wolf',  tx,ty); if(e) enemies.push(e); }
  for (const [tx,ty] of BANDIT_SPAWNS) { const e=makeEnemy('bandit',tx,ty); if(e) enemies.push(e); }
  for (const [cx,cy,w,h,type,count] of CAVE_MOBS) {
    for (let i=0;i<count;i++) {
      const tx=cx+4+Math.floor((w-8)*(i+0.5)/count);
      const ty=cy+Math.floor(h*0.35)+(i%2===0?0:Math.floor(h*0.3));
      const e=makeEnemy(type,tx,ty); if(e) enemies.push(e);
    }
  }
}

// ── Dungeon population (rat dungeon island) ────────────────────────
// The dungeon starts EMPTY. All rat-dungeon mobs are spawned by the
// champion altar (CHAMP_ALTARS idx 6) as staged waves: activating the
// altar spawns stage-1 mobs throughout the dungeon, and killing enough
// advances the stage (see champSpawnTick / champOnKill). Kept as an
// exported no-op kept for the boot sequence's call site.
export function populateDungeon() {}
