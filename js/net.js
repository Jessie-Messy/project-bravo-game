// net.js — multiplayer client layer (Phase A: presence + chat).
// Connects to the Colyseus world server, streams our position at 10Hz, and
// exposes remote players + chat to game3d.js. Fails soft: if the server is
// unreachable the game stays fully playable single-player and retries later.
// Disable per-session with ?mp=off — name override with ?name=YourName.

export const net = {
  status: 'off',        // off | connecting | online
  room: null,
  selfId: null,
  remotes: new Map(),   // sessionId -> live PlayerState (Colyseus schema ref)
  mobs: new Map(),      // mobId -> live MobState (server-authoritative mobs)
  chatLog: [],          // [{name,text,t}] last 50
  onChat: null,         // set by game3d.js for floaters/log rendering
  onPvpHit: null,       // server-validated PvP hit {from,to,w,dmg}
  onMobAtk: null,       // server mob swings {id,to,dmg}
  onMobDead: null,      // server mob died {id,killer}
  onHouses: null,       // full shared-house list from the server
  onPlacedObjects: null, // persistent shared placed objects from the server (torches, lanterns, etc.)
  onSave: null,         // server-side save blob to apply on join
  onWorldTime: null,    // authoritative world clock {t} — keeps everyone's sky in sync
  onDropAdd: null, onDropGone: null, onDropGot: null,   // shared ground drops
  onTradeInvite: null, onTradeStart: null, onTradeUpdate: null, onTradeDone: null, onTradeEnd: null,
  onlineCount: 0,
};

let getSelf = null, sendAcc = 0, lastSent = null, retryT = null;

const params = new URLSearchParams(location.search);
export const MP_ENABLED = params.get('mp') !== 'off';

export function playerName() {
  const q = params.get('name');
  if (q && q.trim()) return q.trim().slice(0, 16);
  let n = localStorage.getItem('bravoName');
  if (!n) {
    n = 'Traveler' + (1000 + Math.floor(Math.random() * 9000));
    localStorage.setItem('bravoName', n);
  }
  return n;
}

// Per-device secret that claims our name on the server the first time we
// join with it; the server rejects later joins under this name without it.
function playerToken() {
  let t = localStorage.getItem('bravoToken');
  if (!t) {
    t = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem('bravoToken', t);
  }
  return t;
}

