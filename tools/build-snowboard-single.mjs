// build-snowboard-single.mjs — bundle Alpenglow into one self-contained page.
//
// `snowboard.html` is the maintained form: separate modules, an importmap, and
// three.js loaded out of vendor/. That is what you develop against. This script
// produces the OTHER form — a single HTML file with every module and every byte
// of CSS inlined — which is what you need in the two situations the multi-file
// version cannot serve:
//
//   • handing someone a link or a file to try, with no server involved
//   • hosts that disallow external requests entirely (a strict CSP, an offline
//     kiosk, an embedded viewer)
//
// The output is page CONTENT plus a <title>: no <!doctype>, <html>, <head> or
// <body>, because the intended host supplies those. Wrap it yourself if you
// want a standalone file to open from disk.
//
// Usage:  npm install && node tools/build-snowboard-single.mjs [--out FILE] [--no-minify]

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let esbuild;
try {
  esbuild = await import('esbuild');
} catch {
  console.error(
    'esbuild is not installed.\n' +
    '  npm install            (it is a devDependency of this repo)\n' +
    'or, without touching node_modules:\n' +
    '  npx --yes esbuild@0.25.0 --version   # then re-run with esbuild on the path');
  process.exit(1);
}

const argv = process.argv.slice(2);
const outArg = argv.indexOf('--out');
const OUT = outArg >= 0 ? argv[outArg + 1] : path.join(ROOT, 'dist', 'alpenglow.html');
const MINIFY = !argv.includes('--no-minify');

// `three` and `three/addons/*` are bare specifiers that the browser resolves
// through the importmap in snowboard.html. esbuild has no importmap, and its
// --alias flag cannot express a trailing-slash prefix, so they are mapped to
// the vendored copies with a resolver plugin.
const vendorThree = {
  name: 'vendor-three',
  setup(build) {
    build.onResolve({ filter: /^three$/ }, () => ({
      path: path.join(ROOT, 'vendor/three/build/three.module.js'),
    }));
    build.onResolve({ filter: /^three\/addons\// }, (args) => ({
      path: path.join(ROOT, 'vendor/three/examples/jsm', args.path.slice('three/addons/'.length)),
    }));
  },
};

const bundled = await esbuild.build({
  entryPoints: [path.join(ROOT, 'js/snowboard/main.js')],
  bundle: true,
  format: 'esm',
  target: 'es2020',
  platform: 'browser',
  legalComments: 'none',
  minify: MINIFY,
  plugins: [vendorThree],
  write: false,
});

const js = bundled.outputFiles[0].text;
const css = await readFile(path.join(ROOT, 'css/snowboard.css'), 'utf8');

// Neither inlined payload may contain the closing tag of its own element, or
// the parser ends the block early and the rest of the file becomes markup.
for (const [what, text, tag] of [['bundle', js, '</script'], ['stylesheet', css, '</style']]) {
  if (text.includes(tag)) throw new Error(`${what} contains ${tag}, which would terminate its inline block`);
}

const page = `<title>Alpenglow</title>
<meta name="theme-color" content="#070b14" />

<style>
/* ── Alpenglow, verbatim from css/snowboard.css ──────────────────────
   Single-theme on purpose. The game is a dark alpine HUD composited over a
   live 3D snowfield; there is no light-mode counterpart to it, so rather than
   inventing one, every colour is painted explicitly (including the body
   ground) so the page holds on either host background. ── */
${css}

/* The host frame is not a bare browser tab, so restate the two things the game
   assumes about a viewport: that it owns the full height, and that nothing
   behind it shows through. */
html, body { width: 100%; height: 100%; background: var(--bg); }
</style>

<canvas id="gl"></canvas>
<div id="ui"></div>

<div id="loader">
  <div class="loader-inner">
    <div class="loader-mark">Project Bravo</div>
    <div class="loader-title">ALPENGLOW</div>
    <div class="loader-bar"><i id="loaderBar"></i></div>
    <div class="loader-note" id="loaderNote">Waxing the base&hellip;</div>
  </div>
</div>

<script type="module">
${js}
</script>
`;

await writeFile(OUT, page);
console.log(`${OUT}  ${(Buffer.byteLength(page) / 1024).toFixed(0)} kB`);
