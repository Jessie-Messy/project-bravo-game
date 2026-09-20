// fire.js — makes a baked flame model burn.
//
// The campfire, torch and lantern are GLB models whose flames are ordinary
// geometry with an EMISSIVE MAP: the flame texels are bright in that map and
// the logs are black. Nothing moved, so a campfire was a photograph of a fire.
//
// That emissive map is the whole trick here. It is already a per-texel mask of
// "this part is on fire", so the flame can be animated without tagging vertices,
// splitting the mesh, or authoring anything new — sample it in the VERTEX shader
// and the same mask that makes the flame glow also decides what may move. The
// logs are black in it, so they are excluded for free, and the same patch works
// on any model built this way without per-model tuning.
//
// This file MOVES the flame and nothing else. It does not change how bright the
// flame is — that made the torch visibly throb, which looks like a dimmer, not
// like fire. Brightness variation lives on the PointLight the flame casts.
//
// Everything is one shared program. These are InstancedMeshes drawing every
// campfire in the world in a single call, so a per-fire material would multiply
// draw calls by the number of fires. Per-instance variety comes from the
// instance matrix's own translation instead: fires in different places curl at
// different phases, so a row of them does not move in unison.

/**
 * @param material        the GLB's MeshStandardMaterial (must have emissiveMap)
 * @param uniforms.uFireTime  shared { value } clock, seconds
 * @param topY            local-space Y of the top of the model, for the taper
 * @param sway            lateral travel at the flame tip, in local units
 */
export function animateFire(material, { uFireTime, topY = 36, sway = 1.0 } = {}) {
  if (!material || !material.emissiveMap) return material;

  const uFireTopY = { value: topY };
  const uFireSway = { value: sway };

  material.onBeforeCompile = (shader) => {
    shader.uniforms.uFireTime = uFireTime;
    shader.uniforms.uFireTopY = uFireTopY;
    shader.uniforms.uFireSway = uFireSway;

    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
        uniform sampler2D emissiveMap;
        uniform float uFireTime;
        uniform float uFireTopY;
        uniform float uFireSway;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        {
          // The mask. smoothstep rather than a hard cut so the base of the
          // flame, where it meets the wood and the map fades out, is anchored
          // instead of shearing away from the logs it is sitting on.
          vec3 em = texture2D( emissiveMap, uv ).rgb;
          float flame = smoothstep( 0.20, 0.70, max( em.r, max( em.g, em.b ) ) );

          // Height taper on top of the mask: a flame is pinned at its root and
          // free at its tip, so the tip travels and the base does not.
          float h = clamp( transformed.y / max( uFireTopY, 0.001 ), 0.0, 1.0 );
          float w = flame * h * h;

          // Per-instance phase from where the instance actually stands, so two
          // campfires side by side do not flicker as one object. Constant for a
          // given fire, so it never shimmers as the window re-windows.
          float ph = 0.0;
          #ifdef USE_INSTANCING
            ph = dot( instanceMatrix[3].xyz, vec3( 0.031, 0.0, 0.047 ) );
          #endif
          float t = uFireTime + ph;

          // Two rates: a fast curl at the tips and a slower lean, so it reads as
          // fire rather than as a flag. The vertical term is what makes the
          // flame lick upward instead of only swaying.
          float curl = sin( t * 6.1 + transformed.y * 0.9 ) * 0.65
                     + sin( t * 9.7 + transformed.x * 1.3 ) * 0.35;
          float lean = sin( t * 1.9 ) * 0.5 + sin( t * 2.7 + 1.3 ) * 0.3;
          transformed.x += ( curl + lean ) * uFireSway * w;
          transformed.z += ( sin( t * 7.3 + transformed.z * 1.1 ) * 0.7 + lean * 0.6 ) * uFireSway * w;
          transformed.y += ( 0.55 + 0.45 * sin( t * 8.3 + ph ) ) * uFireSway * 0.9 * w;

        }`);

    // The flame's own BRIGHTNESS is deliberately left alone. A pulse here made
    // the torch itself throb, which reads as a light bulb on a dimmer rather
    // than as fire. Flicker belongs to the light a flame CASTS — see
    // flameFlicker() in game3d.js, which drives the PointLight. The geometry
    // only moves; it does not brighten.
  };

  // Two materials with the same parameters but different patches must not share
  // a compiled program.
  material.customProgramCacheKey = () => 'fire-anim-v1';
  material.needsUpdate = true;
  return material;
}
