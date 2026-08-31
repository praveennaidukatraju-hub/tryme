import { type DB, schema } from '@tryme/db';
import { jobsCreatedTotal } from '@tryme/observability';
import { type CreateSareeMannequinJobRequest, JOB_SOURCE } from '@tryme/types';
import { aliasedTable, and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { assertQueueCapacity } from '../../lib/queue-capacity-config.js';
import { atomicDeduct } from '../credits/ledger.js';
import { assertOwnsUploadKey, resolveQueueRouting, resolveTryonPlan } from './create.js';
import { promptGuard } from './sanitize.js';

export async function createSareeMannequinJob(
  app: FastifyInstance,
  userId: string,
  body: z.infer<typeof CreateSareeMannequinJobRequest>,
): Promise<{ catalogueId: string; jobIds: string[] }> {
  const { garmentTypeId, garmentKey, secondGarmentKey, faceId, step2 } = body;

  await assertOwnsUploadKey(app, userId, garmentKey);
  if (secondGarmentKey) await assertOwnsUploadKey(app, userId, secondGarmentKey);

  // No join/version lookup for the plain mannequinWorkflowTemplateId — that
  // id is deliberately never snapshotted into the job (see the params
  // comment below), so there is nothing to pair a version with.
  const mannequinTwoInputWf = aliasedTable(schema.workflowTemplates, 'mannequin_two_input_wf');
  const [garmentType] = await app.db
    .select({
      isActive: schema.garmentSubcategories.isActive,
      requiresMannequinStep: schema.garmentSubcategories.requiresMannequinStep,
      mannequinWorkflowTemplateId: schema.garmentSubcategories.mannequinWorkflowTemplateId,
      mannequinTwoInputWorkflowTemplateId:
        schema.garmentSubcategories.mannequinTwoInputWorkflowTemplateId,
      mannequinTwoInputWorkflowVersion: mannequinTwoInputWf.version,
    })
    .from(schema.garmentSubcategories)
    .leftJoin(
      mannequinTwoInputWf,
      eq(schema.garmentSubcategories.mannequinTwoInputWorkflowTemplateId, mannequinTwoInputWf.id),
    )
    .where(eq(schema.garmentSubcategories.id, garmentTypeId));
  if (!garmentType?.isActive || !garmentType.requiresMannequinStep) {
    throw new AppError('BAD_CATALOG', 400, 'garment type does not use a mannequin step');
  }
  if (secondGarmentKey) {
    if (!garmentType.mannequinTwoInputWorkflowTemplateId) {
      throw new AppError(
        'CONFIG',
        400,
        'garment type missing two-input step-1 workflow configuration',
      );
    }
  } else if (!garmentType.mannequinWorkflowTemplateId) {
    throw new AppError('CONFIG', 400, 'garment type missing step-1 workflow configuration');
  }

  const [face] = await app.db
    .select({ id: schema.modelFaces.id })
    .from(schema.modelFaces)
    .where(and(eq(schema.modelFaces.id, faceId), eq(schema.modelFaces.isActive, true)));
  if (!face) throw new AppError('BAD_CATALOG', 400, 'face not found or inactive');

  // Validate + resolve the step-2 plan up front (poses/backgrounds/catalog items/
  // workflow nodes) WITHOUT resolving an upperGarmentKey — it does not exist yet.
  // resolvedUpperGarmentKey: null tells resolveTryonPlan every look's garment key
  // is deferred; it still validates that the (fixed, saree) workflow requires one.
  const plan = await resolveTryonPlan(app, userId, step2, { resolvedUpperGarmentKey: null });

  const [[user], routing] = await Promise.all([
    app.db.select().from(schema.users).where(eq(schema.users.id, userId)),
    resolveQueueRouting(app, userId),
  ]);
  if (!user || user.isBanned) throw new AppError('FORBIDDEN', 403, 'banned');

  await assertQueueCapacity(app, 1);

  const { queueStream, priority, watermark } = routing;

  const { mannequinJobId, jobIds } = await app.db.transaction(async (tx) => {
    const [mannequinJob] = await tx
      .insert(schema.jobs)
      .values({
        userId,
        status: 'QUEUED',
        priority,
        queueStream,
        watermark,
        creditsCharged: 0,
        source: JOB_SOURCE.SAREE_MANNEQUIN,
      })
      .returning();
    await tx.insert(schema.jobInputs).values({
      jobId: mannequinJob.id,
      upperGarmentKey: garmentKey,
      thirdGarmentKey: secondGarmentKey ?? null,
      faceId,
      garmentTypeId,
      params: {
        kind: 'saree_mannequin',
        // No entry at all in the plain (no secondGarmentKey) case — omitting
        // the snapshot is what lets the dispatcher re-resolve
        // garmentType.mannequinWorkflowTemplateId fresh at dispatch time, so
        // an admin who changes a garment type's default mannequin workflow
        // after this job is created (but before it dispatches) has that
        // change take effect.
        ...(secondGarmentKey
          ? {
              workflowTemplateId: garmentType.mannequinTwoInputWorkflowTemplateId,
              dispatchTemplateVersion: garmentType.mannequinTwoInputWorkflowVersion ?? null,
            }
          : {}),
      },
    });

    const created: string[] = [];
    for (const look of plan.looks) {
      const [step2Job] = await tx
        .insert(schema.jobs)
        .values({
          userId,
          catalogueId: plan.catalogueId,
          status: 'PENDING_MANNEQUIN',
          priority,
          queueStream,
          watermark,
          creditsCharged: plan.cost,
          source: JOB_SOURCE.CATALOG,
        })
        .returning();
      await atomicDeduct(tx as unknown as DB, userId, plan.cost, step2Job.id);
      await tx.insert(schema.jobInputs).values({
        jobId: step2Job.id,
        upperGarmentKey: null,
        faceId,
        backgroundId: look.backgroundId,
        poseId: look.poseId,
        garmentTypeId,
        lowerCatalogId: look.lowerCatalogId,
        lowerGarmentKey: look.lowerGarmentKey,
        thirdGarmentKey: step2.inputs.thirdGarmentKey ?? null,
        shoeCatalogId: look.shoeCatalogId,
        userHint: promptGuard(step2.userHint),
        params: { ...look.params, mannequinJobId: mannequinJob.id },
      });
      created.push(step2Job.id);
    }
    return { mannequinJobId: mannequinJob.id, jobIds: created };
  });

  try {
    await app.redis.xadd(
      `jobs:${queueStream}`,
      'MAXLEN',
      '~',
      10000,
      '*',
      'jobId',
      mannequinJobId,
      'userId',
      userId,
    );
    jobsCreatedTotal.inc({ priority: queueStream, kind: JOB_SOURCE.SAREE_MANNEQUIN });
  } catch (err) {
    app.log.error(
      { err, jobId: mannequinJobId },
      'redis xadd failed — mannequin job marked failed',
    );
    // Step-2 jobs stay PENDING_MANNEQUIN pointing at a mannequin job that will
    // never run — mark the mannequin job FAILED so the dispatcher's promoter
    // sweep (which also treats a FAILED parent as "refund + fail children")
    // picks these up and refunds the user instead of leaving them stuck.
    await app.db
      .update(schema.jobs)
      .set({ status: 'FAILED', errorCode: 'ENQUEUE_FAIL' })
      .where(eq(schema.jobs.id, mannequinJobId));
    throw new AppError('ENQUEUE_FAIL', 503, 'queue unavailable');
  }

  return { catalogueId: plan.catalogueId, jobIds };
}
