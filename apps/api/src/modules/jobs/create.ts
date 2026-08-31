import { randomUUID } from 'node:crypto';
import { type DB, schema } from '@tryme/db';
import { jobsCreatedTotal } from '@tryme/observability';
import { keys } from '@tryme/storage';
import {
  ASPECT_DIMENSIONS,
  type CreateCatalogVideoJobRequest,
  type CreateSimpleTryonRequest,
  type CreateTryOnJobRequest,
  JOB_SOURCE,
  type JobSource,
  type Resolution,
  resolutionFromDims,
  type SareeStep2Inputs,
} from '@tryme/types';
import { aliasedTable, and, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import { isCatalogVideoAllowed } from '../../lib/catalog-video-access.js';
import { AppError } from '../../lib/errors.js';
import { assertQueueCapacity } from '../../lib/queue-capacity-config.js';
import {
  getMaxOutputPx,
  getPixverseCreditCost,
  getResolutionCreditCost,
  getTryonCreditCost,
} from '../../lib/resolution-config.js';
import { assertGarmentObjectValid, assertOwnsUploadKey } from '../../lib/upload-ownership.js';
import { atomicDeduct, refundAndMarkFailed } from '../credits/ledger.js';
import { getSareeSettings } from '../saree/settings.js';
import { promptGuard } from './sanitize.js';

export { assertOwnsUploadKey } from '../../lib/upload-ownership.js';

/**
 * Resolves a completed saree-mannequin job (see createSareeMannequinJob) to its
 * output R2 key, for use as a step-2 job's upperGarmentKey. Mirrors
 * assertOwnsUploadKey's ownership check, but against a job's own output rather
 * than a presigned-upload Redis binding.
 */
export async function resolveMannequinGarmentKey(
  app: FastifyInstance,
  userId: string,
  mannequinJobId: string,
): Promise<string> {
  const [row] = await app.db
    .select({
      userId: schema.jobs.userId,
      status: schema.jobs.status,
      kind: sql<string>`${schema.jobInputs.params}->>'kind'`.as('kind'),
    })
    .from(schema.jobs)
    .innerJoin(schema.jobInputs, eq(schema.jobInputs.jobId, schema.jobs.id))
    .where(eq(schema.jobs.id, mannequinJobId));
  if (!row || row.userId !== userId) {
    throw new AppError('FORBIDDEN', 403, 'mannequin job not owned by caller');
  }
  if (row.kind !== 'saree_mannequin') {
    throw new AppError('VALIDATION', 400, 'job is not a mannequin generation job');
  }
  if (row.status !== 'COMPLETED') {
    throw new AppError('VALIDATION', 400, 'mannequin generation not yet complete');
  }
  return keys.output(mannequinJobId);
}

/**
 * H2: keys are format-pinned by zod, but the format alone does not prove the
 * caller owns the object — another user's key has the same shape. Verify each
 * garment key was issued to THIS user by /v1/uploads/presign (Redis binding)
 * before any credit/DB mutation. `trustedGarmentKeys` bypasses the Redis-binding
 * check for a key already proven to belong to this user by an earlier step in
 * the same request (see regenerate.ts, shopify/catalog.routes.ts) — the 24h
 * upload-ownership binding may have expired by the time of a regenerate.
 */
export async function verifyGarmentKey(
  app: FastifyInstance,
  userId: string | null,
  key: string,
  trustedGarmentKeys?: Set<string>,
): Promise<void> {
  if (trustedGarmentKeys?.has(key)) {
    await assertGarmentObjectValid(app, key);
    return;
  }
  if (userId === null) {
    // A null userId (store-billed caller) must never reach here — every key that
    // caller passes is expected to already be in trustedGarmentKeys (see Task 5's
    // createShopifyStoreCatalogJob). Reaching this branch means a code path there
    // is passing an unverified key, which is a bug, not a recoverable case.
    throw new AppError('FORBIDDEN', 403, 'garment key ownership cannot be verified');
  }
  await assertOwnsUploadKey(app, userId, key);
}

export interface QueueRouting {
  queueStream: string;
  priority: boolean;
  watermark: boolean;
}

/**
 * PIPE-9: `users.tier` is sticky forever once any priority-queueStream plan is
 * purchased — plans are one-time credit top-ups, not subscriptions, and nothing
 * ever resets `tier` back down. That makes the priority cohort only ever grow,
 * worsening PIPE-8's starvation risk over time. Decided fix: priority routing
 * requires an actual current balance, not just having bought a priority plan at
 * some point — so it's computed fresh at every enqueue rather than trusting the
 * sticky `users.tier` alone. Watermark entitlement is intentionally untouched:
 * it's a separate, unrelated entitlement that still derives from tier alone.
 */
export async function resolveQueueRouting(
  app: FastifyInstance,
  userId: string,
): Promise<QueueRouting> {
  const [[planRow], [creditsRow]] = await Promise.all([
    app.db
      .select({
        queueStream: schema.creditPlans.queueStream,
        watermark: schema.creditPlans.watermark,
      })
      .from(schema.users)
      .innerJoin(schema.creditPlans, eq(schema.users.tier, schema.creditPlans.slug))
      .where(eq(schema.users.id, userId)),
    app.db
      .select({ balance: schema.userCredits.balance })
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, userId)),
  ]);

  const rawQueueStream: string = planRow?.queueStream ?? 'normal';
  const hasBalance = (creditsRow?.balance ?? 0) > 0;
  const queueStream = rawQueueStream === 'priority' && !hasBalance ? 'normal' : rawQueueStream;

  return {
    queueStream,
    priority: queueStream === 'priority',
    watermark: planRow?.watermark ?? false,
  };
}

export interface TryonPlanLook {
  poseId: string;
  backgroundId: string;
  upperGarmentKey: string | null;
  lowerCatalogId: string | null;
  lowerGarmentKey: string | null;
  shoeCatalogId: string | null;
  workflowTemplateId: string | null;
  promptGarmentPhase: string | null;
  params: Record<string, unknown>;
}

export interface TryonPlan {
  catalogueId: string;
  cost: number;
  looks: TryonPlanLook[];
}

/**
 * Per-request memo for resolveTryonPlan's existence checks. Batch creation calls
 * resolveTryonPlan once per row, and rows overwhelmingly share the same face,
 * background, poses and garment type — without this, a 30-row batch reissues the
 * same handful of queries 30 times.
 *
 * Only ID-existence and admin-config lookups are cached. Per-pose workflow
 * resolution is NOT, because it depends on (poseId, garmentTypeId) together and
 * on pose_garment_configs overrides that vary per row.
 *
 * Lifetime is a single request. Never hold one across requests: an admin
 * deactivating an asset mid-flight must be visible to the next request.
 */
export interface TryonPlanCache {
  faces: Map<string, boolean>;
  backgrounds: Map<string, boolean>;
  poses: Map<string, boolean>;
  catalogItems: Map<string, boolean>;
  garmentTypes: Map<string, boolean>;
  maxOutputPx?: number;
  resolutionCosts: Map<string, number>;
}

