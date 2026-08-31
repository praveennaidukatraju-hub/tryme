import { schema } from '@tryme/db';
import { createLogger } from '@tryme/logger';
import { and, eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { processJob } from '../../src/job/processor.js';
import { setupTestEnv, type TestEnv } from '../helpers/containers.js';

// Exercises markWidgetFailed's success path (apps/dispatcher/src/job/processor.ts):
// a widget/kiosk job with no customerPhotoKey fails the NO_CUSTOMER_PHOTO pre-flight
// check inside processWidgetJob before any ComfyUI interaction, which routes straight
// to markWidgetFailed — the function that resolves the merchant's owning user and
// refunds user_credits/credit_ledger (Task 6's fix for the silent-credit-loss bug).
// No ComfyUI mock or workflow template is needed since this path never reaches a worker.
describe('merchant/kiosk widget job refund — markWidgetFailed', () => {
  let env: TestEnv;
  let redis: Redis;
  let pub: Redis;

  beforeAll(async () => {
    env = await setupTestEnv();
    redis = new Redis('redis://127.0.0.1:6379');
    pub = new Redis('redis://127.0.0.1:6379');
  }, 60_000);

  afterAll(async () => {
    redis.disconnect();
    pub.disconnect();
    await env.cleanup();
  });

  // ORIGINAL_BALANCE is the balance before the (simulated) job-creation deduct — the
  // value the refund should restore. The seeded row holds the post-deduct balance,
  // mirroring how a real job would have already deducted CREDITS_CHARGED at creation
  // time before the dispatcher ever sees it.
  const ORIGINAL_BALANCE = 20;
  const CREDITS_CHARGED = 3;

  async function seedMerchantJobWithNoPhoto() {
    const [user] = await env.db
      .insert(schema.users)
      .values({ email: `merchant-refund-owner-${Date.now()}@test.com`, displayName: 'Owner' })
      .returning();
    if (!user) throw new Error('failed to seed user');

    await env.db
      .insert(schema.userCredits)
      .values({ userId: user.id, balance: ORIGINAL_BALANCE - CREDITS_CHARGED });

    const [merchant] = await env.db
      .insert(schema.merchants)
      .values({
        companyName: 'Refund Test Co',
        contactName: 'Test Contact',
        phone: '0000000000',
        businessAddress: 'Nowhere',
        isActive: true,
        userId: user.id,
      })
      .returning();
    if (!merchant) throw new Error('failed to seed merchant');

    // biome-ignore lint/suspicious/noExplicitAny: merchantId/customerPhotoKey are widget-only job columns
    const [job] = await (env.db.insert(schema.jobs).values as any)({
      merchantId: merchant.id,
      customerPhotoKey: null,
      status: 'QUEUED',
      creditsCharged: CREDITS_CHARGED,
    }).returning();
    if (!job) throw new Error('failed to seed job');

    await env.db.insert(schema.jobInputs).values({ jobId: job.id });

    return {
      jobId: job.id as string,
      userId: user.id as string,
      merchantId: merchant.id as string,
    };
  }

  it('refunds the merchant owner and marks the job FAILED when customerPhotoKey is missing', async () => {
    const { jobId, userId } = await seedMerchantJobWithNoPhoto();
    const log = createLogger('test');

    await processJob(
      { db: env.db, redis, pub, storage: env.storage, s3: env.s3, r2Bucket: env.r2Bucket, log },
      jobId,
      '', // widget jobs have no userId
      'jobs:normal',
      `${Date.now()}-0`,
    );

    const [job] = await env.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
    expect(job?.status).toBe('FAILED');
    expect(job?.errorCode).toBe('NO_CUSTOMER_PHOTO');

    const [credits] = await env.db
      .select()
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, userId));
    expect(credits?.balance).toBe(ORIGINAL_BALANCE);

    const ledgerRows = await env.db
      .select()
      .from(schema.creditLedger)
      .where(
        and(
          eq(schema.creditLedger.jobId, jobId),
          eq(schema.creditLedger.reason, 'JOB_FAIL_REFUND'),
        ),
      );
    expect(ledgerRows).toHaveLength(1);
    expect(ledgerRows[0]?.userId).toBe(userId);
    expect(ledgerRows[0]?.delta).toBe(CREDITS_CHARGED);
  });

  it('does not double-refund when the job is already terminal (idempotency)', async () => {
    const { jobId, userId } = await seedMerchantJobWithNoPhoto();
    const log = createLogger('test');
    const cfg = {
      db: env.db,
      redis,
      pub,
      storage: env.storage,
      s3: env.s3,
      r2Bucket: env.r2Bucket,
      log,
    };

    await processJob(cfg, jobId, '', 'jobs:normal', `${Date.now()}-0`);

    // Job is now FAILED (terminal). A redelivered stream message (e.g. from XPENDING
    // recovery) hits the `job.status !== 'QUEUED'` guard at the top of processJob and
    // is ACKed without reprocessing — it never reaches markWidgetFailed a second time.
    // Calling processJob again on the same terminal job proves that guard holds and
    // the ledger/balance are untouched by the redundant call.
    await processJob(cfg, jobId, '', 'jobs:normal', `${Date.now()}-1`);

    const [credits] = await env.db
      .select()
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, userId));
    expect(credits?.balance).toBe(ORIGINAL_BALANCE);

    const ledgerRows = await env.db
      .select()
      .from(schema.creditLedger)
      .where(
        and(
          eq(schema.creditLedger.jobId, jobId),
          eq(schema.creditLedger.reason, 'JOB_FAIL_REFUND'),
        ),
      );
    expect(ledgerRows).toHaveLength(1);
  });
});
