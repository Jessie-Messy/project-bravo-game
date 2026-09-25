import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { audit } from '../db.js';
import { randomToken, sha256 } from '../security/crypto.js';
import { hashPassword, verifyPassword, passwordProblem } from '../security/password.js';
import { verifyTotp } from '../security/totp.js';
import { createSession, destroySession, destroyAllSessions } from '../security/sessions.js';

const email = z.string().trim().toLowerCase().max(254).email('Enter a valid email address.');
const token = z.string().regex(/^[A-Za-z0-9_-]{20,64}$/, 'This link is not valid.');
const GENERIC_LOGIN_ERROR = 'That email and password don’t match. After several failed tries, sign-in pauses for 15 minutes.';

export function publicUser(u) {
  return { email: u.email, name: u.name, phone: u.phone, role: u.role, totpEnabled: !!(u.totpEnabled ?? u.totp_enabled) };
}

export function authRoutes({ db, cfg, mailer }) {
  const r = express.Router();
  const limiter = rateLimit({ windowMs: 15 * 60e3, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false,
    message: { error: 'Too many attempts from your network. Please wait 15 minutes and try again.' } });
  const findByEmail = db.prepare('SELECT * FROM users WHERE email = ?');

  r.get('/session', (req, res) => {
    res.json({ user: req.user ? publicUser(req.user) : null, csrf: req.session?.csrf || null,
      mfaPassed: !!req.session?.mfaPassed });
  });

  r.post('/login', limiter, async (req, res) => {
    const body = z.object({ email, password: z.string().min(1, 'Enter your password.').max(200) }).strict().parse(req.body);
    const user = findByEmail.get(body.email);
    const now = Date.now();
    const locked = user && user.locked_until > now;
    const ok = await verifyPassword(body.password, locked ? null : user?.password_hash);
    if (!ok) {
      if (user && !locked) {
        const fails = user.failed_logins + 1;
        if (fails >= cfg.auth.maxFailedLogins) {
          db.prepare('UPDATE users SET failed_logins = 0, locked_until = ? WHERE id = ?').run(now + cfg.auth.lockMinutes * 60e3, user.id);
          audit(db, { userId: user.id, action: 'auth.locked', ip: req.ip });
        } else {
          db.prepare('UPDATE users SET failed_logins = ? WHERE id = ?').run(fails, user.id);
        }
      }
      audit(db, { userId: user?.id ?? null, action: 'auth.login_failed', ip: req.ip });
      return res.status(401).json({ error: GENERIC_LOGIN_ERROR });
    }
    db.prepare('UPDATE users SET failed_logins = 0, locked_until = 0 WHERE id = ?').run(user.id);

    if (user.totp_enabled) {
      const challenge = randomToken();
      db.prepare('INSERT INTO mfa_challenges (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
        .run(sha256(challenge), user.id, now + 5 * 60e3);
      return res.json({ mfaRequired: true, challenge });
    }
    destroySession(db, cfg, req, res);
    const csrf = createSession(db, cfg, res, user.id);
    audit(db, { userId: user.id, action: 'auth.login', ip: req.ip });
    res.json({ user: publicUser(user), csrf });
  });

  r.post('/mfa', limiter, (req, res) => {
    const body = z.object({ challenge: token, code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code.') }).strict().parse(req.body);
    const hash = sha256(body.challenge);
    const ch = db.prepare('SELECT * FROM mfa_challenges WHERE token_hash = ?').get(hash);
    if (!ch || ch.expires_at < Date.now() || ch.attempts >= 5) {
      if (ch) db.prepare('DELETE FROM mfa_challenges WHERE token_hash = ?').run(hash);
      return res.status(401).json({ error: 'That sign-in attempt expired. Please start again.', restart: true });
    }
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(ch.user_id);
    const step = verifyTotp(user.totp_secret, body.code, user.totp_last_step);
    if (!step) {
      db.prepare('UPDATE mfa_challenges SET attempts = attempts + 1 WHERE token_hash = ?').run(hash);
      audit(db, { userId: user.id, action: 'auth.mfa_failed', ip: req.ip });
      return res.status(401).json({ error: 'That code didn’t work. Check your authenticator app and try again.' });
    }
    db.prepare('DELETE FROM mfa_challenges WHERE token_hash = ?').run(hash);
    db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ?').run(step, user.id);
    destroySession(db, cfg, req, res);
    const csrf = createSession(db, cfg, res, user.id, { mfaPassed: true });
    audit(db, { userId: user.id, action: 'auth.login', detail: 'with 2-step', ip: req.ip });
    res.json({ user: publicUser(user), csrf });
  });

  r.post('/logout', (req, res) => {
    if (req.user) audit(db, { userId: req.user.id, action: 'auth.logout', ip: req.ip });
    destroySession(db, cfg, req, res);
    res.json({ ok: true });
  });

  // Always answers the same way, whether or not the address has an account.
  r.post('/forgot', limiter, async (req, res) => {
    const body = z.object({ email }).strict().parse(req.body);
    const user = findByEmail.get(body.email);
    if (user) {
      const recent = db.prepare("SELECT COUNT(*) AS n FROM auth_tokens WHERE user_id = ? AND purpose = 'reset' AND expires_at > ?")
        .get(user.id, Date.now() - 3600e3 + cfg.auth.resetTokenMinutes * 60e3).n;
      if (recent < 3) {
        const t = randomToken();
        db.prepare("INSERT INTO auth_tokens (token_hash, user_id, purpose, expires_at) VALUES (?, ?, 'reset', ?)")
          .run(sha256(t), user.id, Date.now() + cfg.auth.resetTokenMinutes * 60e3);
        audit(db, { userId: user.id, action: 'auth.reset_requested', ip: req.ip });
        mailer.send({
          to: user.email,
          subject: `Reset your ${cfg.ranch.name} password`,
          text: `Someone (hopefully you) asked to reset the password for this account.\n\nThe link below works once and expires in ${cfg.auth.resetTokenMinutes} minutes. If you didn’t ask for this, you can ignore this email — your password won’t change.`,
          action: { label: 'Choose a new password', url: `${cfg.origin}/setup#token=${t}` },
        }).catch((e) => console.error('[mail] reset failed', e.message));
      }
    }
    res.json({ ok: true });
  });

  function liveToken(t) {
    const row = db.prepare(`SELECT t.*, u.email, u.totp_enabled FROM auth_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = ?`).get(sha256(t));
    if (!row || row.used_at || row.expires_at < Date.now()) return null;
    return row;
  }

  r.post('/token-info', limiter, (req, res) => {
    const body = z.object({ token }).strict().parse(req.body);
    const row = liveToken(body.token);
    if (!row) return res.status(404).json({ error: 'This link has expired or was already used. You can request a new one from “Forgot password”.' });
    res.json({ purpose: row.purpose, email: row.email });
  });

  r.post('/set-password', limiter, async (req, res) => {
    const body = z.object({ token, password: z.string().max(200) }).strict().parse(req.body);
    const row = liveToken(body.token);
    if (!row) return res.status(404).json({ error: 'This link has expired or was already used. You can request a new one from “Forgot password”.' });
    const problem = passwordProblem(body.password, { email: row.email });
    if (problem) return res.status(400).json({ error: problem, field: 'password' });
    const hash = await hashPassword(body.password);
    const consumed = db.transaction(() => {
      const upd = db.prepare('UPDATE auth_tokens SET used_at = ? WHERE token_hash = ? AND used_at IS NULL').run(Date.now(), row.token_hash);
      if (upd.changes !== 1) return false; // lost a race with another tab
      db.prepare('UPDATE users SET password_hash = ?, failed_logins = 0, locked_until = 0 WHERE id = ?').run(hash, row.user_id);
      db.prepare('DELETE FROM auth_tokens WHERE user_id = ? AND used_at IS NULL').run(row.user_id);
      destroyAllSessions(db, row.user_id);
      return true;
    })();
    if (!consumed) return res.status(404).json({ error: 'This link was already used.' });
    audit(db, { userId: row.user_id, action: `auth.password_${row.purpose}`, ip: req.ip });
    if (row.totp_enabled) return res.json({ next: 'login' });
    destroySession(db, cfg, req, res);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(row.user_id);
    const csrf = createSession(db, cfg, res, user.id);
    res.json({ user: publicUser(user), csrf });
  });

  return r;
}
