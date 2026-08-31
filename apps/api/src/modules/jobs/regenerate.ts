import { schema } from '@tryme/db';
import type {
  CreateSareeJobRequest,
  CreateSimpleTryonRequest,
  CreateTryOnJobRequest,
  Resolution,
} from '@tryme/types';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { createJob, createSimpleTryonJob } from './create.js';
import { createSareeJob } from './createSaree.js';
import { promptGuard } from './sanitize.js';

const FREE_REGENERATE_DAILY_LIMIT = 5;
const FREE_REGENERATE_LIMIT_ENABLED = true;

function freeRegenerateKey(userId: string): string {
  // UTC calendar day — a fixed boundary is simpler and good enough for a soft
  // daily allowance; no need to account for the user's own timezone here.
  const day = new Date().toISOString().slice(0, 10);
  return `regen:free:${userId}:${day}`;
}

async function getFreeRegenerateCount(app: FastifyInstance, userId: string): Promise<number> {
  const raw = await app.redis.get(freeRegenerateKey(userId));
  return raw ? Number(raw) : 0;
}

async function incrementFreeRegenerateCount(app: FastifyInstance, userId: string): Promise<void> {
  const key = freeRegenerateKey(userId);
  const count = await app.redis.incr(key);
  // Only the first increment of the day sets the expiry — a 2-day TTL is a
  // generous safety buffer so a clock skew or slow request near midnight can
  // never leave the key stuck permanently.
  if (count === 1) await app.redis.expire(key, 172_800);
}

/**
 * Resolves which workflow template a (poseId, garmentTypeId) pair would
 * dispatch through today — mirrors the precedence apps/dispatcher/src/job/
 * processor.ts already applies at dispatch time (poseGarmentConfigs override,
 * else the pose's own default). Duplicated rather than shared because the two
 * call sites need different subsets of that resolution (the dispatcher also
 * resolves prompt text and the flat-saree branch; this only needs the template
 * id to look up its regenerationReasonPrompts) — see the patcher.ts `.inputs.prompt`
 * vs `.inputs.text` note in the plan for why this duplication is a known,
 * accepted risk rather than an oversight.
 */
async function resolveEffectiveWorkflowTemplateId(
  app: FastifyInstance,
  params: Record<string, unknown>,
  poseId: string,
  garmentTypeId: string | null,
): Promise<string | null> {
  if (typeof params.workflowTemplateId === 'string') return params.workflowTemplateId;

  if (garmentTypeId) {
    // Flat-saree (and any future two-pass) garment types use ONE fixed workflow
    // for every pose, set on the garment type itself — create.ts's resolveTryonPlan
    // ignores the pose's own workflow/pose_garment_configs entirely for these.
    // Mirroring that precedence here matters: getting it wrong would force the
    // WRONG ComfyUI graph onto the regenerated job, not just the wrong prompt.
    const [gtRow] = await app.db
      .select({
        requiresMannequinStep: schema.garmentSubcategories.requiresMannequinStep,
        sareeStep2WorkflowTemplateId: schema.garmentSubcategories.sareeStep2WorkflowTemplateId,
      })
      .from(schema.garmentSubcategories)
      .where(eq(schema.garmentSubcategories.id, garmentTypeId));
    if (gtRow?.requiresMannequinStep) return gtRow.sareeStep2WorkflowTemplateId ?? null;

    const [cfgRow] = await app.db
      .select({ workflowTemplateId: schema.poseGarmentConfigs.workflowTemplateId })
      .from(schema.poseGarmentConfigs)
      .where(
        and(
          eq(schema.poseGarmentConfigs.poseAssetId, poseId),
          eq(schema.poseGarmentConfigs.subcategoryId, garmentTypeId),
        ),
      );
    if (cfgRow?.workflowTemplateId) return cfgRow.workflowTemplateId;
  }

  const [poseRow] = await app.db
    .select({ workflowTemplateId: schema.modelPoseAssets.workflowTemplateId })
    .from(schema.modelPoseAssets)
    .where(eq(schema.modelPoseAssets.id, poseId));
  return poseRow?.workflowTemplateId ?? null;
}

async function getRegenerationReasonPrompts(
  app: FastifyInstance,
  workflowTemplateId: string,
): Promise<{ reason: string; prompt: string }[]> {
  const [row] = await app.db
    .select({ regenerationReasonPrompts: schema.workflowTemplates.regenerationReasonPrompts })
    .from(schema.workflowTemplates)
    .where(eq(schema.workflowTemplates.id, workflowTemplateId));
  return row?.regenerationReasonPrompts ?? [];
}

/**
 * Picks the admin-curated prompt whose reason exactly matches what the user
 * submitted. No match — an unconfigured reason, or the free-text "Other" —
 * returns null, and the caller falls back to rerunning the original prompt.
 */
async function pickRegenerationPrompt(
  app: FastifyInstance,
  workflowTemplateId: string,
  reason: string,
): Promise<string | null> {
  const pairs = await getRegenerationReasonPrompts(app, workflowTemplateId);
  return pairs.find((p) => p.reason === reason)?.prompt ?? null;
}

