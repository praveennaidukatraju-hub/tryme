import { z } from 'zod';

// Used for GET /v1/catalog/:type (lower garments and shoes only)
export const CatalogTypeSlug = z.enum(['lower', 'shoe']);

export const CatalogItem = z.object({
  id: z.string().uuid(),
  label: z.string(),
  thumbnailUrl: z.string().url(),
});

export const CategoryNode = z.object({
  id: z.number().int(),
  slug: z.string(),
  label: z.string(),
  children: z.array(z.lazy((): z.ZodTypeAny => CategoryNode)),
  items: z.array(CatalogItem),
});

export const CatalogResponse = z.object({
  type: CatalogTypeSlug,
  tree: z.array(CategoryNode),
});

// Model asset types — used for GET /v1/models/faces, /backgrounds, /poses

export const GenderSlug = z.enum(['men', 'women', 'boys', 'girls']);

export const ModelFaceItem = z.object({
  id: z.string().uuid(),
  gender: GenderSlug,
  label: z.string(),
  thumbnailUrl: z.string().url(),
});

export const ModelBackgroundItem = z.object({
  id: z.string().uuid(),
  faceId: z.string().uuid(),
  label: z.string(),
  thumbnailUrl: z.string().url(),
});

export const ModelPoseItem = z.object({
  id: z.string().uuid(),
  backgroundId: z.string().uuid(),
  label: z.string(),
  thumbnailUrl: z.string().url(),
  showsLower: z.boolean(),
  showsShoes: z.boolean(),
});

export const ModelFacesResponse = z.object({ items: z.array(ModelFaceItem) });
export const ModelBackgroundsResponse = z.object({ items: z.array(ModelBackgroundItem) });
export const ModelPosesResponse = z.object({ items: z.array(ModelPoseItem) });