export function createTryonPlanCache(): TryonPlanCache {
  return {
    faces: new Map(),
    backgrounds: new Map(),
    poses: new Map(),
    catalogItems: new Map(),
    garmentTypes: new Map(),
    resolutionCosts: new Map(),
  };
}

/**
 * Validates a tryon request end-to-end — server-side cost, garment-type/
 * mannequin-step policy, face/background/pose/catalog existence, and per-pose
 * workflow node requirements — and produces a plan of QUEUED-job-ready "looks".
 * Read-only: never deducts credits, inserts rows, or enqueues anything. Shared
 * by createJob (the direct /v1/jobs/tryon path) and createSareeMannequinJob's
 * step-2 planning (Task 3), so both stay validation-identical without
 * duplicating this logic.
 *
 * The caller resolves `upperGarmentKey` itself before calling in — either via
 * `resolveMannequinGarmentKey` (mannequinJobId path) or `verifyGarmentKey`
 * (direct upload path) — since only the caller knows which form applies.
 * `opts.resolvedUpperGarmentKey` is `null` only when the caller must defer that
 * resolution (the saree-mannequin step-2 path, until its mannequin job
 * completes). `opts.trustedGarmentKeys` passes through the same regenerate-flow
 * bypass createJob's own upperGarmentKey resolution uses, so the lower/third
 * garment verification below stays consistent with the caller's.
 */
