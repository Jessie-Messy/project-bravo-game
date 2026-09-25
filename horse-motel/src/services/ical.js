// Two-way calendar sync with Airbnb (or any site that speaks iCal).
//
// Import: every ICAL_SYNC_MINUTES, each ICAL_IMPORT_URLS feed is fetched and its events
// become owner blocks on the units in ICAL_BLOCKS (the house by default), so a night
// booked on Airbnb can't also be booked here. Events that disappear from the feed are
// unblocked. If an Airbnb booking lands on a night that's already booked here, the owner
// is emailed once.
//
// Export: /calendar/<ICAL_EXPORT_TOKEN>.ics lists nights taken here (house bookings and
// owner blocks, never guest names) for Airbnb's "Import calendar".
import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import { audit } from '../db.js';
import { addDays, isIsoDate, todayIn } from '../dates.js';
import { BookingError } from './inventory.js';

const MAX_BYTES = 2 * 1024 * 1024;

// Minimal RFC 5545 reader: unfolds lines and pulls UID / DTSTART / DTEND / SUMMARY.
export function parseIcs(text, tz) {
  const lines = text.replace(/\r?\n[ \t]/g, '').split(/\r?\n/);
  const events = [];
  let cur = null;
  const toDate = (prop) => {
    const value = prop.slice(prop.indexOf(':') + 1).trim();
    const m = value.match(/^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/);
    if (!m) return null;
    // All-day and local ("floating"/TZID) times: the date as written. UTC times: the
    // calendar day at the ranch.
    if (!m[4] || !m[7]) return `${m[1]}-${m[2]}-${m[3]}`;
    return todayIn(tz, new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])));
  };
  for (const line of lines) {
    if (line === 'BEGIN:VEVENT') cur = {};
    else if (line === 'END:VEVENT') { if (cur?.uid && cur.start) events.push(cur); cur = null; }
    else if (cur) {
      const name = line.split(/[;:]/)[0].toUpperCase();
      if (name === 'UID') cur.uid = line.slice(line.indexOf(':') + 1).trim().slice(0, 200);
      else if (name === 'DTSTART') cur.start = toDate(line);
      else if (name === 'DTEND') cur.end = toDate(line);
      else if (name === 'SUMMARY') cur.summary = line.slice(line.indexOf(':') + 1).trim().slice(0, 100);
    }
  }
  for (const e of events) if (!e.end || e.end <= e.start) e.end = addDays(e.start, 1);
  return events.filter((e) => isIsoDate(e.start) && isIsoDate(e.end));
}

const PRIVATE_V4 = [/^10\./, /^127\./, /^169\.254\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, /^0\./];
const isPrivate = (ip) => (net.isIPv6(ip)
  ? /^(::1$|fc|fd|fe80:|::ffff:(10|127|169\.254|192\.168)\.)/i.test(ip)
  : PRIVATE_V4.some((re) => re.test(ip)));

