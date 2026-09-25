// Encrypts secrets that must be stored but never read back by people: authenticator
// (TOTP) secrets and camera addresses, which often carry the camera's password.
// AES-256-GCM with a key from DATA_KEY (required in production). A copied database file
// alone is then useless for faking 2-step codes or reaching the cameras.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

let key = null;

export function initSecretBox(cfg) {
  if (cfg.dataKey) {
    key = Buffer.from(cfg.dataKey, 'base64');
  } else if (cfg.test) {
    key = crypto.randomBytes(32);
  } else {
    // Development only (config refuses production without DATA_KEY): keep a local key file.
    const file = path.join(cfg.dataDir, 'secret.key');
    fs.mkdirSync(cfg.dataDir, { recursive: true, mode: 0o700 });
    if (!fs.existsSync(file)) fs.writeFileSync(file, crypto.randomBytes(32).toString('base64'), { mode: 0o600 });
    key = Buffer.from(fs.readFileSync(file, 'utf8').trim(), 'base64');
  }
  if (key.length !== 32) throw new Error('DATA_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)');
}

export function seal(plain) {
  if (plain === null || plain === undefined || plain === '') return plain;
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return `enc:v1:${iv.toString('base64')}:${c.getAuthTag().toString('base64')}:${ct.toString('base64')}`;
}

export function unseal(stored) {
  if (typeof stored !== 'string' || !stored.startsWith('enc:v1:')) return stored; // legacy plaintext
  const [, , iv, tag, ct] = stored.split(':');
  const d = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(ct, 'base64')), d.final()]).toString('utf8');
}
