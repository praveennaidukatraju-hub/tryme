import { z } from 'zod';

export const RESOLUTION_COSTS = {
  HD: 25,
  '2K': 35,
  '4K': 40,
} as const;

export type Resolution = keyof typeof RESOLUTION_COSTS;

/** Canonical output pixel dimensions per aspect ratio — matches patcher.ts ASPECT_DIMENSIONS. */
export const ASPECT_DIMENSIONS: Record<string, { width: number; height: number }> = {
  '1:1': { width: 2048, height: 2048 },
  '2:3': { width: 1365, height: 2048 },
  '3:4': { width: 1331, height: 1774 },
  '4:5': { width: 1375, height: 1718 },
};

/** Derive the server-authoritative resolution tier from actual output pixel dimensions. */
export function resolutionFromDims(width: number, height: number): Resolution {
  const longEdge = Math.max(width, height);
  if (longEdge > 3000) return '4K';
  if (longEdge > 1200) return '2K';
  return 'HD';
}

/**
 * Shape of a user-uploaded garment R2 key, exactly as issued by
 * `/v1/uploads/presign` (`inputs/<uuid>/garment.jpg`). Pinning the format here
 * rejects arbitrary/traversal keys at the API boundary; ownership of the key is
 * additionally enforced server-side against the issuing user (see createJob).
 */
export const INPUT_GARMENT_KEY =
  /^inputs\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/garment\.jpg$/;

export const CreateTryOnJobInputsBase = z.object({
  // Exactly one of upperGarmentKey (a fresh presigned upload) or mannequinJobId
  // (a completed saree-mannequin job's output, see createSareeMannequinJob) is
  // required — enforced below. mannequinJobId is only valid for garment types
  // with requiresMannequinStep=true (enforced server-side in createJob).
  upperGarmentKey: z.string().regex(INPUT_GARMENT_KEY).optional(),
  mannequinJobId: z.string().uuid().optional(),
  faceId: z.string().uuid(),
  // Legacy/custom form: a single shared background applied to every pose.
  backgroundId: z.string().uuid().optional(),
  poseIds: z.array(z.string().uuid()).min(1).optional(),
  // Template form: each pose carries its own background. Exactly one of
  // (backgroundId + poseIds) or looks must be provided — enforced below.
  looks: z
    .array(
      z.object({
        poseId: z.string().uuid(),
        backgroundId: z.string().uuid(),
      }),
    )
    .min(1)
    .max(12)
    .optional(),
  garmentTypeId: z.string().uuid().optional(),
  catalogueTemplateMappingId: z.string().uuid().optional(),
  lowerCatalogId: z.string().uuid().optional(),
  lowerGarmentKey: z.string().regex(INPUT_GARMENT_KEY).optional(),
  thirdGarmentKey: z.string().regex(INPUT_GARMENT_KEY).optional(),
  shoeCatalogId: z.string().uuid().optional(),
});

function refineLooksXor<T extends { backgroundId?: string; poseIds?: string[]; looks?: unknown }>(
  schema: z.ZodType<T>,
) {
  return schema.refine((d) => Boolean(d.backgroundId && d.poseIds) !== Boolean(d.looks), {
    message: 'Provide either (backgroundId + poseIds) or looks, not both',
  });
}

export const CreateTryOnJobInputs = refineLooksXor(CreateTryOnJobInputsBase).refine(
  (d) => Boolean(d.upperGarmentKey) !== Boolean(d.mannequinJobId),
  {
    message: 'Provide either upperGarmentKey or mannequinJobId, not both',
    path: ['upperGarmentKey'],
  },
);

// The step-2 payload embedded in POST /v1/jobs/saree-mannequin. Neither
// upperGarmentKey nor mannequinJobId is accepted from the client here — the
// dispatcher fills upperGarmentKey in once the mannequin job (created in the
// same request) completes, and mannequinJobId is derived server-side, not
// client-supplied. See createSareeMannequinJob.
export const SareeStep2Inputs = refineLooksXor(
  CreateTryOnJobInputsBase.omit({ upperGarmentKey: true, mannequinJobId: true }),
);

