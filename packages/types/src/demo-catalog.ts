import { z } from 'zod';
import { MerchantCatalogCategory } from './widget.js';

export const DemoCatalogSetCreateBody = z.object({
  name: z.string().min(1).max(160),
  description: z.string().max(500).optional(),
  sortOrder: z.number().int().min(0).max(999999).optional(),
});
export type DemoCatalogSetCreateBody = z.infer<typeof DemoCatalogSetCreateBody>;

export const DemoCatalogSetUpdateBody = z
  .object({
    name: z.string().min(1).max(160).optional(),
    description: z.string().max(500).nullable().optional(),
    isActive: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(999999).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: 'at least one field is required',
  });
export type DemoCatalogSetUpdateBody = z.infer<typeof DemoCatalogSetUpdateBody>;

export const DemoCatalogSubcategoryCreateBody = z.object({
  setId: z.string().uuid(),
  category: MerchantCatalogCategory,
  name: z.string().min(1).max(160),
  garmentSubcategoryId: z.string().uuid(),
  sortOrder: z.number().int().min(0).max(999999).optional(),
});
export type DemoCatalogSubcategoryCreateBody = z.infer<typeof DemoCatalogSubcategoryCreateBody>;

export const DemoCatalogSubcategoryUpdateBody = z
  .object({
    category: MerchantCatalogCategory.optional(),
    name: z.string().min(1).max(160).optional(),
    garmentSubcategoryId: z.string().uuid().optional(),
    sortOrder: z.number().int().min(0).max(999999).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: 'at least one field is required',
  });
export type DemoCatalogSubcategoryUpdateBody = z.infer<typeof DemoCatalogSubcategoryUpdateBody>;

export const DemoCatalogPresignBody = z.object({
  assetId: z.string().uuid().optional(),
  kind: z.enum(['image', 'thumbnail']),
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  contentLength: z
    .number()
    .int()
    .positive()
    .max(20 * 1024 * 1024),
});
export type DemoCatalogPresignBody = z.infer<typeof DemoCatalogPresignBody>;

export const DemoCatalogItemCreateBody = z.object({
  subcategoryId: z.string().uuid(),
  label: z.string().min(1).max(200),
  sku: z.string().max(120).optional(),
  actualPrice: z.number().int().min(0),
  offerPrice: z.number().int().min(0),
  r2Key: z.string().min(1),
  thumbnailKey: z.string().min(1),
  sortOrder: z.number().int().min(0).max(999999).optional(),
});
export type DemoCatalogItemCreateBody = z.infer<typeof DemoCatalogItemCreateBody>;

export const DemoCatalogItemUpdateBody = z
  .object({
    subcategoryId: z.string().uuid().optional(),
    label: z.string().min(1).max(200).optional(),
    sku: z.string().max(120).nullable().optional(),
    actualPrice: z.number().int().min(0).optional(),
    offerPrice: z.number().int().min(0).optional(),
    isActive: z.boolean().optional(),
    sortOrder: z.number().int().min(0).max(999999).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: 'at least one field is required',
  });
export type DemoCatalogItemUpdateBody = z.infer<typeof DemoCatalogItemUpdateBody>;

// Full replace, not add/remove: the admin UI edits a multi-select and saves the
// whole list, so a partial API would require the client to diff.
export const DemoCatalogAssignmentsPutBody = z.object({
  merchantIds: z.array(z.string().uuid()).max(500),
});
export type DemoCatalogAssignmentsPutBody = z.infer<typeof DemoCatalogAssignmentsPutBody>;
