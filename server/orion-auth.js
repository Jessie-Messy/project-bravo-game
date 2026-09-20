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

if (!SECRET) {
  console.error('[orion-auth] NO SECRET CONFIGURED — every join will be refused.');
  console.error('[orion-auth] Set ORION_SECRET, or ORION_SECRET_FILE to the platform\'s data/secret.key.');
} else {
  console.log('[orion-auth] ticket verification active');
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

module.exports = { verifyGameTicket, hasSecret: !!SECRET };
