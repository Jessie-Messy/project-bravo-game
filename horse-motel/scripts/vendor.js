// Copies browser dependencies out of node_modules into public/vendor so the site serves
// every script and font from its own origin. That is what lets the Content Security
// Policy be `script-src 'self'` with no third-party CDN to trust.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const nm = path.join(root, 'node_modules');
const vendor = path.join(root, 'public', 'vendor');
const fonts = path.join(root, 'public', 'fonts');
fs.mkdirSync(vendor, { recursive: true });
fs.mkdirSync(fonts, { recursive: true });

const copy = (from, to) => { if (fs.existsSync(from)) fs.copyFileSync(from, to); };
copy(path.join(nm, 'hls.js', 'dist', 'hls.light.min.js'), path.join(vendor, 'hls.light.min.js'));
copy(path.join(nm, '@fontsource-variable', 'inter', 'files', 'inter-latin-wght-normal.woff2'),
  path.join(fonts, 'inter-latin-wght.woff2'));
copy(path.join(nm, '@fontsource-variable', 'fraunces', 'files', 'fraunces-latin-wght-normal.woff2'),
  path.join(fonts, 'fraunces-latin-wght.woff2'));
