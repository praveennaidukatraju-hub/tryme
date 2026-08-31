import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { keys } from '@tryme/storage';
import {
  CreateTryonCategoryBody,
  CreateTryonSampleBody,
  TryonSamplePresignBody,
  UpdateTryonCategoryBody,
} from '@tryme/types';
import { and, asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { requirePermission } from './guard.js';

export async function adminTryonRoutes(app: FastifyInstance) {
  const W = requirePermission('tryon.write');
  const R = requirePermission('tryon.read');
  const uuidParam = z.object({ id: z.string().uuid() });

  // GET /admin/tryon-categories — list with workflow label + samples
  app.get('/admin/tryon-categories', { preHandler: R }, async () => {
    const cats = await app.db
      .select()
      .from(schema.tryonCategories)
      .orderBy(asc(schema.tryonCategories.sortOrder));
    const samples = await app.db
      .select()
      .from(schema.tryonCategorySamples)
      .orderBy(asc(schema.tryonCategorySamples.sortOrder));
    const byCat = new Map<string, typeof samples>();
    for (const s of samples) {
      if (!byCat.has(s.categoryId)) byCat.set(s.categoryId, []);
      byCat.get(s.categoryId)?.push(s);
    }
    return cats.map((c) => ({ ...c, samples: byCat.get(c.id) ?? [] }));
  });

  // POST /admin/tryon-categories
  app.post(
    '/admin/tryon-categories',
    { preHandler: W, schema: { body: CreateTryonCategoryBody } },
    async (req) => {
      const body = req.body as z.infer<typeof CreateTryonCategoryBody>;
      try {
        const [row] = await app.db
          .insert(schema.tryonCategories)
          .values({
            name: body.name,
            slug: body.slug,
            workflowTemplateId: body.workflowTemplateId ?? null,
            sortOrder: body.sortOrder ?? 0,
            isActive: body.isActive ?? true,
          })
          .returning();
        return { ...row, samples: [] };
      } catch (err) {
        if ((err as { code?: string }).code === '23505') {
          throw new AppError('CONFLICT', 409, `slug "${body.slug}" already exists`);
        }
        throw err;
      }
    },
  );

  // PATCH /admin/tryon-categories/:id
  app.patch(
    '/admin/tryon-categories/:id',
    { preHandler: W, schema: { params: uuidParam, body: UpdateTryonCategoryBody } },
    async (req) => {
      const { id } = req.params as { id: string };
      const body = req.body as z.infer<typeof UpdateTryonCategoryBody>;
      const [row] = await app.db
        .update(schema.tryonCategories)
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.workflowTemplateId !== undefined
            ? { workflowTemplateId: body.workflowTemplateId }
            : {}),
          ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
          ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
          updatedAt: new Date(),
        })
        .where(eq(schema.tryonCategories.id, id))
        .returning();
      if (!row) throw new AppError('NOT_FOUND', 404, 'category not found');
      return row;
    },
  );

  // DELETE /admin/tryon-categories/:id  (cascades samples)
  app.delete(
    '/admin/tryon-categories/:id',
    { preHandler: W, schema: { params: uuidParam } },
    async (req) => {
      const { id } = req.params as { id: string };
      const samples = await app.db
        .select({
          r2Key: schema.tryonCategorySamples.r2Key,
          thumbnailKey: schema.tryonCategorySamples.thumbnailKey,
        })
        .from(schema.tryonCategorySamples)
        .where(eq(schema.tryonCategorySamples.categoryId, id));
      const deleted = await app.db
        .delete(schema.tryonCategories)
        .where(eq(schema.tryonCategories.id, id))
        .returning({ id: schema.tryonCategories.id });
      if (!deleted.length) throw new AppError('NOT_FOUND', 404, 'category not found');
      void Promise.allSettled(
        samples.flatMap((s) => [
          app.storage.deleteObject(s.r2Key),
          s.thumbnailKey ? app.storage.deleteObject(s.thumbnailKey) : Promise.resolve(),
        ]),
      );
      return { ok: true };
    },
  );

  // POST /admin/tryon-categories/:id/samples/presign
  app.post(
    '/admin/tryon-categories/:id/samples/presign',
    { preHandler: W, schema: { params: uuidParam, body: TryonSamplePresignBody } },
    async (req) => {
      const { id } = req.params as { id: string };
      const [cat] = await app.db
        .select({ id: schema.tryonCategories.id })
        .from(schema.tryonCategories)
        .where(eq(schema.tryonCategories.id, id));
      if (!cat) throw new AppError('NOT_FOUND', 404, 'category not found');
      const { contentType } = req.body as z.infer<typeof TryonSamplePresignBody>;
      const sampleId = randomUUID();
      const r2Key = keys.tryonSample(id, sampleId);
      const thumbKey = keys.tryonSampleThumb(id, sampleId);
      const [main, thumb] = await Promise.all([
        app.storage.presignPut(r2Key, contentType, 10_000_000, 300),
        app.storage.presignPut(thumbKey, 'image/jpeg', 1_000_000, 300),
      ]);
      return { r2Key, uploadUrl: main.url, thumbnailKey: thumbKey, thumbnailUploadUrl: thumb.url };
    },
  );

  // POST /admin/tryon-categories/:id/samples — record uploaded sample
  app.post(
    '/admin/tryon-categories/:id/samples',
    { preHandler: W, schema: { params: uuidParam, body: CreateTryonSampleBody } },
    async (req) => {
      const { id } = req.params as { id: string };
      const body = req.body as z.infer<typeof CreateTryonSampleBody>;
      const [cat] = await app.db
        .select({ id: schema.tryonCategories.id })
        .from(schema.tryonCategories)
        .where(eq(schema.tryonCategories.id, id));
      if (!cat) throw new AppError('NOT_FOUND', 404, 'category not found');
      const [row] = await app.db
        .insert(schema.tryonCategorySamples)
        .values({
          categoryId: id,
          r2Key: body.r2Key,
          thumbnailKey: body.thumbnailKey ?? null,
          sortOrder: body.sortOrder ?? 0,
        })
        .returning();
      return row;
    },
  );

  // DELETE /admin/tryon-categories/:id/samples/:sampleId
  app.delete(
    '/admin/tryon-categories/:id/samples/:sampleId',
    {
      preHandler: W,
      schema: { params: z.object({ id: z.string().uuid(), sampleId: z.string().uuid() }) },
    },
    async (req) => {
      const { id, sampleId } = req.params as { id: string; sampleId: string };
      const [sample] = await app.db
        .select({
          r2Key: schema.tryonCategorySamples.r2Key,
          thumbnailKey: schema.tryonCategorySamples.thumbnailKey,
        })
        .from(schema.tryonCategorySamples)
        .where(
          and(
            eq(schema.tryonCategorySamples.id, sampleId),
            eq(schema.tryonCategorySamples.categoryId, id),
          ),
        );
      if (!sample) throw new AppError('NOT_FOUND', 404, 'sample not found');
      await app.db
        .delete(schema.tryonCategorySamples)
        .where(
          and(
            eq(schema.tryonCategorySamples.id, sampleId),
            eq(schema.tryonCategorySamples.categoryId, id),
          ),
        );
      void Promise.allSettled([
        app.storage.deleteObject(sample.r2Key),
        sample.thumbnailKey ? app.storage.deleteObject(sample.thumbnailKey) : Promise.resolve(),
      ]);
      return { ok: true };
    },
  );

  const SETTINGS_ID = '00000000-0000-0000-0000-000000000001';

  // GET /admin/tryon-settings — returns global sample keys + presigned URLs
  app.get('/admin/tryon-settings', { preHandler: R }, async () => {
    const [row] = await app.db
      .select()
      .from(schema.tryonSettings)
      .where(eq(schema.tryonSettings.id, SETTINGS_ID));
    if (!row) return { personSampleUrl: null, garmentSampleUrl: null };
    const presign = async (key: string | null) => {
      if (!key) return null;
      try {
        return (await app.storage.presignGet(key, 3600)).url;
      } catch {
        return null;
      }
    };
    const [personSampleUrl, garmentSampleUrl] = await Promise.all([
      presign(row.personSampleThumbKey ?? row.personSampleKey),
      presign(row.garmentSampleThumbKey ?? row.garmentSampleKey),
    ]);
    return { personSampleUrl, garmentSampleUrl };
  });

  // POST /admin/tryon-settings/presign?type=person|garment
  app.post(
    '/admin/tryon-settings/presign',
    {
      preHandler: W,
      schema: {
        body: z.object({ type: z.enum(['person', 'garment']), contentType: z.string() }),
      },
    },
    async (req) => {
      const { type, contentType } = req.body as { type: 'person' | 'garment'; contentType: string };
      const r2Key = type === 'person' ? keys.tryonPersonSample() : keys.tryonGarmentSample();
      const thumbKey =
        type === 'person' ? keys.tryonPersonSampleThumb() : keys.tryonGarmentSampleThumb();
      const [main, thumb] = await Promise.all([
        app.storage.presignPut(r2Key, contentType, 10_000_000, 300),
        app.storage.presignPut(thumbKey, 'image/jpeg', 1_000_000, 300),
      ]);
      return { r2Key, uploadUrl: main.url, thumbnailKey: thumbKey, thumbnailUploadUrl: thumb.url };
    },
  );

  // PATCH /admin/tryon-settings — save person/garment keys after upload
  app.patch(
    '/admin/tryon-settings',
    {
      preHandler: W,
      schema: {
        body: z.object({
          personSampleKey: z.string().optional(),
          personSampleThumbKey: z.string().optional(),
          garmentSampleKey: z.string().optional(),
          garmentSampleThumbKey: z.string().optional(),
        }),
      },
    },
    async (req) => {
      const body = req.body as {
        personSampleKey?: string;
        personSampleThumbKey?: string;
        garmentSampleKey?: string;
        garmentSampleThumbKey?: string;
      };
      await app.db
        .insert(schema.tryonSettings)
        .values({ id: SETTINGS_ID, ...body, updatedAt: new Date() })
        .onConflictDoUpdate({
          target: schema.tryonSettings.id,
          set: { ...body, updatedAt: new Date() },
        });
      return { ok: true };
    },
  );
}
