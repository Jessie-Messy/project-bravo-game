// Accessibility + visual check in a real browser.
//   npm run test:a11y            axe-core (WCAG 2.2 A/AA) on every page, phone and desktop,
//                                light and dark mode, plus keyboard checks on the calendar.
//   SCREENSHOTS=1 npm run test:a11y   also saves screenshots to test/a11y/report/
import { chromium } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer, client, futureStay, bookAndPay } from '../helpers.js';
import { randomToken } from '../../src/security/crypto.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const shots = process.env.SCREENSHOTS ? path.join(here, 'report') : null;
if (shots) fs.mkdirSync(shots, { recursive: true });

const t = await startServer();
// A guest with a stay that is live now, and a demo camera on their stall.
const stall = t.db.prepare("SELECT id FROM units WHERE kind = 'stall' AND number = 1").get();
const cam = t.db.prepare("INSERT INTO cameras (public_id, name, source_type) VALUES (?, 'Stall 1 camera', 'demo')").run(randomToken(12));
t.db.prepare('INSERT INTO camera_units (camera_id, unit_id) VALUES (?, ?)').run(cam.lastInsertRowid, stall.id);
const c = client(t.base);
const { setupToken } = await bookAndPay(t, c, futureStay(t.cfg, { inDays: 0, nights: 3, house: true, guests: 2 }));
const PW = 'correct horse battery staple';
await c.post('/api/auth/set-password', { token: setupToken, password: PW });
// Make the camera live regardless of the time of day the test runs.
t.cfg.cameraAccess.hoursBeforeCheckIn = 24;

const browser = await chromium.launch();
const failures = [];

