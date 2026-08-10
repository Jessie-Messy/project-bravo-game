// water.js — the river surface material.
//
// What this replaces: a MeshBasicMaterial with map + alphaMap. Basic is
// *unlit*, so the river read as a sticker at every hour of the day — same
// brightness at midnight as at noon, no glint, no reflection, no sense that
// the surface had a normal at all. Everything else in the scene reacts to the
// day cycle, so the water was the one thing that gave the frame away.
//
// It is a standalone ShaderMaterial rather than an onBeforeCompile patch on
// MeshStandardMaterial. Water needs three things — a perturbed normal, one
// sun highlight, and a fresnel-weighted sky reflection — and the full PBR
// stack charges for a lot more than that (IBL diffuse, AO, clearcoat plumbing,
// the whole lights_fragment_begin loop over point lights the river never
// touches). Hand-written GLSL is both cheaper and far easier to tune here.
//
// The mesh, the geometry and the two textures all still live in game3d.js.
// This module takes them as arguments and imports nothing from the game —
// no `map`, no `player`, no TILE. Everything arrives through the argument
// object, THREE included.

// ── The mask contract ─────────────────────────────────────────────
// wMaskTex is the whole reason this shader can be as cheap as it is. It is
// built in game3d.js by blurring the binary water field and thresholding it
// through the ground's warp, with a deliberately soft contour (WEDGE = 0.16).
// Two consequences we lean on hard:
//
//   1. Coverage IS the silhouette. The painted bank and the walkability map
//      agree only because both read the same field, so whatever this shader
//      does, coverage must still be a straight multiplier on the final alpha.
//      Bend the silhouette and the visual stops matching what you can swim in.
//
//   2. Coverage is ALSO free distance-from-bank. The WEDGE ramp is a
//      normalised shore gradient that has already been paid for: 1.0 deep
//      inside the river, falling through the ramp as it crosses the bank.
//      That is exactly the signal a depth prepass would go and fetch, so the
//      depth colour ramp and the foam band are both driven off it and there
//      is no second pass and no depth texture read anywhere in here.
//
// The mask stores the same value in R, G and B (alphaMap sampled GREEN, so
// green is the channel with the guarantee behind it). We sample .g.

const DEFAULTS = {
  waterLayers: 2,
  waterGlint: true,
  waterFresnel: true,
  waterFoam: true,
};

// Matches the old MeshBasicMaterial's opacity. The river is meant to read as
// water you can see the riverbed through at the edges, not as glass.
const BASE_OPACITY = 0.92;

const VERT = /* glsl */`
varying vec2 vMapUv;
varying vec3 vWorld;

#include <fog_pars_vertex>

void main() {
  // The quad is FOUR VERTICES covering the whole render window, and its uv
  // attribute is global map coordinates (0..1 across the entire world), not
  // 0..1 across the quad. That is what keeps the wave pattern at a fixed
  // world scale as the window slides with the player -- but it also means
  // there is almost nothing to interpolate from. So we hand the fragment
  // shader real world XZ as well: ripple scale and the view vector both need
  // world units, and deriving them from a 4-vertex uv would be guesswork.
  vMapUv = uv;

  vec4 worldPos = modelMatrix * vec4( position, 1.0 );
  vWorld = worldPos.xyz;

  // Named mvPosition because <fog_vertex> reads exactly that identifier.
  vec4 mvPosition = viewMatrix * worldPos;
  #include <fog_vertex>

  gl_Position = projectionMatrix * mvPosition;
}
`;

