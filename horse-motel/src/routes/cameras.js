import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { requireUser } from '../security/sessions.js';

export function cameraRoutes({ db, cameras }) {
  const r = express.Router();
  r.use(requireUser);
  // Video playback makes a request per segment, so this limit is generous; it exists to
  // stop one account hammering the cameras' uplink.
  r.use(rateLimit({ windowMs: 60e3, limit: 1500, standardHeaders: 'draft-7', legacyHeaders: false,
    keyGenerator: (req) => `u${req.user.id}` }));

  r.get('/', (req, res) => {
    if (req.user.role === 'admin') {
      const all = db.prepare('SELECT public_id, name, source_type FROM cameras WHERE active = 1 ORDER BY name').all();
      return res.json({ cameras: all.map((c) => ({ id: c.public_id, name: c.name, type: c.source_type === 'hls' ? 'hls' : 'image', live: true, covers: [] })) });
    }
    res.json({ cameras: cameras.camerasForUser(req.user.id) });
  });

  // Every single request re-checks access, so ending a booking cuts the feed.
  function authorize(req, res, next) {
    const camera = cameras.findCamera(req.params.id);
    if (!camera || !cameras.canView(req.user, camera)) {
      return res.status(403).json({ error: 'This camera isn’t available to your account right now.' });
    }
    req.camera = camera;
    next();
  }

  r.get('/:id/hls/:file', authorize, async (req, res) => {
    if (req.camera.source_type !== 'hls') return res.status(404).end();
    if (req.params.file === 'index.m3u8') cameras.logView(req.user, req.camera, req.ip);
    await cameras.relayHls(req.camera, req.params.file, req.query, res);
  });

  r.get('/:id/snapshot', authorize, async (req, res) => {
    if (req.camera.source_type === 'hls') return res.status(404).end();
    cameras.logView(req.user, req.camera, req.ip);
    await cameras.relaySnapshot(req.camera, res);
  });

  return r;
}
