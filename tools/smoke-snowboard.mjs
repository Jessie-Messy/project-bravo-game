// smoke-snowboard.mjs — drive the built game the way a phone does, and fail
// loudly if it does not ride.
//
// This exists because three real bugs shipped past a test suite that looked
// thorough. Every one of them lived in an environment the tests were not
// reproducing, and each cost a round trip with a person holding a phone:
//
//   1. Audio init threw, so the DROP IN handler died before the run started.
//      Missed because nothing tested a browser that refuses an AudioContext.
//   2. The countdown ran on clamped simulation time, so a slow device sat at
//      the gate. Missed because the harness never rendered slowly enough.
//   3. navigator.getGamepads() throws in an embed, and it is polled every
//      frame once a run begins, which froze physics, camera, HUD and streaming
//      together. Missed because every test ran the page top-level, where the
//      API is permitted — and because every test steered with the KEYBOARD,
//      so the touch path, the only path a phone has, was never exercised.
//
// So this harness does the two things those tests did not: it runs the page
// inside an iframe that is denied the gamepad permission, and it drives it
// exclusively by synthesised touch. It also probes every browser API the game
// touches in that context, so the next gated-API surprise is enumerated here
// rather than discovered by a person.
//
// Usage:  npm run build:snowboard && node tools/smoke-snowboard.mjs
//         node tools/smoke-snowboard.mjs --headed --keep
//
// Playwright is not a dependency of this repo — it is large and most work here
// does not need it. If it is not resolvable the script says so and exits 2,
// which is distinguishable from a real failure (1).

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PAGE = process.env.SMOKE_PAGE || path.join(ROOT, 'dist', 'alpenglow.html');
const HEADED = process.argv.includes('--headed');

let chromium;
try {
  ({ chromium } = await import('playwright'));
} catch {
  console.error(
    'Playwright is not installed, so the smoke test cannot run.\n' +
    '  npm i -D playwright && npx playwright install chromium\n' +
    'It is deliberately not a dependency of this repo.');
  process.exit(2);
}

let page;
try {
  page = await readFile(PAGE, 'utf8');
} catch {
  console.error(`No built page at ${PAGE}.\n  npm run build:snowboard`);
  process.exit(2);
}

