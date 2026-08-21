// sky.js — atmosphere, sun, and the horizon.
//
// Three pieces, in the order they matter to how the scene reads:
//
//  1. A Preetham sky dome (three's Sky addon) so dawn on the Vallée Blanche is
//     actually the colour dawn is, rather than a hand-picked gradient that only
//     works at one sun angle.
//  2. Lighting built for SNOW specifically. Snow has ~85% albedo, so the bounce
//     is nearly as bright as the key light and it is BLUE — sky light reflected
//     twice. Getting that hemisphere term wrong is the single reason most snow
//     renders look like grey concrete, so the hemi light here is deliberately
//     far stronger than it would be in any other scene.
//  3. A procedural ridge horizon. It is locked to the camera in XZ (the peaks
//     are notionally 20 km away, so horizontal parallax over a 2 km run is
//     invisible) but fixed in Y, which gives the one parallax cue that does
//     matter: the mountains rise around you as you descend.

import * as THREE from 'three';
import { Sky } from 'three/addons/objects/Sky.js';

// ── Presets ───────────────────────────────────────────────────────
// elevation/azimuth in degrees; `key` is the sun colour, `fill` the sky bounce.
// `exposure` is the number that decides whether snow reads as SNOW or as a
// blown-out sheet of paper. Snow's albedo is ~0.85, so a scene lit brightly
// enough to look sunny clips to pure white almost everywhere unless the
// exposure is pulled well down and the tone curve is allowed to do its job.
// These values put sunlit snow around 0.8 rather than 1.0, which is what leaves
// room for the highlights, the sparkle and the blue in the shadows to be seen
// at all. `fog` is the horizon colour the terrain dissolves into — authored per
// time of day rather than derived, because a wrong fog colour is the second way
// to turn a snow scene into milk.
export const TIME_PRESETS = {
  dawn:      { elevation: 3.2,  azimuth: 118, key: 0xffb27a, keyI: 2.4, fill: 0x6f8fd0, ground: 0xc9d6ee, exposure: 0.30, turbidity: 4.5, rayleigh: 2.6, mie: 0.009, mieG: 0.86, fog: 0xd8bfb2 },
  morning:   { elevation: 21,   azimuth: 135, key: 0xfff0d8, keyI: 3.1, fill: 0x8fb2e8, ground: 0xdfe8f8, exposure: 0.23, turbidity: 3.0, rayleigh: 1.6, mie: 0.006, mieG: 0.82, fog: 0xb4cdea },
  midday:    { elevation: 56,   azimuth: 172, key: 0xffffff, keyI: 3.4, fill: 0x9dc0f2, ground: 0xe8eefb, exposure: 0.20, turbidity: 2.2, rayleigh: 1.1, mie: 0.004, mieG: 0.80, fog: 0xbdd6f2 },
  afternoon: { elevation: 29,   azimuth: 232, key: 0xffe3bd, keyI: 2.9, fill: 0x8fb0e0, ground: 0xdde6f6, exposure: 0.24, turbidity: 3.6, rayleigh: 1.9, mie: 0.007, mieG: 0.83, fog: 0xc4cfe4 },
  dusk:      { elevation: 1.4,  azimuth: 258, key: 0xff9a5c, keyI: 2.0, fill: 0x5c74b8, ground: 0xb9c6e6, exposure: 0.33, turbidity: 6.0, rayleigh: 3.2, mie: 0.011, mieG: 0.88, fog: 0x8a90bc },
};

// Weather multiplies the time preset. `flat` lifts the fill and crushes the key
// to fake the flat light of a snowstorm, where shadows essentially vanish.
export const WEATHER_PRESETS = {
  clear:     { fogDensity: 0.0011, keyMul: 1.00, fillMul: 1.00, flat: 0.00, turbidityAdd: 0,  snowfall: 0.06, wind: 0.25, tint: 0xffffff },
  flurries:  { fogDensity: 0.0030, keyMul: 0.86, fillMul: 1.06, flat: 0.20, turbidityAdd: 2,  snowfall: 0.45, wind: 0.55, tint: 0xeef4ff },
  overcast:  { fogDensity: 0.0046, keyMul: 0.45, fillMul: 1.22, flat: 0.62, turbidityAdd: 5,  snowfall: 0.10, wind: 0.35, tint: 0xdfe7f4 },
  snow:      { fogDensity: 0.0062, keyMul: 0.52, fillMul: 1.18, flat: 0.55, turbidityAdd: 6,  snowfall: 0.85, wind: 0.70, tint: 0xe6eefb },
  storm:     { fogDensity: 0.0105, keyMul: 0.34, fillMul: 1.26, flat: 0.80, turbidityAdd: 9,  snowfall: 1.00, wind: 1.00, tint: 0xdbe5f4 },
};

