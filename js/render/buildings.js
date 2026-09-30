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
  const X0 = (B.x0 + 1) * T, X1 = B.x1 * T, Z0 = (B.y0 + 1) * T, Z1 = B.y1 * T;   // inner faces
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
  const wood = mul(cTi, 1.25), dark = mul(cTi, 0.8), plank = [0.42, 0.30, 0.20], ironC = [0.06, 0.06, 0.06];
  const cloth = [[0.45, 0.12, 0.10], [0.16, 0.24, 0.40], [0.22, 0.34, 0.18], [0.46, 0.36, 0.16]][Math.floor(rp() * 4)];

  const counter = (uc, vc, len, deep = 28) => {
    box(A.timber, uc - len / 2, vc - deep / 2, uc + len / 2, vc + deep / 2, 0, 66, dark);
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
    const vc = Dv * 0.62, u0 = onRight ? Wu - 34 : 0, u1 = onRight ? Wu : 34;
    box(A.stone, u0, vc - 44, u1, vc + 44, 0, 150, [0.55, 0.52, 0.48]);
    box(A.stone, onRight ? u0 - 8 : u1, vc - 50, onRight ? u0 : u1 + 8, vc + 50, 0, 10, [0.45, 0.43, 0.4]);   // hearthstone
    box(A.glassLit, onRight ? u0 - 1 : u1, vc - 24, onRight ? u0 : u1 + 1, vc + 24, 12, 50, [1, 0.6, 0.3]);   // the fire's glow
    box(A.stone, onRight ? u0 - 6 : u1, vc - 52, onRight ? u0 : u1 + 6, vc + 52, 96, 106, [0.6, 0.57, 0.52]); // mantel
    block(onRight ? u0 : u1, vc - 40, onRight ? u0 : u1, vc + 40, 20);
    const q = P(onRight ? u0 - 20 : u1 + 20, vc); o.lights.push({ x: q[0], y: F + 60, z: q[1], bid: o.lightBid, warm: true });
  };
  const barrelAt = (u, v) => { const q = P(u, v); barrel(THREE, A, q[0], q[1], F - 4, mul(cTi, 1.1), -1); props.push({ x: q[0], z: q[1], r: 19 }); };
  const crate = (u, v, sz = 34) => { box(A.timber, u - sz / 2, v - sz / 2, u + sz / 2, v + sz / 2, 0, sz, [0.5, 0.38, 0.24]); block(u, v, u, v, sz / 2 + 3); };
  const rug = (uc, vc, lu, lv) => box(A.plaster, uc - lu / 2, vc - lv / 2, uc + lu / 2, vc + lv / 2, 0.4, 1.2, mul(cloth, 1.2));
  const anvil = (u, v) => { box(A.stone, u - 16, v - 12, u + 16, v + 12, 0, 34, [0.35, 0.33, 0.3]); box(A.timber, u - 26, v - 9, u + 22, v + 9, 34, 46, ironC); block(u, v, u, v, 22); };
  const forge = (u0, u1, vBack) => {
    box(A.stone, u0, vBack - 60, u1, vBack, 0, 56, [0.4, 0.37, 0.34]);
    box(A.glassLit, u0 + 10, vBack - 50, u1 - 10, vBack - 10, 56, 58, [1, 0.45, 0.15]);   // coals
    box(A.stone, u0 + 12, vBack - 40, u1 - 12, vBack, 56, 170, [0.45, 0.42, 0.38]);       // hood
    block(u0, vBack - 30, u1, vBack - 30, 30);
    const q = P((u0 + u1) / 2, vBack - 30); o.lights.push({ x: q[0], y: F + 80, z: q[1], bid: o.lightBid, warm: true });
  };
  const hay = (u, v) => { box(A.thatch, u - 30, v - 20, u + 30, v + 20, 0, 36, [0.8, 0.72, 0.45]); block(u, v, u, v, 32); };
  const bookcase = (u0, u1, vBack) => shelves(u0, u1, vBack, 180);

  const mid = Wu / 2, back = Dv;
  // the shopkeeper stands 4 tiles in (city.js); the counter is between them and
  // the door, 3 tiles in, leaving a passage round each end
  const vC = 3 * T - T / 2 + 6;
  switch (role) {
    case 'merchant':
      counter(mid, vC, 160); shelves(mid - 150, mid + 150, back); crate(40, back - 60); crate(78, back - 50, 28); barrelAt(Wu - 40, 40); barrelAt(Wu - 40, 84);
      rug(mid, vC - 60, 120, 60); break;
    case 'blacksmith':
      forge(mid - 80, mid + 80, back); anvil(mid, vC + 60); barrelAt(40, back - 40); crate(Wu - 44, back - 44);
      for (let u = 30; u <= 120; u += 30) box(A.timber, u - 2, back - 8, u + 2, back, 0, 110, ironC);   // a rack of blades
      counter(mid, vC, 120); break;
    case 'mage':
      counter(mid, vC, 140); bookcase(20, Wu - 20, back);
      { const q = P(mid, vC + 80); box(A.timber, mid - 20, vC + 60, mid + 20, vC + 100, 0, 34, ironC); box(A.glassLit, mid - 14, vC + 66, mid + 14, vC + 94, 34, 36, [0.5, 0.9, 0.6]); block(mid, vC + 80, mid, vC + 80, 24);
        o.lights.push({ x: q[0], y: F + 70, z: q[1], bid: o.lightBid, warm: false }); }
      rug(mid, vC - 60, 140, 70); break;
    case 'farrier':
      counter(mid, vC, 120); hay(50, back - 40); hay(50, back - 90); hay(Wu - 50, back - 40); barrelAt(Wu - 40, 60);
      box(A.timber, mid - 40, back - 12, mid + 40, back, 60, 66, dark);   // a saddle bar on the far wall
      break;
    case 'bank':
      counter(mid, vC, Wu - 200, 34); crate(50, back - 50, 40); crate(95, back - 50, 40); crate(Wu - 50, back - 50, 40); crate(Wu - 95, back - 50, 40);
      shelves(mid - 120, mid + 120, back); rug(mid, vC - 70, 200, 70); break;
    case 'healer':
      counter(mid, vC, 120); bed(20, back - 130); bed(Wu - 80, back - 130); shelves(mid - 90, mid + 90, back);
      hearth(mid, false); break;
    case 'antiquarian': case 'curator': case 'cryptologist': case 'grave_robber': case 'fletcher':
      counter(mid, vC, 140); shelves(mid - 150, mid + 150, back); crate(Wu - 44, 44); table(70, back - 110, 90, 50); stool(70, back - 150);
      if (role === 'fletcher') for (let u = Wu - 140; u <= Wu - 40; u += 20) box(A.timber, u - 1.5, back - 6, u + 1.5, back, 20, 130, wood);   // bows on the wall
      break;
    default: {                                                // a home
      bed(20, back - 130);
      table(mid + 40, Dv * 0.45); stool(mid + 40 - 45, Dv * 0.45); stool(mid + 40 + 45, Dv * 0.45);
      hearth(mid, true); crate(40, 40); barrelAt(Wu - 40, 40); rug(mid, Dv * 0.45, 170, 110);
    }
  }
  // a lantern hung from the ceiling's middle, in every room: shops without a
  // hearth were lit only through their windows, and read as cellars at noon
  { const u = mid, v = Dv * 0.5, q = P(u, v);
    // (hung just under the joists: lower, it hung at eye level in the doorway)
    A.timber.beam(THREE, [q[0], F + H1 - 20, q[1]], [q[0], F + H1 - 26, q[1]], 2, ironC, ceilBid, 2);
    box(A.timber, u - 9, v - 9, u + 9, v + 9, H1 - 30, H1 - 26, ironC, ceilBid);
    box(A.glassLit, u - 7, v - 7, u + 7, v + 7, H1 - 48, H1 - 30, [1, 0.8, 0.5], ceilBid);
    box(A.timber, u - 9, v - 9, u + 9, v + 9, H1 - 52, H1 - 48, ironC, ceilBid);
    // the light itself sits lower, mid-room: at the lantern it blew the ceiling out
    o.lights.push({ x: q[0], y: F + H1 * 0.6, z: q[1], bid: o.lightBid, warm: true }); }
  // the ceiling: planks at the storey line, joists under them
  // (on the timber material: the floor's is never cut away, and a plank lid
  //  sat over the room in the third-person view)
  box(A.timber, 0, 0, Wu, Dv, H1 - 8, H1 - 2, mul(plank, 1.5), ceilBid);
  for (let u = 36; u < Wu; u += 48) box(A.timber, u - 5, 0, u + 5, Dv, H1 - 20, H1 - 8, dark, ceilBid);
}

