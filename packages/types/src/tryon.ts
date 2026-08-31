import { z } from 'zod';

export const CreateTryonCategoryBody = z.object({
  name: z.string().min(1).max(80),
  slug: z
    .string()
    .regex(/^[a-z0-9_]+$/, 'Slug must be snake_case (lowercase letters, digits, underscores only)'),
  workflowTemplateId: z.string().uuid().optional(),
  sortOrder: z.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
});

export const UpdateTryonCategoryBody = z.object({
  name: z.string().min(1).max(80).optional(),
  workflowTemplateId: z.string().uuid().nullable().optional(),
  sortOrder: z.number().int().min(0).optional(),
  isActive: z.boolean().optional(),
});

export const TryonSamplePresignBody = z.object({
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
});

export const CreateTryonSampleBody = z.object({
  r2Key: z.string().min(1),
  thumbnailKey: z.string().min(1).optional(),
  sortOrder: z.number().int().min(0).optional(),
});
