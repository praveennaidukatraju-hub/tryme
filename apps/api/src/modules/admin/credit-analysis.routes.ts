import { schema } from '@tryme/db';
import { JOB_SOURCE } from '@tryme/types';
import { and, desc, eq, exists, gte, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { requirePermission } from './guard.js';

const SOURCES = [
  JOB_SOURCE.CATALOG,
  JOB_SOURCE.TRYON,
  JOB_SOURCE.SAREE,
  JOB_SOURCE.SHOPIFY,
] as const;
const DAY_RANGES = ['7', '30', '90', 'all'] as const;
type DayRange = (typeof DAY_RANGES)[number];
type SourceFilter = 'all' | (typeof SOURCES)[number];

const ListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().optional(),
  days: z.enum(DAY_RANGES).default('30'),
  source: z.enum(['all', ...SOURCES]).default('all'),
});

const DetailQuery = z.object({
  days: z.enum(DAY_RANGES).default('30'),
  source: z.enum(['all', ...SOURCES]).default('all'),
});

function sinceDate(days: DayRange): Date | null {
  if (days === 'all') return null;
  return new Date(Date.now() - Number(days) * 24 * 60 * 60 * 1000);
}

function sourceCondition(source: SourceFilter) {
  switch (source) {
    case 'shopify':
      // Real shopify jobs always set both source='shopify' and shopifyStoreId (see
      // apps/api/src/modules/shopify/customer.routes.ts), and historical rows were
      // backfilled to match — but match on either so the filter is robust even if
      // one of the two is ever missing.
      return sql`(${schema.jobs.source} = 'shopify' OR ${schema.jobs.shopifyStoreId} IS NOT NULL)`;
    case 'catalog':
    case 'tryon':
    case 'saree':
      return eq(schema.jobs.source, source);
    default:
      return sql`true`;
  }
}

// Jobs are attributed to whichever user "owns" them: jobs.userId directly,
// or — for the rare merchant-attributed job with no userId of its own — the
// user who owns the merchant profile (merchants.userId is a real 1:1 link;
// a merchant IS a user).
const rankedUserId = sql<string>`COALESCE(${schema.jobs.userId}, ${schema.merchants.userId})`;

