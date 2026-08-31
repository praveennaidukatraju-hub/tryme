import type { FastifyInstance } from 'fastify';
import { AppError } from '../../lib/errors.js';
import { getUploadLimitBytes } from '../../lib/upload-limits-config.js';

const DEMO_CATALOG_CONTENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

/**
 * Demo objects are not merchant-scoped, so the prefix check is a flat
 * `demo-catalog/` rather than a per-owner path. The Redis ownership marker still
 * pins the key to the admin who presigned it, which is what stops an arbitrary
 * `demo-catalog/...` string being accepted.
 */
export async function assertDemoUploadKey(
  app: FastifyInstance,
  adminUserId: string,
  key: string,
  label: string,
): Promise<void> {
  if (!key.startsWith('demo-catalog/')) {
    throw new AppError('FORBIDDEN', 403, `${label} key is not a demo catalog key`);
  }

  const owner = await app.redis.get(`upload:owner:${key}`);
  if (owner !== `admin:${adminUserId}`) {
    throw new AppError('FORBIDDEN', 403, `${label} upload session expired or not owned`);
  }

  let head: { contentLength: number; contentType: string | null };
  try {
    head = await app.storage.headObject(key);
  } catch {
    throw new AppError('BAD_UPLOAD', 400, `${label} not found`);
  }

  const maxBytes = await getUploadLimitBytes(app, 'merchantCatalogMaxBytes');
  if (head.contentLength > maxBytes) {
    throw new AppError('BAD_UPLOAD', 413, `${label} exceeds ${maxBytes / (1024 * 1024)}MB limit`);
  }
  if (!head.contentType || !DEMO_CATALOG_CONTENT_TYPES.has(head.contentType)) {
    throw new AppError('BAD_UPLOAD', 400, `${label} must be jpeg, png, or webp`);
  }
}
