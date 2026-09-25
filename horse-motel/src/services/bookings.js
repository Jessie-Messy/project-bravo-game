// Booking lifecycle: hold -> pay -> confirm -> onboard.
//
//   createHold      reserves specific units for 35 minutes and opens a checkout
//   confirmPaid     runs on Stripe's signed webhook: confirms, creates or links the
//                   guest account, and emails a one-time account set-up link
//   expireHolds     releases holds nobody paid for
//   cancel          releases units and ends camera access
import { ipKeyGenerator } from 'express-rate-limit';
import { audit } from '../db.js';
import { randomToken, sha256, safeEqual, bookingRef } from '../security/crypto.js';
import { BookingError, priceStay, stayProblem } from './inventory.js';

// Unpaid holds take dates off the calendar, so they're rationed: a few per network and
// per email address, and a ceiling across the whole site.
export const HOLD_LIMITS = { perNetwork: 2, perEmail: 2, total: 20 };

export function bookingService({ db, cfg, inventory, payments, mailer }) {
  const byRef = db.prepare('SELECT * FROM bookings WHERE ref = ?');
  const byId = db.prepare('SELECT * FROM bookings WHERE id = ?');

  async function createHold(stay, contact, { ip } = {}) {
    const problem = stayProblem(cfg, stay);
    if (problem) throw new BookingError(problem);
    const quote = priceStay(cfg, stay);
    if (quote.total <= 0) throw new BookingError('Nothing to book.');
    const statusToken = randomToken(24);
    const holdUntil = Date.now() + (cfg.payments.holdMinutes + 1) * 60e3;

    // Reserve first, inside one transaction; the UNIQUE(unit, night) constraint makes a
    // simultaneous second booking fail here rather than after someone has paid.
    const holdKey = ip ? ipKeyGenerator(ip, 56) : '';
    const booking = db.transaction(() => {
      const pending = db.prepare(`SELECT
          SUM(hold_key = ?) AS network, SUM(email = ?) AS email, COUNT(*) AS total
          FROM bookings WHERE status = 'pending'`).get(holdKey, contact.email);
      if ((pending.network || 0) >= HOLD_LIMITS.perNetwork || (pending.email || 0) >= HOLD_LIMITS.perEmail) {
        throw new BookingError('You already have a booking waiting for payment. Finish or cancel it first, or wait 30 minutes.', 429);
      }
      if (pending.total >= HOLD_LIMITS.total) {
        throw new BookingError('Lots of people are booking right now. Please try again in a few minutes.', 503);
      }
      const reason = inventory.unavailableReason(stay);
      if (reason) throw new BookingError(reason, 409);
      const ref = bookingRef();
      const info = db.prepare(`INSERT INTO bookings (ref, kind, status, email, name, phone, check_in, check_out,
          house, stalls, rv_sites, guests, horses, notes, amount_cents, currency, hold_expires_at, status_token_hash, created_at, hold_key)
        VALUES (?, 'guest', 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        ref, contact.email, contact.name, contact.phone, stay.checkIn, stay.checkOut, stay.house ? 1 : 0,
        stay.stalls, stay.rvSites, stay.guests, stay.stalls, contact.notes || '', quote.total, quote.currency,
        holdUntil + 5 * 60e3, sha256(statusToken), Date.now(), holdKey);
      try { inventory.allocate(info.lastInsertRowid, stay); }
      catch (e) {
        if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') throw new BookingError('Those dates were just taken. Please pick different dates.', 409);
        throw e;
      }
      return byId.get(info.lastInsertRowid);
    })();

    try {
      const { sessionId, url } = await payments.createCheckout({ booking, quote, statusToken, holdUntil });
      db.prepare('UPDATE bookings SET stripe_session_id = ? WHERE id = ?').run(sessionId, booking.id);
      audit(db, { action: 'booking.hold', detail: `${booking.ref} ${stay.checkIn}..${stay.checkOut}`, ip });
      return { ref: booking.ref, checkoutUrl: url, statusToken };
    } catch (e) {
      // Could not open a checkout: give the units straight back.
      db.transaction(() => {
        inventory.release(booking.id);
        db.prepare("UPDATE bookings SET status = 'expired' WHERE id = ?").run(booking.id);
      })();
      console.error('[checkout] failed to create session:', e.message);
      throw new BookingError('Payment is temporarily unavailable. Please try again in a few minutes.', 502);
    }
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

      const stay = { checkIn: b.check_in, checkOut: b.check_out, house: !!b.house, stalls: b.stalls, rvSites: b.rv_sites, guests: b.guests };
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
        try { db.transaction(() => inventory.allocate(b.id, stay))(); }
        catch { return flag('paid after the hold expired and the dates are no longer free — refund or rebook'); }
      }

      let user = db.prepare('SELECT * FROM users WHERE email = ?').get(b.email);
      let setupToken = null;
      if (!user) {
        const info = db.prepare('INSERT INTO users (email, name, phone, created_at) VALUES (?, ?, ?, ?)')
          .run(b.email, b.name, b.phone, Date.now());
        user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid);
      }
      if (!user.password_hash) {
        setupToken = randomToken();
        db.prepare("INSERT INTO auth_tokens (token_hash, user_id, purpose, expires_at) VALUES (?, ?, 'setup', ?)")
          .run(sha256(setupToken), user.id, Date.now() + cfg.auth.setupTokenHours * 3600e3);
      }
      db.prepare(`UPDATE bookings SET status = 'confirmed', user_id = ?, confirmed_at = ?, hold_expires_at = NULL,
          stripe_payment_intent = ? WHERE id = ?`).run(user.id, Date.now(), paymentIntent || null, b.id);
      audit(db, { userId: user.id, action: 'booking.confirmed', detail: b.ref });
      return { kind: 'confirmed', booking: byId.get(b.id), user, setupToken };
    })();

    if (outcome.kind === 'confirmed') await sendConfirmation(outcome);
    if (outcome.kind === 'attention') await alertAdmin(outcome.booking, outcome.why);
    return outcome.kind;
  }

  async function sendConfirmation({ booking, user, setupToken }) {
    const units = inventory.unitsFor(booking.id);
    const stalls = units.filter((u) => u.kind === 'stall').map((u) => u.label);
    const fmt = (d) => new Date(d + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    const lines = [
      `Hi ${booking.name.split(' ')[0] || 'there'},`,
      `You’re booked at ${cfg.ranch.name}. Your confirmation number is ${booking.ref}.`,
      `Check-in: ${fmt(booking.check_in)}, from ${hour(cfg.ranch.checkInHour)}\nCheck-out: ${fmt(booking.check_out)}, by ${hour(cfg.ranch.checkOutHour)}`,
      stalls.length ? `Your horses are in ${stalls.join(', ')}. Once you’re signed in you can watch ${stalls.length > 1 ? 'those stalls' : 'that stall'} live from ${cfg.cameraAccess.hoursBeforeCheckIn} hours before check-in until ${cfg.cameraAccess.hoursAfterCheckOut} hours after check-out.` : '',
      stalls.length ? 'Please bring a copy of a current negative Coggins test for each horse.' : '',
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
    if (cfg.mail.adminAlertTo) {
      mailer.send({ to: cfg.mail.adminAlertTo, subject: `New booking ${booking.ref}`,
        text: `${booking.name} <${booking.email}> ${booking.phone}\n${booking.check_in} to ${booking.check_out}\nHouse: ${booking.house ? 'yes' : 'no'}, stalls: ${booking.stalls}, RV sites: ${booking.rv_sites}\nNotes: ${booking.notes || '-'}` })
        .catch(() => {});
    }
  }

  async function alertAdmin(b, why) {
    console.error(`[booking] ${b.ref} needs attention: ${why}`);
    if (!cfg.mail.adminAlertTo) return;
    await mailer.send({ to: cfg.mail.adminAlertTo, subject: `ACTION NEEDED: booking ${b.ref}`,
      text: `Booking ${b.ref} (${b.email}) was paid but could not be confirmed automatically.\n\nReason: ${why}\n\nOpen the admin page to resolve it.` }).catch(() => {});
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
      db.transaction(() => {
        inventory.release(b.id);
        db.prepare("UPDATE bookings SET status = 'expired' WHERE id = ? AND status = 'pending'").run(b.id);
      })();
    }
    // Housekeeping for expired auth material.
    db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
    db.prepare('DELETE FROM mfa_challenges WHERE expires_at < ?').run(now);
    db.prepare('DELETE FROM auth_tokens WHERE expires_at < ?').run(now - 86400e3);
    db.prepare('DELETE FROM audit_log WHERE at < ?').run(now - 400 * 86400e3);
  }

  function expireNow(ref) {
    db.transaction(() => {
      const b = byRef.get(ref);
      if (!b || b.status !== 'pending') return;
      inventory.release(b.id);
      db.prepare("UPDATE bookings SET status = 'expired' WHERE id = ?").run(b.id);
    })();
  }

  function cancel(id, { byUserId, reason = '' } = {}) {
    return db.transaction(() => {
      const b = byId.get(id);
      if (!b) throw new BookingError('No such booking.', 404);
      if (b.kind === 'block') {
        db.prepare('DELETE FROM bookings WHERE id = ?').run(id);
      } else {
        inventory.release(id);
        db.prepare("UPDATE bookings SET status = 'cancelled' WHERE id = ?").run(id);
      }
      audit(db, { userId: byUserId, action: 'booking.cancelled', detail: `${b.ref} ${reason}` });
      return b;
    })();
  }

  // Owner-side block-out: marks units unavailable (maintenance, private use).
  function block({ checkIn, checkOut, house, stalls, rvSites, note }, byUserId) {
    return db.transaction(() => {
      const info = db.prepare(`INSERT INTO bookings (ref, kind, status, check_in, check_out, house, stalls, rv_sites, notes, created_at, user_id)
        VALUES (?, 'block', 'confirmed', ?, ?, ?, ?, ?, ?, ?, ?)`).run(bookingRef().replace('RC-', 'BL-'), checkIn, checkOut,
        house ? 1 : 0, stalls, rvSites, note || '', Date.now(), byUserId);
      const reason = inventory.unavailableReason({ checkIn, checkOut, house, stalls, rvSites });
      if (reason) throw new BookingError(reason, 409);
      inventory.allocate(info.lastInsertRowid, { checkIn, checkOut, house, stalls, rvSites });
      audit(db, { userId: byUserId, action: 'block.created', detail: `${checkIn}..${checkOut}` });
      return byId.get(info.lastInsertRowid);
    })();
  }

  // What the returning booker can see on the status page: no personal details.
  function publicStatus(ref, token) {
    const b = byRef.get(ref);
    if (!b || !b.status_token_hash || !safeEqual(b.status_token_hash, sha256(token))) return null;
    return { ref: b.ref, status: b.status, checkIn: b.check_in, checkOut: b.check_out, house: !!b.house,
      stalls: b.stalls, rvSites: b.rv_sites, amount: b.amount_cents, currency: b.currency };
  }

  return { createHold, confirmPaid, expireHolds, expireNow, cancel, block, publicStatus, sendConfirmation };
}

function hour(h) {
  const suffix = h >= 12 ? 'PM' : 'AM';
  return `${((h + 11) % 12) + 1}:00 ${suffix}`;
}
export { hour };