/**
 * Resolves the reason labels to offer for regenerating a given job — the
 * configured labels for whichever workflow template that job would dispatch
 * through today. Same ownership/status rules as regenerateJob's read, since
 * this is shown before the user has committed to regenerating.
 */
export async function getRegenerateReasons(
  app: FastifyInstance,
  userId: string,
  jobId: string,
): Promise<string[]> {
  const [original] = await app.db
    .select({ job: schema.jobs, inputs: schema.jobInputs })
    .from(schema.jobs)
    .innerJoin(schema.jobInputs, eq(schema.jobs.id, schema.jobInputs.jobId))
    .where(eq(schema.jobs.id, jobId));

  if (!original) throw new AppError('NOT_FOUND', 404, 'job not found');
  if (original.job.userId !== userId) throw new AppError('NOT_FOUND', 404, 'job not found');

  const { inputs } = original;
  const params = (inputs.params ?? {}) as Record<string, unknown>;
  // Saree and direct-tryon-from-catalogue regenerates never carry a poseId —
  // they have no per-workflow reason pool (see the isSaree/isTryonDirect
  // branches in regenerateJob, which never build a paramsOverride either).
  if (!inputs.poseId) return [];

  const effectiveWorkflowTemplateId = await resolveEffectiveWorkflowTemplateId(
    app,
    params,
    inputs.poseId,
    inputs.garmentTypeId,
  );
  if (!effectiveWorkflowTemplateId) return [];

  const pairs = await getRegenerationReasonPrompts(app, effectiveWorkflowTemplateId);
  return pairs.map((p) => p.reason);
}

/**
 * Regenerate = a brand-new job, validated exactly like a fresh request — same
 * createJob/createSimpleTryonJob/createSareeJob helpers the real routes use,
 * so catalog/pose-workflow validation and watermark entitlement can never
 * silently drift from the real routes. Pricing is the one deliberate
 * exception: within today's free allowance, `waiveCost: true` makes those
 * helpers create the job with creditsCharged=0 and skip atomicDeduct entirely
 * — genuinely never charged, not charged-then-refunded. That also means every
 * existing refund path (terminateJob's timeout/failure refund, the stuck-job
 * sweeper) naturally no-ops for a free regenerate, since they all guard on
 * `creditsCharged > 0` — there is nothing left to double-refund if a free
 * regenerate's job later fails.
 */
