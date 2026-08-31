import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALG = 'aes-256-gcm';

function key(keyB64: string): Buffer {
  const k = Buffer.from(keyB64, 'base64');
  if (k.length !== 32) throw new Error('SHOPIFY_TOKEN_ENC_KEY must be 32 bytes (base64)');
  return k;
}

export function encryptToken(plaintext: string, keyB64: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALG, key(keyB64), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}:${tag.toString('base64')}:${ct.toString('base64')}`;
}

export function decryptToken(payload: string, keyB64: string): string {
  const [ivB64, tagB64, ctB64] = payload.split(':');
  if (!ivB64 || !tagB64 || !ctB64) throw new Error('malformed encrypted token');
  const decipher = createDecipheriv(ALG, key(keyB64), Buffer.from(ivB64, 'base64'));
  decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64')), decipher.final()]).toString(
    'utf8',
  );
}
