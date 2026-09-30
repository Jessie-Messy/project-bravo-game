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
  constructor(uvScale = 64) { this.p = []; this.n = []; this.u = []; this.c = []; this.b = []; this.k = []; this.g = []; this.i = []; this.uvs = uvScale; this.cut = -1; this.base = 0; }
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
      this.c.push(col[0], col[1], col[2]); this.b.push(bid); this.k.push(this.cut); this.g.push(this.base);
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
    // The cutaway: which building a vertex belongs to, and that building's
    // floor height. While you are inside, its walls are cut down to waist height.
    g.setAttribute('aCut',     new THREE.Float32BufferAttribute(this.k, 1));
    g.setAttribute('aBase',    new THREE.Float32BufferAttribute(this.g, 1));
    g.setIndex(this.i);
    g.computeBoundingSphere();
    return g;
  }
}

const hex = (THREE, h) => { const c = new THREE.Color(); c.setHex(h, THREE.SRGBColorSpace); return [c.r, c.g, c.b]; };
const mul = (c, k) => [c[0]*k, c[1]*k, c[2]*k];
const mix = (a, b, t) => [a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t, a[2]+(b[2]-a[2])*t];

// Palettes (sRGB), from the spec.
const PLASTER = [0xe6dfcc, 0xddd3bd, 0xd9ceb4, 0xdcc89c, 0xd9c0ae, 0xb8c0c0];
const TIMBER  = [0x3a2a1d, 0x4a3524, 0x5a4a3e];
const STONE   = [0xc9bba0, 0xbfb096, 0xd0c4ac];   // warm dressed sandstone — never the fort walls' grey
const CLAY    = [0x8c4a30, 0x9e5b3c, 0x74402e];
const SLATE   = [0x707880, 0x7e848c];
const DOORS   = [0x5b3a24, 0x3f5a4a, 0x7a2e22];
const THATCH  = [0xb09a68, 0x9a8660];

/**
 * @param opts.buildings  [{x0,y0,x1,y1, doors:[{tx,ty,side}]}] inclusive tile bounds
 * @param opts.TILE
 * @param opts.groundAt   (wx, wz) => ground height
 * @param opts.coastY0    tile row where the coast begins: buildings there are Saltmere huts
 * @returns geometries by material (null when empty): stone, plaster, timber,
 *          boards, glass, glassLit, roof, slate, thatch, floor, shadow, spill,
 *          doorGlow, sign, flowers
 * @param opts.signs      [{tx, ty, icon}] a hanging sign at that door tile (icon: atlas cell)
 */
// Street furniture, shared by every building. Props draw from their OWN random
// stream, so adding or tuning them never reshuffles the architecture (which a
// critic loop signed off on).
const FLOWERS = [0xb8574f, 0xd4b060, 0xe6e0cc, 0x8f6fa6, 0xc97a4a];

// A hanging shop sign: an iron bracket out from the wall above the door, a
// board hanging from it edge-on to the wall so it reads from along the street.
// (hx,hz) the wall-face point, out the outward normal, icon the atlas cell.
function shopSign(THREE, A, hx, hz, out, y, icon, bid) {
  const iron = [0.05, 0.05, 0.05], P = (k, yy) => [hx + out[0]*k, yy, hz + out[1]*k];
  A.timber.beam(THREE, P(0, y), P(60, y), 3.5, iron, bid, 3.5);                     // bracket arm
  A.timber.beam(THREE, P(0, y - 22), P(22, y), 2.5, iron, bid, 2.5);                // its stay
  for (const k of [16, 52]) A.timber.beam(THREE, P(k, y), P(k, y - 6), 1.5, iron, bid, 1.5);   // chains
  // a small lantern hung near the wall, so the sign reads at night
  A.timber.beam(THREE, P(8, y), P(8, y - 8), 1.2, iron, bid, 1.2);
  A.glassLit.beam(THREE, P(8, y - 8), P(8, y - 22), 10, [1, 1, 1], bid, 10);
  A.timber.beam(THREE, P(8, y - 8), P(8, y - 10), 12, iron, bid, 12);
  // the board: 42 across (outward) x 36 tall; both faces carry the icon
  const al = [-out[1], out[0]], y1 = y - 6, y0 = y1 - 36, k0 = 13, k1 = 55;
  const C = (k, yy, e) => [hx + out[0]*k + al[0]*e, yy, hz + out[1]*k + al[1]*e];
  const col = 3, row = 2, cu = (icon % col) / col, cv = Math.floor(icon / col) / row;
  for (const e of [-1, 1]) {
    // u runs outward from the wall on one face and back toward it on the other,
    // so the icon is never mirrored
    const flip = A.sign.quad(C(k0, y0, e), C(k1, y0, e), C(k1, y1, e), C(k0, y1, e), [al[0]*e, 0, al[1]*e], [1, 1, 1], bid);
    const u0 = e > 0 ? cu : cu + 1/col, u1 = e > 0 ? cu + 1/col : cu, v0 = 1 - cv - 1/row, v1 = 1 - cv;
    const uv = [[u0, v0], [u1, v0], [u1, v1], [u0, v1]];
    const order = flip ? [0, 3, 2, 1] : [0, 1, 2, 3];
    A.sign.u.splice(-8, 8, ...order.flatMap(i => uv[i]));
  }
  A.timber.box(Math.min(C(k0, y0, -1)[0], C(k1, y1, 1)[0]), y0, Math.min(C(k0, y0, -1)[2], C(k1, y1, 1)[2]),
               Math.max(C(k0, y0, -1)[0], C(k1, y1, 1)[0]), y0 + 1.5, Math.max(C(k0, y0, -1)[2], C(k1, y1, 1)[2]), [0.2, 0.14, 0.09], bid);
}

// A window box of flowers under a sill: (at) maps (along, y, out) to world.
function flowerBox(THREE, A, at, n, mid, y, w, cTi, rp, bid) {
  A.timber.beam(THREE, at(mid - w/2, y - 4, 7), at(mid + w/2, y - 4, 7), 9, cTi, bid, 9);
  // foliage first — a green mound gives the box its mass (critic: bare heads read as confetti)
  A.flowers.beam(THREE, at(mid - w/2 + 2, y + 3, 7), at(mid + w/2 - 2, y + 3, 7), 8, [0.05, 0.12, 0.04], bid, 7);
  for (let x = mid - w/2 + 4; x <= mid + w/2 - 4; x += 6) {
    if (rp() < 0.3) continue;
    const c = FLOWERS[Math.floor(rp() * FLOWERS.length)], cc = [((c >> 16) & 255) / 255, ((c >> 8) & 255) / 255, (c & 255) / 255];
    const lin = cc.map(v => Math.pow(v, 2.2)), yy = y + 6 + rp() * 4, o = 5 + rp() * 4;
    A.flowers.beam(THREE, at(x, yy, o), at(x, yy + 3, o), 3, lin, bid, 3);
  }
}

// A plank bench against the wall: along [s0,s1], seat 32 up (a quarter of a
// 126 character), 16 deep; a backrest on the town ones.
function bench(THREE, A, at, s0, s1, G, c, bid, back) {
  A.timber.beam(THREE, at(s0, G + 32, 11), at(s1, G + 32, 11), 16, c, bid, 3);
  for (const s of [s0 + 5, s1 - 5]) A.timber.beam(THREE, at(s, G, 11), at(s, G + 31, 11), 4, c, bid, 14);
  if (back) A.timber.beam(THREE, at(s0, G + 50, 3), at(s1, G + 50, 3), 8, c, bid, 3);
}

// A barrel: an 8-sided stave body bulging at the middle (56 tall, 19 at the
// belly — nearly half a character), a lid, two iron hoops.
function barrel(THREE, A, x, z, G, c, bid) {
  const pt = (i, r, y) => { const t = i * Math.PI / 4 + Math.PI / 8; return [x + Math.cos(t) * r, G + y, z + Math.sin(t) * r]; };
  const nrm = i => { const t = (i + 0.5) * Math.PI / 4 + Math.PI / 8; return [Math.cos(t), 0, Math.sin(t)]; };
  for (let i = 0; i < 8; i++) {
    for (const [y0, y1, r0, r1] of [[0, 28, 16, 19], [28, 56, 19, 16]])
      A.timber.quad(pt(i, r0, y0), pt(i + 1, r0, y0), pt(i + 1, r1, y1), pt(i, r1, y1), nrm(i), c, bid);
    for (const y of [10, 44]) {
      const rr = 16 + 3 * (y < 28 ? y / 28 : (56 - y) / 28) + 0.4;
      A.timber.quad(pt(i, rr, y), pt(i + 1, rr, y), pt(i + 1, rr, y + 3), pt(i, rr, y + 3), nrm(i), [0.05, 0.05, 0.05], bid);
    }
  }
  for (const q of [[0, 1, 2, 3], [0, 3, 4, 7], [4, 5, 6, 7]])
    A.timber.quad(...q.map(i => pt(i, 16, 56)), [0, 1, 0], mul(c, 0.8), bid);
}


