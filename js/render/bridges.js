// bridges.js — timber bridges over the rivers, built as structures.
//
// Round 1 drew every BRIDGE tile as its own flat plank box at y=2.5 with a
// thin rail on any edge facing water. Then the rivers were widened by three
// tiles a bank at boot (game3d "Widen the rivers"), and the widening skipped
// bridges — so every bridge became a small raft stranded mid-river, with the
// road ending at the bank and a swim to reach it. The owner: "remake the
// bridges across the water".
//
// This does three things:
//
//   PLAN   — group BRIDGE tiles into spans, find which way each one crosses
//            (the side its ORIGINAL ends touched dry land), and extend it over
//            the widened water until every column lands on dry ground.
//   DECK   — a gentle arch from bank to bank. deckAt() is the walkable height,
//            wrapped into game3d's heightAt, so feet, NPCs and dropped items
//            follow the planks. The ramps start at the centre of the landing
//            tiles, where the deck meets the ground exactly — no step.
//   BUILD  — one geometry per material for every bridge: cross planks with
//            gaps and jitter on three stringers, trestle bents (posts, cap
//            beam, X-bracing) standing in the river bed, stone abutments on
//            both banks, and railings with posts, mid and top rails and
//            heavier newel posts at the ends. Timber and stone below the
//            waterline are darkened. The railings come back as point
//            colliders, so you can't walk off the side into the river.
//
// Pure geometry and planning: no scene, no game state.

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6D2B79F5) >>> 0; let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ── PLAN ─────────────────────────────────────────────────────────────
// Spans of BRIDGE tiles. `axisMap` decides which way each crosses: the map as
// it was BEFORE the rivers were widened, when a bridge's ends still touched
// the road. (Afterwards both ends and both sides are water.)
//   span = { axis:'x'|'y', a0, a1, c0, c1 }   a = along (tiles), c = across
export function findBridgeSpans(map, T, axisMap = map) {
  const H = map.length, W = map[0].length, seen = new Uint8Array(W * H), spans = [];
  const wetT = t => t === T.WATER || t === T.BRIDGE || t === T.SHALLOWS;
  const dry = (y, x) => { const r = axisMap[y]; const t = r && r[x]; return t !== undefined && !wetT(t); };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    if (map[y][x] !== T.BRIDGE || seen[y * W + x]) continue;
    const st = [[x, y]]; seen[y * W + x] = 1;
    let x0 = x, x1 = x, y0 = y, y1 = y, ns = 0, ew = 0;
    while (st.length) {
      const [cx, cy] = st.pop();
      x0 = Math.min(x0, cx); x1 = Math.max(x1, cx); y0 = Math.min(y0, cy); y1 = Math.max(y1, cy);
      if (dry(cy - 1, cx) || dry(cy + 1, cx)) ns++;
      if (dry(cy, cx - 1) || dry(cy, cx + 1)) ew++;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H || seen[ny * W + nx] || map[ny][nx] !== T.BRIDGE) continue;
        seen[ny * W + nx] = 1; st.push([nx, ny]);
      }
    }
    // No dry neighbour anywhere (a bridge entirely inside water): the longer
    // side is the one you walk along.
    const axis = ns !== ew ? (ns > ew ? 'y' : 'x') : ((y1 - y0) >= (x1 - x0) ? 'y' : 'x');
    spans.push(axis === 'y' ? { axis, a0: y0, a1: y1, c0: x0, c1: x1 } : { axis, a0: x0, a1: x1, c0: y0, c1: y1 });
  }
  return spans;
}

// Tile at (along, across) in a span's frame.
const tileOf = (map, sp, a, c) => { const r = sp.axis === 'y' ? map[a] : map[c]; return r ? r[sp.axis === 'y' ? c : a] : undefined; };
const setTile = (map, sp, a, c, t) => { if (sp.axis === 'y') map[a][c] = t; else map[c][a] = t; };

