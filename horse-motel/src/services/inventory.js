// Availability, pricing and unit allocation.
//
// Units: the house, stalls, and RV/trailer sites. The first RV_SEWER_SITES RV sites also
// have a sewer connection ("full hookup"); guests can ask for one specifically. Plain
// hookup requests use non-sewer sites first, so full hookups stay free for those who
// need them.
import { z } from 'zod';
import { addDays, daysBetween, isIsoDate, nightsOf, todayIn } from '../dates.js';

export class BookingError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

const isoDate = z.string().refine(isIsoDate, 'Use a real date (YYYY-MM-DD).');

export function stayRequestSchema(cfg) {
  const inv = cfg.inventory;
  const count = (max, what) => z.number({ message: `Choose how many ${what}.` }).int()
    .min(0, `Choose 0 or more ${what}.`).max(max, `We have ${max} ${what} in total.`);
  return z.object({
    checkIn: isoDate,
    checkOut: isoDate,
    house: z.boolean(),
    stalls: count(inv.stalls, 'stalls'),
    rvSites: count(inv.rvSites, 'RV sites'),
    rvSewer: count(inv.rvSewerSites, 'full-hookup RV sites').optional().default(0),
    guests: z.number().int().min(0).max(inv.maxGuests, `The house sleeps up to ${inv.maxGuests}.`),
  }).strict();
}

// Rules that span fields. Returns a message a guest can act on, or null.
export function stayProblem(cfg, s, now = new Date()) {
  const today = todayIn(cfg.ranch.timezone, now);
  const nights = daysBetween(s.checkIn, s.checkOut);
  const call = cfg.ranch.phone ? ` Call us on ${cfg.ranch.phone} for longer stays.` : ' Contact us for longer stays.';
  if (s.checkIn < today) return 'Check-in can’t be in the past.';
  if (nights < 1) return 'Check-out must be after check-in.';
  if (nights > cfg.inventory.maxNights) return `Stays can be up to ${cfg.inventory.maxNights} nights.${call}`;
  if (daysBetween(today, s.checkIn) > cfg.inventory.bookingWindowDays) return 'That date is too far ahead to book online yet.';
  if (!s.house && !s.stalls && !s.rvSites && !s.rvSewer) return 'Choose the house, at least one stall, or an RV site.';
  if ((s.rvSites || 0) + (s.rvSewer || 0) > cfg.inventory.rvSites) return `We have ${cfg.inventory.rvSites} RV sites in total.`;
  if (s.house && s.guests < 1) return 'Tell us how many people are staying in the house.';
  return null;
}

const plural = (n, one, many = one + 's') => `${n} ${n === 1 ? one : many}`;

export function priceStay(cfg, s) {
  const p = cfg.pricing;
  const nights = daysBetween(s.checkIn, s.checkOut);
  const n = plural(nights, 'night');
  const lines = [];
  if (s.house) lines.push({ label: `Ranch house, ${n}`, unit: p.houseNight, qty: nights });
  if (s.stalls) lines.push({ label: `${plural(s.stalls, 'horse stall')}, ${n}`, unit: p.stallNight, qty: s.stalls * nights });
  if (s.rvSites) lines.push({ label: `${plural(s.rvSites, 'RV hookup')} (power & water), ${n}`, unit: p.rvNight, qty: s.rvSites * nights });
  if (s.rvSewer) lines.push({ label: `${plural(s.rvSewer, 'full RV hookup')} (with sewer), ${n}`, unit: p.rvSewerNight, qty: s.rvSewer * nights });
  if (s.house && p.houseCleaning) lines.push({ label: 'House cleaning fee', unit: p.houseCleaning, qty: 1 });
  if (s.stalls && p.stallCleaning) lines.push({ label: `Stall strip & fresh bedding × ${s.stalls}`, unit: p.stallCleaning, qty: s.stalls });
  for (const l of lines) l.total = l.unit * l.qty;
  const subtotal = lines.reduce((a, l) => a + l.total, 0);
  if (p.taxBasisPoints) {
    const tax = Math.round((subtotal * p.taxBasisPoints) / 10000);
    lines.push({ label: `${p.taxLabel} (${p.taxBasisPoints / 100}%)`, unit: tax, qty: 1, total: tax, tax: true });
  }
  return { nights, lines, total: lines.reduce((a, l) => a + l.total, 0), currency: p.currency };
}

