import express from 'express';
import { rateLimit } from 'express-rate-limit';
import QRCode from 'qrcode';
import { z } from 'zod';
import { audit } from '../db.js';
import { hashPassword, verifyPassword, passwordProblem } from '../security/password.js';
import { newTotpSecret, totpUri, verifyTotp } from '../security/totp.js';
import { requireUser, createSession, destroySession, destroyAllSessions } from '../security/sessions.js';
import { publicUser } from './auth.js';
import { seal, unseal } from '../security/secretbox.js';

export function accountRoutes({ db, cfg, inventory, cameras }) {
  const r = express.Router();
  r.use(requireUser);
  const sensitive = rateLimit({ windowMs: 15 * 60e3, limit: cfg.rateLimits.accountPer15Min, standardHeaders: 'draft-7', legacyHeaders: false,
    message: { error: 'Too many attempts. Please wait 15 minutes.' } });
  const loadUser = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  function revokeEverything(userId) {
    destroyAllSessions(db, userId);
    db.prepare('DELETE FROM auth_tokens WHERE user_id = ? AND used_at IS NULL').run(userId);
    db.prepare('DELETE FROM mfa_challenges WHERE user_id = ?').run(userId);
  }

  r.get('/', (req, res) => {
    const rows = db.prepare(`SELECT id, ref, status, check_in, check_out, house, stalls, rv_sites, rv_sewer, guests, amount_cents, refund_cents, currency
        FROM bookings WHERE user_id = ? AND kind = 'guest' AND status IN ('confirmed','needs_attention','cancelled')
        ORDER BY check_in DESC LIMIT 50`).all(req.user.id);
    const bookings = rows.map((b) => ({
      ref: b.ref, status: b.status, checkIn: b.check_in, checkOut: b.check_out, house: !!b.house,
      stalls: b.stalls, rvSites: b.rv_sites, rvSewer: b.rv_sewer, guests: b.guests, amount: b.amount_cents,
      refunded: b.refund_cents, currency: b.currency,
      units: b.status === 'confirmed' ? inventory.unitsFor(b.id).map((u) => u.label) : [],
    }));
    res.json({ user: publicUser(req.user), bookings, cameras: cameras.camerasForUser(req.user.id),
      ranch: { name: cfg.ranch.name, timezone: cfg.ranch.timezone, checkInHour: cfg.ranch.checkInHour, checkOutHour: cfg.ranch.checkOutHour,
        phone: cfg.ranch.phone, email: cfg.ranch.email } });
  });

  r.post('/profile', (req, res) => {
    const body = z.object({
      name: z.string().trim().min(2, 'Enter your name.').max(80),
      phone: z.string().trim().max(25).regex(/^[0-9+().\-\s]*$/, 'Use digits, spaces and + ( ) - only.'),
    }).strict().parse(req.body);
    db.prepare('UPDATE users SET name = ?, phone = ? WHERE id = ?').run(body.name, body.phone, req.user.id);
    res.json({ ok: true });
  });

  r.post('/password', sensitive, async (req, res) => {
    const body = z.object({ current: z.string().max(200), next: z.string().max(200) }).strict().parse(req.body);
    const user = loadUser(req.user.id);
    if (!(await verifyPassword(body.current, user.password_hash))) {
      return res.status(400).json({ error: 'Your current password isn’t right.', field: 'current' });
    }
    const problem = passwordProblem(body.next, { email: user.email });
    if (problem) return res.status(400).json({ error: problem, field: 'next' });
    db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(body.next), user.id);
    // Sign out every other device, kill any outstanding reset links, then give this one a
    // fresh session.
    revokeEverything(user.id);
    const csrf = createSession(db, cfg, res, user.id, { mfaPassed: req.session.mfaPassed });
    audit(db, { userId: user.id, action: 'account.password_changed', ip: req.ip });
    res.json({ ok: true, csrf });
  });

  r.post('/logout-everywhere', (req, res) => {
    revokeEverything(req.user.id);
    destroySession(db, cfg, req, res);
    audit(db, { userId: req.user.id, action: 'account.logout_all', ip: req.ip });
    res.json({ ok: true });
  });

  // Two-step verification (authenticator app). Optional for guests, required for admins.
  r.post('/mfa/start', sensitive, async (req, res) => {
    const body = z.object({ password: z.string().max(200) }).strict().parse(req.body);
    const user = loadUser(req.user.id);
    if (!(await verifyPassword(body.password, user.password_hash))) {
      return res.status(400).json({ error: 'Your password isn’t right.', field: 'password' });
    }
    if (user.totp_enabled) return res.status(400).json({ error: 'Two-step verification is already on.' });
    const secret = newTotpSecret();
    db.prepare('UPDATE users SET totp_secret = ? WHERE id = ?').run(seal(secret), user.id);
    const uri = totpUri(secret, user.email, cfg.ranch.name);
    const qr = await QRCode.toDataURL(uri, { margin: 1, width: 220, errorCorrectionLevel: 'M' });
    res.json({ secret, qr });
  });

  r.post('/mfa/confirm', sensitive, (req, res) => {
    const body = z.object({ code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code.') }).strict().parse(req.body);
    const user = loadUser(req.user.id);
    const step = user.totp_secret && !user.totp_enabled ? verifyTotp(unseal(user.totp_secret), body.code, user.totp_last_step) : 0;
    if (!step) return res.status(400).json({ error: 'That code didn’t match. Codes change every 30 seconds — try the current one.', field: 'code' });
    db.prepare('UPDATE users SET totp_enabled = 1, totp_last_step = ? WHERE id = ?').run(step, user.id);
    destroyAllSessions(db, user.id);
    const csrf = createSession(db, cfg, res, user.id, { mfaPassed: true });
    audit(db, { userId: user.id, action: 'account.mfa_enabled', ip: req.ip });
    res.json({ ok: true, csrf });
  });

  r.post('/mfa/disable', sensitive, async (req, res) => {
    const body = z.object({ password: z.string().max(200), code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code.') }).strict().parse(req.body);
    const user = loadUser(req.user.id);
    if (user.role === 'admin') return res.status(403).json({ error: 'Admin accounts must keep two-step verification on.' });
    const step = verifyTotp(unseal(user.totp_secret), body.code, user.totp_last_step);
    if (!(await verifyPassword(body.password, user.password_hash)) || !step) {
      return res.status(400).json({ error: 'Password or code is not right.' });
    }
    db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL, totp_last_step = ? WHERE id = ?').run(step, user.id);
    audit(db, { userId: user.id, action: 'account.mfa_disabled', ip: req.ip });
    res.json({ ok: true });
  });

  return r;
}
