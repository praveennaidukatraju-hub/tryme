import { z } from 'zod';

// ── User-facing ────────────────────────────────────────────────────────────

export const CreateSareeJobRequest = z.object({
  garmentKey: z.string().min(1).max(512),
});

export const SareeConfigResponse = z.object({
  modelImageUrl: z.string().url().nullable(),
  sampleSareeImageUrl: z.string().url().nullable(),
  isConfigured: z.boolean(),
  creditsCost: z.number().int().positive(),
});

// ── Admin: settings ────────────────────────────────────────────────────────

export const AdminSareeSettings = z.object({
  modelImageKey: z.string().nullable(),
  modelImageThumbKey: z.string().nullable(),
  modelImageUrl: z.string().url().nullable(),
  modelImageThumbUrl: z.string().url().nullable(),
  sampleSareeImageKey: z.string().nullable(),
  sampleSareeImageThumbKey: z.string().nullable(),
  sampleSareeImageUrl: z.string().url().nullable(),
  sampleSareeImageThumbUrl: z.string().url().nullable(),
  workflowTemplateId: z.string().uuid().nullable(),
  isConfigured: z.boolean(),
});

export const AdminSareeSettingsPatch = z.object({
  modelImageKey: z.string().nullable().optional(),
  modelImageThumbKey: z.string().nullable().optional(),
  sampleSareeImageKey: z.string().nullable().optional(),
  sampleSareeImageThumbKey: z.string().nullable().optional(),
  workflowTemplateId: z.string().uuid().nullable().optional(),
});

export const AdminSareeSettingsPresignBody = z.object({
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  purpose: z.enum(['model', 'sample']).default('model'),
});

export const AdminSareeSettingsPresignResponse = z.object({
  r2Key: z.string(),
  uploadUrl: z.string().url(),
  thumbnailKey: z.string(),
  thumbnailUploadUrl: z.string().url(),
});

// ── Admin: workflow ────────────────────────────────────────────────────────

export const SareeDetectedNodes = z.object({
  modelImageNode: z.string().nullable(),
  sareeImageNode: z.string().nullable(),
  outputNode: z.string().nullable(),
  positivePromptNode: z.string().nullable(),
  negativePromptNode: z.string().nullable(),
  defaultPositivePrompt: z.string(),
  defaultNegativePrompt: z.string(),
});

export const AdminSareeWorkflowCreateBody = z.object({
  label: z.string().min(1).max(120),
  slug: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9_-]+$/, 'slug must be lowercase letters, digits, _ or -'),
  jsonContent: z.record(z.unknown()),
});

export const AdminSareeWorkflow = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  label: z.string(),
  isActive: z.boolean(),
  jsonContent: z.record(z.unknown()),
  detected: SareeDetectedNodes,
});

// ── Admin: workers list ────────────────────────────────────────────────────

export const AdminSareeWorker = z.object({
  id: z.string(),
  label: z.string(),
  url: z.string(),
  isActive: z.boolean(),
  allowedJobTypes: z.array(z.string()),
  status: z.string().nullable(),
});
