import type { FastifyInstance } from 'fastify';

/** Caches a response for 24h keyed on (namespace, scopeId, Idempotency-Key header).
 *  No-op when the header is absent — backward compatible. */
export async function withIdempotency<T>(
  app: FastifyInstance,
  namespace: string,
  scopeId: string,
  idemKey: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  const redisKey = idemKey ? `idem:${namespace}:${scopeId}:${idemKey}` : null;
  if (redisKey) {
    const hit = await app.redis.get(redisKey);
    if (hit) return JSON.parse(hit) as T;
  }
  const result = await fn();
  if (redisKey) await app.redis.setex(redisKey, 86400, JSON.stringify(result));
  return result;
}
