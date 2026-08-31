import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { ASPECT_DIMENSIONS, JOB_SOURCE, type Resolution, resolutionFromDims } from '@tryme/types';
import { aliasedTable, and, eq, ilike } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { AppError } from '../../lib/errors.js';
import {
  getMaxOutputPx,
  getResolutionCreditCost,
  getTryonCreditCost,
} from '../../lib/resolution-config.js';
import { atomicDeduct } from '../credits/ledger.js';
import { assertMerchantUploadKey } from './upload-guard.js';

const CONFIG_KEY = 'config:system';

interface MerchantCatalogDefaults {
  merchantCatalogDefaults?: Partial<
    Record<
      'men' | 'women' | 'boys' | 'girls',
      { faceId: string; backgroundId: string; lowerCatalogId?: string; shoeCatalogId?: string }
    >
  >;
  merchantCatalogAspectRatio?: string;
}

/**
 * Builds an ordinary `jobs.userId`-owned studio job from admin-fixed inputs —
 * NOT a merchantId-owned job, NOT a new pipeline. This is the constrained
 * "Path B" generate: the merchant supplies only a flat garment image; face,
 * background, and pose are all server-resolved so every output is guaranteed
 * try-on-suitable. Deliberately NOT a refactor of jobs/create.ts::createJob
 * (that function is long, security-load-bearing — see its S1/S6/H2 comments —
 * and handles multi-pose/lower/shoe/Amazon cases this flow never needs).
 */
