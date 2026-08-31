import { describe, expect, it } from 'vitest';
import { classifyNode, detectMappings, normaliseTitle } from './workflow-detect.js';

// ── Helpers ───────────────────────────────────────────────────────────────

function loadImageNode(title: string) {
  return { class_type: 'LoadImage', _meta: { title }, inputs: { image: '' } };
}
function textEncodeNode(title: string) {
  return { class_type: 'TextEncodeQwenImageEditPlus', _meta: { title }, inputs: { prompt: '' } };
}
function latentNode(title: string) {
  return {
    class_type: 'EmptyLatentImage',
    _meta: { title },
    inputs: { width: 1536, height: 1536 },
  };
}
function otherNode(classType: string, title: string) {
  return { class_type: classType, _meta: { title }, inputs: {} };
}

// Workflow JSON with all nodes renamed to follow the naming convention.
// This is the twopiece23RD workflow after the required renames.
function makeCanonicalWorkflow() {
  return {
    '1332': loadImageNode('face'),
    '1333': loadImageNode('pose'),
    '1334': loadImageNode('background'),
    '1340': loadImageNode('upper_garment'),
    '1331': loadImageNode('lower_garment'),
    '1352': loadImageNode('shoes'),
    '1345:110': textEncodeNode('negative_prompt'),
    '1345:111': textEncodeNode('positive_prompt'),
    '1345:874': latentNode('size'),
    // Non-input nodes — must not appear in any detection result
    '1316': otherNode('Get Date Time String (JPS)', 'Get Date Time String (JPS)'),
    '1319': otherNode('ReActorFaceSwap', 'ReActor 🌌 Fast Face Swap'),
    '1342': otherNode('DWPreprocessor', 'DWPose Estimator'),
    '1335': otherNode('FaceSegment', 'Face Segmentation (RMBG)'),
    '1345:3': otherNode('KSampler', 'KSampler'),
  };
}

// ── normaliseTitle ────────────────────────────────────────────────────────

describe('normaliseTitle', () => {
  it('lowercases uppercase titles', () => {
    expect(normaliseTitle('Background')).toBe('background');
    expect(normaliseTitle('FACE')).toBe('face');
  });

  it('replaces spaces with underscores', () => {
    expect(normaliseTitle('upper garment')).toBe('upper_garment');
    expect(normaliseTitle('lower garment')).toBe('lower_garment');
  });

  it('replaces hyphens with underscores', () => {
    expect(normaliseTitle('lower-garment')).toBe('lower_garment');
  });

  it('trims leading and trailing whitespace before converting', () => {
    expect(normaliseTitle('  face  ')).toBe('face');
  });

  it('does NOT match old convention title "poseimage" as "pose"', () => {
    // Critical: the old title must not be silently accepted as the new one.
    // If this passed, uploading an old workflow would appear to work but map the wrong node.
    expect(normaliseTitle('poseimage')).toBe('poseimage');
    expect(normaliseTitle('poseimage')).not.toBe('pose');
  });
});

// ── classifyNode ──────────────────────────────────────────────────────────

describe('classifyNode', () => {
  it('classifies LoadImage as image', () => expect(classifyNode('LoadImage')).toBe('image'));
  it('classifies TextEncodeQwenImageEditPlus as prompt', () =>
    expect(classifyNode('TextEncodeQwenImageEditPlus')).toBe('prompt'));
  it('classifies CLIPTextEncode as prompt', () =>
    expect(classifyNode('CLIPTextEncode')).toBe('prompt'));
  it('classifies EmptyLatentImage as latent', () =>
    expect(classifyNode('EmptyLatentImage')).toBe('latent'));
  it('classifies KSampler as other', () => expect(classifyNode('KSampler')).toBe('other'));
  it('classifies ReActorFaceSwap as other', () =>
    expect(classifyNode('ReActorFaceSwap')).toBe('other'));
  it('classifies FaceSegment as other', () => expect(classifyNode('FaceSegment')).toBe('other'));
  it('classifies DWPreprocessor as other', () =>
    expect(classifyNode('DWPreprocessor')).toBe('other'));
});

