// Tiny server-side include renderer: every page shares one head/header/footer, and
// the photo gallery is rendered into the home page as real HTML (so it works without
// JavaScript and is indexable). Pages are rendered once and cached.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROOT } from './config.js';
import { IMAGE_WIDTHS } from './photos.js';

const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const PAGES = {
  '/': { file: 'index.html' },
  '/login': { file: 'login.html', nav: 'login' },
  '/forgot': { file: 'forgot.html', nav: 'login' },
  '/setup': { file: 'setup.html' },
  '/account': { file: 'account.html', nav: 'account' },
  '/admin': { file: 'admin.html', nav: 'admin' },
  '/booking': { file: 'booking.html' },
  '/policies': { file: 'policies.html' },
  '/dev-checkout': { file: 'dev-checkout.html', devOnly: true },
  '/404': { file: '404.html' },
};

function assetVersion() {
  const h = crypto.createHash('sha256');
  for (const dir of ['public/css', 'public/js']) {
    const full = path.join(ROOT, dir);
    for (const f of fs.readdirSync(full).sort()) h.update(f + fs.statSync(path.join(full, f)).mtimeMs);
  }
  return h.digest('hex').slice(0, 10);
}

function galleryHtml() {
  const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'img', 'manifest.json'), 'utf8'));
  return manifest.map((p, i) => {
    const srcset = IMAGE_WIDTHS.map((w) => `/img/${p.slug}-${w}.webp ${w}w`).join(', ');
    const wide = i === 0 || i === 2 ? ' class="wide"' : '';
    // The accessible name starts with the visible tag ("Barn"), so voice users can say it.
    return `<li${wide} data-group="${esc(p.group)}"><button type="button" data-index="${i}" data-alt="${esc(p.alt)}" aria-label="${esc(p.group)}: ${esc(p.alt)}. View larger">` +
      `<img src="/img/${p.slug}-960.webp" srcset="${srcset}" sizes="(max-width: 600px) 100vw, (max-width: 1100px) 50vw, 400px" ` +
      `alt="" loading="lazy" decoding="async" width="960" height="${Math.round(960 / p.ratio)}">` +
      `<span class="tag" aria-hidden="true">${esc(p.group)}</span></button></li>`;
  }).join('\n');
}

export function createRenderer(cfg) {
  const cache = new Map();
  const partial = (name) => fs.readFileSync(path.join(ROOT, 'views', 'partials', `${name}.html`), 'utf8');

  const hour = (h) => `${((h + 11) % 12) + 1}:00 ${h >= 12 ? 'PM' : 'AM'}`;
  const money = (c) => `$${(c / 100).toFixed(c % 100 ? 2 : 0)}`;

  // Plain-text values used across pages, so copy always matches the configuration.
  function vars() {
    const r = cfg.ranch, inv = cfg.inventory, p = cfg.pricing, cam = cfg.cameraAccess;
    return {
      ranch: r.name, origin: cfg.origin, checkInTime: hour(r.checkInHour), checkOutTime: hour(r.checkOutHour),
      stallCount: inv.stalls, rvCount: inv.rvSites, sewerCount: inv.rvSewerSites, maxGuests: inv.maxGuests,
      maxNights: inv.maxNights, camBefore: cam.hoursBeforeCheckIn, camAfter: cam.hoursAfterCheckOut,
      fromPrice: money(Math.min(...[p.stallNight, p.rvNight, p.houseNight].filter((x) => x > 0))),
      address: r.address, lat: r.lat, lng: r.lng, cancellationPolicy: r.cancellationPolicy,
      coords: `${Math.abs(r.lat)}° ${r.lat >= 0 ? 'N' : 'S'}, ${Math.abs(r.lng)}° ${r.lng >= 0 ? 'E' : 'W'}`,
      rating: r.rating, reviewCount: r.reviewCount, reviewUrl: r.reviewUrl,
    };
  }

  function contactHtml() {
    const r = cfg.ranch;
    const items = [];
    if (r.phone) items.push(`<li><a href="tel:${esc(r.phone.replace(/[^\d+]/g, ''))}">${esc(r.phone)}</a></li>`);
    if (r.email) items.push(`<li><a href="mailto:${esc(r.email)}">${esc(r.email)}</a></li>`);
    if (!items.length) items.push('<li>Contact details coming soon.</li>');
    return items.join('');
  }

  function ratingHtml() {
    const r = cfg.ranch;
    if (!r.rating) return '';
    const text = `<span aria-hidden="true">★</span> ${esc(r.rating)} guest rating${r.reviewCount ? ` · ${r.reviewCount} reviews` : ''}`;
    return r.reviewUrl
      ? `<li><a href="${esc(r.reviewUrl)}" rel="noopener noreferrer" target="_blank">${text}<span class="visually-hidden"> on Airbnb (opens in a new tab)</span></a></li>`
      : `<li>${text}</li>`;
  }

  // schema.org data for search engines (a data block: not executed, so CSP-safe).
  function structuredData() {
    const r = cfg.ranch;
    const data = {
      '@context': 'https://schema.org', '@type': 'LodgingBusiness', name: r.name, url: cfg.origin,
      image: `${cfg.origin}/img/og.jpg`, address: { '@type': 'PostalAddress', addressLocality: 'Lonoke', addressRegion: 'AR', addressCountry: 'US' },
      geo: { '@type': 'GeoCoordinates', latitude: Number(r.lat), longitude: Number(r.lng) },
      checkinTime: `${String(r.checkInHour).padStart(2, '0')}:00`, checkoutTime: `${String(r.checkOutHour).padStart(2, '0')}:00`,
      petsAllowed: true, ...(r.phone ? { telephone: r.phone } : {}), ...(r.email ? { email: r.email } : {}),
      amenityFeature: ['Horse stalls', 'Horse turnouts', 'RV hookups', 'Wi-Fi', 'Full kitchen', 'Washer and dryer']
        .map((name) => ({ '@type': 'LocationFeatureSpecification', name, value: true })),
      ...(r.rating && r.reviewCount ? { aggregateRating: { '@type': 'AggregateRating', ratingValue: r.rating, reviewCount: r.reviewCount } } : {}),
    };
    return `<script type="application/ld+json">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>`;
  }

  function render(route) {
    if (cfg.production && cache.has(route)) return cache.get(route);
    const page = PAGES[route];
    let html = fs.readFileSync(path.join(ROOT, 'views', page.file), 'utf8');
    let header = partial('header');
    if (page.nav) header = header.replace(`data-nav="${page.nav}"`, `data-nav="${page.nav}" aria-current="page"`);
    html = html
      .replace('<!--#head-->', partial('head'))
      .replace('<!--#header-->', header)
      .replace('<!--#footer-->', partial('footer'))
      .replace('<!--#gallery-->', () => galleryHtml())
      .replace('<!--#contact-->', () => contactHtml())
      .replace('<!--#rating-->', () => ratingHtml())
      .replace('<!--#structured-data-->', () => structuredData());
    for (const [k, v] of Object.entries(vars())) html = html.replaceAll(`{{${k}}}`, esc(v));
    html = html.replaceAll('{{v}}', assetVersion());
    cache.set(route, html);
    return html;
  }
  return { render };
}
