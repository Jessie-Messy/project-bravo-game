// index.js — Project Bravo multiplayer server entry point.
// Colyseus over WebSocket, one persistent world room. Run: node index.js
const http = require('http');
const express = require('express');
const { Server } = require('colyseus');
const { BravoRoom } = require('./bravo-room.js');

const PORT = process.env.PORT || 2567;

const accounts = require('./accounts.js');

const app = express();
app.use(express.json({ limit: '8kb' }));
// The game is served from a different origin than the world server (file://,
// a dev http-server on :5173, or the VPS's static host), so the login form
// cannot reach these endpoints without CORS.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  res.header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
// ⚠ /health is the ONLY thing a deploy can check without SSHing in, so it
// reports enough to tell a healthy server from a broken one. `resourceLayer:
// false` means world-data.json is stale and every gather will be refused;
// `oplog.disabled: true` means the evidence Phase 2 depends on is not being
// recorded. Both look completely fine from the outside otherwise.
app.get('/health', (req, res) => {
  let extra = {};
  try {
    const oplog = require('./oplog.js');
    const character = require('./character.js');
    const { world } = require('./mobs.js');
    extra = {
      schemaVersion: character.SCHEMA_VERSION,
      storage: character.backend,
      worldData: !!world,
      resourceLayer: !!(world && world.resB64),
      oplog: oplog.stats(),
    };
  } catch (e) { extra = { healthError: e.message }; }
  res.json(Object.assign({ ok: true, uptime: Math.round(process.uptime()) }, extra));
});
app.get('/', (req, res) => res.type('text/plain').send('Project Bravo world server'));

// ── Auth ──────────────────────────────────────────────────────────
// Login happens over HTTP *before* joining the room, so the screen can show
// "wrong password" and list your characters without a room join succeeding or
// failing opaquely. The room then verifies the returned session in onAuth.
//
// Throttled per IP: scrypt is deliberately slow, so unbounded attempts are both
// a guessing oracle and a CPU denial-of-service.
const attempts = new Map();
function throttled(req) {
  const ip = req.ip || 'unknown';
  const now = Date.now();
  const a = attempts.get(ip) || { n: 0, until: 0 };
  if (a.until > now) return true;
  a.n++;
  if (a.n > 10) { a.until = now + 60000; a.n = 0; }   // 10 tries, then a minute out
  attempts.set(ip, a);
  return false;
}
setInterval(() => attempts.clear(), 1000 * 60 * 10).unref?.();

app.post('/auth/register', (req, res) => {
  if (throttled(req)) return res.status(429).json({ ok: false, error: 'too many attempts — wait a minute' });
  const { username, password } = req.body || {};
  const r = accounts.register(username, password);
  if (!r.ok) return res.status(400).json(r);
  res.json({ ok: true, username: r.username, token: accounts.newSession(r.username), characters: [] });
});

app.post('/auth/login', (req, res) => {
  if (throttled(req)) return res.status(429).json({ ok: false, error: 'too many attempts — wait a minute' });
  const { username, password } = req.body || {};
  const r = accounts.verify(username, password);
  if (!r.ok) return res.status(401).json(r);
  res.json({ ok: true, username: r.username, token: accounts.newSession(r.username),
             characters: accounts.listCharacters(r.username) });
});

// Re-list characters for an existing session (after creating one, or on reload
// when the client still holds a valid token and should not re-prompt).
app.post('/auth/characters', (req, res) => {
  const user = accounts.sessionUser((req.body && req.body.token) || '');
  if (!user) return res.status(401).json({ ok: false, error: 'session expired' });
  res.json({ ok: true, username: user, characters: accounts.listCharacters(user) });
});

const gameServer = new Server({ server: http.createServer(app) });
gameServer.define('bravo', BravoRoom);

gameServer.listen(PORT).then(() => {
  console.log(`[bravo] world server listening on :${PORT}`);
});
