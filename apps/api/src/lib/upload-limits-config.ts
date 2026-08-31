import type { FastifyInstance } from 'fastify';

const CONFIG_KEY = 'config:system';

export type UploadLimitKey =
  | 'merchantCatalogMaxBytes'
  | 'webGarmentMaxBytes'
  | 'merchantTryonMaxBytes'
  | 'devApiMaxBytes'
  | 'shopifyCatalogSourceMaxBytes'
  | 'shopifyCustomerPhotoMaxBytes'
  | 'shopifyProductImageMaxBytes'
  | 'shopifyProductSyncMaxBytes'
  | 'bulkImportMaxBytes';

export const DEFAULT_UPLOAD_LIMITS: Record<UploadLimitKey, number> = {
  merchantCatalogMaxBytes: 20 * 1024 * 1024,
  webGarmentMaxBytes: 20 * 1024 * 1024,
  merchantTryonMaxBytes: 20 * 1024 * 1024,
  devApiMaxBytes: 20 * 1024 * 1024,
  shopifyCatalogSourceMaxBytes: 20 * 1024 * 1024,
  shopifyCustomerPhotoMaxBytes: 20 * 1024 * 1024,
  shopifyProductImageMaxBytes: 20 * 1024 * 1024,
  shopifyProductSyncMaxBytes: 20 * 1024 * 1024,
  // Matches today's de facto behavior: this route previously had no dedicated
  // constant and just inherited the 2.5GB global Fastify multipart default.
  bulkImportMaxBytes: 2.5 * 1024 * 1024 * 1024,
};

/**
 * Reads an admin-configured upload size limit (bytes) from the same
 * `config:system` Redis key the admin panel edits (GET/PATCH /admin/config).
 * Falls back to the hardcoded default in DEFAULT_UPLOAD_LIMITS if nothing is
 * stored yet, or the entry is missing/malformed.
 */
export async function getUploadLimitBytes(
  app: FastifyInstance,
  key: UploadLimitKey,
): Promise<number> {
  try {
    const raw = await app.redis.get(CONFIG_KEY);
    const cfg = raw ? JSON.parse(raw) : {};
    const val = cfg.uploadLimits?.[key];
    return typeof val === 'number' ? val : DEFAULT_UPLOAD_LIMITS[key];
  } catch {
    return DEFAULT_UPLOAD_LIMITS[key];
  }
}
