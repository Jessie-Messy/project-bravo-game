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
import http from 'node:http';
import https from 'node:https';
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

// Is this address anywhere other than the public internet? Covers IPv4 private/reserved
// ranges and every IPv6 form that can carry one (mapped, NAT64, 6to4), plus IPv6 local,
// unique-local, site-local, multicast and unspecified.
export function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) {
    const [a, b, c] = ip.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0 && c === 0) || (a === 198 && (b === 18 || b === 19));
  }
  if (!net.isIPv6(ip)) return true;
  const h = expandV6(ip);
  const embeddedV4 = (hi, lo) => `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`;
  if (h.every((x) => x === 0) || (h.slice(0, 7).every((x) => x === 0) && h[7] === 1)) return true; // :: and ::1
  if (h.slice(0, 5).every((x) => x === 0) && h[5] === 0xffff) return isPrivateAddress(embeddedV4(h[6], h[7])); // ::ffff:v4
  if (h[0] === 0x64 && h[1] === 0xff9b) return isPrivateAddress(embeddedV4(h[6], h[7])); // NAT64
  if (h[0] === 0x2002) return isPrivateAddress(embeddedV4(h[1], h[2])); // 6to4
  if ((h[0] & 0xfe00) === 0xfc00 || (h[0] & 0xffc0) === 0xfe80 || (h[0] & 0xffc0) === 0xfec0 || (h[0] & 0xff00) === 0xff00) return true;
  if (h.slice(0, 6).every((x) => x === 0)) return true; // deprecated IPv4-compatible ::a.b.c.d
  return false;
}
function expandV6(ip) {
  let s = ip.split('%')[0];
  const v4 = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) { const [a, b, c, d] = v4[1].split('.').map(Number); s = s.replace(v4[1], `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`); }
  const [head, tail = ''] = s.split('::');
  const hp = head ? head.split(':') : [];
  const tp = s.includes('::') ? (tail ? tail.split(':') : []) : [];
  const fill = s.includes('::') ? Array(8 - hp.length - tp.length).fill('0') : [];
  return [...hp, ...fill, ...tp].map((x) => parseInt(x || '0', 16));
}