export async function resolveTryonPlan(
  app: FastifyInstance,
  userId: string | null,
  body:
    | z.infer<typeof CreateTryOnJobRequest>
    | {
        catalogueId?: string;
        inputs: z.infer<typeof SareeStep2Inputs>;
        params?: z.infer<typeof CreateTryOnJobRequest>['params'];
        userHint?: string;
        aspectRatio: string;
        platform?: string;
      },
  opts: {
    resolvedUpperGarmentKey: string | null;
    trustedGarmentKeys?: Set<string>;
    cache?: TryonPlanCache;
    /** Set only by regenerateJob to force the same workflow's alternate positive
     *  prompt — see the params-merge at the end of the looks_ map below. Never
     *  derived from client input. */
    paramsOverride?: Record<string, unknown>;
  },
): Promise<TryonPlan> {
  const {
    faceId,
    garmentTypeId,
    catalogueTemplateMappingId,
    lowerCatalogId,
    lowerGarmentKey,
    thirdGarmentKey,
    shoeCatalogId,
  } = body.inputs;
  const aspectRatio: string | undefined = body.aspectRatio;
  const platform: string | undefined = body.platform;
  const resolvedUpperGarmentKey = opts.resolvedUpperGarmentKey ?? undefined;

  // S1: compute cost server-side from actual output dims — never trust client's `resolution`.
  const customW = body.params?.outputWidth;
  const customH = body.params?.outputHeight;
  const requestedDims =
    customW && customH
      ? { width: customW, height: customH }
      : (ASPECT_DIMENSIONS[body.aspectRatio] ?? { width: 2048, height: 2048 });
  // Platform-wide resolution ceiling — admin-configured, not per-workflow (see
  // getMaxOutputPx). Only downscale, and only the long edge exceeding it; the
  // dispatcher patches the workflow with whatever dims land in job_inputs.params,
  // so this is the single enforcement point.
  const maxOutputPx =
    opts.cache?.maxOutputPx ??
    (await (async () => {
      const value = await getMaxOutputPx(app);
      if (opts.cache) opts.cache.maxOutputPx = value;
      return value;
    })());
  const requestedLongEdge = Math.max(requestedDims.width, requestedDims.height);
  const outputDims =
    requestedLongEdge > maxOutputPx
      ? requestedDims.width >= requestedDims.height
        ? {
            width: maxOutputPx,
            height: Math.round(maxOutputPx * (requestedDims.height / requestedDims.width)),
          }
        : {
            width: Math.round(maxOutputPx * (requestedDims.width / requestedDims.height)),
            height: maxOutputPx,
          }
      : requestedDims;
  const resolution: Resolution = resolutionFromDims(outputDims.width, outputDims.height);
  const COST =
    opts.cache?.resolutionCosts.get(resolution) ??
    (await (async () => {
      const value = await getResolutionCreditCost(app, resolution);
      opts.cache?.resolutionCosts.set(resolution, value);
      return value;
    })());

  // Flat-saree (and any future two-pass) garment types resolve their garment
  // input from a completed mannequin job instead of a fresh upload, and use a
  // single fixed step-2 workflow for every pose (its own lowerNodeId/shoeNodeId
  // govern validation below) instead of each pose's own default workflow or any
  // pose_garment_configs override.
  let requiresMannequinStep = false;
  let sareeStep2: {
    workflowTemplateId: string | null;
    version: number | null;
    upperNodeIds: string[] | null;
    lowerNodeId: string | null;
    shoeNodeId: string | null;
    sizeNodeIds: string[] | null;
  } | null = null;
  if (garmentTypeId) {
    const [gtRow] = await app.db
      .select({
        requiresMannequinStep: schema.garmentSubcategories.requiresMannequinStep,
        sareeStep2WorkflowTemplateId: schema.garmentSubcategories.sareeStep2WorkflowTemplateId,
        sareeStep2UpperNodeIds: schema.workflowTemplates.upperNodeIds,
        sareeStep2LowerNodeId: schema.workflowTemplates.lowerNodeId,
        sareeStep2ShoeNodeId: schema.workflowTemplates.shoeNodeId,
        sareeStep2SizeNodeIds: schema.workflowTemplates.sizeNodeIds,
        sareeStep2Version: schema.workflowTemplates.version,
      })
      .from(schema.garmentSubcategories)
      .leftJoin(
        schema.workflowTemplates,
        eq(schema.workflowTemplates.id, schema.garmentSubcategories.sareeStep2WorkflowTemplateId),
      )
      .where(eq(schema.garmentSubcategories.id, garmentTypeId));
    requiresMannequinStep = gtRow?.requiresMannequinStep ?? false;
    if (requiresMannequinStep) {
      sareeStep2 = {
        workflowTemplateId: gtRow?.sareeStep2WorkflowTemplateId ?? null,
        version: gtRow?.sareeStep2Version ?? null,
        upperNodeIds: gtRow?.sareeStep2UpperNodeIds ?? null,
        lowerNodeId: gtRow?.sareeStep2LowerNodeId ?? null,
        shoeNodeId: gtRow?.sareeStep2ShoeNodeId ?? null,
        sizeNodeIds: gtRow?.sareeStep2SizeNodeIds ?? null,
      };
    }
  }

  // Defensive backstop only — for both current callers, opts.resolvedUpperGarmentKey
  // is always `string | null` by construction (never JS `undefined`), so this never
  // fires from createJob (which pre-checks the raw mannequinJobId/upperGarmentKey
  // fields itself, see below) or from a saree-step2 caller passing `null` to
  // legitimately defer resolution. It only guards a caller that bypasses the type
  // and passes `undefined` outright.
  if (requiresMannequinStep && opts.resolvedUpperGarmentKey === undefined) {
    throw new AppError('VALIDATION', 400, 'mannequinJobId required for this garment type');
  }

  if (lowerGarmentKey) {
    await verifyGarmentKey(app, userId, lowerGarmentKey, opts.trustedGarmentKeys);
  }
  if (thirdGarmentKey) {
    await verifyGarmentKey(app, userId, thirdGarmentKey, opts.trustedGarmentKeys);
  }

  // Normalize to a single per-look list. This only rejects "neither form present" —
  // it does not independently re-enforce "not both", since CreateTryOnJobInputs's
  // zod .refine() (a true XOR via !==) already guarantees that upstream of every
  // route that calls createJob (and SareeStep2Inputs' own refine does the same for
  // the saree-mannequin path). This guard exists because TS can't see the refine's
  // constraint through the optional fields on body.inputs.
  const legacyBackgroundId = body.inputs.backgroundId;
  const legacyPoseIds = body.inputs.poseIds;
  const templateLooks = body.inputs.looks;
  if (!templateLooks && !(legacyBackgroundId && legacyPoseIds)) {
    throw new AppError(
      'VALIDATION',
      400,
      'inputs must include either backgroundId+poseIds or looks',
    );
  }

  let looks: Array<{ poseId: string; backgroundId: string }>;
  if (templateLooks) {
    // Per-look backgrounds are authoritative for templates — the Amazon white-bg
    // override below must never run for this form.
    looks = templateLooks;
  } else {
    // Amazon platform requires a white background — override the single shared
    // background with the one tagged isWhiteBg in the admin panel. Only applies
    // to the legacy form; template backgrounds are never overridden.
    let effectiveBackgroundId = legacyBackgroundId as string;
    if (platform === 'Amazon') {
      const [whiteBg] = await app.db
        .select({ id: schema.modelBackgrounds.id })
        .from(schema.modelBackgrounds)
        .where(
          and(
            eq(schema.modelBackgrounds.isActive, true),
            eq(schema.modelBackgrounds.isWhiteBg, true),
          ),
        )
        .limit(1);
      if (!whiteBg) {
        throw new AppError(
          'VALIDATION',
          400,
          'Amazon platform requires a white background to be configured',
        );
      }
      effectiveBackgroundId = whiteBg.id;
      app.log.info(
        { originalBg: legacyBackgroundId, amazonBg: effectiveBackgroundId, platform },
        'amazon bg override',
      );
    }
    looks = (legacyPoseIds as string[]).map((poseId) => ({
      poseId,
      backgroundId: effectiveBackgroundId,
    }));
  }

  // Only exact (poseId, backgroundId) duplicates are rejected. Same pose with two
  // DIFFERENT backgrounds is allowed by design — a template can legitimately offer
  // "Pose A @ Background 1" and "Pose A @ Background 2" as two distinct looks.
  const dedupeKeys = new Set(looks.map((l) => `${l.poseId}::${l.backgroundId}`));
  if (dedupeKeys.size !== looks.length) {
    throw new AppError('VALIDATION', 400, 'duplicate pose+background combination in looks');
  }

  const distinctPoseIds = Array.from(new Set(looks.map((l) => l.poseId)));
  const distinctBackgroundIds = Array.from(new Set(looks.map((l) => l.backgroundId)));

  // Only IDs not already known-good in the cache hit the database.
  const uncachedBackgroundIds = distinctBackgroundIds.filter(
    (id) => !opts.cache?.backgrounds.get(id),
  );
  const uncachedPoseIds = distinctPoseIds.filter((id) => !opts.cache?.poses.get(id));
  const faceCached = opts.cache?.faces.get(faceId) === true;

  const [face, backgroundRows, poses] = await Promise.all([
    faceCached
      ? Promise.resolve([{ id: faceId }])
      : app.db
          .select({ id: schema.modelFaces.id })
          .from(schema.modelFaces)
          .where(and(eq(schema.modelFaces.id, faceId), eq(schema.modelFaces.isActive, true))),
    uncachedBackgroundIds.length === 0
      ? Promise.resolve([])
      : app.db
          .select({ id: schema.modelBackgrounds.id })
          .from(schema.modelBackgrounds)
          .where(
            and(
              inArray(schema.modelBackgrounds.id, uncachedBackgroundIds),
              eq(schema.modelBackgrounds.isActive, true),
              // Soft-deleted personal backgrounds (DELETE /v1/backgrounds/mine/:id sets
              // deletedAt rather than hard-deleting) must never validate here - the
              // delete action is user-facing and must actually revoke usability, not
              // just hide the row from GET /mine.
              isNull(schema.modelBackgrounds.deletedAt),
              // A background is valid input either when it's not personal (scope='general'
              // or scope='template' — both open to any caller, matching pre-existing
              // behavior) or when it's the caller's own scope='user' row. Deliberately
              // `ne(scope, 'user')` rather than `eq(scope, 'general')` — catalogue-template
              // jobs resolve backgroundIds that can be scope='template' through this same
              // query (see resolveTryonPlan's templateLooks path above), so narrowing to
              // 'general' only would reject legitimate template-scoped backgrounds.
              or(
                ne(schema.modelBackgrounds.scope, 'user'),
                and(
                  eq(schema.modelBackgrounds.scope, 'user'),
                  userId !== null ? eq(schema.modelBackgrounds.userId, userId) : sql`false`,
                ),
              ),
            ),
          ),
    uncachedPoseIds.length === 0
      ? Promise.resolve([])
      : app.db
          .select({ id: schema.modelPoseAssets.id })
          .from(schema.modelPoseAssets)
          .where(
            and(
              inArray(schema.modelPoseAssets.id, uncachedPoseIds),
              eq(schema.modelPoseAssets.isActive, true),
              isNull(schema.modelPoseAssets.deletedAt),
            ),
          ),
  ]);

  if (!face[0]) throw new AppError('BAD_CATALOG', 400, 'face not found or inactive');
  if (backgroundRows.length !== uncachedBackgroundIds.length)
    throw new AppError('BAD_CATALOG', 400, 'one or more backgrounds not found or inactive');
  if (poses.length !== uncachedPoseIds.length)
    throw new AppError('BAD_CATALOG', 400, 'one or more poses not found or inactive');

  // Only successful lookups are memoised. A miss throws above, so a failing ID is
  // never cached as good — and never cached as bad either, which keeps the cache
  // a pure optimisation.
  if (opts.cache) {
    opts.cache.faces.set(faceId, true);
    for (const id of uncachedBackgroundIds) opts.cache.backgrounds.set(id, true);
    for (const id of uncachedPoseIds) opts.cache.poses.set(id, true);
  }

  // S6: validate optional catalog IDs so the dispatcher never silently falls back
  // on a bad ID that slipped through as null.
  const lowerCatalogCached =
    !!lowerCatalogId && opts.cache?.catalogItems.get(lowerCatalogId) === true;
  const shoeCatalogCached = !!shoeCatalogId && opts.cache?.catalogItems.get(shoeCatalogId) === true;
  const garmentTypeCached = !!garmentTypeId && opts.cache?.garmentTypes.get(garmentTypeId) === true;

  const catalogChecks = await Promise.all([
    !lowerCatalogId || lowerCatalogCached
      ? Promise.resolve([{ id: lowerCatalogId }])
      : app.db
          .select({ id: schema.catalogItems.id })
          .from(schema.catalogItems)
          .where(
            and(eq(schema.catalogItems.id, lowerCatalogId), eq(schema.catalogItems.isActive, true)),
          ),
    !shoeCatalogId || shoeCatalogCached
      ? Promise.resolve([{ id: shoeCatalogId }])
      : app.db
          .select({ id: schema.catalogItems.id })
          .from(schema.catalogItems)
          .where(
            and(eq(schema.catalogItems.id, shoeCatalogId), eq(schema.catalogItems.isActive, true)),
          ),
    !garmentTypeId || garmentTypeCached
      ? Promise.resolve([{ id: garmentTypeId }])
      : app.db
          .select({ id: schema.garmentSubcategories.id })
          .from(schema.garmentSubcategories)
          .where(
            and(
              eq(schema.garmentSubcategories.id, garmentTypeId),
              eq(schema.garmentSubcategories.isActive, true),
            ),
          ),
  ]);
  if (lowerCatalogId && !catalogChecks[0]?.[0])
    throw new AppError('BAD_CATALOG', 400, 'lower catalog item not found or inactive');
  if (shoeCatalogId && !catalogChecks[1]?.[0])
    throw new AppError('BAD_CATALOG', 400, 'shoe catalog item not found or inactive');
  if (garmentTypeId && !catalogChecks[2]?.[0])
    throw new AppError('BAD_CATALOG', 400, 'garment type not found or inactive');

  // Only successful lookups are memoised, same rationale as the face/background/pose
  // checks above: a miss throws before this point, so nothing bad is ever cached.
  if (opts.cache) {
    if (lowerCatalogId && !lowerCatalogCached) opts.cache.catalogItems.set(lowerCatalogId, true);
    if (shoeCatalogId && !shoeCatalogCached) opts.cache.catalogItems.set(shoeCatalogId, true);
    if (garmentTypeId && !garmentTypeCached) opts.cache.garmentTypes.set(garmentTypeId, true);
  }

  // Validate that workflow-required inputs are present for every selected pose.
  // If a pose's workflow has a lower garment node → lowerCatalogId is mandatory.
  // Same for shoes. This mirrors what the studio UI shows based on hasLower/hasShoes.
  // Mapped template looks resolve only from their mapping-specific pose workflows.
  // Custom looks continue resolving through pose_garment_configs, where a configured
  // workflow takes priority over the pose's default.
  const mappingPoseWorkflows = catalogueTemplateMappingId
    ? await (async () => {
        if (!templateLooks || !garmentTypeId) {
          throw new AppError(
            'VALIDATION',
            400,
            'catalogueTemplateMappingId requires looks and garmentTypeId',
          );
        }

        const rows = await app.db
          .select({
            poseId: schema.catalogueTemplateLooks.poseAssetId,
            backgroundId: schema.catalogueTemplateLooks.backgroundId,
            workflowTemplateId: schema.catalogueTemplatePoseWorkflows.workflowTemplateId,
            promptGarmentPhase: schema.catalogueTemplatePoseWorkflows.promptGarmentPhase,
            upperNodeIds: schema.workflowTemplates.upperNodeIds,
            lowerNodeId: schema.workflowTemplates.lowerNodeId,
            shoeNodeId: schema.workflowTemplates.shoeNodeId,
            sizeNodeIds: schema.workflowTemplates.sizeNodeIds,
            version: schema.workflowTemplates.version,
          })
          .from(schema.catalogueTemplateSubcategories)
          .innerJoin(
            schema.catalogueTemplateLooks,
            eq(
              schema.catalogueTemplateLooks.templateId,
              schema.catalogueTemplateSubcategories.templateId,
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
                schema.workflowTemplates.id,
                schema.catalogueTemplatePoseWorkflows.workflowTemplateId,
              ),
              eq(schema.workflowTemplates.isActive, true),
            ),
          )
          .where(
            and(
              eq(schema.catalogueTemplateSubcategories.id, catalogueTemplateMappingId),
              eq(schema.catalogueTemplateSubcategories.subcategoryId, garmentTypeId),
            ),
          );

        const allowedLookKeys = new Set(rows.map((row) => `${row.poseId}::${row.backgroundId}`));
        if (
          rows.length === 0 ||
          looks.some((look) => !allowedLookKeys.has(`${look.poseId}::${look.backgroundId}`))
        ) {
          throw new AppError(
            'BAD_CATALOG',
            400,
            'one or more looks are not configured for this template mapping',
          );
        }

        const byPose = new Map(rows.map((row) => [row.poseId, row]));
        return distinctPoseIds.map((poseId) => {
          const row = byPose.get(poseId);
          if (!row) {
            throw new AppError('BAD_CATALOG', 400, 'workflow not configured for template pose');
          }
          return {
            poseId,
            workflowTemplateId: row.workflowTemplateId,
            version: row.version,
            promptGarmentPhase: row.promptGarmentPhase,
            upperNodeIds: row.upperNodeIds,
            lowerNodeId: row.lowerNodeId,
            shoeNodeId: row.shoeNodeId,
            sizeNodeIds: row.sizeNodeIds,
          };
        });
      })()
    : null;

  const defaultWorkflow = aliasedTable(schema.workflowTemplates, 'default_workflow');
  const overrideWorkflow = aliasedTable(schema.workflowTemplates, 'override_workflow');
  const poseWorkflowRows = await app.db
    .select({
      poseId: schema.modelPoseAssets.id,
      defaultWorkflowTemplateId: schema.modelPoseAssets.workflowTemplateId,
      defaultWorkflowVersion: defaultWorkflow.version,
      defaultUpperNodeIds: defaultWorkflow.upperNodeIds,
      defaultLowerNodeId: defaultWorkflow.lowerNodeId,
      defaultShoeNodeId: defaultWorkflow.shoeNodeId,
      defaultSizeNodeIds: defaultWorkflow.sizeNodeIds,
      configWorkflowTemplateId: schema.poseGarmentConfigs.workflowTemplateId,
      configIsActive: schema.poseGarmentConfigs.isActive,
      overrideWorkflowVersion: overrideWorkflow.version,
      overrideUpperNodeIds: overrideWorkflow.upperNodeIds,
      overrideLowerNodeId: overrideWorkflow.lowerNodeId,
      overrideShoeNodeId: overrideWorkflow.shoeNodeId,
      overrideSizeNodeIds: overrideWorkflow.sizeNodeIds,
    })
    .from(schema.modelPoseAssets)
    .leftJoin(defaultWorkflow, eq(schema.modelPoseAssets.workflowTemplateId, defaultWorkflow.id))
    .leftJoin(
      schema.poseGarmentConfigs,
      and(
        eq(schema.poseGarmentConfigs.poseAssetId, schema.modelPoseAssets.id),
        garmentTypeId
          ? eq(schema.poseGarmentConfigs.subcategoryId, garmentTypeId)
          : isNull(schema.poseGarmentConfigs.subcategoryId),
      ),
    )
    .leftJoin(
      overrideWorkflow,
      eq(schema.poseGarmentConfigs.workflowTemplateId, overrideWorkflow.id),
    )
    .where(inArray(schema.modelPoseAssets.id, distinctPoseIds));

  // A per-garment-type active override can hide a pose for this garment type
  // specifically (see /v1/models/poses) — reject here too so a stale client can't
  // submit a job for a pose+garmentType combo the admin explicitly disabled.
  if (
    !mappingPoseWorkflows &&
    garmentTypeId &&
    poseWorkflowRows.some((r) => r.configIsActive === false)
  ) {
    throw new AppError('BAD_CATALOG', 400, 'one or more poses not found or inactive');
  }

  const poseWorkflows = requiresMannequinStep
    ? distinctPoseIds.map((poseId) => ({
        poseId,
        workflowTemplateId: sareeStep2?.workflowTemplateId ?? null,
        version: sareeStep2?.version ?? null,
        promptGarmentPhase: null,
        upperNodeIds: sareeStep2?.upperNodeIds ?? [],
        lowerNodeId: sareeStep2?.lowerNodeId ?? null,
        shoeNodeId: sareeStep2?.shoeNodeId ?? null,
        sizeNodeIds: sareeStep2?.sizeNodeIds ?? null,
      }))
    : (mappingPoseWorkflows ??
      poseWorkflowRows.map((r) => ({
        poseId: r.poseId,
        workflowTemplateId: r.configWorkflowTemplateId ?? r.defaultWorkflowTemplateId,
        version:
          r.configWorkflowTemplateId != null ? r.overrideWorkflowVersion : r.defaultWorkflowVersion,
        promptGarmentPhase: null,
        upperNodeIds:
          r.configWorkflowTemplateId != null
            ? (r.overrideUpperNodeIds ?? [])
            : (r.defaultUpperNodeIds ?? []),
        lowerNodeId:
          r.configWorkflowTemplateId != null ? r.overrideLowerNodeId : r.defaultLowerNodeId,
        shoeNodeId: r.configWorkflowTemplateId != null ? r.overrideShoeNodeId : r.defaultShoeNodeId,
        sizeNodeIds:
          r.configWorkflowTemplateId != null ? r.overrideSizeNodeIds : r.defaultSizeNodeIds,
      })));

  // Build map for O(1) lookup below.
  const poseWorkflowMap = new Map(poseWorkflows.map((pw) => [pw.poseId, pw]));

  for (const pw of poseWorkflows) {
    if (pw.upperNodeIds.length > 0 && opts.resolvedUpperGarmentKey === undefined) {
      throw new AppError('VALIDATION', 400, 'upper garment required for this pose');
    }
    if (pw.lowerNodeId) {
      if (pw.upperNodeIds.length === 0) {
        // A sole lower hero must be the customer's upload, not a generic catalog image.
        if (!lowerGarmentKey) {
          throw new AppError('VALIDATION', 400, 'lower garment upload required for this pose');
        }
      } else if (!lowerCatalogId && !lowerGarmentKey) {
        throw new AppError('VALIDATION', 400, 'lower garment required for this pose');
      }
    }
    if (pw.shoeNodeId && !shoeCatalogId) {
      throw new AppError('VALIDATION', 400, 'shoe catalog item required for this pose');
    }
  }

  const catalogueId = ('catalogueId' in body ? body.catalogueId : undefined) ?? randomUUID();
  const looks_: TryonPlanLook[] = looks.map((look) => {
    const pw = poseWorkflowMap.get(look.poseId);
    // Only store inputs the workflow actually supports — strips irrelevant fields
    // so the dispatcher never receives/resolves data it won't use.
    const lookUpperGarmentKey =
      pw?.upperNodeIds && pw.upperNodeIds.length > 0 ? (resolvedUpperGarmentKey ?? null) : null;
    const effectiveLowerCatalogId =
      pw?.lowerNodeId && !lowerGarmentKey ? (lowerCatalogId ?? null) : null;
    const effectiveLowerGarmentKey = pw?.lowerNodeId && lowerGarmentKey ? lowerGarmentKey : null;
    const effectiveShoeCatalogId = pw?.shoeNodeId ? (shoeCatalogId ?? null) : null;
    return {
      poseId: look.poseId,
      backgroundId: look.backgroundId,
      upperGarmentKey: lookUpperGarmentKey,
      lowerCatalogId: effectiveLowerCatalogId,
      lowerGarmentKey: effectiveLowerGarmentKey,
      shoeCatalogId: effectiveShoeCatalogId,
      workflowTemplateId: pw?.workflowTemplateId ?? null,
      promptGarmentPhase: pw?.promptGarmentPhase ?? null,
      params: {
        ...(body.params ?? {}),
        dispatchTemplateVersion: pw?.version ?? null,
        ...(pw?.workflowTemplateId ? { workflowTemplateId: pw.workflowTemplateId } : {}),
        // Always the clamped, server-computed dims — whether derived from the
        // aspect-ratio enum or a custom request, this is what the dispatcher
        // patches the workflow with. Never let a raw pre-maxOutputPx value through.
        outputWidth: outputDims.width,
        outputHeight: outputDims.height,
        ...(aspectRatio ? { aspectRatio } : {}),
        resolution,
        ...(platform ? { platform } : {}),
        ...(catalogueTemplateMappingId
          ? {
              catalogueTemplateMappingId,
              ...(pw?.promptGarmentPhase ? { promptGarmentPhase: pw.promptGarmentPhase } : {}),
            }
          : {}),
        // Always last: regenerateJob's alternate-prompt override, when present, wins
        // over both the request's own params and any mapping-derived prompt above —
        // it targets the same workflowTemplateId already resolved for this pose, so
        // this only changes which prompt text is sent, never which graph loads.
        ...(opts.paramsOverride ?? {}),
      },
    };
  });

  return { catalogueId, cost: COST, looks: looks_ };
}

