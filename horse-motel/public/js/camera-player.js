// Plays one stall camera. HLS video uses the browser's native player where it exists
// (Safari, iOS) and hls.js elsewhere; still-image cameras refresh every 2 seconds.
// Every request goes through /api/cameras/…, which re-checks the guest's access.
import { el, icon, fmtInstant, fmtRange } from './common.js';

let hlsLoader;
function loadHls() {
  if (window.Hls) return Promise.resolve(window.Hls);
  hlsLoader ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/vendor/hls.light.min.js';
    s.onload = () => resolve(window.Hls);
    s.onerror = () => { hlsLoader = null; reject(new Error('player failed to load')); };
    document.head.append(s);
  });
  return hlsLoader;
}

export function cameraCard(cam, { tz = 'America/Chicago', heading = 'h4', stay = null } = {}) {
  const view = el('div', { class: 'view' });
  const title = el(heading, {}, cam.name);
  const detail = el('p', {}, [cam.covers?.length ? `Shows ${cam.covers.join(' & ')}` : '', stay ? ` · Your stay ${fmtRange(stay.checkIn, stay.checkOut)}` : ''].join('').replace(/^ · /, ''));
  const status = el('p', { role: 'status', class: 'small' });
  const actions = el('div', { class: 'cam-actions' });
  const card = el('article', { class: 'cam', 'aria-label': cam.name }, view,
    el('div', { class: 'body' }, el('div', {}, title, detail, status), actions));
  let stop = () => {};
  // Only touch the live region when the message actually changes.
  const setStatus = (text) => { if (status.textContent !== text) status.textContent = text; };

  function placeholder(...content) { view.replaceChildren(el('div', { class: 'placeholder' }, ...content)); }

  if (!cam.live) {
    placeholder(icon('clock'), el('p', { class: 'm-0' }, `Your camera turns on ${fmtInstant(cam.liveFrom, tz)}.`));
    return { card, stop };
  }

  const watch = el('button', { type: 'button', class: 'btn small' }, icon('camera'), 'Watch live');
  const full = el('button', { type: 'button', class: 'btn secondary small', hidden: true }, icon('expand'), el('span', {}, 'Full screen'));
  const pause = el('button', { type: 'button', class: 'btn secondary small', hidden: true }, 'Stop');
  actions.append(watch, full, pause);
  placeholder(el('p', { class: 'm-0' }, 'Press “Watch live” to start the feed.'),
    el('p', { class: 'm-0 small' }, `Available until ${fmtInstant(cam.liveUntil, tz)}`));

  function ended(message) {
    stop();
    if (card.classList.contains('expanded')) toggleFull();
    const hadFocus = card.contains(document.activeElement);
    pause.hidden = true; full.hidden = true; watch.hidden = true;
    const msg = el('p', { class: 'm-0', tabindex: '-1' }, message);
    placeholder(icon('lock'), msg);
    setStatus(message);
    if (hadFocus) msg.focus(); // the button that had focus is gone
  }

  // While the card fills the screen, everything else is inert: keyboard and screen reader
  // users stay inside it until they leave full screen.
  let inerted = [];
  let untabbed = [];
  function isolate(on) {
    if (on) {
      for (let node = card; node && node !== document.body; node = node.parentElement) {
        for (const sib of node.parentElement.children) if (sib !== node && !sib.inert) { sib.inert = true; inerted.push(sib); }
        // A focusable container around the card (e.g. a tab panel) leaves the tab order too.
        const parent = node.parentElement;
        if (parent !== document.body && parent.getAttribute('tabindex') === '0') { parent.setAttribute('tabindex', '-1'); untabbed.push(parent); }
      }
    } else {
      inerted.forEach((n) => { n.inert = false; }); inerted = [];
      untabbed.forEach((n) => n.setAttribute('tabindex', '0')); untabbed = [];
    }
  }

  // Full screen: the real thing where supported, otherwise the card fills the viewport.
  function toggleFull() {
    // The whole card goes full screen, so its buttons come with it.
    if (!card.classList.contains('expanded') && document.fullscreenEnabled && card.requestFullscreen) {
      if (document.fullscreenElement === card) document.exitFullscreen(); else card.requestFullscreen();
      return;
    }
    const on = card.classList.toggle('expanded');
    isolate(on);
    full.querySelector('span').textContent = on ? 'Exit full screen' : 'Full screen';
    full.focus();
  }
  document.addEventListener('fullscreenchange', () => {
    full.querySelector('span').textContent = document.fullscreenElement === card ? 'Exit full screen' : 'Full screen';
  });
  card.addEventListener('keydown', (e) => { if (e.key === 'Escape' && card.classList.contains('expanded')) toggleFull(); });

  async function start() {
    watch.hidden = true; pause.hidden = false; full.hidden = false;
    pause.focus(); // the button that had focus is gone; land on its opposite
    setStatus('Connecting…');
    const base = `/api/cameras/${encodeURIComponent(cam.id)}`;
    if (cam.type === 'hls') {
      const video = el('video', { muted: true, playsinline: true, controls: true, 'aria-label': `Live video: ${cam.name}` });
      video.muted = true;
      view.replaceChildren(video, el('span', { class: 'live-pill', 'aria-hidden': 'true' }, 'LIVE'));
      const src = `${base}/hls/index.m3u8`;
      let hls;
      let networkRetries = 0, mediaRecoveries = 0, retryTimer;
      video.addEventListener('playing', () => { networkRetries = 0; setStatus('Live'); });
      if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = src;
        // Safari's own player doesn't say why it failed: ask the server.
        video.addEventListener('error', async () => {
          const r = await fetch(src, { credentials: 'same-origin', cache: 'no-store' }).catch(() => null);
          if (r && (r.status === 401 || r.status === 403)) ended('Your access to this camera has ended.');
          else setStatus('The camera stream stopped. Press Stop, then Watch live to try again.');
        });
      } else {
        try {
          const Hls = await loadHls();
          if (!Hls.isSupported()) { setStatus('This browser can’t play live video. Try Chrome, Edge, Firefox or Safari.'); return; }
          hls = new Hls({ lowLatencyMode: false, liveSyncDurationCount: 3, xhrSetup: (xhr) => { xhr.withCredentials = true; } });
          hls.on(Hls.Events.ERROR, (_, data) => {
            if (!data.fatal) return;
            if (data.response?.code === 403) { ended('Your access to this camera has ended.'); return; }
            if (data.type === Hls.ErrorTypes.NETWORK_ERROR && networkRetries < 8) {
              // Back off: 2s, 4s, 8s … up to 30s, then give up with a clear message.
              const wait = Math.min(30000, 2000 * 2 ** networkRetries++);
              setStatus('Reconnecting…');
              retryTimer = setTimeout(() => hls.startLoad(), wait);
            } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRecoveries < 2) {
              mediaRecoveries++;
              hls.recoverMediaError();
            } else {
              hls.destroy();
              setStatus(data.type === Hls.ErrorTypes.MEDIA_ERROR
                ? 'This camera’s video format can’t be played in the browser.'
                : 'The camera stream isn’t available right now. Press Stop, then Watch live to try again.');
            }
          });
          hls.loadSource(src);
          hls.attachMedia(video);
        } catch { setStatus('The video player didn’t load. Refresh the page to try again.'); return; }
      }
      video.play().catch(() => { setStatus('Press play to start.'); });
      // A native player may just stall when access ends; check once a minute while playing.
      const accessCheck = setInterval(async () => {
        if (document.hidden) return;
        const r = await fetch(src, { credentials: 'same-origin', cache: 'no-store' }).catch(() => null);
        if (r && (r.status === 401 || r.status === 403)) ended('Your access to this camera has ended.');
      }, 60e3);
      stop = () => { clearInterval(accessCheck); clearTimeout(retryTimer); hls?.destroy(); video.removeAttribute('src'); video.load(); };
    } else {
      const img = el('img', { alt: `Live picture from ${cam.name}, refreshed every 2 seconds` });
      view.replaceChildren(img, el('span', { class: 'live-pill', 'aria-hidden': 'true' }, 'LIVE'));
      let timer, failures = 0, alive = true;
      const tick = async () => {
        if (!alive) return;
        if (document.hidden) { timer = setTimeout(tick, 2000); return; }
        try {
          const r = await fetch(`${base}/snapshot?t=${Date.now()}`, { credentials: 'same-origin', cache: 'no-store' });
          if (r.status === 401 || r.status === 403) { ended('Your access to this camera has ended.'); return; }
          if (!r.ok) throw new Error(String(r.status));
          const url = URL.createObjectURL(await r.blob());
          const old = img.src;
          img.src = url;
          if (old.startsWith('blob:')) URL.revokeObjectURL(old);
          failures = 0;
          setStatus('Live');
          timer = setTimeout(tick, 2000);
        } catch {
          failures++;
          setStatus(failures > 2 ? 'The camera isn’t responding. We’ll keep trying.' : 'Reconnecting…');
          timer = setTimeout(tick, Math.min(30000, 2000 * failures));
        }
      };
      tick();
      stop = () => { alive = false; clearTimeout(timer); if (img.src.startsWith('blob:')) URL.revokeObjectURL(img.src); };
    }
  }

  watch.addEventListener('click', start);
  full.addEventListener('click', toggleFull);
  pause.addEventListener('click', () => {
    stop();
    if (card.classList.contains('expanded')) toggleFull();
    if (document.fullscreenElement === card) document.exitFullscreen();
    pause.hidden = true; full.hidden = true; watch.hidden = false;
    setStatus('Stopped.');
    placeholder(el('p', { class: 'm-0' }, 'Feed stopped.'));
    watch.focus();
  });
  return { card, stop: () => stop(), playing: () => !pause.hidden };
}
