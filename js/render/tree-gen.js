// tree-gen.js — recursive procedural tree geometry.
//
// Replaces the stacked-cone canopy in trees.js with actual branch structure,
// following the approach in dgreenheck's EZ-Tree write-up: a queue of branches,
// each swept as a chain of tapering rings, each spawning children until a depth
// limit where leaves are emitted instead.
//
// THE CONSTRAINT THAT SHAPES EVERYTHING HERE: the forest is drawn with
// InstancedMesh. game3d.js draws thousands of trees from a handful of shared
// geometries, so this file must NOT be called per tree. It is called once per
// SPECIES at load to bake a small set of variants; individual trees then vary
// by per-instance scale, spin and lean, which is already how the forest works.
// Generating unique geometry per tree would turn two draw calls into thousands.
//
// Output is TWO merged geometries per tree, because bark and leaves need
// different materials (leaves are alpha-tested double-sided quads, bark is not):
//
//   { bark, leaf }
//
// LOCAL SPACE: unlike the old canopy, the origin is at the BASE OF THE TRUNK,
// y = 0, growing up to roughly `trunkLength`. Both returned geometries share
// that frame, so one instance matrix positions both — no more keeping a trunk
// and a canopy in sync at different heights. The wind shader weights by
// y / height, which is 0 at the roots and 1 at the tip, the way a tree bends.

// ── Deterministic RNG ─────────────────────────────────────────────
// Same generator as trees.js. Shape variation must be reproducible: these
// geometries are baked once, but a species table that reshuffled between
// reloads would make saved worlds look different every session.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Defaults are a mid-sized conifer. Every field is per-LEVEL where the level is
// the recursion depth (0 = trunk), except `force`, which is global.
//
// Reading the level arrays: index 0 describes the trunk, index 1 its children,
// and so on. An array shorter than `levels` clamps to its last entry, so a
// species only has to specify the levels where it actually differs.
export const DEFAULT_PARAMS = {
  levels: 3,                       // recursion depth; leaves are emitted at `levels`
  length:     [220, 90, 42],       // world units, per level
  radius:     [11, 4.2, 1.5],      // radius at the START of a branch
  taper:      [0.82, 0.86, 0.95],  // fraction of radius lost by the tip
  sections:   [8, 5, 3],           // rings along a branch — controls curve smoothness
  segments:   [7, 5, 4],           // sides per ring — controls roundness
  children:   [5, 3, 0],           // child branches spawned per branch
  start:      [0.28, 0.22, 0.2],   // children begin this far along the parent (0..1)
  angle:      [0.62, 0.72, 0.8],   // radians away from the parent's axis
  gnarliness: [0.06, 0.13, 0.2],   // random per-section wobble
  twist:      [0.05, 0.08, 0.0],   // spiral about the branch axis, radians/section
  profile:    ['flat'],            // how child length varies along the parent;
                                   // see profileMult() -- 'cone'|'pine'|'round'

  // Phototropism. Branches rotate toward `direction` with a strength that falls
  // off with radius, so twigs curl up hard and the trunk barely notices. This
  // is what stops a recursive tree from looking like a radially symmetric toy.
  force: { direction: [0, 1, 0], strength: 0.06 },

  leaves: {
    count: 6,        // quads per terminal branch
    size: 26,        // quad edge length in world units
    angle: 0.5,      // tilt away from the branch axis
    start: 0.25,     // how far along the terminal branch leaves begin
    cross: true,     // emit a second quad at 90° so leaves have volume
  },
};

// Resolve a per-level array at `lvl`, clamping to the last entry.
function at(arr, lvl) {
  if (!Array.isArray(arr)) return arr;
  return arr[Math.min(lvl, arr.length - 1)];
}

// How a child branch's length varies with how far up its parent it grows.
// THIS is what separates the species — far more than branch angle does. Give
// every branch the same length and you get a star, whatever the angle; that is
// exactly what the first pass produced, and pine, spruce and oak were
// indistinguishable.
//
//   'cone'  spruce — longest at the base, shrinking to the leader
//   'pine'  pine   — bare lower trunk, widest about a third up, tapering above
//   'round' oak    — short low limbs opening into a broad rounded crown
//   'flat'  no variation
//
// `t` is 0 at the base of the parent and 1 at its tip.
function profileMult(kind, t) {
  switch (kind) {
    case 'cone':  return 1 - 0.85 * t;
    case 'pine':  return Math.max(0.10, 1 - Math.pow(Math.abs(t - 0.34) / 0.66, 1.6));
    case 'round': return 0.42 + 0.58 * Math.sin(Math.PI * Math.min(1, 0.18 + t * 0.88));
    default:      return 1;
  }
}

