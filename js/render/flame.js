// flame.js — the fire on torches, campfires and lanterns.
//
// The flames were additive spheres: an orange ball on a stick. The owner's
// verdict on the v0.21.0 torches: "the animation sucks and the light source
// sucks, it looks wonky". Two pieces replace it, both camera-facing cards,
// both one instanced draw for the whole world:
//
//  FLAME — a teardrop eroded by noise that scrolls UP and is stretched tall,
//          so tongues rise, tear off and vanish rather than boiling in place.
//          The root is pinned; only the upper part wanders. Coloured in four
//          hard bands (white core low down, yellow, orange, red tips) to sit
//          with the flat-shaded art — a soft gradient read as a candle glow.
//  GLOW  — a faint round halo around the flame whose brightness flickers with
//          the SAME formula as the PointLight (flameFlicker in game3d.js), so
//          the flame and the light it throws read as one source; and a few
//          embers that rise off the tip, drift and die.
//
// Per-instance phase comes from the instance's position, so neighbours never
// move in step. The flame shape never pulses in brightness (that read as a
// dimmer); the glow does, because a real flame's light does.

const COMMON = /* glsl */`
  float fh(vec2 p){ vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
  float fn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
    return mix(mix(fh(i), fh(i+vec2(1,0)), f.x), mix(fh(i+vec2(0,1)), fh(i+vec2(1,1)), f.x), f.y); }
  float fbm(vec2 p){ return fn(p) * 0.55 + fn(p * 2.1 + 3.7) * 0.30 + fn(p * 4.3 + 9.1) * 0.15; }
  // The PointLight's flicker (game3d.js flameFlicker), in GLSL.
  float flicker(float t, float ph){
    float b = 0.80 + 0.11 * sin(t * 7.3 + ph) + 0.07 * sin(t * 11.9 + ph * 1.7) + 0.05 * sin(t * 19.1 + ph * 0.6);
    float g = sin(t * 1.7 + ph * 2.3) * sin(t * 0.9 + ph);
    return b * (1.0 - 0.34 * (g > 0.62 ? (g - 0.62) / 0.38 : 0.0));
  }
`;

// Billboard: the card's local x runs along the camera's right, y up. `cyl`
// keeps it upright (the flame); otherwise it faces the camera fully (the glow).
const VERT = (cyl) => /* glsl */`
  uniform float uTime;
  varying vec2 vUv;
  varying float vPh;
  varying float vAspect;
  #include <common>
  #include <fog_pars_vertex>
  void main() {
    vUv = uv;
    vec3 c = vec3(0.0); float sx = 1.0, sy = 1.0;
    #ifdef USE_INSTANCING
      c = instanceMatrix[3].xyz;
      sx = length(instanceMatrix[0].xyz); sy = length(instanceMatrix[1].xyz);
    #else
      sx = length(modelMatrix[0].xyz); sy = length(modelMatrix[1].xyz);
    #endif
    vec3 wc = (modelMatrix * vec4(c, 1.0)).xyz;
    vPh = fract(dot(wc.xz, vec2(0.0131, 0.0217))) * 40.0;
    vAspect = sy / max(sx, 1e-3);
    ${cyl ? `
    vec3 toCam = cameraPosition - wc; toCam.y = 0.0;
    vec3 right = normalize(vec3(toCam.z, 0.0, -toCam.x) + 1e-5);
    vec3 up = vec3(0.0, 1.0, 0.0);` : `
    vec3 right = vec3(viewMatrix[0][0], viewMatrix[1][0], viewMatrix[2][0]);
    vec3 up    = vec3(viewMatrix[0][1], viewMatrix[1][1], viewMatrix[2][1]);`}
    vec3 wp = wc + right * (position.x * sx) + up * (position.y * sy);
    vec4 mvPosition = viewMatrix * vec4(wp, 1.0);   // (the name fog_vertex reads)
    gl_Position = projectionMatrix * mvPosition;
    #include <fog_vertex>
  }
`;

