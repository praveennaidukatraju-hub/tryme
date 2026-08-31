import { describe, expect, it } from 'vitest';
import { detectTryonMappings } from './tryon-detect.js';

// Minimal inline fixture derived from templates/tryonupper25062026 (2).json.
// Templates are gitignored so tests must not read from disk.
const sample: Record<string, unknown> = {
  '994': {
    inputs: { filename_prefix: ['1098', 0], images: ['1036', 0] },
    class_type: 'Save Image With Callback',
    _meta: { title: 'Save Image With Callback' },
  },
  '1000': {
    inputs: { image: 'ComfyUI_temp_jacsj_00001_.png' },
    class_type: 'LoadImage',
    _meta: { title: 'person' },
  },
  '1006': {
    inputs: { image: '20260617113300_00001_.png' },
    class_type: 'LoadImage',
    _meta: { title: 'garment' },
  },
  '1001:111': {
    inputs: {
      prompt:
        'first remove innerwear and upper wear and saree and dupatta and cloths above the shoulder from image1 person.\nfinally tryon image2 upperwear.\ncondition: if result person trouser then only replace with trouser to match fashionate upper garment.\nremove : scarf and dupatta.\n',
      clip: ['1001:38', 0],
      vae: ['1001:39', 0],
      image1: ['1024:456', 0],
      image2: ['1104', 0],
    },
    class_type: 'TextEncodeQwenImageEditPlus',
    _meta: { title: 'TextEncodeQwenImageEditPlus' },
  },
  '1117': {
    inputs: {
      text: 'plastics hands, extra or duplicate hands,keep image1 sleeve, keep image1 neck type. duplicate or extra head, extra buttons , extra zip, tuck upperwear, extra or duplicate hands.frayed edges, threads, torn fabric, distorted sleeves, extra cloth, artifacts tucked upperwear, inside pants, tight waist fit, unnatural fold.',
      clip: ['1001:38', 0],
    },
    class_type: 'CLIPTextEncode',
    _meta: { title: 'CLIP Text Encode (Prompt)' },
  },
  '1001:842': {
    inputs: {
      strength: 0,
      start_percent: 0,
      end_percent: 0.1,
      positive: ['1001:111', 0],
      negative: ['1117', 0],
      control_net: ['1001:809', 0],
      vae: ['1001:39', 0],
      image: ['1024:456', 0],
      mask: ['1119', 0],
    },
    class_type: 'ControlNetInpaintingAliMamaApply',
    _meta: { title: 'ControlNetInpaintingAliMamaApply' },
  },
};

describe('detectTryonMappings', () => {
  it('detects person, garment and output nodes from the sample JSON', () => {
    const { detected } = detectTryonMappings(sample);
    expect(detected.personNodeId).toBe('1000');
    expect(detected.garmentNodeId).toBe('1006');
    expect(detected.outputNodeId).toBe('994');
  });

  it('detects positive and negative prompt nodes via the positive/negative input links', () => {
    const { detected } = detectTryonMappings(sample);
    expect(detected.positivePromptNode).toBe('1001:111');
    expect(detected.negativePromptNode).toBe('1117');
  });

  it('extracts default prompt text from the detected prompt nodes', () => {
    const { detected } = detectTryonMappings(sample);
    expect(detected.defaultPositivePrompt).toContain('tryon image2 upperwear');
    expect(detected.defaultNegativePrompt).toContain('plastics hands');
  });

  it('returns the full image and prompt node lists for manual override', () => {
    const { allImageNodes, allPromptNodes } = detectTryonMappings(sample);
    expect(allImageNodes.map((n) => n.id).sort()).toEqual(['1000', '1006']);
    expect(allPromptNodes.map((n) => n.id).sort()).toEqual(['1001:111', '1117']);
  });
});
