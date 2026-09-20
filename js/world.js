// world.js — map generation, resource system, NPC spawn data, champ altars
import { TILE, MAP_W, MAP_H, T, TREE_HP, STONE_HP, IRON_HP, RESPAWN_TREE, RESPAWN_STONE, RESPAWN_IRON,
  DUNGEON_X0, DUNGEON_Y0, DUNGEON_W, DUNGEON_H,
  COAST_X0, COAST_Y0, COAST_W, COAST_H, COAST_LANDING, COAST_MAINLAND_DOCK,
} from './constants.js';
import { map, resourceHp, respawnAt, origTile, playerPlacedWalls, enemies } from './state.js';

// ── Seeded RNG ─────────────────────────────────────────────────────
function makeRng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
export { makeRng };

// ── Dungeon floors ─────────────────────────────────────────────────
// Floor 1 is the hand-authored sunken lake (carved further below at
// DUNGEON_X0/Y0). Floors 2-5 are generated room-and-corridor caves packed
// into the free space either side of it in the y490+ band, which the
// overworld never uses. Each is 64x64 like floor 1.
// `DUNGEON_STAIRS` maps "tx,ty" -> {to, sx, sy}: step on that tile and you
// arrive on floor `to` at tile (sx,sy). Built during generation.
export const DUNGEON_FLOORS = [
  { n:1, x0:DUNGEON_X0, y0:DUNGEON_Y0, name:'The Sunken Warren' },
  { n:2, x0:280,        y0:DUNGEON_Y0, name:'Gnawed Tunnels' },
  { n:3, x0:352,        y0:DUNGEON_Y0, name:'The Ossuary',       boss:'gravebinder' },
  { n:4, x0:8,          y0:DUNGEON_Y0, name:'The Fungal Deep' },
  { n:5, x0:80,         y0:DUNGEON_Y0, name:"Molloch's Throne",  boss:'molloch' },
];
export const DUNGEON_STAIRS = {};
export const DUNGEON_BOSS_SPAWNS = [];
// Pre-placed treasure containers. Positions are map features (deterministic
// from the world seed), so only the "already looted" flags go in the save.
// `tier` drives the loot table — deeper floors and boss arenas roll richer.
export const WORLD_CHESTS = [];
export function floorAt(tx,ty){
  for(const f of DUNGEON_FLOORS)
    if(tx>=f.x0&&tx<f.x0+DUNGEON_W&&ty>=f.y0&&ty<f.y0+DUNGEON_H) return f;
  return null;
}

// ── Initialise flat map array ──────────────────────────────────────
for (let y = 0; y < MAP_H; y++) {
  map[y] = [];
  for (let x = 0; x < MAP_W; x++) map[y][x] = T.GRASS;
}

