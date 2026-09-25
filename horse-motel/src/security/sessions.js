// Server-side sessions. The browser holds a random 256-bit token in an HttpOnly,
// SameSite cookie; the database holds only its SHA-256. Sessions expire after a period
// of inactivity and at an absolute limit, and are rotated on every login.
import { randomToken, sha256, safeEqual } from './crypto.js';

export function cookieName(cfg) {
  // The __Host- prefix makes the browser refuse the cookie unless it is Secure, host-only
  // and Path=/, which blocks subdomain cookie-tossing.
  return cfg.cookieSecure ? '__Host-rc_sid' : 'rc_sid';
}

function serializeCookie(cfg, value, maxAgeSeconds) {
  const parts = [`${cookieName(cfg)}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAgeSeconds}`];
  if (cfg.cookieSecure) parts.push('Secure');
  return parts.join('; ');
}

export function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export function createSession(db, cfg, res, userId, { mfaPassed = false } = {}) {
  const token = randomToken();
  const now = Date.now();
  const csrf = randomToken();
  db.prepare(`INSERT INTO sessions (token_hash, user_id, csrf_token, mfa_passed, created_at, last_seen, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`).run(sha256(token), userId, csrf, mfaPassed ? 1 : 0, now, now,
    now + cfg.session.absoluteHours * 3600e3);
  res.append('Set-Cookie', serializeCookie(cfg, token, cfg.session.absoluteHours * 3600));
  return csrf;
}

export function destroySession(db, cfg, req, res) {
  const token = readCookie(req, cookieName(cfg));
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  res.append('Set-Cookie', serializeCookie(cfg, '', 0));
}

export const destroyAllSessions = (db, userId) =>
  db.prepare('DELETE FROM sessions WHERE user_id = ?').run(userId);

// Attaches req.user and req.session when the cookie names a live session.
export function sessionMiddleware(db, cfg) {
  const find = db.prepare(`SELECT s.token_hash, s.csrf_token, s.mfa_passed, s.last_seen, s.expires_at,
      u.id, u.email, u.name, u.phone, u.role, u.totp_enabled
    FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?`);
  const touch = db.prepare('UPDATE sessions SET last_seen = ? WHERE token_hash = ?');
  const drop = db.prepare('DELETE FROM sessions WHERE token_hash = ?');
  return (req, res, next) => {
    req.user = null;
    req.session = null;
    const token = readCookie(req, cookieName(cfg));
    if (!token || token.length > 100) return next();
    const hash = sha256(token);
    const row = find.get(hash);
    const now = Date.now();
    if (!row) return next();
    if (now > row.expires_at || now - row.last_seen > cfg.session.idleMinutes * 60e3) {
      drop.run(hash);
      res.append('Set-Cookie', serializeCookie(cfg, '', 0));
      return next();
    }
    if (now - row.last_seen > 60e3) touch.run(now, hash);
    req.session = { tokenHash: hash, csrf: row.csrf_token, mfaPassed: !!row.mfa_passed };
    req.user = { id: row.id, email: row.email, name: row.name, phone: row.phone, role: row.role,
      totpEnabled: !!row.totp_enabled };
    next();
  };
}

// Cross-site request forgery defence, layered:
//  1. Unsafe requests must come from our own origin (Origin / Sec-Fetch-Site).
//  2. Bodies must be JSON, which a cross-site <form> cannot send without a CORS preflight.
//  3. Signed-in requests must echo the per-session CSRF token in a header.
export function csrfMiddleware(cfg) {
  return (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    const origin = req.headers.origin;
    const site = req.headers['sec-fetch-site'];
    const sameOrigin = origin ? origin === cfg.origin : site === 'same-origin';
    if (!sameOrigin) return res.status(403).json({ error: 'Request blocked (cross-site).' });
    const len = Number(req.headers['content-length'] || 0);
    if ((len > 0 || req.headers['transfer-encoding']) && !req.is('application/json')) {
      return res.status(415).json({ error: 'Send JSON.' });
    }
    if (req.session && !safeEqual(req.headers['x-csrf-token'] || '', req.session.csrf)) {
      return res.status(403).json({ error: 'Your session token is missing or stale. Reload the page and try again.' });
    }
    next();
  };
}

export function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please sign in.' });
  next();
}

// Admins must have a second factor enrolled and used for this session.
export function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Please sign in.' });
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Not allowed.' });
  if (!req.user.totpEnabled) return res.status(403).json({ error: 'Set up two-step verification first.', code: 'mfa_enroll' });
  if (!req.session.mfaPassed) return res.status(403).json({ error: 'Sign in again with your verification code.' });
  next();
}
