// composer.js — the postprocessing stack that replaces renderer.render().
//
// Everything arrives through the argument object: THREE, the renderer, the
// scene/camera and the quality-tier settings. This module deliberately imports
// nothing from the game (no game3d.js, no state.js) so the map editor and the
// model viewer can mount the same stack without dragging the world in.
//
// The addons are pulled in with dynamic import() rather than static imports at
// the top. On the 'low' tier createComposer() returns a passthrough before it
// ever touches loadAddons(), so phones never spend a round trip — let alone the
// parse cost — on EffectComposer, SMAA's two base64 lookup textures or GTAO's
// simplex noise generator. Static imports would have downloaded all of it on
// every device regardless of tier, which is the whole thing we're avoiding.

// ── Addon module cache ────────────────────────────────────────────
// Loaded once per page and kept, because rebuild() has to be synchronous: the
// dev panel A/B-toggles tiers mid-frame and an await in there would tear the
// old passes down and leave a hole in the frame while the network settles.
// The cost of that decision is that 'medium' downloads SMAAPass and GTAOPass
// it will not use — a few KB, once, on a machine that already decided it can
// afford a composer at all. 'low' still pays nothing, which is what mattered.
let _addons = null;

async function loadAddons() {
  if (_addons) return _addons;
  const [
    { EffectComposer }, { RenderPass }, { OutputPass },
    { ShaderPass }, { FXAAShader }, { SMAAPass },
    { UnrealBloomPass }, { GTAOPass },
  ] = await Promise.all([
    import('three/addons/postprocessing/EffectComposer.js'),
    import('three/addons/postprocessing/RenderPass.js'),
    import('three/addons/postprocessing/OutputPass.js'),
    import('three/addons/postprocessing/ShaderPass.js'),
    import('three/addons/shaders/FXAAShader.js'),
    import('three/addons/postprocessing/SMAAPass.js'),
    import('three/addons/postprocessing/UnrealBloomPass.js'),
    import('three/addons/postprocessing/GTAOPass.js'),
  ]);
  _addons = { EffectComposer, RenderPass, OutputPass, ShaderPass, FXAAShader, SMAAPass, UnrealBloomPass, GTAOPass };
  return _addons;
}

// ── Passthrough ───────────────────────────────────────────────────
// The 'low' path. render() is a bare renderer.render() with no intermediate
// render target at all, which on integrated parts and phones is most of the
// reason 'low' exists. Every other method is a no-op so callers can hold this
// and the real composer through the same variable without branching.
//
// rebuild() returning false is the signal that this handle cannot become a
// real composer — the addons were never loaded, and loading them here would
// mean going async. A caller that wants to promote low → high re-runs
// createComposer(); a real composer's rebuild() returns true.
function makePassthrough(renderer, scene, camera) {
  return {
    render() { renderer.render(scene, camera); },
    setSize() {},
    setPixelRatio() {},
    rebuild() { return false; },
    dispose() {},
    passes() { return []; },
  };
}

/**
 * Build the postprocessing chain.
 *
 * @param {object}  o
 * @param {object}  o.THREE     the three namespace (never imported here)
 * @param {object}  o.renderer  WebGLRenderer — its toneMapping / outputColorSpace
 *                              / antialias belong to the caller and are not touched
 * @param {object}  o.scene
 * @param {object}  o.camera
 * @param {object}  o.settings  a quality tier from quality.js
 * @param {object}  o.fxGroup   Group holding every additive/transparent effect,
 *                              hidden for the duration of the GTAO prepass
 * @returns {Promise<{render:Function,setSize:Function,setPixelRatio:Function,
 *                    rebuild:Function,dispose:Function,passes:Function}>}
 */
