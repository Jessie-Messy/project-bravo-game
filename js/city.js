// city.js — Lunar City: the ONE source of truth for its layout.
//
// v0.24 ("the bigger world"). The owner play-tested the old city — a 61×61
// walled square whose houses were 5×5 tiles, a 3×3 room inside for a
// 126-tall character — and asked for it ×2.5, with the map grown to fit
// (it moved east, into the new strip; see MAIN_W in constants.js).
//
// Every coordinate here is RELATIVE to the city centre and exported resolved,
// so world.js (the tiles), game3d.js (NPCs, signs, the flatten zone, the
// minimap), state.js (shopkeepers) and the server (safe zone, default spawn)
// all read the same plan. A position typed anywhere else is how the old
// layout's shopkeepers ended up hard-coded in four files.
//
// Plan (tiles, relative to the centre, y grows south):
//   outer wall     ±76, 3 thick; 7×7 corner towers; 7-wide gates N/S/W/E
//   ring road      3 wide, centred 10 in from the outer wall
//   avenues        5 wide, from each gate to the keep
//   keep (inner)   ±36, 5 thick; 7-wide entrances on all four sides
//   bank           23×17 in the middle of the keep, doors S (5)
//   shops          four 13×13 in the keep's corners, doors facing the bank
//   houses         13×13 between the keep and the ring road: the healer, the
//                  four artifact traders and the fletcher each keep a house
//                  (they stood about the old courtyard), the rest are homes
//
// Buildings keep 1-tile walls: at 48 units a tile they are already a stout
// wall, and collision is per tile.

import { T } from './constants.js';

// Centre and half-size. The east strip is x 480–679 (ridge from 675); the
// rivers there bend around the city (world.js, eastStrip), so it can span
// y 214–366 between them.
export const CITY_C = { x: 586, y: 290 };
export const CITY_HALF = 76;
const S = CITY_HALF;
const at = (rx, ry) => ({ x: CITY_C.x + rx, y: CITY_C.y + ry });

export const CITY_RECT = { x1: CITY_C.x - S, y1: CITY_C.y - S, x2: CITY_C.x + S, y2: CITY_C.y + S };

export const OUTER_T = 3, TOWER = 7, GATE_W = 7;
export const RING_IN = 10, ROAD_W = 3, AVENUE_W = 5;
export const KEEP_HALF = 36, KEEP_T = 5;

