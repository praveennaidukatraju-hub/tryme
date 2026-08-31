import { schema } from '@tryme/db';
import { DEFAULT_JOB_RATE_LIMIT_PER_MIN } from '@tryme/types';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { AppError } from './errors.js';

/**
 * Fixed-window (per-UTC-minute) counter, keyed by merchant — merchants.userId is
 * unique (one merchant per user), so merchantUserId is a valid per-merchant key
 * without needing a separate merchantId lookup. Scoped to job-creation calls
 * through createDevJobCore only — i.e. /v1/dev/tryon and /v1/dev/saree-mannequin,
 * NOT every /v1/dev/* route. /v1/dev/catalog/generate (dev/catalog.routes.ts)
 * creates jobs through a different path (createJob with source: API_CATALOG) and
 * is deliberately not covered by this limiter. Distinct from the flat per-key
 * request-volume limiter already on those routes.
 *
 * Fails open on a Redis error, matching server.ts's `skipOnError: true` on the
 * general rate limiter: a Redis blip must not turn into a wall of 500s on a
 * safety-net check.
 */
export async function assertMerchantJobRateLimit(
  app: FastifyInstance,
  merchantUserId: string,
): Promise<void> {
  const [merchant] = await app.db
    .select({ jobRateLimitPerMin: schema.merchants.jobRateLimitPerMin })
    .from(schema.merchants)
    .where(eq(schema.merchants.userId, merchantUserId));
  const limit = merchant?.jobRateLimitPerMin ?? DEFAULT_JOB_RATE_LIMIT_PER_MIN;

  const bucket = Math.floor(Date.now() / 60_000);
  const key = `job-rate:${merchantUserId}:${bucket}`;

  let count: number;
  try {
    count = await app.redis.incr(key);
    if (count === 1) await app.redis.expire(key, 60);
  } catch (err) {
    app.log.warn({ err, merchantUserId }, 'job rate limit check failed open on redis error');
    return;
  }

  if (count > limit) {
    throw new AppError(
      'RATE_LIMITED',
      429,
      'job submission rate limit exceeded, please slow down',
      { limit },
    );
  }
}
