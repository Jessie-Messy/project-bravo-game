// Regression tests for the security critic's findings (one block per finding).
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startServer, client, futureStay, contact, bookAndPay } from './helpers.js';
import { _codeAt } from '../src/security/totp.js';
import { randomToken } from '../src/security/crypto.js';
import { hashPassword } from '../src/security/password.js';
import { buildConfig } from '../src/config.js';
import { HOLD_LIMITS } from '../src/services/bookings.js';
import { addDays } from '../src/dates.js';

const PW = 'correct horse battery staple';
const nowStep = () => Math.floor(Date.now() / 30000);

async function makeUser(t, email, { role = 'guest', totp = false } = {}) {
  t.db.prepare('INSERT INTO users (email, role, password_hash, created_at) VALUES (?, ?, ?, ?)')
    .run(email, role, await hashPassword(PW), Date.now());
  if (!totp) return null;
  const c = client(t.base);
  await c.post('/api/auth/login', { email, password: PW });
  const { secret } = (await c.post('/api/account/mfa/start', { password: PW })).data;
  await c.post('/api/account/mfa/confirm', { code: _codeAt(secret, nowStep()) });
  return secret;
}
const wrongCode = (secret) => { // a 6-digit code that is not valid in the current window
  const valid = new Set([-1, 0, 1].map((d) => _codeAt(secret, nowStep() + d)));
  for (let i = 0; ; i++) { const c = String(i).padStart(6, '0'); if (!valid.has(c)) return c; }
};