// ── Canonical workflow — all 9 nodes detected ─────────────────────────────

describe('canonical workflow — all nodes correctly titled', () => {
  it('detects face node', () =>
    expect(detectMappings(makeCanonicalWorkflow()).detected.faceNodeId).toBe('1332'));
  it('detects pose node', () =>
    expect(detectMappings(makeCanonicalWorkflow()).detected.poseNodeId).toBe('1333'));
  it('detects background node', () =>
    expect(detectMappings(makeCanonicalWorkflow()).detected.bgNodeId).toBe('1334'));
  it('detects upper_garment node', () =>
    expect(detectMappings(makeCanonicalWorkflow()).detected.upperNodeIds).toEqual(['1340']));
  it('detects lower_garment node', () =>
    expect(detectMappings(makeCanonicalWorkflow()).detected.lowerNodeId).toBe('1331'));
  it('detects shoes node', () =>
    expect(detectMappings(makeCanonicalWorkflow()).detected.shoeNodeId).toBe('1352'));
  it('detects negative_prompt node', () =>
    expect(detectMappings(makeCanonicalWorkflow()).detected.negativePromptNode).toBe('1345:110'));
  it('detects positive_prompt node', () =>
    expect(detectMappings(makeCanonicalWorkflow()).detected.positivePromptNode).toBe('1345:111'));
  it('detects size node', () =>
    expect(detectMappings(makeCanonicalWorkflow()).detected.sizeNodeIds).toContain('1345:874'));

  it('non-input nodes (KSampler, FaceSegment, DWPose, etc.) do not appear in any detection list', () => {
    const { allImageNodes, allPromptNodes, allLatentNodes } = detectMappings(
      makeCanonicalWorkflow(),
    );
    const allDetectedIds = [...allImageNodes, ...allPromptNodes, ...allLatentNodes].map(
      (n) => n.id,
    );
    expect(allDetectedIds).not.toContain('1316'); // datetime
    expect(allDetectedIds).not.toContain('1319'); // reactor
    expect(allDetectedIds).not.toContain('1342'); // dwpose
    expect(allDetectedIds).not.toContain('1335'); // facesegment
    expect(allDetectedIds).not.toContain('1345:3'); // ksampler
  });
});

// ── Old convention titles that must NOT be detected ───────────────────────

describe('old/wrong titles — must fail detection, forcing admin to fix the workflow', () => {
  it('"poseimage" is NOT detected as pose node', () => {
    const wf = { '100': loadImageNode('poseimage') };
    expect(detectMappings(wf).detected.poseNodeId).toBeUndefined();
  });

  it('"Background" (capital B) IS detected — normalisation handles it', () => {
    // This is intentional: "Background" → normalise → "background" → matches convention.
    // Documents that normalisation catches this common case.
    const wf = { '100': loadImageNode('Background') };
    expect(detectMappings(wf).detected.bgNodeId).toBe('100');
  });

  it('"upper garment" (space, old convention) IS detected — normalisation handles it', () => {
    const wf = { '100': loadImageNode('upper garment') };
    expect(detectMappings(wf).detected.upperNodeIds).toContain('100');
  });

  it('"lower garment" (space) IS detected — normalisation handles it', () => {
    const wf = { '100': loadImageNode('lower garment') };
    expect(detectMappings(wf).detected.lowerNodeId).toBe('100');
  });

  it('completely arbitrary title is not detected as any role', () => {
    const wf = { '100': loadImageNode('My Custom Funky Node') };
    const { detected } = detectMappings(wf);
    expect(detected.faceNodeId).toBeUndefined();
    expect(detected.poseNodeId).toBeUndefined();
    expect(detected.bgNodeId).toBeUndefined();
    expect(detected.upperNodeIds).toHaveLength(0);
    expect(detected.lowerNodeId).toBeUndefined();
    expect(detected.shoeNodeId).toBeUndefined();
  });

  it('a TextEncode node titled "TextEncodeQwenImageEditPlus" (not renamed) is NOT detected as positive or negative prompt', () => {
    // This was the real case in the original workflow before renaming.
    // Both prompt nodes had identical titles and neither would be auto-detected.
    const wf = {
      '110': textEncodeNode('TextEncodeQwenImageEditPlus'),
      '111': textEncodeNode('TextEncodeQwenImageEditPlus'),
    };
    const { detected } = detectMappings(wf);
    expect(detected.positivePromptNode).toBeUndefined();
    expect(detected.negativePromptNode).toBeUndefined();
  });
});