export function inventoryService(db, cfg) {
  const unitCounts = db.prepare(`SELECT kind, COUNT(*) AS n, SUM(sewer) AS sewer FROM units WHERE active = 1 GROUP BY kind`);
  const usedByNight = db.prepare(`SELECT a.night, u.kind, COUNT(*) AS n, SUM(u.sewer) AS sewer FROM allocations a
      JOIN units u ON u.id = a.unit_id WHERE a.night >= ? AND a.night < ? AND u.active = 1
      GROUP BY a.night, u.kind`);

  function totals() {
    const t = { house: 0, stall: 0, rv: 0, rvSewer: 0 };
    for (const r of unitCounts.all()) { t[r.kind] = r.n; if (r.kind === 'rv') t.rvSewer = r.sewer || 0; }
    return t;
  }

  // Free units of each kind for every night in [from, to). rvSites counts every free RV
  // site; rvSewer counts the free full-hookup ones among them.
  function availability(from, to) {
    const t = totals();
    const days = {};
    for (const d of nightsOf(from, to)) days[d] = { house: t.house, stalls: t.stall, rvSites: t.rv, rvSewer: t.rvSewer };
    for (const r of usedByNight.all(from, to)) {
      const day = days[r.night];
      if (!day) continue;
      if (r.kind === 'stall') day.stalls = Math.max(0, day.stalls - r.n);
      else if (r.kind === 'house') day.house = Math.max(0, day.house - r.n);
      else { day.rvSites = Math.max(0, day.rvSites - r.n); day.rvSewer = Math.max(0, day.rvSewer - (r.sewer || 0)); }
    }
    return { totals: { house: t.house, stalls: t.stall, rvSites: t.rv, rvSewer: t.rvSewer }, days };
  }

  // The fewest free units of each kind across a stay (for capping the steppers).
  function minFree(checkIn, checkOut) {
    const { days, totals: t } = availability(checkIn, checkOut);
    const out = { ...t };
    for (const d of Object.values(days)) for (const k of Object.keys(out)) out[k] = Math.min(out[k], d[k]);
    return out;
  }

  function unavailableReason(s) {
    const { days } = availability(s.checkIn, s.checkOut);
    const none = (n, one, many) => (n === 0 ? `No ${many} are` : n === 1 ? `Only 1 ${one} is` : `Only ${n} ${many} are`);
    for (const [night, free] of Object.entries(days)) {
      const when = new Date(night + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
      if (s.house && free.house < 1) return `The house is already booked the night of ${when}.`;
      if (free.stalls < s.stalls) return `${none(free.stalls, 'stall', 'stalls')} free the night of ${when}.`;
      if (free.rvSewer < (s.rvSewer || 0)) return `${none(free.rvSewer, 'full-hookup RV site', 'full-hookup RV sites')} free the night of ${when}.`;
      if (free.rvSites < (s.rvSites || 0) + (s.rvSewer || 0)) return `${none(free.rvSites, 'RV site', 'RV sites')} free the night of ${when}.`;
    }
    return null;
  }

  // Picks specific units that are free on every night of the stay, so a horse keeps the
  // same stall (and the same camera) for its whole visit. Must run inside a transaction.
  function allocate(bookingId, s) {
    const nights = nightsOf(s.checkIn, s.checkOut);
    const placeholders = nights.map(() => '?').join(',');
    const free = `active = 1 AND id NOT IN (SELECT unit_id FROM allocations WHERE night IN (${placeholders}))`;
    const pick = {
      house: db.prepare(`SELECT id FROM units WHERE kind = 'house' AND ${free} ORDER BY number LIMIT ?`),
      stall: db.prepare(`SELECT id FROM units WHERE kind = 'stall' AND ${free} ORDER BY number LIMIT ?`),
      rvSewer: db.prepare(`SELECT id FROM units WHERE kind = 'rv' AND sewer = 1 AND ${free} ORDER BY number LIMIT ?`),
      rv: db.prepare(`SELECT id FROM units WHERE kind = 'rv' AND ${free} ORDER BY sewer, number LIMIT ?`),
    };
    const insert = db.prepare('INSERT INTO allocations (booking_id, unit_id, night) VALUES (?, ?, ?)');
    // Full hookups first, so a plain request can't take the last sewer site first.
    const want = [['house', s.house ? 1 : 0], ['stall', s.stalls], ['rvSewer', s.rvSewer || 0], ['rv', s.rvSites]];
    for (const [kind, count] of want) {
      if (!count) continue;
      const units = pick[kind].all(...nights, count);
      if (units.length < count) throw new BookingError('Those dates were just taken. Please pick different dates.', 409);
      for (const u of units) for (const n of nights) insert.run(bookingId, u.id, n);
    }
  }

  // Owner blocks name the exact units ("stall 5 is being repaired"). Inside a transaction.
  function allocateUnits(bookingId, unitIds, checkIn, checkOut) {
    const nights = nightsOf(checkIn, checkOut);
    const taken = db.prepare(`SELECT u.label, a.night FROM allocations a JOIN units u ON u.id = a.unit_id
        WHERE a.unit_id = ? AND a.night >= ? AND a.night < ? ORDER BY a.night LIMIT 1`);
    const insert = db.prepare('INSERT INTO allocations (booking_id, unit_id, night) VALUES (?, ?, ?)');
    for (const id of unitIds) {
      const clash = taken.get(id, checkIn, checkOut);
      if (clash) throw new BookingError(`${clash.label} is already booked the night of ${clash.night}.`, 409);
      for (const n of nights) insert.run(bookingId, id, n);
    }
  }

  const release = (bookingId) => db.prepare('DELETE FROM allocations WHERE booking_id = ?').run(bookingId);

  const unitsFor = (bookingId) => db.prepare(`SELECT DISTINCT u.id, u.kind, u.number, u.label, u.sewer FROM allocations a
      JOIN units u ON u.id = a.unit_id WHERE a.booking_id = ? ORDER BY u.kind, u.number`).all(bookingId);

  return { availability, minFree, unavailableReason, allocate, allocateUnits, release, unitsFor, totals };
}

export { addDays };
