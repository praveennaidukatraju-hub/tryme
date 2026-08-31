import { type DbTransaction, schema } from '@tryme/db';
import {
  CreateWorkflowBody,
  DEFAULT_REGENERATION_REASON_PROMPTS,
  ParseWorkflowBody,
  ReassignWorkflowBody,
  ReplaceWorkflowBody,
  UpdateWorkflowBody,
} from '@tryme/types';
import { and, count, eq, ne, notInArray, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { verifyPassword } from '../auth/service.js';
import { recordAudit } from './audit.js';
import { requirePermission } from './guard.js';
import { detectTryonMappings } from './tryon-detect.js';
import { detectTryonTwoInputMappings } from './tryon-two-input-detect.js';
import { detectTwoStageMappings } from './two-stage-detect.js';
import { classifyNode, detectMappings, type NodeCategory } from './workflow-detect.js';

// Statuses that mean a job is done touching its stamped template version.
// Kept in sync by hand with apps/dispatcher/src/workflow/drain-cleanup.ts's
// TERMINAL_STATUSES — that module can't be imported here (dispatcher isn't a
// shared package), and duplicating one string array is cheaper than adding a
// cross-app dependency for it.
const TERMINAL_JOB_STATUSES = ['COMPLETED', 'FAILED', 'CANCELLED'];

/**
 * True if at least one non-terminal job is still stamped with
 * (workflowTemplateId, version) — i.e. was created while that version was
 * live and hasn't finished dispatching against it yet. Mirrors the WHERE
 * clause in the dispatcher's maybeCleanupArchive so "should we archive on
 * replace" and "is it safe to delete the archive" agree on what counts as
 * in-flight. Only jobs that explicitly stamped this exact version count —
 * jobs with no stamp resolve against the live row regardless of any archive,
 * so archiving can't protect them and their presence shouldn't force one.
 */
async function hasInFlightJobsForTemplateVersion(
  tx: DbTransaction,
  workflowTemplateId: string,
  version: number,
): Promise<boolean> {
  const [row] = await tx
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
        notInArray(schema.jobs.status, TERMINAL_JOB_STATUSES),
      ),
    );

  return Number(row?.cnt ?? 0) > 0;
}

type WorkflowNode = {
  class_type?: string;
  _meta?: { title?: string };
  inputs?: Record<string, unknown>;
};

// ── Validation helpers ────────────────────────────────────────────────────

function validateNodeExists(json: Record<string, unknown>, nodeId: string, role: string): void {
  if (!Object.hasOwn(json, nodeId)) {
    throw new AppError('VALIDATION', 400, `Node "${nodeId}" (${role}) not found in workflow JSON`);
  }
}

function validateNodeType(
  json: Record<string, unknown>,
  nodeId: string,
  expectedCategory: NodeCategory,
  role: string,
): void {
  const node = json[nodeId] as WorkflowNode | undefined;
  const classType = node?.class_type ?? '';
  const actual = classifyNode(classType);
  if (actual !== expectedCategory) {
    throw new AppError(
      'VALIDATION',
      400,
      `Node "${nodeId}" (${role}) is type "${classType}" but expected ${
        expectedCategory === 'image'
          ? 'LoadImage'
          : expectedCategory === 'prompt'
            ? 'TextEncode*'
            : 'EmptyLatentImage'
      }`,
    );
  }
}

// Different ComfyUI node types store their text under different input keys —
// standard CLIPTextEncode uses "text", custom nodes (e.g. TextEncodeQwenImageEditPlusPro)
// use "prompt". Try both rather than assuming one.
function extractPromptText(node: WorkflowNode | undefined): string {
  const inputs = node?.inputs;
  return (inputs?.prompt as string | undefined) ?? (inputs?.text as string | undefined) ?? '';
}

function extractDefaultPrompts(
  json: Record<string, unknown>,
  negativePromptNode: string | null,
  positivePromptNode: string,
): { defaultFacePhasePrompt: string; defaultGarmentPhasePrompt: string } {
  const negNode = negativePromptNode
    ? (json[negativePromptNode] as WorkflowNode | undefined)
    : undefined;
  const posNode = json[positivePromptNode] as WorkflowNode | undefined;
  return {
    defaultFacePhasePrompt: extractPromptText(negNode),
    defaultGarmentPhasePrompt: extractPromptText(posNode),
  };
}

// Writes into whichever key the node already uses (standard CLIPTextEncode = "text",
// custom nodes like TextEncodeQwenImageEditPlusPro = "prompt") — mirrors extractPromptText's
// read priority so a write always lands in the field ComfyUI actually reads for that node.
// Defaults to "text" (the standard CLIPTextEncode key) when the node has neither key yet.
function writePromptText(json: Record<string, unknown>, nodeId: string, text: string): void {
  const node = json[nodeId] as WorkflowNode | undefined;
  if (!node) return;
  node.inputs ??= {};
  const key = 'prompt' in node.inputs ? 'prompt' : 'text';
  node.inputs[key] = text;
}

// Targeted by node ID, not "the" KSampler — a workflow can have more than one
// (two_stage: build-person + dress-garment each have their own), so picking
// "the first one found" would silently edit or display the wrong stage.

export function extractKSamplerNodes(json: Record<string, unknown>): {
  nodeId: string;
  steps: number | null;
  cfg: number | null;
  denoise: number | null;
  seed: number | null;
}[] {
  const nodes: ReturnType<typeof extractKSamplerNodes> = [];
  for (const [nodeId, value] of Object.entries(json)) {
    const node = value as WorkflowNode;
    if (node?.class_type !== 'KSampler') continue;
    const inputs = node.inputs;
    nodes.push({
      nodeId,
      steps: typeof inputs?.steps === 'number' ? inputs.steps : null,
      cfg: typeof inputs?.cfg === 'number' ? inputs.cfg : null,
      denoise: typeof inputs?.denoise === 'number' ? inputs.denoise : null,
      seed: typeof inputs?.seed === 'number' ? inputs.seed : null,
    });
  }
  return nodes;
}

// Throws on a bad nodeId (caller turns AppError into the HTTP response) rather
// than returning a boolean — unlike the old single-KSampler version, a wrong
// nodeId here is a client mistake worth a specific error, not silent no-op.
export function writeKSamplerOverride(
  json: Record<string, unknown>,
  override: { nodeId: string; steps?: number; cfg?: number; denoise?: number; seed?: number },
): void {
  const node = json[override.nodeId] as WorkflowNode | undefined;
  if (!node) {
    throw new AppError('VALIDATION', 400, `KSampler node "${override.nodeId}" not found`);
  }
  if (node.class_type !== 'KSampler') {
    throw new AppError(
      'VALIDATION',
      400,
      `Node "${override.nodeId}" is type "${node.class_type}", not a KSampler`,
    );
  }
  node.inputs ??= {};
  if (override.steps !== undefined) node.inputs.steps = override.steps;
  if (override.cfg !== undefined) node.inputs.cfg = override.cfg;
  if (override.denoise !== undefined) node.inputs.denoise = override.denoise;
  if (override.seed !== undefined) node.inputs.seed = override.seed;
}