// ── Map generation ──────────────────────────────────────────────────
(function(){
  const rng = makeRng(7);

  // 3 winding rivers (west→east) — overworld only
  for (const riverY of [80, 200, 360]) {
    for (let x = 0; x < MAP_W; x++) {
      const cy = Math.round(riverY + Math.sin(x * 0.08 + riverY * 0.01) * 9);
      for (let dy = -1; dy <= 1; dy++) {
        const y = cy + dy;
        if (y >= 0 && y < 480) map[y][x] = T.WATER;
      }
    }
  }

  // Main north-south path with bridges
  for (let y = 0; y < 480; y++) {
    const cx = Math.round(240 + Math.sin(y * 0.06) * 8);
    if (cx < 0 || cx >= MAP_W) continue;
    if (map[y][cx] === T.WATER) map[y][cx] = T.BRIDGE; else map[y][cx] = T.PATH;
    if (cx + 1 < MAP_W) {
      if (map[y][cx+1] === T.WATER) map[y][cx+1] = T.BRIDGE; else map[y][cx+1] = T.PATH;
    }
  }
  // East-west path
  for (let x = 0; x < MAP_W; x++) {
    const cy = Math.round(300 + Math.sin(x * 0.05) * 6);
    if (cy < 0 || cy >= 480) continue;
    if (map[cy][x] !== T.WATER && map[cy][x] !== T.PATH) map[cy][x] = T.PATH;
  }

  // Extra bridge crossings
  for (const bridgeX of [120, 240, 360]) {
    for (let y = 0; y < 480; y++)
      if (map[y][bridgeX] === T.WATER) map[y][bridgeX] = T.BRIDGE;
  }

  // Ruins
  for (const [rx, ry] of [[80,60],[380,100],[160,390]]) {
    for (let y = ry; y < ry+5; y++)
      for (let x = rx; x < rx+6; x++) {
        if (x<0||y<0||x>=MAP_W||y>=480) continue;
        const edge = (y===ry||y===ry+4||x===rx||x===rx+5);
        if (edge && rng()<0.8) map[y][x] = T.STONE;
      }
  }

  // Tree groves
  for (let i = 0; i < 160; i++) {
    const cx=Math.floor(rng()*MAP_W), cy=Math.floor(rng()*480), r=2+Math.floor(rng()*4);
    for (let dy=-r;dy<=r;dy++) for (let dx=-r;dx<=r;dx++) {
      const tx=cx+dx, ty=cy+dy;
      if (tx<0||ty<0||tx>=MAP_W||ty>=480) continue;
      if (map[ty][tx]!==T.GRASS) continue;
      if (rng()<0.72) map[ty][tx]=T.TREE;
    }
  }

  // Stone outcrops
  for (let i = 0; i < 80; i++) {
    const cx=Math.floor(rng()*MAP_W), cy=Math.floor(rng()*480), r=1+Math.floor(rng()*2);
    for (let dy=-r;dy<=r;dy++) for (let dx=-r;dx<=r;dx++) {
      const tx=cx+dx, ty=cy+dy;
      if (tx<0||ty<0||tx>=MAP_W||ty>=480) continue;
      if (map[ty][tx]!==T.GRASS) continue;
      if (rng()<0.65) map[ty][tx]=T.STONE;
    }
  }

  // ── Lunar City ────────────────────────────────────────────────────
  // Outer wall: x=280-340, y=332-392 (61×61).  Center: (310,362)
  // Inner wall: x=296-324, y=348-376 (29×29), interior x=298-322 y=350-374
  {
    const OX1=280,OX2=340,OY1=332,OY2=392;
    const IX1=296,IX2=324,IY1=348,IY2=376;
    const CX=310,CY=362;

    // Clear entire city footprint to GRASS (overwrites river/trees/stones)
    for(let y=OY1;y<=OY2;y++) for(let x=OX1;x<=OX2;x++) map[y][x]=T.GRASS;

    // Outer wall perimeter
    for(let x=OX1;x<=OX2;x++){ map[OY1][x]=T.WALL; map[OY2][x]=T.WALL; }
    for(let y=OY1;y<=OY2;y++){ map[y][OX1]=T.WALL; map[y][OX2]=T.WALL; }

    // Corner towers: 3×3 solid blocks at each corner
    for(let dy=0;dy<3;dy++) for(let dx=0;dx<3;dx++){
      map[OY1+dy][OX1+dx]=T.WALL; map[OY1+dy][OX2-dx]=T.WALL;
      map[OY2-dy][OX1+dx]=T.WALL; map[OY2-dy][OX2-dx]=T.WALL;
    }

    // Outer gates — 3-tile openings centered on each wall mid-point
    for(let x=CX-1;x<=CX+1;x++){ map[OY1][x]=T.PATH; map[OY2][x]=T.PATH; }
    for(let y=CY-1;y<=CY+1;y++){ map[y][OX1]=T.PATH; map[y][OX2]=T.PATH; }

    // Ring road — rectangular loop 4 tiles inside outer wall
    const RX1=OX1+4,RX2=OX2-4,RY1=OY1+4,RY2=OY2-4;
    for(let x=RX1;x<=RX2;x++){ map[RY1][x]=T.PATH; map[RY2][x]=T.PATH; }
    for(let y=RY1;y<=RY2;y++){ map[y][RX1]=T.PATH; map[y][RX2]=T.PATH; }

    // Spurs: outer gates → ring road
    for(let x=CX-1;x<=CX+1;x++) for(let y=OY1+1;y<=RY1;y++) map[y][x]=T.PATH;  // N
    for(let x=CX-1;x<=CX+1;x++) for(let y=RY2;y<=OY2-1;y++) map[y][x]=T.PATH;  // S
    for(let x=OX1+1;x<=RX1;x++) for(let y=CY-1;y<=CY+1;y++) map[y][x]=T.PATH;  // W
    for(let x=RX2;x<=OX2-1;x++) for(let y=CY-1;y<=CY+1;y++) map[y][x]=T.PATH;  // E

    // Spurs: ring road → inner wall entrances (horizontal at y=CY=362)
    for(let x=RX1;x<=IX1;x++) map[CY][x]=T.PATH;  // W inner spur
    for(let x=IX2;x<=RX2;x++) map[CY][x]=T.PATH;  // E inner spur

    // NPC houses in residential ring (5×5 each: WALL border, PATH interior, 1 door gap)
    function buildHouse(x1,y1,doorSide,doorOff){
      for(let dy=0;dy<5;dy++) for(let dx=0;dx<5;dx++){
        const tx=x1+dx,ty=y1+dy;
        map[ty][tx]=(dy===0||dy===4||dx===0||dx===4)?T.WALL:T.PATH;
      }
      if(doorSide==='n') map[y1   ][x1+doorOff]=T.PATH;
      if(doorSide==='s') map[y1+4 ][x1+doorOff]=T.PATH;
      if(doorSide==='w') map[y1+doorOff][x1   ]=T.PATH;
      if(doorSide==='e') map[y1+doorOff][x1+4 ]=T.PATH;
    }

    buildHouse(308,339,'s',2);  // Healer — north center, door south (y=343,x=310)
    buildHouse(285,343,'e',2);  // Merchant — W side north, door east (y=345,x=289)
    buildHouse(285,377,'e',2);  // Mage — W side south, door east (y=379,x=289)
    buildHouse(331,343,'w',2);  // Blacksmith — E side north, door west (y=345,x=331)
    buildHouse(331,377,'w',2);  // Farrier — E side south, door west (y=379,x=331)

    // Inner wall — 29×29, 2-tile thick
    for(let y=IY1;y<=IY2;y++) for(let x=IX1;x<=IX2;x++) map[y][x]=T.WALL;
    // Carve interior
    for(let y=IY1+2;y<=IY2-2;y++) for(let x=IX1+2;x<=IX2-2;x++) map[y][x]=T.PATH;
    // W entrance (y=361-363)
    for(let y=CY-1;y<=CY+1;y++){ map[y][IX1]=T.PATH; map[y][IX1+1]=T.PATH; }
    // E entrance (y=361-363)
    for(let y=CY-1;y<=CY+1;y++){ map[y][IX2-1]=T.PATH; map[y][IX2]=T.PATH; }

    // Bank building — 9×7, center of courtyard
    const BX1=306,BX2=314,BY1=359,BY2=365;
    for(let y=BY1;y<=BY2;y++) for(let x=BX1;x<=BX2;x++) map[y][x]=T.WALL;
    for(let y=BY1+1;y<=BY2-1;y++) for(let x=BX1+1;x<=BX2-1;x++) map[y][x]=T.PATH;
    map[BY2][CX-1]=T.PATH; map[BY2][CX]=T.PATH; map[BY2][CX+1]=T.PATH;  // S doors
    map[BY1][CX]=T.PATH;                                                   // N door

    // 4 corner shops — 5×5 each, door faces the bank
    buildHouse(299,351,'s',2);  // NW — door south (x=301,y=355)
    buildHouse(317,351,'s',2);  // NE — door south (x=319,y=355)
    buildHouse(299,369,'n',2);  // SW — door north (x=301,y=369)
    buildHouse(317,369,'n',2);  // SE — door north (x=319,y=369)
  }

  // Cave generator (cellular automata)
  function generateCave(cx, cy, w, h) {
    for (let y=cy;y<cy+h;y++) for (let x=cx;x<cx+w;x++) {
      if (x<=cx||y<=cy||x>=cx+w-1||y>=cy+h-1) { map[y][x]=T.CAVE_WALL; continue; }
      if (map[y][x]===T.WATER||map[y][x]===T.PATH||map[y][x]===T.BRIDGE) continue;
      map[y][x]=rng()<0.44?T.CAVE_WALL:T.CAVE_FLOOR;
    }
    for (let pass=0;pass<4;pass++) {
      const snap=[];
      for (let y=cy;y<cy+h;y++) {
        snap[y-cy]=[];
        for (let x=cx;x<cx+w;x++) snap[y-cy][x-cx]=map[y][x];
      }
      for (let dy=1;dy<h-1;dy++) for (let dx=1;dx<w-1;dx++) {
        let walls=0;
        for (let ny=-1;ny<=1;ny++) for (let nx=-1;nx<=1;nx++) {
          const s=snap[dy+ny]&&snap[dy+ny][dx+nx];
          if (s===T.CAVE_WALL||s===T.WATER||s===undefined) walls++;
        }
        map[cy+dy][cx+dx]=walls>=5?T.CAVE_WALL:T.CAVE_FLOOR;
      }
    }
    for (let y=cy;y<cy+h;y++) { map[y][cx]=T.CAVE_WALL; map[y][cx+w-1]=T.CAVE_WALL; }
    for (let x=cx;x<cx+w;x++) { map[cy][x]=T.CAVE_WALL; map[cy+h-1][x]=T.CAVE_WALL; }
    const ex=cx+Math.floor(w/2);
    if (ex>=0&&ex<MAP_W) {
      if (cy-1>=0) {
        map[cy-1][ex]=T.CAVE_ENTRANCE;
        if (cy-2>=0) {
          for (let ddx=-1;ddx<=1;ddx++) {
            const nx=ex+ddx;
            if (nx>=0&&nx<MAP_W&&(map[cy-2][nx]===T.TREE||map[cy-2][nx]===T.STONE))
              map[cy-2][nx]=T.GRASS;
          }
        }
      }
      if (cy>=0&&cy<MAP_H) map[cy][ex]=T.CAVE_FLOOR;
      for (let depth=0;depth<=4;depth++) {
        for (let ddx=-1;ddx<=1;ddx++) {
          const nx=ex+ddx, ny=cy+depth;
          if (nx>cx&&nx<cx+w-1&&ny<cy+h-1&&ny>=0&&ny<MAP_H&&nx>=0&&nx<MAP_W)
            map[ny][nx]=T.CAVE_FLOOR;
        }
      }
    }
  }

  // 6 standard caves (no Rat Dungeon cave here — it's a separate map zone below)
  for (const [cx,cy,w,h] of [
    [60,140,42,36],[200,50,40,38],[390,100,44,36],
    [100,310,38,40],[360,250,46,35],[420,390,40,38],
  ]) generateCave(cx,cy,w,h);

  // Walkable entry corridors guarantee
  for (let y=0;y<480;y++) {
    for (let x=0;x<MAP_W;x++) {
      if (map[y][x]!==T.CAVE_ENTRANCE) continue;
      for (let dy=1;dy<=3;dy++) {
        if (y+dy<480&&map[y+dy][x]===T.CAVE_WALL) map[y+dy][x]=T.CAVE_FLOOR;
      }
    }
  }

  // ── Helper: draw L-shaped path overwriting grass/trees/stones ──
  function makePath(x1,y1,x2,y2) {
    const sx=x1<x2?1:-1, sy=y1<y2?1:-1;
    for (let x=x1; x!==x2; x+=sx) {
      if (x>=0&&x<MAP_W&&y1>=0&&y1<480) {
        const t=map[y1][x];
        if (t===T.GRASS||t===T.TREE||t===T.STONE) map[y1][x]=T.PATH;
      }
    }
    for (let y=y1; y!==y2+sy; y+=sy) {
      if (x2>=0&&x2<MAP_W&&y>=0&&y<480) {
        const t=map[y][x2];
        if (t===T.GRASS||t===T.TREE||t===T.STONE) map[y][x2]=T.PATH;
      }
    }
  }

  // ── Dungeon Entrance A — main road portal, south of y=200 river ──
  // Located at tile (190, 232): accessible from the north-south main path
  // Small cave mouth: 5-wide CAVE_FLOOR strip + CAVE_WALL back wall + TELEPORT
  const EA_X = 190, EA_Y = 232;
  for (let x=EA_X-2;x<=EA_X+2;x++) {
    map[EA_Y-1][x] = T.CAVE_FLOOR;
    map[EA_Y][x]   = T.CAVE_FLOOR;
    map[EA_Y+1][x] = T.CAVE_WALL;
  }
  map[EA_Y-1][EA_X] = T.TELEPORT;   // portal tile (enter dungeon)
  // Clear any trees/stones near entrance
  for (let dy=-3;dy<=3;dy++) for (let dx=-3;dx<=3;dx++) {
    const tx=EA_X+dx, ty=EA_Y-2+dy;
    if (tx>=0&&tx<MAP_W&&ty>=0&&ty<480&&(map[ty][tx]===T.TREE||map[ty][tx]===T.STONE))
      map[ty][tx]=T.GRASS;
  }
  // Path from main path (x≈240) west to entrance
  makePath(238, EA_Y-1, EA_X+3, EA_Y-1);

  // ── Dungeon Entrance B — inside cave at (60,140,42,36), sparkly ──
  // Place TELEPORT inside the first cave's floor (center of cave)
  const EB_X = 81, EB_Y = 162;
  map[EB_Y][EB_X] = T.TELEPORT;

  // ── Separator strip (rows 480–489): solid CAVE_WALL ──────────────
  for (let y=480;y<490;y++)
    for (let x=0;x<MAP_W;x++)
      map[y][x]=T.CAVE_WALL;

  // ── Dungeon interior (64×64, starts at DUNGEON_X0, DUNGEON_Y0) ──
  const dx0=DUNGEON_X0, dy0=DUNGEON_Y0;

  // Fill dungeon bounding box with CAVE_WALL
  for (let y=dy0;y<dy0+DUNGEON_H;y++)
    for (let x=dx0;x<dx0+DUNGEON_W;x++)
      map[y][x]=T.CAVE_WALL;

  // Flood interior with WATER (the subterranean lake)
  for (let y=dy0+1;y<dy0+DUNGEON_H-1;y++)
    for (let x=dx0+1;x<dx0+DUNGEON_W-1;x++)
      map[y][x]=T.WATER;

  // Kidney-bean island: two overlapping ellipses
  // Main body: center (dx0+32, dy0+36), rx=14, ry=12
  // Upper lobe: center (dx0+37, dy0+24), rx=10, ry=9
  const rngD = makeRng(42);
  for (let y=dy0+1;y<dy0+DUNGEON_H-1;y++) {
    for (let x=dx0+1;x<dx0+DUNGEON_W-1;x++) {
      const d1=((x-(dx0+32))/14)**2+((y-(dy0+36))/12)**2;
      const d2=((x-(dx0+37))/10)**2+((y-(dy0+24))/9)**2;
      if (d1<=1.0||d2<=1.0) map[y][x]=T.CAVE_FLOOR;
    }
  }

  // Erode island edges for organic, uneven shoreline
  for (let y=dy0+1;y<dy0+DUNGEON_H-1;y++) {
    for (let x=dx0+1;x<dx0+DUNGEON_W-1;x++) {
      if (map[y][x]!==T.CAVE_FLOOR) continue;
      let adj=0;
      for (let ny=-1;ny<=1;ny++) for (let nx=-1;nx<=1;nx++)
        if (map[y+ny]?.[x+nx]===T.WATER) adj++;
      if (adj>=3&&rngD()<0.35) map[y][x]=T.WATER;
    }
  }
  // Small stalagmites poking from water near shore
  for (let y=dy0+1;y<dy0+DUNGEON_H-1;y++) {
    for (let x=dx0+1;x<dx0+DUNGEON_W-1;x++) {
      if (map[y][x]!==T.WATER) continue;
      let adjFloor=0;
      for (let ny=-1;ny<=1;ny++) for (let nx=-1;nx<=1;nx++)
        if (map[y+ny]?.[x+nx]===T.CAVE_FLOOR) adjFloor++;
      if (adjFloor>=2&&rngD()<0.08) map[y][x]=T.STONE;
    }
  }

  // West land bridge (5 tiles wide): x from dx0+1 to dx0+19, centred on BY=dy0+36
  const BY = dy0+36;
  for (let x=dx0+1;x<=dx0+19;x++) {
    for (let dy2=-2;dy2<=2;dy2++) {
      const by=BY+dy2;
      if (map[by]?.[x]!==undefined) map[by][x]=T.CAVE_FLOOR;
    }
  }
  // Entry gap in west wall
  for (let dy2=-2;dy2<=2;dy2++) map[BY+dy2][dx0]=T.CAVE_ENTRANCE;
  // Reinforce bridge centre lane
  for (let x=dx0+1;x<=dx0+22;x++) map[BY][x]=T.CAVE_FLOOR;

  // Central 3x3 altar platform — passable CAVE_FLOOR (stone-look drawn by drawChampAltar)
  // x=31..33 centres on DX=DUNGEON_X0+32
  for (let y=dy0+28;y<=dy0+30;y++)
    for (let x=dx0+31;x<=dx0+33;x++)
      if (map[y][x]===T.STONE) map[y][x]=T.CAVE_FLOOR;

  // Rock pillar clusters (5 formations around island)
  const pillars = [
    [dx0+22, dy0+22], [dx0+44, dy0+24], [dx0+19, dy0+40],
    [dx0+45, dy0+40], [dx0+34, dy0+48],
  ];
  for (const [px,py] of pillars) {
    for (let dy2=-1;dy2<=1;dy2++) for (let dx2=-1;dx2<=1;dx2++) {
      const tx=px+dx2, ty=py+dy2;
      if (map[ty]?.[tx]===T.CAVE_FLOOR&&rngD()<0.72) map[ty][tx]=T.STONE;
    }
    if (map[py]?.[px]) map[py][px]=T.STONE;
  }

  // Ensure altar footprint is always clear of blocking stones
  for (let cy2=dy0+26;cy2<=dy0+32;cy2++)
    for (let cx2=dx0+29;cx2<=dx0+35;cx2++)
      if (map[cy2]?.[cx2]===T.STONE) map[cy2][cx2]=T.CAVE_FLOOR;

  // ── North cave (champ stage 1–2 zone) ──────────────────────────
  // Rectangular room across the top of the dungeon zone
  const NC_Y1=dy0+1, NC_Y2=dy0+11;
  const NC_X1=dx0+12, NC_X2=dx0+52;
  for (let y=NC_Y1; y<=NC_Y2; y++)
    for (let x=NC_X1; x<=NC_X2; x++)
      map[y][x] = (y===NC_Y1||y===NC_Y2||x===NC_X1||x===NC_X2) ? T.CAVE_WALL : T.CAVE_FLOOR;
  // North bridge (5 tiles wide, centred x=dx0+32), from cave south wall down to island
  for (let nb=NC_Y2; nb<=dy0+17; nb++)
    for (let bx=dx0+30; bx<=dx0+34; bx++)
      if (map[nb]?.[bx]!==undefined) map[nb][bx]=T.CAVE_FLOOR;

  // ── South cave (champ stage 3–4 zone / city exit) ────────────────
  const SC_Y1=dy0+52, SC_Y2=dy0+62;
  const SC_X1=dx0+12, SC_X2=dx0+52;
  for (let y=SC_Y1; y<=SC_Y2; y++)
    for (let x=SC_X1; x<=SC_X2; x++)
      map[y][x] = (y===SC_Y1||y===SC_Y2||x===SC_X1||x===SC_X2) ? T.CAVE_WALL : T.CAVE_FLOOR;
  // South bridge (5 tiles wide), from island down to cave north wall
  for (let sb=dy0+47; sb<=SC_Y1; sb++)
    for (let bx=dx0+30; bx<=dx0+34; bx++)
      if (map[sb]?.[bx]!==undefined) map[sb][bx]=T.CAVE_FLOOR;

  // ── TELEPORT tiles ───────────────────────────────────────────────
  // Overworld return: near the west wall of the entry bridge (player arrives at dx0+14)
  map[BY][dx0+3]       = T.TELEPORT;
  // City exit: inside the south cave
  map[dy0+57][dx0+38]  = T.TELEPORT;

  // ── Spawn Iron Ore inside standard caves ──
  const rngIron = makeRng(88);
  const caveSpecs = [
    [60,140,42,36],[200,50,40,38],[390,100,44,36],
    [100,310,38,40],[360,250,46,35],[420,390,40,38],
  ];
  for (const [cx, cy, w, h] of caveSpecs) {
    for (let y = cy + 1; y < cy + h - 1; y++) {
      for (let x = cx + 1; x < cx + w - 1; x++) {
        if (map[y][x] === T.CAVE_FLOOR) {
          let nearWall = false;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (map[y+dy]?.[x+dx] === T.CAVE_WALL) nearWall = true;
            }
          }
          if (nearWall && rngIron() < 0.14) {
            map[y][x] = T.ORE_IRON;
          }
        }
      }
    }
  }

  // ── Deep dungeon floors 2-5 ────────────────────────────────────────
  // Room-and-corridor (not cellular automata): rooms are carved in a west→east
  // chain and each is corridor-linked to the previous one, so every floor is
  // guaranteed traversable from its up-stair to its down-stair.
  const floorGeom = {};
  for (const f of DUNGEON_FLOORS) {
    if (f.n === 1) continue;                       // floor 1 is the hand-authored lake above
    const rngF = makeRng(1000 + f.n * 77);
    const X0=f.x0, Y0=f.y0, W=DUNGEON_W, H=DUNGEON_H;
    for (let y=Y0;y<Y0+H;y++) for (let x=X0;x<X0+W;x++) map[y][x]=T.CAVE_WALL;
    const inBounds=(x,y)=>x>X0&&x<X0+W-1&&y>Y0&&y<Y0+H-1;
    const carveRoom=(cx,cy,rw,rh)=>{
      for(let y=cy-(rh>>1);y<=cy+(rh>>1);y++)
        for(let x=cx-(rw>>1);x<=cx+(rw>>1);x++)
          if(inBounds(x,y)) map[y][x]=T.CAVE_FLOOR;
    };
    const carveCorridor=(ax,ay,bx,by)=>{           // L-shaped, 3 tiles wide
      for(let x=Math.min(ax,bx);x<=Math.max(ax,bx);x++)
        for(let d=-1;d<=1;d++) if(inBounds(x,ay+d)) map[ay+d][x]=T.CAVE_FLOOR;
      for(let y=Math.min(ay,by);y<=Math.max(ay,by);y++)
        for(let d=-1;d<=1;d++) if(inBounds(bx+d,y)) map[y][bx+d]=T.CAVE_FLOOR;
    };
    const ROOMS=7, rooms=[];
    for(let i=0;i<ROOMS;i++){
      const last=i===ROOMS-1;
      // boss floors end in a big arena
      const rw = last&&f.boss ? 17 : 6+Math.floor(rngF()*7);
      const rh = last&&f.boss ? 15 : 5+Math.floor(rngF()*6);
      const t  = i/(ROOMS-1);
      const cx = Math.round(X0+8+t*(W-18)+(rngF()-0.5)*5);
      const cy = Math.round(Y0+10+rngF()*(H-24));
      rooms.push({cx,cy});
      carveRoom(cx,cy,rw,rh);
    }
    for(let i=1;i<rooms.length;i++) carveCorridor(rooms[i-1].cx,rooms[i-1].cy,rooms[i].cx,rooms[i].cy);
    // scatter mineable veins along the rock faces
    for(let y=Y0+1;y<Y0+H-1;y++) for(let x=X0+1;x<X0+W-1;x++){
      if(map[y][x]!==T.CAVE_FLOOR) continue;
      let nearWall=false;
      for(let dy=-1;dy<=1;dy++) for(let dx=-1;dx<=1;dx++) if(map[y+dy]?.[x+dx]===T.CAVE_WALL) nearWall=true;
      if(nearWall&&rngF()<0.10) map[y][x]= rngF()<0.55 ? T.STONE : T.ORE_IRON;
    }
    const up={x:rooms[0].cx, y:rooms[0].cy};
    const down={x:rooms[ROOMS-1].cx, y:rooms[ROOMS-1].cy};
    // boss arenas have no down-stair until the boss is dealt with narratively;
    // the last floor has none at all.
    floorGeom[f.n]={up,down,arena:f.boss?down:null};
    map[up.y][up.x]=T.TELEPORT;
    if(f.n<DUNGEON_FLOORS.length){
      // keep the down-stair clear of the arena centre so the boss can't block it
      const dY = f.boss ? down.y+5 : down.y;
      if(inBounds(down.x,dY)){ map[dY][down.x]=T.TELEPORT; floorGeom[f.n].down={x:down.x,y:dY}; }
      else map[down.y][down.x]=T.TELEPORT;
    }
    // Treasure: one chest tucked into the corner of a few mid-chain rooms
    // (never the entry room), plus a guaranteed hoard in a boss arena.
    // Boss floors reserve the arena (last room) for the hoard, so a plain
    // chest can't spawn on top of it.
    const lastPickable = f.boss ? ROOMS-2 : ROOMS-1;
    const taken=new Set();
    for(let c=0;c<2+f.n;c++){
      const ri=1+Math.floor(rngF()*lastPickable);
      if(taken.has(ri))continue; taken.add(ri);
      const r=rooms[ri];
      const cx=r.cx+(rngF()<0.5?-2:2), cy=r.cy+(rngF()<0.5?-1:1);
      if(map[cy]?.[cx]===T.CAVE_FLOOR) WORLD_CHESTS.push({x:cx,y:cy,floor:f.n,tier:f.n});
    }
    if(f.boss) WORLD_CHESTS.push({x:down.x-3,y:down.y,floor:f.n,tier:f.n+2,hoard:true});
  }
  // Floor 1 treasure — scan its caves for genuinely walkable tiles rather than
  // hardcoding spots, so a tweak to the hand-authored layout can't strand a chest.
  {
    const rngC=makeRng(9182), cands=[];
    for(let y=DUNGEON_Y0+2;y<DUNGEON_Y0+DUNGEON_H-2;y++)
      for(let x=DUNGEON_X0+2;x<DUNGEON_X0+DUNGEON_W-2;x++)
        if(map[y][x]===T.CAVE_FLOOR) cands.push([x,y]);
    for(let c=0;c<3&&cands.length;c++){
      const [x,y]=cands.splice(Math.floor(rngC()*cands.length),1)[0];
      WORLD_CHESTS.push({x,y,floor:1,tier:1});
    }
  }
  // Floor 1's descent: a stair in the south cave, clear of the city exit.
  const F1_DOWN={x:DUNGEON_X0+26, y:DUNGEON_Y0+57};
  map[F1_DOWN.y][F1_DOWN.x]=T.TELEPORT;
  floorGeom[1]={up:null, down:F1_DOWN};

  // Wire both directions. Arriving lands one tile east of the target stair so
  // you never spawn on top of a portal tile.
  const spawnBeside=(p)=>({sx:p.x+1, sy:p.y});
  for(const f of DUNGEON_FLOORS){
    const g=floorGeom[f.n]; if(!g) continue;
    const next=DUNGEON_FLOORS.find(o=>o.n===f.n+1);
    const prev=DUNGEON_FLOORS.find(o=>o.n===f.n-1);
    if(next&&g.down&&floorGeom[next.n]?.up)
      DUNGEON_STAIRS[g.down.x+','+g.down.y]={to:next.n, ...spawnBeside(floorGeom[next.n].up)};
    if(prev&&g.up&&floorGeom[prev.n]?.down)
      DUNGEON_STAIRS[g.up.x+','+g.up.y]={to:prev.n, ...spawnBeside(floorGeom[prev.n].down)};
  }
  // Make every arrival tile walkable.
  for(const k in DUNGEON_STAIRS){
    const s=DUNGEON_STAIRS[k];
    if(map[s.sy]?.[s.sx]!==undefined&&map[s.sy][s.sx]!==T.CAVE_FLOOR) map[s.sy][s.sx]=T.CAVE_FLOOR;
  }
  // Boss arena centres, for spawning floor bosses on entry.
  for(const f of DUNGEON_FLOORS){
    if(!f.boss) continue;
    const g=floorGeom[f.n];
    DUNGEON_BOSS_SPAWNS.push({floor:f.n, boss:f.boss, x:g.arena.x, y:g.arena.y});
  }

})();

