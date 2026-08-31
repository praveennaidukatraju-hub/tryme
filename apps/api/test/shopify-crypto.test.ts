import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decryptToken, encryptToken } from '../src/lib/crypto.js';

const KEY = randomBytes(32).toString('base64');

describe('token crypto', () => {
  it('round-trips a token', () => {
    const enc = encryptToken('shpat_secret_value', KEY);
    expect(enc).not.toContain('shpat_secret_value');
    expect(enc.split(':')).toHaveLength(3);
    expect(decryptToken(enc, KEY)).toBe('shpat_secret_value');
  });

  it('fails to decrypt with a wrong key', () => {
    const enc = encryptToken('x', KEY);
    const wrong = randomBytes(32).toString('base64');
    expect(() => decryptToken(enc, wrong)).toThrow();
  });

  it('produces a different ciphertext each call (random IV)', () => {
    expect(encryptToken('x', KEY)).not.toBe(encryptToken('x', KEY));
  });
});
