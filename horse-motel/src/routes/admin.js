import express from 'express';
import { z } from 'zod';
import { audit } from '../db.js';
import { randomToken, sha256 } from '../security/crypto.js';
import { isIsoDate, todayIn, addDays, daysBetween } from '../dates.js';
import { requireAdmin } from '../security/sessions.js';
import { seal, unseal } from '../security/secretbox.js';
import { BookingError, stayRequestSchema } from '../services/inventory.js';

const isoDate = z.string().refine(isIsoDate, 'Use a real date.');

export function adminRoutes({ db, cfg, inventory, bookings, cameras, ical }) {
  const r = express.Router();
  r.use(requireAdmin);

  const idParam = (req) => z.coerce.number().int().positive().parse(req.params.id);
  const contactSchema = z.object({
    name: z.string().trim().min(2, 'Enter the guest’s name.').max(80),
    email: z.string().trim().toLowerCase().max(254).email('Enter a valid email address.'),
    phone: z.string().trim().max(25).regex(/^[0-9+().\-\s]*$/, 'Use digits, spaces and + ( ) - only.'),
    notes: z.string().trim().max(500).optional().default(''),
  }).strict();

  // Bookings list. view: upcoming (default) | attention | cancelled | past | all; q searches
  // name, email, phone and reference.
  r.get('/bookings', (req, res) => {
    const today = todayIn(cfg.ranch.timezone);
    const view = ['upcoming', 'attention', 'cancelled', 'past', 'all'].includes(req.query.view) ? req.query.view : 'upcoming';
    const where = {
      upcoming: "check_out >= @today AND status IN ('confirmed','needs_attention','pending')",
      attention: "status = 'needs_attention'",
      cancelled: "status = 'cancelled' AND kind = 'guest'",
      past: "check_out < @today AND status = 'confirmed'",
      all: "status IN ('confirmed','needs_attention','pending','cancelled')",
    }[view];
    const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 80) : '';
    const search = q ? ' AND (name LIKE @q OR email LIKE @q OR phone LIKE @q OR ref LIKE @q)' : '';
    const order = view === 'past' || view === 'cancelled' ? 'check_in DESC' : 'check_in, created_at';
    const rows = db.prepare(`SELECT id, ref, kind, status, email, name, phone, check_in, check_out, house, stalls, rv_sites, rv_sewer,
        guests, notes, amount_cents, refund_cents, currency, created_at, confirmed_at, source, stripe_payment_intent
        FROM bookings WHERE ${where}${search} ORDER BY ${order} LIMIT 300`).all({ today, q: `%${q}%` });
    const since = Date.now() - 2 * 86400e3;
    res.json({ view, bookings: rows.map((b) => ({ ...b, stripe_payment_intent: undefined,
      paidOnline: !!b.stripe_payment_intent && b.stripe_payment_intent !== 'mock',
      isNew: b.kind === 'guest' && (b.confirmed_at || 0) > since,
      units: inventory.unitsFor(b.id).map((u) => u.label) })) });
  });

  r.post('/bookings/:id/cancel', async (req, res) => {
    const id = idParam(req);
    const body = z.object({ refund: z.boolean().optional().default(false), notify: z.boolean().optional().default(false) })
      .strict().parse(req.body || {});
    const out = await bookings.cancel(id, { byUserId: req.user.id, reason: 'by admin', ...body });
    const money = (c) => `$${(c / 100).toFixed(2)}`;
    let note = out.booking.kind === 'block' ? 'Block removed.' : 'Booking cancelled and camera access ended.';
    if (out.refunded) note += ` Refunded ${money(out.refunded)}.`;
    if (out.refundError) note += ` The refund did NOT go through (${out.refundError}); refund it from your Stripe dashboard.`;
    else if (body.refund && !out.refunded && out.booking.kind === 'guest') note += ' No online payment to refund.';
    if (body.notify) note += ' The guest has been emailed.';
    audit(db, { userId: req.user.id, action: 'admin.cancel', detail: `${out.booking.ref} refund=${out.refunded}`, ip: req.ip });
    res.json({ ok: true, note });
  });

  // Re-sends the confirmation (with a fresh set-up link if the guest never set a password).
  r.post('/bookings/:id/resend', async (req, res) => {
    const booking = db.prepare("SELECT * FROM bookings WHERE id = ? AND kind = 'guest' AND status = 'confirmed'").get(idParam(req));
    if (!booking) throw new BookingError('Only confirmed guest bookings can be re-sent.', 404);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(booking.user_id);
    let setupToken = null;
    if (!user.password_hash) {
      setupToken = randomToken();
      db.prepare("INSERT INTO auth_tokens (token_hash, user_id, purpose, expires_at) VALUES (?, ?, 'setup', ?)")
        .run(sha256(setupToken), user.id, Date.now() + cfg.auth.setupTokenHours * 3600e3);
    }
    await bookings.sendConfirmation({ booking, user, setupToken }, { alertOwner: false });
    audit(db, { userId: req.user.id, action: 'admin.resend', detail: booking.ref, ip: req.ip });
    res.json({ ok: true, note: `Confirmation re-sent to ${booking.email}.` });
  });

  // Fix a mistyped email: moves the stay (and its cameras) to the right account.
  r.post('/bookings/:id/email', async (req, res) => {
    const { email } = z.object({ email: contactSchema.shape.email }).strict().parse(req.body);
    const b = await bookings.changeEmail(idParam(req), email, req.user.id);
    res.json({ ok: true, note: `${b.ref} now belongs to ${email}, and the confirmation was sent there.` });
  });

  // Mark a paid-but-flagged booking as resolved after sorting it out with the guest.
  r.post('/bookings/:id/resolve', async (req, res) => {
    const id = idParam(req);
    const b = db.prepare("SELECT * FROM bookings WHERE id = ? AND status = 'needs_attention'").get(id);
    if (!b) throw new BookingError('That booking doesn’t need attention.', 404);
    const body = z.object({ refund: z.boolean().optional().default(true) }).strict().parse(req.body || {});
    const out = await bookings.cancel(id, { byUserId: req.user.id, reason: 'resolved by admin', refund: body.refund, notify: true });
    res.json({ ok: true, note: out.refunded ? `Resolved and refunded $${(out.refunded / 100).toFixed(2)}.`
      : 'Resolved. Refund the payment from your Stripe dashboard if it hasn’t been.' });
  });

  // A booking taken by phone or in person. The guest gets the same welcome email and
  // camera access as an online booking.
  r.post('/bookings', async (req, res) => {
    const body = z.object({
      stay: stayRequestSchema(cfg),
      contact: contactSchema,
      amountCents: z.number().int().min(0).max(10_000_000).optional(),
    }).strict().parse(req.body);
    const b = await bookings.createManual(body, req.user.id);
    res.status(201).json({ ok: true, ref: b.ref, note: `Booked ${b.ref}. ${b.email} has been sent their confirmation and camera access.` });
  });

  r.post('/users/reset-mfa', (req, res) => {
    const { email } = z.object({ email: z.string().trim().toLowerCase().email('Enter a valid email address.') }).strict().parse(req.body);
    const u = db.prepare("SELECT id FROM users WHERE email = ? AND role = 'guest'").get(email);
    if (!u) throw new BookingError('No guest account with that email.', 404);
    db.prepare('UPDATE users SET totp_enabled = 0, totp_secret = NULL WHERE id = ?').run(u.id);
    db.prepare('DELETE FROM sessions WHERE user_id = ?').run(u.id);
    audit(db, { userId: req.user.id, action: 'admin.reset_guest_mfa', detail: email, ip: req.ip });
    res.json({ ok: true });
  });

  // Block specific stalls / sites / the house (maintenance, private use, out of service).
  r.post('/blocks', (req, res) => {
    const body = z.object({
      checkIn: isoDate, checkOut: isoDate,
      unitIds: z.array(z.number().int().positive()).min(1, 'Tick at least one thing to block.').max(200),
      note: z.string().trim().max(200).optional(),
    }).strict().parse(req.body);
    if (body.checkOut <= body.checkIn) throw new BookingError('The end date must be after the start date.');
    const today = todayIn(cfg.ranch.timezone);
    if (body.checkIn < addDays(today, -1) || body.checkOut > addDays(today, cfg.inventory.bookingWindowDays + 1) ||
        daysBetween(body.checkIn, body.checkOut) > 366) {
      throw new BookingError('Blocks must be within the booking window and at most a year long.');
    }
    const valid = new Set(db.prepare('SELECT id FROM units WHERE active = 1').all().map((u) => u.id));
    if (!body.unitIds.every((id) => valid.has(id))) throw new BookingError('Unknown stall or site.');
    const b = bookings.block({ ...body, unitIds: [...new Set(body.unitIds)] }, req.user.id);
    res.status(201).json({ ok: true, ref: b.ref });
  });

  // Who is in which stall / site / the house, night by night.
  r.get('/occupancy', (req, res) => {
    const from = isIsoDate(req.query.from) ? req.query.from : todayIn(cfg.ranch.timezone);
    const days = Math.min(Math.max(Number.parseInt(req.query.days, 10) || 14, 1), 31);
    const to = addDays(from, days);
    const units = db.prepare('SELECT id, kind, number, label FROM units WHERE active = 1 ORDER BY kind, number').all();
    const cells = db.prepare(`SELECT a.unit_id, a.night, b.id, b.ref, b.kind, b.status, b.name, b.notes, b.source
        FROM allocations a JOIN bookings b ON b.id = a.booking_id WHERE a.night >= ? AND a.night < ?`).all(from, to);
    const grid = {};
    for (const c of cells) {
      grid[`${c.unit_id}:${c.night}`] = { ref: c.ref, kind: c.kind, status: c.status,
        who: c.kind === 'block' ? (c.notes || 'Blocked') : c.name };
    }
    res.json({ from, days, units, grid });
  });

  r.get('/calendar-sync', (req, res) => {
    res.json({ enabled: cfg.ical.importUrls.length > 0, feeds: cfg.ical.importUrls.length,
      exportEnabled: !!cfg.ical.exportToken, exportUrl: cfg.ical.exportToken ? `${cfg.origin}/calendar/${cfg.ical.exportToken}.ics` : null,
      ...ical.state });
  });

  r.post('/calendar-sync', async (req, res) => {
    const out = await ical.syncImports();
    res.json({ ok: !out.lastError, ...out, note: out.lastError ? `Some calendars couldn’t be read: ${out.lastError}` : `Synced. ${out.imported} Airbnb reservation(s) blocking dates.` });
  });

  r.get('/units', (req, res) => {
    res.json({ units: db.prepare('SELECT id, kind, number, label, sewer FROM units WHERE active = 1 ORDER BY kind, number').all() });
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
