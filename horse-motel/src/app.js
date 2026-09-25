import express from 'express';
import helmet from 'helmet';
import path from 'node:path';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { ROOT } from './config.js';
import { sessionMiddleware, csrfMiddleware } from './security/sessions.js';
import { inventoryService, BookingError } from './services/inventory.js';
import { HashBusyError } from './security/password.js';
import { initSecretBox } from './security/secretbox.js';
import { bookingService } from './services/bookings.js';
import { cameraService } from './services/cameras.js';
import { icalService } from './services/ical.js';
import { safeEqual } from './security/crypto.js';
import { publicRoutes, webhookRoute } from './routes/public.js';
import { authRoutes } from './routes/auth.js';
import { accountRoutes } from './routes/account.js';
import { cameraRoutes } from './routes/cameras.js';
import { adminRoutes } from './routes/admin.js';
import { createRenderer, PAGES } from './views.js';

export function createApp({ cfg, db, payments, mailer }) {
  initSecretBox(cfg);
  const inventory = inventoryService(db, cfg);
  const cameras = cameraService({ db, cfg });
  const bookings = bookingService({ db, cfg, inventory, payments, mailer, cameras });
  const ical = icalService({ db, cfg, bookings, mailer });
  const ctx = { cfg, db, payments, mailer, inventory, bookings, cameras, ical };

  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', cfg.trustProxy);
  app.set('query parser', 'simple');

  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'"],
        imgSrc: ["'self'", 'data:', 'blob:'],
        mediaSrc: ["'self'", 'blob:'],
        fontSrc: ["'self'"],
        connectSrc: ["'self'"],
        workerSrc: ["'self'", 'blob:'],
        manifestSrc: ["'self'"],
        frameSrc: ["'none'"],
        frameAncestors: ["'none'"],
        formAction: ["'self'"],
        baseUri: ["'none'"],
        objectSrc: ["'none'"],
        ...(cfg.production ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    crossOriginEmbedderPolicy: false,
    strictTransportSecurity: cfg.production ? { maxAge: 63072000, includeSubDomains: true, preload: false } : false,
    referrerPolicy: { policy: 'no-referrer' },
  }));
  app.use((req, res, next) => {
    res.set('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()');
    next();
  });

  // Stripe needs the raw body to check its signature, so this route comes before JSON parsing.
  app.use('/api/webhooks', webhookRoute(ctx));

  const apiLimiter = rateLimit({ windowMs: 60e3, limit: cfg.rateLimits.apiPerMinute, standardHeaders: 'draft-7', legacyHeaders: false,
    skip: (req) => req.path.startsWith('/cameras/') });
  app.use('/api', apiLimiter, (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
  app.use('/api', express.json({ limit: '20kb', strict: true }));
  app.use(sessionMiddleware(db, cfg));
  app.use('/api', csrfMiddleware(cfg));

  app.use('/api', publicRoutes(ctx));
  app.use('/api/auth', authRoutes(ctx));
  app.use('/api/account', accountRoutes(ctx));
  app.use('/api/cameras', cameraRoutes(ctx));
  app.use('/api/admin', adminRoutes(ctx));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found.' }));

  app.get('/robots.txt', (req, res) => res.type('text').send(
    `User-agent: *\nDisallow: /api/\nDisallow: /account\nDisallow: /admin\nDisallow: /setup\nDisallow: /booking\nDisallow: /calendar/\nSitemap: ${cfg.origin}/sitemap.xml\n`));
  app.get('/sitemap.xml', (req, res) => res.type('application/xml').send(
    `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${['/', '/policies']
      .map((p) => `<url><loc>${cfg.origin}${p}</loc></url>`).join('')}</urlset>\n`));
  // Lets guests add the site to their home screen and open their stall cameras like an app.
  app.get('/manifest.webmanifest', (req, res) => res.type('application/manifest+json').json({
    name: cfg.ranch.name, short_name: 'Stall cams', start_url: '/account', display: 'standalone',
    background_color: '#fbf7f1', theme_color: '#7a3e14',
    icons: [{ src: '/img/icon-192.png', sizes: '192x192', type: 'image/png' }, { src: '/img/icon-512.png', sizes: '512x512', type: 'image/png' }],
  }));

  // Calendar feed for Airbnb to import (secret URL; no guest details inside).
  app.get('/calendar/:file', (req, res) => {
    const token = req.params.file.replace(/\.ics$/, '');
    if (!cfg.ical.exportToken || !safeEqual(token, cfg.ical.exportToken)) return res.status(404).type('text').send('Not found');
    res.set('Cache-Control', 'no-store').type('text/calendar; charset=utf-8').send(ical.exportIcs());
  });

  // Pages (server-side includes), then static assets. The mock checkout page only
  // exists in local development.
  const views = createRenderer(cfg);
  const sendPage = (res, route, status = 200) => {
    res.status(status).set('Cache-Control', 'no-cache').type('html').send(views.render(route));
  };
  for (const [route, page] of Object.entries(PAGES)) {
    if (route === '/404') continue;
    app.get(route === '/' ? ['/', '/index.html'] : [route, `${route}.html`], (req, res) => {
      if (page.devOnly && payments.mode !== 'mock') return sendPage(res, '/404', 404);
      sendPage(res, route);
    });
  }
  app.use(express.static(path.join(ROOT, 'public'), {
    index: false,
    dotfiles: 'ignore',
    setHeaders(res, file) {
      if (/[\\/](img|fonts|vendor)[\\/]/.test(file)) res.set('Cache-Control', 'public, max-age=604800');
      else res.set('Cache-Control', 'no-cache');
    },
  }));
  app.use((req, res) => sendPage(res, '/404', 404));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof z.ZodError) {
      const issue = err.issues[0];
      const field = issue.path.join('.');
      return res.status(400).json({ error: friendlyIssue(issue), field });
    }
    if (err instanceof BookingError) return res.status(err.status).json({ error: err.message });
    if (err instanceof HashBusyError) {
      return res.status(503).set('Retry-After', '10').json({ error: 'We’re very busy right now. Please try again in a few seconds.' });
    }
    if (err.type === 'entity.too.large') return res.status(413).json({ error: 'Request too large.' });
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed request.' });
    console.error('[error]', req.method, req.path, err);
    res.status(500).json({ error: 'Something went wrong on our side. Please try again.' });
  });

  return { app, ctx };
}

// Zod's built-in messages ("Too big: expected number to be <=8") are for developers; the
// schemas carry their own wording where it matters, and this covers the rest.
function friendlyIssue(issue) {
  if (!/^(Too big|Too small|Invalid|Unrecognized)/.test(issue.message)) return issue.message;
  const key = String(issue.path.at(-1) ?? 'value');
  const label = key.replace(/([A-Z])/g, ' $1').toLowerCase();
  switch (issue.code) {
    case 'too_big': return issue.origin === 'string' ? `The ${label} is too long.` : `The ${label} can be at most ${issue.maximum}.`;
    case 'too_small': return issue.origin === 'string' ? `Please fill in the ${label}.` : `The ${label} must be at least ${issue.minimum}.`;
    case 'invalid_type': return `Please fill in the ${label}.`;
    case 'invalid_format': return issue.format === 'email' ? 'Enter a valid email address.' : `The ${label} isn’t in the right format.`;
    case 'unrecognized_keys': return 'The request had unexpected fields. Reload the page and try again.';
    default: return `Please check the ${label}.`;
  }
}