/**
 * Best-effort last-used pose preset update. Never allowed to fail the caller
 * it's invoked from — always wrap in try/catch (this function already does)
 * and never await it in a way that lets its rejection propagate. A
 * delete+insert pair (not onConflictDoUpdate) because the "one row per user"
 * constraint is a partial unique index on isLastUsed=true, and there's no
 * existing precedent in this codebase for targeting a partial index as an
 * ON CONFLICT arbiter — plain delete+insert in one transaction is simpler
 * and just as atomic for this single-row case.
 *
 * Deliberately NOT called from createJob itself — createJob has three
 * callers (the /v1/jobs/tryon route, regenerate.ts's single-pose re-run, and
 * the public dev API's merchant-driven job creation) and only the first is an
 * interactive studio-wizard submission whose pose selection should overwrite
 * the user's "last used" chip. Exported so /v1/jobs/tryon's route handler
 * (the one call site that should trigger it) can call it directly after
 * createJob resolves.
 */
export async function updateLastUsedPosePreset(
  app: FastifyInstance,
  userId: string,
  gender: string | null,
  garmentTypeId: string | null,
  poseIds: string[],
): Promise<void> {
  // Scoped per (user, gender, garmentTypeId) — see userPosePresets' schema
  // comment. A job with no resolvable gender (no poses) or no garmentTypeId
  // (optional on CreateTryOnJobRequest) has no valid scope to track under, so
  // it's a no-op rather than a write to some fabricated global scope.
  if (poseIds.length === 0 || !gender || !garmentTypeId) return;
  const unique = Array.from(new Set(poseIds));
  try {
    await app.db.transaction(async (tx) => {
      await tx
        .delete(schema.userPosePresets)
        .where(
          and(
            eq(schema.userPosePresets.userId, userId),
            eq(schema.userPosePresets.gender, gender),
            eq(schema.userPosePresets.garmentTypeId, garmentTypeId),
            eq(schema.userPosePresets.isLastUsed, true),
          ),
        );
      await tx.insert(schema.userPosePresets).values({
        userId,
        name: null,
        gender,
        garmentTypeId,
        poseIds: unique,
        isLastUsed: true,
      });
    });
  } catch (err) {
    app.log.warn({ err, userId }, 'failed to update last-used pose preset');
  }
}