// ── Interiors (v0.24) ─────────────────────────────────────────────────
// The owner: "if I can enter a building I want to see the inside of the
// building and be able to walk around in them". The ×2.5 city's buildings are
// 13×13 tiles (11×11 inside), room enough for a real room; this furnishes it
// by the building's role, with a plank ceiling so first person looks up at
// joists rather than into the roof (it lifts away with the roof in the
// third-person cutaway).
//
// Rooms are laid out in a DOOR frame: u runs along the door wall's inner face
// (0 at its left end, Wu wide), v inward from it (Dv deep). One layout per
// role then fits whichever way the door faces. Pieces that block the player
// add circle colliders to `props`.
function furnish(THREE, A, B, o) {
  const { T, G, bid, ceilBid, H1, cTi, rp, props, role } = o;
  const LN = 8;                                                // the lining (buildTown)
  const X0 = (B.x0 + 1) * T + LN, X1 = B.x1 * T - LN, Z0 = (B.y0 + 1) * T + LN, Z1 = B.y1 * T - LN;   // inner faces
  const side = (B.doors[0] || {}).side || 's';
  const V = side === 's' ? [0, -1] : side === 'n' ? [0, 1] : side === 'w' ? [1, 0] : [-1, 0];
  const U = [-V[1], V[0]];
  const Wu = (side === 'n' || side === 's') ? X1 - X0 : Z1 - Z0, Dv = (side === 'n' || side === 's') ? Z1 - Z0 : X1 - X0;
  // the inner face of the door wall, left end
  const ox = side === 's' ? X0 : side === 'n' ? X1 : side === 'w' ? X0 : X1;
  const oz = side === 's' ? Z1 : side === 'n' ? Z0 : side === 'w' ? Z0 : Z1;
  const P = (u, v) => [ox + U[0] * u + V[0] * v, oz + U[1] * u + V[1] * v];
  const F = G + 4;                                            // the floor's top
  // an axis-aligned box from room coords
  const box = (acc, u0, v0, u1, v1, y0, y1, col, b = -1) => {
    const a = P(u0, v0), c = P(u1, v1);
    acc.box(Math.min(a[0], c[0]), F + y0, Math.min(a[1], c[1]), Math.max(a[0], c[0]), F + y1, Math.max(a[1], c[1]), col, b);
  };
  const block = (u0, v0, u1, v1, r = 14) => {                  // colliders over a footprint
    const du = u1 - u0, dv = v1 - v0, n = Math.max(1, Math.ceil(Math.max(Math.abs(du), Math.abs(dv)) / 20));
    const lu = Math.abs(du) >= Math.abs(dv);
    for (let k = 0; k <= n; k++) {
      const t = k / n, u = lu ? u0 + du * t : (u0 + u1) / 2, v = lu ? (v0 + v1) / 2 : v0 + dv * t;
      const q = P(u, v); props.push({ x: q[0], z: q[1], r: Math.max(r, (lu ? Math.abs(dv) : Math.abs(du)) / 2 + 4) });
    }
  };
  // (lighter than the frame timbers: counters in cTi read as black slabs, critic I5)
  const plank = [0.42, 0.30, 0.20], wood = mul(plank, 1.45), dark = mul(plank, 1.05), ironC = [0.06, 0.06, 0.06];
  const cloth = [[0.45, 0.12, 0.10], [0.16, 0.24, 0.40], [0.22, 0.34, 0.18], [0.46, 0.36, 0.16]][Math.floor(rp() * 4)];

  const counter = (uc, vc, len, deep = 28) => {
    box(A.timber, uc - len / 2, vc - deep / 2, uc + len / 2, vc + deep / 2, 0, 66, dark);
    box(A.timber, uc - len / 2 + 4, vc - deep / 2 - 1, uc + len / 2 - 4, vc + deep / 2 + 1, 8, 58, mul(dark, 1.15));   // a panel
    box(A.timber, uc - len / 2 - 4, vc - deep / 2 - 5, uc + len / 2 + 4, vc + deep / 2 + 5, 66, 71, wood);
    block(uc - len / 2, vc, uc + len / 2, vc);
  };
  const shelves = (u0, u1, vBack, h = 150) => {           // against the far wall, facing the door
    for (const u of [u0, (u0 + u1) / 2, u1]) box(A.timber, u - 3, vBack - 26, u + 3, vBack, 0, h, dark);
    for (const y of [36, 76, 116, h - 4]) box(A.timber, u0, vBack - 26, u1, vBack, y, y + 4, wood);
    for (const y of [40, 80, 120]) for (let u = u0 + 8; u < u1 - 10; u += 14 + rp() * 8) {
      if (rp() < 0.3) continue;
      const c = [[0.55, 0.28, 0.15], [0.2, 0.3, 0.45], [0.6, 0.55, 0.4], [0.3, 0.42, 0.25]][Math.floor(rp() * 4)];
      const hh = 12 + rp() * 16; box(A.timber, u, vBack - 20, u + 8 + rp() * 6, vBack - 6, y, y + hh, c);
    }
    block(u0, vBack - 13, u1, vBack - 13);
  };
  const table = (uc, vc, lu = 110, lv = 60) => {
    box(A.timber, uc - lu / 2, vc - lv / 2, uc + lu / 2, vc + lv / 2, 60, 65, wood);
    for (const [du, dv] of [[-1, -1], [1, -1], [-1, 1], [1, 1]]) box(A.timber, uc + du * (lu / 2 - 8) - 3, vc + dv * (lv / 2 - 8) - 3, uc + du * (lu / 2 - 8) + 3, vc + dv * (lv / 2 - 8) + 3, 0, 60, dark);
    block(uc - lu / 2 + 10, vc, uc + lu / 2 - 10, vc, lv / 2);
  };
  const stool = (u, v) => { box(A.timber, u - 11, v - 11, u + 11, v + 11, 36, 40, wood); for (const [a, b] of [[-1, -1], [1, 1], [-1, 1], [1, -1]]) box(A.timber, u + a * 7 - 2, v + b * 7 - 2, u + a * 7 + 2, v + b * 7 + 2, 0, 36, dark); };
  const bed = (u0, v0, along = 'v') => {                    // 110 long, 60 wide, head against a wall
    const [lu, lv] = along === 'v' ? [60, 110] : [110, 60];
    box(A.timber, u0, v0, u0 + lu, v0 + lv, 0, 26, dark);
    box(A.plaster, u0 + 3, v0 + 3, u0 + lu - 3, v0 + lv - 3, 26, 36, cloth);
    const pu = along === 'v' ? [u0 + 8, v0 + lv - 26, u0 + lu - 8, v0 + lv - 6] : [u0 + lu - 26, v0 + 8, u0 + lu - 6, v0 + lv - 8];
    box(A.plaster, pu[0], pu[1], pu[2], pu[3], 36, 44, [0.85, 0.82, 0.74]);
    box(A.timber, along === 'v' ? u0 : u0 + lu - 6, along === 'v' ? v0 + lv - 6 : v0, along === 'v' ? u0 + lu : u0 + lu, along === 'v' ? v0 + lv : v0 + lv, 0, 60, dark);   // headboard
    block(u0 + lu / 2, v0 + 10, u0 + lu / 2, v0 + lv - 10, Math.min(lu, lv) / 2 + 2);
  };
  const hearth = (uc, onRight) => {                         // against a side wall, facing across the room
    // A chimney breast 34 deep with a real firebox 22 into it: the flames
    // stood on the ledge outside a painted-on opening (critic r3).
    const vc = Dv * 0.62, D = 34, FB = 22, face = onRight ? Wu - D : D;
    const U = (p, q) => onRight ? [face + p, face + q] : [face - q, face - p];   // depth p..q into the breast
    const st = [0.55, 0.52, 0.48], soot = [0.23, 0.2, 0.19];
    { const [a0, a1] = U(0, D);
      box(A.stone, a0, vc - 44, a1, vc - 26, 0, 150, st); box(A.stone, a0, vc + 26, a1, vc + 44, 0, 150, st);   // cheeks
      box(A.stone, a0, vc - 26, a1, vc + 26, 56, 150, st); }                                                      // the breast over the opening
    { const [a0, a1] = U(FB, D); box(A.stone, a0, vc - 26, a1, vc + 26, 0, 56, soot); }                           // the sooty back
    { const [a0, a1] = U(0, FB); box(A.stone, a0, vc - 26, a1, vc + 26, 0, 6, soot); }                            // its floor
    { const [a0, a1] = U(-8, 0); box(A.stone, a0, vc - 50, a1, vc + 50, 0, 10, [0.45, 0.43, 0.4]); }             // hearthstone
    { const [a0, a1] = U(4, 19); box(A.fire, a0, vc - 20, a1, vc + 20, 6, 10, [1, 0.25, 0.03]);                  // embers
      box(A.timber, a0, vc - 18, a1, vc + 18, 9, 13, [0.2, 0.13, 0.08]); }                                        // the logs
    { const [a0, a1] = U(-6, 0); box(A.stone, a0, vc - 52, a1, vc + 52, 96, 106, [0.6, 0.57, 0.52]); }           // mantel
    // the flames: game3d's animated fire cards, burning at noon
    for (const dv of [-11, 0, 11]) { const q = P(onRight ? face + 11 : face - 11, vc + dv); o.fires.push({ x: q[0], y: F + 24 + (dv ? 0 : 4), z: q[1], s: dv ? 1.9 : 2.5 }); }
    block(face, vc - 40, face, vc + 40, 20);
    const q = P(onRight ? face - 20 : face + 20, vc); o.lights.push({ x: q[0], y: F + 60, z: q[1], bid: o.lightBid, warm: true });
  };
  const barrelAt = (u, v) => { const q = P(u, v); barrel(THREE, A, q[0], q[1], F - 4, mul(cTi, 1.1), -1); props.push({ x: q[0], z: q[1], r: 19 }); };
  const crate = (u, v, sz = 46) => { box(A.timber, u - sz / 2, v - sz / 2, u + sz / 2, v + sz / 2, 0, sz, [0.5, 0.38, 0.24]); block(u, v, u, v, sz / 2 + 3); };
  const rug = (uc, vc, lu, lv) => box(A.plaster, uc - lu / 2, vc - lv / 2, uc + lu / 2, vc + lv / 2, 0.4, 1.2, mul(cloth, 1.2));
  const anvil = (u, v) => {                                   // on a stump: an iron body, a waist, a horn
    box(A.timber, u - 16, v - 16, u + 16, v + 16, 0, 40, [0.42, 0.3, 0.19]);
    box(A.timber, u - 12, v - 8, u + 12, v + 8, 40, 48, ironC); box(A.timber, u - 22, v - 10, u + 18, v + 10, 48, 62, [0.1, 0.1, 0.11]);
    box(A.timber, u + 18, v - 5, u + 34, v + 5, 52, 60, [0.1, 0.1, 0.11]); block(u, v, u, v, 22); };
  const forge = (u0, u1, vBack) => {
    box(A.stone, u0, vBack - 60, u1, vBack, 0, 56, [0.4, 0.37, 0.34]);
    box(A.fire, u0 + 8, vBack - 54, u1 - 8, vBack - 12, 56, 61, [1, 0.22, 0.03]);     // the coal bed, always glowing
    box(A.stone, u0 + 6, vBack - 12, u1 - 6, vBack, 56, 130, [0.23, 0.2, 0.19]);     // the sooty back (the plaster showed through, critic r3)
    // (staggered in height and depth: an even row read as a line of candles, critic r4)
    [[-60, 4, -3], [-36, -6, 6], [-12, 3, -7], [12, -4, 5], [36, 7, -2], [60, -3, 4]].forEach(([du, dz, dy]) => {
      const q = P((u0 + u1) / 2 + du, vBack - 32 + dz); o.fires.push({ x: q[0], y: F + 80 + dy, z: q[1], s: 2.2 + (Math.abs(du) < 30 ? 0.5 : 0) }); });
    // the hood, stepping in to a chimney that runs into the ceiling
    box(A.stone, u0 + 6, vBack - 58, u1 - 6, vBack, 128, 150, [0.45, 0.42, 0.38]);
    box(A.stone, u0 + 22, vBack - 44, u1 - 22, vBack, 150, 172, [0.47, 0.44, 0.4]);
    box(A.stone, u0 + 44, vBack - 32, u1 - 44, vBack, 172, H1 - 2, [0.5, 0.47, 0.43]);
    for (const e of [-1, 1]) box(A.stone, e < 0 ? u0 + 6 : u1 - 16, vBack - 58, e < 0 ? u0 + 16 : u1 - 6, vBack - 48, 56, 128, [0.42, 0.39, 0.35]);   // the hood's legs
    block(u0, vBack - 30, u1, vBack - 30, 30);
    const q = P((u0 + u1) / 2, vBack - 30); o.lights.push({ x: q[0], y: F + 80, z: q[1], bid: o.lightBid, warm: true });
  };
  const hay = (u, v) => { box(A.thatch, u - 30, v - 20, u + 30, v + 20, 0, 36, [0.8, 0.72, 0.45]); block(u, v, u, v, 32); };
  const bookcase = (u0, u1, vBack) => shelves(u0, u1, vBack, 180);
  // ── clutter (critic I1: "25–40 props a room") ──
  const sack = (u, v) => { box(A.plaster, u - 13, v - 11, u + 13, v + 11, 0, 30, [0.72, 0.62, 0.45]); box(A.plaster, u - 9, v - 7, u + 9, v + 7, 30, 38, [0.66, 0.56, 0.4]); block(u, v, u, v, 14); };
  const pot = (u, v, y, c = [0.6, 0.3, 0.16], hh = 14) => { box(A.plaster, u - 5, v - 5, u + 5, v + 5, y, y + hh, c); box(A.plaster, u - 3, v - 3, u + 3, v + 3, y + hh, y + hh + 4, mul(c, 0.8)); };
  const candle = (u, v, y) => { box(A.plaster, u - 2, v - 2, u + 2, v + 2, y, y + 10, [0.9, 0.86, 0.75]); box(A.fire, u - 1.5, v - 1.5, u + 1.5, v + 1.5, y + 10, y + 15, [1, 0.55, 0.15]); };
  const book = (u, v, y, c) => box(A.timber, u - 8, v - 6, u + 8, v + 6, y, y + 4, c);
  const chair = (u, v, back) => {                             // back: +1/-1 = the backrest on the +v / -v side
    stool(u, v); box(A.timber, u - 11, v + back * 9, u + 11, v + back * 11, 40, 92, dark); box(A.timber, u - 11, v + back * 8, u + 11, v + back * 12, 88, 94, wood); };
  // against the back wall, facing the door
  const tapestry = (u0, u1, y0, y1, c = cloth) => {
    box(A.plaster, u0, back - 2, u1, back, y0, y1, c); box(A.plaster, u0 + 6, back - 3, u1 - 6, back - 2, y0 + 8, y1 - 8, mul(c, 1.35));
    box(A.timber, u0 - 6, back - 6, u1 + 6, back, y1, y1 + 4, dark); };
  const wallShelf = (u0, u1, y, items = 4) => {
    box(A.timber, u0, back - 20, u1, back, y, y + 4, wood);
    for (let k = 0; k < items; k++) pot(u0 + 12 + (u1 - u0 - 24) * k / Math.max(1, items - 1), back - 10, y + 4, [[0.55, 0.36, 0.24], [0.7, 0.65, 0.55], [0.35, 0.4, 0.45]][k % 3], 10 + (k % 2) * 6); };
  // a cupboard against a side wall (left: u = 0, right: u = Wu), v0..v1 along it
  const cupboard = (onRight, v0, v1, h = 170) => {
    const u0 = onRight ? Wu - 30 : 0, u1 = onRight ? Wu : 30;
    box(A.timber, u0, v0, u1, v1, 0, h, dark); box(A.timber, onRight ? u0 - 1 : u1, v0 + 6, onRight ? u0 : u1 + 1, v1 - 6, 10, h - 10, mul(dark, 1.2));
    box(A.timber, onRight ? u0 - 2 : u1, (v0 + v1) / 2 - 1, onRight ? u0 : u1 + 2, (v0 + v1) / 2 + 1, 10, h - 10, [0.1, 0.07, 0.05]);
    block(onRight ? u0 + 15 : u1 - 15, v0 + 10, onRight ? u0 + 15 : u1 - 15, v1 - 10, 17); };
  // stairs up to the loft along the back wall, rising from u0 to u1 into a stairwell
  let hole = null;                                            // [u0, u1, v0, v1]: the stairwell through the ceiling
  const stairs = (u0, u1, depth = 58) => {
    const n = 12, du = (u1 - u0) / n, rise = (H1 - 8) / n, v0 = back - depth;
    for (let i = 0; i < n; i++) box(A.timber, u0 + du * i, v0, u0 + du * (i + 1), back, 0, rise * (i + 1), i % 2 ? wood : mul(wood, 0.9));
    box(A.timber, u0, v0 - 4, u1, v0, 0, 10, dark);
    // the ceiling opens over the top five steps (they ran into the planks, critic r2)
    hole = [Math.min(u1, u1 - du * 5), Math.max(u1, u1 - du * 5), v0 - 6, back];
    block(u0 + du, back - depth / 2, u1, back - depth / 2, depth / 2); };

  const mid = Wu / 2, back = Dv;
  // the shopkeeper stands 4 tiles in (city.js); the counter is between them and
  // the door, 3 tiles in, leaving a passage round each end
  const vC = 3 * T - T / 2 + 6;
  switch (role) {
    case 'merchant':
      counter(mid, vC, 160); shelves(mid - 150, mid + 150, back); crate(40, back - 60); crate(84, back - 50, 34); crate(40, back - 104, 34);
      barrelAt(Wu - 40, 40); barrelAt(Wu - 40, 84); sack(Wu - 50, back - 50); sack(Wu - 84, back - 44); sack(Wu - 60, back - 84);
      rug(mid, vC - 60, 120, 60);
      for (const u of [mid - 60, mid - 40, mid + 30]) pot(u, vC, 71, [0.6, 0.45, 0.3], 12);
      box(A.timber, mid + 50, vC - 8, mid + 70, vC + 8, 71, 74, [0.6, 0.5, 0.2]); candle(mid - 5, vC + 4, 71);   // scales, a candle
      tapestry(mid - 60, mid + 60, 160, H1 - 30);
      cupboard(false, 150, 240); break;
    case 'blacksmith':
      forge(mid - 80, mid + 80, back); anvil(mid - 10, back - 60 - 72); barrelAt(40, back - 40); crate(Wu - 44, back - 44);
      // a rack of finished blades on the back wall, points down
      for (const u of [22, 146]) box(A.timber, u - 3, back - 14, u + 3, back, 0, 150, dark);
      for (const y of [44, 132]) box(A.timber, 22, back - 14, 146, back - 8, y, y + 5, dark);
      for (let u = 36; u <= 132; u += 16) {
        box(A.timber, u - 1.5, back - 12, u + 1.5, back - 9, 30, 118, [0.66, 0.68, 0.7]);            // the blade
        box(A.timber, u - 6, back - 13, u + 6, back - 8, 118, 122, [0.15, 0.13, 0.1]);                 // crossguard
        box(A.timber, u - 1.5, back - 12, u + 1.5, back - 9, 122, 140, [0.3, 0.2, 0.12]); }           // grip
      counter(mid, vC, 120);
      barrelAt(mid + 60, back - 130);                                                               // the quench tub
      sack(Wu - 50, back - 100); sack(Wu - 84, back - 96);                                         // charcoal
      for (let k = 0; k < 5; k++) box(A.timber, Wu - 3, 150 + k * 16, Wu, 160 + k * 16, 90, 140, ironC);   // tongs and hammers on the wall
      box(A.stone, 40, vC + 50, 76, vC + 90, 0, 30, [0.45, 0.43, 0.4]); box(A.stone, 50, vC + 58, 66, vC + 82, 30, 64, [0.6, 0.58, 0.55]); block(58, vC + 70, 58, vC + 70, 22);   // grindstone
      box(A.timber, mid - 30, vC - 4, mid + 10, vC + 4, 71, 74, ironC); box(A.timber, mid + 20, vC - 10, mid + 44, vC + 10, 71, 73, [0.35, 0.3, 0.25]); break;   // a blade and a whetstone
    case 'mage':
      counter(mid, vC, 140); bookcase(20, Wu - 20, back);
      { const ou = Wu - 90, ov = back - 130, q = P(ou, ov);   // (off the entry path: it filled the view from the door, critic r2)
        box(A.timber, ou - 20, ov - 20, ou + 20, ov + 20, 0, 34, ironC); box(A.fire, ou - 12, ov - 12, ou + 12, ov + 12, 34, 58, [0.5, 0.95, 0.65]); block(ou, ov, ou, ov, 24);
        o.lights.push({ x: q[0], y: F + 70, z: q[1], bid: o.lightBid, warm: false }); }
      rug(mid, vC - 60, 140, 70);
      table(90, vC + 150, 100, 56); chair(90, vC + 190, 1);
      for (const [u, c] of [[70, [0.5, 0.15, 0.12]], [92, [0.15, 0.25, 0.45]], [110, [0.3, 0.35, 0.18]]]) book(u, vC + 150, 65, c);
      candle(125, vC + 140, 65); candle(55, vC + 160, 65);
      for (let k = 0; k < 4; k++) pot(Wu - 40, 150 + k * 26, 0, [[0.3, 0.5, 0.6], [0.5, 0.3, 0.55], [0.3, 0.55, 0.35], [0.6, 0.5, 0.25]][k], 18 + k * 3);
      pot(mid - 40, vC, 71, [0.3, 0.5, 0.6], 16); candle(mid + 40, vC, 71); break;
    case 'farrier':
      counter(mid, vC, 120); hay(50, back - 40); hay(50, back - 90); hay(Wu - 50, back - 40); barrelAt(Wu - 40, 60);
      box(A.timber, mid - 40, back - 12, mid + 40, back, 60, 66, dark);   // a saddle bar on the far wall
      for (const u of [mid - 22, mid + 22]) { box(A.plaster, u - 16, back - 30, u + 16, back - 6, 66, 80, [0.45, 0.28, 0.16]); box(A.plaster, u - 12, back - 26, u + 12, back - 10, 50, 66, [0.4, 0.25, 0.14]); }   // saddles
      for (let k = 0; k < 6; k++) box(A.timber, mid - 70 + k * 28, back - 3, mid - 58 + k * 28, back, 130, 142, ironC);   // horseshoes
      sack(Wu - 50, back - 100); sack(Wu - 86, back - 90); barrelAt(Wu - 40, 104);
      box(A.timber, 40, vC + 40, 76, vC + 64, 0, 24, [0.5, 0.38, 0.24]); block(58, vC + 52, 58, vC + 52, 18);   // a feed trough
      break;
    case 'bank':
      counter(mid, vC, Wu - 200, 34); crate(50, back - 50, 40); crate(95, back - 50, 40); crate(Wu - 50, back - 50, 40); crate(Wu - 95, back - 50, 40);
      shelves(mid - 120, mid + 120, back); rug(mid, vC - 70, 200, 70);
      for (const u of [mid - 200, mid - 60, mid + 60, mid + 200]) candle(u, vC, 71);
      for (const u of [mid - 150, mid + 110]) { box(A.timber, u, vC - 6, u + 40, vC + 6, 71, 73, [0.85, 0.8, 0.65]); }   // ledgers
      // banners hung the long way, from the dado up (squashed strips under the beams, critic r2)
      [70, 170, Wu - 170, Wu - 70].forEach((u, k) => tapestry(u - 34, u + 34, 86, H1 - 26, k % 2 ? [0.16, 0.24, 0.4] : [0.45, 0.12, 0.1]));
      { const u = mid, v = back - 130; box(A.timber, u - 40, v - 26, u + 40, v + 26, 0, 50, [0.3, 0.2, 0.12]);   // the strongbox
        for (const du of [-26, 0, 26]) box(A.timber, u + du - 3, v - 27, u + du + 3, v + 27, 0, 51, ironC); block(u - 30, v, u + 30, v, 30); }
      table(120, vC + 140, 110, 60); chair(120, vC + 185, 1); table(Wu - 120, vC + 140, 110, 60); chair(Wu - 120, vC + 185, 1);
      book(110, vC + 140, 65, [0.5, 0.15, 0.12]); book(Wu - 130, vC + 140, 65, [0.15, 0.25, 0.45]);
      cupboard(false, 240, 360); cupboard(true, 240, 360);
      // posts carrying the long span, with knee braces up to the joists
      for (const u of [mid - 190, mid + 190]) for (const v of [Dv * 0.42, Dv * 0.72]) {
        box(A.timber, u - 11, v - 11, u + 11, v + 11, 0, H1 - 20, dark); box(A.stone, u - 16, v - 16, u + 16, v + 16, 0, 10, [0.55, 0.52, 0.48]);
        for (const s of [-1, 1]) { const q0 = P(u, v), q1 = P(u + s * 40, v); A.timber.beam(THREE, [q0[0], F + H1 - 70, q0[1]], [q1[0], F + H1 - 22, q1[1]], 7, dark, -1, 7); }
        block(u, v, u, v, 16); }
      // the counting table down the middle: ledgers, coin, candles, chairs
      { const vt = Dv * 0.57; table(mid, vt, 260, 70);
        for (const du of [-90, -30, 30, 90]) { chair(mid + du, vt - 48, -1); chair(mid + du, vt + 48, 1); }
        for (const du of [-100, 20]) book(mid + du, vt, 65, [0.85, 0.8, 0.65]);
        for (const [du, n] of [[-50, 4], [-40, 2], [60, 5], [72, 3]]) for (let k = 0; k < n; k++) box(A.timber, mid + du - 4, vt - 4, mid + du + 4, vt + 4, 65 + k * 2, 66.5 + k * 2, [0.85, 0.62, 0.2]);   // coin
        candle(mid - 20, vt, 65); candle(mid + 110, vt - 10, 65); }
      break;
    case 'healer':
      counter(mid, vC, 120); bed(20, back - 130); bed(Wu - 80, back - 130); shelves(mid - 90, mid + 90, back);
      hearth(mid, false);
      for (const u of [mid - 40, mid - 20, mid + 30]) pot(u, vC, 71, [0.7, 0.65, 0.55], 12);
      candle(mid + 10, vC, 71);
      table(Wu - 90, vC + 110, 90, 50); stool(Wu - 90, vC + 150);
      for (let k = 0; k < 3; k++) box(A.plaster, Wu - 120 + k * 22, vC + 104, Wu - 108 + k * 22, vC + 116, 65, 69, [0.35, 0.5, 0.25]);   // herbs drying
      barrelAt(Wu - 40, 40); box(A.timber, 40, 40, 70, 64, 0, 26, [0.5, 0.38, 0.24]);   // a bucket
      break;
    case 'antiquarian': case 'curator': case 'cryptologist': case 'grave_robber': case 'fletcher':
      counter(mid, vC, 140); shelves(mid - 150, mid + 150, back); crate(Wu - 44, 44); table(70, back - 110, 90, 50); stool(70, back - 150);
      if (role === 'fletcher') for (let u = Wu - 140; u <= Wu - 40; u += 20) box(A.timber, u - 1.5, back - 6, u + 1.5, back, 20, 130, wood);   // bows on the wall
      else tapestry(Wu - 150, Wu - 30, 120, H1 - 30);
      crate(Wu - 44, 94, 34); sack(40, 44); barrelAt(Wu - 44, vC + 60);
      for (const u of [mid - 40, mid + 20]) pot(u, vC, 71, [0.55, 0.5, 0.4], 12); candle(mid - 5, vC, 71);
      book(62, back - 110, 65, [0.5, 0.15, 0.12]); candle(88, back - 104, 65);
      rug(mid, vC - 55, 110, 50);
      break;
    default: {                                                // a home
      bed(20, back - 130); bed(96, back - 130);
      box(A.timber, 20, back - 176, 76, back - 140, 0, 34, [0.5, 0.38, 0.24]); block(48, back - 158, 48, back - 158, 22);   // a chest at the bed's foot
      table(mid + 40, Dv * 0.45); chair(mid + 20, Dv * 0.45 - 46, -1); stool(mid + 60, Dv * 0.45 + 44);
      pot(mid + 25, Dv * 0.45, 65, [0.7, 0.65, 0.55], 12); candle(mid + 50, Dv * 0.45 - 8, 65); pot(mid + 60, Dv * 0.45 + 10, 65, [0.55, 0.36, 0.24], 8);
      hearth(mid, true); crate(40, 40, 36); barrelAt(Wu - 40, 40); sack(Wu - 44, 86); rug(mid, Dv * 0.45, 170, 110);
      stairs(Math.min(mid - 10, 176), Wu - 44);
      cupboard(false, 160, 240);
      wallShelf(20, 150, 150, 4);
    }
  }
  // a lantern hung from the ceiling's middle, in every room: shops without a
  // hearth were lit only through their windows, and read as cellars at noon
  { const u = mid, v = Dv * 0.5, q = P(u, v);
    // (hung just under the joists: lower, it hung at eye level in the doorway)
    A.timber.beam(THREE, [q[0], F + H1 - 20, q[1]], [q[0], F + H1 - 26, q[1]], 2, ironC, ceilBid, 2);
    box(A.timber, u - 9, v - 9, u + 9, v + 9, H1 - 30, H1 - 26, ironC, ceilBid);
    box(A.fire, u - 7, v - 7, u + 7, v + 7, H1 - 48, H1 - 30, [1, 0.62, 0.25], ceilBid);
    box(A.timber, u - 9, v - 9, u + 9, v + 9, H1 - 52, H1 - 48, ironC, ceilBid);
    // the light itself sits lower, mid-room: at the lantern it blew the ceiling out
    o.lights.push({ x: q[0], y: F + H1 * 0.6, z: q[1], bid: o.lightBid, warm: true }); }
  // the ceiling: planks at the storey line, joists under them
  // (on the timber material: the floor's is never cut away, and a plank lid
  //  sat over the room in the third-person view)
  // (lighter: a dark lid made every room a cellar, critic I6)
  const cc = [0.74, 0.6, 0.44];
  if (!hole) box(A.timber, 0, 0, Wu, Dv, H1 - 8, H1 - 2, cc, ceilBid);
  else {
    const [h0, h1, hv0, hv1] = hole;
    box(A.timber, 0, 0, Wu, hv0, H1 - 8, H1 - 2, cc, ceilBid);
    if (hv1 < Dv) box(A.timber, 0, hv1, Wu, Dv, H1 - 8, H1 - 2, cc, ceilBid);
    box(A.timber, 0, hv0, h0, hv1, H1 - 8, H1 - 2, cc, ceilBid); box(A.timber, h1, hv0, Wu, hv1, H1 - 8, H1 - 2, cc, ceilBid);
    // trimmers round the opening, a boarded shaft up, and the loft's floor seen through it
    box(A.timber, h0 - 8, hv0 - 8, h1 + 8, hv0, H1 - 22, H1 - 2, dark, ceilBid);
    for (const u of [h0 - 8, h1]) box(A.timber, u, hv0, u + 8, hv1, H1 - 22, H1 - 2, dark, ceilBid);
    box(A.boards, h0 - 8, hv0 - 8, h1 + 8, hv0 - 6, H1 - 2, H1 + 110, [0.5, 0.4, 0.3], ceilBid);
    for (const u of [h0 - 8, h1 + 6]) box(A.boards, u, hv0, u + 2, hv1, H1 - 2, H1 + 110, [0.5, 0.4, 0.3], ceilBid);
    box(A.timber, h0 - 8, hv0 - 8, h1 + 8, hv1, H1 + 110, H1 + 114, [0.16, 0.12, 0.08], ceilBid);
  }
  for (let u = 36; u < Wu; u += 48) {
    if (hole && u + 5 > hole[0] - 8 && u - 5 < hole[1] + 8) { box(A.timber, u - 5, 0, u + 5, hole[2] - 8, H1 - 20, H1 - 8, wood, ceilBid); continue; }
    box(A.timber, u - 5, 0, u + 5, Dv, H1 - 20, H1 - 8, wood, ceilBid);
  }
}

