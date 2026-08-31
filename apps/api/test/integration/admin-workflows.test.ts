import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminAuthHeader } from '../helpers/admin.js';
import { buildTestApp, type TestApp } from '../helpers/api.js';
import { type Containers, startContainers } from '../helpers/containers.js';

describe('admin workflows - floor validation', () => {
  let c: Containers;
  let app: TestApp;
  let headers: Record<string, string>;

  beforeAll(async () => {
    c = await startContainers();
    app = await buildTestApp(c);
    headers = await adminAuthHeader(app, 'SUPER_ADMIN');
  }, 60000);

  afterAll(async () => {
    await app?.close();
    await c?.stop();
  });

  const jsonContent = {
    pose_node: { inputs: { image: '' }, class_type: 'LoadImage', _meta: { title: 'pose' } },
    lower_node: { inputs: { image: '' }, class_type: 'LoadImage', _meta: { title: 'lower' } },
    positive_node: {
      inputs: { prompt: 'default' },
      class_type: 'CLIPTextEncode',
      _meta: { title: 'positive_prompt' },
    },
  };

  it('creates a lower-only regular workflow with no face/background/upper node', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/admin/workflows',
      headers,
      payload: {
        slug: `lower_only_${Date.now()}`,
        label: 'Lower only',
        jsonContent,
        workflowType: 'regular',
        poseNodeId: 'pose_node',
        lowerNodeId: 'lower_node',
        garmentPhasePromptNode: 'positive_node',
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.faceNodeId ?? null).toBeNull();
    expect(body.upperNodeIds).toEqual([]);
    expect(body.defaultFacePhasePrompt).toBe('');
  });

  it('rejects a regular workflow with neither upperNodeIds nor lowerNodeId', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/admin/workflows',
      headers,
      payload: {
        slug: `no_garment_role_${Date.now()}`,
        label: 'No garment role',
        jsonContent,
        workflowType: 'regular',
        poseNodeId: 'pose_node',
        garmentPhasePromptNode: 'positive_node',
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects faceNodeId set without facePhasePromptNode', async () => {
    const withFace = {
      ...jsonContent,
      face_node: { inputs: { image: '' }, class_type: 'LoadImage', _meta: { title: 'face' } },
    };
    const response = await app.inject({
      method: 'POST',
      url: '/admin/workflows',
      headers,
      payload: {
        slug: `face_no_prompt_${Date.now()}`,
        label: 'Face no prompt',
        jsonContent: withFace,
        workflowType: 'regular',
        poseNodeId: 'pose_node',
        lowerNodeId: 'lower_node',
        garmentPhasePromptNode: 'positive_node',
        faceNodeId: 'face_node',
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it('PATCH rejects clearing the last garment role, and allows converting to lower-only', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/admin/workflows',
      headers,
      payload: {
        slug: `patch_target_${Date.now()}`,
        label: 'Patch target',
        jsonContent: {
          ...jsonContent,
          upper_node: {
            inputs: { image: '' },
            class_type: 'LoadImage',
            _meta: { title: 'upper' },
          },
        },
        workflowType: 'regular',
        poseNodeId: 'pose_node',
        upperNodeIds: ['upper_node'],
        garmentPhasePromptNode: 'positive_node',
      },
    });
    const id = createRes.json().id as string;

    // Clearing the only garment role outright must be rejected.
    const rejectRes = await app.inject({
      method: 'PATCH',
      url: `/admin/workflows/${id}`,
      headers,
      payload: { upperNodeIds: [] },
    });
    expect(rejectRes.statusCode).toBe(400);

    // Setting lowerNodeId while clearing upperNodeIds in the same request must succeed.
    const convertRes = await app.inject({
      method: 'PATCH',
      url: `/admin/workflows/${id}`,
      headers,
      payload: { upperNodeIds: [], lowerNodeId: 'lower_node' },
    });
    expect(convertRes.statusCode).toBe(200);

    const [row] = await app.db
      .select({
        upperNodeIds: schema.workflowTemplates.upperNodeIds,
        lowerNodeId: schema.workflowTemplates.lowerNodeId,
      })
      .from(schema.workflowTemplates)
      .where(eq(schema.workflowTemplates.id, id));
    expect(row?.upperNodeIds).toEqual([]);
    expect(row?.lowerNodeId).toBe('lower_node');
  });

  it('creates a regular workflow with thirdNodeId and returns it', async () => {
    const withThird = {
      ...jsonContent,
      third_node: {
        inputs: { image: '' },
        class_type: 'LoadImage',
        _meta: { title: 'third_garment' },
      },
    };
    const response = await app.inject({
      method: 'POST',
      url: '/admin/workflows',
      headers,
      payload: {
        slug: `third_node_create_${Date.now()}`,
        label: 'Third node create',
        jsonContent: withThird,
        workflowType: 'regular',
        poseNodeId: 'pose_node',
        lowerNodeId: 'lower_node',
        thirdNodeId: 'third_node',
        garmentPhasePromptNode: 'positive_node',
      },
    });
    expect(response.statusCode).toBe(200);

    const [row] = await app.db
      .select({ thirdNodeId: schema.workflowTemplates.thirdNodeId })
      .from(schema.workflowTemplates)
      .where(eq(schema.workflowTemplates.id, response.json().id));
    expect(row?.thirdNodeId).toBe('third_node');
  });

  it('PATCH persists thirdNodeId', async () => {
    const withThird = {
      ...jsonContent,
      third_node: {
        inputs: { image: '' },
        class_type: 'LoadImage',
        _meta: { title: 'third_garment' },
      },
    };
    const createRes = await app.inject({
      method: 'POST',
      url: '/admin/workflows',
      headers,
      payload: {
        slug: `third_node_patch_${Date.now()}`,
        label: 'Third node patch target',
        jsonContent: withThird,
        workflowType: 'regular',
        poseNodeId: 'pose_node',
        lowerNodeId: 'lower_node',
        garmentPhasePromptNode: 'positive_node',
      },
    });
    const id = createRes.json().id as string;

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/admin/workflows/${id}`,
      headers,
      payload: { thirdNodeId: 'third_node' },
    });
    expect(patchRes.statusCode).toBe(200);

    const [row] = await app.db
      .select({ thirdNodeId: schema.workflowTemplates.thirdNodeId })
      .from(schema.workflowTemplates)
      .where(eq(schema.workflowTemplates.id, id));
    expect(row?.thirdNodeId).toBe('third_node');
  });

  it('PATCH updates garmentPhasePrompt text in both jsonContent and defaultGarmentPhasePrompt', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/admin/workflows',
      headers,
      payload: {
        slug: `prompt_edit_garment_${Date.now()}`,
        label: 'Prompt edit garment',
        jsonContent,
        workflowType: 'regular',
        poseNodeId: 'pose_node',
        lowerNodeId: 'lower_node',
        garmentPhasePromptNode: 'positive_node',
      },
    });
    const id = createRes.json().id as string;

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/admin/workflows/${id}`,
      headers,
      payload: { garmentPhasePrompt: 'a brand new positive prompt' },
    });
    expect(patchRes.statusCode).toBe(200);

    const [row] = await app.db
      .select({
        jsonContent: schema.workflowTemplates.jsonContent,
        defaultGarmentPhasePrompt: schema.workflowTemplates.defaultGarmentPhasePrompt,
      })
      .from(schema.workflowTemplates)
      .where(eq(schema.workflowTemplates.id, id));
    expect(row?.defaultGarmentPhasePrompt).toBe('a brand new positive prompt');
    const stored = row?.jsonContent as Record<string, { inputs: { prompt?: string } }>;
    expect(stored.positive_node.inputs.prompt).toBe('a brand new positive prompt');
  });

  it('PATCH rejects an empty or whitespace-only garmentPhasePrompt', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/admin/workflows',
      headers,
      payload: {
        slug: `prompt_edit_empty_${Date.now()}`,
        label: 'Prompt edit empty',
        jsonContent,
        workflowType: 'regular',
        poseNodeId: 'pose_node',
        lowerNodeId: 'lower_node',
        garmentPhasePromptNode: 'positive_node',
      },
    });
    const id = createRes.json().id as string;

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/admin/workflows/${id}`,
      headers,
      payload: { garmentPhasePrompt: '   ' },
    });
    expect(patchRes.statusCode).toBe(400);
  });

  it('PATCH updates facePhasePrompt when the workflow has a facePhasePromptNode', async () => {
    const withFace = {
      ...jsonContent,
      face_node: { inputs: { image: '' }, class_type: 'LoadImage', _meta: { title: 'face' } },
      negative_node: {
        inputs: { prompt: 'default negative' },
        class_type: 'CLIPTextEncode',
        _meta: { title: 'negative_prompt' },
      },
    };
    const createRes = await app.inject({
      method: 'POST',
      url: '/admin/workflows',
      headers,
      payload: {
        slug: `prompt_edit_face_${Date.now()}`,
        label: 'Prompt edit face',
        jsonContent: withFace,
        workflowType: 'regular',
        poseNodeId: 'pose_node',
        lowerNodeId: 'lower_node',
        garmentPhasePromptNode: 'positive_node',
        faceNodeId: 'face_node',
        facePhasePromptNode: 'negative_node',
      },
    });
    const id = createRes.json().id as string;

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/admin/workflows/${id}`,
      headers,
      payload: { facePhasePrompt: 'a brand new negative prompt' },
    });
    expect(patchRes.statusCode).toBe(200);

    const [row] = await app.db
      .select({
        jsonContent: schema.workflowTemplates.jsonContent,
        defaultFacePhasePrompt: schema.workflowTemplates.defaultFacePhasePrompt,
      })
      .from(schema.workflowTemplates)
      .where(eq(schema.workflowTemplates.id, id));
    expect(row?.defaultFacePhasePrompt).toBe('a brand new negative prompt');
    const stored = row?.jsonContent as Record<string, { inputs: { prompt?: string } }>;
    expect(stored.negative_node.inputs.prompt).toBe('a brand new negative prompt');
  });

  it('PATCH rejects facePhasePrompt when the workflow has no facePhasePromptNode', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/admin/workflows',
      headers,
      payload: {
        slug: `prompt_edit_no_face_${Date.now()}`,
        label: 'Prompt edit no face',
        jsonContent,
        workflowType: 'regular',
        poseNodeId: 'pose_node',
        lowerNodeId: 'lower_node',
        garmentPhasePromptNode: 'positive_node',
      },
    });
    const id = createRes.json().id as string;

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/admin/workflows/${id}`,
      headers,
      payload: { facePhasePrompt: 'should be rejected' },
    });
    expect(patchRes.statusCode).toBe(400);
  });

  it('PATCH allows an empty facePhasePrompt when a facePhasePromptNode exists', async () => {
    const withFace = {
      ...jsonContent,
      face_node: { inputs: { image: '' }, class_type: 'LoadImage', _meta: { title: 'face' } },
      negative_node: {
        inputs: { prompt: 'default negative' },
        class_type: 'CLIPTextEncode',
        _meta: { title: 'negative_prompt' },
      },
    };
    const createRes = await app.inject({
      method: 'POST',
      url: '/admin/workflows',
      headers,
      payload: {
        slug: `prompt_edit_face_empty_${Date.now()}`,
        label: 'Prompt edit face empty',
        jsonContent: withFace,
        workflowType: 'regular',
        poseNodeId: 'pose_node',
        lowerNodeId: 'lower_node',
        garmentPhasePromptNode: 'positive_node',
        faceNodeId: 'face_node',
        facePhasePromptNode: 'negative_node',
      },
    });
    const id = createRes.json().id as string;

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/admin/workflows/${id}`,
      headers,
      payload: { facePhasePrompt: '' },
    });
    expect(patchRes.statusCode).toBe(200);

    const [row] = await app.db
      .select({ defaultFacePhasePrompt: schema.workflowTemplates.defaultFacePhasePrompt })
      .from(schema.workflowTemplates)
      .where(eq(schema.workflowTemplates.id, id));
    expect(row?.defaultFacePhasePrompt).toBe('');
  });

  it('PATCH writes to the "text" key for a node that already uses "text" instead of "prompt"', async () => {
    const textKeyed = {
      ...jsonContent,
      positive_node: {
        inputs: { text: 'default via text key' },
        class_type: 'CLIPTextEncode',
        _meta: { title: 'positive_prompt' },
      },
    };
    const createRes = await app.inject({
      method: 'POST',
      url: '/admin/workflows',
      headers,
      payload: {
        slug: `prompt_edit_textkey_${Date.now()}`,
        label: 'Prompt edit text key',
        jsonContent: textKeyed,
        workflowType: 'regular',
        poseNodeId: 'pose_node',
        lowerNodeId: 'lower_node',
        garmentPhasePromptNode: 'positive_node',
      },
    });
    const id = createRes.json().id as string;

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/admin/workflows/${id}`,
      headers,
      payload: { garmentPhasePrompt: 'updated via text key' },
    });
    expect(patchRes.statusCode).toBe(200);

    const [row] = await app.db
      .select({ jsonContent: schema.workflowTemplates.jsonContent })
      .from(schema.workflowTemplates)
      .where(eq(schema.workflowTemplates.id, id));
    const stored = row?.jsonContent as Record<
      string,
      { inputs: { text?: string; prompt?: string } }
    >;
    expect(stored.positive_node.inputs.text).toBe('updated via text key');
    expect(stored.positive_node.inputs.prompt).toBeUndefined();
  });

  it('GET /admin/workflows list response includes facePhasePromptNode', async () => {
    const withFace = {
      ...jsonContent,
      face_node: { inputs: { image: '' }, class_type: 'LoadImage', _meta: { title: 'face' } },
      negative_node: {
        inputs: { prompt: 'default negative' },
        class_type: 'CLIPTextEncode',
        _meta: { title: 'negative_prompt' },
      },
    };
    const createRes = await app.inject({
      method: 'POST',
      url: '/admin/workflows',
      headers,
      payload: {
        slug: `list_face_node_${Date.now()}`,
        label: 'List face node',
        jsonContent: withFace,
        workflowType: 'regular',
        poseNodeId: 'pose_node',
        lowerNodeId: 'lower_node',
        garmentPhasePromptNode: 'positive_node',
        faceNodeId: 'face_node',
        facePhasePromptNode: 'negative_node',
      },
    });
    const id = createRes.json().id as string;

    const listRes = await app.inject({ method: 'GET', url: '/admin/workflows', headers });
    expect(listRes.statusCode).toBe(200);
    const row = (listRes.json() as { id: string; facePhasePromptNode: string | null }[]).find(
      (w) => w.id === id,
    );
    expect(row?.facePhasePromptNode).toBe('negative_node');
  });

  const jsonContentWithKSampler = {
    ...jsonContent,
    ksampler_node: {
      inputs: {
        seed: 12345,
        steps: 4,
        cfg: 1,
        sampler_name: 'euler',
        scheduler: 'simple',
        denoise: 1,
      },
      class_type: 'KSampler',
      _meta: { title: 'KSampler' },
    },
  };

  it('PATCH updates steps/cfg/denoise via ksamplerOverrides in jsonContent', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/admin/workflows',
      headers,
      payload: {
        slug: `ksampler_edit_${Date.now()}`,
        label: 'KSampler edit',
        jsonContent: jsonContentWithKSampler,
        workflowType: 'regular',
        poseNodeId: 'pose_node',
        lowerNodeId: 'lower_node',
        garmentPhasePromptNode: 'positive_node',
      },
    });
    const id = createRes.json().id as string;

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/admin/workflows/${id}`,
      headers,
      payload: {
        ksamplerOverrides: [{ nodeId: 'ksampler_node', steps: 8, cfg: 2.5, denoise: 0.75 }],
      },
    });
    expect(patchRes.statusCode).toBe(200);

    const [row] = await app.db
      .select({ jsonContent: schema.workflowTemplates.jsonContent })
      .from(schema.workflowTemplates)
      .where(eq(schema.workflowTemplates.id, id));
    const stored = row?.jsonContent as Record<
      string,
      { inputs: { steps?: number; cfg?: number; denoise?: number } }
    >;
    expect(stored.ksampler_node.inputs.steps).toBe(8);
    expect(stored.ksampler_node.inputs.cfg).toBe(2.5);
    expect(stored.ksampler_node.inputs.denoise).toBe(0.75);
  });

  it('PATCH rejects a ksamplerOverrides steps below 1', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/admin/workflows',
      headers,
      payload: {
        slug: `ksampler_steps_${Date.now()}`,
        label: 'KSampler steps invalid',
        jsonContent: jsonContentWithKSampler,
        workflowType: 'regular',
        poseNodeId: 'pose_node',
        lowerNodeId: 'lower_node',
        garmentPhasePromptNode: 'positive_node',
      },
    });
    const id = createRes.json().id as string;

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/admin/workflows/${id}`,
      headers,
      payload: { ksamplerOverrides: [{ nodeId: 'ksampler_node', steps: 0 }] },
    });
    expect(patchRes.statusCode).toBe(400);
  });

  it('PATCH rejects a negative ksamplerOverrides cfg', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/admin/workflows',
      headers,
      payload: {
        slug: `ksampler_cfg_${Date.now()}`,
        label: 'KSampler cfg invalid',
        jsonContent: jsonContentWithKSampler,
        workflowType: 'regular',
        poseNodeId: 'pose_node',
        lowerNodeId: 'lower_node',
        garmentPhasePromptNode: 'positive_node',
      },
    });
    const id = createRes.json().id as string;

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/admin/workflows/${id}`,
      headers,
      payload: { ksamplerOverrides: [{ nodeId: 'ksampler_node', cfg: -1 }] },
    });
    expect(patchRes.statusCode).toBe(400);
  });

  it('PATCH rejects a ksamplerOverrides denoise outside [0, 1]', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/admin/workflows',
      headers,
      payload: {
        slug: `ksampler_denoise_${Date.now()}`,
        label: 'KSampler denoise invalid',
        jsonContent: jsonContentWithKSampler,
        workflowType: 'regular',
        poseNodeId: 'pose_node',
        lowerNodeId: 'lower_node',
        garmentPhasePromptNode: 'positive_node',
      },
    });
    const id = createRes.json().id as string;

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/admin/workflows/${id}`,
      headers,
      payload: { ksamplerOverrides: [{ nodeId: 'ksampler_node', denoise: 1.5 }] },
    });
    expect(patchRes.statusCode).toBe(400);
  });

  it('PATCH rejects a ksamplerOverrides nodeId that does not exist in the workflow', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/admin/workflows',
      headers,
      payload: {
        slug: `ksampler_missing_${Date.now()}`,
        label: 'KSampler missing node',
        jsonContent,
        workflowType: 'regular',
        poseNodeId: 'pose_node',
        lowerNodeId: 'lower_node',
        garmentPhasePromptNode: 'positive_node',
      },
    });
    const id = createRes.json().id as string;

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/admin/workflows/${id}`,
      headers,
      payload: { ksamplerOverrides: [{ nodeId: 'ksampler_node', steps: 10 }] },
    });
    expect(patchRes.statusCode).toBe(400);
  });

  it('GET list and GET detail agree on ksamplerNodes for the same workflow', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/admin/workflows',
      headers,
      payload: {
        slug: `ksampler_agree_${Date.now()}`,
        label: 'KSampler agreement',
        jsonContent: jsonContentWithKSampler,
        workflowType: 'regular',
        poseNodeId: 'pose_node',
        lowerNodeId: 'lower_node',
        garmentPhasePromptNode: 'positive_node',
      },
    });
    const id = createRes.json().id as string;

    const listRes = await app.inject({ method: 'GET', url: '/admin/workflows', headers });
    const detailRes = await app.inject({
      method: 'GET',
      url: `/admin/workflows/${id}`,
      headers,
    });
    type KSamplerNode = {
      nodeId: string;
      steps: number | null;
      cfg: number | null;
      denoise: number | null;
      seed: number | null;
    };
    const listItem = (listRes.json() as { id: string; ksamplerNodes: KSamplerNode[] }[]).find(
      (w) => w.id === id,
    );
    const detail = detailRes.json() as { ksamplerNodes: KSamplerNode[] };
    expect(listItem?.ksamplerNodes).toEqual([
      { nodeId: 'ksampler_node', steps: 4, cfg: 1, denoise: 1, seed: 12345 },
    ]);
    expect(detail.ksamplerNodes).toEqual(listItem?.ksamplerNodes);
  });

  it('PATCH with only steps in ksamplerOverrides leaves cfg/denoise unchanged', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/admin/workflows',
      headers,
      payload: {
        slug: `ksampler_partial_${Date.now()}`,
        label: 'KSampler partial update',
        jsonContent: jsonContentWithKSampler,
        workflowType: 'regular',
        poseNodeId: 'pose_node',
        lowerNodeId: 'lower_node',
        garmentPhasePromptNode: 'positive_node',
      },
    });
    const id = createRes.json().id as string;

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/admin/workflows/${id}`,
      headers,
      payload: { ksamplerOverrides: [{ nodeId: 'ksampler_node', steps: 20 }] },
    });
    expect(patchRes.statusCode).toBe(200);

    const [row] = await app.db
      .select({ jsonContent: schema.workflowTemplates.jsonContent })
      .from(schema.workflowTemplates)
      .where(eq(schema.workflowTemplates.id, id));
    const stored = row?.jsonContent as Record<
      string,
      { inputs: { steps?: number; cfg?: number; denoise?: number } }
    >;
    expect(stored.ksampler_node.inputs.steps).toBe(20);
    expect(stored.ksampler_node.inputs.cfg).toBe(1);
    expect(stored.ksampler_node.inputs.denoise).toBe(1);
  });

  it('POST seeds every new workflow with the 5 default regeneration reasons', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/admin/workflows',
      headers,
      payload: {
        slug: `default_reasons_${Date.now()}`,
        label: 'Default reasons',
        jsonContent,
        workflowType: 'regular',
        poseNodeId: 'pose_node',
        lowerNodeId: 'lower_node',
        garmentPhasePromptNode: 'positive_node',
      },
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.regenerationReasonPrompts).toEqual([
      { reason: 'Multiple body parts', prompt: '' },
      { reason: 'Nudity', prompt: '' },
      { reason: 'Draping issue', prompt: '' },
      { reason: 'Additional assets', prompt: '' },
      { reason: 'Texture issue', prompt: '' },
    ]);
  });

  it('PATCH keeps blank-prompt regeneration reasons instead of dropping them', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/admin/workflows',
      headers,
      payload: {
        slug: `keep_blank_reasons_${Date.now()}`,
        label: 'Keep blank reasons',
        jsonContent,
        workflowType: 'regular',
        poseNodeId: 'pose_node',
        lowerNodeId: 'lower_node',
        garmentPhasePromptNode: 'positive_node',
      },
    });
    const id = createRes.json().id as string;

    // Simulates the admin edit screen: save right after opening, with the
    // default reasons still present but none of them given a prompt yet.
    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/admin/workflows/${id}`,
      headers,
      payload: {
        regenerationReasonPrompts: [
          { reason: 'Multiple body parts', prompt: '' },
          { reason: 'Nudity', prompt: '' },
          { reason: 'Draping issue', prompt: 'garment sits flat, no fabric warping' },
          { reason: '  ', prompt: 'should be dropped — blank reason label' },
        ],
      },
    });
    expect(patchRes.statusCode).toBe(200);

    const [row] = await app.db
      .select({ regenerationReasonPrompts: schema.workflowTemplates.regenerationReasonPrompts })
      .from(schema.workflowTemplates)
      .where(eq(schema.workflowTemplates.id, id));
    expect(row?.regenerationReasonPrompts).toEqual([
      { reason: 'Multiple body parts', prompt: '' },
      { reason: 'Nudity', prompt: '' },
      { reason: 'Draping issue', prompt: 'garment sits flat, no fabric warping' },
    ]);
  });

  describe('workflow replace with drain', () => {
    it('rejects replace with wrong admin password', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/admin/workflows',
        headers,
        payload: {
          slug: `replace_bad_pw_${Date.now()}`,
          label: 'Replace Bad PW',
          jsonContent,
          workflowType: 'regular',
          poseNodeId: 'pose_node',
          lowerNodeId: 'lower_node',
          garmentPhasePromptNode: 'positive_node',
        },
      });
      expect(createRes.statusCode).toBe(200);
      const id = createRes.json().id as string;

      const replaceRes = await app.inject({
        method: 'POST',
        url: `/admin/workflows/${id}/replace`,
        headers,
        payload: {
          slug: `replace_bad_pw_${Date.now()}`,
          label: 'Replaced Label',
          jsonContent,
          workflowType: 'regular',
          poseNodeId: 'pose_node',
          lowerNodeId: 'lower_node',
          garmentPhasePromptNode: 'positive_node',
          password: 'wrongpassword',
        },
      });
      expect(replaceRes.statusCode).toBe(401);
    });

    async function seedNonTerminalJobOnTemplate(workflowTemplateId: string, version: number) {
      const [user] = await app.db
        .insert(schema.users)
        .values({
          email: `replace-drain-${Date.now()}-${Math.random()}@example.com`,
          passwordHash: null,
          tier: 'free',
        })
        .returning();
      const [job] = await app.db
        .insert(schema.jobs)
        .values({ userId: user.id, status: 'QUEUED', creditsCharged: 1 })
        .returning();
      await app.db.insert(schema.jobInputs).values({
        jobId: job.id,
        params: { workflowTemplateId, dispatchTemplateVersion: version },
      });
      return job.id;
    }

    it('replaces a workflow with no in-flight jobs immediately, without archiving or draining', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/admin/workflows',
        headers,
        payload: {
          slug: `replace_no_jobs_${Date.now()}`,
          label: 'Initial Label',
          jsonContent,
          workflowType: 'regular',
          poseNodeId: 'pose_node',
          lowerNodeId: 'lower_node',
          garmentPhasePromptNode: 'positive_node',
        },
      });
      expect(createRes.statusCode).toBe(200);
      const id = createRes.json().id as string;

      // No job anywhere references this brand-new template — replacing it
      // should not archive anything, since there is nothing to drain.
      const replaceRes = await app.inject({
        method: 'POST',
        url: `/admin/workflows/${id}/replace`,
        headers,
        payload: {
          slug: `replace_no_jobs_${Date.now()}`,
          label: 'Replaced Label',
          jsonContent,
          workflowType: 'regular',
          poseNodeId: 'pose_node',
          lowerNodeId: 'lower_node',
          garmentPhasePromptNode: 'positive_node',
          password: 'password123',
        },
      });
      expect(replaceRes.statusCode).toBe(200);
      const replacedBody = replaceRes.json();
      expect(replacedBody.version).toBe(2);
      expect(replacedBody.draining).toBeNull();

      const [archiveRow] = await app.db
        .select()
        .from(schema.workflowTemplateArchives)
        .where(eq(schema.workflowTemplateArchives.workflowTemplateId, id));
      expect(archiveRow).toBeUndefined();

      // A second replace must succeed right away — nothing is draining, so
      // there is no conflict to wait out.
      const replaceAgainRes = await app.inject({
        method: 'POST',
        url: `/admin/workflows/${id}/replace`,
        headers,
        payload: {
          slug: `replace_no_jobs_${Date.now()}`,
          label: 'Replaced Again',
          jsonContent,
          workflowType: 'regular',
          poseNodeId: 'pose_node',
          lowerNodeId: 'lower_node',
          garmentPhasePromptNode: 'positive_node',
          password: 'password123',
        },
      });
      expect(replaceAgainRes.statusCode).toBe(200);
      expect(replaceAgainRes.json().version).toBe(3);
      expect(replaceAgainRes.json().draining).toBeNull();
    });

    it('replaces workflow, increments version to 2, archives old version, and reports draining', async () => {
      const createRes = await app.inject({
        method: 'POST',
        url: '/admin/workflows',
        headers,
        payload: {
          slug: `replace_success_${Date.now()}`,
          label: 'Initial Label',
          jsonContent,
          workflowType: 'regular',
          poseNodeId: 'pose_node',
          lowerNodeId: 'lower_node',
          garmentPhasePromptNode: 'positive_node',
        },
      });
      expect(createRes.statusCode).toBe(200);
      const id = createRes.json().id as string;

      // Check initial GET returns version 1 and draining: null
      const getInitial = await app.inject({
        method: 'GET',
        url: `/admin/workflows/${id}`,
        headers,
      });
      expect(getInitial.statusCode).toBe(200);
      expect(getInitial.json().version).toBe(1);
      expect(getInitial.json().draining).toBeNull();

      // A non-terminal job stamped with the current (v1) version is the only
      // thing that should make this replace archive anything.
      await seedNonTerminalJobOnTemplate(id, 1);

      // Replace with new label and new positive prompt
      const newJson = {
        ...jsonContent,
        positive_node: {
          inputs: { prompt: 'replaced prompt' },
          class_type: 'CLIPTextEncode',
          _meta: { title: 'positive_prompt' },
        },
      };

      const replaceRes = await app.inject({
        method: 'POST',
        url: `/admin/workflows/${id}/replace`,
        headers,
        payload: {
          slug: `replace_success_${Date.now()}`,
          label: 'Replaced Label',
          jsonContent: newJson,
          workflowType: 'regular',
          poseNodeId: 'pose_node',
          lowerNodeId: 'lower_node',
          garmentPhasePromptNode: 'positive_node',
          password: 'password123',
        },
      });
      expect(replaceRes.statusCode).toBe(200);
      const replacedBody = replaceRes.json();
      expect(replacedBody.version).toBe(2);
      expect(replacedBody.label).toBe('Replaced Label');
      expect(replacedBody.defaultGarmentPhasePrompt).toBe('replaced prompt');
      expect(replacedBody.draining).toEqual({ fromVersion: 1 });

      // Verify DB state: live row is version 2
      const [liveRow] = await app.db
        .select()
        .from(schema.workflowTemplates)
        .where(eq(schema.workflowTemplates.id, id));
      expect(liveRow?.version).toBe(2);
      expect(liveRow?.label).toBe('Replaced Label');

      // Verify DB state: archive row holds version 1
      const [archiveRow] = await app.db
        .select()
        .from(schema.workflowTemplateArchives)
        .where(eq(schema.workflowTemplateArchives.workflowTemplateId, id));
      expect(archiveRow).toBeDefined();
      expect(archiveRow?.version).toBe(1);
      expect(archiveRow?.defaultGarmentPhasePrompt).toBe('default');

      // Check GET /admin/workflows/:id returns draining status
      const getReplaced = await app.inject({
        method: 'GET',
        url: `/admin/workflows/${id}`,
        headers,
      });
      expect(getReplaced.statusCode).toBe(200);
      expect(getReplaced.json().version).toBe(2);
      expect(getReplaced.json().draining).toEqual({ fromVersion: 1 });

      // Check GET /admin/workflows list also includes draining
      const getList = await app.inject({
        method: 'GET',
        url: '/admin/workflows',
        headers,
      });
      expect(getList.statusCode).toBe(200);
      const listItem = getList.json().find((w: { id: string }) => w.id === id);
      expect(listItem?.version).toBe(2);
      expect(listItem?.draining).toEqual({ fromVersion: 1 });

      // Attempting to replace again while draining must return 409 CONFLICT
      const replaceAgainRes = await app.inject({
        method: 'POST',
        url: `/admin/workflows/${id}/replace`,
        headers,
        payload: {
          slug: `replace_success_${Date.now()}`,
          label: 'Replaced Again',
          jsonContent: newJson,
          workflowType: 'regular',
          poseNodeId: 'pose_node',
          lowerNodeId: 'lower_node',
          garmentPhasePromptNode: 'positive_node',
          password: 'password123',
        },
      });
      expect(replaceAgainRes.statusCode).toBe(409);
      expect(replaceAgainRes.json().error.message).toContain('draining');
    });
  });
});
