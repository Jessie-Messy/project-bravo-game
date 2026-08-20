// course.js — turns a run definition into a ridable mountain.
//
// The whole course is an ANALYTIC HEIGHT FUNCTION, not a mesh. `height(x,z)`
// is the single source of truth: terrain.js evaluates it to build chunk
// geometry, physics.js evaluates it four times a frame to stand the rider on
// it, and scenery.js evaluates it to sit trees on the ground. Nothing can ever
// disagree about where the snow is, which is the bug class that kills every
// "collision mesh vs render mesh" approach.
//
// World frame: the rider descends toward -Z, so distance-down-the-hill is
// d = -z. X is lateral. Y is up. That makes the maths read the way a piste map
// does — d increases as you go down the run.
//
// Structure of a height query, in order:
//   1. base elevation of the centreline at d          (tabulated, integrated)
//   2. corridor cross-section: bank, bowl concavity   (tabulated)
//   3. out-of-bounds walls beyond the corridor        (analytic)
//   4. features: moguls, rollers, kickers, pipe, …    (bucketed lookup)
//   5. wind drift noise                               (fbm)

const DS = 2;             // metres between tabulated samples
const RUNOUT = 90;        // flat-ish outrun past the finish line
const LEAD_IN = 40;       // start gate sits at d = 0 with terrain behind it

// ── Noise ─────────────────────────────────────────────────────────
function hash2(x, y) {
  let h = (Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y);
  let fx = x - xi, fy = y - yi;
  fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
  const a = hash2(xi, yi), b = hash2(xi + 1, yi);
  const c = hash2(xi, yi + 1), dd = hash2(xi + 1, yi + 1);
  return (a + (b - a) * fx) * (1 - fy) + (c + (dd - c) * fx) * fy;
}
function fbm(x, y, oct = 3) {
  let v = 0, a = 0.5, f = 1;
  for (let i = 0; i < oct; i++) { v += a * vnoise(x * f, y * f); f *= 2.07; a *= 0.5; }
  return v;
}
function smoothstep(e0, e1, x) {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}
function lerp(a, b, t) { return a + (b - a) * t; }

// Linear interpolation through [[t, value], …] control points.
function curveAt(points, t) {
  if (t <= points[0][0]) return points[0][1];
  const n = points.length;
  if (t >= points[n - 1][0]) return points[n - 1][1];
  for (let i = 1; i < n; i++) {
    if (t <= points[i][0]) {
      const [t0, v0] = points[i - 1], [t1, v1] = points[i];
      const k = (t - t0) / (t1 - t0);
      return lerp(v0, v1, k * k * (3 - 2 * k));   // smoothstep, so no kinks
    }
  }
  return points[n - 1][1];
}

