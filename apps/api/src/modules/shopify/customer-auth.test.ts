import Redis from 'ioredis-mock';
import { describe, expect, it } from 'vitest';
import { mintAccountLinkCode, resolveAccountLinkCode } from './customer-auth.js';

describe('shopify customer account link', () => {
  it('mints a one-time code that resolves to the userId once, then is gone', async () => {
    const redis = new Redis();
    const userId = 'user-123';
    const code = await mintAccountLinkCode(redis as never, userId);
    expect(await resolveAccountLinkCode(redis as never, code)).toBe(userId);
    expect(await resolveAccountLinkCode(redis as never, code)).toBeNull();
  });
});
