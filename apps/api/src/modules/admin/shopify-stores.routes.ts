import { schema } from '@tryme/db';
import { desc, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { recordAudit } from './audit.js';
import { requirePermission } from './guard.js';

const LedgerQuery = z.object({
  cursor: z.string().datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export async function adminShopifyStoresRoutes(app: FastifyInstance) {
  const RO = requirePermission('shopify_stores.read');
  const DELETE = requirePermission('shopify_stores.delete');

  app.get('/admin/shopify-stores', { preHandler: RO }, async () => {
    const stores = await app.db
      .select({
        id: schema.shopifyStores.id,
        shopDomain: schema.shopifyStores.shopDomain,
        installedAt: schema.shopifyStores.installedAt,
        uninstalledAt: schema.shopifyStores.uninstalledAt,
        balance: sql<number>`COALESCE(${schema.shopifyStoreCredits.balance}, 0)`,
      })
      .from(schema.shopifyStores)
      .leftJoin(
        schema.shopifyStoreCredits,
        eq(schema.shopifyStoreCredits.storeId, schema.shopifyStores.id),
      )
      .orderBy(desc(schema.shopifyStores.installedAt));
    return { stores };
  });

  app.get(
    '/admin/shopify-stores/:id/ledger',
    {
      preHandler: RO,
      schema: { params: z.object({ id: z.string().uuid() }), querystring: LedgerQuery },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const { cursor, limit } = req.query as z.infer<typeof LedgerQuery>;
      const entries = await app.db
        .select({
          id: schema.shopifyCreditLedger.id,
          delta: schema.shopifyCreditLedger.delta,
          reason: schema.shopifyCreditLedger.reason,
          jobId: schema.shopifyCreditLedger.jobId,
          createdAt: schema.shopifyCreditLedger.createdAt,
        })
        .from(schema.shopifyCreditLedger)
        .where(
          cursor
            ? sql`${schema.shopifyCreditLedger.storeId} = ${id} AND ${schema.shopifyCreditLedger.createdAt} < ${new Date(cursor)}`
            : eq(schema.shopifyCreditLedger.storeId, id),
        )
        .orderBy(desc(schema.shopifyCreditLedger.createdAt))
        .limit(limit);
      const nextCursor =
        entries.length === limit ? entries[entries.length - 1].createdAt.toISOString() : null;
      return { entries, nextCursor };
    },
  );

  // Hard delete, not a soft "mark uninstalled" — this exists for dev/test
  // cleanup so a store can be reinstalled from a genuinely blank slate
  // (synced products, credit ledger, onboarding flags all gone), which
  // `uninstalledAt` reprovisioning does not give you. Cascades through every
  // shopify_* child table except jobs.shopifyStoreId (set null). Gated on
  // shopify_stores.delete, SUPER_ADMIN only — see migration 0173.
  app.delete(
    '/admin/shopify-stores/:id',
    { preHandler: DELETE, schema: { params: z.object({ id: z.string().uuid() }) } },
    async (req) => {
      const { id } = req.params as { id: string };

      await app.db.transaction(async (tx) => {
        const [existing] = await tx
          .select()
          .from(schema.shopifyStores)
          .where(eq(schema.shopifyStores.id, id))
          .for('update');
        if (!existing) throw new AppError('NOT_FOUND', 404, 'store not found');

        await tx.delete(schema.shopifyStores).where(eq(schema.shopifyStores.id, id));

        await recordAudit(tx, {
          actor: { userId: req.userId, role: req.adminRole! },
          action: 'shopify_stores.delete',
          resourceType: 'shopify_store',
          resourceId: id,
          before: { id: existing.id, shopDomain: existing.shopDomain },
          request: req,
        });
      });

      app.log.warn(
        { adminUserId: req.userId, storeId: id, action: 'SHOPIFY_STORE_DELETE' },
        'admin deleted Shopify store',
      );

      return { ok: true };
    },
  );
}
