// grass.js — instanced, wind-animated ground cover.
//
// Deliberately NOT a full vegetation system. This map is 480x554 tiles; keeping
// blades for all of it would be a streaming problem, not a rendering one. The
// mesh here is a fixed-size instance pool that game3d.js re-windows around the
// player exactly the way it already re-windows trees and walls, so cost is
// bounded by the pool size and never by the size of the world.
//
// Two decisions worth knowing before changing anything:
//
//  * Blades DO NOT cast shadows. A depth-prepass pass over tens of thousands of
//    alpha-tested blades is the single most expensive thing this file could do,
//    and the payoff is a haze of noise on the ground. They RECEIVE shadows,
//    which is what actually matters — grass that doesn't darken under a tree
//    reads instantly as fake.
//
//  * Wind is applied AFTER instanceMatrix, in <project_vertex>, not in
//    <begin_vertex>. Each blade gets a random Y rotation, so a bend applied in
//    blade-local space would push every blade a different way and read as
//    jitter. Wind has to be one world-space direction for all of them or it
//    doesn't look like wind.
//
// This never imports game3d.js — geometry and material only; placement and the
// windowing loop live with the tile map that owns them.

// A blade is a tapered strip. SEGMENTS controls how smoothly it can curve:
// 1 segment is a rigid quad that pivots at the root and looks like paper, 4 is
// smooth and costs 8 triangles. 3 is the knee of that curve.
const SEGMENTS = 3;

export function makeBladeGeometry(THREE, { height = 1, width = 0.13, curve = 0.22 } = {}) {
  const rows = SEGMENTS + 1;
  const pos = [], uv = [], norm = [], idx = [];

  for (let r = 0; r < rows; r++) {
    const t = r / SEGMENTS;              // 0 at root, 1 at tip
    // Taper is non-linear: a blade keeps most of its width low down and then
    // narrows quickly. Linear taper reads as a triangle, not a leaf.
    const w = width * (1.0 - t * t * 0.85) * 0.5;
    const y = t * height;
    // A resting forward lean, so a still field still has shape in it. Without
    // this, zero wind gives you a bed of nails.
    const z = curve * t * t * height;
    pos.push(-w, y, z,  w, y, z);
    uv.push(0, t,  1, t);
    // Normals face up-and-out rather than flat sideways; grass lit purely by a
    // side-facing normal goes black whenever the sun is overhead.
    norm.push(0, 0.55, 0.83,  0, 0.55, 0.83);
  }
  for (let r = 0; r < SEGMENTS; r++) {
    const a = r * 2, b = a + 1, c = a + 2, d = a + 3;
    idx.push(a, c, b,  b, c, d);
  }

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv',       new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('normal',   new THREE.Float32BufferAttribute(norm, 3));
  g.setIndex(idx);
  return g;
}

// A soft vertical gradient, darker at the root. Doing this with a texture
// rather than in the shader means it costs one tiny fetch and stays visible in
// the shadow/depth paths that don't run our patched code.
export function makeBladeTexture(THREE) {
  const c = document.createElement('canvas');
  c.width = 4; c.height = 32;
  const x = c.getContext('2d');
  const g = x.createLinearGradient(0, 32, 0, 0);
  g.addColorStop(0.00, '#3f5a24');   // root, in shadow of the sward
  g.addColorStop(0.45, '#6f9438');
  g.addColorStop(1.00, '#a8c25c');   // sun-bleached tip
  x.fillStyle = g; x.fillRect(0, 0, 4, 32);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
  return t;
}

// Patched MeshStandardMaterial rather than a bespoke ShaderMaterial, so grass
// inherits shadows, fog, tone mapping and the sky's IBL for free. Rewriting
// those by hand is how vegetation ends up lit differently from the ground it
// sits on.
export function makeGrassMaterial(THREE, { map, windAmount = 1.0 } = {}) {
  const uniforms = {
    uTime:     { value: 0 },
    uWindDir:  { value: new THREE.Vector2(0.86, 0.51).normalize() },
    uWindAmt:  { value: windAmount },
    uGustFreq: { value: 0.0016 },
  };

  const mat = new THREE.MeshStandardMaterial({
    map: map || null,
    roughness: 0.92,
    metalness: 0.0,
    side: THREE.DoubleSide,   // blades are single-sided strips; both faces must light
    alphaTest: 0.35,
    vertexColors: false,
  });

  mat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        uniform float uTime;
        uniform vec2  uWindDir;
        uniform float uWindAmt;
        uniform float uGustFreq;
        varying float vBladeH;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        vBladeH = uv.y;`)
      // Wind lands here, AFTER instanceMatrix, so it is one shared world-space
      // direction instead of each blade's own local axis. See the header note.
      .replace('#include <project_vertex>', `
        vec4 mvPosition = vec4( transformed, 1.0 );
        #ifdef USE_INSTANCING
          mvPosition = instanceMatrix * mvPosition;
        #endif
        {
          // Two scales of motion. The fast term is the blade itself trembling;
          // the slow, low-frequency one is a gust crossing the field, and it is
          // the reason a field reads as weather rather than as a screensaver.
          float ph   = dot( mvPosition.xz, vec2( 0.021, 0.017 ) );
          float gust = 0.55 + 0.45 * sin( dot( mvPosition.xz, vec2( uGustFreq, uGustFreq * 0.8 ) )
                                          - uTime * 0.55 );
          float sway = sin( uTime * 1.9 + ph ) * 0.55
                     + sin( uTime * 3.3 + ph * 1.7 ) * 0.22;
          // h^2: the root stays planted and the tip travels. Linear weighting
          // slides the whole blade sideways and looks like it is skating.
          float h = vBladeH * vBladeH;
          mvPosition.xz += uWindDir * sway * gust * h * uWindAmt;
          // Blades shorten very slightly as they bend, which stops the tips
          // from visibly stretching at full sway.
          mvPosition.y  -= abs( sway ) * gust * h * uWindAmt * 0.18;
        }
        mvPosition = modelViewMatrix * mvPosition;
        gl_Position = projectionMatrix * mvPosition;`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying float vBladeH;`)
      // Cheap translucency: tips brighten as if light were passing through
      // them. Real transmission needs another lighting pass; this reads as 90%
      // of it for one multiply.
      .replace('#include <dithering_fragment>', `#include <dithering_fragment>
        gl_FragColor.rgb *= mix( 0.86, 1.16, vBladeH );`);
  };

  // Two materials with identical parameters but different patches must not
  // share a compiled program.
  mat.customProgramCacheKey = () => 'grass-wind-v1';

  return { material: mat, uniforms };
}
