import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { schema } from '@tryme/db';
import { createLogger } from '@tryme/logger';
import { eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { processJob } from '../../src/job/processor.js';
import { deregisterWorker, registerWorkers, setWorkerStatus } from '../../src/worker/registry.js';
import { type ComfyMock, startComfyMock } from '../helpers/comfy-mock.js';
import { setupTestEnv, type TestEnv } from '../helpers/containers.js';

const WORKER_ID = 'test-worker-replace-drain';

describe('dispatcher — workflow replace and drain integration', () => {
  let env: TestEnv;
  let redis: Redis;
  let pub: Redis;
  let comfy: ComfyMock;

  beforeAll(async () => {
    env = await setupTestEnv();
    redis = new Redis('redis://127.0.0.1:6379');
    pub = new Redis('redis://127.0.0.1:6379');
    comfy = await startComfyMock();

    await registerWorkers(redis, [
      { id: WORKER_ID, url: comfy.url, apiKey: 'test-key', allowedJobTypes: ['catalogue'] },
    ]);
    await redis.setex(`worker:health:${WORKER_ID}`, 30, '1');
  }, 60_000);

  afterAll(async () => {
    await deregisterWorker(redis, WORKER_ID);
    await comfy.close();
    redis.disconnect();
    pub.disconnect();
    await env.cleanup();
  });

  beforeEach(async () => {
    comfy.setOptions({});
    await setWorkerStatus(redis, WORKER_ID, 'IDLE');
  });

  // `marker` sits on the SaveImage node's inputs, a field applyWorkflowPatch
  // never reads or writes (patching only ever touches the mapped
  // face/pose/bg/upper/prompt/size nodes) — so whatever value is here in the
  // stored jsonContent survives unchanged into what's actually POSTed to
  // ComfyUI. This is the test's proof of *which version's graph* was
  // dispatched, independent of prompt text: patcher.ts's applyWorkflowPatch
  // always overrides the garment-phase prompt node with the job's/pose's own
  // promptGarmentPhase when set (patcher.ts:147), so prompt text is
  // identical across every job in this test regardless of which template
  // version supplied it — it cannot distinguish v1 from v2 the way the
  // marker field can.
  function baseWorkflowFields(promptText: string, marker: string) {
    return {
      jsonContent: {
        f: { class_type: 'LoadImage', inputs: { image: 'x.jpg' } },
        p: { class_type: 'LoadImage', inputs: { image: 'x.jpg' } },
        b: { class_type: 'LoadImage', inputs: { image: 'x.jpg' } },
        g: { class_type: 'LoadImage', inputs: { image: 'x.jpg' } },
        prompt_pos: { class_type: 'CLIPTextEncode', inputs: { text: promptText } },
        out: { class_type: 'SaveImage', inputs: { images: ['f', 0], marker } },
      },
      workflowType: 'regular',
      faceNodeId: 'f',
      poseNodeId: 'p',
      bgNodeId: 'b',
      upperNodeIds: ['g'],
      facePhasePromptNode: null,
      garmentPhasePromptNode: 'prompt_pos',
      defaultFacePhasePrompt: '',
      defaultGarmentPhasePrompt: promptText,
      resultNodeId: '10',
    };
  }

  it('drains old version jobs from archive, cleans up archive on last job, and routes new jobs to live version', async () => {
    const [user] = await env.db
      .insert(schema.users)
      .values({ email: `drain-test-${Date.now()}@test.com`, passwordHash: 'x', tier: 'free' })
      .returning();
    await env.db.insert(schema.userCredits).values({ userId: user.id, balance: 100 });

    // 1. Create v1 workflow template
    const [template] = await env.db
      .insert(schema.workflowTemplates)
      .values({
        slug: `drain-wf-${Date.now()}`,
        label: 'Drain Workflow (v1)',
        version: 1,
        ...baseWorkflowFields('v1 base prompt', 'v1-marker'),
      })
      .returning();

    const [face] = await env.db
      .insert(schema.modelFaces)
      .values({
        gender: 'women',
        label: 'F',
        r2Key: 'f.jpg',
        thumbnailKey: 'f.jpg',
        faceSideR2Key: 'f.jpg',
      })
      .returning();
    const [bg] = await env.db
      .insert(schema.modelBackgrounds)
      .values({ label: 'Bg', r2Key: 'b.jpg', thumbnailKey: 'b.jpg' })
      .returning();
    const [pose] = await env.db
      .insert(schema.modelPoseAssets)
      .values({
        label: 'Pose',
        r2Key: 'p.jpg',
        thumbnailKey: 'p.jpg',
        workflowTemplateId: template.id,
        promptGarmentPhase: 'custom garment prompt',
      })
      .returning();

    for (const key of ['garment.jpg', 'f.jpg', 'b.jpg', 'p.jpg']) {
      await env.s3.send(
        new PutObjectCommand({
          Bucket: env.r2Bucket,
          Key: key,
          Body: Buffer.from('stub'),
          ContentType: 'image/jpeg',
        }),
      );
    }

    // 2. Create Job 1 (queued while workflow is at v1)
    const [job1] = await env.db
      .insert(schema.jobs)
      .values({ userId: user.id, status: 'QUEUED', priority: false, creditsCharged: 1 })
      .returning();
    await env.db.insert(schema.jobInputs).values({
      jobId: job1.id,
      upperGarmentKey: 'garment.jpg',
      faceId: face.id,
      backgroundId: bg.id,
      poseId: pose.id,
      params: { dispatchTemplateVersion: 1 },
    });

    // Also create Job 1B (another v1 job) to test partial drain vs final drain cleanup
    const [job1B] = await env.db
      .insert(schema.jobs)
      .values({ userId: user.id, status: 'QUEUED', priority: false, creditsCharged: 1 })
      .returning();
    await env.db.insert(schema.jobInputs).values({
      jobId: job1B.id,
      upperGarmentKey: 'garment.jpg',
      faceId: face.id,
      backgroundId: bg.id,
      poseId: pose.id,
      params: { dispatchTemplateVersion: 1 },
    });

    // 3. Simulate workflow replace: archive v1, update template to v2
    await env.db.insert(schema.workflowTemplateArchives).values({
      workflowTemplateId: template.id,
      version: 1,
      ...baseWorkflowFields('v1 archived prompt', 'v1-marker'),
    });

    await env.db
      .update(schema.workflowTemplates)
      .set({
        label: 'Drain Workflow (v2)',
        version: 2,
        ...baseWorkflowFields('v2 live prompt', 'v2-marker'),
      })
      .where(eq(schema.workflowTemplates.id, template.id));

    // 4. Create Job 2 (queued while workflow is at v2)
    const [job2] = await env.db
      .insert(schema.jobs)
      .values({ userId: user.id, status: 'QUEUED', priority: false, creditsCharged: 1 })
      .returning();
    await env.db.insert(schema.jobInputs).values({
      jobId: job2.id,
      upperGarmentKey: 'garment.jpg',
      faceId: face.id,
      backgroundId: bg.id,
      poseId: pose.id,
      params: { dispatchTemplateVersion: 2 },
    });

    const log = createLogger('test');

    // 5. Process Job 1 (stamped v1) -> should resolve archive v1
    await processJob(
      { db: env.db, redis, pub, storage: env.storage, s3: env.s3, r2Bucket: env.r2Bucket, log },
      job1.id,
      user.id,
      'jobs:normal',
      '1-1',
    );

    const [completedJob1] = await env.db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.id, job1.id));
    expect(completedJob1?.status).toBe('COMPLETED');

    // Proves the ARCHIVED (v1) graph was actually submitted to ComfyUI, not
    // just that the job completed — completion alone would also happen if
    // the resolver silently fell back to the live v2 content.
    expect(comfy.lastPrompt()?.prompt.out.inputs?.marker).toBe('v1-marker');

    // Archive row should STILL exist because job1B is still QUEUED with v1
    const [archiveAfterJob1] = await env.db
      .select()
      .from(schema.workflowTemplateArchives)
      .where(eq(schema.workflowTemplateArchives.workflowTemplateId, template.id));
    expect(archiveAfterJob1).toBeDefined();
    expect(archiveAfterJob1?.version).toBe(1);

    // 6. Process Job 1B (last v1 job) -> should complete and delete archive row
    await setWorkerStatus(redis, WORKER_ID, 'IDLE');
    await processJob(
      { db: env.db, redis, pub, storage: env.storage, s3: env.s3, r2Bucket: env.r2Bucket, log },
      job1B.id,
      user.id,
      'jobs:normal',
      '1-2',
    );

    const [completedJob1B] = await env.db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.id, job1B.id));
    expect(completedJob1B?.status).toBe('COMPLETED');

    // Still the archived (v1) graph — the archive hasn't been cleaned up yet
    // at the moment this job actually dispatched.
    expect(comfy.lastPrompt()?.prompt.out.inputs?.marker).toBe('v1-marker');

    // Archive row should now be DELETED since 0 non-terminal v1 jobs remain
    const [archiveAfterJob1B] = await env.db
      .select()
      .from(schema.workflowTemplateArchives)
      .where(eq(schema.workflowTemplateArchives.workflowTemplateId, template.id));
    expect(archiveAfterJob1B).toBeUndefined();

    // 7. Process Job 2 (stamped v2) -> should resolve live v2
    await setWorkerStatus(redis, WORKER_ID, 'IDLE');
    await processJob(
      { db: env.db, redis, pub, storage: env.storage, s3: env.s3, r2Bucket: env.r2Bucket, log },
      job2.id,
      user.id,
      'jobs:normal',
      '1-3',
    );

    const [completedJob2] = await env.db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.id, job2.id));
    expect(completedJob2?.status).toBe('COMPLETED');

    // Proves the LIVE (v2) graph was submitted for a job stamped with the
    // current version — the resolver's "snapshotVersion matches live" path.
    expect(comfy.lastPrompt()?.prompt.out.inputs?.marker).toBe('v2-marker');

    const obj = await env.s3.send(
      new GetObjectCommand({ Bucket: env.r2Bucket, Key: `outputs/${job2.id}/result.png` }),
    );
    expect(obj.$metadata.httpStatusCode).toBe(200);
  });
});