// Saltmere's mobs and its people -------------------------------------
// Both are filled by generateCoast below, which is the only thing that knows
// where the shoreline ended up — COAST_VILLAGE.y is derived from shore(), so
// nothing here can be a literal without going stale the moment the coast is
// regenerated.
export const COAST_MOBS = [];      // [tx, ty, type]
// Saltmere's safe ground — the ONLY safe zone on the coast. Filled by
// generateCoast from the village it actually placed, in TILE coordinates, and
// exported into world-data.json so the server enforces the same rectangle the
// client draws.
export const COAST_SAFE_ZONE = { x1: 0, y1: 0, x2: 0, y2: 0 };

// ── The Saltmere gate ───────────────────────────────────────────────
// A standing arch in Lunar City that opens onto the coast, and its twin in
// Saltmere village. The ferry is the scenic route; this is the one you use when
// you already know where you are going.
//
// Keyed by "tx,ty" and checked BEFORE the dungeon branch in the TELEPORT
// handler — a bare TELEPORT tile in the city would otherwise drop you into the
// dungeon, because that branch only asks whether you are currently underground.
export const COAST_PORTALS = {};
export const CITY_COAST_GATE = { x: 288, y: 384 };
export const COAST_NPCS = [];      // { id, x, y, style, prop, label }