// Buildings: [rx0, ry0, w, h, doorSide, doorOffset, doorWidth, role]
// (rx0, ry0 = top-left, relative). Door offset is along the door's wall from
// that wall's left/top end.
const B = [
  // bank, centre of the keep
  [-11, -8, 23, 17, 's', 9, 5, 'bank'],
  // keep corner shops, doors facing the bank
  [-30, -30, 13, 13, 'e', 5, 3, 'merchant'],     // NW
  [ 17, -30, 13, 13, 'w', 5, 3, 'blacksmith'],   // NE
  [-30,  17, 13, 13, 'e', 5, 3, 'mage'],         // SW
  [ 17,  17, 13, 13, 'w', 5, 3, 'farrier'],      // SE
  // between the keep and the ring road
  [  6, -60, 13, 13, 'w', 5, 3, 'healer'],       // north avenue, east side
  [-19, -60, 13, 13, 'e', 5, 3, 'antiquarian'],  // north avenue, west side
  [-45, -60, 13, 13, 'n', 5, 3, 'home'],         // (outer homes face the ring road)
  [ 32, -60, 13, 13, 'n', 5, 3, 'curator'],
  [  6,  47, 13, 13, 'w', 5, 3, 'fletcher'],     // south avenue
  [-19,  47, 13, 13, 'e', 5, 3, 'cryptologist'],
  [-45,  47, 13, 13, 's', 5, 3, 'home'],
  [ 32,  47, 13, 13, 's', 5, 3, 'grave_robber'],
  [-60, -30, 13, 13, 'w', 5, 3, 'home'],         // west side
  [-60,  17, 13, 13, 'w', 5, 3, 'home'],
  [ 47, -30, 13, 13, 'e', 5, 3, 'home'],         // east side
  [ 47,  17, 13, 13, 'e', 5, 3, 'home'],
];
export const CITY_BUILDINGS = B.map(([rx, ry, w, h, side, off, dw, role]) => {
  const x0 = CITY_C.x + rx, y0 = CITY_C.y + ry, x1 = x0 + w - 1, y1 = y0 + h - 1;
  // the door tiles, and the tile just OUTSIDE the middle of the door
  const door = [];
  for (let k = 0; k < dw; k++) {
    if (side === 'n') door.push({ x: x0 + off + k, y: y0 });
    if (side === 's') door.push({ x: x0 + off + k, y: y1 });
    if (side === 'w') door.push({ x: x0, y: y0 + off + k });
    if (side === 'e') door.push({ x: x1, y: y0 + off + k });
  }
  const mid = door[dw >> 1];
  const out = { x: mid.x + (side === 'w' ? -1 : side === 'e' ? 1 : 0), y: mid.y + (side === 'n' ? -1 : side === 's' ? 1 : 0) };
  const inside = { x: mid.x - (out.x - mid.x) * 2, y: mid.y - (out.y - mid.y) * 2 };
  return { role, x0, y0, x1, y1, w, h, side, door, doorOut: out, doorIn: inside,
           centre: { x: x0 + (w >> 1), y: y0 + (h >> 1) } };
});
export const cityBuilding = (role) => CITY_BUILDINGS.find(b => b.role === role);

// Where things stand (tiles). The shopkeeper stands inside, behind where the
// counter goes, facing the door; the banker behind the bank's south door.
const inFrom = (b, d) => ({ x: b.doorIn.x + (b.doorIn.x - b.doorOut.x) * d, y: b.doorIn.y + (b.doorIn.y - b.doorOut.y) * d });
export const CITY_SPOTS = {
  merchant:   inFrom(cityBuilding('merchant'), 2),
  blacksmith: inFrom(cityBuilding('blacksmith'), 2),
  mage:       inFrom(cityBuilding('mage'), 2),
  farrier:    inFrom(cityBuilding('farrier'), 2),
  healer:     inFrom(cityBuilding('healer'), 2),
  banker:     inFrom(cityBuilding('bank'), 3),
  antiquarian:  inFrom(cityBuilding('antiquarian'), 2),
  cryptologist: inFrom(cityBuilding('cryptologist'), 2),
  curator:      inFrom(cityBuilding('curator'), 2),
  grave_robber: inFrom(cityBuilding('grave_robber'), 2),
  fletcher:     inFrom(cityBuilding('fletcher'), 2),
  // the jester performs in the courtyard, by the bank's south door
  jester:     at(-7, 12),
  // the default spawn and respawn point: the keep's courtyard, south of the bank
  spawn:      at(0, 13),
  // the contract board, beside the spawn
  contracts:  at(6, 13),
  // arriving from the dungeon's city exit: the courtyard, north-west of the bank
  arrival:    at(-14, -14),
  // the gate to the Saltmere coast: the south-west quarter, off the ring road
  coastGate:  at(-55, 55),
};

