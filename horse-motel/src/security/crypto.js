import crypto from 'node:crypto';

// 256-bit random tokens, URL-safe. Only their SHA-256 is ever stored, so a database
// leak does not hand out live sessions or password links.
export const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

export function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

// Human-friendly booking reference: no 0/O/1/I confusion.
const ALPHA = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export function bookingRef() {
  const b = crypto.randomBytes(8);
  let s = 'RC-';
  for (let i = 0; i < 8; i++) s += ALPHA[b[i] % 32];
  return s;
}
