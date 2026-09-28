// caverock.mjs — the surface caves' rock mass (js/render/cave-rock.js).
//
// Pins the two ways it can go wrong without anyone seeing it in a screenshot:
// rock rising where there is no wall (a skin over open ground, or over a cave's
// floor), and a wall tile with no rock over it (a hole you can see the sky
// through, with collision still there).
//
// Usage: node tools/test/caverock.mjs   (or npm run test:caverock)
import { pathToFileURL } from 'node:url';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { buildCaveRock, CAVE_ROCK_SUB } from '../../js/render/cave-rock.js';

const VENDOR = 'C:/Users/Arnol/Desktop/Server Migration/ORION_GUILD_WEBSITE_WORKING_FOLDER/orion-platform/public/games/medieval/vendor';
if (!fs.existsSync(VENDOR + '/three.module.js')) { console.error('SKIP: vendored three not found at ' + VENDOR); process.exit(0); }
const tmp = path.join(os.tmpdir(), 'bravo-caverock-test');
fs.mkdirSync(tmp, { recursive: true });
fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}');
fs.copyFileSync(VENDOR + '/three.module.js', path.join(tmp, 'three.module.js'));
const THREE = await import(pathToFileURL(path.join(tmp, 'three.module.js')).href);

let fail = 0, checked = 0;
const check = (name, cond, detail) => { checked++; if (!cond) { console.log('  FAIL  ' + name + (detail ? ' — ' + detail : '')); fail++; } };

const TILE = 48, H = 84;
// A ring of cave wall around a 4x4 floor, plus a diagonal staircase arm.
const walls = new Set();
for (let y = 10; y <= 17; y++) for (let x = 10; x <= 17; x++) if (x < 12 || x > 15 || y < 12 || y > 15) walls.add(x + ',' + y);
for (let k = 0; k < 6; k++) { walls.add((18 + k) + ',' + (10 + k)); walls.add((19 + k) + ',' + (10 + k)); }
const tiles = [...walls].map(k => k.split(',').map(Number));
const ground = (x, z) => Math.sin(x * 0.01) * 5;
const noise = (x, y) => (Math.sin(x * 12.9898 + y * 78.233) * 0.5 + 0.5);
const geo = buildCaveRock(THREE, { tiles, TILE, height: H, groundAt: ground, noise, ridged: noise,
  isWall: (tx, ty) => walls.has(tx + ',' + ty) });

check('a geometry is built', !!geo);
const p = geo.attributes.position.array;
check('no NaN', !p.some(Number.isNaN));
// Every wall tile's centre is covered by rock standing well above the ground.
const tops = new Map();
for (let i = 0; i < p.length; i += 3) {
  const k = Math.floor(p[i] / TILE) + ',' + Math.floor(p[i + 2] / TILE);
  tops.set(k, Math.max(tops.get(k) ?? -1e9, p[i + 1] - ground(p[i], p[i + 2])));
}
let low = 0;
for (const k of walls) if (!(tops.get(k) > H * 0.5)) low++;
check('every wall tile stands at least half the wall height', low === 0, low + ' tiles');
// The cave floor (and open ground one tile clear of any wall) never has rock above it.
let skin = 0;
for (let i = 0; i < p.length; i += 3) {
  const fx = p[i] / TILE, fy = p[i + 2] / TILE, tx = Math.floor(fx), ty = Math.floor(fy);
  let nearWall = false;
  for (let oy = -1; oy <= 1 && !nearWall; oy++) for (let ox = -1; ox <= 1; ox++) if (walls.has((tx + ox) + ',' + (ty + oy))) { nearWall = true; break; }
  // well inside the floor: at least 0.9 tile from every wall tile's edge
  const floorCore = fx > 12.9 && fx < 15.1 && fy > 12.9 && fy < 15.1;
  if ((floorCore || !nearWall) && p[i + 1] > ground(p[i], p[i + 2]) + 1) skin++;
}
check('no rock rises over the cave floor or open ground', skin === 0, skin + ' vertices');
check('the grid is ' + CAVE_ROCK_SUB + ' samples per tile', CAVE_ROCK_SUB >= 2);

console.log('\n' + checked + ' checks, ' + fail + ' failure' + (fail === 1 ? '' : 's'));
process.exit(fail ? 1 : 0);
