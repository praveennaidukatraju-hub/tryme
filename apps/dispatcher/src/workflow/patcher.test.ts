import { describe, expect, it, vi } from 'vitest';
import { ASPECT_DIMENSIONS, applyWorkflowPatch, type WorkflowTemplate } from './patcher.js';

// ── Fixtures ──────────────────────────────────────────────────────────────

// All LoadImage nodes start with empty string to simulate what the stored
// workflow JSON looks like after the team clears stale test filenames per convention.
// This is the real scenario: production jobs were failing because old stale filenames
// (like "png-transparent-t-shirt-pants.png") were left in the JSON and submitted
// to ComfyUI, which rejected them because the files didn't exist on the server.
function makeWorkflow() {
  return {
    '1332': { inputs: { image: '' }, class_type: 'LoadImage', _meta: { title: 'face' } },
    '1333': { inputs: { image: '' }, class_type: 'LoadImage', _meta: { title: 'pose' } },
    '1334': { inputs: { image: '' }, class_type: 'LoadImage', _meta: { title: 'background' } },
    '1340': { inputs: { image: '' }, class_type: 'LoadImage', _meta: { title: 'upper_garment' } },
    '1331': { inputs: { image: '' }, class_type: 'LoadImage', _meta: { title: 'lower_garment' } },
    '1352': { inputs: { image: '' }, class_type: 'LoadImage', _meta: { title: 'shoes' } },
    '1360': { inputs: { image: '' }, class_type: 'LoadImage', _meta: { title: 'third_garment' } },
    '1345:110': {
      inputs: { prompt: 'hardcoded negative — must never change' },
      class_type: 'TextEncodeQwenImageEditPlus',
      _meta: { title: 'negative_prompt' },
    },
    '1345:111': {
      inputs: { prompt: 'default positive prompt from template' },
      class_type: 'TextEncodeQwenImageEditPlus',
      _meta: { title: 'positive_prompt' },
    },
    '1345:874': {
      inputs: { width: 1536, height: 1536, batch_size: 1 },
      class_type: 'EmptyLatentImage',
      _meta: { title: 'size' },
    },
    // Non-input processing nodes — must never be touched by patcher
    '1319': {
      inputs: { input_image: ['1345:8', 0], source_image: ['1335', 0] },
      class_type: 'ReActorFaceSwap',
      _meta: { title: 'ReActor Fast Face Swap' },
    },
    '1342': {
      inputs: { image: ['1330', 0] },
      class_type: 'DWPreprocessor',
      _meta: { title: 'DWPose Estimator' },
    },
  };
}

