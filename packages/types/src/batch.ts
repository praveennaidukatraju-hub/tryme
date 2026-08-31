import { z } from 'zod';
import { INPUT_GARMENT_KEY } from './jobs.js';

/**
 * Schema-level ceiling on rows. The operative limit is the admin-configured job
 * cap (the sum of poseIds across rows), enforced server-side — see
 * getMaxBatchJobs() in apps/api/src/lib/batch-config.ts. This exists so a
 * malformed request is rejected by the schema before any DB work happens.
 */
export const MAX_BATCH_ROWS = 100;

/** Fallback when the config:system Redis key holds no batch entry. */
export const DEFAULT_MAX_BATCH_JOBS = 200;

/**
 * One row of a batch: exactly one Studio submission. N poses on a row produce N
 * jobs sharing one catalogueId.
 *
 * Deliberately narrower than CreateTryOnJobInputs. mannequinJobId (saree
 * two-pass), catalogueTemplateMappingId (catalogue templates) and thirdGarmentKey
 * (saree two-input) are absent: each would add a validation branch, and the
 * mannequin flow in particular cannot fit the single-transaction model because
 * each garment's step-2 jobs are unplannable until its mannequin job completes.
 * Zod strips unknown keys, so a client sending them gets them dropped rather
 * than silently honoured.
 */
export const BatchRowInputs = z.object({
  upperGarmentKey: z.string().regex(INPUT_GARMENT_KEY),
  faceId: z.string().uuid(),
  backgroundId: z.string().uuid(),
  poseIds: z.array(z.string().uuid()).min(1),
  lowerCatalogId: z.string().uuid().optional(),
  lowerGarmentKey: z.string().regex(INPUT_GARMENT_KEY).optional(),
  shoeCatalogId: z.string().uuid().optional(),
});
export type BatchRow = z.infer<typeof BatchRowInputs>;

/**
 * garmentTypeId is required here although it is optional on
 * CreateTryOnJobRequest: batch resolves pose/lower/shoe availability once for the
 * whole grid, which is only possible with a known garment type.
 */
export const CreateBatchJobRequest = z.object({
  garmentTypeId: z.string().uuid(),
  aspectRatio: z.enum(['1:1', '2:3', '3:4', '4:5']),
  resolution: z.enum(['HD', '2K', '4K']),
  platform: z.string().optional(),
  params: z
    .object({
      outputWidth: z.number().int().min(512).max(4096).optional(),
      outputHeight: z.number().int().min(512).max(4096).optional(),
    })
    .optional(),
  userHint: z.string().max(300).optional(),
  rows: z.array(BatchRowInputs).min(1).max(MAX_BATCH_ROWS),
});
export type CreateBatchJobBody = z.infer<typeof CreateBatchJobRequest>;

export interface PoseRequirement {
  hasLower: boolean;
  hasShoes: boolean;
}

/**
 * Single source of truth for which optional inputs a pose selection requires.
 * The API validates against it; the web app enables/disables the lower and shoe
 * cells with it. A selection needs an input if ANY selected pose's workflow has
 * the corresponding node — matching what the dispatcher will try to patch.
 */
export function requiredInputsForPoses(poses: PoseRequirement[]): {
  needsLower: boolean;
  needsShoes: boolean;
} {
  return {
    needsLower: poses.some((p) => p.hasLower),
    needsShoes: poses.some((p) => p.hasShoes),
  };
}

/** Total jobs a batch will create — one per pose per row. */
export function countBatchJobs(rows: Array<{ poseIds: string[] }>): number {
  return rows.reduce((total, row) => total + row.poseIds.length, 0);
}