export async function createComposer({ THREE, renderer, scene, camera, settings, fxGroup }) {
  if (!settings || settings.composer === false) return makePassthrough(renderer, scene, camera);

  const A = await loadAddons();

  // Size bookkeeping is kept here rather than read back off the renderer each
  // time, because composerScale means the composer's size and the renderer's
  // size are not the same number and reading the wrong one is silent.
  let cssW = 1, cssH = 1;
  {
    const s = renderer.getSize(new THREE.Vector2());
    cssW = Math.max(1, s.width);
    cssH = Math.max(1, s.height);
  }
  let pixelRatio = renderer.getPixelRatio() || 1;

  let composer = null;
  let names = [];
  let bypass = false;      // set when rebuild() is handed a composer:false tier
  let active = settings;

  // ── Opaque output ───────────────────────────────────────────────
  // The page sits on a #1b1712 CSS background. If the last pass writes an
  // alpha below 1 into the default framebuffer, that brown bleeds through the
  // canvas and the whole frame goes muddy.
  //
  // In practice this game creates its renderer without `alpha`, and three
  // defaults that to false, so the drawing buffer has no alpha channel to get
  // wrong — the canvas composites as opaque no matter what the shader writes.
  // We verify that rather than assume it, because someone adding `alpha: true`
  // for a transparent-canvas experiment would otherwise get a bug that only
  // shows up as "the game looks brownish" with nothing obvious to blame.
  function forceOpaqueOutput() {
    let hasAlphaChannel = true;
    try {
      const attrs = renderer.getContext().getContextAttributes();
      hasAlphaChannel = !attrs || attrs.alpha !== false;
    } catch (_) { /* context lost or a wrapped GL — assume the worst and patch */ }
    if (!hasAlphaChannel) return;

    const last = composer.passes[composer.passes.length - 1];
    const mat = last && (last.material || last.materialBlend);
    if (!mat) { console.log('[composer] alpha-enabled context and no patchable final material; output may not be opaque'); return; }
    // Replace RGB, saturate alpha. src.a is 1 coming off an opaque scene
    // background, so One+One clamps the destination to 1 whatever it held.
    mat.transparent = false;
    mat.blending = THREE.CustomBlending;
    mat.blendEquation = THREE.AddEquation;
    mat.blendSrc = THREE.OneFactor;
    mat.blendDst = THREE.ZeroFactor;
    mat.blendEquationAlpha = THREE.AddEquation;
    mat.blendSrcAlpha = THREE.OneFactor;
    mat.blendDstAlpha = THREE.OneFactor;
    mat.needsUpdate = true;
    console.log('[composer] alpha-enabled drawing buffer — forcing opaque final blend');
  }

  // ── Build ───────────────────────────────────────────────────────
  function build(cfg) {
    active = cfg;
    names = [];

    const scale = Math.min(2, Math.max(0.25, +cfg.composerScale || 1));
    // EffectComposer stores width/height in CSS pixels and multiplies by its
    // own pixel ratio when it sizes targets, so composerScale folds in here
    // once and every pass downstream inherits it.
    const bufW = Math.max(1, Math.round(cssW * scale));
    const bufH = Math.max(1, Math.round(cssH * scale));

    // r160's EffectComposer already defaults its two swap targets to
    // HalfFloatType, which is exactly what bloom needs to have highlights
    // above 1.0 left to work with — no custom render target required.
    composer = new A.EffectComposer(renderer);

    composer.addPass(new A.RenderPass(scene, camera));
    names.push('RenderPass');

    // AO before bloom. Bloom after AO would pick up the darkened creases and
    // smear them, and worse, AO applied after bloom darkens the glow itself —
    // fire in a corner ended up looking like it was sooting the wall.
    if (cfg.gtao) {
      const gtao = new A.GTAOPass(scene, camera, bufW, bufH, undefined, {
        // screenSpaceRadius makes `radius` a multiple of ~100 screen pixels'
        // worth of world distance at the sampled depth, instead of a world
        // unit. That matters a lot here: the world is measured in TILEs with a
        // 60000 far plane, so the stock 0.25-world-unit radius samples a
        // region smaller than a pebble and produces literally nothing.
        radius: 1.0,
        screenSpaceRadius: true,
        distanceExponent: 1.5,
        distanceFallOff: 1.0,
        thickness: 1.0,
        scale: 1.0,
        samples: 16,
      });

      // ── The GTAO transparency problem ───────────────────────────
      // GTAOPass renders its own normal+depth prepass with an override
      // material. Its built-in overrideVisibility() only skips Points and
      // Lines — transparent:true meshes go straight in. This game has ~8
      // additive effect materials (flames, portal sheets, spark systems, altar
      // glows) plus the transparent water quad, and in the prepass they write
      // the normal of a flat billboard and a depth in front of everything, so
      // the ground behind a campfire got a hard AO shadow shaped like the
      // flame sprite. There is no layer mask on the pass to exclude them with.
      //
      // The caller reparents all of it under fxGroup, so hiding that one node
      // for the duration of the pass is enough. It has to survive an exception
      // mid-render — leaving the effects hidden would silently delete every
      // flame in the game for the rest of the session — hence try/finally.
      //
      // Note this composes correctly with GTAOPass's own visibility cache:
      // overrideVisibility() runs inside baseRender and caches fxGroup as
      // already-false, restoreVisibility() puts that same false back, and the
      // finally below is what actually returns it to visible.
      const baseRender = gtao.render.bind(gtao);
      gtao.render = function (rndr, writeBuffer, readBuffer, deltaTime, maskActive) {
        if (!fxGroup) return baseRender(rndr, writeBuffer, readBuffer, deltaTime, maskActive);
        const wasVisible = fxGroup.visible;
        fxGroup.visible = false;
        try {
          return baseRender(rndr, writeBuffer, readBuffer, deltaTime, maskActive);
        } finally {
          fxGroup.visible = wasVisible;
        }
      };

      composer.addPass(gtao);
      names.push('GTAOPass');
    }

    if (cfg.bloom) {
      const b = cfg.bloom;
      const div = Math.max(1, +b.div || 2);
      const bloom = new A.UnrealBloomPass(
        new THREE.Vector2(bufW, bufH),
        +b.strength || 0, +b.radius || 0, +b.threshold || 0
      );
      // UnrealBloomPass halves whatever size it is given before allocating, so
      // its natural state is already div:2. Rescale by 2/div to hit the tier's
      // divisor. This has to be an override of setSize rather than a one-time
      // resize, because EffectComposer.setSize() calls pass.setSize() on every
      // pass with the full effective resolution — a constructor-time divisor
      // gets silently thrown away by the first window resize, which is exactly
      // the bug where bloom quietly costs 4x more on medium after you drag the
      // window edge.
      const baseSetSize = bloom.setSize.bind(bloom);
      bloom.setSize = function (w, h) {
        baseSetSize(
          Math.max(1, Math.round(w * 2 / div)),
          Math.max(1, Math.round(h * 2 / div))
        );
      };
      composer.addPass(bloom);
      names.push('UnrealBloomPass(1/' + div + ')');
    }

    // OutputPass is not optional. r160 disables tone mapping and forces linear
    // output whenever it renders into a render target, so everything above
    // this line is linear HDR — which is what bloom wants, and which looks
    // flat and washed out if it reaches the screen unconverted. OutputPass is
    // the single place ACES + sRGB get applied, and it must be the only one:
    // the renderer's own toneMapping still applies on the no-composer path,
    // so doubling up here would make 'medium' visibly darker than 'low'.
    composer.addPass(new A.OutputPass());
    names.push('OutputPass');

    // AA last, after tone mapping. FXAA and SMAA both detect edges by luma
    // contrast and were tuned against gamma-space pixels; run on linear HDR
    // their thresholds land in the wrong place and bright edges sail straight
    // past the edge test. Tried it before OutputPass first — the stair-stepping
    // on lit roof lines was still clearly there.
    if (cfg.aa === 'smaa') {
      composer.addPass(new A.SMAAPass(bufW * pixelRatio, bufH * pixelRatio));
      names.push('SMAAPass');
    } else if (cfg.aa === 'fxaa') {
      const fxaa = new A.ShaderPass(A.FXAAShader);
      // FXAA's `resolution` uniform is 1/pixels — the size of one texel in UV
      // space — and it must be *device* pixels, not CSS pixels. EffectComposer
      // hands pass.setSize() the already-multiplied effective size (width *
      // pixelRatio), so overriding setSize is both the simplest place to
      // compute it and the only one that cannot drift: it re-fires on every
      // composer.setSize() and every composer.setPixelRatio(). Setting the
      // uniform once from cssW/cssH is the classic version of this bug — FXAA
      // then blurs at 1/1.5 the correct radius on any HiDPI screen and reads
      // as a soft-focus filter rather than antialiasing.
      fxaa.setSize = function (w, h) {
        fxaa.material.uniforms['resolution'].value.set(1 / Math.max(1, w), 1 / Math.max(1, h));
      };
      composer.addPass(fxaa);
      names.push('FXAAPass');
    }

    // Authoritative sizing, after every pass exists. addPass() already sized
    // each one as it went in, but doing it again here is what makes the
    // ordering of build() irrelevant and keeps setSize/setPixelRatio and
    // build() sharing exactly one code path.
    composer.setPixelRatio(pixelRatio);
    composer.setSize(bufW, bufH);

    forceOpaqueOutput();
  }

  // ── Teardown ────────────────────────────────────────────────────
  // EffectComposer.dispose() only frees its own two swap targets and the copy
  // pass — the passes themselves are left holding their GPU memory. SMAAPass
  // owns two render targets plus the area/search lookup textures, GTAOPass
  // owns three targets, a depth texture, two noise textures and five
  // materials, and UnrealBloomPass owns eleven targets. Someone A/B-ing tiers
  // in the dev panel rebuilds dozens of times in a sitting; skipping this
  // leaks hundreds of MB with no visible symptom until the context drops.
  function destroy() {
    if (!composer) return;
    for (const p of composer.passes) {
      if (p && typeof p.dispose === 'function') {
        try { p.dispose(); } catch (err) { console.log('[composer] pass dispose failed:', err); }
      }
    }
    composer.passes.length = 0;
    composer.dispose();
    composer = null;
    names = [];
  }

  build(settings);

  return {
    // deltaTime is forwarded straight through. None of the passes in this
    // chain animate off it in r160 — it exists for things like AfterimagePass
    // — so the ms-vs-seconds question the host would otherwise have to answer
    // does not arise. Passing it anyway keeps EffectComposer from spinning up
    // its own internal Clock.
    render(dt) {
      if (bypass || !composer) { renderer.render(scene, camera); return; }
      composer.render(typeof dt === 'number' && isFinite(dt) ? dt : undefined);
    },

    // CSS pixels, matching renderer.setSize(). Resizes the swap targets and
    // then, via EffectComposer's own loop, calls setSize() on every pass —
    // which is how SMAAPass's edge/weight targets, GTAOPass's three targets
    // and its resolution uniforms, UnrealBloomPass's mip chain and the FXAA
    // resolution uniform all follow along. Nothing here caches a resolution
    // that setSize does not reach.
    setSize(width, height) {
      cssW = Math.max(1, width | 0);
      cssH = Math.max(1, height | 0);
      if (!composer) return;
      const scale = Math.min(2, Math.max(0.25, +active.composerScale || 1));
      composer.setSize(Math.max(1, Math.round(cssW * scale)), Math.max(1, Math.round(cssH * scale)));
    },

    // The half of resize() that is easy to forget. EffectComposer keeps its
    // own _pixelRatio, seeded from the renderer at construction time and never
    // re-read; if the host bumps renderer.setPixelRatio() on a resize (moving
    // the window to a HiDPI monitor does this) and does not tell the composer,
    // every target stays at the old ratio and the whole frame renders at the
    // wrong scale — soft on the way up, aliased on the way down. Note this
    // re-runs the internal setSize, so all the per-pass resizing above happens
    // again for free.
    setPixelRatio(r) {
      pixelRatio = Math.max(0.1, +r || 1);
      if (composer) composer.setPixelRatio(pixelRatio);
    },

    // Hot-swap a tier without touching the renderer — the dev panel flips
    // between high and ultra to compare them, and recreating the WebGL context
    // would drop every compiled shader and uploaded texture in the game.
    rebuild(next) {
      const cfg = next || active;
      destroy();
      if (cfg.composer === false) {
        // Dropping to a no-composer tier at runtime. Keep the handle alive and
        // route render() straight at the renderer; the addons stay cached, so
        // rebuilding back up is still synchronous.
        bypass = true;
        active = cfg;
        return true;
      }
      bypass = false;
      build(cfg);
      return true;
    },

    dispose() { destroy(); bypass = true; },

    // Dev-panel readout. Returning a copy so nobody can splice the live list.
    passes() { return names.slice(); },
  };
}