export function buildTown(THREE, { buildings, TILE, groundAt, coastY0 = Infinity, signs = [] }) {
  const A = {
    stone: new Acc(96), plaster: new Acc(64), timber: new Acc(48), boards: new Acc(64),
    glass: new Acc(24), glassLit: new Acc(24), roof: new Acc(96), slate: new Acc(96), thatch: new Acc(64),
    floor: new Acc(64), shadow: new Acc(1), spill: new Acc(1), doorGlow: new Acc(48),
    sign: new Acc(1), flowers: new Acc(16),
  };
  const T = TILE;
  const props = [];           // {x, z, r}: circle colliders for the street furniture (and furniture)
  const lights = [];          // {x, y, z, bid}: a hearth / forge / lamp to light a room you are in
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
    const H1 = two ? 164 : hut ? 160 : 184;         // ground storey top (A/HUT: the eaves) — a 150 door + head beam fits
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
    if (!hut && w >= 7 && h >= 7) {
      furnish(THREE, A, B, { T, G, bid, ceilBid: two ? bid : bid, H1, cTi, rp, props, lights, lightBid: bid, role: B.role || 'home' });
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
    if (two) for (const F of [facades[0], facades[1]]) {
      // F is the jettied upper facade; step back J to the stone wall face
      const at = (s, y, out) => [F.o[0] + F.a[0]*s + F.n[0]*(out - J), y, F.o[1] + F.a[1]*s + F.n[1]*(out - J)];
      for (const frac of [0.3, 0.7]) {
        const s = J + (F.L - 2*J) * frac;
        const px = F.o[0] + F.a[0]*s - F.n[0]*(T/2 + J), pz = F.o[1] + F.a[1]*s - F.n[1]*(T/2 + J);
        if (isDoor(Math.floor(px / T), Math.floor(pz / T))) continue;
        const y0 = G + 72, y1 = y0 + 44;
        const litS = r() < 0.6; if (litS) { const q = at(s, 0, 0); spill(q[0], q[2], F.n[0], F.n[1], 40, 80); }
        if (rp() < 0.35) flowerBox(THREE, A, (a, y, o) => at(a, y, o + 3), F.n, s, y0 - 6, 38, cTi, rp, -1);
        (litS ? A.glassLit : A.glass).quad(at(s - 14, y0, 0.6), at(s + 14, y0, 0.6), at(s + 14, y1, 0.6), at(s - 14, y1, 0.6), [F.n[0],0,F.n[1]], [1,1,1]);
        // dressings in pale freestone (critic r3: stone-on-stone vanished, leaving black holes)
        const cDr = hex(THREE, 0xb9ab8e);
        for (const e of [-1, 1]) A.plaster.beam(THREE, at(s + e*17, y0 - 1, 2), at(s + e*17, y1 + 1, 2), 6, cDr, -1, 4);   // jambs
        A.plaster.beam(THREE, at(s - 21, y1 + 5, 2), at(s + 21, y1 + 5, 2), 9, cDr, -1, 4);   // lintel, 1.5x the opening
        A.plaster.beam(THREE, at(s - 20, y0 - 3, 3), at(s + 20, y0 - 3, 3), 5, cDr, -1, 6);   // sill, 6 proud
        A.timber.beam(THREE, at(s, y0, 1), at(s, y1, 1), 3, cTi, -1, 2);                        // mullion
        A.timber.beam(THREE, at(s - 14, y0 + 44*0.62, 1), at(s + 14, y0 + 44*0.62, 1), 3, cTi, -1, 2);   // transom
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
      // the leaf: 44 x 146 planks with two iron straps, swung out and left ajar,
      // 65 deg off the wall. (In the reveal it read as a dark slot; flat against
      // the wall it read as a second, closed door.)
      const al = ax ? [1, 0] : [0, 1], ca = Math.cos(65 * Math.PI / 180), sa = Math.sin(65 * Math.PI / 180);
      const hx = pp[0][0] + out[0]*3, hz = pp[0][1] + out[1]*3;               // hinge, just outside the first post
      const tip = (y, k = 44) => [hx + (-al[0]*ca + out[0]*sa)*k, y, hz + (-al[1]*ca + out[1]*sa)*k];
      const lf = (y, k) => [hx + (-al[0]*ca + out[0]*sa)*k, y, hz + (-al[1]*ca + out[1]*sa)*k];
      // (it lifts away with the roof when you are inside: cut to waist height it
      // read as a stray slab beside the wall)
      A.timber.beam(THREE, lf(G + 75, 1), tip(G + 75), 3, cDoor, bid, 146);
      for (const sy of [32, 112]) A.timber.beam(THREE, lf(G + sy, 1), tip(G + sy, 40), 3.8, [0.03, 0.03, 0.03], bid, 4);
      // the room beyond glows through the open door at night (critic r5: a
      // lamplight pool on the step with no visible source). At the BACK of the
      // reveal, with its own dim warm material, so it reads as a lit room and
      // not a white-hot slit (critic r6). Hidden with the roof.
      { const ix = ax ? 0 : out[0], iz = ax ? out[1] : 0, dd = -(T - 4);
        const q0 = ax ? [x + 6, G + 4, fz + iz*dd] : [fx + ix*dd, G + 4, z + 6];
        const q1 = ax ? [x + T - 6, G + 4, fz + iz*dd] : [fx + ix*dd, G + 4, z + T - 6];
        A.doorGlow.quad(q0, q1, [q1[0], G + DOOR_H - 2, q1[2]], [q0[0], G + DOOR_H - 2, q0[2]], [out[0], 0, out[1]], [1,1,1], bid); }
      // shop sign on the far side from the leaf; a bench or barrels on some doors
      const al2 = ax ? [1, 0] : [0, 1];
      const wallAt = (k, y, o) => [pp[1][0] + al2[0]*k + out[0]*(o - 2), y, pp[1][1] + al2[1]*k + out[1]*(o - 2)];
      const sg = signs.find(q => q.tx === d.tx && q.ty === d.ty);
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
      const tx0 = ax ? x : (out[0] > 0 ? x + T : x - 14), tx1 = ax ? x + T : (out[0] > 0 ? x + T + 14 : x);
      const tz0 = ax ? (out[1] > 0 ? z + T : z - 14) : z, tz1 = ax ? (out[1] > 0 ? z + T + 14 : z) : z + T;
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
  const out = {};
  for (const k in A) out[k] = A[k].p.length ? A[k].geometry(THREE) : null;
  out.props = props;
  out.lights = lights;
  return out;
}
