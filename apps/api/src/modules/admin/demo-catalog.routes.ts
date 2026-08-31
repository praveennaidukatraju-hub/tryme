import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { keys } from '@tryme/storage';
import {
  DemoCatalogAssignmentsPutBody,
  DemoCatalogItemCreateBody,
  DemoCatalogItemUpdateBody,
  DemoCatalogPresignBody,
  DemoCatalogSetCreateBody,
  DemoCatalogSetUpdateBody,
  DemoCatalogSubcategoryCreateBody,
  DemoCatalogSubcategoryUpdateBody,
} from '@tryme/types';
import { and, asc, count, desc, eq, ilike, inArray, or, type SQL } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { assertDemoUploadKey } from './demo-upload-guard.js';
import { requirePermission } from './guard.js';

type DemoObjectField = 'r2Key' | 'thumbnailKey';

interface DemoObjectTarget {
  field: DemoObjectField;
  key: string;
}

function serializeStorageError(error: unknown) {
  const reason = error instanceof Error ? error : new Error(String(error));
  const code = 'code' in reason ? String(reason.code) : undefined;
  return {
    message: reason.message,
    ...(code ? { code } : {}),
  };
}

export async function adminDemoCatalogRoutes(app: FastifyInstance): Promise<void> {
  const RW = requirePermission('demo_catalog.write');
  const D = requirePermission('demo_catalog.delete');
  const uuidParam = z.object({ id: z.string().uuid() });
  type DemoItemRow = typeof schema.demoCatalogItems.$inferSelect;

  async function serializeItem(item: DemoItemRow) {
    const [imageUrl, thumbnailUrl] = await Promise.all([
      app.storage
        .presignGet(item.r2Key, 3600)
        .then((result) => result.url)
        .catch(() => null),
      app.storage
        .presignGet(item.thumbnailKey, 3600)
        .then((result) => result.url)
        .catch(() => null),
    ]);

    return {
      ...item,
      actualPrice: Math.round(item.actualPricePaise / 100),
      offerPrice: Math.round(item.offerPricePaise / 100),
      imageUrl,
      thumbnailUrl,
    };
  }

  async function loadSet(id: string) {
    const [set] = await app.db
      .select()
      .from(schema.demoCatalogSets)
      .where(eq(schema.demoCatalogSets.id, id))
      .limit(1);
    if (!set) throw new AppError('NOT_FOUND', 404, 'demo set not found');
    return set;
  }

  async function loadGarmentType(id: string) {
    const [garmentType] = await app.db
      .select({ id: schema.garmentSubcategories.id })
      .from(schema.garmentSubcategories)
      .where(eq(schema.garmentSubcategories.id, id))
      .limit(1);
    if (!garmentType) throw new AppError('NOT_FOUND', 404, 'garment type not found');
    return garmentType;
  }

  async function deleteDemoObjects(targets: DemoObjectTarget[]) {
    const results = await Promise.allSettled(
      targets.map((target) => app.storage.deleteObject(target.key)),
    );
    const deletedObjectKeys: string[] = [];
    const failedObjects: Array<
      DemoObjectTarget & { error: ReturnType<typeof serializeStorageError> }
    > = [];
    for (const [index, result] of results.entries()) {
      const target = targets[index];
      if (!target) continue;
      if (result.status === 'fulfilled') {
        deletedObjectKeys.push(target.key);
      } else {
        failedObjects.push({ ...target, error: serializeStorageError(result.reason) });
      }
    }
    return { deletedObjectKeys, failedObjects };
  }

  app.post(
    '/admin/demo-catalog/presign',
    { preHandler: RW, schema: { body: DemoCatalogPresignBody } },
    async (req) => {
      const body = req.body as z.infer<typeof DemoCatalogPresignBody>;
      const { assetId = randomUUID(), kind, contentType, contentLength } = body;
      const key =
        kind === 'thumbnail' ? keys.demoCatalogItemThumb(assetId) : keys.demoCatalogItem(assetId);
      const { url, expiresIn } = await app.storage.presignPut(key, contentType, contentLength, 600);
      await app.redis.set(`upload:owner:${key}`, `admin:${req.userId}`, 'EX', 600);

      app.log.info(
        {
          adminUserId: req.userId,
          entity: 'demoCatalogUpload',
          entityId: assetId,
          fields: Object.keys(body),
        },
        'demo catalog upload presigned',
      );
      return { assetId, uploadUrl: url, r2Key: key, expiresIn };
    },
  );

  app.get('/admin/demo-catalog/items', { preHandler: RW }, async (req) => {
    const { subcategoryId, search = '' } = req.query as {
      subcategoryId?: string;
      search?: string;
    };
    const conditions: (SQL | undefined)[] = [];
    if (subcategoryId) {
      conditions.push(eq(schema.demoCatalogItems.subcategoryId, subcategoryId));
    }
    if (search.trim()) {
      const pattern = `%${search.trim()}%`;
      conditions.push(
        or(
          ilike(schema.demoCatalogItems.label, pattern),
          ilike(schema.demoCatalogItems.sku, pattern),
        ),
      );
    }

    const rows = await app.db
      .select()
      .from(schema.demoCatalogItems)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(asc(schema.demoCatalogItems.sortOrder), desc(schema.demoCatalogItems.createdAt));

    return { items: await Promise.all(rows.map(serializeItem)) };
  });

  app.post(
    '/admin/demo-catalog/items',
    { preHandler: RW, schema: { body: DemoCatalogItemCreateBody } },
    async (req, reply) => {
      const body = req.body as z.infer<typeof DemoCatalogItemCreateBody>;
      const [subcategory] = await app.db
        .select({ id: schema.demoCatalogSubcategories.id })
        .from(schema.demoCatalogSubcategories)
        .where(eq(schema.demoCatalogSubcategories.id, body.subcategoryId))
        .limit(1);
      if (!subcategory) throw new AppError('NOT_FOUND', 404, 'demo subcategory not found');

      await Promise.all([
        assertDemoUploadKey(app, req.userId, body.r2Key, 'image'),
        assertDemoUploadKey(app, req.userId, body.thumbnailKey, 'thumbnail'),
      ]);

      const [row] = await app.db
        .insert(schema.demoCatalogItems)
        .values({
          subcategoryId: body.subcategoryId,
          label: body.label,
          sku: body.sku?.trim() || null,
          actualPricePaise: body.actualPrice * 100,
          offerPricePaise: body.offerPrice * 100,
          r2Key: body.r2Key,
          thumbnailKey: body.thumbnailKey,
          sortOrder: body.sortOrder ?? 0,
        })
        .returning();
      if (!row) throw new AppError('INTERNAL', 500, 'failed to create demo item');

      app.log.info(
        {
          adminUserId: req.userId,
          entity: 'demoCatalogItem',
          entityId: row.id,
          fields: Object.keys(body),
        },
        'demo item created',
      );
      reply.code(201);
      return serializeItem(row);
    },
  );

  app.patch(
    '/admin/demo-catalog/items/:id',
    { preHandler: RW, schema: { params: uuidParam, body: DemoCatalogItemUpdateBody } },
    async (req) => {
      const { id } = req.params as { id: string };
      const body = req.body as z.infer<typeof DemoCatalogItemUpdateBody>;

      const [updated] = await app.db
        .update(schema.demoCatalogItems)
        .set({
          ...(body.subcategoryId !== undefined ? { subcategoryId: body.subcategoryId } : {}),
          ...(body.label !== undefined ? { label: body.label } : {}),
          ...(body.sku !== undefined ? { sku: body.sku?.trim() || null } : {}),
          ...(body.actualPrice !== undefined ? { actualPricePaise: body.actualPrice * 100 } : {}),
          ...(body.offerPrice !== undefined ? { offerPricePaise: body.offerPrice * 100 } : {}),
          ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
          ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
          updatedAt: new Date(),
        })
        .where(eq(schema.demoCatalogItems.id, id))
        .returning();
      if (!updated) throw new AppError('NOT_FOUND', 404, 'demo item not found');

      app.log.info(
        {
          adminUserId: req.userId,
          entity: 'demoCatalogItem',
          entityId: id,
          fields: Object.keys(body),
        },
        'demo item updated',
      );
      return serializeItem(updated);
    },
  );

  app.delete(
    '/admin/demo-catalog/items/:id',
    { preHandler: D, schema: { params: uuidParam } },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const [deleted] = await app.db
        .delete(schema.demoCatalogItems)
        .where(eq(schema.demoCatalogItems.id, id))
        .returning();
      if (!deleted) throw new AppError('NOT_FOUND', 404, 'demo item not found');

      const cleanup = await deleteDemoObjects([
        { field: 'r2Key', key: deleted.r2Key },
        { field: 'thumbnailKey', key: deleted.thumbnailKey },
      ]);
      if (cleanup.failedObjects.length > 0) {
        app.log.error(
          {
            adminUserId: req.userId,
            entity: 'demoCatalogItem',
            entityId: id,
            fields: Object.keys(deleted),
            databaseDeleted: true,
            deletedObjectKeys: cleanup.deletedObjectKeys,
            failedObjects: cleanup.failedObjects,
          },
          'demo item deleted with object cleanup failures',
        );
        throw new AppError(
          'STORAGE_DELETE_FAILED',
          502,
          'demo item deleted but object cleanup failed',
        );
      }

      app.log.info(
        {
          adminUserId: req.userId,
          entity: 'demoCatalogItem',
          entityId: id,
          fields: Object.keys(deleted),
          deletedObjects: cleanup.deletedObjectKeys.length,
        },
        'demo item deleted',
      );
      reply.code(204);
      return reply.send();
    },
  );

  app.get('/admin/demo-catalog/sets', { preHandler: RW }, async () => {
    const sets = await app.db
      .select()
      .from(schema.demoCatalogSets)
      .orderBy(asc(schema.demoCatalogSets.sortOrder), desc(schema.demoCatalogSets.createdAt));
    if (sets.length === 0) return { items: [] };

    const setIds = sets.map((set) => set.id);
    const subRows = await app.db
      .select({
        setId: schema.demoCatalogSubcategories.setId,
        id: schema.demoCatalogSubcategories.id,
      })
      .from(schema.demoCatalogSubcategories)
      .where(inArray(schema.demoCatalogSubcategories.setId, setIds));

    const itemRows = subRows.length
      ? await app.db
          .select({
            subcategoryId: schema.demoCatalogItems.subcategoryId,
            n: count(),
          })
          .from(schema.demoCatalogItems)
          .where(
            inArray(
              schema.demoCatalogItems.subcategoryId,
              subRows.map((subcategory) => subcategory.id),
            ),
          )
          .groupBy(schema.demoCatalogItems.subcategoryId)
      : [];

    const assignmentRows = await app.db
      .select({ setId: schema.demoCatalogAssignments.setId, n: count() })
      .from(schema.demoCatalogAssignments)
      .where(inArray(schema.demoCatalogAssignments.setId, setIds))
      .groupBy(schema.demoCatalogAssignments.setId);

    const itemsBySubcategory = new Map(itemRows.map((row) => [row.subcategoryId, Number(row.n)]));
    const assignedBySet = new Map(assignmentRows.map((row) => [row.setId, Number(row.n)]));
    const subcategoriesBySet = new Map<string, string[]>();
    for (const row of subRows) {
      subcategoriesBySet.set(row.setId, [...(subcategoriesBySet.get(row.setId) ?? []), row.id]);
    }

    return {
      items: sets.map((set) => {
        const subcategoryIds = subcategoriesBySet.get(set.id) ?? [];
        return {
          ...set,
          subcategoryCount: subcategoryIds.length,
          productCount: subcategoryIds.reduce(
            (sum, id) => sum + (itemsBySubcategory.get(id) ?? 0),
            0,
          ),
          assignedMerchantCount: assignedBySet.get(set.id) ?? 0,
        };
      }),
    };
  });

  app.post(
    '/admin/demo-catalog/sets',
    { preHandler: RW, schema: { body: DemoCatalogSetCreateBody } },
    async (req, reply) => {
      const body = req.body as z.infer<typeof DemoCatalogSetCreateBody>;
      const [row] = await app.db
        .insert(schema.demoCatalogSets)
        .values({
          name: body.name,
          description: body.description ?? null,
          sortOrder: body.sortOrder ?? 0,
          createdByUserId: req.userId,
        })
        .returning();
      if (!row) throw new AppError('INTERNAL', 500, 'failed to create demo set');
      app.log.info(
        { adminUserId: req.userId, demoSetId: row.id, fields: Object.keys(body) },
        'demo set created',
      );
      reply.code(201);
      return row;
    },
  );

  app.patch(
    '/admin/demo-catalog/sets/:id',
    { preHandler: RW, schema: { params: uuidParam, body: DemoCatalogSetUpdateBody } },
    async (req) => {
      const { id } = req.params as { id: string };
      const body = req.body as z.infer<typeof DemoCatalogSetUpdateBody>;
      await loadSet(id);
      const [updated] = await app.db
        .update(schema.demoCatalogSets)
        .set({ ...body, updatedAt: new Date() })
        .where(eq(schema.demoCatalogSets.id, id))
        .returning();
      app.log.info(
        { adminUserId: req.userId, demoSetId: id, fields: Object.keys(body) },
        'demo set updated',
      );
      return updated;
    },
  );

  app.delete(
    '/admin/demo-catalog/sets/:id',
    { preHandler: D, schema: { params: uuidParam } },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const set = await loadSet(id);
      const orphaned = await app.db
        .select({
          r2Key: schema.demoCatalogItems.r2Key,
          thumbnailKey: schema.demoCatalogItems.thumbnailKey,
        })
        .from(schema.demoCatalogItems)
        .innerJoin(
          schema.demoCatalogSubcategories,
          eq(schema.demoCatalogSubcategories.id, schema.demoCatalogItems.subcategoryId),
        )
        .where(eq(schema.demoCatalogSubcategories.setId, id));

      await app.db.delete(schema.demoCatalogSets).where(eq(schema.demoCatalogSets.id, id));
      const cleanup = await deleteDemoObjects(
        orphaned.flatMap((row) => [
          { field: 'r2Key' as const, key: row.r2Key },
          { field: 'thumbnailKey' as const, key: row.thumbnailKey },
        ]),
      );

      if (cleanup.failedObjects.length > 0) {
        app.log.error(
          {
            adminUserId: req.userId,
            demoSetId: id,
            fields: Object.keys(set),
            databaseDeleted: true,
            deletedObjectKeys: cleanup.deletedObjectKeys,
            failedObjects: cleanup.failedObjects,
          },
          'demo set deleted with object cleanup failures',
        );
        throw new AppError(
          'STORAGE_DELETE_FAILED',
          502,
          'demo set deleted but object cleanup failed',
        );
      }

      app.log.info(
        {
          adminUserId: req.userId,
          demoSetId: id,
          fields: Object.keys(set),
          deletedObjects: cleanup.deletedObjectKeys.length,
        },
        'demo set deleted',
      );
      reply.code(204);
      return reply.send();
    },
  );

  app.get(
    '/admin/demo-catalog/sets/:id/subcategories',
    { preHandler: RW, schema: { params: uuidParam } },
    async (req) => {
      const { id } = req.params as { id: string };
      await loadSet(id);

      const rows = await app.db
        .select()
        .from(schema.demoCatalogSubcategories)
        .where(eq(schema.demoCatalogSubcategories.setId, id))
        .orderBy(
          asc(schema.demoCatalogSubcategories.sortOrder),
          desc(schema.demoCatalogSubcategories.createdAt),
        );
      if (rows.length === 0) return { items: [] };

      const counts = await app.db
        .select({ subcategoryId: schema.demoCatalogItems.subcategoryId, n: count() })
        .from(schema.demoCatalogItems)
        .where(
          inArray(
            schema.demoCatalogItems.subcategoryId,
            rows.map((row) => row.id),
          ),
        )
        .groupBy(schema.demoCatalogItems.subcategoryId);
      const countById = new Map(counts.map((row) => [row.subcategoryId, Number(row.n)]));

      return {
        items: rows.map((row) => ({ ...row, productCount: countById.get(row.id) ?? 0 })),
      };
    },
  );

  app.post(
    '/admin/demo-catalog/subcategories',
    { preHandler: RW, schema: { body: DemoCatalogSubcategoryCreateBody } },
    async (req, reply) => {
      const body = req.body as z.infer<typeof DemoCatalogSubcategoryCreateBody>;
      await loadSet(body.setId);

      await loadGarmentType(body.garmentSubcategoryId);

      const [row] = await app.db
        .insert(schema.demoCatalogSubcategories)
        .values({
          setId: body.setId,
          category: body.category,
          name: body.name,
          garmentSubcategoryId: body.garmentSubcategoryId,
          sortOrder: body.sortOrder ?? 0,
        })
        .returning();
      if (!row) throw new AppError('INTERNAL', 500, 'failed to create demo subcategory');
      app.log.info(
        {
          adminUserId: req.userId,
          demoSetId: body.setId,
          demoSubcategoryId: row.id,
          fields: Object.keys(body),
        },
        'demo subcategory created',
      );
      reply.code(201);
      return row;
    },
  );

  app.patch(
    '/admin/demo-catalog/subcategories/:id',
    { preHandler: RW, schema: { params: uuidParam, body: DemoCatalogSubcategoryUpdateBody } },
    async (req) => {
      const { id } = req.params as { id: string };
      const body = req.body as z.infer<typeof DemoCatalogSubcategoryUpdateBody>;
      if (body.garmentSubcategoryId) await loadGarmentType(body.garmentSubcategoryId);
      const [updated] = await app.db
        .update(schema.demoCatalogSubcategories)
        .set({ ...body, updatedAt: new Date() })
        .where(eq(schema.demoCatalogSubcategories.id, id))
        .returning();
      if (!updated) throw new AppError('NOT_FOUND', 404, 'demo subcategory not found');
      app.log.info(
        { adminUserId: req.userId, demoSubcategoryId: id, fields: Object.keys(body) },
        'demo subcategory updated',
      );
      return updated;
    },
  );

  app.delete(
    '/admin/demo-catalog/subcategories/:id',
    { preHandler: D, schema: { params: uuidParam } },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const orphaned = await app.db
        .select({
          r2Key: schema.demoCatalogItems.r2Key,
          thumbnailKey: schema.demoCatalogItems.thumbnailKey,
        })
        .from(schema.demoCatalogItems)
        .where(eq(schema.demoCatalogItems.subcategoryId, id));

      const [deleted] = await app.db
        .delete(schema.demoCatalogSubcategories)
        .where(eq(schema.demoCatalogSubcategories.id, id))
        .returning();
      if (!deleted) throw new AppError('NOT_FOUND', 404, 'demo subcategory not found');

      const cleanup = await deleteDemoObjects(
        orphaned.flatMap((row) => [
          { field: 'r2Key' as const, key: row.r2Key },
          { field: 'thumbnailKey' as const, key: row.thumbnailKey },
        ]),
      );
      if (cleanup.failedObjects.length > 0) {
        app.log.error(
          {
            adminUserId: req.userId,
            demoSubcategoryId: id,
            fields: Object.keys(deleted),
            databaseDeleted: true,
            deletedObjectKeys: cleanup.deletedObjectKeys,
            failedObjects: cleanup.failedObjects,
          },
          'demo subcategory deleted with object cleanup failures',
        );
        throw new AppError(
          'STORAGE_DELETE_FAILED',
          502,
          'demo subcategory deleted but object cleanup failed',
        );
      }
      app.log.info(
        {
          adminUserId: req.userId,
          demoSubcategoryId: id,
          fields: Object.keys(deleted),
          deletedObjects: cleanup.deletedObjectKeys.length,
        },
        'demo subcategory deleted',
      );
      reply.code(204);
      return reply.send();
    },
  );

  app.get(
    '/admin/demo-catalog/sets/:id/assignments',
    { preHandler: RW, schema: { params: uuidParam } },
    async (req) => {
      const { id } = req.params as { id: string };
      await loadSet(id);

      const rows = await app.db
        .select({
          merchantId: schema.merchants.id,
          companyName: schema.merchants.companyName,
          isActive: schema.merchants.isActive,
          assignedAt: schema.demoCatalogAssignments.createdAt,
        })
        .from(schema.demoCatalogAssignments)
        .innerJoin(
          schema.merchants,
          eq(schema.merchants.id, schema.demoCatalogAssignments.merchantId),
        )
        .where(eq(schema.demoCatalogAssignments.setId, id))
        .orderBy(asc(schema.merchants.companyName));

      return { items: rows };
    },
  );

  app.put(
    '/admin/demo-catalog/sets/:id/assignments',
    { preHandler: RW, schema: { params: uuidParam, body: DemoCatalogAssignmentsPutBody } },
    async (req) => {
      const { id } = req.params as { id: string };
      const { merchantIds } = req.body as z.infer<typeof DemoCatalogAssignmentsPutBody>;
      await loadSet(id);

      const unique = [...new Set(merchantIds)];
      if (unique.length > 0) {
        // Validate before writing so a typo'd id cannot half-apply the change.
        const found = await app.db
          .select({ id: schema.merchants.id })
          .from(schema.merchants)
          .where(inArray(schema.merchants.id, unique));
        if (found.length !== unique.length) {
          throw new AppError('NOT_FOUND', 404, 'one or more merchants not found');
        }
      }

      await app.db.transaction(async (tx) => {
        await tx
          .delete(schema.demoCatalogAssignments)
          .where(eq(schema.demoCatalogAssignments.setId, id));
        if (unique.length > 0) {
          await tx.insert(schema.demoCatalogAssignments).values(
            unique.map((merchantId) => ({
              setId: id,
              merchantId,
              assignedByUserId: req.userId,
            })),
          );
        }
      });

      app.log.info(
        { adminUserId: req.userId, demoSetId: id, merchantCount: unique.length },
        'demo set assignments replaced',
      );
      return { assignedMerchantCount: unique.length };
    },
  );
}