function serverUrl() {
  const h = location.hostname;
  // dev (static server on 5173, or plain localhost) → direct to :2567,
  // which also works for phones on the LAN pointed at the PC's IP.
  if (h === 'localhost' || h === '127.0.0.1' || location.port === '5173')
    return 'ws://' + h + ':2567';
  // production → nginx-proxied path on the same host
  return (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/bravo-ws';
}

function loadLib() {
  if (window.Colyseus && window.Colyseus.Client) return Promise.resolve(window.Colyseus);
  return new Promise((res, rej) => {
    const s = document.createElement('script');
    // pinned: 0.15.27+ browser dists are broken (node 'ws' lib bundled in,
    // crashes on Buffer/process at init). 0.15.26 is a clean browser build.
    s.src = 'https://cdn.jsdelivr.net/npm/colyseus.js@0.15.26/dist/colyseus.js';
    s.onload = () => (window.Colyseus && window.Colyseus.Client)
      ? res(window.Colyseus)
      : rej(new Error('colyseus.js loaded but Client missing'));
    s.onerror = () => rej(new Error('colyseus.js failed to load'));
    document.head.appendChild(s);
  });
}

function updateCount() {
  net.onlineCount = net.remotes.size + (net.status === 'online' ? 1 : 0);
}

function scheduleRetry() {
  if (retryT) return;
  retryT = setTimeout(() => { retryT = null; if (net.status !== 'online') initNet(getSelf); }, 20000);
}

export async function initNet(getSelfFn) {
  if (!MP_ENABLED) return;
  getSelf = getSelfFn;
  net.status = 'connecting';
  try {
    const Colyseus = await loadLib();
    const client = new Colyseus.Client(serverUrl());
    const room = await client.joinOrCreate('bravo', { name: playerName(), token: playerToken() });
    net.room = room; net.selfId = room.sessionId; net.status = 'online';
    lastSent = null;                       // force an immediate first send
    room.state.players.onAdd((p, id) => {
      if (id !== room.sessionId) net.remotes.set(id, p);
      updateCount();
    });
    room.state.players.onRemove((p, id) => { net.remotes.delete(id); updateCount(); });
    if (room.state.mobs) {   // server-authoritative mobs (older servers lack them)
      room.state.mobs.onAdd((m, id) => net.mobs.set(id, m));
      room.state.mobs.onRemove((m, id) => net.mobs.delete(id));
    }
    room.onMessage('mob_atk', m => { if (net.onMobAtk) net.onMobAtk(m); });
    room.onMessage('mob_dead', m => { if (net.onMobDead) net.onMobDead(m); });
    room.onMessage('houses', list => { if (net.onHouses) net.onHouses(list); });
    room.onMessage('placed_objects', list => { if (net.onPlacedObjects) net.onPlacedObjects(list); });
    room.onMessage('save', blob => { if (net.onSave) net.onSave(blob); });
    room.onMessage('worldtime', m => { if (net.onWorldTime) net.onWorldTime(m); });
    room.onMessage('drop_add',  m => { if (net.onDropAdd)  net.onDropAdd(m); });
    room.onMessage('drop_gone', m => { if (net.onDropGone) net.onDropGone(m); });
    room.onMessage('drop_got',  m => { if (net.onDropGot)  net.onDropGot(m); });
    room.onMessage('trade_invite', m => { if (net.onTradeInvite) net.onTradeInvite(m); });
    room.onMessage('trade_start',  m => { if (net.onTradeStart)  net.onTradeStart(m); });
    room.onMessage('trade_update', m => { if (net.onTradeUpdate) net.onTradeUpdate(m); });
    room.onMessage('trade_done',   m => { if (net.onTradeDone)   net.onTradeDone(m); });
    room.onMessage('trade_end',    m => { if (net.onTradeEnd)    net.onTradeEnd(m); });
    room.onMessage('chat', m => {
      net.chatLog.push(m);
      if (net.chatLog.length > 50) net.chatLog.shift();
      if (net.onChat) net.onChat(m);
    });
    room.onMessage('pvp_hit', m => { if (net.onPvpHit) net.onPvpHit(m); });
    room.onMessage('feed', m => {          // kill feed → chat log, no speaker
      net.chatLog.push({ name: '', text: m.text, t: Date.now() });
      if (net.chatLog.length > 50) net.chatLog.shift();
      if (net.onChat) net.onChat({ name: '', text: m.text, feed: true });
    });
    room.onLeave(() => {
      net.status = 'off'; net.room = null;
      net.remotes.clear(); net.mobs.clear(); updateCount();
      scheduleRetry();
    });
    updateCount();
    console.log('[net] online as', playerName());
  } catch (e) {
    const msg = '' + (e.message || e);
    if (msg.includes('name-protected')) {
      // don't retry-spam a rejected identity — tell the player instead
      net.status = 'off';
      net.nameRejected = true;
      console.warn(`[net] the name "${playerName()}" is claimed on this server from another device. ` +
        'Pick a new name (?name=... or localStorage bravoName).');
      return;
    }
    console.warn('[net] offline — server unreachable (retrying):', msg);
    net.status = 'off';
    scheduleRetry();
  }
}

// Called every frame; sends our presence at 10Hz when something changed.
export function netTick(dt) {
  if (net.status !== 'online' || !net.room || !getSelf) return;
  sendAcc += dt;
  if (sendAcc < 0.1) return;
  sendAcc = 0;
  const s = getSelf();
  const key = s.x.toFixed(1) + ',' + s.y.toFixed(1) + ',' + s.dir.toFixed(2) + ',' +
    s.weapon + ',' + s.dead + ',' + s.ghost + ',' + s.onHorse + ',' + s.hidden + ',' + s.hp;
  if (key === lastSent) return;
  lastSent = key;
  net.room.send('move', s);
}

export function netChat(text) {
  if (net.status === 'online' && net.room) net.room.send('chat', text);
}

// PvP attack intent — the server referees range/cooldown/safe-zone/damage
let _lastPvpSend = 0;
export function netPvp(targetId, weapon) {
  if (net.status !== 'online' || !net.room) return;
  const now = performance.now();
  if (now - _lastPvpSend < 250) return;    // client-side pre-throttle
  _lastPvpSend = now;
  net.room.send('pvp', { t: targetId, w: weapon });
}

// Damage intent against a server-authoritative mob (server clamps + referees)
let _lastMobHit = 0;
export function netMobHit(id, dmg) {
  if (net.status !== 'online' || !net.room) return;
  const now = performance.now();
  if (now - _lastMobHit < 150) return;
  _lastMobHit = now;
  net.room.send('mob_hit', { id, dmg });
}

// Push the full save blob to the server (source of truth while online)
export function netSave(blob) {
  if (net.status === 'online' && net.room) net.room.send('save', blob);
}

// Ground drops + trading senders
export function netDropAdd(type, count) { if (net.status==='online'&&net.room) net.room.send('drop_add', { type, count }); }
export function netDropTake(id) { if (net.status==='online'&&net.room) net.room.send('drop_take', { id }); }
export function netTradeReq(to) { if (net.status==='online'&&net.room) net.room.send('trade_req', { to }); }
export function netTradeAccept(from) { if (net.status==='online'&&net.room) net.room.send('trade_accept', { from }); }
export function netTradeOffer(offer) { if (net.status==='online'&&net.room) net.room.send('trade_offer', offer); }
export function netTradeConfirm() { if (net.status==='online'&&net.room) net.room.send('trade_confirm', {}); }
export function netTradeCancel() { if (net.status==='online'&&net.room) net.room.send('trade_cancel', {}); }

// Shared houses: place / update / remove through the server (owner-checked there)
export function netHousePlace(h) {
  if (net.status === 'online' && net.room)
    net.room.send('house_place', { x0: h.x0, y0: h.y0, size: h.size, isPublic: !!h.isPublic });
}
export function netHouseUpdate(idx, fields) {
  if (net.status === 'online' && net.room)
    net.room.send('house_update', Object.assign({ idx }, fields));
}
export function netHouseRemove(idx) {
  if (net.status === 'online' && net.room) net.room.send('house_remove', { idx });
}

// Declare a legit teleport (portal / death respawn / dev) so the server's
// speed enforcement doesn't rubber-band it
export function netTp(reason) {
  if (net.status !== 'online' || !net.room || !getSelf) return;
  const s = getSelf();
  net.room.send('tp', { x: s.x, y: s.y, reason });
}
