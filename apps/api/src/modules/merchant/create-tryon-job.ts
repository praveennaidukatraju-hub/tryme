import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { JOB_SOURCE } from '@tryme/types';
import type { FastifyInstance } from 'fastify';
import { getTryonCreditCost } from '../../lib/resolution-config.js';
import { atomicMerchantDeduct } from './ledger.js';

interface CreateMerchantTryonJobInput {
  merchantId: string;
  merchantUserId: string;
  upperGarmentKey: string;
  secondGarmentKey?: string;
  customerPhotoKey: string;
  workflowTemplateId: string;
  dispatchTemplateVersion?: number | null;
}

export async function createMerchantTryonJob(
  app: FastifyInstance,
  input: CreateMerchantTryonJobInput,
): Promise<string> {
  const jobId = randomUUID();
  const cost = await getTryonCreditCost(app);

  await app.db.transaction(async (tx) => {
    // biome-ignore lint/suspicious/noExplicitAny: nullable widget inputs are wider than Drizzle's inferred insert type.
    await (tx.insert(schema.jobs).values as any)({
      id: jobId,
      userId: input.merchantUserId,
      merchantId: input.merchantId,
      customerPhotoKey: input.customerPhotoKey,
      status: 'QUEUED',
      creditsCharged: cost,
      source: JOB_SOURCE.MERCHANT_TRYON,
    });

    // biome-ignore lint/suspicious/noExplicitAny: nullable widget inputs are wider than Drizzle's inferred insert type.
    await (tx.insert(schema.jobInputs).values as any)({
      jobId,
      upperGarmentKey: input.upperGarmentKey,
      thirdGarmentKey: input.secondGarmentKey ?? null,
      faceId: null,
      backgroundId: null,
      poseId: null,
      params: {
        workflowTemplateId: input.workflowTemplateId,
        dispatchTemplateVersion: input.dispatchTemplateVersion ?? null,
      },
    });

    // biome-ignore lint/suspicious/noExplicitAny: tx type narrowing loses the custom methods added by the merchant ledger helper.
    await atomicMerchantDeduct(tx as any, input.merchantId, cost, jobId);
  });

  await app.redis.xadd(
    'jobs:normal',
    'MAXLEN',
    '~',
    10000,
    '*',
    'jobId',
    jobId,
    'userId',
    input.merchantUserId,
    'type',
    'MERCHANT_TRYON',
  );

  return jobId;
}
