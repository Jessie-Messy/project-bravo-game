# Project Bravo — World Server (Phase A: presence + chat)

Colyseus server: one persistent `bravo` room. Players see each other move,
chat, and last positions persist to `data/positions.json` across restarts.
Movement is client-authoritative for now; Phase B moves combat/mobs/loot
server-side (PvP + anti-cheat) and swaps JSON for SQLite.

## Run locally
```
cd server
npm install
node index.js        # listens on :2567 (PORT env to change)
```
The game client auto-connects to `ws://<host>:2567` when served from
localhost / the dev server (port 5173). Health check: http://localhost:2567/health

Multiplayer can be disabled per-session with `?mp=off` in the game URL.
Player name: `?name=YourName` (else a saved/random "Traveler####").

## Deploy to the VPS
Run `deploy_server_to_vps.bat` (project root). It copies the three server
files, `npm install`s on the VPS, and (re)starts under pm2 as `bravo`.

### One-time VPS setup
1. pm2 (the deploy script attempts this automatically):
   `sudo npm i -g pm2 && pm2 startup` (follow its printed command once)
2. nginx — add inside the `orionsyndicateguild.org` HTTPS server block, then
   `sudo nginx -t && sudo systemctl reload nginx`:
```nginx
location /bravo-ws/ {
    proxy_pass http://127.0.0.1:2567/;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 86400;
}
```
The client connects to `wss://orionsyndicateguild.org/bravo-ws` automatically
when the game isn't running on localhost (both Colyseus matchmaking HTTP
calls and the WebSocket ride through that one location block).

## Ops crib sheet
```
pm2 status            # is it up
pm2 logs bravo        # tail logs
pm2 restart bravo
curl -s localhost:2567/health
```
