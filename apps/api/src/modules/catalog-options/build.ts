import { schema } from '@tryme/db';
import { and, asc, eq, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

/**
 * Shared builder for the admin-curated asset picker payload (garment types,
 * faces, backgrounds, poses, lower garments, shoes).
 *
 * Extracted verbatim from the Shopify options route so the public developer API
 * (/v1/dev/catalog/options) and the Shopify embedded app resolve from exactly the
 * same rules — in particular the pose_garment_configs overlay below, which is
 * subtle enough that a second hand-written copy would drift.
 *
 * `publicOnly` narrows every asset query to rows with a non-null public_api_slug,
 * i.e. the subset an admin has deliberately opted into the third-party API. It is
 * the ONLY behavioural difference between the two surfaces.
 *
 * Returns rows carrying BOTH `id` and `slug`; each route projects the one its
 * surface exposes. This output is what gets cached (see lib/catalog-options-cache.ts),
 * so keeping `id` in it lets the public route resolve slug -> id with no extra DB hit.
 */

export const CATALOG_OPTION_GENDERS = ['men', 'women', 'boys', 'girls'] as const;
export type CatalogOptionGender = (typeof CATALOG_OPTION_GENDERS)[number];

export interface CatalogOptionItem {
  id: string;
  slug: string | null;
  label: string;
  thumbnailUrl: string;
}

export interface CatalogOptionPose extends CatalogOptionItem {
  hasLower: boolean;
  hasShoes: boolean;
}

export interface CatalogOptionGarmentType {
  id: string;
  slug: string | null;
  label: string;
  sortOrder: number;
}

export interface CatalogOptions {
  garmentTypes: CatalogOptionGarmentType[];
  faces: CatalogOptionItem[];
  backgrounds: CatalogOptionItem[];
  poses: CatalogOptionPose[];
  lowerItems: CatalogOptionItem[];
  shoeItems: CatalogOptionItem[];
}

async function fetchCatalogItems(
  app: FastifyInstance,
  type: 'lower' | 'shoe',
  gender: string,
  garmentTypeId: string | undefined,
  publicOnly: boolean,
): Promise<CatalogOptionItem[]> {
  let allowedIds: string[] | null = null;
  if (garmentTypeId) {
    const [gt] = await app.db
      .select({
        defaultLowerCatalogId: schema.garmentSubcategories.defaultLowerCatalogId,
        defaultShoeCatalogId: schema.garmentSubcategories.defaultShoeCatalogId,
      })
      .from(schema.garmentSubcategories)
      .where(eq(schema.garmentSubcategories.id, garmentTypeId));
    const mappings = await app.db
      .select({ catalogItemId: schema.catalogItemSubcategories.catalogItemId })
      .from(schema.catalogItemSubcategories)
      .where(eq(schema.catalogItemSubcategories.subcategoryId, garmentTypeId));
    const defaultId = type === 'lower' ? gt?.defaultLowerCatalogId : gt?.defaultShoeCatalogId;
    allowedIds = [
      ...new Set([...mappings.map((m) => m.catalogItemId), ...(defaultId ? [defaultId] : [])]),
    ];
    if (allowedIds.length === 0) return [];
  }

  const conditions = [
    eq(schema.catalogItems.isActive, true),
    eq(schema.catalogItems.type, type),
    eq(schema.catalogItems.genderSlug, gender),
  ];
  if (allowedIds) conditions.push(inArray(schema.catalogItems.id, allowedIds));
  if (publicOnly) conditions.push(isNotNull(schema.catalogItems.publicApiSlug));

  const items = await app.db
    .select()
    .from(schema.catalogItems)
    .where(and(...conditions));

  return Promise.all(
    items.map(async (i) => ({
      id: i.id,
      slug: i.publicApiSlug,
      label: i.label,
      thumbnailUrl: (await app.storage.presignGet(i.thumbnailKey, 3600)).url,
    })),
  );
}

export async function buildCatalogOptions(
  app: FastifyInstance,
  opts: { gender: string; garmentTypeId?: string; publicOnly: boolean },
): Promise<CatalogOptions> {
  const { gender, garmentTypeId, publicOnly } = opts;

  const garmentTypeConditions = [
    eq(schema.garmentSubcategories.genderSlug, gender),
    eq(schema.garmentSubcategories.isActive, true),
  ];
  if (publicOnly) garmentTypeConditions.push(isNotNull(schema.garmentSubcategories.publicApiSlug));

  const garmentTypes = await app.db
    .select({
      id: schema.garmentSubcategories.id,
      slug: schema.garmentSubcategories.publicApiSlug,
      label: schema.garmentSubcategories.label,
      sortOrder: schema.garmentSubcategories.sortOrder,
    })
    .from(schema.garmentSubcategories)
    .where(and(...garmentTypeConditions))
    .orderBy(asc(schema.garmentSubcategories.sortOrder));

  const faceConditions = [
    eq(schema.modelFaces.gender, gender),
    eq(schema.modelFaces.isActive, true),
    isNull(schema.modelFaces.deletedAt),
  ];
  if (publicOnly) faceConditions.push(isNotNull(schema.modelFaces.publicApiSlug));

  const faceRows = await app.db
    .select({
      id: schema.modelFaces.id,
      slug: schema.modelFaces.publicApiSlug,
      label: schema.modelFaces.label,
      thumbnailKey: schema.modelFaces.thumbnailKey,
    })
    .from(schema.modelFaces)
    .where(and(...faceConditions));
  const faces = await Promise.all(
    faceRows.map(async (f) => ({
      id: f.id,
      slug: f.slug,
      label: f.label,
      thumbnailUrl: (await app.storage.presignGet(f.thumbnailKey, 3600)).url,
    })),
  );

  const backgroundConditions = [
    eq(schema.modelBackgrounds.isActive, true),
    isNull(schema.modelBackgrounds.deletedAt),
    eq(schema.modelBackgrounds.scope, 'general'),
    or(isNull(schema.modelBackgrounds.genderSlug), eq(schema.modelBackgrounds.genderSlug, gender)),
  ];
  if (publicOnly) backgroundConditions.push(isNotNull(schema.modelBackgrounds.publicApiSlug));

  const backgroundRows = await app.db
    .select({
      id: schema.modelBackgrounds.id,
      slug: schema.modelBackgrounds.publicApiSlug,
      label: schema.modelBackgrounds.label,
      thumbnailKey: schema.modelBackgrounds.thumbnailKey,
    })
    .from(schema.modelBackgrounds)
    .where(and(...backgroundConditions));
  const backgrounds = await Promise.all(
    backgroundRows.map(async (b) => ({
      id: b.id,
      slug: b.slug,
      label: b.label,
      thumbnailUrl: (await app.storage.presignGet(b.thumbnailKey, 3600)).url,
    })),
  );

  const poseConditions = [
    eq(schema.modelPoseAssets.genderSlug, gender),
    eq(schema.modelPoseAssets.isActive, true),
    isNull(schema.modelPoseAssets.deletedAt),
    eq(schema.modelPoseAssets.scope, 'general'),
  ];
  if (publicOnly) poseConditions.push(isNotNull(schema.modelPoseAssets.publicApiSlug));

  const poseRows = await app.db
    .select({
      id: schema.modelPoseAssets.id,
      slug: schema.modelPoseAssets.publicApiSlug,
      label: schema.modelPoseAssets.displayName,
      fallbackLabel: schema.modelPoseAssets.label,
      thumbnailKey: schema.modelPoseAssets.thumbnailKey,
      lowerNodeId: schema.workflowTemplates.lowerNodeId,
      shoeNodeId: schema.workflowTemplates.shoeNodeId,
    })
    .from(schema.modelPoseAssets)
    .leftJoin(
      schema.workflowTemplates,
      eq(schema.modelPoseAssets.workflowTemplateId, schema.workflowTemplates.id),
    )
    .where(and(...poseConditions));

  // If garmentTypeId given, overlay per-type workflow overrides for hasLower/hasShoes,
  // and per-type active overrides (a pose can be hidden for one garment type without
  // touching its global isActive flag or its visibility under other garment types).
  let configMap = new Map<string, { lowerNodeId: string | null; shoeNodeId: string | null }>();
  let inactiveForType = new Set<string>();
  if (garmentTypeId && poseRows.length > 0) {
    const poseIds = poseRows.map((p) => p.id);
    const configs = await app.db
      .select({
        poseAssetId: schema.poseGarmentConfigs.poseAssetId,
        workflowTemplateId: schema.poseGarmentConfigs.workflowTemplateId,
        isActive: schema.poseGarmentConfigs.isActive,
        lowerNodeId: schema.workflowTemplates.lowerNodeId,
        shoeNodeId: schema.workflowTemplates.shoeNodeId,
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
    // Only override lower/shoe when the config row actually has a workflow override
    // set — a prompt-only override (no workflowTemplateId) must fall back to the
    // pose's own default workflow instead of wiping out hasLower/hasShoes.
    configMap = new Map(
      configs
        .filter((c) => c.workflowTemplateId != null)
        .map((c) => [
          c.poseAssetId,
          { lowerNodeId: c.lowerNodeId ?? null, shoeNodeId: c.shoeNodeId ?? null },
        ]),
    );
    inactiveForType = new Set(
      configs.filter((c) => c.isActive === false).map((c) => c.poseAssetId),
    );
  }

  const poses = await Promise.all(
    poseRows
      .filter((p) => !inactiveForType.has(p.id))
      .map(async (p) => {
        const cfg = configMap.get(p.id);
        const lowerNodeId = cfg !== undefined ? cfg.lowerNodeId : p.lowerNodeId;
        const shoeNodeId = cfg !== undefined ? cfg.shoeNodeId : p.shoeNodeId;
        return {
          id: p.id,
          slug: p.slug,
          label: p.label ?? p.fallbackLabel,
          thumbnailUrl: (await app.storage.presignGet(p.thumbnailKey, 3600)).url,
          hasLower: lowerNodeId != null,
          hasShoes: shoeNodeId != null,
        };
      }),
  );

  const [lowerItems, shoeItems] = await Promise.all([
    fetchCatalogItems(app, 'lower', gender, garmentTypeId, publicOnly),
    fetchCatalogItems(app, 'shoe', gender, garmentTypeId, publicOnly),
  ]);

  return { garmentTypes, faces, backgrounds, poses, lowerItems, shoeItems };
}
