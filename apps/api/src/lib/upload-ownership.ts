import type { FastifyInstance } from 'fastify';
import { AppError } from './errors.js';
import { getUploadLimitBytes } from './upload-limits-config.js';

/**
 * Verifies the object exists in storage and is within the accepted size limit.
 * Does not check ownership - callers that have already established ownership
 * through another means (e.g. regenerating an already-owned completed job)
 * use this directly instead of the full Redis-binding check below.
 */
export async function assertGarmentObjectValid(app: FastifyInstance, key: string) {
  let head: { contentLength: number };
  try {
    head = await app.storage.headObject(key);
  } catch {
    throw new AppError('BAD_UPLOAD', 400, 'uploaded garment not found');
  }
  const maxBytes = await getUploadLimitBytes(app, 'webGarmentMaxBytes');
  if (head.contentLength > maxBytes) {
    throw new AppError('BAD_UPLOAD', 413, 'uploaded garment exceeds size limit');
  }
}

/**
 * Reject a garment key that was not presigned for this user. The presign route
 * records `upload:owner:<key> -> userId` in Redis with a 24h TTL; a key bound
 * to nobody (expired/never issued) or to another user fails here. This is the
 * check for a fresh upload - regeneration of an old job uses
 * `trustedGarmentKeys` in `createJob` instead, since the 24h binding will
 * usually have expired long before an old job is regenerated even though the
 * caller's ownership of that job (and therefore its garment keys) is still valid.
 */
export async function assertOwnsUploadKey(app: FastifyInstance, userId: string, key: string) {
  const owner = await app.redis.get(`upload:owner:${key}`);
  if (owner !== userId) {
    throw new AppError('FORBIDDEN', 403, 'upload key not owned by caller');
  }
  await assertGarmentObjectValid(app, key);
}
