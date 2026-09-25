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
