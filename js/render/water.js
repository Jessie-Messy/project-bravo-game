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
//   2. Coverage is NOT free distance-from-bank, however much it looks like it
//      should be. That claim used to sit here and it is what every failed
//      version of this shader was built on — see the measurement below. The
//      depth ramp is driven off wideCov() instead. Still no second pass and no
//      depth texture read anywhere in here.
//
// The mask stores the same value in R, G and B (alphaMap sampled GREEN, so
// green is the channel with the guarantee behind it). We sample .g.
//
// ⚠⚠ MEASURED, and it overturns the note in HANDOFF.md that has caused two
// regressions here. HANDOFF says "coverage only spans ~0.52-0.75, never near
// 1.0". That is true of the *water field* (`_wField`, floored at WFIELD_KEEP)
// and it is NOT the number this shader reads. paintWaterMask puts the field
// through the WEDGE remap — `v = (cov - 0.5)/0.16 + 0.5`, clamped — before it
// writes a texel, and that remap sends anything at or above field 0.58 to a
// solid 255.
//
// Histogram of the mask over a 80x80-tile block containing the river at tile
// 248,353: 11900 non-zero texels, of which 10202 (86%) sit in the top bucket at
// exactly 1.0, the rest spread thinly and evenly across 0..0.95. A transect
// across the channel reads 0, 0.05, 0.66, 0.84, then 1.0 for thirty-odd texels,
// then 0.97, 0.69, 0.29, 0.06, 0.
//
// So coverage is effectively BINARY with a ~3-texel (three-quarters of a tile)
// antialias fringe. It is a silhouette, not a shore-distance signal, and every
// previous attempt to key a depth ramp off it could only ever paint a hairline
// at the bank and one flat colour everywhere else — which is exactly what the
// river looked like. `wideCov()` below builds the real distance-from-bank the
// ramp needs, by blurring the mask over several tiles with a handful of extra
// taps. Re-measure with the histogram above before touching any ramp; do not
// trust either this comment or HANDOFF's on faith.

const DEFAULTS = {
  waterLayers: 2,
  waterGlint: true,
  waterFresnel: true,
  waterFoam: true,
};

// Opacity is a RAMP now, not the old single 0.92 that matched the original
// MeshBasicMaterial. The river is meant to read as water you can see the
// riverbed through at the edges, and one flat value can only ever be a sheet of
// coloured glass — see the alpha note at the bottom of the fragment shader.
// ⚠ MEASURED, and it bounds how translucent this surface is allowed to be.
// Hiding the water quad entirely (traverse for material.name === 'water', set
// visible = false) shows what is underneath: paintTerrainRegion paints WATER
// tiles as flat dark navy on the ground canvas, at tile resolution, so the bed
// is a 45-degree STAIRCASE — the exact blockiness the mask-driven quad exists to
// hide. The first attempt at "translucent enough to suggest a bed" used 0.62 at
// the bank and the river came back looking like the bed shot with no water in
// it at all: the staircase read straight through, and the navy paint is so
// close to the deep stop that the surface itself became invisible.
// So the shallows stay nearly opaque and the sense of a bed underneath is
// carried by colour and caustics instead. If the ground painter is ever changed
// to paint the riverbed with its nearest ground type (grass/sand, which
// groundUnder already computes) rather than navy, drop SHORE_ALPHA back toward
// 0.7 and the water will genuinely read as see-through.
const SHORE_ALPHA = 0.88;   // bank: a little of the bed tints it, no more
const DEEP_ALPHA  = 0.97;   // channel: opaque, so the indigo stays saturated

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
// Tune live with _dev.water({shallow, deep, lo, hi, caustic, print, shore,
// shoreA, deepA}); defaults below. ⚠ lo/hi are stops on the BLURRED distance
// field from wideCov(), which is a real 0..1 signal — NOT on raw coverage,
// which is a silhouette. The warning in HANDOFF.md and in game3d.js's _dev.water
// comment ("set hi below ~0.8 or the whole surface pins to deep") applies to the
// old raw-coverage ramp and is wrong for these.
uniform vec3  uDeepCol;
uniform vec3  uShallowCol;
uniform float uDepthLo;
uniform float uDepthHi;

// Extra painterly controls, all live-tunable through _dev.water({...}) for the
// same reason the palette is: matching a painted reference is guess-and-look,
// and a recompile per guess is hopeless.
uniform float uCaustic;        // strength of the light streaks
uniform float uPrintMix;       // how much of the wave print survives into albedo
uniform float uShoreA;         // alpha at the bank (bed shows through)
uniform float uDeepA;          // alpha in the channel
uniform float uShore;          // strength of the soft shore wash (was "foam")

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

