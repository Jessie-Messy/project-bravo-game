// loading.js — the boot loading screen.
//
// Until now the game started instantly with procedural stand-in rigs and let the real
// models pop in as they arrived. That is a graceful fallback and it stays — but it means
// the network is saturated during the exact seconds a new player is forming their first
// impression, and a character that visibly swaps out from under you reads as broken
// rather than as progressive.
//
// This gates the first frame on a small BOOT SET and lets everything else stream in
// behind it. The boot set is deliberately tiny: the protagonist, and nothing else that
// is a GLB. Terrain, sky and water are procedural and already cost nothing to wait for.
// Everything else -- mobs, armour, NPCs, the horse -- keeps the old pop-in behaviour,
// because a wolf appearing a second late in a forest you are still walking toward costs
// the player nothing.
//
// TWO RULES THIS MODULE WILL NOT BREAK:
//
//   1. It never traps the player. Every exit path is guarded -- a failed download, a
//      missing file, a machine with no skinning support, or simply taking too long all
//      dismiss the screen and start the game. A progress bar that never reaches the end
//      is strictly worse than no progress bar, and the game is playable without any of
//      these models.
//
//   2. It owns its own DOM. The overlay is built here and injected at runtime rather
//      than living in the page, because the local medieval_prototype.html and the
//      deployed games/medieval/index.html have diverged -- the deployed one is
//      platform-adapted with a vendored importmap and a save-bridge. Shipping the
//      loading screen inside js/ means it reaches players through the normal deploy
//      without either file needing to be touched.

const OVERLAY_ID = 'bravo-boot';

// Hard ceiling on how long the screen may hold the game back. Past this we start
// regardless of what is still in flight. Tuned against the measured payload: after the
// Phase 02 bake the protagonist is ~1.2 MB, which is a couple of seconds on a slow
// connection and effectively instant on a fast one.
const MAX_HOLD_MS = 15000;

const CSS = `
#${OVERLAY_ID}{
  position:fixed; inset:0; z-index:9999;
  display:flex; flex-direction:column; align-items:center; justify-content:center;
  gap:1.25rem;
  background:#0d0f0e;
  color:#c8cfcb;
  font-family:'Trebuchet MS',Verdana,sans-serif;
  transition:opacity .45s ease;
}
#${OVERLAY_ID}.done{opacity:0; pointer-events:none}
#${OVERLAY_ID} .bravo-boot-title{
  font-size:1.35rem; letter-spacing:.18em; text-transform:uppercase;
  color:#d8c9a3; font-weight:700;
}
#${OVERLAY_ID} .bravo-boot-track{
  width:min(320px,60vw); height:3px; background:#23282a; overflow:hidden;
}
#${OVERLAY_ID} .bravo-boot-fill{
  height:100%; width:0%; background:#d8c9a3;
  transition:width .3s ease;
}
#${OVERLAY_ID} .bravo-boot-status{
  font-size:.78rem; letter-spacing:.08em; color:#6f7a75;
  font-family:ui-monospace,Consolas,monospace; min-height:1.2em;
}
@media (prefers-reduced-motion:reduce){
  #${OVERLAY_ID}, #${OVERLAY_ID} .bravo-boot-fill{transition:none}
}
`;

/**
 * Build the overlay, and return a LoadingManager to hand to the GLTFLoader.
 *
 * @param {object}   opts
 * @param {string[]} opts.bootFiles  Filenames (not full paths) that must finish before
 *                                   the game is revealed. Matched by suffix, so
 *                                   'Protag_animations_basic.glb' matches whatever
 *                                   prefix the loader resolves it to.
 * @param {typeof import('three').LoadingManager} opts.LoadingManager
 * @returns {{manager: object, dismiss: () => void}}
 */
export function createLoadingScreen({ bootFiles, LoadingManager }) {
  const pending = new Set(bootFiles);
  let dismissed = false;
  const readyCbs = [];

  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  const el = document.createElement('div');
  el.id = OVERLAY_ID;
  el.setAttribute('role', 'status');
  el.setAttribute('aria-live', 'polite');
  el.innerHTML = `
    <div class="bravo-boot-title">Project Bravo</div>
    <div class="bravo-boot-track"><div class="bravo-boot-fill"></div></div>
    <div class="bravo-boot-status">preparing the world…</div>
  `;
  // The canvas may not exist yet depending on when this runs, so attach to body and
  // rely on z-index rather than DOM order.
  (document.body || document.documentElement).appendChild(el);

  const fill = el.querySelector('.bravo-boot-fill');
  const status = el.querySelector('.bravo-boot-status');

  function setProgress(fraction, text) {
    const pct = Math.max(0, Math.min(1, fraction)) * 100;
    fill.style.width = pct.toFixed(0) + '%';
    if (text) status.textContent = text;
  }

  function dismiss(reason) {
    if (dismissed) return;
    dismissed = true;
    clearTimeout(timer);
    setProgress(1, reason || 'ready');
    el.classList.add('done');
    // Remove rather than leave an invisible full-screen element over the canvas --
    // pointer-events:none covers input, but a stale node is still a node.
    setTimeout(() => el.remove(), 600);
    // Anything that should not happen until the player can actually see and control
    // the world -- most importantly connecting to the world server, because until the
    // boot screen is gone you are a standing target you cannot move.
    for (const cb of readyCbs.splice(0)) {
      try { cb(); } catch (err) { console.error('[boot] ready callback failed', err); }
    }
  }

  // Rule 1: never trap the player.
  const timer = setTimeout(() => {
    dismiss('starting anyway');
  }, MAX_HOLD_MS);

  const settle = (url) => {
    for (const name of pending) {
      if (url.endsWith(name)) {
        pending.delete(name);
        break;
      }
    }
    if (pending.size === 0) dismiss('ready');
  };

  const manager = new LoadingManager();

  manager.onProgress = (url, loaded, total) => {
    // The stream set keeps loading after the screen is gone, so these keep firing --
    // ignore them once dismissed or they overwrite the final state during the fade.
    if (dismissed) return;
    // `total` counts everything in flight, boot set or not, so it is a reasonable
    // overall signal but must never be the dismissal condition.
    if (total > 0) setProgress(loaded / total, 'loading assets…');
  };

  // Both success and failure settle the item -- a model that 404s must not hold the
  // door shut, and the game already falls back to a primitive rig when a template is
  // missing.
  manager.onLoad = () => dismiss('ready');
  manager.onError = (url) => {
    console.warn('[boot] failed to load', url);
    settle(url);
  };

  return {
    manager,
    /** Call when a boot-set file has finished, success or not. */
    settle,
    /** Force the screen away (e.g. skinning unsupported, so no boot models will load). */
    dismiss: () => dismiss('ready'),
    /**
     * Run `cb` once the world is actually playable. Fires immediately if the screen has
     * already gone, so a late caller is never stranded.
     */
    whenReady(cb) {
      if (dismissed) cb();
      else readyCbs.push(cb);
    },
  };
}
