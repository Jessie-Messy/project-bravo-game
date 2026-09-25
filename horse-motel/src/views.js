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
    return `<li${wide} data-group="${esc(p.group)}"><button type="button" data-index="${i}" aria-label="View larger: ${esc(p.alt)}">` +
      `<img src="/img/${p.slug}-960.webp" srcset="${srcset}" sizes="(max-width: 600px) 100vw, (max-width: 1100px) 50vw, 400px" ` +
      `alt="" loading="lazy" decoding="async" width="960" height="${Math.round(960 / p.ratio)}">` +
      `<span class="tag" aria-hidden="true">${esc(p.group)}</span></button></li>`;
  }).join('\n');
}

export function createRenderer(cfg) {
  const cache = new Map();
  const partial = (name) => fs.readFileSync(path.join(ROOT, 'views', 'partials', `${name}.html`), 'utf8');

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
      .replaceAll('{{ranch}}', esc(cfg.ranch.name))
      .replaceAll('{{v}}', assetVersion());
    cache.set(route, html);
    return html;
  }
  return { render };
}
