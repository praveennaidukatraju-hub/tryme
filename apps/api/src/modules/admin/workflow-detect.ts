// Pure workflow node auto-detection — extracted here so it can be unit-tested
// without spinning up a Fastify instance or database.
//
// Detection strategy (two passes):
//   Pass 1 — title matching (set _meta.title in ComfyUI):
//     LoadImage titles: face, pose, background/bg, upper_garment[_N],
//                       lower_garment, shoes/shoe
//     TextEncode titles: positive_prompt, negative_prompt
//     Latent titles: size, empty_latent_image (or auto-assigned by class_type)
//     Dual-size-group titles (build_model_main v2+): max-width/max-height
//                       (latent group), result-width/result-height (output group)
//     SaveImage titles: when more than one SaveImage(type=output) node exists,
//                       the one whose title contains "customer" is the deliverable
//                       result — disambiguates the transitional "model-result" +
//                       "customer-result-image" pair until templates drop the former.
//
//   Pass 2 — connection-based fallback for anything unresolved after pass 1:
//     positive_prompt: TextEncode node whose output → KSampler*.positive
//     negative_prompt: TextEncode node whose output → KSampler*.negative
//
// Number of LoadImage inputs varies by workflow (closeup has no lower/shoes,
// twopiece has both). Absent roles produce undefined — patcher handles nulls.

export type NodeCategory = 'image' | 'prompt' | 'latent' | 'other';

export interface ParsedNode {
  id: string;
  class_type: string;
  title: string;
  category: NodeCategory;
}

export interface DetectedMappings {
  faceNodeId?: string;
  poseNodeId?: string;
  bgNodeId?: string;
  upperNodeIds: string[];
  lowerNodeId?: string;
  shoeNodeId?: string;
  sizeNodeIds: string[];
  positivePromptNode?: string;
  negativePromptNode?: string;
  latentSizeNodeIds: string[]; // [widthNodeId, heightNodeId] — dual-size-group templates only
  outputSizeNodeIds: string[]; // [widthNodeId, heightNodeId] — dual-size-group templates only
  resultNodeId?: string; // disambiguates multiple SaveImage(type=output) nodes
}

// Node class_types that control output dimensions (EmptyLatentImage + resize nodes)
const SIZE_CLASS_TYPES = new Set([
  'EmptyLatentImage',
  'ResizeImageMaskNode',
  'ResizeAndPadImage',
  'ImageResizeKJ',
  'LatentUpscaleBy',
]);

export function classifyNode(classType: string): NodeCategory {
  if (classType === 'LoadImage') return 'image';
  if (classType.includes('TextEncode')) return 'prompt';
  if (SIZE_CLASS_TYPES.has(classType)) return 'latent';
  return 'other';
}

