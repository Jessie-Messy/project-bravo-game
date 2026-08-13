// Headless rig for Project Bravo — boots the real game in Chromium so a test can
// drive it through window._dev.
//
//   node tools/check_client.mjs        (needs playwright + a static server on 5173)
//
// CDN modules are mirrored to a local cache via curl (which honours HTTPS_PROXY)
// and served through page.route, so the browser itself needs no proxy at all.
//
// ⚠ Playwright is NOT a repo dependency — this is a dev tool, and pinning a
// browser automation stack into a game repo for a handful of checks is not worth
// it. Set PLAYWRIGHT_PATH if it is not resolvable by name.
import { execFileSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

let chromium;
try {
  ({ chromium } = await import(process.env.PLAYWRIGHT_PATH || 'playwright'));
} catch (e) {
  console.error('playwright not found. Install it (npm i -D playwright) or set PLAYWRIGHT_PATH\n' +
                'to its index.mjs. This rig is a dev tool and is deliberately not a repo dependency.');
  process.exit(2);
}

// Cache CDN mirrors beside the repo, not in a hardcoded scratchpad.
const HERE = path.join(path.dirname(fileURLToPath(import.meta.url)), '.rig-cache');
const CACHE = HERE;
fs.mkdirSync(CACHE, { recursive: true });

function mirror(url) {
  const file = path.join(CACHE, url.replace(/^https?:\/\//, '').replace(/[^\w.\-/]/g, '_').replace(/\//g, '__'));
  if (!fs.existsSync(file)) {
    execFileSync('curl', ['-sSL', '--max-time', '60', '-o', file, url], { stdio: ['ignore', 'ignore', 'pipe'] });
  }
  return fs.readFileSync(file);
}

export async function withGame(fn, opts = {}) {
  const browser = await chromium.launch({
    executablePath: '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader',
           '--ignore-gpu-blocklist', '--no-sandbox'],
  });
  const page = await browser.newPage({ viewport: opts.viewport || { width: 1280, height: 800 } });
  const errors = [], logs = [];
  page.on('console', m => { logs.push(m.type() + ': ' + m.text()); });
  page.on('pageerror', e => errors.push('PAGEERROR: ' + (e.message || e)));
  page.on('requestfailed', r => {
    const u = r.url();
    if (!/colyseus|ws:|wss:/.test(u)) errors.push(`FAILED ${r.failure()?.errorText} ${u.slice(0, 140)}`);
  });

  const mirrorRoute = async route => {
    const url = route.request().url();
    try {
      const body = mirror(url);
      const ct = /\.wasm(\?|$)/.test(url) ? 'application/wasm'
               : /\.json(\?|$)/.test(url) ? 'application/json'
               : 'application/javascript; charset=utf-8';
      route.fulfill({ status: 200, contentType: ct, body });
    } catch (e) { route.abort(); }
  };
  await page.route('**://cdn.jsdelivr.net/**', mirrorRoute);
  await page.route('**://www.gstatic.com/**', mirrorRoute);

  // ?mp=off so the account gate never prompts: ensureAccount() returns 'offline'
// immediately when multiplayer is disabled. Without this the login overlay
// blocks boot and every art shot is a picture of the login form.
await page.goto('http://localhost:5173/medieval_prototype.html?mp=off#headless', { waitUntil: 'load', timeout: 60000 });
  let ready = false;
  try { await page.waitForFunction(() => !!window._dev, null, { timeout: 120000 }); ready = true; } catch (_) {}

  // Boot lands on the character-select overlay with the How-To-Play panel open.
  // Both are just flags over an already-simulating world; clear them so what we
  // screenshot is the world and not a UI panel. (Measuring the overlay by
  // mistake is exactly how the first pass produced garbage numbers.)
  if (ready && opts.enterWorld !== false) {
    await page.evaluate(() => {
      const G = window._dev.G;
      G.charSelectOpen = false; G.charCreatorOpen = false;
      for (const k of Object.keys(G)) if (/Open$/.test(k) && G[k] === true) G[k] = false;
    });
    await page.waitForTimeout(400);
    const stillUp = await page.evaluate(() => {
      const G = window._dev.G;
      return Object.keys(G).filter(k => /Open$/.test(k) && G[k] === true);
    });
    if (stillUp.length) logs.push('warn: panels still open: ' + stillUp.join(','));
  }

  const result = await fn(page, { ready, errors, logs });
  await browser.close();
  return result;
}
