// Availability, pricing and unit allocation.
import { z } from 'zod';
import { addDays, daysBetween, isIsoDate, nightsOf, todayIn } from '../dates.js';

export class BookingError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const isoDate = z.string().refine(isIsoDate, 'Use a real date (YYYY-MM-DD).');

export function stayRequestSchema(cfg) {
  const inv = cfg.inventory;
  return z.object({
    checkIn: isoDate,
    checkOut: isoDate,
    house: z.boolean(),
    stalls: z.number().int().min(0).max(inv.stalls),
    rvSites: z.number().int().min(0).max(inv.rvSites),
    guests: z.number().int().min(0).max(inv.maxGuests),
  }).strict();
}

// Rules that span fields. Returns a message a guest can act on, or null.
export function stayProblem(cfg, s, now = new Date()) {
  const today = todayIn(cfg.ranch.timezone, now);
  const nights = daysBetween(s.checkIn, s.checkOut);
  if (s.checkIn < today) return 'Check-in can’t be in the past.';
  if (nights < 1) return 'Check-out must be after check-in.';
  if (nights > cfg.inventory.maxNights) return `Stays can be up to ${cfg.inventory.maxNights} nights. Call us for longer stays.`;
  if (daysBetween(today, s.checkIn) > cfg.inventory.bookingWindowDays) return 'That date is too far ahead to book online yet.';
  if (!s.house && s.stalls === 0 && s.rvSites === 0) return 'Choose the house, at least one stall, or an RV site.';
  if (s.house && s.guests < 1) return 'Tell us how many people are staying in the house.';
  return null;
}

export function priceStay(cfg, s) {
  const p = cfg.pricing;
  const nights = daysBetween(s.checkIn, s.checkOut);
  const lines = [];
  if (s.house) lines.push({ label: `Ranch house × ${nights} night${nights > 1 ? 's' : ''}`, unit: p.houseNight, qty: nights });
  if (s.stalls) lines.push({ label: `Horse stall × ${s.stalls} × ${nights} night${nights > 1 ? 's' : ''}`, unit: p.stallNight, qty: s.stalls * nights });
  if (s.rvSites) lines.push({ label: `RV / trailer hookup × ${s.rvSites} × ${nights} night${nights > 1 ? 's' : ''}`, unit: p.rvNight, qty: s.rvSites * nights });
  if (s.house && p.houseCleaning) lines.push({ label: 'House cleaning fee', unit: p.houseCleaning, qty: 1 });
  if (s.stalls && p.stallCleaning) lines.push({ label: `Stall strip & bedding × ${s.stalls}`, unit: p.stallCleaning, qty: s.stalls });
  for (const l of lines) l.total = l.unit * l.qty;
  return { nights, lines, total: lines.reduce((a, l) => a + l.total, 0), currency: p.currency };
}

export function inventoryService(db, cfg) {
  const unitCounts = db.prepare("SELECT kind, COUNT(*) AS n FROM units WHERE active = 1 GROUP BY kind");
  const usedByNight = db.prepare(`SELECT a.night, u.kind, COUNT(*) AS n FROM allocations a
      JOIN units u ON u.id = a.unit_id WHERE a.night >= ? AND a.night < ? AND u.active = 1
      GROUP BY a.night, u.kind`);

  function totals() {
    const t = { house: 0, stall: 0, rv: 0 };
    for (const r of unitCounts.all()) t[r.kind] = r.n;
    return t;
  }

  // Free units of each kind for every night in [from, to).
  function availability(from, to) {
    const t = totals();
    const days = {};
    for (const d of nightsOf(from, to)) days[d] = { house: t.house, stalls: t.stall, rvSites: t.rv };
    for (const r of usedByNight.all(from, to)) {
      const key = r.kind === 'stall' ? 'stalls' : r.kind === 'rv' ? 'rvSites' : 'house';
      if (days[r.night]) days[r.night][key] = Math.max(0, days[r.night][key] - r.n);
    }
    return { totals: { house: t.house, stalls: t.stall, rvSites: t.rv }, days };
  }

  function unavailableReason(s) {
    const { days } = availability(s.checkIn, s.checkOut);
    for (const [night, free] of Object.entries(days)) {
      const when = new Date(night + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
      if (s.house && free.house < 1) return `The house is already booked the night of ${when}.`;
      if (free.stalls < s.stalls) return `Only ${free.stalls} stall${free.stalls === 1 ? ' is' : 's are'} free the night of ${when}.`;
      if (free.rvSites < s.rvSites) return `Only ${free.rvSites} RV site${free.rvSites === 1 ? ' is' : 's are'} free the night of ${when}.`;
    }
    return null;
  }

  // Picks specific units that are free on every night of the stay, so a horse keeps the
  // same stall (and the same camera) for its whole visit. Must run inside a transaction.
  function allocate(bookingId, s) {
    const nights = nightsOf(s.checkIn, s.checkOut);
    const placeholders = nights.map(() => '?').join(',');
    const pick = db.prepare(`SELECT id FROM units WHERE kind = ? AND active = 1 AND id NOT IN
        (SELECT unit_id FROM allocations WHERE night IN (${placeholders})) ORDER BY number LIMIT ?`);
    const insert = db.prepare('INSERT INTO allocations (booking_id, unit_id, night) VALUES (?, ?, ?)');
    const want = [['house', s.house ? 1 : 0], ['stall', s.stalls], ['rv', s.rvSites]];
    for (const [kind, count] of want) {
      if (!count) continue;
      const units = pick.all(kind, ...nights, count);
      if (units.length < count) {
        throw new BookingError('Those dates were just taken. Please pick different dates.', 409);
      }
      for (const u of units) for (const n of nights) insert.run(bookingId, u.id, n);
    }
  }

  const release = (bookingId) => db.prepare('DELETE FROM allocations WHERE booking_id = ?').run(bookingId);

  const unitsFor = (bookingId) => db.prepare(`SELECT DISTINCT u.id, u.kind, u.number, u.label FROM allocations a
      JOIN units u ON u.id = a.unit_id WHERE a.booking_id = ? ORDER BY u.kind, u.number`).all(bookingId);

  return { availability, unavailableReason, allocate, release, unitsFor, totals };
}

export { addDays };
