import { schema } from '@tryme/db';
import { and, desc, eq, isNotNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

/** Only shoppers who actually supplied an email. Anonymous rows exist for
 *  limit counting and are not a mailing list. */
async function listShoppers(app: FastifyInstance, storeId: string) {
  return app.db
    .select({
      id: schema.shopifyShoppers.id,
      email: schema.shopifyShoppers.email,
      emailConsent: schema.shopifyShoppers.emailConsent,
      firstSeenAt: schema.shopifyShoppers.firstSeenAt,
      tryOnCount: sql<number>`(
        SELECT COUNT(*)::int FROM ${schema.jobs}
        WHERE ${schema.jobs.shopifyShopperId} = ${schema.shopifyShoppers.id}
      )`,
    })
    .from(schema.shopifyShoppers)
    .where(
      and(eq(schema.shopifyShoppers.storeId, storeId), isNotNull(schema.shopifyShoppers.email)),
    )
    .orderBy(desc(schema.shopifyShoppers.firstSeenAt));
}

/** RFC4180 minimal quoting. Emails cannot contain commas, but consent and
 *  dates are rendered here too and a stray quote must not corrupt the file. */
function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export async function shopifyShoppersRoutes(app: FastifyInstance) {
  app.get('/v1/shopify/shoppers', { preHandler: app.requireShopifySession }, async (req) => {
    const store = req.shopifyStore as typeof schema.shopifyStores.$inferSelect;
    return { items: await listShoppers(app, store.id) };
  });

  app.get(
    '/v1/shopify/shoppers.csv',
    { preHandler: app.requireShopifySession },
    async (req, reply) => {
      const store = req.shopifyStore as typeof schema.shopifyStores.$inferSelect;
      const rows = await listShoppers(app, store.id);
      const lines = ['email,consent,first_seen,try_ons'];
      for (const r of rows) {
        lines.push(
          [
            csvCell(r.email ?? ''),
            r.emailConsent ? 'yes' : 'no',
            r.firstSeenAt.toISOString(),
            String(r.tryOnCount),
          ].join(','),
        );
      }
      return reply
        .header('Content-Type', 'text/csv; charset=utf-8')
        .header('Content-Disposition', 'attachment; filename="shoppers.csv"')
        .send(`${lines.join('\n')}\n`);
    },
  );
}
