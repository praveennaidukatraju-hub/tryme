// Two-stage workflow node auto-detection ("build a person from pose+face+
// background, then dress that person in the garment" — two KSamplers in one
// ComfyUI graph). Unlike detectMappings/detectTryonMappings, prompt detection
// here does NOT rely on positive_prompt/negative_prompt titles at all: with
// two KSamplers in the graph, a single "negative_prompt" title is ambiguous
// (it could belong to either stage) and a naive "first Sampler-wired prompt
// found in file order" fallback picks the wrong stage as often as the right
// one — this is exactly what broke on the first real two-stage upload.
//
// Instead this walks the graph backward from the output node, through any
// post-processing (Color Correct, etc.) and the VAEDecode, to the nearest
// upstream KSampler — that KSampler's positive/negative inputs are, by
// construction, the ones that actually produced the delivered image (stage 2).
// The other KSampler in the graph is assumed to be stage 1.
import { classifyNode, normaliseTitle, type ParsedNode } from './workflow-detect.js';

export interface DetectedTwoStageMappings {
  faceNodeId?: string;
  poseNodeId?: string;
  bgNodeId?: string;
  garmentNodeId?: string;
  outputNodeId?: string;
  stage1PositivePromptNode?: string;
  stage1NegativePromptNode?: string;
  stage2PositivePromptNode?: string;
  stage2NegativePromptNode?: string;
  sizeNodeIds: string[];
  defaultStage1PositivePrompt: string;
  defaultStage1NegativePrompt: string;
  defaultStage2PositivePrompt: string;
  defaultStage2NegativePrompt: string;
}

type WorkflowNode = {
  class_type?: string;
  _meta?: { title?: string };
  inputs?: Record<string, unknown>;
};

const SIZE_CLASS_TYPES = new Set([
  'EmptyLatentImage',
  'ResizeImageMaskNode',
  'ResizeAndPadImage',
  'ImageResizeKJ',
  'LatentUpscaleBy',
]);

// ponytail: linear chain only (each node has at most one image-carrying input
// we follow) — matches every known two-stage graph (SaveImage <- post-process
// <- VAEDecode <- KSampler). A graph that composites two branches before the
// final Sampler would need a real multi-parent walk; not needed yet.
const IMAGE_CHAIN_KEYS = ['images', 'image', 'samples'];

function isLink(val: unknown): val is [string, number] {
  return Array.isArray(val) && val.length === 2 && typeof val[0] === 'string';
}

function isSampler(classType: string | undefined): boolean {
  return (classType ?? '').toLowerCase().includes('sampler');
}

function findUpstreamSampler(
  json: Record<string, unknown>,
  startId: string,
  maxHops = 20,
): string | undefined {
  let currentId: string | undefined = startId;
  const visited = new Set<string>();
  for (let i = 0; i < maxHops && currentId; i++) {
    if (visited.has(currentId)) return undefined;
    visited.add(currentId);
    const node = json[currentId] as WorkflowNode | undefined;
    if (!node?.class_type) return undefined;
    if (isSampler(node.class_type)) return currentId;

    let nextId: string | undefined;
    for (const key of IMAGE_CHAIN_KEYS) {
      const val = node.inputs?.[key];
      if (isLink(val)) {
        nextId = val[0];
        break;
      }
    }
    currentId = nextId;
  }
  return undefined;
}

function promptText(node: WorkflowNode | undefined): string {
  const inputs = node?.inputs;
  return (inputs?.prompt as string | undefined) ?? (inputs?.text as string | undefined) ?? '';
}

function samplerPromptNodes(
  json: Record<string, unknown>,
  samplerId: string | undefined,
): { positive?: string; negative?: string } {
  if (!samplerId) return {};
  const node = json[samplerId] as WorkflowNode | undefined;
  const positive = node?.inputs?.positive;
  const negative = node?.inputs?.negative;
  return {
    positive: isLink(positive) ? positive[0] : undefined,
    negative: isLink(negative) ? negative[0] : undefined,
  };
}