function extractWorkflowInsertFields(body: z.infer<typeof CreateWorkflowBody>) {
  const workflowType = body.workflowType ?? 'regular';

  if (workflowType === 'saree_step1_two_input') {
    const { detected: autoDetected } = detectTryonTwoInputMappings(body.jsonContent);
    const personNodeId = body.tryonPersonNodeId ?? autoDetected.personNodeId ?? '';
    const bodyNodeId = body.tryonGarmentNodeId ?? autoDetected.bodyNodeId ?? '';
    const palluNodeId = body.tryonGarmentNodeId2 ?? autoDetected.palluNodeId ?? '';
    const outputNodeId = body.tryonOutputNodeId ?? autoDetected.outputNodeId ?? '';
    // biome-ignore lint/style/noNonNullAssertion: guaranteed by superRefine
    const negNode = body.facePhasePromptNode!;
    // biome-ignore lint/style/noNonNullAssertion: guaranteed by superRefine
    const posNode = body.garmentPhasePromptNode!;
    if (!bodyNodeId)
      throw new AppError(
        'VALIDATION',
        400,
        'Could not detect body node — set tryonGarmentNodeId manually',
      );
    if (!palluNodeId)
      throw new AppError(
        'VALIDATION',
        400,
        'Could not detect pallu node — set tryonGarmentNodeId2 manually',
      );
    if (!outputNodeId)
      throw new AppError(
        'VALIDATION',
        400,
        'Could not detect output node — set tryonOutputNodeId manually',
      );
    if (personNodeId) {
      validateNodeExists(body.jsonContent, personNodeId, 'person');
      validateNodeType(body.jsonContent, personNodeId, 'image', 'person');
    }
    validateNodeExists(body.jsonContent, bodyNodeId, 'body');
    validateNodeExists(body.jsonContent, palluNodeId, 'pallu');
    validateNodeExists(body.jsonContent, outputNodeId, 'output');
    validateNodeExists(body.jsonContent, negNode, 'negative prompt');
    validateNodeExists(body.jsonContent, posNode, 'positive prompt');
    validateNodeType(body.jsonContent, bodyNodeId, 'image', 'body');
    validateNodeType(body.jsonContent, palluNodeId, 'image', 'pallu');
    validateNodeType(body.jsonContent, negNode, 'prompt', 'negative prompt');
    validateNodeType(body.jsonContent, posNode, 'prompt', 'positive prompt');
    const { defaultFacePhasePrompt, defaultGarmentPhasePrompt } = extractDefaultPrompts(
      body.jsonContent,
      negNode,
      posNode,
    );
    return {
      slug: body.slug,
      label: body.label,
      jsonContent: body.jsonContent,
      workflowType,
      faceNodeId: '',
      poseNodeId: '',
      bgNodeId: '',
      upperNodeIds: [],
      lowerNodeId: null,
      shoeNodeId: null,
      thirdNodeId: null,
      sizeNodeIds: [],
      latentSizeNodeIds: [],
      latentMaxPx: 2048,
      outputSizeNodeIds: [],
      outputMaxPx: 2048,
      resultNodeId: null,
      facePhasePromptNode: negNode,
      garmentPhasePromptNode: posNode,
      defaultFacePhasePrompt,
      defaultGarmentPhasePrompt,
      stage1PositivePromptNode: null,
      stage1NegativePromptNode: null,
      defaultStage1PositivePrompt: '',
      defaultStage1NegativePrompt: '',
      tryonPersonNodeId: personNodeId || null,
      tryonGarmentNodeId: bodyNodeId,
      tryonGarmentNodeId2: palluNodeId,
      tryonOutputNodeId: outputNodeId,
    };
  }

  if (workflowType === 'two_stage') {
    const { detected: autoDetected } = detectTwoStageMappings(body.jsonContent);
    const faceNodeId = body.faceNodeId ?? autoDetected.faceNodeId ?? '';
    const poseNodeId = body.poseNodeId ?? autoDetected.poseNodeId ?? '';
    const bgNodeId = body.bgNodeId ?? autoDetected.bgNodeId ?? '';
    const garmentNodeId = body.upperNodeIds?.[0] ?? autoDetected.garmentNodeId ?? '';
    // biome-ignore lint/style/noNonNullAssertion: guaranteed by superRefine
    const stage2NegativeNode = body.facePhasePromptNode!;
    // biome-ignore lint/style/noNonNullAssertion: guaranteed by superRefine
    const stage2PositiveNode = body.garmentPhasePromptNode!;
    const stage1PositiveNode =
      body.stage1PositivePromptNode ?? autoDetected.stage1PositivePromptNode ?? '';
    const stage1NegativeNode =
      body.stage1NegativePromptNode ?? autoDetected.stage1NegativePromptNode ?? '';

    if (!faceNodeId)
      throw new AppError('VALIDATION', 400, 'Could not detect face node — set faceNodeId manually');
    if (!poseNodeId)
      throw new AppError('VALIDATION', 400, 'Could not detect pose node — set poseNodeId manually');
    if (!bgNodeId)
      throw new AppError(
        'VALIDATION',
        400,
        'Could not detect background node — set bgNodeId manually',
      );
    if (!garmentNodeId)
      throw new AppError(
        'VALIDATION',
        400,
        'Could not detect garment node — set upperNodeIds manually',
      );
    if (!stage1PositiveNode || !stage1NegativeNode)
      throw new AppError(
        'VALIDATION',
        400,
        'Could not detect stage-1 prompt nodes — set stage1PositivePromptNode/stage1NegativePromptNode manually',
      );

    validateNodeExists(body.jsonContent, faceNodeId, 'face');
    validateNodeType(body.jsonContent, faceNodeId, 'image', 'face');
    validateNodeExists(body.jsonContent, poseNodeId, 'pose');
    validateNodeType(body.jsonContent, poseNodeId, 'image', 'pose');
    validateNodeExists(body.jsonContent, bgNodeId, 'background');
    validateNodeType(body.jsonContent, bgNodeId, 'image', 'background');
    validateNodeExists(body.jsonContent, garmentNodeId, 'garment');
    validateNodeType(body.jsonContent, garmentNodeId, 'image', 'garment');
    validateNodeExists(body.jsonContent, stage2NegativeNode, 'stage-2 negative prompt');
    validateNodeType(body.jsonContent, stage2NegativeNode, 'prompt', 'stage-2 negative prompt');
    validateNodeExists(body.jsonContent, stage2PositiveNode, 'stage-2 positive prompt');
    validateNodeType(body.jsonContent, stage2PositiveNode, 'prompt', 'stage-2 positive prompt');
    validateNodeExists(body.jsonContent, stage1PositiveNode, 'stage-1 positive prompt');
    validateNodeType(body.jsonContent, stage1PositiveNode, 'prompt', 'stage-1 positive prompt');
    validateNodeExists(body.jsonContent, stage1NegativeNode, 'stage-1 negative prompt');
    validateNodeType(body.jsonContent, stage1NegativeNode, 'prompt', 'stage-1 negative prompt');

    const sizeNodeIds = body.sizeNodeIds ?? autoDetected.sizeNodeIds;
    const defaultFacePhasePrompt = extractPromptText(
      body.jsonContent[stage2NegativeNode] as WorkflowNode | undefined,
    );
    const defaultGarmentPhasePrompt = extractPromptText(
      body.jsonContent[stage2PositiveNode] as WorkflowNode | undefined,
    );
    const defaultStage1PositivePrompt = extractPromptText(
      body.jsonContent[stage1PositiveNode] as WorkflowNode | undefined,
    );
    const defaultStage1NegativePrompt = extractPromptText(
      body.jsonContent[stage1NegativeNode] as WorkflowNode | undefined,
    );

    return {
      slug: body.slug,
      label: body.label,
      jsonContent: body.jsonContent,
      workflowType,
      faceNodeId,
      poseNodeId,
      bgNodeId,
      upperNodeIds: [garmentNodeId],
      lowerNodeId: null,
      shoeNodeId: null,
      thirdNodeId: null,
      sizeNodeIds,
      latentSizeNodeIds: [],
      latentMaxPx: 2048,
      outputSizeNodeIds: [],
      outputMaxPx: 2048,
      resultNodeId: null,
      facePhasePromptNode: stage2NegativeNode,
      garmentPhasePromptNode: stage2PositiveNode,
      stage1PositivePromptNode: stage1PositiveNode,
      stage1NegativePromptNode: stage1NegativeNode,
      defaultFacePhasePrompt,
      defaultGarmentPhasePrompt,
      defaultStage1PositivePrompt,
      defaultStage1NegativePrompt,
      tryonPersonNodeId: null,
      tryonGarmentNodeId: null,
      tryonGarmentNodeId2: null,
      tryonOutputNodeId: null,
    };
  }

  if (workflowType === 'tryon' || workflowType === 'saree_step1') {
    const { detected: autoDetected } = detectTryonMappings(body.jsonContent);
    const personNodeId = body.tryonPersonNodeId ?? autoDetected.personNodeId ?? '';
    const garmentNodeId = body.tryonGarmentNodeId ?? autoDetected.garmentNodeId ?? '';
    const outputNodeId = body.tryonOutputNodeId ?? autoDetected.outputNodeId ?? '';
    // biome-ignore lint/style/noNonNullAssertion: guaranteed by superRefine
    const negNode = body.facePhasePromptNode!;
    // biome-ignore lint/style/noNonNullAssertion: guaranteed by superRefine
    const posNode = body.garmentPhasePromptNode!;

    if (!garmentNodeId)
      throw new AppError(
        'VALIDATION',
        400,
        'Could not detect garment node — set tryonGarmentNodeId manually',
      );
    if (!outputNodeId)
      throw new AppError(
        'VALIDATION',
        400,
        'Could not detect output node — set tryonOutputNodeId manually',
      );

    if (personNodeId) {
      validateNodeExists(body.jsonContent, personNodeId, 'person');
      validateNodeType(body.jsonContent, personNodeId, 'image', 'person');
    }
    validateNodeExists(body.jsonContent, garmentNodeId, 'garment');
    validateNodeExists(body.jsonContent, outputNodeId, 'output');
    validateNodeExists(body.jsonContent, negNode, 'negative prompt');
    validateNodeExists(body.jsonContent, posNode, 'positive prompt');
    validateNodeType(body.jsonContent, garmentNodeId, 'image', 'garment');
    validateNodeType(body.jsonContent, negNode, 'prompt', 'negative prompt');
    validateNodeType(body.jsonContent, posNode, 'prompt', 'positive prompt');

    const { defaultFacePhasePrompt, defaultGarmentPhasePrompt } = extractDefaultPrompts(
      body.jsonContent,
      negNode,
      posNode,
    );

    return {
      slug: body.slug,
      label: body.label,
      jsonContent: body.jsonContent,
      workflowType,
      faceNodeId: '',
      poseNodeId: '',
      bgNodeId: '',
      upperNodeIds: [],
      lowerNodeId: null,
      shoeNodeId: null,
      thirdNodeId: null,
      sizeNodeIds: [],
      latentSizeNodeIds: [],
      latentMaxPx: 2048,
      outputSizeNodeIds: [],
      outputMaxPx: 2048,
      resultNodeId: null,
      facePhasePromptNode: negNode,
      garmentPhasePromptNode: posNode,
      defaultFacePhasePrompt,
      defaultGarmentPhasePrompt,
      stage1PositivePromptNode: null,
      stage1NegativePromptNode: null,
      defaultStage1PositivePrompt: '',
      defaultStage1NegativePrompt: '',
      tryonPersonNodeId: personNodeId || null,
      tryonGarmentNodeId: garmentNodeId,
      tryonGarmentNodeId2: null,
      tryonOutputNodeId: outputNodeId,
    };
  }

  // Regular workflow — full node validation.
  // biome-ignore lint/style/noNonNullAssertion: guaranteed by superRefine
  const poseNodeId = body.poseNodeId!;
  // biome-ignore lint/style/noNonNullAssertion: guaranteed by superRefine
  const garmentPhasePromptNode = body.garmentPhasePromptNode!;
  const upperNodeIds = body.upperNodeIds ?? [];

  validateNodeExists(body.jsonContent, poseNodeId, 'pose');
  validateNodeType(body.jsonContent, poseNodeId, 'image', 'pose');
  if (body.faceNodeId) {
    validateNodeExists(body.jsonContent, body.faceNodeId, 'face');
    validateNodeType(body.jsonContent, body.faceNodeId, 'image', 'face');
  }
  if (body.bgNodeId) {
    validateNodeExists(body.jsonContent, body.bgNodeId, 'background');
    validateNodeType(body.jsonContent, body.bgNodeId, 'image', 'background');
  }
  for (const uid of upperNodeIds) {
    validateNodeExists(body.jsonContent, uid, 'upper garment');
    validateNodeType(body.jsonContent, uid, 'image', 'upper garment');
  }
  if (body.lowerNodeId) {
    validateNodeExists(body.jsonContent, body.lowerNodeId, 'lower garment');
    validateNodeType(body.jsonContent, body.lowerNodeId, 'image', 'lower garment');
  }
  if (body.shoeNodeId) {
    validateNodeExists(body.jsonContent, body.shoeNodeId, 'shoes');
    validateNodeType(body.jsonContent, body.shoeNodeId, 'image', 'shoes');
  }
  if (body.thirdNodeId) {
    validateNodeExists(body.jsonContent, body.thirdNodeId, 'third garment');
    validateNodeType(body.jsonContent, body.thirdNodeId, 'image', 'third garment');
  }
  for (const uid of body.sizeNodeIds ?? []) {
    validateNodeExists(body.jsonContent, uid, 'size');
  }
  validateNodeExists(body.jsonContent, garmentPhasePromptNode, 'positive prompt');
  validateNodeType(body.jsonContent, garmentPhasePromptNode, 'prompt', 'positive prompt');
  if (body.facePhasePromptNode) {
    validateNodeExists(body.jsonContent, body.facePhasePromptNode, 'negative prompt');
    validateNodeType(body.jsonContent, body.facePhasePromptNode, 'prompt', 'negative prompt');
  }

  const defaultGarmentPhasePrompt = extractPromptText(
    body.jsonContent[garmentPhasePromptNode] as WorkflowNode | undefined,
  );
  const defaultFacePhasePrompt = body.facePhasePromptNode
    ? extractPromptText(body.jsonContent[body.facePhasePromptNode] as WorkflowNode | undefined)
    : '';

  return {
    slug: body.slug,
    label: body.label,
    jsonContent: body.jsonContent,
    workflowType: 'regular',
    faceNodeId: body.faceNodeId ?? null,
    poseNodeId,
    bgNodeId: body.bgNodeId ?? null,
    upperNodeIds,
    lowerNodeId: body.lowerNodeId ?? null,
    shoeNodeId: body.shoeNodeId ?? null,
    thirdNodeId: body.thirdNodeId ?? null,
    sizeNodeIds: body.sizeNodeIds ?? [],
    latentSizeNodeIds: body.latentSizeNodeIds ?? [],
    latentMaxPx: body.latentMaxPx ?? 2048,
    outputSizeNodeIds: body.outputSizeNodeIds ?? [],
    outputMaxPx: body.outputMaxPx ?? 2048,
    resultNodeId: body.resultNodeId ?? null,
    facePhasePromptNode: body.facePhasePromptNode ?? null,
    garmentPhasePromptNode,
    defaultFacePhasePrompt,
    defaultGarmentPhasePrompt,
    stage1PositivePromptNode: null,
    stage1NegativePromptNode: null,
    defaultStage1PositivePrompt: '',
    defaultStage1NegativePrompt: '',
    tryonPersonNodeId: null,
    tryonGarmentNodeId: null,
    tryonGarmentNodeId2: null,
    tryonOutputNodeId: null,
  };
}

