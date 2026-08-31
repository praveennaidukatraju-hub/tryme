import { describe, expect, it } from 'vitest';
import { countingIdentity, normalizeEmail } from './shopper.js';

const base = {
  id: 'row-1',
  storeId: 'store-1',
  clientId: 'client-abc',
  shopifyCustomerId: null as number | null,
  email: null as string | null,
  emailConsent: false,
  emailCapturedAt: null,
  firstSeenAt: new Date(),
  lastSeenAt: new Date(),
};

describe('countingIdentity', () => {
  it('prefers the shopify customer id above all else', () => {
    expect(countingIdentity({ ...base, shopifyCustomerId: 99, email: 'a@b.com' })).toEqual({
      kind: 'customer',
      value: 99,
    });
  });

  it('falls back to email when there is no customer id', () => {
    expect(countingIdentity({ ...base, email: 'A@B.com' })).toEqual({
      kind: 'email',
      value: 'a@b.com',
    });
  });

  it('falls back to the anonymous client id when nothing stronger exists', () => {
    expect(countingIdentity(base)).toEqual({ kind: 'client', value: 'client-abc' });
  });
});

describe('normalizeEmail', () => {
  it('lowercases and trims so casing cannot fork a counting bucket', () => {
    expect(normalizeEmail('  Foo@Example.COM ')).toBe('foo@example.com');
  });

  it('returns null for blank input', () => {
    expect(normalizeEmail('   ')).toBeNull();
    expect(normalizeEmail(undefined)).toBeNull();
  });
});