const FLAME_FRAG = /* glsl */`
  uniform float uTime;
  uniform float uGain;
  varying vec2 vUv;
  varying float vPh;
  varying float vAspect;
  #include <common>
  #include <fog_pars_fragment>
  ${COMMON}
  void main() {
    // x across -0.5..0.5, y 0 at the root .. 1 at the tip
    vec2 p = vec2(vUv.x - 0.5, vUv.y);
    float t = uTime + vPh;
    float free = smoothstep(0.08, 0.30, p.y);            // the root stays put
    // the whole column wanders a little, more toward the tip
    p.x += (fn(vec2(p.y * 3.0 - t * 2.0, vPh)) - 0.5) * 0.12 * p.y * free;
    // noise stretched tall and scrolling up: tongues rise and tear away
    float n  = fbm(vec2(p.x * 4.0, p.y * 1.2 - t * 3.4));
    float n2 = fbm(vec2(p.x * 7.0 + 4.0, p.y * 2.4 - t * 4.0));
    float x = p.x + (n2 - 0.5) * 0.20 * p.y * free;
    // teardrop: widest low down, pinched to a point at the top, rounded base
    float halfW = 0.33 * smoothstep(0.0, 0.14, p.y) * (1.0 - smoothstep(0.18, 1.0, p.y) * 0.95);
    float body = 1.0 - smoothstep(halfW * 0.6, halfW, abs(x));
    // the outline eats in from the top
    // (hard: a soft erosion left a smooth bulb; the tongues ARE the look)
    float erode = mix(0.22, 0.92, smoothstep(0.05, 0.90, p.y)) * mix(0.35, 1.0, free);
    // the edges burn away first: one central tongue, lower ones at the sides
    // (equal spikes read as a paper crown)
    erode += abs(x) / max(halfW, 1e-3) * 0.25 * free;
    // and the centre column always survives to most of the height, so the
    // flame never bobs tall-squat-tall
    erode *= mix(0.8, 1.0, clamp(abs(x) / max(halfW, 1e-3), 0.0, 1.0));
    float centre = 1.0 - clamp(abs(x) / max(halfW, 1e-3), 0.0, 1.0);
    float f = body * smoothstep(erode - 0.06, erode + 0.05, n * 1.15 + (1.0 - p.y) * 0.22 + centre * 0.16 * (1.0 - smoothstep(0.7, 0.95, p.y)));   // (not at the tip: it spun a needle)
    if (f < 0.02) discard;
    // heat falls off with height and toward the edge; tips end red
    float heat = clamp(f * (1.1 - p.y * 1.15) * (1.0 - abs(x) / max(halfW, 1e-3) * 0.55), 0.0, 1.0);
    // four hard bands, like the flat-shaded art around it
    const float w = 0.03;
    vec3 col = vec3(0.60, 0.08, 0.01);
    col = mix(col, vec3(0.95, 0.30, 0.04), smoothstep(0.25 - w, 0.25 + w, heat));
    col = mix(col, vec3(1.00, 0.52, 0.08), smoothstep(0.58 - w, 0.58 + w, heat));
    col = mix(col, vec3(1.00, 0.88, 0.55), smoothstep(0.85 - w, 0.85 + w, heat) * (1.0 - step(0.25, p.y)));
    // Normal blending, premultiplied: additive washed all four bands out to
    // cream once the halo and bloom were added on top (torch critic r2).
    float a = smoothstep(0.02, 0.12, f);
    gl_FragColor = vec4(col * uGain * a, a);
    #include <fog_fragment>
  }
`;

const GLOW_FRAG = /* glsl */`
  uniform float uTime;
  uniform float uGlow;
  varying vec2 vUv;
  varying float vPh;
  varying float vAspect;
  #include <common>
  #include <fog_pars_fragment>
  ${COMMON}
  void main() {
    // the card is centred on the flame; uv (0.5,0.5) is the halo's centre
    vec2 q = (vUv - 0.5) * vec2(1.0, vAspect);          // round, whatever the card's shape
    float t = uTime + vPh;
    float r = length(q) * 2.0;
    float halo = r < 1.0 ? (1.0 - r) * (1.0 - r) : 0.0;
    vec3 col = vec3(1.0, 0.45, 0.12) * halo * 0.18 * flicker(t, vPh * 0.37) * uGlow;
    // embers: three sparks lifting off the tip, drifting, cooling from yellow to red
    for (int i = 0; i < 3; i++) {
      float fi = float(i);
      float k = t / 1.6 + fi * 0.37 + fh(vec2(vPh, fi)) * 0.5;
      float life = fract(k), seed = floor(k) + fi * 7.1 + vPh;
      vec2 ep = vec2((fh(vec2(seed, 1.0)) - 0.5) * 0.10 + sin(life * 6.0 + seed) * 0.05 * life,
                     0.15 + life * 0.65);            // q units: from the tip up the card
      float d = length((q - ep) * vec2(1.0, 0.45));  // squashed along the path: a streak
      float e = smoothstep(0.006, 0.0, d) * (1.0 - life) * (1.0 - life) * step(0.15, fh(vec2(seed, 3.0)));
      col += mix(vec3(1.0, 0.55, 0.15), vec3(0.7, 0.12, 0.02), life) * e * 0.9;
    }
    if (max(col.r, max(col.g, col.b)) < 0.002) discard;
    gl_FragColor = vec4(col, 1.0);
    #include <fog_fragment>
  }
`;

function mk(THREE, vert, frag, uTime, extra, additive) {
  const m = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, extra]),
    vertexShader: vert, fragmentShader: frag,
    transparent: true, depthWrite: false, fog: true,
    blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending, premultipliedAlpha: !additive,
    // Double-sided: the card is built facing the camera in the shader, but a
    // mirrored parent (the character's hand bones) makes three flip the
    // winding, and the held torch's flame was silently back-face culled.
    side: THREE.DoubleSide,
  });
  m.uniforms.uTime = uTime;               // shared clock object, not a copy
  m.defines = { NO_RANGE_FOG: '' };
  return m;
}
export function makeFlameMaterial(THREE, { uTime, gain = 1.15 } = {}) {
  return mk(THREE, VERT(true), FLAME_FRAG, uTime, { uGain: { value: gain } }, false);
}
export function makeGlowMaterial(THREE, { uTime, glow = 1.0 } = {}) {
  return mk(THREE, VERT(false), GLOW_FRAG, uTime, { uGlow: { value: glow } }, true);
}
// The flame card: 1 wide, 1 tall, root at y = 0 — scale sets the flame's size.
export function makeFlameGeometry(THREE) {
  const g = new THREE.PlaneGeometry(1, 1, 1, 4);
  g.translate(0, 0.5, 0);
  return g;
}
// The glow card: 1 x 1, centred — scale sets the halo's size.
export function makeGlowGeometry(THREE) {
  return new THREE.PlaneGeometry(1, 1);
}
