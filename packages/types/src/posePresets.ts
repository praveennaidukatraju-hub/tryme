import { z } from 'zod';
import { GenderSlug } from './catalog.js';

export const PosePresetSchema = z.object({
  id: z.string().uuid(),
  name: z.string().nullable(),
  gender: GenderSlug,
  garmentTypeId: z.string().uuid(),
  poseIds: z.array(z.string().uuid()),
  isLastUsed: z.boolean(),
  updatedAt: z.string(),
});
export type PosePreset = z.infer<typeof PosePresetSchema>;

export const CreatePosePresetRequest = z.object({
  name: z.string().trim().min(1).max(40),
  gender: GenderSlug,
  garmentTypeId: z.string().uuid(),
  poseIds: z.array(z.string().uuid()).min(1),
});
export type CreatePosePresetBody = z.infer<typeof CreatePosePresetRequest>;

export const ListPosePresetsQuery = z.object({
  gender: GenderSlug,
  garmentTypeId: z.string().uuid(),
});
export type ListPosePresetsQueryParams = z.infer<typeof ListPosePresetsQuery>;

export const ListPosePresetsResponse = z.object({
  lastUsed: PosePresetSchema.nullable(),
  named: z.array(PosePresetSchema),
});
export type ListPosePresetsResult = z.infer<typeof ListPosePresetsResponse>;
