// index.js — Project Bravo multiplayer server entry point.
// Colyseus over WebSocket, one persistent world room. Run: node index.js
const http = require('http');
const express = require('express');
const { Server } = require('colyseus');
const { BravoRoom } = require('./bravo-room.js');
const { DEV_AUTH } = require('./orion-auth.js');

const PORT = process.env.PORT || 2567;

// ⚠ WHEN THE DEV AUTH BYPASS IS ON, BIND TO LOOPBACK.
//
// The bypass accepts any client under any name. Binding 0.0.0.0 with it active
// would put an unauthenticated world server on every interface the machine has,
// which on a laptop means the coffee-shop wifi. Loopback makes the bypass
// reachable only from the machine running it — a second guard that does not
// depend on remembering to unset an env var.
//
// Testing from a phone on the LAN needs the bypass reachable off-box, so that
// is an explicit second opt-in rather than the default:
//   ORION_DEV_AUTH=1 ORION_DEV_AUTH_HOST=0.0.0.0 node index.js
const HOST = DEV_AUTH ? (process.env.ORION_DEV_AUTH_HOST || '127.0.0.1') : undefined;

const app = express();
app.get('/health', (req, res) => res.json({ ok: true, uptime: Math.round(process.uptime()) }));
app.get('/', (req, res) => res.type('text/plain').send('Project Bravo world server'));

const gameServer = new Server({ server: http.createServer(app) });
gameServer.define('bravo', BravoRoom);

gameServer.listen(PORT, HOST).then(() => {
  console.log(`[bravo] world server listening on ${HOST || '0.0.0.0'}:${PORT}`);
  if (DEV_AUTH && HOST !== '127.0.0.1')
    console.warn('[bravo] dev auth bypass is reachable OFF THIS MACHINE ' +
                 `(bound ${HOST}) — that was an explicit opt-in via ORION_DEV_AUTH_HOST.`);
});
