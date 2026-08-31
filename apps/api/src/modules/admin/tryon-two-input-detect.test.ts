import { describe, expect, it } from 'vitest';
import { detectTryonTwoInputMappings } from './tryon-two-input-detect.js';

// Inline fixture â€” 3 LoadImage inputs (person, body, pallu), 1 output, 2 prompts.
const sample: Record<string, unknown> = {
  '994': {
    inputs: { filename_prefix: ['1098', 0], images: ['1036', 0] },
    class_type: 'Save Image With Callback',
    _meta: { title: 'Save Image With Callback' },
  },
  '1000': {
    inputs: { image: 'placeholder.png' },
    class_type: 'LoadImage',
    _meta: { title: 'person' },
  },
  '1006': {
    inputs: { image: 'placeholder.png' },
    class_type: 'LoadImage',
    _meta: { title: 'body' },
  },
  '1007': {
    inputs: { image: 'placeholder.png' },
    class_type: 'LoadImage',
    _meta: { title: 'pallu' },
  },
  '1001:111': {
    inputs: {
      prompt: 'drape image2 body and image3 pallu onto image1 person',
      positive: undefined,
      image1: ['1024:456', 0],
      image2: ['1104', 0],
    },
    class_type: 'TextEncodeQwenImageEditPlus',
    _meta: { title: 'TextEncodeQwenImageEditPlus' },
  },
  '1117': {
    inputs: { text: 'extra hands, distorted pallu, artifacts' },
    class_type: 'CLIPTextEncode',
    _meta: { title: 'CLIP Text Encode (Prompt)' },
  },
  '1001:842': {
    inputs: {
      positive: ['1001:111', 0],
      negative: ['1117', 0],
      control_net: ['1001:809', 0],
      image: ['1024:456', 0],
    },
    class_type: 'ControlNetInpaintingAliMamaApply',
    _meta: { title: 'ControlNetInpaintingAliMamaApply' },
  },
};

describe('detectTryonTwoInputMappings', () => {
  it('detects person, body, pallu and output nodes from the sample JSON', () => {
    const { detected } = detectTryonTwoInputMappings(sample);
    expect(detected.personNodeId).toBe('1000');
    expect(detected.bodyNodeId).toBe('1006');
    expect(detected.palluNodeId).toBe('1007');
    expect(detected.outputNodeId).toBe('994');
  });

  it('detects positive and negative prompt nodes via the positive/negative input links', () => {
    const { detected } = detectTryonTwoInputMappings(sample);
    expect(detected.positivePromptNode).toBe('1001:111');
    expect(detected.negativePromptNode).toBe('1117');
  });

  it('extracts default prompt text from the detected prompt nodes', () => {
    const { detected } = detectTryonTwoInputMappings(sample);
    expect(detected.defaultPositivePrompt).toContain('drape image2 body');
    expect(detected.defaultNegativePrompt).toContain('distorted pallu');
  });

  it('returns the full image and prompt node lists for manual override', () => {
    const { allImageNodes, allPromptNodes } = detectTryonTwoInputMappings(sample);
    expect(allImageNodes.map((n) => n.id).sort()).toEqual(['1000', '1006', '1007']);
    expect(allPromptNodes.map((n) => n.id).sort()).toEqual(['1001:111', '1117']);
  });

  it('falls back to the leftover image node for person when untitled', () => {
    const untitledPerson = structuredClone(sample) as Record<string, { _meta: { title: string } }>;
    untitledPerson['1000']._meta.title = '1000';
    const { detected } = detectTryonTwoInputMappings(untitledPerson);
    expect(detected.personNodeId).toBe('1000');
  });
});
