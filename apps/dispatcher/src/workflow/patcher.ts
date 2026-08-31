import type { DB, schema } from '@tryme/db';
import { ASPECT_DIMENSIONS } from '@tryme/types';
import { resizeToMax } from './resize-to-max.js';
import { resolveWorkflowTemplateVersion } from './resolve-template-version.js';

type WorkflowNode = { inputs: Record<string, unknown>; class_type: string; _meta?: unknown };
type Workflow = Record<string, WorkflowNode>;

// ── Template loading ──────────────────────────────────────────────────────

async function loadWorkflow(
  db: DB,
  workflowTemplateId: string,
  snapshotVersion: number | null | undefined,
): Promise<typeof schema.workflowTemplates.$inferSelect> {
  const record = await resolveWorkflowTemplateVersion(db, workflowTemplateId, snapshotVersion);

  if (!record) {
    throw new Error(`Workflow template "${workflowTemplateId}" not found in database`);
  }

  return record;
}

// ── Patch helpers ─────────────────────────────────────────────────────────

function requireNode(workflow: Workflow, nodeId: string, role: string): WorkflowNode {
  const node = workflow[nodeId];
  if (!node) {
    throw new Error(
      `Workflow node "${nodeId}" (${role}) not found in JSON — ` +
        `the stored workflow JSON may be out of sync with its node mappings`,
    );
  }
  return node;
}

// ── Aspect ratio dimensions ───────────────────────────────────────────────

export { ASPECT_DIMENSIONS };

// ── Public interface ──────────────────────────────────────────────────────

export interface WorkflowInputs {
  workflowTemplateId: string;
  poseFile: string;
  upperGarmentFile?: string;
  faceSideFile?: string;
  backgroundFile?: string;
  lowerGarmentFile?: string;
  shoeGarmentFile?: string;
  thirdGarmentFile?: string;
  promptFacePhase?: string;
  promptGarmentPhase?: string;
  aspectRatio?: string;
  /** Custom pixel dimensions from the user — when present, override the
   *  ASPECT_DIMENSIONS enum lookup so the exact requested resolution is used. */
  outputWidth?: number;
  outputHeight?: number;
}

export type WorkflowTemplate = typeof schema.workflowTemplates.$inferSelect;
type PatchLog = { warn: (msg: string, ...args: unknown[]) => void };

/**
 * Pure patch function — takes the already-loaded template record and a deep-cloned
 * workflow JSON, applies all node substitutions, and returns the patched workflow.
 * Exported for unit testing without a database dependency.
 */
