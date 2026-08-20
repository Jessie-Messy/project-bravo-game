// fx.js — particles.
//
// Two systems, both CPU-simulated into a single Points buffer each. At these
// counts (a few hundred to a couple of thousand) a JS loop is cheaper than the
// bookkeeping a GPU transform-feedback path would need, and it means spray can
// react to slip, snow type and board float without a uniform for each.
//
// The sprites are drawn procedurally in the fragment shader — a soft radial
// falloff, no texture, no alpha-test shimmer, and correct in both blend modes.
// Powder spray in particular is NOT additive: real spray is a cloud that
// occludes, and additive white against a white slope disappears completely.

import * as THREE from 'three';

// aSize is a real diameter IN METRES, and uScale carries the only thing needed
// to turn that into pixels: viewportHeightPx / (2 * tan(fov/2)). The previous
// version used a magic 300.0 with sizes in arbitrary units, which put a single
// close spray particle at over a thousand pixels across — on screen it read as
// a white sheet hanging off the board, not as snow. Sizing in metres also means
// the field stays correct when the FOV widens with speed.
const PARTICLE_VS = /* glsl */`
  attribute float aSize;
  attribute float aLife;
  attribute vec3  aTint;
  varying float vLife;
  varying vec3  vTint;
  uniform float uPixelRatio;
  uniform float uScale;
  uniform float uMaxPx;
  void main() {
    vLife = aLife;
    vTint = aTint;
    vec4 mv = modelViewMatrix * vec4(position, 1.0);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = min(aSize * uScale / max(0.35, -mv.z), uMaxPx) * uPixelRatio;
  }
`;

const PARTICLE_FS = /* glsl */`
  varying float vLife;
  varying vec3  vTint;
  uniform vec3  uColor;
  uniform float uOpacity;
  void main() {
    vec2 p = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(p, p);
    if (r2 > 1.0) discard;
    // Soft core with a fading skirt — reads as a snow puff rather than a dot.
    float a = pow(1.0 - r2, 1.6) * vLife * uOpacity;
    gl_FragColor = vec4(uColor * vTint, a);
    #include <colorspace_fragment>
  }
`;

