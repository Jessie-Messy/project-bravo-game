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
  // In development the origin follows PORT, so links and the same-origin check just work.
  const origin = (e.APP_ORIGIN || `http://localhost:${int(e.PORT, 3000)}`).replace(/\/$/, '');

  const cfg = {
    production,
    test: e.NODE_ENV === 'test',
    port: int(e.PORT, 3000),
    host: e.HOST || '127.0.0.1',
    origin,
    // Number of reverse proxies in front of the app (e.g. 1 for Caddy/nginx). Needed so
    // rate limits key on the real client IP, never trusted blindly.
    trustProxy: int(e.TRUST_PROXY, 0),
    // 32 random bytes, base64 (openssl rand -base64 32). Encrypts 2-step secrets and camera
    // addresses in the database. Required in production.
    dataKey: e.DATA_KEY || '',
    dataDir: e.DATA_DIR || path.join(ROOT, 'data'),
    cookieSecure: e.COOKIE_SECURE ? e.COOKIE_SECURE === 'true' : origin.startsWith('https://'),

    ranch: {
      name: e.RANCH_NAME || "Rockin' C Ranch",
      timezone: e.RANCH_TZ || 'America/Chicago',
      email: e.RANCH_CONTACT_EMAIL || '',
      phone: e.RANCH_CONTACT_PHONE || '',
      checkInHour: int(e.CHECK_IN_HOUR, 15),
      checkOutHour: int(e.CHECK_OUT_HOUR, 11),
      address: e.RANCH_ADDRESS || 'Lonoke, Arkansas',
      lat: e.RANCH_LAT || '34.863750',
      lng: e.RANCH_LNG || '-91.916582',
      // Shown in the hero; defaults are the listing's Airbnb rating at the time of writing.
      rating: e.RATING ?? '5.0',
      reviewCount: int(e.REVIEW_COUNT, 8),
      reviewUrl: e.REVIEW_URL ?? 'https://www.airbnb.com/rooms/1711664297060154728#reviews',
      cancellationPolicy: e.CANCELLATION_POLICY ||
        'To cancel or change a booking, contact us as soon as you can. Refunds are decided case by case, and camera access ends as soon as a booking is cancelled.',
    },

    // Airbnb (or any iCal) calendar sync. Imported events block the units listed in
    // ICAL_BLOCKS ("house" by default); our own bookings are published at
    // /calendar/<ICAL_EXPORT_TOKEN>.ics for Airbnb to import.
    ical: {
      importUrls: (e.ICAL_IMPORT_URLS || '').split(/[\s,]+/).filter(Boolean),
      blocks: (e.ICAL_BLOCKS || 'house').split(',').map((x) => x.trim()).filter(Boolean),
      exportToken: e.ICAL_EXPORT_TOKEN || '',
      syncMinutes: int(e.ICAL_SYNC_MINUTES, 30),
    },

    inventory: {
      stalls: int(e.STALL_COUNT, 8),
      rvSites: int(e.RV_SITE_COUNT, 6),
      // The first N RV sites also have a sewer connection ("full hookup").
      rvSewerSites: int(e.RV_SEWER_SITES, 2),
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
      rvSewerNight: int(e.PRICE_RV_SEWER_NIGHT_CENTS, 5500),
      // Optional tax added to the total (e.g. state + local lodging tax), in basis points:
      // 1150 = 11.5%. 0 = no tax line.
      taxBasisPoints: int(e.TAX_BASIS_POINTS, 0),
      taxLabel: e.TAX_LABEL || 'Taxes',
      houseCleaning: int(e.PRICE_HOUSE_CLEANING_CENTS, 7500),
      stallCleaning: int(e.PRICE_STALL_CLEANING_CENTS, 1000),
    },

    // Guests can watch their stalls from this many hours before check-in time until this
    // many hours after check-out time.
    cameraAccess: {
      hoursBeforeCheckIn: int(e.CAMERA_HOURS_BEFORE_CHECKIN, 3),
      hoursAfterCheckOut: int(e.CAMERA_HOURS_AFTER_CHECKOUT, 2),
      // Hosts the server may fetch camera video from. Required in production.
      allowedHosts: (e.CAMERA_ALLOWED_HOSTS || '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean),
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

    // Per-IP request limits. Only the test suite changes these (everything there comes
    // from 127.0.0.1); the per-account lockout is what really stops password guessing.
    rateLimits: {
      authPer15Min: int(e.RATE_AUTH_PER_15MIN, 30),
      accountPer15Min: int(e.RATE_ACCOUNT_PER_15MIN, 20),
      bookingsPerHour: int(e.RATE_BOOKINGS_PER_HOUR, 15),
      apiPerMinute: int(e.RATE_API_PER_MINUTE, 300),
    },

    auth: {
      maxFailedLogins: 5,   // per lock step; each further 5 failures doubles the lock
      lockMinutes: 15,
      maxLockHours: 24,
      setupTokenHours: 72,
      resetTokenMinutes: 30,
    },
  };

  validate(cfg);
  return cfg;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

function validate(cfg) {
  const problems = [];
  const numbers = {
    PORT: [cfg.port, 1, 65535], TRUST_PROXY: [cfg.trustProxy, 0, 5],
    CHECK_IN_HOUR: [cfg.ranch.checkInHour, 0, 23], CHECK_OUT_HOUR: [cfg.ranch.checkOutHour, 0, 23],
    STALL_COUNT: [cfg.inventory.stalls, 0, 100], RV_SITE_COUNT: [cfg.inventory.rvSites, 0, 100],
    RV_SEWER_SITES: [cfg.inventory.rvSewerSites, 0, cfg.inventory.rvSites], TAX_BASIS_POINTS: [cfg.pricing.taxBasisPoints, 0, 5000],
    REVIEW_COUNT: [cfg.ranch.reviewCount, 0, 100000], ICAL_SYNC_MINUTES: [cfg.ical.syncMinutes, 5, 1440],
    HOUSE_MAX_GUESTS: [cfg.inventory.maxGuests, 1, 50], MAX_NIGHTS: [cfg.inventory.maxNights, 1, 90],
    BOOKING_WINDOW_DAYS: [cfg.inventory.bookingWindowDays, 1, 730],
    CAMERA_HOURS_BEFORE_CHECKIN: [cfg.cameraAccess.hoursBeforeCheckIn, 0, 48],
    CAMERA_HOURS_AFTER_CHECKOUT: [cfg.cameraAccess.hoursAfterCheckOut, 0, 48],
    SESSION_IDLE_MINUTES: [cfg.session.idleMinutes, 5, 1440], SESSION_ABSOLUTE_HOURS: [cfg.session.absoluteHours, 1, 720],
  };
  for (const [name, [v, lo, hi]] of Object.entries(numbers)) {
    if (!Number.isInteger(v) || v < lo || v > hi) problems.push(`${name} must be a whole number from ${lo} to ${hi}`);
  }
  if (cfg.dataKey && Buffer.from(cfg.dataKey, 'base64').length !== 32) problems.push('DATA_KEY must be 32 random bytes, base64 (openssl rand -base64 32)');
  // Test payments confirm bookings for free, so they only ever run on a private dev machine.
  // Behind a reverse proxy (TRUST_PROXY > 0) the site is reachable by others, so no.
  if (cfg.payments.mode === 'mock' && !cfg.test &&
      (cfg.production || cfg.origin.startsWith('https://') || !LOOPBACK.has(cfg.host) || cfg.trustProxy > 0 ||
       !/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(cfg.origin))) {
    problems.push('Test payments (PAYMENTS_MODE=mock) only run on localhost over http. Set STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET.');
  }
  if (cfg.production) {
    if (!cfg.origin.startsWith('https://')) problems.push('APP_ORIGIN must be https:// in production');
    if (!cfg.cookieSecure) problems.push('COOKIE_SECURE cannot be false in production');
    if (cfg.payments.mode !== 'stripe') problems.push('PAYMENTS_MODE must be "stripe" in production');
    if (!cfg.payments.stripeSecretKey) problems.push('STRIPE_SECRET_KEY is required');
    if (!cfg.payments.stripeWebhookSecret) problems.push('STRIPE_WEBHOOK_SECRET is required');
    if (!cfg.mail.smtpUrl) problems.push('SMTP_URL is required (guests are onboarded by email)');
    if (!cfg.dataKey) problems.push('DATA_KEY is required (openssl rand -base64 32)');
    if (!cfg.cameraAccess.allowedHosts.length) problems.push('CAMERA_ALLOWED_HOSTS is required (the address of your camera box)');
    if (!cfg.ranch.email && !cfg.ranch.phone) problems.push('RANCH_CONTACT_EMAIL or RANCH_CONTACT_PHONE is required (guests need a way to reach you)');
    if (!cfg.mail.adminAlertTo) problems.push('ADMIN_ALERT_EMAIL is required (that is how you hear about new bookings)');
    if (cfg.ical.exportToken && cfg.ical.exportToken.length < 24) problems.push('ICAL_EXPORT_TOKEN must be at least 24 random characters');
  }
  if (!['stripe', 'mock'].includes(cfg.payments.mode)) problems.push('PAYMENTS_MODE must be stripe or mock');
  if (cfg.payments.mode === 'stripe' && !cfg.test &&
      (!cfg.payments.stripeSecretKey || !cfg.payments.stripeWebhookSecret)) {
    problems.push('Stripe mode needs STRIPE_SECRET_KEY and STRIPE_WEBHOOK_SECRET');
  }
  try { new Intl.DateTimeFormat('en-US', { timeZone: cfg.ranch.timezone }); }
  catch { problems.push(`RANCH_TZ "${cfg.ranch.timezone}" is not a valid IANA time zone`); }
  for (const [k, v] of Object.entries(cfg.pricing)) {
    if (!['currency', 'taxLabel'].includes(k) && (!Number.isInteger(v) || v < 0)) problems.push(`price ${k} must be a whole number of cents`);
  }
  for (const u of cfg.ical.importUrls) {
    try { if (new URL(u).protocol !== 'https:') problems.push('ICAL_IMPORT_URLS must be https:// addresses'); }
    catch { problems.push(`ICAL_IMPORT_URLS has an invalid address: ${u.slice(0, 40)}`); }
  }
  if (problems.length) {
    throw new Error('Refusing to start with an unsafe configuration:\n  - ' + problems.join('\n  - '));
  }
}
