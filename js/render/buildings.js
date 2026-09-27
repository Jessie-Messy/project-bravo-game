// buildings.js — procedural medieval buildings, built as architecture.
//
// Round 1 drew every wall TILE as its own textured box: per-tile wallpaper
// framing, paper-thin roofs whose gables stopped short of the ridge, windows as
// black stickers, and doors lower than the people using them. The owner called
// it "meh". This builds each building ONCE, from its footprint, to a written
// spec (critic round 2, 2026-09-26):
//
//   SCALE — a character is 126 tall. Plinth to 24, doors 150, a storey ~126.
//   TYPES — A: one storey + loft (eaves 160). B: stone ground storey + jettied
//           timber-framed upper (150-265, jetty 12). C: the bank — B, bigger.
//           HUT: Saltmere's — tarred weatherboard and reed thatch.
//   FRAMING — real 3D beams proud of the plaster: 12x12 corner posts, studs
//           every ~34 across the whole facade (never per tile), sill and head
//           plates, a mid rail, braces from the corners and beside doors.
//   OPENINGS — framed, recessed windows with sills, leaded glass, shutters on
//           some; doors 48 x 150 with a head beam, the plank leaf open against
//           the inner reveal, a threshold stone.
//   ROOF — 50-58 deg, 8 thick, 20 eave / 14 verge overhang, fascia, barge
//           boards, ridge cap, gables closed to the ridge with king post and
//           collar, moss toward the eaves, a stone chimney on the ridge.
//   GROUND — sits on the HIGHEST ground under it; plinth runs 40 below the
//           lowest; a soft contact shadow.
//
// Everything merges into one geometry per material (a handful of draw calls
// for the whole town). Pieces that belong to the roof and upper storey carry a
// per-vertex building id so the roof can be lifted off while the player is
// inside, in the vertex shader. Collision is per tile and is not touched: the
// walls stay a full tile thick.
//
// Pure geometry: no scene, no game state. game3d.js calls buildTown().

function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6D2B79F5) >>> 0; let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// A geometry accumulator with world-space planar UVs, vertex colour and a
// per-vertex building id (-1 = never hidden).
class Acc {
  constructor(uvScale = 64) { this.p = []; this.n = []; this.u = []; this.c = []; this.b = []; this.i = []; this.uvs = uvScale; }
  quad(a, b, c, d, nrm, col, bid = -1) {
    // Winding follows the given normal, so callers never have to think about it.
    const e1 = [b[0]-a[0], b[1]-a[1], b[2]-a[2]], e2 = [c[0]-a[0], c[1]-a[1], c[2]-a[2]];
    const cr = [e1[1]*e2[2]-e1[2]*e2[1], e1[2]*e2[0]-e1[0]*e2[2], e1[0]*e2[1]-e1[1]*e2[0]];
    const swapped = cr[0]*nrm[0] + cr[1]*nrm[1] + cr[2]*nrm[2] < 0;
    if (swapped) { const t = b; b = d; d = t; }
    const base = this.p.length / 3;
    const ax = Math.abs(nrm[0]), ay = Math.abs(nrm[1]);
    for (const v of [a, b, c, d]) {
      this.p.push(v[0], v[1], v[2]); this.n.push(nrm[0], nrm[1], nrm[2]);
      const uu = ay > 0.8 ? v[0] : (ax > 0.7 ? v[2] : v[0]);
      const vv = ay > 0.8 ? v[2] : v[1];
      this.u.push(uu / this.uvs, vv / this.uvs);
      this.c.push(col[0], col[1], col[2]); this.b.push(bid);
    }
    this.i.push(base, base + 1, base + 2, base, base + 2, base + 3);
    return swapped;      // (b and d were exchanged: callers that set their own UVs need to know)
  }
  box(x0, y0, z0, x1, y1, z1, col, bid = -1, skip = null) {
    const S = skip || {};
    if (!S.top)    this.quad([x0,y1,z1],[x1,y1,z1],[x1,y1,z0],[x0,y1,z0],[0,1,0],col,bid);
    if (!S.bottom) this.quad([x0,y0,z0],[x1,y0,z0],[x1,y0,z1],[x0,y0,z1],[0,-1,0],col,bid);
    if (!S.pz)     this.quad([x0,y0,z1],[x1,y0,z1],[x1,y1,z1],[x0,y1,z1],[0,0,1],col,bid);
    if (!S.nz)     this.quad([x1,y0,z0],[x0,y0,z0],[x0,y1,z0],[x1,y1,z0],[0,0,-1],col,bid);
    if (!S.px)     this.quad([x1,y0,z1],[x1,y0,z0],[x1,y1,z0],[x1,y1,z1],[1,0,0],col,bid);
    if (!S.nx)     this.quad([x0,y0,z0],[x0,y0,z1],[x0,y1,z1],[x0,y1,z0],[-1,0,0],col,bid);
  }
  // A beam of rectangular section w (across) x d (depth) between two points.
  beam(THREE, p0, p1, w, col, bid = -1, d = null) {
    const dir = new THREE.Vector3(p1[0]-p0[0], p1[1]-p0[1], p1[2]-p0[2]);
    if (dir.length() < 0.01) return;
    dir.normalize();
    const up = Math.abs(dir.y) > 0.9 ? new THREE.Vector3(1,0,0) : new THREE.Vector3(0,1,0);
    const s1 = new THREE.Vector3().crossVectors(dir, up).normalize().multiplyScalar(w/2);
    const s2 = new THREE.Vector3().crossVectors(dir, s1).normalize().multiplyScalar((d ?? w)/2);
    const P = (b, a, c) => [b[0]+s1.x*a+s2.x*c, b[1]+s1.y*a+s2.y*c, b[2]+s1.z*a+s2.z*c];
    const k4 = [[1,1],[-1,1],[-1,-1],[1,-1]];
    for (let k = 0; k < 4; k++) {
      const [a1,b1] = k4[k], [a2,b2] = k4[(k+1)%4];
      const n = new THREE.Vector3(s1.x*(a1+a2)+s2.x*(b1+b2), s1.y*(a1+a2)+s2.y*(b1+b2), s1.z*(a1+a2)+s2.z*(b1+b2)).normalize();
      this.quad(P(p0,a1,b1), P(p0,a2,b2), P(p1,a2,b2), P(p1,a1,b1), [n.x,n.y,n.z], col, bid);
    }
  }
  geometry(THREE) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.p, 3));
    g.setAttribute('normal',   new THREE.Float32BufferAttribute(this.n, 3));
    g.setAttribute('uv',       new THREE.Float32BufferAttribute(this.u, 2));
    g.setAttribute('color',    new THREE.Float32BufferAttribute(this.c, 3));
    g.setAttribute('aBid',     new THREE.Float32BufferAttribute(this.b, 1));
    g.setIndex(this.i);
    g.computeBoundingSphere();
    return g;
  }
}

