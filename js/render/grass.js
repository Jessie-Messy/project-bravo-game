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
//  * Per-blade SHAPE variation goes the other way — it belongs in
//    <begin_vertex>, in blade-local space, because "how wide is this blade" and
//    "how far does it arc" are properties of the blade and should follow its
//    spin. Same file, two opposite conventions; getting them the wrong way
//    round produces a field that either jitters (wind in local space) or leans
//    the same way regardless of spin (shape in world space). Both look like
//    bugs elsewhere.
//
// This never imports game3d.js — geometry and material only; placement and the
// windowing loop live with the tile map that owns them.

// A blade is a tapered strip. SEGMENTS controls how smoothly it can curve:
// 1 segment is a rigid quad that pivots at the root and looks like paper, 4 is
// smooth and costs 8 triangles. 3 is the knee of that curve.
// Left at 3 deliberately even though the blades now arc harder than they used
// to: 4 rows is +33% vertex work across ~200k instances, and this box renders
// under SwiftShader, so that cost cannot be honestly measured here. Don't spend
// frame time you can't measure. If someone profiles 4 on the RTX and it's free,
// take it — the arc is the only thing that wants it.
const SEGMENTS = 3;

export function makeBladeGeometry(THREE, { height = 1, width = 0.13, curve = 0.22 } = {}) {
  const rows = SEGMENTS + 1;
  const pos = [], uv = [], norm = [], idx = [];

  for (let r = 0; r < rows; r++) {
    const t = r / SEGMENTS;              // 0 at root, 1 at tip
    // Taper runs to a POINT (w = 0 at t = 1), not to the old 15%-width stub.
    // The stub is what made the field read as hard-edged: every blade ended in
    // a flat, fully-opaque cap two pixels wide, and 200k of those is 200k tiny
    // hard rectangles. A point tip plus the alpha ramp in makeBladeTexture is
    // what buys the soft top the painted reference has.
    // The exponent holds width low down and then sheds it fast — a blade, not
    // a triangle. (0.42 → relative widths 1.00 / 0.84 / 0.63 / 0.)
    const w = width * 0.5 * Math.pow(1.0 - t, 0.42);
    // A resting forward lean, so a still field still has shape in it. Without
    // this, zero wind gives you a bed of nails.
    const z = curve * t * t * height;
    // NB the "leaning costs height" correction is NOT applied here — the shader
    // scales this lean per blade (up to ~2x), so the correction has to be
    // computed after that or it is wrong for every blade but the average one.
    // See <begin_vertex> in makeGrassMaterial.
    const y = t * height;
    pos.push(-w, y, z,  w, y, z);
    uv.push(0, t,  1, t);
    // Normals face up-and-out rather than flat sideways; grass lit purely by a
    // side-facing normal goes black whenever the sun is overhead.
    // They also SPLAY sideways (±x), so the strip shades like a rounded stalk
    // instead of a flat ribbon — a free close-up round-off, since the blade
    // carries its own left/right gradient rather than one flat tone. Splay
    // fades toward the tip, where the blade is too narrow to show it.
    // MEASURED: with the old normals (~43 degrees off vertical) the sward came
    // out 22% darker than the bare ground beside it, and brightening the albedo
    // to compensate only made the blades chalky. The real cause is the diffuse
    // term — cos(43) is 0.73 of what the flat ground receives, so grass could
    // not help but sit in a lower value band than the terrain. Near-vertical
    // normals light the field like the ground it grows out of, which is what
    // makes it read as one continuous surface rather than a layer of specks
    // scattered on top. The tip keeps some forward tilt so the arc still has
    // form; the small ±x splay is what rounds a flat strip into a stalk.
    const sp = 0.30 * (1.0 - t * 0.6);
    const ny = 1.00 - 0.22 * t, nz = 0.26 + 0.30 * t;
    const nl = Math.hypot(sp, ny, nz);
    norm.push(-sp / nl, ny / nl, nz / nl,   sp / nl, ny / nl, nz / nl);
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

// The blade's own shading: a vertical gradient (cool shadowed root → warm
// sunlit tip), a lateral round-off, and an ALPHA ramp over the top of the
// blade.
// Doing this with a texture rather than in the shader means it costs one tiny
// fetch and stays visible in the shadow/depth paths that don't run our patched
// code.
//
// The alpha ramp is the reason this texture now earns its keep. The old one was
// fully opaque, so `alphaTest: 0.35` was dead code — every fragment passed and
// the blade's silhouette came entirely from geometry, i.e. a hard cut. With the
// top ~22% ramping out, two things happen: the tip rounds off instead of ending
// on an edge, and (because the ramp survives into the mips) blades DISSOLVE
// with distance instead of shrinking to hard 1px specks. That distance
// behaviour is most of what separates "meadow" from "stipple" in a wide shot.
//
// Written through ImageData rather than a canvas gradient on purpose: canvas
// compositing round-trips translucent pixels through premultiplied alpha, and
// the colour under a low alpha comes back quantised. Explicit bytes, no
// surprises — and, per the terrain bug this project already paid for once,
// EVERY pixel gets its d[i+3] written.

// The colour ramp itself. MEASURED, not guessed. In a 300x200 crop of the near field the grassed ground
// averaged luma 106 against bare terrain at 137 — the sward was reading 22%
// DARKER than the ground it covers, with a per-pixel luma stddev of 25. That
// combination is the definition of stipple: dark specks scattered over pale
// paint. Two things fix it and both are in this table.
//   1. LIFT. Every stop is ~30% brighter than the first version, so the field
//      lands just under the ground's value instead of well below it.
//   2. COMPRESS. The old root→tip span was 88→200 in luma, a 2.3x ramp inside a
//      3-pixel-tall sprite, so each blade contributed one dark pixel AND one
//      near-yellow one. Those bright tips read as sparkle, not as sunlight.
//      1.5x still gives a legible gradient close up and averages to a single
//      tone at distance, which is the whole brief.
// Don't take this much further: past here the field goes pale and chalky and
// stops reading as grass at all.
const BLADE_STOPS = [
  [0.00, 0x5d, 0x7a, 0x44],   // root: cool, shadowed by the sward around it
  [0.35, 0x6e, 0x8b, 0x48],
  [0.68, 0x7f, 0x9d, 0x52],
  [1.00, 0x9a, 0xb4, 0x69],   // sun-warmed tip — warm, but NOT a highlight
];
export function makeBladeTexture(THREE) {
  const W = 8, H = 64;
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const x = c.getContext('2d');
  const img = x.createImageData(W, H);
  const d = img.data;
  for (let py = 0; py < H; py++) {
    const t = 1 - (py + 0.5) / H;                 // 0 at root (bottom), 1 at tip
    let s = 0;
    while (s < BLADE_STOPS.length - 2 && t > BLADE_STOPS[s + 1][0]) s++;
    const a = BLADE_STOPS[s], b = BLADE_STOPS[s + 1];
    const f = Math.min(1, Math.max(0, (t - a[0]) / (b[0] - a[0])));
    // Alpha holds solid until 0.78, then eases out. Ease, not linear: a linear
    // ramp against a 0.35 test cuts at a fixed height and just shortens the
    // blade, where the ease leaves a band of part-covered mips to blur through.
    const ta = Math.max(0, (t - 0.78) / 0.22);
    const alpha = 1 - ta * ta * (3 - 2 * ta);
    for (let px = 0; px < W; px++) {
      // Symmetric edge darkening — the blade is spun to a random Y angle per
      // instance, so there is no fixed "lit side" to paint; rounding both edges
      // is the only lateral shading that survives the spin.
      const u = ((px + 0.5) / W - 0.5) * 2;
      const shade = 1 - 0.22 * u * u;
      const i = (py * W + px) * 4;
      d[i    ] = Math.round((a[1] + (b[1] - a[1]) * f) * shade);
      d[i + 1] = Math.round((a[2] + (b[2] - a[2]) * f) * shade);
      d[i + 2] = Math.round((a[3] + (b[3] - a[3]) * f) * shade);
      d[i + 3] = Math.round(alpha * 255);
    }
  }
  x.putImageData(img, 0, 0);
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
    // Gust wavenumber, and it has to be small enough that more than one gust
    // fits in the field you can see. MEASURED over the visible disc at medium
    // (radius 22 tiles): the old 0.0016 put 0.69 of a wavelength on screen —
    // one broad ramp from lull to peak across the whole view, which reads as
    // the entire meadow rising and falling as one object rather than as gusts
    // arriving. 0.0042 (~1500 units, ~31 tiles) puts 1.41 wavelengths on
    // screen, and the second, cross-modulated wave in <project_vertex> breaks
    // the front so they arrive as patches rather than as a clean stripe.
    // Live-tunable via _dev.grass({gust}); scratchpad/windprobe.mjs is the
    // measurement (a still frame cannot show you any of this).
    uGustFreq: { value: 0.0042 },
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
        // ONE varying carrying the blade's whole colour multiplier, computed in
        // the vertex shader. The fragment side is ~200k blades' worth of pixels,
        // so the rule in this file is that anything that can be a per-vertex
        // computation must be: the fragment now does a single multiply where it
        // used to do a mix and a multiply, and it gets the broad tonal
        // variation thrown in for free because interpolating a vec3 costs the
        // same as interpolating the float it replaced.
        varying vec3 vGrassMul;
        // Hash on the instance's WORLD POSITION — the only per-blade value a
        // shared geometry can see. Deliberately not sin()-based: the arguments
        // here run to five figures of world units, where sin() in a single
        // float quantises and neighbouring blades start coming out correlated.
        // That is the same class of bug as the placement-hash one recorded in
        // HANDOFF.md, and it presents the same way — visible tufting.
        float gHash( vec2 p ){
          vec3 q = fract( vec3( p.xyx ) * 0.1031 );
          q += dot( q, q.yzx + 33.33 );
          return fract( ( q.x + q.y ) * q.z );
        }
        // Smooth value noise. SMOOTH is the point: game3d.js already tints per
        // instance from a hashed 4-tile CELL, and its amplitude has to stay low
        // (0.26) because cells have seams — push it and the meadow grows visible
        // square moss blobs. Interpolated noise has no seams, so the same idea
        // can carry a much bigger swing here without drawing boundaries.
        float gNoise( vec2 p ){
          vec2 i = floor( p ), f = fract( p );
          f = f * f * ( 3.0 - 2.0 * f );
          return mix( mix( gHash( i ),                  gHash( i + vec2( 1.0, 0.0 ) ), f.x ),
                      mix( gHash( i + vec2( 0.0, 1.0 ) ), gHash( i + vec2( 1.0, 1.0 ) ), f.x ), f.y );
        }`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        // Per-blade shape variation, in BLADE-LOCAL space (unlike wind, which
        // must be world-space — see the header). Local is correct here: x is
        // the blade's own width axis and z its own lean axis, so both rotate
        // with the blade's random Y spin instead of fighting it.
        vec2 gSeed = vec2( 0.0 );
        #ifdef USE_INSTANCING
          gSeed = instanceMatrix[3].xz;
        #endif
        float gRnd  = gHash( gSeed );
        float gRnd2 = gHash( gSeed + 37.19 );
        // One geometry over 200k instances is what makes a field read as
        // manufactured. Width spread keeps a mix of fine and coarse blades
        // (mean ~0.98, so the field does not get thinner overall); the arc
        // spread is the bigger win — some blades stand up, some bow right over,
        // and the silhouette stops being one repeated stamp.
        transformed.x *= 0.72 + 0.52 * gRnd2;
        // Mean arc ~1.4x the geometry's resting lean. Raised from 1.22 after a
        // capture: this camera sits at ~57 degrees, so an upright blade presents
        // as a 1px vertical dash and an arced one presents its LENGTH — arcing
        // is what turns a field of dashes into brush strokes. The spread matters
        // as much as the mean; a uniform arc is just a differently-shaped stamp.
        transformed.z *= 0.55 + 1.70 * gRnd;
        // Arcing costs height, or the bowed blades visibly stretch.
        transformed.y -= transformed.z * transformed.z * 0.28;
        // ── Colour, all of it, once per vertex ──
        // Broad tone across the clearing: ~8 tiles per cell (1/0.0026 = 385
        // units at 48 units/tile), which is the scale you notice while walking
        // rather than while standing still, plus a per-blade jitter so the
        // patches never resolve as flat areas of one green. Warm dry
        // yellow-green at one end, deep shadowed green at the other — the swing
        // the painted reference has across a single field.
        float gTone = gNoise( gSeed * 0.0026 ) * 0.82 + gRnd2 * 0.18;
        vec3 gPatch = mix( vec3( 0.84, 0.90, 0.86 ),      // damp, shadowed
                           vec3( 1.13, 1.07, 0.82 ),      // sun-dried, warm
                           gTone );
        // Tip translucency, folded into the same multiply: light passing
        // through a leaf comes out WARM, so the lift has to carry hue or the
        // tips just go pale. Roots go slightly cool and dark in the same
        // operation — the contact shadow the sward casts on itself, free.
        vGrassMul = gPatch * mix( vec3( 0.90, 0.92, 0.88 ),
                                  vec3( 1.12, 1.10, 0.94 ), uv.y );`)
      // Wind lands here, AFTER instanceMatrix, so it is one shared world-space
      // direction instead of each blade's own local axis. See the header note.
      .replace('#include <project_vertex>', `
        vec4 mvPosition = vec4( transformed, 1.0 );
        #ifdef USE_INSTANCING
          mvPosition = instanceMatrix * mvPosition;
        #endif
        {
          // Three scales of motion.
          //
          // GUST — the slow envelope, and the thing that makes a field read as
          // weather. It must TRAVEL, so it is measured along the WIND axis and
          // advanced with time: (along*freq - uTime*1.15) is a front moving
          // downwind at 1.15/freq = ~274 units/s, about 5.7 tiles a second. The
          // old version used a fixed wave vector unrelated to uWindDir, so
          // retuning the wind direction silently left the gusts crossing the
          // field at some other angle. A second, longer wave carrying a
          // cross-wind term breaks the front up, so gusts arrive as ragged
          // patches instead of as one clean stripe sweeping the screen.
          //
          // NB: no backticks anywhere in this patch. The whole thing is a JS
          // template literal, and one backtick in a GLSL comment terminates it
          // — the error you get is "missing ) after argument list" pointing at
          // a line 60 lines away. Cost a round trip.
          vec2  wPerp = vec2( -uWindDir.y, uWindDir.x );
          float along  = dot( mvPosition.xz, uWindDir );
          float across = dot( mvPosition.xz, wPerp );
          float gust = 0.52
                     + 0.30 * sin( along * uGustFreq - uTime * 1.15 )
                     + 0.18 * sin( along * uGustFreq * 0.41 + across * uGustFreq * 0.55
                                   - uTime * 0.47 );
          // Range is ~0.04..1.00 by construction — real lulls travel through the
          // field, but it never goes negative, which would swing blades back
          // INTO the wind and read as a twitch.
          //
          // SWAY — the blade's own motion. The slow half keeps a shared,
          // position-derived phase (a gust has to be coherent or it stops
          // looking like one); the fast half gets a PER-BLADE phase. Without
          // that, the fast term is a pure function of world position and, at
          // ~4 units between blades, neighbours sit within 0.1 rad of each
          // other — the whole neighbourhood twitches in lockstep, which is
          // exactly the vibrating-carpet read.
          float ph   = dot( mvPosition.xz, vec2( 0.021, 0.017 ) );
          float sway = sin( uTime * 1.55 + ph ) * 0.62
                     + sin( uTime * 3.10 + gRnd * 6.2832 ) * 0.20;
          // CROSS-WIND — a small perpendicular wander. Pure single-axis motion
          // over a whole meadow reads mechanical however well phased it is;
          // this puts a little curl in it for one extra sin.
          float curl = sin( uTime * 0.95 + gRnd2 * 6.2832 + ph * 0.6 ) * 0.30;
          // h^2: the root stays planted and the tip travels. Linear weighting
          // slides the whole blade sideways and looks like it is skating.
          // Read straight off the attribute, not off a varying: the height
          // varying this used to borrow is gone (colour is pre-mixed in the
          // vertex shader now), and uv.y IS the blade height by construction.
          float h = uv.y * uv.y;
          mvPosition.xz += ( uWindDir * sway + wPerp * curl ) * gust * h * uWindAmt;
          // Blades shorten very slightly as they bend, which stops the tips
          // from visibly stretching at full sway.
          mvPosition.y  -= abs( sway ) * gust * h * uWindAmt * 0.18;
        }
        mvPosition = modelViewMatrix * mvPosition;
        gl_Position = projectionMatrix * mvPosition;`);

    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vGrassMul;`)
      // The entire per-blade colour treatment — tip translucency and the broad
      // tonal patches — arrives pre-mixed from the vertex shader. One multiply.
      // ⚠ This lands AFTER fog (that is where the original hook was, kept for
      // continuity), so it modulates the fogged result rather than the albedo:
      // very distant blades don't converge quite as cleanly to fog colour as
      // they should. It is not visible at the radii this system draws (22-38
      // tiles), but if the grass radius is ever pushed far enough for fog to
      // dominate, move this to <color_fragment> and re-check the tips — the
      // translucency lift is doing real work at the top of the blade and gets
      // eaten by the lighting if applied to albedo.
      .replace('#include <dithering_fragment>', `#include <dithering_fragment>
        gl_FragColor.rgb *= vGrassMul;`);
  };

  // Two materials with identical parameters but different patches must not
  // share a compiled program. Bump this whenever the patch changes, or a build
  // that mixes old and new grass materials silently reuses the wrong program.
  mat.customProgramCacheKey = () => 'grass-wind-v2';

  return { material: mat, uniforms };
}
