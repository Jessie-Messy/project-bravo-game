import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { audit } from '../db.js';
import { randomToken, sha256 } from '../security/crypto.js';
import { hashPassword, verifyPassword, passwordProblem } from '../security/password.js';
import { verifyTotp } from '../security/totp.js';
import { unseal } from '../security/secretbox.js';
import { createSession, destroySession, destroyAllSessions } from '../security/sessions.js';

const email = z.string().trim().toLowerCase().max(254).email('Enter a valid email address.');
const token = z.string().regex(/^[A-Za-z0-9_-]{20,64}$/, 'This link is not valid.');
const GENERIC_LOGIN_ERROR = 'That email and password don’t match. After several failed tries, sign-in pauses for a while and we email the account owner.';

export function publicUser(u) {
  return { email: u.email, name: u.name, phone: u.phone, role: u.role, totpEnabled: !!(u.totpEnabled ?? u.totp_enabled) };
}

export function authRoutes({ db, cfg, mailer }) {
  const r = express.Router();
  const limiter = rateLimit({ windowMs: 15 * 60e3, limit: cfg.rateLimits.authPer15Min, standardHeaders: 'draft-7', legacyHeaders: false,
    message: { error: 'Too many attempts from your network. Please wait 15 minutes and try again.' } });
  const findByEmail = db.prepare('SELECT * FROM users WHERE email = ?');

  r.get('/session', (req, res) => {
    res.json({ user: req.user ? publicUser(req.user) : null, csrf: req.session?.csrf || null,
      mfaPassed: !!req.session?.mfaPassed });
  });

  // Sign-in attempts are counted per account BEFORE the slow password check, in one
  // synchronous step, so parallel guesses can't slip past the limit. Password and 2-step
  // failures share one budget of 5; the account owner is emailed when their account locks.
  // Two separate budgets:
  //  - wrong passwords (anyone who knows an email can cause these): a short, fixed pause
  //    that never escalates, so nobody can lock an owner out for long;
  //  - wrong 2-step codes after a correct password (the password is known): each lock
  //    doubles, up to a day. A correct password never resets this budget.
  const counter = { password: 'failed_logins', '2-step': 'mfa_failures' };
  const bump = {
    password: db.prepare(`UPDATE users SET failed_logins = failed_logins + 1 WHERE id = ? AND locked_until <= ?
        RETURNING failed_logins AS n, lock_level`),
    '2-step': db.prepare(`UPDATE users SET mfa_failures = mfa_failures + 1 WHERE id = ? AND locked_until <= ?
        RETURNING mfa_failures AS n, lock_level`),
  };

  function lockNow(user, reason, ip) {
    const escalate = reason === '2-step';
    const minutes = escalate ? Math.min(cfg.auth.lockMinutes * 2 ** user.lock_level, cfg.auth.maxLockHours * 60) : cfg.auth.lockMinutes;
    db.prepare(`UPDATE users SET ${counter[reason]} = 0, lock_level = lock_level + ?, locked_until = ? WHERE id = ?`)
      .run(escalate ? 1 : 0, Date.now() + minutes * 60e3, user.id);
    db.prepare('DELETE FROM mfa_challenges WHERE user_id = ?').run(user.id);
    audit(db, { userId: user.id, action: 'auth.locked', detail: `${reason}, ${minutes} min`, ip });
    mailer.send({
      to: user.email,
      subject: `Sign-in paused on your ${cfg.ranch.name} account`,
      text: escalate
        ? `Someone entered your password correctly but then got the 2-step verification code wrong several times, so sign-in is paused for ${minutes} minutes.\n\nIf this wasn’t you, your password is known to someone else: change it as soon as you can (use “Forgot password” on the sign-in page).`
        : `There were several failed attempts to sign in to your account, so sign-in is paused for ${minutes} minutes.\n\nIf this wasn’t you, you don’t need to do anything — but make sure your password isn’t used on any other website.`,
    }).catch(() => {});
  }

  // Reserves one attempt before the (slow) check. Returns false when the account is, or
  // just became, locked.
  function takeAttempt(user, reason, ip) {
    const row = bump[reason].get(user.id, Date.now());
    if (!row) return false;
    if (row.n > cfg.auth.maxFailedLogins) {
      lockNow({ ...user, lock_level: row.lock_level }, reason, ip);
      return false;
    }
    return true;
  }
  // After a failure: the 5th one locks straight away.
  function afterFailure(user, reason, ip) {
    const row = db.prepare(`SELECT ${counter[reason]} AS n, lock_level, locked_until FROM users WHERE id = ?`).get(user.id);
    if (row.locked_until <= Date.now() && row.n >= cfg.auth.maxFailedLogins) lockNow({ ...user, lock_level: row.lock_level }, reason, ip);
  }
  const isLocked = (id) => db.prepare('SELECT locked_until FROM users WHERE id = ?').get(id).locked_until > Date.now();
  const clearFailures = (id) => db.prepare('UPDATE users SET failed_logins = 0, mfa_failures = 0, lock_level = 0, locked_until = 0 WHERE id = ?').run(id);

  r.post('/login', limiter, async (req, res) => {
    const body = z.object({ email, password: z.string().min(1, 'Enter your password.').max(200) }).strict().parse(req.body);
    const user = findByEmail.get(body.email);
    const allowed = user ? takeAttempt(user, 'password', req.ip) : false;
    // Hash even when refusing, so timing doesn't reveal which accounts exist or are locked.
    const ok = await verifyPassword(body.password, allowed ? user.password_hash : null);
    if (!ok || !allowed || isLocked(user.id)) {
      if (user && allowed && !ok) afterFailure(user, 'password', req.ip);
      audit(db, { userId: user?.id ?? null, action: 'auth.login_failed', ip: req.ip });
      return res.status(401).json({ error: GENERIC_LOGIN_ERROR });
    }

    if (user.totp_enabled) {
      // The password was right: its budget resets. The 2-step budget does not.
      db.prepare('UPDATE users SET failed_logins = 0 WHERE id = ?').run(user.id);
      db.prepare('DELETE FROM mfa_challenges WHERE user_id = ?').run(user.id);
      const challenge = randomToken();
      db.prepare('INSERT INTO mfa_challenges (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
        .run(sha256(challenge), user.id, Date.now() + 5 * 60e3);
      return res.json({ mfaRequired: true, challenge });
    }
    clearFailures(user.id);
    destroySession(db, cfg, req, res);
    const csrf = createSession(db, cfg, res, user.id);
    audit(db, { userId: user.id, action: 'auth.login', ip: req.ip });
    res.json({ user: publicUser(user), csrf });
  });

  r.post('/mfa', limiter, (req, res) => {
    const body = z.object({ challenge: token, code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code.') }).strict().parse(req.body);
    const hash = sha256(body.challenge);
    const ch = db.prepare('SELECT * FROM mfa_challenges WHERE token_hash = ?').get(hash);
    const expired = { error: 'That sign-in attempt expired. Please start again.', restart: true };
    if (!ch || ch.expires_at < Date.now() || ch.attempts >= 3) {
      if (ch) db.prepare('DELETE FROM mfa_challenges WHERE token_hash = ?').run(hash);
      return res.status(401).json(expired);
    }
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(ch.user_id);
    if (!takeAttempt(user, '2-step', req.ip)) {
      db.prepare('DELETE FROM mfa_challenges WHERE token_hash = ?').run(hash);
      return res.status(401).json({ ...expired, error: GENERIC_LOGIN_ERROR });
    }
    const step = verifyTotp(unseal(user.totp_secret), body.code, user.totp_last_step);
    if (!step) {
      db.prepare('UPDATE mfa_challenges SET attempts = attempts + 1 WHERE token_hash = ?').run(hash);
      audit(db, { userId: user.id, action: 'auth.mfa_failed', ip: req.ip });
      afterFailure(user, '2-step', req.ip);
      return res.status(401).json({ error: 'That code didn’t work. Check your authenticator app and try again.' });
    }
    db.prepare('DELETE FROM mfa_challenges WHERE user_id = ?').run(user.id);
    db.prepare('UPDATE users SET totp_last_step = ? WHERE id = ?').run(step, user.id);
    clearFailures(user.id);
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
    const row = db.prepare(`SELECT t.*, u.email, u.role, u.totp_enabled FROM auth_tokens t JOIN users u ON u.id = t.user_id
      WHERE t.token_hash = ?`).get(sha256(t));
    if (!row || row.used_at || row.expires_at < Date.now()) return null;
    return row;
  }

  r.post('/token-info', limiter, (req, res) => {
    const body = z.object({ token }).strict().parse(req.body);
    const row = liveToken(body.token);
    if (!row) return res.status(404).json({ error: 'This link has expired or was already used. You can request a new one from “Forgot password”.' });
    res.json({ purpose: row.purpose, email: row.email, role: row.role });
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
      db.prepare('UPDATE users SET password_hash = ?, failed_logins = 0, mfa_failures = 0, lock_level = 0, locked_until = 0 WHERE id = ?').run(hash, row.user_id);
      db.prepare('DELETE FROM mfa_challenges WHERE user_id = ?').run(row.user_id);
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
