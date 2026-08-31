import { describe, expect, it } from 'vitest';
import { detectSareeMappings } from './saree-detect.js';

// Minimal inline fixture mirroring templates/saree.json. Templates are gitignored
// so tests must not read from disk.
const sample: Record<string, unknown> = {
  '950': {
    inputs: { filename_prefix: 'sareedraping', images: ['949:8', 0] },
    class_type: 'SaveImage',
    _meta: { title: 'save-result' },
  },
  '951': {
    inputs: { image: '1782279578.png' },
    class_type: 'LoadImage',
    _meta: { title: 'person' },
  },
  '952': {
    inputs: { image: 'image (1).jpg' },
    class_type: 'LoadImage',
    _meta: { title: 'flatsaree' },
  },
  '949:111': {
    inputs: {
      prompt: 'image 3 full body person nivi Style draped saree complete body and pleats.',
      clip: ['949:499', 1],
      vae: ['949:39', 0],
      image1: ['1014:1007', 0],
      image2: ['1014:1008', 0],
      image3: ['970', 0],
    },
    class_type: 'TextEncodeQwenImageEditPlus',
    _meta: { title: 'TextEncodeQwenImageEditPlus' },
  },
  '949:110': {
    inputs: {
      prompt: 'low quality, worst quality, blurry, soft focus, noise.',
      clip: ['949:499', 1],
      vae: ['949:39', 0],
      image1: ['1014:1007', 0],
      image2: ['1014:1008', 0],
      image3: ['970', 0],
    },
    class_type: 'TextEncodeQwenImageEditPlus',
    _meta: { title: 'TextEncodeQwenImageEditPlus' },
  },
  '949:3': {
    inputs: {
      seed: 667676120053242,
      steps: 8,
      cfg: 1,
      sampler_name: 'dpmpp_2m',
      scheduler: 'karras',
      denoise: 1,
      model: ['949:75', 0],
      positive: ['949:111', 0],
      negative: ['949:110', 0],
      latent_image: ['949:874', 0],
    },
    class_type: 'KSampler',
    _meta: { title: 'KSampler' },
  },
};

describe('detectSareeMappings', () => {
  it('detects model (person) and saree (flatsaree) image nodes', () => {
    const { detected } = detectSareeMappings(sample);
    expect(detected.modelImageNode).toBe('951');
    expect(detected.sareeImageNode).toBe('952');
  });

  it('detects output node', () => {
    const { detected } = detectSareeMappings(sample);
    expect(detected.outputNode).toBe('950');
  });

  it('detects positive and negative prompt nodes via input links', () => {
    const { detected } = detectSareeMappings(sample);
    expect(detected.positivePromptNode).toBe('949:111');
    expect(detected.negativePromptNode).toBe('949:110');
  });

  it('extracts default prompt text', () => {
    const { detected } = detectSareeMappings(sample);
    expect(detected.defaultPositivePrompt).toContain('nivi Style');
    expect(detected.defaultNegativePrompt).toContain('low quality');
  });

  it('returns null for missing nodes on a sparse JSON', () => {
    const { detected } = detectSareeMappings({});
    expect(detected.modelImageNode).toBeNull();
    expect(detected.sareeImageNode).toBeNull();
    expect(detected.outputNode).toBeNull();
  });
});