export async function regenerateJob(
  app: FastifyInstance,
  userId: string,
  originalJobId: string,
  reason: string,
) {
  const cleanReason = promptGuard(reason);
  if (!cleanReason) throw new AppError('VALIDATION', 400, 'a reason is required to regenerate');

  const [original] = await app.db
    .select({
      job: schema.jobs,
      inputs: schema.jobInputs,
      downloadedAt: schema.jobOutputs.downloadedAt,
    })
    .from(schema.jobs)
    .innerJoin(schema.jobInputs, eq(schema.jobs.id, schema.jobInputs.jobId))
    .leftJoin(schema.jobOutputs, eq(schema.jobs.id, schema.jobOutputs.jobId))
    .where(eq(schema.jobs.id, originalJobId));

  if (!original) throw new AppError('NOT_FOUND', 404, 'job not found');
  if (original.job.userId !== userId) throw new AppError('NOT_FOUND', 404, 'job not found');
  if (original.job.status !== 'COMPLETED') {
    throw new AppError('CONFLICT', 409, 'can only regenerate completed jobs');
  }
  if (original.downloadedAt) {
    throw new AppError(
      'ALREADY_DOWNLOADED',
      409,
      'this result has already been downloaded and can no longer be regenerated',
    );
  }

  if (FREE_REGENERATE_LIMIT_ENABLED) {
    const freeUsedToday = await getFreeRegenerateCount(app, userId);
    if (freeUsedToday >= FREE_REGENERATE_DAILY_LIMIT) {
      throw new AppError(
        'FREE_REGENERATE_LIMIT',
        429,
        `You've used all ${FREE_REGENERATE_DAILY_LIMIT} free regenerations for today. Please contact customer support for more.`,
      );
    }
  }

  const { inputs } = original;
  const params = (inputs.params ?? {}) as Record<string, unknown>;
  const isSaree = params.kind === 'saree';
  const isTryonDirect = typeof params.personKey === 'string';

  // Shared tail: log why, count today's free allowance, stamp parentJobId.
  // Every branch below funnels through this before returning.
  const finish = async (newJobId: string, catalogueId?: string) => {
    // Logged against the NEW job (not the original) — parentJobId already links
    // back to the original on the jobs row itself, and admins reviewing a
    // regenerated job want the reason available right there, not on a
    // different job's event log.
    await app.db.insert(schema.jobEvents).values({
      jobId: newJobId,
      eventType: 'REGENERATE_REASON',
      payload: { reason: cleanReason, parentJobId: originalJobId },
    });

    // Skipped while the cap is disabled too — otherwise local testing would
    // silently burn through the real quota and the very first regenerate after
    // re-enabling it could already be over the limit.
    if (FREE_REGENERATE_LIMIT_ENABLED) await incrementFreeRegenerateCount(app, userId);

    await setParentJobId(app, newJobId, originalJobId);
    return { jobId: newJobId, catalogueId };
  };

  if (isSaree) {
    if (!inputs.upperGarmentKey) {
      throw new AppError('VALIDATION', 400, 'original job has no garment to regenerate');
    }
    const body: z.infer<typeof CreateSareeJobRequest> = { garmentKey: inputs.upperGarmentKey };
    const result = await createSareeJob(app, userId, body, { waiveCost: true });
    return finish(result.jobId, result.catalogueId);
  }

  if (isTryonDirect) {
    const { personKey, sourceJobId } = params;
    if (typeof personKey !== 'string' || typeof sourceJobId !== 'string') {
      throw new AppError(
        'VALIDATION',
        400,
        'this job cannot be regenerated — missing source reference',
      );
    }
    const body: z.infer<typeof CreateSimpleTryonRequest> = { personKey, sourceJobId };
    const result = await createSimpleTryonJob(app, userId, body, { waiveCost: true });
    return finish(result.jobId, result.catalogueId);
  }

  // Studio/catalogue job — one poseId per job row, reconstruct the multi-pose
  // request shape createJob expects with just that single pose.
  if (!inputs.poseId || !inputs.faceId || !inputs.backgroundId) {
    throw new AppError('VALIDATION', 400, 'original job is missing required inputs to regenerate');
  }
  const mappingId =
    typeof params.catalogueTemplateMappingId === 'string'
      ? params.catalogueTemplateMappingId
      : undefined;
  if (mappingId && !inputs.garmentTypeId) {
    throw new AppError(
      'VALIDATION',
      400,
      'mapped original job is missing its garment type and cannot be regenerated',
    );
  }

  const trustedGarmentKeys = new Set<string>();
  if (inputs.upperGarmentKey) trustedGarmentKeys.add(inputs.upperGarmentKey);
  if (inputs.lowerGarmentKey) trustedGarmentKeys.add(inputs.lowerGarmentKey);

  // Same workflow, different prompt: resolve which template this pose/garment-type
  // combo would dispatch through today, then — only if the admin has configured
  // alternates for it — force that same template id back onto the new job's
  // params along with the chosen prompt text. processor.ts already honors this
  // exact snapshot shape (see docs/superpowers plan) for the catalogue-template-
  // mapping flow; this reuses it rather than adding a second mechanism.
  let paramsOverride: Record<string, unknown> | undefined;
  const effectiveWorkflowTemplateId = await resolveEffectiveWorkflowTemplateId(
    app,
    params,
    inputs.poseId,
    inputs.garmentTypeId,
  );
  if (effectiveWorkflowTemplateId) {
    const chosenPrompt = await pickRegenerationPrompt(
      app,
      effectiveWorkflowTemplateId,
      cleanReason,
    );
    if (chosenPrompt) {
      paramsOverride = {
        workflowTemplateId: effectiveWorkflowTemplateId,
        promptGarmentPhase: chosenPrompt,
      };
    }
  }

  const body: z.infer<typeof CreateTryOnJobRequest> = {
    catalogueId: original.job.catalogueId ?? undefined,
    inputs: {
      upperGarmentKey: inputs.upperGarmentKey ?? undefined,
      faceId: inputs.faceId,
      garmentTypeId: inputs.garmentTypeId ?? undefined,
      lowerCatalogId: inputs.lowerCatalogId ?? undefined,
      lowerGarmentKey: inputs.lowerGarmentKey ?? undefined,
      shoeCatalogId: inputs.shoeCatalogId ?? undefined,
      ...(mappingId
        ? {
            catalogueTemplateMappingId: mappingId,
            looks: [{ poseId: inputs.poseId, backgroundId: inputs.backgroundId }],
          }
        : { backgroundId: inputs.backgroundId, poseIds: [inputs.poseId] }),
    },
    params: {
      outputWidth: typeof params.outputWidth === 'number' ? params.outputWidth : undefined,
      outputHeight: typeof params.outputHeight === 'number' ? params.outputHeight : undefined,
    },
    userHint: inputs.userHint ?? undefined,
    aspectRatio: (typeof params.aspectRatio === 'string' ? params.aspectRatio : '1:1') as z.infer<
      typeof CreateTryOnJobRequest
    >['aspectRatio'],
    resolution: (typeof params.resolution === 'string' ? params.resolution : '2K') as Resolution,
    platform: typeof params.platform === 'string' ? params.platform : undefined,
  };

  const result = await createJob(app, userId, body, {
    trustedGarmentKeys,
    paramsOverride,
    waiveCost: true,
  });
  const newJobId = result.jobIds[0];
  return finish(newJobId, result.catalogueId);
}

async function setParentJobId(app: FastifyInstance, jobId: string, parentJobId: string) {
  await app.db.update(schema.jobs).set({ parentJobId }).where(eq(schema.jobs.id, jobId));
}
