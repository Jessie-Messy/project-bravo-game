// sky.js — Preetham sky dome, starfield, phased moon, dynamic PMREM env map.
//
// Replaces two things the game used to do: a flat scene.background Color and a
// 64×256 canvas gradient baked once at startup into scene.environment. The
// gradient never changed, so metal reflected a noon sky at midnight and the
// horizon colour had to be hand-lerped to compensate. Here the environment map
// is re-baked from the *actual* sky, so IBL, fog and the sky itself can never
// disagree again.
//
// Nothing in here imports a game module. THREE, the renderer, the scene and the
// quality settings all arrive through createSky()'s argument object — that's
// what keeps js/render/* out of the game3d.js ⇄ state.js import cycle. The one
// exception is the Sky addon below, which is pure three and safe to import.
import { Sky } from 'three/addons/objects/Sky.js';

// The world is 23040×26592 units and the camera orbits the player at ~1300, so
// a sky parked at the world origin would sit off to one side and read as a
// painted wall. Everything in this module rides the camera instead.
// Sky.js is a unit BoxGeometry, so scale 10000 = a half-extent of 5000 and a
// corner distance of ~8660 — comfortably inside the camera's far plane of
// 12000, which is why the stars/moon below live at 4200/3800 rather than
// "some big number".
const SKY_SCALE  = 10000;
// Tune live with _dev.skyGain(n) — see the exposure-gain block in createSky.
const DEFAULT_SKY_GAIN = 0.35;
const STAR_R     = 4200;
const MOON_DIST  = 3800;
const MOON_SIZE  = 430;    // ~6.5° across. Astronomically huge; reads right on a 52° FOV.
const STAR_COUNT = 2400;
// The star shader twinkles at sin(uTime * 1.6 + phase); 512 whole periods of
// that is where the accumulator resets. Keep the 1.6 in sync with the shader.
const TWINKLE_WRAP = (Math.PI * 2 / 1.6) * 512;

