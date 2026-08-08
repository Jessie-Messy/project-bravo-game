// editor.js — Standalone World & Entity Editor Engine for Project Bravo

// ── Constants & Definitions ─────────────────────────────────────────
const TILE = 48, MAP_W = 480, MAP_H = 554;
const T = {
  GRASS: 0, PATH: 1, WATER: 2, TREE: 3, STONE: 4,
  WALL: 5, BRIDGE: 6, CAVE_FLOOR: 7, CAVE_WALL: 8, CAVE_ENTRANCE: 9,
  TELEPORT: 10, ORE_IRON: 11, STAINED_GLASS: 12,
};

const TILE_NAMES = {
  [T.GRASS]: 'Grass', [T.PATH]: 'Path', [T.WATER]: 'Water',
  [T.TREE]: 'Tree Grove', [T.STONE]: 'Stone/Rock', [T.WALL]: 'Wall',
  [T.BRIDGE]: 'Bridge', [T.CAVE_FLOOR]: 'Cave Floor', [T.CAVE_WALL]: 'Cave Wall',
  [T.CAVE_ENTRANCE]: 'Cave Mouth', [T.TELEPORT]: 'Teleport Portal',
  [T.ORE_IRON]: 'Iron Ore', [T.STAINED_GLASS]: 'Stained Glass'
};

const TILE_COLORS = {
  [T.GRASS]: [79, 122, 58], [T.PATH]: [156, 123, 79], [T.WATER]: [18, 42, 82],
  [T.TREE]: [30, 75, 25], [T.STONE]: [111, 106, 99], [T.WALL]: [138, 127, 110],
  [T.BRIDGE]: [122, 80, 48], [T.CAVE_FLOOR]: [26, 20, 18], [T.CAVE_WALL]: [13, 12, 11],
  [T.CAVE_ENTRANCE]: [96, 78, 52], [T.TELEPORT]: [120, 80, 200],
  [T.ORE_IRON]: [106, 86, 77], [T.STAINED_GLASS]: [142, 34, 48]
};

const ED_COLORS = [
  [200,60,50],[220,130,40],[230,200,60],[120,190,60],[40,150,70],[60,200,180],
  [50,120,220],[90,60,200],[170,60,200],[220,80,150],[140,90,50],[90,60,30],
  [235,235,220],[150,150,150],[80,80,80],[25,25,30]
];

const DEFAULT_ENEMY_CFG = {
  wolf:        { name: 'Wolf',          maxHp: 30,  speed: 140, damage: 8,  aggroRange: 192, attackCooldown: 1.1, cave: false, color: '#a07850' },
  bandit:      { name: 'Bandit',        maxHp: 50,  speed: 75,  damage: 15, aggroRange: 288, attackCooldown: 1.4, cave: false, color: '#d04040' },
  goblin:      { name: 'Goblin',        maxHp: 22,  speed: 160, damage: 10, aggroRange: 240, attackCooldown: 0.9, cave: true,  color: '#40b040' },
  troll:       { name: 'Troll',         maxHp: 90,  speed: 48,  damage: 26, aggroRange: 192, attackCooldown: 2.0, cave: true,  color: '#708090' },
  spider:      { name: 'Spider',       maxHp: 35,  speed: 130, damage: 12, aggroRange: 240, attackCooldown: 1.2, cave: true,  color: '#a050d0' },
  goblin_k:    { name: 'Goblin King',   maxHp: 220, speed: 85,  damage: 32, aggroRange: 432, attackCooldown: 1.4, cave: true,  color: '#ffd700' },
  troll_l:     { name: 'Troll Lord',    maxHp: 450, speed: 32,  damage: 58, aggroRange: 432, attackCooldown: 2.6, cave: true,  color: '#ff4500' },
  spider_q:    { name: 'Spider Queen',  maxHp: 280, speed: 100, damage: 40, aggroRange: 432, attackCooldown: 1.6, cave: true,  color: '#ee82ee' },
  slime:       { name: 'Slime',         maxHp: 20,  speed: 52,  damage: 5,  aggroRange: 144, attackCooldown: 1.6, cave: true,  color: '#32cd32' },
  ratman:      { name: 'Ratman',        maxHp: 38,  speed: 115, damage: 11, aggroRange: 240, attackCooldown: 1.0, cave: true,  color: '#8b4513' },
  ratman_wiz:  { name: 'Ratman Wizard', maxHp: 30,  speed: 85,  damage: 16, aggroRange: 288, attackCooldown: 2.2, cave: true,  color: '#4169e1' },
  hellhound:   { name: 'Hellhound',     maxHp: 58,  speed: 170, damage: 18, aggroRange: 288, attackCooldown: 0.9, cave: true,  color: '#ff0000' },
  silver_serp: { name: 'Silver Serpent',maxHp: 75,  speed: 135, damage: 14, aggroRange: 288, attackCooldown: 1.3, cave: true,  color: '#c0c0c0' },
  piper:       { name: 'Piper Boss',    maxHp: 520, speed: 65,  damage: 42, aggroRange: 576, attackCooldown: 2.0, cave: true,  color: '#9370db' },
  giant_rat:   { name: 'Giant Rat',     maxHp: 15,  speed: 120, damage: 4,  aggroRange: 192, attackCooldown: 1.2, cave: true,  color: '#a9a9a9' },
  ratman_archer:{ name: 'Ratman Archer',maxHp: 34,  speed: 100, damage: 10, aggroRange: 288, attackCooldown: 1.8, cave: true,  color: '#daa520' }
};

// ── State Storage ──────────────────────────────────────────────────
const EDITS_KEY = 'bravoWorldEdits_v1';
const baseMap = []; // 2D array [554][480] of base tiles
const activeMap = []; // 2D array [554][480] of effective tiles

const worldEdits = {
  map: {},        // "tx,ty": tileId
  spawns: [],     // [{ id, t, x, y }]
  mobs: {},       // { type: { maxHp, speed, damage... } }
  tiles: [],      // [{ id, name, color, blocking, boxH }]
  customMobs: []  // [{ id, name, base, tint, scale, cave, stats }]
};

const customTileDefs = {};
const customMobDefs = {};

// Active Editor State
const edState = {
  tool: 'inspect',   // 'inspect', 'paint', 'rect', 'bucket', 'erase', 'spawn'
  brushSize: 1,      // 1, 2 (3x3), 3 (5x5), 4 (7x7)
  activeTab: 'tiles',// 'tiles', 'mobs'
  selectedTile: T.GRASS,
  selectedMob: 'wolf',
  rectStart: null,   // { tx, ty } when dragging rect
  draggedSpawn: null,// spawn object being dragged
  hoverTile: { tx: -1, ty: -1 },
  selectedItem: null,// { type: 'tile'|'spawn', tx, ty, spawn }
  showGrid: true,
  showSpawns: true,
  showDungeon: true
};

