import express from 'express';
import { rateLimit } from 'express-rate-limit';
import { requireUser } from '../security/sessions.js';

export function cameraRoutes({ db, cameras }) {
  const r = express.Router();
  r.use(requireUser);
  // Playback makes about one request a second per camera (playlist + segment), so this
  // covers several cameras at once while stopping one account hammering the uplink.
  // Requests in flight are capped separately in the camera service.
  r.use(rateLimit({ windowMs: 60e3, limit: 400, standardHeaders: 'draft-7', legacyHeaders: false,
    keyGenerator: (req) => `u${req.user.id}` }));

  r.get('/', (req, res) => {
    if (cameras.isVerifiedAdmin(req.user, req.session)) {
      const all = db.prepare('SELECT public_id, name, source_type FROM cameras WHERE active = 1 ORDER BY name').all();
      return res.json({ cameras: all.map((c) => ({ id: c.public_id, name: c.name, type: c.source_type === 'hls' ? 'hls' : 'image', live: true, covers: [] })) });
    }
    res.json({ cameras: cameras.camerasForUser(req.user.id) });
  });

  // Every single request re-checks access, so ending a booking cuts the feed.
  function authorize(req, res, next) {
    const camera = cameras.findCamera(req.params.id);
    if (!camera || !cameras.canView(req.user, camera, req.session)) {
      return res.status(403).json({ error: 'This camera isn’t available to your account right now.' });
    }
    req.camera = camera;
    next();
  }

  r.get('/:id/hls/:file', authorize, async (req, res) => {
    if (req.camera.source_type !== 'hls') return res.status(404).end();
    if (req.params.file === 'index.m3u8') cameras.logView(req.user, req.camera, req.ip);
    await cameras.relayHls(req.user, req.camera, req.params.file, req.query, res);
  });

  r.get('/:id/snapshot', authorize, async (req, res) => {
    if (req.camera.source_type === 'hls') return res.status(404).end();
    cameras.logView(req.user, req.camera, req.ip);
    await cameras.relaySnapshot(req.user, req.camera, res);
  });

  return r;
}