// The Saltmere gate, city end ----------------------------------------
// Inside the outer wall, in the open south-west of the courtyard, clear of the
// inner keep. A small paved plaza so the arch is obviously a thing rather than
// a tile that happens to be a different colour.
(function buildCityGate(){
  const g = CITY_COAST_GATE;
  for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
    const x = g.x + dx, y = g.y + dy;
    if (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) continue;
    if (map[y][x] === T.WALL || map[y][x] === T.STAINED_GLASS) continue;   // never carve the city wall
    map[y][x] = T.PATH;
  }
  map[g.y][g.x] = T.TELEPORT;
})();

// The mainland ferry jetty -------------------------------------------
// The Saltmere end of the crossing is the long pier the coast generator lays
// down; this is the other end, on the south bank of the y=360 river.
//
// ⚠ BUILT FROM DOCK TILES ALL THE WAY TO THE BANK, INCLUDING THE APPROACH, AND
// THAT IS DELIBERATE. game3d.js widens every river by 3 tiles AFTER this module
// has run, and the widener floods GRASS and PATH. A jetty with a path approach
// would have had its approach turn into river, leaving the ferryman standing on
// an island. DOCK is not in the floodable set, so the whole structure survives.
export const FERRY_MAINLAND = { x: COAST_MAINLAND_DOCK.x, y: COAST_MAINLAND_DOCK.y };
(function buildMainlandJetty(){
  const jx = COAST_MAINLAND_DOCK.x;
  // Run north from the standing point toward the river; the widened bank ends
  // up around y 364, so this reaches the water once the widener has run.
  for (let jy = COAST_MAINLAND_DOCK.y; jy >= 364; jy--) {
    if (jy < 0 || jy >= MAP_H) continue;
    const t = map[jy][jx];
    if (t === T.WALL || t === T.CAVE_WALL) break;
    map[jy][jx] = T.DOCK;
    if (jx + 1 < MAP_W && map[jy][jx+1] !== T.WALL) map[jy][jx+1] = T.DOCK;   // two planks wide
  }
  // A little cleared apron on the land side so you can walk onto it.
  for (let dy = 0; dy <= 2; dy++) for (let dx = -2; dx <= 3; dx++) {
    const x = jx + dx, y = COAST_MAINLAND_DOCK.y + dy;
    if (x < 0 || y < 0 || x >= MAP_W || y >= MAP_H) continue;
    if (map[y][x] === T.TREE || map[y][x] === T.STONE) map[y][x] = T.PATH;
  }
})();