// Camera / Viewport Transform
const view = {
  x: 240 * TILE,
  y: 240 * TILE,
  zoom: 0.35,
  isPanning: false,
  panStartX: 0,
  panStartY: 0
};

// ── Seeded Procedural Map Generator ────────────────────────────────
function makeRng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function generateDefaultWorld() {
  const rng = makeRng(7);
  for (let y = 0; y < MAP_H; y++) {
    baseMap[y] = new Array(MAP_W).fill(T.GRASS);
  }

  // Rivers
  for (const riverY of [80, 200, 360]) {
    for (let x = 0; x < MAP_W; x++) {
      const cy = Math.round(riverY + Math.sin(x * 0.08 + riverY * 0.01) * 9);
      for (let dy = -1; dy <= 1; dy++) {
        const y = cy + dy;
        if (y >= 0 && y < 480) baseMap[y][x] = T.WATER;
      }
    }
  }

  // North-South Path + Bridges
  for (let y = 0; y < 480; y++) {
    const cx = Math.round(240 + Math.sin(y * 0.06) * 8);
    if (cx < 0 || cx >= MAP_W) continue;
    if (baseMap[y][cx] === T.WATER) baseMap[y][cx] = T.BRIDGE; else baseMap[y][cx] = T.PATH;
    if (cx + 1 < MAP_W) {
      if (baseMap[y][cx+1] === T.WATER) baseMap[y][cx+1] = T.BRIDGE; else baseMap[y][cx+1] = T.PATH;
    }
  }

  // East-West Path
  for (let x = 0; x < MAP_W; x++) {
    const cy = Math.round(300 + Math.sin(x * 0.05) * 6);
    if (cy < 0 || cy >= 480) continue;
    if (baseMap[cy][x] !== T.WATER && baseMap[cy][x] !== T.PATH) baseMap[cy][x] = T.PATH;
  }

  // Extra bridges
  for (const bridgeX of [120, 240, 360]) {
    for (let y = 0; y < 480; y++)
      if (baseMap[y][bridgeX] === T.WATER) baseMap[y][bridgeX] = T.BRIDGE;
  }

  // Ruins
  for (const [rx, ry] of [[80,60],[380,100],[160,390]]) {
    for (let y = ry; y < ry+5; y++)
      for (let x = rx; x < rx+6; x++) {
        if (x<0||y<0||x>=MAP_W||y>=480) continue;
        const edge = (y===ry||y===ry+4||x===rx||x===rx+5);
        if (edge && rng()<0.8) baseMap[y][x] = T.STONE;
      }
  }

  // Tree groves
  for (let i = 0; i < 160; i++) {
    const cx=Math.floor(rng()*MAP_W), cy=Math.floor(rng()*480), r=2+Math.floor(rng()*4);
    for (let dy=-r;dy<=r;dy++) for (let dx=-r;dx<=r;dx++) {
      const tx=cx+dx, ty=cy+dy;
      if (tx<0||ty<0||tx>=MAP_W||ty>=480) continue;
      if (baseMap[ty][tx]!==T.GRASS) continue;
      if (rng()<0.72) baseMap[ty][tx]=T.TREE;
    }
  }

  // Stone outcrops
  for (let i = 0; i < 80; i++) {
    const cx=Math.floor(rng()*MAP_W), cy=Math.floor(rng()*480), r=1+Math.floor(rng()*2);
    for (let dy=-r;dy<=r;dy++) for (let dx=-r;dx<=r;dx++) {
      const tx=cx+dx, ty=cy+dy;
      if (tx<0||ty<0||tx>=MAP_W||ty>=480) continue;
      if (baseMap[ty][tx]!==T.GRASS) continue;
      if (rng()<0.65) baseMap[ty][tx]=T.STONE;
    }
  }

  // Lunar City footprint
  const OX1=280,OX2=340,OY1=332,OY2=392;
  const IX1=296,IX2=324,IY1=348,IY2=376;
  const CX=310,CY=362;
  for(let y=OY1;y<=OY2;y++) for(let x=OX1;x<=OX2;x++) baseMap[y][x]=T.GRASS;
  for(let x=OX1;x<=OX2;x++){ baseMap[OY1][x]=T.WALL; baseMap[OY2][x]=T.WALL; }
  for(let y=OY1;y<=OY2;y++){ baseMap[y][OX1]=T.WALL; baseMap[y][OX2]=T.WALL; }
  for(let dy=0;dy<3;dy++) for(let dx=0;dx<3;dx++){
    baseMap[OY1+dy][OX1+dx]=T.WALL; baseMap[OY1+dy][OX2-dx]=T.WALL;
    baseMap[OY2-dy][OX1+dx]=T.WALL; baseMap[OY2-dy][OX2-dx]=T.WALL;
  }
  for(let x=CX-1;x<=CX+1;x++){ baseMap[OY1][x]=T.PATH; baseMap[OY2][x]=T.PATH; }
  for(let y=CY-1;y<=CY+1;y++){ baseMap[y][OX1]=T.PATH; baseMap[y][OX2]=T.PATH; }

  const RX1=OX1+4,RX2=OX2-4,RY1=OY1+4,RY2=OY2-4;
  for(let x=RX1;x<=RX2;x++){ baseMap[RY1][x]=T.PATH; baseMap[RY2][x]=T.PATH; }
  for(let y=RY1;y<=RY2;y++){ baseMap[y][RX1]=T.PATH; baseMap[y][RX2]=T.PATH; }
  for(let x=CX-1;x<=CX+1;x++) for(let y=OY1+1;y<=RY1;y++) baseMap[y][x]=T.PATH;
  for(let x=CX-1;x<=CX+1;x++) for(let y=RY2;y<=OY2-1;y++) baseMap[y][x]=T.PATH;
  for(let x=OX1+1;x<=RX1;x++) for(let y=CY-1;y<=CY+1;y++) baseMap[y][x]=T.PATH;
  for(let x=RX2;x<=OX2-1;x++) for(let y=CY-1;y<=CY+1;y++) baseMap[y][x]=T.PATH;
  for(let x=RX1;x<=IX1;x++) baseMap[CY][x]=T.PATH;
  for(let x=IX2;x<=RX2;x++) baseMap[CY][x]=T.PATH;

  function buildHouse(x1,y1,doorSide,doorOff){
    for(let dy=0;dy<5;dy++) for(let dx=0;dx<5;dx++){
      const tx=x1+dx,ty=y1+dy;
      baseMap[ty][tx]=(dy===0||dy===4||dx===0||dx===4)?T.WALL:T.PATH;
    }
    if(doorSide==='n') baseMap[y1   ][x1+doorOff]=T.PATH;
    if(doorSide==='s') baseMap[y1+4 ][x1+doorOff]=T.PATH;
    if(doorSide==='w') baseMap[y1+doorOff][x1   ]=T.PATH;
    if(doorSide==='e') baseMap[y1+doorOff][x1+4 ]=T.PATH;
  }
  buildHouse(308,339,'s',2); buildHouse(285,343,'e',2);
  buildHouse(285,377,'e',2); buildHouse(331,343,'w',2); buildHouse(331,377,'w',2);

  for(let y=IY1;y<=IY2;y++) for(let x=IX1;x<=IX2;x++) baseMap[y][x]=T.WALL;
  for(let y=IY1+2;y<=IY2-2;y++) for(let x=IX1+2;x<=IX2-2;x++) baseMap[y][x]=T.PATH;
  for(let y=CY-1;y<=CY+1;y++){ baseMap[y][IX1]=T.PATH; baseMap[y][IX1+1]=T.PATH; }
  for(let y=CY-1;y<=CY+1;y++){ baseMap[y][IX2-1]=T.PATH; baseMap[y][IX2]=T.PATH; }

  const BX1=306,BX2=314,BY1=359,BY2=365;
  for(let y=BY1;y<=BY2;y++) for(let x=BX1;x<=BX2;x++) baseMap[y][x]=T.WALL;
  for(let y=BY1+1;y<=BY2-1;y++) for(let x=BX1+1;x<=BX2-1;x++) baseMap[y][x]=T.PATH;
  baseMap[BY2][CX-1]=T.PATH; baseMap[BY2][CX]=T.PATH; baseMap[BY2][CX+1]=T.PATH;
  baseMap[BY1][CX]=T.PATH;

  buildHouse(299,351,'s',2); buildHouse(317,351,'s',2);
  buildHouse(299,369,'n',2); buildHouse(317,369,'n',2);

  // Caves generator
  function generateCave(cx, cy, w, h) {
    for (let y=cy;y<cy+h;y++) for (let x=cx;x<cx+w;x++) {
      if (x<=cx||y<=cy||x>=cx+w-1||y>=cy+h-1) { baseMap[y][x]=T.CAVE_WALL; continue; }
      if (baseMap[y][x]===T.WATER||baseMap[y][x]===T.PATH||baseMap[y][x]===T.BRIDGE) continue;
      baseMap[y][x]=rng()<0.44?T.CAVE_WALL:T.CAVE_FLOOR;
    }
    for (let pass=0;pass<4;pass++) {
      const snap=[];
      for (let y=cy;y<cy+h;y++) {
        snap[y-cy]=[];
        for (let x=cx;x<cx+w;x++) snap[y-cy][x-cx]=baseMap[y][x];
      }
      for (let dy=1;dy<h-1;dy++) for (let dx=1;dx<w-1;dx++) {
        let walls=0;
        for (let ny=-1;ny<=1;ny++) for (let nx=-1;nx<=1;nx++) {
          const s=snap[dy+ny]&&snap[dy+ny][dx+nx];
          if (s===T.CAVE_WALL||s===T.WATER||s===undefined) walls++;
        }
        baseMap[cy+dy][cx+dx]=walls>=5?T.CAVE_WALL:T.CAVE_FLOOR;
      }
    }
    for (let y=cy;y<cy+h;y++) { baseMap[y][cx]=T.CAVE_WALL; baseMap[y][cx+w-1]=T.CAVE_WALL; }
    for (let x=cx;x<cx+w;x++) { baseMap[cy][x]=T.CAVE_WALL; baseMap[cy+h-1][x]=T.CAVE_WALL; }
    const ex=cx+Math.floor(w/2);
    if (ex>=0&&ex<MAP_W) {
      if (cy-1>=0) {
        baseMap[cy-1][ex]=T.CAVE_ENTRANCE;
        if (cy-2>=0) {
          for (let ddx=-1;ddx<=1;ddx++) {
            const nx=ex+ddx;
            if (nx>=0&&nx<MAP_W&&(baseMap[cy-2][nx]===T.TREE||baseMap[cy-2][nx]===T.STONE))
              baseMap[cy-2][nx]=T.GRASS;
          }
        }
      }
      if (cy>=0&&cy<MAP_H) baseMap[cy][ex]=T.CAVE_FLOOR;
      for (let depth=0;depth<=4;depth++) {
        for (let ddx=-1;ddx<=1;ddx++) {
          const nx=ex+ddx, ny=cy+depth;
          if (nx>cx&&nx<cx+w-1&&ny<cy+h-1&&ny>=0&&ny<MAP_H&&nx>=0&&nx<MAP_W)
            baseMap[ny][nx]=T.CAVE_FLOOR;
        }
      }
    }
  }

  for (const [cx,cy,w,h] of [
    [60,140,42,36],[200,50,40,38],[390,100,44,36],
    [100,310,38,40],[360,250,46,35],[420,390,40,38]
  ]) generateCave(cx,cy,w,h);

  const EA_X = 190, EA_Y = 232;
  for (let x=EA_X-2;x<=EA_X+2;x++) {
    baseMap[EA_Y-1][x] = T.CAVE_FLOOR;
    baseMap[EA_Y][x]   = T.CAVE_FLOOR;
    baseMap[EA_Y+1][x] = T.CAVE_WALL;
  }
  baseMap[EA_Y-1][EA_X] = T.TELEPORT;

  const EB_X = 81, EB_Y = 162;
  baseMap[EB_Y][EB_X] = T.TELEPORT;

  // Separator strip (rows 480–489)
  for (let y=480;y<490;y++)
    for (let x=0;x<MAP_W;x++)
      baseMap[y][x]=T.CAVE_WALL;

  // Dungeon subterranean lake
  const dx0=208, dy0=490, dw=64, dh=64;
  for (let y=dy0;y<dy0+dh;y++) for (let x=dx0;x<dx0+dw;x++) baseMap[y][x]=T.CAVE_WALL;
  for (let y=dy0+1;y<dy0+dh-1;y++) for (let x=dx0+1;x<dx0+dw-1;x++) baseMap[y][x]=T.WATER;
  for (let y=dy0+1;y<dy0+dh-1;y++) {
    for (let x=dx0+1;x<dx0+dw-1;x++) {
      const d1=((x-(dx0+32))/14)**2+((y-(dy0+36))/12)**2;
      const d2=((x-(dx0+37))/10)**2+((y-(dy0+24))/9)**2;
      if (d1<=1.0||d2<=1.0) baseMap[y][x]=T.CAVE_FLOOR;
    }
  }

  rebuildActiveMap();
}

