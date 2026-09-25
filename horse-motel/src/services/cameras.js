// Stall cameras.
//
// Guests never see a camera's real address or credentials. The browser only ever talks
// to this server, which checks on every request that the signed-in guest has a
// confirmed booking for a stall that camera covers, and that the stay's access window
// is open right now. Only then is the request relayed to the camera (or the NVR /
// MediaMTX / go2rtc box in front of it) on the private network.
import { zonedInstant } from '../dates.js';
import { audit } from '../db.js';

const FILE_RE = /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,120}\.(m3u8|ts|m4s|mp4|aac)$/;
const HLS_QUERY = ['_HLS_msn', '_HLS_part', '_HLS_skip'];

export function cameraService({ db, cfg, allowedHosts = [] }) {
  const grantCache = new Map();

  function windowFor(b) {
    const tz = cfg.ranch.timezone;
    return {
      from: zonedInstant(tz, b.check_in, cfg.ranch.checkInHour) - cfg.cameraAccess.hoursBeforeCheckIn * 3600e3,
      until: zonedInstant(tz, b.check_out, cfg.ranch.checkOutHour) + cfg.cameraAccess.hoursAfterCheckOut * 3600e3,
    };
  }

  // Every camera a guest has (or will have) access to through a confirmed booking.
  function camerasForUser(userId, now = Date.now()) {
    const rows = db.prepare(`SELECT DISTINCT c.id, c.public_id, c.name, c.source_type, b.ref, b.check_in, b.check_out
        FROM bookings b
        JOIN allocations a ON a.booking_id = b.id
        JOIN camera_units cu ON cu.unit_id = a.unit_id
        JOIN cameras c ON c.id = cu.camera_id AND c.active = 1
        WHERE b.user_id = ? AND b.kind = 'guest' AND b.status = 'confirmed'
        ORDER BY b.check_in, c.name`).all(userId);
    const unitLabels = db.prepare(`SELECT DISTINCT u.label FROM camera_units cu JOIN units u ON u.id = cu.unit_id
        JOIN allocations a ON a.unit_id = u.id JOIN bookings b ON b.id = a.booking_id
        WHERE cu.camera_id = ? AND b.ref = ? ORDER BY u.number`);
    const out = [];
    for (const r of rows) {
      const w = windowFor(r);
      if (now > w.until) continue; // stay is over: no longer listed
      out.push({ id: r.public_id, name: r.name, type: r.source_type === 'hls' ? 'hls' : 'image', booking: r.ref,
        covers: unitLabels.all(r.id, r.ref).map((x) => x.label), liveFrom: w.from, liveUntil: w.until,
        live: now >= w.from && now <= w.until });
    }
    return out;
  }

  function findCamera(publicId) {
    if (typeof publicId !== 'string' || !/^[A-Za-z0-9_-]{8,40}$/.test(publicId)) return null;
    return db.prepare('SELECT * FROM cameras WHERE public_id = ? AND active = 1').get(publicId);
  }

  function canView(user, camera, now = Date.now()) {
    if (!user || !camera) return false;
    if (user.role === 'admin') return true;
    const key = `${user.id}:${camera.id}`;
    const cached = grantCache.get(key);
    if (cached && cached > now) return true;
    const ok = camerasForUser(user.id, now).some((c) => c.id === camera.public_id && c.live);
    if (ok) grantCache.set(key, now + 15e3); // short: a cancellation takes effect within seconds
    else grantCache.delete(key);
    return ok;
  }

  const revokeAll = () => grantCache.clear();

  function checkSourceUrl(raw, type) {
    if (type === 'demo') return '';
    let u;
    try { u = new URL(raw); } catch { throw new Error('Enter a full http:// or https:// address.'); }
    if (!['http:', 'https:'].includes(u.protocol)) throw new Error('Only http:// and https:// camera addresses are supported.');
    if (allowedHosts.length && !allowedHosts.includes(u.hostname)) {
      throw new Error(`Camera host must be one of: ${allowedHosts.join(', ')} (CAMERA_ALLOWED_HOSTS).`);
    }
    if (type === 'hls' && !u.pathname.endsWith('.m3u8')) throw new Error('An HLS address must end in .m3u8');
    return u.toString();
  }

  async function upstream(url, init = {}) {
    const u = new URL(url);
    const headers = {};
    if (u.username || u.password) {
      headers.authorization = 'Basic ' + Buffer.from(`${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}`).toString('base64');
      u.username = ''; u.password = '';
    }
    return fetch(u, { ...init, headers, redirect: 'error', signal: AbortSignal.timeout(init.timeout || 10000) });
  }

  // HLS: /api/cameras/:id/hls/<file>. The first request (index.m3u8) is the camera's
  // configured playlist; every other file must sit in the same upstream directory.
  async function relayHls(camera, file, query, res) {
    if (!FILE_RE.test(file)) return res.status(400).end();
    const playlist = new URL(camera.source_url);
    const baseDir = new URL('./', playlist);
    const target = file === 'index.m3u8' ? new URL(playlist) : new URL(file, baseDir);
    if (!target.href.startsWith(baseDir.href)) return res.status(400).end();
    for (const k of HLS_QUERY) if (typeof query[k] === 'string' && /^\d{1,10}$|^YES$|^v2$/.test(query[k])) target.searchParams.set(k, query[k]);

    let r;
    try { r = await upstream(target.href, { timeout: file.endsWith('.m3u8') ? 20000 : 15000 }); }
    catch { return res.status(502).json({ error: 'Camera is not responding.' }); }
    if (!r.ok) return res.status(r.status === 404 ? 404 : 502).end();

    res.set('Cache-Control', 'no-store');
    if (file.endsWith('.m3u8')) {
      const text = await r.text();
      if (text.length > 512 * 1024) return res.status(502).end();
      res.type('application/vnd.apple.mpegurl').send(rewritePlaylist(text, target, baseDir));
    } else {
      const type = file.endsWith('.ts') ? 'video/mp2t' : file.endsWith('.aac') ? 'audio/aac' : 'video/mp4';
      res.type(type);
      const buf = Buffer.from(await r.arrayBuffer());
      if (buf.length > 25 * 1024 * 1024) return res.status(502).end();
      res.send(buf);
    }
  }

  async function relaySnapshot(camera, res) {
    res.set('Cache-Control', 'no-store');
    if (camera.source_type === 'demo') return res.type('image/svg+xml').send(demoFrame(camera.name));
    let r;
    try { r = await upstream(camera.source_url, { timeout: 8000 }); }
    catch { return res.status(502).json({ error: 'Camera is not responding.' }); }
    const type = (r.headers.get('content-type') || '').split(';')[0].trim();
    if (!r.ok || !['image/jpeg', 'image/png', 'image/webp'].includes(type)) return res.status(502).end();
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length > 8 * 1024 * 1024) return res.status(502).end();
    res.type(type).send(buf);
  }

  function logView(user, camera, ip) {
    const key = `log:${user.id}:${camera.id}`;
    const now = Date.now();
    if ((grantCache.get(key) || 0) > now) return;
    grantCache.set(key, now + 10 * 60e3);
    audit(db, { userId: user.id, action: 'camera.view', detail: camera.name, ip });
  }

  return { camerasForUser, findCamera, canView, relayHls, relaySnapshot, checkSourceUrl, logView, revokeAll, windowFor };
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
