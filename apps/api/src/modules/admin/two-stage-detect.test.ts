import { describe, expect, it } from 'vitest';
import { detectTwoStageMappings } from './two-stage-detect.js';

// ── Helpers ───────────────────────────────────────────────────────────────

function loadImageNode(title: string) {
  return { class_type: 'LoadImage', _meta: { title }, inputs: { image: '' } };
}
function textEncodeNode(title: string, promptText = '') {
  return {
    class_type: 'TextEncodeQwenImageEditPlusAdvance_lrzjason',
    _meta: { title },
    inputs: { prompt: promptText },
  };
}
function latentNode(title: string) {
  return {
    class_type: 'EmptyLatentImage',
    _meta: { title },
    inputs: { width: 2048, height: 2048 },
  };
}

// A minimal two-KSampler graph shaped like the real "build person, then dress
// in garment" workflows: stage 1 builds a person from pose+face+background,
// stage 2 dresses that person in the garment, then a post-process node and a
// custom save node sit between stage 2's KSampler and the actual output.
//
// The negative_prompt title is deliberately placed on STAGE 1's node ("21"),
// not stage 2's ("31") — this is the exact trap that breaks the 'regular'
// detector on real uploads (it grabs whichever Sampler it finds first).
function makeTwoStageWorkflow() {
  return {
    '10': loadImageNode('face'),
    '11': loadImageNode('pose'),
    '12': loadImageNode('background'),
    '13': loadImageNode('garment'),
    '40': latentNode('Empty Latent Image'),
    '41': latentNode('Empty Latent Image'),

    // Stage 1 — build person. Neither prompt node is titled positive/negative_prompt
    // except '21', which misleadingly carries the "negative_prompt" title.
    '20': textEncodeNode('TextEncodeQwenImageEditPlusAdvance lrzjason', 'stage1 positive'),
    '21': textEncodeNode('negative_prompt', 'stage1 negative'),
    '22': {
      class_type: 'KSampler',
      _meta: { title: 'KSampler' },
      inputs: { positive: ['20', 0], negative: ['21', 0], latent_image: ['40', 0] },
    },
    '23': {
      class_type: 'VAEDecode',
      _meta: { title: 'VAE Decode' },
      inputs: { samples: ['22', 0] },
    },

    // Stage 2 — dress in garment. This is the stage that actually reaches the
    // output node, but neither of its prompt nodes has a distinguishing title.
    '30': textEncodeNode('TextEncodeQwenImageEditPlusAdvance lrzjason', 'stage2 positive'),
    '31': textEncodeNode('TextEncodeQwenImageEditPlusAdvance lrzjason', 'stage2 negative'),
    '32': {
      class_type: 'KSampler',
      _meta: { title: 'KSampler' },
      inputs: { positive: ['30', 0], negative: ['31', 0], latent_image: ['41', 0] },
    },
    '33': {
      class_type: 'VAEDecode',
      _meta: { title: 'VAE Decode' },
      inputs: { samples: ['32', 0] },
    },
    '34': {
      class_type: 'Color Correct (mtb)',
      _meta: { title: 'Color Correct (mtb)' },
      inputs: { image: ['33', 0] },
    },
    '35': {
      class_type: 'Save Image With Callback',
      _meta: { title: 'Save Image With Callback' },
      inputs: { images: ['34', 0] },
    },
  };
}

describe('detectTwoStageMappings', () => {
  it('detects face/pose/background/garment images by title', () => {
    const { detected } = detectTwoStageMappings(makeTwoStageWorkflow());
    expect(detected.faceNodeId).toBe('10');
    expect(detected.poseNodeId).toBe('11');
    expect(detected.bgNodeId).toBe('12');
    expect(detected.garmentNodeId).toBe('13');
  });

  it('detects the output node via the custom "Save Image" class', () => {
    const { detected } = detectTwoStageMappings(makeTwoStageWorkflow());
    expect(detected.outputNodeId).toBe('35');
  });

  it('resolves stage2 prompts by tracing back from the output through post-processing to the final KSampler', () => {
    const { detected } = detectTwoStageMappings(makeTwoStageWorkflow());
    expect(detected.stage2PositivePromptNode).toBe('30');
    expect(detected.stage2NegativePromptNode).toBe('31');
  });

  it('does NOT fall for the misleading "negative_prompt" title on stage 1 — stage2 negative must not be node 21', () => {
    const { detected } = detectTwoStageMappings(makeTwoStageWorkflow());
    expect(detected.stage2NegativePromptNode).not.toBe('21');
  });

  it('resolves stage1 prompts from the other KSampler in the graph', () => {
    const { detected } = detectTwoStageMappings(makeTwoStageWorkflow());
    expect(detected.stage1PositivePromptNode).toBe('20');
    expect(detected.stage1NegativePromptNode).toBe('21');
  });

  it('collects both EmptyLatentImage nodes as sizeNodeIds', () => {
    const { detected } = detectTwoStageMappings(makeTwoStageWorkflow());
    expect(detected.sizeNodeIds.sort()).toEqual(['40', '41']);
  });

  it('extracts default prompt text for all four prompt slots', () => {
    const { detected } = detectTwoStageMappings(makeTwoStageWorkflow());
    expect(detected.defaultStage1PositivePrompt).toBe('stage1 positive');
    expect(detected.defaultStage1NegativePrompt).toBe('stage1 negative');
    expect(detected.defaultStage2PositivePrompt).toBe('stage2 positive');
    expect(detected.defaultStage2NegativePrompt).toBe('stage2 negative');
  });

  it('leaves stage1 prompts undefined when there is only one KSampler, without throwing', () => {
    const json = makeTwoStageWorkflow();
    // Remove stage 1 entirely — its VAEDecode('23') is unused/dangling, which is fine.
    delete (json as Record<string, unknown>)['22'];
    const { detected } = detectTwoStageMappings(json);
    expect(detected.stage2PositivePromptNode).toBe('30');
    expect(detected.stage1PositivePromptNode).toBeUndefined();
    expect(detected.stage1NegativePromptNode).toBeUndefined();
  });
});
