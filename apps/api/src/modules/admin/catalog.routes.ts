import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { keys } from '@tryme/storage';
import {
  BulkCatalogSubcatsBody,
  ConfirmCatalogItemBody,
  CreateCategoryBody,
  PatchCategoryBody,
  PresignCatalogItemBody,
  PublicApiSlugField,
} from '@tryme/types';
import { and, count, eq, ilike, inArray, isNull, ne } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { requirePermission } from './guard.js';

export async function adminCatalogRoutes(app: FastifyInstance) {
  const RW = requirePermission('catalog.write');
  const D = requirePermission('catalog.delete');

  app.get(
    '/admin/catalog/items',
    {
      preHandler: RW,
      schema: {
        querystring: z.object({
          genderSlug: z.string().optional(),
          type: z.string().optional(),
          categoryId: z.coerce.number().int().optional(),
        }),
      },
    },
    async (req) => {
      const { genderSlug, type, categoryId } = req.query as {
        genderSlug?: string;
        type?: string;
        categoryId?: number;
      };
      const conditions = [];
      if (genderSlug) conditions.push(eq(schema.catalogItems.genderSlug, genderSlug));
      if (type) conditions.push(eq(schema.catalogItems.type, type));
      if (categoryId) conditions.push(eq(schema.catalogItems.categoryId, categoryId));
      const rows = await app.db
        .select({
          id: schema.catalogItems.id,
          categoryId: schema.catalogItems.categoryId,
          type: schema.catalogItems.type,
          genderSlug: schema.catalogItems.genderSlug,
          label: schema.catalogItems.label,
          r2Key: schema.catalogItems.r2Key,
          thumbnailKey: schema.catalogItems.thumbnailKey,
          publicApiSlug: schema.catalogItems.publicApiSlug,
          isActive: schema.catalogItems.isActive,
          sortOrder: schema.catalogItems.sortOrder,
          createdAt: schema.catalogItems.createdAt,
          updatedAt: schema.catalogItems.updatedAt,
        })
        .from(schema.catalogItems)
        .where(conditions.length > 0 ? and(...conditions) : undefined);

      if (rows.length === 0) return rows;
      const itemIds = rows.map((r) => r.id);
      const links = await app.db
        .select()
        .from(schema.catalogItemSubcategories)
        .where(inArray(schema.catalogItemSubcategories.catalogItemId, itemIds));
      const subMap = new Map<string, string[]>();
      for (const l of links) {
        if (!subMap.has(l.catalogItemId)) subMap.set(l.catalogItemId, []);
        subMap.get(l.catalogItemId)?.push(l.subcategoryId);
      }
      return Promise.all(
        rows.map(async (r) => ({
          ...r,
          subcategoryIds: subMap.get(r.id) ?? [],
          thumbnailUrl: r.thumbnailKey
            ? (await app.storage.presignGet(r.thumbnailKey, 3600)).url
            : null,
          r2Url: r.r2Key ? (await app.storage.presignGet(r.r2Key, 3600)).url : null,
        })),
      );
    },
  );

  app.get('/admin/catalog/categories', { preHandler: RW }, async () => {
    const rows = await app.db
      .select({
        id: schema.catalogCategories.id,
        typeId: schema.catalogCategories.typeId,
        parentId: schema.catalogCategories.parentId,
        slug: schema.catalogCategories.slug,
        label: schema.catalogCategories.label,
        genderSlug: schema.catalogCategories.genderSlug,
        thumbnailKey: schema.catalogCategories.thumbnailKey,
        sortOrder: schema.catalogCategories.sortOrder,
        isActive: schema.catalogCategories.isActive,
        typeSlug: schema.catalogTypes.slug,
      })
      .from(schema.catalogCategories)
      .innerJoin(schema.catalogTypes, eq(schema.catalogCategories.typeId, schema.catalogTypes.id))
      .orderBy(schema.catalogCategories.sortOrder);
    return Promise.all(
      rows.map(async (r) => ({
        ...r,
        thumbnailUrl: r.thumbnailKey
          ? (await app.storage.presignGet(r.thumbnailKey, 3600)).url
          : null,
      })),
    );
  });

  app.post(
    '/admin/catalog/categories/presign',
    { preHandler: RW, schema: { body: z.object({ typeSlug: z.string() }) } },
    async (req) => {
      const { typeSlug } = req.body as { typeSlug: string };
      const id = randomUUID();
      const thumbKey = keys.catalogCategoryThumb(typeSlug, id);
      const result = await app.storage.presignPut(thumbKey, 'image/jpeg', 1_000_000, 300);
      return { uploadUrl: result.url, thumbnailKey: thumbKey };
    },
  );

  app.post(
    '/admin/catalog/items/presign',
    { preHandler: RW, schema: { body: PresignCatalogItemBody } },
    async (req) => {
      const { contentType, typeSlug } = req.body as z.infer<typeof PresignCatalogItemBody>;
      const newId = randomUUID();
      const r2Key = keys.catalogItem(typeSlug, newId);
      const thumbKey = keys.catalogThumb(typeSlug, newId);
      const main = await app.storage.presignPut(r2Key, contentType, 10_000_000, 300);
      // Thumbnails are downscaled to JPEG client-side; sign for image/jpeg.
      const thumb = await app.storage.presignPut(thumbKey, 'image/jpeg', 1_000_000, 300);
      return { uploadUrl: main.url, r2Key, thumbnailUploadUrl: thumb.url, thumbnailKey: thumbKey };
    },
  );

  app.post(
    '/admin/catalog/items/confirm',
    { preHandler: RW, schema: { body: ConfirmCatalogItemBody } },
    async (req) => {
      const {
        typeSlug,
        genderSlug,
        label,
        r2Key,
        thumbnailKey,
        sortOrder,
        subcategoryIds,
        categoryId,
      } = req.body as z.infer<typeof ConfirmCatalogItemBody>;
      const [existingLabel] = await app.db
        .select({ id: schema.catalogItems.id })
        .from(schema.catalogItems)
        .where(
          and(
            ilike(schema.catalogItems.label, label),
            eq(schema.catalogItems.type, typeSlug),
            genderSlug
              ? eq(schema.catalogItems.genderSlug, genderSlug)
              : isNull(schema.catalogItems.genderSlug),
          ),
        );
      if (existingLabel) {
        throw new AppError('CONFLICT', 409, `label "${label}" already exists`);
      }
      const row = await app.db.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(schema.catalogItems)
          .values({
            type: typeSlug,
            genderSlug: genderSlug ?? null,
            label,
            r2Key,
            thumbnailKey,
            sortOrder,
            categoryId: categoryId ?? null,
          })
          .returning();
        if (!inserted) throw new AppError('INTERNAL', 500, 'catalog item insert returned no row');
        if (subcategoryIds && subcategoryIds.length > 0) {
          await tx.insert(schema.catalogItemSubcategories).values(
            subcategoryIds.map((sid: string) => ({
              catalogItemId: inserted.id,
              subcategoryId: sid,
            })),
          );
        }
        return { ...inserted, subcategoryIds: subcategoryIds ?? [] };
      });
      return row;
    },
  );

  app.patch(
    '/admin/catalog/items/:id',
    {
      preHandler: RW,
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({
          label: z.string().max(120).optional(),
          isActive: z.boolean().optional(),
          sortOrder: z.number().int().optional(),
          genderSlug: z.enum(['men', 'women', 'boys', 'girls']).nullable().optional(),
          subcategoryIds: z.array(z.string().uuid()).optional(),
          r2Key: z.string().optional(),
          thumbnailKey: z.string().optional(),
          publicApiSlug: PublicApiSlugField,
        }),
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      // publicApiSlug arrives already normalized ('' -> null) by PublicApiSlugField.
      const { subcategoryIds, ...itemFields } = req.body as {
        label?: string;
        isActive?: boolean;
        sortOrder?: number;
        genderSlug?: 'men' | 'women' | 'boys' | 'girls' | null;
        subcategoryIds?: string[];
        r2Key?: string;
        thumbnailKey?: string;
        publicApiSlug?: string | null;
      };
      if (itemFields.label) {
        const [existing] = await app.db
          .select({ type: schema.catalogItems.type, genderSlug: schema.catalogItems.genderSlug })
          .from(schema.catalogItems)
          .where(eq(schema.catalogItems.id, id));
        const type = existing?.type;
        const genderSlug =
          itemFields.genderSlug !== undefined ? itemFields.genderSlug : existing?.genderSlug;
        const [existingLabel] = await app.db
          .select({ id: schema.catalogItems.id })
          .from(schema.catalogItems)
          .where(
            and(
              ilike(schema.catalogItems.label, itemFields.label),
              ne(schema.catalogItems.id, id),
              type ? eq(schema.catalogItems.type, type) : undefined,
              genderSlug
                ? eq(schema.catalogItems.genderSlug, genderSlug)
                : isNull(schema.catalogItems.genderSlug),
            ),
          );
        if (existingLabel) {
          throw new AppError('CONFLICT', 409, `label "${itemFields.label}" already exists`);
        }
      }
      await app.db.transaction(async (tx) => {
        if (Object.keys(itemFields).length > 0) {
          await tx
            .update(schema.catalogItems)
            .set({ ...itemFields, updatedAt: new Date() })
            .where(eq(schema.catalogItems.id, id));
        }
        if (subcategoryIds !== undefined) {
          await tx
            .delete(schema.catalogItemSubcategories)
            .where(eq(schema.catalogItemSubcategories.catalogItemId, id));
          if (subcategoryIds.length > 0) {
            await tx
              .insert(schema.catalogItemSubcategories)
              .values(
                subcategoryIds.map((sid: string) => ({ catalogItemId: id, subcategoryId: sid })),
              );
          }
        }
      });
      return { ok: true };
    },
  );

  app.delete(
    '/admin/catalog/items/:id',
    {
      preHandler: D,
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const [item] = await app.db
        .select()
        .from(schema.catalogItems)
        .where(eq(schema.catalogItems.id, id));
      if (!item) throw new AppError('NOT_FOUND', 404, 'item not found');
      await app.db.transaction(async (tx) => {
        // Nullify FK references in job_inputs before deleting the catalog row.
        await tx
          .update(schema.jobInputs)
          .set({ lowerCatalogId: null })
          .where(eq(schema.jobInputs.lowerCatalogId, id));
        await tx
          .update(schema.jobInputs)
          .set({ shoeCatalogId: null })
          .where(eq(schema.jobInputs.shoeCatalogId, id));
        await tx.delete(schema.catalogItems).where(eq(schema.catalogItems.id, id));
      });
      await app.storage.deleteObject(item.r2Key);
      await app.storage.deleteObject(item.thumbnailKey);
      return { ok: true };
    },
  );

  app.post(
    '/admin/catalog/categories',
    { preHandler: RW, schema: { body: CreateCategoryBody } },
    async (req) => {
      const body = req.body as z.infer<typeof CreateCategoryBody>;
      const [existingLabel] = await app.db
        .select({ id: schema.catalogCategories.id })
        .from(schema.catalogCategories)
        .where(
          and(
            ilike(schema.catalogCategories.label, body.label),
            eq(schema.catalogCategories.typeId, body.typeId),
            body.genderSlug
              ? eq(schema.catalogCategories.genderSlug, body.genderSlug)
              : isNull(schema.catalogCategories.genderSlug),
          ),
        );
      if (existingLabel) {
        throw new AppError('CONFLICT', 409, `label "${body.label}" already exists`);
      }
      const [row] = await app.db.insert(schema.catalogCategories).values(body).returning();
      if (!row) throw new AppError('INTERNAL', 500, 'category insert returned no row');
      const typeRow = await app.db
        .select({ slug: schema.catalogTypes.slug })
        .from(schema.catalogTypes)
        .where(eq(schema.catalogTypes.id, row.typeId))
        .then((r) => r[0]);
      return {
        ...row,
        typeSlug: typeRow?.slug ?? '',
        thumbnailUrl: row.thumbnailKey
          ? (await app.storage.presignGet(row.thumbnailKey, 3600)).url
          : null,
      };
    },
  );

  app.delete(
    '/admin/catalog/categories/:id',
    {
      preHandler: D,
      schema: { params: z.object({ id: z.coerce.number().int() }) },
    },
    async (req) => {
      const { id } = req.params as { id: number };
      const [itemsCount, backgroundsCount] = await Promise.all([
        app.db
          .select({ value: count() })
          .from(schema.catalogItems)
          .where(
            and(eq(schema.catalogItems.categoryId, id), eq(schema.catalogItems.isActive, true)),
          )
          .then((r) => r[0]?.value),
        app.db
          .select({ value: count() })
          .from(schema.modelBackgrounds)
          .where(
            and(
              eq(schema.modelBackgrounds.categoryId, id),
              eq(schema.modelBackgrounds.isActive, true),
              isNull(schema.modelBackgrounds.deletedAt),
            ),
          )
          .then((r) => r[0]?.value),
      ]);
      if (itemsCount > 0 || backgroundsCount > 0)
        throw new AppError('IN_USE', 409, 'category has active items');
      await app.db.delete(schema.catalogCategories).where(eq(schema.catalogCategories.id, id));
      return { ok: true };
    },
  );

  app.patch(
    '/admin/catalog/categories/:id',
    {
      preHandler: RW,
      schema: {
        params: z.object({ id: z.coerce.number().int() }),
        body: PatchCategoryBody,
      },
    },
    async (req) => {
      const { id } = req.params as { id: number };
      const body = req.body as z.infer<typeof PatchCategoryBody>;
      if (body.label) {
        const [current] = await app.db
          .select({
            typeId: schema.catalogCategories.typeId,
            genderSlug: schema.catalogCategories.genderSlug,
          })
          .from(schema.catalogCategories)
          .where(eq(schema.catalogCategories.id, id));
        const genderSlug = body.genderSlug !== undefined ? body.genderSlug : current?.genderSlug;
        const [existingLabel] = await app.db
          .select({ id: schema.catalogCategories.id })
          .from(schema.catalogCategories)
          .where(
            and(
              ilike(schema.catalogCategories.label, body.label),
              ne(schema.catalogCategories.id, id),
              current ? eq(schema.catalogCategories.typeId, current.typeId) : undefined,
              genderSlug
                ? eq(schema.catalogCategories.genderSlug, genderSlug)
                : isNull(schema.catalogCategories.genderSlug),
            ),
          );
        if (existingLabel) {
          throw new AppError('CONFLICT', 409, `label "${body.label}" already exists`);
        }
      }
      await app.db
        .update(schema.catalogCategories)
        .set(body)
        .where(eq(schema.catalogCategories.id, id));
      return { ok: true };
    },
  );

  app.get('/admin/catalog/types', { preHandler: RW }, async () => {
    return app.db.select().from(schema.catalogTypes);
  });

  app.patch(
    '/admin/catalog/items/bulk-subcategories',
    { preHandler: RW, schema: { body: BulkCatalogSubcatsBody } },
    async (req) => {
      const { ids, subcategoryIds } = req.body as { ids: string[]; subcategoryIds: string[] };
      await app.db.transaction(async (tx) => {
        await tx
          .delete(schema.catalogItemSubcategories)
          .where(inArray(schema.catalogItemSubcategories.catalogItemId, ids));
        if (subcategoryIds.length > 0) {
          await tx
            .insert(schema.catalogItemSubcategories)
            .values(
              ids.flatMap((itemId) =>
                subcategoryIds.map((subcategoryId) => ({ catalogItemId: itemId, subcategoryId })),
              ),
            );
        }
      });
      return { ok: true, updated: ids.length };
    },
  );
}
