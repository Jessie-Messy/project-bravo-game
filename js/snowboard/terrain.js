// terrain.js — the snow material and the chunk streamer.
//
// SNOW IS HARD TO RENDER and a plain white MeshStandardMaterial always reads as
// plaster. Four things fix it, and this material does all four:
//
//   • Sparkle. Real snow is a field of ice facets, each a tiny mirror. Only the
//     handful whose normal bisects eye and sun light up, so the glitter field
//     moves as you move. That is faked here with a high-frequency world-space
//     hash gated on the half-vector, which is cheap and behaves correctly under
//     motion — a static noise texture does not.
//   • Subsurface blue. Light entering snow scatters centimetres before it comes
//     back out, and it comes back BLUE. Concavities get the blue; convexities
//     stay white. The per-vertex curvature term drives it.
//   • Corduroy. A groomed piste is a corrugated surface. Perturbing the normal
//     with a ~35 cm ripple, masked to the groomed part of the corridor, is the
//     single strongest "this is a ski area" cue available.
//   • Rock break-through. Above ~40° snow sloughs off. Blending to rock by
//     slope is what stops the out-of-bounds shoulders looking like icing.

import * as THREE from 'three';
import { CHUNK_LEN } from './course.js';

export function createSnowMaterial(run, snowType, opts = {}) {
  // Snow's real albedo is ~0.85, not 1.0, and the difference matters: at 1.0
  // every lit surface clips to white and the shading disappears. Sitting the
  // base a little under measured albedo leaves headroom for the specular and
  // the sparkle to be visible on top of it.
  const tint = new THREE.Color(snowType.tint).multiplyScalar(0.84);
  const mat = new THREE.MeshStandardMaterial({
    color: tint,
    roughness: 0.72,
    metalness: 0.0,
    envMapIntensity: 0.9,
    dithering: true,
  });

  const uniforms = {
    uTime:      { value: 0 },
    uSunDir:    { value: new THREE.Vector3(0.4, 0.8, 0.3) },
    uSparkle:   { value: opts.sparkle === false ? 0 : 1 },
    uGroomDetail: { value: opts.groomDetail === false ? 0 : 1 },
    uRockCol:   { value: new THREE.Color(run.time === 'dusk' ? 0x3b3340 : 0x4d5163) },
    uDeepCol:   { value: new THREE.Color(0x9dbde8) },
    uIceCol:    { value: new THREE.Color(0xbcd8f2) },
    uPowder:    { value: run.snow === 'powder' ? 1 : run.snow === 'crud' ? 0.5 : 0 },
    uSparkleCol:{ value: new THREE.Color(0xffffff) },
  };
  mat.userData.uniforms = uniforms;

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', /* glsl */`
        #include <common>
        attribute float aGroom;
        attribute float aCurv;
        varying vec3 vWPos;
        varying vec3 vWNrm;
        varying float vGroom;
        varying float vCurv;
      `)
      .replace('#include <begin_vertex>', /* glsl */`
        #include <begin_vertex>
        vWPos  = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vWNrm  = normalize(mat3(modelMatrix) * objectNormal);
        vGroom = aGroom;
        vCurv  = aCurv;
      `);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', /* glsl */`
        #include <common>
        uniform float uTime;
        uniform vec3  uSunDir;
        uniform float uSparkle;
        uniform float uGroomDetail;
        uniform vec3  uRockCol;
        uniform vec3  uDeepCol;
        uniform vec3  uIceCol;
        uniform vec3  uSparkleCol;
        uniform float uPowder;
        varying vec3 vWPos;
        varying vec3 vWNrm;
        varying float vGroom;
        varying float vCurv;

        float hash31(vec3 p) {
          p = fract(p * 0.1031);
          p += dot(p, p.zyx + 31.32);
          return fract((p.x + p.y) * p.z);
        }
        float vnoise3(vec3 p) {
          vec3 i = floor(p), f = fract(p);
          f = f * f * (3.0 - 2.0 * f);
          float n = mix(
            mix(mix(hash31(i), hash31(i + vec3(1,0,0)), f.x),
                mix(hash31(i + vec3(0,1,0)), hash31(i + vec3(1,1,0)), f.x), f.y),
            mix(mix(hash31(i + vec3(0,0,1)), hash31(i + vec3(1,0,1)), f.x),
                mix(hash31(i + vec3(0,1,1)), hash31(i + vec3(1,1,1)), f.x), f.y), f.z);
          return n;
        }
      `)
      // Albedo: rock on steeps, blue in the hollows, wind texture everywhere.
      .replace('#include <map_fragment>', /* glsl */`
        #include <map_fragment>
        float slope = clamp(vWNrm.y, 0.0, 1.0);

        // Fine snow grain so a flat groomer is never a flat colour.
        float grain = vnoise3(vWPos * 3.1) * 0.5 + vnoise3(vWPos * 11.0) * 0.28;
        diffuseColor.rgb *= 0.93 + grain * 0.14;

        // Subsurface blue in the concavities, extra white on the convex crests.
        float hollow = clamp(-vCurv * 2.2, 0.0, 1.0);
        float crest  = clamp( vCurv * 2.0, 0.0, 1.0);
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * uDeepCol, hollow * (0.30 + 0.22 * uPowder));
        diffuseColor.rgb += crest * 0.05;

        // Wind scallops: stretched along the fall line, so they read as drift.
        float drift = vnoise3(vec3(vWPos.x * 0.55, vWPos.y * 0.2, vWPos.z * 0.18));
        diffuseColor.rgb *= 1.0 + (drift - 0.5) * 0.10 * (0.4 + uPowder);

        // Rock break-through on genuinely steep faces only — past about 50°,
        // where snow sloughs off. Catching gentler ground than that turns every
        // out-of-bounds shoulder grey.
        float rockMask = smoothstep(0.66, 0.40, slope + (vnoise3(vWPos * 0.8) - 0.5) * 0.16);
        diffuseColor.rgb = mix(diffuseColor.rgb, uRockCol * (0.75 + grain * 0.6), rockMask * 0.92);

        // The same corduroy as a faint tonal stripe. Normal-map detail vanishes
        // under mip filtering a hundred metres out; a brightness difference
        // survives, which keeps the piste reading as groomed all the way to the
        // fog line.
        float cord = sin(vWPos.x * 18.0) * 0.5 + 0.5;
        diffuseColor.rgb *= 1.0 + (cord - 0.5) * 0.055 * vGroom * uGroomDetail;

        // Scraped ice on the fall line of a hardpack piste.
        float scrape = smoothstep(0.55, 0.95, vnoise3(vec3(vWPos.x * 0.9, 0.0, vWPos.z * 0.12)));
        diffuseColor.rgb = mix(diffuseColor.rgb, uIceCol, scrape * vGroom * (1.0 - uPowder) * 0.18);
      `)
      // Corduroy ripple + slope-varying roughness.
      .replace('#include <roughnessmap_fragment>', /* glsl */`
        #include <roughnessmap_fragment>
        float slopeR = clamp(vWNrm.y, 0.0, 1.0);
        roughnessFactor = mix(0.94, 0.74, slopeR);          // steep rock is matte
        roughnessFactor -= vGroom * 0.10;                    // corduroy is slick
        roughnessFactor -= smoothstep(0.55, 0.95,
          vnoise3(vec3(vWPos.x * 0.9, 0.0, vWPos.z * 0.12))) * vGroom * 0.14;
        roughnessFactor = clamp(roughnessFactor - uPowder * 0.06, 0.18, 1.0);
      `)
      .replace('#include <normal_fragment_maps>', /* glsl */`
        #include <normal_fragment_maps>
        // three's normal variable is in VIEW space here, but everything we
        // perturb it with comes from world position, so each offset has to be
        // rotated into view space first. Adding a world-space vector onto a
        // view-space normal tilts it in whatever direction the camera happens
        // to be facing, which is why the corduroy was invisible.
        if (uGroomDetail > 0.5 && vGroom > 0.01) {
          // ~35 cm corduroy running down the fall line, plus a finer second
          // harmonic so it does not read as a single clean sine.
          float rip = sin(vWPos.x * 18.0) * 0.5 + sin(vWPos.x * 41.0 + vWPos.z * 0.4) * 0.22;
          vec3 t = normalize(vec3(1.0, 0.0, 0.0) - vWNrm * vWNrm.x);
          vec3 tv = normalize((viewMatrix * vec4(t, 0.0)).xyz);
          normal = normalize(normal + tv * rip * 0.17 * vGroom);
        }
        // Micro-relief everywhere, so grazing light picks up texture.
        vec3 nOff = vec3(
          vnoise3(vWPos * 6.3 + 11.0) - 0.5,
          0.0,
          vnoise3(vWPos * 6.3 + 71.0) - 0.5);
        normal = normalize(normal + (viewMatrix * vec4(nOff, 0.0)).xyz * 0.12);
      `)
      // Sparkle. Gated on the half-vector so facets flare and die as you move.
      .replace('#include <emissivemap_fragment>', /* glsl */`
        #include <emissivemap_fragment>
        if (uSparkle > 0.5) {
          vec3 V = normalize(cameraPosition - vWPos);
          vec3 H = normalize(V + uSunDir);
          float align = max(dot(vWNrm, H), 0.0);
          // Three octaves of facet field at different scales = a believable
          // spread of glint sizes instead of a uniform stipple.
          float f = 0.0;
          f += step(0.9955, hash31(floor(vWPos * 46.0)));
          f += step(0.9975, hash31(floor(vWPos * 118.0) + 3.0)) * 1.6;
          f += step(0.9990, hash31(floor(vWPos * 260.0) + 9.0)) * 2.4;
          float g = pow(align, 220.0) * f;
          float dist = length(cameraPosition - vWPos);
          g *= smoothstep(90.0, 12.0, dist);              // fade before it aliases
          g *= (1.0 - smoothstep(0.80, 0.55, vWNrm.y));   // no sparkle on rock
          totalEmissiveRadiance += uSparkleCol * g * 1.7;
        }
      `);

    mat.userData.shader = shader;
  };
  mat.customProgramCacheKey = () => 'snow-' + (opts.sparkle === false ? '0' : '1') + (opts.groomDetail === false ? '0' : '1');
  return mat;
}

// ── Chunk streaming ───────────────────────────────────────────────
// Lateral sample positions are a pure function of d, NOT of the chunk. That is
// what makes the seams watertight: chunk A's last row and chunk B's first row
// are computed from the same d with the same column count, so they land on
// byte-identical vertices and no crack can appear between them.
export class TerrainField {
  constructor(course, run, quality, snowType) {
    this.course = course;
    this.run = run;
    this.group = new THREE.Group();
    this.material = createSnowMaterial(run, snowType, {
      sparkle: quality.sparkle, groomDetail: quality.groomDetail,
    });
    this.chunks = new Map();
    this.setQuality(quality);
  }

  setQuality(q) {
    this.q = q;
    this.cols = Math.max(40, Math.round(96 * q.terrainRes));
    this.rowStep = 1.6 / Math.max(0.5, q.terrainRes);
    this.ahead = q.chunkAhead;
    this.behind = 2;
    if (this.material.userData.uniforms) {
      this.material.userData.uniforms.uSparkle.value = q.sparkle ? 1 : 0;
      this.material.userData.uniforms.uGroomDetail.value = q.groomDetail ? 1 : 0;
    }
    // Existing chunks keep their old resolution rather than being rebuilt on
    // the spot — a tier demote mid-run must not cause the hitch it is trying
    // to avoid. They age out naturally as the rider descends.
  }

  /** Lateral half-extent of the built mesh at distance d. */
  _extentAt(d) {
    return this.course.widthAt(d) * 1.35 + 42;
  }

  /** Column j of `cols`, warped so resolution concentrates on the piste. */
  _colU(j, extent) {
    const s = (j / this.cols) * 2 - 1;
    const a = Math.abs(s);
    return Math.sign(s) * Math.pow(a, 1.7) * extent;
  }

  _build(ci) {
    const course = this.course;
    const d0 = ci * CHUNK_LEN, d1 = d0 + CHUNK_LEN;
    const rows = Math.max(6, Math.round(CHUNK_LEN / this.rowStep));
    const cols = this.cols;
    const vcount = (rows + 1) * (cols + 1);

    const pos = new Float32Array(vcount * 3);
    const groom = new Float32Array(vcount);
    const curv = new Float32Array(vcount);
    const idx = new (vcount > 65535 ? Uint32Array : Uint16Array)(rows * cols * 6);

    const stride0 = cols + 1;
    let vi = 0;
    for (let r = 0; r <= rows; r++) {
      const d = d0 + (d1 - d0) * (r / rows);
      const z = -d;
      const c = course.centreAt(d);
      const extent = this._extentAt(d);
      for (let j = 0; j <= cols; j++) {
        const u = this._colU(j, extent);
        const x = c + u;
        pos[vi * 3] = x; pos[vi * 3 + 1] = course.height(x, z); pos[vi * 3 + 2] = z;
        groom[vi] = course.isGroomed(d, u);
        vi++;
      }
    }

    // Discrete curvature — height against the mean of the four grid
    // neighbours. Negative in hollows, positive on crests; the snow shader
    // turns it into subsurface blue and crest highlights.
    //
    // Read off the grid we just built rather than by sampling height() four
    // more times per vertex. That is the difference between ~12k and ~2.5k
    // height evaluations per chunk, which is the difference between a visible
    // hitch every 40 m and none. The lateral spacing is non-uniform, so this
    // over-reads curvature toward the edges — where the terrain is
    // out-of-bounds shoulder nobody looks at closely.
    for (let r = 0; r <= rows; r++) {
      for (let j = 0; j <= cols; j++) {
        const i = r * stride0 + j;
        const y = pos[i * 3 + 1];
        const l = pos[(j > 0 ? i - 1 : i) * 3 + 1];
        const rr = pos[(j < cols ? i + 1 : i) * 3 + 1];
        const u = pos[(r > 0 ? i - stride0 : i) * 3 + 1];
        const dn = pos[(r < rows ? i + stride0 : i) * 3 + 1];
        curv[i] = Math.max(-1, Math.min(1, (y - 0.25 * (l + rr + u + dn)) * 2.6));
      }
    }

    let ii = 0;
    const stride = cols + 1;
    for (let r = 0; r < rows; r++) {
      for (let j = 0; j < cols; j++) {
        const a = r * stride + j, b = a + 1, cc = a + stride, dd = cc + 1;
        idx[ii++] = a; idx[ii++] = cc; idx[ii++] = b;
        idx[ii++] = b; idx[ii++] = cc; idx[ii++] = dd;
      }
    }

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aGroom', new THREE.BufferAttribute(groom, 1));
    g.setAttribute('aCurv', new THREE.BufferAttribute(curv, 1));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeVertexNormals();
    g.computeBoundingSphere();

    const mesh = new THREE.Mesh(g, this.material);
    mesh.receiveShadow = !!this.q.shadows;
    mesh.castShadow = false;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.frustumCulled = true;
    return mesh;
  }

  /**
   * Ensure the window of chunks around the rider exists. Returns the number of
   * chunks built this call so main.js can spread the initial build over frames.
   */
  update(riderD, budget = 1) {
    const ci = Math.floor(riderD / CHUNK_LEN);
    const lo = ci - this.behind, hi = ci + this.ahead;
    let built = 0;
    for (let i = lo; i <= hi && built < budget; i++) {
      if (this.chunks.has(i)) continue;
      const maxCi = Math.floor(this.course.total / CHUNK_LEN) + 1;
      if (i < Math.floor(-this.course.leadIn / CHUNK_LEN) || i > maxCi) continue;
      const m = this._build(i);
      this.chunks.set(i, m);
      this.group.add(m);
      built++;
    }
    for (const [i, m] of this.chunks) {
      if (i < lo - 1 || i > hi + 1) {
        this.group.remove(m);
        m.geometry.dispose();
        this.chunks.delete(i);
      }
    }
    return built;
  }

  /** Build every chunk in the window right now (used on the loading screen). */
  prime(riderD) {
    while (this.update(riderD, 4) > 0) { /* keep going until the window is full */ }
  }

  setUniform(name, value) {
    const u = this.material.userData.uniforms;
    if (u && u[name]) {
      if (u[name].value && u[name].value.copy && value && value.isVector3) u[name].value.copy(value);
      else u[name].value = value;
    }
  }

  dispose() {
    for (const [, m] of this.chunks) m.geometry.dispose();
    this.chunks.clear();
    this.material.dispose();
  }
}
