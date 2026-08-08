// index.js — Project Bravo multiplayer server entry point.
// Colyseus over WebSocket, one persistent world room. Run: node index.js
const http = require('http');
const express = require('express');
const { Server } = require('colyseus');
const { BravoRoom } = require('./bravo-room.js');

const PORT = process.env.PORT || 2567;

const app = express();
app.get('/health', (req, res) => res.json({ ok: true, uptime: Math.round(process.uptime()) }));
app.get('/', (req, res) => res.type('text/plain').send('Project Bravo world server'));

const gameServer = new Server({ server: http.createServer(app) });
gameServer.define('bravo', BravoRoom);

gameServer.listen(PORT).then(() => {
  console.log(`[bravo] world server listening on :${PORT}`);
});