// Extend each span over open water until every column reaches dry ground on
// both ends. Only WATER becomes BRIDGE; any land inside the new rectangle (one
// column met the bank sooner than its neighbour) stays land and the deck
// simply passes over it. A span that runs `maxReach` tiles without finding
// land on some column is left at that end as it was (it's going along a
// river, not across it). Returns the number of tiles converted.
export function extendBridgeSpans(map, T, spans, { maxReach = 12, minWidth = 3 } = {}) {
  let n = 0;
  for (const sp of spans) {
    // A one-tile footbridge is 48 wide, and between two railings a 13-radius
    // player barely fits: give it a second column over the water.
    if (sp.c1 === sp.c0) {
      for (const c of [sp.c0 + 1, sp.c0 - 1]) {
        let wet = 0;
        for (let a = sp.a0; a <= sp.a1; a++) { const t = tileOf(map, sp, a, c); if (t === T.WATER || t === T.SHALLOWS || t === T.BRIDGE) wet++; }
        if (wet < sp.a1 - sp.a0 + 1) continue;
        for (let a = sp.a0; a <= sp.a1; a++) if (tileOf(map, sp, a, c) !== T.BRIDGE) { setTile(map, sp, a, c, T.BRIDGE); n++; }
        if (c > sp.c0) sp.c1 = c; else sp.c0 = c;
        break;
      }
    }
    for (const dir of [-1, 1]) {
      let reach = 0, ok = true;
      for (let c = sp.c0; c <= sp.c1 && ok; c++) {
        let k = 0, a = dir < 0 ? sp.a0 - 1 : sp.a1 + 1;
        while (tileOf(map, sp, a, c) === T.WATER || tileOf(map, sp, a, c) === T.SHALLOWS) {
          if (++k > maxReach) { ok = false; break; }
          a += dir;
        }
        if (tileOf(map, sp, a, c) === undefined) ok = false;
        reach = Math.max(reach, k);
      }
      if (!ok || !reach) continue;
      for (let k = 1; k <= reach; k++) {
        const a = dir < 0 ? sp.a0 - k : sp.a1 + k;
        for (let c = sp.c0; c <= sp.c1; c++) {
          const t = tileOf(map, sp, a, c);
          if (t === T.WATER || t === T.SHALLOWS) { setTile(map, sp, a, c, T.BRIDGE); n++; }
        }
      }
      if (dir < 0) sp.a0 -= reach; else sp.a1 += reach;
    }
    // ...and at least `minWidth` wide (v0.24, owner: "the new bridges look
    // great... but can be much bigger in scale" — ×1.5, two tiles to three).
    // A column is added on whichever side has more water under it; land the
    // new column crosses stays land and the deck passes over it.
    for (let guard = 0; sp.c1 - sp.c0 + 1 < minWidth && guard < 4; guard++) {
      const wetIn = c => { let w = 0; for (let a = sp.a0; a <= sp.a1; a++) { const t = tileOf(map, sp, a, c); if (t === T.WATER || t === T.SHALLOWS || t === T.BRIDGE) w++; } return w; };
      const lo = sp.c0 - 1, hi = sp.c1 + 1, wl = wetIn(lo), wh = wetIn(hi);
      const c = wh >= wl ? hi : lo;
      if (!wetIn(c)) break;
      for (let a = sp.a0; a <= sp.a1; a++) {
        const t = tileOf(map, sp, a, c);
        if (t === T.WATER || t === T.SHALLOWS) { setTile(map, sp, a, c, T.BRIDGE); n++; }
      }
      if (c > sp.c1) sp.c1 = c; else sp.c0 = c;
    }
    // The road meets the bridge: the landing tiles at each end are paved, so a
    // bridge never sets down in a meadow beside the road it serves.
    // Trees and boulders anywhere on the footprint (ramps, and land the deck
    // passes over) are cleared too — trunks came up through a deck (critic r1).
    // (a pad a column wider than the deck and three tiles out: the ×1.5
    //  bridges set down in open grass, critic r3)
    if (T.PATH !== undefined) for (let a = sp.a0 - 3; a <= sp.a1 + 3; a++) for (let c = sp.c0 - 1; c <= sp.c1 + 1; c++) {
      const t = tileOf(map, sp, a, c), end = a < sp.a0 || a > sp.a1, deck = c >= sp.c0 && c <= sp.c1;
      if ((end && t === T.GRASS) || (deck && (t === T.TREE || t === T.STONE)) || (end && (t === T.TREE || t === T.STONE))) setTile(map, sp, a, c, T.PATH);
    }
    // ...and beside it: a tree one column off still put its canopy over the
    // rail and its trunk in the river next to the posts.
    // (three columns: trees are drawn jittered off their tile and a canopy is
    // wide — one column off still hid an end newel, critic r2)
    if (T.TREE !== undefined) for (let a = sp.a0 - 5; a <= sp.a1 + 5; a++) for (const c of [sp.c0 - 3, sp.c0 - 2, sp.c0 - 1, sp.c1 + 1, sp.c1 + 2, sp.c1 + 3]) {
      const t = tileOf(map, sp, a, c);
      if (t === T.TREE || t === T.STONE) setTile(map, sp, a, c, a >= sp.a0 && a <= sp.a1 ? T.WATER : T.GRASS);
    }
    // ...and a clear ring four tiles round each end: a grove on the bank still
    // reached the landing, trunks against the rail (critic r4)
    if (T.TREE !== undefined) for (const [ae, dir] of [[sp.a0 - 1, -1], [sp.a1 + 1, 1]])
      for (let k = 0; k <= 5; k++) for (let c = sp.c0 - 4; c <= sp.c1 + 4; c++) {
        const a = ae + dir * k, t = tileOf(map, sp, a, c);
        if (t === T.TREE || t === T.STONE) setTile(map, sp, a, c, T.GRASS);
      }
  }
  return n;
}

