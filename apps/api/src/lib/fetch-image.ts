import { AppError } from './errors.js';
import { pinnedFetch } from './pinned-fetch.js';

const ALLOWED_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/**
 * Fetches a URL with a hard byte cap enforced during the stream read (not just
 * from a possibly-absent/lying Content-Length header) and a request timeout.
 * Redirects are refused outright rather than followed, to avoid re-validating
 * a second host — from-url callers must pass the URL and address returned
 * together by assertPublicHttpUrl, so the connection goes to the exact IP that
 * was validated rather than whatever the hostname resolves to right now.
 */
export async function fetchImageWithCap(
  url: URL,
  address: string,
  maxBytes: number,
  timeoutMs: number,
): Promise<Buffer> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await pinnedFetch(url, address, controller.signal);
    if (res.status >= 300 && res.status < 400) {
      throw new AppError('VALIDATION', 400, 'redirects are not supported for background URLs');
    }
    if (!res.ok) {
      throw new AppError('VALIDATION', 400, `failed to fetch image (status ${res.status})`);
    }
    const contentType = res.headers.get('content-type') ?? '';
    if (!ALLOWED_CONTENT_TYPES.some((t) => contentType.startsWith(t))) {
      throw new AppError('VALIDATION', 400, 'url did not return an image');
    }
    const contentLength = res.headers.get('content-length');
    if (contentLength && Number(contentLength) > maxBytes) {
      throw new AppError('VALIDATION', 413, 'image exceeds size limit');
    }
    if (!res.body) {
      throw new AppError('VALIDATION', 400, 'empty response body');
    }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new AppError('VALIDATION', 413, 'image exceeds size limit');
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally {
    clearTimeout(timeout);
  }
}
