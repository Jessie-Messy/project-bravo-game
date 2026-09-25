// Booking lifecycle: hold -> pay -> confirm -> onboard.
//
//   createHold      reserves specific units for ~35 minutes and opens a checkout
//   confirmPaid     runs on Stripe's signed webhook: confirms, creates or links the
//                   guest account, and emails a one-time account set-up link
//   createManual    the owner enters a phone/cash booking; same onboarding, no payment
//   expireHolds     releases holds nobody paid for
//   cancel          releases units, ends camera access, optionally refunds and emails
import { ipKeyGenerator } from 'express-rate-limit';
import { audit } from '../db.js';
import { randomToken, sha256, safeEqual, bookingRef } from '../security/crypto.js';
import { BookingError, priceStay, stayProblem } from './inventory.js';

// Unpaid holds take dates off the calendar, so they're rationed: a few per network and
// per email address, and a ceiling across the whole site.
export const HOLD_LIMITS = { perNetwork: 3, perEmail: 2, total: 20 };

export const hour = (h) => `${((h + 11) % 12) + 1}:00 ${h >= 12 ? 'PM' : 'AM'}`;
export const maskEmail = (e) => {
  const [local, domain] = String(e).split('@');
  return `${local.slice(0, 1)}${'•'.repeat(Math.max(2, Math.min(local.length - 1, 6)))}@${domain}`;
};
const longDate = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