// Named horizon silhouettes. `horn` entries carve a recognisable peak into the
// ridge at a fixed bearing — the Matterhorn's asymmetric hook, the Tetons'
// three-summit wall — so each mountain's backdrop is identifiably itself.
const SKYLINES = {
  matterhorn: { base: 0.42, rough: 1.0, horns: [{ at: 0.06, w: 0.055, h: 2.5, hook: 0.55 }] },
  montblanc:  { base: 0.58, rough: 0.8, horns: [{ at: 0.90, w: 0.16, h: 1.9, hook: 0.10 }, { at: 0.10, w: 0.05, h: 1.5, hook: 0.4 }] },
  tetons:     { base: 0.36, rough: 1.1, horns: [{ at: 0.12, w: 0.05, h: 2.2, hook: 0.35 }, { at: 0.18, w: 0.04, h: 1.7, hook: 0.25 }, { at: 0.06, w: 0.035, h: 1.5, hook: 0.2 }] },
  yotei:      { base: 0.22, rough: 0.55, horns: [{ at: 0.80, w: 0.13, h: 1.8, hook: 0.0, volcano: true }] },
  coastal:    { base: 0.34, rough: 1.15, horns: [{ at: 0.20, w: 0.09, h: 1.5, hook: 0.2 }] },
  sierra:     { base: 0.30, rough: 1.25, horns: [] },
  alps:       { base: 0.46, rough: 1.05, horns: [{ at: 0.15, w: 0.07, h: 1.7, hook: 0.3 }, { at: 0.72, w: 0.06, h: 1.4, hook: 0.28 }] },
  rockies:    { base: 0.38, rough: 1.2, horns: [{ at: 0.28, w: 0.10, h: 1.5, hook: 0.15 }] },
  monashee:   { base: 0.32, rough: 1.0, horns: [{ at: 0.55, w: 0.12, h: 1.4, hook: 0.12 }] },
};

function hash1(i) {
  let h = Math.imul(i | 0, 374761393) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}
function noise1(x) {
  const i = Math.floor(x), f = x - i, s = f * f * (3 - 2 * f);
  return hash1(i) * (1 - s) + hash1(i + 1) * s;
}
function fbm1(x, oct = 5) {
  let v = 0, a = 0.5, fr = 1;
  for (let i = 0; i < oct; i++) { v += a * noise1(x * fr); fr *= 2.13; a *= 0.5; }
  return v;
}

/**
 * Builds a ring of ridge geometry around the origin.
 *
 * Each column is subdivided VERTICALLY rather than being a single base-to-peak
 * quad. That is the whole difference between "distant mountain range" and "grey
 * curtain": with two vertices per column the only colour information available
 * is a smooth vertical gradient, whereas subdividing lets the SNOW LINE run
 * horizontally across the range at a consistent altitude, cutting each summit
 * where it actually crosses it. A snow line is the single strongest cue that a
 * silhouette is a mountain and not a wall.
 *
 * `skirt` drops the base below the ring origin so the bottom edge is never a
 * hard line hanging in the sky. It stays short and ends in exactly the horizon
 * colour, because the terrain does not reach far enough to occlude a tall one.
 */