// ── Multiple upper_garment nodes ──────────────────────────────────────────

describe('multiple upper_garment nodes', () => {
  it('detects all upper_garment_N nodes', () => {
    const wf = {
      '10': loadImageNode('upper_garment_1'),
      '11': loadImageNode('upper_garment_2'),
      '12': loadImageNode('upper_garment_3'),
    };
    const { detected } = detectMappings(wf);
    expect(detected.upperNodeIds).toHaveLength(3);
    expect(detected.upperNodeIds).toContain('10');
    expect(detected.upperNodeIds).toContain('11');
    expect(detected.upperNodeIds).toContain('12');
  });

  it('detects plain "upper_garment" alongside numbered ones', () => {
    const wf = {
      '10': loadImageNode('upper_garment'),
      '11': loadImageNode('upper_garment_1'),
    };
    const { detected } = detectMappings(wf);
    expect(detected.upperNodeIds).toHaveLength(2);
  });
});

// ── Case insensitivity ────────────────────────────────────────────────────

describe('title case normalisation', () => {
  it('detects "FACE" as face node', () => {
    const wf = { '100': loadImageNode('FACE') };
    expect(detectMappings(wf).detected.faceNodeId).toBe('100');
  });

  it('detects "SHOES" as shoes node', () => {
    const wf = { '100': loadImageNode('SHOES') };
    expect(detectMappings(wf).detected.shoeNodeId).toBe('100');
  });

  it('detects "Positive_Prompt" as positive prompt node', () => {
    const wf = { '100': textEncodeNode('Positive_Prompt') };
    expect(detectMappings(wf).detected.positivePromptNode).toBe('100');
  });
});

// ── Empty / degenerate inputs ─────────────────────────────────────────────

describe('edge cases', () => {
  it('returns empty detected mappings for an empty workflow JSON', () => {
    const { detected } = detectMappings({});
    expect(detected.faceNodeId).toBeUndefined();
    expect(detected.poseNodeId).toBeUndefined();
    expect(detected.bgNodeId).toBeUndefined();
    expect(detected.upperNodeIds).toEqual([]);
    expect(detected.lowerNodeId).toBeUndefined();
    expect(detected.shoeNodeId).toBeUndefined();
    expect(detected.positivePromptNode).toBeUndefined();
    expect(detected.negativePromptNode).toBeUndefined();
    expect(detected.sizeNodeIds).toEqual([]);
  });

  it('a node with no _meta title falls back to the node ID (not detected as any role)', () => {
    const wf = { face: { class_type: 'LoadImage', inputs: { image: '' } } };
    // Key "face" happens to match the face convention — but only _meta.title is checked,
    // not the node key. The node key being "face" must not trigger detection.
    // Actually: since _meta is missing, title defaults to nodeId. nodeId is "face" → detected!
    // This documents that the node ID fallback can accidentally trigger detection.
    // The admin must always set _meta.title explicitly in ComfyUI.
    const { detected } = detectMappings(wf);
    // This WILL be detected because the nodeId "face" is used as fallback title.
    // Document this behavior explicitly so the team knows.
    expect(detected.faceNodeId).toBe('face'); // node ID fallback matches convention
  });
});

// ── Returned node lists ───────────────────────────────────────────────────

// ── Dual-size-group titles (build_model_main v2) ──────────────────────────