function rebuildActiveMap() {
  for (let y = 0; y < MAP_H; y++) {
    activeMap[y] = [...baseMap[y]];
  }
  for (const [k, t] of Object.entries(worldEdits.map)) {
    const [tx, ty] = k.split(',').map(Number);
    if (activeMap[ty] && activeMap[ty][tx] !== undefined) {
      activeMap[ty][tx] = t;
    }
  }
}

// ── Persistence & Storage Sync ─────────────────────────────────────
function loadEdits() {
  try {
    const raw = localStorage.getItem(EDITS_KEY);
    if (raw) {
      const src = JSON.parse(raw);
      worldEdits.map = src.map || {};
      worldEdits.spawns = src.spawns || [];
      worldEdits.mobs = src.mobs || {};
      worldEdits.tiles = src.tiles || [];
      worldEdits.customMobs = src.customMobs || [];
    }
  } catch (e) { console.warn('Edits load failed', e); }

  registerCustomDefs();
  rebuildActiveMap();
  updateUIStats();
}

let saveTimer = null;
function saveEdits() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(EDITS_KEY, JSON.stringify(worldEdits));
      showStatus('LocalStorage Synced (bravoWorldEdits_v1)', 'green');
    } catch (e) { showStatus('Save Error!', 'red'); }
  }, 300);
}