const FRAG = /* glsl */`
#include <common>
#include <cube_uv_reflection_fragment>
#include <fog_pars_fragment>

uniform sampler2D uMap;        // the Hokusai wave print
uniform sampler2D uMaskMap;    // coverage; GREEN channel
uniform sampler2D uEnvMap;     // PMREM CubeUV, only sampled when uEnvOn > 0.5
uniform vec2  uMapRepeat;
uniform vec2  uMapOffset;

uniform float uTime;
uniform vec3  uSunDir;         // normalised, points TO the sun
uniform vec3  uSunColor;
uniform float uDayF;           // 0 night .. 1 day
uniform vec3  uCamPos;
uniform float uEnvOn;
uniform float uOpacity;

// Quality switches. Uniform floats rather than #defines on purpose: the tier
// system can demote mid-session (the watchdog does exactly that after a bad
// two seconds), and a #define swap means a shader recompile -- a visible hitch
// at the precise moment we have decided the machine is already struggling.
// None of these gate anything expensive enough to be worth that.
uniform float uLayer2;         // 0 = single ripple layer (low tier), 1 = two
uniform float uGlint;
uniform float uFresnel;
uniform float uFoam;

varying vec2 vMapUv;
varying vec3 vWorld;

// Deep is the print's own base navy (#0f2447) taken to linear; shallow is
// warmer and lighter so the banks read as knee-deep rather than as the same
// cold channel water pushed up against the grass.
// Repainted toward the illustrated reference: bright turquoise shallows falling
// to a cool indigo in the channel, rather than navy-to-teal. Values are LINEAR
// (sRGB #48d8cf and #1d2a6b), so they look darker here than the hex suggests.
// The shallow end is deliberately far brighter than the deep end -- that spread
// is what makes a river read as water over a visible bed instead of a flat
// coloured ribbon.
// DEEP is a mid indigo-blue, NOT a near-black navy. In the reference even the
// channel centre stays luminous; darkening it just produces a black ribbon.
// Palette and ramp are UNIFORMS, not constants: matching a painted reference is
// iterative, and recompiling to try a colour means a full reload per guess.
// Tune live with _dev.water({shallow, deep, lo, hi}); defaults below.
uniform vec3  uDeepCol;
uniform vec3  uShallowCol;
uniform float uDepthLo;
uniform float uDepthHi;

// Coverage -> depth. The ramp only occupies the WEDGE band, so both stops sit
// inside it; pushing the far stop to 1.0 flattened the whole river to "deep"
// because most of the surface is pinned at coverage 255.
// Same correction as the foam band below: the reachable coverage range on this
// map's rivers is roughly 0.52-0.75, not 0.34-0.90, because the field is
// blurred and then floored at WFIELD_KEEP. With the old stops a river never
// got past the shallow half of the ramp and read uniformly pale.
// ⚠ Retuned AGAIN, and the reason is the one already recorded in HANDOFF.md:
// real river coverage only spans ~0.52-0.75, because the field is blurred then
// floored at WFIELD_KEEP. With the ramp ending at 0.66 nearly the whole river
// sat at or past the DEEP stop, so repainting SHALLOW changed nothing visible
// and repainting DEEP darkened the entire river. The ramp now STARTS at the
// bottom of the real range and ends far beyond its top, so the surface spends
// most of its width in the turquoise half and only the middle approaches deep.


// Foam sits just INSIDE the bank. The painted contour is at coverage 0.5,
// where the quad is already half transparent -- foam centred there mostly
// faded out before you could see it, so the band is biased deeper.
// These sit BELOW the 0.5 contour, not above it. The original 0.50-0.94 band
// assumed coverage reaches ~1.0 in open water, which is true for a lake and
// false for every river on this map: buildWaterField blurs with WFIELD_R=1 and
// then floors real water tiles at WFIELD_KEEP=0.52, so a 2-3 tile river sits at
// roughly 0.52-0.70 across its whole width. That put the entire river inside
// the foam band and painted it white like pack ice.
// Foam belongs on the shallow ramp seaward of the contour, i.e. below 0.52.
const float FOAM_LO = 0.16;
const float FOAM_HI = 0.54;

float wHash( vec2 p ) {
  return fract( sin( dot( p, vec2( 127.1, 311.7 ) ) ) * 43758.5453123 );
}

float wNoise( vec2 p ) {
  vec2 i = floor( p );
  vec2 f = fract( p );
  vec2 u = f * f * ( 3.0 - 2.0 * f );
  return mix( mix( wHash( i ),                    wHash( i + vec2( 1.0, 0.0 ) ), u.x ),
              mix( wHash( i + vec2( 0.0, 1.0 ) ), wHash( i + vec2( 1.0, 1.0 ) ), u.x ), u.y );
}

// Gradient of one directional ripple train, in world XZ.
//
// The crest direction is cross-modulated by a slow travelling sine so the
// crests bend instead of marching as parallel bars -- a plain sin(dot(p,dir))
// looks like corrugated iron from the game's near-overhead camera. The cross
// term's own derivative is deliberately dropped: it costs another cos() and
// the error it leaves behind is extra wobble in the normal, which is the
// thing we were adding the term to get.
vec2 rippleGrad( vec2 p, vec2 dir, float wavelen, float speed ) {
  float k = 6.2831853 / wavelen;
  float bend = sin( dot( p, vec2( -dir.y, dir.x ) ) * k * 0.37 + uTime * 0.31 ) * 1.7;
  float phase = dot( p, dir ) * k + uTime * speed + bend;
  return dir * cos( phase );
}

// Sky reflection when no PMREM env map is available -- early in load, or if
// the caller hands us something that is not a CubeUV texture. Two-stop ramp
// on the reflected ray's elevation, crossfaded to a night sky by uDayF.
vec3 skyRamp( vec3 r ) {
  float up = clamp( r.y * 0.5 + 0.5, 0.0, 1.0 );
  vec3 dayC   = mix( vec3( 0.55, 0.66, 0.82 ), vec3( 0.20, 0.38, 0.70 ), up );
  vec3 nightC = mix( vec3( 0.045, 0.060, 0.105 ), vec3( 0.015, 0.025, 0.060 ), up );
  return mix( nightC, dayC, uDayF );
}

void main() {
  // -- Coverage: silhouette and shore distance in one fetch --------
  float cov = texture2D( uMaskMap, vMapUv ).g;
  if ( cov <= 0.0 ) discard;   // outside the painted bank; nothing else to do

  // -- Albedo ------------------------------------------------------
  // waterTex carries its own repeat (MAP_W*0.5, MAP_H*0.5) so one pattern
  // spans 2x2 tiles. Applying it here rather than trusting a built-in map slot keeps
  // the world scale identical to the old material -- and keeps working if the
  // in-game skin editor repaints the canvas underneath us.
  vec3 texel = texture2D( uMap, vMapUv * uMapRepeat + uMapOffset ).rgb;
  float texL = dot( texel, vec3( 0.2126, 0.7152, 0.0722 ) );

  float depth = smoothstep( uDepthLo, uDepthHi, cov );
  vec3 depthCol = mix( uShallowCol, uDeepCol, depth );

  // Multiplying the print into the ramp was the first attempt and it crushed
  // the shallows to mud, because the print is mostly dark navy by area. Mixing
  // keeps the teal, and the cream wave caps get added back on top so they
  // still pop the way the artwork intends.
  vec3 albedo = mix( depthCol, texel, 0.45 );
  albedo += smoothstep( 0.55, 0.95, texL ) * 0.16;

  // -- Ripple normal -----------------------------------------------
  // Two trains at different wavelengths, speeds and directions. One layer on
  // its own slides as a single sheet no matter how it is tuned; the second is
  // what makes the surface read as moving water. Low tier drops it (uLayer2).
  vec2 p = vWorld.xz;
  vec2 grad  = rippleGrad( p, normalize( vec2( 0.86, 0.51 ) ), 340.0, 1.35 ) * 1.00;
  grad      += rippleGrad( p, normalize( vec2( -0.44, 0.90 ) ), 129.0, -2.05 ) * 0.55 * uLayer2;

  // The 3.4 flattens the normal -- the raw gradient gives a surface far too
  // choppy for a river seen from a near-overhead camera, and the glint turned
  // into television static.
  vec3 N = normalize( vec3( -grad.x, 3.4, -grad.y ) );
  vec3 V = normalize( uCamPos - vWorld );
  vec3 L = uSunDir;

  // -- Lighting ----------------------------------------------------
  // Wrapped diffuse rather than a straight N.L: water is thin and scatters,
  // and a hard terminator on a nearly flat plane just banded.
  float wrap = clamp( ( dot( N, L ) + 0.35 ) / 1.35, 0.0, 1.0 );

  // Ambient still has to exist at night or the river becomes a black hole in
  // a scene that is lit by moonlight -- but it goes cold and dim, which is
  // what makes the night cycle land on the water at all.
  vec3 ambient = mix( vec3( 0.055, 0.075, 0.115 ), vec3( 0.36, 0.40, 0.44 ), uDayF );
  vec3 col = albedo * ( ambient + uSunColor * wrap * 0.90 * uDayF );

  // -- Sun glint ---------------------------------------------------
  // The single biggest "that is water" cue. Tight Blinn-Phong lobe for the
  // sparkle, plus a much broader low-strength lobe so there is a general
  // sheen down the sunward side instead of isolated fireflies.
  vec3 H = normalize( L + V );
  float ndh = max( dot( N, H ), 0.0 );
  float spec  = pow( ndh, 220.0 ) * 1.60;
  float sheen = pow( ndh, 22.0 ) * 0.11;
  col += uSunColor * ( spec + sheen ) * uDayF * uGlint;

  // -- Fresnel + sky reflection ------------------------------------
  // Schlick with water's F0 = 0.02: near-zero looking straight down, near-one
  // at the grazing angles you get across the far half of the render window.
  float fres = 0.02 + 0.98 * pow( 1.0 - clamp( dot( N, V ), 0.0, 1.0 ), 5.0 );
  fres *= uFresnel;

  if ( fres > 0.0 ) {
    vec3 R = reflect( -V, N );
    vec3 refl = skyRamp( R );
    #ifdef ENVMAP_TYPE_CUBE_UV
      // Real PMREM sample. The roughness is not 0 on purpose -- a mirror sky
      // on a rippled surface aliases badly at this camera distance, and a
      // blurred mip reads more like water anyway.
      if ( uEnvOn > 0.5 ) refl = textureCubeUV( uEnvMap, R, 0.28 ).rgb;
    #endif
    // The env map is baked once from a daylight sky and does not know about
    // the day cycle (game3d dims it per-material via envMapIntensity, which
    // only Standard materials honour), so it gets the same treatment here.
    refl *= mix( 0.16, 1.0, uDayF );
    col = mix( col, refl, fres * 0.72 );
  }

  // -- Shoreline foam ----------------------------------------------
  // Straight smoothstep on coverage gives a perfect outline of the bank --
  // technically correct, visually a highlighter pen. Two things break it up:
  // noise pushes the band in and out along the shore, and a slow travelling
  // sine makes the whole thing surge, so it reads as lapping rather than as
  // a static ring drawn around the river.
  float foamAlpha = 0.0;
  if ( uFoam > 0.5 ) {
    float wob = wNoise( p * 0.0125 + vec2( uTime * 0.055, uTime * -0.037 ) )
              + wNoise( p * 0.0410 - vec2( uTime * 0.021, uTime *  0.048 ) ) * 0.5;
    // Wobble scaled down with the band — +/-0.17 against a 0.38-wide band
    // smeared foam right back across the interior it was just pulled out of.
    float cc = cov + ( wob / 1.5 - 0.5 ) * 0.09
             + sin( dot( p, vec2( 0.0210, -0.0173 ) ) + uTime * 1.10 ) * 0.018;

    float band = smoothstep( FOAM_LO, FOAM_LO + 0.16, cc )
               * ( 1.0 - smoothstep( FOAM_HI - 0.22, FOAM_HI, cc ) );
    float lap = 0.55 + 0.45 * sin( uTime * 0.90 + dot( p, vec2( 0.0080, 0.0113 ) ) );
    float foam = band * mix( 0.60, 1.0, lap );

    // Foam picks up the sun's tint so it goes amber at dusk with everything
    // else, and never brighter than the ambient allows at night.
    // The painted reference has NO white surf line -- the shore is a bright
    // turquoise shallow that just gets paler, so the foam is retuned from
    // whitewater into a light aquamarine wash and its strength cut by more than
    // half. A white band at this saturation reads as sea foam on a river.
    vec3 foamCol = mix( vec3( 0.62, 0.93, 0.88 ), uSunColor, 0.18 ) * mix( 0.22, 1.0, uDayF );
    col = mix( col, foamCol, clamp( foam * 0.16, 0.0, 1.0 ) );

    // Whitewater is denser than open water. Still multiplied by coverage
    // below, so the silhouette is untouched.
    foamAlpha = clamp( foam * 0.14, 0.0, 0.16 );
  }

  // -- Alpha -------------------------------------------------------
  // Coverage multiplies in as the outermost factor. Every term above can only
  // scale what is already inside the painted bank, so the silhouette is
  // byte-for-byte the shape the old alphaMap produced.
  float alpha = cov * clamp( uOpacity + foamAlpha + fres * 0.06, 0.0, 1.0 );

  gl_FragColor = vec4( col, alpha );

  // ShaderMaterial gets none of this for free -- the built-in materials call
  // these chunks explicitly at the end of their own main(). Without them the
  // river would skip ACES and the sRGB write and sit in a different colour
  // space from every other surface in the frame.
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

// ── PMREM CubeUV plumbing ─────────────────────────────────────────
// three only injects CUBEUV_TEXEL_WIDTH / _HEIGHT / _MAX_MIP for materials it
// recognises as having an envMap slot, which a hand-rolled ShaderMaterial does
// not have. Rather than pretend to be a Standard material and hope the
// internals cooperate, we compute the same three numbers ourselves (this is
// generateCubeUVSize from WebGLProgram, verbatim) and declare them as our own
// defines. <cube_uv_reflection_fragment> is guarded by ENVMAP_TYPE_CUBE_UV, so
// with the defines absent the whole thing compiles out and the shader falls
// through to skyRamp().
function cubeUVDefines( THREE, envMap ) {
  if ( ! envMap || envMap.mapping !== THREE.CubeUVReflectionMapping ) return null;
  const h = envMap.image && envMap.image.height;
  if ( ! h || ! isFinite( h ) ) return null;

  const maxMip = Math.log2( h ) - 2;
  const texelHeight = 1.0 / h;
  const texelWidth = 1.0 / ( 3 * Math.max( Math.pow( 2, maxMip ), 7 * 16 ) );
  return {
    ENVMAP_TYPE_CUBE_UV: '',
    CUBEUV_TEXEL_WIDTH: texelWidth,
    CUBEUV_TEXEL_HEIGHT: texelHeight,
    // Must land in the shader as a float literal, hence the forced decimal.
    CUBEUV_MAX_MIP: Number.isInteger( maxMip ) ? maxMip + '.0' : maxMip.toFixed( 6 ),
  };
}

function sameDefines( a, b ) {
  if ( ! a || ! b ) return a === b;
  const ka = Object.keys( a );
  if ( ka.length !== Object.keys( b ).length ) return false;
  for ( const k of ka ) if ( a[ k ] !== b[ k ] ) return false;
  return true;
}

/**
 * Build the river material.
 *
 * @param {object}  args
 * @param {object}  args.THREE      the three namespace (never imported here)
 * @param {object}  args.renderer   WebGLRenderer — anisotropy caps only
 * @param {object}  args.waterTex   the wave-print CanvasTexture
 * @param {object}  args.maskTex    the coverage CanvasTexture (green channel)
 * @param {object}  args.settings   a quality.js tier settings object
 * @returns {{ material:object, update:Function, setSettings:Function, dispose:Function }}
 */
export function createWaterMaterial( { THREE, renderer, waterTex, maskTex, settings } ) {
  const s = Object.assign( {}, DEFAULTS, settings || {} );

  // UniformsLib.fog MUST be merged in whenever a raw ShaderMaterial sets
  // `fog: true`. three's refreshFogUniforms() reaches straight for
  // uniforms.fogColor / fogNear / fogFar / fogDensity with no guard, so
  // including the <fog_*> chunks without these throws
  // "Cannot read properties of undefined (reading 'value')" once per frame per
  // draw — which aborts the render loop and leaves the whole canvas black.
  // The built-in materials get this merge for free; ShaderMaterial does not.
  const uniforms = Object.assign( {}, THREE.UniformsLib.fog, {
    uMap:       { value: waterTex || null },
    uMaskMap:   { value: maskTex || null },
    uEnvMap:    { value: null },
    uMapRepeat: { value: new THREE.Vector2( 1, 1 ) },
    uMapOffset: { value: new THREE.Vector2( 0, 0 ) },

    uTime:     { value: 0 },
    uSunDir:   { value: new THREE.Vector3( 0.5, 0.8, 0.33 ).normalize() },
    uSunColor: { value: new THREE.Color( 0xfffde0 ) },
    uDayF:     { value: 1 },
    uCamPos:   { value: new THREE.Vector3() },
    uEnvOn:    { value: 0 },
    uOpacity:  { value: BASE_OPACITY },

    uLayer2:  { value: ( s.waterLayers | 0 ) >= 2 ? 1 : 0 },
    uGlint:   { value: s.waterGlint ? 1 : 0 },
    uFresnel: { value: s.waterFresnel ? 1 : 0 },
    uFoam:    { value: s.waterFoam ? 1 : 0 },
    // Linear-space defaults: sRGB #48d8cf shallow, a mid indigo deep. The ramp
    // stops match the REAL coverage range a river occupies (~0.52-0.75), not
    // 0..1 -- see the note in HANDOFF.md; assuming 0..1 pins the whole surface
    // to the deep stop and makes the shallow colour unreachable.
    uShallowCol: { value: new THREE.Vector3( 0.0900, 0.7200, 0.6400 ) },
    uDeepCol:    { value: new THREE.Vector3( 0.0250, 0.0500, 0.2750 ) },
    uDepthLo:    { value: 0.52 },
    uDepthHi:    { value: 1.15 },
  } );

  if ( waterTex && waterTex.repeat ) uniforms.uMapRepeat.value.copy( waterTex.repeat );
  if ( waterTex && waterTex.offset ) uniforms.uMapOffset.value.copy( waterTex.offset );

  const material = new THREE.ShaderMaterial( {
    uniforms,
    vertexShader: VERT,
    fragmentShader: FRAG,
    // These three are load-bearing for render order, not cosmetic. The mesh is
    // renderOrder 1 with frustumCulled off and it draws over the terrain and
    // the bridge decks; writing depth would punch a hole in everything the
    // transparent pass draws after it, and DoubleSide keeps the surface alive
    // when the camera pitches under the waterline at the far zoom stops.
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    fog: true,
  } );
  material.name = 'water';

  // Anisotropy on the print matters more here than anywhere else in the scene:
  // the quad is a ground plane seen at a very shallow angle across most of the
  // screen, which is the exact case bilinear filtering smears into porridge.
  if ( waterTex && renderer && renderer.capabilities ) {
    const maxAniso = renderer.capabilities.getMaxAnisotropy();
    if ( waterTex.anisotropy < maxAniso ) { waterTex.anisotropy = maxAniso; waterTex.needsUpdate = true; }
  }

  let envDefines = null;
  let envTex = null;
  let envH = -1;

  function applyEnv( envMap ) {
    // Height is part of the identity check, not just the object: the CubeUV
    // atlas layout is baked into the defines, so a re-bake at a different
    // skyPmremSize has to be caught even in the (unlikely) case the sky module
    // hands back a texture we have already seen.
    const h = envMap && envMap.image ? envMap.image.height : -1;
    if ( envMap === envTex && h === envH ) return;
    envTex = envMap || null;
    envH = h;

    const next = cubeUVDefines( THREE, envTex );
    uniforms.uEnvMap.value = next ? envTex : null;
    uniforms.uEnvOn.value = next ? 1 : 0;

    // Only recompile when the atlas dimensions actually move. The sky re-bakes
    // every few seconds on the higher tiers (skyRebakeSec) and hands back a
    // fresh texture each time at the same size — recompiling on every one of
    // those would hitch the frame for no visual difference at all.
    if ( sameDefines( envDefines, next ) ) return;
    envDefines = next;
    material.defines = next ? Object.assign( {}, next ) : {};
    material.needsUpdate = true;
  }

  function update( opts ) {
    if ( ! opts ) return;

    if ( typeof opts.t === 'number' ) uniforms.uTime.value = opts.t;
    if ( opts.sunDir ) uniforms.uSunDir.value.copy( opts.sunDir );
    if ( opts.sunColor ) uniforms.uSunColor.value.copy( opts.sunColor );
    if ( typeof opts.dayF === 'number' ) uniforms.uDayF.value = opts.dayF;
    if ( opts.cameraPos ) uniforms.uCamPos.value.copy( opts.cameraPos );

    // envMap is legitimately null for the first frames of the load, and the
    // sky module swaps it for a new texture on every re-bake, so this is
    // re-checked every frame rather than wired up once.
    applyEnv( opts.envMap || null );

    // The skin editor can repaint waterTex and change its repeat underneath
    // us; keeping these in sync per frame is two float compares.
    const t = uniforms.uMap.value;
    if ( t ) {
      if ( t.repeat ) uniforms.uMapRepeat.value.copy( t.repeat );
      if ( t.offset ) uniforms.uMapOffset.value.copy( t.offset );
    }
  }

  function setSettings( next ) {
    if ( ! next ) return;
    Object.assign( s, next );
    // Pure uniform writes — no recompile, so the watchdog's mid-session demote
    // costs nothing on the frame it lands.
    uniforms.uLayer2.value  = ( s.waterLayers | 0 ) >= 2 ? 1 : 0;
    uniforms.uGlint.value   = s.waterGlint ? 1 : 0;
    uniforms.uFresnel.value = s.waterFresnel ? 1 : 0;
    uniforms.uFoam.value    = s.waterFoam ? 1 : 0;
  }

  function dispose() {
    // Only the material. waterTex, maskTex and the env map are all owned by
    // the caller and outlive any single material instance.
    material.dispose();
    uniforms.uMap.value = null;
    uniforms.uMaskMap.value = null;
    uniforms.uEnvMap.value = null;
  }

  // Live palette control for matching reference art without a rebuild.
  function setPalette(o){
    o = o || {};
    const U = material.uniforms;
    const toLin = hex => {                    // sRGB hex -> linear vec3
      const c = new THREE.Color(hex); c.convertSRGBToLinear();
      return new THREE.Vector3(c.r, c.g, c.b);
    };
    if(o.shallow !== undefined) U.uShallowCol.value.copy(toLin(o.shallow));
    if(o.deep    !== undefined) U.uDeepCol.value.copy(toLin(o.deep));
    if(o.lo      !== undefined) U.uDepthLo.value = o.lo;
    if(o.hi      !== undefined) U.uDepthHi.value = o.hi;
    return { shallow:U.uShallowCol.value.toArray().map(n=>+n.toFixed(3)),
             deep:U.uDeepCol.value.toArray().map(n=>+n.toFixed(3)),
             lo:U.uDepthLo.value, hi:U.uDepthHi.value };
  }
  return { material, update, setSettings, setPalette, dispose };
}