export async function createMerchantCatalogJob(
  app: FastifyInstance,
  params: {
    userId: string;
    garmentSubcategoryId: string;
    category: string;
    flatImageKey: string;
    subcategoryId: string;
    merchantId: string;
    // Bulk-flat batches are parked at status HELD and never enqueued here; an
    // admin releases every merchant's held jobs at once during free-GPU hours
    // (POST /admin/held-jobs/release). Credits are still deducted now, in the
    // same transaction, so a released batch can never fail for lack of balance.
    hold?: boolean;
    // Pallu image for the "Body & Pallu" two-input mannequin step. Only meaningful when
    // the garment type requires the mannequin step AND has a two-input workflow
    // configured — validated below. When present, the mannequin drape runs as its own
    // job (see saree-step2-promoter.ts) instead of the inline single-image path every
    // other merchant catalog job uses — see docs/superpowers/plans/
    // 2026-08-20-merchant-catalog-saree-two-input.md.
    secondFlatImageKey?: string;
  },
): Promise<{ jobId: string }> {
  const mannequinTwoInputWf = aliasedTable(schema.workflowTemplates, 'mannequin_two_input_wf');
  const [garmentType] = await app.db
    .select({
      defaultPoseId: schema.garmentSubcategories.defaultPoseId,
      requiresMannequinStep: schema.garmentSubcategories.requiresMannequinStep,
      mannequinTwoInputWorkflowTemplateId:
        schema.garmentSubcategories.mannequinTwoInputWorkflowTemplateId,
      mannequinTwoInputWorkflowVersion: mannequinTwoInputWf.version,
    })
    .from(schema.garmentSubcategories)
    .leftJoin(
      mannequinTwoInputWf,
      eq(schema.garmentSubcategories.mannequinTwoInputWorkflowTemplateId, mannequinTwoInputWf.id),
    )
    .where(
      and(
        eq(schema.garmentSubcategories.id, params.garmentSubcategoryId),
        eq(schema.garmentSubcategories.isActive, true),
      ),
    )
    .limit(1);
  if (!garmentType) throw new AppError('BAD_CATALOG', 400, 'garment type not found or inactive');
  if (params.secondFlatImageKey) {
    if (!garmentType.requiresMannequinStep) {
      throw new AppError('VALIDATION', 400, 'this garment type does not use the mannequin step');
    }
    if (!garmentType.mannequinTwoInputWorkflowTemplateId) {
      throw new AppError(
        'CONFIG',
        400,
        'garment type missing two-input step-1 workflow configuration',
      );
    }
  }
  if (!garmentType.defaultPoseId) {
    throw new AppError(
      'VALIDATION',
      400,
      'admin has not configured a default pose for this garment type',
    );
  }

  const raw = await app.redis.get(CONFIG_KEY);
  const cfg = (raw ? JSON.parse(raw) : {}) as MerchantCatalogDefaults;
  const categoryDefaults =
    cfg.merchantCatalogDefaults?.[params.category as 'men' | 'women' | 'boys' | 'girls'];
  if (!categoryDefaults?.faceId || !categoryDefaults?.backgroundId) {
    throw new AppError(
      'VALIDATION',
      400,
      `admin has not configured default face/background for category "${params.category}"`,
    );
  }
  const aspectRatio = cfg.merchantCatalogAspectRatio ?? '2:3';

  // Determine whether the fixed pose's workflow (honoring any per-garment-type
  // override in pose_garment_configs) actually needs a lower garment / shoe --
  // mirrors the pose-workflow resolution in jobs/create.ts so both paths agree
  // on what a given pose+garment-type combo requires.
  const defaultWorkflow = aliasedTable(schema.workflowTemplates, 'default_workflow');
  const overrideWorkflow = aliasedTable(schema.workflowTemplates, 'override_workflow');
  const [poseWorkflow] = await app.db
    .select({
      defaultLowerNodeId: defaultWorkflow.lowerNodeId,
      defaultShoeNodeId: defaultWorkflow.shoeNodeId,
      defaultWorkflowVersion: defaultWorkflow.version,
      configWorkflowTemplateId: schema.poseGarmentConfigs.workflowTemplateId,
      overrideWorkflowVersion: overrideWorkflow.version,
      overrideLowerNodeId: overrideWorkflow.lowerNodeId,
      overrideShoeNodeId: overrideWorkflow.shoeNodeId,
    })
    .from(schema.modelPoseAssets)
    .leftJoin(defaultWorkflow, eq(schema.modelPoseAssets.workflowTemplateId, defaultWorkflow.id))
    .leftJoin(
      schema.poseGarmentConfigs,
      and(
        eq(schema.poseGarmentConfigs.poseAssetId, schema.modelPoseAssets.id),
        eq(schema.poseGarmentConfigs.subcategoryId, params.garmentSubcategoryId),
      ),
    )
    .leftJoin(
      overrideWorkflow,
      eq(schema.poseGarmentConfigs.workflowTemplateId, overrideWorkflow.id),
    )
    .where(eq(schema.modelPoseAssets.id, garmentType.defaultPoseId))
    .limit(1);
  const needsLower =
    (poseWorkflow?.configWorkflowTemplateId != null
      ? poseWorkflow.overrideLowerNodeId
      : poseWorkflow?.defaultLowerNodeId) != null;
  const needsShoes =
    (poseWorkflow?.configWorkflowTemplateId != null
      ? poseWorkflow.overrideShoeNodeId
      : poseWorkflow?.defaultShoeNodeId) != null;

  if (needsLower && !categoryDefaults.lowerCatalogId) {
    throw new AppError(
      'VALIDATION',
      400,
      `admin has not configured a default lower garment for category "${params.category}"`,
    );
  }
  if (needsShoes && !categoryDefaults.shoeCatalogId) {
    throw new AppError(
      'VALIDATION',
      400,
      `admin has not configured a default shoe for category "${params.category}"`,
    );
  }

  const [face] = await app.db
    .select({ id: schema.modelFaces.id })
    .from(schema.modelFaces)
    .where(
      and(eq(schema.modelFaces.id, categoryDefaults.faceId), eq(schema.modelFaces.isActive, true)),
    );
  const [background] = await app.db
    .select({ id: schema.modelBackgrounds.id })
    .from(schema.modelBackgrounds)
    .where(
      and(
        eq(schema.modelBackgrounds.id, categoryDefaults.backgroundId),
        eq(schema.modelBackgrounds.isActive, true),
      ),
    );
  const [pose] = await app.db
    .select({ id: schema.modelPoseAssets.id })
    .from(schema.modelPoseAssets)
    .where(
      and(
        eq(schema.modelPoseAssets.id, garmentType.defaultPoseId),
        eq(schema.modelPoseAssets.isActive, true),
      ),
    );
  const [lowerItem] = needsLower
    ? await app.db
        .select({ id: schema.catalogItems.id })
        .from(schema.catalogItems)
        .where(
          and(
            // biome-ignore lint/style/noNonNullAssertion: guaranteed by the needsLower/lowerCatalogId check above (line 159)
            eq(schema.catalogItems.id, categoryDefaults.lowerCatalogId!),
            eq(schema.catalogItems.isActive, true),
          ),
        )
    : [];
  const [shoeItem] = needsShoes
    ? await app.db
        .select({ id: schema.catalogItems.id })
        .from(schema.catalogItems)
        .where(
          and(
            // biome-ignore lint/style/noNonNullAssertion: guaranteed by the needsShoes/shoeCatalogId check above (line 166)
            eq(schema.catalogItems.id, categoryDefaults.shoeCatalogId!),
            eq(schema.catalogItems.isActive, true),
          ),
        )
    : [];
  if (!face)
    throw new AppError('BAD_CATALOG', 400, 'configured default face not found or inactive');
  if (!background)
    throw new AppError('BAD_CATALOG', 400, 'configured default background not found or inactive');
  if (!pose)
    throw new AppError('BAD_CATALOG', 400, 'configured default pose not found or inactive');
  if (needsLower && !lowerItem)
    throw new AppError(
      'BAD_CATALOG',
      400,
      'configured default lower garment not found or inactive',
    );
  if (needsShoes && !shoeItem)
    throw new AppError('BAD_CATALOG', 400, 'configured default shoe not found or inactive');

  await assertMerchantUploadKey(app, params.merchantId, params.flatImageKey, 'flat garment');
  if (params.secondFlatImageKey) {
    await assertMerchantUploadKey(app, params.merchantId, params.secondFlatImageKey, 'pallu');
  }

  const requestedDims = ASPECT_DIMENSIONS[aspectRatio] ?? ASPECT_DIMENSIONS['2:3'];
  const maxOutputPx = await getMaxOutputPx(app);
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
  const cost = await getResolutionCreditCost(app, resolution);

  const jobId = randomUUID();

  const effectiveWorkflowVersion =
    poseWorkflow?.configWorkflowTemplateId != null
      ? poseWorkflow.overrideWorkflowVersion
      : poseWorkflow?.defaultWorkflowVersion;

  if (params.secondFlatImageKey) {
    // Two-input path: create a standalone mannequin job now (0 credits, matches
    // Studio's createSareeMannequinJob convention — the real charge is on the step-2
    // job below), and the step-2 job as PENDING_MANNEQUIN pointing at it. Only the
    // mannequin job is enqueued here; apps/dispatcher/src/job/saree-step2-promoter.ts
    // (already running, unmodified) promotes the step-2 job to QUEUED once the
    // mannequin job completes, exactly as it already does for Studio's own two-input
    // flow. No dispatcher changes needed — verified promoteSareeStep2Jobs does not
    // branch on jobs.source anywhere.
    const mannequinJobId = randomUUID();
    await app.db.transaction(async (tx) => {
      await tx.insert(schema.jobs).values({
        id: mannequinJobId,
        userId: params.userId,
        status: 'QUEUED',
        watermark: false,
        queueStream: 'normal',
        creditsCharged: 0,
        source: JOB_SOURCE.SAREE_MANNEQUIN,
      });
      await tx.insert(schema.jobInputs).values({
        jobId: mannequinJobId,
        upperGarmentKey: params.flatImageKey,
        thirdGarmentKey: params.secondFlatImageKey,
        // Reuses the same category-configured face the step-2 composite below will
        // use — consistent model across drape and final composite. Harmless if the
        // two-input template has no person node: processSareeMannequinJob only reads
        // faceId when the template's tryonPersonNodeId is set.
        faceId: face.id,
        garmentTypeId: params.garmentSubcategoryId,
        params: {
          kind: 'saree_mannequin',
          workflowTemplateId: garmentType.mannequinTwoInputWorkflowTemplateId,
          dispatchTemplateVersion: garmentType.mannequinTwoInputWorkflowVersion ?? null,
        },
      });

      await tx.insert(schema.jobs).values({
        id: jobId,
        userId: params.userId,
        status: params.hold ? 'HELD' : 'PENDING_MANNEQUIN',
        watermark: false,
        queueStream: params.hold ? 'low' : 'normal',
        creditsCharged: cost,
        source: JOB_SOURCE.MERCHANT_CATALOG,
      });
      await atomicDeduct(tx as unknown as typeof app.db, params.userId, cost, jobId);
      await tx.insert(schema.jobInputs).values({
        jobId,
        upperGarmentKey: null,
        faceId: face.id,
        backgroundId: background.id,
        poseId: pose.id,
        garmentTypeId: params.garmentSubcategoryId,
        lowerCatalogId: lowerItem?.id ?? null,
        shoeCatalogId: shoeItem?.id ?? null,
        params: {
          kind: 'merchant_catalog',
          subcategoryId: params.subcategoryId,
          outputWidth: outputDims.width,
          outputHeight: outputDims.height,
          aspectRatio,
          resolution,
          mannequinJobId,
          dispatchTemplateVersion: effectiveWorkflowVersion ?? null,
          ...(params.hold ? { heldBatch: true } : {}),
        },
      });
    });

    await app.redis.xadd(
      'jobs:normal',
      'MAXLEN',
      '~',
      10000,
      '*',
      'jobId',
      mannequinJobId,
      'userId',
      params.userId,
    );

    return { jobId };
  }

  // Single-input path — unchanged from before this task.
  await app.db.transaction(async (tx) => {
    await tx.insert(schema.jobs).values({
      id: jobId,
      userId: params.userId,
      status: params.hold ? 'HELD' : 'QUEUED',
      // Merchant-generated catalogue images are never watermarked, regardless of
      // the user's plan tier — merchants are paying customers of a distinct product.
      watermark: false,
      // A released batch is bulk backfill, not someone waiting on a screen — it
      // must never sit in front of live customer traffic.
      queueStream: params.hold ? 'low' : 'normal',
      creditsCharged: cost,
      source: JOB_SOURCE.MERCHANT_CATALOG,
    });
    await atomicDeduct(tx as unknown as typeof app.db, params.userId, cost, jobId);
    await tx.insert(schema.jobInputs).values({
      jobId,
      upperGarmentKey: params.flatImageKey,
      faceId: face.id,
      backgroundId: background.id,
      poseId: pose.id,
      garmentTypeId: params.garmentSubcategoryId,
      lowerCatalogId: lowerItem?.id ?? null,
      shoeCatalogId: shoeItem?.id ?? null,
      params: {
        kind: 'merchant_catalog',
        subcategoryId: params.subcategoryId,
        outputWidth: outputDims.width,
        outputHeight: outputDims.height,
        aspectRatio,
        resolution,
        // The merchant's flatImageKey is always a raw, never-processed photo -
        // tells the dispatcher to run the mannequin compositing step inline
        // before the real generation. See apps/dispatcher/src/job/processor.ts's
        // requiresMannequinStep branch.
        needsMannequinStep: garmentType.requiresMannequinStep,
        dispatchTemplateVersion: effectiveWorkflowVersion ?? null,
        // Marks the job for POST /v1/merchant/catalog/reconcile-held, which turns
        // it into a product row once it completes — the merchant is long gone by
        // then and cannot call /import themselves.
        ...(params.hold ? { heldBatch: true } : {}),
      },
    });
  });

  // Held jobs enter the stream only when an admin releases them.
  if (!params.hold) {
    await app.redis.xadd(
      'jobs:normal',
      'MAXLEN',
      '~',
      10000,
      '*',
      'jobId',
      jobId,
      'userId',
      params.userId,
    );
  }

  return { jobId };
}

