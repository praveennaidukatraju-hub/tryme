import { schema } from '@tryme/db';
import { and, count, eq, gte, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { computeRunway } from './runway.js';
import { windowStart } from './store-day.js';

/**
 * Activation-aware count of products effectively enabled for try-on, for the
 * Dashboard's "Try-On Enabled" stat and the onboarding gate. Must agree with
 * the precedence rule in `activation.ts` (`computeEffectiveEnabled`):
 * exclusion — individual or via an excluded collection — always wins, even
 * under global mode.
 *
 * Global mode: every synced, non-deleted product counts except ones excluded
 * (individually or via an excluded collection).
 *
 * Selective mode: the union of individually-enabled products and products
 * reachable through an enabled collection, minus the same exclusions. Counted
 * as one query over `shopify_product_garments` with EXISTS subqueries so each
 * product is counted at most once (no double counting between the two
 * enablement paths).
 */
async function computeEnabledProductCount(
  app: FastifyInstance,
  store: typeof schema.shopifyStores.$inferSelect,
): Promise<number> {
  const mode = store.settings.activation?.mode ?? 'selective';

  const notExcludedByCollection = sql`NOT EXISTS (
    SELECT 1 FROM shopify_collection_products cp
    JOIN shopify_excluded_collections xc
      ON xc.store_id = cp.store_id AND xc.shopify_collection_id = cp.shopify_collection_id
    WHERE cp.store_id = pg.store_id AND cp.shopify_product_id = pg.shopify_product_id
  )`;

  const enabledViaCollection = sql`EXISTS (
    SELECT 1 FROM shopify_collection_products cp
    JOIN shopify_enabled_collections ec
      ON ec.store_id = cp.store_id AND ec.shopify_collection_id = cp.shopify_collection_id
    WHERE cp.store_id = pg.store_id AND cp.shopify_product_id = pg.shopify_product_id
  )`;

  const enablementCondition =
    mode === 'global' ? sql`true` : sql`(pg.enabled = true OR ${enabledViaCollection})`;

  const result = await app.db.execute<{ cnt: number }>(sql`
    SELECT COUNT(*)::int AS cnt
    FROM shopify_product_garments pg
    WHERE pg.store_id = ${store.id}
      AND pg.status <> 'deleted'
      AND pg.excluded = false
      AND ${notExcludedByCollection}
      AND ${enablementCondition}
  `);
  return (result as unknown as Array<{ cnt: number }>)[0]?.cnt ?? 0;
}

export async function shopifyMeRoutes(app: FastifyInstance) {
  app.get('/v1/shopify/me', { preHandler: app.requireShopifySession }, async (req) => {
    const store = req.shopifyStore as typeof schema.shopifyStores.$inferSelect;

    // Supersedes the bare balance lookup: the SPA needs the level and the
    // runway to render a banner, and computing it here keeps one definition of
    // "low" shared with the scheduler instead of duplicating thresholds in the
    // frontend where they would drift.
    const runway = await computeRunway(app, store.id);
    // computeRunway already ran a byte-identical COUNT(*) over jobs WHERE
    // shopify_store_id = ? for `lifetimeJobs` — reuse it instead of a second
    // round trip for the same number.
    const totalTryOns = runway.lifetimeJobs;

    const [{ syncedProductCount }] = await app.db
      .select({ syncedProductCount: count() })
      .from(schema.shopifyProductGarments)
      .where(eq(schema.shopifyProductGarments.storeId, store.id));

    const enabledProductCount = await computeEnabledProductCount(app, store);

    const [{ activeCount, processingCount, failedCount, disabledCount }] = await app.db
      .select({
        activeCount: sql<number>`COUNT(*) FILTER (WHERE ${schema.shopifyProductGarments.enabled} = true AND ${schema.shopifyProductGarments.status} = 'active')::int`,
        processingCount: sql<number>`COUNT(*) FILTER (WHERE ${schema.shopifyProductGarments.enabled} = true AND ${schema.shopifyProductGarments.status} = 'processing')::int`,
        failedCount: sql<number>`COUNT(*) FILTER (WHERE ${schema.shopifyProductGarments.enabled} = true AND ${schema.shopifyProductGarments.status} = 'failed')::int`,
        disabledCount: sql<number>`COUNT(*) FILTER (WHERE ${schema.shopifyProductGarments.enabled} = false OR ${schema.shopifyProductGarments.status} = 'deleted')::int`,
      })
      .from(schema.shopifyProductGarments)
      .where(eq(schema.shopifyProductGarments.storeId, store.id));

    // Derived from Postgres, not the Redis cap counter: the merchant-facing
    // number must stay correct even if Redis has been flushed and the guard
    // has lost the day.
    const [{ todayTryOns }] = await app.db
      .select({ todayTryOns: count() })
      .from(schema.jobs)
      .where(
        and(
          eq(schema.jobs.shopifyStoreId, store.id),
          gte(schema.jobs.createdAt, windowStart(store.ianaTimezone, 'day')),
        ),
      );

    const [{ capturedEmailCount }] = await app.db
      .select({ capturedEmailCount: count() })
      .from(schema.shopifyShoppers)
      .where(
        and(
          eq(schema.shopifyShoppers.storeId, store.id),
          sql`${schema.shopifyShoppers.email} IS NOT NULL`,
        ),
      );

    // Dashboard's free-credits tile stays up until the store has paid for a
    // pack at least once (manual or autorefill — both land here with the same
    // status field) — 'ACTIVE' is Shopify's AppPurchaseOneTime status for a
    // charge that actually went through, matching the same check
    // grantForPurchase already gates the credit grant on.
    const [{ hasPurchasedPack }] = await app.db
      .select({ hasPurchasedPack: sql<boolean>`count(*) > 0` })
      .from(schema.shopifyCreditPurchases)
      .where(
        and(
          eq(schema.shopifyCreditPurchases.storeId, store.id),
          eq(schema.shopifyCreditPurchases.status, 'ACTIVE'),
        ),
      );

    return {
      store: {
        shopDomain: store.shopDomain,
        // Prefills the email-bonus popup — auto-captured from `shop.email` at
        // install, so it's usually already correct and just needs confirming.
        shopEmail: store.shopEmail,
        settings: store.settings,
        connectedSince: store.installedAt.toISOString(),
      },
      creditBalance: runway.balance,
      hasPurchasedPack,
      runway: {
        balance: runway.balance,
        tryOnsRemaining: runway.tryOnsRemaining,
        dailyBurnCredits: runway.dailyBurnCredits,
        daysRemaining: runway.daysRemaining,
        level: runway.level,
      },
      autorefill: {
        enabled: store.autorefillStatus != null,
        status: store.autorefillStatus,
        packId: store.autorefillPackId,
        triggerCredits: store.autorefillTriggerCredits,
        cappedAmountUsdCents: store.autorefillCappedAmountCents,
        // Read straight from Postgres like everything else here — refreshed
        // from Shopify by the hourly sweep, not by this route. A dashboard
        // load must not cost a Shopify round trip, and this figure only has to
        // be roughly current to be useful: it exists to show the merchant how
        // much of their own ceiling this cycle has consumed.
        balanceUsedUsdCents: store.autorefillBalanceUsedCents,
      },
      stats: {
        totalTryOns,
        syncedProductCount,
        enabledProductCount,
        statusCounts: {
          active: activeCount,
          processing: processingCount,
          failed: failedCount,
          disabled: disabledCount,
        },
        todayTryOns,
        storeDailyCap: store.settings.limits?.storeDailyCap ?? null,
        capturedEmailCount,
      },
    };
  });
}
