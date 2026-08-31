import type { schema } from '@tryme/db';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { buildPostInstallRedirect, EMBEDDED_SPA_PATH } from './auth.routes.js';
import { confirmPurchase, createPurchase } from './purchase.js';

const PurchaseBody = z.object({ packId: z.string().min(1).max(64) });
const ConfirmQuery = z.object({ purchase: z.string().uuid() });
const ReturnQuery = z.object({
  purchase: z.string().uuid(),
  shop: z.string().min(1),
  charge_id: z.string().optional(),
});

export async function shopifyPurchaseRoutes(app: FastifyInstance) {
  app.post(
    '/v1/shopify/billing/purchase',
    { preHandler: app.requireShopifySession, schema: { body: PurchaseBody } },
    async (req) => {
      const store = req.shopifyStore as typeof schema.shopifyStores.$inferSelect;
      const { packId } = req.body as z.infer<typeof PurchaseBody>;
      return createPurchase(app, store, packId);
    },
  );

  // Unauthenticated by necessity — this is exactly where Shopify's
  // post-approval redirect lands, before the merchant has any session token.
  // `shop` comes straight from a query param Shopify echoes back through the
  // returnUrl we registered, not from anything the caller can use to act on
  // another store's data: this route only ever builds and issues a redirect,
  // never reads or writes a purchase. `confirmPurchase` (reached only once
  // re-embedded) re-derives `store` from that shop's own authenticated
  // session and 404s on a `purchase` row belonging to a different store — see
  // its own `row.storeId !== store.id` check — so a forged `shop` here can at
  // most misdirect where the browser lands, not which store's credits get
  // touched.
  app.get(
    '/v1/shopify/billing/purchase/return',
    { schema: { querystring: ReturnQuery } },
    async (req, reply) => {
      const { purchase, shop, charge_id: chargeId } = req.query as z.infer<typeof ReturnQuery>;
      const path = `${EMBEDDED_SPA_PATH}/billing/callback?purchase=${purchase}${chargeId ? `&charge_id=${chargeId}` : ''}`;
      const apiKey = app.env.SHOPIFY_API_KEY;
      const storeHandle = shop.replace(/\.myshopify\.com$/, '');
      // SHOPIFY_API_KEY is optional in the env schema — see appLinkFor's
      // identical guard in alert-scheduler.ts. Without it, falling straight
      // through to buildPostInstallRedirect would produce `.../apps/` with an
      // empty handle and 404 a merchant who just approved a real charge.
      return reply.redirect(
        apiKey
          ? buildPostInstallRedirect(shop, apiKey, path)
          : `https://admin.shopify.com/store/${storeHandle}/apps`,
      );
    },
  );

  app.get(
    '/v1/shopify/billing/purchase/confirm',
    { preHandler: app.requireShopifySession, schema: { querystring: ConfirmQuery } },
    async (req) => {
      const store = req.shopifyStore as typeof schema.shopifyStores.$inferSelect;
      const { purchase } = req.query as z.infer<typeof ConfirmQuery>;
      return confirmPurchase(app, store, purchase);
    },
  );
}
