// Deploy preflight — proves the deploy scripts actually ship every file the
// code loads at runtime.  node tools/check_deploy.mjs
//
// ── Why this exists ─────────────────────────────────────────────────────────
// Both deploy scripts listed their files BY HAND. That is fine on the day it is
// written and wrong from the next new file onward, and the failure is invisible
// at deploy time:
//
//   • the server script never learned about accounts.js, character.js, tx.js or
//     shared/. pm2 reports a successful restart and then crash-loops on
//     require(), while /health can still be answered by the stale process.
//   • the client script never learned about shared/. game3d.js fetches
//     shared/recipes.json at boot, so crafting silently refuses everything in
//     production while working perfectly on localhost.
//
// Neither shows up as a red line in the deploy output. So instead of trusting a
// list, this reads the DEPLOY SCRIPTS THEMSELVES and checks them against what
// the code actually requires and fetches. Both .bat files run it first and abort
// on failure.
//
// ⚠ It reads the real scripts on purpose. A separate manifest would be a second
// list to forget to update — the same bug one level up.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = p => readFileSync(join(root, p), 'utf8');
const rel  = p => relative(root, p).replace(/\\/g, '/');

let problems = [];
const note = (script, msg) => problems.push(`${script}: ${msg}`);

// A path counts as covered if the script mentions it, or mentions the directory
// it lives in (the scripts copy whole folders and use wildcards).
// ⚠ Strip `rem` comments and `echo` lines FIRST. Without that, a comment that
// merely NAMES a file counts as shipping it — this checker's own explanatory
// comment mentioning "server/tx.js" made it declare tx.js covered by a script
// that did not copy it. A false negative in a preflight is worse than no
// preflight: it converts "we forgot a file" into "we proved we didn't".
// Only real commands may satisfy a path.
function commandsOnly(text) {
  return text.split(/\r?\n/)
    .filter(l => !/^\s*(rem\b|::|echo\b)/i.test(l))
    .join('\n');
}

// ⚠ Normalise the script's Windows backslashes ONCE, up front. Doing it per
// branch is how the first version reported world-data.json as missing while the
// script copied it two lines above — a checker that cries wolf gets switched off,
// which is the same failure from the other direction.
function covers(scriptTextRaw, filePath) {
  const script = commandsOnly(scriptTextRaw).replace(/\\/g, '/');
  const p = filePath.replace(/\\/g, '/');
  if (script.includes(p)) return true;
  const base = p.split('/').pop();
  const dir = p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '';
  const ext = base.slice(base.lastIndexOf('.'));
  // wildcard form: server\*.js  →  server/*.js
  if (dir && script.includes(`${dir}/*${ext}`)) return true;
  // whole-directory copy: -r "%~dp0js"  /  -r "%~dp0shared"
  if (dir && new RegExp(`-r\\s+"%~dp0${dir}"`).test(script)) return true;
  return false;
}

// ── Server: every local require() must be shipped ──
{
  const script = read('deploy_server_to_vps.bat');
  const files = readdirSync(join(root, 'server')).filter(f => f.endsWith('.js'));
  const wanted = new Set();

  for (const f of files) {
    wanted.add(`server/${f}`);
    const src = read(`server/${f}`);
    for (const m of src.matchAll(/require\(\s*['"](\.[^'"]+)['"]\s*\)/g)) {
      const target = resolve(join(root, 'server'), m[1]);
      const r = rel(target);
      if (!existsSync(target) && !existsSync(target + '.js'))
        note('server', `server/${f} requires ${m[1]} which does not exist`);
      wanted.add(existsSync(target) ? r : r + '.js');
    }
    // path.join(__dirname, '..', 'shared', 'x.json') — the tx.js form
    for (const m of src.matchAll(/path\.join\(__dirname,\s*'\.\.',\s*'([^']+)',\s*'([^']+)'\)/g))
      wanted.add(`${m[1]}/${m[2]}`);
    // readFileSync(path.join(__dirname, 'world-data.json'))
    for (const m of src.matchAll(/__dirname,\s*'([\w.-]+\.json)'\)/g))
      wanted.add(`server/${m[1]}`);
  }
  wanted.add('server/package.json');

  for (const w of [...wanted].sort()) {
    // data/ is runtime state that lives on the server and must never be shipped.
    if (w.startsWith('server/data/')) continue;
    if (!existsSync(join(root, w))) { note('server', `${w} is required but missing from the repo`); continue; }
    if (!covers(script, w)) note('server', `${w} is loaded at runtime but the deploy script does not copy it`);
  }
}

// ── Client: every fetched static path must be shipped ──
{
  const script = read('deploy_to_vps.bat');
  const jsFiles = readdirSync(join(root, 'js')).filter(f => f.endsWith('.js'));
  const wanted = new Set();

  for (const f of jsFiles) {
    const src = read(`js/${f}`);
    for (const m of src.matchAll(/fetch\(\s*['"]([^'":?]+\.(?:json|png|glb|bin))['"]/g)) {
      const p = m[1].replace(/^\.\//, '');
      if (p.startsWith('http')) continue;
      wanted.add(p);
    }
  }
  for (const w of [...wanted].sort()) {
    if (!existsSync(join(root, w))) {
      // world_edits.json is genuinely optional — the client tolerates a 404.
      if (w === 'world_edits.json') continue;
      note('client', `js/ fetches ${w} but it does not exist in the repo`);
      continue;
    }
    if (!covers(script, w)) note('client', `js/ fetches ${w} at boot but the deploy script does not copy it`);
  }
}

// ── The two nginx location blocks, which are not in any script ──
// Not verifiable from here (they live on the VPS), so this is a loud reminder
// rather than a check. /auth/ was added in the accounts work and production
// 404s every login without it while localhost is perfect.
const reminders = [
  'nginx must proxy /bravo-ws/  (websocket world server)',
  'nginx must proxy /auth/      (accounts: register / login / characters)',
  'server/world-data.json must be REGENERATED after any world edit, or the',
  '  server refuses gathers on tiles the client renders as trees',
];

if (problems.length) {
  console.error('DEPLOY PREFLIGHT FAILED\n');
  for (const p of problems) console.error('  ✖ ' + p);
  console.error('\nFix the deploy script(s) above before deploying — these failures are');
  console.error('SILENT at deploy time: pm2 reports success and crash-loops, or the client');
  console.error('loads and quietly refuses every craft.');
  process.exit(1);
}
console.log('deploy preflight OK — every runtime dependency is covered by the deploy scripts');
console.log('\nreminders (not checkable from here):');
for (const r of reminders) console.log('  · ' + r);