export function icalService({ db, cfg, bookings, mailer }) {
  // Tests point the importer at a local server; everywhere else feeds must be public.
  async function assertPublicHost(hostname, original) {
    if (cfg.test && new URL(original).hostname === hostname) return;
    const addrs = net.isIP(hostname) ? [hostname] : (await dns.lookup(hostname, { all: true })).map((a) => a.address);
    if (!addrs.length || addrs.some(isPrivate) || /(^|\.)(localhost|internal)$/i.test(hostname)) throw new Error('feed address is not a public host');
  }

  const state = { lastSync: null, lastError: null, imported: 0 };

  function unitIdsFor(spec) {
    const ids = new Set();
    for (const item of spec) {
      const [kind, num] = item.split(':');
      const rows = num
        ? db.prepare('SELECT id FROM units WHERE kind = ? AND number = ? AND active = 1').all(kind, Number(num))
        : db.prepare('SELECT id FROM units WHERE kind = ? AND active = 1').all(kind);
      rows.forEach((r) => ids.add(r.id));
    }
    return [...ids];
  }

  // Follows up to 3 redirects by hand, checking every hop: never downgrade from https,
  // never go to a loopback / private / link-local / metadata address.
  async function fetchFeed(url) {
    let current = new URL(url);
    let r;
    for (let hop = 0; ; hop++) {
      await assertPublicHost(current.hostname, url);
      r = await fetch(current, { redirect: 'manual', signal: AbortSignal.timeout(20000), headers: { accept: 'text/calendar' } });
      if (![301, 302, 303, 307, 308].includes(r.status)) break;
      if (hop >= 3) throw new Error('feed redirected too many times');
      const next = new URL(r.headers.get('location') || '', current);
      if (current.protocol === 'https:' && next.protocol !== 'https:') throw new Error('feed redirected away from https');
      current = next;
    }
    if (!r.ok) throw new Error(`feed returned ${r.status}`);
    const chunks = [];
    let size = 0;
    for await (const c of r.body) { size += c.length; if (size > MAX_BYTES) throw new Error('feed too large'); chunks.push(c); }
    return Buffer.concat(chunks).toString('utf8');
  }

  async function syncImports() {
    if (!cfg.ical.importUrls.length) return state;
    const today = todayIn(cfg.ranch.timezone);
    const units = unitIdsFor(cfg.ical.blocks);
    let count = 0;
    const errors = [];
    for (const url of cfg.ical.importUrls) {
      const feed = crypto.createHash('sha256').update(url).digest('hex').slice(0, 10);
      let events;
      try { events = parseIcs(await fetchFeed(url), cfg.ranch.timezone); }
      catch (e) { errors.push(e.message); continue; } // keep existing blocks if a fetch fails
      const seen = new Set();
      for (const ev of events) {
        if (ev.end <= today) continue;
        const start = ev.start < today ? today : ev.start;
        const uid = `${feed}:${ev.uid}`;
        seen.add(uid);
        const existing = db.prepare("SELECT id, check_in, check_out FROM bookings WHERE external_uid = ? AND kind = 'block'").get(uid);
        if (existing && existing.check_in === start && existing.check_out === ev.end) { count++; continue; }
        if (existing) db.transaction(() => { db.prepare('DELETE FROM bookings WHERE id = ?').run(existing.id); })();
        try {
          bookings.block({ checkIn: start, checkOut: ev.end, unitIds: units, note: `Airbnb: ${ev.summary || 'Reserved'}`, source: 'ical', externalUid: uid });
          count++;
        } catch (e) {
          if (!(e instanceof BookingError)) throw e;
          await reportConflict(uid, start, ev.end, e.message);
        }
      }
      // Events removed from the feed (cancelled on Airbnb) free their nights again.
      const ours = db.prepare("SELECT id, external_uid FROM bookings WHERE kind = 'block' AND source = 'ical' AND external_uid LIKE ? AND check_out > ?")
        .all(`${feed}:%`, today);
      for (const b of ours) if (!seen.has(b.external_uid)) db.prepare('DELETE FROM bookings WHERE id = ?').run(b.id);
    }
    state.lastSync = Date.now();
    state.lastError = errors.length ? errors.join('; ') : null;
    state.imported = count;
    if (errors.length) console.error('[ical] sync problems:', state.lastError);
    return state;
  }

  async function reportConflict(uid, start, end, why) {
    const already = db.prepare("SELECT 1 FROM audit_log WHERE action = 'ical.conflict' AND detail LIKE ?").get(`${uid}%`);
    if (already) return;
    audit(db, { action: 'ical.conflict', detail: `${uid} ${start}..${end}: ${why}` });
    if (cfg.mail.adminAlertTo) {
      await mailer.send({ to: cfg.mail.adminAlertTo, subject: 'ACTION NEEDED: Airbnb booking overlaps a booking on your website',
        text: `An Airbnb reservation from ${start} to ${end} overlaps nights already booked on your website (${why}).\n\nOne of the two needs to be moved or cancelled.`,
        action: { label: 'Open the admin page', url: `${cfg.origin}/admin` } }).catch(() => {});
    }
  }

  function exportIcs() {
    const from = addDays(todayIn(cfg.ranch.timezone), -30);
    const rows = db.prepare(`SELECT DISTINCT b.ref, b.check_in, b.check_out FROM bookings b
        JOIN allocations a ON a.booking_id = b.id JOIN units u ON u.id = a.unit_id
        WHERE u.id IN (${unitIdsFor(cfg.ical.blocks).map(() => '?').join(',') || 'NULL'})
          AND b.status = 'confirmed' AND b.source != 'ical' AND b.check_out >= ?
        ORDER BY b.check_in`).all(...unitIdsFor(cfg.ical.blocks), from);
    const host = new URL(cfg.origin).host;
    const d = (iso) => iso.replaceAll('-', '');
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
    const events = rows.map((r) => ['BEGIN:VEVENT', `UID:${r.ref}@${host}`, `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${d(r.check_in)}`, `DTEND;VALUE=DATE:${d(r.check_out)}`, 'SUMMARY:Reserved', 'END:VEVENT'].join('\r\n'));
    return ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:-//${host}//bookings//EN`, 'CALSCALE:GREGORIAN', ...events, 'END:VCALENDAR', ''].join('\r\n');
  }

  return { syncImports, exportIcs, state };
}