const hex = (THREE, h) => { const c = new THREE.Color(); c.setHex(h, THREE.SRGBColorSpace); return [c.r, c.g, c.b]; };
const mul = (c, k) => [c[0]*k, c[1]*k, c[2]*k];
const mix = (a, b, t) => [a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t, a[2]+(b[2]-a[2])*t];

// Palettes (sRGB), from the spec.
const PLASTER = [0xe6dfcc, 0xddd3bd, 0xd9ceb4, 0xd6b777, 0xd2ab98, 0xb8c0c0];
const TIMBER  = [0x3a2a1d, 0x4a3524, 0x5a4a3e];
const STONE   = [0xa89f90, 0x9d9483, 0xb3aa9a];
const CLAY    = [0x8c4a30, 0x9e5b3c, 0x74402e];
const SLATE   = [0x4d5258, 0x5d636b];
const DOORS   = [0x5b3a24, 0x3f5a4a, 0x7a2e22];
const THATCH  = [0x9c8250, 0x7d6b48];

/**
 * @param opts.buildings  [{x0,y0,x1,y1, doors:[{tx,ty,side}]}] inclusive tile bounds
 * @param opts.TILE
 * @param opts.groundAt   (wx, wz) => ground height
 * @param opts.coastY0    tile row where the coast begins: buildings there are Saltmere huts
 * @returns geometries by material (null when empty): stone, plaster, timber,
 *          boards, glass, glassLit, roof, thatch, floor, shadow
 */
