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
  character: null,      // PHASE 0 shadow document (not authoritative yet)
  onCharacter: null,
  onTxResult: null,     // PHASE 1 transaction outcome {seq,kind,ok,deltas|reason}
  onWorldTime: null,    // authoritative world clock {t} — keeps everyone's sky in sync
  onDropAdd: null, onDropGone: null, onDropGot: null,   // shared ground drops
  onTradeInvite: null, onTradeStart: null, onTradeUpdate: null, onTradeDone: null, onTradeEnd: null,
  onlineCount: 0,
};

let getSelf = null, sendAcc = 0, lastSent = null, retryT = null;

const params = new URLSearchParams(location.search);
export const MP_ENABLED = params.get('mp') !== 'off';

// The name we join the world under. This MUST be the selected character, not a
// separate per-browser nickname.
//
// ⚠ It used to read only `bravoName`, a key nothing ever wrote except the
// random fallback below. So picking "Gideon" on the select screen still joined
// as "Traveler1234": the server claimed THAT name for your account and sent
// back Traveler's (empty) save — the character you picked never loaded, which
// defeats the entire point of server-side characters. The active slot is the
// authority; `bravoName` is only a fallback for a session with no character.
export function activeCharacterName() {
  try {
    const acc = JSON.parse(localStorage.getItem('bravo_account_v1') || 'null');
    const s = acc && acc.slots && acc.slots[acc.activeSlot || 0];
    if (s && s.name) return ('' + s.name).slice(0, 16);
  } catch (_) {}
  return null;
}
export function playerName() {
  const q = params.get('name');
  if (q && q.trim()) return q.trim().slice(0, 16);
  const chosen = activeCharacterName();
  if (chosen) return chosen;
  let n = localStorage.getItem('bravoName');
  if (!n) {
    n = 'Traveler' + (1000 + Math.floor(Math.random() * 9000));
    localStorage.setItem('bravoName', n);
  }
  return n;
}

// ── Accounts ──────────────────────────────────────────────────────
// Identity used to be a random per-device token in localStorage. That token IS
// the identity, and it cannot leave the browser that made it — so logging in
// from a second computer generated a new one, the server saw it did not match
// the name's claim, and refused the join. You could not reach your own
// character from another machine. Now the account lives on the server and you
// carry a username and password instead.
//
// The session token below is still cached in localStorage, but only as a
// convenience so a reload doesn't re-prompt; losing it costs a re-login, not a
// character.
export const auth = { username: null, session: null, characters: [] };

