// post.js — the composer stack.
//
// Order matters and is not arbitrary:
//   RenderPass  → scene in linear HDR (half-float target, so bloom has real
//                 highlights to work with rather than clipped white)
//   Bloom       → the sparkle field and the sun on the steel edges
//   OutputPass  → tone map + sRGB, i.e. HDR becomes a picture
//   GradePass   → speed streaks, vignette, cold grade, whiteout flash. Runs
//                 AFTER tone mapping because it is a look, not lighting.
//   SMAA        → last, on the finished image, where its edge detection works
//
// The whole stack is skipped on the low tier: the renderer draws straight to
// the canvas, which is most of the win on a budget phone.

import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { SMAAPass } from 'three/addons/postprocessing/SMAAPass.js';

const GradeShader = {
  uniforms: {
    tDiffuse:   { value: null },
    uSpeed:     { value: 0 },     // 0..1, drives the radial streaks
    uFlash:     { value: 0 },     // crash whiteout
    uVignette:  { value: 0.85 },
    uCool:      { value: 0.5 },   // how far to push the shadows blue
    uAberr:     { value: 1.0 },
    uCenter:    { value: new THREE.Vector2(0.5, 0.56) },
  },
  vertexShader: /* glsl */`
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */`
    uniform sampler2D tDiffuse;
    uniform float uSpeed, uFlash, uVignette, uCool, uAberr;
    uniform vec2 uCenter;
    varying vec2 vUv;

    void main() {
      vec2 dir = vUv - uCenter;
      float r = length(dir);

      // Radial streaks. Taps are spaced by r*r so the centre of the screen
      // stays sharp — the rider never smears, only the world past them does.
      vec3 col = vec3(0.0);
      float amt = uSpeed * r * r * 0.16;
      if (amt > 0.0005) {
        float wsum = 0.0;
        for (int i = 0; i < 6; i++) {
          float t = float(i) / 5.0;
          float w = 1.0 - t * 0.72;
          col += texture2D(tDiffuse, vUv - dir * amt * t).rgb * w;
          wsum += w;
        }
        col /= wsum;
      } else {
        col = texture2D(tDiffuse, vUv).rgb;
      }

      // Chromatic aberration on the outer third only.
      float ab = uAberr * r * r * 0.0035 * (0.4 + uSpeed);
      if (ab > 0.00005) {
        col.r = texture2D(tDiffuse, vUv - dir * ab).r;
        col.b = texture2D(tDiffuse, vUv + dir * ab).b;
      }

      // Grade: lift the shadows toward blue, warm the highlights a touch. Snow
      // photographs cold in shadow and warm in sun, and matching that is most
      // of what makes a white scene look photographic instead of blown out.
      float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
      vec3 shadow = vec3(0.78, 0.86, 1.06);
      vec3 high   = vec3(1.03, 1.00, 0.96);
      col *= mix(shadow, high, smoothstep(0.18, 0.82, lum)) * (1.0 - uCool * 0.06) + uCool * 0.06;

      // Gentle S-curve for contrast without crushing the snow's detail.
      col = clamp(col, 0.0, 1.4);
      col = col * col * (3.0 - 2.0 * clamp(col, 0.0, 1.0)) * 0.34 + col * 0.66;

      // Vignette, tightened with speed so the tunnel closes in as you go faster.
      float vig = smoothstep(0.98, 0.28, r * (1.0 + uSpeed * 0.35));
      col *= mix(1.0, vig, uVignette);

      col = mix(col, vec3(1.0), uFlash);
      gl_FragColor = vec4(col, 1.0);
    }
  `,
};

export function createComposer(renderer, scene, camera, quality) {
  if (!quality.composer) return null;

  const size = renderer.getDrawingBufferSize(new THREE.Vector2());
  const target = new THREE.WebGLRenderTarget(size.x, size.y, {
    type: THREE.HalfFloatType,
    samples: quality.msaa || 0,
  });
  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));

  let bloom = null;
  if (quality.bloom) {
    bloom = new UnrealBloomPass(
      new THREE.Vector2(size.x, size.y),
      quality.bloom.strength, quality.bloom.radius, quality.bloom.threshold);
    composer.addPass(bloom);
  }

  composer.addPass(new OutputPass());

  const grade = new ShaderPass(GradeShader);
  composer.addPass(grade);

  if (quality.smaa) composer.addPass(new SMAAPass(size.x, size.y));

  return {
    composer, grade, bloom,
    render(dt) { composer.render(dt); },
    setSize(w, h) { composer.setSize(w, h); bloom?.setSize(w, h); },
    /** @param speed 0..1 normalised ride speed  @param flash 0..1 */
    setLook(speed, flash) {
      grade.uniforms.uSpeed.value = speed;
      grade.uniforms.uFlash.value = flash;
    },
    dispose() { composer.dispose(); target.dispose(); },
  };
}