// The Saltmere coast ------------------------------------------------
// The second surface region. Generated exactly like the dungeon floors -- into
// the same tile array, in its own band, from its own fixed seed -- so nothing
// in the engine has to learn about "maps". What IS new is that it brings its
// own ground texture rather than extending the shared one; see TERRAIN_MAP_H in
// constants.js for why that was worth splitting.
//
// Layout: sea to the south-west, land to the north-east, with the coastline
// running as a noisy diagonal so no stretch of it reads as a straight edge.
//
//   deep WATER | SHALLOWS | SAND | grass/TREE inland | CLIFF ridge
//
// Saltmere village sits on the middle of the beach with piers out over the
// shallows. The boat from the mainland ties up at the head of the long pier.
// ⚠ y IS DERIVED FROM THE SHORELINE, NOT WRITTEN DOWN. The first version
// hard-coded `COAST_Y0 + 78` while the coastline is a function of x, and at the
// village's own x-range the beach turns out to sit at local ly 26-45. So
// Saltmere — a fishing village, with piers — was built roughly FORTY TILES
// INLAND, and the reason it still looked like a beach settlement is that the
// footprint-clearing pass converts trees and rock to SAND: it had manufactured
// its own little desert in the middle of the woods and sat in that.
// The generator sets .y below, from shore() at the village's centre.
export const COAST_VILLAGE = { x: COAST_X0 + 88, y: COAST_Y0 + 39, w: 26, h: 20 };
export const COAST_HOUSE_PLOTS = [];   // flat, cleared 6x6 spots for player housing
export const COAST_DOCK_TILES  = [];   // pier tiles, for the boat and for props

