// Saree two-input (body + pallu) step-1 mannequin workflow node auto-detection.
// Structurally identical to detectTryonMappings (tryon-detect.ts) except it has
// a third image input: person/face, body, and pallu, each a separate LoadImage.
import { classifyNode, normaliseTitle, type ParsedNode } from './workflow-detect.js';

const PERSON_TITLES = new Set(['person', 'face']);
const BODY_TITLES = new Set(['body', 'garment', 'upper_garment', 'saree', 'flat_saree']);
const PALLU_TITLES = new Set(['pallu', 'palu']);

export interface DetectedTryonTwoInputMappings {
  personNodeId?: string;
  bodyNodeId?: string;
  palluNodeId?: string;
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

export function detectTryonTwoInputMappings(json: Record<string, unknown>): {
  detected: DetectedTryonTwoInputMappings;
  allImageNodes: ParsedNode[];
  allPromptNodes: ParsedNode[];
} {
  const detected: DetectedTryonTwoInputMappings = {
    defaultPositivePrompt: '',
    defaultNegativePrompt: '',
  };
  const allImageNodes: ParsedNode[] = [];
  const allPromptNodes: ParsedNode[] = [];

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
      else if (PALLU_TITLES.has(norm)) detected.palluNodeId = nodeId;
      else if (BODY_TITLES.has(norm)) detected.bodyNodeId = nodeId;
    } else if (category === 'prompt') {
      allPromptNodes.push({ id: nodeId, class_type: classType, title, category });
      if (norm === 'positive_prompt') detected.positivePromptNode = nodeId;
      else if (norm === 'negative_prompt') detected.negativePromptNode = nodeId;
    }

    if (!detected.outputNodeId && classType.includes('Save Image')) {
      detected.outputNodeId = nodeId;
    }
  }

  if (!detected.outputNodeId) {
    for (const [nodeId, raw] of Object.entries(json)) {
      if ((raw as WorkflowNode)?.class_type === 'SaveImage') {
        detected.outputNodeId = nodeId;
        break;
      }
    }
  }

  // Fallback: if person isn't titled, and exactly one image node is neither
  // body nor pallu, that leftover node is person. No fallback for body vs
  // pallu â€” they need distinct titles, there is no safe heuristic between them.
  if (!detected.personNodeId) {
    const candidate = allImageNodes.find(
      (n) => n.id !== detected.bodyNodeId && n.id !== detected.palluNodeId,
    );
    if (candidate) detected.personNodeId = candidate.id;
  }

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