function registerCustomDefs() {
  for (const ct of worldEdits.tiles) {
    customTileDefs[ct.id] = ct;
    TILE_NAMES[ct.id] = ct.name;
    TILE_COLORS[ct.id] = ct.color;
  }
  for (const cm of worldEdits.customMobs) {
    customMobDefs[cm.id] = cm;
  }
}

// ── DOM Elements ───────────────────────────────────────────────────
let canvas, ctx, viewport;

window.addEventListener('DOMContentLoaded', () => {
  canvas = document.getElementById('mapCanvas');
  ctx = canvas.getContext('2d');
  viewport = document.getElementById('viewport');

  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  generateDefaultWorld();
  loadEdits();

  initPalette();
  initColorPickers();
  initEventListeners();

  requestAnimationFrame(renderLoop);
});

function resizeCanvas() {
  canvas.width = viewport.clientWidth;
  canvas.height = viewport.clientHeight;
}

// ── Render Loop ────────────────────────────────────────────────────
function renderLoop() {
  renderMap();
  requestAnimationFrame(renderLoop);
}

function renderMap() {
  if (!ctx) return;
  const w = canvas.width, h = canvas.height;

  ctx.fillStyle = '#08070c';
  ctx.fillRect(0, 0, w, h);

  ctx.save();
  // Transform view (Center point at view.x, view.y)
  ctx.translate(w / 2, h / 2);
  ctx.scale(view.zoom, view.zoom);
  ctx.translate(-view.x, -view.y);

  // Calculate visible tile range
  const halfW = (w / 2) / view.zoom, halfH = (h / 2) / view.zoom;
  const minTx = Math.max(0, Math.floor((view.x - halfW) / TILE));
  const maxTx = Math.min(MAP_W - 1, Math.ceil((view.x + halfW) / TILE));
  const minTy = Math.max(0, Math.floor((view.y - halfH) / TILE));
  const maxTy = Math.min(MAP_H - 1, Math.ceil((view.y + halfH) / TILE));

  // Draw Tiles
  for (let ty = minTy; ty <= maxTy; ty++) {
    for (let tx = minTx; tx <= maxTx; tx++) {
      const tileId = activeMap[ty][tx];
      const col = TILE_COLORS[tileId] || [100, 100, 100];

      ctx.fillStyle = `rgb(${col[0]},${col[1]},${col[2]})`;
      ctx.fillRect(tx * TILE, ty * TILE, TILE, TILE);
    }
  }

  // Draw Grid Lines if zoomed in and enabled
  if (edState.showGrid && view.zoom >= 0.25) {
    ctx.strokeStyle = 'rgba(255,255,255,0.08)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    for (let tx = minTx; tx <= maxTx + 1; tx++) {
      ctx.moveTo(tx * TILE, minTy * TILE);
      ctx.lineTo(tx * TILE, (maxTy + 1) * TILE);
    }
    for (let ty = minTy; ty <= maxTy + 1; ty++) {
      ctx.moveTo(minTx * TILE, ty * TILE);
      ctx.lineTo((maxTx + 1) * TILE, ty * TILE);
    }
    ctx.stroke();
  }

  // Draw Mob Spawns
  if (edState.showSpawns) {
    for (const s of worldEdits.spawns) {
      if (s.x < minTx || s.x > maxTx || s.y < minTy || s.y > maxTy) continue;

      const px = s.x * TILE + TILE / 2, py = s.y * TILE + TILE / 2;
      const mobCfg = getMobConfig(s.t);
      const isSelected = edState.selectedItem && edState.selectedItem.spawn && edState.selectedItem.spawn.id === s.id;

      // Outer circle marker
      ctx.fillStyle = mobCfg.color || '#ff5555';
      ctx.beginPath(); ctx.arc(px, py, 14, 0, Math.PI * 2); ctx.fill();

      ctx.strokeStyle = isSelected ? '#ffffff' : '#000000';
      ctx.lineWidth = isSelected ? 3 : 1.5;
      ctx.stroke();

      // Mob Initial label
      ctx.fillStyle = '#ffffff';
      ctx.font = 'bold 12px sans-serif';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(mobCfg.name ? mobCfg.name[0].toUpperCase() : 'M', px, py);
    }
  }

  // Draw Hover / Tool Cursor Outline
  const { tx, ty } = edState.hoverTile;
  if (tx >= 0 && tx < MAP_W && ty >= 0 && ty < MAP_H) {
    const r = edState.brushSize - 1;

    if (edState.tool === 'paint' || edState.tool === 'erase') {
      const col = edState.tool === 'erase' ? [200, 50, 50] : (TILE_COLORS[edState.selectedTile] || [255, 215, 0]);
      ctx.fillStyle = `rgba(${col[0]},${col[1]},${col[2]},0.45)`;
      ctx.strokeStyle = '#ffd97a'; ctx.lineWidth = 2;

      for (let dy = -r; dy <= r; dy++) {
        for (let dx = -r; dx <= r; dx++) {
          const ntx = tx + dx, nty = ty + dy;
          if (ntx >= 0 && ntx < MAP_W && nty >= 0 && nty < MAP_H) {
            ctx.fillRect(ntx * TILE, nty * TILE, TILE, TILE);
            ctx.strokeRect(ntx * TILE, nty * TILE, TILE, TILE);
          }
        }
      }
    } else if (edState.tool === 'rect' && edState.rectStart) {
      const stx = Math.min(edState.rectStart.tx, tx), etx = Math.max(edState.rectStart.tx, tx);
      const sty = Math.min(edState.rectStart.ty, ty), ety = Math.max(edState.rectStart.ty, ty);

      ctx.fillStyle = 'rgba(200,162,90,0.35)';
      ctx.strokeStyle = '#ffd97a'; ctx.lineWidth = 2;

      const rw = (etx - stx + 1) * TILE, rh = (ety - sty + 1) * TILE;
      ctx.fillRect(stx * TILE, sty * TILE, rw, rh);
      ctx.strokeRect(stx * TILE, sty * TILE, rw, rh);
    } else {
      // Inspect / Spawn hover outline
      ctx.strokeStyle = '#ffd97a'; ctx.lineWidth = 2;
      ctx.strokeRect(tx * TILE, ty * TILE, TILE, TILE);
    }
  }

  ctx.restore();
}