export async function createJob(
  app: FastifyInstance,
  userId: string,
  body: z.infer<typeof CreateTryOnJobRequest>,
  opts?: {
    trustedGarmentKeys?: Set<string>;
    /** Set by the public developer API so the resulting jobs are readable through
     *  /v1/dev/jobs/:id and /v1/dev/catalogues/:id, which scope by merchant via a
     *  join on api_keys and filter jobs.source against the api_* JobSource values.
     *  Omitting either field there makes every generated job 404 on its own status
     *  endpoint. */
    apiKeyId?: string;
    source?: JobSource;
    /** Set only by regenerateJob — see resolveTryonPlan's matching field. */
    paramsOverride?: Record<string, unknown>;
    /** Set only by regenerateJob when the caller is still within today's free
     *  regenerate allowance: the job is created with creditsCharged=0 and no
     *  credit_ledger row at all — genuinely never charged, not charged-then-
     *  refunded. Keeping creditsCharged at 0 also means every existing refund
     *  path (terminateJob, the sweeper) naturally no-ops for this job, since
     *  they all guard on `creditsCharged > 0`. */
    waiveCost?: boolean;
  },
) {
  const {
    faceId,
    garmentTypeId,
    upperGarmentKey,
    mannequinJobId,
    lowerGarmentKey,
    thirdGarmentKey,
  } = body.inputs;

  // mannequinJobId vs. upperGarmentKey is XOR'd by zod, but WHICH one is valid
  // depends on this garment type's requiresMannequinStep policy. resolveTryonPlan
  // (below) re-derives requiresMannequinStep internally too (along with its
  // saree-step2 workflow node IDs), but it only ever sees opts.resolvedUpperGarmentKey
  // — not the raw mannequinJobId/upperGarmentKey fields — so this specific
  // cross-check has to live here, where both are still in scope.
  let requiresMannequinStep = false;
  if (garmentTypeId) {
    const [gtRow] = await app.db
      .select({ requiresMannequinStep: schema.garmentSubcategories.requiresMannequinStep })
      .from(schema.garmentSubcategories)
      .where(eq(schema.garmentSubcategories.id, garmentTypeId));
    requiresMannequinStep = gtRow?.requiresMannequinStep ?? false;
  }
  if (requiresMannequinStep && !mannequinJobId) {
    throw new AppError('VALIDATION', 400, 'mannequinJobId required for this garment type');
  }
  if (!requiresMannequinStep && mannequinJobId) {
    throw new AppError('VALIDATION', 400, 'mannequinJobId not valid for this garment type');
  }

  // The garment image actually used for this job's upper — either a fresh
  // presigned upload (verified via verifyGarmentKey, trusted-key aware for
  // regeneration) or a completed saree-mannequin job's output (resolveMannequinGarmentKey
  // does its own ownership check against jobs.userId, no Redis-binding TTL involved,
  // so it doesn't need verifyGarmentKey's trusted-key bypass).
  let resolvedUpperGarmentKey: string | undefined;
  if (mannequinJobId) {
    resolvedUpperGarmentKey = await resolveMannequinGarmentKey(app, userId, mannequinJobId);
  } else if (upperGarmentKey) {
    await verifyGarmentKey(app, userId, upperGarmentKey, opts?.trustedGarmentKeys);
    resolvedUpperGarmentKey = upperGarmentKey;
  }
  if (lowerGarmentKey)
    await verifyGarmentKey(app, userId, lowerGarmentKey, opts?.trustedGarmentKeys);
  if (thirdGarmentKey)
    await verifyGarmentKey(app, userId, thirdGarmentKey, opts?.trustedGarmentKeys);

  const plan = await resolveTryonPlan(app, userId, body, {
    resolvedUpperGarmentKey: resolvedUpperGarmentKey ?? null,
    trustedGarmentKeys: opts?.trustedGarmentKeys,
    paramsOverride: opts?.paramsOverride,
  });

  await assertQueueCapacity(app, plan.looks.length);

  const [[user], routing] = await Promise.all([
    app.db.select().from(schema.users).where(eq(schema.users.id, userId)),
    resolveQueueRouting(app, userId),
  ]);
  if (!user || user.isBanned) throw new AppError('FORBIDDEN', 403, 'banned');

  // Snapshot watermark entitlement from the plan at job creation time.
  // Never re-derived after this point — see spec precedence rule.
  const { queueStream, priority, watermark } = routing;

  const cost = opts?.waiveCost ? 0 : plan.cost;
  const jobIds = await app.db.transaction(async (tx) => {
    const created: string[] = [];
    for (const look of plan.looks) {
      const [job] = await tx
        .insert(schema.jobs)
        .values({
          userId,
          apiKeyId: opts?.apiKeyId,
          catalogueId: plan.catalogueId,
          status: 'QUEUED',
          priority,
          queueStream,
          watermark,
          creditsCharged: cost,
          source: opts?.source ?? JOB_SOURCE.CATALOG,
        })
        .returning();
      if (cost > 0) await atomicDeduct(tx as unknown as DB, userId, cost, job.id);
      await tx.insert(schema.jobInputs).values({
        jobId: job.id,
        upperGarmentKey: look.upperGarmentKey,
        faceId,
        backgroundId: look.backgroundId,
        poseId: look.poseId,
        garmentTypeId: garmentTypeId ?? null,
        lowerCatalogId: look.lowerCatalogId,
        lowerGarmentKey: look.lowerGarmentKey,
        thirdGarmentKey: thirdGarmentKey ?? null,
        shoeCatalogId: look.shoeCatalogId,
        userHint: promptGuard(body.userHint),
        params: look.params,
      });
      created.push(job.id);
    }
    return created;
  });

  const stream = `jobs:${queueStream}`;
  const failedEnqueues: string[] = [];
  for (const jobId of jobIds) {
    try {
      await app.redis.xadd(stream, 'MAXLEN', '~', 10000, '*', 'jobId', jobId, 'userId', userId);
      jobsCreatedTotal.inc({ priority: queueStream, kind: JOB_SOURCE.CATALOG });
    } catch (err) {
      app.log.error({ err, jobId }, 'redis xadd failed — job will be refunded');
      failedEnqueues.push(jobId);
    }
  }

  if (failedEnqueues.length > 0) {
    // refundAndMarkFailed does the refund + FAILED transition as one atomic,
    // idempotent operation (guarded on status='QUEUED') — closes the crash-
    // between-two-calls gap a separate refund() + UPDATE would leave open.
    await Promise.all(
      failedEnqueues.map((jobId) =>
        refundAndMarkFailed(
          app.db,
          userId,
          plan.cost,
          jobId,
          'REFUND_ENQUEUE_FAIL',
          'ENQUEUE_FAIL',
        ),
      ),
    );
    if (failedEnqueues.length === jobIds.length) {
      throw new AppError('ENQUEUE_FAIL', 503, 'queue unavailable');
    }
  }

  // gender isn't part of CreateTryOnJobRequest — derived from the resolved
  // pose(s) themselves (the reliable source), not trusted from client input.
  // Assumes a job's poses are all one gender — the studio picker only ever
  // queries one gender at a time, but nothing here enforces that server-side,
  // so a hand-rolled request with mixed-gender looks would silently take the
  // first look's gender. Harmless: only last-used tracking reads this, and
  // activePoseIds (pose-presets/routes.ts) filters mismatched poses out at
  // GET time regardless. A separate, single lookup rather than threading
  // gender through resolveTryonPlan/TryonPlanLook, which stays untouched.
  // Skipped when garmentTypeId is absent (optional on CreateTryOnJobRequest)
  // since updateLastUsedPosePreset no-ops without it anyway — no point
  // paying the round trip for regenerate.ts/dev API callers that never use it.
  const firstPoseId = garmentTypeId ? plan.looks[0]?.poseId : undefined;
  const [firstPoseRow] = firstPoseId
    ? await app.db
        .select({ genderSlug: schema.modelPoseAssets.genderSlug })
        .from(schema.modelPoseAssets)
        .where(eq(schema.modelPoseAssets.id, firstPoseId))
    : [];

  return {
    catalogueId: plan.catalogueId,
    jobIds,
    // Exposed so /v1/jobs/tryon's route handler — the only caller that should
    // track "last used" pose presets — can call updateLastUsedPosePreset with
    // exactly the poseIds resolveTryonPlan actually resolved, without
    // re-deriving them from the request body (which isn't a 1:1 match with
    // what actually got used; see resolveTryonPlan's Amazon-background-override
    // and template-looks handling above).
    poseIds: plan.looks.map((l) => l.poseId),
    gender: firstPoseRow?.genderSlug ?? null,
    garmentTypeId: garmentTypeId ?? null,
  };
}

