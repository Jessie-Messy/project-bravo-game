import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { addDays, isIsoDate, todayIn } from '../dates.js';
import { stayRequestSchema, stayProblem, priceStay, BookingError } from '../services/inventory.js';
import { audit } from '../db.js';

const contactSchema = z.object({
  name: z.string().trim().min(2, 'Enter your full name.').max(80),
  email: z.string().trim().toLowerCase().max(254).email('Enter a valid email address.'),
  phone: z.string().trim().min(7, 'Enter a phone number we can reach you on.').max(25)
    .regex(/^[0-9+().\-\s]+$/, 'Use digits, spaces and + ( ) - only.'),
  notes: z.string().trim().max(500).optional().default(''),
}).strict();

export function publicRoutes({ cfg, db, inventory, bookings, payments }) {
  const r = express.Router();
  const bookingLimiter = rateLimit({ windowMs: 3600e3, limit: 15, standardHeaders: 'draft-7', legacyHeaders: false,
    message: { error: 'Too many booking attempts. Please wait a while or call us.' } });

  r.get('/site', (req, res) => {
    res.json({
      name: cfg.ranch.name,
      timezone: cfg.ranch.timezone,
      today: todayIn(cfg.ranch.timezone),
      checkInHour: cfg.ranch.checkInHour,
      checkOutHour: cfg.ranch.checkOutHour,
      contact: { email: cfg.ranch.email, phone: cfg.ranch.phone },
      inventory: { ...inventory.totals(), maxGuests: cfg.inventory.maxGuests, maxNights: cfg.inventory.maxNights,
        bookingWindowDays: cfg.inventory.bookingWindowDays },
      pricing: cfg.pricing,
      cameraAccess: cfg.cameraAccess,
      testPayments: payments.mode === 'mock',
    });
  });

  // Free units per night for up to ~3 months starting at `from`.
  r.get('/availability', (req, res) => {
    const today = todayIn(cfg.ranch.timezone);
    let from = isIsoDate(req.query.from) ? req.query.from : today;
    if (from < addDays(today, -31)) from = addDays(today, -31);
    const days = Math.min(Math.max(Number.parseInt(req.query.days, 10) || 62, 1), 100);
    const last = addDays(today, cfg.inventory.bookingWindowDays + 1);
    let to = addDays(from, days);
    if (to > last) to = last;
    if (from >= to) return res.json({ totals: inventory.totals(), days: {} });
    res.json(inventory.availability(from, to));
  });

  r.post('/quote', (req, res) => {
    const stay = stayRequestSchema(cfg).parse(req.body);
    const problem = stayProblem(cfg, stay);
    if (problem) return res.json({ ok: false, reason: problem });
    const reason = inventory.unavailableReason(stay);
    res.json({ ok: !reason, reason, quote: priceStay(cfg, stay) });
  });

  r.post('/bookings', bookingLimiter, async (req, res) => {
    const body = z.object({
      stay: z.unknown(),
      contact: z.unknown(),
      agree: z.object({ rules: z.literal(true, { message: 'Please accept the ranch rules and liability terms.' }),
        coggins: z.boolean() }).strict(),
    }).strict().parse(req.body);
    const stay = stayRequestSchema(cfg).parse(body.stay);
    const contact = contactSchema.parse(body.contact);
    if (stay.stalls > 0 && !body.agree.coggins) {
      throw new BookingError('Please confirm each horse has a current negative Coggins test.');
    }
    const out = await bookings.createHold(stay, contact, { ip: req.ip });
    res.status(201).json({ ref: out.ref, checkoutUrl: out.checkoutUrl });
  });

  r.get('/bookings/status', (req, res) => {
    const s = typeof req.query.ref === 'string' && typeof req.query.t === 'string'
      ? bookings.publicStatus(req.query.ref, req.query.t) : null;
    if (!s) return res.status(404).json({ error: 'We couldn’t find that booking.' });
    res.json(s);
  });

  // The guest backed out of checkout: release their hold straight away.
  r.post('/bookings/release', async (req, res) => {
    const { ref, t } = z.object({ ref: z.string().max(20), t: z.string().max(64) }).strict().parse(req.body);
    const s = bookings.publicStatus(ref, t);
    if (!s) return res.status(404).json({ error: 'We couldn’t find that booking.' });
    if (s.status === 'pending') {
      if (payments.mode === 'stripe') {
        const row = db.prepare('SELECT stripe_session_id FROM bookings WHERE ref = ?').get(ref);
        if (row?.stripe_session_id) await payments.expireSession(row.stripe_session_id);
      }
      bookings.expireNow(ref);
    }
    res.json({ ok: true });
  });

  // Local development only: stands in for Stripe so the whole flow can be tried.
  if (payments.mode === 'mock') {
    r.post('/dev/mock-pay', async (req, res) => {
      const { ref, t } = z.object({ ref: z.string().max(20), t: z.string().max(64) }).strict().parse(req.body);
      const s = bookings.publicStatus(ref, t);
      if (!s) return res.status(404).json({ error: 'No such booking.' });
      const result = await bookings.confirmPaid(ref, { amountPaid: s.amount, currency: s.currency, paymentIntent: 'mock' });
      res.json({ result });
    });
  }

  return r;
}

// Stripe webhook: signature-verified, idempotent, and the only thing that can mark a
// booking as paid.
export function webhookRoute({ db, payments, bookings, cameras }) {
  const r = express.Router();
  if (payments.mode !== 'stripe') return r;
  r.post('/stripe', express.raw({ type: 'application/json', limit: '1mb' }), async (req, res) => {
    let event;
    try { event = payments.constructEvent(req.body, req.headers['stripe-signature']); }
    catch { return res.status(400).send('bad signature'); }
    if (db.prepare('SELECT 1 FROM webhook_events WHERE id = ?').get(event.id)) return res.json({ received: true });

    const s = event.data.object;
    const ref = s?.metadata?.booking_ref;
    switch (event.type) {
      case 'checkout.session.completed':
      case 'checkout.session.async_payment_succeeded':
        if (ref && s.payment_status === 'paid') {
          await bookings.confirmPaid(ref, { sessionId: s.id, amountPaid: s.amount_total, currency: s.currency, paymentIntent: s.payment_intent });
        } else if (ref) {
          // Paid by a delayed method (e.g. bank debit): keep holding until Stripe reports back.
          db.prepare("UPDATE bookings SET hold_expires_at = ? WHERE ref = ? AND status = 'pending'").run(Date.now() + 10 * 86400e3, ref);
        }
        break;
      case 'checkout.session.expired':
      case 'checkout.session.async_payment_failed':
        if (ref) bookings.expireNow(ref);
        break;
      case 'charge.refunded':
        if (s.refunded && s.payment_intent) {
          const b = db.prepare("SELECT id FROM bookings WHERE stripe_payment_intent = ? AND status = 'confirmed'").get(s.payment_intent);
          if (b) { bookings.cancel(b.id, { reason: 'refunded in Stripe' }); cameras.revokeAll(); }
        }
        break;
      default:
        break;
    }
    db.prepare('INSERT OR IGNORE INTO webhook_events (id, received_at) VALUES (?, ?)').run(event.id, Date.now());
    audit(db, { action: 'webhook', detail: `${event.type} ${ref || ''}` });
    res.json({ received: true });
  });
  return r;
}
