import { buildConfig } from '../src/config.js';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { createMailer } from '../src/services/mailer.js';
import { createPayments } from '../src/services/payments.js';
import { addDays, todayIn } from '../src/dates.js';

process.env.NODE_ENV = 'test';

export async function startServer(overrides = {}, { payments: paymentsOverride } = {}) {
  const cfg = buildConfig({ NODE_ENV: 'test', PAYMENTS_MODE: 'mock', APP_ORIGIN: 'http://localhost:0', ...overrides });
  const db = openDb(cfg, { memory: true });
  const mailer = createMailer(cfg);
  const payments = paymentsOverride || createPayments(cfg);
  const { app, ctx } = createApp({ cfg, db, payments, mailer });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  cfg.origin = base; // requests must come from our own origin
  return { cfg, db, mailer, ctx, base, close: () => new Promise((r) => server.close(r)) };
}

// A minimal browser: keeps cookies, sends Origin and the CSRF token like the real site.
export function client(base, { origin = base } = {}) {
  const jar = new Map();
  let csrf = null;
  async function req(method, path, body, extraHeaders = {}) {
    const headers = { Origin: origin, ...extraHeaders };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (jar.size) headers.Cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    if (csrf && !('X-CSRF-Token' in extraHeaders)) headers['X-CSRF-Token'] = csrf;
    const res = await fetch(base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual' });
    for (const c of res.headers.getSetCookie()) {
      const [pair, ...attrs] = c.split(';');
      const [k, v] = pair.split('=');
      if (attrs.some((a) => /max-age=0/i.test(a.trim())) || v === '') jar.delete(k.trim());
      else jar.set(k.trim(), v.trim());
    }
    let data = null;
    const text = await res.text();
    try { data = JSON.parse(text); } catch { data = text; }
    if (data && data.csrf) csrf = data.csrf;
    return { status: res.status, data, headers: res.headers };
  }
  return {
    get: (p, h) => req('GET', p, undefined, h),
    post: (p, b, h) => req('POST', p, b, h),
    put: (p, b, h) => req('PUT', p, b, h),
    del: (p, h) => req('DELETE', p, undefined, h),
    async refreshCsrf() { const r = await req('GET', '/api/auth/session'); csrf = r.data.csrf; return r.data; },
    jar,
    setCsrf(t) { csrf = t; },
  };
}

export function futureStay(cfg, { inDays = 10, nights = 2, ...rest } = {}) {
  const checkIn = addDays(todayIn(cfg.ranch.timezone), inDays);
  return { checkIn, checkOut: addDays(checkIn, nights), house: false, stalls: 1, rvSites: 0, guests: 0, ...rest };
}

export const contact = (email = 'rider@example.com') => ({ name: 'Casey Rider', email, phone: '501-555-0100', notes: '' });

// Books and pays (mock) and returns the setup token from the welcome email.
export async function bookAndPay(t, c, stay, email = 'rider@example.com') {
  const r = await c.post('/api/bookings', { stay, contact: contact(email), agree: { rules: true, coggins: true } });
  if (r.status !== 201) throw new Error(`booking failed: ${r.status} ${JSON.stringify(r.data)}`);
  const u = new URL(r.data.checkoutUrl);
  const pay = await c.post('/api/dev/mock-pay', { ref: u.searchParams.get('ref'), t: u.searchParams.get('t') });
  if (pay.status !== 200) throw new Error('pay failed');
  const mail = t.mailer.outbox.at(-1);
  const m = mail?.text.match(/#token=([A-Za-z0-9_-]+)/);
  return { ref: r.data.ref, statusToken: u.searchParams.get('t'), setupToken: m ? m[1] : null, mail };
}
