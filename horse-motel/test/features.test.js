// Owner and guest features added after the requirements review.
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startServer, client, futureStay, contact, bookAndPay } from './helpers.js';
import { _codeAt } from '../src/security/totp.js';
import { hashPassword } from '../src/security/password.js';
import { parseIcs } from '../src/services/ical.js';

const PW = 'correct horse battery staple';

async function adminClient(t) {
  t.db.prepare("INSERT INTO users (email, role, password_hash, created_at) VALUES ('owner@example.com', 'admin', ?, ?)")
    .run(await hashPassword(PW), Date.now());
  const c = client(t.base);
  await c.post('/api/auth/login', { email: 'owner@example.com', password: PW });
  const { secret } = (await c.post('/api/account/mfa/start', { password: PW })).data;
  await c.post('/api/account/mfa/confirm', { code: _codeAt(secret, Math.floor(Date.now() / 30000)) });
  return c;
}

describe('guest-facing features', () => {
  let t;
  before(async () => { t = await startServer(); });
  after(() => t.close());

  test('full-hookup RV sites are bookable and plain hookups leave them free', async () => {
    const stay = futureStay(t.cfg, { inDays: 12, stalls: 0, rvSites: 4 });
    await bookAndPay(t, client(t.base), stay, 'plain@example.com');
    const a = (await client(t.base).get(`/api/availability?from=${stay.checkIn}&days=1`)).data.days[stay.checkIn];
    assert.deepEqual({ rv: a.rvSites, sewer: a.rvSewer }, { rv: 2, sewer: 2 }, 'the 4 plain hookups used sites 3–6');
    const full = await client(t.base).post('/api/quote', { ...stay, rvSites: 0, rvSewer: 2 });
    assert.equal(full.data.ok, true);
    assert.ok(full.data.quote.lines.some((l) => /full RV hookup/.test(l.label)));
    const tooMany = await client(t.base).post('/api/quote', { ...stay, rvSites: 1, rvSewer: 2 });
    assert.equal(tooMany.data.ok, false);
    assert.match(tooMany.data.reason, /Only 2 RV sites are free/);
  });

  test('quote reports what is still free so the steppers can be capped', async () => {
    const stay = futureStay(t.cfg, { inDays: 12, stalls: 1 });
    const q = await client(t.base).post('/api/quote', stay);
    assert.equal(q.data.free.stalls, 8);
    assert.equal(q.data.free.rvSites, 2);
  });

  test('going back from checkout and booking again releases your own hold (with its token only)', async () => {
    const c = client(t.base);
    const stay = futureStay(t.cfg, { inDays: 40, house: true, guests: 2, stalls: 0 });
    const first = await c.post('/api/bookings', { stay, contact: contact('back@example.com'), agree: { rules: true, coggins: false } });
    assert.equal(first.status, 201);
    // Without the token: the house is still held by the first attempt.
    const blocked = await c.post('/api/bookings', { stay, contact: contact('back@example.com'), agree: { rules: true, coggins: false } });
    assert.equal(blocked.status, 409);
    const wrong = await c.post('/api/bookings', { stay, contact: contact('back@example.com'), agree: { rules: true, coggins: false }, replace: { ref: first.data.ref, t: 'nope' } });
    assert.equal(wrong.status, 409, 'a wrong token cannot release someone’s hold');
    const again = await c.post('/api/bookings', { stay, contact: contact('back@example.com'), agree: { rules: true, coggins: false },
      replace: { ref: first.data.ref, t: first.data.statusToken } });
    assert.equal(again.status, 201);
    await t.ctx.bookings.expireHolds(Date.now() + 3600e3);
  });

  test('the welcome email has everything a guest needs', async () => {
    const { mail } = await bookAndPay(t, client(t.base), futureStay(t.cfg, { inDays: 60, house: true, guests: 3, stalls: 2, rvSewer: 1 }), 'full@example.com');
    for (const needle of [/Stall 1, Stall 2/, /RV site 1 \(full hookup\)/, /Ranch house for 3 guests/, /Total paid: \$/, /Central Time/, /google\.com\/maps/, /Coggins/]) {
      assert.match(mail.text, needle);
    }
  });
});