(function generateCoast(){
  const rng = makeRng(20260920);
  const X0 = COAST_X0, Y0 = COAST_Y0, W = COAST_W, H = COAST_H;
  const at  = (lx, ly) => (lx < 0 || ly < 0 || lx >= W || ly >= H) ? T.CAVE_WALL : map[Y0 + ly][X0 + lx];
  const put = (lx, ly, t) => { if (lx >= 0 && ly >= 0 && lx < W && ly < H) map[Y0 + ly][X0 + lx] = t; };

  // Separator rows 554-559, so the dungeon band and the coast band are not
  // walkable into one another. Same trick the dungeon uses at 480-489.
  for (let y = 554; y < Y0; y++)
    for (let x = 0; x < MAP_W; x++) map[y][x] = T.CAVE_WALL;
  // Seal everything in the band that is not the region. The band is 200 wide
  // inside a 480-wide array, and the remainder would otherwise be reachable
  // open grass that nobody authored.
  for (let y = Y0; y < Y0 + H; y++)
    for (let x = X0 + W; x < MAP_W; x++) map[y][x] = T.CAVE_WALL;
  for (let y = Y0 + H; y < MAP_H; y++)
    for (let x = 0; x < MAP_W; x++) map[y][x] = T.CAVE_WALL;

  // The shoreline. Three sine terms of different periods: one alone gives a
  // wave you can see repeating, three do not.
  const shore = lx =>
    46 + Math.sin(lx * 0.055) * 13 + Math.sin(lx * 0.021 + 1.7) * 8
       + Math.sin(lx * 0.13 + 0.4) * 3;

  for (let lx = 0; lx < W; lx++) {
    const sh = shore(lx);
    for (let ly = 0; ly < H; ly++) {
      const d = ly - sh;                       // <0 seaward, >0 inland
      let t;
      if      (d < -9) t = T.WATER;            // open sea
      else if (d < -2) t = T.SHALLOWS;         // wadeable
      else if (d <  4) t = T.SAND;             // beach
      else             t = T.GRASS;            // inland
      put(lx, ly, t);
    }
  }

  // Ragged the band edges. Without this every boundary is a clean curve and
  // the whole coast reads as printed rather than eroded.
  for (let pass = 0; pass < 2; pass++) {
    const edits = [];
    for (let lx = 1; lx < W - 1; lx++) for (let ly = 1; ly < H - 1; ly++) {
      const c = at(lx, ly);
      if (c !== T.SAND && c !== T.SHALLOWS && c !== T.GRASS) continue;
      const n = [at(lx-1, ly), at(lx+1, ly), at(lx, ly-1), at(lx, ly+1)];
      const other = n.find(v => v !== c && (v === T.SAND || v === T.SHALLOWS || v === T.GRASS));
      if (other !== undefined && rng() < 0.22) edits.push([lx, ly, other]);
    }
    for (const e of edits) put(e[0], e[1], e[2]);
  }

  // Cliff ridge along the inland edge. It is the region's back wall, but a
  // wall made of rock reads as landscape.
  for (let lx = 0; lx < W; lx++) {
    const top = 4 + Math.round(Math.sin(lx * 0.045 + 2.1) * 3 + Math.sin(lx * 0.11) * 1.5);
    for (let ly = 0; ly < top; ly++) put(lx, ly, T.CLIFF);
  }
  // A second broken ridge further in, for shape rather than for blocking.
  for (let lx = 0; lx < W; lx++) {
    if (rng() < 0.35) continue;
    const base = 74 + Math.round(Math.sin(lx * 0.037) * 9);
    const tall = 1 + Math.floor(rng() * 3);
    for (let k = 0; k < tall; k++) if (at(lx, base + k) === T.GRASS) put(lx, base + k, T.CLIFF);
  }

  // Inland cover.
  for (let i = 0; i < 70; i++) {
    const cx = Math.floor(rng() * W), cy = Math.floor(rng() * H), r = 2 + Math.floor(rng() * 3);
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (at(cx + dx, cy + dy) !== T.GRASS) continue;
      if (rng() < 0.62) put(cx + dx, cy + dy, T.TREE);
    }
  }
  for (let i = 0; i < 40; i++) {
    const cx = Math.floor(rng() * W), cy = Math.floor(rng() * H), r = 1 + Math.floor(rng() * 2);
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      if (at(cx + dx, cy + dy) !== T.GRASS) continue;
      if (rng() < 0.55) put(cx + dx, cy + dy, T.STONE);
    }
  }

  // Saltmere village — placed against the waterline rather than at a number.
  // shore() at the village's centre gives the sand; +4 puts the first row of
  // huts just inland of it, and because the coast slopes across the village's
  // width the western end sits nearer the water than the eastern one, which is
  // what a village strung along a shore actually looks like.
  const V = COAST_VILLAGE;
  V.y = Y0 + Math.round(shore(V.x - X0 + Math.floor(V.w / 2))) + 4;
  const vx = V.x - X0, vy = V.y - Y0;
  // Clear the footprint back to sand, so the huts sit on the beach rather than
  // in whatever grove happened to roll there.
  for (let ly = vy - 2; ly < vy + V.h + 2; ly++)
    for (let lx = vx - 2; lx < vx + V.w + 2; lx++) {
      const c = at(lx, ly);
      if (c === T.TREE || c === T.STONE || c === T.CLIFF) put(lx, ly, T.SAND);
    }
  // Six huts in two rows: a hollow WALL ring each, doorway facing the sea.
  for (let row = 0; row < 2; row++) for (let col = 0; col < 3; col++) {
    const hx = vx + 2 + col * 8, hy = vy + 2 + row * 9, hw = 5, hh = 5;
    for (let ly = 0; ly < hh; ly++) for (let lx = 0; lx < hw; lx++) {
      const edge = (lx === 0 || ly === 0 || lx === hw - 1 || ly === hh - 1);
      put(hx + lx, hy + ly, edge ? T.WALL : T.PATH);
    }
    put(hx + 2, hy + hh - 1, T.PATH);              // doorway
  }
  // Village path spine.
  for (let lx = vx - 1; lx < vx + V.w + 1; lx++) {
    const ly = vy + 7;
    if (at(lx, ly) !== T.WALL) put(lx, ly, T.PATH);
  }

  // Piers. Each runs seaward from the beach; the long one is the boat landing.
  const pierAt = (lx, stopAtDeep) => {
    let ly = vy + 7;
    for (; ly > 0; ly--) if (at(lx, ly) === T.SHALLOWS || at(lx, ly) === T.WATER) break;
    let laid = 0, k = 0;
    for (k = 0; k < 40 && ly - k > 0; k++) {
      const c = at(lx, ly - k);
      if (c === T.CLIFF || c === T.WALL) break;
      const wasDeep = (c === T.WATER);
      put(lx, ly - k, T.DOCK);
      COAST_DOCK_TILES.push({ x: X0 + lx, y: Y0 + ly - k });
      laid++;
      if (stopAtDeep) { if (wasDeep && laid > 4) break; }
      else if (laid >= 7) break;
    }
    return { x: X0 + lx, y: Y0 + ly - laid + 1 };
  };
  pierAt(vx + 4, false);
  pierAt(vx + V.w - 5, false);
  const landing = pierAt(vx + 12, true);          // the long pier
  // Join the piers to the spine so you can walk off them.
  for (const px of [vx + 4, vx + 12, vx + V.w - 5])
    for (let ly = vy + 7; ly < vy + 9; ly++) if (at(px, ly) === T.SAND) put(px, ly, T.PATH);

  // The declared landing must BE the pier head. If the generator ever drifts,
  // this is the line that disagrees first.
  COAST_LANDING.x = landing.x; COAST_LANDING.y = landing.y;

  // The village and one tile of apron around it is the coast's safe ground.
  // Derived from the placed village rather than written down, so it cannot drift
  // away from the huts the way the village itself drifted from the shoreline.
  COAST_SAFE_ZONE.x1 = V.x - 2;          COAST_SAFE_ZONE.y1 = V.y - 2;
  COAST_SAFE_ZONE.x2 = V.x + V.w + 2;    COAST_SAFE_ZONE.y2 = V.y + V.h + 2;

  // ── The Saltmere gate, village end ───────────────────────────────
  // On the spine, at the inland end of the village so it does not crowd the
  // piers. Both ends are registered together so they can never point at
  // something that was never built.
  {
    const gx = vx + V.w - 3, gy = vy + 7;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const c = at(gx + dx, gy + dy);
      if (c === T.TREE || c === T.STONE || c === T.CLIFF) put(gx + dx, gy + dy, T.PATH);
    }
    put(gx, gy, T.TELEPORT);
    const cityG = CITY_COAST_GATE;
    // village gate -> city, and city gate -> village. Arrival tiles are one
    // step clear of the arch so you do not land on it and bounce straight back.
    COAST_PORTALS[(X0 + gx) + ',' + (Y0 + gy)] = { sx: cityG.x, sy: cityG.y + 2, to: 'mainland' };
    COAST_PORTALS[cityG.x + ',' + cityG.y]     = { sx: X0 + gx, sy: Y0 + gy + 2, to: 'coast' };
  }

  // ── Who and what lives here ──────────────────────────────────────
  // Positions are derived from the village the generator just placed, so they
  // follow it if the shoreline moves.
  const push = (id, lx, ly, style, prop, label) =>
    COAST_NPCS.push({ id, x: (X0+lx)*TILE + TILE/2, y: (Y0+ly)*TILE + TILE/2, style, prop, label });
  // The harbourmaster stands at the landward end of the long pier, where he can
  // see every boat that ties up.
  push('harbourmaster', vx + 12, vy - 2, 'harbourmaster', null, 'Harbourmaster');
  // The village itself: a fishwife on the spine, a shipwright by the huts.
  push('fishwife',   vx + 5,        vy + 7, 'fishwife',   null,     'Fishwife');
  push('shipwright', vx + V.w - 6,  vy + 7, 'shipwright', 'hammer', 'Shipwright');
  // Two villagers, for somewhere to look that is not a shop.
  push('villager_a', vx + 10, vy + 7,  'villager', null, null);
  push('villager_b', vx + 18, vy + 16, 'villager', null, null);

  // Mobs. Crabs on the sand, serpents in the shallows, wreckers along the
  // beach away from the village so the place is not under siege on arrival.
  const beachAt = lx => Math.round(shore(lx));
  for (let i = 0; i < 10; i++) {
    const lx = 12 + i * 18;
    if (lx >= W - 4) break;
    COAST_MOBS.push([X0 + lx, Y0 + beachAt(lx) + 1, 'shore_crab']);
  }
  for (let i = 0; i < 7; i++) {
    const lx = 20 + i * 24;
    if (lx >= W - 4) break;
    COAST_MOBS.push([X0 + lx, Y0 + beachAt(lx) - 4, 'reef_serpent']);
  }
  for (const lx of [22, 40, 150, 172]) {
    COAST_MOBS.push([X0 + lx, Y0 + beachAt(lx) + 3, 'wrecker']);
  }

  // Player house plots: 6x6 clearings on the grass INLAND of the village.
  //
  // They used to sit east of it, which worked only while the village was in the
  // middle of the region. With the village against the waterline the eastern
  // strip is half beach and half sea, and three of the six plots were being
  // rejected for standing in water. Inland is the dependable direction — the
  // ground behind a shore settlement is the ground you would build on anyway.
  for (let i = 0; i < 6; i++) {
    const px = vx + 1 + (i % 3) * 9, py = vy + V.h + 3 + Math.floor(i / 3) * 8;
    let ok = true;
    for (let ly = 0; ly < 6 && ok; ly++) for (let lx = 0; lx < 6; lx++) {
      const c = at(px + lx, py + ly);
      if (c === T.WATER || c === T.SHALLOWS || c === T.WALL || c === T.DOCK || c === T.CAVE_WALL) { ok = false; break; }
    }
    if (!ok) continue;
    for (let ly = 0; ly < 6; ly++) for (let lx = 0; lx < 6; lx++) {
      const c = at(px + lx, py + ly);
      if (c === T.TREE || c === T.STONE || c === T.CLIFF) put(px + lx, py + ly, T.GRASS);
    }
    COAST_HOUSE_PLOTS.push({ x: X0 + px, y: Y0 + py, size: 6 });
  }
})();

