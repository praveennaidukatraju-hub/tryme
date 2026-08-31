import { schema } from '@tryme/db';
import { JOB_SOURCE } from '@tryme/types';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { AppError } from '../../lib/errors.js';
import { getSareeMannequinDevCreditCost } from '../../lib/resolution-config.js';
import { createDevJobCore } from './create-job.js';

/**
 * Creates a developer-API saree-mannequin (step-1) job from a raw garment
 * cloth image. Resolves the workflow off the dedicated single-row
 * dev_saree_mannequin_config table — the public saree-mannequin endpoint owns
 * its own workflow pointer, decoupled from garment_subcategories, so the
 * internal saree Studio flow can change independently. The resolved
 * workflowTemplateId is snapshotted into job_inputs.params so the dispatcher
 * never re-reads any internal catalog table for this job (see
 * processor.ts processDevSareeMannequin, params.workflowTemplateId branch).
 *
 * faceId is always null here — the workflow's face comes from a fixed URL node
 * baked into the template, not a caller-supplied image.
 */
export async function createDevSareeMannequinJob(
  app: FastifyInstance,
  params: {
    merchantUserId: string;
    apiKeyId: string;
    garmentKey: string;
  },
): Promise<{ jobId: string }> {
  const cost = await getSareeMannequinDevCreditCost(app);

  // Resolve off the DEDICATED single-row dev config, not garment_subcategories —
  // the public saree-mannequin endpoint owns its own workflow pointer, so the
  // internal saree Studio flow can change independently. Snapshotting the resolved
  // workflow into params (below) means the dispatcher never re-reads any internal
  // catalog table for this job (see processor.ts processDevSareeMannequin).
  const [config] = await app.db
    .select({
      workflowTemplateId: schema.devSareeMannequinConfig.workflowTemplateId,
      isActive: schema.devSareeMannequinConfig.isActive,
    })
    .from(schema.devSareeMannequinConfig)
    .limit(1);

  if (!config?.isActive || !config.workflowTemplateId) {
    throw new AppError('BAD_CATEGORY', 400, 'saree mannequin generation is not configured');
  }

  const [template] = await app.db
    .select({
      isActive: schema.workflowTemplates.isActive,
      version: schema.workflowTemplates.version,
    })
    .from(schema.workflowTemplates)
    .where(eq(schema.workflowTemplates.id, config.workflowTemplateId));
  if (!template?.isActive) {
    throw new AppError('BAD_CATEGORY', 400, 'saree mannequin generation is not configured');
  }

  const [user] = await app.db
    .select({ isBanned: schema.users.isBanned })
    .from(schema.users)
    .where(eq(schema.users.id, params.merchantUserId));
  if (!user || user.isBanned) throw new AppError('FORBIDDEN', 403, 'account suspended');

  return createDevJobCore(app, {
    merchantUserId: params.merchantUserId,
    apiKeyId: params.apiKeyId,
    cost,
    watermark: false,
    source: JOB_SOURCE.API_SAREE_MANNEQUIN,
    buildJobInputs: () => ({
      upperGarmentKey: params.garmentKey,
      garmentTypeId: null,
      faceId: null,
      // Snapshot the workflow so the dispatcher routes off params, not internal tables.
      params: {
        kind: 'saree_mannequin',
        workflowTemplateId: config.workflowTemplateId,
        dispatchTemplateVersion: template.version ?? null,
      },
    }),
  });
}