// ── UI Initialization & Palette ─────────────────────────────────────
function initPalette() {
  // Built-in Tiles Grid
  const builtinGrid = document.getElementById('builtinTilesGrid');
  builtinGrid.innerHTML = '';
  for (const [idStr, name] of Object.entries(TILE_NAMES)) {
    const id = Number(idStr);
    if (id >= 100) continue; // Skip custom tiles here
    const col = TILE_COLORS[id] || [0,0,0];

    const item = document.createElement('div');
    item.className = `palette-item ${edState.selectedTile === id ? 'active' : ''}`;
    item.dataset.tileId = id;
    item.innerHTML = `
      <div class="swatch" style="background: rgb(${col[0]},${col[1]},${col[2]});"></div>
      <div class="palette-item-info">
        <div class="palette-item-name">${name}</div>
        <div class="palette-item-sub">ID: ${id}</div>
      </div>
    `;
    item.onclick = () => {
      edState.selectedTile = id;
      document.querySelectorAll('#tabTilesContent .palette-item').forEach(el => el.classList.remove('active'));
      item.classList.add('active');
    };
    builtinGrid.appendChild(item);
  }

  // Custom Tiles Grid
  renderCustomTilesPalette();

  // Standard Mobs Grid
  const stdMobsGrid = document.getElementById('standardMobsGrid');
  stdMobsGrid.innerHTML = '';
  for (const [type, cfg] of Object.entries(DEFAULT_ENEMY_CFG)) {
    const item = document.createElement('div');
    item.className = `palette-item ${edState.selectedMob === type ? 'active' : ''}`;
    item.dataset.mobType = type;
    item.innerHTML = `
      <div class="swatch" style="background: ${cfg.color};"></div>
      <div class="palette-item-info">
        <div class="palette-item-name">${cfg.name}</div>
        <div class="palette-item-sub">HP: ${getMobStat(type,'maxHp')} · Dmg: ${getMobStat(type,'damage')}</div>
      </div>
    `;
    item.onclick = () => {
      edState.selectedMob = type;
      document.querySelectorAll('#tabMobsContent .palette-item').forEach(el => el.classList.remove('active'));
      item.classList.add('active');
      openMobTuner(type);
    };
    stdMobsGrid.appendChild(item);
  }

  // Custom Mobs Grid
  renderCustomMobsPalette();

  // Populate Base Mob Select dropdown in Mob Wizard
  const baseSelect = document.getElementById('mobBaseInput');
  baseSelect.innerHTML = '';
  for (const [type, cfg] of Object.entries(DEFAULT_ENEMY_CFG)) {
    baseSelect.innerHTML += `<option value="${type}">${cfg.name}</option>`;
  }
}

function renderCustomTilesPalette() {
  const customGrid = document.getElementById('customTilesGrid');
  customGrid.innerHTML = '';
  if (worldEdits.tiles.length === 0) {
    customGrid.innerHTML = `<div style="color:var(--text-muted);font-style:italic;grid-column:span 2;font-size:11px;">No custom tiles created yet.</div>`;
    return;
  }
  for (const ct of worldEdits.tiles) {
    const item = document.createElement('div');
    item.className = `palette-item ${edState.selectedTile === ct.id ? 'active' : ''}`;
    item.dataset.tileId = ct.id;
    item.innerHTML = `
      <div class="swatch" style="background: rgb(${ct.color[0]},${ct.color[1]},${ct.color[2]});"></div>
      <div class="palette-item-info">
        <div class="palette-item-name">✱ ${ct.name}</div>
        <div class="palette-item-sub">${ct.blocking ? 'Solid' : 'Walkable'}</div>
      </div>
    `;
    item.onclick = () => {
      edState.selectedTile = ct.id;
      document.querySelectorAll('#tabTilesContent .palette-item').forEach(el => el.classList.remove('active'));
      item.classList.add('active');
    };
    customGrid.appendChild(item);
  }
}

function renderCustomMobsPalette() {
  const customGrid = document.getElementById('customMobsGrid');
  customGrid.innerHTML = '';
  if (worldEdits.customMobs.length === 0) {
    customGrid.innerHTML = `<div style="color:var(--text-muted);font-style:italic;grid-column:span 2;font-size:11px;">No custom entity mobs created yet.</div>`;
    return;
  }
  for (const cm of worldEdits.customMobs) {
    const hexColor = '#' + (cm.tint || 0xffffff).toString(16).padStart(6, '0');
    const item = document.createElement('div');
    item.className = `palette-item ${edState.selectedMob === cm.id ? 'active' : ''}`;
    item.dataset.mobType = cm.id;
    item.innerHTML = `
      <div class="swatch" style="background: ${hexColor};"></div>
      <div class="palette-item-info">
        <div class="palette-item-name">✱ ${cm.name}</div>
        <div class="palette-item-sub">Base: ${cm.base}</div>
      </div>
    `;
    item.onclick = () => {
      edState.selectedMob = cm.id;
      document.querySelectorAll('#tabMobsContent .palette-item').forEach(el => el.classList.remove('active'));
      item.classList.add('active');
      openMobTuner(cm.id);
    };
    customGrid.appendChild(item);
  }
}

function initColorPickers() {
  const tileGrid = document.getElementById('tileColorGrid');
  const mobGrid = document.getElementById('mobColorGrid');
  tileGrid.innerHTML = ''; mobGrid.innerHTML = '';

  ED_COLORS.forEach((c, idx) => {
    const rgbStr = `rgb(${c[0]},${c[1]},${c[2]})`;

    const optTile = document.createElement('div');
    optTile.className = `color-swatch-opt ${idx === 0 ? 'selected' : ''}`;
    optTile.style.background = rgbStr;
    optTile.dataset.colorIdx = idx;
    optTile.onclick = () => {
      tileGrid.querySelectorAll('.color-swatch-opt').forEach(el => el.classList.remove('selected'));
      optTile.classList.add('selected');
    };
    tileGrid.appendChild(optTile);

    const optMob = document.createElement('div');
    optMob.className = `color-swatch-opt ${idx === 0 ? 'selected' : ''}`;
    optMob.style.background = rgbStr;
    optMob.dataset.colorIdx = idx;
    optMob.onclick = () => {
      mobGrid.querySelectorAll('.color-swatch-opt').forEach(el => el.classList.remove('selected'));
      optMob.classList.add('selected');
    };
    mobGrid.appendChild(optMob);
  });
}

// ── Mob Config Helpers & Stat Tuner ────────────────────────────────
function getMobConfig(type) {
  if (customMobDefs[type]) {
    const cm = customMobDefs[type];
    const base = DEFAULT_ENEMY_CFG[cm.base] || {};
    const hexColor = '#' + (cm.tint || 0xffffff).toString(16).padStart(6, '0');
    return { name: cm.name, cave: cm.cave, color: hexColor, ...base, ...(cm.stats || {}), ...(worldEdits.mobs[type] || {}) };
  }
  return { ...(DEFAULT_ENEMY_CFG[type] || { name: type, color: '#ff5555' }), ...(worldEdits.mobs[type] || {}) };
}

