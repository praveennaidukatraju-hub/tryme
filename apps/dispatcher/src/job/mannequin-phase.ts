import { randomUUID } from 'node:crypto';
import type { S3Client } from '@aws-sdk/client-s3';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { type DB, schema } from '@tryme/db';
import type { Logger } from '@tryme/logger';
import { comfyRequestDuration } from '@tryme/observability';
import { keys } from '@tryme/storage';
import { WORKER_POOL } from '@tryme/types';
import { eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';
import {
  downloadOutputImage,
  fetchHistory,
  submitPrompt,
  uploadImageToComfy,
} from '../comfyui/client.js';
import { waitForCompletion } from '../comfyui/progress.js';
import { setWorkerStatus } from '../worker/registry.js';
import { selectWorker } from '../worker/selector.js';

export interface MannequinPhaseConfig {
  db: DB;
  redis: Redis;
  s3: S3Client;
  r2Bucket: string;
}
export interface MannequinPhaseParams {
  jobId: string;
  garmentKey: string;
  faceId: string | null;
  mannequinWorkflowTemplateId: string;
  jobLog: Logger;
  jobType: string | null;
}

export async function runMannequinPhase(
  cfg: MannequinPhaseConfig,
  params: MannequinPhaseParams,
): Promise<string> {
  const { db, redis, s3, r2Bucket } = cfg;
  const { jobId, garmentKey, faceId, mannequinWorkflowTemplateId, jobLog, jobType } = params;
  const [template] = await db
    .select({
      jsonContent: schema.workflowTemplates.jsonContent,
      tryonPersonNodeId: schema.workflowTemplates.tryonPersonNodeId,
      tryonGarmentNodeId: schema.workflowTemplates.tryonGarmentNodeId,
      tryonOutputNodeId: schema.workflowTemplates.tryonOutputNodeId,
    })
    .from(schema.workflowTemplates)
    .where(eq(schema.workflowTemplates.id, mannequinWorkflowTemplateId));
  if (!template) throw new Error('MANNEQUIN_WORKFLOW_NOT_FOUND');
  const {
    tryonPersonNodeId: personNodeId,
    tryonGarmentNodeId: garmentNodeId,
    tryonOutputNodeId: outputNodeId,
  } = template;
  if (!garmentNodeId || !outputNodeId) throw new Error('MANNEQUIN_NODES_NOT_CONFIGURED');
  let personKey: string | undefined;
  if (personNodeId) {
    if (!faceId) throw new Error('MANNEQUIN_NO_FACE_IMAGE');
    const [faceRow] = await db
      .select({ r2Key: schema.modelFaces.r2Key, faceSideR2Key: schema.modelFaces.faceSideR2Key })
      .from(schema.modelFaces)
      .where(eq(schema.modelFaces.id, faceId));
    if (!faceRow) throw new Error('MANNEQUIN_NO_FACE_IMAGE');
    personKey = faceRow.faceSideR2Key ?? faceRow.r2Key;
  }
  const worker = await selectWorker(redis, WORKER_POOL.SAREE);
  if (!worker) throw new Error('MANNEQUIN_NO_WORKER');
  const w = worker;

  try {
    async function r2Download(key: string): Promise<Uint8Array> {
      const res = await s3.send(new GetObjectCommand({ Bucket: r2Bucket, Key: key }));
      if (!res.Body) throw new Error(`R2 object missing: ${key}`);
      return res.Body.transformToByteArray();
    }
    async function uploadToComfy(key: string, prefix: string): Promise<string> {
      const bytes = await r2Download(key);
      const rawExt = key.split('.').pop()?.toLowerCase() ?? '';
      const ext = rawExt === 'png' ? 'png' : rawExt === 'webp' ? 'webp' : 'jpg';
      const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
      return uploadImageToComfy(w.url, w.apiKey, bytes, `${prefix}_${jobId}.${ext}`, mime, jobLog);
    }
    jobLog.info('uploading mannequin-phase inputs to ComfyUI');
    const [personFile, garmentFile] = await Promise.all([
      personKey ? uploadToComfy(personKey, 'mannequin_person') : Promise.resolve(undefined),
      uploadToComfy(garmentKey, 'mannequin_garment'),
    ]);
    jobLog.info({ personFile, garmentFile }, 'mannequin-phase inputs uploaded');
    const workflow = structuredClone(template.jsonContent) as Record<
      string,
      { inputs?: Record<string, unknown> }
    >;
    if (personNodeId && personFile && workflow[personNodeId]?.inputs) {
      // biome-ignore lint/style/noNonNullAssertion: guarded by optional-chain check above
      workflow[personNodeId].inputs!.image = personFile;
    }
    if (workflow[garmentNodeId]?.inputs) {
      // biome-ignore lint/style/noNonNullAssertion: guarded by optional-chain check above
      workflow[garmentNodeId].inputs!.image = garmentFile;
    }
    const clientUuid = randomUUID();
    const comfyStartedAt = Date.now();
    const { promptId } = await submitPrompt(w.url, w.apiKey, clientUuid, workflow, jobLog);
    jobLog.info({ promptId }, 'mannequin-phase prompt submitted');
    await db.insert(schema.jobEvents).values({
      jobId,
      eventType: 'COMFY_DISPATCH',
      payload: {
        promptId,
        workerId: w.id,
        workerUrl: w.url,
        workflowTemplateId: mannequinWorkflowTemplateId,
        phase: 'mannequin',
        inputs: { garmentKey, personKey, personFile, garmentFile },
      },
    });
    await waitForCompletion(
      w.url,
      w.apiKey,
      clientUuid,
      promptId,
      300_000,
      (update) => jobLog.debug(update, 'comfyui progress'),
      {
        info: jobLog.info.bind(jobLog),
        debug: jobLog.debug.bind(jobLog),
        error: jobLog.error.bind(jobLog),
      },
    );
    const comfyMs = Date.now() - comfyStartedAt;
    comfyRequestDuration.observe({ job_type: jobType ?? 'unknown' }, comfyMs / 1000);
    await db
      .update(schema.jobs)
      .set({ comfyDurationMs: Math.round(comfyMs) })
      .where(eq(schema.jobs.id, jobId));
    const [firstImage] = await fetchHistory(w.url, w.apiKey, promptId, jobLog, outputNodeId);
    if (!firstImage) throw new Error('ComfyUI returned no output images for mannequin phase');
    const imageBytes = await downloadOutputImage(
      w.url,
      w.apiKey,
      firstImage.filename,
      firstImage.subfolder,
    );
    const intermediateKey = keys.mannequinIntermediate(jobId);
    await s3.send(
      new PutObjectCommand({
        Bucket: r2Bucket,
        Key: intermediateKey,
        Body: imageBytes,
        ContentType: 'image/png',
      }),
    );
    jobLog.info({ intermediateKey }, 'mannequin phase complete');
    return intermediateKey;
  } finally {
    await setWorkerStatus(redis, w.id, 'IDLE');
  }
}