// ── Street dressing (v0.24) ───────────────────────────────────────────
// The ×2.5 city's courtyard and streets were bare sand (city critic r1). Each
// entry of city.js CITY_EXTRAS is drawn here: a well, market stalls, lamp posts
// and carts. `x, y` is the tile, `rot` a quarter-turn count; pieces are laid
// out in a local frame (u across, v deep) and turned into place. Anything you
// would walk into gets a circle collider in `props`; the lamps' flames are
// returned for game3d's flame cards and light pool.
function dress(THREE, A, extras, { T, groundAt, props, flames }) {
  const iron = [0.06, 0.06, 0.06], wood = hex(THREE, 0x6a4a30), dark = hex(THREE, 0x3f2c1d);
  const stoneC = hex(THREE, 0xb3a78f), roofC = hex(THREE, 0x8c4a30);
  const CANVAS = [[hex(THREE, 0xb8574f), hex(THREE, 0xe6dfcc)], [hex(THREE, 0x4f6b8a), hex(THREE, 0xe6dfcc)],
                  [hex(THREE, 0x5f7a3e), hex(THREE, 0xd9ceb4)], [hex(THREE, 0xc49a3c), hex(THREE, 0x7a2e22)]];
  extras.forEach((e, k) => {
    const cx = (e.x + 0.5) * T, cz = (e.y + 0.5) * T, G = groundAt(cx, cz);
    const a = (e.rot || 0) * Math.PI / 2, ca = Math.round(Math.cos(a)), sa = Math.round(Math.sin(a));
    const P = (u, v, y) => [cx + ca * u - sa * v, G + y, cz + sa * u + ca * v];
    const N = (u, v, y = 0) => [ca * u - sa * v, y, sa * u + ca * v];
    // an axis-aligned box from local coords (quarter turns keep it aligned)
    const box = (acc, u0, v0, u1, v1, y0, y1, col) => {
      const p = P(u0, v0, 0), q = P(u1, v1, 0);
      acc.box(Math.min(p[0], q[0]), G + y0, Math.min(p[2], q[2]), Math.max(p[0], q[0]), G + y1, Math.max(p[2], q[2]), col);
    };
    const coll = (u, v, r) => { const p = P(u, v, 0); props.push({ x: p[0], z: p[2], r }); };
    for (const k2 in A) { A[k2].cut = -1; A[k2].base = G; }

    if (e.type === 'well') {
      // an eight-sided stone kerb, a dark water disc, two posts, a winch and a little roof
      const R0 = 44, R1 = 34, H = 42, pt = (i, r, y) => { const t = i * Math.PI / 4 + Math.PI / 8; return [cx + Math.cos(t) * r, G + y, cz + Math.sin(t) * r]; };
      for (let i = 0; i < 8; i++) {
        const t = (i + 0.5) * Math.PI / 4 + Math.PI / 8, n = [Math.cos(t), 0, Math.sin(t)];
        A.stone.quad(pt(i, R0, -20), pt(i + 1, R0, -20), pt(i + 1, R0, H), pt(i, R0, H), n, stoneC);
        A.stone.quad(pt(i, R1, 0), pt(i + 1, R1, 0), pt(i + 1, R1, H), pt(i, R1, H), [-n[0], 0, -n[2]], mul(stoneC, 0.7));
        A.stone.quad(pt(i, R1, H), pt(i + 1, R1, H), pt(i + 1, R0 + 3, H + 6), pt(i, R0 + 3, H + 6), [0, 1, 0], mul(stoneC, 1.1));
        A.stone.quad(pt(i, R0 + 3, H), pt(i + 1, R0 + 3, H), pt(i + 1, R0 + 3, H + 6), pt(i, R0 + 3, H + 6), n, mul(stoneC, 1.05));
      }
      A.glass.box(cx - R1, G + 10, cz - R1, cx + R1, G + 12, cz + R1, [0.2, 0.3, 0.35]);
      for (const s of [-1, 1]) box(A.timber, s * 38 - 5, -5, s * 38 + 5, 5, H, 190, dark);
      A.timber.beam(THREE, P(-44, 0, 150), P(44, 0, 150), 8, wood);                      // the winch
      A.timber.beam(THREE, P(-20, 0, 150), P(-20, 0, 62), 1.5, [0.55, 0.48, 0.35]);       // rope
      box(A.timber, -28, -9, -12, 9, 44, 62, wood);                                       // bucket
      // the roof: two tiled slopes, both faces, and a ridge
      for (const s of [-1, 1]) {
        const q = [P(-58, 0, 214), P(58, 0, 214), P(58, s * 62, 168), P(-58, s * 62, 168)];
        A.roof.quad(...q, N(0, s * 0.6, 0.8), roofC);
        A.roof.quad(...q, N(0, -s * 0.6, -0.8), mul(roofC, 0.6));
      }
      A.timber.beam(THREE, P(-60, 0, 216), P(60, 0, 216), 7, dark);
      for (let i = 0; i < 8; i++) { const t = i * Math.PI / 4; props.push({ x: cx + Math.cos(t) * 32, z: cz + Math.sin(t) * 32, r: 16 }); }
      props.push({ x: cx, z: cz, r: 30 });
    } else if (e.type === 'stall') {
      // a trestle counter 3 tiles long under a striped canvas awning, goods on it
      const W = 72, D = 30, [c1, c2] = CANVAS[k % CANVAS.length];
      box(A.timber, -W, -D, W, D, 0, 64, dark);
      box(A.timber, -W - 4, -D - 6, W + 4, D + 4, 64, 70, wood);
      for (const [u, v, h] of [[-W, -D - 40, 220], [W, -D - 40, 220], [-W, D, 180], [W, D, 180]]) box(A.timber, u - 4, v - 4, u + 4, v + 4, 0, h, dark);
      // awning: stripes, both faces, sloping from the back posts down over the counter
      const n = 8;
      for (let i = 0; i < n; i++) {
        const u0 = -W - 10 + (2 * W + 20) * i / n, u1 = -W - 10 + (2 * W + 20) * (i + 1) / n, col = i % 2 ? c1 : c2;
        const q = [P(u0, -D - 48, 226), P(u1, -D - 48, 226), P(u1, D + 26, 176), P(u0, D + 26, 176)];
        A.plaster.quad(...q, N(0, 0.55, 0.83), col);
        A.plaster.quad(...q, N(0, -0.55, -0.83), mul(col, 0.7));
        A.plaster.quad(P(u0, D + 26, 176), P(u1, D + 26, 176), P(u1, D + 26, 156), P(u0, D + 26, 156), N(0, 1), col);   // the valance
      }
      // goods: baskets of produce, bolts of cloth, crocks
      const G3 = [[0.62, 0.22, 0.14], [0.78, 0.6, 0.2], [0.35, 0.45, 0.2], [0.45, 0.3, 0.55], [0.8, 0.75, 0.6]];
      for (let u = -W + 14, j = 0; u < W - 10; u += 24, j++) {
        const c = G3[(j + k) % G3.length];
        box(A.timber, u - 9, -12, u + 9, 12, 70, 80, [0.5, 0.38, 0.22]);
        box(A.plaster, u - 7, -10, u + 7, 10, 80, 88 + (j % 3) * 3, c);
      }
      for (let u = -W + 10; u <= W - 10; u += 22) coll(u, 0, 26);
    } else if (e.type === 'lamp') {
      // a post on a stone foot, an arm, and a glazed lantern: lit, and on all night
      box(A.stone, -12, -12, 12, 12, -10, 20, stoneC);
      box(A.timber, -5, -5, 5, 5, 20, 236, dark);
      A.timber.beam(THREE, P(0, 0, 226), P(0, 30, 226), 4, iron);
      A.timber.beam(THREE, P(0, 6, 206), P(0, 26, 226), 3, iron);
      box(A.timber, -9, 21, 9, 39, 222, 225, iron);
      box(A.glassLit, -7, 23, 7, 37, 198, 222, [1, 0.8, 0.5]);
      box(A.timber, -10, 20, 10, 40, 194, 198, iron);
      box(A.timber, -9, 21, 9, 39, 225, 230, iron);
      const f = P(0, 30, 204); flames.push({ x: f[0], y: f[1], z: f[2] });
      coll(0, 0, 12);
    } else if (e.type === 'goods') {
      // stock waiting by the stalls: crates, a barrel, sacks
      box(A.timber, -30, -24, 16, 22, 0, 46, [0.5, 0.38, 0.24]); box(A.timber, -24, -18, 10, 16, 46, 80, [0.56, 0.42, 0.27]);
      for (const y of [8, 40]) box(A.timber, -31, -25, 17, 23, y, y + 3, [0.3, 0.22, 0.14]);
      { const p = P(40, 10, 0); barrel(THREE, A, p[0], p[2], G, mul(wood, 1.1), -1); }
      box(A.plaster, 20, -34, 48, -12, 0, 28, [0.72, 0.62, 0.45]); box(A.plaster, 26, -30, 44, -16, 28, 36, [0.66, 0.56, 0.4]);
      coll(-8, 0, 32); coll(40, 10, 20); coll(34, -23, 16);
    } else if (e.type === 'cross') {
      // a market cross: three octagonal steps, a tall shaft, a stone cross
      const oct = (r, y0, y1, c) => { for (let i = 0; i < 8; i++) {
        const t0 = i * Math.PI / 4 + Math.PI / 8, t1 = t0 + Math.PI / 4, tm = (t0 + t1) / 2, n = [Math.cos(tm), 0, Math.sin(tm)];
        const q = (t, y) => [cx + Math.cos(t) * r, G + y, cz + Math.sin(t) * r];
        A.stone.quad(q(t0, y0), q(t1, y0), q(t1, y1), q(t0, y1), n, c);
        A.stone.quad(q(t0, y1), q(t1, y1), [cx, G + y1, cz], [cx, G + y1, cz], [0, 1, 0], mul(c, 1.08)); } };
      oct(70, -12, 16, mul(stoneC, 0.9)); oct(52, 16, 32, stoneC); oct(36, 32, 48, mul(stoneC, 1.05));
      box(A.stone, -12, -12, 12, 12, 48, 70, mul(stoneC, 1.05));
      box(A.stone, -8, -8, 8, 8, 70, 330, mul(stoneC, 1.1));
      box(A.stone, -26, -6, 26, 6, 290, 306, mul(stoneC, 1.1));
      box(A.stone, -11, -11, 11, 11, 326, 336, mul(stoneC, 0.95));
      props.push({ x: cx, z: cz, r: 60 });
    } else if (e.type === 'cart') {
      // a two-wheeled handcart: plank bed with sides, spoked wheels, shafts forward
      const L = 60, Wd = 38, Y = 44;
      box(A.timber, -L, -Wd, L, Wd, Y, Y + 6, wood);
      for (const s of [-1, 1]) box(A.timber, -L, s * Wd - 3, L, s * Wd + 3, Y + 6, Y + 26, mul(wood, 0.9));
      box(A.timber, -L - 3, -Wd, -L + 3, Wd, Y + 6, Y + 26, mul(wood, 0.9));
      for (const s of [-1, 1]) A.timber.beam(THREE, P(L - 10, s * 24, Y + 2), P(L + 80, s * 22, 20), 5, dark);
      A.timber.beam(THREE, P(0, -Wd - 8, 34), P(0, Wd + 8, 34), 5, iron);                // axle
      for (const s of [-1, 1]) {
        const v = s * (Wd + 6), rr = 34;
        const W8 = i => { const t = i * Math.PI / 6; return P(Math.cos(t) * rr, v, 34 + Math.sin(t) * rr); };
        for (let i = 0; i < 12; i++) A.timber.beam(THREE, W8(i), W8(i + 1), 5, dark, -1, 6);
        for (let i = 0; i < 6; i++) A.timber.beam(THREE, W8(i), W8(i + 6), 2.5, wood);
      }
      // a load: sacks and a barrel
      box(A.plaster, -48, -26, -12, 4, Y + 6, Y + 30, [0.72, 0.62, 0.45]);
      box(A.plaster, -40, 6, -6, 30, Y + 6, Y + 26, [0.66, 0.56, 0.4]);
      { const p = P(24, 0, 0); barrel(THREE, A, p[0], p[2], G + Y + 6, mul(wood, 1.1), -1); }
      for (const u of [-50, -20, 10, 40, 80]) coll(u, 0, u > 60 ? 12 : 40);
    }
  });
}

