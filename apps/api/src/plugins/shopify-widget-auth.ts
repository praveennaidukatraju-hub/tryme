import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import fp from 'fastify-plugin';
import { AppError } from '../lib/errors.js';
import { isShopifyPreviewOrigin } from '../lib/shopify-origin.js';
import { verifyAppProxySignature } from '../modules/shopify/service.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// SEC-7.1: a request forwarded through Shopify's App Proxy is signed by Shopify
// itself (see verifyAppProxySignature) — there is no client-supplied secret to
// steal, unlike the legacy X-Widget-Key path below. Requests older than this are
// rejected even with a valid signature, so a captured proxy URL can't be replayed
// indefinitely (Shopify's own proxy calls are effectively instantaneous).
const APP_PROXY_MAX_AGE_SEC = 300;

export const shopifyWidgetAuthPlugin = fp(async (app) => {
  app.decorate('requireShopifyStoreKey', async (req, _reply) => {
    const query = req.query as Record<string, string | string[]> | undefined;

    // App Proxy path (preferred): Shopify signs the forwarded request itself.
    if (query && typeof query.signature === 'string') {
      const secret = app.env.SHOPIFY_API_SECRET;
      if (!secret || !verifyAppProxySignature(query, secret)) {
        throw new AppError('UNAUTHORIZED', 401, 'Invalid app proxy signature');
      }
      const timestamp = Number(query.timestamp);
      if (
        !Number.isFinite(timestamp) ||
        Math.abs(Date.now() / 1000 - timestamp) > APP_PROXY_MAX_AGE_SEC
      ) {
        throw new AppError('UNAUTHORIZED', 401, 'App proxy request expired');
      }
      const shop = typeof query.shop === 'string' ? query.shop : undefined;
      if (!shop) throw new AppError('UNAUTHORIZED', 401, 'Missing shop parameter');
      const [store] = await app.db
        .select()
        .from(schema.shopifyStores)
        .where(eq(schema.shopifyStores.shopDomain, shop))
        .limit(1);
      if (!store || store.uninstalledAt) {
        throw new AppError('UNAUTHORIZED', 401, 'Invalid or inactive store');
      }
      req.shopifyStoreId = store.id;
      req.shopifyStoreRow = store;
      return;
    }

    // Legacy path: a static per-store key baked into the theme's rendered HTML
    // (SEC-7.1) — being phased out as merchants' themes pick up the App
    // Proxy-based widget script. Kept so already-rendered/cached widget pages
    // don't break mid-rollout.
    const key = req.headers['x-widget-key'];
    if (!key || typeof key !== 'string') {
      throw new AppError('UNAUTHORIZED', 401, 'Missing X-Widget-Key header');
    }
    // storeKey is a uuid column — a malformed value would otherwise reach Postgres
    // as an invalid input syntax error (unhandled, 500) instead of the intended 401.
    if (!UUID_RE.test(key)) {
      throw new AppError('UNAUTHORIZED', 401, 'Invalid or inactive store key');
    }
    const [store] = await app.db
      .select()
      .from(schema.shopifyStores)
      .where(eq(schema.shopifyStores.storeKey, key))
      .limit(1);
    if (!store || store.uninstalledAt) {
      throw new AppError('UNAUTHORIZED', 401, 'Invalid or inactive store key');
    }
    if (store.allowedOrigins.length > 0) {
      const origin = req.headers.origin ?? '';
      if (!store.allowedOrigins.includes(origin) && !isShopifyPreviewOrigin(origin)) {
        throw new AppError('FORBIDDEN', 403, 'Origin not allowed');
      }
    }
    req.shopifyStoreId = store.id;
    req.shopifyStoreRow = store;
  });
});

import type { InferSelectModel } from 'drizzle-orm';

declare module 'fastify' {
  interface FastifyRequest {
    shopifyStoreId?: string;
    shopifyStoreRow?: InferSelectModel<typeof schema.shopifyStores>;
  }
  interface FastifyInstance {
    requireShopifyStoreKey: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}
