// Tryon workflow node auto-detection. Independent of the regular detectMappings
// because the tryon JSON breaks all of its assumptions:
//   - output node class_type is "Save Image With Callback", not "SaveImage"
//   - prompt nodes feed ControlNetInpaintingAliMamaApply.positive/.negative,
//     not KSampler.positive/.negative directly
//   - input titles are "person"/"garment", not "face"/"upper_garment"
import { classifyNode, normaliseTitle, type ParsedNode } from './workflow-detect.js';

const PERSON_TITLES = new Set(['person', 'face']);
const GARMENT_TITLES = new Set(['garment', 'upper_garment', 'saree', 'flat_saree']);

export interface DetectedTryonMappings {
  personNodeId?: string;
  garmentNodeId?: string;
  outputNodeId?: string;
  positivePromptNode?: string;
  negativePromptNode?: string;
  defaultPositivePrompt: string;
  defaultNegativePrompt: string;
}

type WorkflowNode = {
  class_type?: string;
  _meta?: { title?: string };
  inputs?: Record<string, unknown>;
};

function promptText(node: WorkflowNode | undefined): string {
  const inputs = node?.inputs;
  return (inputs?.prompt as string | undefined) ?? (inputs?.text as string | undefined) ?? '';
}

// nodeId → list of {consumerId, inputName} that link FROM this node.
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

export function detectTryonMappings(json: Record<string, unknown>): {
  detected: DetectedTryonMappings;
  allImageNodes: ParsedNode[];
  allPromptNodes: ParsedNode[];
} {
  const detected: DetectedTryonMappings = {
    defaultPositivePrompt: '',
    defaultNegativePrompt: '',
  };
  const allImageNodes: ParsedNode[] = [];
  const allPromptNodes: ParsedNode[] = [];

  // ── Pass 1: title / class_type detection ─────────────────────────────────
  for (const [nodeId, raw] of Object.entries(json)) {
    const node = raw as WorkflowNode;
    if (!node?.class_type) continue;
    const classType = node.class_type;
    const title = node._meta?.title ?? nodeId;
    const norm = normaliseTitle(title);
    const category = classifyNode(classType);

    if (category === 'image') {
      allImageNodes.push({ id: nodeId, class_type: classType, title, category });
      if (PERSON_TITLES.has(norm)) detected.personNodeId = nodeId;
      else if (GARMENT_TITLES.has(norm)) detected.garmentNodeId = nodeId;
    } else if (category === 'prompt') {
      allPromptNodes.push({ id: nodeId, class_type: classType, title, category });
      if (norm === 'positive_prompt') detected.positivePromptNode = nodeId;
      else if (norm === 'negative_prompt') detected.negativePromptNode = nodeId;
    }

    // Output: class_type contains "Save Image" (matches "Save Image With Callback").
    if (!detected.outputNodeId && classType.includes('Save Image')) {
      detected.outputNodeId = nodeId;
    }
  }

  // Fallback: a single SaveImage node when no "Save Image*" custom node matched.
  if (!detected.outputNodeId) {
    for (const [nodeId, raw] of Object.entries(json)) {
      if ((raw as WorkflowNode)?.class_type === 'SaveImage') {
        detected.outputNodeId = nodeId;
        break;
      }
    }
  }

  // Fallback: if exactly one garment isn't titled, the non-garment image is person.
  if (!detected.personNodeId) {
    const candidate = allImageNodes.find((n) => n.id !== detected.garmentNodeId);
    if (candidate) detected.personNodeId = candidate.id;
  }

  // ── Pass 2: connection-based prompt detection ────────────────────────────
  // A prompt node feeding any consumer input named "positive"/"negative" — works
  // for ControlNet AND KSampler (regular detector requires a Sampler; tryon does not).
  if (!detected.positivePromptNode || !detected.negativePromptNode) {
    const rev = buildReverseLinks(json);
    for (const node of allPromptNodes) {
      if (detected.positivePromptNode && detected.negativePromptNode) break;
      for (const { inputName } of rev.get(node.id) ?? []) {
        if (inputName === 'positive' && !detected.positivePromptNode) {
          detected.positivePromptNode = node.id;
        } else if (inputName === 'negative' && !detected.negativePromptNode) {
          detected.negativePromptNode = node.id;
        }
      }
    }
  }

  if (detected.positivePromptNode) {
    detected.defaultPositivePrompt = promptText(json[detected.positivePromptNode] as WorkflowNode);
  }
  if (detected.negativePromptNode) {
    detected.defaultNegativePrompt = promptText(json[detected.negativePromptNode] as WorkflowNode);
  }

  allImageNodes.sort((a, b) => a.title.localeCompare(b.title));
  allPromptNodes.sort((a, b) => a.title.localeCompare(b.title));

  return { detected, allImageNodes, allPromptNodes };
}