export async function adminCreditAnalysisRoutes(app: FastifyInstance) {
  const ALL = requirePermission('credit_analysis.read');

  app.get(
    '/admin/credit-analysis/users',
    { preHandler: ALL, schema: { querystring: ListQuery } },
    async (req) => {
      const { page, pageSize, search, days, source } = req.query as z.infer<typeof ListQuery>;
      const since = sinceDate(days);

      let matchingUserIds: string[] | null = null;
      if (search) {
        const rows = await app.db
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(
            sql`${schema.users.email} ILIKE ${`%${search}%`} OR ${schema.users.displayName} ILIKE ${`%${search}%`}`,
          );
        matchingUserIds = rows.map((r) => r.id);
        if (matchingUserIds.length === 0) {
          return { page, pageSize, total: 0, items: [] };
        }
      }

      const conditions = [
        sourceCondition(source),
        since ? gte(schema.jobs.createdAt, since) : undefined,
        matchingUserIds ? inArray(rankedUserId, matchingUserIds) : undefined,
      ].filter((c): c is NonNullable<typeof c> => c !== undefined);

      const aggRows = await app.db
        .select({
          userId: rankedUserId,
          totalSpent: sql<number>`COALESCE(SUM(CASE WHEN ${schema.jobs.status} = 'COMPLETED' THEN ${schema.jobs.creditsCharged} ELSE 0 END), 0)::int`,
          totalJobs: sql<number>`COUNT(*) FILTER (WHERE ${schema.jobs.status} = 'COMPLETED')::int`,
          lastActivityAt: sql<string | null>`MAX(${schema.jobs.createdAt})`,
        })
        .from(schema.jobs)
        .leftJoin(schema.merchants, eq(schema.merchants.id, schema.jobs.merchantId))
        .where(and(...conditions))
        .groupBy(rankedUserId)
        .having(sql`COALESCE(${schema.jobs.userId}, ${schema.merchants.userId}) IS NOT NULL`)
        .orderBy(
          desc(
            sql`COALESCE(SUM(CASE WHEN ${schema.jobs.status} = 'COMPLETED' THEN ${schema.jobs.creditsCharged} ELSE 0 END), 0)`,
          ),
        )
        .limit(pageSize)
        .offset((page - 1) * pageSize);

      const rankedSubquery = app.db
        .select({ userId: rankedUserId })
        .from(schema.jobs)
        .leftJoin(schema.merchants, eq(schema.merchants.id, schema.jobs.merchantId))
        .where(and(...conditions))
        .groupBy(rankedUserId)
        .having(sql`COALESCE(${schema.jobs.userId}, ${schema.merchants.userId}) IS NOT NULL`)
        .as('ranked');
      const [{ total }] = await app.db
        .select({ total: sql<number>`COUNT(*)::int` })
        .from(rankedSubquery);

      const pageUserIds = aggRows.map((r) => r.userId);
      const userRows = pageUserIds.length
        ? await app.db
            .select({
              id: schema.users.id,
              email: schema.users.email,
              displayName: schema.users.displayName,
              tier: schema.users.tier,
              balance: sql<number>`COALESCE(${schema.userCredits.balance}, 0)`,
              hasShopifyStore: exists(
                app.db
                  .select()
                  .from(schema.shopifyStores)
                  .where(
                    and(
                      eq(schema.shopifyStores.ownerUserId, schema.users.id),
                      isNull(schema.shopifyStores.uninstalledAt),
                    ),
                  ),
              ),
            })
            .from(schema.users)
            .leftJoin(schema.userCredits, eq(schema.userCredits.userId, schema.users.id))
            .where(inArray(schema.users.id, pageUserIds))
        : [];
      const userMap = new Map(userRows.map((u) => [u.id, u]));

      const items = aggRows.map((r) => {
        const u = userMap.get(r.userId);
        return {
          id: r.userId,
          email: u?.email ?? '(unknown)',
          displayName: u?.displayName ?? null,
          tier: u?.tier ?? '',
          balance: u?.balance ?? 0,
          hasShopifyStore: u?.hasShopifyStore ?? false,
          totalSpent: r.totalSpent,
          totalJobs: r.totalJobs,
          avgCostPerJob: r.totalJobs > 0 ? Math.round((r.totalSpent / r.totalJobs) * 100) / 100 : 0,
          lastActivityAt: r.lastActivityAt,
        };
      });

      return { page, pageSize, total, items };
    },
  );

  app.get(
    '/admin/credit-analysis/users/:id',
    {
      preHandler: ALL,
      schema: { params: z.object({ id: z.string().uuid() }), querystring: DetailQuery },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const { days, source } = req.query as z.infer<typeof DetailQuery>;
      const since = sinceDate(days);

      const [user] = await app.db
        .select({
          id: schema.users.id,
          email: schema.users.email,
          displayName: schema.users.displayName,
          tier: schema.users.tier,
        })
        .from(schema.users)
        .where(eq(schema.users.id, id));
      if (!user) throw new AppError('NOT_FOUND', 404, 'user not found');

      const [credits] = await app.db
        .select({ balance: schema.userCredits.balance })
        .from(schema.userCredits)
        .where(eq(schema.userCredits.userId, id));

      const [linkedStore] = await app.db
        .select({ id: schema.shopifyStores.id })
        .from(schema.shopifyStores)
        .where(
          and(eq(schema.shopifyStores.ownerUserId, id), isNull(schema.shopifyStores.uninstalledAt)),
        )
        .limit(1);

      const conditions = [
        eq(rankedUserId, id),
        sourceCondition(source),
        since ? gte(schema.jobs.createdAt, since) : undefined,
      ].filter((c): c is NonNullable<typeof c> => c !== undefined);

      const dailySpend = await app.db
        .select({
          date: sql<string>`to_char(${schema.jobs.createdAt}, 'YYYY-MM-DD')`,
          spent: sql<number>`COALESCE(SUM(CASE WHEN ${schema.jobs.status} = 'COMPLETED' THEN ${schema.jobs.creditsCharged} ELSE 0 END), 0)::int`,
        })
        .from(schema.jobs)
        .leftJoin(schema.merchants, eq(schema.merchants.id, schema.jobs.merchantId))
        .where(and(...conditions))
        .groupBy(sql`to_char(${schema.jobs.createdAt}, 'YYYY-MM-DD')`)
        .orderBy(sql`to_char(${schema.jobs.createdAt}, 'YYYY-MM-DD')`);

      // Ledger entries with no jobId (FREE_TRIAL, PAYMENT, admin grants/deductions)
      // have no job to attribute a source to — effectiveSource is NULL for those,
      // and they're correctly dropped when a specific source filter is active
      // (sourceCondition's checks all evaluate false/NULL against a NULL-joined
      // job row).
      const ledgerConditions = [
        eq(schema.creditLedger.userId, id),
        since ? gte(schema.creditLedger.createdAt, since) : undefined,
        source !== 'all' ? sourceCondition(source) : undefined,
      ].filter((c): c is NonNullable<typeof c> => c !== undefined);

      const ledger = await app.db
        .select({
          id: schema.creditLedger.id,
          delta: schema.creditLedger.delta,
          reason: schema.creditLedger.reason,
          jobId: schema.creditLedger.jobId,
          createdAt: schema.creditLedger.createdAt,
          source: sql<string | null>`CASE
            WHEN ${schema.jobs.shopifyStoreId} IS NOT NULL THEN 'shopify'
            ELSE ${schema.jobs.source}
          END`,
        })
        .from(schema.creditLedger)
        .leftJoin(schema.jobs, eq(schema.jobs.id, schema.creditLedger.jobId))
        .where(and(...ledgerConditions))
        .orderBy(desc(schema.creditLedger.createdAt))
        .limit(50);

      let topProducts: {
        shopifyProductId: number;
        title: string | null;
        jobCount: number;
        creditsSpent: number;
      }[] = [];

      if (linkedStore) {
        const productConditions = [
          eq(schema.jobs.shopifyStoreId, linkedStore.id),
          since ? gte(schema.jobs.createdAt, since) : undefined,
        ].filter((c): c is NonNullable<typeof c> => c !== undefined);

        const rows = await app.db
          .select({
            shopifyProductId: sql<number>`(${schema.jobInputs.params}->>'shopifyProductId')::bigint`,
            jobCount: sql<number>`COUNT(*)::int`,
            creditsSpent: sql<number>`COALESCE(SUM(CASE WHEN ${schema.jobs.status} = 'COMPLETED' THEN ${schema.jobs.creditsCharged} ELSE 0 END), 0)::int`,
          })
          .from(schema.jobs)
          .innerJoin(schema.jobInputs, eq(schema.jobInputs.jobId, schema.jobs.id))
          .where(and(...productConditions))
          .groupBy(sql`(${schema.jobInputs.params}->>'shopifyProductId')::bigint`)
          .orderBy(
            desc(
              sql`COALESCE(SUM(CASE WHEN ${schema.jobs.status} = 'COMPLETED' THEN ${schema.jobs.creditsCharged} ELSE 0 END), 0)`,
            ),
          );

        // postgres.js returns ::bigint values as strings (to avoid silent precision
        // loss on int8), unlike Drizzle's own bigint({mode:'number'}) column decoding
        // which only applies to schema-typed columns, not raw sql`` casts. Real
        // Shopify product IDs (~13 digits) are well within Number.MAX_SAFE_INTEGER,
        // so converting here is safe and keeps ids consistent with the garments
        // query below (whose column IS schema-typed and already comes back numeric).
        const normalizedRows = rows.map((r) => ({
          ...r,
          shopifyProductId: Number(r.shopifyProductId),
        }));
        const productIds = normalizedRows.map((r) => r.shopifyProductId).filter((v) => v != null);
        const garments = productIds.length
          ? await app.db
              .select({
                shopifyProductId: schema.shopifyProductGarments.shopifyProductId,
                title: schema.shopifyProductGarments.title,
              })
              .from(schema.shopifyProductGarments)
              .where(
                and(
                  eq(schema.shopifyProductGarments.storeId, linkedStore.id),
                  inArray(schema.shopifyProductGarments.shopifyProductId, productIds),
                ),
              )
          : [];
        const titleMap = new Map(garments.map((g) => [g.shopifyProductId, g.title]));

        topProducts = normalizedRows.map((r) => ({
          shopifyProductId: r.shopifyProductId,
          title: titleMap.get(r.shopifyProductId) ?? null,
          jobCount: r.jobCount,
          creditsSpent: r.creditsSpent,
        }));
      }

      return {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        tier: user.tier,
        balance: credits?.balance ?? 0,
        hasShopifyStore: !!linkedStore,
        dailySpend,
        ledger,
        topProducts,
      };
    },
  );
}
