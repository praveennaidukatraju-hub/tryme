import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { keys } from '@tryme/storage';
import {
  CreateCatalogueTemplateBody,
  PatchCatalogueTemplateBody,
  PresignCatalogueTemplateThumbnailBody,
  PutCatalogueTemplateLooksBody,
} from '@tryme/types';
import { and, asc, eq, ilike, inArray, isNull, ne, notInArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { requirePermission } from './guard.js';
import { resolveForTemplate } from './shot-type-resolve.js';

export async function adminCatalogueTemplatesRoutes(app: FastifyInstance) {
  const RW = requirePermission('catalogue_templates.write');
  const D = requirePermission('catalogue_templates.delete');
  const uuidParam = z.object({ id: z.string().uuid() });

  app.get('/admin/assets/catalogue-templates', { preHandler: RW }, async () => {
    const templates = await app.db
      .select()
      .from(schema.catalogueTemplates)
      .where(isNull(schema.catalogueTemplates.deletedAt))
      .orderBy(asc(schema.catalogueTemplates.sortOrder));
    const looks = await app.db.select().from(schema.catalogueTemplateLooks);
    const lookCountByTemplate = new Map<string, number>();
    for (const l of looks) {
      lookCountByTemplate.set(l.templateId, (lookCountByTemplate.get(l.templateId) ?? 0) + 1);
    }
    return {
      items: await Promise.all(
        templates.map(async (t) => ({
          ...t,
          thumbnailUrl: t.thumbnailKey
            ? (await app.storage.presignGet(t.thumbnailKey, 3600)).url
            : null,
          lookCount: lookCountByTemplate.get(t.id) ?? 0,
        })),
      ),
    };
  });

  app.post(
    '/admin/assets/catalogue-templates/thumbnail/presign',
    { preHandler: RW, schema: { body: PresignCatalogueTemplateThumbnailBody } },
    async (_req) => {
      const newId = randomUUID();
      const thumbnailKey = keys.catalogueTemplateThumb(newId);
      const { url } = await app.storage.presignPut(thumbnailKey, 'image/jpeg', 5_000_000, 300);
      return { uploadUrl: url, thumbnailKey };
    },
  );

  app.post(
    '/admin/assets/catalogue-templates',
    { preHandler: RW, schema: { body: CreateCatalogueTemplateBody } },
    async (req) => {
      const body = req.body as z.infer<typeof CreateCatalogueTemplateBody>;
      const [existingLabel] = await app.db
        .select({ id: schema.catalogueTemplates.id })
        .from(schema.catalogueTemplates)
        .where(
          and(
            ilike(schema.catalogueTemplates.label, body.label),
            eq(schema.catalogueTemplates.genderSlug, body.genderSlug),
            isNull(schema.catalogueTemplates.deletedAt),
          ),
        );
      if (existingLabel) {
        throw new AppError('CONFLICT', 409, `label "${body.label}" already exists`);
      }
      const [row] = await app.db
        .insert(schema.catalogueTemplates)
        .values({
          genderSlug: body.genderSlug,
          label: body.label,
          thumbnailKey: body.thumbnailKey ?? null,
          sortOrder: body.sortOrder,
        })
        .returning();
      return row;
    },
  );

  app.patch(
    '/admin/assets/catalogue-templates/:id',
    { preHandler: RW, schema: { params: uuidParam, body: PatchCatalogueTemplateBody } },
    async (req) => {
      const { id } = req.params as { id: string };
      const body = req.body as Record<string, unknown>;
      if (typeof body.label === 'string') {
        const [current] = await app.db
          .select({ genderSlug: schema.catalogueTemplates.genderSlug })
          .from(schema.catalogueTemplates)
          .where(eq(schema.catalogueTemplates.id, id));
        const [existingLabel] = await app.db
          .select({ id: schema.catalogueTemplates.id })
          .from(schema.catalogueTemplates)
          .where(
            and(
              ilike(schema.catalogueTemplates.label, body.label),
              isNull(schema.catalogueTemplates.deletedAt),
              ne(schema.catalogueTemplates.id, id),
              current ? eq(schema.catalogueTemplates.genderSlug, current.genderSlug) : undefined,
            ),
          );
        if (existingLabel) {
          throw new AppError('CONFLICT', 409, `label "${body.label}" already exists`);
        }
      }
      if ('thumbnailKey' in body) {
        const [current] = await app.db
          .select({ thumbnailKey: schema.catalogueTemplates.thumbnailKey })
          .from(schema.catalogueTemplates)
          .where(eq(schema.catalogueTemplates.id, id));
        if (current?.thumbnailKey) {
          await app.storage.deleteObject(current.thumbnailKey).catch(() => {});
        }
      }
      const [updated] = await app.db
        .update(schema.catalogueTemplates)
        .set({ ...body, updatedAt: new Date() })
        .where(eq(schema.catalogueTemplates.id, id))
        .returning({ id: schema.catalogueTemplates.id });
      if (!updated) throw new AppError('NOT_FOUND', 404, 'catalogue template not found');
      return { ok: true };
    },
  );

  app.delete(
    '/admin/assets/catalogue-templates/:id',
    { preHandler: D, schema: { params: uuidParam } },
    async (req) => {
      const { id } = req.params as { id: string };
      const [row] = await app.db
        .select()
        .from(schema.catalogueTemplates)
        .where(eq(schema.catalogueTemplates.id, id));
      if (!row) throw new AppError('NOT_FOUND', 404, 'catalogue template not found');
      await app.db
        .update(schema.catalogueTemplates)
        .set({ deletedAt: new Date() })
        .where(eq(schema.catalogueTemplates.id, id));
      return { ok: true };
    },
  );

  app.put(
    '/admin/assets/catalogue-templates/:id/looks',
    { preHandler: RW, schema: { params: uuidParam, body: PutCatalogueTemplateLooksBody } },
    async (req) => {
      const { id } = req.params as { id: string };
      const { looks } = req.body as z.infer<typeof PutCatalogueTemplateLooksBody>;

      const [template] = await app.db
        .select({ id: schema.catalogueTemplates.id })
        .from(schema.catalogueTemplates)
        .where(eq(schema.catalogueTemplates.id, id));
      if (!template) throw new AppError('NOT_FOUND', 404, 'catalogue template not found');

      const dedupeKeys = new Set(looks.map((l) => `${l.poseAssetId}::${l.backgroundId}`));
      if (dedupeKeys.size !== looks.length) {
        throw new AppError('VALIDATION', 400, 'duplicate pose+background combination');
      }

      if (looks.length > 0) {
        const poseIds = Array.from(new Set(looks.map((l) => l.poseAssetId)));
        const backgroundIds = Array.from(new Set(looks.map((l) => l.backgroundId)));
        const [poseRows, backgroundRows] = await Promise.all([
          app.db
            .select({ id: schema.modelPoseAssets.id })
            .from(schema.modelPoseAssets)
            .where(
              and(
                inArray(schema.modelPoseAssets.id, poseIds),
                eq(schema.modelPoseAssets.isActive, true),
                isNull(schema.modelPoseAssets.deletedAt),
              ),
            ),
          app.db
            .select({ id: schema.modelBackgrounds.id })
            .from(schema.modelBackgrounds)
            .where(
              and(
                inArray(schema.modelBackgrounds.id, backgroundIds),
                eq(schema.modelBackgrounds.isActive, true),
                isNull(schema.modelBackgrounds.deletedAt),
                ne(schema.modelBackgrounds.scope, 'user'),
              ),
            ),
        ]);
        if (poseRows.length !== poseIds.length) {
          throw new AppError('VALIDATION', 400, 'one or more poses not found or inactive');
        }
        if (backgroundRows.length !== backgroundIds.length) {
          throw new AppError('VALIDATION', 400, 'one or more backgrounds not found or inactive');
        }
      }

      const resolvedCount = await app.db.transaction(async (tx) => {
        await tx
          .delete(schema.catalogueTemplateLooks)
          .where(eq(schema.catalogueTemplateLooks.templateId, id));
        if (looks.length > 0) {
          await tx.insert(schema.catalogueTemplateLooks).values(
            looks.map((l, i) => ({
              templateId: id,
              poseAssetId: l.poseAssetId,
              backgroundId: l.backgroundId,
              sortOrder: i,
            })),
          );
        }

        // Retag a pose's shot type in place — lets an admin correct an existing
        // look's category without re-uploading its image. Must run before the
        // resolve call below so the cascade sees the new value.
        for (const l of looks) {
          if (!l.shotType) continue;
          await tx
            .update(schema.modelPoseAssets)
            .set({ shotType: l.shotType })
            .where(eq(schema.modelPoseAssets.id, l.poseAssetId));
        }

        // Every pose upload in this builder is fresh (a new pose_asset_id), so
        // "correct a mis-tagged pose by re-uploading it" — or simply removing a
        // look — always leaves the old pose's workflow row behind with nothing
        // pointing at it anymore. Delete any catalogue_template_pose_workflows row,
        // across every garment type this template is mapped to, whose pose is no
        // longer among the template's current looks.
        const mappingRows = await tx
          .select({ id: schema.catalogueTemplateSubcategories.id })
          .from(schema.catalogueTemplateSubcategories)
          .where(eq(schema.catalogueTemplateSubcategories.templateId, id));
        const mappingIds = mappingRows.map((m) => m.id);
        if (mappingIds.length > 0) {
          const currentPoseIds = looks.map((l) => l.poseAssetId);
          const staleConditions = [
            inArray(schema.catalogueTemplatePoseWorkflows.mappingId, mappingIds),
          ];
          if (currentPoseIds.length > 0) {
            staleConditions.push(
              notInArray(schema.catalogueTemplatePoseWorkflows.poseAssetId, currentPoseIds),
            );
          }
          await tx.delete(schema.catalogueTemplatePoseWorkflows).where(and(...staleConditions));
        }

        return resolveForTemplate(tx, id);
      });

      return { ok: true, count: looks.length, resolvedCount };
    },
  );

  app.get(
    '/admin/assets/catalogue-templates/:id/looks',
    { preHandler: RW, schema: { params: uuidParam } },
    async (req) => {
      const { id } = req.params as { id: string };
      const rows = await app.db
        .select()
        .from(schema.catalogueTemplateLooks)
        .where(eq(schema.catalogueTemplateLooks.templateId, id))
        .orderBy(asc(schema.catalogueTemplateLooks.sortOrder));
      return { items: rows };
    },
  );
}
