import type { MerchantCatalogGenerateStatus, MerchantCatalogItem } from '@tryme/types';
import { api } from '@/lib/api';

const ALLOWED_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
type AllowedContentType = (typeof ALLOWED_CONTENT_TYPES)[number];

export function toAllowedContentType(file: File): AllowedContentType {
  if ((ALLOWED_CONTENT_TYPES as readonly string[]).includes(file.type)) {
    return file.type as AllowedContentType;
  }
  throw new Error('Only JPEG, PNG, or WEBP images are supported.');
}

/** Presigns an R2 upload slot and pushes the file to it. Returns the resolved key. */
export async function presignAndUpload(
  file: File,
  kind: 'image' | 'thumbnail' | 'flat',
): Promise<{ assetId: string; r2Key: string }> {
  const contentType = toAllowedContentType(file);
  const { assetId, uploadUrl, r2Key } = await api.post<{
    assetId: string;
    uploadUrl: string;
    r2Key: string;
  }>('/v1/merchant/catalog/presign', { kind, contentType, contentLength: file.size });
  await api.uploadToR2(uploadUrl, file);
  return { assetId, r2Key };
}

const TERMINAL_STATUSES = new Set(['COMPLETED', 'FAILED', 'CANCELLED']);

/** Polls a single Path B generate job until it reaches a terminal status. */
export async function pollGenerateJob(
  jobId: string,
  opts: { intervalMs?: number; timeoutMs?: number } = {},
): Promise<MerchantCatalogGenerateStatus> {
  const intervalMs = opts.intervalMs ?? 2500;
  const timeoutMs = opts.timeoutMs ?? 180_000;
  const startedAt = Date.now();
  for (;;) {
    const status = await api.get<MerchantCatalogGenerateStatus>(
      `/v1/merchant/catalog/generate/${jobId}`,
    );
    if (TERMINAL_STATUSES.has(status.status)) return status;
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error('Timed out waiting for the catalogue image to generate.');
    }
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Copies a completed job's output into a merchant_catalog_items row (Path A import, also used to finalize Path B generates). */
export function finalizeGeneratedProduct(
  jobId: string,
  subcategoryId: string,
): Promise<MerchantCatalogItem> {
  return api.post<MerchantCatalogItem>('/v1/merchant/catalog/import', { jobId, subcategoryId });
}

/** Best-effort cleanup of an orphaned $0 product (e.g. user closes the modal after generating but before saving). */
export function deleteProduct(id: string): Promise<void> {
  return api.del<void>(`/v1/merchant/catalog/${id}`).catch(() => undefined);
}

/**
 * Materializes any bulk-flat batches that finished while the merchant was away.
 * Held batches run whenever an admin releases them, so there is no in-modal poll
 * to finalize them — the catalogue view calls this on mount instead. Rows come
 * back inactive until the merchant fills in SKU and prices.
 *
 * `failed` distinguishes two very different situations for the caller:
 *  - a non-negative number is the server's own count of rows it could not
 *    finalize (a genuine partial failure, already logged server-side);
 *  - `-1` means the request itself never reached/completed against the server
 *    (network error, 5xx, session expiry) — reconciliation state is unknown,
 *    not "zero rows failed." Flattening this to 0 would silently hide a
 *    systemic failure behind an identical "nothing new yet" UI.
 */
export function reconcileHeldProducts(): Promise<{
  created: MerchantCatalogItem[];
  failed: number;
}> {
  return api
    .post<{ created: MerchantCatalogItem[]; failed: number }>(
      '/v1/merchant/catalog/reconcile-held',
      {},
    )
    .catch(() => ({ created: [], failed: -1 }));
}
