// All runtime configuration comes from environment variables (see .env.example).
// The process refuses to start in production with an unsafe or incomplete config,
// because a half-configured payment or auth system fails open in the worst ways.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Minimal .env loader so there is no dotenv dependency. Real environment wins.
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trimStart().startsWith('#')) continue;
    const value = m[2].replace(/^(['"])(.*)\1$/, '$2');
    if (process.env[m[1]] === undefined) process.env[m[1]] = value;
  }
}
if (process.env.NODE_ENV !== 'test') loadDotEnv(path.join(ROOT, '.env'));

const env = process.env;
const int = (v, d) => (v === undefined || v === '' ? d : Number.parseInt(v, 10));

export function buildConfig(overrides = {}) {
  const e = { ...env, ...overrides };
  const production = e.NODE_ENV === 'production';
  const origin = (e.APP_ORIGIN || 'http://localhost:3000').replace(/\/$/, '');

  const cfg = {
    production,
    test: e.NODE_ENV === 'test',
    port: int(e.PORT, 3000),
    host: e.HOST || '127.0.0.1',
    origin,
    // Number of reverse proxies in front of the app (e.g. 1 for Caddy/nginx). Needed so
    // rate limits key on the real client IP, never trusted blindly.
    trustProxy: int(e.TRUST_PROXY, 0),
    dataDir: e.DATA_DIR || path.join(ROOT, 'data'),
    cookieSecure: e.COOKIE_SECURE ? e.COOKIE_SECURE === 'true' : origin.startsWith('https://'),

    ranch: {
      name: e.RANCH_NAME || "Rockin' C Ranch",
      timezone: e.RANCH_TZ || 'America/Chicago',
      email: e.RANCH_CONTACT_EMAIL || '',
      phone: e.RANCH_CONTACT_PHONE || '',
      checkInHour: int(e.CHECK_IN_HOUR, 15),
      checkOutHour: int(e.CHECK_OUT_HOUR, 11),
    },

    inventory: {
      stalls: int(e.STALL_COUNT, 8),
      rvSites: int(e.RV_SITE_COUNT, 6),
      maxGuests: int(e.HOUSE_MAX_GUESTS, 6),
      maxNights: int(e.MAX_NIGHTS, 28),
      bookingWindowDays: int(e.BOOKING_WINDOW_DAYS, 365),
    },

    // All prices in cents. THESE ARE PLACEHOLDERS -- set real prices in .env.
    pricing: {
      currency: (e.CURRENCY || 'usd').toLowerCase(),
      houseNight: int(e.PRICE_HOUSE_NIGHT_CENTS, 17500),
      stallNight: int(e.PRICE_STALL_NIGHT_CENTS, 3500),
      rvNight: int(e.PRICE_RV_NIGHT_CENTS, 4500),
      houseCleaning: int(e.PRICE_HOUSE_CLEANING_CENTS, 7500),
      stallCleaning: int(e.PRICE_STALL_CLEANING_CENTS, 1000),
    },

    // Guests can watch their stalls from this many hours before check-in time until this
    // many hours after check-out time.
    cameraAccess: {
      hoursBeforeCheckIn: int(e.CAMERA_HOURS_BEFORE_CHECKIN, 3),
      hoursAfterCheckOut: int(e.CAMERA_HOURS_AFTER_CHECKOUT, 2),
    },

    payments: {
      // 'stripe' in production. 'mock' is a local-development stand-in that confirms a
      // booking without taking money; it is refused outright in production.
      mode: e.PAYMENTS_MODE || (e.STRIPE_SECRET_KEY ? 'stripe' : 'mock'),
      stripeSecretKey: e.STRIPE_SECRET_KEY || '',
      stripeWebhookSecret: e.STRIPE_WEBHOOK_SECRET || '',
      holdMinutes: 30, // Stripe's minimum Checkout expiry; the hold lasts slightly longer.
    },

    mail: {
      from: e.MAIL_FROM || "Rockin' C Ranch <no-reply@localhost>",
      smtpUrl: e.SMTP_URL || '',
      adminAlertTo: e.ADMIN_ALERT_EMAIL || '',
    },

    session: {
      idleMinutes: int(e.SESSION_IDLE_MINUTES, 120),
      absoluteHours: int(e.SESSION_ABSOLUTE_HOURS, 24 * 7),
    },

    auth: {
      maxFailedLogins: 5,
      lockMinutes: 15,
      setupTokenHours: 72,
      resetTokenMinutes: 30,
    },
  };

  validate(cfg);
  return cfg;
}

function validate(cfg) {
  const problems = [];
  if (cfg.production) {
    if (!cfg.origin.startsWith('https://')) problems.push('APP_ORIGIN must be https:// in production');
    if (!cfg.cookieSecure) problems.push('COOKIE_SECURE cannot be false in production');
    if (cfg.payments.mode !== 'stripe') problems.push('PAYMENTS_MODE must be "stripe" in production');
    if (!cfg.payments.stripeSecretKey) problems.push('STRIPE_SECRET_KEY is required');
    if (!cfg.payments.stripeWebhookSecret) problems.push('STRIPE_WEBHOOK_SECRET is required');
    if (!cfg.mail.smtpUrl) problems.push('SMTP_URL is required (guests are onboarded by email)');
  }
  if (!['stripe', 'mock'].includes(cfg.payments.mode)) problems.push('PAYMENTS_MODE must be stripe or mock');
  if (cfg.payments.mode === 'stripe' && !cfg.test &&
      (!cfg.payments.stripeSecretKey || !cfg.payments.stripeWebhookSecret)) {
    problems.push('Stripe mode needs STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET');
  }
  try { new Intl.DateTimeFormat('en-US', { timeZone: cfg.ranch.timezone }); }
  catch { problems.push(`RANCH_TZ "${cfg.ranch.timezone}" is not a valid IANA time zone`); }
  for (const [k, v] of Object.entries(cfg.pricing)) {
    if (k !== 'currency' && (!Number.isInteger(v) || v < 0)) problems.push(`price ${k} must be a whole number of cents`);
  }
  if (problems.length) {
    throw new Error('Refusing to start with an unsafe configuration:\n  - ' + problems.join('\n  - '));
  }
}