export function normaliseTitle(title: string): string {
  return title
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

type WorkflowNode = {
  class_type?: string;
  _meta?: { title?: string };
  inputs?: Record<string, unknown>;
};

// Build reverse link map: nodeId → [{consumerId, inputName}]
// ComfyUI API format encodes links as [sourceNodeId, outputIndex] arrays.
function buildReverseLinks(
  json: Record<string, unknown>,
): Map<string, { consumerId: string; inputName: string }[]> {
  const rev = new Map<string, { consumerId: string; inputName: string }[]>();
  for (const [consumerId, raw] of Object.entries(json)) {
    const node = raw as WorkflowNode;
    if (!node?.inputs) continue;
    for (const [inputName, val] of Object.entries(node.inputs)) {
      if (Array.isArray(val) && val.length === 2 && typeof val[0] === 'string') {
        const srcId = val[0] as string;
        if (!rev.has(srcId)) rev.set(srcId, []);
        rev.get(srcId)?.push({ consumerId, inputName });
      }
    }
  }
  return rev;
}

export function detectMappings(json: Record<string, unknown>): {
  detected: DetectedMappings;
  allImageNodes: ParsedNode[];
  allPromptNodes: ParsedNode[];
  allLatentNodes: ParsedNode[];
} {
  const detected: DetectedMappings = {
    upperNodeIds: [],
    sizeNodeIds: [],
    latentSizeNodeIds: [],
    outputSizeNodeIds: [],
  };
  const allImageNodes: ParsedNode[] = [];
  const allPromptNodes: ParsedNode[] = [];
  const allLatentNodes: ParsedNode[] = [];
  const saveImageNodes: ParsedNode[] = [];

  let maxWidthId: string | undefined;
  let maxHeightId: string | undefined;
  let resultWidthId: string | undefined;
  let resultHeightId: string | undefined;

  // ── Pass 1: title-based detection ────────────────────────────────────────
  for (const [nodeId, raw] of Object.entries(json)) {
    const node = raw as WorkflowNode;
    if (!node?.class_type) continue;
    const classType = node.class_type;
    const title = node._meta?.title ?? nodeId;
    const norm = normaliseTitle(title);
    const category = classifyNode(classType);

    if (category === 'image') {
      allImageNodes.push({ id: nodeId, class_type: classType, title, category });
      if (norm === 'face') {
        detected.faceNodeId = nodeId;
      } else if (norm === 'pose') {
        detected.poseNodeId = nodeId;
      } else if (norm === 'background' || norm === 'bg') {
        detected.bgNodeId = nodeId;
      } else if (norm === 'upper_garment' || /^upper_garment_\d+$/.test(norm)) {
        detected.upperNodeIds.push(nodeId);
      } else if (norm === 'lower_garment') {
        detected.lowerNodeId = nodeId;
      } else if (norm === 'shoes' || norm === 'shoe') {
        detected.shoeNodeId = nodeId;
      }
    } else if (category === 'prompt') {
      allPromptNodes.push({ id: nodeId, class_type: classType, title, category });
      if (norm === 'positive_prompt') {
        detected.positivePromptNode = nodeId;
      } else if (norm === 'negative_prompt') {
        detected.negativePromptNode = nodeId;
      }
    } else if (category === 'latent') {
      allLatentNodes.push({ id: nodeId, class_type: classType, title, category });
    }

    // Dual-size-group titles — independent of class_type (these are PrimitiveInt
    // nodes, not classified 'latent' by classifyNode).
    if (norm === 'max_width') maxWidthId = nodeId;
    else if (norm === 'max_height') maxHeightId = nodeId;
    else if (norm === 'result_width') resultWidthId = nodeId;
    else if (norm === 'result_height') resultHeightId = nodeId;

    if (classType === 'SaveImage') {
      saveImageNodes.push({ id: nodeId, class_type: classType, title, category: 'other' });
    }
  }

  if (maxWidthId && maxHeightId) detected.latentSizeNodeIds = [maxWidthId, maxHeightId];
  if (resultWidthId && resultHeightId) detected.outputSizeNodeIds = [resultWidthId, resultHeightId];

  // Multiple SaveImage nodes — prefer the one whose title contains "customer"
  // (the deliverable result) over a raw/intermediate one (e.g. "model-result").
  if (saveImageNodes.length > 1) {
    const customerNode = saveImageNodes.find((n) => normaliseTitle(n.title).includes('customer'));
    if (customerNode) detected.resultNodeId = customerNode.id;
  }

  // ── Pass 2: connection-based fallback for unresolved prompt nodes ─────────
  // Find TextEncode nodes whose output feeds into a KSampler* node as
  // 'positive' or 'negative' — reliable regardless of node title.
  if (!detected.positivePromptNode || !detected.negativePromptNode) {
    const rev = buildReverseLinks(json);
    for (const node of allPromptNodes) {
      if (detected.positivePromptNode && detected.negativePromptNode) break;
      const links = rev.get(node.id) ?? [];
      for (const { consumerId, inputName } of links) {
        const consumer = json[consumerId] as WorkflowNode | undefined;
        const consumerClass = consumer?.class_type ?? '';
        if (!consumerClass.includes('Sampler') && !consumerClass.includes('sampler')) continue;
        if (inputName === 'positive' && !detected.positivePromptNode) {
          detected.positivePromptNode = node.id;
        } else if (inputName === 'negative' && !detected.negativePromptNode) {
          detected.negativePromptNode = node.id;
        }
      }
    }
  }

  allImageNodes.sort((a, b) => a.title.localeCompare(b.title));
  allPromptNodes.sort((a, b) => a.title.localeCompare(b.title));
  allLatentNodes.sort((a, b) => a.title.localeCompare(b.title));

  // Always use ALL latent nodes as sizeNodeIds — EXCEPT for dual-size-group
  // templates, where the real patch targets are the PrimitiveInt nodes already
  // captured in latentSizeNodeIds/outputSizeNodeIds. Auto-filling sizeNodeIds
  // here too would surface unrelated ResizeAndPadImage/EmptyLatentImage nodes
  // (e.g. internal garment-resize steps) as if they were output-size candidates.
  const isDualSizeGroupTemplate =
    detected.latentSizeNodeIds.length === 2 && detected.outputSizeNodeIds.length === 2;
  detected.sizeNodeIds = isDualSizeGroupTemplate ? [] : allLatentNodes.map((n) => n.id);

  return { detected, allImageNodes, allPromptNodes, allLatentNodes };
}
