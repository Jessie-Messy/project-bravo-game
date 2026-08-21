// scenery.js — everything on the mountain that is not the mountain.
//
// All of it is generated in code. No .glb, no texture downloads, no licence
// audit: a conifer is four cones and a cylinder merged into one geometry with
// baked vertex colours, and a serac is a sheared prism. That buys three things
// that matter more than model fidelity at 25 m/s — the whole game stays a
// couple of hundred KB, every prop can be re-tinted per mountain, and each type
// collapses into a single InstancedMesh, so a thousand trees cost one draw
// call.
//
// Instances are rebuilt only when the rider crosses a chunk boundary, from the
// prop buckets course.js baked at load. Rebuilding a few hundred matrices once
// a second is free; re-uploading geometry would not be.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CHUNK_LEN } from './course.js';

// Paint a geometry's vertices, optionally shading by height or normal so a
// single merged mesh can carry snow-on-top for free.
function paint(geo, color, opts = {}) {
  const pos = geo.attributes.position;
  const nrm = geo.attributes.normal;
  const n = pos.count;
  const col = new Float32Array(n * 3);
  const c = new THREE.Color();
  const base = new THREE.Color(color);
  const top = opts.top ? new THREE.Color(opts.top) : null;
  let minY = Infinity, maxY = -Infinity;
  if (top) for (let i = 0; i < n; i++) { const y = pos.getY(i); if (y < minY) minY = y; if (y > maxY) maxY = y; }
  for (let i = 0; i < n; i++) {
    c.copy(base);
    if (top) {
      const t = (pos.getY(i) - minY) / Math.max(0.001, maxY - minY);
      // Snow sticks to up-facing surfaces, and more of it near the top.
      const up = nrm ? Math.max(0, nrm.getY(i)) : 1;
      c.lerp(top, Math.pow(t, opts.topPow ?? 1.4) * Math.pow(up, opts.upPow ?? 1.2) * (opts.topAmt ?? 1));
    }
    if (opts.jitter) {
      const j = 1 + (Math.sin(i * 12.9898) * 43758.5453 % 1) * opts.jitter;
      c.multiplyScalar(j);
    }
    col[i * 3] = c.r; col[i * 3 + 1] = c.g; col[i * 3 + 2] = c.b;
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
  return geo;
}

function rngFrom(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ── Prop geometry builders ────────────────────────────────────────

function makeConifer(variant, palette) {
  const R = rngFrom(9001 + variant * 77);
  const parts = [];
  const h = 7.0 + variant * 2.6;                 // 7 / 9.6 / 12.2 m
  const trunkR = 0.14 + variant * 0.03;

  const trunk = new THREE.CylinderGeometry(trunkR * 0.62, trunkR, h * 0.42, 6, 1);
  trunk.translate(0, h * 0.21, 0);
  parts.push(paint(trunk, palette.bark));

  // Stacked canopy tiers, each with a white cap sitting on top of it.
  const tiers = 4 + variant;
  for (let i = 0; i < tiers; i++) {
    const t = i / (tiers - 1);
    const y = h * (0.24 + 0.68 * t);
    const r = (1.72 - variant * 0.06) * (1 - t * 0.82) * (0.9 + R() * 0.2);
    const th = h * (0.30 - t * 0.13);
    const cone = new THREE.ConeGeometry(r, th, 7, 1);
    cone.translate(0, y + th * 0.35, 0);
    parts.push(paint(cone, palette.needle, { top: palette.needleTip, topAmt: 0.7, topPow: 0.7 }));

    // The snow layer: a wider, flatter cone offset a hair up the trunk.
    const cap = new THREE.ConeGeometry(r * 0.97, th * 0.42, 7, 1);
    cap.translate(0, y + th * 0.62, 0);
    parts.push(paint(cap, palette.snow, { jitter: 0.06 }));
  }
  const g = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  g.computeVertexNormals();
  return g;
}

function makeRock(variant) {
  const R = rngFrom(4242 + variant * 31);
  const g = new THREE.IcosahedronGeometry(1, variant === 2 ? 2 : 1);
  const pos = g.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
    const k = 0.62 + R() * 0.7;
    // Squash vertically so boulders sit rather than float, and flatten the base.
    pos.setXYZ(i, x * k * 1.15, Math.max(-0.15, y * k * 0.72), z * k * 1.1);
  }
  g.computeVertexNormals();
  g.translate(0, 0.42, 0);
  return paint(g, 0x51576b, { top: 0xf2f7ff, topAmt: 0.95, topPow: 1.1, upPow: 2.4, jitter: 0.10 });
}

function makeSerac(variant) {
  const R = rngFrom(777 + variant * 19);
  const parts = [];
  const n = 2 + variant;
  for (let i = 0; i < n; i++) {
    const w = 0.8 + R() * 1.4, hh = 1.6 + R() * 2.6, d = 0.8 + R() * 1.2;
    const b = new THREE.BoxGeometry(w, hh, d);
    // Shear the top so the block leans, the way calved ice actually stands.
    const pos = b.attributes.position;
    for (let v = 0; v < pos.count; v++) {
      if (pos.getY(v) > 0) pos.setX(v, pos.getX(v) + (R() - 0.5) * 0.5 + 0.25);
    }
    b.computeVertexNormals();
    b.rotateY(R() * 6.283);
    b.translate((R() - 0.5) * 1.8, hh * 0.5, (R() - 0.5) * 1.8);
    parts.push(paint(b, 0x9cc6ea, { top: 0xffffff, topAmt: 0.9, upPow: 2.0, jitter: 0.08 }));
  }
  const g = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  g.computeVertexNormals();
  return g;
}

function makeGate(variant) {
  const parts = [];
  const pole = new THREE.CylinderGeometry(0.035, 0.045, 2.0, 6);
  pole.translate(0, 1.0, 0);
  parts.push(paint(pole, 0xe8e8ee));
  const flag = new THREE.PlaneGeometry(0.72, 0.5);
  flag.translate(0.36, 1.62, 0);
  parts.push(paint(flag, variant ? 0x2b6ef2 : 0xe0242c));
  const g = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return g;
}

function makeNet(variant) {
  const parts = [];
  // Runs ALONG the fall line (local Z), not across it: props are placed every
  // 11 m down each shoulder, so a segment has to span that gap or the netting
  // reads as a row of sticks poking into the piste.
  const SEG = 11.5;
  for (const z of [0, -SEG]) {
    const post = new THREE.CylinderGeometry(0.05, 0.06, 1.9, 6);
    post.translate(0, 0.95, z);
    parts.push(paint(post, 0x2b2f36));
  }
  // Horizontal bars rather than an alpha texture, so it stays readable at
  // distance and never shimmers.
  for (let i = 0; i < 5; i++) {
    const bar = new THREE.BoxGeometry(0.03, 0.045, SEG);
    bar.translate(0, 0.34 + i * 0.36, -SEG * 0.5);
    parts.push(paint(bar, variant ? 0xb8482a : 0xc4762a));   // weathered, not hi-vis
  }
  const g = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return g;
}

function makeTower() {
  const parts = [];
  const leg = new THREE.CylinderGeometry(0.22, 0.34, 11, 8);
  leg.translate(0, 5.5, 0);
  parts.push(paint(leg, 0x3b4250));
  const arm = new THREE.BoxGeometry(4.2, 0.22, 0.3);
  arm.translate(0, 11.1, 0);
  parts.push(paint(arm, 0x3b4250));
  for (const s of [-1, 1]) {
    const sheave = new THREE.BoxGeometry(1.5, 0.32, 0.5);
    sheave.translate(s * 1.7, 10.85, 0);
    parts.push(paint(sheave, 0x2a2f3a));
  }
  const g = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return g;
}

function makeSign(grade) {
  const parts = [];
  const post = new THREE.CylinderGeometry(0.045, 0.05, 2.2, 6);
  post.translate(0, 1.1, 0);
  parts.push(paint(post, 0x39404d));
  const board = new THREE.BoxGeometry(0.62, 0.62, 0.05);
  board.rotateZ(grade === 'black' || grade === 'double' ? Math.PI / 4 : 0);
  board.translate(0, 2.05, 0);
  const col = grade === 'green' ? 0x2f9e57 : grade === 'blue' ? 0x2b6ef2 : grade === 'double' ? 0x14161c : 0x14161c;
  parts.push(paint(board, col, { top: 0xffffff, topAmt: 0.25, upPow: 3 }));
  const g = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return g;
}

function makeWand() {
  const parts = [];
  const pole = new THREE.CylinderGeometry(0.02, 0.025, 1.5, 5);
  pole.translate(0, 0.75, 0);
  parts.push(paint(pole, 0xd8c48a));
  const flag = new THREE.PlaneGeometry(0.28, 0.2);
  flag.translate(0.14, 1.35, 0);
  parts.push(paint(flag, 0xff4d2e));
  const g = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return g;
}

function makeRail(box) {
  const parts = [];
  if (box) {
    const top = new THREE.BoxGeometry(1.0, 0.16, 1.0);
    parts.push(paint(top, 0x1d2330, { top: 0xa9b6cc, topAmt: 0.5, upPow: 3 }));
  } else {
    const tube = new THREE.CylinderGeometry(0.055, 0.055, 1.0, 10);
    tube.rotateX(Math.PI / 2);
    parts.push(paint(tube, 0xb9c2d2));
  }
  for (const s of [-0.38, 0.38]) {
    const leg = new THREE.CylinderGeometry(0.035, 0.04, 1.0, 6);
    leg.translate(0, -0.5, s);
    parts.push(paint(leg, 0x2b313c));
  }
  const g = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return g;
}

// ── Scenery manager ───────────────────────────────────────────────
// Needle colours look far too pale written down and are still barely green on
// screen. A conifer's measured albedo is under 10%, and at the exposure a snow
// scene needs (0.24–0.40) anything authored at that value renders as a black
// cut-out. These are lifted well above the physical figure so the trees read as
// dark GREEN against the snow rather than as holes in it.
const TREE_PALETTES = {
  coastal:  { bark: 0x53412f, needle: 0x39674c, needleTip: 0x5d9068, snow: 0xf3f8ff },
  yotei:    { bark: 0x5e4a38, needle: 0x3f6e52, needleTip: 0x63996f, snow: 0xfbfdff },
  alps:     { bark: 0x4c3c2c, needle: 0x345f47, needleTip: 0x568861, snow: 0xeef5ff },
  sierra:   { bark: 0x5f4433, needle: 0x426b4c, needleTip: 0x6a9a6a, snow: 0xf2f8ff },
  rockies:  { bark: 0x523e30, needle: 0x3a6650, needleTip: 0x5e9169, snow: 0xf1f7ff },
  monashee: { bark: 0x47372a, needle: 0x315c43, needleTip: 0x52855d, snow: 0xf4faff },
  tetons:   { bark: 0x503e2f, needle: 0x3b6750, needleTip: 0x5f9269, snow: 0xf1f7ff },
  matterhorn:{ bark: 0x4c3c2c, needle: 0x345f47, needleTip: 0x568861, snow: 0xeef5ff },
  montblanc:{ bark: 0x4c3c2c, needle: 0x366249, needleTip: 0x578a63, snow: 0xeff6ff },
};

export class Scenery {
  constructor(course, run, quality) {
    this.course = course;
    this.run = run;
    this.q = quality;
    this.group = new THREE.Group();
    this._lastCi = null;

    const palette = TREE_PALETTES[run.peaks] || TREE_PALETTES.alps;
    const mat = () => new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.85, metalness: 0.0, envMapIntensity: 0.75,
    });
    // Ice wants a different response — smoother, and it picks up the sky.
    const iceMat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.28, metalness: 0.05, envMapIntensity: 1.5,
    });
    const flatMat = new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: 0.7, metalness: 0.1, side: THREE.DoubleSide,
    });

    const budget = quality.treeBudget;
    this.pools = {};
    const add = (key, geo, material, count, shadow = true) => {
      const im = new THREE.InstancedMesh(geo, material, count);
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.castShadow = shadow && !!quality.shadows;
      im.receiveShadow = !!quality.shadows;
      im.count = 0;
      im.frustumCulled = false;   // instances span the whole view; the manager culls
      this.group.add(im);
      this.pools[key] = im;
    };

    add('conifer0', makeConifer(0, palette), mat(), Math.round(budget * 0.45));
    add('conifer1', makeConifer(1, palette), mat(), Math.round(budget * 0.35));
    add('conifer2', makeConifer(2, palette), mat(), Math.round(budget * 0.25));
    add('rock0', makeRock(0), mat(), 180);
    add('rock1', makeRock(1), mat(), 140);
    add('rock2', makeRock(2), mat(), 90);
    add('serac0', makeSerac(0), iceMat, 60);
    add('serac1', makeSerac(1), iceMat, 60);
    add('serac2', makeSerac(2), iceMat, 40);
    add('gate0', makeGate(0), flatMat, 40, false);
    add('gate1', makeGate(1), flatMat, 40, false);
    add('net0', makeNet(0), mat(), 120, false);
    add('net1', makeNet(1), mat(), 120, false);
    add('tower', makeTower(), mat(), 12);
    add('sign', makeSign(run.grade), flatMat, 12, false);
    add('wand', makeWand(), flatMat, 40, false);
    add('rail', makeRail(false), mat(), 12);
    add('box', makeRail(true), mat(), 12);

    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._p = new THREE.Vector3();
    this._s = new THREE.Vector3();

    this._buildFixtures();
  }

  /** Start gate and finish arch — one-offs, not instanced. */
  _buildFixtures() {
    const course = this.course, run = this.run;
    const mkBanner = (text, sub, color) => {
      const cv = document.createElement('canvas');
      cv.width = 1024; cv.height = 256;
      const g = cv.getContext('2d');
      const grd = g.createLinearGradient(0, 0, 0, 256);
      grd.addColorStop(0, color); grd.addColorStop(1, '#0d1017');
      g.fillStyle = grd; g.fillRect(0, 0, 1024, 256);
      g.fillStyle = 'rgba(255,255,255,0.10)'; g.fillRect(0, 200, 1024, 56);
      g.textAlign = 'center'; g.fillStyle = '#ffffff';
      g.font = '700 92px system-ui, -apple-system, Segoe UI, sans-serif';
      g.fillText(text, 512, 116);
      g.font = '500 42px system-ui, -apple-system, Segoe UI, sans-serif';
      g.globalAlpha = 0.8;
      g.fillText(sub, 512, 182);
      const t = new THREE.CanvasTexture(cv);
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 8;
      return t;
    };

    const arch = (d, tex, width) => {
      const grp = new THREE.Group();
      const c = course.centreAt(d);
      const y = course.height(c, -d);
      const postGeo = new THREE.CylinderGeometry(0.16, 0.2, 5.4, 8);
      const postMat = new THREE.MeshStandardMaterial({ color: 0x1b2029, roughness: 0.6, metalness: 0.3 });
      for (const s of [-1, 1]) {
        const p = new THREE.Mesh(postGeo, postMat);
        p.position.set(s * width * 0.5, 2.7, 0);
        p.castShadow = !!this.q.shadows;
        grp.add(p);
      }
      const banner = new THREE.Mesh(
        new THREE.BoxGeometry(width, 1.5, 0.14),
        [
          new THREE.MeshStandardMaterial({ color: 0x1b2029, roughness: 0.7 }),
          new THREE.MeshStandardMaterial({ color: 0x1b2029, roughness: 0.7 }),
          new THREE.MeshStandardMaterial({ color: 0x1b2029, roughness: 0.7 }),
          new THREE.MeshStandardMaterial({ color: 0x1b2029, roughness: 0.7 }),
          new THREE.MeshStandardMaterial({ map: tex, roughness: 0.55 }),
          new THREE.MeshStandardMaterial({ map: tex, roughness: 0.55 }),
        ],
      );
      banner.position.set(0, 5.0, 0);
      banner.castShadow = !!this.q.shadows;
      grp.add(banner);
      grp.position.set(c, y, -d);
      return grp;
    };

    // Sited 11 m above the start line so it frames the rider from behind
    // instead of filling the screen with banner.
    this.startArch = arch(-11, mkBanner(run.run.toUpperCase(), run.mountain, '#2b6ef2'), Math.min(26, course.widthAt(-11) * 1.4));
    this.finishArch = arch(course.length, mkBanner('FINISH', run.mountain, '#e0242c'), Math.min(26, course.widthAt(course.length) * 1.4));
    this.group.add(this.startArch, this.finishArch);

    // Lift cable, strung through the tower line. A single fat line is enough —
    // at speed it reads as infrastructure and costs one draw call.
    const towers = this.course.props.filter(p => p.type === 'tower');
    if (towers.length > 1) {
      const pts = [];
      for (const t of towers) pts.push(new THREE.Vector3(t.x, t.y + 10.9, t.z));
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      const line = new THREE.Line(geo, new THREE.LineBasicMaterial({ color: 0x20242c, transparent: true, opacity: 0.85 }));
      line.frustumCulled = false;
      this.group.add(line);
      this.cable = line;
    }
  }

  update(riderD, force = false) {
    const ci = Math.floor(riderD / CHUNK_LEN);
    if (!force && ci === this._lastCi) return;
    this._lastCi = ci;

    const lo = ci - 2, hi = ci + this.q.chunkAhead + 1;
    const counts = {};
    for (const k in this.pools) counts[k] = 0;

    for (let c = lo; c <= hi; c++) {
      for (const p of this.course.propsInChunk(c)) {
        let key = p.type;
        if (p.type === 'conifer') key = 'conifer' + (p.v % 3);
        else if (p.type === 'rock') key = 'rock' + (p.v % 3);
        else if (p.type === 'serac') key = 'serac' + (p.v % 3);
        else if (p.type === 'gate') key = 'gate' + (p.v % 2);
        else if (p.type === 'net') key = 'net' + (p.v % 2);
        const im = this.pools[key];
        if (!im || counts[key] >= im.instanceMatrix.count) continue;

        const y = p.y;                       // baked at course build
        this._p.set(p.x, y, p.z);
        let sx = p.s, sy = p.s, sz = p.s;
        let rot = p.rot;

        if (p.type === 'rail' || p.type === 'box') {
          // Rails are authored in metres, so scale the unit geometry to length.
          sz = p.len; sx = p.w * 2; sy = 1;
          this._p.y = y - p.h * 0.0;
        } else if (p.type === 'net') {
          rot = 0;
          this._p.y = y;
        } else if (p.type === 'conifer') {
          // Sink the trunk slightly so it reads as buried in snowpack.
          this._p.y = y - 0.25 * p.s;
        }

        this._e.set(p.lean || 0, rot, 0);
        this._q.setFromEuler(this._e);
        this._s.set(sx, sy, sz);
        this._m.compose(this._p, this._q, this._s);
        im.setMatrixAt(counts[key]++, this._m);
      }
    }

    for (const k in this.pools) {
      const im = this.pools[k];
      im.count = counts[k];
      im.instanceMatrix.needsUpdate = true;
    }
  }

  dispose() {
    for (const k in this.pools) {
      const im = this.pools[k];
      im.geometry.dispose();
      if (Array.isArray(im.material)) im.material.forEach(m => m.dispose()); else im.material.dispose();
    }
    this.group.traverse(o => {
      if (o.isMesh && !o.isInstancedMesh) {
        o.geometry.dispose();
        if (Array.isArray(o.material)) o.material.forEach(m => { m.map?.dispose(); m.dispose(); });
        else { o.material.map?.dispose(); o.material.dispose(); }
      }
    });
  }
}
