import fp from 'fastify-plugin';
import { Redis } from 'ioredis';

function retryStrategy(times: number): number | null {
  return Math.min(times * 200, 5000);
}

declare module 'fastify' {
  interface FastifyInstance {
    // General-purpose client. Bounded retries — fails fast on a Redis blip rather
    // than queuing forever, since every normal caller (rate-limit, checkRateLimit
    // in shopify/customer.routes.ts, resolution-config.ts, nonce/presign lookups,
    // ...) expects a near-instant round trip. Do NOT issue blocking commands
    // (BLOCK/BLPOP/etc.) on this client — see redisBlocking below for why.
    redis: Redis;
    redisSub: Redis;
    // Dedicated client for shopify/sync-consumer.ts's blocking XREADGROUP loop
    // ONLY. maxRetriesPerRequest: null is correct there (queue forever while
    // legitimately blocked waiting for stream entries) but is actively dangerous
    // on a client anything else shares: Redis commands are strictly ordered on a
    // single connection, so a fast command queued behind an in-flight BLOCK
    // read waits through one or more of its ~5s cycles. That's the exact
    // mechanism that caused the Shopify customer/presign → customer/jobs 100%
    // drop-off (presign never failed, it was just slow enough the widget
    // abandoned before reaching the next step) — first found in checkRateLimit
    // sharing this client, missed on the first pass that resolution-config.ts's
    // getTryonCreditCost() (used by job creation) shared it too. Isolating the
    // one caller doing something unusual, instead of hunting down every other
    // caller, is what actually closes this class of bug for good.
    redisBlocking: Redis;
  }
}
export const redisPlugin = fp(async (app) => {
  const redis = new Redis(app.env.REDIS_URL, { maxRetriesPerRequest: 2, retryStrategy });
  const redisSub = new Redis(app.env.REDIS_URL, { maxRetriesPerRequest: null, retryStrategy });
  const redisBlocking = new Redis(app.env.REDIS_URL, { maxRetriesPerRequest: null, retryStrategy });

  for (const [name, client] of [
    ['redis', redis],
    ['redisSub', redisSub],
    ['redisBlocking', redisBlocking],
  ] as const) {
    client.on('error', (err) => app.log.warn({ err, client: name }, 'redis client error'));
    client.on('reconnecting', () => app.log.warn({ client: name }, 'redis client reconnecting'));
  }

  app.decorate('redis', redis);
  app.decorate('redisSub', redisSub);
  app.decorate('redisBlocking', redisBlocking);
  app.addHook('onClose', async () => {
    redis.disconnect();
    redisSub.disconnect();
    redisBlocking.disconnect();
  });
});