/**
 * Mobile-only variant of createMerchantCatalogJob: finalizes the job with the
 * mannequin-drape (step 1) output directly, skipping step 2's pose/background/
 * face compositing entirely — so none of that admin config is required here.
 * Dispatches to the same `saree_mannequin` job kind the dev-API and Studio's
 * pre-resolution flow already use (see processSareeMannequinJob in
 * apps/dispatcher/src/job/processor.ts) — no dispatcher changes needed.
 *
 * faceId is always null: the mannequin workflow used for this garment type
 * bakes the face in via a fixed URL node, not a caller-supplied image.
 */
export async function createMerchantSareeMannequinJob(
  app: FastifyInstance,
  params: {
    userId: string;
    garmentSubcategoryId: string;
    flatImageKey: string;
    merchantId: string;
    sareeStyleId?: string;
    secondFlatImageKey?: string;
  },
): Promise<{ jobId: string }> {
  // No join/version lookup for the plain mannequinWorkflowTemplateId here —
  // that id is deliberately never snapshotted into the job (see the params
  // comment below), so there is nothing to pair a version with.
  const mannequinTwoInputWf = aliasedTable(schema.workflowTemplates, 'mannequin_two_input_wf');
  const [garmentType] = await app.db
    .select({
      requiresMannequinStep: schema.garmentSubcategories.requiresMannequinStep,
      mannequinWorkflowTemplateId: schema.garmentSubcategories.mannequinWorkflowTemplateId,
      mannequinTwoInputWorkflowTemplateId:
        schema.garmentSubcategories.mannequinTwoInputWorkflowTemplateId,
      mannequinTwoInputWorkflowVersion: mannequinTwoInputWf.version,
      isActive: schema.garmentSubcategories.isActive,
    })
    .from(schema.garmentSubcategories)
    .leftJoin(
      mannequinTwoInputWf,
      eq(schema.garmentSubcategories.mannequinTwoInputWorkflowTemplateId, mannequinTwoInputWf.id),
    )
    .where(eq(schema.garmentSubcategories.id, params.garmentSubcategoryId))
    .limit(1);
  if (!garmentType?.isActive) {
    throw new AppError('BAD_CATALOG', 400, 'garment type not found or inactive');
  }
  if (!garmentType.requiresMannequinStep) {
    throw new AppError('VALIDATION', 400, 'this garment type does not use the mannequin step');
  }
  if (!params.secondFlatImageKey && !garmentType.mannequinWorkflowTemplateId) {
    throw new AppError('VALIDATION', 400, 'this garment type does not use the mannequin step');
  }

  let styleWorkflowTemplateId: string | undefined;
  let styleWorkflowVersion: number | null = null;
  if (params.sareeStyleId) {
    // Matched by label (case-insensitive), not id — see MerchantCatalogGenerateBody.
    const styleWf = aliasedTable(schema.workflowTemplates, 'style_wf');
    const styleTwoInputWf = aliasedTable(schema.workflowTemplates, 'style_two_input_wf');
    const [style] = await app.db
      .select({
        isActive: schema.sareeMannequinStyles.isActive,
        mannequinWorkflowTemplateId: schema.sareeMannequinStyles.mannequinWorkflowTemplateId,
        mannequinWorkflowVersion: styleWf.version,
        mannequinTwoInputWorkflowTemplateId:
          schema.sareeMannequinStyles.mannequinTwoInputWorkflowTemplateId,
        mannequinTwoInputWorkflowVersion: styleTwoInputWf.version,
      })
      .from(schema.sareeMannequinStyles)
      .leftJoin(styleWf, eq(schema.sareeMannequinStyles.mannequinWorkflowTemplateId, styleWf.id))
      .leftJoin(
        styleTwoInputWf,
        eq(schema.sareeMannequinStyles.mannequinTwoInputWorkflowTemplateId, styleTwoInputWf.id),
      )
      .where(ilike(schema.sareeMannequinStyles.label, params.sareeStyleId))
      .limit(1);
    if (!style?.isActive) {
      throw new AppError('BAD_STYLE', 400, 'saree style not found or inactive');
    }
    if (params.secondFlatImageKey) {
      if (!style.mannequinTwoInputWorkflowTemplateId) {
        throw new AppError(
          'CONFIG',
          400,
          'saree style missing two-input step-1 workflow configuration',
        );
      }
      styleWorkflowTemplateId = style.mannequinTwoInputWorkflowTemplateId;
      styleWorkflowVersion = style.mannequinTwoInputWorkflowVersion ?? null;
    } else {
      styleWorkflowTemplateId = style.mannequinWorkflowTemplateId;
      styleWorkflowVersion = style.mannequinWorkflowVersion ?? null;
    }
  }

  // A style able to supply a two-input workflow satisfies this requirement
  // even when the garment type itself has none configured — mirrors how a
  // style already overrides the garment type's single-input default above.
  if (
    params.secondFlatImageKey &&
    !styleWorkflowTemplateId &&
    !garmentType.mannequinTwoInputWorkflowTemplateId
  ) {
    throw new AppError(
      'CONFIG',
      400,
      'garment type missing two-input step-1 workflow configuration',
    );
  }

  await assertMerchantUploadKey(app, params.merchantId, params.flatImageKey, 'flat garment');
  if (params.secondFlatImageKey) {
    await assertMerchantUploadKey(app, params.merchantId, params.secondFlatImageKey, 'pallu');
  }

  const cost = await getTryonCreditCost(app);

  const jobId = randomUUID();
  await app.db.transaction(async (tx) => {
    await tx.insert(schema.jobs).values({
      id: jobId,
      userId: params.userId,
      status: 'QUEUED',
      watermark: false,
      queueStream: 'normal',
      creditsCharged: cost,
      source: JOB_SOURCE.MERCHANT_CATALOG_SAREE_MANNEQUIN,
    });
    await atomicDeduct(tx as unknown as typeof app.db, params.userId, cost, jobId);
    await tx.insert(schema.jobInputs).values({
      jobId,
      upperGarmentKey: params.flatImageKey,
      thirdGarmentKey: params.secondFlatImageKey ?? null,
      faceId: null,
      garmentTypeId: params.garmentSubcategoryId,
      params: {
        kind: 'saree_mannequin',
        // No entry at all (not even a null workflowTemplateId) in the final
        // fallback case — that is load-bearing, not an oversight: omitting
        // the snapshot is what lets the dispatcher re-resolve
        // garmentType.mannequinWorkflowTemplateId fresh at dispatch time, so
        // an admin who changes a garment type's default mannequin workflow
        // after this job is created (but before it dispatches) has that
        // change take effect. Stamping a version here too would be
        // meaningless without a snapshotted template id to pair it with —
        // the dispatcher's own fresh lookup also resolves that template's
        // current live content, with nothing to compare a version against.
        ...(styleWorkflowTemplateId
          ? {
              workflowTemplateId: styleWorkflowTemplateId,
              dispatchTemplateVersion: styleWorkflowVersion,
            }
          : params.secondFlatImageKey
            ? {
                workflowTemplateId: garmentType.mannequinTwoInputWorkflowTemplateId,
                dispatchTemplateVersion: garmentType.mannequinTwoInputWorkflowVersion ?? null,
              }
            : {}),
      },
    });
  });

  await app.redis.xadd(
    'jobs:normal',
    'MAXLEN',
    '~',
    10000,
    '*',
    'jobId',
    jobId,
    'userId',
    params.userId,
  );

  return { jobId };
}