// ── DECK ─────────────────────────────────────────────────────────────
// Fill in each span's world frame and its arch. `groundAt` is the bare terrain
// (carved bed and all), never the wrapped heightAt that includes decks.
export const DECK_T = 4;           // plank thickness
export const RAMP_TILES = 1.5;     // the stone approach on each bank
export function shapeBridgeSpans(spans, { TILE, groundAt, waterY = 2 }) {
  for (const sp of spans) {
    const cc = (sp.c0 + sp.c1 + 1) / 2 * TILE;
    sp.hw = (sp.c1 - sp.c0 + 1) * TILE / 2; sp.cc = cc;
    // sA..sB is the water (the bank edges); S0..S1 adds a stone approach ramp
    // on each bank. The banks by a river sit at or BELOW the water surface
    // (the flattening and the carved bed both pull them down), so a deck that
    // started at bank height ran its first half-tile under the water — it read
    // as a pale ghost block. The ramps lift it clear before it leaves land.
    sp.sA = sp.a0 * TILE; sp.sB = (sp.a1 + 1) * TILE;
    sp.S0 = sp.sA - RAMP_TILES * TILE; sp.S1 = sp.sB + RAMP_TILES * TILE;
    const at = (s) => sp.axis === 'y' ? groundAt(cc, s) : groundAt(s, cc);
    sp.yA = at(sp.S0); sp.yB = at(sp.S1);
    sp.eA = Math.max(sp.yA, waterY + 12); sp.eB = Math.max(sp.yB, waterY + 12);
    const tiles = sp.a1 - sp.a0 + 1;
    sp.arch = Math.min(52, 9 + tiles * 3.9);          // (×1.5 with the wider decks, v0.24)
  }
  return spans;
}
const sstep = (t) => { t = Math.min(1, Math.max(0, t)); return t * t * (3 - 2 * t); };
export function deckY(sp, s) {
  if (s <= sp.sA) return sp.yA + (sp.eA - sp.yA) * sstep((s - sp.S0) / (sp.sA - sp.S0));
  if (s >= sp.sB) return sp.yB + (sp.eB - sp.yB) * sstep((sp.S1 - s) / (sp.S1 - sp.sB));
  const v = (s - sp.sA) / (sp.sB - sp.sA);
  return sp.eA + (sp.eB - sp.eA) * v + sp.arch * Math.sin(Math.PI * v);
}
// A lookup from world position to deck height (null off every deck). One
// Int16 per tile marks which span covers it, so the test is cheap enough for
// heightAt, which runs for every blade of grass.
export function makeDeckLookup(spans, { TILE, W, H }) {
  const idx = new Int16Array(W * H);
  spans.forEach((sp, i) => {
    const r = Math.ceil(RAMP_TILES);
    for (let a = sp.a0 - r; a <= sp.a1 + r; a++) for (let c = sp.c0; c <= sp.c1; c++) {
      const x = sp.axis === 'y' ? c : a, y = sp.axis === 'y' ? a : c;
      if (x >= 0 && y >= 0 && x < W && y < H) idx[y * W + x] = i + 1;
    }
  });
  return function deckAt(wx, wz) {
    const tx = Math.floor(wx / TILE), ty = Math.floor(wz / TILE);
    if (tx < 0 || ty < 0 || tx >= W || ty >= H) return null;
    const k = idx[ty * W + tx]; if (!k) return null;
    const sp = spans[k - 1], s = sp.axis === 'y' ? wz : wx, c = sp.axis === 'y' ? wx : wz;
    if (s < sp.S0 || s > sp.S1 || Math.abs(c - sp.cc) > sp.hw) return null;
    return deckY(sp, s);
  };
}

