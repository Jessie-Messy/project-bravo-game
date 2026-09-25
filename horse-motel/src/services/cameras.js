// Stall cameras.
//
// Guests never see a camera's real address or credentials. The browser only ever talks
// to this server, which checks on every request that the signed-in guest has a
// confirmed booking for a stall that camera covers, and that the stay's access window
// is open right now. Only then is the request relayed to the camera (or the NVR /
// MediaMTX / go2rtc box in front of it) on the private network.
//
// The relay is also protected against abuse: every upstream read is size-capped while
// streaming, each account and each camera has a small number of requests in flight at
// most, and video segments are shared between viewers through a short-lived cache, so
// one guest can't exhaust the server's memory or the ranch's upload bandwidth.
import { zonedInstant, addDays } from '../dates.js';
import { audit } from '../db.js';
import { unseal } from '../security/secretbox.js';

const FILE_RE = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,120}\.(m3u8|ts|m4s|mp4|aac)$/;
const HLS_QUERY = ['_HLS_msn', '_HLS_part', '_HLS_skip'];
const LIMITS = {
  playlistBytes: 512 * 1024,
  segmentBytes: 12 * 1024 * 1024,
  snapshotBytes: 6 * 1024 * 1024,
  perUserInFlight: 6,
  perCameraInFlight: 12,
  cacheEntries: 80,
  cacheBytes: 96 * 1024 * 1024,
  segmentTtlMs: 20e3,
};
// Never fetched unless explicitly allow-listed: loopback, link-local, cloud metadata.
const RISKY_HOST = /^(localhost|0\.0\.0\.0|127\.\d+\.\d+\.\d+|169\.254\.\d+\.\d+|\[?::1\]?|\[?fe80:.*|metadata\.google\.internal)$/i;

export class RelayError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function cameraService({ db, cfg }) {
  const grantCache = new Map();
  const inFlightUser = new Map();
  const inFlightCamera = new Map();
  const segmentCache = new Map(); // key -> { expires, size, promise }
  let cacheBytes = 0;

  // Another guest holds one of this camera's units on `night`? Then windows must not overlap.
  const neighbourOnNight = db.prepare(`SELECT 1 FROM allocations a
      JOIN bookings b ON b.id = a.booking_id
      JOIN camera_units cu ON cu.unit_id = a.unit_id
      WHERE cu.camera_id = ? AND a.night = ? AND b.id != ? AND b.kind = 'guest'
        AND b.status IN ('confirmed','needs_attention') LIMIT 1`);

  function windowFor(b, cameraId = null) {
    const tz = cfg.ranch.timezone;
    let from = zonedInstant(tz, b.check_in, cfg.ranch.checkInHour) - cfg.cameraAccess.hoursBeforeCheckIn * 3600e3;
    let until = zonedInstant(tz, b.check_out, cfg.ranch.checkOutHour) + cfg.cameraAccess.hoursAfterCheckOut * 3600e3;
    if (cameraId !== null && b.id !== undefined) {
      // Back-to-back guests on the same stall: the leaving guest's view ends at check-out
      // time, and the arriving guest's view starts no earlier than that.
      if (neighbourOnNight.get(cameraId, addDays(b.check_in, -1), b.id)) {
        from = Math.max(from, zonedInstant(tz, b.check_in, cfg.ranch.checkOutHour));
      }
      if (neighbourOnNight.get(cameraId, b.check_out, b.id)) {
        until = Math.min(until, zonedInstant(tz, b.check_out, cfg.ranch.checkOutHour));
      }
    }
    return { from, until };
  }

  // Every camera a guest has (or will have) access to through a confirmed booking.
  function camerasForUser(userId, now = Date.now()) {
    const rows = db.prepare(`SELECT DISTINCT c.id AS camera_id, c.public_id, c.name, c.source_type,
          b.id, b.ref, b.check_in, b.check_out
        FROM bookings b
        JOIN allocations a ON a.booking_id = b.id
        JOIN camera_units cu ON cu.unit_id = a.unit_id
        JOIN cameras c ON c.id = cu.camera_id AND c.active = 1
        WHERE b.user_id = ? AND b.kind = 'guest' AND b.status = 'confirmed'
        ORDER BY b.check_in, c.name`).all(userId);
    const unitLabels = db.prepare(`SELECT DISTINCT u.label FROM camera_units cu JOIN units u ON u.id = cu.unit_id
        JOIN allocations a ON a.unit_id = u.id
        WHERE cu.camera_id = ? AND a.booking_id = ? ORDER BY u.number`);
    const byCamera = new Map();
    for (const r of rows) {
      const w = windowFor(r, r.camera_id);
      if (now > w.until) continue; // stay is over: no longer listed
      const entry = { id: r.public_id, name: r.name, type: r.source_type === 'hls' ? 'hls' : 'image', booking: r.ref,
        stay: { checkIn: r.check_in, checkOut: r.check_out },
        covers: unitLabels.all(r.camera_id, r.id).map((x) => x.label), liveFrom: w.from, liveUntil: w.until,
        live: now >= w.from && now <= w.until };
      // The same camera across two stays: show the one that's live, else the soonest.
      const prev = byCamera.get(r.public_id);
      if (!prev || (!prev.live && (entry.live || entry.liveFrom < prev.liveFrom))) byCamera.set(r.public_id, entry);
    }
    return [...byCamera.values()];
  }

  function findCamera(publicId) {
    if (typeof publicId !== 'string' || !/^[A-Za-z0-9_-]{8,40}$/.test(publicId)) return null;
    return db.prepare('SELECT * FROM cameras WHERE public_id = ? AND active = 1').get(publicId);
  }

  // Admins see every camera, but only from a session that passed 2-step verification.
  const isVerifiedAdmin = (user, session) => user?.role === 'admin' && user.totpEnabled && !!session?.mfaPassed;

  function canView(user, camera, session, now = Date.now()) {
    if (!user || !camera) return false;
    if (isVerifiedAdmin(user, session)) return true;
    if (user.role === 'admin') return false;
    const key = `${user.id}:${camera.id}`;
    const cached = grantCache.get(key);
    if (cached && cached > now) return true;
    const ok = camerasForUser(user.id, now).some((c) => c.id === camera.public_id && c.live);
    if (ok) grantCache.set(key, now + 15e3); // short: a cancellation takes effect within seconds
    else grantCache.delete(key);
    return ok;
  }

  const revokeAll = () => { for (const k of [...grantCache.keys()]) if (!k.startsWith('log:')) grantCache.delete(k); };

  function checkSourceUrl(raw, type) {
    if (type === 'demo') return '';
    let u;
    try { u = new URL(raw); } catch { throw new Error('Enter a full http:// or https:// address.'); }
    if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only http:// and https:// camera addresses are supported.');
    hostAllowed(u.hostname, true);
    if (type === 'hls' && !u.pathname.endsWith('.m3u8')) throw new Error('An HLS address must end in .m3u8');
    u.hash = '';
    return u.toString();
  }

  function hostAllowed(hostname, explain = false) {
    const host = hostname.toLowerCase().replace(/^\[|\]$/g, '');
    const list = cfg.cameraAccess.allowedHosts;
    const fail = (msg) => { if (explain) throw new Error(msg); return false; };
    if (list.length) {
      return list.includes(host) || fail(`Camera host must be one of: ${list.join(', ')} (CAMERA_ALLOWED_HOSTS).`);
    }
    if (cfg.production) return fail('Set CAMERA_ALLOWED_HOSTS to your camera box’s address first.');
    if (RISKY_HOST.test(host)) return fail('That address is not allowed for a camera. Add it to CAMERA_ALLOWED_HOSTS if it really is one.');
    return true;
  }

  // Fetches from the camera box with a hard size cap enforced while streaming.
  async function fetchLimited(url, { timeout, maxBytes }) {
    const u = new URL(url);
    if (!hostAllowed(u.hostname)) throw new RelayError(502, 'Camera host not allowed.');
    const headers = {};
    if (u.username || u.password) {
      headers.authorization = 'Basic ' + Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64');
      u.username = ''; u.password = '';
    }
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const r = await fetch(u, { headers, redirect: 'error', signal: ctrl.signal });
      if (!r.ok) { ctrl.abort(); throw new RelayError(r.status === 404 ? 404 : 502, 'Camera returned an error.'); }
      const declared = Number(r.headers.get('content-length') || 0);
      if (declared > maxBytes) { ctrl.abort(); throw new RelayError(502, 'Camera response too large.'); }
      const chunks = [];
      let size = 0;
      for await (const chunk of r.body) {
        size += chunk.length;
        if (size > maxBytes) { ctrl.abort(); throw new RelayError(502, 'Camera response too large.'); }
        chunks.push(chunk);
      }
      return { body: Buffer.concat(chunks, size), type: (r.headers.get('content-type') || '').split(';')[0].trim() };
    } catch (e) {
      if (e instanceof RelayError) throw e;
      throw new RelayError(502, 'Camera is not responding.');
    } finally {
      clearTimeout(timer);
    }
  }

  // Caps concurrent upstream fetches per account and per camera.
  async function throttled(user, camera, fn) {
    const u = inFlightUser.get(user.id) || 0;
    const c = inFlightCamera.get(camera.id) || 0;
    if (u >= LIMITS.perUserInFlight || c >= LIMITS.perCameraInFlight) throw new RelayError(429, 'Too many requests for this camera. Please slow down.');
    inFlightUser.set(user.id, u + 1);
    inFlightCamera.set(camera.id, c + 1);
    try { return await fn(); } finally {
      const nu = (inFlightUser.get(user.id) || 1) - 1;
      const nc = (inFlightCamera.get(camera.id) || 1) - 1;
      if (nu) inFlightUser.set(user.id, nu); else inFlightUser.delete(user.id);
      if (nc) inFlightCamera.set(camera.id, nc); else inFlightCamera.delete(camera.id);
    }
  }

  // Segments are immutable, so viewers of the same camera share one upstream fetch.
  function cachedSegment(key, load) {
    const now = Date.now();
    for (const [k, v] of segmentCache) {
      if (v.expires > now) break; // Map keeps insertion order: oldest first
      segmentCache.delete(k); cacheBytes -= v.size;
    }
    const hit = segmentCache.get(key);
    if (hit && hit.expires > now) return hit.promise;
    const entry = { expires: now + LIMITS.segmentTtlMs, size: 0, promise: null };
    entry.promise = load().then((v) => {
      entry.size = v.body.length; cacheBytes += entry.size;
      while (segmentCache.size > LIMITS.cacheEntries || cacheBytes > LIMITS.cacheBytes) {
        const [k, old] = segmentCache.entries().next().value;
        segmentCache.delete(k); cacheBytes -= old.size;
      }
      return v;
    }, (e) => { segmentCache.delete(key); throw e; });
    segmentCache.set(key, entry);
    return entry.promise;
  }

  // HLS: /api/cameras/:id/hls/<file>. The first request (index.m3u8) is the camera's
  // configured playlist; every other file must sit in the same upstream directory.
  async function relayHls(user, camera, file, query, res) {
    if (!FILE_RE.test(file)) return res.status(400).end();
    const playlist = new URL(unseal(camera.source_url));
    const baseDir = new URL('./', playlist);
    const target = file === 'index.m3u8' ? new URL(playlist) : new URL(file, baseDir);
    if (!target.href.startsWith(baseDir.href)) return res.status(400).end();
    for (const k of HLS_QUERY) if (typeof query[k] === 'string' && /^(\d{1,10}|YES|v2)$/.test(query[k])) target.searchParams.set(k, query[k]);

    try {
      res.set('Cache-Control', 'no-store');
      if (file.endsWith('.m3u8')) {
        const r = await throttled(user, camera, () => fetchLimited(target.href, { timeout: 20000, maxBytes: LIMITS.playlistBytes }));
        return res.type('application/vnd.apple.mpegurl').send(rewritePlaylist(r.body.toString('utf8'), target, baseDir));
      }
      const r = await cachedSegment(`${camera.id}:${target.href}`,
        () => throttled(user, camera, () => fetchLimited(target.href, { timeout: 15000, maxBytes: LIMITS.segmentBytes })));
      const type = file.endsWith('.ts') ? 'video/mp2t' : file.endsWith('.aac') ? 'audio/aac' : 'video/mp4';
      return res.type(type).send(r.body);
    } catch (e) {
      return relayFailure(res, e);
    }
  }

  async function relaySnapshot(user, camera, res) {
    res.set('Cache-Control', 'no-store');
    if (camera.source_type === 'demo') return res.type('image/svg+xml').send(demoFrame(camera.name));
    try {
      const r = await throttled(user, camera, () => fetchLimited(unseal(camera.source_url), { timeout: 8000, maxBytes: LIMITS.snapshotBytes }));
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(r.type)) return res.status(502).end();
      return res.type(r.type).send(r.body);
    } catch (e) {
      return relayFailure(res, e);
    }
  }

  function relayFailure(res, e) {
    const status = e instanceof RelayError ? e.status : 502;
    if (status === 429) res.set('Retry-After', '2');
    return res.status(status).json({ error: status === 429 ? e.message : 'The camera isn’t responding right now.' });
  }

  function logView(user, camera, ip) {
    const key = `log:${user.id}:${camera.id}`;
    const now = Date.now();
    if ((grantCache.get(key) || 0) > now) return;
    grantCache.set(key, now + 10 * 60e3);
    audit(db, { userId: user.id, action: 'camera.view', detail: camera.name, ip });
  }

  return { camerasForUser, findCamera, canView, isVerifiedAdmin, relayHls, relaySnapshot, checkSourceUrl, logView, revokeAll, windowFor };
}