export function icalService({ db, cfg, bookings, mailer }) {
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

  // Fetches a feed. The address check happens inside the connection's own DNS lookup, so
  // the address that was checked is the address that's connected to (no DNS rebinding).
  // Redirects are followed by hand (at most 3), never downgrading from https.
  function getOnce(url) {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const allowLocal = cfg.test && u.hostname === '127.0.0.1'; // the test suite's own feed server
      // Node doesn't run `lookup` for literal IP addresses, so check those here.
      const literal = u.hostname.replace(/^\[|\]$/g, '');
      if (net.isIP(literal) && isPrivateAddress(literal) && !allowLocal) return reject(new Error('feed address is not a public host'));
      const lookup = (hostname, opts, cb) => dns.lookup(hostname, { all: true }).then((addrs) => {
        const bad = addrs.find((a) => isPrivateAddress(a.address));
        if (!addrs.length || (bad && !allowLocal)) return cb(new Error('feed address is not a public host'));
        const pick = addrs[0];
        return opts.all ? cb(null, [pick]) : cb(null, pick.address, pick.family);
      }, cb);
      const lib = u.protocol === 'https:' ? https : http;
      const req = lib.get(u, { lookup, timeout: 20000, headers: { accept: 'text/calendar' } }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode)) { res.resume(); return resolve({ redirect: res.headers.location }); }
        if (res.statusCode !== 200) { res.resume(); return reject(new Error(`feed returned ${res.statusCode}`)); }
        const chunks = [];
        let size = 0;
        res.on('data', (c) => { size += c.length; if (size > MAX_BYTES) { req.destroy(new Error('feed too large')); } else chunks.push(c); });
        res.on('end', () => resolve({ body: Buffer.concat(chunks).toString('utf8') }));
        res.on('error', reject);
      });
      req.on('timeout', () => req.destroy(new Error('feed timed out')));
      req.on('error', reject);
    });
  }

  async function fetchFeed(url) {
    let current = url;
    for (let hop = 0; hop <= 3; hop++) {
      const r = await getOnce(current);
      if (r.body !== undefined) return r.body;
      const next = new URL(r.redirect || '', current);
      if (new URL(current).protocol === 'https:' && next.protocol !== 'https:') throw new Error('feed redirected away from https');
      if (!['http:', 'https:'].includes(next.protocol)) throw new Error('feed redirected somewhere odd');
      current = next.href;
    }
    throw new Error('feed redirected too many times');
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
        if (existing) db.prepare("DELETE FROM bookings WHERE kind = 'block' AND (external_uid = ? OR external_uid LIKE ?)").run(uid, `${uid}#%`);
        else db.prepare("DELETE FROM bookings WHERE kind = 'block' AND external_uid LIKE ?").run(`${uid}#%`);
        // Our own booking echoed back by Airbnb (it imports our feed): nothing to do.
        if (isOwnEcho(start, ev.end, units)) continue;
        const note = `Airbnb: ${ev.summary || 'Reserved'}`;
        try {
          bookings.block({ checkIn: start, checkOut: ev.end, unitIds: units, note, source: 'ical', externalUid: uid });
          count++;
        } catch (e) {
          if (!(e instanceof BookingError)) throw e;
          // Partly overlaps something booked here: still block the nights that are free,
          // and tell the owner about the clash.
          blockFreeNights(start, ev.end, units, note, uid);
          await reportConflict(uid, start, ev.end, e.message);
        }
      }
      // Events removed from the feed (cancelled on Airbnb) free their nights again.
      const ours = db.prepare("SELECT id, external_uid FROM bookings WHERE kind = 'block' AND source = 'ical' AND external_uid LIKE ? AND check_out > ?")
        .all(`${feed}:%`, today);
      for (const b of ours) if (!seen.has(b.external_uid.split('#')[0])) db.prepare('DELETE FROM bookings WHERE id = ?').run(b.id);
    }
    state.lastSync = Date.now();
    state.lastError = errors.length ? errors.join('; ') : null;
    state.imported = count;
    if (errors.length) console.error('[ical] sync problems:', state.lastError);
    return state;
  }

  // Our own bookings come back from Airbnb (it imports our feed), sometimes merged into one
  // event. An event is an echo when every one of its nights is already booked here.
  function isOwnEcho(start, end, units) {
    const covered = new Set(db.prepare(`SELECT DISTINCT a.night FROM allocations a JOIN bookings b ON b.id = a.booking_id
        WHERE b.status = 'confirmed' AND b.source != 'ical' AND a.night >= ? AND a.night < ?
          AND a.unit_id IN (${units.map(() => '?').join(',')})`).all(start, end, ...units).map((r) => r.night));
    for (let d = start; d < end; d = addDays(d, 1)) if (!covered.has(d)) return false;
    return true;
  }

  function blockFreeNights(start, end, units, note, uid) {
    const taken = new Set(db.prepare(`SELECT DISTINCT night FROM allocations WHERE night >= ? AND night < ?
        AND unit_id IN (${units.map(() => '?').join(',')})`).all(start, end, ...units).map((r) => r.night));
    let runStart = null;
    for (let d = start; d <= end; d = addDays(d, 1)) {
      const free = d < end && !taken.has(d);
      if (free && runStart === null) runStart = d;
      if (!free && runStart !== null) {
        try { bookings.block({ checkIn: runStart, checkOut: d, unitIds: units, note, source: 'ical', externalUid: `${uid}#${runStart}` }); }
        catch (e) { if (!(e instanceof BookingError)) throw e; }
        runStart = null;
      }
    }
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
    // UIDs are a hash of the booking reference, so the feed reveals nothing usable.
    const uidOf = (ref) => crypto.createHash('sha256').update(`${cfg.ical.exportToken}:${ref}`).digest('hex').slice(0, 20);
    const events = rows.map((r) => ['BEGIN:VEVENT', `UID:${uidOf(r.ref)}@${host}`, `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${d(r.check_in)}`, `DTEND;VALUE=DATE:${d(r.check_out)}`, 'SUMMARY:Reserved', 'END:VEVENT'].join('\r\n'));
    return ['BEGIN:VCALENDAR', 'VERSION:2.0', `PRODID:-//${host}//bookings//EN`, 'CALSCALE:GREGORIAN', ...events, 'END:VCALENDAR', ''].join('\r\n');
  }

  return { syncImports, exportIcs, state };
}