function buildRidge(profile, radius, height, segments, seed, hazeCol, rockCol, snowCol, skirt = 260) {
  const LEVELS = 6;
  const pos = [], col = [], idx = [];
  const c = new THREE.Color();

  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const a = t * Math.PI * 2;
    const cs = Math.cos(a), sn = Math.sin(a);

    // Ridge height: fbm at two scales, then the named horns on top.
    let h = profile.base + profile.rough * 0.62 * (fbm1(t * 26 + seed, 5) - 0.35)
                         + profile.rough * 0.26 * (fbm1(t * 71 + seed * 3, 3) - 0.4);
    // Horn heights are multiples of the ring height, and the ring heights were
    // raised to put the skyline above the run — so they need scaling back down
    // to stay believable. Sanity check: the real Matterhorn stands about 2.5 km
    // above Zermatt at 5 km out, which is 27°. Unscaled, this ring's tallest
    // horn subtended 46° and read as a pink wall across half the sky.
    const HORN_SCALE = 0.55;
    for (const horn of profile.horns) {
      const dt = Math.abs(((t - horn.at) + 1.5) % 1 - 0.5);
      const k = Math.max(0, 1 - dt / horn.w);
      if (k <= 0) continue;
      // A snow horn is a sharp power curve; a stratovolcano is a broad cone.
      const shape = horn.volcano ? Math.pow(k, 1.35) : Math.pow(k, 0.62);
      const skew = horn.hook ? horn.hook * Math.sin((t - horn.at) / horn.w * Math.PI) * k : 0;
      h += horn.h * HORN_SCALE * (shape + skew * 0.35);
    }
    h = Math.max(0.05, h) * height;

    // The snow line wanders with aspect and wind, but it stays a LINE: an
    // altitude, not a fraction of each summit's own height.
    const snowLine = (0.30 + 0.13 * fbm1(t * 9 + seed * 5, 3)) * height;
    const band = height * 0.07;

    for (let l = 0; l <= LEVELS; l++) {
      const f = l / LEVELS;
      const y = -skirt + (h + skirt) * f;
      pos.push(cs * radius, y, sn * radius);

      const k = Math.min(1, Math.max(0, (y - snowLine) / band));
      c.copy(rockCol).lerp(snowCol, k * k * (3 - 2 * k));
      // Aerial perspective: the lower a face sits, the more atmosphere is in
      // front of it, and anything at or below the origin is pure haze.
      const haze = 1 - Math.min(1, Math.max(0, y / (height * 0.55)));
      c.lerp(hazeCol, 0.20 + 0.80 * haze * haze);
      col.push(c.r, c.g, c.b);
    }
  }

  const stride = LEVELS + 1;
  for (let i = 0; i < segments; i++) {
    for (let l = 0; l < LEVELS; l++) {
      const a = i * stride + l, b = a + 1;
      const cc = (i + 1) * stride + l, d = cc + 1;
      idx.push(a, cc, b, b, cc, d);
    }
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

export function createEnvironment(renderer, scene, run) {
  const time = TIME_PRESETS[run.time] || TIME_PRESETS.midday;
  const wx = WEATHER_PRESETS[run.weather] || WEATHER_PRESETS.clear;

  // ── Sky dome ────────────────────────────────────────────────────
  const sky = new Sky();
  sky.scale.setScalar(60000);
  sky.renderOrder = -1000;   // behind every piece of terrain and skyline
  sky.material.uniforms.turbidity.value = time.turbidity + wx.turbidityAdd;
  sky.material.uniforms.rayleigh.value = time.rayleigh;
  sky.material.uniforms.mieCoefficient.value = time.mie;
  sky.material.uniforms.mieDirectionalG.value = time.mieG;

  const sunPos = new THREE.Vector3();
  const phi = THREE.MathUtils.degToRad(90 - time.elevation);
  const theta = THREE.MathUtils.degToRad(time.azimuth);
  sunPos.setFromSphericalCoords(1, phi, theta);
  sky.material.uniforms.sunPosition.value.copy(sunPos);
  scene.add(sky);

  // ── Environment map ─────────────────────────────────────────────
  // One PMREM bake of the sky. The weather never changes mid-run, so this is a
  // single up-front cost rather than the per-frame rebake the medieval
  // prototype needs for its day cycle.
  const pmrem = new THREE.PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();
  const envRT = pmrem.fromScene(sky, 0, 100, 100000);
  scene.environment = envRT.texture;

  // ── Fog ─────────────────────────────────────────────────────────
  // Sampled from the sky's own horizon colour so the terrain fades into the
  // exact pixel the sky is drawing there — no visible seam at the fog wall.
  // Authored per time of day, then pulled toward the weather's own cast. Snow
  // scenes live or die on this colour: derive it and you get white, and white
  // fog over white snow is a whiteout with no depth in it at all.
  const horizon = new THREE.Color(time.fog).lerp(new THREE.Color(wx.tint), 0.35 * wx.flat);
  scene.fog = new THREE.FogExp2(horizon.getHex(), wx.fogDensity);

  // ── Lights ──────────────────────────────────────────────────────
  const sun = new THREE.DirectionalLight(time.key, time.keyI * wx.keyMul);
  sun.position.copy(sunPos).multiplyScalar(220);
  sun.castShadow = false;                    // enabled by applyQuality()
  sun.shadow.camera.near = 1;
  sun.shadow.camera.far = 520;
  sun.shadow.bias = -0.0009;
  sun.shadow.normalBias = 0.9;
  scene.add(sun);
  scene.add(sun.target);

  // Snow bounce, and it is worth being explicit about how large this has to be.
  // Snow reflects ~85% of what lands on it, and a slope is surrounded by more
  // snow, so a surface facing AWAY from the sun is still receiving most of a
  // full hemisphere of bounced light. The photographic result is a key-to-fill
  // ratio near 1.5:1, not the 4:1 an outdoor scene on grass or rock would have.
  //
  // At the ratio this used to run, every valley flank not facing the sun went
  // to near-black and the run read as a trench cut through slag. `ground` is
  // the up-facing snow colour being thrown back up into the scene, and it is
  // the single most important light in a snow render.
  const hemi = new THREE.HemisphereLight(time.fill, time.ground, 1.45 * wx.fillMul + wx.flat * 0.6);
  scene.add(hemi);

  // A dim cool fill from the anti-sun side keeps deep shadow readable without
  // washing out the key. On storm days it does most of the work.
  const fill = new THREE.DirectionalLight(time.fill, 0.30 + wx.flat * 0.5);
  fill.position.set(-sunPos.x * 120, 90, -sunPos.z * 120);
  scene.add(fill);

  // ── Horizon ridges ──────────────────────────────────────────────
  const profile = SKYLINES[run.peaks] || SKYLINES.alps;
  const ridges = new THREE.Group();
  ridges.renderOrder = -1;

  // Aerial perspective: at four kilometres a ridge is mostly atmosphere, so
  // these sit very close to the horizon colour. Pushing them darker "for
  // contrast" is what turns a distant range into a cardboard cut-out.
  const hazeFar = horizon.clone().lerp(new THREE.Color(0x9fb6d6), 0.16);
  const hazeNear = horizon.clone().lerp(new THREE.Color(0x8ea6c8), 0.22);
  const rock = new THREE.Color(run.time === 'dusk' ? 0x6b5c74 : 0x7c869e).lerp(horizon, 0.42);
  const snowC = new THREE.Color(run.time === 'dawn' ? 0xf3d8c6 : run.time === 'dusk' ? 0xd6c2cc : 0xf4f8ff)
    .lerp(horizon, 0.22);

  // depthWrite MUST be on. These are opaque geometry standing between the sky
  // dome and the terrain: with it off, the sky dome — which draws after them —
  // passed the depth test and painted the entire skyline back out again, which
  // is why the Matterhorn was invisible.
  const mkMat = () => new THREE.MeshBasicMaterial({
    vertexColors: true, side: THREE.DoubleSide, fog: false, depthWrite: true,
  });

  const far = new THREE.Mesh(buildRidge(
    { base: profile.base * 0.55, rough: profile.rough * 0.7, horns: profile.horns.map(h => ({ ...h, h: h.h * 0.7 })) },
    9000, 2600, 220, 11.3, hazeFar, rock.clone().lerp(hazeFar, 0.72), snowC.clone().lerp(hazeFar, 0.62), 420), mkMat());
  far.renderOrder = -3;
  ridges.add(far);

  const near = new THREE.Mesh(buildRidge(
    profile, 4200, 1750, 300, 3.7, hazeNear, rock, snowC), mkMat());
  near.renderOrder = -2;
  ridges.add(near);

  // A third range, closer and rockier. Overlapping silhouettes at three depths
  // is what makes a horizon read as distance rather than as a painted backdrop.
  // Kept close to the horizon colour so the ring's lower body dissolves into
  // the sky instead of standing as a flat blue block between the terrain and
  // the peaks — which is all a viewer sees of it in portrait.
  const hazeMid = horizon.clone().lerp(new THREE.Color(0x7f96ba), 0.20);
  const mid = new THREE.Mesh(buildRidge(
    { base: profile.base * 0.62, rough: profile.rough * 1.3, horns: [] },
    2100, 1150, 260, 21.7, hazeMid, rock, snowC, 200), mkMat());
  mid.renderOrder = -1;
  ridges.add(mid);

  scene.add(ridges);

  // ── Cloud deck ──────────────────────────────────────────────────
  // A single soft billboard shell. Cheap, and on storm days it is what sells
  // the ceiling coming down on top of the run.
  const cloudTex = makeCloudTexture();
  const clouds = new THREE.Group();
  const cloudCount = wx.flat > 0.4 ? 26 : 14;
  for (let i = 0; i < cloudCount; i++) {
    const a = (i / cloudCount) * Math.PI * 2 + hash1(i * 31) * 0.4;
    const r = 900 + hash1(i * 7) * 1400;
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({
        map: cloudTex, transparent: true, depthWrite: false, fog: false,
        opacity: 0.16 + wx.flat * 0.42,
        color: horizon.clone().lerp(new THREE.Color(0xffffff), 0.55).multiplyScalar(1 - wx.flat * 0.25),
      }),
    );
    const s = 700 + hash1(i * 13) * 900;
    m.scale.set(s, s * 0.34, 1);
    m.position.set(Math.cos(a) * r, 340 + hash1(i * 17) * 420 - wx.flat * 200, Math.sin(a) * r);
    m.userData.drift = 0.6 + hash1(i * 19) * 1.4;
    clouds.add(m);
  }
  clouds.renderOrder = -1;
  scene.add(clouds);

  const api = {
    sky, sun, hemi, fill, ridges, clouds, envRT, pmrem,
    time, weather: wx, horizonColor: horizon, sunDir: sunPos.clone(),

    /** Keep the horizon centred on the camera and drift the cloud deck. */
    update(camera, dt) {
      ridges.position.set(camera.position.x, api.ridgeBaseY, camera.position.z);
      clouds.position.set(camera.position.x, 0, camera.position.z);
      for (const c of clouds.children) {
        c.lookAt(camera.position.x, c.position.y, camera.position.z);
        c.position.x += c.userData.drift * dt * wx.wind * 3;
        if (c.position.x > 2600) c.position.x -= 5200;
      }
    },

    /** Park the shadow camera on the rider so its texels are never wasted. */
    trackShadow(target) {
      sun.target.position.copy(target);
      sun.position.copy(sunPos).multiplyScalar(200).add(target);
      sun.target.updateMatrixWorld();
    },

    applyQuality(q) {
      sun.castShadow = !!q.shadows;
      if (q.shadows) {
        sun.shadow.mapSize.set(q.shadowMapSize, q.shadowMapSize);
        const half = 62;
        const c = sun.shadow.camera;
        c.left = -half; c.right = half; c.top = half; c.bottom = -half;
        c.updateProjectionMatrix();
        if (sun.shadow.map) { sun.shadow.map.dispose(); sun.shadow.map = null; }
      }
    },

    dispose() {
      envRT.dispose(); pmrem.dispose(); cloudTex.dispose();
      far.geometry.dispose(); near.geometry.dispose(); mid.geometry.dispose();
      for (const c of clouds.children) { c.geometry.dispose(); c.material.dispose(); }
    },
  };

  api.ridgeBaseY = 0;   // set by main.js once the course elevation is known
  return api;
}

// Soft elliptical puff, built once and shared by every cloud billboard.
function makeCloudTexture() {
  const S = 256;
  const cv = document.createElement('canvas');
  cv.width = S; cv.height = S;
  const g = cv.getContext('2d');
  const img = g.createImageData(S, S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const u = (x / S - 0.5) * 2, v = (y / S - 0.5) * 2;
      // Radial falloff × a lumpy noise field = a puff with a ragged edge.
      const r = Math.sqrt(u * u + v * v * 2.4);
      let n = 0, amp = 0.5, f = 3;
      for (let o = 0; o < 4; o++) {
        n += amp * noise1(x * 0.04 * f + y * 0.017 * f * 1.7 + o * 37);
        f *= 2.1; amp *= 0.5;
      }
      const a = Math.max(0, 1 - r) * (0.45 + n * 0.9);
      const i = (y * S + x) * 4;
      img.data[i] = 255; img.data[i + 1] = 255; img.data[i + 2] = 255;
      img.data[i + 3] = Math.min(255, a * 255) | 0;
    }
  }
  g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
