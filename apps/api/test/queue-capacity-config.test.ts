import { describe, expect, it, vi } from 'vitest';
import { assertQueueCapacity, getMaxQueueDepth } from '../src/lib/queue-capacity-config.js';

function fakeApp(opts: { redisConfig?: string | null; queuedCount: number }) {
  const redis = { get: vi.fn(async () => opts.redisConfig ?? null) };
  const db = {
    select: () => ({
      from: () => ({
        where: () => Promise.resolve([{ c: opts.queuedCount }]),
      }),
    }),
  };
  // biome-ignore lint/suspicious/noExplicitAny: minimal fake FastifyInstance for a unit test
  return { redis, db } as any;
}

describe('getMaxQueueDepth', () => {
  it('returns the default when config:system holds no maxQueueDepth', async () => {
    const app = fakeApp({ redisConfig: null, queuedCount: 0 });
    expect(await getMaxQueueDepth(app)).toBe(50);
  });

  it('returns the admin-configured value when present', async () => {
    const app = fakeApp({ redisConfig: JSON.stringify({ maxQueueDepth: 5 }), queuedCount: 0 });
    expect(await getMaxQueueDepth(app)).toBe(5);
  });
});

describe('assertQueueCapacity', () => {
  it('allows the request when under the ceiling', async () => {
    const app = fakeApp({ redisConfig: JSON.stringify({ maxQueueDepth: 10 }), queuedCount: 5 });
    await expect(assertQueueCapacity(app, 3)).resolves.toBeUndefined();
  });

  it('rejects when the request would push past the ceiling', async () => {
    const app = fakeApp({ redisConfig: JSON.stringify({ maxQueueDepth: 10 }), queuedCount: 8 });
    await expect(assertQueueCapacity(app, 3)).rejects.toMatchObject({
      code: 'SERVER_BUSY',
      statusCode: 503,
    });
  });

  it('allows a request that lands exactly on the ceiling', async () => {
    const app = fakeApp({ redisConfig: JSON.stringify({ maxQueueDepth: 10 }), queuedCount: 7 });
    await expect(assertQueueCapacity(app, 3)).resolves.toBeUndefined();
  });
});
