import { buildConfig } from './config.js';
import { openDb } from './db.js';
import { createApp } from './app.js';
import { createPayments } from './services/payments.js';
import { createMailer } from './services/mailer.js';

const cfg = buildConfig();
const db = openDb(cfg);
const payments = createPayments(cfg);
const mailer = createMailer(cfg);
const { app, ctx } = createApp({ cfg, db, payments, mailer });

// Owner content that ships with placeholder defaults: remind, but don't block.
if (!process.env.CANCELLATION_POLICY) console.warn('[setup] CANCELLATION_POLICY is still the placeholder text. Set your real cancellation policy in .env.');
if (process.env.RATING === undefined) console.warn('[setup] The home page shows the default rating (5.0 · 8 reviews). Confirm RATING/REVIEW_COUNT/REVIEW_URL in .env, or set RATING= to hide it.');

const server = app.listen(cfg.port, cfg.host, () => {
  console.log(`${cfg.ranch.name} listening on http://${cfg.host}:${cfg.port} (public origin ${cfg.origin})`);
  if (payments.mode === 'mock') console.log('Payments are in TEST mode: no money is taken. Set STRIPE_* in .env for real payments.');
});
server.headersTimeout = 30e3;
server.requestTimeout = 60e3;

const sweep = setInterval(() => ctx.bookings.expireHolds().catch((e) => console.error('[holds]', e.message)), 60e3);
const syncCalendars = () => ctx.ical.syncImports().catch((e) => console.error('[ical]', e.message));
const calendarSync = setInterval(syncCalendars, cfg.ical.syncMinutes * 60e3);
setTimeout(syncCalendars, 5000).unref();

function shutdown() {
  clearInterval(sweep);
  clearInterval(calendarSync);
  server.close(() => { db.close(); process.exit(0); });
  setTimeout(() => process.exit(0), 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