export async function createSimpleTryonJob(
  app: FastifyInstance,
  userId: string,
  body: z.infer<typeof CreateSimpleTryonRequest>,
  opts?: {
    /** Set only by regenerateJob within today's free allowance — see createJob's
     *  matching option for why this is a genuine zero, not charge-then-refund. */
    waiveCost?: boolean;
  },
) {
  const { personKey, sourceJobId } = body;
  const COST = opts?.waiveCost ? 0 : await getTryonCreditCost(app);

  await assertOwnsUploadKey(app, userId, personKey);

  // Resolve the source image's workflow template. For Studio jobs this goes
  // through the garment type → tryon category chain; for saree catalogue jobs
  // it reads from saree_settings.workflowTemplateId.
  const [source] = await app.db
    .select({
      jobUserId: schema.jobs.userId,
      jobStatus: schema.jobs.status,
      garmentTypeId: schema.jobInputs.garmentTypeId,
      kind: sql<string>`${schema.jobInputs.params}->>'kind'`.as('kind'),
      workflowTemplateId: schema.tryonCategories.workflowTemplateId,
      workflowTemplateVersion: schema.workflowTemplates.version,
      tryonCategoryIsActive: schema.tryonCategories.isActive,
      workflowTemplateIsActive: schema.workflowTemplates.isActive,
      // Tryon-direct results (source='tryon'/'api_tryon') are WebP-encoded, not
      // PNG (see apps/dispatcher/src/workflow/finalize.ts) — the actual uploaded
      // key must come from here, not be reconstructed via keys.output(sourceJobId).
      resultKey: schema.jobOutputs.resultKey,
    })
    .from(schema.jobs)
    .innerJoin(schema.jobInputs, eq(schema.jobInputs.jobId, schema.jobs.id))
    .leftJoin(schema.jobOutputs, eq(schema.jobOutputs.jobId, schema.jobs.id))
    .leftJoin(
      schema.garmentSubcategories,
      eq(schema.garmentSubcategories.id, schema.jobInputs.garmentTypeId),
    )
    .leftJoin(
      schema.tryonCategories,
      eq(schema.tryonCategories.id, schema.garmentSubcategories.tryonCategoryId),
    )
    .leftJoin(
      schema.workflowTemplates,
      eq(schema.workflowTemplates.id, schema.tryonCategories.workflowTemplateId),
    )
    .where(eq(schema.jobs.id, sourceJobId));

  if (!source) throw new AppError('NOT_FOUND', 404, 'source image not found');
  if (source.jobUserId !== userId) {
    throw new AppError('FORBIDDEN', 403, 'source image not owned by caller');
  }
  if (source.jobStatus !== 'COMPLETED') {
    throw new AppError('VALIDATION', 400, 'source image is not a completed job');
  }

  let workflowTemplateId: string;
  let workflowTemplateVersion: number | null = source.workflowTemplateVersion ?? null;

  if (source.kind === 'saree') {
    const sareeSettings = await getSareeSettings(app.db);
    if (!sareeSettings?.workflowTemplateId) {
      throw new AppError('VALIDATION', 400, 'saree tryon workflow not configured by admin');
    }
    const [wf] = await app.db
      .select({
        isActive: schema.workflowTemplates.isActive,
        version: schema.workflowTemplates.version,
      })
      .from(schema.workflowTemplates)
      .where(
        and(
          eq(schema.workflowTemplates.id, sareeSettings.workflowTemplateId),
          eq(schema.workflowTemplates.isActive, true),
        ),
      );
    if (!wf) {
      throw new AppError('VALIDATION', 400, 'saree tryon workflow is not active');
    }
    workflowTemplateId = sareeSettings.workflowTemplateId;
    workflowTemplateVersion = wf.version;
  } else {
    // Kill-switch parity: a tryon category (or its workflow template) that an admin
    // deactivated after garment types were mapped to it must not resolve.
    if (
      !source.workflowTemplateId ||
      !source.tryonCategoryIsActive ||
      !source.workflowTemplateIsActive
    ) {
      throw new AppError('VALIDATION', 400, 'garment type has no tryon category configured');
    }
    workflowTemplateId = source.workflowTemplateId;
  }

  // Legacy rows (predating job_outputs.resultKey being populated for every
  // job) fall back to the PNG convention — safe because webp is new.
  const garmentKey = source.resultKey ?? keys.output(sourceJobId);

  const [[user], routing] = await Promise.all([
    app.db.select().from(schema.users).where(eq(schema.users.id, userId)),
    resolveQueueRouting(app, userId),
  ]);
  if (!user || user.isBanned) throw new AppError('FORBIDDEN', 403, 'banned');

  const { queueStream, priority, watermark } = routing;

  const catalogueId = randomUUID();
  const [job] = await app.db.transaction(async (tx) => {
    const [newJob] = await tx
      .insert(schema.jobs)
      .values({
        userId,
        catalogueId,
        status: 'QUEUED',
        priority,
        queueStream,
        watermark,
        creditsCharged: COST,
        source: JOB_SOURCE.TRYON,
      })
      .returning();
    if (COST > 0) await atomicDeduct(tx as unknown as DB, userId, COST, newJob.id);
    await tx.insert(schema.jobInputs).values({
      jobId: newJob.id,
      upperGarmentKey: garmentKey,
      garmentTypeId: source.garmentTypeId,
      // sourceJobId is stored (not just resolved into garmentKey) so a later
      // regenerate can re-derive the garment from the CURRENT output of the
      // source job, exactly as a fresh request would, instead of needing a
      // separate code path.
      params: {
        personKey,
        workflowTemplateId,
        sourceJobId,
        dispatchTemplateVersion: workflowTemplateVersion,
      },
    });
    return [newJob];
  });

  const stream = `jobs:${queueStream}`;
  try {
    await app.redis.xadd(stream, 'MAXLEN', '~', 10000, '*', 'jobId', job.id, 'userId', userId);
    jobsCreatedTotal.inc({ priority: queueStream, kind: JOB_SOURCE.TRYON });
  } catch (err) {
    app.log.error({ err, jobId: job.id }, 'redis xadd failed — simple tryon job will be refunded');
    // refundAndMarkFailed does the refund + FAILED transition as one atomic,
    // idempotent operation (guarded on status='QUEUED') — closes the crash-
    // between-two-calls gap a separate refund() + UPDATE would leave open.
    await refundAndMarkFailed(app.db, userId, COST, job.id, 'REFUND_ENQUEUE_FAIL', 'ENQUEUE_FAIL');
    throw new AppError('ENQUEUE_FAIL', 503, 'queue unavailable');
  }

  return { jobId: job.id, catalogueId };
}