function makePoints(count, color, opacity, blending, sizeAttenuation = true) {
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  geo.setAttribute('aSize', new THREE.BufferAttribute(new Float32Array(count), 1));
  geo.setAttribute('aLife', new THREE.BufferAttribute(new Float32Array(count), 1));
  geo.setAttribute('aTint', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
  geo.setDrawRange(0, 0);
  const mat = new THREE.ShaderMaterial({
    vertexShader: PARTICLE_VS,
    fragmentShader: PARTICLE_FS,
    uniforms: {
      uColor: { value: new THREE.Color(color) },
      uOpacity: { value: opacity },
      uPixelRatio: { value: 1 },
      uScale: { value: 600 },     // recomputed from the live camera each frame
      uMaxPx: { value: 140 },     // fill-rate guard: one particle must never
                                  // become a full-screen quad
    },
    transparent: true,
    depthWrite: false,
    blending,
  });
  const pts = new THREE.Points(geo, mat);
  pts.frustumCulled = false;
  return pts;
}

// ── Board spray ───────────────────────────────────────────────────
export class Spray {
  constructor(max, snowType) {
    this.max = max;
    this.points = makePoints(max, snowType.tint, 0.85, THREE.NormalBlending);
    this.pos = this.points.geometry.attributes.position;
    this.size = this.points.geometry.attributes.aSize;
    this.life = this.points.geometry.attributes.aLife;
    this.tint = this.points.geometry.attributes.aTint;
    this.vel = new Float32Array(max * 3);
    this.age = new Float32Array(max);
    this.ttl = new Float32Array(max);
    this.count = 0;
    this.head = 0;
  }

  /**
   * @param p      world emit point (under the board)
   * @param dir    unit travel direction
   * @param amount 0..N particles this frame
   * @param power  0..1 — slip and speed, drives spread and size
   * @param up     surface normal
   */
  emit(p, dir, amount, power, up, tintScale = 1) {
    for (let k = 0; k < amount; k++) {
      const i = this.head;
      this.head = (this.head + 1) % this.max;
      if (this.count < this.max) this.count++;

      const spread = 0.55 + power * 1.9;
      // Thrown backwards along travel and up along the normal, plus scatter.
      const rx = (Math.random() - 0.5) * spread;
      const ry = Math.random() * (0.8 + power * 2.6);
      const rz = (Math.random() - 0.5) * spread;
      const back = 1.4 + power * 7.0;

      this.pos.array[i * 3] = p.x + (Math.random() - 0.5) * 0.5;
      this.pos.array[i * 3 + 1] = p.y + 0.05 + Math.random() * 0.12;
      this.pos.array[i * 3 + 2] = p.z + (Math.random() - 0.5) * 0.5;

      this.vel[i * 3] = -dir.x * back + rx + up.x * ry * 2;
      this.vel[i * 3 + 1] = ry * 2.2 + up.y * ry;
      this.vel[i * 3 + 2] = -dir.z * back + rz + up.z * ry * 2;

      // Metres across. A thrown clump of snow is a hand-sized thing that
      // expands as it drifts, not a beach ball.
      this.size.array[i] = (0.10 + Math.random() * 0.22) * (0.7 + power * 1.1);
      this.ttl[i] = 0.5 + Math.random() * (0.6 + power * 0.9);
      this.age[i] = 0;
      this.life.array[i] = 1;
      // A touch of blue in the bigger, slower particles reads as depth in the
      // cloud instead of a flat white smear.
      const b = 0.92 + Math.random() * 0.08;
      this.tint.array[i * 3] = b * tintScale;
      this.tint.array[i * 3 + 1] = b * tintScale;
      this.tint.array[i * 3 + 2] = Math.min(1, (b + 0.06) * tintScale);
    }
  }

  update(dt, wind = 0) {
    const n = this.count;
    for (let i = 0; i < n; i++) {
      if (this.life.array[i] <= 0) continue;
      this.age[i] += dt;
      const t = this.age[i] / this.ttl[i];
      if (t >= 1) { this.life.array[i] = 0; continue; }
      // Snow dust hangs: heavy damping and only a fraction of gravity.
      const damp = Math.exp(-2.1 * dt);
      this.vel[i * 3] = this.vel[i * 3] * damp + wind * dt * 1.5;
      this.vel[i * 3 + 1] = this.vel[i * 3 + 1] * damp - 3.4 * dt;
      this.vel[i * 3 + 2] *= damp;
      this.pos.array[i * 3] += this.vel[i * 3] * dt;
      this.pos.array[i * 3 + 1] += this.vel[i * 3 + 1] * dt;
      this.pos.array[i * 3 + 2] += this.vel[i * 3 + 2] * dt;
      // Fade in fast, out slow.
      this.life.array[i] = Math.min(1, t * 6) * (1 - t) * (1 - t);
      this.size.array[i] *= 1 + dt * 0.75;     // the cloud expands as it drifts
    }
    this.points.geometry.setDrawRange(0, this.count);
    this.pos.needsUpdate = true;
    this.life.needsUpdate = true;
    this.size.needsUpdate = true;
    this.tint.needsUpdate = true;
  }

  setPixelRatio(r) { this.points.material.uniforms.uPixelRatio.value = r; }
  setProjection(heightPx, fovDeg) {
    this.points.material.uniforms.uScale.value =
      heightPx / (2 * Math.tan(fovDeg * Math.PI / 360));
  }
  dispose() { this.points.geometry.dispose(); this.points.material.dispose(); }
}

// ── Ambient snowfall ──────────────────────────────────────────────
// A box of flakes that follows the camera and wraps at the edges, so a fixed
// budget covers an infinite run. Wrapping in camera space (not world space)
// means the field never thins out no matter how far down the hill you get.
export class Snowfall {
  constructor(count, weather) {
    this.count = count;
    this.box = { x: 90, y: 46, z: 90 };
    this.points = makePoints(count, 0xffffff, 0.9, THREE.NormalBlending);
    this.pos = this.points.geometry.attributes.position;
    this.size = this.points.geometry.attributes.aSize;
    this.life = this.points.geometry.attributes.aLife;
    this.tint = this.points.geometry.attributes.aTint;
    this.vel = new Float32Array(count * 3);
    this.wind = weather.wind;

    for (let i = 0; i < count; i++) {
      this.pos.array[i * 3] = (Math.random() - 0.5) * this.box.x * 2;
      this.pos.array[i * 3 + 1] = (Math.random() - 0.5) * this.box.y * 2;
      this.pos.array[i * 3 + 2] = (Math.random() - 0.5) * this.box.z * 2;
      // A spread of flake sizes is what gives the field depth; all-equal sizes
      // read as a bug.
      const big = Math.random() < 0.22;
      // Near flakes are metres from the lens, so even a real 5 mm flake needs
      // to be a few centimetres here to register at all; the 'big' ones are the
      // out-of-focus foreground flakes every snow photograph has.
      this.size.array[i] = big ? 0.10 + Math.random() * 0.16 : 0.025 + Math.random() * 0.05;
      this.life.array[i] = big ? 0.85 : 0.55 + Math.random() * 0.3;
      this.vel[i * 3] = (Math.random() - 0.5) * 0.8;
      this.vel[i * 3 + 1] = -(0.9 + Math.random() * 2.4) * (big ? 1.35 : 1);
      this.vel[i * 3 + 2] = (Math.random() - 0.5) * 0.8;
      const b = 0.93 + Math.random() * 0.07;
      this.tint.array[i * 3] = b; this.tint.array[i * 3 + 1] = b; this.tint.array[i * 3 + 2] = 1;
    }
    this.points.geometry.setDrawRange(0, count);
    this.pos.needsUpdate = true; this.size.needsUpdate = true;
    this.life.needsUpdate = true; this.tint.needsUpdate = true;
  }

  update(dt, camera, riderVel) {
    const b = this.box;
    const cx = camera.position.x, cy = camera.position.y, cz = camera.position.z;
    const w = this.wind;
    // Flakes inherit a slice of the rider's velocity in reverse, which is what
    // sells speed: at 90 km/h the snow streams past rather than drifting down.
    const rvx = -riderVel.x * 0.10, rvz = -riderVel.z * 0.10;
    for (let i = 0; i < this.count; i++) {
      const ix = i * 3;
      this.pos.array[ix] += (this.vel[ix] + w * 3.2 + rvx) * dt;
      this.pos.array[ix + 1] += this.vel[ix + 1] * dt;
      this.pos.array[ix + 2] += (this.vel[ix + 2] + rvz) * dt;

      // Wrap around the camera.
      let dx = this.pos.array[ix] - cx;
      let dy = this.pos.array[ix + 1] - cy;
      let dz = this.pos.array[ix + 2] - cz;
      if (dx > b.x) this.pos.array[ix] -= b.x * 2; else if (dx < -b.x) this.pos.array[ix] += b.x * 2;
      if (dy > b.y) this.pos.array[ix + 1] -= b.y * 2; else if (dy < -b.y) this.pos.array[ix + 1] += b.y * 2;
      if (dz > b.z) this.pos.array[ix + 2] -= b.z * 2; else if (dz < -b.z) this.pos.array[ix + 2] += b.z * 2;
    }
    this.pos.needsUpdate = true;
  }

  setPixelRatio(r) { this.points.material.uniforms.uPixelRatio.value = r; }
  setProjection(heightPx, fovDeg) {
    this.points.material.uniforms.uScale.value =
      heightPx / (2 * Math.tan(fovDeg * Math.PI / 360));
  }
  dispose() { this.points.geometry.dispose(); this.points.material.dispose(); }
}
