// Saree workflow node auto-detection.
//
// Wraps the existing tryon-detect logic — both flows are structurally identical:
// two LoadImage inputs ("person" + "garment/saree") and a single SaveImage output
// with positive/negative prompts feeding a sampler. The only delta is that the
// saree flow titles the user-uploaded image "flatsaree" (or "saree") and we
// surface the person input as `modelImageNode` to make the static/admin
// distinction explicit at the call site.

import { classifyNode, normaliseTitle, type ParsedNode } from './workflow-detect.js';

export interface DetectedSareeMappings {
  modelImageNode: string | null;
  sareeImageNode: string | null;
  outputNode: string | null;
  positivePromptNode: string | null;
  negativePromptNode: string | null;
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

// Map a normalised LoadImage title to the saree slot. `garment` is the canonical
// tryon term; `saree` and `flatsaree` are saree-specific synonyms. The saree
// detector exposes `sareeImageNode` (user-uploaded) and `modelImageNode` (the
// static "person" image set by admin).
function isSareeTitle(norm: string): boolean {
  return norm === 'garment' || norm === 'saree' || norm === 'flatsaree';
}

function isModelTitle(norm: string): boolean {
  return norm === 'person' || norm === 'model';
}

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

export function detectSareeMappings(json: Record<string, unknown>): {
  detected: DetectedSareeMappings;
  allImageNodes: ParsedNode[];
  allPromptNodes: ParsedNode[];
} {
  const detected: DetectedSareeMappings = {
    modelImageNode: null,
    sareeImageNode: null,
    outputNode: null,
    positivePromptNode: null,
    negativePromptNode: null,
    defaultPositivePrompt: '',
    defaultNegativePrompt: '',
  };
  const allImageNodes: ParsedNode[] = [];
  const allPromptNodes: ParsedNode[] = [];

  // Pass 1: title / class_type detection
  for (const [nodeId, raw] of Object.entries(json)) {
    const node = raw as WorkflowNode;
    if (!node?.class_type) continue;
    const classType = node.class_type;
    const title = node._meta?.title ?? nodeId;
    const norm = normaliseTitle(title);
    const category = classifyNode(classType);

    if (category === 'image') {
      allImageNodes.push({ id: nodeId, class_type: classType, title, category });
      if (isModelTitle(norm)) detected.modelImageNode = nodeId;
      else if (isSareeTitle(norm)) detected.sareeImageNode = nodeId;
    } else if (category === 'prompt') {
      allPromptNodes.push({ id: nodeId, class_type: classType, title, category });
      if (norm === 'positive_prompt') detected.positivePromptNode = nodeId;
      else if (norm === 'negative_prompt') detected.negativePromptNode = nodeId;
    }

    if (!detected.outputNode && classType.includes('Save Image')) {
      detected.outputNode = nodeId;
    }
  }

  // Fallback: a single SaveImage node when no "Save Image*" custom node matched.
  if (!detected.outputNode) {
    for (const [nodeId, raw] of Object.entries(json)) {
      if ((raw as WorkflowNode)?.class_type === 'SaveImage') {
        detected.outputNode = nodeId;
        break;
      }
    }
  }

  // Fallback: if exactly one of the two image slots is missing a title match,
  // the un-titled image is the missing slot.
  if (!detected.modelImageNode) {
    const candidate = allImageNodes.find((n) => n.id !== detected.sareeImageNode);
    if (candidate) detected.modelImageNode = candidate.id;
  } else if (!detected.sareeImageNode) {
    const candidate = allImageNodes.find((n) => n.id !== detected.modelImageNode);
    if (candidate) detected.sareeImageNode = candidate.id;
  }

  // Pass 2: connection-based prompt detection
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
