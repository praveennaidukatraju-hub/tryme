// apps/dispatcher/src/workflow/resolve-template-version.ts
import { type DB, schema } from '@tryme/db';
import { and, eq } from 'drizzle-orm';

/**
 * Resolves which content a job should use for a given workflow template:
 * the live row (the common case — no replace has happened since this job was
 * created, or the job predates version stamping entirely), or a specific
 * archived version if the live template has since moved on. See
 * docs/superpowers/specs/2026-08-26-workflow-template-replace-design.md.
 */
export async function resolveWorkflowTemplateVersion(
  db: DB,
  workflowTemplateId: string,
  snapshotVersion: number | null | undefined,
): Promise<typeof schema.workflowTemplates.$inferSelect | undefined> {
  const [live] = await db
    .select()
    .from(schema.workflowTemplates)
    .where(eq(schema.workflowTemplates.id, workflowTemplateId));
  if (!live) return undefined;
  if (snapshotVersion == null || snapshotVersion === live.version) return live;

  const [archived] = await db
    .select()
    .from(schema.workflowTemplateArchives)
    .where(
      and(
        eq(schema.workflowTemplateArchives.workflowTemplateId, workflowTemplateId),
        eq(schema.workflowTemplateArchives.version, snapshotVersion),
      ),
    );
  if (!archived) {
    throw new Error(
      `Workflow template "${workflowTemplateId}" version ${snapshotVersion} was archived but no longer exists — job outlived its drain window`,
    );
  }

  return {
    ...live,
    jsonContent: archived.jsonContent,
    faceNodeId: archived.faceNodeId,
    poseNodeId: archived.poseNodeId,
    bgNodeId: archived.bgNodeId,
    upperNodeIds: archived.upperNodeIds,
    lowerNodeId: archived.lowerNodeId,
    shoeNodeId: archived.shoeNodeId,
    thirdNodeId: archived.thirdNodeId,
    sizeNodeId: archived.sizeNodeId,
    sizeNodeIds: archived.sizeNodeIds,
    latentSizeNodeIds: archived.latentSizeNodeIds,
    latentMaxPx: archived.latentMaxPx,
    outputSizeNodeIds: archived.outputSizeNodeIds,
    outputMaxPx: archived.outputMaxPx,
    resultNodeId: archived.resultNodeId,
    facePhasePromptNode: archived.facePhasePromptNode,
    garmentPhasePromptNode: archived.garmentPhasePromptNode,
    stage1PositivePromptNode: archived.stage1PositivePromptNode,
    stage1NegativePromptNode: archived.stage1NegativePromptNode,
    defaultFacePhasePrompt: archived.defaultFacePhasePrompt,
    defaultGarmentPhasePrompt: archived.defaultGarmentPhasePrompt,
    defaultStage1PositivePrompt: archived.defaultStage1PositivePrompt,
    defaultStage1NegativePrompt: archived.defaultStage1NegativePrompt,
    workflowType: archived.workflowType,
    tryonPersonNodeId: archived.tryonPersonNodeId,
    tryonGarmentNodeId: archived.tryonGarmentNodeId,
    tryonGarmentNodeId2: archived.tryonGarmentNodeId2,
    tryonOutputNodeId: archived.tryonOutputNodeId,
    version: archived.version,
  };
}