describe('security regressions', () => {
  let t, camUpstream, upstreamPort, bigHits = 0;
  before(async () => {
    camUpstream = http.createServer((req, res) => {
      if (req.url.endsWith('big.mp4')) { bigHits++; res.writeHead(200, { 'content-type': 'video/mp4' }); const chunk = Buffer.alloc(1024 * 1024); let n = 0; const pump = () => { while (n++ < 40) { if (!res.write(chunk)) return res.once('drain', pump); } res.end(); }; return pump(); }
      if (req.url.endsWith('slow.mp4')) { setTimeout(() => { res.writeHead(200, { 'content-type': 'video/mp4' }); res.end('x'); }, 400); return; }
      if (req.url.endsWith('index.m3u8')) { res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' }); return res.end('#EXTM3U\n#EXTINF:1,\nseg1.mp4\n'); }
      res.writeHead(200, { 'content-type': 'video/mp4' }); res.end('segment');
    });
    await new Promise((r) => camUpstream.listen(0, '127.0.0.1', r));
    upstreamPort = camUpstream.address().port;
    t = await startServer({ CAMERA_ALLOWED_HOSTS: '127.0.0.1' });
  });
  after(async () => { await t.close(); camUpstream.close(); });

  test('#1 2-step codes cannot be brute-forced across many sign-ins', async () => {
    const secret = await makeUser(t, 'mfa@example.com', { totp: true });
    const before = t.mailer.outbox.length;
    let refused = false;
    for (let i = 0; i < 12 && !refused; i++) {
      const c = client(t.base);
      const login = await c.post('/api/auth/login', { email: 'mfa@example.com', password: PW });
      if (!login.data.mfaRequired) { refused = true; break; }
      const r = await c.post('/api/auth/mfa', { challenge: login.data.challenge, code: wrongCode(secret) });
      if (r.data.restart) refused = true;
    }
    assert.ok(refused, 'the account locks');
    const u = t.db.prepare("SELECT locked_until FROM users WHERE email = 'mfa@example.com'").get();
    assert.ok(u.locked_until > Date.now());
    // Even the right password and code are refused while locked.
    const c = client(t.base);
    const login = await c.post('/api/auth/login', { email: 'mfa@example.com', password: PW });
    assert.equal(login.status, 401);
    assert.ok(t.mailer.outbox.slice(before).some((m) => /2-step verification code wrong/.test(m.text)), 'the owner is warned');
  });

  test('#2 parallel wrong passwords cannot skip the lockout', async () => {
    await makeUser(t, 'race@example.com');
    const guesses = Array.from({ length: 12 }, (_, i) => client(t.base).post('/api/auth/login', { email: 'race@example.com', password: `wrong-guess-${i}` }));
    const right = client(t.base).post('/api/auth/login', { email: 'race@example.com', password: PW });
    const results = await Promise.all([...guesses, right]);
    assert.ok(results.every((r) => r.status === 401 || r.status === 503), 'no guess succeeds and the correct one is refused too');
    const u = t.db.prepare("SELECT locked_until FROM users WHERE email = 'race@example.com'").get();
    assert.ok(u.locked_until > Date.now());
  });

  test('#3 admin camera access needs a 2-step session', async () => {
    t.db.prepare('INSERT INTO users (email, role, password_hash, created_at) VALUES (?, ?, ?, ?)')
      .run('newadmin@example.com', 'admin', await hashPassword(PW), Date.now());
    const cam = t.db.prepare("INSERT INTO cameras (public_id, name, source_type) VALUES (?, 'Lonely cam', 'demo')").run(randomToken(12));
    const pid = t.db.prepare('SELECT public_id FROM cameras WHERE id = ?').get(cam.lastInsertRowid).public_id;
    const c = client(t.base);
    await c.post('/api/auth/login', { email: 'newadmin@example.com', password: PW });
    assert.equal((await c.get('/api/cameras')).data.cameras.length, 0);
    assert.equal((await c.get(`/api/cameras/${pid}/snapshot`)).status, 403);
  });

  test('#4 one network cannot hold the whole calendar', async () => {
    const results = [];
    for (let i = 0; i < 4; i++) {
      results.push(await client(t.base).post('/api/bookings', { stay: futureStay(t.cfg, { inDays: 100 + i * 30, stalls: 8 }),
        contact: contact(`hog${i}@example.com`), agree: { rules: true, coggins: true } }));
    }
    assert.deepEqual(results.map((r) => r.status), [201, 201, 429, 429]);
    await t.ctx.bookings.expireHolds(Date.now() + 3600e3);
  });

  test('#5 camera relay caps response size and requests in flight', async () => {
    const guest = 'viewer@example.com';
    const c = client(t.base);
    const stall = t.db.prepare("SELECT id FROM units WHERE kind = 'stall' AND number = 8").get();
    const { seal } = await import('../src/security/secretbox.js');
    const ins = t.db.prepare("INSERT INTO cameras (public_id, name, source_type, source_url) VALUES (?, 'Relay cam', 'hls', ?)")
      .run(randomToken(12), seal(`http://127.0.0.1:${upstreamPort}/stall8/index.m3u8`));
    t.db.prepare('INSERT INTO camera_units (camera_id, unit_id) VALUES (?, ?)').run(ins.lastInsertRowid, stall.id);
    const pid = t.db.prepare('SELECT public_id FROM cameras WHERE id = ?').get(ins.lastInsertRowid).public_id;
    t.cfg.cameraAccess.hoursBeforeCheckIn = 30; // make the stay live now whatever the time of day
    const { setupToken } = await bookAndPay(t, c, futureStay(t.cfg, { inDays: 0, stalls: 8 }), guest);
    await c.post('/api/auth/set-password', { token: setupToken, password: PW });
    const pl = await c.get(`/api/cameras/${pid}/hls/index.m3u8`);
    assert.equal(pl.status, 200);
    assert.match(pl.data, /seg1\.mp4/);
    const big = await c.get(`/api/cameras/${pid}/hls/big.mp4`);
    assert.equal(big.status, 502, 'a 40 MB segment is refused');
    const burst = await Promise.all(Array.from({ length: 10 }, () => c.get(`/api/cameras/${pid}/hls/slow.mp4`)));
    // identical segment requests share one upstream fetch through the cache
    assert.ok(burst.every((r) => r.status === 200));
    const distinct = await Promise.all(Array.from({ length: 10 }, (_, i) => c.get(`/api/cameras/${pid}/hls/s${i}-slow.mp4`)));
    assert.ok(distinct.some((r) => r.status === 429), 'more than a few requests in flight are refused');
    t.cfg.cameraAccess.hoursBeforeCheckIn = 3;
  });

  test('#6 a replayed payment cannot revive a cancelled booking', async () => {
    const c = client(t.base);
    const r = await c.post('/api/bookings', { stay: futureStay(t.cfg, { inDays: 200 }), contact: contact('refund@example.com'), agree: { rules: true, coggins: true } });
    const tok = new URL(r.data.checkoutUrl).searchParams.get('t');
    await c.post('/api/dev/mock-pay', { ref: r.data.ref, t: tok });
    const b = t.db.prepare('SELECT * FROM bookings WHERE ref = ?').get(r.data.ref);
    t.ctx.bookings.cancel(b.id, { reason: 'refund' });
    const again = await t.ctx.bookings.confirmPaid(r.data.ref, { amountPaid: b.amount_cents, currency: b.currency });
    assert.equal(again, 'already');
    assert.equal(t.db.prepare('SELECT status FROM bookings WHERE id = ?').get(b.id).status, 'cancelled');
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM allocations WHERE booking_id = ?').get(b.id).n, 0);
  });

  test('#8 back-to-back guests on one stall never overlap', async () => {
    const stall = t.db.prepare("SELECT id FROM units WHERE kind = 'stall' AND number = 1").get();
    const cam = t.db.prepare("INSERT INTO cameras (public_id, name, source_type) VALUES (?, 'Stall 1 cam', 'demo')").run(randomToken(12));
    t.db.prepare('INSERT INTO camera_units (camera_id, unit_id) VALUES (?, ?)').run(cam.lastInsertRowid, stall.id);
    const first = futureStay(t.cfg, { inDays: 300, nights: 2 });
    const second = { ...first, checkIn: first.checkOut, checkOut: addDays(first.checkOut, 2) };
    await bookAndPay(t, client(t.base), first, 'first@example.com');
    await bookAndPay(t, client(t.base), second, 'second@example.com');
    const uid = (e) => t.db.prepare('SELECT id FROM users WHERE email = ?').get(e).id;
    const far = Date.parse(first.checkIn) - 86400e3;
    const a = t.ctx.cameras.camerasForUser(uid('first@example.com'), far).find((x) => x.name === 'Stall 1 cam');
    const b = t.ctx.cameras.camerasForUser(uid('second@example.com'), far).find((x) => x.name === 'Stall 1 cam');
    assert.ok(a && b);
    assert.ok(a.liveUntil <= b.liveFrom, 'the first guest’s view ends before the next guest’s starts');
  });

  test('#9 a failed late re-allocation leaves nothing held', async () => {
    const stay = futureStay(t.cfg, { inDays: 250, house: true, guests: 2, stalls: 8 });
    const c = client(t.base);
    const r = await c.post('/api/bookings', { stay, contact: contact('late@example.com'), agree: { rules: true, coggins: true } });
    const b = t.db.prepare('SELECT * FROM bookings WHERE ref = ?').get(r.data.ref);
    t.ctx.bookings.expireNow(r.data.ref);
    // Someone else takes one stall; the house is still free.
    const other = await client(t.base).post('/api/bookings', { stay: { ...stay, house: false, guests: 0, stalls: 1 }, contact: contact('other@example.com'), agree: { rules: true, coggins: true } });
    assert.equal(other.status, 201);
    const out = await t.ctx.bookings.confirmPaid(r.data.ref, { amountPaid: b.amount_cents, currency: b.currency });
    assert.equal(out, 'attention');
    assert.equal(t.db.prepare('SELECT COUNT(*) AS n FROM allocations WHERE booking_id = ?').get(b.id).n, 0);
    await t.ctx.bookings.expireHolds(Date.now() + 3600e3);
  });

  test('#11 camera addresses must be on the allow-list', () => {
    assert.throws(() => t.ctx.cameras.checkSourceUrl('http://169.254.169.254/latest/x.m3u8', 'hls'), /must be one of/);
    assert.ok(t.ctx.cameras.checkSourceUrl(`http://127.0.0.1:${upstreamPort}/a/index.m3u8`, 'hls'));
  });

  test('#12 changing the password kills outstanding reset links', async () => {
    await makeUser(t, 'links@example.com');
    const c = client(t.base);
    await c.post('/api/auth/forgot', { email: 'links@example.com' });
    const token = t.mailer.outbox.at(-1).text.match(/#token=([A-Za-z0-9_-]+)/)[1];
    await c.post('/api/auth/login', { email: 'links@example.com', password: PW });
    assert.equal((await c.post('/api/account/password', { current: PW, next: 'an entirely new passphrase' })).status, 200);
    assert.equal((await client(t.base).post('/api/auth/token-info', { token })).status, 404);
  });

  test('#13 2-step secrets and camera addresses are encrypted at rest', async () => {
    const row = t.db.prepare("SELECT totp_secret FROM users WHERE email = 'mfa@example.com'").get();
    assert.match(row.totp_secret, /^enc:v1:/);
    const cam = t.db.prepare("SELECT source_url FROM cameras WHERE name = 'Relay cam'").get();
    assert.match(cam.source_url, /^enc:v1:/);
    assert.ok(!cam.source_url.includes('127.0.0.1'));
  });

  test('#15 admin blocks are bounded', async () => {
    const secret = await makeUser(t, 'boss@example.com', { role: 'admin', totp: true });
    const c = client(t.base);
    const login = await c.post('/api/auth/login', { email: 'boss@example.com', password: PW });
    await c.post('/api/auth/mfa', { challenge: login.data.challenge, code: _codeAt(secret, nowStep() + 1) });
    const house = t.db.prepare("SELECT id FROM units WHERE kind = 'house'").get().id;
    const r = await c.post('/api/admin/blocks', { checkIn: futureStay(t.cfg).checkIn, checkOut: '9999-12-31', unitIds: [house] });
    assert.equal(r.status, 400);
  });

  test('hold limits are the documented ones', () => {
    assert.deepEqual(HOLD_LIMITS, { perNetwork: 2, perEmail: 2, total: 20 });
  });
});

describe('#10 / #11 / #14 configuration fails closed', () => {
  test('test payments only on localhost over http', () => {
    assert.throws(() => buildConfig({ NODE_ENV: 'development', PAYMENTS_MODE: 'mock', APP_ORIGIN: 'https://book.example.com' }), /Test payments/);
    assert.throws(() => buildConfig({ NODE_ENV: 'development', PAYMENTS_MODE: 'mock', HOST: '0.0.0.0' }), /Test payments/);
  });
  test('numbers are validated', () => {
    assert.throws(() => buildConfig({ NODE_ENV: 'test', TRUST_PROXY: 'true' }), /TRUST_PROXY/);
    assert.throws(() => buildConfig({ NODE_ENV: 'test', SESSION_IDLE_MINUTES: 'forever' }), /SESSION_IDLE_MINUTES/);
  });
  test('production needs DATA_KEY and a camera allow-list', () => {
    const base = { NODE_ENV: 'production', APP_ORIGIN: 'https://x.example', PAYMENTS_MODE: 'stripe', STRIPE_SECRET_KEY: 'sk', STRIPE_WEBHOOK_SECRET: 'wh',
      SMTP_URL: 'smtps://a:b@mail.example', RANCH_CONTACT_PHONE: '501-555-0100', ADMIN_ALERT_EMAIL: 'owner@example.com' };
    assert.throws(() => buildConfig(base), /DATA_KEY[\s\S]*CAMERA_ALLOWED_HOSTS/);
    assert.doesNotThrow(() => buildConfig({ ...base, DATA_KEY: Buffer.alloc(32, 7).toString('base64'), CAMERA_ALLOWED_HOSTS: '100.64.0.10' }));
  });
});