// ── Routes ────────────────────────────────────────────────────────────────

export async function adminWorkflowsRoutes(app: FastifyInstance) {
  const W = requirePermission('workflows.write');
  const R = requirePermission('workflows.read');
  const uuidParam = z.object({ id: z.string().uuid() });

  // GET /admin/workflows
  app.get('/admin/workflows', { preHandler: R }, async () => {
    const rows = await app.db.select().from(schema.workflowTemplates);

    const [poseCounts, funnelCounts, archives] = await Promise.all([
      app.db
        .select({
          workflowTemplateId: schema.modelPoseAssets.workflowTemplateId,
          cnt: count(),
        })
        .from(schema.modelPoseAssets)
        .groupBy(schema.modelPoseAssets.workflowTemplateId),
      app.db
        .select({
          workflowTemplateId: schema.shopifyFunnelTemplates.workflowTemplateId,
          cnt: count(),
        })
        .from(schema.shopifyFunnelTemplates)
        .groupBy(schema.shopifyFunnelTemplates.workflowTemplateId),
      app.db
        .select({
          workflowTemplateId: schema.workflowTemplateArchives.workflowTemplateId,
          version: schema.workflowTemplateArchives.version,
        })
        .from(schema.workflowTemplateArchives),
    ]);

    const countMap = Object.fromEntries(
      poseCounts.map((r) => [r.workflowTemplateId, Number(r.cnt)]),
    );
    const funnelCountMap = Object.fromEntries(
      funnelCounts.map((r) => [r.workflowTemplateId, Number(r.cnt)]),
    );
    const archiveMap = Object.fromEntries(
      archives.map((r) => [r.workflowTemplateId, { fromVersion: r.version }]),
    );

    return rows.map((r) => ({
      id: r.id,
      slug: r.slug,
      label: r.label,
      version: r.version,
      workflowType: r.workflowType,
      isActive: r.isActive,
      poseCount: countMap[r.id] ?? 0,
      funnelCount: funnelCountMap[r.id] ?? 0,
      draining: archiveMap[r.id] ?? null,
      defaultFacePhasePrompt: r.defaultFacePhasePrompt,
      defaultGarmentPhasePrompt: r.defaultGarmentPhasePrompt,
      regenerationReasonPrompts: r.regenerationReasonPrompts,
      facePhasePromptNode: r.facePhasePromptNode,
      ksamplerNodes: extractKSamplerNodes(r.jsonContent as Record<string, unknown>),
      lowerNodeId: r.lowerNodeId,
      shoeNodeId: r.shoeNodeId,
      thirdNodeId: r.thirdNodeId,
      sizeNodeIds: r.sizeNodeIds,
      latentSizeNodeIds: r.latentSizeNodeIds,
      latentMaxPx: r.latentMaxPx,
      outputSizeNodeIds: r.outputSizeNodeIds,
      outputMaxPx: r.outputMaxPx,
      resultNodeId: r.resultNodeId,
      tryonPersonNodeId: r.tryonPersonNodeId,
      tryonGarmentNodeId: r.tryonGarmentNodeId,
      tryonGarmentNodeId2: r.tryonGarmentNodeId2,
      tryonOutputNodeId: r.tryonOutputNodeId,
      stage1PositivePromptNode: r.stage1PositivePromptNode,
      stage1NegativePromptNode: r.stage1NegativePromptNode,
      defaultStage1PositivePrompt: r.defaultStage1PositivePrompt,
      defaultStage1NegativePrompt: r.defaultStage1NegativePrompt,
      createdAt: r.createdAt,
    }));
  });

  // POST /admin/workflows/parse
  // Auto-detect node mappings from the workflow JSON using the naming convention.
  // Returns detected mappings + full lists of image/prompt nodes for manual override.
  app.post(
    '/admin/workflows/parse',
    {
      preHandler: W,
      schema: { body: ParseWorkflowBody },
    },
    async (req) => {
      const { jsonContent } = req.body as { jsonContent: Record<string, unknown> };

      if (typeof jsonContent !== 'object' || Array.isArray(jsonContent) || jsonContent === null) {
        throw new AppError('VALIDATION', 400, 'jsonContent must be a JSON object');
      }

      const parseWorkflowType = (req.body as { workflowType?: string }).workflowType;
      if (parseWorkflowType === 'tryon' || parseWorkflowType === 'saree_step1') {
        const { detected, allImageNodes, allPromptNodes } = detectTryonMappings(jsonContent);
        return { detected, allImageNodes, allPromptNodes };
      }
      if (parseWorkflowType === 'saree_step1_two_input') {
        const { detected, allImageNodes, allPromptNodes } =
          detectTryonTwoInputMappings(jsonContent);
        return { detected, allImageNodes, allPromptNodes };
      }
      if (parseWorkflowType === 'two_stage') {
        const { detected, allImageNodes, allPromptNodes } = detectTwoStageMappings(jsonContent);
        return { detected, allImageNodes, allPromptNodes };
      }

      const { detected, allImageNodes, allPromptNodes, allLatentNodes } =
        detectMappings(jsonContent);

      return { detected, allImageNodes, allPromptNodes, allLatentNodes };
    },
  );

  // POST /admin/workflows
  app.post(
    '/admin/workflows',
    {
      preHandler: W,
      schema: { body: CreateWorkflowBody },
    },
    async (req) => {
      const body = req.body as z.infer<typeof CreateWorkflowBody>;

      const [existing] = await app.db
        .select({ id: schema.workflowTemplates.id })
        .from(schema.workflowTemplates)
        .where(eq(schema.workflowTemplates.slug, body.slug));
      if (existing) {
        throw new AppError('CONFLICT', 409, `Workflow with slug "${body.slug}" already exists`);
      }

      // Every new workflow starts with the default reason pool (blank prompts —
      // "no override yet") so the regenerate reason picker is never empty for
      // it. /replace intentionally never sets this field, so an existing
      // workflow's curated list survives a jsonContent swap untouched.
      const values = {
        ...extractWorkflowInsertFields(body),
        regenerationReasonPrompts: DEFAULT_REGENERATION_REASON_PROMPTS,
      };

      const row = await app.db.transaction(async (tx) => {
        const [inserted] = await tx.insert(schema.workflowTemplates).values(values).returning();
        if (!inserted)
          throw new AppError('INSERT_FAILED', 500, 'failed to insert workflow template');

        await recordAudit(tx, {
          // biome-ignore lint/style/noNonNullAssertion: set by the requirePermission preHandler (guard.ts) before any handler runs
          actor: { userId: req.userId, role: req.adminRole! },
          action: 'workflow.create',
          resourceType: 'workflow',
          resourceId: inserted.id,
          after: {
            id: inserted.id,
            slug: inserted.slug,
            label: inserted.label,
            workflowType: inserted.workflowType,
          },
          request: req,
        });

        return inserted;
      });

      return {
        ...row,
        poseCount: 0,
        funnelCount: 0,
        draining: null,
      };
    },
  );

  // GET /admin/workflows/:id
  app.get(
    '/admin/workflows/:id',
    {
      preHandler: R,
      schema: { params: uuidParam },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const [row] = await app.db
        .select()
        .from(schema.workflowTemplates)
        .where(eq(schema.workflowTemplates.id, id));
      if (!row) throw new AppError('NOT_FOUND', 404, 'workflow not found');

      const [[poseCountRow], [funnelCountRow], [archiveRow]] = await Promise.all([
        app.db
          .select({ cnt: count() })
          .from(schema.modelPoseAssets)
          .where(eq(schema.modelPoseAssets.workflowTemplateId, id)),
        app.db
          .select({ cnt: count() })
          .from(schema.shopifyFunnelTemplates)
          .where(eq(schema.shopifyFunnelTemplates.workflowTemplateId, id)),
        app.db
          .select({ version: schema.workflowTemplateArchives.version })
          .from(schema.workflowTemplateArchives)
          .where(eq(schema.workflowTemplateArchives.workflowTemplateId, id))
          .limit(1),
      ]);

      return {
        ...row,
        poseCount: Number(poseCountRow?.cnt ?? 0),
        funnelCount: Number(funnelCountRow?.cnt ?? 0),
        draining: archiveRow ? { fromVersion: archiveRow.version } : null,
        ksamplerNodes: extractKSamplerNodes(row.jsonContent as Record<string, unknown>),
      };
    },
  );

  // PATCH /admin/workflows/:id
  app.patch(
    '/admin/workflows/:id',
    {
      preHandler: W,
      schema: { params: uuidParam, body: UpdateWorkflowBody },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const body = req.body as {
        label?: string;
        slug?: string;
        isActive?: boolean;
        faceNodeId?: string;
        poseNodeId?: string;
        bgNodeId?: string;
        upperNodeIds?: string[];
        lowerNodeId?: string | null;
        shoeNodeId?: string | null;
        thirdNodeId?: string | null;
        sizeNodeIds?: string[];
        latentSizeNodeIds?: string[];
        latentMaxPx?: number;
        outputSizeNodeIds?: string[];
        outputMaxPx?: number;
        resultNodeId?: string | null;
        facePhasePromptNode?: string;
        garmentPhasePromptNode?: string;
        garmentPhasePrompt?: string;
        facePhasePrompt?: string;
        regenerationReasonPrompts?: { reason: string; prompt: string }[];
        ksamplerOverrides?: {
          nodeId: string;
          steps?: number;
          cfg?: number;
          denoise?: number;
          seed?: number;
        }[];
        tryonPersonNodeId?: string | null;
        tryonGarmentNodeId?: string | null;
        tryonGarmentNodeId2?: string | null;
        tryonOutputNodeId?: string | null;
        stage1PositivePromptNode?: string;
        stage1NegativePromptNode?: string;
        stage1PositivePrompt?: string;
        stage1NegativePrompt?: string;
      };

      const [existing] = await app.db
        .select()
        .from(schema.workflowTemplates)
        .where(eq(schema.workflowTemplates.id, id));
      if (!existing) throw new AppError('NOT_FOUND', 404, 'workflow not found');

      const json = existing.jsonContent as Record<string, unknown>;

      if (body.faceNodeId) {
        validateNodeExists(json, body.faceNodeId, 'face');
        validateNodeType(json, body.faceNodeId, 'image', 'face');
      }
      if (body.poseNodeId) {
        validateNodeExists(json, body.poseNodeId, 'pose');
        validateNodeType(json, body.poseNodeId, 'image', 'pose');
      }
      if (body.bgNodeId) {
        validateNodeExists(json, body.bgNodeId, 'background');
        validateNodeType(json, body.bgNodeId, 'image', 'background');
      }
      if (body.upperNodeIds) {
        for (const uid of body.upperNodeIds) {
          validateNodeExists(json, uid, 'upper garment');
          validateNodeType(json, uid, 'image', 'upper garment');
        }
      }
      if (body.lowerNodeId) {
        validateNodeExists(json, body.lowerNodeId, 'lower garment');
        validateNodeType(json, body.lowerNodeId, 'image', 'lower garment');
      }
      if (body.shoeNodeId) {
        validateNodeExists(json, body.shoeNodeId, 'shoes');
        validateNodeType(json, body.shoeNodeId, 'image', 'shoes');
      }
      if (body.thirdNodeId) {
        validateNodeExists(json, body.thirdNodeId, 'third garment');
        validateNodeType(json, body.thirdNodeId, 'image', 'third garment');
      }
      if (body.facePhasePromptNode) {
        validateNodeExists(json, body.facePhasePromptNode, 'negative prompt');
        validateNodeType(json, body.facePhasePromptNode, 'prompt', 'negative prompt');
      }
      if (body.garmentPhasePromptNode) {
        validateNodeExists(json, body.garmentPhasePromptNode, 'positive prompt');
        validateNodeType(json, body.garmentPhasePromptNode, 'prompt', 'positive prompt');
      }
      if (body.stage1PositivePromptNode) {
        validateNodeExists(json, body.stage1PositivePromptNode, 'stage-1 positive prompt');
        validateNodeType(json, body.stage1PositivePromptNode, 'prompt', 'stage-1 positive prompt');
      }
      if (body.stage1NegativePromptNode) {
        validateNodeExists(json, body.stage1NegativePromptNode, 'stage-1 negative prompt');
        validateNodeType(json, body.stage1NegativePromptNode, 'prompt', 'stage-1 negative prompt');
      }

      const mergedUpperNodeIds = body.upperNodeIds ?? existing.upperNodeIds;
      const mergedLowerNodeId =
        body.lowerNodeId !== undefined ? body.lowerNodeId : existing.lowerNodeId;
      const mergedFaceNodeId =
        body.faceNodeId !== undefined ? body.faceNodeId : existing.faceNodeId;
      const mergedFacePhasePromptNode =
        body.facePhasePromptNode !== undefined
          ? body.facePhasePromptNode
          : existing.facePhasePromptNode;

      if (existing.workflowType === 'regular') {
        const hasUpper = mergedUpperNodeIds.length > 0;
        const hasLower = !!mergedLowerNodeId;
        if (!hasUpper && !hasLower) {
          throw new AppError(
            'VALIDATION',
            400,
            'cannot clear the last garment role - at least one of upperNodeIds/lowerNodeId must remain set',
          );
        }
        if (mergedFaceNodeId && !mergedFacePhasePromptNode) {
          throw new AppError(
            'VALIDATION',
            400,
            'cannot leave faceNodeId set without facePhasePromptNode',
          );
        }
      }

      const newNegNode = body.facePhasePromptNode ?? existing.facePhasePromptNode;
      const newPosNode = body.garmentPhasePromptNode ?? existing.garmentPhasePromptNode;
      const newStage1PosNode = body.stage1PositivePromptNode ?? existing.stage1PositivePromptNode;
      const newStage1NegNode = body.stage1NegativePromptNode ?? existing.stage1NegativePromptNode;

      if (body.garmentPhasePrompt !== undefined) {
        if (!body.garmentPhasePrompt.trim()) {
          throw new AppError(
            'VALIDATION',
            400,
            'garmentPhasePrompt cannot be empty — an empty positive prompt causes ComfyUI to reject the job',
          );
        }
        writePromptText(json, newPosNode, body.garmentPhasePrompt);
      }
      if (body.facePhasePrompt !== undefined) {
        if (!newNegNode) {
          throw new AppError(
            'VALIDATION',
            400,
            'cannot set facePhasePrompt: this workflow has no face-phase prompt node',
          );
        }
        writePromptText(json, newNegNode, body.facePhasePrompt);
      }
      if (body.stage1PositivePrompt !== undefined) {
        if (!body.stage1PositivePrompt.trim()) {
          throw new AppError(
            'VALIDATION',
            400,
            'stage1PositivePrompt cannot be empty — an empty positive prompt causes ComfyUI to reject the job',
          );
        }
        if (!newStage1PosNode) {
          throw new AppError(
            'VALIDATION',
            400,
            'cannot set stage1PositivePrompt: this workflow has no stage-1 positive prompt node',
          );
        }
        writePromptText(json, newStage1PosNode, body.stage1PositivePrompt);
      }
      if (body.stage1NegativePrompt !== undefined) {
        if (!newStage1NegNode) {
          throw new AppError(
            'VALIDATION',
            400,
            'cannot set stage1NegativePrompt: this workflow has no stage-1 negative prompt node',
          );
        }
        writePromptText(json, newStage1NegNode, body.stage1NegativePrompt);
      }
      for (const override of body.ksamplerOverrides ?? []) {
        writeKSamplerOverride(json, override);
      }

      let defaultFacePhasePrompt = existing.defaultFacePhasePrompt;
      let defaultGarmentPhasePrompt = existing.defaultGarmentPhasePrompt;
      if (
        body.facePhasePromptNode ||
        body.garmentPhasePromptNode ||
        body.facePhasePrompt !== undefined ||
        body.garmentPhasePrompt !== undefined
      ) {
        const extracted = extractDefaultPrompts(json, newNegNode, newPosNode);
        defaultFacePhasePrompt = extracted.defaultFacePhasePrompt;
        defaultGarmentPhasePrompt = extracted.defaultGarmentPhasePrompt;
      }

      let defaultStage1PositivePrompt = existing.defaultStage1PositivePrompt;
      let defaultStage1NegativePrompt = existing.defaultStage1NegativePrompt;
      if (
        body.stage1PositivePromptNode ||
        body.stage1NegativePromptNode ||
        body.stage1PositivePrompt !== undefined ||
        body.stage1NegativePrompt !== undefined
      ) {
        defaultStage1PositivePrompt = extractPromptText(
          newStage1PosNode ? (json[newStage1PosNode] as WorkflowNode | undefined) : undefined,
        );
        defaultStage1NegativePrompt = extractPromptText(
          newStage1NegNode ? (json[newStage1NegNode] as WorkflowNode | undefined) : undefined,
        );
      }

      const updateValues: Record<string, unknown> = {
        updatedAt: new Date(),
        defaultFacePhasePrompt,
        defaultGarmentPhasePrompt,
        defaultStage1PositivePrompt,
        defaultStage1NegativePrompt,
      };
      if (
        body.garmentPhasePrompt !== undefined ||
        body.facePhasePrompt !== undefined ||
        body.stage1PositivePrompt !== undefined ||
        body.stage1NegativePrompt !== undefined ||
        (body.ksamplerOverrides?.length ?? 0) > 0
      ) {
        updateValues.jsonContent = json;
      }
      if (body.label !== undefined) updateValues.label = body.label;
      if (body.slug !== undefined) {
        const [conflict] = await app.db
          .select({ id: schema.workflowTemplates.id })
          .from(schema.workflowTemplates)
          .where(
            and(eq(schema.workflowTemplates.slug, body.slug), ne(schema.workflowTemplates.id, id)),
          );
        if (conflict) throw new AppError('CONFLICT', 409, `Slug "${body.slug}" already taken`);
        updateValues.slug = body.slug;
      }
      if (body.isActive !== undefined) updateValues.isActive = body.isActive;
      if (body.faceNodeId !== undefined) updateValues.faceNodeId = body.faceNodeId;
      if (body.poseNodeId !== undefined) updateValues.poseNodeId = body.poseNodeId;
      if (body.bgNodeId !== undefined) updateValues.bgNodeId = body.bgNodeId;
      if (body.upperNodeIds !== undefined) updateValues.upperNodeIds = body.upperNodeIds;
      if ('lowerNodeId' in body) updateValues.lowerNodeId = body.lowerNodeId ?? null;
      if ('shoeNodeId' in body) updateValues.shoeNodeId = body.shoeNodeId ?? null;
      if ('thirdNodeId' in body) updateValues.thirdNodeId = body.thirdNodeId ?? null;
      if ('sizeNodeIds' in body) updateValues.sizeNodeIds = body.sizeNodeIds ?? [];
      if ('latentSizeNodeIds' in body)
        updateValues.latentSizeNodeIds = body.latentSizeNodeIds ?? [];
      if (body.latentMaxPx !== undefined) updateValues.latentMaxPx = body.latentMaxPx;
      if ('outputSizeNodeIds' in body)
        updateValues.outputSizeNodeIds = body.outputSizeNodeIds ?? [];
      if (body.outputMaxPx !== undefined) updateValues.outputMaxPx = body.outputMaxPx;
      if ('resultNodeId' in body) updateValues.resultNodeId = body.resultNodeId ?? null;
      if (body.facePhasePromptNode !== undefined)
        updateValues.facePhasePromptNode = body.facePhasePromptNode;
      if (body.garmentPhasePromptNode !== undefined)
        updateValues.garmentPhasePromptNode = body.garmentPhasePromptNode;
      if (body.stage1PositivePromptNode !== undefined)
        updateValues.stage1PositivePromptNode = body.stage1PositivePromptNode;
      if (body.stage1NegativePromptNode !== undefined)
        updateValues.stage1NegativePromptNode = body.stage1NegativePromptNode;
      if ('tryonPersonNodeId' in body)
        updateValues.tryonPersonNodeId = body.tryonPersonNodeId ?? null;
      if ('tryonGarmentNodeId' in body)
        updateValues.tryonGarmentNodeId = body.tryonGarmentNodeId ?? null;
      if ('tryonGarmentNodeId2' in body)
        updateValues.tryonGarmentNodeId2 = body.tryonGarmentNodeId2 ?? null;
      if ('tryonOutputNodeId' in body)
        updateValues.tryonOutputNodeId = body.tryonOutputNodeId ?? null;
      if (body.regenerationReasonPrompts !== undefined) {
        // Trim + drop rows with a blank REASON here rather than trusting the
        // client's array verbatim — an admin backspacing a reason label to
        // empty shouldn't leave a nameless row the picker can't render. A
        // blank PROMPT is kept deliberately: it means "no override configured
        // yet" for that reason (regenerate then falls back to the original
        // prompt) — dropping it would silently erase default reasons an admin
        // hasn't gotten to yet every time they save an unrelated field.
        updateValues.regenerationReasonPrompts = body.regenerationReasonPrompts
          .map((p) => ({ reason: p.reason.trim(), prompt: p.prompt.trim() }))
          .filter((p) => p.reason.length > 0);
      }

      await app.db.transaction(async (tx) => {
        const [locked] = await tx
          .select()
          .from(schema.workflowTemplates)
          .where(eq(schema.workflowTemplates.id, id))
          .for('update');
        if (!locked) throw new AppError('NOT_FOUND', 404, 'workflow not found');

        await tx
          .update(schema.workflowTemplates)
          .set(updateValues)
          .where(eq(schema.workflowTemplates.id, id));

        await recordAudit(tx, {
          // biome-ignore lint/style/noNonNullAssertion: set by the requirePermission preHandler (guard.ts) before any handler runs
          actor: { userId: req.userId, role: req.adminRole! },
          action: 'workflow.update',
          resourceType: 'workflow',
          resourceId: id,
          before: locked,
          after: { ...locked, ...updateValues },
          request: req,
        });
      });

      return { ok: true };
    },
  );

  // POST /admin/workflows/:id/replace
  app.post(
    '/admin/workflows/:id/replace',
    {
      preHandler: W,
      schema: { params: uuidParam, body: ReplaceWorkflowBody },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const body = req.body as z.infer<typeof ReplaceWorkflowBody>;

      const [adminRow] = await app.db
        .select({ passwordHash: schema.adminUsers.passwordHash, status: schema.adminUsers.status })
        .from(schema.adminUsers)
        .where(eq(schema.adminUsers.userId, req.userId));
      if (adminRow?.status !== 'active' || !adminRow.passwordHash) {
        throw new AppError('INVALID', 401, 'invalid credentials');
      }
      if (!(await verifyPassword(adminRow.passwordHash, body.password))) {
        throw new AppError('INVALID', 401, 'invalid password');
      }

      const values = extractWorkflowInsertFields(body);

      const result = await app.db.transaction(async (tx) => {
        const [existing] = await tx
          .select()
          .from(schema.workflowTemplates)
          .where(eq(schema.workflowTemplates.id, id))
          .for('update');
        if (!existing) throw new AppError('NOT_FOUND', 404, 'workflow not found');

        const [archive] = await tx
          .select({ id: schema.workflowTemplateArchives.id })
          .from(schema.workflowTemplateArchives)
          .where(eq(schema.workflowTemplateArchives.workflowTemplateId, id))
          .limit(1);
        if (archive) {
          throw new AppError(
            'CONFLICT',
            409,
            'A previous version of this workflow is still draining. Wait for draining to complete before replacing again.',
          );
        }

        if (body.slug !== existing.slug) {
          const [conflict] = await tx
            .select({ id: schema.workflowTemplates.id })
            .from(schema.workflowTemplates)
            .where(
              and(
                eq(schema.workflowTemplates.slug, body.slug),
                ne(schema.workflowTemplates.id, id),
              ),
            );
          if (conflict) {
            throw new AppError('CONFLICT', 409, `Workflow with slug "${body.slug}" already exists`);
          }
        }

        // Only archive the outgoing version if a non-terminal job is actually
        // stamped with it — otherwise there is nothing to drain, and an
        // archive row with no job that will ever reach a terminal state would
        // sit there forever (drain-cleanup only runs off a job's terminal
        // transition, never a periodic sweep), permanently blocking the next
        // replace with a false "still draining" conflict.
        const needsDrain = await hasInFlightJobsForTemplateVersion(
          tx,
          existing.id,
          existing.version,
        );

        if (needsDrain) {
          await tx.insert(schema.workflowTemplateArchives).values({
            workflowTemplateId: existing.id,
            version: existing.version,
            jsonContent: existing.jsonContent,
            faceNodeId: existing.faceNodeId,
            poseNodeId: existing.poseNodeId,
            bgNodeId: existing.bgNodeId,
            upperNodeIds: existing.upperNodeIds,
            lowerNodeId: existing.lowerNodeId,
            shoeNodeId: existing.shoeNodeId,
            thirdNodeId: existing.thirdNodeId,
            sizeNodeIds: existing.sizeNodeIds,
            latentSizeNodeIds: existing.latentSizeNodeIds,
            latentMaxPx: existing.latentMaxPx,
            outputSizeNodeIds: existing.outputSizeNodeIds,
            outputMaxPx: existing.outputMaxPx,
            resultNodeId: existing.resultNodeId,
            facePhasePromptNode: existing.facePhasePromptNode,
            garmentPhasePromptNode: existing.garmentPhasePromptNode,
            tryonPersonNodeId: existing.tryonPersonNodeId,
            tryonGarmentNodeId: existing.tryonGarmentNodeId,
            tryonGarmentNodeId2: existing.tryonGarmentNodeId2,
            tryonOutputNodeId: existing.tryonOutputNodeId,
            stage1PositivePromptNode: existing.stage1PositivePromptNode,
            stage1NegativePromptNode: existing.stage1NegativePromptNode,
            defaultFacePhasePrompt: existing.defaultFacePhasePrompt,
            defaultGarmentPhasePrompt: existing.defaultGarmentPhasePrompt,
            defaultStage1PositivePrompt: existing.defaultStage1PositivePrompt,
            defaultStage1NegativePrompt: existing.defaultStage1NegativePrompt,
          });
        }

        const [updated] = await tx
          .update(schema.workflowTemplates)
          .set({
            ...values,
            version: existing.version + 1,
            updatedAt: new Date(),
          })
          .where(eq(schema.workflowTemplates.id, id))
          .returning();

        await recordAudit(tx, {
          // biome-ignore lint/style/noNonNullAssertion: set by the requirePermission preHandler (guard.ts) before any handler runs
          actor: { userId: req.userId, role: req.adminRole! },
          action: 'workflow.replace',
          resourceType: 'workflow',
          resourceId: id,
          before: { version: existing.version, slug: existing.slug, label: existing.label },
          after: {
            version: updated.version,
            slug: updated.slug,
            label: updated.label,
            archived: needsDrain,
          },
          request: req,
        });

        return { updated, fromVersion: existing.version, archived: needsDrain };
      });

      const [[poseCountRow], [funnelCountRow]] = await Promise.all([
        app.db
          .select({ cnt: count() })
          .from(schema.modelPoseAssets)
          .where(eq(schema.modelPoseAssets.workflowTemplateId, id)),
        app.db
          .select({ cnt: count() })
          .from(schema.shopifyFunnelTemplates)
          .where(eq(schema.shopifyFunnelTemplates.workflowTemplateId, id)),
      ]);

      return {
        ...result.updated,
        poseCount: Number(poseCountRow?.cnt ?? 0),
        funnelCount: Number(funnelCountRow?.cnt ?? 0),
        draining: result.archived ? { fromVersion: result.fromVersion } : null,
        ksamplerNodes: extractKSamplerNodes(result.updated.jsonContent as Record<string, unknown>),
      };
    },
  );

  // POST /admin/workflows/:id/reassign
  app.post(
    '/admin/workflows/:id/reassign',
    {
      preHandler: W,
      schema: { params: uuidParam, body: ReassignWorkflowBody },
    },
    async (req) => {
      const { id: sourceId } = req.params as { id: string };
      const { targetWorkflowId } = req.body as { targetWorkflowId: string };

      if (sourceId === targetWorkflowId) {
        throw new AppError('CONFLICT', 409, 'source and target workflow are the same');
      }

      const result = await app.db.transaction(async (tx) => {
        const [source] = await tx
          .select({ id: schema.workflowTemplates.id })
          .from(schema.workflowTemplates)
          .where(eq(schema.workflowTemplates.id, sourceId));
        if (!source) throw new AppError('NOT_FOUND', 404, 'source workflow not found');

        const [target] = await tx
          .select({
            id: schema.workflowTemplates.id,
            defaultGarmentPhasePrompt: schema.workflowTemplates.defaultGarmentPhasePrompt,
          })
          .from(schema.workflowTemplates)
          .where(eq(schema.workflowTemplates.id, targetWorkflowId));
        if (!target) throw new AppError('NOT_FOUND', 404, 'target workflow not found');

        const updatedRows = await tx
          .update(schema.modelPoseAssets)
          .set({
            workflowTemplateId: targetWorkflowId,
            promptGarmentPhase: target.defaultGarmentPhasePrompt ?? null,
          })
          .where(eq(schema.modelPoseAssets.workflowTemplateId, sourceId))
          .returning({ id: schema.modelPoseAssets.id });

        await recordAudit(tx, {
          // biome-ignore lint/style/noNonNullAssertion: set by the requirePermission preHandler (guard.ts) before any handler runs
          actor: { userId: req.userId, role: req.adminRole! },
          action: 'workflow.reassign',
          resourceType: 'workflow',
          resourceId: sourceId,
          after: { targetWorkflowId, updatedPoses: updatedRows.length },
          request: req,
        });

        return updatedRows;
      });

      return { ok: true, updated: result.length };
    },
  );

  // DELETE /admin/workflows/:id
  app.delete(
    '/admin/workflows/:id',
    {
      preHandler: W,
      schema: { params: uuidParam },
    },
    async (req) => {
      const { id } = req.params as { id: string };

      await app.db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(schema.workflowTemplates)
          .where(eq(schema.workflowTemplates.id, id))
          .for('update');
        if (!row) throw new AppError('NOT_FOUND', 404, 'workflow not found');

        const [poseCountRow] = await tx
          .select({ cnt: count() })
          .from(schema.modelPoseAssets)
          .where(eq(schema.modelPoseAssets.workflowTemplateId, id));
        const poseCount = Number(poseCountRow?.cnt ?? 0);
        if (poseCount > 0) {
          throw new AppError(
            'CONFLICT',
            409,
            `Cannot delete: ${poseCount} pose asset${poseCount === 1 ? '' : 's'} use this workflow. Reassign those poses first.`,
          );
        }

        const [funnelCountRow] = await tx
          .select({ cnt: count() })
          .from(schema.shopifyFunnelTemplates)
          .where(eq(schema.shopifyFunnelTemplates.workflowTemplateId, id));
        const funnelCount = Number(funnelCountRow?.cnt ?? 0);
        if (funnelCount > 0) {
          throw new AppError(
            'CONFLICT',
            409,
            `Cannot delete: ${funnelCount} Shopify funnel template${funnelCount === 1 ? '' : 's'} use this workflow. Reassign those funnel templates first.`,
          );
        }

        await tx.delete(schema.workflowTemplates).where(eq(schema.workflowTemplates.id, id));

        await recordAudit(tx, {
          // biome-ignore lint/style/noNonNullAssertion: set by the requirePermission preHandler (guard.ts) before any handler runs
          actor: { userId: req.userId, role: req.adminRole! },
          action: 'workflow.delete',
          resourceType: 'workflow',
          resourceId: id,
          // Omit jsonContent — the full ComfyUI workflow blob doesn't belong in an
          // audit-log payload.
          before: { id: row.id, slug: row.slug, label: row.label, workflowType: row.workflowType },
          request: req,
        });
      });

      return { ok: true };
    },
  );
}
