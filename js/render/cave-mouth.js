// cave-mouth.js — the entrances to the surface caves.
//
// A cave mouth used to be a CAVE_ENTRANCE tile with a stone "arch" over it:
// two 56-tall posts and a lintel at 58, half the height of the 126-tall
// character, spanning one tile of a three-tile gap in the cliff, lit by two
// additive orange balls. You looked straight over it in first person, and
// from outside the mouth read as a notch in the rock (owner, 2026-09-28:
// "cave entrances" on the short list).
//
// Now each mouth is a portal cut in the cliff:
//
//   ROCK    — an overhang of the same rock as the cliffs (it is drawn with
//             their material), spanning the whole gap and running down into
//             jambs at either side. The soffit arches from ~180 at the jambs
//             to ~214 at the crown, well over head height; the outer face
//             leans out over the entrance, the crest rides up to the cliff
//             tops, and every face is broken up by noise that tapers to zero
//             on shared edges, so the faces meet without cracks.
//   TIMBER  — mine props under the overhang: two frames of posts against the
//             jambs, caps just under the soffit, knee braces, lagging planks
//             and stringers, so the mouth reads as a way in someone has used.
//   TORCHES — a sconce on each jamb, outside, flanking the way in. Returned
//             as flame points for game3d's flame cards and light pool (the
//             same fire as a placed torch).
//
// Pure geometry: no scene, no game state.

import { Acc } from './bridges.js';

/**
 * @param mouths  [{ mx, mz, dx, dz, halfW, gy }] — centre of the gap on the
 *                wall line, the unit direction INTO the cave (axis-aligned),
 *                half the gap's width, and the ground height there
 * @param opts.height   the cliff's nominal height (CAVEH)
 * @param opts.noise    (x, y) => 0..1 smooth noise
 * @param opts.colors   { post, beam, iron, lag, board } linear RGB
 * @returns {{ rock: BufferGeometry, wood: BufferGeometry, flames: [{x,y,z}] }}
 */
