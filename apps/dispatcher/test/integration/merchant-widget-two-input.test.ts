import { PutObjectCommand } from '@aws-sdk/client-s3';
import { schema } from '@tryme/db';
import { createLogger } from '@tryme/logger';
import { and, eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import sharp from 'sharp';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { processJob } from '../../src/job/processor.js';
import { deregisterWorker, registerWorkers, setWorkerStatus } from '../../src/worker/registry.js';
import { type ComfyMock, startComfyMock } from '../helpers/comfy-mock.js';
import { setupTestEnv, type TestEnv } from '../helpers/containers.js';

const WORKER_ID = 'test-worker-merchant-widget-two-input';
const PERSON_NODE_ID = '26';
const GARMENT_NODE_ID = '30'; // body
const GARMENT_NODE_ID_2 = '27'; // pallu
// comfy-mock's /history handler hardcodes output images under node '10'.
const OUTPUT_NODE_ID = '10';

// Covers Task 7 of docs/superpowers/plans/2026-08-20-merchant-catalog-two-input-direct-tryon.md
// — the dispatcher's patching of a SECOND garment node (pallu) into the ComfyUI workflow for
// a merchant tryon job. merchant-widget-webp.test.ts covers the single-garment-node path;
// this file is the two-node counterpart, previously untested (the plan only asked for a
// typecheck step on Task 7, not a test — this closes that gap).
describe('merchant widget job — two-input (body + pallu) garment patching', () => {
  let env: TestEnv;
  let redis: Redis;
  let pub: Redis;
  let comfy: ComfyMock;
  let realOutputBytes: Uint8Array;

  beforeAll(async () => {
    env = await setupTestEnv();
    redis = new Redis('redis://127.0.0.1:6379');
    pub = new Redis('redis://127.0.0.1:6379');
    comfy = await startComfyMock();

    await registerWorkers(redis, [
      { id: WORKER_ID, url: comfy.url, apiKey: 'test-key', allowedJobTypes: ['merchant'] },
    ]);
    await redis.setex(`worker:health:${WORKER_ID}`, 30, '1');

    realOutputBytes = await sharp({
      create: { width: 640, height: 800, channels: 3, background: { r: 90, g: 140, b: 200 } },
    })
      .png()
      .toBuffer();
  }, 60_000);

  afterAll(async () => {
    await deregisterWorker(redis, WORKER_ID);
    await comfy.close();
    redis.disconnect();
    pub.disconnect();
    await env.cleanup();
  });

  beforeEach(async () => {
    comfy.setOptions({ outputBytes: realOutputBytes });
    await setWorkerStatus(redis, WORKER_ID, 'IDLE');
  });

  async function seedTwoInputMerchantWidgetJob(opts: { thirdGarmentKey?: string | null } = {}) {
    const [user] = await env.db
      .insert(schema.users)
      .values({ email: `merchant-owner-2in-${Date.now()}@test.com`, displayName: 'Merchant Owner' })
      .returning();
    if (!user) throw new Error('failed to seed user');

    const [merchant] = await env.db
      .insert(schema.merchants)
      .values({
        companyName: 'Test Co',
        contactName: 'Test Contact',
        phone: '0000000000',
        businessAddress: 'Nowhere',
        isActive: true,
        userId: user.id,
      })
      .returning();
    if (!merchant) throw new Error('failed to seed merchant');

    const [template] = await env.db
      .insert(schema.workflowTemplates)
      .values({
        slug: `merchant-widget-two-input-tpl-${Date.now()}`,
        label: 'Merchant widget two-input test template',
        jsonContent: {
          [PERSON_NODE_ID]: { inputs: { image: '' } },
          [GARMENT_NODE_ID]: { inputs: { image: '' } },
          [GARMENT_NODE_ID_2]: { inputs: { image: '' } },
          [OUTPUT_NODE_ID]: { class_type: 'SaveImage', inputs: {} },
        },
        faceNodeId: 'x',
        poseNodeId: 'x',
        bgNodeId: 'x',
        upperNodeIds: ['x'],
        facePhasePromptNode: 'x',
        garmentPhasePromptNode: 'x',
        workflowType: 'saree_step1_two_input',
        tryonPersonNodeId: PERSON_NODE_ID,
        tryonGarmentNodeId: GARMENT_NODE_ID,
        tryonGarmentNodeId2: GARMENT_NODE_ID_2,
        tryonOutputNodeId: OUTPUT_NODE_ID,
      })
      .returning();
    if (!template) throw new Error('failed to seed workflow template');

    const customerPhotoKey = `widget-inputs/${merchant.id}/photo.jpg`;
    const bodyKey = `merchant-garments/${merchant.id}/body.jpg`;
    const palluKey = `merchant-garments/${merchant.id}/pallu.jpg`;

    // biome-ignore lint/suspicious/noExplicitAny: merchantId/customerPhotoKey are widget-only job columns
    const [job] = await (env.db.insert(schema.jobs).values as any)({
      merchantId: merchant.id,
      customerPhotoKey,
      status: 'QUEUED',
      creditsCharged: 2,
    }).returning();
    if (!job) throw new Error('failed to seed job');

    const thirdGarmentKey = opts.thirdGarmentKey === undefined ? palluKey : opts.thirdGarmentKey;

    // biome-ignore lint/suspicious/noExplicitAny: params/faceId etc. are widget-only job_inputs shape
    await (env.db.insert(schema.jobInputs).values as any)({
      jobId: job.id,
      upperGarmentKey: bodyKey,
      thirdGarmentKey,
      faceId: null,
      backgroundId: null,
      poseId: null,
      params: { workflowTemplateId: template.id },
    });

    const uploadKeys = [customerPhotoKey, bodyKey];
    if (thirdGarmentKey) uploadKeys.push(thirdGarmentKey);
    for (const key of uploadKeys) {
      await env.s3.send(
        new PutObjectCommand({
          Bucket: env.r2Bucket,
          Key: key,
          Body: Buffer.from('stub'),
          ContentType: 'image/jpeg',
        }),
      );
    }

    return { jobId: job.id as string, merchantId: merchant.id };
  }

  it('patches all three nodes (person, body, pallu) and completes the job', async () => {
    const { jobId } = await seedTwoInputMerchantWidgetJob();
    const log = createLogger('test');

    await processJob(
      { db: env.db, redis, pub, storage: env.storage, s3: env.s3, r2Bucket: env.r2Bucket, log },
      jobId,
      '',
      'jobs:normal',
      `${Date.now()}-0`,
    );

    const [job] = await env.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
    expect(job?.status).toBe('COMPLETED');

    const prompt = comfy.lastPrompt();
    expect(prompt).not.toBeNull();
    const patched = prompt?.prompt as Record<string, { inputs?: Record<string, unknown> }>;
    expect(patched[PERSON_NODE_ID]?.inputs?.image).toMatch(/^uploaded-merchant_customer_/);
    expect(patched[GARMENT_NODE_ID]?.inputs?.image).toMatch(/^uploaded-merchant_garment_/);
    expect(patched[GARMENT_NODE_ID_2]?.inputs?.image).toMatch(/^uploaded-merchant_garment2_/);

    const [event] = await env.db
      .select()
      .from(schema.jobEvents)
      .where(
        and(eq(schema.jobEvents.jobId, jobId), eq(schema.jobEvents.eventType, 'COMFY_DISPATCH')),
      );
    const payload = event?.payload as { inputs?: { secondGarmentFilename?: string | null } };
    expect(payload?.inputs?.secondGarmentFilename).toMatch(/^uploaded-merchant_garment2_/);
  });

  it('fails loud instead of silently dropping the pallu image when the template expects one but the job has none', async () => {
    const { jobId } = await seedTwoInputMerchantWidgetJob({ thirdGarmentKey: null });
    const log = createLogger('test');

    await processJob(
      { db: env.db, redis, pub, storage: env.storage, s3: env.s3, r2Bucket: env.r2Bucket, log },
      jobId,
      '',
      'jobs:normal',
      `${Date.now()}-0`,
    );

    const [job] = await env.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
    expect(job?.status).toBe('FAILED');
    expect(job?.errorCode).toBe('TRYON_NODES_NOT_CONFIGURED');
  });
});