// -- Resource HP + respawn arrays ----------------------------------
for (let y=0;y<MAP_H;y++) {
  resourceHp[y]=[]; respawnAt[y]=[]; origTile[y]=[]; playerPlacedWalls[y]=[];
  for (let x=0;x<MAP_W;x++) {
    const tile = map[y][x];
    resourceHp[y][x] = tile===T.TREE?TREE_HP:tile===T.STONE?STONE_HP:tile===T.ORE_IRON?IRON_HP:0;
    respawnAt[y][x]  = null;
    origTile[y][x]   = tile;
    playerPlacedWalls[y][x] = false;
  }
}

// -- Champ altars --------------------------------------------------
const DX = DUNGEON_X0+32, DY = DUNGEON_Y0+29;
export const CHAMP_ALTARS = [
  { idx:0, atx: 81, aty:158, type:'goblin' },
  { idx:1, atx:220, aty: 69, type:'troll'  },
  { idx:2, atx:412, aty:118, type:'spider' },
  { idx:3, atx:119, aty:330, type:'goblin' },
  { idx:4, atx:383, aty:267, type:'spider' },
  { idx:5, atx:440, aty:409, type:'troll'  },
  { idx:6, atx: DX, aty: DY, dungeon:true, spawnCooldown:1.5,
    mobPool:[
      ['giant_rat','slime'],
      ['ratman'],
      ['ratman','ratman_archer'],
      ['ratman','ratman_wiz'],
      ['hellhound'],
      ['silver_serp'],
    ],
    bossType:'piper',
  },
].map(def => {
  const bossMap = { goblin:'goblin_k', troll:'troll_l', spider:'spider_q' };
  return {
    ...def,
    x: def.atx * TILE + TILE/2,
    y: def.aty * TILE + TILE/2,
    rx: 14 * TILE,
    bossType: def.bossType || bossMap[def.type],
    state:'idle', level:0, whiteCandles:0, killsThisCandle:0,
    decayTimer:0, decayInterval:300, spawnTimer:0, spawnCooldown: def.spawnCooldown || 8,
  };
});