export function applyWorkflowPatch(
  workflow: Workflow,
  tmpl: WorkflowTemplate,
  inputs: Omit<WorkflowInputs, 'workflowTemplateId'>,
  log?: PatchLog,
): Record<string, unknown> {
  // Required image nodes — throw if any are missing from the JSON
  if (tmpl.faceNodeId) {
    if (!inputs.faceSideFile) {
      throw new Error(`Workflow "${tmpl.slug}" maps a face node but no face image was provided`);
    }
    requireNode(workflow, tmpl.faceNodeId, 'face').inputs.image = inputs.faceSideFile;
  }
  requireNode(workflow, tmpl.poseNodeId, 'pose').inputs.image = inputs.poseFile;
  if (tmpl.bgNodeId) {
    if (!inputs.backgroundFile) {
      throw new Error(
        `Workflow "${tmpl.slug}" maps a background node but no background image was provided`,
      );
    }
    requireNode(workflow, tmpl.bgNodeId, 'bg').inputs.image = inputs.backgroundFile;
  }

  // Upper garment — patch all mapped nodes
  if (tmpl.upperNodeIds.length > 0) {
    if (!inputs.upperGarmentFile) {
      throw new Error(
        `Workflow "${tmpl.slug}" maps ${tmpl.upperNodeIds.length} upper garment node(s) but no upper garment image was provided`,
      );
    }
    for (const uid of tmpl.upperNodeIds) {
      requireNode(workflow, uid, 'upper garment').inputs.image = inputs.upperGarmentFile;
    }
  }

  // Every mapped role must receive its own file; never reuse another role's image.
  if (tmpl.lowerNodeId) {
    if (!inputs.lowerGarmentFile) {
      throw new Error(
        `Workflow "${tmpl.slug}" maps a lower garment node but no lower garment image was provided`,
      );
    }
    requireNode(workflow, tmpl.lowerNodeId, 'lower garment').inputs.image = inputs.lowerGarmentFile;
  } else if (inputs.lowerGarmentFile) {
    log?.warn(
      `patchWorkflow: lower garment provided but workflow "${tmpl.slug}" has no lower_node_id — skipping`,
    );
  }

  if (tmpl.shoeNodeId) {
    if (!inputs.shoeGarmentFile) {
      throw new Error(`Workflow "${tmpl.slug}" maps a shoe node but no shoe image was provided`);
    }
    requireNode(workflow, tmpl.shoeNodeId, 'shoes').inputs.image = inputs.shoeGarmentFile;
  } else if (inputs.shoeGarmentFile) {
    log?.warn(
      `patchWorkflow: shoe garment provided but workflow "${tmpl.slug}" has no shoe_node_id — skipping`,
    );
  }

  if (tmpl.thirdNodeId) {
    if (!inputs.thirdGarmentFile) {
      throw new Error(
        `Workflow "${tmpl.slug}" maps a third node but no third garment image was provided`,
      );
    }
    requireNode(workflow, tmpl.thirdNodeId, 'third garment').inputs.image = inputs.thirdGarmentFile;
  } else if (inputs.thirdGarmentFile) {
    log?.warn(
      `patchWorkflow: third garment provided but workflow "${tmpl.slug}" has no third_node_id — skipping`,
    );
  }

  // Positive prompt — only override when pose provides a non-empty, non-whitespace string.
  // Empty or whitespace-only strings are skipped so the workflow's hardcoded default is preserved.
  // Whitespace-only prompts would cause ComfyUI to reject the submission (same as empty string).
  const promptNode = workflow[tmpl.garmentPhasePromptNode];
  if (inputs.promptGarmentPhase?.trim() && promptNode) {
    promptNode.inputs.prompt = inputs.promptGarmentPhase;
  }
  // Negative prompt (facePhasePromptNode) is never overridden — hardcoded per workflow.

  // Resolve output dimensions: custom pixel dims take precedence over the
  // ASPECT_DIMENSIONS enum lookup. Custom dims come from the user's explicit
  // width/height selection in the studio; enum dims are the predefined values
  // for each of the four standard aspect ratios.
  const customDims =
    inputs.outputWidth && inputs.outputHeight
      ? { width: inputs.outputWidth, height: inputs.outputHeight }
      : null;
  const enumDims = inputs.aspectRatio ? (ASPECT_DIMENSIONS[inputs.aspectRatio] ?? null) : null;
  const outputDims = customDims ?? enumDims;

  // Dual-size-group templates. Latent group (max-width/max-height) is derived from the
  // raw aspect numbers via resizeToMax, capped at latentMaxPx — this is the diffusion
  // canvas size and doesn't need to match any fixed enum value. Output group (result-width/
  // result-height) uses the resolved outputDims directly — the max-output-resolution ceiling
  // is a product/pricing decision enforced once, globally, by the API before enqueue
  // (see getMaxOutputPx in apps/api), not a per-template technical constraint like latentMaxPx.
  const latentSizeNodeIds = tmpl.latentSizeNodeIds ?? [];
  const outputSizeNodeIds = tmpl.outputSizeNodeIds ?? [];
  if (outputDims && (latentSizeNodeIds.length === 2 || outputSizeNodeIds.length === 2)) {
    // Latent: scale so the long edge = latentMaxPx, preserving aspect
    const latentMax = tmpl.latentMaxPx ?? 2048;
    const latentDims = resizeToMax(outputDims.width, outputDims.height, latentMax);
    const [lwId, lhId] = latentSizeNodeIds;
    const lwNode = lwId ? workflow[lwId] : undefined;
    const lhNode = lhId ? workflow[lhId] : undefined;
    if (lwNode) lwNode.inputs.value = latentDims.width;
    if (lhNode) lhNode.inputs.value = latentDims.height;

    if (outputSizeNodeIds.length === 2) {
      const [widthId, heightId] = outputSizeNodeIds;
      const wNode = widthId ? workflow[widthId] : undefined;
      const hNode = heightId ? workflow[heightId] : undefined;
      if (wNode) wNode.inputs.value = outputDims.width;
      if (hNode) hNode.inputs.value = outputDims.height;
    }
  } else if (outputDims && tmpl.sizeNodeIds.length > 0) {
    // Legacy single-group: patch all size-controlling nodes by class_type.
    // sizeNodeIds[0] = width node, sizeNodeIds[1] = height node.
    for (let i = 0; i < tmpl.sizeNodeIds.length; i++) {
      const nodeId = tmpl.sizeNodeIds[i];
      if (!nodeId) continue;
      const node = workflow[nodeId];
      if (!node) continue;
      const dimValue = i === 0 ? outputDims.width : outputDims.height;
      if (node.class_type === 'PrimitiveInt') {
        node.inputs.value = dimValue;
      } else if (node.class_type === 'ResizeImageMaskNode') {
        node.inputs['resize_type.width'] = outputDims.width;
        node.inputs['resize_type.height'] = outputDims.height;
      } else if (node.class_type === 'ResizeAndPadImage') {
        node.inputs.target_width = outputDims.width;
        node.inputs.target_height = outputDims.height;
      } else {
        // EmptyLatentImage and generic fallback
        node.inputs.width = outputDims.width;
        node.inputs.height = outputDims.height;
      }
    }
  } else if (inputs.aspectRatio) {
    log?.warn(
      `patchWorkflow: no dimensions resolved for aspectRatio "${inputs.aspectRatio}" — skipping size patch`,
    );
  }

  return workflow as unknown as Record<string, unknown>;
}

export interface PatchedWorkflow {
  prompt: Record<string, unknown>;
  resultNodeId: string | null;
}

/**
 * Loads the workflow template from the DB — the live row, or a specific
 * archived version if `snapshotVersion` no longer matches the live template's
 * current version — deep-clones the JSON, and delegates to applyWorkflowPatch.
 */
export async function patchWorkflow(
  inputs: WorkflowInputs,
  db: DB,
  log?: PatchLog,
  snapshotVersion?: number | null,
): Promise<PatchedWorkflow> {
  const tmpl = await loadWorkflow(db, inputs.workflowTemplateId, snapshotVersion);
  const workflow = JSON.parse(JSON.stringify(tmpl.jsonContent)) as Workflow;
  const prompt = applyWorkflowPatch(workflow, tmpl, inputs, log);
  return { prompt, resultNodeId: tmpl.resultNodeId };
}
