import { describe, expect, it, vi } from 'vitest';
import { assertMerchantJobRateLimit } from '../src/lib/job-rate-limit.js';

function fakeApp(opts: { jobRateLimitPerMin: number | null; incrValues: number[] }) {
  let call = 0;
  const redis = {
    incr: vi.fn(async () => opts.incrValues[call++] ?? opts.incrValues[opts.incrValues.length - 1]),
    expire: vi.fn(async () => 1),
  };
  const db = {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve([{ jobRateLimitPerMin: opts.jobRateLimitPerMin }]),
      }),
    }),
  };
  // biome-ignore lint/suspicious/noExplicitAny: minimal fake FastifyInstance for a unit test
  return { redis, db } as any;
}

describe('assertMerchantJobRateLimit', () => {
  it('allows requests under the limit', async () => {
    const app = fakeApp({ jobRateLimitPerMin: 15, incrValues: [1] });
    await expect(assertMerchantJobRateLimit(app, 'user-1')).resolves.toBeUndefined();
    expect(app.redis.expire).toHaveBeenCalledWith(expect.any(String), 60);
  });

  it('rejects the request that crosses the limit', async () => {
    const app = fakeApp({ jobRateLimitPerMin: 15, incrValues: [16] });
    await expect(assertMerchantJobRateLimit(app, 'user-1')).rejects.toMatchObject({
      code: 'RATE_LIMITED',
      statusCode: 429,
    });
  });

  it('falls back to DEFAULT_JOB_RATE_LIMIT_PER_MIN when the merchant has no override', async () => {
    const app = fakeApp({ jobRateLimitPerMin: null, incrValues: [16] });
    await expect(assertMerchantJobRateLimit(app, 'user-1')).rejects.toMatchObject({
      code: 'RATE_LIMITED',
    });
  });

  it('does not call expire on the second and later request in the same window', async () => {
    const app = fakeApp({ jobRateLimitPerMin: 15, incrValues: [2] });
    await assertMerchantJobRateLimit(app, 'user-1');
    expect(app.redis.expire).not.toHaveBeenCalled();
  });
});
