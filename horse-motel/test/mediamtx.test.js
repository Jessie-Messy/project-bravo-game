// The recommended camera setup (Reolink NVR → MediaMTX → site relay) end to end, with a
// stand-in that serves exactly MediaMTX's HLS layout: a multivariant index.m3u8, a media
// playlist, an init segment and fMP4 segments, all as flat names in /stallN/.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { startServer, client, futureStay, bookAndPay } from './helpers.js';
import { seal } from '../src/security/secretbox.js';
import { randomToken } from '../src/security/crypto.js';

let t, mtx, port;
const hits = [];
before(async () => {
  mtx = http.createServer((req, res) => {
    hits.push(req.url);
    const u = new URL(req.url, 'http://x');
    const m = u.pathname.match(/^\/stall(\d)\/(.+)$/);
    if (!m) { res.writeHead(404); return res.end(); }
    const file = m[2];
    if (req.headers.authorization !== 'Basic ' + Buffer.from('viewer:s3cret').toString('base64')) { res.writeHead(401); return res.end(); }
    if (file === 'index.m3u8') {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      return res.end('#EXTM3U\n#EXT-X-VERSION:9\n#EXT-X-INDEPENDENT-SEGMENTS\n#EXT-X-STREAM-INF:BANDWIDTH=600000,CODECS="avc1.64001f",RESOLUTION=640x360\nmain_stream.m3u8\n');
    }
    if (file === 'main_stream.m3u8') {
      res.writeHead(200, { 'content-type': 'application/vnd.apple.mpegurl' });
      return res.end('#EXTM3U\n#EXT-X-VERSION:9\n#EXT-X-TARGETDURATION:2\n#EXT-X-MEDIA-SEQUENCE:40\n#EXT-X-MAP:URI="9f3c2a_main_init.mp4"\n#EXTINF:2.00000,\n9f3c2a_main_seg40.mp4\n#EXTINF:2.00000,\n9f3c2a_main_seg41.mp4\n');
    }
    if (/^9f3c2a_main_(init|seg\d+)\.mp4$/.test(file)) { res.writeHead(200, { 'content-type': 'video/mp4' }); return res.end(Buffer.alloc(2048, 1)); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => mtx.listen(0, '127.0.0.1', r));
  port = mtx.address().port;
  t = await startServer({ CAMERA_ALLOWED_HOSTS: '127.0.0.1', CAMERA_HOURS_BEFORE_CHECKIN: '30' });
});
after(async () => { await t.close(); mtx.close(); });

test('setup script output format matches what the relay accepts', () => {
  const out = execFileSync(process.execPath, ['--check', 'scripts/setup-cameras.js']);
  assert.equal(out.length, 0);
});

test('a guest plays a MediaMTX stream through the site, credentials never exposed', async () => {
  const stall = t.db.prepare("SELECT id FROM units WHERE kind = 'stall' AND number = 1").get();
  const cam = t.db.prepare("INSERT INTO cameras (public_id, name, source_type, source_url) VALUES (?, 'Stall 1 camera', 'hls', ?)")
    .run(randomToken(12), seal(`http://viewer:s3cret@127.0.0.1:${port}/stall1/index.m3u8`));
  t.db.prepare('INSERT INTO camera_units (camera_id, unit_id) VALUES (?, ?)').run(cam.lastInsertRowid, stall.id);
  const pid = t.db.prepare('SELECT public_id FROM cameras WHERE id = ?').get(cam.lastInsertRowid).public_id;

  const c = client(t.base);
  const { setupToken } = await bookAndPay(t, c, futureStay(t.cfg, { inDays: 0 }), 'watcher@example.com');
  await c.post('/api/auth/set-password', { token: setupToken, password: 'correct horse battery staple' });

  const index = await c.get(`/api/cameras/${pid}/hls/index.m3u8`);
  assert.equal(index.status, 200);
  assert.match(index.data, /^main_stream\.m3u8$/m);
  const media = await c.get(`/api/cameras/${pid}/hls/main_stream.m3u8`);
  assert.equal(media.status, 200);
  assert.match(media.data, /URI="9f3c2a_main_init\.mp4"/);
  assert.match(media.data, /^9f3c2a_main_seg41\.mp4$/m);
  for (const f of ['9f3c2a_main_init.mp4', '9f3c2a_main_seg40.mp4', '9f3c2a_main_seg41.mp4']) {
    const r = await fetch(`${t.base}/api/cameras/${pid}/hls/${f}`, { headers: { Cookie: [...c.jar].map(([k, v]) => `${k}=${v}`).join('; ') } });
    assert.equal(r.status, 200, f);
    assert.equal(r.headers.get('content-type'), 'video/mp4');
  }
  assert.ok(!JSON.stringify([index.data, media.data]).includes('s3cret'));
  // Anyone else is refused before MediaMTX is ever contacted.
  const before = hits.length;
  assert.equal((await client(t.base).get(`/api/cameras/${pid}/hls/index.m3u8`)).status, 401);
  assert.equal(hits.length, before);
});
