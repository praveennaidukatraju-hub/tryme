// apps/dispatcher/src/workflow/drain-cleanup.ts
import { type DB, schema } from '@tryme/db';
import type { Logger } from '@tryme/logger';
import { and, count, eq, notInArray, or, sql } from 'drizzle-orm';

const TERMINAL_STATUSES = ['COMPLETED', 'FAILED', 'CANCELLED'];

/**
 * Deletes an archived template version once no non-terminal job still
 * references it via job_inputs.params.dispatchTemplateVersion. Called from
 * the dispatcher's existing terminal-transition points — not a periodic
 * sweep — since it only ever needs to run right after a job that might have
 * been the last one draining a given version reaches a terminal state.
 */
export async function maybeCleanupArchive(
  db: DB,
  workflowTemplateId: string,
  version: number,
): Promise<void> {
  const [row] = await db
    .select({ cnt: count() })
    .from(schema.jobs)
    .innerJoin(schema.jobInputs, eq(schema.jobInputs.jobId, schema.jobs.id))
    .leftJoin(schema.modelPoseAssets, eq(schema.modelPoseAssets.id, schema.jobInputs.poseId))
    .leftJoin(
      schema.garmentSubcategories,
      eq(schema.garmentSubcategories.id, schema.jobInputs.garmentTypeId),
    )
    .where(
      and(
        sql`${schema.jobInputs.params} ->> 'dispatchTemplateVersion' = ${String(version)}`,
        or(
          sql`${schema.jobInputs.params} ->> 'workflowTemplateId' = ${workflowTemplateId}`,
          eq(schema.modelPoseAssets.workflowTemplateId, workflowTemplateId),
          eq(schema.garmentSubcategories.sareeStep2WorkflowTemplateId, workflowTemplateId),
          eq(schema.garmentSubcategories.mannequinWorkflowTemplateId, workflowTemplateId),
          eq(schema.garmentSubcategories.mannequinTwoInputWorkflowTemplateId, workflowTemplateId),
          eq(schema.garmentSubcategories.twoInputTryonWorkflowTemplateId, workflowTemplateId),
        ),
        notInArray(schema.jobs.status, TERMINAL_STATUSES),
      ),
    );

  if (Number(row?.cnt ?? 0) > 0) return;

  await db
    .delete(schema.workflowTemplateArchives)
    .where(
      and(
        eq(schema.workflowTemplateArchives.workflowTemplateId, workflowTemplateId),
        eq(schema.workflowTemplateArchives.version, version),
      ),
    );
}

/**
 * Resolves the workflow template + version a just-terminated job was
 * dispatched against, then runs maybeCleanupArchive for it. Shared by every
 * terminal-transition call site (transitionJob's inline update and
 * terminateJob's separate refund+status transaction — the two places a job
 * actually reaches COMPLETED/FAILED/CANCELLED) so the resolution query lives
 * in exactly one place. Never throws — a failure here must not affect the
 * job-termination path it's called from, so callers can invoke this directly
 * without their own try/catch.
 */
export async function checkAndCleanupArchiveForJob(
  db: DB,
  jobId: string,
  log: Logger,
): Promise<void> {
  try {
    const [inputRow] = await db
      .select({
        params: schema.jobInputs.params,
        poseWorkflowTemplateId: schema.modelPoseAssets.workflowTemplateId,
        sareeStep2WorkflowTemplateId: schema.garmentSubcategories.sareeStep2WorkflowTemplateId,
        mannequinWorkflowTemplateId: schema.garmentSubcategories.mannequinWorkflowTemplateId,
        mannequinTwoInputWorkflowTemplateId:
          schema.garmentSubcategories.mannequinTwoInputWorkflowTemplateId,
        twoInputTryonWorkflowTemplateId:
          schema.garmentSubcategories.twoInputTryonWorkflowTemplateId,
      })
      .from(schema.jobInputs)
      .leftJoin(schema.modelPoseAssets, eq(schema.modelPoseAssets.id, schema.jobInputs.poseId))
      .leftJoin(
        schema.garmentSubcategories,
        eq(schema.garmentSubcategories.id, schema.jobInputs.garmentTypeId),
      )
      .where(eq(schema.jobInputs.jobId, jobId));

    const rawParams = (inputRow?.params ?? {}) as Record<string, unknown>;
    const workflowTemplateId =
      (rawParams.workflowTemplateId as string | undefined) ??
      inputRow?.poseWorkflowTemplateId ??
      inputRow?.sareeStep2WorkflowTemplateId ??
      inputRow?.mannequinWorkflowTemplateId ??
      inputRow?.mannequinTwoInputWorkflowTemplateId ??
      inputRow?.twoInputTryonWorkflowTemplateId;
    const version = rawParams.dispatchTemplateVersion as number | undefined;

    if (typeof version === 'number' && typeof workflowTemplateId === 'string') {
      await maybeCleanupArchive(db, workflowTemplateId, version);
    }
  } catch (err) {
    log.warn({ err, jobId }, 'failed to check workflow template archive cleanup');
  }
}
