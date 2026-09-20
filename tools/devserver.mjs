// devserver.mjs — a static server for local testing that never caches.
//
//   node tools/devserver.mjs [port]
//
// `python -m http.server` sends Last-Modified and no Cache-Control, so browsers apply
// heuristic caching to ES modules. The effect is that you edit a file, reload, and the
// page silently runs the OLD module while a cache-busted fetch of the same URL shows the
// new one. That has cost real debugging time on this project more than once — twice it
// looked like a fix had not deployed when it had.
//
// A different port used to be the workaround, because a different origin gets a clean
// cache. That only works once per port. This just refuses to be cached at all.
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, sep } from 'node:path';

const ROOT = process.cwd();
const PORT = Number(process.argv[2]) || 8123;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.mjs':  'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.glb':  'model/gltf-binary',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.webp': 'image/webp',
  '.ogg':  'audio/ogg',
  '.mp3':  'audio/mpeg',
  '.svg':  'image/svg+xml',
  '.wasm': 'application/wasm',
  '.ttf':  'font/ttf',
  '.woff2':'font/woff2',
};

createServer(async (req, res) => {
  try {
    const url = decodeURIComponent((req.url || '/').split('?')[0]);
    // Contain the path inside ROOT: normalize resolves any ../ before it is joined.
    const rel = normalize(url).replace(/^([/\\])+/, '');
    const path = join(ROOT, rel);
    if (!path.startsWith(ROOT + sep) && path !== ROOT) {
      res.writeHead(403).end('forbidden');
      return;
    }

    let target = path;
    const s = await stat(target).catch(() => null);
    if (s && s.isDirectory()) target = join(target, 'index.html');

    const body = await readFile(target);
    res.writeHead(200, {
      'Content-Type': TYPES[extname(target).toLowerCase()] || 'application/octet-stream',
      // The whole point of this server. no-store means the browser may not keep a copy
      // at all, so a reload always re-fetches every module.
      'Cache-Control': 'no-store, no-cache, must-revalidate',
      'Pragma': 'no-cache',
      'Expires': '0',
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Cache-Control': 'no-store' }).end('not found');
  }
}).listen(PORT, () => {
  console.log(`dev server on http://localhost:${PORT}  (Cache-Control: no-store)`);
  console.log(`serving ${ROOT}`);
});
