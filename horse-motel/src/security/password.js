// Password hashing with scrypt (memory-hard, built into Node, no native addon).
// Parameters follow OWASP guidance: N=2^17, r=8, p=1.
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import os from 'node:os';

const scryptRaw = promisify(crypto.scrypt);
const N = 2 ** 17, R = 8, P = 1, KEYLEN = 64;
const MAXMEM = 256 * 1024 * 1024;

// Each hash takes ~128 MB and ~0.4 s. Run a few at once (2–4, by CPU count) with a short queue, so a
// flood of sign-in attempts gets a quick "busy" answer instead of exhausting memory/CPU.
const MAX_ACTIVE = Math.max(2, Math.min(4, (os.availableParallelism?.() ?? 2) - 1)), MAX_QUEUED = 16;
let active = 0;
const queue = [];
export class HashBusyError extends Error {}

async function scrypt(...args) {
  if (active >= MAX_ACTIVE) {
    if (queue.length >= MAX_QUEUED) throw new HashBusyError('busy');
    await new Promise((resolve) => queue.push(resolve)); // a finishing hash hands us its slot
  } else {
    active++;
  }
  try { return await scryptRaw(...args); }
  finally {
    const next = queue.shift();
    if (next) next(); else active--;
  }
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password.normalize('NFKC'), salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

export async function verifyPassword(password, stored) {
  if (typeof stored !== 'string' || !stored.startsWith('scrypt$')) {
    // Burn comparable time so "no such user" and "wrong password" look the same.
    await scrypt('x', 'dummy-salt-value', KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
    return false;
  }
  const [, n, r, p, salt, key] = stored.split('$');
  const expected = Buffer.from(key, 'base64');
  const actual = await scrypt(password.normalize('NFKC'), Buffer.from(salt, 'base64'), expected.length,
    { N: +n, r: +r, p: +p, maxmem: MAXMEM });
  return crypto.timingSafeEqual(actual, expected);
}

// Length beats composition rules (NIST 800-63B). Block the obvious ones.
const COMMON = new Set(['password1234', 'passwordpassword', '123456789012', 'qwertyuiopas',
  'iloveyou1234', 'letmein12345', 'welcome12345', 'horsehorse12', 'rockincranch', 'changeme1234']);

export function passwordProblem(password, { email = '' } = {}) {
  if (typeof password !== 'string') return 'Enter a password.';
  if (password.length < 12) return 'Use at least 12 characters.';
  if (password.length > 128) return 'Use 128 characters or fewer.';
  const lower = password.toLowerCase();
  if (COMMON.has(lower) || /^(.)\1+$/.test(password)) return 'That password is too easy to guess.';
  const local = email.split('@')[0].toLowerCase();
  if (local.length >= 4 && lower.includes(local)) return "Don't include your email address in your password.";
  return null;
}