// Distance-from-bank, which the raw mask does NOT give us (see the mask
// contract note at the top: coverage is binary with a three-quarter-tile
// fringe). Blurring the mask over a few tiles turns that silhouette back into
// the shore gradient the depth ramp needs: a texel is only "deep" when its
// whole neighbourhood out to ~3 tiles is also water, so a narrow creek stays
// turquoise for its full width while a broad channel earns its indigo centre.
//
// Two rings rather than one wide ring: the inner ring carries the first tile of
// falloff (which is where the eye reads the bank) and the outer one keeps the
// gradient going long enough to cross a river. Eight taps of a tiny, extremely
// cache-friendly texture on a single quad — no second pass, no depth read.
//
// The tap offsets are in TILES, converted through uMapRepeat: the print's
// repeat is (MAP_W*0.5, MAP_H*0.5) tiles-per-uv, so one tile is 0.5/uMapRepeat
// in uv. Deriving it this way rather than hardcoding a uv step is what keeps
// this correct on any map size — water.js is never told MAP_W or TILE.
float wideCov( vec2 uv, float cov ) {
  vec2 st = 0.5 / max( uMapRepeat, vec2( 1e-5 ) );
  // Radii set the WIDTH of the shoal, and the first pass had them too tight:
  // at 1.6/3.6 tiles the inner ring saturates a tile and a half in, so the
  // turquoise came out as a bright rim hugging the bank with the mid tones
  // squeezed into a few pixels. Pushed out, the gradient spans about five tiles
  // — most of this river's width — and the teal middle is where the eye lands.
  const float RI = 2.4;   // inner ring radius, tiles
  const float RO = 5.2;   // outer ring radius, tiles

  vec2 di = st * RI * 0.7071;
  float inner = texture2D( uMaskMap, uv + vec2(  di.x,  di.y ) ).g
              + texture2D( uMaskMap, uv + vec2( -di.x,  di.y ) ).g
              + texture2D( uMaskMap, uv + vec2(  di.x, -di.y ) ).g
              + texture2D( uMaskMap, uv + vec2( -di.x, -di.y ) ).g;

  vec2 dou = st * RO;
  float outer = texture2D( uMaskMap, uv + vec2( dou.x, 0.0 ) ).g
              + texture2D( uMaskMap, uv + vec2( -dou.x, 0.0 ) ).g
              + texture2D( uMaskMap, uv + vec2( 0.0, dou.y ) ).g
              + texture2D( uMaskMap, uv + vec2( 0.0, -dou.y ) ).g;

  // 0.28 + 4*0.09 + 4*0.09 == 1.0 exactly, so open water still reaches the top
  // of the ramp and the DEEP colour stays reachable.
  return cov * 0.28 + ( inner + outer ) * 0.09;
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

  vec2 p = vWorld.xz;

  // -- Depth ------------------------------------------------------
  // Off the blurred mask, not off cov — cov is a silhouette (see the top).
  float dist = wideCov( vMapUv, cov );

  // One octave of very low-frequency noise breaks the depth boundary before it
  // is ramped. Without it the turquoise-to-indigo transition is a perfect
  // offset curve parallel to the bank, which reads as an airbrushed gradient;
  // a painter varies the channel edge, so the shoal wanders in and out by a
  // tile or so. This is the single cheapest thing in the shader that makes it
  // look hand-painted rather than generated.
  // Two scales, not one: the broad octave moves the whole shoal in and out over
  // tens of tiles, the tighter one gives the boundary a brush-edge wobble. With
  // only the broad octave the transition is still a clean curve, just a wonkier
  // one, and it keeps reading as an airbrush.
  dist += ( wNoise( p * 0.0042 ) - 0.5 ) * 0.26
        + ( wNoise( p * 0.0180 ) - 0.5 ) * 0.09;

  float depth = smoothstep( uDepthLo, uDepthHi, dist );
  vec3 depthCol = mix( uShallowCol, uDeepCol, depth );

  // Multiplying the print into the ramp was the first attempt and it crushed
  // the shallows to mud, because the print is mostly dark navy by area. Mixing
  // keeps the teal, and the cream wave caps get added back on top so they
  // still pop the way the artwork intends.
  // Weight dropped from a flat 0.45: at that level the print's big pale wave
  // caps dominate the surface and read as fog banks lying on the river, which
  // fights the depth ramp we just built. It now contributes texture, not
  // colour — and it is pulled back further in the shallows, where the ramp is
  // doing the work and the print only muddies the turquoise.
  vec3 albedo = mix( depthCol, texel, uPrintMix * mix( 0.55, 1.0, depth ) );
  albedo += smoothstep( 0.62, 0.98, texL ) * 0.09;

  // -- Ripple normal -----------------------------------------------
  // Two trains at different wavelengths, speeds and directions. One layer on
  // its own slides as a single sheet no matter how it is tuned; the second is
  // what makes the surface read as moving water. Low tier drops it (uLayer2).
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

  // -- Caustic light streaks ---------------------------------------
  // The painterly cue the reference actually has: pale ribbons of light lying
  // ALONG the current, not the isotropic sparkle a specular lobe gives.
  //
  // Anisotropy is the whole trick. The noise is sampled in a frame aligned to
  // the flow, with the along-flow axis squashed ~5x relative to the across-flow
  // one, so its features come out as long streaks instead of blobs. Sampling
  // isotropic noise and thresholding it gives leopard spots — tried, and it
  // reads as scum on the surface rather than light in the water.
  //
  // Threshold high and narrow: caustics are a small bright fraction of the
  // area. A gentle threshold produces an all-over milky haze, which is the
  // failure mode the old wave-print mix already had.
  vec2 fdir = normalize( vec2( 0.86, 0.51 ) );
  vec2 q = vec2( dot( p, fdir ) * 0.0031, dot( p, vec2( -fdir.y, fdir.x ) ) * 0.0110 );
  float cn = wNoise( q * 6.0 + vec2( uTime * 0.085, uTime * 0.02 ) )
           + wNoise( q * 13.0 - vec2( uTime * 0.130, 0.0 ) ) * 0.5;
  // Sparser and shorter than the first attempt (5:1 anisotropy, threshold from
  // 0.86): those streaks ran bank to bank and combed the whole river into
  // parallel smears that read as motion blur. A patch mask on top clusters them
  // into a few lit passages with quiet water between, which is how a painter
  // spaces them — an even distribution is the tell that it is a noise field.
  // ⚠ Named clump, not patch: 'patch' is a RESERVED WORD in GLSL ES and the
  // fragment shader fails to compile with nothing but "Illegal use of reserved
  // word" in the console. node --check is happy — the shader is a string.
  float clump = smoothstep( 0.34, 0.72, wNoise( p * 0.0060 + vec2( uTime * 0.012, 0.0 ) ) );
  float streak = smoothstep( 0.93, 1.30, cn ) * mix( 0.25, 1.0, clump );

  // Keep the light OFF the outermost fringe. Caustics peak in the shallows, and
  // the shallowest strip of all is the half-tile against the bank — leaving
  // them at full strength there rebuilds the bright shore line by accident,
  // which is the one thing the reference must not have.
  streak *= smoothstep( 0.06, 0.32, dist );

  // Caustics are light that reached the BED and bounced, so they belong in the
  // shallows and have to die off toward the channel — carrying them into the
  // deep water is what makes a stylised river read as a shiny plastic sheet.
  // They also only exist while the sun does.
  vec3 causticCol = mix( vec3( 0.55, 1.00, 0.92 ), uSunColor, 0.35 );
  col += causticCol * streak * uCaustic * mix( 1.0, 0.28, depth ) * uDayF;

  // -- Shore wash ---------------------------------------------------
  // This replaces the foam band, and the change is a deliberate rejection of
  // the old idea rather than a retune. Any band keyed off cov is confined to
  // the three-texel antialias fringe (see the mask contract), so however it was
  // tinted it drew a hairline along the bank — a highlighter pen, which is the
  // one thing the reference explicitly does not have.
  //
  // What a painter puts there instead is a wide, soft lightening of the
  // shallows: the same turquoise, paler and more luminous, fading out over a
  // couple of tiles with no edge of its own. So it is keyed off the blurred
  // distance field, not off cov, and it is a colour LIGHTENING with no white in
  // it at all. The slow lap only breathes it in and out; it never draws a line.
  float shoreAlpha = 0.0;
  if ( uFoam > 0.5 ) {
    float wob = wNoise( p * 0.0125 + vec2( uTime * 0.055, uTime * -0.037 ) )
              + wNoise( p * 0.0410 - vec2( uTime * 0.021, uTime *  0.048 ) ) * 0.5;
    float lap = 0.72 + 0.28 * sin( uTime * 0.55 + dot( p, vec2( 0.0080, 0.0113 ) ) );
    // Wide ramp, and it starts INSIDE the water rather than at the contour, so
    // the brightest part of the wash sits a tile in and the very edge is left
    // alone. Edge-brightest is precisely what reads as surf.
    float wash = ( 1.0 - smoothstep( 0.16, 0.62, dist + ( wob / 1.5 - 0.5 ) * 0.10 ) )
               * smoothstep( 0.0, 0.30, dist ) * lap;

    // 1.35x plus a lift made the bank glow like a neon strip once the depth
    // ramp was already painting it turquoise — the wash was double-counting the
    // shallows. It only needs to be a shade paler than what is under it.
    vec3 washCol = mix( uShallowCol * 1.12 + vec3( 0.01, 0.03, 0.03 ), uSunColor, 0.12 )
                 * mix( 0.22, 1.0, uDayF );
    col = mix( col, washCol, clamp( wash * uShore, 0.0, 1.0 ) );
    shoreAlpha = wash * 0.05;
  }

  // -- Alpha -------------------------------------------------------
  // Coverage multiplies in as the outermost factor. Every term above can only
  // scale what is already inside the painted bank, so the silhouette is
  // byte-for-byte the shape the old alphaMap produced.
  //
  // Opacity now RAMPS WITH DEPTH instead of being one flat 0.92. That single
  // change is what suggests a bed: the ground painter (buildGroundUnder) fills
  // the riverbed with the nearest real ground type, so letting the shallows go
  // translucent lets that bed tint the turquoise while the channel stays solid.
  // A uniform 0.92 everywhere is why the river read as a coloured ribbon laid
  // on top of the world rather than as water sitting in it.
  float alpha = cov * clamp( mix( uShoreA, uDeepA, depth ) + shoreAlpha + fres * 0.06, 0.0, 1.0 );

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

    uLayer2:  { value: ( s.waterLayers | 0 ) >= 2 ? 1 : 0 },
    uGlint:   { value: s.waterGlint ? 1 : 0 },
    uFresnel: { value: s.waterFresnel ? 1 : 0 },
    uFoam:    { value: s.waterFoam ? 1 : 0 },
    // Linear-space defaults: sRGB #48d8cf shallow, a mid indigo deep. The ramp
    // stops match the REAL coverage range a river occupies (~0.52-0.75), not
    // 0..1 -- see the note in HANDOFF.md; assuming 0..1 pins the whole surface
    // to the deep stop and makes the shallow colour unreachable.
    uShallowCol: { value: new THREE.Vector3( 0.0900, 0.7200, 0.6400 ) },
    // Nudged up and slightly toward violet: the reference channel is LUMINOUS
    // indigo, and against a bright turquoise bank the old value read as a
    // near-black trough rather than deep water.
    uDeepCol:    { value: new THREE.Vector3( 0.0320, 0.0620, 0.3400 ) },
    // Stops are on the BLURRED distance field (wideCov), which really is a
    // 0..1 signal — unlike raw coverage, which is a silhouette. The ramp starts
    // early so the banks hold turquoise for a tile or two, and ends just short
    // of 1 so a wide channel actually reaches the indigo.
    uDepthLo:    { value: 0.34 },
    uDepthHi:    { value: 0.92 },

    // Print weight is low and stays low: what remains of it at 0.16 is surface
    // texture, and anything above ~0.25 brings back the big pale wave caps that
    // read as fog banks lying on the water.
    uCaustic:  { value: 0.14 },
    uPrintMix: { value: 0.16 },
    uShoreA:   { value: SHORE_ALPHA },
    uDeepA:    { value: DEEP_ALPHA },
    uShore:    { value: 0.16 },
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
    // The painterly knobs ride the same hook rather than getting a _dev entry
    // of their own — game3d.js passes this object straight through, so
    // extending it here needs no change outside this module.
    if(o.caustic !== undefined) U.uCaustic.value  = o.caustic;
    if(o.print   !== undefined) U.uPrintMix.value = o.print;
    if(o.shoreA  !== undefined) U.uShoreA.value   = o.shoreA;
    if(o.deepA   !== undefined) U.uDeepA.value    = o.deepA;
    if(o.shore   !== undefined) U.uShore.value    = o.shore;
    return { shallow:U.uShallowCol.value.toArray().map(n=>+n.toFixed(3)),
             deep:U.uDeepCol.value.toArray().map(n=>+n.toFixed(3)),
             lo:U.uDepthLo.value, hi:U.uDepthHi.value,
             caustic:U.uCaustic.value, print:U.uPrintMix.value,
             shoreA:U.uShoreA.value, deepA:U.uDeepA.value, shore:U.uShore.value };
  }
  return { material, update, setSettings, setPalette, dispose };
}
