import { DEV_WIDGET_KEY_RATE_LIMIT_PER_MIN } from '@tryme/types';
import type { FastifyInstance } from 'fastify';
import { AppError } from './errors.js';

/**
 * Fixed-window (per-UTC-minute) counter keyed by apiKeyId, mirroring
 * job-rate-limit.ts's assertMerchantJobRateLimit. Applied only to widget-scoped
 * keys (checked by the caller via req.apiKeyScope === 'widget') on the two
 * routes a storefront widget calls: /v1/dev/tryon and /v1/dev/jobs/:id.
 *
 * Fails open on a Redis error, matching server.ts's `skipOnError: true` on the
 * general rate limiter: a Redis blip must not turn into a wall of 500s on a
 * safety-net check.
 */
export async function assertWidgetKeyRateLimit(
  app: FastifyInstance,
  apiKeyId: string,
): Promise<void> {
  const bucket = Math.floor(Date.now() / 60_000);
  const key = `widget-key-rate:${apiKeyId}:${bucket}`;

  let count: number;
  try {
    count = await app.redis.incr(key);
    if (count === 1) await app.redis.expire(key, 60);
  } catch (err) {
    app.log.warn({ err, apiKeyId }, 'widget key rate limit check failed open on redis error');
    return;
  }

  if (count > DEV_WIDGET_KEY_RATE_LIMIT_PER_MIN) {
    throw new AppError('RATE_LIMITED', 429, 'widget key request rate limit exceeded', {
      limit: DEV_WIDGET_KEY_RATE_LIMIT_PER_MIN,
    });
  }
}