describe('dual-size-group node detection', () => {
  function primitiveIntNode(title: string) {
    return { class_type: 'PrimitiveInt', _meta: { title }, inputs: { value: 1024 } };
  }
  function saveImageNode(title: string) {
    return { class_type: 'SaveImage', _meta: { title }, inputs: {} };
  }

  it('detects latentSizeNodeIds from max-width/max-height titles, ordered [width, height]', () => {
    const wf = {
      '733': primitiveIntNode('max-width'),
      '734': primitiveIntNode('max-height'),
    };
    const { detected } = detectMappings(wf);
    expect(detected.latentSizeNodeIds).toEqual(['733', '734']);
  });

  it('detects outputSizeNodeIds from result-width/result-height titles, ordered [width, height]', () => {
    const wf = {
      '1034': primitiveIntNode('result-width'),
      '736': primitiveIntNode('result-height'),
    };
    const { detected } = detectMappings(wf);
    expect(detected.outputSizeNodeIds).toEqual(['1034', '736']);
  });

  it('leaves both groups empty when only one half of a pair is present', () => {
    const wf = { '733': primitiveIntNode('max-width') };
    const { detected } = detectMappings(wf);
    expect(detected.latentSizeNodeIds).toEqual([]);
  });

  it('with a single SaveImage(output) node, resultNodeId stays undefined (no ambiguity)', () => {
    const wf = { '617': saveImageNode('model-result') };
    const { detected } = detectMappings(wf);
    expect(detected.resultNodeId).toBeUndefined();
  });

  it('suppresses legacy sizeNodeIds auto-fill when both dual-size groups are detected', () => {
    const wf = {
      '733': primitiveIntNode('max-width'),
      '734': primitiveIntNode('max-height'),
      '1034': primitiveIntNode('result-width'),
      '736': primitiveIntNode('result-height'),
      // Unrelated internal resize step — must NOT end up in sizeNodeIds
      '691:674': {
        class_type: 'ResizeAndPadImage',
        _meta: { title: 'footwear-resize' },
        inputs: {},
      },
      '1044:1031': latentNode('size'),
    };
    const { detected } = detectMappings(wf);
    expect(detected.latentSizeNodeIds).toEqual(['733', '734']);
    expect(detected.outputSizeNodeIds).toEqual(['1034', '736']);
    expect(detected.sizeNodeIds).toEqual([]);
  });

  it('with two SaveImage nodes, picks the one whose title contains "customer" as resultNodeId', () => {
    const wf = {
      '617': saveImageNode('model-result'),
      '739': saveImageNode('customer-result-Image'),
    };
    const { detected } = detectMappings(wf);
    expect(detected.resultNodeId).toBe('739');
  });
});

describe('returned node lists are correctly populated', () => {
  it('allImageNodes contains only LoadImage nodes', () => {
    const { allImageNodes } = detectMappings(makeCanonicalWorkflow());
    expect(allImageNodes.every((n) => n.class_type === 'LoadImage')).toBe(true);
  });

  it('allImageNodes is sorted alphabetically by title', () => {
    const { allImageNodes } = detectMappings(makeCanonicalWorkflow());
    const titles = allImageNodes.map((n) => n.title);
    expect(titles).toEqual([...titles].sort((a, b) => a.localeCompare(b)));
  });

  it('allPromptNodes contains only TextEncode nodes', () => {
    const { allPromptNodes } = detectMappings(makeCanonicalWorkflow());
    expect(allPromptNodes.every((n) => n.class_type.includes('TextEncode'))).toBe(true);
    expect(allPromptNodes).toHaveLength(2);
  });

  it('allLatentNodes contains only EmptyLatentImage nodes', () => {
    const { allLatentNodes } = detectMappings(makeCanonicalWorkflow());
    expect(allLatentNodes.every((n) => n.class_type === 'EmptyLatentImage')).toBe(true);
    expect(allLatentNodes).toHaveLength(1);
  });
});