export function detectTwoStageMappings(json: Record<string, unknown>): {
  detected: DetectedTwoStageMappings;
  allImageNodes: ParsedNode[];
  allPromptNodes: ParsedNode[];
} {
  const detected: DetectedTwoStageMappings = {
    sizeNodeIds: [],
    defaultStage1PositivePrompt: '',
    defaultStage1NegativePrompt: '',
    defaultStage2PositivePrompt: '',
    defaultStage2NegativePrompt: '',
  };
  const allImageNodes: ParsedNode[] = [];
  const allPromptNodes: ParsedNode[] = [];
  const allLatentNodes: ParsedNode[] = [];
  const samplerIds: string[] = [];

  for (const [nodeId, raw] of Object.entries(json)) {
    const node = raw as WorkflowNode;
    if (!node?.class_type) continue;
    const classType = node.class_type;
    const title = node._meta?.title ?? nodeId;
    const norm = normaliseTitle(title);
    const category = classifyNode(classType);

    if (category === 'image') {
      allImageNodes.push({ id: nodeId, class_type: classType, title, category });
      if (norm === 'face') detected.faceNodeId = nodeId;
      else if (norm === 'pose') detected.poseNodeId = nodeId;
      else if (norm === 'background' || norm === 'bg') detected.bgNodeId = nodeId;
      else if (norm === 'garment') detected.garmentNodeId = nodeId;
    } else if (category === 'prompt') {
      allPromptNodes.push({ id: nodeId, class_type: classType, title, category });
    } else if (SIZE_CLASS_TYPES.has(classType)) {
      allLatentNodes.push({ id: nodeId, class_type: classType, title, category: 'latent' });
    }

    if (!detected.outputNodeId && classType.includes('Save Image')) {
      detected.outputNodeId = nodeId;
    }
    if (isSampler(classType)) samplerIds.push(nodeId);
  }

  if (!detected.outputNodeId) {
    for (const [nodeId, raw] of Object.entries(json)) {
      if ((raw as WorkflowNode)?.class_type === 'SaveImage') {
        detected.outputNodeId = nodeId;
        break;
      }
    }
  }

  detected.sizeNodeIds = allLatentNodes.map((n) => n.id);

  // Stage 2 — the KSampler nearest the actual output, found by walking
  // backward through post-processing and VAEDecode. Its prompts are correct
  // by construction, regardless of title.
  const stage2SamplerId = detected.outputNodeId
    ? findUpstreamSampler(json, detected.outputNodeId)
    : undefined;
  const stage2Prompts = samplerPromptNodes(json, stage2SamplerId);
  detected.stage2PositivePromptNode = stage2Prompts.positive;
  detected.stage2NegativePromptNode = stage2Prompts.negative;

  // Stage 1 — ponytail: assumes exactly one other Sampler in the graph (every
  // known two-stage template has exactly 2). More than one leftover Sampler
  // is out of scope for this type; stage1 fields just stay undefined.
  const otherSamplers = samplerIds.filter((id) => id !== stage2SamplerId);
  if (otherSamplers.length === 1) {
    const stage1Prompts = samplerPromptNodes(json, otherSamplers[0]);
    detected.stage1PositivePromptNode = stage1Prompts.positive;
    detected.stage1NegativePromptNode = stage1Prompts.negative;
  }

  detected.defaultStage1PositivePrompt = promptText(
    json[detected.stage1PositivePromptNode ?? ''] as WorkflowNode | undefined,
  );
  detected.defaultStage1NegativePrompt = promptText(
    json[detected.stage1NegativePromptNode ?? ''] as WorkflowNode | undefined,
  );
  detected.defaultStage2PositivePrompt = promptText(
    json[detected.stage2PositivePromptNode ?? ''] as WorkflowNode | undefined,
  );
  detected.defaultStage2NegativePrompt = promptText(
    json[detected.stage2NegativePromptNode ?? ''] as WorkflowNode | undefined,
  );

  allImageNodes.sort((a, b) => a.title.localeCompare(b.title));
  allPromptNodes.sort((a, b) => a.title.localeCompare(b.title));

  return { detected, allImageNodes, allPromptNodes };
}