/** Carve the city into `map` (rows of tile ids). Clears the whole footprint first. */
export function buildCity(map) {
  const { x1: X1, y1: Y1, x2: X2, y2: Y2 } = CITY_RECT, CX = CITY_C.x, CY = CITY_C.y;
  const set = (x, y, t) => { if (map[y] && map[y][x] !== undefined) map[y][x] = t; };
  const rect = (x0, y0, x1, y1, t) => { for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) set(x, y, t); };

  rect(X1, Y1, X2, Y2, T.GRASS);
  // outer wall, 3 thick, and 7×7 corner towers
  rect(X1, Y1, X2, Y1 + OUTER_T - 1, T.WALL); rect(X1, Y2 - OUTER_T + 1, X2, Y2, T.WALL);
  rect(X1, Y1, X1 + OUTER_T - 1, Y2, T.WALL); rect(X2 - OUTER_T + 1, Y1, X2, Y2, T.WALL);
  for (const [tx, ty] of [[X1, Y1], [X2 - TOWER + 1, Y1], [X1, Y2 - TOWER + 1], [X2 - TOWER + 1, Y2 - TOWER + 1]])
    rect(tx, ty, tx + TOWER - 1, ty + TOWER - 1, T.WALL);
  const g = GATE_W >> 1, a = AVENUE_W >> 1, r = ROAD_W >> 1;
  // ring road
  const RI = S - RING_IN;
  rect(CX - RI - r, CY - RI - r, CX + RI + r, CY - RI + r, T.PATH);
  rect(CX - RI - r, CY + RI - r, CX + RI + r, CY + RI + r, T.PATH);
  rect(CX - RI - r, CY - RI - r, CX - RI + r, CY + RI + r, T.PATH);
  rect(CX + RI - r, CY - RI - r, CX + RI + r, CY + RI + r, T.PATH);
  // avenues: gate to keep, all four sides (through the gates, 7 wide in the wall)
  rect(CX - a, Y1, CX + a, CY - KEEP_HALF, T.PATH); rect(CX - a, CY + KEEP_HALF, CX + a, Y2, T.PATH);
  rect(X1, CY - a, CX - KEEP_HALF, CY + a, T.PATH); rect(CX + KEEP_HALF, CY - a, X2, CY + a, T.PATH);
  rect(CX - g, Y1, CX + g, Y1 + OUTER_T - 1, T.PATH); rect(CX - g, Y2 - OUTER_T + 1, CX + g, Y2, T.PATH);
  rect(X1, CY - g, X1 + OUTER_T - 1, CY + g, T.PATH); rect(X2 - OUTER_T + 1, CY - g, X2, CY + g, T.PATH);
  // the keep: a 5-thick ring with 7-wide entrances, a paved courtyard inside
  const K = KEEP_HALF;
  rect(CX - K, CY - K, CX + K, CY + K, T.WALL);
  rect(CX - K + KEEP_T, CY - K + KEEP_T, CX + K - KEEP_T, CY + K - KEEP_T, T.PATH);
  rect(CX - g, CY - K, CX + g, CY - K + KEEP_T - 1, T.PATH); rect(CX - g, CY + K - KEEP_T + 1, CX + g, CY + K, T.PATH);
  rect(CX - K, CY - g, CX - K + KEEP_T - 1, CY + g, T.PATH); rect(CX + K - KEEP_T + 1, CY - g, CX + K, CY + g, T.PATH);
  // buildings: 1-tile walls, a paved floor, the door(s)
  for (const b of CITY_BUILDINGS) {
    rect(b.x0, b.y0, b.x1, b.y1, T.WALL);
    rect(b.x0 + 1, b.y0 + 1, b.x1 - 1, b.y1 - 1, T.PATH);
    for (const d of b.door) set(d.x, d.y, T.PATH);
    set(b.doorOut.x, b.doorOut.y, T.PATH);
    // (The bank had a small north door too. In line with the south doors it cut
    // the wall ring in two, and the builder drew two houses side by side.)
  }
  // a path from each door to the nearest road, so no house opens onto turf
  for (const b of CITY_BUILDINGS) {
    let { x, y } = b.doorOut; const dx = b.doorOut.x - b.door[0].x, dy = b.doorOut.y - b.door[0].y;
    for (let k = 0; k < 40; k++) {
      const t = map[y] && map[y][x];
      if (t === undefined || t === T.WALL || (k > 0 && t === T.PATH)) break;
      set(x, y, T.PATH); x += dx; y += dy;
    }
  }
}
