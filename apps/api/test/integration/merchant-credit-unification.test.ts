import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getTryonCreditCost } from '../../src/lib/resolution-config.js';
import { createMerchantTryonJob } from '../../src/modules/merchant/create-tryon-job.js';
import { atomicMerchantDeduct, merchantRefund } from '../../src/modules/merchant/ledger.js';
import { buildTestApp, type TestApp } from '../helpers/api';
import { type Containers, startContainers } from '../helpers/containers';
import { createTestMerchant, createTestTryonCategory } from '../helpers/merchant.js';

describe('merchant credit unification', () => {
  let c: Containers;
  let app: TestApp;
  let workflowTemplateId: string;

  beforeAll(async () => {
    c = await startContainers();
    app = await buildTestApp(c);
    ({ workflowTemplateId } = await createTestTryonCategory(app, {
      slug: `unif-${randomUUID()}`,
    }));
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await c?.stop();
  });

  it('merchant tryon deducts from user_credits, not a separate pool', async () => {
    const merchant = await createTestMerchant(app, { balance: 100 });
    const cost = await getTryonCreditCost(app);

    const jobId = await createMerchantTryonJob(app, {
      merchantId: merchant.merchantId,
      merchantUserId: merchant.userId,
      upperGarmentKey: 'test/garment.jpg',
      customerPhotoKey: 'test/photo.jpg',
      workflowTemplateId: workflowTemplateId,
    });
    expect(jobId).toBeTruthy();

    const [credits] = await app.db
      .select({ balance: schema.userCredits.balance })
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, merchant.userId));
    expect(credits?.balance).toBe(100 - cost);
  });

  it('refunding a merchant job twice credits it only once', async () => {
    const merchant = await createTestMerchant(app, { balance: 100 });
    const jobId = randomUUID();

    await merchantRefund(app.db, merchant.merchantId, 25, jobId, 'JOB_FAIL_REFUND');
    await merchantRefund(app.db, merchant.merchantId, 25, jobId, 'JOB_FAIL_REFUND');

    const [credits] = await app.db
      .select({ balance: schema.userCredits.balance })
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, merchant.userId));
    expect(credits?.balance).toBe(125);

    const ledger = await app.db
      .select()
      .from(schema.creditLedger)
      .where(eq(schema.creditLedger.jobId, jobId));
    expect(ledger).toHaveLength(1);
  });

  it('deducting more than the balance throws and leaves the balance untouched', async () => {
    const merchant = await createTestMerchant(app, { balance: 5 });

    await expect(
      atomicMerchantDeduct(app.db, merchant.merchantId, 50, randomUUID()),
    ).rejects.toThrow();

    const [credits] = await app.db
      .select({ balance: schema.userCredits.balance })
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, merchant.userId));
    expect(credits?.balance).toBe(5);
  });
});