export function buildTown(THREE, { buildings, TILE, groundAt, coastY0 = Infinity }) {
  const A = {
    stone: new Acc(64), plaster: new Acc(64), timber: new Acc(48), boards: new Acc(64),
    glass: new Acc(24), glassLit: new Acc(24), roof: new Acc(64), thatch: new Acc(64),
    floor: new Acc(64), shadow: new Acc(1), spill: new Acc(1),
  };
  const T = TILE;
  buildings.forEach((B, bid) => {
    const r = rng(0x9e3779b1 ^ (B.x0 * 73856093) ^ (B.y0 * 19349663));
    const pick = a => a[Math.floor(r() * a.length)];
    const jit = c => mul(c, 0.96 + r() * 0.08);
    const X0 = B.x0 * T, X1 = (B.x1 + 1) * T, Z0 = B.y0 * T, Z1 = (B.y1 + 1) * T;
    const cx = (X0 + X1) / 2, cz = (Z0 + Z1) / 2;
    const w = B.x1 - B.x0 + 1, h = B.y1 - B.y0 + 1;
    // Sit on the HIGHEST ground under the footprint; the plinth runs down to
    // well below the lowest, so a slope never shows daylight or steps the eaves.
    let gHi = -1e9, gLo = 1e9;
    for (let x = X0; x <= X1; x += T/2) for (let z = Z0; z <= Z1; z += T/2) { const g = groundAt(x, z); gHi = Math.max(gHi, g); gLo = Math.min(gLo, g); }
    const G = gHi;

    const hut = Math.min(w, h) <= 3 || B.y0 >= coastY0;
    const type = hut ? 'HUT' : (Math.max(w, h) >= 8 ? 'C' : (r() < 0.5 ? 'A' : 'B'));
    const cPl = jit(hex(THREE, pick(PLASTER))), cTi = jit(hex(THREE, pick(TIMBER))), cSt = jit(hex(THREE, pick(STONE)));
    const cDoor = hex(THREE, hut ? 0x4f6b78 : pick(DOORS));
    const cRf = hut ? hex(THREE, pick(THATCH)) : hex(THREE, r() < 0.7 ? pick(CLAY) : pick(SLATE));
    const cBoard = jit(hex(THREE, 0x5e5247)), cSalt = hex(THREE, 0x9a948a);   // tarred boards, salt-bleached at the foot

    const PL = 24;                                   // plinth top
    const DOOR_H = 150;
    const two = type === 'B' || type === 'C';
    const H1 = two ? 176 : hut ? 172 : 184;         // ground storey top (A/HUT: the eaves) — a 150 door + head beam fits
    const H2 = two ? (type === 'C' ? 126 : 112) : 0; // upper storey height
    const J  = two ? 12 : 0;                          // jetty
    const EAVE = G + H1 + H2;                        // wall plate
    const upperBid = two ? bid : -1;                 // the upper storey lifts off with the roof

    // ── contact shadow ──
    { const m = 28, y = gLo + 0.8;
      A.shadow.quad([X0-m,y,Z1+m],[X1+m,y,Z1+m],[X1+m,y,Z0-m],[X0-m,y,Z0-m],[0,1,0],[1,1,1]);
      A.shadow.u.splice(-8, 8, 0,0, 1,0, 1,1, 0,1); }

    // A pool of lamplight on the ground in front of a lit opening, for night:
    // (px,pz) the wall-face point below the opening, (nx,nz) outward, wid across.
    // UV u runs across, v from the wall (0) outward (1); the material shapes it.
    const spill = (px, pz, nx, nz, wid, len = 80) => {
      const ax = -nz, az = nx, P = (a, d) => { const x = px + ax*a + nx*d, z = pz + az*a + nz*d; return [x, groundAt(x, z) + 1.2, z]; };
      const flip = A.spill.quad(P(-wid/2, 2), P(wid/2, 2), P(wid*0.9, len), P(-wid*0.9, len), [0,1,0], [1,1,1]);
      A.spill.u.splice(-8, 8, 0,0, ...(flip ? [0,1, 1,1, 1,0] : [1,0, 1,1, 0,1]));
    };

    const doorSet = new Set(B.doors.map(d => d.tx + ',' + d.ty));
    const isDoor = (tx, ty) => doorSet.has(tx + ',' + ty);
    const ring = f => { for (let tx = B.x0; tx <= B.x1; tx++) for (let ty = B.y0; ty <= B.y1; ty++) {
      if (tx === B.x0 || tx === B.x1 || ty === B.y0 || ty === B.y1) f(tx, ty); } };

    // ── plinth: stone course, 3 proud, from well below the lowest ground ──
    { const o = 3, y0 = gLo - 40, y1 = G + PL;
      ring((tx, ty) => { if (isDoor(tx, ty)) return;
        A.stone.box(tx*T - (tx === B.x0 ? o : 0), y0, ty*T - (ty === B.y0 ? o : 0),
                    tx*T + T + (tx === B.x1 ? o : 0), y1, ty*T + T + (ty === B.y1 ? o : 0), mul(cSt, 0.82), -1, {bottom:true}); });
      // interior floor: planks (houses) or boards (huts)
      A.floor.box(X0 + T, y0, Z0 + T, X1 - T, G + 4, Z1 - T, hut ? mul(cBoard, 1.4) : hex(THREE, 0x5a3e27), -1, {bottom:true});
    }

    // ── ground storey ──
    // B/C: stone. A: timber-framed plaster. HUT: tarred weatherboard.
    ring((tx, ty) => {
      if (isDoor(tx, ty)) return;
      const x = tx*T, z = ty*T;
      if (two) A.stone.box(x, G + PL, z, x + T, G + H1, z + T, jit(cSt), -1, {bottom:true, top:true});
      else if (hut) {
        // boards darken to salt-bleached grey toward the bottom
        A.boards.box(x, G + PL, z, x + T, G + PL + 24, z + T, cSalt, -1, {bottom:true, top:true});
        A.boards.box(x, G + PL + 24, z, x + T, G + H1, z + T, jit(cBoard), -1, {bottom:true, top:true});
      }
      else A.plaster.box(x, G + PL, z, x + T, G + H1, z + T, cPl, -1, {bottom:true, top:true});
    });
    // over each doorway: wall above the opening
    for (const d of B.doors) {
      const x = d.tx*T, z = d.ty*T, acc = two ? A.stone : hut ? A.boards : A.plaster, col = two ? cSt : hut ? cBoard : cPl;
      if (H1 > DOOR_H + 8) acc.box(x, G + DOOR_H + 8, z, x + T, G + H1, z + T, col, -1, {top:true});
    }
    // the storey-junction cap, seen from above when the upper storey is lifted off
    // (seen from above when the roof is lifted off: the wall's own material, not a black band)
    ring((tx, ty) => { (two ? A.stone : hut ? A.boards : A.plaster).box(tx*T, G + H1, ty*T, tx*T + T, G + H1 + 2, ty*T + T,
      two ? mul(cSt, 0.9) : hut ? cBoard : mul(cPl, 0.9), -1, {bottom:true}); });

    // ── upper storey (B/C): jettied plaster over the whole ring ──
    const ox0 = X0 - J, ox1 = X1 + J, oz0 = Z0 - J, oz1 = Z1 + J;
    if (two) {
      const y0 = G + H1, y1 = EAVE;
      A.plaster.box(ox0, y0, oz0, ox1, y1, Z0 + T, cPl, upperBid);
      A.plaster.box(ox0, y0, Z1 - T, ox1, y1, oz1, cPl, upperBid);
      A.plaster.box(ox0, y0, Z0 + T, X0 + T, y1, Z1 - T, cPl, upperBid);
      A.plaster.box(X1 - T, y0, Z0 + T, ox1, y1, Z1 - T, cPl, upperBid);
      // floor beam band + joist ends under the jetty
      A.timber.box(ox0 - 2, y0 - 8, oz0 - 2, ox1 + 2, y0 + 1, oz1 + 2, cTi, upperBid, {top:true});
      for (const F of [[X0, Z0, 1, 0, 0, -1], [X0, Z1, 1, 0, 0, 1], [X0, Z0, 0, 1, -1, 0], [X1, Z0, 0, 1, 1, 0]]) {
        const L = F[2] ? (X1 - X0) : (Z1 - Z0);
        for (let s = 8; s < L; s += 16) {
          const bx = F[0] + F[2]*s, bz = F[1] + F[3]*s;
          A.timber.box(bx - 2.5 + (F[4] < 0 ? -J - 2 : F[4] > 0 ? 0 : 0), y0 - 14, bz - 2.5 + (F[5] < 0 ? -J - 2 : 0),
                       bx + 2.5 + (F[4] > 0 ? J + 2 : 0), y0 - 8, bz + 2.5 + (F[5] > 0 ? J + 2 : 0), mul(cTi, 0.9), upperBid);
        }
      }
    }

    // ── huts: corner posts, a wall plate, one small shuttered window per side ──
    if (hut) {
      const cPost = hex(THREE, 0x2b241d);
      for (const [px, pz] of [[X0, Z0], [X1, Z0], [X0, Z1], [X1, Z1]])
        A.timber.beam(THREE, [px, gLo - 4, pz], [px, G + H1 + 4, pz], 12, cPost, -1, 12);
      const sides = [[[X0, Z0], [1, 0], [0, -1], X1 - X0], [[X1, Z1], [-1, 0], [0, 1], X1 - X0], [[X0, Z1], [0, -1], [-1, 0], Z1 - Z0], [[X1, Z0], [0, 1], [1, 0], Z1 - Z0]];
      for (const [o, a, n, L] of sides) {
        const at = (s, y, out) => [o[0] + a[0]*s + n[0]*out, y, o[1] + a[1]*s + n[1]*out];
        A.timber.beam(THREE, at(0, G + H1 - 4, 2), at(L, G + H1 - 4, 2), 8, cPost, -1, 4);
        const s = L * (0.3 + r() * 0.4);
        const px = o[0] + a[0]*s - n[0]*T/2, pz = o[1] + a[1]*s - n[1]*T/2;
        if (isDoor(Math.floor(px / T), Math.floor(pz / T))) continue;
        const y0 = G + 84, y1 = y0 + 26;
        const litH = r() < 0.6; if (litH) { const q = at(s, 0, 0); spill(q[0], q[2], n[0], n[1], 30, 70); }
        (litH ? A.glassLit : A.glass).quad(at(s - 10, y0, 0.6), at(s + 10, y0, 0.6), at(s + 10, y1, 0.6), at(s - 10, y1, 0.6), [n[0],0,n[1]], [1,1,1]);
        for (const [a0, a1] of [[s - 12, s + 12]]) {
          A.timber.beam(THREE, at(a0, y0 - 2, 3), at(a1, y0 - 2, 3), 4, cPost, -1, 4);
          A.timber.beam(THREE, at(a0, y1 + 2, 3), at(a1, y1 + 2, 3), 4, cPost, -1, 4);
          A.timber.beam(THREE, at(a0, y0 - 2, 3), at(a0, y1 + 2, 3), 4, cPost, -1, 4);
          A.timber.beam(THREE, at(a1, y0 - 2, 3), at(a1, y1 + 2, 3), 4, cPost, -1, 4);
        }
        // shutters: weathered sea-blue, open flat
        for (const e of [-1, 1]) A.timber.beam(THREE, at(s + e*18, y0 - 1, 3), at(s + e*18, y1 + 1, 3), 11, cDoor, -1, 2);
      }
    }

    // ── timber framing + windows, per facade ──
    const P = 2;                      // beams stand 2 proud of the plaster
    // A facade: an origin corner, the along-axis, the outward normal, its length,
    // the storey band [y0,y1] it frames, and whether it is the jettied upper.
    const facades = [];
    const addFacades = (x0, z0, x1, z1, y0, y1, upper) => {
      facades.push({ o:[x0,z0], a:[1,0],  n:[0,-1], L:x1-x0, y0, y1, upper });
      facades.push({ o:[x1,z1], a:[-1,0], n:[0,1],  L:x1-x0, y0, y1, upper });
      facades.push({ o:[x0,z1], a:[0,-1], n:[-1,0], L:z1-z0, y0, y1, upper });
      facades.push({ o:[x1,z0], a:[0,1],  n:[1,0],  L:z1-z0, y0, y1, upper });
    };
    if (type === 'A') addFacades(X0, Z0, X1, Z1, G + PL, G + H1, false);
    if (two) addFacades(ox0, oz0, ox1, oz1, G + H1, EAVE, true);
    const winHeads = {};
    for (const F of facades) {
      const bb = F.upper ? upperBid : -1;
      const at = (s, y, out = P) => [F.o[0] + F.a[0]*s + F.n[0]*out, y, F.o[1] + F.a[1]*s + F.n[1]*out];
      const tileAt = s => { const px = F.o[0] + F.a[0]*s - F.n[0]*(T/2 + (F.upper ? J : 0)), pz = F.o[1] + F.a[1]*s - F.n[1]*(T/2 + (F.upper ? J : 0));
        return [Math.floor(px / T), Math.floor(pz / T)]; };
      const n = Math.max(2, Math.round(F.L / 34)), step = F.L / n;
      const yMid = F.y0 + (F.y1 - F.y0) * 0.33;       // the rail is the window sill
      // plates, rail, posts & studs — spaced over the WHOLE facade
      A.timber.beam(THREE, at(0, F.y0 + 3), at(F.L, F.y0 + 3), 7, cTi, bb, 4);
      A.timber.beam(THREE, at(0, F.y1 - 3), at(F.L, F.y1 - 3), 7, cTi, bb, 4);
      A.timber.beam(THREE, at(0, yMid), at(F.L, yMid), 6, cTi, bb, 4);
      // which bays hold a doorway (ground storey of type A only)
      const doorBay = k => { if (F.upper) return false; const [tx, ty] = tileAt((k + 0.5) * step); return isDoor(tx, ty); };
      for (let k = 0; k <= n; k++) {
        const corner = k === 0 || k === n;
        A.timber.beam(THREE, at(k*step, F.y0), at(k*step, F.y1), corner ? 12 : 7, cTi, bb, corner ? 12 : 4);
      }
      for (let k = 0; k < n; k++) {
        const s0 = k*step, s1 = (k+1)*step, mid = (s0 + s1)/2;
        const corner = k === 0 || k === n - 1;
        if (doorBay(k)) continue;
        // braces: in the corner bays, rising from the corner post to the plate;
        // and flanking a door bay
        const flanksDoor = doorBay(k - 1) || doorBay(k + 1);
        if (corner || flanksDoor) {
          const towardLeft = (k === 0) || doorBay(k - 1);
          const lo = F.y0 + 6, hi = yMid;
          if (towardLeft) A.timber.beam(THREE, at(s0 + 4, hi), at(s1 - 4, lo), 7, cTi, bb, 4);
          else            A.timber.beam(THREE, at(s1 - 4, hi), at(s0 + 4, lo), 7, cTi, bb, 4);
          const lo2 = yMid + 4, hi2 = F.y1 - 6;
          if (towardLeft) A.timber.beam(THREE, at(s0 + 4, lo2), at(s1 - 4, hi2), 7, cTi, bb, 4);
          else            A.timber.beam(THREE, at(s1 - 4, lo2), at(s0 + 4, hi2), 7, cTi, bb, 4);
          continue;
        }
        // windows: every other free bay, heads aligned per facade
        if ((k % 2) !== 1 || step < 26) continue;
        const ww = Math.min(24, step - 12), wy0 = yMid + 5, wh = Math.min(38, F.y1 - 10 - wy0), wy1 = wy0 + wh;
        const lit = r() < 0.6;
        const gl = lit ? A.glassLit : A.glass;
        if (lit && !F.upper) { const q = at(mid, 0, 0); spill(q[0], q[2], F.n[0], F.n[1], ww + 12, 80); }
        // The walls are solid (a full tile thick), so the glass sits just proud of
        // the plaster, inside a frame that stands 3 proud — the frame's depth is
        // the recess. (Round 1 put it 2 INSIDE the wall: invisible, never lit.)
        gl.quad(at(mid - ww/2, wy0, 0.6), at(mid + ww/2, wy0, 0.6), at(mid + ww/2, wy1, 0.6), at(mid - ww/2, wy1, 0.6), [F.n[0],0,F.n[1]], [1,1,1], bb);
        const fr = (a, b) => A.timber.beam(THREE, a, b, 4, mul(cTi, 1.1), bb, 3);
        fr(at(mid - ww/2 - 2, wy0 - 2, 3), at(mid + ww/2 + 2, wy0 - 2, 3));
        fr(at(mid - ww/2 - 2, wy1 + 2, 3), at(mid + ww/2 + 2, wy1 + 2, 3));
        fr(at(mid - ww/2 - 2, wy0 - 2, 3), at(mid - ww/2 - 2, wy1 + 2, 3));
        fr(at(mid + ww/2 + 2, wy0 - 2, 3), at(mid + ww/2 + 2, wy1 + 2, 3));
        A.timber.beam(THREE, at(mid, wy0, 1), at(mid, wy1, 1), 2, cTi, bb, 2);
        A.timber.beam(THREE, at(mid - ww/2, wy0 + wh*0.62, 1), at(mid + ww/2, wy0 + wh*0.62, 1), 2, cTi, bb, 2);
        A.timber.beam(THREE, at(mid - 15, wy0 - 5, 5), at(mid + 15, wy0 - 5, 5), 3, mul(cTi, 1.2), bb, 5);
        // shutters, open flat against the wall, on some windows
        if (r() < 0.4) for (const sgn of [-1, 1]) {
          const sx = mid + sgn*(ww/2 + 3 + 6);
          A.timber.beam(THREE, at(sx, wy0 - 1, P + 1.5), at(sx, wy1 + 1, P + 1.5), 12, cDoor, bb, 2);
        }
      }
    }
    // ground-storey windows on stone walls (B/C): stone-dressed, on the long sides
    if (two) for (const F of [facades[0], facades[1]]) {
      // F is the jettied upper facade; step back J to the stone wall face
      const at = (s, y, out) => [F.o[0] + F.a[0]*s + F.n[0]*(out - J), y, F.o[1] + F.a[1]*s + F.n[1]*(out - J)];
      for (const frac of [0.3, 0.7]) {
        const s = J + (F.L - 2*J) * frac;
        const px = F.o[0] + F.a[0]*s - F.n[0]*(T/2 + J), pz = F.o[1] + F.a[1]*s - F.n[1]*(T/2 + J);
        if (isDoor(Math.floor(px / T), Math.floor(pz / T))) continue;
        const y0 = G + 72, y1 = y0 + 36;
        const litS = r() < 0.6; if (litS) { const q = at(s, 0, 0); spill(q[0], q[2], F.n[0], F.n[1], 36, 80); }
        (litS ? A.glassLit : A.glass).quad(at(s - 12, y0, 0.6), at(s + 12, y0, 0.6), at(s + 12, y1, 0.6), at(s - 12, y1, 0.6), [F.n[0],0,F.n[1]], [1,1,1]);
        for (const e of [-1, 1]) A.stone.beam(THREE, at(s + e*14, y0 - 1, 1.5), at(s + e*14, y1 + 1, 1.5), 5, mul(cSt, 1.08), -1, 4);   // jambs
        A.stone.beam(THREE, at(s - 18, y1 + 4, 1), at(s + 18, y1 + 4, 1), 8, mul(cSt, 1.12), -1, 6);   // lintel
        A.stone.beam(THREE, at(s - 16, y0 - 3, 1.5), at(s + 16, y0 - 3, 1.5), 5, mul(cSt, 1.12), -1, 7); // sill
      }
    }

    // ── doors: 48 x 150, head beam, leaf open against the inner reveal ──
    for (const d of B.doors) {
      const x = d.tx*T, z = d.ty*T;
      const ax = d.side === 'n' || d.side === 's';
      const out = d.side === 'n' ? [0,-1] : d.side === 's' ? [0,1] : d.side === 'w' ? [-1,0] : [1,0];
      const fx = out[0] > 0 ? x + T : x, fz = out[1] > 0 ? z + T : z;          // outer face of the doorway
      spill(ax ? x + T/2 : fx, ax ? fz : z + T/2, out[0], out[1], 40, 120);
      const pp = ax ? [[x + 2, fz + out[1]*2], [x + T - 2, fz + out[1]*2]] : [[fx + out[0]*2, z + 2], [fx + out[0]*2, z + T - 2]];
      for (const [px, pz] of pp) A.timber.beam(THREE, [px, G, pz], [px, G + DOOR_H, pz], 8, cTi, -1, 8);
      A.timber.beam(THREE, [pp[0][0], G + DOOR_H + 4, pp[0][1]], [pp[1][0], G + DOOR_H + 4, pp[1][1]], 8, cTi, -1, 9);
      // the leaf: 44 x 146 x 3 planks with two iron straps, swung in against the left reveal
      const inw = [-out[0], -out[1]];
      const hx = pp[0][0] + inw[0]*4 + (ax ? 6 : 0), hz = pp[0][1] + inw[1]*4 + (ax ? 0 : 6);   // clear of the post
      const ex = hx + inw[0]*44, ez = hz + inw[1]*44;
      const lx0 = Math.min(hx, ex) - (ax ? 1.5 : 0), lx1 = Math.max(hx, ex) + (ax ? 1.5 : 0);
      const lz0 = Math.min(hz, ez) - (ax ? 0 : 1.5), lz1 = Math.max(hz, ez) + (ax ? 0 : 1.5);
      const lxs = ax ? [hx - 1.5, hx + 1.5] : [lx0, lx1], lzs = ax ? [lz0, lz1] : [hz - 1.5, hz + 1.5];
      A.timber.box(lxs[0], G + 2, lzs[0], lxs[1], G + 146, lzs[1], cDoor);
      for (const sy of [30, 110]) A.timber.box(lxs[0] - 0.4, G + sy, lzs[0] - 0.4, lxs[1] + 0.4, G + sy + 4, lzs[1] + 0.4, [0.03, 0.03, 0.03]);
      // threshold stone
      const tx0 = ax ? x : (out[0] > 0 ? x + T : x - 14), tx1 = ax ? x + T : (out[0] > 0 ? x + T + 14 : x);
      const tz0 = ax ? (out[1] > 0 ? z + T : z - 14) : z, tz1 = ax ? (out[1] > 0 ? z + T + 14 : z) : z + T;
      A.stone.box(tx0, gLo - 8, tz0, tx1, G + 4, tz1, mul(cSt, 0.95), -1, {bottom:true});
    }

    // ── roof ──
    const alongX = (ox1 - ox0) >= (oz1 - oz0);
    const verge = 14, eave = hut ? 24 : 20;
    const Lh = (alongX ? (ox1 - ox0) : (oz1 - oz0)) / 2 + verge;
    const Wh = (alongX ? (oz1 - oz0) : (ox1 - ox0)) / 2;
    const pitch = (hut ? 58 : 50 + r() * 5) * Math.PI / 180;
    const th = hut ? 14 : 8;
    const rise = Wh * Math.tan(pitch);
    const W = (u, v, y) => alongX ? [cx + u, EAVE + y, cz + v] : [cx + v, EAVE + y, cz + u];
    const RA = hut ? A.thatch : A.roof;
    for (const side of [-1, 1]) {
      const vE = side * (Wh + eave), yE = -eave * Math.tan(pitch);
      const nl = [Math.cos(pitch), side * Math.sin(pitch)];
      const N = alongX ? [0, nl[0], nl[1]] : [nl[1], nl[0], 0];
      const jz = () => (r() - 0.5) * 3;                           // not ruler-straight
      const moss = mix(cRf, hex(THREE, 0x55603a), hut ? 0.15 : 0.35);
      const a = W(-Lh, vE, yE + th + jz()), b = W(Lh, vE, yE + th + jz()), c = W(Lh, 0, rise + th), d = W(-Lh, 0, rise + th);
      // top face, with moss toward the eaves: two quads so the eave edge can be tinted
      const m1 = W(-Lh, vE*0.55, (yE + th)*0.55 + (rise + th)*0.45), m2 = W(Lh, vE*0.55, (yE + th)*0.55 + (rise + th)*0.45);
      if (side > 0) { RA.quad(a, b, m2, m1, N, moss, bid); RA.quad(m1, m2, c, d, N, cRf, bid); }
      else          { RA.quad(b, a, m1, m2, N, moss, bid); RA.quad(m2, m1, d, c, N, cRf, bid); }
      // underside (soffit) and the eave fascia
      const a2 = W(-Lh, vE, yE), b2 = W(Lh, vE, yE), c2 = W(Lh, 0, rise), d2 = W(-Lh, 0, rise);
      const soffit = hex(THREE, 0x3a2c22);
      if (side > 0) A.timber.quad(b2, a2, d2, c2, [-N[0], -N[1], -N[2]], soffit, bid); else A.timber.quad(a2, b2, c2, d2, [-N[0], -N[1], -N[2]], soffit, bid);
      A.timber.quad(side > 0 ? a2 : b2, side > 0 ? b2 : a2, side > 0 ? b : a, side > 0 ? a : b, alongX ? [0,0,side] : [side,0,0], mul(cTi, 0.9), bid);
      // verge ends of the slab
      for (const u of [-1, 1]) {
        const e0 = W(u*Lh, vE, yE), e1 = W(u*Lh, 0, rise), e2 = W(u*Lh, 0, rise + th), e3 = W(u*Lh, vE, yE + th);
        const NN = alongX ? [u,0,0] : [0,0,u];
        RA.quad(e0, e1, e2, e3, NN, mul(cRf, 0.8), bid);
        if (!hut) A.timber.beam(THREE, W(u*(Lh + 1.5), vE, yE + th/2), W(u*(Lh + 1.5), 0, rise + th/2), 3, cTi, bid, 12);  // barge board
      }
      if (!hut) A.timber.beam(THREE, W(-Lh, vE - side*1.5, yE + th/2 - 2), W(Lh, vE - side*1.5, yE + th/2 - 2), 3, cTi, bid, 10);   // fascia
    }
    // ridge: a tile cap, or a thatch roll
    if (hut) RA.beam(THREE, W(-Lh, 0, rise + th + 3), W(Lh, 0, rise + th + 3), 14, mul(cRf, 0.85), bid, 10);
    else     RA.beam(THREE, W(-Lh - 2, 0, rise + th + 2), W(Lh + 2, 0, rise + th + 2), 10, mul(cRf, 0.8), bid, 6);
    // gable ends: closed right up to the roof underside, framed
    for (const s of [-1, 1]) {
      const u = s * (Lh - verge);
      const N = alongX ? [s, 0, 0] : [0, 0, s];
      const gA = W(u, -Wh, 0), gB = W(u, Wh, 0), gC = W(u, 0, rise);
      const gAcc = hut ? A.boards : A.plaster, gCol = hut ? cBoard : mul(cPl, 0.97);
      if (s > 0) gAcc.quad(gA, gB, gC, gC, N, gCol, bid); else gAcc.quad(gB, gA, gC, gC, N, gCol, bid);
      if (s > 0) gAcc.quad(gB, gA, gC, gC, [-N[0],0,-N[2]], gCol, bid); else gAcc.quad(gA, gB, gC, gC, [-N[0],0,-N[2]], gCol, bid);
      if (hut) continue;
      const o = (p) => alongX ? [p[0] + s*P, p[1], p[2]] : [p[0], p[1], p[2] + s*P];
      A.timber.beam(THREE, o(W(u, -Wh, 3)), o(W(u, Wh, 3)), 8, cTi, bid, 4);                   // tie beam
      A.timber.beam(THREE, o(W(u, 0, 3)), o(W(u, 0, rise - 4)), 8, cTi, bid, 4);               // king post
      A.timber.beam(THREE, o(W(u, -Wh*0.5, rise*0.5)), o(W(u, Wh*0.5, rise*0.5)), 6, cTi, bid, 4);  // collar
      A.timber.beam(THREE, o(W(u, -Wh*0.55, 3)), o(W(u, -Wh*0.08, rise*0.48)), 6, cTi, bid, 4); // struts
      A.timber.beam(THREE, o(W(u, Wh*0.55, 3)), o(W(u, Wh*0.08, rise*0.48)), 6, cTi, bid, 4);
      if (rise > 60) {                                                                          // a loft window
        const gy = EAVE + rise*0.18, gp = (v, y, k) => { const q = W(u, v, y - EAVE); return alongX ? [q[0] + s*k, q[1], q[2]] : [q[0], q[1], q[2] + s*k]; };
        const lit = r() < 0.5;
        (lit ? A.glassLit : A.glass).quad(gp(-8, gy, 0.6), gp(8, gy, 0.6), gp(8, gy + 20, 0.6), gp(-8, gy + 20, 0.6), N, [1,1,1], bid);
        A.timber.beam(THREE, gp(-10, gy - 1, 3), gp(10, gy - 1, 3), 4, cTi, bid, 3);
        A.timber.beam(THREE, gp(-10, gy + 21, 3), gp(10, gy + 21, 3), 4, cTi, bid, 3);
      }
    }
    // chimney: stone, on the ridge line 0.3 of the way from one gable, 30 above the ridge
    if (!hut || r() < 0.5) {
      const u = (r() < 0.5 ? -1 : 1) * (Lh - verge) * 0.4;
      const base = W(u, 0, 0), sz = hut ? 14 : 22;
      const x0 = base[0] - sz/2, z0 = base[2] - sz/2, y1 = EAVE + rise + th + 30;
      A.stone.box(x0, EAVE - 20, z0, x0 + sz, y1, z0 + sz, mul(cSt, 0.78), bid, {bottom:true});
      A.stone.box(x0 - 2, y1, z0 - 2, x0 + sz + 2, y1 + 4, z0 + sz + 2, mul(cSt, 0.6), bid);
    }
  });
  const out = {};
  for (const k in A) out[k] = A[k].p.length ? A[k].geometry(THREE) : null;
  return out;
}
