import { schema } from '@tryme/db';
import {
  CreateDevTryonCategoryBody,
  UpdateDevSareeConfigBody,
  UpdateDevTryonCategoryBody,
} from '@tryme/types';
import { and, asc, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  bumpCatalogOptionsVersion,
  getCatalogOptionsVersion,
} from '../../lib/catalog-options-cache.js';
import { AppError } from '../../lib/errors.js';
import { makeUniqueSlug } from '../../lib/slugify.js';
import { requirePermission } from './guard.js';

const DEV_SAREE_CONFIG_ID = '00000000-0000-0000-0000-000000000002';

export async function adminDevApiRoutes(app: FastifyInstance) {
  const W = requirePermission('dev_api.write');
  const R = requirePermission('dev_api.read');
  const uuidParam = z.object({ id: z.string().uuid() });

  // Manual escape hatch for the catalog options cache. The onResponse hook in
  // plugins/catalog-cache-invalidation.ts already bumps the generation on every
  // successful /admin/assets and /admin/catalog mutation, so this exists only for
  // the cases the hook cannot see — a direct DB edit, or a suspected desync.
  app.post('/admin/dev-api/catalog/rebuild-cache', { preHandler: W }, async () => {
    await bumpCatalogOptionsVersion(app);
    return { ok: true, version: await getCatalogOptionsVersion(app) };
  });

  // One-time bulk opt-in: assigns a public_api_slug to every currently-unpublished
  // active asset, so /v1/dev/catalog/options isn't empty until an admin hand-edits
  // hundreds of rows one at a time through the individual asset editors. Slugs are
  // derived from each row's own label; see lib/slugify.ts for why a bare
  // slugify(label) isn't enough (labels collide across genders, and some are
  // literally a UUID). Re-running this is safe and cheap — every WHERE clause
  // excludes rows that already have a slug, so it only ever fills gaps.
  //
  // Eligibility mirrors buildCatalogOptions()'s WHERE clauses exactly (catalog-
  // options/build.ts) — publishing a row that query would filter out anyway
  // (wrong scope, inactive, soft-deleted) would just mislead an admin into
  // thinking it's live when it structurally can never appear.
  app.post('/admin/dev-api/catalog/backfill-slugs', { preHandler: W }, async (req) => {
    const counts = await app.db.transaction(async (tx) => {
      // ── model_faces ──────────────────────────────────────────────────────
      // Seeded from EVERY row with a slug, not just active/non-deleted ones:
      // the partial unique index has no such condition, so a soft-deleted row
      // still occupies its slug at the DB level.
      const usedFaceSlugs = new Set(
        (await tx.select({ slug: schema.modelFaces.publicApiSlug }).from(schema.modelFaces))
          .map((r) => r.slug)
          .filter((s): s is string => s != null),
      );
      const faceRows = await tx
        .select({
          id: schema.modelFaces.id,
          label: schema.modelFaces.label,
          gender: schema.modelFaces.gender,
        })
        .from(schema.modelFaces)
        .where(
          and(
            eq(schema.modelFaces.isActive, true),
            isNull(schema.modelFaces.deletedAt),
            isNull(schema.modelFaces.publicApiSlug),
          ),
        );
      for (const row of faceRows) {
        const slug = makeUniqueSlug(row.label, [row.gender], row.id, usedFaceSlugs, 'face');
        await tx
          .update(schema.modelFaces)
          .set({ publicApiSlug: slug })
          .where(eq(schema.modelFaces.id, row.id));
      }

      // ── model_backgrounds ────────────────────────────────────────────────
      const usedBackgroundSlugs = new Set(
        (
          await tx
            .select({ slug: schema.modelBackgrounds.publicApiSlug })
            .from(schema.modelBackgrounds)
        )
          .map((r) => r.slug)
          .filter((s): s is string => s != null),
      );
      const backgroundRows = await tx
        .select({
          id: schema.modelBackgrounds.id,
          label: schema.modelBackgrounds.label,
          genderSlug: schema.modelBackgrounds.genderSlug,
        })
        .from(schema.modelBackgrounds)
        .where(
          and(
            eq(schema.modelBackgrounds.isActive, true),
            isNull(schema.modelBackgrounds.deletedAt),
            eq(schema.modelBackgrounds.scope, 'general'),
            isNull(schema.modelBackgrounds.publicApiSlug),
          ),
        );
      for (const row of backgroundRows) {
        const slug = makeUniqueSlug(
          row.label,
          [row.genderSlug ?? 'general'],
          row.id,
          usedBackgroundSlugs,
          'background',
        );
        await tx
          .update(schema.modelBackgrounds)
          .set({ publicApiSlug: slug })
          .where(eq(schema.modelBackgrounds.id, row.id));
      }

      // ── model_pose_assets ────────────────────────────────────────────────
      const usedPoseSlugs = new Set(
        (
          await tx
            .select({ slug: schema.modelPoseAssets.publicApiSlug })
            .from(schema.modelPoseAssets)
        )
          .map((r) => r.slug)
          .filter((s): s is string => s != null),
      );
      const poseRows = await tx
        .select({
          id: schema.modelPoseAssets.id,
          label: schema.modelPoseAssets.label,
          displayName: schema.modelPoseAssets.displayName,
          genderSlug: schema.modelPoseAssets.genderSlug,
        })
        .from(schema.modelPoseAssets)
        .where(
          and(
            eq(schema.modelPoseAssets.isActive, true),
            isNull(schema.modelPoseAssets.deletedAt),
            eq(schema.modelPoseAssets.scope, 'general'),
            isNull(schema.modelPoseAssets.publicApiSlug),
          ),
        );
      for (const row of poseRows) {
        const slug = makeUniqueSlug(
          row.displayName || row.label,
          [row.genderSlug ?? 'general'],
          row.id,
          usedPoseSlugs,
          'pose',
        );
        await tx
          .update(schema.modelPoseAssets)
          .set({ publicApiSlug: slug })
          .where(eq(schema.modelPoseAssets.id, row.id));
      }

      // ── catalog_items ────────────────────────────────────────────────────
      const usedCatalogItemSlugs = new Set(
        (await tx.select({ slug: schema.catalogItems.publicApiSlug }).from(schema.catalogItems))
          .map((r) => r.slug)
          .filter((s): s is string => s != null),
      );
      const catalogItemRows = await tx
        .select({
          id: schema.catalogItems.id,
          label: schema.catalogItems.label,
          genderSlug: schema.catalogItems.genderSlug,
          type: schema.catalogItems.type,
        })
        .from(schema.catalogItems)
        .where(
          and(eq(schema.catalogItems.isActive, true), isNull(schema.catalogItems.publicApiSlug)),
        );
      for (const row of catalogItemRows) {
        // type must disambiguate before an id suffix: lower vs shoe items can
        // share a label, and the unique index has no type column of its own.
        const slug = makeUniqueSlug(
          row.label,
          [row.genderSlug ?? 'general', row.type],
          row.id,
          usedCatalogItemSlugs,
          row.type,
        );
        await tx
          .update(schema.catalogItems)
          .set({ publicApiSlug: slug })
          .where(eq(schema.catalogItems.id, row.id));
      }

      // ── garment_subcategories ────────────────────────────────────────────
      const usedGarmentTypeSlugs = new Set(
        (
          await tx
            .select({ slug: schema.garmentSubcategories.publicApiSlug })
            .from(schema.garmentSubcategories)
        )
          .map((r) => r.slug)
          .filter((s): s is string => s != null),
      );
      const garmentTypeRows = await tx
        .select({
          id: schema.garmentSubcategories.id,
          label: schema.garmentSubcategories.label,
          genderSlug: schema.garmentSubcategories.genderSlug,
        })
        .from(schema.garmentSubcategories)
        .where(
          and(
            eq(schema.garmentSubcategories.isActive, true),
            isNull(schema.garmentSubcategories.publicApiSlug),
          ),
        );
      for (const row of garmentTypeRows) {
        const slug = makeUniqueSlug(
          row.label,
          [row.genderSlug],
          row.id,
          usedGarmentTypeSlugs,
          'garment-type',
        );
        await tx
          .update(schema.garmentSubcategories)
          .set({ publicApiSlug: slug })
          .where(eq(schema.garmentSubcategories.id, row.id));
      }

      return {
        modelFaces: faceRows.length,
        modelBackgrounds: backgroundRows.length,
        modelPoseAssets: poseRows.length,
        catalogItems: catalogItemRows.length,
        garmentSubcategories: garmentTypeRows.length,
      };
    });

    await bumpCatalogOptionsVersion(app);

    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    app.log.info(
      { adminUserId: req.userId, counts, total },
      'catalog public_api_slug backfill executed',
    );

    return { ok: true, counts, total, version: await getCatalogOptionsVersion(app) };
  });

  app.get('/admin/dev-api/tryon-categories', { preHandler: R }, async () => {
    return app.db
      .select()
      .from(schema.devTryonCategories)
      .orderBy(asc(schema.devTryonCategories.sortOrder));
  });

  app.post(
    '/admin/dev-api/tryon-categories',
    { preHandler: W, schema: { body: CreateDevTryonCategoryBody } },
    async (req) => {
      const body = req.body as z.infer<typeof CreateDevTryonCategoryBody>;
      try {
        const [row] = await app.db
          .insert(schema.devTryonCategories)
          .values({
            name: body.name,
            slug: body.slug,
            workflowTemplateId: body.workflowTemplateId ?? null,
            sortOrder: body.sortOrder ?? 0,
            isActive: body.isActive ?? true,
          })
          .returning();
        return row;
      } catch (err) {
        if ((err as { code?: string }).code === '23505') {
          throw new AppError('CONFLICT', 409, `slug "${body.slug}" already exists`);
        }
        throw err;
      }
    },
  );

  app.patch(
    '/admin/dev-api/tryon-categories/:id',
    { preHandler: W, schema: { params: uuidParam, body: UpdateDevTryonCategoryBody } },
    async (req) => {
      const { id } = req.params as { id: string };
      const body = req.body as z.infer<typeof UpdateDevTryonCategoryBody>;
      const [row] = await app.db
        .update(schema.devTryonCategories)
        .set({
          ...(body.name !== undefined ? { name: body.name } : {}),
          ...(body.workflowTemplateId !== undefined
            ? { workflowTemplateId: body.workflowTemplateId }
            : {}),
          ...(body.sortOrder !== undefined ? { sortOrder: body.sortOrder } : {}),
          ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
          updatedAt: new Date(),
        })
        .where(eq(schema.devTryonCategories.id, id))
        .returning();
      if (!row) throw new AppError('NOT_FOUND', 404, 'category not found');
      return row;
    },
  );

  app.delete(
    '/admin/dev-api/tryon-categories/:id',
    { preHandler: W, schema: { params: uuidParam } },
    async (req) => {
      const { id } = req.params as { id: string };
      const deleted = await app.db
        .delete(schema.devTryonCategories)
        .where(eq(schema.devTryonCategories.id, id))
        .returning({ id: schema.devTryonCategories.id });
      if (!deleted.length) throw new AppError('NOT_FOUND', 404, 'category not found');
      return { ok: true };
    },
  );

  app.get('/admin/dev-api/saree-config', { preHandler: R }, async () => {
    const [row] = await app.db
      .select({
        workflowTemplateId: schema.devSareeMannequinConfig.workflowTemplateId,
        isActive: schema.devSareeMannequinConfig.isActive,
        updatedAt: schema.devSareeMannequinConfig.updatedAt,
      })
      .from(schema.devSareeMannequinConfig)
      .where(eq(schema.devSareeMannequinConfig.id, DEV_SAREE_CONFIG_ID));
    return row ?? { workflowTemplateId: null, isActive: false, updatedAt: null };
  });

  app.patch(
    '/admin/dev-api/saree-config',
    { preHandler: W, schema: { body: UpdateDevSareeConfigBody } },
    async (req) => {
      const body = req.body as z.infer<typeof UpdateDevSareeConfigBody>;
      const [row] = await app.db
        .insert(schema.devSareeMannequinConfig)
        .values({
          id: DEV_SAREE_CONFIG_ID,
          workflowTemplateId: body.workflowTemplateId ?? null,
          isActive: body.isActive ?? true,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: schema.devSareeMannequinConfig.id,
          set: {
            ...(body.workflowTemplateId !== undefined
              ? { workflowTemplateId: body.workflowTemplateId }
              : {}),
            ...(body.isActive !== undefined ? { isActive: body.isActive } : {}),
            updatedAt: new Date(),
          },
        })
        .returning({
          workflowTemplateId: schema.devSareeMannequinConfig.workflowTemplateId,
          isActive: schema.devSareeMannequinConfig.isActive,
          updatedAt: schema.devSareeMannequinConfig.updatedAt,
        });
      return row;
    },
  );
}
