import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { keys } from '@tryme/storage';
import {
  CreateGarmentTypeBody,
  PatchGarmentTypeBody,
  PresignGarmentTypeBody,
  PresignGarmentTypeInstructionBody,
} from '@tryme/types';
import { and, asc, eq, gt, gte, ilike, inArray, isNull, lt, lte, ne, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { requirePermission } from './guard.js';
import { resolveForGarmentTypeShotType, resolveForMapping } from './shot-type-resolve.js';

export async function adminGarmentTypesRoutes(app: FastifyInstance) {
  const RW = requirePermission('subcategories.write');
  const D = requirePermission('subcategories.delete');
  const uuidParam = z.object({ id: z.string().uuid() });

  app.get('/admin/assets/garment-types', { preHandler: RW }, async () => {
    const rows = await app.db
      .select()
      .from(schema.garmentSubcategories)
      .orderBy(asc(schema.garmentSubcategories.sortOrder), asc(schema.garmentSubcategories.label));
    return {
      items: await Promise.all(
        rows.map(async (r) => ({
          ...r,
          instructionImageUrl: r.instructionImageKey
            ? (await app.storage.presignGet(r.instructionImageKey, 3600)).url
            : null,
          thumbnailUrl: r.thumbnailKey
            ? (await app.storage.presignGet(r.thumbnailKey, 3600)).url
            : null,
        })),
      ),
    };
  });

  app.post(
    '/admin/assets/garment-types/presign',
    {
      preHandler: RW,
      schema: { body: PresignGarmentTypeBody },
    },
    async (_req) => {
      const newId = randomUUID();
      const thumbKey = keys.subcategoryThumb(newId);
      // contentType is still validated by the route schema, but the uploaded image is
      // downscaled to JPEG client-side — sign for image/jpeg so the PUT header matches.
      const { url } = await app.storage.presignPut(thumbKey, 'image/jpeg', 5_000_000, 300);
      return { uploadUrl: url, thumbnailKey: thumbKey };
    },
  );

  app.post(
    '/admin/assets/garment-types/instruction/presign',
    {
      preHandler: RW,
      schema: { body: PresignGarmentTypeInstructionBody },
    },
    async (_req) => {
      const newId = randomUUID();
      const instructionKey = keys.subcategoryInstruction(newId);
      const { url } = await app.storage.presignPut(instructionKey, 'image/jpeg', 10_000_000, 300);
      return { uploadUrl: url, instructionImageKey: instructionKey };
    },
  );

  app.post(
    '/admin/assets/garment-types',
    {
      preHandler: RW,
      schema: { body: CreateGarmentTypeBody },
    },
    async (req) => {
      const {
        genderSlug,
        slug,
        label,
        sortOrder,
        thumbnailKey,
        requiresLowerUpload,
        requiresThirdUpload,
        tryonCategoryId,
      } = req.body as {
        genderSlug: string;
        slug: string;
        label: string;
        sortOrder?: number;
        thumbnailKey?: string;
        requiresLowerUpload?: boolean;
        requiresThirdUpload?: boolean;
        tryonCategoryId?: string | null;
      };
      const [existingLabel] = await app.db
        .select({ id: schema.garmentSubcategories.id })
        .from(schema.garmentSubcategories)
        .where(
          and(
            ilike(schema.garmentSubcategories.label, label),
            eq(schema.garmentSubcategories.genderSlug, genderSlug),
          ),
        );
      if (existingLabel) {
        throw new AppError('CONFLICT', 409, `label "${label}" already exists for ${genderSlug}`);
      }
      const row = await app.db.transaction(async (tx) => {
        let targetSortOrder = sortOrder;
        if (targetSortOrder === undefined) {
          const [maxRow] = await tx
            .select({ max: sql<number | null>`MAX(${schema.garmentSubcategories.sortOrder})` })
            .from(schema.garmentSubcategories)
            .where(eq(schema.garmentSubcategories.genderSlug, genderSlug));
          targetSortOrder = Number(maxRow?.max ?? 0) + 1;
        } else {
          // Make room at the target position - anything already there (and
          // after) shifts up by one, so inserting acts like a positional
          // list insert rather than silently colliding.
          await tx
            .update(schema.garmentSubcategories)
            .set({ sortOrder: sql`${schema.garmentSubcategories.sortOrder} + 1` })
            .where(
              and(
                eq(schema.garmentSubcategories.genderSlug, genderSlug),
                gte(schema.garmentSubcategories.sortOrder, targetSortOrder),
              ),
            );
        }
        const [inserted] = await tx
          .insert(schema.garmentSubcategories)
          .values({
            genderSlug,
            slug,
            label,
            sortOrder: targetSortOrder,
            thumbnailKey,
            requiresLowerUpload: requiresLowerUpload ?? false,
            requiresThirdUpload: requiresThirdUpload ?? false,
            tryonCategoryId: tryonCategoryId ?? null,
          })
          .returning();
        return inserted;
      });
      return row;
    },
  );

  app.patch(
    '/admin/assets/garment-types/:id',
    {
      preHandler: RW,
      schema: { params: uuidParam, body: PatchGarmentTypeBody },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const body = req.body as Record<string, unknown>;

      if (typeof body.label === 'string') {
        const [current] = await app.db
          .select({ genderSlug: schema.garmentSubcategories.genderSlug })
          .from(schema.garmentSubcategories)
          .where(eq(schema.garmentSubcategories.id, id));
        const [existingLabel] = await app.db
          .select({ id: schema.garmentSubcategories.id })
          .from(schema.garmentSubcategories)
          .where(
            and(
              ilike(schema.garmentSubcategories.label, body.label),
              ne(schema.garmentSubcategories.id, id),
              current ? eq(schema.garmentSubcategories.genderSlug, current.genderSlug) : undefined,
            ),
          );
        if (existingLabel) {
          throw new AppError('CONFLICT', 409, `label "${body.label}" already exists`);
        }
      }

      if ('instructionImageKey' in body) {
        const [current] = await app.db
          .select({ instructionImageKey: schema.garmentSubcategories.instructionImageKey })
          .from(schema.garmentSubcategories)
          .where(eq(schema.garmentSubcategories.id, id));
        if (current?.instructionImageKey) {
          await app.storage.deleteObject(current.instructionImageKey).catch(() => {});
        }
      }

      // genderSlug isn't patchable, so a sortOrder move never has to cross
      // gender boundaries - the shifted range is always within one gender's list.
      const requestedSortOrder = typeof body.sortOrder === 'number' ? body.sortOrder : null;
      if (requestedSortOrder !== null) {
        const [current] = await app.db
          .select({
            genderSlug: schema.garmentSubcategories.genderSlug,
            sortOrder: schema.garmentSubcategories.sortOrder,
          })
          .from(schema.garmentSubcategories)
          .where(eq(schema.garmentSubcategories.id, id));
        if (!current) throw new AppError('NOT_FOUND', 404, 'garment type not found');

        if (requestedSortOrder !== current.sortOrder) {
          await app.db.transaction(async (tx) => {
            if (requestedSortOrder > current.sortOrder) {
              // Moving later: close the gap left behind by decrementing
              // everything between the old spot (exclusive) and the new one.
              await tx
                .update(schema.garmentSubcategories)
                .set({ sortOrder: sql`${schema.garmentSubcategories.sortOrder} - 1` })
                .where(
                  and(
                    eq(schema.garmentSubcategories.genderSlug, current.genderSlug),
                    ne(schema.garmentSubcategories.id, id),
                    gt(schema.garmentSubcategories.sortOrder, current.sortOrder),
                    lte(schema.garmentSubcategories.sortOrder, requestedSortOrder),
                  ),
                );
            } else {
              // Moving earlier: open a gap by incrementing everything from
              // the new spot up to (exclusive) the old one.
              await tx
                .update(schema.garmentSubcategories)
                .set({ sortOrder: sql`${schema.garmentSubcategories.sortOrder} + 1` })
                .where(
                  and(
                    eq(schema.garmentSubcategories.genderSlug, current.genderSlug),
                    ne(schema.garmentSubcategories.id, id),
                    gte(schema.garmentSubcategories.sortOrder, requestedSortOrder),
                    lt(schema.garmentSubcategories.sortOrder, current.sortOrder),
                  ),
                );
            }
            await tx
              .update(schema.garmentSubcategories)
              .set({ ...body, updatedAt: new Date() })
              .where(eq(schema.garmentSubcategories.id, id));
          });
          app.log.info(
            { adminUserId: req.userId, garmentTypeId: id, fields: Object.keys(body) },
            'garment type updated',
          );
          return { ok: true };
        }
      }

      const [updated] = await app.db
        .update(schema.garmentSubcategories)
        .set({ ...body, updatedAt: new Date() })
        .where(eq(schema.garmentSubcategories.id, id))
        .returning({ id: schema.garmentSubcategories.id });
      if (!updated) throw new AppError('NOT_FOUND', 404, 'garment type not found');
      app.log.info(
        { adminUserId: req.userId, garmentTypeId: id, fields: Object.keys(body) },
        'garment type updated',
      );
      return { ok: true };
    },
  );

  app.delete(
    '/admin/assets/garment-types/:id',
    {
      preHandler: D,
      schema: { params: uuidParam },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const [sub] = await app.db
        .select()
        .from(schema.garmentSubcategories)
        .where(eq(schema.garmentSubcategories.id, id));
      if (!sub) throw new AppError('NOT_FOUND', 404, 'garment type not found');

      await app.db
        .delete(schema.garmentSubcategories)
        .where(eq(schema.garmentSubcategories.id, id));

      app.log.info({ adminUserId: req.userId, garmentTypeId: id }, 'garment type deleted');
      return { ok: true };
    },
  );

  // ── Per-garment-type pose configs ─────────────────────────────────────────

  // GET /admin/assets/garment-types/:id/pose-configs
  // Returns all active poses for the garment type's gender, with their override config (if any).
  app.get(
    '/admin/assets/garment-types/:id/pose-configs',
    { preHandler: RW, schema: { params: uuidParam } },
    async (req) => {
      const { id } = req.params as { id: string };
      const [sub] = await app.db
        .select({ genderSlug: schema.garmentSubcategories.genderSlug })
        .from(schema.garmentSubcategories)
        .where(eq(schema.garmentSubcategories.id, id));
      if (!sub) throw new AppError('NOT_FOUND', 404, 'garment type not found');

      const poses = await app.db
        .select({
          id: schema.modelPoseAssets.id,
          globalIsActive: schema.modelPoseAssets.isActive,
          label: schema.modelPoseAssets.label,
          displayName: schema.modelPoseAssets.displayName,
          thumbnailKey: schema.modelPoseAssets.thumbnailKey,
          defaultWorkflowTemplateId: schema.modelPoseAssets.workflowTemplateId,
          defaultPromptGarmentPhase: schema.modelPoseAssets.promptGarmentPhase,
          defaultPromptFacePhase: schema.modelPoseAssets.promptFacePhase,
        })
        .from(schema.modelPoseAssets)
        .where(
          and(
            eq(schema.modelPoseAssets.genderSlug, sub.genderSlug ?? ''),
            isNull(schema.modelPoseAssets.deletedAt),
            // Template-scoped poses belong to "2. Catalogue templates" above —
            // this panel is standalone poses for "Create your own look" only.
            eq(schema.modelPoseAssets.scope, 'general'),
          ),
        )
        .orderBy(asc(schema.modelPoseAssets.sortOrder), asc(schema.modelPoseAssets.label));

      const poseIds = poses.map((p) => p.id);
      const configs =
        poseIds.length > 0
          ? await app.db
              .select()
              .from(schema.poseGarmentConfigs)
              .where(
                and(
                  inArray(schema.poseGarmentConfigs.poseAssetId, poseIds),
                  eq(schema.poseGarmentConfigs.subcategoryId, id),
                ),
              )
          : [];

      const configMap = new Map(configs.map((c) => [c.poseAssetId, c]));

      return {
        items: await Promise.all(
          poses.map(async (p) => {
            const cfg = configMap.get(p.id) ?? null;
            // Effective active state for this garment type: the per-type override
            // wins when set, otherwise fall back to the pose asset's global flag.
            const isActive = cfg?.isActive ?? p.globalIsActive;
            return {
              ...p,
              isActive,
              thumbnailUrl: (await app.storage.presignGet(p.thumbnailKey, 3600)).url,
              config: cfg
                ? {
                    workflowTemplateId: cfg.workflowTemplateId,
                    promptGarmentPhase: cfg.promptGarmentPhase,
                    promptFacePhase: cfg.promptFacePhase,
                    isActive: cfg.isActive,
                  }
                : null,
            };
          }),
        ),
      };
    },
  );

  // PATCH /admin/assets/garment-types/:id/pose-configs/:poseAssetId
  // Upsert override. If all override fields are null/empty, deletes the config row.
  app.patch(
    '/admin/assets/garment-types/:id/pose-configs/:poseAssetId',
    {
      preHandler: RW,
      schema: {
        params: z.object({ id: z.string().uuid(), poseAssetId: z.string().uuid() }),
        body: z.object({
          workflowTemplateId: z.string().uuid().nullable(),
          promptGarmentPhase: z.string().nullable(),
          promptFacePhase: z.string().nullable(),
          isActive: z.boolean().nullable(),
        }),
      },
    },
    async (req) => {
      const { id, poseAssetId } = req.params as { id: string; poseAssetId: string };
      const { workflowTemplateId, promptGarmentPhase, promptFacePhase, isActive } = req.body as {
        workflowTemplateId: string | null;
        promptGarmentPhase: string | null;
        promptFacePhase: string | null;
        isActive: boolean | null;
      };

      const hasOverride =
        workflowTemplateId || promptGarmentPhase || promptFacePhase || isActive !== null;
      if (!hasOverride) {
        await app.db
          .delete(schema.poseGarmentConfigs)
          .where(
            and(
              eq(schema.poseGarmentConfigs.poseAssetId, poseAssetId),
              eq(schema.poseGarmentConfigs.subcategoryId, id),
            ),
          );
        return { ok: true, action: 'deleted' };
      }

      await app.db
        .insert(schema.poseGarmentConfigs)
        .values({
          poseAssetId,
          subcategoryId: id,
          workflowTemplateId: workflowTemplateId ?? null,
          promptGarmentPhase: promptGarmentPhase ?? null,
          promptFacePhase: promptFacePhase ?? null,
          isActive,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: [schema.poseGarmentConfigs.poseAssetId, schema.poseGarmentConfigs.subcategoryId],
          set: {
            workflowTemplateId: workflowTemplateId ?? null,
            promptGarmentPhase: promptGarmentPhase ?? null,
            promptFacePhase: promptFacePhase ?? null,
            isActive,
            updatedAt: new Date(),
          },
        });

      return { ok: true, action: 'upserted' };
    },
  );

  // ── Per-garment-type catalogue-template mapping ───────────────────────────
  // Which catalogue templates are offered for this garment type — pure
  // enablement, no override data (per-pose workflow variance is handled
  // separately and already, by pose_garment_configs above).

  // GET /admin/assets/garment-types/:id/templates
  // Returns every SAME-GENDER catalogue template, each flagged mapped:true/false.
  app.get(
    '/admin/assets/garment-types/:id/templates',
    { preHandler: RW, schema: { params: uuidParam } },
    async (req) => {
      const { id } = req.params as { id: string };
      const [sub] = await app.db
        .select({ genderSlug: schema.garmentSubcategories.genderSlug })
        .from(schema.garmentSubcategories)
        .where(eq(schema.garmentSubcategories.id, id));
      if (!sub) throw new AppError('NOT_FOUND', 404, 'garment type not found');

      const templates = await app.db
        .select({
          id: schema.catalogueTemplates.id,
          label: schema.catalogueTemplates.label,
          thumbnailKey: schema.catalogueTemplates.thumbnailKey,
        })
        .from(schema.catalogueTemplates)
        .where(
          and(
            eq(schema.catalogueTemplates.genderSlug, sub.genderSlug ?? ''),
            isNull(schema.catalogueTemplates.deletedAt),
          ),
        )
        .orderBy(asc(schema.catalogueTemplates.sortOrder), asc(schema.catalogueTemplates.label));

      const mappedRows = await app.db
        .select({
          id: schema.catalogueTemplateSubcategories.id,
          templateId: schema.catalogueTemplateSubcategories.templateId,
        })
        .from(schema.catalogueTemplateSubcategories)
        .where(eq(schema.catalogueTemplateSubcategories.subcategoryId, id));
      const mappingIdByTemplate = new Map(mappedRows.map((r) => [r.templateId, r.id]));

      const templateIds = templates.map((template) => template.id);
      const lookRows =
        templateIds.length > 0
          ? await app.db
              .select({
                templateId: schema.catalogueTemplateLooks.templateId,
                poseAssetId: schema.catalogueTemplateLooks.poseAssetId,
              })
              .from(schema.catalogueTemplateLooks)
              .where(inArray(schema.catalogueTemplateLooks.templateId, templateIds))
          : [];
      const poseIdsByTemplate = new Map<string, Set<string>>();
      for (const look of lookRows) {
        const poseIds = poseIdsByTemplate.get(look.templateId) ?? new Set<string>();
        poseIds.add(look.poseAssetId);
        poseIdsByTemplate.set(look.templateId, poseIds);
      }

      return {
        items: await Promise.all(
          templates.map(async (t) => ({
            id: t.id,
            label: t.label,
            thumbnailUrl: t.thumbnailKey
              ? (await app.storage.presignGet(t.thumbnailKey, 3600)).url
              : null,
            mapped: mappingIdByTemplate.has(t.id),
            mappingId: mappingIdByTemplate.get(t.id) ?? null,
            poseAssetIds: [...(poseIdsByTemplate.get(t.id) ?? [])],
          })),
        ),
      };
    },
  );

  // PATCH /admin/assets/garment-types/:id/templates/:templateId
  // mapped:true inserts the mapping row (no-op if already present). mapped:false
  // deletes it and cascades its mapping-specific pose workflows.
  app.patch(
    '/admin/assets/garment-types/:id/templates/:templateId',
    {
      preHandler: RW,
      schema: {
        params: z.object({ id: z.string().uuid(), templateId: z.string().uuid() }),
        body: z.object({ mapped: z.boolean() }),
      },
    },
    async (req) => {
      const { id, templateId } = req.params as { id: string; templateId: string };
      const { mapped } = req.body as { mapped: boolean };

      if (mapped) {
        const inserted = await app.db.transaction(async (tx) => {
          const [row] = await tx
            .insert(schema.catalogueTemplateSubcategories)
            .values({ templateId, subcategoryId: id })
            .onConflictDoNothing()
            .returning({ id: schema.catalogueTemplateSubcategories.id });
          if (!row) return null;
          const resolvedCount = await resolveForMapping(tx, row.id);
          return { id: row.id, resolvedCount };
        });
        if (inserted)
          return { ok: true, mappingId: inserted.id, resolvedCount: inserted.resolvedCount };

        const [existing] = await app.db
          .select({ id: schema.catalogueTemplateSubcategories.id })
          .from(schema.catalogueTemplateSubcategories)
          .where(
            and(
              eq(schema.catalogueTemplateSubcategories.templateId, templateId),
              eq(schema.catalogueTemplateSubcategories.subcategoryId, id),
            ),
          );
        return { ok: true, mappingId: existing?.id ?? null };
      } else {
        await app.db
          .delete(schema.catalogueTemplateSubcategories)
          .where(
            and(
              eq(schema.catalogueTemplateSubcategories.templateId, templateId),
              eq(schema.catalogueTemplateSubcategories.subcategoryId, id),
            ),
          );
      }

      return { ok: true, mappingId: null };
    },
  );

  // Look visibility is scoped to one concrete template-to-garment-type mapping.
  // No exclusion row means the look remains shown (the default).
  app.get(
    '/admin/assets/catalogue-template-mappings/:mappingId/looks',
    {
      preHandler: RW,
      schema: { params: z.object({ mappingId: z.string().uuid() }) },
    },
    async (req) => {
      const { mappingId } = req.params as { mappingId: string };
      const [mapping] = await app.db
        .select({ templateId: schema.catalogueTemplateSubcategories.templateId })
        .from(schema.catalogueTemplateSubcategories)
        .where(eq(schema.catalogueTemplateSubcategories.id, mappingId));
      if (!mapping) throw new AppError('NOT_FOUND', 404, 'template mapping not found');

      const looks = await app.db
        .select({
          id: schema.catalogueTemplateLooks.id,
          poseAssetId: schema.catalogueTemplateLooks.poseAssetId,
          poseLabel: schema.modelPoseAssets.label,
          poseDisplayName: schema.modelPoseAssets.displayName,
          poseThumbnailKey: schema.modelPoseAssets.thumbnailKey,
          backgroundLabel: schema.modelBackgrounds.label,
          excludedId: schema.catalogueTemplateLookExclusions.id,
        })
        .from(schema.catalogueTemplateLooks)
        .innerJoin(
          schema.modelPoseAssets,
          eq(schema.catalogueTemplateLooks.poseAssetId, schema.modelPoseAssets.id),
        )
        .innerJoin(
          schema.modelBackgrounds,
          eq(schema.catalogueTemplateLooks.backgroundId, schema.modelBackgrounds.id),
        )
        .leftJoin(
          schema.catalogueTemplateLookExclusions,
          and(
            eq(schema.catalogueTemplateLookExclusions.mappingId, mappingId),
            eq(schema.catalogueTemplateLookExclusions.lookId, schema.catalogueTemplateLooks.id),
          ),
        )
        .where(eq(schema.catalogueTemplateLooks.templateId, mapping.templateId))
        .orderBy(asc(schema.catalogueTemplateLooks.sortOrder));

      return {
        items: await Promise.all(
          looks.map(async (look) => ({
            id: look.id,
            poseAssetId: look.poseAssetId,
            poseLabel: look.poseDisplayName ?? look.poseLabel,
            poseThumbnailUrl: (await app.storage.presignGet(look.poseThumbnailKey, 3600)).url,
            backgroundLabel: look.backgroundLabel,
            isEnabled: look.excludedId == null,
          })),
        ),
      };
    },
  );

  app.patch(
    '/admin/assets/catalogue-template-mappings/:mappingId/looks/:lookId',
    {
      preHandler: RW,
      schema: {
        params: z.object({ mappingId: z.string().uuid(), lookId: z.string().uuid() }),
        body: z.object({ isEnabled: z.boolean() }),
      },
    },
    async (req) => {
      const { mappingId, lookId } = req.params as { mappingId: string; lookId: string };
      const { isEnabled } = req.body as { isEnabled: boolean };

      const [validLook] = await app.db
        .select({ id: schema.catalogueTemplateLooks.id })
        .from(schema.catalogueTemplateSubcategories)
        .innerJoin(
          schema.catalogueTemplateLooks,
          and(
            eq(
              schema.catalogueTemplateLooks.templateId,
              schema.catalogueTemplateSubcategories.templateId,
            ),
            eq(schema.catalogueTemplateLooks.id, lookId),
          ),
        )
        .where(eq(schema.catalogueTemplateSubcategories.id, mappingId))
        .limit(1);
      if (!validLook) {
        throw new AppError('NOT_FOUND', 404, 'look does not belong to this template mapping');
      }

      if (isEnabled) {
        await app.db
          .delete(schema.catalogueTemplateLookExclusions)
          .where(
            and(
              eq(schema.catalogueTemplateLookExclusions.mappingId, mappingId),
              eq(schema.catalogueTemplateLookExclusions.lookId, lookId),
            ),
          );
      } else {
        await app.db
          .insert(schema.catalogueTemplateLookExclusions)
          .values({ mappingId, lookId })
          .onConflictDoNothing();
      }

      return { ok: true, isEnabled };
    },
  );
  app.get(
    '/admin/assets/catalogue-template-mappings/:mappingId/poses',
    {
      preHandler: RW,
      schema: { params: z.object({ mappingId: z.string().uuid() }) },
    },
    async (req) => {
      const { mappingId } = req.params as { mappingId: string };
      const [mapping] = await app.db
        .select({ templateId: schema.catalogueTemplateSubcategories.templateId })
        .from(schema.catalogueTemplateSubcategories)
        .where(eq(schema.catalogueTemplateSubcategories.id, mappingId));
      if (!mapping) throw new AppError('NOT_FOUND', 404, 'template mapping not found');

      const poses = await app.db
        .selectDistinct({
          id: schema.modelPoseAssets.id,
          label: schema.modelPoseAssets.label,
          displayName: schema.modelPoseAssets.displayName,
          thumbnailKey: schema.modelPoseAssets.thumbnailKey,
          sortOrder: schema.modelPoseAssets.sortOrder,
          workflowTemplateId: schema.catalogueTemplatePoseWorkflows.workflowTemplateId,
          promptGarmentPhase: schema.catalogueTemplatePoseWorkflows.promptGarmentPhase,
          source: schema.catalogueTemplatePoseWorkflows.source,
        })
        .from(schema.catalogueTemplateLooks)
        .innerJoin(
          schema.modelPoseAssets,
          eq(schema.catalogueTemplateLooks.poseAssetId, schema.modelPoseAssets.id),
        )
        .leftJoin(
          schema.catalogueTemplatePoseWorkflows,
          and(
            eq(schema.catalogueTemplatePoseWorkflows.mappingId, mappingId),
            eq(
              schema.catalogueTemplatePoseWorkflows.poseAssetId,
              schema.catalogueTemplateLooks.poseAssetId,
            ),
          ),
        )
        .where(eq(schema.catalogueTemplateLooks.templateId, mapping.templateId))
        .orderBy(asc(schema.modelPoseAssets.sortOrder), asc(schema.modelPoseAssets.label));

      return {
        items: await Promise.all(
          poses.map(async (pose) => ({
            id: pose.id,
            label: pose.label,
            displayName: pose.displayName,
            workflowTemplateId: pose.workflowTemplateId,
            promptGarmentPhase: pose.promptGarmentPhase,
            source: pose.source,
            thumbnailUrl: (await app.storage.presignGet(pose.thumbnailKey, 3600)).url,
          })),
        ),
      };
    },
  );

  app.patch(
    '/admin/assets/catalogue-template-mappings/:mappingId/poses/:poseAssetId',
    {
      preHandler: RW,
      schema: {
        params: z.object({
          mappingId: z.string().uuid(),
          poseAssetId: z.string().uuid(),
        }),
        body: z.object({
          workflowTemplateId: z.string().uuid().nullable(),
          promptGarmentPhase: z.string().nullable().optional(),
        }),
      },
    },
    async (req) => {
      const { mappingId, poseAssetId } = req.params as {
        mappingId: string;
        poseAssetId: string;
      };
      const body = req.body as {
        workflowTemplateId: string | null;
        promptGarmentPhase?: string | null;
      };
      const { workflowTemplateId } = body;

      const [validPose] = await app.db
        .select({ id: schema.catalogueTemplateLooks.id })
        .from(schema.catalogueTemplateSubcategories)
        .innerJoin(
          schema.catalogueTemplateLooks,
          and(
            eq(
              schema.catalogueTemplateLooks.templateId,
              schema.catalogueTemplateSubcategories.templateId,
            ),
            eq(schema.catalogueTemplateLooks.poseAssetId, poseAssetId),
          ),
        )
        .where(eq(schema.catalogueTemplateSubcategories.id, mappingId))
        .limit(1);
      if (!validPose) {
        throw new AppError('NOT_FOUND', 404, 'pose does not belong to this template mapping');
      }

      if (!workflowTemplateId) {
        // "Clear override" and "reset to category default" unified: deleting can
        // immediately let resolveForMapping fall back to a live default for this
        // pose's shot type — the response returns the row's real resulting state
        // (possibly a re-populated workflow, possibly nothing) rather than a blind
        // "cleared", so the admin UI never shows stale "Workflow required" after a
        // clear that actually just repopulated a different workflow. Delete + resolve
        // + re-read run in one transaction so this is one atomic unit.
        const result = await app.db.transaction(async (tx) => {
          await tx
            .delete(schema.catalogueTemplatePoseWorkflows)
            .where(
              and(
                eq(schema.catalogueTemplatePoseWorkflows.mappingId, mappingId),
                eq(schema.catalogueTemplatePoseWorkflows.poseAssetId, poseAssetId),
              ),
            );
          const resolvedCount = await resolveForMapping(tx, mappingId);
          const [row] = await tx
            .select({
              workflowTemplateId: schema.catalogueTemplatePoseWorkflows.workflowTemplateId,
              source: schema.catalogueTemplatePoseWorkflows.source,
            })
            .from(schema.catalogueTemplatePoseWorkflows)
            .where(
              and(
                eq(schema.catalogueTemplatePoseWorkflows.mappingId, mappingId),
                eq(schema.catalogueTemplatePoseWorkflows.poseAssetId, poseAssetId),
              ),
            );
          return {
            resolvedCount,
            workflowTemplateId: row?.workflowTemplateId ?? null,
            source: row?.source ?? null,
          };
        });
        return { ok: true, action: 'deleted', ...result };
      }

      const [workflow] = await app.db
        .select({ id: schema.workflowTemplates.id })
        .from(schema.workflowTemplates)
        .where(
          and(
            eq(schema.workflowTemplates.id, workflowTemplateId),
            eq(schema.workflowTemplates.workflowType, 'regular'),
            eq(schema.workflowTemplates.isActive, true),
          ),
        );
      if (!workflow) throw new AppError('BAD_CATALOG', 400, 'workflow not found or inactive');

      // `promptGarmentPhase` absent from the body means "leave it untouched" (the
      // workflow-<select>'s own PATCH calls never send it) — only update it on
      // conflict when the key was actually present in the request.
      const hasPromptKey = 'promptGarmentPhase' in body;
      const updateSet: {
        workflowTemplateId: string;
        updatedAt: Date;
        source: 'manual';
        promptGarmentPhase?: string | null;
      } = { workflowTemplateId, source: 'manual', updatedAt: new Date() };
      if (hasPromptKey) updateSet.promptGarmentPhase = body.promptGarmentPhase ?? null;

      await app.db
        .insert(schema.catalogueTemplatePoseWorkflows)
        .values({
          mappingId,
          poseAssetId,
          workflowTemplateId,
          source: 'manual',
          promptGarmentPhase: body.promptGarmentPhase ?? null,
        })
        .onConflictDoUpdate({
          target: [
            schema.catalogueTemplatePoseWorkflows.mappingId,
            schema.catalogueTemplatePoseWorkflows.poseAssetId,
          ],
          set: updateSet,
        });

      return { ok: true, action: 'upserted', workflowTemplateId, source: 'manual' as const };
    },
  );

  // ── Per-garment-type shot-type default workflows ──────────────────────────
  // The 3-slot default that auto-resolves catalogue_template_pose_workflows for
  // every template mapped to this garment type — see shot-type-resolve.ts.

  const SHOT_TYPES = ['full', 'half', 'closeup'] as const;

  async function requireGarmentType(id: string) {
    const [sub] = await app.db
      .select({ id: schema.garmentSubcategories.id })
      .from(schema.garmentSubcategories)
      .where(eq(schema.garmentSubcategories.id, id));
    if (!sub) throw new AppError('NOT_FOUND', 404, 'garment type not found');
  }

  app.get(
    '/admin/assets/garment-types/:id/shot-type-workflows',
    { preHandler: RW, schema: { params: uuidParam } },
    async (req) => {
      const { id } = req.params as { id: string };
      await requireGarmentType(id);
      const rows = await app.db
        .select({
          shotType: schema.garmentShotTypeWorkflows.shotType,
          workflowTemplateId: schema.garmentShotTypeWorkflows.workflowTemplateId,
        })
        .from(schema.garmentShotTypeWorkflows)
        .where(eq(schema.garmentShotTypeWorkflows.garmentTypeId, id));
      const byShotType = new Map(rows.map((r) => [r.shotType, r.workflowTemplateId]));
      return {
        items: SHOT_TYPES.map((shotType) => ({
          shotType,
          workflowTemplateId: byShotType.get(shotType) ?? null,
        })),
      };
    },
  );

  app.patch(
    '/admin/assets/garment-types/:id/shot-type-workflows/:shotType',
    {
      preHandler: RW,
      schema: {
        params: z.object({ id: z.string().uuid(), shotType: z.enum(SHOT_TYPES) }),
        body: z.object({ workflowTemplateId: z.string().uuid().nullable() }),
      },
    },
    async (req) => {
      const { id, shotType } = req.params as {
        id: string;
        shotType: (typeof SHOT_TYPES)[number];
      };
      const { workflowTemplateId } = req.body as { workflowTemplateId: string | null };
      await requireGarmentType(id);

      if (!workflowTemplateId) {
        await app.db
          .delete(schema.garmentShotTypeWorkflows)
          .where(
            and(
              eq(schema.garmentShotTypeWorkflows.garmentTypeId, id),
              eq(schema.garmentShotTypeWorkflows.shotType, shotType),
            ),
          );
        // Deliberately does not touch already-resolved 'auto' rows — clearing a
        // default shouldn't retroactively break templates that are already working.
        return { ok: true, action: 'cleared', resolvedCount: 0 };
      }

      const [workflow] = await app.db
        .select({ id: schema.workflowTemplates.id })
        .from(schema.workflowTemplates)
        .where(
          and(
            eq(schema.workflowTemplates.id, workflowTemplateId),
            eq(schema.workflowTemplates.workflowType, 'regular'),
            eq(schema.workflowTemplates.isActive, true),
          ),
        );
      if (!workflow) throw new AppError('BAD_CATALOG', 400, 'workflow not found or inactive');

      // Upsert + cascade run in one transaction — see shot-type-resolve.ts's header
      // comment for why: if the resolve half failed after a non-transactional upsert
      // had already committed, the default would be saved but never actually applied,
      // with no automatic way to notice or retry.
      const resolvedCount = await app.db.transaction(async (tx) => {
        await tx
          .insert(schema.garmentShotTypeWorkflows)
          .values({ garmentTypeId: id, shotType, workflowTemplateId })
          .onConflictDoUpdate({
            target: [
              schema.garmentShotTypeWorkflows.garmentTypeId,
              schema.garmentShotTypeWorkflows.shotType,
            ],
            set: { workflowTemplateId, updatedAt: new Date() },
          });
        return resolveForGarmentTypeShotType(tx, id, shotType);
      });
      return { ok: true, action: 'upserted', resolvedCount };
    },
  );
}
