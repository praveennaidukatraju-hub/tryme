import { schema } from '@tryme/db';
import { ShopifyWidgetEventRequest } from '@tryme/types';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Redis } from 'ioredis';

// Far higher than the 60/min per store that customer.routes.ts applies to job
// creation: one busy store legitimately produces hundreds of events a minute,
// and this endpoint costs a single insert rather than a generation.
const EVENTS_PER_MINUTE = 600;

/** @returns true when this event is within budget and should be stored. */
async function withinEventBudget(redis: Redis, storeId: string): Promise<boolean> {
  const key = `shopify:events:rl:${storeId}`;
  const [[, used], [, ttl]] = (await redis.pipeline().incr(key).ttl(key).exec()) as [
    [null, number],
    [null, number],
  ];
  if (ttl === -1) await redis.expire(key, 60);
  return used <= EVENTS_PER_MINUTE;
}

// SEC-7.1: also registered at the App Proxy-forwarded path — see
// customer.routes.ts's registerProxied for why.
const PROXY_PATH = '/v1/shopify/proxy/customer/event';

export async function shopifyEventsRoutes(app: FastifyInstance) {
  const opts = {
    preValidation: app.requireShopifyStoreKey,
    schema: { body: ShopifyWidgetEventRequest },
  };
  const handler = async (req: FastifyRequest, reply: FastifyReply) => {
    const storeId = req.shopifyStoreId as string;
    const body = req.body as ShopifyWidgetEventRequest;

    // Everything below is best-effort. This endpoint sits in the widget's hot
    // path, and a shopper must never see a failure caused by our bookkeeping
    // — so an over-budget event and a broken database look identical from the
    // storefront: 204, nothing stored.
    try {
      if (await withinEventBudget(app.redis, storeId)) {
        await app.db.insert(schema.shopifyWidgetEvents).values({
          storeId,
          clientId: body.clientId ?? null,
          shopifyProductId: body.shopifyProductId ?? null,
          type: body.type,
          device: body.device ?? null,
        });
      }
    } catch (err) {
      req.log.warn({ err, storeId }, 'shopify widget event dropped');
    }

    return reply.code(204).send();
  };

  app.post('/v1/shopify/customer/event', opts, handler);
  app.post(PROXY_PATH, opts, handler);
}