// ── BUILD ────────────────────────────────────────────────────────────
// Geometry accumulator: hexahedra from 8 corners, per-face UVs along the
// face's own edges (so wood grain runs down every beam), vertex colour with
// a wet band at and below the waterline.
export class Acc {      // (also used by render/cave-mouth.js)
  constructor(uvScale, waterY) { this.p = []; this.n = []; this.u = []; this.c = []; this.i = []; this.s = uvScale; this.wy = waterY; }
  // v: [b0,b1,b2,b3,t0,t1,t2,t3], each [x,y,z]; bottom and top in the same order.
  hex(v, col) {
    const F = [[0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7], [4, 5, 6, 7], [3, 2, 1, 0]];
    // centre, to point every face's normal outward whatever the corner order
    const m = [0, 0, 0]; for (const p of v) { m[0] += p[0] / 8; m[1] += p[1] / 8; m[2] += p[2] / 8; }
    for (const f of F) {
      let [a, b, c, d] = f.map(k => v[k]);
      const e1 = sub(c, a), e2 = sub(d, b);
      let n = norm(cross(e1, e2));
      const fc = [(a[0] + b[0] + c[0] + d[0]) / 4, (a[1] + b[1] + c[1] + d[1]) / 4, (a[2] + b[2] + c[2] + d[2]) / 4];
      if (dot(n, sub(fc, m)) < 0) { n = [-n[0], -n[1], -n[2]]; const t = b; b = d; d = t; }
      // u along the face's longer edge pair, v across it
      const ab = sub(b, a), ad = sub(d, a);
      const uAx = norm(len(ab) >= len(ad) ? ab : ad), vAx = norm(cross(n, uAx));
      const base = this.p.length / 3;
      for (const q of [a, b, c, d]) {
        this.p.push(q[0], q[1], q[2]); this.n.push(n[0], n[1], n[2]);
        this.u.push(dot(q, uAx) / this.s, dot(q, vAx) / this.s);
        // wet: darker and a little green from the waterline down, a soft band above it
        const w = Math.min(1, Math.max(0, (this.wy + 3 - q[1]) / 10));
        this.c.push(col[0] * (1 - 0.45 * w), col[1] * (1 - 0.38 * w), col[2] * (1 - 0.48 * w));
      }
      this.i.push(base, base + 1, base + 2, base, base + 2, base + 3);
    }
  }
  // An oriented box: centre, three unit axes, half sizes.
  box(o, ax, ay, az, hx, hy, hz, col) {
    const v = [];
    for (const sy of [-1, 1]) for (const [sx, sz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]])
      v.push([o[0] + ax[0] * hx * sx + ay[0] * hy * sy + az[0] * hz * sz,
              o[1] + ax[1] * hx * sx + ay[1] * hy * sy + az[1] * hz * sz,
              o[2] + ax[2] * hx * sx + ay[2] * hy * sy + az[2] * hz * sz]);
    this.hex(v, col);
  }
  // A beam from p to q (centre line), section w (horizontal) x h, `side` the
  // horizontal axis the width runs along.
  beam(p, q, w, h, side, col) {
    const ax = norm(sub(q, p)), l = len(sub(q, p));
    let ay = norm(cross(side, ax)); if (ay[1] < 0) ay = [-ay[0], -ay[1], -ay[2]];
    const az = norm(cross(ax, ay));
    this.box([(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, (p[2] + q[2]) / 2], ax, ay, az, l / 2, h / 2, w / 2, col);
  }
  geometry(THREE) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(this.u, 2));
    g.setAttribute('color', new THREE.Float32BufferAttribute(this.c, 3));
    g.setIndex(this.i);
    g.computeBoundingSphere();
    return g;
  }
}
const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a) => Math.hypot(a[0], a[1], a[2]);
const norm = (a) => { const l = len(a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };

// Linear colours (callers pass sRGB hex through THREE.Color for these).
// `solidAt(wx, wz)` — true where rock or masonry stands (the railing stops
// against it rather than running on inside the cliff).
export function buildBridges(THREE, spans, { TILE, groundAt, waterY = 2, colors, solidAt = () => false }) {
  const wood = new Acc(48, waterY), stone = new Acc(96, waterY), glow = new Acc(16, -1e9), colliders = [], lamps = [];
  const C = colors;
  spans.forEach((sp, si) => {
    const r = rng(0xB41D6E + si * 7919);
    const Y = sp.axis === 'y';
    // world point from (along s, across c, height y)
    const P = (s, c, y) => Y ? [sp.cc + c, y, s] : [s, y, sp.cc + c];
    const A = Y ? [0, 0, 1] : [1, 0, 0], Cx = Y ? [1, 0, 0] : [0, 0, 1];
    const hw = sp.hw, L = sp.S1 - sp.S0;
    const dy = (s) => deckY(sp, s);
    const tangent = (s) => { const e = 2; return norm([A[0] * 2 * e, dy(s + e) - dy(s - e), A[2] * 2 * e]); };
    const ground = (s, c) => { const p = P(s, c, 0); return groundAt(p[0], p[2]); };
    const tint = (col, k) => [col[0] * k, col[1] * k, col[2] * k];

    const hd = TILE * 0.35;          // how far each pier head reaches out over the water
    const pA = sp.sA + hd, pB = sp.sB - hd;
    const sy = DECK_T + 8;           // stringer centre below the deck top (the ×1.5 stringers are 15 deep)

    // APPROACH RAMPS: dressed stone from the landing up to the bank edge; its
    // top IS the walking surface (deckY), so nothing floats and nothing sinks.
    const ramp = (sa, sb) => {
      // (10 segments: the chords of 5 sagged below the curve, and the first
      // plank stood proud of the stone — critic r2)
      const ex = hw + 4, n = 10;
      for (let k = 0; k < n; k++) {
        const s0 = sa + (sb - sa) * k / n, s1 = sa + (sb - sa) * (k + 1) / n;
        const lo = Math.min(ground(s0, -ex), ground(s0, ex), ground(s1, -ex), ground(s1, ex)) - 30;
        const t0 = dy(s0), t1 = dy(s1);
        stone.hex([P(s0, -ex, lo), P(s0, ex, lo), P(s1, ex, lo), P(s1, -ex, lo),
                   P(s0, -ex, t0), P(s0, ex, t0), P(s1, ex, t1), P(s1, -ex, t1)], tint(C.stone, 0.95 + r() * 0.1));
        // a kerb along each edge, so the ramp reads as built, not a slab on the road
        for (const side of [-1, 1]) {
          const a = side * (hw - 1), b = side * (hw + 4.5);
          stone.hex([P(s0, a, t0 - 1), P(s0, b, t0 - 1), P(s1, b, t1 - 1), P(s1, a, t1 - 1),
                     P(s0, a, t0 + 3), P(s0, b, t0 + 3), P(s1, b, t1 + 3), P(s1, a, t1 + 3)], tint(C.kerb || C.stone, 0.95 + r() * 0.08));
        }
      }
    };
    // PIER HEADS: a heavier block at each bank edge the stringers bed on, down
    // into the river bed, with a coping course proud of it.
    const head = (sa, sb) => {
      // no wider than the ramp: a wider head showed its side faces as a grey
      // ghost through the shore foam (critic r2)
      const ex = hw + 4, lo = Math.min(ground(sa, 0), ground(sb, 0)) - 40;
      const t0 = dy(sa) - sy - 5, t1 = dy(sb) - sy - 5;
      stone.hex([P(sa, -ex, lo), P(sa, ex, lo), P(sb, ex, lo), P(sb, -ex, lo),
                 P(sa, -ex, t0), P(sa, ex, t0), P(sb, ex, t1), P(sb, -ex, t1)], tint(C.stone, 0.9));
      const e2 = ex + 3;
      stone.hex([P(sa - 2, -e2, t0 - 6), P(sa - 2, e2, t0 - 6), P(sb + 2, e2, t1 - 6), P(sb + 2, -e2, t1 - 6),
                 P(sa - 2, -e2, t0), P(sa - 2, e2, t0), P(sb + 2, e2, t1), P(sb + 2, -e2, t1)], tint(C.stone, 1.08));
    };
    ramp(sp.S0 - 6, sp.sA + 2); ramp(sp.sB - 2, sp.S1 + 6);
    head(sp.sA - 4, pA); head(pB, sp.sB + 4);

    // STRINGERS: three longitudinal beams under the planks, in segments that
    // follow the arch, bank edge to bank edge.
    // (a fourth and fifth under a deck three tiles wide: at 144 across, three
    //  left planks spanning 60 unsupported)
    for (const c of hw >= 70 ? [-(hw - 11), -(hw - 11) / 2, 0, (hw - 11) / 2, hw - 11] : [-(hw - 11), 0, hw - 11]) {
      if (c === 0 && hw < 40) continue;
      const seg = 24;
      for (let s = sp.sA - 4; s < sp.sB + 3; s += seg) {
        const s2 = Math.min(sp.sB + 4, s + seg);
        wood.beam(P(s, c, dy(s) - sy), P(s2, c, dy(s2) - sy), 13, 15, Cx, tint(C.beam, 0.95 + r() * 0.1));
      }
    }

    // PLANKS across the span, following the arch; gaps, and each a slightly
    // different length, tone and set. They lap a few units onto each ramp.
    // (12 with 1.5 gaps: at 9.4 the gaps broke into noisy striping at range)
    const pitch = 12;
    for (let s = sp.sA - 4 + pitch / 2; s < sp.sB + 4; s += pitch) {
      const t = tangent(s), up = norm(cross(t, Cx));
      const upv = up[1] < 0 ? [-up[0], -up[1], -up[2]] : up;
      const jl = (r() - 0.5) * 6, off = (r() - 0.5) * 3;
      // each set a little proud and a degree or so askew, so the ends catch
      // the light unevenly (flat stripes in first person — critic r3)
      const o = P(s, off, dy(s) - DECK_T / 2 + 0.2 + r() * 0.6);
      const yaw = (r() - 0.5) * 0.05, ax = norm([Cx[0] + A[0] * yaw, 0, Cx[2] + A[2] * yaw]);
      let az = norm(cross(ax, upv)); if (dot(az, t) < 0) az = [-az[0], -az[1], -az[2]];
      wood.box(o, ax, upv, az, hw - 2 + jl / 2, DECK_T / 2, pitch / 2 - 0.75, tint(C.plank, 0.88 + r() * 0.18));
    }

    // TRESTLE BENTS in the river: posts from the bed to the stringers, a cap
    // beam across, and X-bracing above the water.
    // evenly between the pier heads, none closer than ~1.4 tiles to one
    const nb = Math.max(1, Math.round((pB - pA) / (TILE * 1.9)));
    for (let k = 1; k < nb; k++) {
      const s = pA + (pB - pA) * k / nb;
      const capY = dy(s) - sy - 8 - 7;
      const posts = hw >= 70 ? [-(hw - 9), -(hw - 9) / 3, (hw - 9) / 3, hw - 9] : hw >= 40 ? [-(hw - 9), 0, hw - 9] : [-(hw - 8), hw - 8];
      for (const c of posts) {
        const g = ground(s, c) - 14;
        wood.box(P(s, c, (g + capY) / 2), Cx, [0, 1, 0], A, 7.5, (capY - g) / 2, 7.5, tint(C.post, 0.9 + r() * 0.15));
      }
      wood.beam(P(s, -(hw + 16), capY), P(s, hw + 16, capY), 15, 13, A, tint(C.beam, 1));
      // braces: between the outer posts, from just above the water to the cap
      const lo = Math.max(waterY + 8, Math.max(ground(s, -(hw - 7)), ground(s, hw - 7)) + 4);
      if (capY - lo > 16) {
        wood.beam(P(s + 4, -(hw - 9), lo), P(s + 4, hw - 9, capY - 8), 6, 9, A, tint(C.beam, 0.9));
        wood.beam(P(s - 4, hw - 9, lo), P(s - 4, -(hw - 9), capY - 8), 6, 9, A, tint(C.beam, 0.9));
      }
      // knee braces from the outer posts up to the outer stringers, both ways:
      // they show at every range where the X-bracing is below the eye (critic r3)
      for (const c of [-(hw - 11), hw - 11]) for (const d of [-1, 1]) {
        const k0 = P(s, c, capY - 27), s2 = s + d * 27;
        if (capY - 27 < waterY + 2) continue;
        wood.beam(k0, P(s2, c, dy(s2) - sy - 6), 6.5, 7.5, Cx, tint(C.beam, 0.92));
      }
    }

    // RAILINGS: posts every ~44, a mid rail and a top rail on each side; big
    // newel posts at the four corners. Colliders along each side.
    const rc = hw - 4, postH = 54;                 // (×1.5, v0.24: waist-high on a 126 character)
    const np = Math.max(2, Math.round((L - 20) / 60));
    for (const side of [-1, 1]) {
      const c = side * rc;
      let prev = null;
      const inRock = (s) => { const q = P(s, side * (hw + 10), 0); const q2 = P(s, side * (hw - 3), 0);
        return solidAt(q[0], q[2]) || solidAt(q2[0], q2[2]); };
      for (let k = 0; k <= np; k++) {
        const s = sp.S0 + 10 + (L - 20) * k / np;
        if (inRock(s)) { prev = null; continue; }
        const newel = k === 0 || k === np || inRock(sp.S0 + 10 + (L - 20) * (k - 1) / np) || inRock(sp.S0 + 10 + (L - 20) * (k + 1) / np);
        const base = dy(s) - DECK_T - 6, h = newel ? postH + 10 : postH;
        const hs = newel ? 9.5 : 5.2;
        wood.box(P(s, c, base + (h + 6) / 2), Cx, [0, 1, 0], A, hs, (h + 6) / 2, hs, tint(C.post, 0.95 + r() * 0.12));
        if (newel) wood.box(P(s, c, base + h + 6 + 3), Cx, [0, 1, 0], A, hs + 2, 3, hs + 2, tint(C.post, 1.1));
        // a lantern on one newel at each bank, on opposite corners: it marks
        // the crossing after dark (the bridge vanished at night — critic r3)
        if ((side === 1 && k === 0) || (side === -1 && k === np)) {
          const ly = base + h + 6 + 4;
          wood.box(P(s, c, ly + 1.5), Cx, [0, 1, 0], A, 4.2, 1.5, 4.2, tint(C.beam, 0.8));          // base plate
          glow.box(P(s, c, ly + 8), Cx, [0, 1, 0], A, 3.2, 5, 3.2, C.lamp || [1, 0.7, 0.35]);      // glass
          for (const [ox, oz] of [[-1, -1], [1, -1], [1, 1], [-1, 1]])                              // corner bars
            wood.box(P(s + oz * 3.4, c + ox * 3.4, ly + 8), Cx, [0, 1, 0], A, 0.7, 5.2, 0.7, tint(C.beam, 0.6));
          wood.box(P(s, c, ly + 14), Cx, [0, 1, 0], A, 4.8, 1.4, 4.8, tint(C.beam, 0.7));          // roof
          wood.box(P(s, c, ly + 16.5), Cx, [0, 1, 0], A, 1.6, 1.2, 1.6, tint(C.beam, 0.7));         // finial
          const q = P(s, c, ly + 8); lamps.push({ x: q[0], y: q[1], z: q[2] });
        }
        const top = P(s, c, dy(s) + postH - 4), midr = P(s, c, dy(s) + 24);
        if (prev) {
          wood.beam(prev.top, top, 7.5, 7, Cx, tint(C.rail, 0.95 + r() * 0.1));
          wood.beam(prev.mid, midr, 5, 5.5, Cx, tint(C.rail, 0.9));
        }
        prev = { top, mid: midr };
      }
      // at the deck's edge, small: 4 + the player's 13, 15 apart, leaves no gap
      for (let s = sp.S0 + 6; s <= sp.S1 - 6; s += 15) {
        const p = P(s, side * (hw + 1), 0);
        colliders.push({ x: p[0], y: p[2], r: 4 });
      }
    }
  });
  return { wood: wood.geometry(THREE), stone: stone.geometry(THREE), glow: glow.geometry(THREE), colliders, lamps };
}
