import type { DB } from '@tryme/db';
import { schema } from '@tryme/db';
import { and, asc, count, desc, eq, ilike, inArray, or, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

/**
 * Defaults to true so the Android app picks demo data up with no client change.
 * Parsed as a string enum on purpose: z.coerce.boolean() maps the string "false"
 * to true, which would make ?includeDemo=false a silent no-op.
 */
export const IncludeDemoQuery = z
  .enum(['true', 'false'])
  .optional()
  .transform((value) => value !== 'false');

type DemoSubcategoryRow = typeof schema.demoCatalogSubcategories.$inferSelect;
type DemoItemRow = typeof schema.demoCatalogItems.$inferSelect;

/**
 * Only one demo set is ever used in practice (see apps/admin-web's Kiosk Demo
 * Data page), so there is no per-set assignment UI — demoData=true is the only
 * signal an admin gives. Call this everywhere a merchant ends up with
 * demoData=true (creation or PATCH) so demoCatalogAssignments — the actual
 * authorization check in assignedSetFilter/resolve-tryon-garment.ts — has a
 * row to match against.
 */
export async function assignMerchantToActiveDemoSets(
  db: DB,
  merchantId: string,
  assignedByUserId: string | null,
): Promise<void> {
  const activeSets = await db
    .select({ id: schema.demoCatalogSets.id })
    .from(schema.demoCatalogSets)
    .where(eq(schema.demoCatalogSets.isActive, true));
  if (activeSets.length === 0) return;
  await db
    .insert(schema.demoCatalogAssignments)
    .values(activeSets.map((set) => ({ setId: set.id, merchantId, assignedByUserId })))
    .onConflictDoNothing();
}

/**
 * Subquery-free base filter: only sets assigned to this merchant and still
 * active, and only while the merchant-level demo-data switch is enabled.
 */
function assignedSetFilter(merchantId: string): SQL | undefined {
  return and(
    eq(schema.demoCatalogAssignments.merchantId, merchantId),
    eq(schema.merchants.demoData, true),
    eq(schema.demoCatalogSets.isActive, true),
  );
}

export async function loadDemoSubcategories(
  app: FastifyInstance,
  merchantId: string,
  opts: { category?: string; mannequinOnly?: boolean } = {},
) {
  const conditions: (SQL | undefined)[] = [assignedSetFilter(merchantId)];
  if (opts.category) {
    conditions.push(eq(schema.demoCatalogSubcategories.category, opts.category));
  }
  if (opts.mannequinOnly) {
    conditions.push(eq(schema.garmentSubcategories.requiresMannequinStep, true));
  }

  let query = app.db
    .select({ sub: schema.demoCatalogSubcategories })
    .from(schema.demoCatalogSubcategories)
    .innerJoin(
      schema.demoCatalogSets,
      eq(schema.demoCatalogSets.id, schema.demoCatalogSubcategories.setId),
    )
    .innerJoin(
      schema.demoCatalogAssignments,
      eq(schema.demoCatalogAssignments.setId, schema.demoCatalogSets.id),
    )
    .innerJoin(schema.merchants, eq(schema.merchants.id, schema.demoCatalogAssignments.merchantId))
    .$dynamic();

  if (opts.mannequinOnly) {
    query = query.innerJoin(
      schema.garmentSubcategories,
      eq(schema.garmentSubcategories.id, schema.demoCatalogSubcategories.garmentSubcategoryId),
    );
  }

  const rows = await query
    .where(and(...conditions))
    .orderBy(
      asc(schema.demoCatalogSubcategories.sortOrder),
      desc(schema.demoCatalogSubcategories.createdAt),
    );

  if (rows.length === 0) return [];

  // Only active items count, matching what loadDemoItems will actually return.
  const counts = await app.db
    .select({ subcategoryId: schema.demoCatalogItems.subcategoryId, n: count() })
    .from(schema.demoCatalogItems)
    .where(
      and(
        inArray(
          schema.demoCatalogItems.subcategoryId,
          rows.map((r) => r.sub.id),
        ),
        eq(schema.demoCatalogItems.isActive, true),
      ),
    )
    .groupBy(schema.demoCatalogItems.subcategoryId);
  const byId = new Map(counts.map((r) => [r.subcategoryId, Number(r.n)]));

  return rows.map((r) => serializeDemoSubcategory(r.sub, merchantId, byId.get(r.sub.id) ?? 0));
}

export async function loadDemoItems(
  app: FastifyInstance,
  merchantId: string,
  opts: { subcategoryId?: string; search?: string } = {},
) {
  const conditions: (SQL | undefined)[] = [
    assignedSetFilter(merchantId),
    eq(schema.demoCatalogItems.isActive, true),
  ];
  if (opts.subcategoryId) {
    conditions.push(eq(schema.demoCatalogItems.subcategoryId, opts.subcategoryId));
  }
  if (opts.search?.trim()) {
    const pattern = `%${opts.search.trim()}%`;
    conditions.push(
      or(
        ilike(schema.demoCatalogItems.label, pattern),
        ilike(schema.demoCatalogItems.sku, pattern),
      ),
    );
  }

  const rows = await app.db
    .select({ item: schema.demoCatalogItems })
    .from(schema.demoCatalogItems)
    .innerJoin(
      schema.demoCatalogSubcategories,
      eq(schema.demoCatalogSubcategories.id, schema.demoCatalogItems.subcategoryId),
    )
    .innerJoin(
      schema.demoCatalogSets,
      eq(schema.demoCatalogSets.id, schema.demoCatalogSubcategories.setId),
    )
    .innerJoin(
      schema.demoCatalogAssignments,
      eq(schema.demoCatalogAssignments.setId, schema.demoCatalogSets.id),
    )
    .innerJoin(schema.merchants, eq(schema.merchants.id, schema.demoCatalogAssignments.merchantId))
    .where(and(...conditions))
    .orderBy(asc(schema.demoCatalogItems.sortOrder), desc(schema.demoCatalogItems.createdAt));

  return Promise.all(rows.map((r) => serializeDemoItem(app, r.item, merchantId)));
}

/**
 * merchantId is stamped with the *requesting* merchant's id, not stored on the row —
 * MerchantCatalogSubcategory.merchantId is a non-null uuid on the wire and the
 * Android app reads these two shapes interchangeably.
 */
function serializeDemoSubcategory(
  row: DemoSubcategoryRow,
  merchantId: string,
  productCount: number,
) {
  return {
    id: row.id,
    merchantId,
    category: row.category,
    name: row.name,
    garmentSubcategoryId: row.garmentSubcategoryId,
    sortOrder: row.sortOrder,
    productCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    isDemo: true as const,
    readOnly: true as const,
  };
}

async function serializeDemoItem(app: FastifyInstance, item: DemoItemRow, merchantId: string) {
  const [imageUrl, thumbnailUrl] = await Promise.all([
    app.storage
      .presignGet(item.r2Key, 3600)
      .then((r) => r.url)
      .catch(() => null),
    app.storage
      .presignGet(item.thumbnailKey, 3600)
      .then((r) => r.url)
      .catch(() => null),
  ]);

  return {
    id: item.id,
    merchantId,
    subcategoryId: item.subcategoryId,
    label: item.label,
    sku: item.sku,
    actualPrice: Math.round(item.actualPricePaise / 100),
    offerPrice: Math.round(item.offerPricePaise / 100),
    actualPricePaise: item.actualPricePaise,
    offerPricePaise: item.offerPricePaise,
    r2Key: item.r2Key,
    thumbnailKey: item.thumbnailKey,
    imageUrl,
    thumbnailUrl,
    // Demo items are always admin-uploaded and pre-approved; these fields exist
    // only so the shape matches MerchantCatalogItem.
    sourceJobId: null,
    sourceKind: 'uploaded' as const,
    flatSourceKey: null,
    isActive: item.isActive,
    moderationStatus: 'approved' as const,
    moderationNote: null,
    sortOrder: item.sortOrder,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    isDemo: true as const,
    readOnly: true as const,
  };
}

export type SerializedDemoSubcategory = ReturnType<typeof serializeDemoSubcategory>;
export type SerializedDemoItem = Awaited<ReturnType<typeof serializeDemoItem>>;
