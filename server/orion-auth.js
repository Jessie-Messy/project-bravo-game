// orion-auth.js — verifies Orion platform tickets inside the world server.
//
// The browser asks the platform for a short-lived ticket
// (POST /api/games/medieval/ticket) and hands it over on join. This checks the
// signature, so the world server learns the real account id without a database
// lookup, a session cookie, or any call back to the platform.
//
// Deliberately standalone: this file is a copy of the verify half of the
// platform's auth module rather than an import, so the world server stays a
// separate deployable with no dependency on the platform's source tree. Both
// sides only need the same secret.
const crypto = require('crypto');
const fs = require('fs');

// Secret resolution, in order:
//   1. ORION_SECRET        — how production should set it
//   2. ORION_SECRET_FILE   — path to the platform's data/secret.key, which is
//                            what local development generates automatically
// With neither, every join is refused: a world server that cannot verify a
// ticket must not fall back to trusting whatever name the client sends, which
// is precisely the hole this replaces.
function loadSecret() {
  if (process.env.ORION_SECRET && process.env.ORION_SECRET.length >= 32) {
    return Buffer.from(process.env.ORION_SECRET, 'utf8');
  }
  const file = process.env.ORION_SECRET_FILE;
  if (file) {
    try {
      return Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'hex');
    } catch (e) {
      console.error('[orion-auth] could not read ORION_SECRET_FILE (' + file + '): ' + e.message);
    }
  }
  return null;
}

const SECRET = loadSecret();

// ── LOCAL DEVELOPMENT BYPASS ────────────────────────────────────────────────
//
// This accepts a join with NO TICKET AT ALL and takes the player's word for who
// they are. It exists for one reason: a clean clone of this repo could not run
// multiplayer locally in any form. The repo's client joins with a localStorage
// device token, the server wants a platform-signed ticket, and with no secret
// configured every single join was refused — so nothing multiplayer could be
// developed or tested without the whole Orion platform running alongside.
//
// It is an AUTHENTICATION BYPASS. Three independent conditions must all hold,
// and any one of them failing disables it:
//
//   1. ORION_DEV_AUTH=1            — explicit opt-in, never a default
//   2. NODE_ENV !== 'production'
//   3. NO SECRET IS CONFIGURED     — the important one
//
// Condition 3 is what makes this safe to have in the tree. Production resolves
// a secret (ORION_SECRET_FILE points at the platform's data/secret.key), so the
// bypass CANNOT engage there even if the env var were set by accident, on the
// wrong host, or by a stray line in a systemd unit. A server with real auth
// available will always use it; this can only ever be a fallback for a server
// that has none — which in production is already a total outage, not a downgrade.
//
// index.js additionally binds to loopback when this is on. See the note there.
const DEV_AUTH = process.env.ORION_DEV_AUTH === '1'
              && process.env.NODE_ENV !== 'production'
              && !SECRET;

if (SECRET) {
  console.log('[orion-auth] ticket verification active');
  if (process.env.ORION_DEV_AUTH === '1')
    console.warn('[orion-auth] ORION_DEV_AUTH is set but a real secret is configured — ' +
                 'the dev bypass is OFF and tickets are still required. This is intended.');
} else if (DEV_AUTH) {
  console.warn('');
  console.warn('  ####################################################################');
  console.warn('  #  DEV AUTH BYPASS ACTIVE — ANY CLIENT MAY CLAIM ANY NAME          #');
  console.warn('  #  No ticket is checked. Nothing here is authenticated.            #');
  console.warn('  #  Never run this anywhere the world server is reachable by         #');
  console.warn('  #  anyone you would not hand an account to.                        #');
  console.warn('  ####################################################################');
  console.warn('');
} else {
  console.error('[orion-auth] NO SECRET CONFIGURED — every join will be refused.');
  console.error('[orion-auth] Set ORION_SECRET, or ORION_SECRET_FILE to the platform\'s data/secret.key.');
  console.error('[orion-auth] For local development only, ORION_DEV_AUTH=1 skips ticket checks entirely.');
}

// Returns the ticket's claims, or null if it is missing, malformed, forged,
// expired, or minted for a different game.
function verifyGameTicket(ticket, gameId) {
  if (!SECRET) return null;
  try {
    const parts = String(ticket).split('.');
    const body = parts[0], sig = parts[1];
    if (!body || !sig) return null;

    const expect = crypto.createHmac('sha256', SECRET).update(body).digest('base64url');
    const a = Buffer.from(sig), b = Buffer.from(expect);
    // Length check first: timingSafeEqual throws on a mismatch.
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

    const claims = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (claims.exp < Date.now()) return null;
    if (gameId && claims.game !== gameId) return null;
    return claims;
  } catch {
    return null;
  }
}

// Identity for a dev-mode join: whatever the client says it is.
//
// Returns null unless every DEV_AUTH condition holds, so the caller can use it
// unconditionally — there is no code path where this grants access on a server
// that has a secret.
//
// The uid is derived from the name so a dev player keeps the same save across
// reconnects, and is prefixed `dev:` so it can never collide with a real Orion
// account id in storage.
function devAuthClaims(options) {
  if (!DEV_AUTH) return null;
  const raw = (options && typeof options.name === 'string') ? options.name : '';
  const name = raw.replace(/[^\w \-']/g, '').trim().slice(0, 16) || 'DevPlayer';
  return { uid: 'dev:' + name.toLowerCase(), name, slot: 0, dev: true };
}

module.exports = { verifyGameTicket, devAuthClaims, hasSecret: !!SECRET, DEV_AUTH };