export function bookingService({ db, cfg, inventory, payments, mailer, cameras }) {
  const byRef = db.prepare('SELECT * FROM bookings WHERE ref = ?');
  const byId = db.prepare('SELECT * FROM bookings WHERE id = ?');
  const tz = new Intl.DateTimeFormat('en-US', { timeZone: cfg.ranch.timezone, timeZoneName: 'long' })
    .formatToParts(new Date()).find((p) => p.type === 'timeZoneName')?.value.replace(/ (Standard|Daylight) /, ' ') || cfg.ranch.timezone;
  const money = (c, cur = cfg.pricing.currency) => new Intl.NumberFormat('en-US', { style: 'currency', currency: cur.toUpperCase() }).format(c / 100);

  const stayOf = (b) => ({ checkIn: b.check_in, checkOut: b.check_out, house: !!b.house, stalls: b.stalls,
    rvSites: b.rv_sites, rvSewer: b.rv_sewer || 0, guests: b.guests });

  async function createHold(stay, contact, { ip, replace } = {}) {
    const problem = stayProblem(cfg, stay);
    if (problem) throw new BookingError(problem);
    const quote = priceStay(cfg, stay);
    if (quote.total <= 0) throw new BookingError('Nothing to book.');
    const statusToken = randomToken(24);
    const holdUntil = Date.now() + (cfg.payments.holdMinutes + 1) * 60e3;
    const holdKey = ip ? ipKeyGenerator(ip, 56) : '';

    // A guest who went back from checkout and is booking again: the browser proves it
    // owns the unfinished hold (its private status token) and that hold is released, so
    // it doesn't block them or their own dates. Knowing someone's email is not enough.
    if (replace?.ref && replace?.t && publicStatus(replace.ref, replace.t)?.status === 'pending') {
      await releaseHold(replace.ref);
    }

    // Reserve inside one transaction; the UNIQUE(unit, night) constraint makes a
    // simultaneous second booking fail here rather than after someone has paid.
    const booking = db.transaction(() => {
      const pending = db.prepare(`SELECT SUM(hold_key = ?) AS network, SUM(email = ?) AS email, COUNT(*) AS total
          FROM bookings WHERE status = 'pending'`).get(holdKey, contact.email);
      if ((pending.network || 0) >= HOLD_LIMITS.perNetwork || (pending.email || 0) >= HOLD_LIMITS.perEmail) {
        throw new BookingError('A few bookings from your internet connection (or this email address) are already waiting for payment. Finish one of them, or try again in about 30 minutes — or contact us and we’ll book you in.', 429);
      }
      if (pending.total >= HOLD_LIMITS.total) {
        throw new BookingError('Lots of people are booking right now. Please try again in a few minutes.', 503);
      }
      const reason = inventory.unavailableReason(stay);
      if (reason) throw new BookingError(reason, 409);
      const info = insertGuestBooking(stay, contact, quote, { status: 'pending', holdExpires: holdUntil + 5 * 60e3,
        statusTokenHash: sha256(statusToken), holdKey });
      return byId.get(info);
    })();

    try {
      const { sessionId, url } = await payments.createCheckout({ booking, quote, statusToken, holdUntil });
      db.prepare('UPDATE bookings SET stripe_session_id = ? WHERE id = ?').run(sessionId, booking.id);
      audit(db, { action: 'booking.hold', detail: `${booking.ref} ${stay.checkIn}..${stay.checkOut}`, ip });
      return { ref: booking.ref, checkoutUrl: url, statusToken, holdUntil };
    } catch (e) {
      // Could not open a checkout: give the units straight back.
      expireNow(booking.ref);
      console.error('[checkout] failed to create session:', e.message);
      throw new BookingError('Payment is temporarily unavailable. Please try again in a few minutes.', 502);
    }
  }

  // Inserts a guest booking row and allocates its units. Must run inside a transaction.
  function insertGuestBooking(stay, contact, quote, { status, holdExpires = null, statusTokenHash = null, holdKey = '', source = 'web', amount = quote.total }) {
    const info = db.prepare(`INSERT INTO bookings (ref, kind, status, email, name, phone, check_in, check_out,
        house, stalls, rv_sites, rv_sewer, guests, horses, notes, amount_cents, currency, hold_expires_at, status_token_hash,
        created_at, hold_key, source)
      VALUES (?, 'guest', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      bookingRef(), status, contact.email, contact.name, contact.phone, stay.checkIn, stay.checkOut, stay.house ? 1 : 0,
      stay.stalls, stay.rvSites, stay.rvSewer || 0, stay.guests, stay.stalls, contact.notes || '', amount, quote.currency,
      holdExpires, statusTokenHash, Date.now(), holdKey, source);
    try { inventory.allocate(info.lastInsertRowid, stay); }
    catch (e) {
      if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') throw new BookingError('Those dates were just taken. Please pick different dates.', 409);
      throw e;
    }
    return info.lastInsertRowid;
  }

  // Links a booking to the guest's account (creating it if needed) and returns a one-time
  // set-up token when the account has no password yet. Inside a transaction.
  function attachGuest(bookingId, email, name, phone) {
    let user = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    if (!user) {
      const info = db.prepare('INSERT INTO users (email, name, phone, created_at) VALUES (?, ?, ?, ?)').run(email, name, phone, Date.now());
      user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
    }
    let setupToken = null;
    if (!user.password_hash) {
      setupToken = randomToken();
      db.prepare("INSERT INTO auth_tokens (token_hash, user_id, purpose, expires_at) VALUES (?, ?, 'setup', ?)")
        .run(sha256(setupToken), user.id, Date.now() + cfg.auth.setupTokenHours * 3600e3);
    }
    db.prepare('UPDATE bookings SET user_id = ? WHERE id = ?').run(user.id, bookingId);
    return { user, setupToken };
  }

  // Idempotent: safe to call again for a booking that is already confirmed.
  async function confirmPaid(ref, { sessionId, amountPaid, currency, paymentIntent }) {
    const outcome = db.transaction(() => {
      const b = byRef.get(ref);
      if (!b || b.kind !== 'guest') return { kind: 'unknown' };
      if (sessionId && b.stripe_session_id !== sessionId) return { kind: 'unknown' };
      if (b.status === 'confirmed' || b.status === 'needs_attention') return { kind: 'already' };
      if (b.status === 'cancelled') {
        // A late or replayed payment event must never revive a cancelled/refunded stay.
        audit(db, { action: 'booking.late_payment_ignored', detail: b.ref });
        return { kind: 'already' };
      }
      if (b.status !== 'pending' && b.status !== 'expired') return { kind: 'unknown' };

      const flag = (why) => {
        db.prepare("UPDATE bookings SET status = 'needs_attention', stripe_payment_intent = ? WHERE id = ?").run(paymentIntent || null, b.id);
        audit(db, { action: 'booking.needs_attention', detail: `${b.ref}: ${why}` });
        return { kind: 'attention', booking: b, why };
      };
      if (amountPaid !== b.amount_cents || (currency && currency !== b.currency)) {
        return flag(`paid ${amountPaid} ${currency}, expected ${b.amount_cents} ${b.currency}`);
      }
      if (b.status !== 'pending') {
        // The hold lapsed before payment landed. Try to take the units again, all or
        // nothing (the inner transaction is a savepoint that rolls back on failure).
        try { db.transaction(() => inventory.allocate(b.id, stayOf(b)))(); }
        catch { return flag('paid after the hold expired and the dates are no longer free — refund or rebook'); }
      }
      const { user, setupToken } = attachGuest(b.id, b.email, b.name, b.phone);
      db.prepare(`UPDATE bookings SET status = 'confirmed', confirmed_at = ?, hold_expires_at = NULL,
          stripe_payment_intent = ? WHERE id = ?`).run(Date.now(), paymentIntent || null, b.id);
      audit(db, { userId: user.id, action: 'booking.confirmed', detail: b.ref });
      return { kind: 'confirmed', booking: byId.get(b.id), user, setupToken };
    })();

    if (outcome.kind === 'confirmed') await sendConfirmation(outcome);
    if (outcome.kind === 'attention') await alertAdmin(outcome.booking, outcome.why);
    return outcome.kind;
  }

  // A booking the owner took by phone or in person: confirmed straight away, and the
  // guest is onboarded exactly like an online booking (cameras included).
  async function createManual({ stay, contact, amountCents }, byUserId) {
    const problem = stayProblem(cfg, stay);
    if (problem) throw new BookingError(problem);
    const quote = priceStay(cfg, stay);
    const outcome = db.transaction(() => {
      const reason = inventory.unavailableReason(stay);
      if (reason) throw new BookingError(reason, 409);
      const id = insertGuestBooking(stay, contact, quote, { status: 'confirmed', source: 'admin', amount: amountCents ?? quote.total });
      const { user, setupToken } = attachGuest(id, contact.email, contact.name, contact.phone);
      db.prepare('UPDATE bookings SET confirmed_at = ? WHERE id = ?').run(Date.now(), id);
      audit(db, { userId: byUserId, action: 'admin.manual_booking', detail: byId.get(id).ref });
      return { booking: byId.get(id), user, setupToken };
    })();
    await sendConfirmation(outcome, { alertOwner: false });
    return outcome.booking;
  }

  function describeUnits(booking) {
    const units = inventory.unitsFor(booking.id);
    const of = (kind) => units.filter((u) => u.kind === kind).map((u) => u.label);
    return { stalls: of('stall'), rv: of('rv'), house: of('house').length > 0 };
  }

  async function sendConfirmation({ booking, user, setupToken }, { alertOwner = true } = {}) {
    const u = describeUnits(booking);
    const contact = [cfg.ranch.phone && `call or text ${cfg.ranch.phone}`, cfg.ranch.email && `email ${cfg.ranch.email}`].filter(Boolean).join(' or ');
    const what = [
      u.house ? `• Ranch house for ${booking.guests} guest${booking.guests === 1 ? '' : 's'}` : '',
      u.stalls.length ? `• ${u.stalls.join(', ')}` : '',
      u.rv.length ? `• ${u.rv.join(', ')}` : '',
    ].filter(Boolean).join('\n');
    const lines = [
      `Hi ${booking.name.split(' ')[0] || 'there'},`,
      `You’re booked at ${cfg.ranch.name}. Your confirmation number is ${booking.ref}.`,
      `Check-in: ${longDate(booking.check_in)}, from ${hour(cfg.ranch.checkInHour)} (${tz})\nCheck-out: ${longDate(booking.check_out)}, by ${hour(cfg.ranch.checkOutHour)}`,
      `What’s reserved for you:\n${what}`,
      booking.amount_cents ? `${booking.source === 'admin' ? 'Total' : 'Total paid'}: ${money(booking.amount_cents, booking.currency)}` : '',
      u.stalls.length ? `Stall cameras: once you’re signed in you can watch ${u.stalls.length > 1 ? 'your stalls' : 'your stall'} live from ${cfg.cameraAccess.hoursBeforeCheckIn} hours before check-in until ${cfg.cameraAccess.hoursAfterCheckOut} hours after check-out.` : '',
      u.stalls.length ? 'Please bring a copy of a current negative Coggins test for each horse.' : '',
      `Finding us: ${cfg.ranch.address}. Google sometimes gets lost out here, so use our exact location: https://www.google.com/maps/search/?api=1&query=${cfg.ranch.lat},${cfg.ranch.lng}`,
      contact ? `Questions or running late? ${contact[0].toUpperCase()}${contact.slice(1)}.` : '',
    ].filter(Boolean);
    try {
      if (setupToken) {
        await mailer.send({
          to: user.email,
          subject: `You’re booked — set up your ${cfg.ranch.name} account (${booking.ref})`,
          text: [...lines, `Create your password to finish setting up your guest account. This link works once and expires in ${cfg.auth.setupTokenHours} hours. If it expires, use “Forgot password” on the sign-in page.`].join('\n\n'),
          action: { label: 'Set up my account', url: `${cfg.origin}/setup#token=${setupToken}` },
        });
      } else {
        await mailer.send({
          to: user.email,
          subject: `You’re booked at ${cfg.ranch.name} (${booking.ref})`,
          text: [...lines, 'This stay has been added to your guest account.'].join('\n\n'),
          action: { label: 'Open my account', url: `${cfg.origin}/account` },
        });
      }
    } catch (e) {
      console.error('[mail] confirmation failed for', booking.ref, e.message);
      audit(db, { userId: user.id, action: 'mail.failed', detail: booking.ref });
    }
    if (alertOwner && cfg.mail.adminAlertTo) {
      mailer.send({ to: cfg.mail.adminAlertTo, subject: `New booking ${booking.ref}: ${booking.check_in} to ${booking.check_out}`,
        text: `${booking.name} <${booking.email}> ${booking.phone}\n${longDate(booking.check_in)} to ${longDate(booking.check_out)}\n${what}\nPaid online: ${money(booking.amount_cents, booking.currency)}\nNotes: ${booking.notes || '-'}`,
        action: { label: 'Open the admin page', url: `${cfg.origin}/admin` } }).catch(() => {});
    }
  }

  async function alertAdmin(b, why) {
    console.error(`[booking] ${b.ref} needs attention: ${why}`);
    if (!cfg.mail.adminAlertTo) return;
    await mailer.send({ to: cfg.mail.adminAlertTo, subject: `ACTION NEEDED: booking ${b.ref}`,
      text: `Booking ${b.ref} (${b.email}) was paid but could not be confirmed automatically.\n\nReason: ${why}`,
      action: { label: 'Open the admin page', url: `${cfg.origin}/admin` } }).catch(() => {});
  }

  // Releases unpaid holds. In Stripe mode, a hold is double-checked with Stripe before it
  // is released, in case a payment webhook is merely late.
  async function expireHolds(now = Date.now()) {
    const stale = db.prepare("SELECT * FROM bookings WHERE status = 'pending' AND hold_expires_at < ?").all(now);
    for (const b of stale) {
      if (payments.mode === 'stripe' && b.stripe_session_id) {
        try {
          const s = await payments.retrieveSession(b.stripe_session_id);
          if (s?.payment_status === 'paid') {
            await confirmPaid(b.ref, { sessionId: s.id, amountPaid: s.amount_total, currency: s.currency, paymentIntent: s.payment_intent });
            continue;
          }
          if (s?.status === 'open') { await payments.expireSession(s.id); }
        } catch (e) { console.error('[holds] could not check', b.ref, e.message); continue; }
      }
      expireNow(b.ref);
    }
    // Housekeeping for expired auth material.
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
    db.prepare('DELETE FROM mfa_challenges WHERE expires_at < ?').run(now);
    db.prepare('DELETE FROM auth_tokens WHERE expires_at < ?').run(now - 86400e3);
    db.prepare('DELETE FROM audit_log WHERE at < ?').run(now - 400 * 86400e3);
  }

  // Releases an unpaid hold, but never one whose payment is going through right now
  // (paid in another tab, webhook not here yet): that one is confirmed instead.
  async function releaseHold(ref) {
    const row = byRef.get(ref);
    if (!row || row.status !== 'pending') return false;
    if (payments.mode === 'stripe' && row.stripe_session_id) {
      const s = await payments.retrieveSession(row.stripe_session_id).catch(() => null);
      if (s?.payment_status === 'paid') {
        await confirmPaid(ref, { sessionId: s.id, amountPaid: s.amount_total, currency: s.currency, paymentIntent: s.payment_intent });
        return false;
      }
      if (s?.status === 'complete') return false;
      await payments.expireSession(row.stripe_session_id);
    }
    expireNow(ref);
    return true;
  }

  function expireNow(ref) {
    db.transaction(() => {
      const b = byRef.get(ref);
      if (!b || b.status !== 'pending') return;
      inventory.release(b.id);
      db.prepare("UPDATE bookings SET status = 'expired' WHERE id = ?").run(b.id);
    })();
  }

  // Cancels a stay: units released and camera access ended at once. Optionally refunds
  // the full payment through Stripe and emails the guest.
  async function cancel(id, { byUserId = null, reason = '', refund = false, notify = false, refundedCents = null } = {}) {
    const b = db.transaction(() => {
      const row = byId.get(id);
      if (!row) throw new BookingError('No such booking.', 404);
      if (row.kind === 'block') {
        db.prepare('DELETE FROM bookings WHERE id = ?').run(id);
      } else {
        if (row.status === 'cancelled') throw new BookingError('That booking is already cancelled.', 409);
        inventory.release(id);
        db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(id);
      }
      audit(db, { userId: byUserId, action: row.kind === 'block' ? 'block.removed' : 'booking.cancelled', detail: `${row.ref} ${reason}` });
      return row;
    })();
    cameras?.revokeAll();
    if (b.kind === 'block') return { booking: b, refunded: 0 };

    let refunded = refundedCents ?? 0;
    let refundError = null;
    if (refund && b.stripe_payment_intent && b.stripe_payment_intent !== 'mock' && payments.mode === 'stripe') {
      try { refunded = await payments.refund(b.stripe_payment_intent, b.ref); }
      catch (e) { refundError = e.message; console.error('[refund] failed for', b.ref, e.message); }
    } else if (refund && payments.mode === 'mock') {
      refunded = b.amount_cents;
    }
    if (refunded) db.prepare('UPDATE bookings SET refund_cents = ? WHERE id = ?').run(refunded, id);
    if (notify && b.email) {
      const contact = [cfg.ranch.phone, cfg.ranch.email].filter(Boolean).join(' or ');
      mailer.send({
        to: b.email,
        subject: `Your ${cfg.ranch.name} booking ${b.ref} has been cancelled`,
        text: [`Hi ${b.name.split(' ')[0] || 'there'},`,
          `Your booking ${b.ref} for ${longDate(b.check_in)} to ${longDate(b.check_out)} has been cancelled.`,
          refunded ? `We’ve refunded ${money(refunded, b.currency)} to your card. It usually shows up within 5–10 business days.` : '',
          contact ? `Questions? Contact us: ${contact}.` : ''].filter(Boolean).join('\n\n'),
      }).catch(() => {});
    }
    return { booking: b, refunded, refundError };
  }

  // Owner-side block-out of specific units (maintenance, private use, other channels).
  function block({ checkIn, checkOut, unitIds, note, source = 'admin', externalUid = null }, byUserId = null) {
    return db.transaction(() => {
      const info = db.prepare(`INSERT INTO bookings (ref, kind, status, check_in, check_out, notes, created_at, user_id, source, external_uid)
        VALUES (?, 'block', 'confirmed', ?, ?, ?, ?, ?, ?, ?)`).run(bookingRef().replace('RC-', 'BL-'), checkIn, checkOut,
        note || '', Date.now(), byUserId, source, externalUid);
      inventory.allocateUnits(info.lastInsertRowid, unitIds, checkIn, checkOut);
      const kinds = db.prepare(`SELECT SUM(kind = 'house') AS house, SUM(kind = 'stall') AS stalls, SUM(kind = 'rv') AS rv
          FROM units WHERE id IN (${unitIds.map(() => '?').join(',')})`).get(...unitIds);
      db.prepare('UPDATE bookings SET house = ?, stalls = ?, rv_sites = ? WHERE id = ?')
        .run(kinds.house || 0, kinds.stalls || 0, kinds.rv || 0, info.lastInsertRowid);
      audit(db, { userId: byUserId, action: 'block.created', detail: `${checkIn}..${checkOut} ${note || ''}`.trim() });
      return byId.get(info.lastInsertRowid);
    })();
  }

  // Fixes a mistyped email: moves the booking to the right account and re-sends the
  // confirmation (with a fresh set-up link if that account has no password yet).
  async function changeEmail(id, email, byUserId) {
    const outcome = db.transaction(() => {
      const b = byId.get(id);
      if (!b || b.kind !== 'guest' || b.status !== 'confirmed') throw new BookingError('Only confirmed guest bookings can be changed.', 404);
      db.prepare('UPDATE bookings SET email = ? WHERE id = ?').run(email, id);
      const { user, setupToken } = attachGuest(id, email, b.name, b.phone);
      audit(db, { userId: byUserId, action: 'admin.booking_email_changed', detail: `${b.ref}: ${b.email} → ${email}` });
      return { booking: byId.get(id), user, setupToken };
    })();
    cameras?.revokeAll();
    await sendConfirmation(outcome, { alertOwner: false });
    return outcome.booking;
  }

  // What the returning booker can see on the status page: no personal details beyond a
  // masked email so they can spot a typo.
  function publicStatus(ref, token) {
    const b = byRef.get(ref);
    if (!b || !b.status_token_hash || !safeEqual(b.status_token_hash, sha256(String(token)))) return null;
    return { ref: b.ref, status: b.status, checkIn: b.check_in, checkOut: b.check_out, house: !!b.house, guests: b.guests,
      stalls: b.stalls, rvSites: b.rv_sites, rvSewer: b.rv_sewer || 0, amount: b.amount_cents, currency: b.currency,
      refunded: b.refund_cents, email: maskEmail(b.email), holdUntil: b.status === 'pending' ? b.hold_expires_at - 5 * 60e3 : null,
      units: b.status === 'confirmed' ? inventory.unitsFor(b.id).map((u) => u.label) : [] };
  }

  return { createHold, confirmPaid, createManual, expireHolds, expireNow, releaseHold, cancel, block, changeEmail, publicStatus, sendConfirmation, stayOf };
}