// -- Cave mob spawn data -------------------------------------------
export const CAVE_MOBS = [
  [60,140,42,36,'goblin',5],
  [200,50,40,38,'troll',3],
  [390,100,44,36,'spider',5],
  [100,310,38,40,'goblin',6],
  [360,250,46,35,'spider',4],
  [420,390,40,38,'troll',4],
];
export const WOLF_SPAWNS = [
  [50,340],[410,120],[150,50],[360,430],[445,280],[70,220],
  [120,150],[310,80],[185,430],[445,140],[80,390],[265,50],
  [425,305],[105,200],[355,155],[205,325],[455,70],[30,295],
  [170,260],[420,430],[55,90],[330,195],[245,445],[470,340],
  [35,50],[475,60],[30,460],[475,460],[25,180],[478,185],
  [140,100],[285,120],[395,65],[145,290],[390,200],[250,410],
  [70,340],[440,370],[200,20],[360,25],[110,465],[440,20],
];
export const BANDIT_SPAWNS = [
  [120,90],[390,340],[285,40],[155,430],[410,205],[55,155],
  [255,355],[455,255],[105,445],[330,440],[460,110],[200,155],
  [30,120],[475,400],[250,280],[400,460],[160,320],[350,30],
];

// Dungeon portal positions
export const DUNGEON_PORTAL_A   = { x: 190, y: 231 };
export const DUNGEON_PORTAL_B   = { x:  81, y: 162 };
export const DUNGEON_ENTRY_TILE = { x: DUNGEON_X0+14, y: DUNGEON_Y0+36 };
export const DUNGEON_CITY_EXIT  = { x: DUNGEON_X0+38, y: DUNGEON_Y0+57 };