export function buildCaveMouths(THREE, mouths, { TILE, height, noise, colors }) {
  const pos = [], idx = [];
  const wood = new Acc(48, -1e9), flames = [];
  const C = colors;

  for (const m of mouths) {
    const U = [-m.dz, 0, m.dx], D = [m.dx, 0, m.dz];
    const P = (u, v, y) => [m.mx + U[0] * u + D[0] * v, y, m.mz + U[2] * u + D[2] * v];
    const hw = m.halfW, E = hw + TILE * 0.85;
    // outer and inner faces: 1.8 tiles deep. At 1.35, looking up from the
    // mouth you saw past the lagging into the open canyon — sky through the
    // roof (critic r2).
    const v0 = -TILE * 0.55, v1 = TILE * 1.25;
    const n = (a, b) => noise((m.mx + a) / 37 + 11.3, (m.mz + b) / 37 + 4.1);

    // Soffit: an arch over the gap, then falling steeply into a jamb either side.
    const crown = m.gy + 214, spring = m.gy + 180;   // (×1.25 with the ×1.5 cliffs, v0.24)
    const soffit = (u) => {
      const a = Math.abs(u);
      if (a <= hw) return spring + (crown - spring) * Math.cos((a / hw) * Math.PI / 2);
      const t = Math.min(1, (a - hw) / (E - hw));
      return spring + (m.gy - 14 - spring) * Math.pow(t, 0.55);
    };
    // The crest rides up to the cliff tops and is as jagged as they are: lower
    // and smooth, it read as a hobbit door stuck on the cliff (critic r1).
    const top = (u) => Math.max(soffit(u) + 24, m.gy + height + 30 + (n(u, 0) - 0.5) * 60 - Math.pow(Math.abs(u) / E, 3) * 40);

    const NU = 22, NK = 7, NJ = 4;
    // A quad grid of vertices, wound so its faces point along `want` (the
    // material is single-sided: a soffit wound upward was culled from below,
    // and the portal showed sky between its two faces).
    const grid = (nu, nk, at, want) => {
      const base = pos.length / 3;
      for (let i = 0; i <= nu; i++) for (let k = 0; k <= nk; k++) pos.push(...at(i / nu, k / nk));
      const V = (j) => [pos[j * 3], pos[j * 3 + 1], pos[j * 3 + 2]];
      const m0 = base + (nu >> 1) * (nk + 1) + (nk >> 1), p0 = V(m0), p1 = V(m0 + nk + 1), p2 = V(m0 + 1);
      const e1 = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]], e2 = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
      const nx = e1[1] * e2[2] - e1[2] * e2[1], ny = e1[2] * e2[0] - e1[0] * e2[2], nz = e1[0] * e2[1] - e1[1] * e2[0];
      const flip = nx * want[0] + ny * want[1] + nz * want[2] < 0;
      for (let i = 0; i < nu; i++) for (let k = 0; k < nk; k++) {
        const a = base + i * (nk + 1) + k, b = a + nk + 1;
        if (flip) idx.push(a, a + 1, b, b, a + 1, b + 1); else idx.push(a, b, a + 1, b, b + 1, a + 1);
      }
      return base;
    };
    const OUT = [-D[0], 0, -D[2]], IN = D, DOWN = [0, -1, 0], UP = [0, 1, 0];
    const uAt = (s) => -E + 2 * E * s;
    // Every face's noise tapers to nothing on the edges it shares with its
    // neighbours, and each edge is built from the same points on both sides:
    // displaced independently, the outer face and the soffit never met, and a
    // crack of sky ran the length of the arch (critic r1).
    const outerV = (u, t, y) => v0 - t * 12 - (n(u, y) - 0.5) * 18 * t;
    const innerV = (u, t, y) => v1 + (n(u + 91, y) - 0.5) * 18 * t;
    // outer face: leans out toward the top, lumpy
    grid(NU, NK, (s, t) => {
      const u = uAt(s), ys = soffit(u), y = ys + (top(u) - ys) * t;
      return P(u, outerV(u, t, y), y);
    }, OUT);
    // inner face, back into the cave
    grid(NU, NK, (s, t) => {
      const u = uAt(s), ys = soffit(u), y = ys + (top(u) - ys) * t;
      return P(u, innerV(u, t, y), y);
    }, IN);
    // soffit: the underside, sagging and knobbly (edges exactly on the faces')
    grid(NU, NJ, (s, t) => {
      const u = uAt(s), v = v0 + (v1 - v0) * t, w = Math.sin(t * Math.PI);
      return P(u, v, soffit(u) - ((n(u + 37, v) - 0.5) * 16 + 6) * w);
    }, DOWN);
    // top: the crest, from the outer face's top edge to the inner face's
    grid(NU, NJ, (s, t) => {
      const u = uAt(s), yt = top(u), va = outerV(u, 1, yt), vb = innerV(u, 1, yt), v = va + (vb - va) * t;
      return P(u, v, yt + (n(u + 53, v) - 0.5) * 60 * Math.sin(t * Math.PI));   // (±11 read as a flat lid)
    }, UP);

    // TORCH SCONCES on the jambs, outside, flanking the way in.
    for (const side of [-1, 1]) {
      const u = side * (hw + 14), fy = m.gy + 118, vf = v0 - 14;
      wood.beam(P(u, v0 + 6, fy - 8), P(u, vf, fy - 8), 3, 3, U, C.iron);             // arm, straight back into the rock
      wood.box(P(u, vf, fy - 8), U, [0, 1, 0], D, 3.6, 1.5, 3.6, C.iron);              // ...ending in a ring round the shaft
      wood.box(P(u, vf, fy - 14), U, [0, 1, 0], D, 2.2, 14, 2.2, C.post);              // the torch's shaft
      wood.box(P(u, vf, fy - 1), U, [0, 1, 0], D, 4, 2.5, 4, C.iron);                  // an iron cup for the pitch
      const f = P(u, vf, fy + 1); flames.push({ x: f[0], y: f[1], z: f[2] });
    }

    // MINE PROPS under the overhang: two frames, posts against the jambs and
    // the cap just under the soffit, lagging planks across the caps, and a
    // stringer down each side. Set past the inner face they stood in open
    // canyon, a lone doorframe in a courtyard (critic r1).
    {
      // (posts 8 inside the jambs: at 3 the jamb rock's noise cut through them)
      const pu = hw - 8, capY = Math.min(soffit(pu + 5), soffit(-pu - 5)) - 10, d0 = v0 + 14, d1 = v1 - 14;
      for (const depth of [d0, d1]) {
        for (const side of [-1, 1]) {
          wood.box(P(side * pu, depth, (m.gy - 4 + capY - 6) / 2), U, [0, 1, 0], D, 5, (capY - 6 - m.gy + 4) / 2, 5, C.post);
          wood.beam(P(side * pu, depth, capY - 34), P(side * (pu - 22), depth, capY - 8), 4, 5, D, C.beam);   // knee brace
        }
        wood.beam(P(-(pu + 6), depth, capY), P(pu + 6, depth, capY), 11, 12, D, C.beam);                 // cap
      }
      for (const side of [-1, 1])                                                                           // stringers
        wood.beam(P(side * pu, d0 - 6, capY - 14), P(side * pu, d1 + 6, capY - 14), 7, 8, U, C.beam);
      // lagging: close-set, and starting behind the front cap — five short
      // planks stood on it like battlements from outside (critic r2)
      const nl = Math.max(3, Math.round((2 * pu) / 15));
      for (let k = 0; k < nl; k++) {
        const u = -pu + 6 + (2 * pu - 12) * k / (nl - 1);
        wood.beam(P(u, d0 + 6, capY + 8), P(u, d1 + 10, capY + 8), 12, 4, U, C.lag || C.beam);
      }
      // ...and a close-boarded sheet on top of them, frame to frame. Seen
      // steeply upward through a gap, a ray crossed the lagging, rose to the
      // soffit's height only past the portal's back edge, and found the open
      // canyon sky: a bright slit along every gap (critic r2, r3; traced).
      // (It overhangs both caps: stopped at the lagging's ends it left a strip
      // over each cap, and pinholes of sky showed from inside, critic r4.)
      const s0 = d0 - 7, s1 = d1 + 12;
      wood.box(P(0, (s0 + s1) / 2, capY + 11.5), U, [0, 1, 0], D, pu + 2, 1.5, (s1 - s0) / 2, C.board || C.lag || C.beam);
    }
  }

  const rock = new THREE.BufferGeometry();
  rock.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  rock.setIndex(idx);
  rock.computeVertexNormals();
  rock.computeBoundingSphere();
  return { rock, wood: wood.geometry(THREE), flames };
}