// Rewrites every URI in a playlist to a bare file name under our proxy path, and drops
// any that point outside the camera's own directory.
export function rewritePlaylist(text, playlistUrl, baseDir) {
  const fix = (uri) => {
    let abs;
    try { abs = new URL(uri, playlistUrl); } catch { return null; }
    if (!abs.href.startsWith(baseDir.href)) return null;
    const name = abs.pathname.slice(baseDir.pathname.length);
    if (!FILE_RE.test(name)) return null;
    const q = new URLSearchParams();
    for (const k of HLS_QUERY) if (abs.searchParams.has(k)) q.set(k, abs.searchParams.get(k));
    const qs = q.toString();
    return qs ? `${name}?${qs}` : name;
  };
  const out = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith('#')) {
      let dropped = false;
      const rewritten = line.replace(/URI="([^"]*)"/g, (_, uri) => {
        const f = fix(uri);
        if (f === null) { dropped = true; return 'URI=""'; }
        return `URI="${f}"`;
      });
      if (!dropped) out.push(rewritten);
    } else if (line.trim()) {
      const f = fix(line.trim());
      if (f !== null) out.push(f);
      else if (out.length && /^#EXT(INF|-X-STREAM-INF)/.test(out[out.length - 1])) out.pop();
    } else out.push(line);
  }
  return out.join('\n');
}

function demoFrame(name) {
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const t = new Date().toLocaleTimeString('en-US', { timeZone: 'America/Chicago' });
  const x = 80 + Math.round((Date.now() / 1000) % 60) * 8;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 640 360" width="640" height="360">
<rect width="640" height="360" fill="#2b2118"/><rect y="250" width="640" height="110" fill="#6b4a2b"/>
<g fill="#c9a97a" opacity=".5">${[0, 1, 2, 3, 4, 5, 6, 7].map((i) => `<rect x="${i * 80 + 4}" y="60" width="72" height="190"/>`).join('')}</g>
<ellipse cx="${x}" cy="230" rx="60" ry="26" fill="#3a2a1c"/><rect x="${x + 40}" y="170" width="18" height="60" fill="#3a2a1c" transform="rotate(20 ${x + 49} 200)"/>
<text x="20" y="36" font-family="monospace" font-size="20" fill="#fff">${esc(name)} · DEMO FEED</text>
<text x="20" y="340" font-family="monospace" font-size="18" fill="#fff">${t} CT</text></svg>`;
}
