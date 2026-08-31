import { api } from '@/lib/api';

export const MAX_FILE_BYTES = 10 * 1024 * 1024;

/**
 * Presigns and uploads one file, resolving to its R2 key. Each call gets its own
 * key from /v1/uploads/presign (the UUID in the key is a per-upload token, not
 * the user id), so parallel uploads never collide.
 */
export async function uploadTrayFile(
  file: File,
  onProgress: (pct: number) => void,
): Promise<string> {
  const { uploadUrl, r2Key } = await api.post<{
    uploadUrl: string;
    r2Key: string;
    expiresIn: number;
  }>('/v1/uploads/presign', { contentType: file.type, contentLength: file.size });
  await api.uploadToR2WithProgress(uploadUrl, file, onProgress);
  return r2Key;
}

/** How many bulk-upload files run at once — see runWithConcurrencyLimit. */
export const BULK_UPLOAD_CONCURRENCY = 3;

/**
 * Runs `worker` over every item with at most `limit` in flight at once.
 * Bulk upload used to fire every file's presign+PUT simultaneously; on a
 * slower connection or a local dev stack that can't take that many
 * concurrent uploads, they failed together instead of queuing. One item's
 * rejection doesn't stop the others — worker is expected to catch its own
 * errors (uploadTrayFile's caller already reports failures per-garment).
 */
export async function runWithConcurrencyLimit<T>(
  items: T[],
  limit: number,
  worker: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  async function runNext(): Promise<void> {
    const i = next++;
    const item = items[i];
    if (item === undefined) return;
    await worker(item);
    return runNext();
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runNext));
}