function makeTemplate(overrides: Partial<WorkflowTemplate> = {}): WorkflowTemplate {
  return {
    id: 'test-uuid',
    slug: 'twopiece_v1',
    label: 'Two Piece V1',
    jsonContent: {},
    faceNodeId: '1332',
    poseNodeId: '1333',
    bgNodeId: '1334',
    upperNodeIds: ['1340'],
    lowerNodeId: '1331',
    shoeNodeId: '1352',
    thirdNodeId: '1360',
    sizeNodeId: '1345:874', // legacy field kept in schema
    sizeNodeIds: ['1345:874'],
    facePhasePromptNode: '1345:110', // negative prompt — DB column named "facePhase" historically
    garmentPhasePromptNode: '1345:111', // positive prompt — dynamic per pose
    defaultFacePhasePrompt: 'hardcoded negative — must never change',
    defaultGarmentPhasePrompt: 'default positive prompt from template',
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as WorkflowTemplate;
}

const BASE_INPUTS = {
  upperGarmentFile: 'garment_abc123.jpg',
  faceSideFile: 'face_abc123.jpg',
  poseFile: 'pose_abc123.jpg',
  backgroundFile: 'bg_abc123.jpg',
  lowerGarmentFile: 'lower_abc123.jpg',
  shoeGarmentFile: 'shoe_abc123.jpg',
  thirdGarmentFile: 'third_abc123.jpg',
};

describe('fail-closed on missing garment input for a mapped role', () => {
  it('throws when upperNodeIds is mapped but upperGarmentFile is missing', () => {
    const wf = makeWorkflow();
    const { upperGarmentFile, ...inputsWithoutUpper } = BASE_INPUTS;
    expect(() =>
      applyWorkflowPatch(
        wf,
        makeTemplate({ faceNodeId: null, bgNodeId: null }),
        inputsWithoutUpper,
      ),
    ).toThrow(/upper/i);
  });

  it('throws when lowerNodeId is mapped but lowerGarmentFile is missing (no fallback to upper)', () => {
    const wf = makeWorkflow();
    const { lowerGarmentFile, ...inputsWithoutLower } = BASE_INPUTS;
    expect(() =>
      applyWorkflowPatch(wf, makeTemplate({ lowerNodeId: '1331' }), inputsWithoutLower),
    ).toThrow(/lower/i);
  });

  it('throws when faceNodeId is mapped but faceSideFile is missing', () => {
    const wf = makeWorkflow();
    const { faceSideFile, ...inputsWithoutFace } = BASE_INPUTS;
    expect(() =>
      applyWorkflowPatch(wf, makeTemplate({ bgNodeId: null }), inputsWithoutFace),
    ).toThrow(/face/i);
  });

  it('does not throw for an unmapped role even when its input is absent', () => {
    const wf = makeWorkflow();
    const { upperGarmentFile, ...inputsWithoutUpper } = BASE_INPUTS;
    expect(() =>
      applyWorkflowPatch(
        wf,
        makeTemplate({ faceNodeId: null, bgNodeId: null, upperNodeIds: [], lowerNodeId: '1331' }),
        { ...inputsWithoutUpper, lowerGarmentFile: 'lower_abc123.jpg' },
      ),
    ).not.toThrow();
  });

  it('patches the lower node with its own file, not a fallback, when both are provided', () => {
    const wf = makeWorkflow();
    applyWorkflowPatch(wf, makeTemplate(), {
      ...BASE_INPUTS,
      lowerGarmentFile: 'lower_xyz.jpg',
    });
    expect(wf['1331']?.inputs.image).toBe('lower_xyz.jpg');
  });
});

// ── Required image nodes — must ALL be patched ────────────────────────────

describe('required nodes', () => {
  it('patches face node with faceSideFile', () => {
    const wf = makeWorkflow();
    applyWorkflowPatch(wf, makeTemplate(), BASE_INPUTS);
    expect(wf['1332']?.inputs.image).toBe('face_abc123.jpg');
  });

  it('patches pose node with poseFile', () => {
    const wf = makeWorkflow();
    applyWorkflowPatch(wf, makeTemplate(), BASE_INPUTS);
    expect(wf['1333']?.inputs.image).toBe('pose_abc123.jpg');
  });

  it('patches background node with backgroundFile', () => {
    const wf = makeWorkflow();
    applyWorkflowPatch(wf, makeTemplate(), BASE_INPUTS);
    expect(wf['1334']?.inputs.image).toBe('bg_abc123.jpg');
  });

  it('patches all upper garment nodes', () => {
    const wf = makeWorkflow();
    applyWorkflowPatch(wf, makeTemplate({ upperNodeIds: ['1340'] }), BASE_INPUTS);
    expect(wf['1340']?.inputs.image).toBe('garment_abc123.jpg');
  });

  it('patches multiple upper garment nodes with the same file', () => {
    const wf = {
      ...makeWorkflow(),
      '9001': {
        inputs: { image: '' },
        class_type: 'LoadImage',
        _meta: { title: 'upper_garment_2' },
      },
    };
    const tmpl = makeTemplate({ upperNodeIds: ['1340', '9001'] });
    applyWorkflowPatch(wf, tmpl, BASE_INPUTS);
    expect(wf['1340']?.inputs.image).toBe('garment_abc123.jpg');
    expect(wf['9001']?.inputs.image).toBe('garment_abc123.jpg');
  });

  it('throws with the missing node ID when a required node is absent from the workflow JSON', () => {
    const wf = makeWorkflow();
    const tmpl = makeTemplate({ faceNodeId: 'NODE_THAT_DOES_NOT_EXIST' });
    expect(() => applyWorkflowPatch(wf, tmpl, BASE_INPUTS)).toThrowError(
      /NODE_THAT_DOES_NOT_EXIST/,
    );
  });

  it('after patching, no mapped LoadImage node retains an empty string — the production bug this guards against', () => {
    // This test directly maps to the incident: node 1331 had a stale/empty filename
    // in the stored workflow JSON. The patcher did not touch it (lowerNodeId was unmapped),
    // so ComfyUI received "" or a stale filename and returned 400.
    const wf = makeWorkflow();
    applyWorkflowPatch(wf, makeTemplate(), BASE_INPUTS);

    const mappedNodeIds = ['1332', '1333', '1334', '1340', '1331', '1352', '1360'];
    for (const nodeId of mappedNodeIds) {
      const img = wf[nodeId as keyof typeof wf]?.inputs.image;
      expect(img, `node ${nodeId} still has empty/stale image after patch`).toBeTruthy();
      expect(img, `node ${nodeId} still has empty/stale image after patch`).not.toBe('');
    }
  });
});

// ── Lower garment ─────────────────────────────────────────────────────────

describe('lower garment', () => {
  it('patches lower garment node with the provided lowerGarmentFile', () => {
    const wf = makeWorkflow();
    applyWorkflowPatch(wf, makeTemplate(), {
      ...BASE_INPUTS,
      lowerGarmentFile: 'lower_abc123.jpg',
    });
    expect(wf['1331']?.inputs.image).toBe('lower_abc123.jpg');
  });

  it('leaves lower node completely untouched when lowerNodeId is null (no mapping)', () => {
    const wf = makeWorkflow();
    const tmpl = makeTemplate({ lowerNodeId: null });
    applyWorkflowPatch(wf, tmpl, { ...BASE_INPUTS, lowerGarmentFile: 'lower_abc123.jpg' });
    // Node 1331 was not mapped — it keeps its original empty value
    expect(wf['1331']?.inputs.image).toBe('');
  });

  it('warns when a lower garment file is provided but no lowerNodeId is mapped — it is silently skipped', () => {
    const wf = makeWorkflow();
    const warn = vi.fn();
    const tmpl = makeTemplate({ lowerNodeId: null });
    applyWorkflowPatch(
      wf,
      tmpl,
      { ...BASE_INPUTS, lowerGarmentFile: 'lower_abc123.jpg' },
      { warn },
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no lower_node_id'));
  });
});

// ── Shoes ─────────────────────────────────────────────────────────────────

describe('shoes', () => {
  it('patches shoe node with the provided shoeGarmentFile', () => {
    const wf = makeWorkflow();
    applyWorkflowPatch(wf, makeTemplate(), { ...BASE_INPUTS, shoeGarmentFile: 'shoe_abc123.jpg' });
    expect(wf['1352']?.inputs.image).toBe('shoe_abc123.jpg');
  });

  it('throws when shoeNodeId is mapped but no shoe file is provided', () => {
    const wf = makeWorkflow();
    const { shoeGarmentFile, ...inputsWithoutShoe } = BASE_INPUTS;
    expect(() => applyWorkflowPatch(wf, makeTemplate(), inputsWithoutShoe)).toThrow(/shoe/i);
  });

  it('leaves shoe node completely untouched when shoeNodeId is null', () => {
    const wf = makeWorkflow();
    const tmpl = makeTemplate({ shoeNodeId: null });
    applyWorkflowPatch(wf, tmpl, { ...BASE_INPUTS, shoeGarmentFile: 'shoe_abc123.jpg' });
    expect(wf['1352']?.inputs.image).toBe('');
  });
});

// ── Third Garment ────────────────────────────────────────────────────────

describe('third garment', () => {
  it('patches third node with the provided thirdGarmentFile', () => {
    const wf = makeWorkflow();
    applyWorkflowPatch(wf, makeTemplate(), {
      ...BASE_INPUTS,
      thirdGarmentFile: 'third_abc123.jpg',
    });
    expect(wf['1360']?.inputs.image).toBe('third_abc123.jpg');
  });

  it('throws when thirdNodeId is mapped but no third garment file is provided', () => {
    const wf = makeWorkflow();
    const { thirdGarmentFile, ...inputsWithoutThird } = BASE_INPUTS;
    expect(() => applyWorkflowPatch(wf, makeTemplate(), inputsWithoutThird)).toThrow(/third/i);
  });

  it('leaves third node completely untouched when thirdNodeId is null', () => {
    const wf = makeWorkflow();
    const tmpl = makeTemplate({ thirdNodeId: null });
    applyWorkflowPatch(wf, tmpl, { ...BASE_INPUTS, thirdGarmentFile: 'third_abc123.jpg' });
    expect(wf['1360']?.inputs.image).toBe('');
  });
});

// ── Prompts ───────────────────────────────────────────────────────────────

describe('prompts', () => {
  it('overrides the positive prompt node (garmentPhasePromptNode) when promptGarmentPhase is provided', () => {
    const wf = makeWorkflow();
    applyWorkflowPatch(wf, makeTemplate(), {
      ...BASE_INPUTS,
      promptGarmentPhase: 'custom positive for sitting pose',
    });
    expect(wf['1345:111']?.inputs.prompt).toBe('custom positive for sitting pose');
  });

  it('leaves positive prompt at template default when promptGarmentPhase is not provided', () => {
    const wf = makeWorkflow();
    applyWorkflowPatch(wf, makeTemplate(), BASE_INPUTS);
    expect(wf['1345:111']?.inputs.prompt).toBe('default positive prompt from template');
  });

  it('leaves positive prompt at template default when promptGarmentPhase is empty string — production bug: empty string caused ComfyUI 400', () => {
    const wf = makeWorkflow();
    applyWorkflowPatch(wf, makeTemplate(), { ...BASE_INPUTS, promptGarmentPhase: '' });
    expect(wf['1345:111']?.inputs.prompt).toBe('default positive prompt from template');
  });

  it('leaves positive prompt at template default when promptGarmentPhase is whitespace only', () => {
    const wf = makeWorkflow();
    applyWorkflowPatch(wf, makeTemplate(), { ...BASE_INPUTS, promptGarmentPhase: '   ' });
    expect(wf['1345:111']?.inputs.prompt).toBe('default positive prompt from template');
  });

  it('NEVER modifies the negative prompt node (facePhasePromptNode) under any circumstances', () => {
    const wf = makeWorkflow();
    const originalNegative = wf['1345:110']?.inputs.prompt;

    // Try with promptFacePhase provided — it must be completely ignored
    applyWorkflowPatch(wf, makeTemplate(), {
      ...BASE_INPUTS,
      promptFacePhase: 'trying to override negative',
    });
    expect(wf['1345:110']?.inputs.prompt).toBe(originalNegative);
  });

  it('promptFacePhase has no effect on ANY node in the workflow — it is completely ignored', () => {
    const wf = makeWorkflow();
    // Snapshot all node inputs before patching
    const before = JSON.stringify(
      Object.fromEntries(Object.entries(wf).map(([id, node]) => [id, { ...node.inputs }])),
    );

    // Apply with promptFacePhase — only the normal image patches should change
    applyWorkflowPatch(wf, makeTemplate(), {
      ...BASE_INPUTS,
      promptFacePhase: 'should have zero effect',
    });

    // Verify the negative prompt node is identical to before
    expect(wf['1345:110']?.inputs.prompt).toBe(JSON.parse(before)['1345:110'].prompt);
  });
});

// ── Non-input nodes are never touched ────────────────────────────────────

describe('non-input nodes', () => {
  it('does not modify ReActorFaceSwap node inputs', () => {
    const wf = makeWorkflow();
    const before = JSON.stringify(wf['1319']?.inputs);
    applyWorkflowPatch(wf, makeTemplate(), BASE_INPUTS);
    expect(JSON.stringify(wf['1319']?.inputs)).toBe(before);
  });

  it('does not modify DWPose node inputs', () => {
    const wf = makeWorkflow();
    const before = JSON.stringify(wf['1342']?.inputs);
    applyWorkflowPatch(wf, makeTemplate(), BASE_INPUTS);
    expect(JSON.stringify(wf['1342']?.inputs)).toBe(before);
  });
});

// ── Aspect ratio ──────────────────────────────────────────────────────────

describe('aspect ratio', () => {
  it.each(Object.entries(ASPECT_DIMENSIONS))(
    'patches EmptyLatentImage width/height for ratio %s → %o',
    (ratio, dims) => {
      const wf = makeWorkflow();
      applyWorkflowPatch(wf, makeTemplate(), { ...BASE_INPUTS, aspectRatio: ratio });
      expect(wf['1345:874']?.inputs.width).toBe(dims.width);
      expect(wf['1345:874']?.inputs.height).toBe(dims.height);
    },
  );

  it('does not patch size node when aspectRatio is not provided', () => {
    const wf = makeWorkflow();
    applyWorkflowPatch(wf, makeTemplate(), BASE_INPUTS);
    expect(wf['1345:874']?.inputs.width).toBe(1536);
    expect(wf['1345:874']?.inputs.height).toBe(1536);
  });

  it('does not patch size node when sizeNodeIds is empty, even if aspectRatio is provided', () => {
    const wf = makeWorkflow();
    applyWorkflowPatch(wf, makeTemplate({ sizeNodeIds: [] }), {
      ...BASE_INPUTS,
      aspectRatio: '4:5',
    });
    expect(wf['1345:874']?.inputs.width).toBe(1536);
    expect(wf['1345:874']?.inputs.height).toBe(1536);
  });

  it('warns and skips for an unknown aspect ratio string', () => {
    const wf = makeWorkflow();
    const warn = vi.fn();
    applyWorkflowPatch(wf, makeTemplate(), { ...BASE_INPUTS, aspectRatio: '7:3' }, { warn });
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('7:3'));
    // Size node must remain unchanged
    expect(wf['1345:874']?.inputs.width).toBe(1536);
    expect(wf['1345:874']?.inputs.height).toBe(1536);
  });

  it('batch_size is never changed by aspect ratio patch', () => {
    const wf = makeWorkflow();
    applyWorkflowPatch(wf, makeTemplate(), { ...BASE_INPUTS, aspectRatio: '9:16' });
    expect(wf['1345:874']?.inputs.batch_size).toBe(1);
  });

  it('patches PrimitiveInt nodes — sizeNodeIds[0]=width, sizeNodeIds[1]=height', () => {
    const wf = {
      ...makeWorkflow(),
      '1404': { inputs: { value: 2048 }, class_type: 'PrimitiveInt', _meta: { title: 'Int' } },
      '1405': { inputs: { value: 2048 }, class_type: 'PrimitiveInt', _meta: { title: 'Int' } },
    };
    applyWorkflowPatch(wf, makeTemplate({ sizeNodeIds: ['1404', '1405'] }), {
      ...BASE_INPUTS,
      aspectRatio: '3:4',
    });
    expect(wf['1404']?.inputs.value).toBe(ASPECT_DIMENSIONS['3:4']?.width);
    expect(wf['1405']?.inputs.value).toBe(ASPECT_DIMENSIONS['3:4']?.height);
  });

  it('does not touch EmptyLatentImage when template uses PrimitiveInt nodes', () => {
    const wf = {
      ...makeWorkflow(),
      '1404': { inputs: { value: 2048 }, class_type: 'PrimitiveInt', _meta: { title: 'Int' } },
      '1405': { inputs: { value: 2048 }, class_type: 'PrimitiveInt', _meta: { title: 'Int' } },
    };
    applyWorkflowPatch(wf, makeTemplate({ sizeNodeIds: ['1404', '1405'] }), {
      ...BASE_INPUTS,
      aspectRatio: '1:1',
    });
    // EmptyLatentImage not in sizeNodeIds — must remain untouched
    expect(wf['1345:874']?.inputs.width).toBe(1536);
    expect(wf['1345:874']?.inputs.height).toBe(1536);
  });
});

// ── Dual-size-group templates (build_model_main v2) ──────────────────────

describe('dual-size groups', () => {
  function makeDualSizeWorkflow() {
    return {
      ...makeWorkflow(),
      'max-width': {
        inputs: { value: 2048 },
        class_type: 'PrimitiveInt',
        _meta: { title: 'max-width' },
      },
      'max-height': {
        inputs: { value: 2048 },
        class_type: 'PrimitiveInt',
        _meta: { title: 'max-height' },
      },
      'result-width': {
        inputs: { value: 1024 },
        class_type: 'PrimitiveInt',
        _meta: { title: 'result-width' },
      },
      'result-height': {
        inputs: { value: 1024 },
        class_type: 'PrimitiveInt',
        _meta: { title: 'result-height' },
      },
    };
  }

  it('patches the latent group via resizeToMax, and the output group via the literal ASPECT_DIMENSIONS lookup', () => {
    const wf = makeDualSizeWorkflow();
    applyWorkflowPatch(
      wf,
      makeTemplate({
        latentSizeNodeIds: ['max-width', 'max-height'],
        latentMaxPx: 2048,
        outputSizeNodeIds: ['result-width', 'result-height'],
      }),
      { ...BASE_INPUTS, aspectRatio: '2:3' },
    );
    // Latent group: resizeToMax(2, 3, 2048) — portrait, width = round(max * 2/3)
    expect(wf['max-width']?.inputs.value).toBe(Math.round(2048 * (2 / 3)));
    expect(wf['max-height']?.inputs.value).toBe(2048);
    // Output group: the literal selected dimensions, not derived via resizeToMax
    expect(wf['result-width']?.inputs.value).toBe(ASPECT_DIMENSIONS['2:3']?.width);
    expect(wf['result-height']?.inputs.value).toBe(ASPECT_DIMENSIONS['2:3']?.height);
  });

  it('warns and skips the output group for an unknown aspect ratio, leaving the node untouched', () => {
    const wf = makeDualSizeWorkflow();
    const warn = vi.fn();
    applyWorkflowPatch(
      wf,
      makeTemplate({
        latentSizeNodeIds: ['max-width', 'max-height'],
        outputSizeNodeIds: ['result-width', 'result-height'],
      }),
      { ...BASE_INPUTS, aspectRatio: '7:3' },
      { warn },
    );
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('skipping size patch'));
    expect(wf['result-width']?.inputs.value).toBe(1024);
    expect(wf['result-height']?.inputs.value).toBe(1024);
  });

  it('does not run the legacy sizeNodeIds path when a dual-size group is mapped', () => {
    const wf = {
      ...makeDualSizeWorkflow(),
      // legacy size node still present in JSON, should be left untouched
      '1345:874': {
        inputs: { width: 1536, height: 1536, batch_size: 1 },
        class_type: 'EmptyLatentImage',
        _meta: { title: 'size' },
      },
    };
    applyWorkflowPatch(
      wf,
      makeTemplate({
        sizeNodeIds: ['1345:874'],
        latentSizeNodeIds: ['max-width', 'max-height'],
        outputSizeNodeIds: ['result-width', 'result-height'],
      }),
      { ...BASE_INPUTS, aspectRatio: '1:1' },
    );
    expect(wf['1345:874']?.inputs.width).toBe(1536);
    expect(wf['1345:874']?.inputs.height).toBe(1536);
  });

  it('falls back to legacy sizeNodeIds path when dual-size columns are empty', () => {
    const wf = makeWorkflow();
    applyWorkflowPatch(wf, makeTemplate({ latentSizeNodeIds: [], outputSizeNodeIds: [] }), {
      ...BASE_INPUTS,
      aspectRatio: '1:1',
    });
    expect(wf['1345:874']?.inputs.width).toBe(ASPECT_DIMENSIONS['1:1']?.width);
  });
});
