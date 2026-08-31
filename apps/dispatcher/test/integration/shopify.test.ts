import crypto from 'node:crypto';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { schema } from '@tryme/db';
import { createLogger } from '@tryme/logger';
import { eq, sql } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { processJob } from '../../src/job/processor.js';
import { deregisterWorker, registerWorkers, setWorkerStatus } from '../../src/worker/registry.js';
import { type ComfyMock, startComfyMock } from '../helpers/comfy-mock.js';
import { setupTestEnv, type TestEnv } from '../helpers/containers.js';

const WORKER_ID = 'test-worker-shopify';
const PERSON_NODE_ID = '20';
const GARMENT_NODE_ID = '21';
// The comfy-mock's /history handler hardcodes output images under node '10' —
// match that here so fetchHistory's resultNodeId filter actually finds them.
const OUTPUT_NODE_ID = '10';

describe('dispatcher shopify job routing', () => {
  let env: TestEnv;
  let redis: Redis;
  let pub: Redis;
  let comfy: ComfyMock;

  beforeAll(async () => {
    env = await setupTestEnv();
    redis = new Redis('redis://127.0.0.1:6379');
    pub = new Redis('redis://127.0.0.1:6379');
    comfy = await startComfyMock();

    // Only accepts 'shopify' job type — proves processShopifyJob's
    // selectWorker(redis, 'shopify') call (not 'catalogue'/'saree'/'tryon') is
    // what actually claims this worker.
    await registerWorkers(redis, [
      { id: WORKER_ID, url: comfy.url, apiKey: 'test-key', allowedJobTypes: ['shopify'] },
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

  async function seedShopifyJob() {
    const [store] = await env.db
      .insert(schema.shopifyStores)
      .values({
        shopDomain: `shopify-${Date.now()}.myshopify.com`,
        shopifyShopId: Date.now(),
        accessToken: 'enc',
        scope: 'read_products',
      })
      .returning();
    if (!store) throw new Error('failed to seed store');

    const [template] = await env.db
      .insert(schema.workflowTemplates)
      .values({
        slug: `shopify-tpl-${Date.now()}`,
        label: 'Shopify test template',
        jsonContent: {
          [PERSON_NODE_ID]: { inputs: { image: '' } },
          [GARMENT_NODE_ID]: { inputs: { image: '' } },
          [OUTPUT_NODE_ID]: { class_type: 'SaveImage', inputs: {} },
        },
        faceNodeId: 'x',
        poseNodeId: 'x',
        bgNodeId: 'x',
        upperNodeIds: ['x'],
        facePhasePromptNode: 'x',
        garmentPhasePromptNode: 'x',
        workflowType: 'tryon',
        tryonPersonNodeId: PERSON_NODE_ID,
        tryonGarmentNodeId: GARMENT_NODE_ID,
        tryonOutputNodeId: OUTPUT_NODE_ID,
      })
      .returning();

    // biome-ignore lint/suspicious/noExplicitAny: db insert mocking
    const [job] = await (env.db.insert(schema.jobs).values as any)({
      shopifyStoreId: store.id,
      customerPhotoKey: `widget-inputs/${store.id}/photo.jpg`,
      status: 'QUEUED',
      creditsCharged: 2,
    }).returning();

    // biome-ignore lint/suspicious/noExplicitAny: db insert mocking
    await (env.db.insert(schema.jobInputs).values as any)({
      jobId: job?.id,
      upperGarmentKey: `shopify-garments/${store.id}/garment.jpg`,
      faceId: null,
      backgroundId: null,
      poseId: null,
      params: { kind: 'shopify', workflowTemplateId: template?.id },
    });

    for (const key of [
      `widget-inputs/${store.id}/photo.jpg`,
      `shopify-garments/${store.id}/garment.jpg`,
    ]) {
      await env.s3.send(
        new PutObjectCommand({
          Bucket: env.r2Bucket,
          Key: key,
          Body: Buffer.from('stub'),
          ContentType: 'image/jpeg',
        }),
      );
    }

    return {
      jobId: job?.id as string,
      storeId: store.id,
      templateId: template?.id as string,
    };
  }

  async function seedShopifyJobViaFunnel(opts: { withFunnel: boolean }) {
    const [store] = await env.db
      .insert(schema.shopifyStores)
      .values({
        shopDomain: `funnel-test-${Date.now()}.myshopify.com`,
        shopifyShopId: Date.now(),
        accessToken: 'iv:tag:enc',
        scope: 'read_products',
      })
      .returning();

    let funnelWorkflowId: string | undefined;
    let funnelTemplateIdToAssign: string | undefined;
    if (opts.withFunnel) {
      const [funnelWorkflow] = await env.db
        .insert(schema.workflowTemplates)
        .values({
          slug: `funnel-wf-${Date.now()}`,
          label: 'Funnel WF',
          jsonContent: {
            [PERSON_NODE_ID]: { inputs: { image: '' } },
            [GARMENT_NODE_ID]: { inputs: { image: '' } },
            [OUTPUT_NODE_ID]: { class_type: 'SaveImage', inputs: {} },
          },
          faceNodeId: 'x',
          poseNodeId: 'x',
          bgNodeId: 'x',
          upperNodeIds: ['x'],
          facePhasePromptNode: 'x',
          garmentPhasePromptNode: 'x',
          workflowType: 'tryon',
          tryonPersonNodeId: PERSON_NODE_ID,
          tryonGarmentNodeId: GARMENT_NODE_ID,
          tryonOutputNodeId: OUTPUT_NODE_ID,
        })
        .returning();
      const [funnelTemplate] = await env.db
        .insert(schema.shopifyFunnelTemplates)
        .values({
          slug: `funnel-tpl-${Date.now()}`,
          label: 'Funnel Template',
          workflowTemplateId: funnelWorkflow.id,
        })
        .returning();
      funnelWorkflowId = funnelWorkflow.id;
      funnelTemplateIdToAssign = funnelTemplate.id;
    }

    const garmentKey = `shopify-garments/${store?.id}/garment.jpg`;
    await env.db.insert(schema.shopifyProductGarments).values({
      storeId: store?.id as string,
      shopifyProductId: 1,
      shopifyVariantId: 0,
      r2Key: garmentKey,
      status: 'active',
      enabled: true,
      funnelTemplateId: funnelTemplateIdToAssign ? funnelTemplateIdToAssign : null,
      funnelAssignmentSource: funnelTemplateIdToAssign ? 'manual' : null,
    });

    // biome-ignore lint/suspicious/noExplicitAny: db insert mocking
    const [job] = await (env.db.insert(schema.jobs).values as any)({
      shopifyStoreId: store.id,
      customerPhotoKey: `widget-inputs/${store.id}/photo.jpg`,
      status: 'QUEUED',
      creditsCharged: 2,
    }).returning();

    // biome-ignore lint/suspicious/noExplicitAny: mirrors seedShopifyJob's own face/bg/pose cast above
    await (env.db.insert(schema.jobInputs).values as any)({
      jobId: job?.id,
      upperGarmentKey: garmentKey,
      faceId: null,
      backgroundId: null,
      poseId: null,
      params: {
        kind: 'shopify',
        ...(funnelWorkflowId ? { workflowTemplateId: funnelWorkflowId } : {}),
      },
    });

    for (const key of [`widget-inputs/${store.id}/photo.jpg`, garmentKey]) {
      await env.s3.send(
        new PutObjectCommand({
          Bucket: env.r2Bucket,
          Key: key,
          Body: Buffer.from('stub'),
          ContentType: 'image/jpeg',
        }),
      );
    }

    return { jobId: job?.id as string, storeId: store.id };
  }

  const STARTING_BALANCE = 100;

  async function seedStoreBilledShopifyJob(_opts: { withFunnel: boolean } = { withFunnel: false }) {
    const shopDomain = `store-billed-${Date.now()}.myshopify.com`;
    const [store] = await env.db
      .insert(schema.shopifyStores)
      .values({
        shopDomain,
        shopifyShopId: Date.now(),
        accessToken: 'enc',
        scope: 'read_products',
      })
      .returning();
    if (!store) throw new Error('failed to seed store');

    await env.db
      .insert(schema.shopifyStoreCredits)
      .values({ storeId: store.id, balance: STARTING_BALANCE - 5 })
      .onConflictDoUpdate({
        target: schema.shopifyStoreCredits.storeId,
        set: { balance: sql`${schema.shopifyStoreCredits.balance} - 5` },
      });

    const jobId = crypto.randomUUID();
    await env.db.insert(schema.jobs).values({
      id: jobId,
      shopifyStoreId: store.id,
      customerPhotoKey: 'widget-inputs/x/photo.jpg',
      status: 'QUEUED',
      creditsCharged: 5,
      // biome-ignore lint/suspicious/noExplicitAny: mock type
    } as any);

    await env.db.insert(schema.jobInputs).values({
      jobId,
      upperGarmentKey: 'catalog/upper-garment.png',
      faceId: null,
      backgroundId: null,
      poseId: null,
      params: { kind: 'shopify' },
      // biome-ignore lint/suspicious/noExplicitAny: mock type
    } as any);

    return { jobId, storeId: store.id };
  }

  it("resolves the workflow via the product's funnel template", async () => {
    const { jobId } = await seedShopifyJobViaFunnel({ withFunnel: true });
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
  });

  it('fails with NO_WORKFLOW_CONFIGURED when neither a funnel nor a store default is set', async () => {
    const { jobId } = await seedShopifyJobViaFunnel({ withFunnel: false });
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
    expect(job?.errorCode).toBe('NO_WORKFLOW_CONFIGURED');
  });

  it('routes to processShopifyJob: claims a "shopify" worker and patches the person/garment nodes', async () => {
    const { jobId } = await seedShopifyJob();
    const log = createLogger('test');

    await processJob(
      { db: env.db, redis, pub, storage: env.storage, s3: env.s3, r2Bucket: env.r2Bucket, log },
      jobId,
      '', // widget/shopify jobs have no userId
      'jobs:normal',
      `${Date.now()}-0`, // must be a syntactically valid Redis stream ID for XACK to accept it
    );

    const [job] = await env.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
    expect(job?.status).toBe('COMPLETED');
    // workerId is only set via the GENERATING transition inside processShopifyJob —
    // proves selectWorker(redis, 'shopify') actually claimed WORKER_ID.
    expect(job?.workerId).toBe(WORKER_ID);

    const [output] = await env.db
      .select()
      .from(schema.jobOutputs)
      .where(eq(schema.jobOutputs.jobId, jobId));
    expect(output?.resultKey).toBe(`outputs/${jobId}/result.png`);

    // Assert on the patched workflow JSON actually submitted to ComfyUI — not on
    // network I/O. The comfy-mock's /upload/image echoes the incoming upload's
    // original filename (see comfy-mock.ts), which processShopifyJob names as
    // `shopify_customer_<jobId>.<ext>` / `shopify_garment_<jobId>.<ext>` — so the
    // returned name is traceable back to its source file. This would FAIL if
    // processShopifyJob swapped the person/garment node assignment.
    const sent = comfy.lastPrompt();
    expect(sent).not.toBeNull();
    const personImage = sent?.prompt[PERSON_NODE_ID]?.inputs?.image;
    const garmentImage = sent?.prompt[GARMENT_NODE_ID]?.inputs?.image;
    expect(personImage).toEqual(expect.stringContaining('shopify_customer'));
    expect(garmentImage).toEqual(expect.stringContaining('shopify_garment'));
    expect(personImage).not.toEqual(expect.stringContaining('shopify_garment'));
    expect(garmentImage).not.toEqual(expect.stringContaining('shopify_customer'));

    const worker = await (await import('../../src/worker/registry.js')).getWorkers(redis);
    expect(worker.get(WORKER_ID)?.status).toBe('IDLE');
  });

  it('refunds shopify_store_credits on terminal failure for a store-billed shopify job', async () => {
    const { jobId, storeId } = await seedStoreBilledShopifyJob({ withFunnel: false });

    const cfg = {
      db: env.db,
      redis,
      pub,
      storage: env.storage,
      s3: env.s3,
      r2Bucket: env.r2Bucket,
      log: createLogger('test'),
    } as Parameters<typeof processJob>[0];

    await deregisterWorker(redis, WORKER_ID);
    try {
      await processJob(cfg, jobId, '', 'jobs:normal', `${Date.now()}-0`);

      const [job] = await env.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
      expect(job?.status).toBe('FAILED');

      const [credits] = await env.db
        .select()
        .from(schema.shopifyStoreCredits)
        .where(eq(schema.shopifyStoreCredits.storeId, storeId));
      expect(credits?.balance).toBe(STARTING_BALANCE);
    } finally {
      await registerWorkers(redis, [
        { id: WORKER_ID, url: comfy.url, apiKey: 'test-key', allowedJobTypes: ['shopify'] },
      ]);
      await redis.setex(`worker:health:${WORKER_ID}`, 30, '1');
    }
  });

  it('is a safe no-op when a job the API already compensated is (re)delivered to the dispatcher', async () => {
    // Residual-risk guard for the Shopify shopper-limits fix round 1, finding
    // #5: XADD can succeed on the Redis server side while the client's
    // response is lost, so apps/api may treat the enqueue as failed and
    // compensate (refund + mark FAILED) a job that is actually visible to
    // this dispatcher and will still be delivered. Simulates exactly that:
    // a job already refunded and marked FAILED by the API's compensation
    // path, then handed to processJob as if the ambiguous XADD had in fact
    // landed. Must not re-refund, re-process, or crash.
    const { jobId, storeId } = await seedStoreBilledShopifyJob({ withFunnel: false });

    // Mirror what apps/api's refundAndMarkFailed does post-commit: one
    // ledger row, balance restored, job terminally FAILED.
    await env.db.transaction(async (tx) => {
      await tx.insert(schema.shopifyCreditLedger).values({
        storeId,
        delta: 5,
        reason: 'REFUND_ENQUEUE_FAIL',
        jobId,
      });
      await tx
        .update(schema.shopifyStoreCredits)
        .set({ balance: sql`${schema.shopifyStoreCredits.balance} + 5` })
        .where(eq(schema.shopifyStoreCredits.storeId, storeId));
      await tx
        .update(schema.jobs)
        .set({ status: 'FAILED', errorCode: 'ENQUEUE_FAIL' })
        .where(eq(schema.jobs.id, jobId));
    });

    const cfg = {
      db: env.db,
      redis,
      pub,
      storage: env.storage,
      s3: env.s3,
      r2Bucket: env.r2Bucket,
      log: createLogger('test'),
    } as Parameters<typeof processJob>[0];

    // Does not throw — a real dispatcher would otherwise crash processing
    // this stream message.
    await expect(
      processJob(cfg, jobId, '', 'jobs:normal', `${Date.now()}-0`),
    ).resolves.toBeUndefined();

    const [job] = await env.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
    expect(job?.status).toBe('FAILED');
    expect(job?.errorCode).toBe('ENQUEUE_FAIL');

    const [credits] = await env.db
      .select()
      .from(schema.shopifyStoreCredits)
      .where(eq(schema.shopifyStoreCredits.storeId, storeId));
    expect(credits?.balance).toBe(STARTING_BALANCE);

    const refundRows = await env.db
      .select()
      .from(schema.shopifyCreditLedger)
      .where(eq(schema.shopifyCreditLedger.jobId, jobId));
    expect(refundRows).toHaveLength(1);

    // No processing happened at all — the top-of-processJob status guard
    // (job.status !== 'QUEUED') short-circuits before any COMFY_DISPATCH
    // event would be written.
    const events = await env.db
      .select()
      .from(schema.jobEvents)
      .where(eq(schema.jobEvents.jobId, jobId));
    expect(events.some((e) => e.eventType === 'COMFY_DISPATCH')).toBe(false);
  });
});