// Deterministic PRNG (mulberry32). A bare Math.random() at module scope would
// reshuffle the constellations on every page load, which looks like a bug the
// first time you notice it. Same seed → same sky, every session, every client.
function mulberry32(a){
  return function(){
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function clamp01(v){ return v < 0 ? 0 : v > 1 ? 1 : v; }

// IEEE 754 binary16 → float. readRenderTargetPixels hands back a Uint16Array
// for a HalfFloatType target and three has no decoder for it.
function halfToFloat(h){
  const s = (h & 0x8000) ? -1 : 1, e = (h & 0x7c00) >> 10, f = h & 0x03ff;
  if (e === 0)  return s * 5.9604644775390625e-8 * f;   // subnormal
  if (e === 31) return f ? 0 : s * 65504;               // NaN → 0, Inf → clamp
  return s * Math.pow(2, e - 15) * (1 + f / 1024);
}

export function createSky({ THREE, renderer, scene, settings }){

  let rebakeSec = 4, pmremSize = 128;
  function readSettings(s){
    if (!s) return;
    if (typeof s.skyRebakeSec  === 'number') rebakeSec = Math.max(0.25, s.skyRebakeSec);
    if (typeof s.skyPmremSize  === 'number') pmremSize = Math.max(16, s.skyPmremSize | 0);
  }
  readSettings(settings);

  // ── Preetham sky ────────────────────────────────────────────────
  const sky = new Sky();
  sky.scale.setScalar(SKY_SCALE);
  // It's a box we re-centre on the camera every frame, so its bounding sphere
  // is stale by definition and the cull test is pure waste — and when the
  // camera pitches to near-overhead the stale sphere can cull it outright and
  // the sky vanishes. Same reasoning as makeMesh()'s instanced meshes.
  sky.frustumCulled = false;
  sky.renderOrder = -3;                 // before the stars, the moon and the world
  scene.add(sky);

  // ── Exposure gain ───────────────────────────────────────────────
  // Sky.js is built for the three.js example, which renders it straight to the
  // screen at toneMappingExposure ~0.5. Here the scene goes into a linear HDR
  // target and OutputPass tone-maps afterwards, and this game's exposure is set
  // by the *ground*, not the sky — so the sky arrives far too hot and clips to
  // flat white, taking fog and the clear colour with it.
  //
  // Scale the radiance; do NOT try to reshape the curve. Cancelling the shader's
  // built-in `pow(texColor, 1/(1.2+1.2*sunfade))` with a pow(rgb,2.2) was tried
  // and made it strictly worse — that output exceeds 1.0 near the horizon, where
  // a >1 exponent amplifies instead of attenuating.
  //
  // A plain multiply keeps the hue relationships Preetham computed (which is the
  // whole reason to use it) and moves only the level. It applies to the PMREM
  // bake too, since that renders this same material — so the sky and the light
  // it casts stay consistent by construction.
  //
  // NOTE this camera always looks AT the player and can never pitch to the
  // zenith, so the only sky ever on screen is the horizon band. Tune the gain
  // against that band, not against an overhead blue you'll never see.
  const skyGain = { value: DEFAULT_SKY_GAIN };
  sky.material.onBeforeCompile = (shader) => {
    shader.uniforms.uSkyGain = skyGain;
    shader.fragmentShader = 'uniform float uSkyGain;\n' + shader.fragmentShader
      .replace(/}\s*$/, '  gl_FragColor.rgb *= uSkyGain;\n}');
  };
  sky.material.needsUpdate = true;

  const su = sky.material.uniforms;

  // ── Clouds ──────────────────────────────────────────────────────
  // A Preetham sky is a clean gradient and nothing else, which reads as an
  // empty dome — there is no scale cue and no motion anywhere above the
  // horizon. This is a single camera-following dome carrying animated fbm.
  //
  // A dome rather than a flat plane on purpose: this camera can pitch down to
  // near ground level, and a plane's edge would swing into frame as a visible
  // straight line across the sky. Rendered inside the sky box, before the world,
  // with depthWrite off.
  //
  // Coverage and colour are driven from outside so clouds warm at dusk and go
  // near-black at night along with everything else.
  const cloudUni = {
    uTime:     { value: 0 },
    uCover:    { value: 0.46 },   // 0 = clear, 1 = overcast
    uSunDir:   { value: new THREE.Vector3(0, 1, 0) },
    uTint:     { value: new THREE.Color(0xffffff) },
    uOpacity:  { value: 1.0 },
  };
  const cloudMat = new THREE.ShaderMaterial({
    uniforms: cloudUni,
    transparent: true,
    depthWrite: false,
    // depthTest stays ON. With it off the dome would paint over the world
    // rather than sitting behind it — clouds only ever draw above the horizon,
    // so there is nothing for the test to wrongly occlude.
    depthTest: true,
    side: THREE.BackSide,
    fog: false,
    vertexShader: `
      varying vec3 vDir;
      void main(){
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }`,
    fragmentShader: `
      varying vec3 vDir;
      uniform float uTime, uCover, uOpacity;
      uniform vec3  uSunDir, uTint;
      float h21(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
      float vn(vec2 p){
        vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
        return mix(mix(h21(i), h21(i+vec2(1,0)), f.x),
                   mix(h21(i+vec2(0,1)), h21(i+vec2(1,1)), f.x), f.y);
      }
      float fbm(vec2 p){
        float s = 0.0, a = 0.5;
        for(int i = 0; i < 5; i++){ s += a * vn(p); p = p * 2.03 + 17.3; a *= 0.5; }
        return s;
      }
      void main(){
        // Below the horizon there is only ground; bail before doing any noise.
        if(vDir.y <= 0.02) discard;
        // Project the view direction onto a plane at a fixed height. This is
        // what makes clouds compress toward the horizon like real ones instead
        // of tiling evenly across the dome.
        vec2 uv = vDir.xz / max(vDir.y, 0.06) * 0.55;
        uv += vec2(uTime * 0.0032, uTime * 0.0019);          // drift
        float n = fbm(uv);
        n = mix(n, fbm(uv * 2.7 - vec2(uTime * 0.004, 0.0)), 0.35);  // shear the layers
        // Coverage as a threshold, not a multiply: this is what gives clouds
        // edges and gaps of clear sky rather than a uniform haze.
        // The threshold has to sit on the noise's REAL distribution. This fbm
        // sums amplitudes 0.5+0.25+... to a 0.97 maximum and a mean near 0.48,
        // so the obvious-looking "1.0 minus uCover" put the cut at 0.54 and up,
        // out in the tail - nearly every pixel discarded and the sky stayed
        // empty. Map coverage across the band the noise actually occupies.
        // (No backticks in here: this whole shader is a JS template literal.)
        float thr = mix(0.62, 0.30, uCover);
        float d = smoothstep(thr, thr + 0.16, n);
        // Fade near the horizon so the dome's base never shows as a rim — but
        // only just. This camera always looks AT the player and can never pitch
        // up, so the horizon band is the only sky it ever shows; fading from
        // 0.30 put the entire cloud layer above the top of the frame.
        d *= smoothstep(0.010, 0.11, vDir.y);
        if(d <= 0.001) discard;
        // Cheap lighting: thin edges brighten toward the sun, thick cores stay
        // dark. Not scattering, but it stops them reading as flat cutouts.
        float sunAmt = pow(max(dot(normalize(vDir), normalize(uSunDir)), 0.0), 6.0);
        // Daylit cumulus are BRIGHT — brighter than the sky behind them. The
        // first pass used 0.55/0.32, which made every cloud darker than the
        // blue it sat on and read as smog. Only the deepest cores go grey.
        vec3 lit  = uTint * (1.25 + 0.95 * sunAmt);
        vec3 core = uTint * 0.62;
        vec3 col  = mix(lit, core, smoothstep(0.45, 1.0, d));
        gl_FragColor = vec4(col, d * uOpacity);
      }`,
  });
  const WHITE = new THREE.Color(1, 1, 1);
  const cloudMesh = new THREE.Mesh(new THREE.SphereGeometry(SKY_SCALE * 0.42, 24, 16), cloudMat);
  cloudMesh.frustumCulled = false;
  cloudMesh.renderOrder = -2;          // after the sky dome, before stars/moon
  scene.add(cloudMesh);

  // ── Starfield ───────────────────────────────────────────────────
  // Preetham correctly goes black once the sun drops below the horizon, which
  // is accurate and completely dead to look at. These fill it back in.
  const starPos = new Float32Array(STAR_COUNT * 3);
  const starCol = new Float32Array(STAR_COUNT * 3);
  const starSize = new Float32Array(STAR_COUNT);
  const starPhase = new Float32Array(STAR_COUNT);
  {
    const rnd = mulberry32(0x5EED1A70);
    for (let i = 0; i < STAR_COUNT; i++){
      // Uniform on the sphere via the y-slab trick, but clipped to y >= -0.15:
      // the bottom hemisphere is under the terrain, so those verts would be
      // paid for and never seen.
      const y   = -0.15 + rnd() * 1.15;
      const r   = Math.sqrt(Math.max(0, 1 - y * y));
      const phi = rnd() * Math.PI * 2;
      starPos[i*3+0] = Math.cos(phi) * r * STAR_R;
      starPos[i*3+1] = y * STAR_R;
      starPos[i*3+2] = Math.sin(phi) * r * STAR_R;

      // Colour spread: blue-white → white → faint amber. A field of identical
      // white dots reads as dust on the monitor rather than as stars.
      const t = rnd();
      let cr, cg, cb;
      if (t < 0.55){ const k = t / 0.55;        cr = 0.72 + 0.28*k; cg = 0.80 + 0.20*k; cb = 1.00; }
      else         { const k = (t - 0.55)/0.45; cr = 1.00;          cg = 1.00 - 0.14*k; cb = 1.00 - 0.34*k; }
      const mag = 0.40 + rnd() * 0.60;          // apparent magnitude spread
      starCol[i*3+0] = cr * mag; starCol[i*3+1] = cg * mag; starCol[i*3+2] = cb * mag;

      // Biased toward small: a handful of bright anchors, the rest pinpricks.
      starSize[i]  = 1.1 + Math.pow(rnd(), 2.6) * 3.2;
      starPhase[i] = rnd();
    }
  }
  const starGeo = new THREE.BufferGeometry();
  starGeo.setAttribute('position', new THREE.BufferAttribute(starPos, 3));
  starGeo.setAttribute('aColor',   new THREE.BufferAttribute(starCol, 3));
  starGeo.setAttribute('aSize',    new THREE.BufferAttribute(starSize, 1));
  starGeo.setAttribute('aPhase',   new THREE.BufferAttribute(starPhase, 1));
  // PointsMaterial has one global size, so per-star size needs a shader. Cheap
  // enough — one attribute read and a sin() per vertex, 2400 verts.
  const starMat = new THREE.ShaderMaterial({
    uniforms: { uFade: { value: 0 }, uTime: { value: 0 }, uScale: { value: 1 } },
    vertexShader: /* glsl */`
      attribute vec3 aColor; attribute float aSize; attribute float aPhase;
      uniform float uFade, uTime, uScale;
      varying vec3 vCol; varying float vAmt;
      void main(){
        vec4 mv = modelViewMatrix * vec4(position, 1.0);
        gl_Position = projectionMatrix * mv;
        float tw = 0.80 + 0.20 * sin(uTime * 1.6 + aPhase * 6.2831853);
        vCol = aColor; vAmt = uFade * tw;
        gl_PointSize = aSize * uScale;
      }`,
    fragmentShader: /* glsl */`
      varying vec3 vCol; varying float vAmt;
      void main(){
        vec2 d = gl_PointCoord - 0.5;
        float r2 = dot(d, d);
        if (r2 > 0.25) discard;
        float a = smoothstep(0.25, 0.0, r2);
        gl_FragColor = vec4(vCol * a * vAmt, 1.0);
      }`,
    // transparent:false keeps this in the OPAQUE queue, which is the only way
    // to get it drawn before the world — three always flushes the transparent
    // queue last, renderOrder or not, and a transparent starfield with
    // depthTest off would paint straight over the terrain. Additive blending
    // still applies at transparent:false (WebGLState.setMaterial only forces
    // NoBlending for NormalBlending), so uFade=0 adds literally nothing and
    // there are no black dots punched through the daytime sky.
    transparent: false,
    blending: THREE.AdditiveBlending,
    depthTest: false,
    depthWrite: false,
  });
  const starPoints = new THREE.Points(starGeo, starMat);
  starPoints.frustumCulled = false;
  starPoints.renderOrder = -2;
  starPoints.visible = false;
  scene.add(starPoints);

  // ── Moon ────────────────────────────────────────────────────────
  // The game already runs a real 8-phase lunar cycle and gates night ambient
  // brightness off it (new moon = bring a torch). Players had no way to see
  // *why* one night was pitch black and the next was navigable, so the phase
  // gets drawn on a canvas and hung in the sky.
  const MOON_TEX_PX = 256;
  const moonCanvas = document.createElement('canvas');
  moonCanvas.width = moonCanvas.height = MOON_TEX_PX;
  const moonCtx = moonCanvas.getContext('2d');
  const moonTex = new THREE.CanvasTexture(moonCanvas);
  moonTex.colorSpace = THREE.SRGBColorSpace;

  function drawMoonPhase(phase){
    const S = MOON_TEX_PX, R = S * 0.36, c = moonCtx;
    c.setTransform(1, 0, 0, 1, 0, 0);
    c.globalCompositeOperation = 'source-over';
    c.clearRect(0, 0, S, S);
    moonTex.needsUpdate = true;
    if (phase === 0) return;                    // new moon: nothing is lit, so draw nothing

    // theta 0 = new, PI = full. Illuminated fraction = (1 - cos theta)/2, which
    // gives 0 / 0.5 / 1 / 0.5 at phases 0 / 2 / 4 / 6 — matching the
    // phaseBright table updateEnvironmentCycle uses for moonlight.
    const theta   = phase * Math.PI / 4;
    const cosT    = Math.cos(theta);
    const litFrac = (1 - cosT) / 2;
    const gibbous = cosT < 0;

    c.save();
    c.translate(S / 2, S / 2);
    c.scale(phase > 4 ? -1 : 1, 1);             // waning half of the cycle lights the other limb

    // Lit region = the sunlit limb (a true semicircle) closed off by the
    // terminator, which is a half-ellipse of x-radius R*|cos theta|. It bulges
    // AWAY from the lit limb while gibbous and TOWARD it while crescent — that
    // one flag is the whole difference between a waxing gibbous and a waxing
    // crescent, and getting it from waxing/waning instead of sign(cos) is the
    // easy way to draw phase 3 as a crescent by mistake.
    c.beginPath();
    c.arc(0, 0, R, -Math.PI / 2, Math.PI / 2, false);
    c.ellipse(0, 0, R * Math.abs(cosT), R, 0, Math.PI / 2, -Math.PI / 2, !gibbous);
    c.closePath();
    c.clip();

    const g = c.createRadialGradient(-R * 0.28, -R * 0.28, R * 0.12, 0, 0, R * 1.06);
    g.addColorStop(0.00, '#fffdf2');
    g.addColorStop(0.62, '#e6e4d6');
    g.addColorStop(1.00, '#b4b2a4');
    c.fillStyle = g;
    c.beginPath(); c.arc(0, 0, R, 0, Math.PI * 2); c.fill();

    // Maria. Seeded off a fixed constant, not the phase, so the face doesn't
    // reshuffle every time the moon waxes.
    const mr = mulberry32(0x0F1CE5);
    for (let i = 0; i < 11; i++){
      const a = mr() * Math.PI * 2, d = Math.sqrt(mr()) * R * 0.82;
      const rr = R * (0.07 + mr() * 0.20);
      c.fillStyle = `rgba(112,118,138,${0.10 + mr() * 0.13})`;
      c.beginPath(); c.arc(Math.cos(a) * d, Math.sin(a) * d, rr, 0, Math.PI * 2); c.fill();
    }
    c.restore();

    // Soft halo outside the disc, scaled by how much of it is lit — a new-moon
    // sliver shouldn't glow like a full moon.
    // The halo MUST reach zero before the canvas edge. R is 0.36*S, so the
    // texture's half-width is only ~1.39R — an outer stop at 2.0R was still
    // clearly bright where it met the border and got clipped to the quad,
    // which rendered the moon as a lighter SQUARE against the night sky.
    // 1.32R lands at 0.475*S, just inside the edge, and the extra midpoint
    // stop keeps the falloff soft rather than conical now that it's tighter.
    c.globalCompositeOperation = 'lighter';
    const haloA = 0.10 + 0.24 * litFrac;
    const halo = c.createRadialGradient(S/2, S/2, R * 0.92, S/2, S/2, R * 1.32);
    halo.addColorStop(0.00, `rgba(186,202,236,${haloA.toFixed(3)})`);
    halo.addColorStop(0.45, `rgba(186,202,236,${(haloA * 0.34).toFixed(3)})`);
    halo.addColorStop(1.00, 'rgba(186,202,236,0)');
    c.fillStyle = halo; c.fillRect(0, 0, S, S);
    c.globalCompositeOperation = 'source-over';
  }

  // A Sprite would be simpler, but sprites re-face whatever camera is drawing
  // them — in the 6-face PMREM cube bake below that puts a moon in every
  // direction. A plane we aim ourselves appears exactly once, where it belongs.
  const moonMat = new THREE.MeshBasicMaterial({
    map: moonTex, color: 0x000000, fog: false,
    transparent: false, blending: THREE.AdditiveBlending,
    depthTest: false, depthWrite: false,
  });
  const moonGeo = new THREE.PlaneGeometry(MOON_SIZE, MOON_SIZE);
  const moonMesh = new THREE.Mesh(moonGeo, moonMat);
  moonMesh.frustumCulled = false;
  moonMesh.renderOrder = -1;
  moonMesh.visible = false;
  scene.add(moonMesh);

  // ── PMREM ───────────────────────────────────────────────────────
  // ONE generator for the lifetime of the module. Building one per bake (or
  // calling .dispose() between bakes) throws away its compiled blur/cubemap
  // shaders and re-links them every few seconds — a visible hitch plus a slow
  // leak of program objects. It is disposed exactly once, in dispose().
  const pmrem = new THREE.PMREMGenerator(renderer);

  // A dedicated scene so the bake sees the sky and nothing else. Baking the
  // real scene would drag every tree, wall and NPC through six 90° renders.
  const skyScene = new THREE.Scene();

  // We take ownership of whatever scene.environment already held — that's the
  // startup canvas-gradient PMREM this module exists to replace, and nothing
  // else references it.
  let envRT  = null;
  let envTex = scene.environment || null;

  // fromScene() builds its cube camera with this far plane. It has to clear the
  // dome's far corners — the box half-extent is SKY_SCALE/2 = 5000 and the
  // corners are at ~8660 — so the usual far=1000 you see in three examples
  // bakes a completely black env map here and metal goes dead. Sized for the
  // geometry, not copied from a sample.
  const BAKE_FAR = SKY_SCALE * 1.2;

  function bakeAtSize(size){
    // r160's PMREMGenerator.fromScene() opens with a hardcoded
    // `this._setSize( 256 )` (it's right there in three.module.js), so
    // settings.skyPmremSize would be silently ignored and every quality tier
    // would pay for a 256px cube. Shim the private sizer for the duration of
    // one call. If a future three drops _setSize we fall back to stock 256
    // rather than throwing.
    const proto = Object.getPrototypeOf(pmrem);
    if (typeof proto._setSize !== 'function') return pmrem.fromScene(skyScene, 0, 0.1, BAKE_FAR);
    pmrem._setSize = function(){ proto._setSize.call(pmrem, size); };
    try { return pmrem.fromScene(skyScene, 0, 0.1, BAKE_FAR); }
    finally { delete pmrem._setSize; }
  }

  function bake(){
    const rt = bakeAtSize(pmremSize);
    // ⚠ LEAK GUARD — fromScene() allocates a brand-new CubeUV render target on
    // every single call, so the one the scene is holding right now is dead the
    // moment this one exists. Release it before the reassignment below or we
    // leak a whole env map every skyRebakeSec seconds and the tab dies over a
    // long session. Dispose the render TARGET, not just .texture: texture
    // dispose leaves the framebuffer and depth attachment behind.
    if (envRT) envRT.dispose(); else if (envTex) envTex.dispose();
    envRT = rt; envTex = rt.texture; scene.environment = envTex;
  }

  // ── Horizon sample ──────────────────────────────────────────────
  // The caller drives scene.fog.color and the clear colour off this. It used to
  // be a hand-tuned lerp between two hex constants, which meant fog and sky
  // drifted apart at dawn. Reading it back off the GPU costs a pipeline stall,
  // so it rides the bake throttle rather than running per frame.
  //
  // Half-float, and deliberately NOT tone mapped: three skips tone mapping when
  // rendering to a plain render target, and fog is applied in linear space
  // *before* tone mapping anyway, so raw linear radiance is exactly the value
  // fog.color wants. (The clear colour would prefer a tone-mapped value, but
  // the sky box covers every pixel now, so nothing ever sees the clear.)
  const HZ_W = 16, HZ_H = 8;
  let horizonRT = null, horizonBuf = null, horizonCam = null;
  let canReadBack = !!(renderer.capabilities && renderer.capabilities.isWebGL2 &&
                       renderer.extensions &&
                       (renderer.extensions.has('EXT_color_buffer_float') ||
                        renderer.extensions.has('EXT_color_buffer_half_float')));
  const _horizon = new THREE.Color(0x1a2a14);
  const _aim = new THREE.Vector3();

  function fallbackHorizon(dayF, horizonF){
    // Only used where the half-float readback isn't available. Roughly the old
    // hand-tuned ramp, plus a warm push while the sun is on the horizon.
    const n = 1 - dayF;
    let r = 0.012 * n + 0.055 * dayF;
    let g = 0.018 * n + 0.085 * dayF;
    let b = 0.045 * n + 0.075 * dayF;
    const w = horizonF * dayF * 0.9;
    r += w * 0.16; g += w * 0.06; b += w * 0.01;
    _horizon.setRGB(r, g, b, THREE.LinearSRGBColorSpace);
  }

  function sampleHorizon(sunDir, dayF, horizonF){
    if (!canReadBack){ fallbackHorizon(dayF, horizonF); return; }
    if (!horizonRT){
      horizonRT = new THREE.WebGLRenderTarget(HZ_W, HZ_H, {
        type: THREE.HalfFloatType, depthBuffer: false, stencilBuffer: false,
        minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false,
      });
      horizonBuf = new Uint16Array(HZ_W * HZ_H * 4);
      horizonCam = new THREE.PerspectiveCamera(34, HZ_W / HZ_H, 1, 20000);
    }
    // Aim down the sun's azimuth and a few degrees up: that's the bearing whose
    // colour the player is actually looking into at dawn and dusk, and it's the
    // direction the warm rayleigh ramp is tuned for. Straight at 0° grazes the
    // shader's zenith-angle cutoff and reads muddy.
    _aim.set(sunDir.x, 0, sunDir.z);
    if (_aim.lengthSq() < 1e-8) _aim.set(0, 0, 1);
    _aim.normalize(); _aim.y = 0.09; _aim.normalize();
    horizonCam.position.set(0, 0, 0);
    horizonCam.lookAt(_aim);
    horizonCam.updateMatrixWorld();

    const prevRT = renderer.getRenderTarget();
    renderer.setRenderTarget(horizonRT);
    renderer.render(skyScene, horizonCam);
    renderer.setRenderTarget(prevRT);
    try {
      renderer.readRenderTargetPixels(horizonRT, 0, 0, HZ_W, HZ_H, horizonBuf);
    } catch (_){
      canReadBack = false;                       // don't retry every bake forever
      fallbackHorizon(dayF, horizonF);
      return;
    }
    let r = 0, g = 0, b = 0;
    const n = HZ_W * HZ_H;
    for (let i = 0; i < n; i++){
      r += halfToFloat(horizonBuf[i*4+0]);
      g += halfToFloat(horizonBuf[i*4+1]);
      b += halfToFloat(horizonBuf[i*4+2]);
    }
    r /= n; g /= n; b /= n;
    if (!(r >= 0) || !(g >= 0) || !(b >= 0)){ fallbackHorizon(dayF, horizonF); return; }
    // Clamped high: the sun disc itself can push this well past 1 and a fog
    // colour that bright washes the whole middle distance to white.
    _horizon.setRGB(Math.min(r, 1.4), Math.min(g, 1.4), Math.min(b, 1.4), THREE.LinearSRGBColorSpace);
  }

  // ── Per-frame placement ─────────────────────────────────────────
  function placeAround(center, sunDir){
    sky.position.copy(center);
    starPoints.position.copy(center);
    cloudMesh.position.copy(center);
    // Opposite the sun, which is exactly where a full moon sits and close
    // enough for the rest of the cycle at this scale.
    moonMesh.position.copy(center).addScaledVector(sunDir, -MOON_DIST);
    moonMesh.lookAt(center);
  }

  let lastBakeTime = -1e9, lastBakeDay = -99, elapsed = 0, lastPR = -1;
  let curPhase = -1;
  const _origin = new THREE.Vector3(0, 0, 0);

  function update(opts){
    const sunDir = opts.sunDir;
    const dayF = clamp01(opts.dayF);
    const dt = (typeof opts.dt === 'number' && opts.dt > 0) ? Math.min(opts.dt, 0.1) : 0;
    // Wrapped on an exact multiple of the twinkle period, so the stars don't
    // visibly jump when it rolls over — and so a float32 uniform doesn't lose
    // its fractional bits after a few hours of uptime.
    elapsed = (elapsed + dt) % TWINKLE_WRAP;

    // How close the sun is to the horizon, straight off its real elevation
    // rather than off dayF — dayF is flat at 1 all through the middle of the
    // day, so it can't tell noon from mid-afternoon.
    // The 0.30 this used to divide by was far too tight. The game's dusk window
    // is 18:00-20:00, and at 19:00 the sun sits at y=0.24 — about 14 degrees of
    // elevation, unmistakably golden hour — yet that gave horizonF=0.20, so the
    // warm ramp was still essentially off and dusk sampled a near-neutral
    // [0.90, 0.92, 0.86] horizon. 0.55 lets the warmth build from roughly 33
    // degrees down, so 19:00 lands near 0.56 and 20:00 reaches full sunset.
    // Noon (y=0.95) still clamps to 0, so midday is unaffected.
    const horizonF = clamp01(1 - Math.abs(sunDir.y) / 0.55);

    // Rayleigh is the dial that matters: pushing it up near the horizon is what
    // reddens the sky at dawn/dusk. Note the shader's own vSunfade term is
    // useless to us — it divides sunPosition.y by 450000 and we pass a unit
    // vector (as the official three example does), so it pins at 1.0 and every
    // dusk cue has to come from these four ramps instead.
    su.turbidity.value        = 2.2 + 6.8 * horizonF;
    su.rayleigh.value         = 0.9 + 2.9 * horizonF;
    su.mieCoefficient.value   = 0.0045 + 0.0110 * horizonF;
    su.mieDirectionalG.value  = 0.80 + 0.11 * horizonF;
    su.sunPosition.value.copy(sunDir);

    // Clouds ride the camera like the sky, take the sun direction for their
    // rim lighting, and are tinted by the same horizon colour that drives fog —
    // so at dusk they go amber with the sky rather than staying white cutouts
    // pasted over it.
    cloudUni.uTime.value = elapsed;
    cloudUni.uSunDir.value.copy(sunDir);
    cloudUni.uTint.value.copy(_horizon).multiplyScalar(1.35).lerp(WHITE, 0.30 * dayF);
    // Night clouds must not glow. They stay faintly visible against the stars,
    // which reads as overcast, rather than vanishing entirely.
    cloudUni.uOpacity.value = 0.22 + 0.78 * dayF;

    // Stars are gone well before full daylight; the moon lingers a little
    // longer and is gated by the phase brightness so a new moon shows nothing.
    const starFade = clamp01(1 - dayF * 2.2);
    const moonFade = clamp01(1 - dayF * 1.4) * clamp01(opts.moonBright || 0);

    starPoints.visible = starFade > 0.01;
    if (starPoints.visible){
      starMat.uniforms.uFade.value = starFade;
      starMat.uniforms.uTime.value = elapsed;
      const pr = renderer.getPixelRatio();
      if (pr !== lastPR){ lastPR = pr; starMat.uniforms.uScale.value = pr; }
    }

    const phase = (opts.moonPhase | 0) & 7;
    if (phase !== curPhase){ curPhase = phase; drawMoonPhase(phase); }
    moonMesh.visible = moonFade > 0.01 && phase !== 0;
    if (moonMesh.visible) moonMat.color.setScalar(moonFade);

    // Re-bake on the game clock, not wall clock, so a paused or fast-forwarded
    // world stays consistent. The dayF delta is the important half: the throttle
    // alone would step the IBL in visible chunks through dawn and dusk, which is
    // precisely when the lighting is moving fastest.
    if (opts.gameTime < lastBakeTime) lastBakeTime = opts.gameTime;   // clock reset / world reload
    const due = (opts.gameTime - lastBakeTime) >= rebakeSec ||
                Math.abs(dayF - lastBakeDay) > 0.05 ||
                envRT === null;

    if (due){
      // Park everything at the origin first — fromScene() renders its cube from
      // (0,0,0), and a sky box still centred on a camera 20000 units away would
      // bake the inside of one wall.
      placeAround(_origin, sunDir);
      skyScene.add(sky, moonMesh);          // add() reparents; stars stay out, they
                                            // contribute nothing to irradiance
      bake();
      sampleHorizon(sunDir, dayF, horizonF);
      scene.add(sky, moonMesh);             // and back again
      lastBakeTime = opts.gameTime;
      lastBakeDay = dayF;
    }

    placeAround(opts.cameraPos, sunDir);
  }

  // Returns the live instance, not a clone — the caller copies out of it
  // (fog.color.copy / setClearColor) and this runs every frame.
  function horizonColor(){ return _horizon; }

  function setSettings(s){
    readSettings(s);
    lastBakeDay = -99;      // force a re-bake so a tier change takes effect now
  }

  function dispose(){
    scene.remove(sky, starPoints, moonMesh);
    skyScene.remove(sky, moonMesh);
    scene.remove(cloudMesh);
    cloudMesh.geometry.dispose(); cloudMat.dispose();
    sky.geometry.dispose(); sky.material.dispose();
    starGeo.dispose(); starMat.dispose();
    moonGeo.dispose(); moonMat.dispose(); moonTex.dispose();
    if (horizonRT){ horizonRT.dispose(); horizonRT = null; }
    if (scene.environment === envTex) scene.environment = null;
    if (envRT) envRT.dispose(); else if (envTex) envTex.dispose();
    envRT = null; envTex = null;
    pmrem.dispose();        // the only .dispose() this generator ever gets
  }

  // Setting the gain forces a re-bake: the env map and the horizon sample are
  // both derived from this material, and leaving them on the old level while
  // the visible sky moved is exactly the kind of mismatch that's impossible to
  // eyeball later.
  function setGain(v){
    if(typeof v === 'number' && isFinite(v)) { skyGain.value = Math.max(0, v); lastBakeDay = -99; }
    return skyGain.value;
  }

  // Cloud cover is a look dial, so it's tunable live rather than baked.
  function setClouds(v){
    if(typeof v === 'number' && isFinite(v)) cloudUni.uCover.value = Math.max(0, Math.min(1, v));
    return cloudUni.uCover.value;
  }

  return { update, horizonColor, setSettings, setGain, setClouds, dispose };
}
