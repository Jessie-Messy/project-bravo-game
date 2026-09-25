// Plays one stall camera. HLS video uses the browser's native player where it exists
// (Safari, iOS) and hls.js elsewhere; still-image cameras refresh every 2 seconds.
// Every request goes through /api/cameras/…, which re-checks the guest's access.
import { el, icon, fmtInstant } from './common.js';

let hlsLoader;
function loadHls() {
  if (window.Hls) return Promise.resolve(window.Hls);
  hlsLoader ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = '/vendor/hls.light.min.js';
    s.onload = () => resolve(window.Hls);
    s.onerror = () => reject(new Error('player failed to load'));
    document.head.append(s);
  });
  return hlsLoader;
}

export function cameraCard(cam, { tz } = {}) {
  const view = el('div', { class: 'view' });
  const title = el('h3', {}, cam.name);
  const detail = el('p', {}, cam.covers?.length ? `Shows ${cam.covers.join(' & ')}` : '');
  const status = el('p', { role: 'status', class: 'small' });
  const actions = el('div', { class: 'cam-actions' });
  const card = el('article', { class: 'cam', 'aria-label': cam.name }, view,
    el('div', { class: 'body' }, el('div', {}, title, detail, status), actions));
  let stop = () => {};

  function placeholder(...content) { view.replaceChildren(el('div', { class: 'placeholder' }, ...content)); }

  if (!cam.live) {
    placeholder(icon('clock'), el('p', { class: 'm-0' }, `Your camera turns on ${fmtInstant(cam.liveFrom, tz)}.`));
    return { card, stop };
  }

  const watch = el('button', { type: 'button', class: 'btn small' }, icon('camera'), 'Watch live');
  const full = el('button', { type: 'button', class: 'btn secondary small', hidden: true }, icon('expand'), 'Full screen');
  const pause = el('button', { type: 'button', class: 'btn secondary small', hidden: true }, 'Stop');
  actions.append(watch, full, pause);
  placeholder(el('p', { class: 'm-0' }, 'Press “Watch live” to start the feed.'),
    el('p', { class: 'm-0 small' }, `Available until ${fmtInstant(cam.liveUntil, tz)}`));

  async function start() {
    watch.hidden = true; pause.hidden = false; full.hidden = false;
    status.textContent = 'Connecting…';
    const base = `/api/cameras/${encodeURIComponent(cam.id)}`;
    if (cam.type === 'hls') {
      const video = el('video', { muted: true, playsinline: true, controls: true, 'aria-label': `Live video: ${cam.name}` });
      video.muted = true;
      view.replaceChildren(video, el('span', { class: 'live-pill', 'aria-hidden': 'true' }, 'LIVE'));
      const src = `${base}/hls/index.m3u8`;
      let hls;
      const onError = (msg) => { status.textContent = msg; };
      video.addEventListener('playing', () => { status.textContent = 'Live'; });
      if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = src;
        video.addEventListener('error', () => onError('The camera stream stopped. Press Stop, then Watch live to retry.'));
      } else {
        try {
          const Hls = await loadHls();
          if (!Hls.isSupported()) { onError('This browser can’t play live video. Try Chrome, Edge, Firefox or Safari.'); return; }
          hls = new Hls({ lowLatencyMode: false, liveSyncDurationCount: 3, xhrSetup: (xhr) => { xhr.withCredentials = true; } });
          hls.on(Hls.Events.ERROR, (_, data) => {
            if (!data.fatal) return;
            if (data.response?.code === 403) { onError('Your access to this camera has ended.'); hls.destroy(); return; }
            onError('Reconnecting…');
            if (data.type === Hls.ErrorTypes.NETWORK_ERROR) setTimeout(() => hls.startLoad(), 3000);
            else hls.recoverMediaError();
          });
          hls.loadSource(src);
          hls.attachMedia(video);
        } catch { onError('The video player didn’t load. Refresh the page to try again.'); return; }
      }
      video.play().catch(() => { status.textContent = 'Press play to start.'; });
      stop = () => { hls?.destroy(); video.removeAttribute('src'); video.load(); };
      full.onclick = () => (video.requestFullscreen?.() || video.webkitEnterFullscreen?.());
    } else {
      const img = el('img', { alt: `Live picture from ${cam.name}, refreshed every 2 seconds` });
      view.replaceChildren(img, el('span', { class: 'live-pill', 'aria-hidden': 'true' }, 'LIVE'));
      let timer, failures = 0, alive = true;
      const tick = () => {
        if (!alive) return;
        if (document.hidden) { timer = setTimeout(tick, 2000); return; }
        const next = new Image();
        next.onload = () => { img.src = next.src; failures = 0; status.textContent = 'Live'; timer = setTimeout(tick, 2000); };
        next.onerror = () => {
          failures++;
          status.textContent = failures > 2 ? 'The camera isn’t responding. We’ll keep trying.' : 'Reconnecting…';
          timer = setTimeout(tick, Math.min(15000, 2000 * failures));
        };
        next.src = `${base}/snapshot?t=${Date.now()}`;
      };
      tick();
      stop = () => { alive = false; clearTimeout(timer); };
      full.onclick = () => view.requestFullscreen?.();
    }
  }

  watch.addEventListener('click', start);
  pause.addEventListener('click', () => {
    stop();
    pause.hidden = true; full.hidden = true; watch.hidden = false;
    status.textContent = 'Stopped.';
    placeholder(el('p', { class: 'm-0' }, 'Feed stopped.'));
    watch.focus();
  });
  return { card, stop: () => stop() };
}
