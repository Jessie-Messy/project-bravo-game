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
//   2. Coverage is NOT distance-from-bank, though this shader used to assume
//      it was. The WEDGE ramp is an ANTIALIASING wedge about one texel wide,
//      not a shore gradient: measured off the built mask, 86.5% of water
//      texels sit at coverage >= 0.95 and a bank crossing reads
//      0, 0.06, 0.53, 1, 1, ... So a depth ramp keyed to coverage was pinned
//      at "deep" across every river on the map, and a foam band keyed to it
//      evaluated to zero everywhere. Both were dead code for as long as they
//      existed.
//
//      Depth now comes from a chamfer distance transform that game3d.js bakes
//      into the mask's RED channel: 0 at the painted contour, 1.0 three tiles
//      in. Still one fetch, still no prepass and no depth texture -- the two
//      signals just live in two channels instead of being conflated into one.
//
// So: RED is distance from the bank, GREEN is coverage. Green is the channel
// with the silhouette guarantee behind it (alphaMap sampled green, and the
// wading test reads the same field), so bend anything else you like but never
// that one.

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
const vec3 DEEP_COL    = vec3( 0.0261, 0.0648, 0.0684 );
const vec3 SHALLOW_COL = vec3( 0.0703, 0.2051, 0.2158 );


// sin()-free. The classic sin(dot(...)) hash costs a transcendental per corner,
// which is four per noise lookup, and this shader now wants a dozen lookups a
// pixel for the bed and the caustics. Three multiplies and a fract distribute
// at least as well and leave the headroom to spend there instead.
float wHash( vec2 p ) {
  vec3 q = fract( vec3( p.xyx ) * vec3( 0.1031, 0.1030, 0.0973 ) );
  q += dot( q, q.yzx + 33.33 );
  return fract( ( q.x + q.y ) * q.z );
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
//
// The footprint argument is how many world units one screen pixel covers here.
// A ripple train finer than the pixels sampling it CANNOT be drawn: below the
// Nyquist limit the cosine is being point-sampled at less than two samples per
// wave and what comes out is an alias -- broad moire bars marching across the
// river, the "zebra stripes at distance" this fade exists to remove.
//
// It shows up at grazing angles rather than at great range. Seen from overhead
// the water plane is face-on and a pixel covers a couple of world units; from a
// low camera the plane goes nearly edge-on, the footprint along the view
// direction explodes, and a single pixel spans several whole wavelengths.
// fwidth() captures exactly that, which is why the fade keys off it rather than
// off distance to the camera.
//
// Fading to a flat normal is the correct answer, not a compromise: the mean of
// a ripple train over an area larger than its wavelength IS flat water.
vec2 rippleGrad( vec2 p, vec2 dir, float wavelen, float speed, float footprint ) {
  float fade = 1.0 - smoothstep( wavelen * 0.125, wavelen * 0.40, footprint );
  if ( fade <= 0.0 ) return vec2( 0.0 );
  float k = 6.2831853 / wavelen;
  float bend = sin( dot( p, vec2( -dir.y, dir.x ) ) * k * 0.37 + uTime * 0.31 ) * 1.7;
  float phase = dot( p, dir ) * k + uTime * speed + bend;
  return dir * cos( phase ) * fade;
}

// ---- The riverbed -------------------------------------------------------
// There is no bed to look at: the water is a four-vertex quad at y=2 and the
// terrain painted under it is flat blue. So the bottom is generated here.
//
// That is not a shortcut around repainting the terrain, it is the better place
// for it. A bed that lives in this shader can be sampled at an OFFSET position
// -- which is what refraction is -- and the caustics can be multiplied into it
// rather than smeared over the surface on top of everything else.
// The weighting matters more than the colours. Putting 0.46 of it on the
// coarsest octave produced big smooth light-and-dark swirls that read as
// polished marble rather than as gravel -- most of the visual weight has to sit
// on detail too fine to make out individual shapes in, or the bed stops being a
// surface and becomes a pattern.
vec3 bedAlbedo( vec2 q ) {
  float coarse = wNoise( q * 0.030 );           // silt banks, ~33 units across
  float mid    = wNoise( q * 0.115 + 11.3 );    // gravel patches
  float grain  = wNoise( q * 0.360 +  4.7 );    // individual stones
  float v = coarse * 0.28 + mid * 0.40 + grain * 0.32;
  vec3 silt   = vec3( 0.090, 0.076, 0.055 );
  vec3 gravel = vec3( 0.150, 0.132, 0.100 );
  return mix( silt, gravel, smoothstep( 0.32, 0.70, v ) ) * ( 0.86 + 0.26 * grain );
}

// ---- Caustics -----------------------------------------------------------
// The bright shifting web on the bottom of shallow water: sunlight focused by
// the lenses the surface ripples make. Computing that honestly means tracing
// light through the surface, so instead this takes the zero set of the
// difference of two drifting noise fields -- a closed, branching, wandering
// network of thin lines, which is the shape caustics have -- and sharpens it.
//
// The two fields drift in different directions at different rates, so the web
// reorganises continuously instead of sliding across the bed as a rigid
// pattern, and it never repeats.
float causticWeb( vec2 q, float t ) {
  float a = wNoise( q            + vec2(  t * 0.091, t * -0.062 ) );
  float b = wNoise( q * 1.41 + 7.3 + vec2( -t * 0.074, t *  0.085 ) );
  // 7.5, not 3.6. Two smoothed noise fields are close to each other over broad
  // areas, so a shallow ridge threshold selects patches and the result is soft
  // blobs -- which is what this produced at 3.6, and blobs are the one thing
  // caustics never look like. Narrowing the ridge to where the fields actually
  // cross is what turns it into a branching web; the power then has to come
  // DOWN, or the line that is now genuinely thin gets crushed away entirely.
  float ridge = 1.0 - abs( a - b ) * 7.5;
  return pow( max( ridge, 0.0 ), 2.6 );
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
  // -- One fetch, two signals: RED depth, GREEN silhouette ---------
  vec2 mask = texture2D( uMaskMap, vMapUv ).rg;
  float cov = mask.g;
  if ( cov <= 0.0 ) discard;   // outside the painted bank; nothing else to do
  float deep = mask.r;         // 0 at the bank, 1 three tiles in

  // -- Albedo ------------------------------------------------------
  // waterTex carries its own repeat (MAP_W*0.5, MAP_H*0.5) so one pattern
  // spans 2x2 tiles. Applying it here rather than trusting a built-in map slot keeps
  // the world scale identical to the old material -- and keeps working if the
  // in-game skin editor repaints the canvas underneath us.
  vec3 texel = texture2D( uMap, vMapUv * uMapRepeat + uMapOffset ).rgb;

  // The print's weight is down from 0.45 to 0.14, and its cream wave caps are
  // no longer added on top at all. Those caps were painted highlights on a
  // surface that now has real ones, and two sets of highlights that do not
  // agree about where the crests are is most of what "fake" looks like. It
  // stays in at a low weight so the in-game skin editor still tints the river.
  vec3 body = mix( mix( SHALLOW_COL, DEEP_COL, deep ), texel, 0.14 );

  // -- Ripple normal -----------------------------------------------
  // Two trains at different wavelengths, speeds and directions. One layer on
  // its own slides as a single sheet no matter how it is tuned; the second is
  // what makes the surface read as moving water. Low tier drops it (uLayer2).
  vec2 p = vWorld.xz;
  // World units covered by one pixel, both axes. The short train falls away
  // first, which is correct -- it is the one that aliases first.
  float footprint = max( length( fwidth( p ) ), 1e-4 );
  // WAVELENGTHS ARE IN WORLD UNITS, and the world's scale is set by the hero:
  // CHAR_H is 126 units for a person, so one unit is about a centimetre and a
  // half. These three trains are therefore roughly 2m / 0.9m / 0.4m, which is
  // the range river chop actually occupies. They were 340 and 129 units -- a
  // five-metre swell and a two-metre one -- which is wrong for a channel a few
  // metres across whatever else is going on.
  //
  // Do NOT read the history here as "the wavelengths were the stripes". They
  // were not: with the camera pinned, the broad white bars survived uGlint = 0
  // and uFoam = 0 unchanged and vanished completely at uFresnel = 0. See the
  // note on the Fresnel term below for what was actually happening. Shortening
  // the trains was right on its own merits and fixed nothing on its own.
  //
  // Shortening costs nothing in stability: rippleGrad returns a unit amplitude
  // cosine (it deliberately does NOT scale by k), so the normal is exactly as
  // steep as before -- only the spatial frequency changed. And the footprint
  // fade above removes each train by itself once a pixel spans it, so the
  // finest one simply drops out at distance instead of aliasing.
  vec2 grad  = rippleGrad( p, normalize( vec2( 0.86, 0.51 ) ), 148.0, 1.15, footprint ) * 1.00;
  grad      += rippleGrad( p, normalize( vec2( -0.44, 0.90 ) ),  61.0, -1.75, footprint ) * 0.58 * uLayer2;
  grad      += rippleGrad( p, normalize( vec2( 0.30, -0.95 ) ),  26.0,  2.60, footprint ) * 0.34 * uLayer2;

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
  vec3 bodyLit = body * ( ambient + uSunColor * wrap * 0.90 * uDayF );

  // -- What you see through the surface ----------------------------
  // Beer-Lambert absorption along the downward path. The three coefficients
  // are the whole trick: red dies roughly twice as fast as green and blue, so
  // the bed loses its warmth first and the water turns blue-green as it
  // deepens. Scaling one absorption number across all channels instead would
  // give a bed that simply got darker, which reads as dim, not as deep.
  // 13% / 32% / 43% survive at full depth. Tuned live: at 3.40/1.90/1.35 the
  // bed kept 3% of its red and was gone a shore-width out, so a wide river was
  // flat in the middle again -- which is the problem this was added to solve.
  vec3 absorb = exp( -deep * vec3( 2.05, 1.15, 0.85 ) );
  vec3 col;
  if ( uLayer2 > 0.5 ) {
    // Refraction. The lateral offset of a ray crossing the surface grows with
    // both the surface slope and the distance it then travels underwater, and
    // grad IS the slope -- so displacing the bed lookup by it is the real
    // effect, not an approximation of it. The constant floor keeps a little
    // wobble in the shallows, where the path is too short to bend much but the
    // bed is the only thing you are looking at.
    vec2 bedP = p + grad * ( 8.0 + 26.0 * deep );

    // High-frequency bed detail has to fade for the same Nyquist reason the
    // ripples do -- at a grazing angle one pixel covers whole stones, and
    // point-sampling that is how you get crawling static on the riverbed.
    float bedFade = 1.0 - smoothstep( 10.0, 34.0, footprint );

    vec3 bed = mix( vec3( 0.128, 0.110, 0.077 ), bedAlbedo( bedP ), bedFade );

    // Caustics need the sun to be UP, not merely for it to be daytime: they
    // are focused sunlight, so they go with the sun's elevation and vanish at
    // dusk rather than fading with the ambient.
    float sunUp = clamp( uSunDir.y, 0.0, 1.0 );
    float web = causticWeb( bedP * 0.0285, uTime ) * 0.80
              + causticWeb( bedP * 0.0820 + 19.0, uTime * 1.37 ) * 0.42;
    // Caustics are focused sunlight, so they belong to shallow water: the
    // deeper the column, the more the focus has spread and the less of it
    // arrives. Absorption alone was not falling off fast enough to sell that.
    web *= bedFade * sunUp * uDayF * ( 1.0 - smoothstep( 0.25, 1.0, deep ) * 0.55 );

    vec3 bedLit = bed * ( ambient + uSunColor * ( 0.30 + 0.70 * sunUp ) * 0.95 * uDayF )
                // 0.17, down from 0.26. At 0.26 the web was adding more light
                // than the bed's own albedo reflects, so it stopped reading as
                // light ON something and turned the whole river milky.
                + uSunColor * web * 0.17;

    col = bedLit * absorb + bodyLit * ( 1.0 - absorb );
  } else {
    // Low tier: no bed, no caustics. Absorption still runs, so the shallows
    // still lighten toward the bank -- it just lightens toward a flat silt
    // colour instead of toward a bed you can make out.
    col = vec3( 0.115, 0.099, 0.070 ) * absorb * uDayF + bodyLit * ( 1.0 - absorb );
  }

  // -- Sun glint ---------------------------------------------------
  // The single biggest "that is water" cue. Tight Blinn-Phong lobe for the
  // sparkle, plus a much broader low-strength lobe so there is a general
  // sheen down the sunward side instead of isolated fireflies.
  vec3 H = normalize( L + V );
  float ndh = max( dot( N, H ), 0.0 );
  // 1.15, down from 1.60, where crests blew to pure white. Note this was NOT
  // the source of the broad white bars -- setting uGlint to 0 left those
  // completely intact. It is just a highlight that was too hot on its own.
  float spec  = pow( ndh, 220.0 ) * 1.15;
  // THE HAZE WAS HERE. At exponent 22, on a surface whose normal is within a
  // few degrees of straight up, with the sun overhead, this lobe sits near its
  // maximum across the WHOLE river simultaneously -- about 0.04 of flat white
  // per pixel, against a water colour whose red channel is under 0.05. It was
  // not a sheen down the sunward side, it was a veil over everything. At 60 it
  // is actually directional, and the amount drops with it.
  float sheen = pow( ndh, 60.0 ) * 0.030;
  col += uSunColor * ( spec + sheen ) * uDayF * uGlint;

  // -- Fresnel + sky reflection ------------------------------------
  // THIS IS WHERE THE WHITE STRIPES CAME FROM. Schlick is right; the normal it
  // was being handed was not. Feeding it the ripple normal means a crest that
  // tilts ~25 degrees swings dot(N,V) from about 0.3 to about 0.95, and the
  // fifth power turns that into ~10^5 in reflectance -- fully on at every crest
  // and fully off in every trough, with 72% of a bright sky mixed into the
  // "on" half. One hard white bar per crest, marching down the river.
  //
  // Damping the normal is the physically correct answer, not a fudge. The
  // reflectance a pixel should show is Schlick AVERAGED over everything inside
  // its footprint, and for ripples finer than the eye resolves at this camera
  // distance that average is close to Schlick of the mean normal. Sub-pixel
  // chop is supposed to BLUR a reflection, not chop it into bars. The glint
  // below still gets the true normal, because per-crest variation is the entire
  // point of a specular highlight and its narrow lobe makes sparkle, not bands.
  //
  // The visible consequence is the one worth having: at the shallow angles you
  // look down at nearby water, reflectance is now a couple of percent and you
  // see the bed; near the far bank it climbs and you get sky. Which is what
  // Fresnel is for.
  // A FIXED damping was not enough, because Schlick is steep at both ends. Near
  // the horizon dot(Nf,V) is around 0.15 and fres around 0.45, and a 20% ripple
  // perturbation still swings it between roughly 0.3 and 0.6 -- times 0.88 of a
  // bright sky, that is one white bar per crest again, out in the receding half
  // of a long reach. So the damping is no longer uniform: the ripple's influence
  // on the reflection falls away with both of the things that should flatten it.
  //
  //   faceOn   -- at grazing incidence the pixel footprint stretches along the
  //               view direction and covers many crests, so the reflectance to
  //               show is their average, and the average of a ripple field is
  //               flat water.
  //   refSharp -- the same Nyquist argument rippleGrad already makes for the
  //               ripples themselves, finally applied to the reflection too.
  //
  // In normal play the camera looks at nearby water with V.y around 0.7, so
  // faceOn saturates and the near field is bit-for-bit what it was.
  float faceOn   = clamp( V.y * 1.60, 0.0, 1.0 );
  float refSharp = faceOn * ( 1.0 - smoothstep( 12.0, 60.0, footprint ) );
  vec3 Nf = normalize( mix( vec3( 0.0, 1.0, 0.0 ), N, 0.20 * refSharp ) );
  float fres = 0.02 + 0.98 * pow( 1.0 - clamp( dot( Nf, V ), 0.0, 1.0 ), 5.0 );
  fres *= uFresnel;

  if ( fres > 0.0 ) {
    // Nf, not N. A crest tilted 25 degrees swings the REFLECTED DIRECTION by
    // 50, which sweeps the env map from bright horizon to darker zenith once
    // per crest -- banding just as strong as the reflectance banding above, and
    // damping only one of the two would have left half the artefact behind.
    // A blurred reflection is blurred in direction and magnitude together.
    vec3 R = reflect( -V, Nf );
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
    // Reflection also has to lose to depth: a clear shallow margin where you
    // can see gravel should not be mirroring sky as hard as the deep channel.
    col = mix( col, refl, fres * mix( 0.45, 0.88, deep ) );
  }

  // -- Shoreline foam ----------------------------------------------
  // Straight smoothstep on coverage gives a perfect outline of the bank --
  // technically correct, visually a highlighter pen. Two things break it up:
  // noise pushes the band in and out along the shore, and a slow travelling
  // sine makes the whole thing surge, so it reads as lapping rather than as
  // a static ring drawn around the river.
  float foamAlpha = 0.0;
  if ( uFoam > 0.5 ) {
    // Keyed to distance from the bank, which is a signal that now exists.
    // Keyed to coverage this was identically zero across every river on the
    // map, because coverage saturates one texel in from the contour.
    float wob = wNoise( p * 0.0125 + vec2( uTime * 0.055, uTime * -0.037 ) )
              + wNoise( p * 0.0410 - vec2( uTime * 0.021, uTime *  0.048 ) ) * 0.5;
    // The band is ~0.3 of the 3-tile ramp, so roughly a tile of whitewater.
    // The wobble is scaled to it: enough to make the edge ragged, not enough
    // to push foam out into open water.
    float s = deep + ( wob / 1.5 - 0.5 ) * 0.22;

    float band = 1.0 - smoothstep( 0.03, 0.34, s );
    float lap = 0.55 + 0.45 * sin( uTime * 0.90 + dot( p, vec2( 0.0080, 0.0113 ) ) );
    float foam = band * mix( 0.60, 1.0, lap );

    // Foam picks up the sun's tint so it goes amber at dusk with everything
    // else, and never brighter than the ambient allows at night.
    vec3 foamCol = mix( vec3( 0.78 ), uSunColor, 0.22 ) * mix( 0.22, 1.0, uDayF );
    col = mix( col, foamCol, clamp( foam * 0.38, 0.0, 1.0 ) );

    // Whitewater is denser than open water. Still multiplied by coverage
    // below, so the silhouette is untouched.
    foamAlpha = clamp( foam * 0.30, 0.0, 0.30 );
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
    // The ripple fade uses fwidth(). That is core in GLSL ES 3.00 (WebGL2) but
    // needs the extension declared on WebGL1, where a raw ShaderMaterial gets
    // nothing for free — same reason the fog uniforms have to be merged in by
    // hand above. Harmless where it is already core.
    extensions: { derivatives: true },
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

  return { material, update, setSettings, dispose };
}