const pages = [
  { path: '/', name: 'home' },
  { path: '/login', name: 'login' },
  { path: '/forgot', name: 'forgot' },
  { path: '/setup#token=invalidtokenvalue-invalidtokenvalue', name: 'setup-invalid' },
  { path: '/policies', name: 'policies' },
  { path: '/booking?ref=RC-NOPE&t=x', name: 'booking-missing' },
  { path: '/nope', name: '404' },
  { path: '/account', name: 'account', auth: true },
  { path: '/account#security', name: 'account-security', auth: true },
];
const viewports = [
  { name: 'phone', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
  { name: 'desktop', viewport: { width: 1366, height: 900 } },
];

async function login(page) {
  await page.goto(t.base + '/login');
  await page.fill('#email', 'rider@example.com');
  await page.fill('#password', PW);
  await page.click('#login-form button[type="submit"]');
  await page.waitForURL(/\/account/);
}

for (const scheme of ['light', 'dark']) {
  for (const vp of viewports) {
    const ctx = await browser.newContext({ ...vp, colorScheme: scheme, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    const consoleErrors = [];
    page.on('console', (m) => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', (e) => consoleErrors.push(e.message));
    let signedIn = false;
    for (const p of pages) {
      if (p.auth && !signedIn) { await login(page); signedIn = true; }
      await page.goto(t.base + p.path, { waitUntil: 'networkidle' });
      await page.waitForTimeout(300);
      const res = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']).analyze();
      for (const v of res.violations) {
        failures.push(`[${scheme}/${vp.name}] ${p.name}: ${v.id} (${v.impact}) — ${v.help}\n      ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join('\n      ')}`);
      }
      if (shots) {
        // Scroll through so lazy-loaded photos are in the screenshot.
        await page.evaluate(async () => {
          for (let y = 0; y < document.body.scrollHeight; y += 500) { window.scrollTo(0, y); await new Promise((r) => setTimeout(r, 40)); }
          window.scrollTo(0, 0);
        });
        await page.waitForTimeout(400);
        await page.screenshot({ path: path.join(shots, `${p.name}-${vp.name}-${scheme}.png`), fullPage: true });
      }
    }
    // The CSP must not be blocking anything we rely on.
    const cspErrors = consoleErrors.filter((e) => /Content Security Policy|Refused to/i.test(e));
    if (cspErrors.length) failures.push(`[${scheme}/${vp.name}] CSP violations: ${cspErrors.join(' | ')}`);
    const jsErrors = consoleErrors.filter((e) => !/Content Security Policy|Refused to|401|404|Failed to load resource/i.test(e));
    if (jsErrors.length) failures.push(`[${scheme}/${vp.name}] JS errors: ${jsErrors.join(' | ')}`);
    await ctx.close();
  }
}

// The phone menu opens, shows its links, and closes with Escape (on every kind of page).
{
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  for (const p of ['/', '/login', '/policies', '/booking?ref=x&t=y']) {
    await page.goto(t.base + p, { waitUntil: 'networkidle' });
    await page.locator('.menu-toggle').focus();
    await page.keyboard.press('Enter');
    const open = await page.locator('.menu-toggle').getAttribute('aria-expanded');
    const visible = await page.locator('#site-nav a[href="/#book"]').isVisible();
    if (open !== 'true' || !visible) failures.push(`menu: did not open on ${p} (aria-expanded=${open}, links visible=${visible})`);
    await page.keyboard.press('Escape');
    if (await page.locator('#site-nav').isVisible()) failures.push(`menu: Escape did not close it on ${p}`);
    const scripts = await page.evaluate(() => performance.getEntriesByType('resource').filter((r) => /common\.js/.test(r.name)).length);
    if (scripts > 1) failures.push(`common.js loaded ${scripts} times on ${p}`);
  }
  await ctx.close();
}

// Keyboard-only: pick dates on the calendar, open the gallery dialog, and close it.
{
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(t.base + '/#book', { waitUntil: 'networkidle' });
  const today = await page.locator('.day[tabindex="0"]').first();
  await today.focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(600);
  const [ci, co] = [await page.inputValue('#check-in'), await page.inputValue('#check-out')];
  if (!ci || !co || co <= ci) failures.push(`keyboard: calendar selection failed (${ci} → ${co})`);
  const quote = await page.locator('#quote').innerText();
  if (!/Total/.test(quote)) failures.push('keyboard: quote did not appear after choosing dates');
  if (shots) await page.screenshot({ path: path.join(shots, 'booking-selected-desktop.png'), fullPage: false });

  await page.locator('#gallery button').first().focus();
  await page.keyboard.press('Enter');
  const open = await page.locator('#lightbox').evaluate((d) => d.open);
  if (!open) failures.push('keyboard: gallery dialog did not open');
  await page.keyboard.press('ArrowRight');
  const count = await page.locator('#lightbox-count').innerText();
  if (!/Photo 2 of/.test(count)) failures.push(`keyboard: arrow key did not advance photo (${count})`);
  await page.keyboard.press('Escape');
  const focusedBack = await page.evaluate(() => document.activeElement?.closest('#gallery') !== null);
  if (!focusedBack) failures.push('keyboard: focus did not return to the gallery after closing the dialog');

  // Full booking with keyboard + mock payment reaches the confirmation page.
  await page.goto(t.base + '/#book', { waitUntil: 'networkidle' });
  const d = futureStay(t.cfg, { inDays: 30 });
  await page.fill('#check-in', d.checkIn); await page.dispatchEvent('#check-in', 'change');
  await page.fill('#check-out', d.checkOut); await page.dispatchEvent('#check-out', 'change');
  await page.fill('#name', 'Pat Keyboard');
  await page.fill('#email', 'pat@example.com');
  await page.fill('#phone', '501 555 0199');
  await page.check('#agree-coggins');
  await page.check('#agree-rules');
  await page.click('#book-btn');
  await page.waitForURL(/dev-checkout/);
  await page.click('#pay');
  await page.waitForURL(/\/booking/);
  await page.waitForSelector('text=You’re booked!', { timeout: 10000 }).catch(() => failures.push('booking flow: confirmation page never showed "You’re booked!"'));
  if (shots) await page.screenshot({ path: path.join(shots, 'booking-confirmed-desktop.png') });

  // Zoom / reflow: 320 CSS px wide must not scroll horizontally.
  for (const p of ['/', '/login', '/policies']) {
    await page.setViewportSize({ width: 320, height: 640 });
    await page.goto(t.base + p, { waitUntil: 'networkidle' });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (overflow > 1) failures.push(`reflow: ${p} scrolls sideways by ${overflow}px at 320px wide`);
  }
  await ctx.close();
}

await browser.close();
await t.close();

if (failures.length) {
  console.error(`\n${failures.length} accessibility problem(s):\n  - ${failures.join('\n  - ')}`);
  process.exit(1);
}
console.log('Accessibility checks passed: no axe violations, keyboard flows work, no horizontal scroll at 320px.');
