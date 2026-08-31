import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { keys } from '@tryme/storage';
import {
  MerchantCatalogCreateBody,
  MerchantCatalogGenerateBody,
  MerchantCatalogGenerateBulkBody,
  MerchantCatalogImportBody,
  MerchantCatalogPresignBody,
  MerchantCatalogSubcategoryCreateBody,
  MerchantCatalogSubcategoryUpdateBody,
  MerchantCatalogUpdateBody,
} from '@tryme/types';
import { and, count, desc, eq, ilike, inArray, or, type SQL, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { createMerchantCatalogJob, createMerchantSareeMannequinJob } from './create-job.js';
import { IncludeDemoQuery, loadDemoItems, loadDemoSubcategories } from './demo-catalog-read.js';
import { assertMerchantUploadKey } from './upload-guard.js';

type MerchantCatalogRow = typeof schema.merchantCatalogItems.$inferSelect;

async function serializeCatalogItem(app: FastifyInstance, item: MerchantCatalogRow) {
  const [imageUrl, thumbnailUrl, secondImageUrl] = await Promise.all([
    app.storage
      .presignGet(item.r2Key, 3600)
      .then((result) => result.url)
      .catch(() => null),
    app.storage
      .presignGet(item.thumbnailKey, 3600)
      .then((result) => result.url)
      .catch(() => null),
    item.secondR2Key
      ? app.storage
          .presignGet(item.secondR2Key, 3600)
          .then((result) => result.url)
          .catch(() => null)
      : Promise.resolve(null),
  ]);

  return {
    ...item,
    actualPrice: Math.round(item.actualPricePaise / 100),
    offerPrice: Math.round(item.offerPricePaise / 100),
    imageUrl,
    thumbnailUrl,
    secondImageUrl,
  };
}

function catalogueLabel(catalogueId: string | null, jobId: string): string {
  if (catalogueId) return `Catalogue ${catalogueId.slice(0, 8)}`;
  return `Job ${jobId.slice(0, 8)}`;
}

/**
 * Copies a completed job's OUTPUT (never the source garment) into a fresh
 * merchant_catalog_items row. Used by both /import (Path A — merchant hand-picks
 * an existing studio result) and the generate-completion flow (Path B — merchant
 * uploaded a flat garment and the studio pipeline generated a catalogue image).
 * The output image serves BOTH roles: kiosk display AND the ComfyUI try-on input
 * for later virtual try-on jobs — there is no separate "flat garment" stored as
 * r2Key; that would defeat guaranteeing every catalogue item is try-on-suitable.
 */
async function copyJobOutputIntoProduct(
  app: FastifyInstance,
  params: {
    merchantId: string;
    subcategoryId: string;
    job: { id: string; catalogueId: string | null };
    resultKey: string;
    thumbnailKey: string | null;
    sourceKind: 'imported' | 'generated';
    flatSourceKey?: string;
    label?: string;
    // Held-batch products land inactive: nobody was on screen to give them a
    // SKU or a price, and the kiosk query filters on isActive. Defaults true so
    // the interactive /import path is unchanged.
    isActive?: boolean;
  },
): Promise<MerchantCatalogRow> {
  const sourceThumbKey = params.thumbnailKey ?? params.resultKey;
  const [imageHead, thumbHead, imageBody, thumbBody] = await Promise.all([
    app.storage.headObject(params.resultKey),
    app.storage.headObject(sourceThumbKey),
    app.storage.getObject(params.resultKey),
    app.storage.getObject(sourceThumbKey),
  ]).catch(() => {
    throw new AppError('BAD_UPLOAD', 400, 'source assets are missing');
  });

  const assetId = randomUUID();
  const imageKey = keys.merchantCatalogItem(params.merchantId, assetId);
  const thumbKey = keys.merchantCatalogItemThumb(params.merchantId, assetId);
  await Promise.all([
    app.storage.putObject(imageKey, imageBody, imageHead.contentType ?? 'image/jpeg'),
    app.storage.putObject(thumbKey, thumbBody, thumbHead.contentType ?? 'image/jpeg'),
  ]);

  try {
    const [item] = await app.db
      .insert(schema.merchantCatalogItems)
      .values({
        id: assetId,
        merchantId: params.merchantId,
        subcategoryId: params.subcategoryId,
        label: params.label ?? catalogueLabel(params.job.catalogueId, params.job.id),
        actualPricePaise: 0,
        offerPricePaise: 0,
        r2Key: imageKey,
        thumbnailKey: thumbKey,
        sourceJobId: params.job.id,
        sourceKind: params.sourceKind,
        flatSourceKey: params.flatSourceKey ?? null,
        isActive: params.isActive ?? true,
      })
      .returning();
    return item;
  } catch (err) {
    await Promise.allSettled([
      app.storage.deleteObject(imageKey),
      app.storage.deleteObject(thumbKey),
    ]);
    if ((err as { code?: string }).code === '23505') {
      throw new AppError(
        'CONFLICT',
        409,
        params.sourceKind === 'generated'
          ? 'job already used for a generated product'
          : 'job already imported',
      );
    }
    throw err;
  }
}

async function serializeSubcategory(
  app: FastifyInstance,
  row: typeof schema.merchantCatalogSubcategories.$inferSelect,
) {
  const [{ n }] = await app.db
    .select({ n: count() })
    .from(schema.merchantCatalogItems)
    .where(eq(schema.merchantCatalogItems.subcategoryId, row.id));
  // Mirrors the existing per-row productCount lookup above — same N+1-per-row shape this
  // function already has, not a new performance concern for a merchant's subcategory list
  // (bounded by how many subcategories one merchant creates, never paginated at scale).
  const [garmentType] = await app.db
    .select({
      requiresMannequinStep: schema.garmentSubcategories.requiresMannequinStep,
      mannequinTwoInputWorkflowTemplateId:
        schema.garmentSubcategories.mannequinTwoInputWorkflowTemplateId,
      twoInputTryonWorkflowTemplateId: schema.garmentSubcategories.twoInputTryonWorkflowTemplateId,
    })
    .from(schema.garmentSubcategories)
    .where(eq(schema.garmentSubcategories.id, row.garmentSubcategoryId));
  return {
    ...row,
    productCount: n,
    supportsTwoInputMannequin: Boolean(
      garmentType?.requiresMannequinStep && garmentType?.mannequinTwoInputWorkflowTemplateId,
    ),
    supportsTwoInputDirectTryon: Boolean(garmentType?.twoInputTryonWorkflowTemplateId),
  };
}

export async function merchantCatalogRoutes(app: FastifyInstance) {
  app.get(
    '/v1/merchant/catalog/subcategories',
    {
      preHandler: app.requireMerchant,
      schema: {
        querystring: z.object({ category: z.string().optional(), includeDemo: IncludeDemoQuery }),
      },
    },
    async (req) => {
      const merchantId = req.merchantClientId;
      if (!merchantId) throw new AppError('UNAUTH', 401, 'missing merchant');

      const { category, includeDemo } = req.query as { category?: string; includeDemo: boolean };
      const where = category
        ? and(
            eq(schema.merchantCatalogSubcategories.merchantId, merchantId),
            eq(schema.merchantCatalogSubcategories.category, category),
          )
        : eq(schema.merchantCatalogSubcategories.merchantId, merchantId);

      // General-purpose: lists subcategories across every garment type for this
      // merchant/category, backed by the same unfiltered /v1/models/garment-types
      // list the web catalogue-manager already uses. The saree Android app has its
      // own dedicated GET /v1/merchant/catalog/saree-subcategories below — do not
      // add a requiresMannequinStep filter here, it would break every non-saree
      // category's ability to create/list subcategories.
      const rows = await app.db
        .select()
        .from(schema.merchantCatalogSubcategories)
        .where(where)
        .orderBy(
          schema.merchantCatalogSubcategories.sortOrder,
          desc(schema.merchantCatalogSubcategories.createdAt),
        );

      const own = await Promise.all(rows.map((row) => serializeSubcategory(app, row)));
      if (!includeDemo) return { items: own };
      // Demo rows go last so the merchant's real products lead on the kiosk.
      const demo = await loadDemoSubcategories(app, merchantId, { category });
      return { items: [...own, ...demo] };
    },
  );

  app.get(
    '/v1/merchant/catalog/saree-subcategories',
    {
      preHandler: app.requireMerchant,
      schema: {
        querystring: z.object({ category: z.string().optional(), includeDemo: IncludeDemoQuery }),
      },
    },
    async (req) => {
      const merchantId = req.merchantClientId;
      if (!merchantId) throw new AppError('UNAUTH', 401, 'missing merchant');

      const { category, includeDemo } = req.query as { category?: string; includeDemo: boolean };
      const where = category
        ? and(
            eq(schema.merchantCatalogSubcategories.merchantId, merchantId),
            eq(schema.merchantCatalogSubcategories.category, category),
          )
        : eq(schema.merchantCatalogSubcategories.merchantId, merchantId);

      // Dedicated to the saree catalogue Android app — only ever shows/creates
      // subcategories for garment types that use the mannequin (saree) pipeline.
      // Does not affect the general /v1/merchant/catalog/subcategories endpoint
      // the web catalogue-manager uses for every other category/garment type.
      const merchantCatalogSubcategoryColumns = {
        id: schema.merchantCatalogSubcategories.id,
        merchantId: schema.merchantCatalogSubcategories.merchantId,
        category: schema.merchantCatalogSubcategories.category,
        name: schema.merchantCatalogSubcategories.name,
        garmentSubcategoryId: schema.merchantCatalogSubcategories.garmentSubcategoryId,
        sortOrder: schema.merchantCatalogSubcategories.sortOrder,
        createdAt: schema.merchantCatalogSubcategories.createdAt,
        updatedAt: schema.merchantCatalogSubcategories.updatedAt,
      };
      let rows = await app.db
        .select(merchantCatalogSubcategoryColumns)
        .from(schema.merchantCatalogSubcategories)
        .innerJoin(
          schema.garmentSubcategories,
          eq(
            schema.garmentSubcategories.id,
            schema.merchantCatalogSubcategories.garmentSubcategoryId,
          ),
        )
        .where(and(where, eq(schema.garmentSubcategories.requiresMannequinStep, true)))
        .orderBy(
          schema.merchantCatalogSubcategories.sortOrder,
          desc(schema.merchantCatalogSubcategories.createdAt),
        );

      // No admin UI creates these rows, so a merchant who has never been
      // seeded for this category would otherwise be stuck forever with an
      // empty picker. Self-provision one subcategory per active admin
      // saree garment type for the category on first read.
      if (rows.length === 0 && category) {
        const garmentTypes = await app.db
          .select({ id: schema.garmentSubcategories.id, label: schema.garmentSubcategories.label })
          .from(schema.garmentSubcategories)
          .where(
            and(
              eq(schema.garmentSubcategories.genderSlug, category),
              eq(schema.garmentSubcategories.isActive, true),
              eq(schema.garmentSubcategories.requiresMannequinStep, true),
            ),
          )
          .orderBy(schema.garmentSubcategories.sortOrder);

        if (garmentTypes.length > 0) {
          await app.db.insert(schema.merchantCatalogSubcategories).values(
            garmentTypes.map((gt, i) => ({
              merchantId,
              category,
              name: gt.label,
              garmentSubcategoryId: gt.id,
              sortOrder: i,
            })),
          );

          rows = await app.db
            .select(merchantCatalogSubcategoryColumns)
            .from(schema.merchantCatalogSubcategories)
            .innerJoin(
              schema.garmentSubcategories,
              eq(
                schema.garmentSubcategories.id,
                schema.merchantCatalogSubcategories.garmentSubcategoryId,
              ),
            )
            .where(and(where, eq(schema.garmentSubcategories.requiresMannequinStep, true)))
            .orderBy(
              schema.merchantCatalogSubcategories.sortOrder,
              desc(schema.merchantCatalogSubcategories.createdAt),
            );
        }
      }

      const own = await Promise.all(rows.map((row) => serializeSubcategory(app, row)));
      if (!includeDemo) return { items: own };
      const demo = await loadDemoSubcategories(app, merchantId, { category, mannequinOnly: true });
      return { items: [...own, ...demo] };
    },
  );

  app.post(
    '/v1/merchant/catalog/subcategories',
    { preHandler: app.requireMerchant, schema: { body: MerchantCatalogSubcategoryCreateBody } },
    async (req, reply) => {
      const merchantId = req.merchantClientId;
      if (!merchantId) throw new AppError('UNAUTH', 401, 'missing merchant');

      const body = req.body as z.infer<typeof MerchantCatalogSubcategoryCreateBody>;
      const [garmentType] = await app.db
        .select({ id: schema.garmentSubcategories.id })
        .from(schema.garmentSubcategories)
        .where(
          and(
            eq(schema.garmentSubcategories.id, body.garmentSubcategoryId),
            eq(schema.garmentSubcategories.isActive, true),
          ),
        )
        .limit(1);
      if (!garmentType)
        throw new AppError('BAD_CATALOG', 400, 'garment type not found or inactive');

      const [row] = await app.db
        .insert(schema.merchantCatalogSubcategories)
        .values({
          merchantId,
          category: body.category,
          name: body.name,
          garmentSubcategoryId: body.garmentSubcategoryId,
        })
        .returning();

      reply.code(201);
      return await serializeSubcategory(app, row);
    },
  );

  app.patch(
    '/v1/merchant/catalog/subcategories/:id',
    {
      preHandler: app.requireMerchant,
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: MerchantCatalogSubcategoryUpdateBody,
      },
    },
    async (req) => {
      const merchantId = req.merchantClientId;
      if (!merchantId) throw new AppError('UNAUTH', 401, 'missing merchant');

      const { id } = req.params as { id: string };
      const body = req.body as z.infer<typeof MerchantCatalogSubcategoryUpdateBody>;

      if (body.garmentSubcategoryId !== undefined) {
        const [garmentType] = await app.db
          .select({ id: schema.garmentSubcategories.id })
          .from(schema.garmentSubcategories)
          .where(
            and(
              eq(schema.garmentSubcategories.id, body.garmentSubcategoryId),
              eq(schema.garmentSubcategories.isActive, true),
            ),
          )
          .limit(1);
        if (!garmentType)
          throw new AppError('BAD_CATALOG', 400, 'garment type not found or inactive');
      }

      const [updated] = await app.db
        .update(schema.merchantCatalogSubcategories)
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.garmentSubcategoryId !== undefined
            ? { garmentSubcategoryId: body.garmentSubcategoryId }
            : {}),
          ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.merchantCatalogSubcategories.id, id),
            eq(schema.merchantCatalogSubcategories.merchantId, merchantId),
          ),
        )
        .returning();

      if (!updated) throw new AppError('NOT_FOUND', 404, 'subcategory not found');
      return await serializeSubcategory(app, updated);
    },
  );

  app.delete(
    '/v1/merchant/catalog/subcategories/:id',
    {
      preHandler: app.requireMerchant,
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (req, reply) => {
      const merchantId = req.merchantClientId;
      if (!merchantId) throw new AppError('UNAUTH', 401, 'missing merchant');

      const { id } = req.params as { id: string };

      // Select children before the cascading delete so their R2 objects can be
      // cleaned up — the DB FK cascade removes the rows but knows nothing about R2.
      const children = await app.db
        .select({
          r2Key: schema.merchantCatalogItems.r2Key,
          thumbnailKey: schema.merchantCatalogItems.thumbnailKey,
          flatSourceKey: schema.merchantCatalogItems.flatSourceKey,
        })
        .from(schema.merchantCatalogItems)
        .where(
          and(
            eq(schema.merchantCatalogItems.subcategoryId, id),
            eq(schema.merchantCatalogItems.merchantId, merchantId),
          ),
        );

      const [deleted] = await app.db
        .delete(schema.merchantCatalogSubcategories)
        .where(
          and(
            eq(schema.merchantCatalogSubcategories.id, id),
            eq(schema.merchantCatalogSubcategories.merchantId, merchantId),
          ),
        )
        .returning();

      if (!deleted) throw new AppError('NOT_FOUND', 404, 'subcategory not found');

      await Promise.allSettled(
        children.flatMap((c) => [
          app.storage.deleteObject(c.r2Key),
          app.storage.deleteObject(c.thumbnailKey),
          ...(c.flatSourceKey ? [app.storage.deleteObject(c.flatSourceKey)] : []),
        ]),
      );

      reply.code(204);
      return reply.send();
    },
  );

  app.post(
    '/v1/merchant/catalog/presign',
    { preHandler: app.requireMerchant, schema: { body: MerchantCatalogPresignBody } },
    async (req) => {
      const merchantId = req.merchantClientId;
      if (!merchantId) throw new AppError('UNAUTH', 401, 'missing merchant');

      const {
        assetId = randomUUID(),
        kind,
        contentLength,
        contentType,
      } = req.body as z.infer<typeof MerchantCatalogPresignBody>;
      const key =
        kind === 'thumbnail'
          ? keys.merchantCatalogItemThumb(merchantId, assetId)
          : kind === 'flat'
            ? keys.merchantCatalogFlatGarment(merchantId, assetId)
            : keys.merchantCatalogItem(merchantId, assetId);

      const { url, expiresIn } = await app.storage.presignPut(key, contentType, contentLength, 600);
      await app.redis.set(`upload:owner:${key}`, merchantId, 'EX', 600);

      return { assetId, uploadUrl: url, r2Key: key, expiresIn };
    },
  );

  app.get(
    '/v1/merchant/catalog',
    {
      preHandler: app.requireMerchant,
      schema: {
        querystring: z.object({
          search: z.string().optional(),
          subcategoryId: z.string().optional(),
          includeDemo: IncludeDemoQuery,
        }),
      },
    },
    async (req) => {
      const merchantId = req.merchantClientId;
      if (!merchantId) throw new AppError('UNAUTH', 401, 'missing merchant');

      const {
        search = '',
        subcategoryId,
        includeDemo,
      } = req.query as { search?: string; subcategoryId?: string; includeDemo: boolean };
      const conditions: (SQL | undefined)[] = [
        eq(schema.merchantCatalogItems.merchantId, merchantId),
      ];
      if (search.trim()) {
        const pattern = `%${search.trim()}%`;
        // Merchants search by SKU as often as by label — match either.
        conditions.push(
          or(
            ilike(schema.merchantCatalogItems.label, pattern),
            ilike(schema.merchantCatalogItems.sku, pattern),
          ),
        );
      }
      if (subcategoryId)
        conditions.push(eq(schema.merchantCatalogItems.subcategoryId, subcategoryId));

      const items = await app.db
        .select()
        .from(schema.merchantCatalogItems)
        .where(and(...conditions))
        .orderBy(
          schema.merchantCatalogItems.sortOrder,
          desc(schema.merchantCatalogItems.createdAt),
        );

      const own = await Promise.all(items.map((item) => serializeCatalogItem(app, item)));
      if (!includeDemo) return { items: own };
      const demo = await loadDemoItems(app, merchantId, { subcategoryId, search });
      return { items: [...own, ...demo] };
    },
  );

  app.post(
    '/v1/merchant/catalog',
    { preHandler: app.requireMerchant, schema: { body: MerchantCatalogCreateBody } },
    async (req, reply) => {
      const merchantId = req.merchantClientId;
      if (!merchantId) throw new AppError('UNAUTH', 401, 'missing merchant');

      const body = req.body as z.infer<typeof MerchantCatalogCreateBody>;

      const [subcategory] = await app.db
        .select({ id: schema.merchantCatalogSubcategories.id })
        .from(schema.merchantCatalogSubcategories)
        .where(
          and(
            eq(schema.merchantCatalogSubcategories.id, body.subcategoryId),
            eq(schema.merchantCatalogSubcategories.merchantId, merchantId),
          ),
        )
        .limit(1);
      if (!subcategory) throw new AppError('NOT_FOUND', 404, 'subcategory not found');

      await Promise.all([
        assertMerchantUploadKey(app, merchantId, body.r2Key, 'image'),
        assertMerchantUploadKey(app, merchantId, body.thumbnailKey, 'thumbnail'),
        ...(body.secondR2Key
          ? [assertMerchantUploadKey(app, merchantId, body.secondR2Key, 'second image')]
          : []),
        ...(body.secondThumbnailKey
          ? [assertMerchantUploadKey(app, merchantId, body.secondThumbnailKey, 'second thumbnail')]
          : []),
      ]);

      const [item] = await app.db
        .insert(schema.merchantCatalogItems)
        .values({
          merchantId,
          subcategoryId: body.subcategoryId,
          label: body.label,
          sku: body.sku?.trim() || null,
          actualPricePaise: body.actualPrice * 100,
          offerPricePaise: body.offerPrice * 100,
          r2Key: body.r2Key,
          thumbnailKey: body.thumbnailKey,
          secondR2Key: body.secondR2Key ?? null,
          secondThumbnailKey: body.secondThumbnailKey ?? null,
        })
        .returning();

      reply.code(201);
      return await serializeCatalogItem(app, item);
    },
  );

  app.patch(
    '/v1/merchant/catalog/:id',
    {
      preHandler: app.requireMerchant,
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: MerchantCatalogUpdateBody,
      },
    },
    async (req) => {
      const merchantId = req.merchantClientId;
      if (!merchantId) throw new AppError('UNAUTH', 401, 'missing merchant');

      const { id } = req.params as { id: string };
      const body = req.body as z.infer<typeof MerchantCatalogUpdateBody>;

      if (body.subcategoryId !== undefined) {
        const [subcategory] = await app.db
          .select({ id: schema.merchantCatalogSubcategories.id })
          .from(schema.merchantCatalogSubcategories)
          .where(
            and(
              eq(schema.merchantCatalogSubcategories.id, body.subcategoryId),
              eq(schema.merchantCatalogSubcategories.merchantId, merchantId),
            ),
          )
          .limit(1);
        if (!subcategory) throw new AppError('NOT_FOUND', 404, 'subcategory not found');
      }

      const [existing] = await app.db
        .select()
        .from(schema.merchantCatalogItems)
        .where(
          and(
            eq(schema.merchantCatalogItems.id, id),
            eq(schema.merchantCatalogItems.merchantId, merchantId),
          ),
        )
        .limit(1);
      if (!existing) throw new AppError('NOT_FOUND', 404, 'catalog item not found');

      // A held-batch product is materialized inactive with ₹0 prices and no SKU
      // (see /reconcile-held). Filling those in is what publishes it to the
      // kiosk. The ₹0 test is what distinguishes it from a product the merchant
      // priced and then deliberately switched off — that one stays off.
      const isPendingHeldProduct =
        !existing.isActive &&
        existing.sourceKind === 'generated' &&
        existing.actualPricePaise === 0 &&
        existing.offerPricePaise === 0;
      const completesDetails =
        !!body.sku?.trim() &&
        body.actualPrice !== undefined &&
        body.actualPrice > 0 &&
        body.offerPrice !== undefined;
      const autoActivate = isPendingHeldProduct && completesDetails && body.isActive === undefined;

      const [updated] = await app.db
        .update(schema.merchantCatalogItems)
        .set({
          ...(autoActivate ? { isActive: true } : {}),
          ...(body.subcategoryId !== undefined ? { subcategoryId: body.subcategoryId } : {}),
          ...(body.label !== undefined ? { label: body.label } : {}),
          ...(body.sku !== undefined ? { sku: body.sku?.trim() || null } : {}),
          ...(body.actualPrice !== undefined ? { actualPricePaise: body.actualPrice * 100 } : {}),
          ...(body.offerPrice !== undefined ? { offerPricePaise: body.offerPrice * 100 } : {}),
          ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
          ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(schema.merchantCatalogItems.id, id),
            eq(schema.merchantCatalogItems.merchantId, merchantId),
          ),
        )
        .returning();

      if (!updated) throw new AppError('NOT_FOUND', 404, 'catalog item not found');
      return serializeCatalogItem(app, updated);
    },
  );

  app.delete(
    '/v1/merchant/catalog/:id',
    {
      preHandler: app.requireMerchant,
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (req, reply) => {
      const merchantId = req.merchantClientId;
      if (!merchantId) throw new AppError('UNAUTH', 401, 'missing merchant');

      const { id } = req.params as { id: string };
      const [deleted] = await app.db
        .delete(schema.merchantCatalogItems)
        .where(
          and(
            eq(schema.merchantCatalogItems.id, id),
            eq(schema.merchantCatalogItems.merchantId, merchantId),
          ),
        )
        .returning();

      if (!deleted) throw new AppError('NOT_FOUND', 404, 'catalog item not found');

      await Promise.allSettled([
        app.storage.deleteObject(deleted.r2Key),
        app.storage.deleteObject(deleted.thumbnailKey),
        ...(deleted.secondR2Key ? [app.storage.deleteObject(deleted.secondR2Key)] : []),
        ...(deleted.secondThumbnailKey
          ? [app.storage.deleteObject(deleted.secondThumbnailKey)]
          : []),
      ]);

      reply.code(204);
      return reply.send();
    },
  );

  app.get('/v1/merchant/catalogues', { preHandler: app.requireMerchant }, async (req) => {
    const merchantId = req.merchantClientId;
    if (!merchantId) throw new AppError('UNAUTH', 401, 'missing merchant');

    const [client] = await app.db
      .select({ userId: schema.merchants.userId })
      .from(schema.merchants)
      .where(eq(schema.merchants.id, merchantId))
      .limit(1);
    if (!client) return { catalogues: [] };

    const rows = await app.db
      .select({
        jobId: schema.jobs.id,
        catalogueId: schema.jobs.catalogueId,
        createdAt: schema.jobs.createdAt,
        thumbnailKey: schema.jobOutputs.thumbnailKey,
      })
      .from(schema.jobs)
      .leftJoin(schema.jobOutputs, eq(schema.jobOutputs.jobId, schema.jobs.id))
      .where(and(eq(schema.jobs.userId, client.userId), eq(schema.jobs.status, 'COMPLETED')))
      .orderBy(desc(schema.jobs.createdAt));

    if (rows.length === 0) return { catalogues: [] };

    const importedRows = await app.db
      .select({ sourceJobId: schema.merchantCatalogItems.sourceJobId })
      .from(schema.merchantCatalogItems)
      .where(
        and(
          eq(schema.merchantCatalogItems.merchantId, merchantId),
          inArray(
            schema.merchantCatalogItems.sourceJobId,
            rows.map((row) => row.jobId),
          ),
        ),
      );
    const importedJobIds = new Set(
      importedRows.map((row) => row.sourceJobId).filter((value): value is string => value !== null),
    );

    const grouped = new Map<
      string,
      {
        catalogueId: string;
        label: string;
        createdAt: string;
        jobs: Array<{
          jobId: string;
          catalogueId: string;
          label: string;
          thumbnailUrl: string | null;
          createdAt: string;
          imported: boolean;
        }>;
      }
    >();

    for (const row of rows) {
      const catalogueId = row.catalogueId ?? row.jobId;
      const label = catalogueLabel(row.catalogueId, row.jobId);
      const thumbKey = row.thumbnailKey ?? keys.output(row.jobId);
      const thumbnailUrl = await app.storage
        .presignGet(thumbKey, 3600)
        .then((result) => result.url)
        .catch(() => null);

      if (!grouped.has(catalogueId)) {
        grouped.set(catalogueId, {
          catalogueId,
          label,
          createdAt: row.createdAt.toISOString(),
          jobs: [],
        });
      }

      grouped.get(catalogueId)?.jobs.push({
        jobId: row.jobId,
        catalogueId,
        label,
        thumbnailUrl,
        createdAt: row.createdAt.toISOString(),
        imported: importedJobIds.has(row.jobId),
      });
    }

    return { catalogues: Array.from(grouped.values()) };
  });

  app.post(
    '/v1/merchant/catalog/import',
    { preHandler: app.requireMerchant, schema: { body: MerchantCatalogImportBody } },
    async (req, reply) => {
      const merchantId = req.merchantClientId;
      if (!merchantId) throw new AppError('UNAUTH', 401, 'missing merchant');

      const { jobId, subcategoryId } = req.body as z.infer<typeof MerchantCatalogImportBody>;

      const [subcategory] = await app.db
        .select({ id: schema.merchantCatalogSubcategories.id })
        .from(schema.merchantCatalogSubcategories)
        .where(
          and(
            eq(schema.merchantCatalogSubcategories.id, subcategoryId),
            eq(schema.merchantCatalogSubcategories.merchantId, merchantId),
          ),
        )
        .limit(1);
      if (!subcategory) throw new AppError('NOT_FOUND', 404, 'subcategory not found');

      const [client] = await app.db
        .select({ userId: schema.merchants.userId })
        .from(schema.merchants)
        .where(eq(schema.merchants.id, merchantId))
        .limit(1);
      if (!client) throw new AppError('NOT_FOUND', 404, 'merchant not found');

      const [job] = await app.db
        .select({
          id: schema.jobs.id,
          userId: schema.jobs.userId,
          catalogueId: schema.jobs.catalogueId,
          status: schema.jobs.status,
          resultKey: schema.jobOutputs.resultKey,
          thumbnailKey: schema.jobOutputs.thumbnailKey,
        })
        .from(schema.jobs)
        .leftJoin(schema.jobOutputs, eq(schema.jobOutputs.jobId, schema.jobs.id))
        .where(eq(schema.jobs.id, jobId))
        .limit(1);

      if (!job) throw new AppError('NOT_FOUND', 404, 'job not found');
      if (job.userId !== client.userId) {
        throw new AppError('FORBIDDEN', 403, 'job does not belong to the linked studio user');
      }
      if (job.status !== 'COMPLETED') {
        throw new AppError('CONFLICT', 409, 'only completed jobs can be imported');
      }
      if (!job.resultKey) throw new AppError('BAD_UPLOAD', 400, 'job has no output');

      const item = await copyJobOutputIntoProduct(app, {
        merchantId,
        subcategoryId,
        job,
        resultKey: job.resultKey,
        thumbnailKey: job.thumbnailKey,
        sourceKind: 'imported',
      });

      reply.code(201);
      return await serializeCatalogItem(app, item);
    },
  );

  app.get('/v1/merchant/catalog/saree-styles', { preHandler: app.requireMerchant }, async () => {
    const rows = await app.db
      .select({
        id: schema.sareeMannequinStyles.id,
        label: schema.sareeMannequinStyles.label,
        previewImageKey: schema.sareeMannequinStyles.previewImageKey,
        sortOrder: schema.sareeMannequinStyles.sortOrder,
        mannequinTwoInputWorkflowTemplateId:
          schema.sareeMannequinStyles.mannequinTwoInputWorkflowTemplateId,
      })
      .from(schema.sareeMannequinStyles)
      .where(eq(schema.sareeMannequinStyles.isActive, true))
      .orderBy(schema.sareeMannequinStyles.sortOrder, schema.sareeMannequinStyles.label);

    const items = await Promise.all(
      rows.map(async (row) => ({
        id: row.id,
        label: row.label,
        previewUrl: row.previewImageKey
          ? await app.storage
              .presignGet(row.previewImageKey, 3600)
              .then((result) => result.url)
              .catch(() => null)
          : null,
        sortOrder: row.sortOrder,
        supportsTwoInput: row.mannequinTwoInputWorkflowTemplateId !== null,
      })),
    );
    return { items };
  });

  app.post(
    '/v1/merchant/catalog/generate',
    { preHandler: app.requireMerchant, schema: { body: MerchantCatalogGenerateBody } },
    async (req, reply) => {
      const merchantId = req.merchantClientId;
      if (!merchantId) throw new AppError('UNAUTH', 401, 'missing merchant');

      const { subcategoryId, flatImageKey, mannequinOnly, sareeStyleId, secondFlatImageKey } =
        req.body as z.infer<typeof MerchantCatalogGenerateBody>;

      const [row] = await app.db
        .select({
          userId: schema.merchants.userId,
          category: schema.merchantCatalogSubcategories.category,
          garmentSubcategoryId: schema.merchantCatalogSubcategories.garmentSubcategoryId,
        })
        .from(schema.merchantCatalogSubcategories)
        .innerJoin(
          schema.merchants,
          eq(schema.merchants.id, schema.merchantCatalogSubcategories.merchantId),
        )
        .where(
          and(
            eq(schema.merchantCatalogSubcategories.id, subcategoryId),
            eq(schema.merchantCatalogSubcategories.merchantId, merchantId),
          ),
        )
        .limit(1);
      if (!row) throw new AppError('NOT_FOUND', 404, 'subcategory not found');

      const { jobId } = mannequinOnly
        ? await createMerchantSareeMannequinJob(app, {
            userId: row.userId,
            garmentSubcategoryId: row.garmentSubcategoryId,
            flatImageKey,
            merchantId,
            sareeStyleId,
            secondFlatImageKey,
          })
        : await createMerchantCatalogJob(app, {
            userId: row.userId,
            garmentSubcategoryId: row.garmentSubcategoryId,
            category: row.category,
            flatImageKey,
            subcategoryId,
            merchantId,
            secondFlatImageKey,
          });

      reply.code(201);
      return { jobId };
    },
  );

  app.post(
    '/v1/merchant/catalog/generate-bulk',
    { preHandler: app.requireMerchant, schema: { body: MerchantCatalogGenerateBulkBody } },
    async (req, reply) => {
      const merchantId = req.merchantClientId;
      if (!merchantId) throw new AppError('UNAUTH', 401, 'missing merchant');

      const { subcategoryId, flatImageKeys } = req.body as z.infer<
        typeof MerchantCatalogGenerateBulkBody
      >;

      const [row] = await app.db
        .select({
          userId: schema.merchants.userId,
          category: schema.merchantCatalogSubcategories.category,
          garmentSubcategoryId: schema.merchantCatalogSubcategories.garmentSubcategoryId,
        })
        .from(schema.merchantCatalogSubcategories)
        .innerJoin(
          schema.merchants,
          eq(schema.merchants.id, schema.merchantCatalogSubcategories.merchantId),
        )
        .where(
          and(
            eq(schema.merchantCatalogSubcategories.id, subcategoryId),
            eq(schema.merchantCatalogSubcategories.merchantId, merchantId),
          ),
        )
        .limit(1);
      if (!row) throw new AppError('NOT_FOUND', 404, 'subcategory not found');

      const jobIds: string[] = [];
      const failures: Array<{ flatImageKey: string; error: string }> = [];
      for (const flatImageKey of flatImageKeys) {
        try {
          const { jobId } = await createMerchantCatalogJob(app, {
            userId: row.userId,
            garmentSubcategoryId: row.garmentSubcategoryId,
            category: row.category,
            flatImageKey,
            subcategoryId,
            merchantId,
            // Every bulk-flat batch is held for admin release — see Task 3's
            // POST /admin/held-jobs/release. The single-item /generate route
            // stays interactive because the merchant is waiting on it.
            hold: true,
          });
          jobIds.push(jobId);
        } catch (err) {
          if (!(err instanceof AppError)) {
            app.log.warn({ err, flatImageKey }, 'merchant catalog bulk generate: item failed');
          }
          failures.push({
            flatImageKey,
            error: err instanceof AppError ? err.message : 'unknown error',
          });
        }
      }

      // Always return per-item failures rather than throwing, even when every
      // item failed — the client needs the real reason for each row (e.g. a
      // missing admin default), not a generic "all failed" message.
      reply.code(201);
      return { jobIds, failures };
    },
  );

  app.get(
    '/v1/merchant/catalog/generate/status',
    { preHandler: app.requireMerchant },
    async (req) => {
      const merchantId = req.merchantClientId;
      if (!merchantId) throw new AppError('UNAUTH', 401, 'missing merchant');

      const { jobIds: jobIdsParam } = req.query as { jobIds?: string };
      const jobIds = (jobIdsParam ?? '').split(',').filter(Boolean);
      if (jobIds.length === 0) return { items: [] };

      const [client] = await app.db
        .select({ userId: schema.merchants.userId })
        .from(schema.merchants)
        .where(eq(schema.merchants.id, merchantId))
        .limit(1);
      if (!client) throw new AppError('NOT_FOUND', 404, 'merchant not found');

      const rows = await app.db
        .select({
          id: schema.jobs.id,
          userId: schema.jobs.userId,
          status: schema.jobs.status,
          errorCode: schema.jobs.errorCode,
          resultKey: schema.jobOutputs.resultKey,
        })
        .from(schema.jobs)
        .leftJoin(schema.jobOutputs, eq(schema.jobOutputs.jobId, schema.jobs.id))
        .where(inArray(schema.jobs.id, jobIds));

      const items = await Promise.all(
        rows
          .filter((row) => row.userId === client.userId)
          .map(async (row) => ({
            jobId: row.id,
            status: row.status,
            resultUrl: row.resultKey
              ? await app.storage
                  .presignGet(row.resultKey, 3600)
                  .then((r) => r.url)
                  .catch(() => null)
              : null,
            errorCode: row.errorCode,
          })),
      );

      return { items };
    },
  );

  app.get(
    '/v1/merchant/catalog/generate/:jobId',
    { preHandler: app.requireMerchant, schema: { params: z.object({ jobId: z.string().uuid() }) } },
    async (req) => {
      const merchantId = req.merchantClientId;
      if (!merchantId) throw new AppError('UNAUTH', 401, 'missing merchant');

      const { jobId } = req.params as { jobId: string };

      const [client] = await app.db
        .select({ userId: schema.merchants.userId })
        .from(schema.merchants)
        .where(eq(schema.merchants.id, merchantId))
        .limit(1);
      if (!client) throw new AppError('NOT_FOUND', 404, 'merchant not found');

      const [job] = await app.db
        .select({
          id: schema.jobs.id,
          userId: schema.jobs.userId,
          status: schema.jobs.status,
          errorCode: schema.jobs.errorCode,
          resultKey: schema.jobOutputs.resultKey,
        })
        .from(schema.jobs)
        .leftJoin(schema.jobOutputs, eq(schema.jobOutputs.jobId, schema.jobs.id))
        .where(eq(schema.jobs.id, jobId))
        .limit(1);
      if (!job || job.userId !== client.userId) {
        throw new AppError('NOT_FOUND', 404, 'job not found');
      }

      const resultUrl = job.resultKey
        ? await app.storage
            .presignGet(job.resultKey, 3600)
            .then((r) => r.url)
            .catch(() => null)
        : null;

      return { jobId: job.id, status: job.status, resultUrl, errorCode: job.errorCode };
    },
  );

  /**
   * Materializes completed held-batch jobs into products. The interactive
   * generate flow finalizes each job from the browser via /import, but a held
   * batch completes hours or days after the merchant closed the app — so the
   * app calls this on load instead. Rows land isActive=false; PATCHing in a SKU
   * and prices is what publishes them to the kiosk.
   */
  app.post(
    '/v1/merchant/catalog/reconcile-held',
    { preHandler: app.requireMerchant },
    async (req) => {
      const merchantId = req.merchantClientId;
      if (!merchantId) throw new AppError('UNAUTH', 401, 'missing merchant');

      const [client] = await app.db
        .select({ userId: schema.merchants.userId })
        .from(schema.merchants)
        .where(eq(schema.merchants.id, merchantId))
        .limit(1);
      if (!client) throw new AppError('NOT_FOUND', 404, 'merchant not found');

      const rows = await app.db
        .select({
          jobId: schema.jobs.id,
          catalogueId: schema.jobs.catalogueId,
          resultKey: schema.jobOutputs.resultKey,
          thumbnailKey: schema.jobOutputs.thumbnailKey,
          flatKey: schema.jobInputs.upperGarmentKey,
          params: schema.jobInputs.params,
        })
        .from(schema.jobs)
        .innerJoin(schema.jobInputs, eq(schema.jobInputs.jobId, schema.jobs.id))
        .innerJoin(schema.jobOutputs, eq(schema.jobOutputs.jobId, schema.jobs.id))
        .where(
          and(
            eq(schema.jobs.userId, client.userId),
            eq(schema.jobs.status, 'COMPLETED'),
            sql`${schema.jobInputs.params}->>'heldBatch' = 'true'`,
            sql`coalesce(${schema.jobInputs.params}->>'heldReconciled', 'false') <> 'true'`,
          ),
        )
        .limit(200);

      const created: Awaited<ReturnType<typeof serializeCatalogItem>>[] = [];
      let failed = 0;
      for (const row of rows) {
        const subcategoryId = (row.params as { subcategoryId?: string } | null)?.subcategoryId;
        if (!row.resultKey || !subcategoryId) {
          failed++;
          app.log.warn(
            { jobId: row.jobId, hasResultKey: !!row.resultKey, subcategoryId },
            'reconcile-held: job has incomplete data, cannot finalize',
          );
          continue;
        }
        try {
          const item = await copyJobOutputIntoProduct(app, {
            merchantId,
            subcategoryId,
            job: { id: row.jobId, catalogueId: row.catalogueId },
            resultKey: row.resultKey,
            thumbnailKey: row.thumbnailKey,
            sourceKind: 'generated',
            flatSourceKey: row.flatKey ?? undefined,
            isActive: false,
          });
          created.push(await serializeCatalogItem(app, item));
        } catch (err) {
          // 409 = a concurrent reconcile already claimed this job and created
          // its product — still mark reconciled below so this job stops being
          // re-selected, exactly as if this call had won the race itself.
          if (!(err instanceof AppError && err.statusCode === 409)) {
            failed++;
            app.log.warn({ err, jobId: row.jobId }, 'reconcile-held: failed to finalize job');
            continue;
          }
        }
        // Marks the job reconciled regardless of who actually created the
        // product (this call or a concurrent one), so a merchant deleting the
        // resulting product later never makes reconcile-held resurrect it —
        // idempotency lives on the job, not on whether the product row exists.
        try {
          await app.db
            .update(schema.jobInputs)
            .set({
              params: sql`${schema.jobInputs.params} || '{"heldReconciled": true}'::jsonb`,
            })
            .where(eq(schema.jobInputs.jobId, row.jobId));
        } catch (err) {
          // The product was already created (or a concurrent call already
          // created it) — only the reconciled-marker write failed. Count it
          // as failed so it's visible, but don't let it take down the whole
          // response; the job stays selectable next time, which will retry
          // this stamp (copyJobOutputIntoProduct's own 409 guard makes that
          // safe even if the product now exists).
          failed++;
          app.log.warn(
            { err, jobId: row.jobId },
            'reconcile-held: failed to stamp reconciled marker',
          );
        }
      }

      if (failed > 0) {
        app.log.error(
          { failed, total: rows.length },
          'reconcile-held: some jobs failed to finalize',
        );
      }
      return { created, failed };
    },
  );
}