function getMobStat(type, stat) {
  const cfg = getMobConfig(type);
  return cfg[stat] !== undefined ? cfg[stat] : 0;
}

function openMobTuner(type) {
  const cfg = getMobConfig(type);
  document.getElementById('activeMobTunerName').innerText = cfg.name;

  const content = document.getElementById('mobTunerContent');
  content.innerHTML = '';

  const stats = [
    { key: 'maxHp', name: 'Max HP', step: 10, min: 5 },
    { key: 'speed', name: 'Speed', step: 10, min: 10 },
    { key: 'damage', name: 'Damage', step: 2, min: 1 },
    { key: 'aggroRange', name: 'Aggro Range', step: 48, min: 48, fmt: val => (val / TILE).toFixed(1) + ' tiles' },
    { key: 'attackCooldown', name: 'Atk Cooldown', step: 0.1, min: 0.2, fmt: val => val.toFixed(1) + 's' }
  ];

  stats.forEach(s => {
    const val = getMobStat(type, s.key);
    const valStr = s.fmt ? s.fmt(val) : val;

    const row = document.createElement('div');
    row.className = 'stat-row';
    row.innerHTML = `
      <div class="stat-label">${s.name}</div>
      <div class="stat-controls">
        <button class="stat-btn btn-dec">−</button>
        <div class="stat-val">${valStr}</div>
        <button class="stat-btn btn-inc">+</button>
      </div>
    `;

    row.querySelector('.btn-dec').onclick = () => tuneStat(type, s.key, -s.step, s.min);
    row.querySelector('.btn-inc').onclick = () => tuneStat(type, s.key, s.step, s.min);

    content.appendChild(row);
  });

  // If custom mob, add delete button
  if (customMobDefs[type]) {
    const delBtn = document.createElement('button');
    delBtn.className = 'btn btn-danger';
    delBtn.style.marginTop = '10px'; delBtn.style.width = '100%';
    delBtn.innerText = '✕ Delete Custom Mob Entity';
    delBtn.onclick = () => deleteCustomMob(type);
    content.appendChild(delBtn);
  }
}

function tuneStat(type, stat, delta, minVal) {
  const cur = getMobStat(type, stat);
  const next = Math.round(Math.max(minVal, cur + delta) * 100) / 100;

  (worldEdits.mobs[type] ??= {})[stat] = next;
  saveEdits();
  openMobTuner(type);
  initPalette();
}

function deleteCustomMob(type) {
  if (!confirm(`Delete custom mob definition "${customMobDefs[type]?.name}"?`)) return;

  worldEdits.customMobs = worldEdits.customMobs.filter(cm => cm.id !== type);
  delete worldEdits.mobs[type];
  delete customMobDefs[type];
  worldEdits.spawns = worldEdits.spawns.filter(s => s.t !== type);

  saveEdits();
  registerCustomDefs();
  initPalette();
  updateUIStats();
  openMobTuner('wolf');
}

// ── Tool Operations ────────────────────────────────────────────────
function applyTool(tx, ty) {
  if (tx < 0 || tx >= MAP_W || ty < 0 || ty >= MAP_H) return;

  if (edState.tool === 'paint') {
    paintBrush(tx, ty, edState.selectedTile);
  } else if (edState.tool === 'erase') {
    paintBrush(tx, ty, null); // Revert to base tile
  } else if (edState.tool === 'bucket') {
    bucketFill(tx, ty, edState.selectedTile);
  } else if (edState.tool === 'spawn') {
    placeSpawn(tx, ty, edState.selectedMob);
  } else if (edState.tool === 'inspect') {
    inspectPoint(tx, ty);
  }
}

function paintTile(tx, ty, t) {
  if (tx < 0 || ty < 0 || tx >= MAP_W || ty >= MAP_H) return;
  const key = tx + ',' + ty;

  if (t === null || t === baseMap[ty][tx]) {
    delete worldEdits.map[key];
    activeMap[ty][tx] = baseMap[ty][tx];
  } else {
    worldEdits.map[key] = t;
    activeMap[ty][tx] = t;
  }
  saveEdits();
  updateUIStats();
}

function paintBrush(tx, ty, t) {
  const r = edState.brushSize - 1;
  for (let dy = -r; dy <= r; dy++) {
    for (let dx = -r; dx <= r; dx++) {
      paintTile(tx + dx, ty + dy, t);
    }
  }
}

function fillRect(stx, sty, etx, ety, t) {
  const minX = Math.max(0, Math.min(stx, etx)), maxX = Math.min(MAP_W - 1, Math.max(stx, etx));
  const minY = Math.max(0, Math.min(sty, ety)), maxY = Math.min(MAP_H - 1, Math.max(sty, ety));

  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      paintTile(x, y, t);
    }
  }
}

function bucketFill(startTx, startTy, newTile) {
  const targetTile = activeMap[startTy][startTx];
  if (targetTile === newTile) return;

  const queue = [{ x: startTx, y: startTy }];
  const visited = new Set();
  const maxFill = 15000;
  let count = 0;

  while (queue.length > 0 && count < maxFill) {
    const { x, y } = queue.pop();
    const key = x + ',' + y;
    if (visited.has(key)) continue;
    visited.add(key);

    if (activeMap[y][x] === targetTile) {
      paintTile(x, y, newTile);
      count++;

      if (x > 0) queue.push({ x: x - 1, y });
      if (x < MAP_W - 1) queue.push({ x: x + 1, y });
      if (y > 0) queue.push({ x, y: y - 1 });
      if (y < MAP_H - 1) queue.push({ x, y: y + 1 });
    }
  }
}

function placeSpawn(tx, ty, mobType) {
  const id = Date.now() + '_' + Math.floor(Math.random() * 1000);
  const spawn = { id, t: mobType, x: tx, y: ty };
  worldEdits.spawns.push(spawn);
  saveEdits();
  updateUIStats();
  inspectPoint(tx, ty);
}

function removeSpawn(spawnId) {
  worldEdits.spawns = worldEdits.spawns.filter(s => s.id !== spawnId);
  saveEdits();
  updateUIStats();
  document.getElementById('inspectorContent').innerHTML = `<div style="color:var(--text-muted);font-style:italic;text-align:center;">Spawn removed.</div>`;
}

