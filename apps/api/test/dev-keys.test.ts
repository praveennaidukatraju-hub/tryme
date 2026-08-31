import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { API_KEY_RE, extractBearer, generateApiKey, hashApiKey } from '../src/modules/dev/keys.js';

describe('generateApiKey', () => {
  it('produces a key matching the documented format', () => {
    const { key } = generateApiKey();
    expect(key).toMatch(API_KEY_RE);
    expect(key.startsWith('sk_live_')).toBe(true);
    expect(key.length).toBe(8 + 43);
  });

  it('returns the sha256 hex of the key as keyHash', () => {
    const { key, keyHash } = generateApiKey();
    expect(keyHash).toBe(createHash('sha256').update(key).digest('hex'));
  });

  it('returns a prefix that is a strict, non-authenticating substring', () => {
    const { key, keyPrefix } = generateApiKey();
    expect(keyPrefix).toBe(key.slice(0, 12));
    expect(keyPrefix.length).toBeLessThan(key.length);
  });

  it('never repeats a key', () => {
    const keys = new Set(Array.from({ length: 500 }, () => generateApiKey().key));
    expect(keys.size).toBe(500);
  });
});

describe('hashApiKey', () => {
  it('is deterministic', () => {
    expect(hashApiKey('sk_live_abc')).toBe(hashApiKey('sk_live_abc'));
  });

  it('differs for different keys', () => {
    expect(hashApiKey('sk_live_abc')).not.toBe(hashApiKey('sk_live_abd'));
  });
});

describe('API_KEY_RE', () => {
  it('rejects malformed keys', () => {
    expect(API_KEY_RE.test('sk_live_short')).toBe(false);
    expect(API_KEY_RE.test('sk_test_' + 'a'.repeat(43))).toBe(false);
    expect(API_KEY_RE.test('a'.repeat(43))).toBe(false);
    expect(API_KEY_RE.test("sk_live_' OR 1=1--")).toBe(false);
    expect(API_KEY_RE.test('sk_live_' + 'a'.repeat(44))).toBe(false);
  });

  it('is not sticky (safe to reuse across calls)', () => {
    const { key } = generateApiKey();
    expect(API_KEY_RE.test(key)).toBe(true);
    expect(API_KEY_RE.test(key)).toBe(true);
  });
});

describe('extractBearer', () => {
  it('extracts a bearer token', () => {
    expect(extractBearer('Bearer sk_live_x')).toBe('sk_live_x');
  });

  it('returns undefined for missing or non-bearer headers', () => {
    expect(extractBearer(undefined)).toBeUndefined();
    expect(extractBearer('Basic abc')).toBeUndefined();
    expect(extractBearer('sk_live_x')).toBeUndefined();
  });
});
