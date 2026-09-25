import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, client, futureStay, contact, bookAndPay } from './helpers.js';
import { _codeAt } from '../src/security/totp.js';
import { rewritePlaylist } from '../src/services/cameras.js';
import { randomToken } from '../src/security/crypto.js';

const PW = 'correct horse battery staple';

describe('booking, onboarding and camera access', () => {
  let t;
  before(async () => { t = await startServer(); });
  after(() => t.close());

  test('availability reports every stall free on an empty calendar', async () => {
    const c = client(t.base);
    const r = await c.get('/api/availability?days=5');
    assert.equal(r.status, 200);
    const nights = Object.values(r.data.days);
    assert.equal(nights.length, 5);
    assert.ok(nights.every((n) => n.stalls === 8 && n.rvSites === 6 && n.house === 1));
  });

  test('quote is computed on the server', async () => {
    const c = client(t.base);
    const r = await c.post('/api/quote', futureStay(t.cfg, { stalls: 2, nights: 3, house: true, guests: 2 }));
    assert.equal(r.status, 200);
    assert.ok(r.data.ok);
    const p = t.cfg.pricing;
    assert.equal(r.data.quote.total, 3 * p.houseNight + 6 * p.stallNight + p.houseCleaning + 2 * p.stallCleaning);
  });

  test('rejects past dates, empty stays and unknown fields', async () => {
    const c = client(t.base);
    const base = futureStay(t.cfg);
    let r = await c.post('/api/quote', { ...base, checkIn: '2020-01-01', checkOut: '2020-01-02' });
    assert.equal(r.data.ok, false);
    r = await c.post('/api/quote', { ...base, stalls: 0 });
    assert.equal(r.data.ok, false);
    r = await c.post('/api/quote', { ...base, price: 1 });
    assert.equal(r.status, 400);
    r = await c.post('/api/bookings', { stay: base, contact: contact(), agree: { rules: true, coggins: true }, amount: 1 });
    assert.equal(r.status, 400);
  });

  test('booking stalls requires the Coggins confirmation', async () => {
    const c = client(t.base);
    const r = await c.post('/api/bookings', { stay: futureStay(t.cfg), contact: contact(), agree: { rules: true, coggins: false } });
    assert.equal(r.status, 400);
  });

  test('full flow: book → pay → welcome email → set password → see only own stall camera', async () => {
    // Two demo cameras, one per stall.
    const units = t.db.prepare("SELECT id, number FROM units WHERE kind = 'stall' ORDER BY number").all();
    for (const u of units.slice(0, 2)) {
      const info = t.db.prepare("INSERT INTO cameras (public_id, name, source_type) VALUES (?, ?, 'demo')").run(randomToken(12), `Stall ${u.number} cam`);
      t.db.prepare('INSERT INTO camera_units (camera_id, unit_id) VALUES (?, ?)').run(info.lastInsertRowid, u.id);
    }
    const c = client(t.base);
    // Stay starting today so the access window is open now (check-in 3 PM minus 3h may still be ahead,
    // so use inDays 0 and verify either live or upcoming below).
    const stay = futureStay(t.cfg, { inDays: 0, nights: 2 });
    const { setupToken, mail, ref } = await bookAndPay(t, c, stay);
    assert.ok(setupToken, 'welcome email carries a setup link');
    assert.match(mail.subject, /set up your/i);
    assert.match(mail.text, /Stall 1/);

    const info = await c.post('/api/auth/token-info', { token: setupToken });
    assert.equal(info.data.email, 'rider@example.com');
    const weak = await c.post('/api/auth/set-password', { token: setupToken, password: 'short' });
    assert.equal(weak.status, 400);
    const set = await c.post('/api/auth/set-password', { token: setupToken, password: PW });
    assert.equal(set.status, 200);
    assert.equal(set.data.user.email, 'rider@example.com');

    // Token is single-use.
    const again = await c.post('/api/auth/set-password', { token: setupToken, password: PW + '!' });
    assert.equal(again.status, 404);

    const acct = await c.get('/api/account');
    assert.equal(acct.status, 200);
    assert.equal(acct.data.bookings[0].ref, ref);
    assert.deepEqual(acct.data.bookings[0].units, ['Stall 1']);
    assert.equal(acct.data.cameras.length, 1, 'only the camera for the rented stall');
    assert.equal(acct.data.cameras[0].name, 'Stall 1 cam');

    // The other stall's camera is refused.
    const all = t.db.prepare('SELECT public_id, name FROM cameras').all();
    const mine = all.find((x) => x.name === 'Stall 1 cam');
    const theirs = all.find((x) => x.name === 'Stall 2 cam');
    const other = await c.get(`/api/cameras/${theirs.public_id}/snapshot`);
    assert.equal(other.status, 403);
    const own = await c.get(`/api/cameras/${mine.public_id}/snapshot`);
    assert.equal(own.status, acct.data.cameras[0].live ? 200 : 403);

    // Anonymous is refused.
    const anon = await client(t.base).get(`/api/cameras/${mine.public_id}/snapshot`);
    assert.equal(anon.status, 401);
  });

  test('camera window is enforced by time', async () => {
    const cams = t.ctx.cameras;
    const user = t.db.prepare("SELECT id FROM users WHERE email = 'rider@example.com'").get();
    const list = cams.camerasForUser(user.id);
    const w = list[0];
    assert.ok(w.liveUntil > w.liveFrom);
    assert.equal(cams.camerasForUser(user.id, w.liveFrom - 1)[0].live, false);
    assert.equal(cams.camerasForUser(user.id, w.liveFrom + 1)[0].live, true);
    assert.equal(cams.camerasForUser(user.id, w.liveUntil + 1).length, 0);
  });

  test('a returning guest is linked to their existing account and not sent a setup link', async () => {
    const c = client(t.base);
    const { setupToken, mail } = await bookAndPay(t, c, futureStay(t.cfg, { inDays: 20 }));
    assert.equal(setupToken, null);
    assert.match(mail.subject, /You’re booked/);
  });

  test('never double-books the last stall', async () => {
    const stay = futureStay(t.cfg, { inDays: 40, stalls: 8 });
    const a = await client(t.base).post('/api/bookings', { stay, contact: contact('a@example.com'), agree: { rules: true, coggins: true } });
    assert.equal(a.status, 201);
    const b = await client(t.base).post('/api/bookings', { stay: { ...stay, stalls: 1 }, contact: contact('b@example.com'), agree: { rules: true, coggins: true } });
    assert.equal(b.status, 409);
    // Released after the hold expires.
    await t.ctx.bookings.expireHolds(Date.now() + 3600e3);
    const c2 = await client(t.base).post('/api/bookings', { stay: { ...stay, stalls: 1 }, contact: contact('b@example.com'), agree: { rules: true, coggins: true } });
    assert.equal(c2.status, 201);
  });

  test('status page needs the private token', async () => {
    const c = client(t.base);
    const r = await c.post('/api/bookings', { stay: futureStay(t.cfg, { inDays: 60 }), contact: contact('s@example.com'), agree: { rules: true, coggins: true } });
    const ref = r.data.ref;
    assert.equal((await c.get(`/api/bookings/status?ref=${ref}&t=wrong`)).status, 404);
    const tok = new URL(r.data.checkoutUrl).searchParams.get('t');
    const ok = await c.get(`/api/bookings/status?ref=${ref}&t=${tok}`);
    assert.equal(ok.data.status, 'pending');
    assert.equal(ok.data.email, 's••@example.com', 'only a masked email on the status endpoint');
    assert.equal(ok.data.name, undefined);
    assert.equal(ok.data.phone, undefined);
  });

  test('cancelling a booking ends camera access immediately', async () => {
    const c = client(t.base);
    const login = await c.post('/api/auth/login', { email: 'rider@example.com', password: PW });
    assert.equal(login.status, 200);
    const before = (await c.get('/api/cameras')).data.cameras.length;
    assert.ok(before >= 1);
    for (const b of t.db.prepare("SELECT id FROM bookings WHERE email = 'rider@example.com'").all()) t.ctx.bookings.cancel(b.id);
    t.ctx.cameras.revokeAll();
    assert.equal((await c.get('/api/cameras')).data.cameras.length, 0);
  });
});

