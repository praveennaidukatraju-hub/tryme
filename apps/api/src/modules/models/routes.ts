import { schema } from '@tryme/db';
import { and, asc, eq, inArray, isNull, or } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { isCatalogVideoAllowed } from '../../lib/catalog-video-access.js';
import { AppError } from '../../lib/errors.js';
import { getPixverseCreditCost } from '../../lib/resolution-config.js';

export async function modelsRoutes(app: FastifyInstance) {
  app.get(
    '/v1/models/garment-types',
    {
      preHandler: app.requireUserOrCatalogApp,
      schema: { querystring: z.object({ gender: z.enum(['men', 'women', 'boys', 'girls']) }) },
    },
    async (req) => {
      const { gender } = req.query as { gender: string };
      const items = await app.db
        .select({
          id: schema.garmentSubcategories.id,
          slug: schema.garmentSubcategories.slug,
          label: schema.garmentSubcategories.label,
          sortOrder: schema.garmentSubcategories.sortOrder,
          thumbnailKey: schema.garmentSubcategories.thumbnailKey,
          instructionImageKey: schema.garmentSubcategories.instructionImageKey,
          requiresLowerUpload: schema.garmentSubcategories.requiresLowerUpload,
          upperUploadLabel: schema.garmentSubcategories.upperUploadLabel,
          lowerUploadLabel: schema.garmentSubcategories.lowerUploadLabel,
          requiresThirdUpload: schema.garmentSubcategories.requiresThirdUpload,
          thirdUploadLabel: schema.garmentSubcategories.thirdUploadLabel,
          defaultLowerCatalogId: schema.garmentSubcategories.defaultLowerCatalogId,
          defaultShoeCatalogId: schema.garmentSubcategories.defaultShoeCatalogId,
          requiresMannequinStep: schema.garmentSubcategories.requiresMannequinStep,
          mannequinTwoInputWorkflowTemplateId:
            schema.garmentSubcategories.mannequinTwoInputWorkflowTemplateId,
        })
        .from(schema.garmentSubcategories)
        .where(
          and(
            eq(schema.garmentSubcategories.genderSlug, gender),
            eq(schema.garmentSubcategories.isActive, true),
          ),
        )
        .orderBy(
          asc(schema.garmentSubcategories.sortOrder),
          asc(schema.garmentSubcategories.label),
        );
      return {
        items: await Promise.all(
          items.map(async (i) => ({
            ...i,
            thumbnailUrl: i.thumbnailKey
              ? (await app.storage.presignGet(i.thumbnailKey, 3600)).url
              : null,
            instructionImageUrl: i.instructionImageKey
              ? (await app.storage.presignGet(i.instructionImageKey, 3600)).url
              : null,
          })),
        ),
      };
    },
  );

  app.get('/v1/models/sample-videos', { preHandler: app.requireUser }, async (req) => {
    const [caller] = await app.db
      .select({ email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, req.userId));
    if (!isCatalogVideoAllowed(app.env, caller?.email ?? null)) {
      throw new AppError('FORBIDDEN', 403, 'catalog video is not enabled for this account');
    }
    const rows = await app.db
      .select({
        id: schema.sampleVideos.id,
        title: schema.sampleVideos.title,
        thumbnailR2Key: schema.sampleVideos.thumbnailR2Key,
        videoR2Key: schema.sampleVideos.videoR2Key,
      })
      .from(schema.sampleVideos)
      .where(and(eq(schema.sampleVideos.isActive, true), isNull(schema.sampleVideos.deletedAt)))
      .orderBy(asc(schema.sampleVideos.sortOrder));
    const creditCost = await getPixverseCreditCost(app);
    return {
      creditCost,
      items: await Promise.all(
        rows.map(async (row) => {
          const [thumbnail, video] = await Promise.all([
            app.storage.presignGet(row.thumbnailR2Key, 3_600),
            app.storage.presignGet(row.videoR2Key, 3_600),
          ]);

          return {
            id: row.id,
            title: row.title,
            thumbnailUrl: thumbnail.url,
            previewVideoUrl: video.url,
          };
        }),
      ),
    };
  });

  app.get(
    '/v1/models/faces',
    {
      preHandler: app.requireUser,
      schema: {
        querystring: z.object({
          gender: z.enum(['men', 'women', 'boys', 'girls']),
        }),
      },
    },
    async (req) => {
      const { gender } = req.query as { gender: string };

      const items = await app.db
        .select({
          id: schema.modelFaces.id,
          gender: schema.modelFaces.gender,
          label: schema.modelFaces.label,
          continent: schema.modelFaces.continent,
          thumbnailUrl: schema.modelFaces.thumbnailKey,
          tags: schema.modelFaces.tags,
        })
        .from(schema.modelFaces)
        .where(
          and(
            eq(schema.modelFaces.gender, gender),
            eq(schema.modelFaces.isActive, true),
            isNull(schema.modelFaces.deletedAt),
          ),
        )
        .orderBy(asc(schema.modelFaces.sortOrder), asc(schema.modelFaces.label));

      return {
        items: await Promise.all(
          items.map(async (i) => ({
            ...i,
            thumbnailUrl: (await app.storage.presignGet(i.thumbnailUrl, 3600)).url,
          })),
        ),
      };
    },
  );

  app.get(
    '/v1/models/backgrounds',
    {
      preHandler: app.requireUser,
      schema: {
        querystring: z.object({
          gender: z.enum(['men', 'women', 'boys', 'girls']).optional(),
        }),
      },
    },
    async (req) => {
      const { gender } = req.query as { gender?: string };

      const rows = await app.db
        .select({
          id: schema.modelBackgrounds.id,
          label: schema.modelBackgrounds.label,
          thumbnailKey: schema.modelBackgrounds.thumbnailKey,
          isWhiteBg: schema.modelBackgrounds.isWhiteBg,
          categoryId: schema.modelBackgrounds.categoryId,
          tags: schema.modelBackgrounds.tags,
          specialTag: schema.modelBackgrounds.specialTag,
        })
        .from(schema.modelBackgrounds)
        .where(
          and(
            eq(schema.modelBackgrounds.isActive, true),
            isNull(schema.modelBackgrounds.deletedAt),
            // Template-scoped backgrounds are managed only via their owning
            // catalogue template — never offered in "create your own look".
            eq(schema.modelBackgrounds.scope, 'general'),
            gender
              ? or(
                  isNull(schema.modelBackgrounds.genderSlug),
                  eq(schema.modelBackgrounds.genderSlug, gender),
                )
              : undefined,
          ),
        );

      return {
        items: await Promise.all(
          rows.map(async (b) => {
            const thumbnailUrl = (await app.storage.presignGet(b.thumbnailKey, 3600)).url;
            return {
              id: b.id,
              label: b.label,
              thumbnailUrl,
              previewUrl: thumbnailUrl,
              isWhiteBg: b.isWhiteBg,
              categoryId: b.categoryId,
              tags: b.tags,
              specialTag: b.specialTag,
            };
          }),
        ),
      };
    },
  );

  app.get(
    '/v1/models/background-categories',
    {
      preHandler: app.requireUser,
      schema: {
        querystring: z.object({
          gender: z.enum(['men', 'women', 'boys', 'girls']).optional(),
        }),
      },
    },
    async (req) => {
      const { gender } = req.query as { gender?: string };

      const rows = await app.db
        .select({
          id: schema.catalogCategories.id,
          slug: schema.catalogCategories.slug,
          label: schema.catalogCategories.label,
          thumbnailKey: schema.catalogCategories.thumbnailKey,
          genderSlug: schema.catalogCategories.genderSlug,
          sortOrder: schema.catalogCategories.sortOrder,
        })
        .from(schema.catalogCategories)
        .innerJoin(schema.catalogTypes, eq(schema.catalogCategories.typeId, schema.catalogTypes.id))
        .where(
          and(
            eq(schema.catalogTypes.slug, 'background'),
            eq(schema.catalogCategories.isActive, true),
            gender
              ? or(
                  isNull(schema.catalogCategories.genderSlug),
                  eq(schema.catalogCategories.genderSlug, gender),
                )
              : undefined,
          ),
        )
        .orderBy(schema.catalogCategories.sortOrder);

      return {
        items: await Promise.all(
          rows.map(async (c) => ({
            id: c.id,
            slug: c.slug,
            label: c.label,
            thumbnailUrl: c.thumbnailKey
              ? (await app.storage.presignGet(c.thumbnailKey, 3600)).url
              : null,
          })),
        ),
      };
    },
  );

  app.get(
    '/v1/models/poses',
    {
      preHandler: app.requireUser,
      schema: {
        querystring: z.object({
          gender: z.enum(['men', 'women', 'boys', 'girls']),
          garmentTypeId: z.string().uuid().optional(),
        }),
      },
    },
    async (req) => {
      const { gender, garmentTypeId } = req.query as {
        gender: string;
        garmentTypeId?: string;
      };
      const items = await app.db
        .select({
          id: schema.modelPoseAssets.id,
          displayName: schema.modelPoseAssets.displayName,
          label: schema.modelPoseAssets.label,
          thumbnailUrl: schema.modelPoseAssets.thumbnailKey,
          // Default workflow from pose asset
          lowerNodeId: schema.workflowTemplates.lowerNodeId,
          shoeNodeId: schema.workflowTemplates.shoeNodeId,
          sizeNodeIds: schema.workflowTemplates.sizeNodeIds,
        })
        .from(schema.modelPoseAssets)
        .leftJoin(
          schema.workflowTemplates,
          eq(schema.modelPoseAssets.workflowTemplateId, schema.workflowTemplates.id),
        )
        .where(
          and(
            eq(schema.modelPoseAssets.genderSlug, gender),
            eq(schema.modelPoseAssets.isActive, true),
            isNull(schema.modelPoseAssets.deletedAt),
            // Template-scoped poses are managed only via their owning catalogue
            // template — never offered in "create your own look".
            eq(schema.modelPoseAssets.scope, 'general'),
          ),
        )
        .orderBy(asc(schema.modelPoseAssets.sortOrder), asc(schema.modelPoseAssets.label));

      // If garmentTypeId given, overlay per-type workflow overrides for hasLower/hasShoes,
      // and per-type active overrides (a pose can be hidden for one garment type without
      // touching its global isActive flag or its visibility under other garment types).
      let configMap = new Map<
        string,
        { lowerNodeId: string | null; shoeNodeId: string | null; sizeNodeIds: string[] | null }
      >();
      let inactiveForType = new Set<string>();
      if (garmentTypeId && items.length > 0) {
        const poseIds = items.map((i) => i.id);
        const configs = await app.db
          .select({
            poseAssetId: schema.poseGarmentConfigs.poseAssetId,
            workflowTemplateId: schema.poseGarmentConfigs.workflowTemplateId,
            isActive: schema.poseGarmentConfigs.isActive,
            lowerNodeId: schema.workflowTemplates.lowerNodeId,
            shoeNodeId: schema.workflowTemplates.shoeNodeId,
            sizeNodeIds: schema.workflowTemplates.sizeNodeIds,
          })
          .from(schema.poseGarmentConfigs)
          .leftJoin(
            schema.workflowTemplates,
            eq(schema.poseGarmentConfigs.workflowTemplateId, schema.workflowTemplates.id),
          )
          .where(
            and(
              inArray(schema.poseGarmentConfigs.poseAssetId, poseIds),
              eq(schema.poseGarmentConfigs.subcategoryId, garmentTypeId),
            ),
          );
        // Only override lower/shoe/size when the config row actually has a workflow
        // override set — a prompt-only override (no workflowTemplateId) must fall back
        // to the pose's own default workflow instead of wiping out hasLower/hasShoes.
        configMap = new Map(
          configs
            .filter((c) => c.workflowTemplateId != null)
            .map((c) => [
              c.poseAssetId,
              {
                lowerNodeId: c.lowerNodeId ?? null,
                shoeNodeId: c.shoeNodeId ?? null,
                sizeNodeIds: c.sizeNodeIds ?? null,
              },
            ]),
        );
        inactiveForType = new Set(
          configs.filter((c) => c.isActive === false).map((c) => c.poseAssetId),
        );
      }

      return {
        items: await Promise.all(
          items
            .filter((i) => !inactiveForType.has(i.id))
            .map(async (i) => {
              const cfg = configMap.get(i.id);
              const lowerNodeId = cfg !== undefined ? cfg.lowerNodeId : i.lowerNodeId;
              const shoeNodeId = cfg !== undefined ? cfg.shoeNodeId : i.shoeNodeId;
              const sizeNodeIds = cfg !== undefined ? cfg.sizeNodeIds : i.sizeNodeIds;
              return {
                id: i.id,
                label: i.displayName ?? i.label,
                thumbnailUrl: (await app.storage.presignGet(i.thumbnailUrl, 3600)).url,
                hasLower: lowerNodeId != null,
                hasShoes: shoeNodeId != null,
                hasAspectRatio: (sizeNodeIds?.length ?? 0) > 0,
              };
            }),
        ),
      };
    },
  );

  app.get(
    '/v1/models/catalogue-templates',
    {
      preHandler: app.requireUser,
      schema: {
        querystring: z.object({
          gender: z.enum(['men', 'women', 'boys', 'girls']),
          garmentTypeId: z.string().uuid().optional(),
        }),
      },
    },
    async (req) => {
      const { gender, garmentTypeId } = req.query as { gender: string; garmentTypeId?: string };

      // A template with no mapping row for this garment type is not offered for it at
      // all (strict opt-in — see catalogue_template_subcategories). Without a
      // garmentTypeId there's no way to know which templates apply, so fail closed.
      if (!garmentTypeId) return { items: [] };

      const templates = await app.db
        .select({
          id: schema.catalogueTemplates.id,
          label: schema.catalogueTemplates.label,
          thumbnailKey: schema.catalogueTemplates.thumbnailKey,
          mappingId: schema.catalogueTemplateSubcategories.id,
        })
        .from(schema.catalogueTemplates)
        .innerJoin(
          schema.catalogueTemplateSubcategories,
          and(
            eq(schema.catalogueTemplateSubcategories.templateId, schema.catalogueTemplates.id),
            eq(schema.catalogueTemplateSubcategories.subcategoryId, garmentTypeId),
          ),
        )
        .where(
          and(
            eq(schema.catalogueTemplates.genderSlug, gender),
            eq(schema.catalogueTemplates.isActive, true),
            isNull(schema.catalogueTemplates.deletedAt),
          ),
        )
        .orderBy(asc(schema.catalogueTemplates.sortOrder));

      if (templates.length === 0) return { items: [] };
      const templateIds = templates.map((t) => t.id);

      const lookRows = await app.db
        .select({
          lookId: schema.catalogueTemplateLooks.id,
          templateId: schema.catalogueTemplateLooks.templateId,
          poseId: schema.modelPoseAssets.id,
          poseLabel: schema.modelPoseAssets.label,
          poseDisplayName: schema.modelPoseAssets.displayName,
          poseThumbnailKey: schema.modelPoseAssets.thumbnailKey,
          lowerNodeId: schema.workflowTemplates.lowerNodeId,
          shoeNodeId: schema.workflowTemplates.shoeNodeId,
          backgroundId: schema.modelBackgrounds.id,
          backgroundLabel: schema.modelBackgrounds.label,
          backgroundThumbnailKey: schema.modelBackgrounds.thumbnailKey,
        })
        .from(schema.catalogueTemplateLooks)
        .innerJoin(
          schema.modelPoseAssets,
          and(
            eq(schema.catalogueTemplateLooks.poseAssetId, schema.modelPoseAssets.id),
            eq(schema.modelPoseAssets.isActive, true),
            isNull(schema.modelPoseAssets.deletedAt),
          ),
        )
        .innerJoin(
          schema.modelBackgrounds,
          and(
            eq(schema.catalogueTemplateLooks.backgroundId, schema.modelBackgrounds.id),
            eq(schema.modelBackgrounds.isActive, true),
            isNull(schema.modelBackgrounds.deletedAt),
          ),
        )
        .innerJoin(
          schema.catalogueTemplateSubcategories,
          and(
            eq(
              schema.catalogueTemplateSubcategories.templateId,
              schema.catalogueTemplateLooks.templateId,
            ),
            eq(schema.catalogueTemplateSubcategories.subcategoryId, garmentTypeId),
          ),
        )
        .leftJoin(
          schema.catalogueTemplateLookExclusions,
          and(
            eq(
              schema.catalogueTemplateLookExclusions.mappingId,
              schema.catalogueTemplateSubcategories.id,
            ),
            eq(schema.catalogueTemplateLookExclusions.lookId, schema.catalogueTemplateLooks.id),
          ),
        )
        .innerJoin(
          schema.catalogueTemplatePoseWorkflows,
          and(
            eq(
              schema.catalogueTemplatePoseWorkflows.mappingId,
              schema.catalogueTemplateSubcategories.id,
            ),
            eq(
              schema.catalogueTemplatePoseWorkflows.poseAssetId,
              schema.catalogueTemplateLooks.poseAssetId,
            ),
          ),
        )
        .innerJoin(
          schema.workflowTemplates,
          and(
            eq(
              schema.catalogueTemplatePoseWorkflows.workflowTemplateId,
              schema.workflowTemplates.id,
            ),
            eq(schema.workflowTemplates.isActive, true),
          ),
        )
        .where(
          and(
            inArray(schema.catalogueTemplateLooks.templateId, templateIds),
            isNull(schema.catalogueTemplateLookExclusions.id),
          ),
        )
        .orderBy(asc(schema.catalogueTemplateLooks.sortOrder));

      const looksByTemplate = new Map<string, typeof lookRows>();
      for (const row of lookRows) {
        if (!looksByTemplate.has(row.templateId)) looksByTemplate.set(row.templateId, []);
        looksByTemplate.get(row.templateId)?.push(row);
      }

      const items = (
        await Promise.all(
          templates.map(async (t) => {
            const rows = looksByTemplate.get(t.id) ?? [];
            const looks = await Promise.all(
              rows.map(async (r) => ({
                id: r.lookId,
                poseId: r.poseId,
                poseLabel: r.poseDisplayName ?? r.poseLabel,
                poseThumbnailUrl: (await app.storage.presignGet(r.poseThumbnailKey, 3600)).url,
                backgroundId: r.backgroundId,
                backgroundLabel: r.backgroundLabel,
                backgroundThumbnailUrl: (
                  await app.storage.presignGet(r.backgroundThumbnailKey, 3600)
                ).url,
                hasLower: r.lowerNodeId != null,
                hasShoes: r.shoeNodeId != null,
              })),
            );
            return {
              id: t.id,
              mappingId: t.mappingId,
              label: t.label,
              thumbnailUrl: t.thumbnailKey
                ? (await app.storage.presignGet(t.thumbnailKey, 3600)).url
                : (looks[0]?.poseThumbnailUrl ?? null),
              looks,
            };
          }),
        )
      ).filter((t) => t.looks.length > 0);

      return { items };
    },
  );
}