/**
 * Catalog-video jobs are generated by PixVerse over HTTP — no ComfyUI, no GPU worker.
 * They ride a dedicated stream so they aren't gated by the dispatcher's GPU-capacity
 * semaphore, which blocks stream reads entirely when no worker is registered. The
 * matching `queueStream: 'video'` column value also makes admin retry
 * (admin/jobs.routes.ts derives the stream from it) land back in this lane.
 */
const VIDEO_QUEUE_STREAM = 'jobs:video';

export async function createCatalogVideoJob(
  app: FastifyInstance,
  userId: string,
  body: z.infer<typeof CreateCatalogVideoJobRequest>,
) {
  const cost = await getPixverseCreditCost(app);

  // Exactly one of sourceJobId or sourceImageKey is present — enforced by
  // CreateCatalogVideoJobRequest's XOR refine. sourceImageKey lets the caller
  // animate any image they own, not required to be an AI Vastra generation;
  // sourceJobId reuses a completed AI Vastra job's own result.
  let resolvedSourceImageKey: string;
  if (body.sourceImageKey) {
    await assertOwnsUploadKey(app, userId, body.sourceImageKey);
    resolvedSourceImageKey = body.sourceImageKey;
  } else if (body.sourceJobId) {
    const sourceJobId = body.sourceJobId;
    const [source] = await app.db
      .select({
        userId: schema.jobs.userId,
        status: schema.jobs.status,
        // Tryon-direct results (source='tryon'/'api_tryon') are WebP-encoded, not
        // PNG (see apps/dispatcher/src/workflow/finalize.ts) — the actual uploaded
        // key must come from here, not be reconstructed via keys.output(sourceJobId).
        resultKey: schema.jobOutputs.resultKey,
      })
      .from(schema.jobs)
      .leftJoin(schema.jobOutputs, eq(schema.jobOutputs.jobId, schema.jobs.id))
      .where(eq(schema.jobs.id, sourceJobId));
    if (!source) throw new AppError('NOT_FOUND', 404, 'source image not found');
    if (source.userId !== userId)
      throw new AppError('FORBIDDEN', 403, 'source image not owned by caller');
    if (source.status !== 'COMPLETED')
      throw new AppError('VALIDATION', 400, 'source image is not a completed job');
    resolvedSourceImageKey = source.resultKey ?? keys.output(sourceJobId);
  } else {
    // Unreachable: CreateCatalogVideoJobRequest's XOR refine guarantees exactly
    // one of sourceJobId/sourceImageKey is present.
    throw new AppError('VALIDATION', 400, 'sourceJobId or sourceImageKey is required');
  }

  const [sample] = await app.db
    .select()
    .from(schema.sampleVideos)
    .where(eq(schema.sampleVideos.id, body.sampleVideoId));
  if (!sample || sample.deletedAt) throw new AppError('NOT_FOUND', 404, 'sample video not found');
  if (!sample.isActive) throw new AppError('VALIDATION', 400, 'sample video is not active');
  const [user] = await app.db.select().from(schema.users).where(eq(schema.users.id, userId));
  if (!user || user.isBanned) throw new AppError('FORBIDDEN', 403, 'banned');
  if (!isCatalogVideoAllowed(app.env, user.email)) {
    throw new AppError('FORBIDDEN', 403, 'catalog video is not enabled for this account');
  }
  const [job] = await app.db.transaction(async (tx) => {
    const [newJob] = await tx
      .insert(schema.jobs)
      .values({
        userId,
        status: 'QUEUED',
        // Video jobs don't compete for GPU capacity, so the credit plan's queue tier
        // doesn't apply — they get their own lane instead (see VIDEO_QUEUE_STREAM).
        priority: false,
        queueStream: 'video',
        watermark: false,
        creditsCharged: cost,
        source: JOB_SOURCE.CATALOG_VIDEO,
      })
      .returning();
    await atomicDeduct(tx as unknown as DB, userId, cost, newJob.id);
    await tx.insert(schema.jobInputs).values({
      jobId: newJob.id,
      params: {
        kind: 'video',
        ...(body.sourceJobId ? { sourceJobId: body.sourceJobId } : {}),
        sourceImageKey: resolvedSourceImageKey,
        sampleVideoId: body.sampleVideoId,
        prompt: sample.prompt,
      },
    });
    return [newJob];
  });
  try {
    await app.redis.xadd(
      VIDEO_QUEUE_STREAM,
      'MAXLEN',
      '~',
      10000,
      '*',
      'jobId',
      job.id,
      'userId',
      userId,
    );
    jobsCreatedTotal.inc({ priority: 'video', kind: JOB_SOURCE.CATALOG_VIDEO });
  } catch (err) {
    app.log.error({ err, jobId: job.id }, 'redis xadd failed');
    // refundAndMarkFailed does the refund + FAILED transition as one atomic,
    // idempotent operation (guarded on status='QUEUED') — closes the crash-
    // between-two-calls gap a separate refund() + UPDATE would leave open.
    await refundAndMarkFailed(app.db, userId, cost, job.id, 'REFUND_ENQUEUE_FAIL', 'ENQUEUE_FAIL');
    throw new AppError('ENQUEUE_FAIL', 503, 'queue unavailable');
  }
  return { jobId: job.id };
}
