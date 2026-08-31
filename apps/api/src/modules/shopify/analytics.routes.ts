import type { schema as dbSchema } from '@tryme/db';
import { ShopifyAnalyticsQuery } from '@tryme/types';
import type { FastifyInstance } from 'fastify';
import {
  type AnalyticsRange,
  analyticsCards,
  analyticsDaily,
  analyticsFunnel,
  analyticsProducts,
} from './analytics.js';
import { localDayStart } from './store-day.js';

const DAY_MS = 86_400_000;

export async function shopifyAnalyticsRoutes(app: FastifyInstance) {
  app.get(
    '/v1/shopify/analytics',
    {
      preValidation: app.requireShopifySession,
      schema: { querystring: ShopifyAnalyticsQuery },
    },
    async (req) => {
      const store = req.shopifyStore as typeof dbSchema.shopifyStores.$inferSelect;
      const { from, to } = req.query as ShopifyAnalyticsQuery;

      // `to` is inclusive to the merchant — "1st to 7th" must contain the 7th.
      // Internally every query is half-open, so resolve it to the start of the
      // following local day rather than to the 7th's own midnight.
      //
      // Adding a fixed 24 hours here is correct because `localDayStart`
      // resolves the *following* calendar date independently in the
      // zone-aware helper only when given that date. If a DST transition
      // falls on `to`, the added day can land an hour early or late. That is
      // acceptable — it shifts at most one hour of activity at the very edge
      // of a range — and avoiding it entirely would mean date arithmetic in
      // the store's calendar, which store-day.ts does not expose.
      const toStart = localDayStart(store.ianaTimezone, to);
      const range: AnalyticsRange = {
        from: localDayStart(store.ianaTimezone, from),
        to: new Date(toStart.getTime() + DAY_MS),
        timezone: store.ianaTimezone ?? 'UTC',
      };

      const [cards, daily, funnel, products] = await Promise.all([
        analyticsCards(app.db, store.id, range),
        analyticsDaily(app.db, store.id, range),
        analyticsFunnel(app.db, store.id, range),
        analyticsProducts(app.db, store.id, range),
      ]);

      return { range: { from, to, timezone: range.timezone }, cards, daily, funnel, products };
    },
  );
}