describe('authentication and session security', () => {
  let t;
  before(async () => {
    t = await startServer();
    const c = client(t.base);
    const { setupToken } = await bookAndPay(t, c, futureStay(t.cfg), 'guest@example.com');
    await c.post('/api/auth/set-password', { token: setupToken, password: PW });
  });
  after(() => t.close());

  test('session cookie is HttpOnly and SameSite', async () => {
    const r = await client(t.base).post('/api/auth/login', { email: 'guest@example.com', password: PW });
    const cookie = r.headers.getSetCookie().join('\n');
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
  });

  test('wrong password and unknown email give the same answer', async () => {
    const a = await client(t.base).post('/api/auth/login', { email: 'guest@example.com', password: 'nope-nope-nope' });
    const b = await client(t.base).post('/api/auth/login', { email: 'nobody@example.com', password: 'nope-nope-nope' });
    assert.equal(a.status, 401);
    assert.equal(b.status, 401);
    assert.equal(a.data.error, b.data.error);
  });

  test('account locks after repeated failures', async () => {
    const c = client(t.base);
    for (let i = 0; i < 5; i++) await c.post('/api/auth/login', { email: 'guest@example.com', password: 'wrong-password-' + i });
    const r = await c.post('/api/auth/login', { email: 'guest@example.com', password: PW });
    assert.equal(r.status, 401, 'correct password is refused while locked');
    t.db.prepare("UPDATE users SET locked_until = 0 WHERE email = 'guest@example.com'").run();
  });

  test('cross-site requests are blocked', async () => {
    const evil = client(t.base, { origin: 'https://evil.example' });
    const r = await evil.post('/api/auth/login', { email: 'guest@example.com', password: PW });
    assert.equal(r.status, 403);
  });

  test('form-encoded bodies are refused', async () => {
    const res = await fetch(t.base + '/api/auth/login', { method: 'POST', headers: { Origin: t.base, 'Content-Type': 'application/x-www-form-urlencoded' }, body: 'email=a&password=b' });
    assert.equal(res.status, 415);
  });

  test('signed-in writes need the CSRF token', async () => {
    const c = client(t.base);
    await c.post('/api/auth/login', { email: 'guest@example.com', password: PW });
    const r = await c.post('/api/account/profile', { name: 'Casey', phone: '' }, { 'X-CSRF-Token': 'forged' });
    assert.equal(r.status, 403);
    const ok = await c.post('/api/account/profile', { name: 'Casey', phone: '' });
    assert.equal(ok.status, 200);
  });

  test('guests cannot reach admin APIs', async () => {
    const c = client(t.base);
    await c.post('/api/auth/login', { email: 'guest@example.com', password: PW });
    assert.equal((await c.get('/api/admin/bookings')).status, 403);
    assert.equal((await client(t.base).get('/api/admin/bookings')).status, 401);
  });

  test('two-step verification: enrol, then required at sign-in, codes not reusable', async () => {
    const c = client(t.base);
    await c.post('/api/auth/login', { email: 'guest@example.com', password: PW });
    const start = await c.post('/api/account/mfa/start', { password: PW });
    assert.equal(start.status, 200);
    const secret = start.data.secret;
    const step = Math.floor(Date.now() / 30000);
    const confirm = await c.post('/api/account/mfa/confirm', { code: _codeAt(secret, step) });
    assert.equal(confirm.status, 200);

    const c2 = client(t.base);
    const login = await c2.post('/api/auth/login', { email: 'guest@example.com', password: PW });
    assert.equal(login.data.mfaRequired, true);
    assert.equal((await c2.get('/api/account')).status, 401, 'password alone does not sign in');
    const replay = await c2.post('/api/auth/mfa', { challenge: login.data.challenge, code: _codeAt(secret, step) });
    assert.equal(replay.status, 401, 'a code cannot be used twice');
    const good = await c2.post('/api/auth/mfa', { challenge: login.data.challenge, code: _codeAt(secret, step + 1) });
    assert.equal(good.status, 200);
    assert.equal((await c2.get('/api/account')).status, 200);
  });

  test('password reset: same response for unknown email, link is single use, old sessions die', async () => {
    const other = client(t.base);
    const a = await other.post('/api/auth/forgot', { email: 'nobody@example.com' });
    const before = t.mailer.outbox.length;
    const b = await other.post('/api/auth/forgot', { email: 'guest@example.com' });
    assert.deepEqual(a.data, b.data);
    assert.equal(t.mailer.outbox.length, before + 1);
    const token = t.mailer.outbox.at(-1).text.match(/#token=([A-Za-z0-9_-]+)/)[1];
    const r = await other.post('/api/auth/set-password', { token, password: 'a brand new long password' });
    assert.equal(r.status, 200);
    assert.equal(r.data.next, 'login', 'with 2-step on, the reset does not sign in by itself');
    assert.equal((await other.post('/api/auth/set-password', { token, password: 'another long password!' })).status, 404);
  });

  test('logout destroys the session server-side', async () => {
    t.db.prepare("UPDATE users SET totp_enabled = 0 WHERE email = 'guest@example.com'").run();
    const c = client(t.base);
    await c.post('/api/auth/login', { email: 'guest@example.com', password: 'a brand new long password' });
    const cookie = [...c.jar][0];
    await c.post('/api/auth/logout');
    const replay = await fetch(t.base + '/api/account', { headers: { Cookie: `${cookie[0]}=${cookie[1]}` } });
    assert.equal(replay.status, 401);
  });
});

describe('admin', () => {
  let t, admin, secret;
  before(async () => {
    t = await startServer();
    t.db.prepare("INSERT INTO users (email, role, created_at) VALUES ('owner@example.com', 'admin', ?)").run(Date.now());
    const { hashPassword } = await import('../src/security/password.js');
    t.db.prepare("UPDATE users SET password_hash = ? WHERE email = 'owner@example.com'").run(await hashPassword(PW));
    admin = client(t.base);
    await admin.post('/api/auth/login', { email: 'owner@example.com', password: PW });
  });
  after(() => t.close());

  test('admin without two-step is sent to enrol', async () => {
    const r = await admin.get('/api/admin/bookings');
    assert.equal(r.status, 403);
    assert.equal(r.data.code, 'mfa_enroll');
    const start = await admin.post('/api/account/mfa/start', { password: PW });
    secret = start.data.secret;
    await admin.post('/api/account/mfa/confirm', { code: _codeAt(secret, Math.floor(Date.now() / 30000)) });
    assert.equal((await admin.get('/api/admin/bookings')).status, 200);
  });

  test('admin cannot turn off two-step', async () => {
    const r = await admin.post('/api/account/mfa/disable', { password: PW, code: '123456' });
    assert.equal(r.status, 403);
  });

  test('camera addresses are validated and never returned', async () => {
    const units = (await admin.get('/api/admin/units')).data.units;
    const stall = units.find((u) => u.kind === 'stall');
    const bad = await admin.post('/api/admin/cameras', { name: 'x', sourceType: 'hls', sourceUrl: 'file:///etc/passwd', unitIds: [] });
    assert.equal(bad.status, 400);
    const ok = await admin.post('/api/admin/cameras', { name: 'Stall 1', sourceType: 'hls', sourceUrl: 'http://user:secret@10.0.0.5:8888/stall1/index.m3u8', unitIds: [stall.id] });
    assert.equal(ok.status, 201);
    const list = await admin.get('/api/admin/cameras');
    const text = JSON.stringify(list.data);
    assert.ok(!text.includes('secret'), 'credentials never leave the server');
    assert.ok(text.includes('10.0.0.5:8888'));
  });

  test('blocking dates removes them from availability', async () => {
    const stay = futureStay(t.cfg, { inDays: 5, nights: 1 });
    const units = (await admin.get('/api/admin/units')).data.units;
    const ids = units.filter((u) => u.kind === 'house' || u.kind === 'stall').map((u) => u.id);
    const r = await admin.post('/api/admin/blocks', { checkIn: stay.checkIn, checkOut: stay.checkOut, unitIds: ids, note: 'Family visit' });
    assert.equal(r.status, 201);
    const a = await client(t.base).get(`/api/availability?from=${stay.checkIn}&days=1`);
    assert.deepEqual(a.data.days[stay.checkIn], { house: 0, stalls: 0, rvSites: 6, rvSewer: 2 });
  });
});

describe('HLS playlist rewriting', () => {
  test('keeps same-directory files, drops anything else', () => {
    const pl = new URL('http://nvr.lan:8888/stall1/index.m3u8');
    const base = new URL('./', pl);
    const out = rewritePlaylist([
      '#EXTM3U',
      '#EXT-X-MAP:URI="init.mp4"',
      '#EXTINF:1.0,', 'seg1.mp4',
      '#EXTINF:1.0,', 'http://nvr.lan:8888/stall1/seg2.mp4?_HLS_msn=4&evil=1',
      '#EXTINF:1.0,', 'http://evil.example/seg3.mp4',
      '#EXTINF:1.0,', '../stall2/seg4.mp4',
    ].join('\n'), pl, base);
    assert.match(out, /URI="init\.mp4"/);
    assert.match(out, /^seg1\.mp4$/m);
    assert.match(out, /^seg2\.mp4\?_HLS_msn=4$/m);
    assert.ok(!out.includes('evil'));
    assert.ok(!out.includes('stall2'));
  });
});

describe('production safety', () => {
  test('refuses to start without HTTPS, Stripe and SMTP', async () => {
    const { buildConfig } = await import('../src/config.js');
    assert.throws(() => buildConfig({ NODE_ENV: 'production', APP_ORIGIN: 'http://x.com', PAYMENTS_MODE: 'mock' }), /unsafe configuration/);
  });
});