function inspectPoint(tx, ty) {
  const inspector = document.getElementById('inspectorContent');
  document.getElementById('inspectCoord').innerText = `(${tx}, ${ty})`;

  // Check if a mob spawn is on this tile
  const spawn = worldEdits.spawns.find(s => s.x === tx && s.y === ty);
  const tileId = activeMap[ty][tx];
  const tileName = TILE_NAMES[tileId] || `Custom Tile (${tileId})`;
  const col = TILE_COLORS[tileId] || [100,100,100];

  edState.selectedItem = { type: spawn ? 'spawn' : 'tile', tx, ty, spawn };

  if (spawn) {
    const mobCfg = getMobConfig(spawn.t);
    inspector.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
        <div class="swatch" style="background:${mobCfg.color};width:24px;height:24px;"></div>
        <div>
          <div style="font-weight:700;color:var(--text-gold);">${mobCfg.name} Spawn</div>
          <div style="font-size:10px;color:var(--text-muted);font-family:var(--font-mono);">ID: ${spawn.id}</div>
        </div>
      </div>
      <div class="form-group">
        <label>Coordinates</label>
        <div class="form-control" style="font-family:var(--font-mono);">Tile X: ${tx}, Tile Y: ${ty}</div>
      </div>
      <div class="form-group" style="margin-top:6px;">
        <label>Ground Check</label>
        <div style="color:${(mobCfg.cave ? (tileId===T.CAVE_FLOOR) : (tileId===T.GRASS)) ? 'var(--accent-green)' : 'var(--accent-red)'};font-weight:600;">
          ${(mobCfg.cave ? (tileId===T.CAVE_FLOOR) : (tileId===T.GRASS)) ? '✔ Valid Ground' : '⚠️ Mismatched Ground (Needs ' + (mobCfg.cave ? 'Cave Floor' : 'Grass') + ')'}
        </div>
      </div>
      <button class="btn btn-danger" style="margin-top:12px;width:100%;" id="btnDeleteSpawn">✕ Delete Spawn Point</button>
    `;
    document.getElementById('btnDeleteSpawn').onclick = () => removeSpawn(spawn.id);
  } else {
    inspector.innerHTML = `
      <div style="display:flex;align-items:center;gap:10px;margin-bottom:8px;">
        <div class="swatch" style="background:rgb(${col[0]},${col[1]},${col[2]});width:24px;height:24px;"></div>
        <div>
          <div style="font-weight:700;color:var(--text-gold);">${tileName}</div>
          <div style="font-size:10px;color:var(--text-muted);font-family:var(--font-mono);">ID: ${tileId} ${worldEdits.map[tx+','+ty] !== undefined ? '(Edited)' : '(Base)'}</div>
        </div>
      </div>
      <div class="form-group">
        <label>Zone Region</label>
        <div class="form-control">${ty >= 490 ? 'Subterranean Dungeon' : (ty >= 480 ? 'Cave Separator' : 'Overworld World')}</div>
      </div>
    `;
  }
}

// ── Event Handlers & Interactions ──────────────────────────────────
function initEventListeners() {
  // Tools Buttons
  document.querySelectorAll('.tool-btn').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      edState.tool = btn.dataset.tool;
    };
  });

  // Brush Size Buttons
  document.querySelectorAll('.b-size-btn').forEach(btn => {
    btn.onclick = () => {
      document.querySelectorAll('.b-size-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      edState.brushSize = Number(btn.dataset.size);
    };
  });

  // Sidebar Tabs
  document.querySelectorAll('.tab-btn').forEach(tab => {
    tab.onclick = () => {
      document.querySelectorAll('.tab-btn').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');

      const isTiles = tab.dataset.tab === 'tiles';
      document.getElementById('tabTilesContent').style.display = isTiles ? 'flex' : 'none';
      document.getElementById('tabMobsContent').style.display = isTiles ? 'none' : 'flex';
      edState.activeTab = tab.dataset.tab;
    };
  });

  // Header Actions
  document.getElementById('btnLoadDefaultMap').onclick = () => {
    if (confirm('Re-generate default procedural map? (Your tile edits & spawns will be preserved)')) {
      generateDefaultWorld();
    }
  };

  document.getElementById('btnClearEdits').onclick = () => {
    if (confirm('Clear ALL custom tile edits and mob spawn points? This cannot be undone.')) {
      worldEdits.map = {}; worldEdits.spawns = [];
      saveEdits(); rebuildActiveMap(); updateUIStats();
    }
  };

  document.getElementById('btnExportJson').onclick = exportEdits;

  document.getElementById('btnImportJson').onclick = () => {
    document.getElementById('jsonFileInput').click();
  };

  document.getElementById('jsonFileInput').onchange = (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    file.text().then(importEditsJson).catch(err => alert('Failed to import JSON file!'));
  };

  document.getElementById('btnCopyJson').onclick = () => {
    navigator.clipboard.writeText(JSON.stringify(worldEdits, null, 2)).then(() => {
      showStatus('JSON Copied to Clipboard!', 'green');
    });
  };

  document.getElementById('btnLaunchGame').onclick = () => {
    window.location.href = 'medieval_prototype.html';
  };

  // Canvas Mouse Viewport Controls
  const viewportEl = document.getElementById('viewport');
  const tooltip = document.getElementById('mapTooltip');

  viewportEl.oncontextmenu = (e) => e.preventDefault();

  viewportEl.onmousedown = (e) => {
    const mousePx = getCanvasMousePos(e);
    const { tx, ty } = mouseToTile(mousePx.x, mousePx.y);

    if (e.button === 1 || e.button === 2 || e.spaceKey) {
      // Pan Viewport
      view.isPanning = true;
      view.panStartX = e.clientX;
      view.panStartY = e.clientY;
    } else if (e.button === 0) {
      // Left Click Tool Action
      if (edState.tool === 'rect') {
        edState.rectStart = { tx, ty };
      } else {
        applyTool(tx, ty);
      }
    }
  };

  window.onmousemove = (e) => {
    if (view.isPanning) {
      const dx = e.clientX - view.panStartX;
      const dy = e.clientY - view.panStartY;
      view.x -= dx / view.zoom;
      view.y -= dy / view.zoom;
      view.panStartX = e.clientX;
      view.panStartY = e.clientY;
      return;
    }

    const mousePx = getCanvasMousePos(e);
    const { tx, ty } = mouseToTile(mousePx.x, mousePx.y);
    edState.hoverTile = { tx, ty };

    if (tx >= 0 && tx < MAP_W && ty >= 0 && ty < MAP_H) {
      const tileId = activeMap[ty][tx];
      const tileName = TILE_NAMES[tileId] || 'Custom';

      document.getElementById('coordText').innerText = `X: ${tx}, Y: ${ty} | Tile: ${tileName}`;
      tooltip.style.display = 'block';
      tooltip.style.left = (e.clientX - viewportEl.getBoundingClientRect().left + 15) + 'px';
      tooltip.style.top = (e.clientY - viewportEl.getBoundingClientRect().top + 15) + 'px';
      tooltip.innerText = `(${tx}, ${ty}) ${tileName}`;

      if (e.buttons === 1 && (edState.tool === 'paint' || edState.tool === 'erase')) {
        applyTool(tx, ty);
      }
    } else {
      tooltip.style.display = 'none';
    }
  };

  window.onmouseup = (e) => {
    if (view.isPanning) {
      view.isPanning = false;
    }
    if (edState.tool === 'rect' && edState.rectStart) {
      const mousePx = getCanvasMousePos(e);
      const { tx, ty } = mouseToTile(mousePx.x, mousePx.y);
      fillRect(edState.rectStart.tx, edState.rectStart.ty, tx, ty, edState.selectedTile);
      edState.rectStart = null;
    }
  };

  viewportEl.onwheel = (e) => {
    e.preventDefault();
    const zoomFactor = e.deltaY < 0 ? 1.15 : 0.85;
    const newZoom = Math.max(0.08, Math.min(3.0, view.zoom * zoomFactor));

    view.zoom = newZoom;
    document.getElementById('zoomLabel').innerText = Math.round(view.zoom * 100) + '%';
  };

  // Floating Controls
  document.getElementById('toggleGrid').onclick = function() {
    edState.showGrid = !edState.showGrid;
    this.classList.toggle('active', edState.showGrid);
  };
  document.getElementById('toggleSpawns').onclick = function() {
    edState.showSpawns = !edState.showSpawns;
    this.classList.toggle('active', edState.showSpawns);
  };
  document.getElementById('btnZoomIn').onclick = () => {
    view.zoom = Math.min(3.0, view.zoom * 1.2);
    document.getElementById('zoomLabel').innerText = Math.round(view.zoom * 100) + '%';
  };
  document.getElementById('btnZoomOut').onclick = () => {
    view.zoom = Math.max(0.08, view.zoom / 1.2);
    document.getElementById('zoomLabel').innerText = Math.round(view.zoom * 100) + '%';
  };
  document.getElementById('btnResetView').onclick = () => {
    view.x = (MAP_W / 2) * TILE; view.y = (MAP_H / 2) * TILE; view.zoom = 0.35;
    document.getElementById('zoomLabel').innerText = '35%';
  };

  // Modals Setup
  setupModals();
}

function getCanvasMousePos(e) {
  const rect = viewport.getBoundingClientRect();
  return { x: e.clientX - rect.left, y: e.clientY - rect.top };
}

function mouseToTile(px, py) {
  const w = canvas.width, h = canvas.height;
  // Invert transformation
  const worldX = (px - w / 2) / view.zoom + view.x;
  const worldY = (py - h / 2) / view.zoom + view.y;

  return { tx: Math.floor(worldX / TILE), ty: Math.floor(worldY / TILE) };
}

// ── Modals & Wizard Handlers ───────────────────────────────────────
function setupModals() {
  const tileModal = document.getElementById('modalTile');
  const mobModal = document.getElementById('modalMob');

  // Tile Modal
  document.getElementById('btnNewTileWiz').onclick = () => tileModal.classList.add('active');
  document.getElementById('btnCloseTileModal').onclick = () => tileModal.classList.remove('active');
  document.getElementById('btnCancelTileModal').onclick = () => tileModal.classList.remove('active');

  document.getElementById('btnSaveTileModal').onclick = () => {
    const name = document.getElementById('tileNameInput').value.trim();
    if (!name) return alert('Please enter a tile name.');

    const colorOpt = document.querySelector('#tileColorGrid .color-swatch-opt.selected');
    const colorIdx = colorOpt ? Number(colorOpt.dataset.colorIdx) : 0;
    const color = ED_COLORS[colorIdx];

    const blocking = document.getElementById('tileBlockingInput').value === 'true';
    const boxH = Number(document.getElementById('tileHeightInput').value);

    const nextId = Math.max(99, ...worldEdits.tiles.map(t => t.id)) + 1;
    const newTile = { id: nextId, name: name.slice(0, 12), color, blocking, boxH };

    worldEdits.tiles.push(newTile);
    saveEdits();
    registerCustomDefs();
    renderCustomTilesPalette();

    tileModal.classList.remove('active');
    document.getElementById('tileNameInput').value = '';
  };

  // Mob Modal
  document.getElementById('btnNewMobWiz').onclick = () => mobModal.classList.add('active');
  document.getElementById('btnCloseMobModal').onclick = () => mobModal.classList.remove('active');
  document.getElementById('btnCancelMobModal').onclick = () => mobModal.classList.remove('active');

  document.getElementById('btnSaveMobModal').onclick = () => {
    const name = document.getElementById('mobNameInput').value.trim();
    if (!name) return alert('Please enter an entity mob name.');

    const base = document.getElementById('mobBaseInput').value;
    const cave = document.getElementById('mobCaveInput').value === 'true';

    const colorOpt = document.querySelector('#mobColorGrid .color-swatch-opt.selected');
    const colorIdx = colorOpt ? Number(colorOpt.dataset.colorIdx) : 0;
    const c = ED_COLORS[colorIdx];
    const tint = (c[0] << 16) | (c[1] << 8) | c[2];

    const scale = Number(document.getElementById('mobScaleInput').value);
    const maxHp = Number(document.getElementById('mobHpInput').value);
    const damage = Number(document.getElementById('mobDmgInput').value);

    const id = 'c' + Date.now();
    const newMob = {
      id, name: name.slice(0, 16), base, tint, scale, cave,
      stats: { maxHp, damage }
    };

    worldEdits.customMobs.push(newMob);
    saveEdits();
    registerCustomDefs();
    renderCustomMobsPalette();

    mobModal.classList.remove('active');
    document.getElementById('mobNameInput').value = '';
  };
}

// ── Import / Export Handlers ───────────────────────────────────────
function exportEdits() {
  const jsonStr = JSON.stringify(worldEdits, null, 2);
  const blob = new Blob([jsonStr], { type: 'application/json' });
  const url = URL.createObjectURL(blob);

  const a = document.createElement('a');
  a.href = url; a.download = 'world_edits.json';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function importEditsJson(text) {
  try {
    const src = JSON.parse(text);
    worldEdits.map = src.map || {};
    worldEdits.spawns = src.spawns || [];
    worldEdits.mobs = src.mobs || {};
    worldEdits.tiles = src.tiles || [];
    worldEdits.customMobs = src.customMobs || [];

    saveEdits();
    registerCustomDefs();
    rebuildActiveMap();
    initPalette();
    updateUIStats();
    showStatus('Imported world_edits.json successfully!', 'green');
  } catch (e) {
    alert('Invalid JSON file format!');
  }
}

function updateUIStats() {
  document.getElementById('statTileEdits').innerText = Object.keys(worldEdits.map).length;
  document.getElementById('statMobSpawns').innerText = worldEdits.spawns.length;
  document.getElementById('statCustomMobs').innerText = worldEdits.customMobs.length;
  document.getElementById('statCustomTiles').innerText = worldEdits.tiles.length;
}

function showStatus(msg, color) {
  const badge = document.getElementById('statusBadge');
  const text = document.getElementById('statusText');

  text.innerText = msg;
  badge.style.background = color === 'green' ? 'var(--accent-green)' : 'var(--accent-red)';
  badge.style.boxShadow = `0 0 6px ${badge.style.background}`;
}