// The wrapper reproduces the delivery context that mattered: an iframe, denied
// the gamepad permission, laid out at a phone width. The viewport meta is not
// decoration — without it the wrapper lays out at 980px, the iframe inherits
// that, and the game's own responsive rules hide the touch controls.
const wrapper = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>smoke harness</title>
<style>html,body{margin:0;height:100%;background:#000}iframe{border:0;width:100%;height:100%;display:block}</style>
<iframe id="f" src="/game" allow="gamepad 'none'"></iframe>`;

const server = createServer((req, res) => {
  const body = req.url.startsWith('/game') ? page : wrapper;
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

const failures = [];
const check = (name, ok, detail) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
  if (!ok) failures.push(name);
};

const browser = await chromium.launch({
  headless: !HEADED,
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
});
const ctx = await browser.newContext({
  viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
});
const tab = await ctx.newPage();
const errors = [];
tab.on('pageerror', e => errors.push(String(e.message)));

try {
  await tab.goto(`${base}/`, { waitUntil: 'load' });
  const frame = tab.frames().find(f => f.url().includes('/game'));
  if (!frame) throw new Error('game iframe never appeared');

  // Every browser API the game touches, probed in the embedded context.
  const probe = await frame.evaluate(() => {
    const t = (fn) => { try { fn(); return 'ok'; } catch (e) { return `${e.name}: ${e.message}`.slice(0, 100); } };
    return {
      getGamepads: t(() => navigator.getGamepads()),
      AudioContext: t(() => { const C = window.AudioContext || window.webkitAudioContext; if (!C) throw new Error('absent'); new C().close(); }),
      localStorage: t(() => { localStorage.setItem('__s', '1'); localStorage.removeItem('__s'); }),
      canvas2d: t(() => { if (!document.createElement('canvas').getContext('2d')) throw new Error('null context'); }),
      webgl2: t(() => { if (!document.createElement('canvas').getContext('webgl2')) throw new Error('null context'); }),
      pointerCapture: t(() => { if (!Element.prototype.setPointerCapture) throw new Error('absent'); }),
      performanceNow: t(() => performance.now()),
    };
  });
  console.log('API probe in the embedded context:');
  for (const [k, v] of Object.entries(probe)) console.log(`    ${k.padEnd(15)} ${v}`);
  // getGamepads being refused here is the POINT of the harness, not a failure.
  // Anything else refusing is new information and must be looked at.
  const unexpected = Object.entries(probe).filter(([k, v]) => k !== 'getGamepads' && v !== 'ok');
  check('only getGamepads is refused in an embed', unexpected.length === 0,
    unexpected.map(([k, v]) => `${k}: ${v}`).join('; '));

  let ready = false;
  for (let i = 0; i < 90 && !ready; i++) {
    ready = await frame.evaluate(() => document.getElementById('loader')?.classList.contains('is-done'));
    if (!ready) await tab.waitForTimeout(1000);
  }
  check('boots to the menu', ready,
    ready ? '' : await frame.evaluate(() => document.getElementById('loaderNote')?.textContent));
  if (!ready) throw new Error('never finished loading');

  // Touch only, from here on. No keyboard.
  const cdp = await ctx.newCDPSession(tab);
  const touch = (type, x, y) => cdp.send('Input.dispatchTouchEvent', {
    type, touchPoints: type === 'touchEnd' ? [] : [{ x, y, id: 1 }],
  });
  const centreOf = (sel) => frame.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return r.width && r.height ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
  }, sel);
  const tap = async (pt) => { await touch('touchStart', pt.x, pt.y); await tab.waitForTimeout(80); await touch('touchEnd', pt.x, pt.y); };

  const dropIn = await frame.evaluate(() => {
    const b = [...document.querySelectorAll('.btn')].find(x => x.textContent.includes('DROP IN'));
    if (!b) return null;
    const r = b.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
  });
  check('DROP IN is present and laid out', !!dropIn);
  if (!dropIn) throw new Error('no DROP IN button');
  await tap(dropIn);

  // The countdown must clear on wall-clock time even when frames are slow.
  let started = false;
  for (let i = 0; i < 20 && !started; i++) {
    await tab.waitForTimeout(1000);
    started = await frame.evaluate(() => window.SNOW?.state === 'ride');
  }
  check('the run starts', started);

  // ...and the rider must actually descend, which is what the gamepad throw
  // silently prevented while leaving every other sign of life intact.
  await tab.waitForTimeout(4000);
  const moving = await frame.evaluate(() => {
    const r = window.SNOW.world.ride;
    return { d: r.distance, kmh: r.groundSpeed * 3.6, time: r.time };
  });
  check('the rider descends', moving.d > 10 && moving.time > 1,
    `${moving.d.toFixed(1)} m, ${moving.kmh.toFixed(0)} km/h, t=${moving.time.toFixed(2)}s`);

  // Drag steering: wherever the thumb lands is centre.
  await touch('touchStart', 196, 620);
  for (let i = 1; i <= 8; i++) { await touch('touchMove', 196 - i * 13, 620); await tab.waitForTimeout(30); }
  const steer = await frame.evaluate(() => ({
    steer: window.SNOW.input.state.steer,
    edge: window.SNOW.world.ride.edge,
    padsBlocked: window.SNOW.input._padsBlocked,
  }));
  await touch('touchEnd', 90, 620);
  check('drag steers the board', steer.steer < -0.3 && steer.edge < -0.2,
    `steer ${steer.steer.toFixed(2)}, edge ${steer.edge.toFixed(2)}`);
  check('gamepad polling latched off after refusal', steer.padsBlocked === true);

  // The thumb controls must exist on a touch device regardless of how wide the
  // viewport measures — they were once hidden by a min-width media query.
  const ollieBtn = await centreOf('#btnAction');
  check('the ollie button is laid out on a touch device', !!ollieBtn);

  if (ollieBtn) {
    await tab.waitForTimeout(800);
    const before = await frame.evaluate(() => window.SNOW.world.ride.stats.airTotal);
    await tap(ollieBtn);
    let airborne = false;
    for (let i = 0; i < 14 && !airborne; i++) {
      airborne = await frame.evaluate(() => !window.SNOW.world.ride.grounded);
      await tab.waitForTimeout(100);
    }
    const after = await frame.evaluate(() => window.SNOW.world.ride.stats.airTotal);
    check('tapping ollie leaves the ground', airborne || after > before + 0.05,
      `airTotal ${before.toFixed(2)} → ${after.toFixed(2)}`);
  }

  check('no frame-loop error banner', !(await frame.evaluate(() => !!document.querySelector('.errbar'))));
  check('no uncaught page errors', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (err) {
  check('harness ran to completion', false, err.message);
} finally {
  await browser.close();
  server.close();
}

console.log(failures.length ? `\n${failures.length} check(s) failed: ${failures.join(', ')}` : '\nAll checks passed.');
process.exit(failures.length ? 1 : 0);
