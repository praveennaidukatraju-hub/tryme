import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import fp from 'fastify-plugin';
import { AppError } from '../lib/errors.js';
import { provisionShopifyStore } from '../modules/shopify/auth.routes.js';
import { verifySessionToken } from '../modules/shopify/service.js';
import { exchangeSessionToken } from '../modules/shopify/token.js';

/**
 * How long to hold the per-shop provisioning lock, and how patiently a loser
 * waits for the winner's row. Provisioning does a handful of Shopify round
 * trips (shop details, metafield, webhooks), so the lock outlives a slow one
 * without wedging the shop if a process dies mid-install.
 */
const PROVISION_LOCK_TTL_S = 60;
const PROVISION_WAIT_MS = 250;
const PROVISION_ATTEMPTS = 40;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type Store = typeof schema.shopifyStores.$inferSelect;

async function loadStore(app: FastifyInstance, shopDomain: string): Promise<Store | undefined> {
  const [store] = await app.db
    .select()
    .from(schema.shopifyStores)
    .where(eq(schema.shopifyStores.shopDomain, shopDomain))
    .limit(1);
  return store;
}

export const shopifyAuthPlugin = fp(async (app) => {
  app.decorate('requireShopifySession', async (req, _reply) => {
    const secret = app.env.SHOPIFY_API_SECRET;
    const apiKey = app.env.SHOPIFY_API_KEY;
    if (!secret || !apiKey) throw new AppError('CONFIG', 500, 'Shopify not configured');

    const auth = req.headers.authorization;
    const token = auth?.startsWith('Bearer ') ? auth.slice(7) : undefined;
    if (!token) throw new AppError('UNAUTHORIZED', 401, 'Missing session token');

    let shopDomain: string;
    try {
      ({ shopDomain } = verifySessionToken(token, secret, apiKey));
    } catch {
      throw new AppError('UNAUTHORIZED', 401, 'Invalid session token');
    }

    let store = await loadStore(app, shopDomain);

    // Under Shopify managed installation there is no OAuth callback to create
    // this row: Shopify installs the app and grants the TOML scopes without
    // calling us at all. A verified session token for a shop we have never
    // seen is therefore the *expected* first contact of a new install, not an
    // error — trade it for an offline access token and provision the store
    // here. `uninstalledAt` set means a reinstall, which arrives the same way.
    if (!store || store.uninstalledAt) {
      store = await provisionFromSessionToken(app, shopDomain, token, req.log);
    }

    req.shopifyStore = store;
  });
});

/**
 * Serialize first-contact provisioning per shop.
 *
 * The embedded app opens several requests at once on boot, and every one of
 * them arrives with a valid session token for a shop that has no row yet.
 * Without a lock each would run its own token exchange and its own webhook
 * registration. The loser waits for the winner's row rather than exchanging
 * again — the row is the shared result, so re-reading it is both cheaper and
 * more correct than racing.
 */
async function provisionFromSessionToken(
  app: FastifyInstance,
  shopDomain: string,
  sessionToken: string,
  log: FastifyBaseLogger,
): Promise<Store> {
  const lockKey = `shopify:provision:${shopDomain}`;
  const held = await app.redis.set(lockKey, '1', 'EX', PROVISION_LOCK_TTL_S, 'NX');

  if (!held) {
    for (let i = 0; i < PROVISION_ATTEMPTS; i++) {
      await sleep(PROVISION_WAIT_MS);
      const store = await loadStore(app, shopDomain);
      if (store && !store.uninstalledAt) return store;
    }
    // The holder died or is still going. Report it as not-installed rather
    // than provisioning in parallel; the next request retries cleanly.
    throw new AppError('FORBIDDEN', 403, 'Store not installed');
  }

  try {
    const { grant, scope } = await exchangeSessionToken(app, shopDomain, sessionToken);
    return await provisionShopifyStore(app, shopDomain, grant.accessToken, scope, grant, log);
  } finally {
    await app.redis.del(lockKey).catch(() => {
      // Best-effort: the TTL releases it anyway, just later.
    });
  }
}

import type { InferSelectModel } from 'drizzle-orm';

declare module 'fastify' {
  interface FastifyRequest {
    shopifyStore?: InferSelectModel<typeof schema.shopifyStores>;
  }
  interface FastifyInstance {
    requireShopifySession: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}
