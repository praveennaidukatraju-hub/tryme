/**
 * finalizeOutput — shared helper called by all three job processors
 * (processJob, processTryonDirectJob, processSareeJob) after ComfyUI
 * produces its result image.
 *
 * Responsibility:
 *   1. Upload the raw image buffer to R2 at keys.output(jobId).
 *   2. Generate a 512-px thumbnail from the same buffer.
 *   3. Upload the thumbnail to keys.outputThumb(jobId).
 *   4. Write job_outputs row (assetKind, watermarkVersion) — currently always ORIGINAL.
 *   5. Transition the job to COMPLETED.
 *
 * Step 2 of 7 — pure refactor, no watermarking behavior yet.
 * Watermarking will be wired in at step 4 behind ENABLE_WATERMARKING env var.
 */

import type { S3Client } from '@aws-sdk/client-s3';
import { PutObjectCommand } from '@aws-sdk/client-s3';
import { type DB, schema } from '@tryme/db';
import type { Logger } from '@tryme/logger';
import { keys } from '@tryme/storage';
import type { Redis } from 'ioredis';
import sharp from 'sharp';
import { loadEnv } from '../env.js';
import { transitionJob } from '../job/state.js';
import { applyWatermark, WATERMARK_VERSION } from './watermark.js';

export interface FinalizeOutputOpts {
  /** Raw image bytes downloaded from ComfyUI. */
  imageBytes: Uint8Array;
  jobId: string;
  userId: string;
  shopifyStoreId?: string;
  /** Whether this job has the watermark flag set (snapshotted at creation). */
  jobWatermark: boolean;
  /** Result image encoding — defaults to 'png'. 'webp' re-encodes at q90 (smaller payload). */
  outputFormat?: 'png' | 'webp';
  db: DB;
  pub: Redis;
  s3: S3Client;
  r2Bucket: string;
  jobLog: Logger;
}

/**
 * Upload result + thumbnail, write job_outputs, transition to COMPLETED.
 *
 * Returns the { resultKey, thumbnailKey } written to R2.
 */
export async function finalizeOutput(opts: FinalizeOutputOpts): Promise<{
  resultKey: string;
  thumbnailKey: string | undefined;
}> {
  const { imageBytes, jobId, userId, db, pub, s3, r2Bucket, jobLog } = opts;
  const finalizeStartedAt = Date.now();

  const env = loadEnv();

  let finalBuffer: Uint8Array = imageBytes;
  let watermarkApplied = false;
  let watermarkVersion: number | null = null;

  if (opts.jobWatermark) {
    if (env.ENABLE_WATERMARKING) {
      finalBuffer = await applyWatermark({ image: imageBytes, jobId });
      watermarkApplied = true;
      watermarkVersion = WATERMARK_VERSION;
    } else {
      jobLog.warn(
        {
          stage: 'watermark',
          jobId,
          expectedWatermark: true,
          appliedWatermark: false,
          reason: 'ENABLE_WATERMARKING_DISABLED',
        },
        'watermark disabled by kill switch',
      );
    }
  }

  // Upload result to R2
  const outputFormat = opts.outputFormat ?? 'png';
  const resultKey = keys.output(jobId, outputFormat);
  const resultBuffer =
    outputFormat === 'webp'
      ? await sharp(finalBuffer).webp({ quality: 90 }).toBuffer()
      : finalBuffer;
  await s3.send(
    new PutObjectCommand({
      Bucket: r2Bucket,
      Key: resultKey,
      Body: resultBuffer,
      ContentType: outputFormat === 'webp' ? 'image/webp' : 'image/png',
    }),
  );

  // Generate and upload thumbnail (512px, JPEG) from the final buffer.
  // Thumbnail is always generated from the final buffer — not the pre-watermark original.
  let thumbnailKey: string | undefined;
  try {
    const metadata = await sharp(finalBuffer).metadata();
    const thumbBytes = await sharp(finalBuffer)
      .rotate()
      .resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 80 })
      .toBuffer();
    thumbnailKey = keys.outputThumb(jobId);
    await s3.send(
      new PutObjectCommand({
        Bucket: r2Bucket,
        Key: thumbnailKey,
        Body: thumbBytes,
        ContentType: 'image/jpeg',
      }),
    );
    jobLog.info(
      {
        stage: 'watermark',
        jobId,
        watermarkApplied,
        watermarkVersion,
        processingTimeMs: Date.now() - finalizeStartedAt,
        imageWidth: metadata.width,
        imageHeight: metadata.height,
        imageSizeBytes: finalBuffer.byteLength,
        outputFormat: metadata.format,
      },
      'finalizeOutput complete',
    );
  } catch (thumbErr) {
    jobLog.warn({ err: thumbErr }, 'thumbnail generation failed — proceeding without thumbnail');
    thumbnailKey = undefined;
  }

  // Write job_outputs with asset_kind and watermark_version.
  // asset_kind reflects what actually ran — currently always ORIGINAL.
  const assetKind = watermarkApplied ? 'WATERMARKED' : 'ORIGINAL';
  await db
    .insert(schema.jobOutputs)
    .values({
      jobId,
      resultKey,
      thumbnailKey: thumbnailKey ?? null,
      assetKind,
      watermarkVersion: watermarkVersion !== null ? watermarkVersion : undefined,
    })
    .onConflictDoUpdate({
      target: schema.jobOutputs.jobId,
      set: {
        resultKey,
        thumbnailKey: thumbnailKey ?? null,
        assetKind,
        watermarkVersion: watermarkVersion !== null ? watermarkVersion : null,
      },
    });

  // Transition to COMPLETED — resultKey/thumbnailKey are included for SSE payload.
  // skipOutputInsert=true because we already upserted job_outputs above with assetKind/watermarkVersion.
  await transitionJob(
    db,
    pub,
    jobId,
    userId,
    'COMPLETED',
    { resultKey, thumbnailKey, skipOutputInsert: true, shopifyStoreId: opts.shopifyStoreId },
    jobLog,
  );

  return { resultKey, thumbnailKey };
}
