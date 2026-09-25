import express from 'express';
import { z } from 'zod';
import { audit } from '../db.js';
import { randomToken, sha256 } from '../security/crypto.js';
import { isIsoDate, todayIn, addDays, daysBetween } from '../dates.js';
import { requireAdmin } from '../security/sessions.js';
import { seal, unseal } from '../security/secretbox.js';
import { BookingError } from '../services/inventory.js';

const isoDate = z.string().refine(isIsoDate, 'Use a real date.');

export function adminRoutes({ db, cfg, inventory, bookings, cameras }) {
  const r = express.Router();
  r.use(requireAdmin);

  r.get('/bookings', (req, res) => {
    const from = isIsoDate(req.query.from) ? req.query.from : addDays(todayIn(cfg.ranch.timezone), -7);
    const rows = db.prepare(`SELECT id, ref, kind, status, email, name, phone, check_in, check_out, house, stalls, rv_sites,
        guests, notes, amount_cents, currency, created_at, stripe_payment_intent
        FROM bookings WHERE check_out >= ? AND status IN ('confirmed','needs_attention','pending')
        ORDER BY check_in, created_at LIMIT 500`).all(from);
    res.json({ bookings: rows.map((b) => ({ ...b, units: inventory.unitsFor(b.id).map((u) => u.label) })) });
  });

  r.post('/bookings/:id/cancel', (req, res) => {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const b = bookings.cancel(id, { byUserId: req.user.id, reason: 'by admin' });
    cameras.revokeAll();
    res.json({ ok: true, note: b.kind === 'guest' && b.stripe_payment_intent && b.stripe_payment_intent !== 'mock'
      ? 'Booking cancelled and camera access ended. Issue any refund from your Stripe dashboard.' : 'Cancelled.' });
  });

  // Re-sends the confirmation (with a fresh set-up link if the guest never set a password).
  r.post('/bookings/:id/resend', async (req, res) => {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const booking = db.prepare("SELECT * FROM bookings WHERE id = ? AND kind = 'guest' AND status = 'confirmed'").get(id);
    if (!booking) throw new BookingError('Only confirmed guest bookings can be re-sent.', 404);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(booking.user_id);
    let setupToken = null;
    if (!user.password_hash) {
      setupToken = randomToken();
      db.prepare("INSERT INTO auth_tokens (token_hash, user_id, purpose, expires_at) VALUES (?, ?, 'setup', ?)")
        .run(sha256(setupToken), user.id, Date.now() + cfg.auth.setupTokenHours * 3600e3);
    }
    await bookings.sendConfirmation({ booking, user, setupToken });
    audit(db, { userId: req.user.id, action: 'admin.resend', detail: booking.ref, ip: req.ip });
    res.json({ ok: true });
  });

  // Mark a paid-but-flagged booking as resolved after sorting it out with the guest.
  r.post('/bookings/:id/resolve', (req, res) => {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const b = db.prepare("SELECT * FROM bookings WHERE id = ? AND status = 'needs_attention'").get(id);
    if (!b) throw new BookingError('That booking doesn’t need attention.', 404);
    bookings.cancel(id, { byUserId: req.user.id, reason: 'resolved by admin (refunded)' });
    res.json({ ok: true, note: 'Marked resolved and released. Refund the payment from Stripe if you haven’t.' });
  });

  r.post('/users/reset-mfa', (req, res) => {
    const { email } = z.object({ email: z.string().trim().toLowerCase().email() }).strict().parse(req.body);
    const u = db.prepare("SELECT id FROM users WHERE email = ? AND role = 'guest'").get(email);
    if (!u) throw new BookingError('No guest account with that email.', 404);
    db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?').run(u.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    audit(db, { userId: req.user.id, action: 'admin.reset_guest_mfa', detail: email, ip: req.ip });
    res.json({ ok: true });
  });

  r.post('/blocks', (req, res) => {
    const body = z.object({
      checkIn: isoDate, checkOut: isoDate, house: z.boolean(),
      stalls: z.number().int().min(0).max(cfg.inventory.stalls),
      rvSites: z.number().int().min(0).max(cfg.inventory.rvSites),
      note: z.string().trim().max(200).optional(),
    }).strict().parse(req.body);
    if (body.checkOut <= body.checkIn) throw new BookingError('The end date must be after the start date.');
    const today = todayIn(cfg.ranch.timezone);
    if (body.checkIn < addDays(today, -1) || body.checkOut > addDays(today, cfg.inventory.bookingWindowDays + 1) ||
        daysBetween(body.checkIn, body.checkOut) > 366) {
      throw new BookingError('Blocks must be within the booking window and at most a year long.');
    }
    if (!body.house && !body.stalls && !body.rvSites) throw new BookingError('Choose what to block.');
    const b = bookings.block(body, req.user.id);
    res.status(201).json({ ok: true, ref: b.ref });
  });

  r.get('/units', (req, res) => {
    res.json({ units: db.prepare('SELECT id, kind, number, label FROM units WHERE active = 1 ORDER BY kind, number').all() });
  });

  // Camera addresses can hold credentials, so the admin list shows only the host.
  r.get('/cameras', (req, res) => {
    const list = db.prepare('SELECT * FROM cameras ORDER BY name').all().map((c) => {
      let host = '';
      try { host = c.source_url ? new URL(unseal(c.source_url)).host : ''; } catch { /* ignore */ }
      const units = db.prepare('SELECT unit_id FROM camera_units WHERE camera_id = ?').all(c.id).map((x) => x.unit_id);
      return { id: c.id, publicId: c.public_id, name: c.name, sourceType: c.source_type, host, active: !!c.active, unitIds: units };
    });
    res.json({ cameras: list });
  });

  const cameraBody = z.object({
    name: z.string().trim().min(1, 'Name the camera.').max(60),
    sourceType: z.enum(['hls', 'snapshot', 'demo']),
    sourceUrl: z.string().trim().max(500).optional().default(''),
    unitIds: z.array(z.number().int().positive()).max(20),
    active: z.boolean().optional().default(true),
  }).strict();

  function saveUnits(cameraId, unitIds) {
    const valid = new Set(db.prepare('SELECT id FROM units WHERE active = 1').all().map((u) => u.id));
    db.prepare('DELETE FROM camera_units WHERE camera_id = ?').run(cameraId);
    const ins = db.prepare('INSERT INTO camera_units (camera_id, unit_id) VALUES (?, ?)');
    for (const u of new Set(unitIds)) if (valid.has(u)) ins.run(cameraId, u);
  }

  function sourceFor(body, existing) {
    // Leaving the address blank on edit keeps the stored one (it is never sent to the browser).
    if (existing && !body.sourceUrl && body.sourceType === existing.source_type) return existing.source_url;
    try { return seal(cameras.checkSourceUrl(body.sourceUrl, body.sourceType)); }
    catch (e) { throw new BookingError(e.message); }
  }

  r.post('/cameras', (req, res) => {
    const body = cameraBody.parse(req.body);
    const url = sourceFor(body, null);
    const id = db.transaction(() => {
      const info = db.prepare('INSERT INTO cameras (public_id, name, source_type, source_url, active) VALUES (?, ?, ?, ?, ?)')
        .run(randomToken(12), body.name, body.sourceType, url, body.active ? 1 : 0);
      saveUnits(info.lastInsertRowid, body.unitIds);
      return info.lastInsertRowid;
    })();
    audit(db, { userId: req.user.id, action: 'admin.camera_added', detail: body.name, ip: req.ip });
    cameras.revokeAll();
    res.status(201).json({ ok: true, id });
  });

  r.put('/cameras/:id', (req, res) => {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    const existing = db.prepare('SELECT * FROM cameras WHERE id = ?').get(id);
    if (!existing) throw new BookingError('No such camera.', 404);
    const body = cameraBody.parse(req.body);
    const url = sourceFor(body, existing);
    db.transaction(() => {
      db.prepare('UPDATE cameras SET name = ?, source_type = ?, source_url = ?, active = ? WHERE id = ?')
        .run(body.name, body.sourceType, url, body.active ? 1 : 0, id);
      saveUnits(id, body.unitIds);
    })();
    audit(db, { userId: req.user.id, action: 'admin.camera_updated', detail: body.name, ip: req.ip });
    cameras.revokeAll();
    res.json({ ok: true });
  });

  r.delete('/cameras/:id', (req, res) => {
    const id = z.coerce.number().int().positive().parse(req.params.id);
    db.prepare('DELETE FROM cameras WHERE id = ?').run(id);
    audit(db, { userId: req.user.id, action: 'admin.camera_deleted', detail: String(id), ip: req.ip });
    cameras.revokeAll();
    res.json({ ok: true });
  });

  r.get('/audit', (req, res) => {
    const rows = db.prepare(`SELECT a.at, a.action, a.detail, a.ip, u.email FROM audit_log a
      LEFT JOIN users u ON u.id = a.user_id ORDER BY a.id DESC LIMIT 200`).all();
    res.json({ entries: rows });
  });

  return r;
}