function authOrigin() {
  const h = location.hostname;
  if (h === 'localhost' || h === '127.0.0.1' || location.port === '5173')
    return location.protocol + '//' + h + ':2567';
  return location.origin;                    // production: same host as the game
}
async function authPost(path, body) {
  try {
    const r = await fetch(authOrigin() + path, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) return { ok: false, error: j.error || ('server said ' + r.status) };
    return j;
  } catch (e) {
    return { ok: false, error: 'cannot reach the server' };
  }
}
function rememberSession(j) {
  auth.username = j.username; auth.session = j.token; auth.characters = j.characters || [];
  try { localStorage.setItem('bravoSession', JSON.stringify({ u: j.username, t: j.token })); } catch (_) {}
  return { ok: true };
}
export async function accountRegister(username, password) {
  const j = await authPost('/auth/register', { username, password });
  return j.ok ? rememberSession(j) : j;
}
export async function accountLogin(username, password) {
  const j = await authPost('/auth/login', { username, password });
  return j.ok ? rememberSession(j) : j;
}
// Re-use a cached session on reload. Returns false if it expired, in which case
// the login screen must be shown again.
export async function accountResume() {
  let c = null;
  try { c = JSON.parse(localStorage.getItem('bravoSession') || 'null'); } catch (_) {}
  if (!c || !c.t) return false;
  const j = await authPost('/auth/characters', { token: c.t });
  if (!j.ok) { try { localStorage.removeItem('bravoSession'); } catch (_) {} return false; }
  auth.username = j.username; auth.session = c.t; auth.characters = j.characters || [];
  return true;
}
export async function accountRefreshCharacters() {
  if (!auth.session) return [];
  const j = await authPost('/auth/characters', { token: auth.session });
  if (j.ok) auth.characters = j.characters || [];
  return auth.characters;
}
export function accountLogout() {
  auth.username = auth.session = null; auth.characters = [];
  try { localStorage.removeItem('bravoSession'); } catch (_) {}
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

// Re-join under whatever character is active now. The world connection is
// opened at boot, BEFORE the player has picked a character, so the first join
// uses whatever name was active last time (or none). Selecting a character has
// to move the connection to that character, or you would be standing in the
// world under the previous one and saving over its blob.
export async function netRejoinAsActiveCharacter() {
  if (!MP_ENABLED || !auth.session) return;
  const want = playerName();
  if (net.room && net.joinedAs === want) return;      // already the right one
  try { if (net.room) await net.room.leave(); } catch (_) {}
  net.room = null; net.remotes.clear();
  await initNet(getSelf);
}

export async function initNet(getSelfFn) {
  if (!MP_ENABLED) return;
  if (getSelfFn) getSelf = getSelfFn;
  net.status = 'connecting';
  try {
    const Colyseus = await loadLib();
    const client = new Colyseus.Client(serverUrl());
    // No session → stay offline rather than joining anonymously. Joining
    // without an account would let the world hand out a character name that
    // nobody owns, which is what the account system exists to prevent.
    if (!auth.session) { net.status = 'offline'; net.error = 'not logged in'; return; }
    const joinName = playerName();
    const room = await client.joinOrCreate('bravo', { name: joinName, session: auth.session });
    net.room = room; net.selfId = room.sessionId; net.status = 'online';
    net.joinedAs = joinName;               // so a character switch knows to re-join
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
    // PHASE 0 (docs/SERVER_AUTHORITY.md): pull the server's character document
    // alongside the save. Nothing reads it authoritatively yet -- it is a shadow
    // copy, and having the client hold it makes the divergence visible on this
    // side too rather than only in the server log.
    room.onMessage('character_state', doc => { net.character = doc; if (net.onCharacter) net.onCharacter(doc); });
    room.onMessage('tx_result', m => { if (net.onTxResult) net.onTxResult(m); });
    room.send('request_character');
    // Ask for our save now that every handler above is attached.
    // ⚠ The server also pushes it from onJoin, but that send happens while we
    // are still inside joinOrCreate() with no handlers registered, so it is
    // delivered to nobody and dropped. That is why a character could join with
    // the right name, against a server holding the right save, and still come
    // up with a default inventory. Do not remove this in favour of the push.
    room.send('request_save');
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

// ── Transactions (PHASE 1 of docs/SERVER_AUTHORITY.md) ────────────
// Send an INTENT and get an authoritative answer. The caller has normally
// already applied the change locally (prediction) — that is what keeps crafting
// and pickups feeling instant — so the reply either confirms it or is a
// rejection the caller must undo.
//
// ⚠ Each intent carries a monotonic `seq` and the server echoes it back. Without
// it, two intents in flight at once cannot be told apart on reply, and a
// rejection would roll back whichever action the client guessed at — which
// presents as an item vanishing for no reason. `pending` holds what each seq
// predicted so the reconciler knows exactly what to reverse.
let txSeq = 0;
export const txPending = new Map();   // seq -> {kind, intent, predicted}

// Offline is a demo/tutorial only (see docs/SERVER_AUTHORITY.md, Decisions), so
// there is deliberately no local transaction path here: single-player keeps its
// own client-side rules and never round-trips.
export function netTx(kind, intent, predicted) {
  if (net.status !== 'online' || !net.room) return 0;
  const seq = ++txSeq;
  txPending.set(seq, { kind, intent, predicted: predicted || null, at: Date.now() });
  // A reply that never arrives would leak an entry per action for the whole
  // session; drop anything older than a generous round trip.
  if (txPending.size > 64) {
    const cut = Date.now() - 30000;
    for (const [k, v] of txPending) if (v.at < cut) txPending.delete(k);
  }
  net.room.send('tx', { seq, kind, intent });
  return seq;
}
