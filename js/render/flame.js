// flame.js — a real-looking fire for torches, campfires and lanterns.
//
// The flames were additive spheres: an orange ball on a stick, the same from
// every side, and still, because moving the ball made the torch "breathe". The
// owner's verdict on v0.21.0 torches: "the animation sucks and the light
// source sucks, it looks wonky".
//
// This is a camera-facing card drawn with a procedural flame: a teardrop body
// whose outline is eaten away by noise scrolling UP (so tongues lick upward,
// break off and vanish), a white-yellow core, orange body, deep red tips, and a
// few embers rising above it. The card faces the camera about the vertical
// axis only, so a flame stays upright however you look at it, and its base is
// pinned while its tip is free.
//
// Brightness does NOT pulse (that read as a dimmer, see fire.js); what moves is
// the SHAPE. The light it casts flickers separately (flameFlicker in game3d).
//
// Instanced: one draw for every placed flame in the world. Per-instance phase
// comes from the instance's position, so neighbours never move in step.

const VERT = /* glsl */`
  uniform float uTime;
  varying vec2 vUv;
  varying float vPh;
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
    // cylindrical billboard: face the camera about Y, stay upright
    vec3 toCam = cameraPosition - wc; toCam.y = 0.0;
    vec3 right = normalize(vec3(toCam.z, 0.0, -toCam.x) + 1e-5);
    // a gentle sway of the whole tip; the base stays put
    float lean = (sin(uTime * 1.7 + vPh) * 0.6 + sin(uTime * 3.1 + vPh * 1.3) * 0.4) * uv.y * uv.y * 0.18;
    vec3 wp = wc + right * ((position.x + lean) * sx) + vec3(0.0, 1.0, 0.0) * (position.y * sy);
    vec4 mv = viewMatrix * vec4(wp, 1.0);
    gl_Position = projectionMatrix * mv;
    #include <fog_vertex>
  }
`;

const FRAG = /* glsl */`
  uniform float uTime;
  uniform float uGain;
  varying vec2 vUv;
  varying float vPh;
  #include <common>
  #include <fog_pars_fragment>
  float fh(vec2 p){ vec3 q = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); q += dot(q, q.yzx + 33.33); return fract((q.x + q.y) * q.z); }
  float fn(vec2 p){ vec2 i = floor(p), f = fract(p); f = f*f*(3.0-2.0*f);
    return mix(mix(fh(i), fh(i+vec2(1,0)), f.x), mix(fh(i+vec2(0,1)), fh(i+vec2(1,1)), f.x), f.y); }
  float fbm(vec2 p){ return fn(p) * 0.55 + fn(p * 2.1 + 3.7) * 0.30 + fn(p * 4.3 + 9.1) * 0.15; }
  void main() {
    // uv: x across -0.5..0.5 (card is 1 wide), y 0 at the root .. 1 at the top
    vec2 p = vec2(vUv.x - 0.5, vUv.y);
    float t = uTime + vPh;
    // noise scrolling upward, faster higher up: tongues rise and tear away
    float n = fbm(vec2(p.x * 3.2, p.y * 2.2 - t * 2.6));
    float n2 = fbm(vec2(p.x * 6.0 + 4.0, p.y * 4.0 - t * 4.1));
    // wobble the column sideways more toward the tip
    float wob = (n2 - 0.5) * 0.22 * p.y;
    float x = p.x + wob;
    // teardrop: wide at ~0.25, pinched to a point at the top, rounded base
    float halfW = 0.34 * smoothstep(0.0, 0.18, p.y) * (1.0 - smoothstep(0.25, 1.0, p.y) * 0.92);
    float body = 1.0 - smoothstep(halfW * 0.55, halfW, abs(x));
    // the outline is eaten away by the noise, more so at the top
    float erode = mix(0.18, 0.78, smoothstep(0.1, 0.95, p.y));
    float f = body * smoothstep(erode - 0.18, erode + 0.12, n + (1.0 - p.y) * 0.35);
    if (f < 0.01) discard;
    // colour by "heat": the core (low, central) is near white, then yellow,
    // orange and deep red at the ragged tips
    float heat = clamp(f * (1.15 - p.y * 0.9) * (1.0 - abs(x) / max(halfW, 1e-3) * 0.6), 0.0, 1.0);
    vec3 col = mix(vec3(0.55, 0.05, 0.0), vec3(1.0, 0.32, 0.03), smoothstep(0.05, 0.40, heat));
    col = mix(col, vec3(1.0, 0.72, 0.22), smoothstep(0.40, 0.70, heat));
    col = mix(col, vec3(1.0, 0.95, 0.75), smoothstep(0.72, 0.95, heat));
    gl_FragColor = vec4(col * f * uGain, 1.0);
    #include <fog_fragment>
  }
`;

// The card: 1 wide, 1 tall, root at y = 0 — scale sets the flame's size.
export function makeFlameMaterial(THREE, { uTime, gain = 2.2 } = {}) {
  const m = new THREE.ShaderMaterial({
    uniforms: THREE.UniformsUtils.merge([THREE.UniformsLib.fog, { uGain: { value: gain } }]),
    vertexShader: VERT, fragmentShader: FRAG,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, fog: true,
  });
  m.uniforms.uTime = uTime;               // shared clock object, not a copy
  m.defines = { NO_RANGE_FOG: '' };
  return m;
}
export function makeFlameGeometry(THREE) {
  const g = new THREE.PlaneGeometry(1, 1, 1, 4);
  g.translate(0, 0.5, 0);
  return g;
}
