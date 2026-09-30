// gatehouse.js — the city's gateways, built as gatehouses (v0.24).
//
// The ×2.5 city's gates were square holes in the wall with a thin lintel
// across (city critic r2: "gates are square holes"). Each gateway now gets:
//
//   ARCH       — masonry filling the opening above a basket arch that springs
//                at ~170 and crowns at ~270, with a proud voussoir ring on
//                both faces and merlons along the outer edge of its top.
//                Drawn with the fort's own material (world-space courses).
//   PORTCULLIS — an iron grille just inside the outer face, raised: its
//                bottom edge hangs ~60 below the crown.
//   DOORS      — two plank leaves, folded back against the passage walls
//                near the inner face, iron-strapped.
//
// A gate is { u0, u1, w0, w1, axis, out, top }: the opening across (u, world
// units) and the passage through the wall (w), `axis` 'x' when u runs along
// world x, `out` +1/-1 the direction of the outer face along w, `top` the
// wall's height above the ground. Pure geometry: no scene, no game state.

import { Acc } from './bridges.js';

export function buildGatehouses(THREE, gates, { groundAt, colors = {} }) {
  const stone = new Acc(96, -1e9), metal = new Acc(24, -1e9), wood = new Acc(48, -1e9);
  const cIron = colors.iron || [0.05, 0.05, 0.05], cWood = colors.wood || [0.3, 0.2, 0.12], cStrap = [0.04, 0.04, 0.04];
  for (const G of gates) {
    const X = G.axis === 'x';
    const um = (G.u0 + G.u1) / 2, R = (G.u1 - G.u0) / 2;
    // world point from (u across, w through, y)
    const P = (u, w, y) => X ? [um + u, y, w] : [w, y, um + u];
    const gy = X ? groundAt(um, (G.w0 + G.w1) / 2) : groundAt((G.w0 + G.w1) / 2, um);
    const top = gy + G.top, spring = gy + 170, rise = 100;
    const arch = u => spring + rise * Math.sqrt(Math.max(0, 1 - (u / R) * (u / R)));
    const wo = G.out > 0 ? G.w1 : G.w0, wi = G.out > 0 ? G.w0 : G.w1;   // outer and inner faces
    const N = 24;
    // ARCH: one hexahedron per slice, soffit to the wall top
    for (let i = 0; i < N; i++) {
      const a = -R + 2 * R * i / N, b = -R + 2 * R * (i + 1) / N, ya = arch(a), yb = arch(b);
      stone.hex([P(a, G.w0, ya), P(b, G.w0, yb), P(b, G.w1, yb), P(a, G.w1, ya),
                 P(a, G.w0, top), P(b, G.w0, top), P(b, G.w1, top), P(a, G.w1, top)], [1, 1, 1]);
      // the voussoir ring, proud of both faces
      for (const [f, d] of [[G.w0, -1], [G.w1, 1]]) {
        const e = f + d * 6;
        stone.hex([P(a, f, ya - 2), P(b, f, yb - 2), P(b, e, yb - 2), P(a, e, ya - 2),
                   P(a, f, ya + 30), P(b, f, yb + 30), P(b, e, yb + 30), P(a, e, ya + 30)], [1, 1, 1]);
      }
    }
    // the passage's jambs: an impost block where the arch springs, each side
    for (const s of [-1, 1]) for (const [f, d] of [[G.w0, -1], [G.w1, 1]]) {
      const u = s * R, e = f + d * 8;
      stone.hex([P(u - 10, f, spring - 16), P(u + 10, f, spring - 16), P(u + 10, e, spring - 16), P(u - 10, e, spring - 16),
                 P(u - 10, f, spring), P(u + 10, f, spring), P(u + 10, e, spring), P(u - 10, e, spring)], [1, 1, 1]);
    }
    // merlons along the outer edge of the top, one every other tile
    const T = 48;
    for (let u = -R; u + T * 0.72 <= R + 1; u += T * 2) {
      const e = wo - G.out * 18;
      stone.hex([P(u, wo, top), P(u + T * 0.72, wo, top), P(u + T * 0.72, e, top), P(u, e, top),
                 P(u, wo, top + 60), P(u + T * 0.72, wo, top + 60), P(u + T * 0.72, e, top + 60), P(u, e, top + 60)], [1, 1, 1]);
    }

    // PORTCULLIS: raised, its teeth ~60 below the crown, just inside the outer face
    const wp = wo - G.out * 22, bottom = spring + rise - 60;
    const Ax = X ? [1, 0, 0] : [0, 0, 1], Aw = X ? [0, 0, 1] : [1, 0, 0];
    for (let u = -R + 14; u <= R - 14; u += 26) {
      const ya = arch(u); if (ya < bottom + 6) continue;
      metal.box(P(u, wp, (bottom + ya + 20) / 2), Ax, [0, 1, 0], Aw, 3, (ya + 20 - bottom) / 2, 3, cIron);
      metal.box(P(u, wp, bottom - 5), Ax, [0, 1, 0], Aw, 2, 5, 2, cIron);                            // a tooth
    }
    for (const y of [bottom + 10, bottom + 36]) {
      const k = (y - spring) / rise; if (k >= 1) continue;
      const hu = R * Math.sqrt(1 - k * k) + 10;
      metal.box(P(0, wp, y), Ax, [0, 1, 0], Aw, hu, 3, 3.5, cIron);
    }
    // DOORS: two leaves folded back against the passage walls, by the inner face
    const L = Math.min(R - 20, Math.abs(G.w1 - G.w0) - 50), H = spring - gy - 6;
    for (const s of [-1, 1]) {
      const u = s * (R - 6), wa = wi + G.out * 12, wb = wa + G.out * L, wm = (wa + wb) / 2;
      wood.box(P(u, wm, gy + H / 2), Aw, [0, 1, 0], Ax, L / 2, H / 2, 3, cWood);
      for (const y of [gy + 30, gy + H - 30]) wood.box(P(u - s * 3.5, wm, y), Aw, [0, 1, 0], Ax, L / 2 - 4, 3, 1, cStrap);
    }
  }
  return { stone: stone.geometry(THREE), metal: metal.geometry(THREE), wood: wood.geometry(THREE) };
}