export const CreateTryOnJobRequest = z.object({
  catalogueId: z.string().uuid().optional(),
  inputs: CreateTryOnJobInputs,
  params: z
    .object({
      seedStage1: z.number().int().optional(),
      seedStage2: z.number().int().optional(),
      stepsStage1: z.number().int().min(1).max(30).optional(), // ponytail: flat cap; make per-tier when step pricing is decided
      stepsStage2: z.number().int().min(1).max(30).optional(),
      outputWidth: z.number().int().min(512).max(4096).optional(),
      outputHeight: z.number().int().min(512).max(4096).optional(),
    })
    .optional(),
  userHint: z.string().max(300).optional(),
  aspectRatio: z.enum(['1:1', '2:3', '3:4', '4:5']),
  resolution: z.enum(['HD', '2K', '4K']),
  platform: z.string().optional(),
});

/** Fallback default — the actual charged cost is admin-configurable, see getTryonCreditCost(). */
export const SIMPLE_TRYON_COST = 5;

/** Fallback default — the actual charged cost is admin-configurable, see getSareeMannequinDevCreditCost(). */
export const SAREE_MANNEQUIN_DEV_COST = 10;
/** Fallback default — the actual charged cost is admin-configurable, see getPixverseCreditCost(). */
export const PIXVERSE_VIDEO_COST = 150;

export const CreateSimpleTryonRequest = z.object({
  personKey: z.string().regex(INPUT_GARMENT_KEY),
  sourceJobId: z.string().uuid(),
});

/** A reason is mandatory before a regenerate request fires — see regenerateJob. */
export const RegenerateJobRequest = z.object({
  reason: z.string().min(1).max(300),
});

/** Reason labels configured for the job's resolved workflow template, plus a
 *  fixed trailing "Other" the client always offers — see getRegenerateReasons. */
export const RegenerateReasonsResponse = z.object({
  reasons: z.array(z.string()),
});

export const CreateCatalogVideoJobRequest = z
  .object({
    // Exactly one of sourceJobId (an existing completed AI Vastra job) or
    // sourceImageKey (a fresh upload of any image the caller owns — not
    // required to have been generated by AI Vastra) is required — enforced
    // below, same XOR style as upperGarmentKey/mannequinJobId above.
    sourceJobId: z.string().uuid().optional(),
    sourceImageKey: z.string().regex(INPUT_GARMENT_KEY).optional(),
    sampleVideoId: z.string().uuid(),
  })
  .refine((d) => Boolean(d.sourceJobId) !== Boolean(d.sourceImageKey), {
    message: 'Provide either sourceJobId or sourceImageKey, not both',
    path: ['sourceJobId'],
  });

export const CreateSareeMannequinJobRequest = z.object({
  garmentTypeId: z.string().uuid(),
  garmentKey: z.string().regex(INPUT_GARMENT_KEY),
  // Pallu image for the "Body & Pallu" two-input upload mode — only valid when
  // the garment type has mannequinTwoInputWorkflowTemplateId configured
  // (enforced server-side in createSareeMannequinJob, see Task 6).
  secondGarmentKey: z.string().regex(INPUT_GARMENT_KEY).optional(),
  faceId: z.string().uuid(),
  // Full step-2 (tryon) request, captured up front so the dispatcher can create
  // and enqueue the tryon job(s) itself once the mannequin job completes — see
  // createSareeMannequinJob and apps/dispatcher/src/job/saree-step2-promoter.ts.
  step2: z.object({
    catalogueId: z.string().uuid().optional(),
    inputs: SareeStep2Inputs,
    params: z
      .object({
        seedStage1: z.number().int().optional(),
        seedStage2: z.number().int().optional(),
        stepsStage1: z.number().int().min(1).max(30).optional(),
        stepsStage2: z.number().int().min(1).max(30).optional(),
        outputWidth: z.number().int().min(512).max(4096).optional(),
        outputHeight: z.number().int().min(512).max(4096).optional(),
      })
      .optional(),
    userHint: z.string().max(300).optional(),
    aspectRatio: z.enum(['1:1', '2:3', '3:4', '4:5']),
    resolution: z.enum(['HD', '2K', '4K']),
    platform: z.string().optional(),
  }),
});

export const PresignUploadBody = z.object({
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  contentLength: z
    .number()
    .int()
    .positive()
    .max(20 * 1024 * 1024),
});

export const PresignUploadResponse = z.object({
  uploadUrl: z.string().url(),
  r2Key: z.string(),
  expiresIn: z.number().int().positive(),
});