describe('owner features', () => {
  let t, admin, feed, feedBody = '';
  before(async () => {
    feed = http.createServer((req, res) => { res.writeHead(200, { 'content-type': 'text/calendar' }); res.end(feedBody); });
    await new Promise((r) => feed.listen(0, '127.0.0.1', r));
    t = await startServer({ ICAL_EXPORT_TOKEN: 'x'.repeat(32), ADMIN_ALERT_EMAIL: 'owner-alerts@example.com' });
    // The feed server is plain http on localhost; point the importer at it directly.
    t.cfg.ical.importUrls = [`http://127.0.0.1:${feed.address().port}/airbnb.ics`];
    admin = await adminClient(t);
  });
  after(async () => { await t.close(); feed.close(); });

  test('phone bookings are confirmed and the guest is onboarded with camera access', async () => {
    const stay = futureStay(t.cfg, { inDays: 5, stalls: 1 });
    const r = await admin.post('/api/admin/bookings', { stay, contact: { name: 'Pat Phone', email: 'pat@example.com', phone: '501 555 0111' }, amountCents: 5000 });
    assert.equal(r.status, 201);
    const mail = t.mailer.outbox.find((m) => m.to === 'pat@example.com');
    assert.ok(mail && /#token=/.test(mail.text), 'guest got a set-up link');
    const b = t.db.prepare("SELECT status, source, amount_cents FROM bookings WHERE email = 'pat@example.com'").get();
    assert.deepEqual(b, { status: 'confirmed', source: 'admin', amount_cents: 5000 });
  });

  test('blocks target the exact stall the owner picks', async () => {
    const stall5 = t.db.prepare("SELECT id FROM units WHERE kind = 'stall' AND number = 5").get().id;
    const stay = futureStay(t.cfg, { inDays: 70, nights: 3 });
    const r = await admin.post('/api/admin/blocks', { checkIn: stay.checkIn, checkOut: stay.checkOut, unitIds: [stall5], note: 'Repairing stall 5' });
    assert.equal(r.status, 201);
    const held = t.db.prepare('SELECT DISTINCT u.number FROM allocations a JOIN units u ON u.id = a.unit_id JOIN bookings b ON b.id = a.booking_id WHERE b.ref = ?').all(r.data.ref);
    assert.deepEqual(held.map((x) => x.number), [5]);
    // A guest booking 5 stalls those nights gets 1–4 and 6, never 5.
    await bookAndPay(t, client(t.base), { ...stay, stalls: 5 }, 'five@example.com');
    const got = t.db.prepare("SELECT DISTINCT u.number FROM allocations a JOIN units u ON u.id = a.unit_id JOIN bookings b ON b.id = a.booking_id WHERE b.email = 'five@example.com' ORDER BY u.number").all();
    assert.deepEqual(got.map((x) => x.number), [1, 2, 3, 4, 6]);
  });

  test('cancel with refund + email ends access and tells the guest', async () => {
    const b = t.db.prepare("SELECT id FROM bookings WHERE email = 'five@example.com'").get();
    const r = await admin.post(`/api/admin/bookings/${b.id}/cancel`, { refund: true, notify: true });
    assert.equal(r.status, 200);
    assert.match(r.data.note, /Refunded \$/);
    const mail = t.mailer.outbox.at(-1);
    assert.equal(mail.to, 'five@example.com');
    assert.match(mail.text, /cancelled/);
    assert.match(mail.text, /refunded/);
    const cancelled = await admin.get('/api/admin/bookings?view=cancelled');
    assert.ok(cancelled.data.bookings.some((x) => x.email === 'five@example.com' && x.refund_cents > 0));
  });

  test('a mistyped email can be corrected and the stay moves to the right account', async () => {
    const r1 = await bookAndPay(t, client(t.base), futureStay(t.cfg, { inDays: 90 }), 'typo@exmaple.com');
    const b = t.db.prepare('SELECT id FROM bookings WHERE ref = ?').get(r1.ref);
    const r = await admin.post(`/api/admin/bookings/${b.id}/email`, { email: 'right@example.com' });
    assert.equal(r.status, 200);
    const moved = t.db.prepare('SELECT b.email, u.email AS owner FROM bookings b JOIN users u ON u.id = b.user_id WHERE b.id = ?').get(b.id);
    assert.deepEqual(moved, { email: 'right@example.com', owner: 'right@example.com' });
    assert.ok(t.mailer.outbox.some((m) => m.to === 'right@example.com' && /#token=/.test(m.text)));
  });

  test('bookings can be searched', async () => {
    const r = await admin.get('/api/admin/bookings?view=all&q=right@');
    assert.equal(r.data.bookings.length, 1);
  });

  test('occupancy shows who is in which stall each night', async () => {
    const from = futureStay(t.cfg, { inDays: 5 }).checkIn;
    const r = await admin.get(`/api/admin/occupancy?from=${from}&days=2`);
    const stall1 = r.data.units.find((u) => u.label === 'Stall 1').id;
    assert.equal(r.data.grid[`${stall1}:${from}`].who, 'Pat Phone');
  });

  test('Airbnb calendar import blocks the house, updates, and unblocks cancelled stays', async () => {
    const s = futureStay(t.cfg, { inDays: 120, nights: 3 });
    const d = (x) => x.replaceAll('-', '');
    feedBody = `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:abc123@airbnb.com\r\nDTSTART;VALUE=DATE:${d(s.checkIn)}\r\nDTEND;VALUE=DATE:${d(s.checkOut)}\r\nSUMMARY:Reserved\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
    const sync = await admin.post('/api/admin/calendar-sync');
    assert.equal(sync.data.imported, 1);
    let a = (await client(t.base).get(`/api/availability?from=${s.checkIn}&days=3`)).data.days;
    assert.ok(Object.values(a).every((n) => n.house === 0));
    await admin.post('/api/admin/calendar-sync'); // idempotent
    assert.equal(t.db.prepare("SELECT COUNT(*) AS n FROM bookings WHERE source = 'ical'").get().n, 1);
    feedBody = 'BEGIN:VCALENDAR\r\nEND:VCALENDAR\r\n';
    await admin.post('/api/admin/calendar-sync');
    a = (await client(t.base).get(`/api/availability?from=${s.checkIn}&days=3`)).data.days;
    assert.ok(Object.values(a).every((n) => n.house === 1), 'cancelled on Airbnb → free again');
  });

  test('an Airbnb booking that overlaps a website booking alerts the owner once', async () => {
    const s = futureStay(t.cfg, { inDays: 150, nights: 2, house: true, guests: 2, stalls: 0 });
    await bookAndPay(t, client(t.base), s, 'webhouse@example.com');
    const d = (x) => x.replaceAll('-', '');
    feedBody = `BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:clash@airbnb.com\r\nDTSTART;VALUE=DATE:${d(s.checkIn)}\r\nDTEND;VALUE=DATE:${d(s.checkOut)}\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n`;
    const before = t.mailer.outbox.filter((m) => /overlaps/.test(m.subject)).length;
    await admin.post('/api/admin/calendar-sync');
    await admin.post('/api/admin/calendar-sync');
    assert.equal(t.mailer.outbox.filter((m) => /overlaps/.test(m.subject)).length, before + 1);
  });

  test('the export feed lists house nights without guest names, behind a secret URL', async () => {
    assert.equal((await fetch(`${t.base}/calendar/wrong-token.ics`)).status, 404);
    const r = await fetch(`${t.base}/calendar/${'x'.repeat(32)}.ics`);
    const text = await r.text();
    assert.match(r.headers.get('content-type'), /text\/calendar/);
    assert.match(text, /BEGIN:VEVENT/);
    assert.match(text, /SUMMARY:Reserved/);
    assert.ok(!/webhouse|Casey/.test(text));
  });

  test('iCal parsing handles folding, timed and all-day events', () => {
    const ev = parseIcs('BEGIN:VCALENDAR\r\nBEGIN:VEVENT\r\nUID:long-\r\n uid\r\nDTSTART:20270105T200000Z\r\nDTEND:20270107T170000Z\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:b\r\nDTSTART;VALUE=DATE:20270110\r\nEND:VEVENT\r\nEND:VCALENDAR', 'America/Chicago');
    assert.deepEqual(ev.map((e) => [e.uid, e.start, e.end]), [['long-uid', '2027-01-05', '2027-01-07'], ['b', '2027-01-10', '2027-01-11']]);
  });

  test('validation errors read like English', async () => {
    const r = await admin.post('/api/admin/bookings', { stay: { ...futureStay(t.cfg), stalls: 99 }, contact: { name: 'A B', email: 'a@example.com', phone: '' } });
    assert.equal(r.status, 400);
    assert.match(r.data.error, /We have 8 stalls/);
  });
});