function mulberry(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const CHUNK_LEN = 40;   // metres of course per terrain chunk

export class Course {
  constructor(run, seed = 20260820) {
    this.run = run;
    this.seed = seed;
    this.rand = mulberry(seed ^ (run.id.length * 2654435761));
    this.length = run.courseLength;
    this.total = run.courseLength + RUNOUT;
    this.leadIn = LEAD_IN;
    this.snow = run.snow;

    this.n = Math.ceil((this.total + LEAD_IN) / DS) + 4;
    this.elev = new Float32Array(this.n);
    this.cx = new Float32Array(this.n);     // corridor centreline x
    this.hw = new Float32Array(this.n);     // corridor half-width
    this.bowl = new Float32Array(this.n);   // 0 = flat cross-section, 1 = deep U
    this.bank = new Float32Array(this.n);   // superelevation, radians
    this.pitchT = new Float32Array(this.n); // local pitch, radians

    this._buildProfile();
    this._buildFeatures();
    this._buildProps();
  }

  // ── Tabulated centreline ────────────────────────────────────────
  _buildProfile() {
    const run = this.run, L = this.length;
    // Meander is three detuned sines so the run never repeats visibly, plus a
    // slow drift term that keeps long runs from feeling like a corridor.
    const ph = [this.rand() * 6.283, this.rand() * 6.283, this.rand() * 6.283];
    const amp = run.curve;

    // Zones that alter the base profile rather than adding to the surface.
    const flats = [], drops = [], chutes = [], bowls = [];
    for (const z of run.zones || []) {
      const a = z.at * L, b = (z.at + z.len) * L;
      if (z.type === 'cattrack') flats.push([a, b]);
      else if (z.type === 'cliff') drops.push([a, b, z.drop || 4]);
      else if (z.type === 'chute') chutes.push([a, b]);
      else if (z.type === 'bowl') bowls.push([a, b]);
    }

    let y = 0;
    for (let i = 0; i < this.n; i++) {
      const d = i * DS - LEAD_IN;
      const t = Math.min(1, Math.max(0, d / L));

      // Pitch, softened over the runout so nobody launches off the finish.
      let deg = curveAt(run.pitch, t);
      for (const [a, b] of flats) {
        const f = smoothstep(a - 18, a, d) * (1 - smoothstep(b, b + 18, d));
        deg = lerp(deg, 5.5, f * 0.9);
      }
      if (d > L) deg = lerp(deg, 3.0, smoothstep(L, L + RUNOUT * 0.6, d));
      if (d < 0) deg = lerp(deg, 4.0, smoothstep(-4, -LEAD_IN, d));
      const rad = deg * Math.PI / 180;
      this.pitchT[i] = rad;

      if (i > 0) y -= Math.tan(rad) * DS;
      this.elev[i] = y;

      // Corridor
      let halfW = curveAt(run.width, t) * 0.5;
      for (const [a, b] of chutes) {
        const f = smoothstep(a - 14, a + 6, d) * (1 - smoothstep(b - 6, b + 14, d));
        halfW = lerp(halfW, Math.min(halfW, 7.5), f);
      }
      let bowlF = 0;
      for (const [a, b] of bowls) {
        const f = smoothstep(a - 20, a + 20, d) * (1 - smoothstep(b - 20, b + 20, d));
        bowlF = Math.max(bowlF, f);
        halfW = lerp(halfW, halfW * 1.25, f);
      }
      this.hw[i] = halfW;
      this.bowl[i] = bowlF;

      // Centreline meander, damped to zero at both ends so the start gate and
      // the finish arch always sit square to the fall line.
      const endFade = smoothstep(-LEAD_IN, -LEAD_IN + 25, d) * (1 - smoothstep(L + 20, L + RUNOUT, d));
      const s = d * 0.01;
      this.cx[i] = endFade * amp * (
        13.0 * Math.sin(s * 0.62 + ph[0]) +
         7.0 * Math.sin(s * 1.31 + ph[1]) +
         3.4 * Math.sin(s * 2.73 + ph[2])
      );
    }

    // Cliff bands, applied after the integration pass so the drop is a clean
    // step rather than an accumulated pitch error.
    for (const z of run.zones || []) {
      if (z.type !== 'cliff') continue;
      const a = z.at * L, drop = z.drop || 4;
      for (let i = 0; i < this.n; i++) {
        const d = i * DS - LEAD_IN;
        this.elev[i] -= drop * smoothstep(a - 1.5, a + 1.5, d);
      }
    }

    // Superelevation: bank the corridor into its own curvature so the fast line
    // is the banked one, exactly like a bobsleigh trough.
    const bankZones = (run.zones || []).filter(z => z.type === 'bank');
    for (let i = 1; i < this.n - 1; i++) {
      const curv = (this.cx[i + 1] - 2 * this.cx[i] + this.cx[i - 1]) / (DS * DS);
      let k = 26;
      const d = i * DS - LEAD_IN;
      for (const z of bankZones) {
        const a = z.at * L, b = (z.at + z.len) * L;
        const f = smoothstep(a - 20, a, d) * (1 - smoothstep(b, b + 20, d));
        k = lerp(k, 90, f);
      }
      this.bank[i] = Math.max(-0.42, Math.min(0.42, -curv * k));
    }
    this.bank[0] = this.bank[1];
    this.bank[this.n - 1] = this.bank[this.n - 2];

    this.startY = this.elevAt(0);
    this.finishY = this.elevAt(this.length);
    this.dropTotal = this.startY - this.elevAt(this.total);
  }

  // ── Surface features ────────────────────────────────────────────
  // Bucketed by chunk so a height query only tests the handful of features
  // that could possibly be underfoot, not all ninety of them.
  _buildFeatures() {
    const run = this.run, L = this.length, R = this.rand;
    const feats = [];

    for (const z of run.zones || []) {
      const a = z.at * L, len = z.len * L, b = a + len;
      switch (z.type) {
        case 'moguls':
          feats.push({ kind: 'moguls', a, b, amp: (z.amp || 1) * 0.95, wl: z.wavelength || 11, fade: 12 });
          break;
        case 'rollers':
          feats.push({ kind: 'rollers', a, b, amp: (z.amp || 1) * 1.35, wl: z.wavelength || 26, fade: 14 });
          break;
        case 'halfpipe':
          feats.push({ kind: 'pipe', a, b, depth: z.depth || 6, radius: z.radius || 10, fade: 16 });
          break;
        case 'kickers': {
          const count = z.count || 2, size = z.size || 1;
          for (let i = 0; i < count; i++) {
            const d = a + len * ((i + 0.5) / count);
            feats.push({
              kind: 'kicker', d, size,
              lip: 1.5 + 1.5 * size,            // ramp height above the slope
              ramp: 11 + 6 * size,              // ramp length
              width: 5.5 + 2.5 * size,
              off: (R() - 0.5) * 2 * Math.min(8, this.widthAt(d) * 0.35),
              gap: 9 + 9 * size,
            });
          }
          break;
        }
        case 'rails': {
          const count = z.count || 3;
          for (let i = 0; i < count; i++) {
            const d = a + len * ((i + 0.5) / count);
            const box = R() < 0.5;
            feats.push({
              kind: 'rail', d, len: 8 + R() * 6, box,
              h: box ? 0.55 + R() * 0.35 : 0.75 + R() * 0.5,
              w: box ? 1.3 : 0.5,
              off: (R() - 0.5) * 2 * Math.min(10, this.widthAt(d) * 0.5),
            });
          }
          break;
        }
        case 'crevasse': {
          const count = z.count || 4;
          for (let i = 0; i < count; i++) {
            const d = a + len * ((i + 0.55) / count) + (R() - 0.5) * 8;
            feats.push({
              kind: 'crevasse', d,
              halfLen: 1.6 + R() * 2.4,
              depth: 7 + R() * 5,
              skew: (R() - 0.5) * 0.5,          // not quite square to the fall line
              gapAt: (R() - 0.5) * 1.4,         // a ridable snow bridge, if you find it
            });
          }
          break;
        }
      }
    }

    this.features = feats;
    this.buckets = new Map();
    const push = (ci, f) => {
      let arr = this.buckets.get(ci);
      if (!arr) this.buckets.set(ci, arr = []);
      arr.push(f);
    };
    for (const f of feats) {
      const lo = (f.a !== undefined ? f.a - (f.fade || 0) : f.d - 40);
      const hi = (f.b !== undefined ? f.b + (f.fade || 0) : f.d + 60);
      for (let ci = Math.floor(lo / CHUNK_LEN) - 1; ci <= Math.floor(hi / CHUNK_LEN) + 1; ci++) push(ci, f);
    }
  }

  // ── Table sampling ──────────────────────────────────────────────
  _sample(tab, d) {
    const f = (d + LEAD_IN) / DS;
    const i = Math.floor(f);
    if (i < 0) return tab[0];
    if (i >= this.n - 1) return tab[this.n - 1];
    const k = f - i;
    return tab[i] + (tab[i + 1] - tab[i]) * k;
  }
  elevAt(d)  { return this._sample(this.elev, d); }
  centreAt(d){ return this._sample(this.cx, d); }
  widthAt(d) { return this._sample(this.hw, d); }
  bankAt(d)  { return this._sample(this.bank, d); }
  pitchAt(d) { return this._sample(this.pitchT, d); }
  bowlAt(d)  { return this._sample(this.bowl, d); }

  /** Fall-line heading at d, in radians about Y (0 = straight down the hill). */
  headingAt(d) {
    const a = this.centreAt(d - 4), b = this.centreAt(d + 4);
    return Math.atan2(b - a, 8);
  }

  // ── The height function ─────────────────────────────────────────
  height(x, z) {
    const d = -z;
    let y = this.elevAt(d);
    const c = this.centreAt(d);
    const hw = this.widthAt(d);
    const u = x - c;                 // lateral offset from the centreline
    const au = Math.abs(u);
    const t = au / hw;

    // Cross-section: bank, then bowl concavity toward the edges.
    y += -u * Math.tan(this.bankAt(d));
    const bowlF = this.bowlAt(d);
    if (bowlF > 0.001) y += bowlF * 5.5 * t * t;

    // Out-of-bounds: the hillside continues past the piste edge. This used to
    // be a near-vertical wall, which from the chase camera read as grey ribbons
    // flying through the sky. It is now a real cross-slope — about +1.6 m ten
    // metres out, +6 m at twenty-five, +14 m at forty — so leaving the corridor
    // costs you speed by making you climb, which fences the player in without
    // anything that looks like a fence.
    if (t > 1) {
      const over = au - hw;
      y += Math.min(26, over * 0.10 + over * over * 0.006);
    }

    // Features
    const arr = this.buckets.get(Math.floor(d / CHUNK_LEN));
    if (arr) for (let i = 0; i < arr.length; i++) y += this._featureH(arr[i], d, u, hw);

    // Broad terrain form, on every run regardless of snow type. Without it a
    // groomed piste is a mathematically flat ramp, and a flat white ramp has no
    // light and shade on it at all — which is what makes an untextured
    // snowfield read as a blank sheet rather than as terrain. Amplitudes are
    // deliberately under a metre over tens of metres, so it shapes the light
    // without changing the line you take.
    y += 0.95 * (fbm(x * 0.011, z * 0.009, 2) - 0.5) * 2
       + 0.34 * (fbm(x * 0.055, z * 0.048, 2) - 0.5) * 2;

    // Wind drift on top of that. Amplitude follows the snow type — groomers are
    // scraped smooth, powder builds ripples and pillows.
    const s = this.snow;
    const dr = s === 'powder' ? 0.42 : s === 'crud' ? 0.34 : s === 'hardpack' ? 0.10 : s === 'ice' ? 0.05 : 0.14;
    if (dr > 0.001) {
      y += dr * (fbm(x * 0.045, z * 0.045, 3) - 0.5) * 2
         + dr * 0.55 * (fbm(x * 0.17, z * 0.13, 2) - 0.5) * 2;
    }
    return y;
  }

  _featureH(f, d, u, hw) {
    switch (f.kind) {
      case 'moguls': {
        if (d < f.a - f.fade || d > f.b + f.fade) return 0;
        const g = smoothstep(f.a - f.fade, f.a + 4, d) * (1 - smoothstep(f.b - 4, f.b + f.fade, d));
        if (g <= 0.001) return 0;
        // Offset rows: every other line of bumps is shifted half a wavelength,
        // which is what makes a real mogul field a diagonal lattice rather than
        // a waffle iron.
        const row = Math.floor(d / f.wl);
        const shift = (row & 1) ? f.wl * 0.5 : 0;
        const bu = Math.cos((u + shift) * 2 * Math.PI / f.wl);
        const bd = Math.cos(d * 2 * Math.PI / f.wl);
        const bump = (bu * 0.5 + 0.5) * (bd * 0.5 + 0.5);
        const edge = 1 - smoothstep(0.82, 1.02, Math.abs(u) / hw);
        return g * edge * f.amp * (bump * 1.7 - 0.55);
      }
      case 'rollers': {
        if (d < f.a - f.fade || d > f.b + f.fade) return 0;
        const g = smoothstep(f.a - f.fade, f.a + 5, d) * (1 - smoothstep(f.b - 5, f.b + f.fade, d));
        return g * f.amp * Math.sin(d * 2 * Math.PI / f.wl) * (1 - 0.35 * Math.abs(u) / hw);
      }
      case 'pipe': {
        if (d < f.a - f.fade || d > f.b + f.fade) return 0;
        const g = smoothstep(f.a - f.fade, f.a + 8, d) * (1 - smoothstep(f.b - 8, f.b + f.fade, d));
        if (g <= 0.001) return 0;
        // Flat bottom of `radius` metres, then a transition arc up to vertical.
        const flat = f.radius, au = Math.abs(u);
        if (au <= flat) return 0;
        const over = Math.min(au - flat, f.radius);
        // Quarter-circle transition, then the vertical lip above it.
        const arc = f.depth * (1 - Math.sqrt(Math.max(0, 1 - (over / f.radius) ** 2)));
        const vert = Math.max(0, au - flat - f.radius) * 3.0;
        return g * (arc + Math.min(vert, f.depth * 0.5));
      }
      case 'kicker': {
        const uu = u - f.off;
        if (Math.abs(uu) > f.width * 1.4) return 0;
        const lat = 1 - smoothstep(f.width * 0.72, f.width * 1.35, Math.abs(uu));
        if (lat <= 0.001) return 0;
        if (d > f.d - f.ramp && d <= f.d) {
          // Ramp: cubic ease so the transition is smooth at the bottom and
          // steepest at the lip, which is how a real booter is shaped.
          const k = (d - (f.d - f.ramp)) / f.ramp;
          return lat * f.lip * k * k * (1.35 - 0.35 * k);
        }
        if (d > f.d && d < f.d + 1.2) return lat * f.lip * (1 - (d - f.d) / 1.2) * 0.35;
        // Landing knuckle then a steeper landing slope past the gap.
        const ls = f.d + f.gap;
        if (d > ls - 3 && d < ls + 16) {
          const k = smoothstep(ls - 3, ls + 2, d) * (1 - smoothstep(ls + 9, ls + 16, d));
          return -lat * f.lip * 0.55 * k;
        }
        return 0;
      }
      case 'rail': {
        const uu = u - f.off;
        if (Math.abs(uu) > f.w * 1.9) return 0;
        if (d < f.d - 1 || d > f.d + f.len + 1) return 0;
        const along = smoothstep(f.d - 0.8, f.d + 1.6, d) * (1 - smoothstep(f.d + f.len - 1.6, f.d + f.len + 0.8, d));
        const lat = 1 - smoothstep(f.w * 0.85, f.w * 1.6, Math.abs(uu));
        // Rise relative to the slope, so it stays a level ride the whole way.
        const rise = this.elevAt(f.d) - this.elevAt(d);
        return along * lat * (f.h + rise);
      }
      case 'crevasse': {
        const dd = d - f.d - u * f.skew;
        const a = Math.abs(dd);
        if (a > f.halfLen + 2.5) return 0;
        // Snow bridge: one lateral band stays intact, and finding it is the
        // whole game on the Vallée Blanche.
        const bridge = smoothstep(3.5, 1.2, Math.abs(u - f.gapAt * this.widthAt(d)));
        const open = 1 - bridge;
        return -f.depth * open * (1 - smoothstep(f.halfLen - 0.4, f.halfLen + 1.4, a));
      }
      default: return 0;
    }
  }

  /** Surface normal by central difference. eps of 0.6 m matches the board. */
  normal(x, z, out = { x: 0, y: 1, z: 0 }, eps = 0.6) {
    const hx = this.height(x + eps, z) - this.height(x - eps, z);
    const hz = this.height(x, z + eps) - this.height(x, z - eps);
    const nx = -hx / (2 * eps), nz = -hz / (2 * eps);
    const inv = 1 / Math.hypot(nx, 1, nz);
    out.x = nx * inv; out.y = inv; out.z = nz * inv;
    return out;
  }

  /** True where the surface is a groomed piste (drives the corduroy shader). */
  isGroomed(d, u) {
    if (this.snow === 'powder' || this.snow === 'crud') return 0;
    const hw = this.widthAt(d);
    return 1 - smoothstep(0.72, 0.96, Math.abs(u) / hw);
  }

  // ── Scenery placement ───────────────────────────────────────────
  // Generated once, bucketed by chunk. scenery.js only ever instances the
  // buckets inside the view distance, so a 2.6 km run costs the same per frame
  // as a 1.4 km one.
  _buildProps() {
    const R = this.rand, run = this.run, L = this.length;
    const props = [];
    const treeLineD = (run.treeLine ?? 0.4) * L;

    const gladed = [];
    for (const z of run.zones || []) {
      if (z.type === 'gladed') gladed.push([z.at * L, (z.at + z.len) * L, z.density || 0.6]);
    }
    const isGladed = (d) => {
      for (const [a, b, den] of gladed) if (d > a && d < b) return den;
      return 0;
    };

    // Flanking forest. Density ramps in below the tree line and thickens as the
    // run drops, which is what the real transition out of the alpine looks like.
    const step = 3.2;
    for (let d = -this.leadIn; d < this.total; d += step) {
      const belowTreeLine = smoothstep(treeLineD - 60, treeLineD + 80, d);
      const dens = run.trees * belowTreeLine;
      if (dens <= 0.01) continue;
      const hw = this.widthAt(d), c = this.centreAt(d);
      for (const side of [-1, 1]) {
        // ceil, not round: a run with trees:0.15 rounded to zero attempts and
        // grew no forest at all. The `R() > dens` gate below is what actually
        // sets the density; this only has to offer enough attempts.
        const n = Math.max(1, Math.ceil(dens * 3.2));
        for (let i = 0; i < n; i++) {
          if (R() > dens) continue;
          const out = 1.5 + Math.pow(R(), 0.55) * 34;
          const x = c + side * (hw + out);
          const zz = -(d + (R() - 0.5) * step * 2);
          props.push({
            type: 'conifer', x, z: zz,
            s: 0.72 + R() * 0.85, rot: R() * 6.283,
            lean: (R() - 0.5) * 0.10, snow: 0.5 + R() * 0.5,
            v: (R() * 3) | 0,
          });
        }
      }
      // Trees inside the corridor — the whole point of a glade run.
      const gd = isGladed(d);
      if (gd > 0) {
        const n = Math.max(1, Math.ceil(gd * 2.4));
        for (let i = 0; i < n; i++) {
          if (R() > gd) continue;
          const u = (R() - 0.5) * 2 * hw * 0.92;
          props.push({
            type: 'conifer', x: c + u, z: -(d + (R() - 0.5) * step * 2),
            s: 0.62 + R() * 0.75, rot: R() * 6.283,
            lean: (R() - 0.5) * 0.12, snow: 0.6 + R() * 0.4,
            v: (R() * 3) | 0,
          });
        }
      }
    }

    // Rocks and boulders, mostly on the shoulders, occasionally in-bounds as a
    // hazard you have to read.
    const rockDens = run.rocks ?? 0.4;
    for (let d = -this.leadIn; d < this.total; d += 6) {
      if (R() > rockDens * 0.7) continue;
      const hw = this.widthAt(d), c = this.centreAt(d);
      const side = R() < 0.5 ? -1 : 1;
      const inBounds = R() < 0.16;
      const u = inBounds ? (R() - 0.5) * 2 * hw * 0.8 : side * (hw + R() * 22);
      props.push({
        type: 'rock', x: c + u, z: -(d + R() * 6),
        s: (inBounds ? 0.5 : 0.8) + R() * (inBounds ? 0.7 : 2.0),
        rot: R() * 6.283, v: (R() * 3) | 0,
      });
    }

    // Authored props from the zone list.
    for (const z of run.zones || []) {
      const a = z.at * L, len = z.len * L;
      if (z.type === 'gates') {
        const count = z.count || 10;
        for (let i = 0; i < count; i++) {
          const d = a + len * ((i + 0.5) / count);
          const hw = this.widthAt(d), c = this.centreAt(d);
          const u = Math.sin(i * 1.9) * hw * 0.45;
          props.push({ type: 'gate', x: c + u, z: -d, s: 1, rot: 0, v: i & 1 });
        }
      } else if (z.type === 'seracs') {
        for (let i = 0; i < 26; i++) {
          const d = a + len * R();
          const hw = this.widthAt(d), c = this.centreAt(d);
          const side = R() < 0.5 ? -1 : 1;
          const u = R() < 0.3 ? (R() - 0.5) * 2 * hw * 0.7 : side * (hw * 0.75 + R() * 26);
          props.push({ type: 'serac', x: c + u, z: -d, s: 1.2 + R() * 2.6, rot: R() * 6.283, v: (R() * 3) | 0 });
        }
      } else if (z.type === 'crevasse') {
        // Warning wands on the approach.
        for (let i = 0; i < 6; i++) {
          const d = a - 12 + len * R();
          const hw = this.widthAt(d), c = this.centreAt(d);
          props.push({ type: 'wand', x: c + (R() - 0.5) * 2 * hw * 0.8, z: -d, s: 1, rot: 0, v: 0 });
        }
      }
    }

    // Rails and kickers get physical props to match their height contribution.
    for (const f of this.features) {
      if (f.kind === 'rail') props.push({ type: f.box ? 'box' : 'rail', x: this.centreAt(f.d) + f.off, z: -f.d, s: 1, rot: 0, v: 0, len: f.len, h: f.h, w: f.w });
    }

    // Piste furniture. Netting is deliberately RARE: a continuous orange fence
    // down both shoulders reads as a construction site, not a mountain. Real
    // B-net goes where a fall has consequences — above the steepest pitches and
    // through the finish area — and nowhere else.
    const netSeg = 11.5;   // matches the geometry's own segment length
    for (let d = 0; d < L; d += netSeg) {
      const t = d / L;
      const steep = this.pitchAt(d) > 0.50;
      const finish = t > 0.95;
      if (!steep && !finish) continue;
      const hw = this.widthAt(d), c = this.centreAt(d);
      props.push({ type: 'net', x: c - hw - 1.5, z: -d, s: 1, rot: 0, v: 0 });
      props.push({ type: 'net', x: c + hw + 1.5, z: -d, s: 1, rot: 0, v: 1 });
    }
    if (run.grade !== 'double') {
      const side = R() < 0.5 ? -1 : 1;
      for (let d = 40; d < L; d += 120) {
        const hw = this.widthAt(d), c = this.centreAt(d);
        props.push({ type: 'tower', x: c + side * (hw + 16), z: -d, s: 1, rot: 0, v: 0 });
      }
    }
    for (let d = 60; d < L; d += 210) {
      const hw = this.widthAt(d), c = this.centreAt(d);
      props.push({ type: 'sign', x: c - hw + 2.5, z: -d, s: 1, rot: 0, v: 0 });
    }

    // Props never move, so their ground height is baked once here rather than
    // re-sampled for every visible prop each time the rider crosses a chunk
    // boundary — that was ~1500 height() calls in a single frame.
    for (const p of props) p.y = this.height(p.x, p.z);

    this.props = props;
    this.propBuckets = new Map();
    for (const p of props) {
      const ci = Math.floor((-p.z) / CHUNK_LEN);
      let arr = this.propBuckets.get(ci);
      if (!arr) this.propBuckets.set(ci, arr = []);
      arr.push(p);
    }
  }

  propsInChunk(ci) { return this.propBuckets.get(ci) || []; }
}