export function buildTown(THREE, { buildings, TILE, groundAt, coastY0 = Infinity, signs = [], extras = [] }) {
  const A = {
    stone: new Acc(96), plaster: new Acc(64), timber: new Acc(48), boards: new Acc(64),
    glass: new Acc(24), glassLit: new Acc(24), roof: new Acc(96), slate: new Acc(96), thatch: new Acc(64),
    floor: new Acc(64), shadow: new Acc(1), spill: new Acc(1), doorGlow: new Acc(48),
    sign: new Acc(1), flowers: new Acc(16),
    // v0.24 interiors: window panes seen from INSIDE (lit by the day, not the
    // night), and fire that burns at noon too (hearths, forges, lanterns)
    pane: new Acc(24), fire: new Acc(24),
  };
  const T = TILE;
  const props = [];           // {x, z, r}: circle colliders for the street furniture (and furniture)
  const lights = [];          // {x, y, z, bid}: a hearth / forge / lamp to light a room you are in
  const fires = [];           // {x, y, z, s}: flame cards for game3d (hearths, forges)
  buildings.forEach((B, bid) => {
    const r = rng(0x9e3779b1 ^ (B.x0 * 73856093) ^ (B.y0 * 19349663));
    const rp = rng(0x51ed270b ^ (B.x0 * 83492791) ^ (B.y0 * 2971215073));   // props only
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
    for (const k in A) { A[k].cut = bid; A[k].base = G; }

    const hut = Math.min(w, h) <= 3 || B.y0 >= coastY0;
    const type = hut ? 'HUT' : (Math.max(w, h) >= 8 ? 'C' : (r() < 0.5 ? 'A' : 'B'));
    const cPl = jit(hex(THREE, pick(PLASTER))), cTi = jit(hex(THREE, pick(TIMBER))), cSt = jit(hex(THREE, pick(STONE)));
    const cDoor = hex(THREE, hut ? 0x4f6b78 : pick(DOORS));
    const slate = !hut && r() >= 0.7;
    const cRf = hut ? mul(hex(THREE, pick(THATCH)), 0.94 + r() * 0.12) : hex(THREE, slate ? pick(SLATE) : pick(CLAY));
    const cBoard = jit(hex(THREE, 0x6f6456)), cSalt = hex(THREE, 0x9a948a);   // tarred boards, salt-bleached at the foot

    const PL = 24;                                   // plinth top
    const DOOR_H = 150;
    const two = type === 'B' || type === 'C';
    // (critic r3: a 112 upper under a 176 base read as a squashed band — the
    // upper storey must be at least a character tall, and the jetty must show)
    // Walk-in rooms (the ×2.5 city) get a taller ground storey: at 164 the
    // ceiling hung 50 over the eye and the lantern at it (interiors critic r1).
    const room = !hut && w >= 7 && h >= 7;
    const H1 = two ? (room ? 220 : 164) : hut ? 160 : 184;   // ground storey top (A/HUT: the eaves) — a 150 door + head beam fits
    const H2 = two ? (type === 'C' ? 156 : 144) : 0; // upper storey height
    const J  = two ? 20 : 0;                          // jetty
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
      A.floor.box(X0 + T, y0, Z0 + T, X1 - T, G + 4, Z1 - T, hut ? mul(cBoard, 1.4) : hex(THREE, 0x8c6a47), -1, {bottom:true});   // (lighter: rooms read as cellars at 0x5a3e27)
    }
    // furniture, and a ceiling you see from inside (rooms big enough to stand in)
    if (room) {
      furnish(THREE, A, B, { T, G, bid, ceilBid: two ? bid : bid, H1, cTi, rp, props, lights, fires, lightBid: bid, role: B.role || 'home' });
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
    // dressed quoins at the stone corners: alternating long and short blocks, paler,
    // 1.5 proud of both faces
    if (two) for (const [qx, qz, sx, sz] of [[X0, Z0, 1, 1], [X1, Z0, -1, 1], [X0, Z1, 1, -1], [X1, Z1, -1, -1]]) {
      for (let y = G + PL, k = 0; y < G + H1 - 6; y += 22, k++) {
        const la = k % 2 ? 20 : 34, lb = k % 2 ? 34 : 20, y1 = Math.min(y + 20, G + H1 - 2), c = mul(cSt, 1.05 + (k % 3) * 0.03);
        const ox = -sx*1.5, oz = -sz*1.5;                 // outward offsets
        // flat freestone like the window dressings: the stone texture's phase
        // fought the wall's at every joint and read as loose slabs (critic)
        A.plaster.box(Math.min(qx + ox, qx + sx*la), y, Math.min(qz + oz, qz), Math.max(qx + ox, qx + sx*la), y1, Math.max(qz + oz, qz), c, -1, {bottom:true});
        A.plaster.box(Math.min(qx + ox, qx), y, Math.min(qz + oz, qz + sz*lb), Math.max(qx + ox, qx), y1, Math.max(qz + oz, qz + sz*lb), c, -1, {bottom:true});
      }
    }

    // over each doorway: wall above the opening
    for (const d of B.doors) {
      const x = d.tx*T, z = d.ty*T, acc = two ? A.stone : hut ? A.boards : A.plaster, col = two ? cSt : hut ? cBoard : cPl;
      if (H1 > DOOR_H + 8) acc.box(x, G + DOOR_H + 8, z, x + T, G + H1, z + T, col, -1, {top:true, bottom:true});
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
        for (let s = 12; s < L; s += 24) {
          const bx = F[0] + F[2]*s, bz = F[1] + F[3]*s;
          A.timber.box(bx - 4 + (F[4] < 0 ? -J - 2 : 0), y0 - 16, bz - 4 + (F[5] < 0 ? -J - 2 : 0),
                       bx + 4 + (F[4] > 0 ? J + 2 : 0), y0 - 8, bz + 4 + (F[5] > 0 ? J + 2 : 0), mul(cTi, 0.9), upperBid);
        }
      }
    }

    // ── huts: corner posts, a wall plate, one small shuttered window per side ──
    if (hut) {
      const cPost = hex(THREE, 0x2b241d); let hutLit = false;
      for (const [px, pz] of [[X0, Z0], [X1, Z0], [X0, Z1], [X1, Z1]])
        A.timber.beam(THREE, [px, gLo - 4, pz], [px, G + H1 + 4, pz], 12, cPost, -1, 12);
      const sides = [[[X0, Z0], [1, 0], [0, -1], X1 - X0], [[X1, Z1], [-1, 0], [0, 1], X1 - X0], [[X0, Z1], [0, -1], [-1, 0], Z1 - Z0], [[X1, Z0], [0, 1], [1, 0], Z1 - Z0]];
      for (const [o, a, n, L] of sides) {
        const at = (s, y, out) => [o[0] + a[0]*s + n[0]*out, y, o[1] + a[1]*s + n[1]*out];
        A.timber.beam(THREE, at(0, G + H1 - 4, 2), at(L, G + H1 - 4, 2), 8, cPost, -1, 4);
        const s = L * (0.3 + r() * 0.4);
        const px = o[0] + a[0]*s - n[0]*T/2, pz = o[1] + a[1]*s - n[1]*T/2;
        if (isDoor(Math.floor(px / T), Math.floor(pz / T))) continue;
        const y0 = G + 80, y1 = y0 + 38;
        // one window per hut is always lit, so a hut never vanishes at night
        const litH = !hutLit || r() < 0.5; hutLit = true;
        if (litH) { const q = at(s, 0, 0); spill(q[0], q[2], n[0], n[1], 40, 80); }
        (litH ? A.glassLit : A.glass).quad(at(s - 16, y0, 0.6), at(s + 16, y0, 0.6), at(s + 16, y1, 0.6), at(s - 16, y1, 0.6), [n[0],0,n[1]], [1,1,1]);
        A.timber.beam(THREE, at(s, y0, 1.5), at(s, y1, 1.5), 3, cPost, -1, 3);
        for (const [a0, a1] of [[s - 18, s + 18]]) {
          A.timber.beam(THREE, at(a0, y0 - 2, 3), at(a1, y0 - 2, 3), 4, cPost, -1, 4);
          A.timber.beam(THREE, at(a0, y1 + 2, 3), at(a1, y1 + 2, 3), 4, cPost, -1, 4);
          A.timber.beam(THREE, at(a0, y0 - 2, 3), at(a0, y1 + 2, 3), 4, cPost, -1, 4);
          A.timber.beam(THREE, at(a1, y0 - 2, 3), at(a1, y1 + 2, 3), 4, cPost, -1, 4);
        }
        // shutters: weathered sea-blue, open flat
        for (const e of [-1, 1]) A.timber.beam(THREE, at(s + e*27, y0 - 1, 3), at(s + e*27, y1 + 1, 3), 16, cDoor, -1, 2);
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
    const sideOf = n => n[1] < 0 ? 'n' : n[1] > 0 ? 's' : n[0] < 0 ? 'w' : 'e';
    for (const F of facades) {
      const bb = F.upper ? upperBid : -1;
      const at = (s, y, out = P) => [F.o[0] + F.a[0]*s + F.n[0]*out, y, F.o[1] + F.a[1]*s + F.n[1]*out];
      // doorway spans along this facade (ground storey only), padded for the door posts
      const doors = F.upper ? [] : B.doors.filter(d => d.side === sideOf(F.n)).map(d => {
        const sA = (d.tx*T - F.o[0]) * F.a[0] + (d.ty*T - F.o[1]) * F.a[1];
        const sB = ((d.tx + 1)*T - F.o[0]) * F.a[0] + ((d.ty + 1)*T - F.o[1]) * F.a[1];
        return [Math.min(sA, sB) - 2, Math.max(sA, sB) + 2];
      }).sort((p, q) => p[0] - q[0]);
      const inDoor = (s0, s1) => doors.some(([d0, d1]) => s1 > d0 && s0 < d1);
      // a horizontal member, broken where a doorway passes through it
      const rail = (y, w, d) => {
        let s0 = 0;
        for (const [d0, d1] of doors) {
          if (d0 > s0) A.timber.beam(THREE, at(s0, y), at(d0, y), w, cTi, bb, d);
          s0 = Math.max(s0, d1);
        }
        if (s0 < F.L) A.timber.beam(THREE, at(s0, y), at(F.L, y), w, cTi, bb, d);
      };
      const n = Math.max(2, Math.round(F.L / 42)), step = F.L / n;
      const yMid = F.y0 + (F.y1 - F.y0) * 0.40;       // the rail is the window sill
      rail(F.y0 + 3, 7, 4);                                                      // sill plate
      A.timber.beam(THREE, at(0, F.y1 - 3), at(F.L, F.y1 - 3), 7, cTi, bb, 4);   // head plate (above any door)
      rail(yMid, 6, 4);                                                          // mid rail
      // posts: corners stop 6 short of the plate so they never poke through the eaves
      for (let k = 0; k <= n; k++) {
        const corner = k === 0 || k === n;
        if (!corner && inDoor(k*step - 4, k*step + 4)) continue;
        A.timber.beam(THREE, at(k*step, F.y0), at(k*step, F.y1 - (corner ? 6 : 0)), corner ? 12 : 7, cTi, bb, corner ? 12 : 4);
      }
      for (let k = 0; k < n; k++) {
        const s0 = k*step, s1 = (k+1)*step, mid = (s0 + s1)/2;
        if (inDoor(s0, s1)) continue;
        // braces: in the corner bays, and in a bay beside a doorway, rising toward it
        const doorL = inDoor(s0 - step, s0), doorR = inDoor(s1, s1 + step);
        const corner = k === 0 || k === n - 1;
        if (corner || doorL || doorR) {
          const towardLeft = corner ? k === 0 : doorL;
          const lo = F.y0 + 6, hi = yMid;
          if (towardLeft) A.timber.beam(THREE, at(s0 + 4, hi), at(s1 - 4, lo), 7, cTi, bb, 4);
          else            A.timber.beam(THREE, at(s1 - 4, hi), at(s0 + 4, lo), 7, cTi, bb, 4);
          // A corner bay is braced full height. A bay beside a door keeps only
          // the lower brace and takes a window above the rail — critic r5: the
          // healer's front had nothing but door-flanking bays, so no windows.
          if (corner && !(doorL || doorR)) {
            const lo2 = yMid + 4, hi2 = F.y1 - 6;
            if (towardLeft) A.timber.beam(THREE, at(s0 + 4, lo2), at(s1 - 4, hi2), 7, cTi, bb, 4);
            else            A.timber.beam(THREE, at(s1 - 4, lo2), at(s0 + 4, hi2), 7, cTi, bb, 4);
            continue;
          }
          if (step < 30) continue;
        }
        // windows: every other free bay, and every bay beside a door; heads aligned
        else if ((k % 2) !== 1 || step < 30) continue;
        const ww = Math.min(28, step - 12), wy0 = yMid + 5, wh = Math.min(46, F.y1 - 10 - wy0), wy1 = wy0 + wh;
        const lit = r() < 0.6;
        const gl = lit ? A.glassLit : A.glass;
        if (rp() < (F.upper ? 0.25 : 0.35)) flowerBox(THREE, A, at, F.n, mid, wy0 - 6, ww + 10, cTi, rp, bb);
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
        A.timber.beam(THREE, at(mid, wy0, 1), at(mid, wy1, 1), 3, cTi, bb, 2);
        A.timber.beam(THREE, at(mid - ww/2, wy0 + wh*0.62, 1), at(mid + ww/2, wy0 + wh*0.62, 1), 3, cTi, bb, 2);
        A.timber.beam(THREE, at(mid - 17, wy0 - 5, 5), at(mid + 17, wy0 - 5, 5), 3, mul(cTi, 1.2), bb, 5);
        // shutters, open flat against the wall, on some windows
        if (r() < 0.4) for (const sgn of [-1, 1]) {
          const sx = mid + sgn*(ww/2 + 3 + 7);
          A.timber.beam(THREE, at(sx, wy0 - 1, P + 1.5), at(sx, wy1 + 1, P + 1.5), 14, cDoor, bb, 2);
        }
      }
    }
    // ground-storey windows on stone walls (B/C): stone-dressed, on the long sides
    // A walk-in room has them on the door wall and toward the front of each side
    // wall too (none behind the shelves and beds along the back): from inside,
    // a room with two windows in one wall read as a cellar (interiors critic r1).
    const wins = [];                                  // openings the room's lining leaves: {side, c, y0, y1}
    const doorSide = (B.doors[0] || {}).side;
    const groundWins = F => {
      const front = F === facades[0] || F === facades[1];
      if (!room) return front ? [0.3, 0.7] : [];
      const sd = sideOf(F.n);
      if (sd === doorSide) return [0.3, 0.7];
      if (sd === { n: 's', s: 'n', e: 'w', w: 'e' }[doorSide]) return [];
      const dist = f => { const q = F.L * f, px = F.o[0] + F.a[0]*q, pz = F.o[1] + F.a[1]*q;
        return doorSide === 'n' ? pz - Z0 : doorSide === 's' ? Z1 - pz : doorSide === 'w' ? px - X0 : X1 - px; };
      return [dist(0.3) < dist(0.7) ? 0.3 : 0.7];
    };
    if (two) for (const F of facades.slice(0, 4)) {
      // F is the jettied upper facade; step back J to the stone wall face
      const at = (s, y, out) => [F.o[0] + F.a[0]*s + F.n[0]*(out - J), y, F.o[1] + F.a[1]*s + F.n[1]*(out - J)];
      for (const frac of groundWins(F)) {
        const s = J + (F.L - 2*J) * frac;
        const px = F.o[0] + F.a[0]*s - F.n[0]*(T/2 + J), pz = F.o[1] + F.a[1]*s - F.n[1]*(T/2 + J);
        if (isDoor(Math.floor(px / T), Math.floor(pz / T))) continue;
        const y0 = G + (room ? 84 : 72), wh = room ? 60 : 44, y1 = y0 + wh;
        const litS = r() < 0.6; if (litS) { const q = at(s, 0, 0); spill(q[0], q[2], F.n[0], F.n[1], 40, 80); }
        if (rp() < 0.35) flowerBox(THREE, A, (a, y, o) => at(a, y, o + 3), F.n, s, y0 - 6, 38, cTi, rp, -1);
        (litS ? A.glassLit : A.glass).quad(at(s - 14, y0, 0.6), at(s + 14, y0, 0.6), at(s + 14, y1, 0.6), at(s - 14, y1, 0.6), [F.n[0],0,F.n[1]], [1,1,1]);
        // dressings in pale freestone (critic r3: stone-on-stone vanished, leaving black holes)
        const cDr = hex(THREE, 0xb9ab8e);
        for (const e of [-1, 1]) A.plaster.beam(THREE, at(s + e*17, y0 - 1, 2), at(s + e*17, y1 + 1, 2), 6, cDr, -1, 4);   // jambs
        A.plaster.beam(THREE, at(s - 21, y1 + 5, 2), at(s + 21, y1 + 5, 2), 9, cDr, -1, 4);   // lintel, 1.5x the opening
        A.plaster.beam(THREE, at(s - 20, y0 - 3, 3), at(s + 20, y0 - 3, 3), 5, cDr, -1, 6);   // sill, 6 proud
        A.timber.beam(THREE, at(s, y0, 1), at(s, y1, 1), 3, cTi, -1, 2);                        // mullion
        A.timber.beam(THREE, at(s - 14, y0 + wh*0.62, 1), at(s + 14, y0 + wh*0.62, 1), 3, cTi, -1, 2);   // transom
        if (room) {
          // ...and from inside: the pane at the back of a reveal through the
          // lining, daylit, with its mullion, transom and a sill board
          const inn = (a, y, o) => at(a, y, -T - o), N = [-F.n[0], 0, -F.n[1]];
          A.pane.quad(inn(s - 16, y0, 0.6), inn(s + 16, y0, 0.6), inn(s + 16, y1, 0.6), inn(s - 16, y1, 0.6), N, [1, 1, 1]);
          A.timber.beam(THREE, inn(s, y0, 1.5), inn(s, y1, 1.5), 3, cTi, -1, 2);
          A.timber.beam(THREE, inn(s - 16, y0 + wh*0.62, 1.5), inn(s + 16, y0 + wh*0.62, 1.5), 3, cTi, -1, 2);
          A.timber.beam(THREE, inn(s - 22, y0 - 3, 7), inn(s + 22, y0 - 3, 7), 6, mul(cTi, 1.5), -1, 14);
          const c = F.n[1] !== 0 ? F.o[0] + F.a[0]*s : F.o[1] + F.a[1]*s;
          wins.push({ side: sideOf(F.n), c, y0: y0 - 2, y1: y1 + 2 });
        }
      }
    }

    // ── the room's lining (v0.24): the walls inside were the outside's stone
    // (interiors critic r1). Boarded to the dado, lime plaster above, a dado
    // rail and posts every two tiles; openings left for the doors and windows,
    // whose sides become the reveals. Cut to the waist with the rest of the
    // building in the third-person cutaway.
    if (room) {
      const LT = 8, F0 = G + 4, WS = F0 + 74, top = G + H1 - 8;
      const cIn = mix(cPl, [1, 0.97, 0.9], 0.35), cWain = mul(hex(THREE, 0x7a5a3c), 1.0), cRail = mul(cTi, 1.2);
      const walls = [
        { side: 'n', f: Z0 + T, dir: 1, ax: 'x', a0: X0 + T, a1: X1 - T },
        { side: 's', f: Z1 - T, dir: -1, ax: 'x', a0: X0 + T, a1: X1 - T },
        { side: 'w', f: X0 + T, dir: 1, ax: 'z', a0: Z0 + T, a1: Z1 - T },
        { side: 'e', f: X1 - T, dir: -1, ax: 'z', a0: Z0 + T, a1: Z1 - T },
      ];
      for (const Wl of walls) {
        const holes = [];                               // [s0, s1, y0, y1]
        for (const d of B.doors) if (d.side === Wl.side) { const q = Wl.ax === 'x' ? d.tx*T : d.ty*T; holes.push([q, q + T, F0 - 2, G + DOOR_H + 8]); }
        for (const q of wins) if (q.side === Wl.side) holes.push([q.c - 18, q.c + 18, q.y0, q.y1]);
        const piece = (s0, s1, y0, y1, acc, col, depth) => {
          if (s1 - s0 < 0.5 || y1 - y0 < 0.5) return;
          const f0 = Wl.f, f1 = Wl.f + Wl.dir * depth;
          if (Wl.ax === 'x') acc.box(s0, y0, Math.min(f0, f1), s1, y1, Math.max(f0, f1), col);
          else acc.box(Math.min(f0, f1), y0, s0, Math.max(f0, f1), y1, s1, col);
        };
        const cuts = [...new Set([Wl.a0, Wl.a1, ...holes.flatMap(hh => [hh[0], hh[1]])])]
          .filter(c => c >= Wl.a0 && c <= Wl.a1).sort((p, q) => p - q);
        for (let i = 0; i < cuts.length - 1; i++) {
          const s0 = cuts[i], s1 = cuts[i + 1], m = (s0 + s1) / 2;
          let spans = [[F0, top]];
          for (const hh of holes) if (m > hh[0] && m < hh[1])
            spans = spans.flatMap(([a, b]) => [...(hh[2] > a ? [[a, Math.min(b, hh[2])]] : []), ...(hh[3] < b ? [[Math.max(a, hh[3]), b]] : [])]);
          for (const [a, b] of spans) {
            if (a < WS) piece(s0, s1, a, Math.min(b, WS), A.boards, cWain, LT + 2);
            if (b > WS) piece(s0, s1, Math.max(a, WS), b, A.plaster, cIn, LT);
            if (a < WS - 2 && b > WS + 5) piece(s0, s1, WS - 2, WS + 5, A.timber, cRail, LT + 5);   // dado rail
          }
        }
        piece(Wl.a0, Wl.a1, top - 12, top, A.timber, cTi, LT + 5);                             // wall plate
        for (let q = Wl.a0 + 2*T; q < Wl.a1 - T/2; q += 2*T) {                                 // posts
          if (holes.some(hh => q + 6 > hh[0] && q - 6 < hh[1])) continue;
          piece(q - 5, q + 5, F0, top - 12, A.timber, cTi, LT + 4);
        }
      }
    }

    // ── doors: 48 x 150, head beam, leaf open against the inner reveal ──
    // Contiguous door tiles on one wall are ONE opening: the city's doors are
    // 3 and 5 wide, and per tile each got its own posts and leaf, the leaves
    // clipping each other and a barrel standing in the next tile (critic C5).
    const doorSpans = [];
    for (const d of [...B.doors].sort((p, q) => (p.tx - q.tx) || (p.ty - q.ty))) {
      const L = doorSpans[doorSpans.length - 1], e = L && L.tiles[L.tiles.length - 1];
      if (e && L.side === d.side && Math.abs(d.tx - e.tx) + Math.abs(d.ty - e.ty) === 1) L.tiles.push(d);
      else doorSpans.push({ side: d.side, tiles: [d], tx: d.tx, ty: d.ty });
    }
    for (const d of doorSpans) {
      const x = d.tx*T, z = d.ty*T, nT = d.tiles.length, WD = nT*T;
      const ax = d.side === 'n' || d.side === 's';
      const out = d.side === 'n' ? [0,-1] : d.side === 's' ? [0,1] : d.side === 'w' ? [-1,0] : [1,0];
      const fx = out[0] > 0 ? x + T : x, fz = out[1] > 0 ? z + T : z;          // outer face of the doorway
      spill(ax ? x + WD/2 : fx, ax ? fz : z + WD/2, out[0], out[1], 40 + (nT - 1)*36, 120);
      const pp = ax ? [[x + 2, fz + out[1]*2], [x + WD - 2, fz + out[1]*2]] : [[fx + out[0]*2, z + 2], [fx + out[0]*2, z + WD - 2]];
      for (const [px, pz] of pp) A.timber.beam(THREE, [px, G, pz], [px, G + DOOR_H, pz], 8, cTi, -1, 8);
      A.timber.beam(THREE, [pp[0][0], G + DOOR_H + 4, pp[0][1]], [pp[1][0], G + DOOR_H + 4, pp[1][1]], 8, cTi, -1, 9);
      // the leaf: 44 x 146 planks with two iron straps, swung out and left ajar,
      // 65 deg off the wall. (In the reveal it read as a dark slot; flat against
      // the wall it read as a second, closed door.)
      const al = ax ? [1, 0] : [0, 1], ca = Math.cos(65 * Math.PI / 180), sa = Math.sin(65 * Math.PI / 180);
      // a wide opening takes a PAIR of leaves, one hung from each post
      const LW = nT === 1 ? 44 : Math.min(66, WD / 2 - 6);
      for (const [pi, sg] of nT === 1 ? [[0, -1]] : [[0, -1], [1, 1]]) {
        const hx = pp[pi][0] + out[0]*3, hz = pp[pi][1] + out[1]*3;           // hinge, just outside the post
        const lf = (y, k) => [hx + (sg*al[0]*ca + out[0]*sa)*k, y, hz + (sg*al[1]*ca + out[1]*sa)*k];
        // (it lifts away with the roof when you are inside: cut to waist height it
        // read as a stray slab beside the wall)
        A.timber.beam(THREE, lf(G + 75, 1), lf(G + 75, LW), 3, cDoor, bid, 146);
        for (const sy of [32, 112]) A.timber.beam(THREE, lf(G + sy, 1), lf(G + sy, LW - 4), 3.8, [0.03, 0.03, 0.03], bid, 4);
      }
      // the room beyond glows through the open door at night (critic r5: a
      // lamplight pool on the step with no visible source). At the BACK of the
      // reveal, with its own dim warm material, so it reads as a lit room and
      // not a white-hot slit (critic r6). Hidden with the roof.
      // (not for a walk-in room: the card hid the room, a black slot at noon, critic r3)
      if (!room) { const ix = ax ? 0 : out[0], iz = ax ? out[1] : 0, dd = -(T - 4);
        const q0 = ax ? [x + 6, G + 4, fz + iz*dd] : [fx + ix*dd, G + 4, z + 6];
        const q1 = ax ? [x + WD - 6, G + 4, fz + iz*dd] : [fx + ix*dd, G + 4, z + WD - 6];
        A.doorGlow.quad(q0, q1, [q1[0], G + DOOR_H - 2, q1[2]], [q0[0], G + DOOR_H - 2, q0[2]], [out[0], 0, out[1]], [1,1,1], bid); }
      // shop sign on the far side from the leaf; a bench or barrels on some doors
      const al2 = ax ? [1, 0] : [0, 1];
      const wallAt = (k, y, o) => [pp[1][0] + al2[0]*k + out[0]*(o - 2), y, pp[1][1] + al2[1]*k + out[1]*(o - 2)];
      const sg = signs.find(q => d.tiles.some(t => q.tx === t.tx && q.ty === t.ty));
      if (sg) {
        // hung above head height: from the jettied upper storey on B/C (so the
        // bracket starts at ITS face), under the eaves on A
        const w0 = wallAt(16, 0, two ? J : 0);
        shopSign(THREE, A, w0[0], w0[2], out, two ? G + H1 + 34 : G + H1 - 4, sg.icon, bid);
        if (sg.icon === 0 || sg.icon === 1 || sg.icon === 3) {         // trades keep stock outside
          const bc = mul(hex(THREE, 0x7a5634), 0.9 + rp() * 0.2);
          { const q = wallAt(26, 0, 21); barrel(THREE, A, q[0], q[2], G, bc, -1); props.push({ x: q[0], z: q[2], r: 19 }); }
          const q = wallAt(66, 0, 20);
          A.timber.box(q[0] - 18, G, q[2] - 18, q[0] + 18, G + 36, q[2] + 18, mul(hex(THREE, 0x8a6a44), 0.9 + rp() * 0.2), -1);
          props.push({ x: q[0], z: q[2], r: 20 });
        }
      } else if (rp() < (hut ? 0.5 : 0.4)) {
        bench(THREE, A, wallAt, 12, 60, G, mul(cTi, 1.3), -1, !hut);
        for (const k of [24, 48]) { const q = wallAt(k, 0, 11); props.push({ x: q[0], z: q[2], r: 10 }); }
      } else if (hut && rp() < 0.6) {
        const q = wallAt(28, 0, 21); barrel(THREE, A, q[0], q[2], G, mul(hex(THREE, 0x6b5a48), 0.9 + rp() * 0.2), -1);
        props.push({ x: q[0], z: q[2], r: 19 });
      }
      // threshold stone
      const tx0 = ax ? x : (out[0] > 0 ? x + T : x - 14), tx1 = ax ? x + WD : (out[0] > 0 ? x + T + 14 : x);
      const tz0 = ax ? (out[1] > 0 ? z + T : z - 14) : z, tz1 = ax ? (out[1] > 0 ? z + T + 14 : z) : z + WD;
      A.stone.box(tx0, gLo - 8, tz0, tx1, G + 4, tz1, mul(cSt, 0.95), -1, {bottom:true});
    }

    // ── roof ──
    // Square huts pick their ridge axis at random, so Saltmere is not a row of clones.
    const alongX = (ox1 - ox0) === (oz1 - oz0) ? r() < 0.5 : (ox1 - ox0) > (oz1 - oz0);
    const verge = 20, eave = 30;
    const Lh = (alongX ? (ox1 - ox0) : (oz1 - oz0)) / 2 + verge;
    const Wh = (alongX ? (oz1 - oz0) : (ox1 - ox0)) / 2;
    // A: 42-48 deg; B/C: 50-55; huts 52-58 for thatch, but the rise capped so a
    // wide hut is not a barn (critic r3: 5-tile huts rose higher than their walls)
    let pitch = (hut ? 52 + r() * 6 : type === 'A' ? 42 + r() * 6 : 50 + r() * 5) * Math.PI / 180;
    if (hut) pitch = Math.atan(Math.min(Math.tan(pitch), 120 / Wh));
    const th = hut ? 22 : 12, tp = Math.tan(pitch);
    const rise = Wh * tp;
    // Half-hips (jerkinhead) on about a third of the town roofs: the gable stops
    // at 0.7 of the rise and a small hip runs up to a shortened ridge. Breaks
    // the chess-piece skyline from the aerial camera (critic r5).
    const hh = !hut && Wh > 90 && r() < 0.35;
    const yc = rise * 0.7, vc = Wh * 0.3, Lr = hh ? Lh - vc : Lh;        // cut height, its half-width, ridge half-length
    const W = (u, v, y) => alongX ? [cx + u, EAVE + y, cz + v] : [cx + v, EAVE + y, cz + u];
    const Wn = (nu, ny, nv) => alongX ? [nu, ny, nv] : [nv, ny, nu];
    const RA = hut ? A.thatch : slate ? A.slate : A.roof;
    const soffit = hex(THREE, 0x3a2c22);
    for (const side of [-1, 1]) {
      const vE = side * (Wh + eave), yE = -eave * tp;
      const N = Wn(0, Math.cos(pitch), side * Math.sin(pitch)), Nd = [-N[0], -N[1], -N[2]];
      const jz = () => (r() - 0.5) * 3;                           // not ruler-straight
      const moss = mix(cRf, hex(THREE, 0x55603a), hut ? 0.15 : 0.18);
      if (hh) {
        // lower band to the cut line (moss), then a trapezoid up to the short ridge
        const e1 = W(-Lh, vE, yE + th + jz()), e2 = W(Lh, vE, yE + th + jz());
        const k1 = W(-Lh, side*vc, yc + th), k2 = W(Lh, side*vc, yc + th), r1 = W(-Lr, 0, rise + th), r2 = W(Lr, 0, rise + th);
        RA.quad(e1, e2, k2, k1, N, moss, bid); RA.quad(k1, k2, r2, r1, N, cRf, bid);
        A.timber.quad(W(-Lh, vE, yE), W(Lh, vE, yE), W(Lh, side*vc, yc), W(-Lh, side*vc, yc), Nd, soffit, bid);
        A.timber.quad(W(-Lh, side*vc, yc), W(Lh, side*vc, yc), W(Lr, 0, rise), W(-Lr, 0, rise), Nd, soffit, bid);
      } else {
        const a = W(-Lh, vE, yE + th + jz()), b = W(Lh, vE, yE + th + jz()), c = W(Lh, 0, rise + th), d = W(-Lh, 0, rise + th);
        // top face, with moss toward the eaves: two quads so the eave edge can be tinted
        const m1 = W(-Lh, vE*0.55, (yE + th)*0.55 + (rise + th)*0.45), m2 = W(Lh, vE*0.55, (yE + th)*0.55 + (rise + th)*0.45);
        RA.quad(a, b, m2, m1, N, moss, bid); RA.quad(m1, m2, c, d, N, cRf, bid);
        A.timber.quad(W(-Lh, vE, yE), W(Lh, vE, yE), W(Lh, 0, rise), W(-Lh, 0, rise), Nd, soffit, bid);
      }
      // the eave fascia face
      A.timber.quad(W(-Lh, vE, yE), W(Lh, vE, yE), W(Lh, vE, yE + th), W(-Lh, vE, yE + th), Wn(0, 0, side), mul(cTi, 0.9), bid);
      // verge ends of the slab: to the ridge, or to the cut line under a half-hip
      for (const u of [-1, 1]) {
        const topV = hh ? side*vc : 0, topY = hh ? yc : rise;
        const e0 = W(u*Lh, vE, yE), e1 = W(u*Lh, topV, topY), e2 = W(u*Lh, topV, topY + th), e3 = W(u*Lh, vE, yE + th);
        RA.quad(e0, e1, e2, e3, Wn(u, 0, 0), mul(cRf, 0.8), bid);
        if (!hut) A.timber.beam(THREE, W(u*(Lh + 1.5), vE, yE + th/2), W(u*(Lh + 1.5), topV, topY + th/2), 3, cTi, bid, 12);  // barge board
        // thatch: a soft roll along the verge, like the ridge and the eave (critic r5)
        else RA.beam(THREE, W(u*Lh, vE, yE + th/2), W(u*Lh, 0, rise + th/2), 14, mul(cRf, 0.9), bid, 14);
      }
      if (!hut) A.timber.beam(THREE, W(-Lh, vE - side*1.5, yE + th/2 - 2), W(Lh, vE - side*1.5, yE + th/2 - 2), 3, cTi, bid, 10);   // fascia board
      else RA.beam(THREE, W(-Lh, vE, yE + th/2), W(Lh, vE, yE + th/2), 16, mul(cRf, 0.9), bid, 16);                     // thatch eave roll
    }
    // the half-hips themselves: a triangle at each end, its slab edge, hip caps
    if (hh) for (const u of [-1, 1]) {
      const Nh = Wn(u * Math.sin(pitch), Math.cos(pitch), 0);
      RA.quad(W(u*Lh, -vc, yc + th), W(u*Lh, vc, yc + th), W(u*Lr, 0, rise + th), W(u*Lr, 0, rise + th), Nh, cRf, bid);
      A.timber.quad(W(u*Lh, -vc, yc), W(u*Lh, vc, yc), W(u*Lr, 0, rise), W(u*Lr, 0, rise), [-Nh[0], -Nh[1], -Nh[2]], soffit, bid);
      RA.quad(W(u*Lh, -vc, yc), W(u*Lh, vc, yc), W(u*Lh, vc, yc + th), W(u*Lh, -vc, yc + th), Wn(u, 0, 0), mul(cRf, 0.8), bid);
      A.timber.beam(THREE, W(u*(Lh + 1.5), -vc, yc + th/2), W(u*(Lh + 1.5), vc, yc + th/2), 3, cTi, bid, 12);
      for (const sv of [-1, 1]) RA.beam(THREE, W(u*Lh, sv*vc, yc + th + 2), W(u*Lr, 0, rise + th + 2), 8, mul(cRf, 0.8), bid, 5);
    }
    // ridge: a tile cap, or a thatch roll
    if (hut) RA.beam(THREE, W(-Lh, 0, rise + th + 3), W(Lh, 0, rise + th + 3), 14, mul(cRf, 0.85), bid, 10);
    else     RA.beam(THREE, W(-Lr - 2, 0, rise + th + 2), W(Lr + 2, 0, rise + th + 2), 10, mul(cRf, 0.8), bid, 6);
    // gable ends: closed right up to the roof underside, framed. Under a
    // half-hip the gable is a trapezoid: it meets the hip's underside, which at
    // the wall plane (verge in from the hip's edge) stands verge*tan above the cut.
    for (const s of [-1, 1]) {
      const u = s * (Lh - verge);
      const N = Wn(s, 0, 0), Nb = Wn(-s, 0, 0);
      const gAcc = hut ? A.boards : A.plaster, gCol = hut ? cBoard : mul(cPl, 0.97);
      const gTop = hh ? yc + verge * tp : rise, gV = hh ? Math.max(0, vc - verge) : 0;
      const gA = W(u, -Wh, 0), gB = W(u, Wh, 0), gC = W(u, gV, gTop), gD = W(u, -gV, gTop);
      gAcc.quad(gA, gB, gC, gD, N, gCol, bid); gAcc.quad(gA, gB, gC, gD, Nb, gCol, bid);
      if (hut) continue;
      const o = (p) => alongX ? [p[0] + s*P, p[1], p[2]] : [p[0], p[1], p[2] + s*P];
      A.timber.beam(THREE, o(W(u, -Wh, 3)), o(W(u, Wh, 3)), 8, cTi, bid, 4);                   // tie beam
      A.timber.beam(THREE, o(W(u, 0, 3)), o(W(u, 0, gTop - 4)), 8, cTi, bid, 4);               // king post
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
      const u = (r() < 0.5 ? -1 : 1) * Math.min((Lh - verge) * 0.4, Lr - 30);
      const base = W(u, 0, 0), sz = hut ? 18 : 30;
      const x0 = base[0] - sz/2, z0 = base[2] - sz/2, y1 = EAVE + rise + th + 50;
      A.stone.box(x0, EAVE - 20, z0, x0 + sz, y1, z0 + sz, mul(cSt, 0.78), bid, {bottom:true});
      A.stone.box(x0 - 2, y1, z0 - 2, x0 + sz + 2, y1 + 4, z0 + sz + 2, mul(cSt, 0.6), bid);
    }
  });
  const flames = [];
  dress(THREE, A, extras, { T, groundAt, props, flames });
  const out = {};
  for (const k in A) out[k] = A[k].p.length ? A[k].geometry(THREE) : null;
  out.props = props;
  out.lights = lights;
  out.flames = flames;
  out.fires = fires;
  return out;
}