// A growing set of typed-array-backed buffers. Building into plain arrays and
// converting once at the end is far cheaper than repeatedly resizing typed
// arrays, and this runs at load where a few large arrays are not a problem.
function newSink() {
  return { pos: [], nrm: [], uv: [], idx: [] };
}
function sinkToGeometry(THREE, s) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(s.pos, 3));
  g.setAttribute('normal',   new THREE.Float32BufferAttribute(s.nrm, 3));
  g.setAttribute('uv',       new THREE.Float32BufferAttribute(s.uv, 2));
  g.setIndex(s.idx);
  g.computeBoundingSphere();
  return g;
}

/**
 * Generate one tree.
 *
 * @param THREE   the three.js namespace (this module never imports it, matching
 *                the rest of js/render/*, which is loaded before the renderer)
 * @param params  see DEFAULT_PARAMS; shallow-merged over it
 * @param seed    integer; the same seed always produces the same tree
 * @returns {{ bark: BufferGeometry, leaf: BufferGeometry, height: number }}
 */
export function generateTree(THREE, params = {}, seed = 1) {
  const P = Object.assign({}, DEFAULT_PARAMS, params);
  P.force  = Object.assign({}, DEFAULT_PARAMS.force,  params.force  || {});
  P.leaves = Object.assign({}, DEFAULT_PARAMS.leaves, params.leaves || {});

  const rand = rng(seed);
  const rrange = (a, b) => a + rand() * (b - a);

  const bark = newSink();
  const leaf = newSink();

  const forceDir = new THREE.Vector3().fromArray(P.force.direction).normalize();

  // Scratch objects, reused across the whole build. Allocating a Vector3 per
  // vertex on a tree with tens of thousands of them is the difference between
  // this taking milliseconds and taking a noticeable hitch at load.
  const _q     = new THREE.Quaternion();
  const _qTmp  = new THREE.Quaternion();
  const _e     = new THREE.Euler();
  const _v     = new THREE.Vector3();
  const _axis  = new THREE.Vector3();
  const _up    = new THREE.Vector3(0, 1, 0);
  const _nrm   = new THREE.Vector3();

  let maxY = 0;

  // The queue the whole algorithm runs on. Breadth-first rather than recursive
  // so depth is bounded by the params, not the JS stack, and so a runaway
  // species definition fails as "too many branches" rather than as a crash.
  const queue = [{
    origin: new THREE.Vector3(0, 0, 0),
    orientation: new THREE.Quaternion(),      // identity = growing along +Y
    length: at(P.length, 0),
    radius: at(P.radius, 0),
    level: 0,
  }];

  // Hard ceiling. Children multiply, and a typo like children:[8,8,8] with
  // levels:4 is 4681 branches — enough to lock the tab. Failing loudly beats
  // hanging.
  const MAX_BRANCHES = 4000;
  let built = 0;

  while (queue.length) {
    const b = queue.shift();
    if (++built > MAX_BRANCHES) {
      throw new Error('generateTree: branch budget exceeded (' + MAX_BRANCHES +
        '). Check children[]/levels in the species params.');
    }
    buildBranch(b);
  }

  function buildBranch(branch) {
    const lvl      = branch.level;
    const sections = Math.max(2, at(P.sections, lvl) | 0);
    const segments = Math.max(3, at(P.segments, lvl) | 0);
    const taper    = at(P.taper, lvl);
    const gnarl    = at(P.gnarliness, lvl);
    const twist    = at(P.twist, lvl);

    const secLen = branch.length / sections;

    // Ring vertices are recorded so children can be attached to a real point on
    // the parent rather than to an approximation of it.
    const ringStart = [];    // index of the first vertex of each ring
    const ringPos   = [];    // Vector3 centre of each ring
    const ringQuat  = [];    // orientation at each ring
    const ringRad   = [];    // radius at each ring

    const pos = branch.origin.clone();
    const q   = branch.orientation.clone();

    for (let i = 0; i <= sections; i++) {
      const t = i / sections;
      const r = branch.radius * (1 - taper * t);

      ringStart.push(bark.pos.length / 3);
      ringPos.push(pos.clone());
      ringQuat.push(q.clone());
      ringRad.push(r);

      // Emit the ring. `segments + 1` vertices, duplicating the seam vertex, so
      // the bark UV can run 0..1 without the last face sampling backwards
      // across the whole texture.
      for (let s = 0; s <= segments; s++) {
        const a = (s / segments) * Math.PI * 2;
        _v.set(Math.cos(a) * r, 0, Math.sin(a) * r).applyQuaternion(q).add(pos);
        bark.pos.push(_v.x, _v.y, _v.z);

        // Outward normal: the ring offset with the radius divided out, so it
        // stays unit-length regardless of how thin the branch has tapered.
        _nrm.set(Math.cos(a), 0, Math.sin(a)).applyQuaternion(q);
        bark.nrm.push(_nrm.x, _nrm.y, _nrm.z);

        // V repeats along the branch so bark does not stretch on long trunks.
        bark.uv.push(s / segments, t * (branch.length / 90));
      }

      if (_v.y > maxY) maxY = _v.y;

      if (i < sections) {
        // Advance to the next ring, then bend. Bending AFTER the step means the
        // first ring keeps the orientation it was handed, so a child branch
        // leaves its parent at the angle it was given.
        _v.set(0, secLen, 0).applyQuaternion(q);
        pos.add(_v);

        // Gnarliness: random wobble, scaled up as the branch thins. A thick
        // trunk that wandered this much would look broken; a twig that didn't
        // would look extruded.
        const gScale = Math.max(1, 1 / Math.sqrt(Math.max(0.05, ringRad[i])));
        _e.set(rrange(-gnarl, gnarl) * gScale, 0, rrange(-gnarl, gnarl) * gScale);
        _qTmp.setFromEuler(_e);
        q.multiply(_qTmp);

        // Twist about the branch's own axis. Cheap, and it keeps child branches
        // from all landing in one plane.
        if (twist) {
          _qTmp.setFromAxisAngle(_up, twist);
          q.multiply(_qTmp);
        }

        // Growth force. Rotate the branch's own +Y toward the force direction,
        // weighted down by radius so the trunk resists and twigs comply.
        if (P.force.strength) {
          _v.set(0, 1, 0).applyQuaternion(q);
          _axis.crossVectors(_v, forceDir);
          const len = _axis.length();
          if (len > 1e-5) {
            _axis.divideScalar(len);
            // The 1/r term is what makes twigs comply and trunks resist, but it
            // is unbounded as the branch tapers: with taper 0.94 the tip radius
            // approaches zero, the clamp takes over, and the force becomes an
            // order of magnitude stronger than the value the species asked for.
            // That curled every branch tip violently upward and collapsed the
            // conifers into narrow lopsided crowns instead of cones.
            //
            // Normalising against the branch's OWN starting radius keeps the
            // intended behaviour — thin branches bend more than thick ones —
            // while making `strength` mean the same thing at every scale.
            const rNorm = Math.max(0.25, ringRad[i] / Math.max(0.05, branch.radius));
            const amount = Math.asin(Math.min(1, len)) * P.force.strength / rNorm;
            _qTmp.setFromAxisAngle(_axis, amount);
            q.premultiply(_qTmp);
          }
        }
      }
    }

    // Stitch consecutive rings into quads.
    for (let i = 0; i < sections; i++) {
      const a = ringStart[i], b2 = ringStart[i + 1];
      for (let s = 0; s < segments; s++) {
        const a0 = a + s, a1 = a + s + 1;
        const b0 = b2 + s, b1 = b2 + s + 1;
        bark.idx.push(a0, b0, a1,  a1, b0, b1);
      }
    }

    // ── Children, or leaves at the last level ──
    const isTerminal = lvl >= P.levels - 1;
    if (isTerminal) {
      emitLeaves(branch, ringPos, ringQuat, sections);
      return;
    }

    const kids = at(P.children, lvl) | 0;
    if (kids <= 0) return;

    const startFrac  = at(P.start, lvl);
    const childAngle = at(P.angle, lvl);
    const radialOff  = rand();

    for (let c = 0; c < kids; c++) {
      // Spread children along the parent's upper portion. Evenly spaced with a
      // jitter — purely random placement clumps, and clumps read as damage.
      const t = startFrac + (1 - startFrac) * ((c + rrange(0.15, 0.85)) / kids);
      const f = t * sections;
      const i0 = Math.min(sections - 1, Math.floor(f));
      const frac = f - i0;

      const cpos = ringPos[i0].clone().lerp(ringPos[i0 + 1], frac);
      const crad = ringRad[i0] * (1 - frac) + ringRad[i0 + 1] * frac;
      _q.copy(ringQuat[i0]).slerp(ringQuat[i0 + 1], frac);

      // Distribute radially around the parent, then tilt outward.
      const radial = Math.PI * 2 * (radialOff + c / kids);
      _qTmp.setFromAxisAngle(_up, radial);
      _q.multiply(_qTmp);
      _qTmp.setFromAxisAngle(new THREE.Vector3(1, 0, 0), childAngle * rrange(0.75, 1.25));
      _q.multiply(_qTmp);

      // A child is never thicker than the parent it leaves — that reads as a
      // growth, not a branch.
      const cr = Math.min(crad * 0.82, at(P.radius, lvl + 1) * rrange(0.8, 1.15));
      // Species silhouette lives here: see profileMult above.
      const cl = at(P.length, lvl + 1) * rrange(0.8, 1.15) *
                 profileMult(at(P.profile, lvl) || 'flat', t);

      queue.push({
        origin: cpos,
        orientation: _q.clone(),
        length: cl,
        radius: cr,
        level: lvl + 1,
      });
    }
  }

  // Leaves are crossed quads: two planes at 90° so a leaf cluster still has
  // volume when you walk around it. A single quad flickers out of existence at
  // grazing angles, which is the classic giveaway of cheap foliage.
  function emitLeaves(branch, ringPos, ringQuat, sections) {
    const L = P.leaves;
    const n = L.count | 0;
    if (n <= 0) return;

    for (let c = 0; c < n; c++) {
      const t = L.start + (1 - L.start) * ((c + rrange(0.1, 0.9)) / n);
      const f = t * sections;
      const i0 = Math.min(sections - 1, Math.floor(f));
      const frac = f - i0;

      const p = ringPos[i0].clone().lerp(ringPos[i0 + 1], frac);
      _q.copy(ringQuat[i0]).slerp(ringQuat[i0 + 1], frac);

      // Spin each cluster around the branch and tilt it off the axis.
      _qTmp.setFromAxisAngle(_up, rand() * Math.PI * 2);
      _q.multiply(_qTmp);
      _qTmp.setFromAxisAngle(new THREE.Vector3(1, 0, 0), L.angle * rrange(0.6, 1.4));
      _q.multiply(_qTmp);

      const size = L.size * rrange(0.75, 1.25);
      quad(p, _q, size, 0);
      if (L.cross) quad(p, _q, size, Math.PI / 2);
    }
  }

  // One leaf quad, rooted at its base edge so it hangs off the branch rather
  // than being centred on it.
  function quad(p, q, size, roll) {
    const base = leaf.pos.length / 3;
    _qTmp.setFromAxisAngle(_up, roll);
    const qq = q.clone().multiply(_qTmp);

    const hw = size * 0.5;
    // Corners in leaf-local space: x across, y along the leaf's length.
    const corners = [[-hw, 0], [hw, 0], [-hw, size], [hw, size]];
    for (let i = 0; i < 4; i++) {
      _v.set(corners[i][0], corners[i][1], 0).applyQuaternion(qq).add(p);
      leaf.pos.push(_v.x, _v.y, _v.z);
      if (_v.y > maxY) maxY = _v.y;
    }
    // A single normal for the whole quad, pointing along the leaf's face.
    // Per-corner normals on a flat quad buy nothing and cost bandwidth.
    _nrm.set(0, 0, 1).applyQuaternion(qq);
    for (let i = 0; i < 4; i++) leaf.nrm.push(_nrm.x, _nrm.y, _nrm.z);

    leaf.uv.push(0, 0,  1, 0,  0, 1,  1, 1);
    leaf.idx.push(base, base + 1, base + 2,  base + 2, base + 1, base + 3);
  }

  return {
    bark: sinkToGeometry(THREE, bark),
    leaf: sinkToGeometry(THREE, leaf),
    height: maxY,
    branches: built,
  };
}
