import { AppError } from './errors.js';
import { pinnedFetch } from './pinned-fetch.js';
import { assertPublicHttpUrl, type PublicHttpTarget } from './ssrf-guard.js';

const MAX_REDIRECT_HOPS = 5;
const MAX_HTML_BYTES = 5 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;

// Pinterest's og:image meta tag has been observed with attributes in either order
// (`content` before `property`, or after), with extra attributes (e.g. data-app)
// interleaved. Both alternatives are anchored to a single `<meta ...>` tag since
// `[^>]*` cannot cross a `>` boundary.
const OG_IMAGE_RE =
  /<meta\b[^>]*\bproperty=["']og:image["'][^>]*\bcontent=["']([^"']+)["']|<meta\b[^>]*\bcontent=["']([^"']+)["'][^>]*\bproperty=["']og:image["']/i;

export function isPinterestUrl(url: URL): boolean {
  const host = url.hostname.toLowerCase();
  return host === 'pin.it' || host === 'pinterest.com' || host.endsWith('.pinterest.com');
}

interface Hop {
  location: string | null;
  html: string | undefined;
}

async function fetchHop(target: PublicHttpTarget): Promise<Hop> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await pinnedFetch(target.url, target.address, controller.signal);
    if (res.status >= 300 && res.status < 400) {
      return { location: res.headers.get('location'), html: undefined };
    }
    if (!res.ok) {
      throw new AppError('VALIDATION', 400, `failed to fetch pinterest url (status ${res.status})`);
    }
    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.startsWith('text/html')) {
      throw new AppError('VALIDATION', 400, 'pinterest url did not return a page');
    }
    const contentLength = res.headers.get('content-length');
    if (contentLength && Number(contentLength) > MAX_HTML_BYTES) {
      throw new AppError('VALIDATION', 413, 'pinterest page exceeds size limit');
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
      if (total > MAX_HTML_BYTES) {
        await reader.cancel();
        throw new AppError('VALIDATION', 413, 'pinterest page exceeds size limit');
      }
      chunks.push(value);
    }
    return { location: null, html: Buffer.concat(chunks).toString('utf8') };
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Resolves a pin.it short link or a pinterest.com pin page to the actual image URL,
 * so `/backgrounds/mine/from-url` can accept Pinterest links (which are HTML pages,
 * not direct image bytes) as input. Every redirect hop and the final scraped image
 * URL are re-validated via assertPublicHttpUrl -- the initial pin.it/pinterest.com
 * host being trusted does not extend trust to wherever its redirect chain leads.
 */
export async function resolvePinterestImageUrl(
  target: PublicHttpTarget,
): Promise<PublicHttpTarget> {
  let current = target;
  let html: string | undefined;
  for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop++) {
    const result = await fetchHop(current);
    if (result.html !== undefined) {
      html = result.html;
      break;
    }
    if (!result.location) {
      throw new AppError('VALIDATION', 400, 'could not resolve pinterest url');
    }
    const next = new URL(result.location, current.url);
    current = await assertPublicHttpUrl(next.toString());
  }
  if (html === undefined) {
    throw new AppError('VALIDATION', 400, 'too many redirects resolving pinterest url');
  }

  const match = html.match(OG_IMAGE_RE);
  const imageUrl = match?.[1] ?? match?.[2];
  if (!imageUrl) {
    throw new AppError('VALIDATION', 400, 'could not find an image on that pinterest page');
  }
  return assertPublicHttpUrl(imageUrl);
}
