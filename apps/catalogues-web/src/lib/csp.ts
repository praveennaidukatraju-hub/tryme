// SEC-H2: origins are derived from this build's own env vars (baked in at
// build time, see CLAUDE.md "Build-time vs runtime config") rather than
// hardcoded, so the CSP always matches whatever this specific build actually
// talks to instead of drifting from a copy-pasted domain list.
function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

const apiOrigin = originOf(process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000');
const chatbotOrigin = originOf(process.env.NEXT_PUBLIC_CHATBOT_URL);
const chatbotWsOrigin = chatbotOrigin?.replace(/^http/, 'ws') ?? null;
const sentryOrigin = originOf(process.env.NEXT_PUBLIC_SENTRY_DSN);

/**
 * Nonce + 'strict-dynamic': Next.js auto-tags its own inline/streaming
 * scripts with the nonce it finds on the request (see middleware.ts), and
 * 'strict-dynamic' lets those trusted scripts load further scripts (Next's
 * chunks, Razorpay's dynamically-inserted checkout.js) without needing every
 * origin individually allow-listed. 'self' + the explicit hosts stay as a
 * fallback for browsers that don't support strict-dynamic.
 */
export function buildCsp(nonce: string): string {
  const isDev = process.env.NODE_ENV !== 'production';

  const directives: Record<string, string[]> = {
    'default-src': ["'self'"],
    'script-src': [
      "'self'",
      `'nonce-${nonce}'`,
      "'strict-dynamic'",
      'https://checkout.razorpay.com',
      ...(isDev ? ["'unsafe-eval'"] : []), // Next dev/HMR needs eval; never shipped to prod
    ],
    // React/Radix inline `style="..."` attributes are pervasive — style-src
    // unsafe-inline can't execute JS, so the risk it accepts is far smaller
    // than script-src unsafe-inline would be.
    'style-src': ["'self'", "'unsafe-inline'"],
    'img-src': [
      "'self'",
      'data:',
      'blob:',
      'http://127.0.0.1:*', // local MinIO in dev — loopback-only, harmless outside a dev machine
      'https://*.r2.cloudflarestorage.com',
      'https://app.tryme.com',
      'https://*.razorpay.com',
      'https://img.youtube.com', // Tutorials + Try-On demo video thumbnails
      ...(apiOrigin ? [apiOrigin] : []),
    ],
    'font-src': ["'self'", 'data:'],
    'connect-src': [
      "'self'",
      'https://api.razorpay.com',
      'https://lumberjack.razorpay.com',
      'https://api.frankfurter.app', // pricing page currency conversion
      // Garment/asset uploads PUT directly from the browser to a presigned
      // storage URL (bypassing the API — see CLAUDE.md's web/architecture
      // notes), so the storage origin needs connect-src too, not just
      // img-src (which only covers displaying the result afterward). Mirrors
      // img-src's storage origins exactly.
      'http://127.0.0.1:*', // local MinIO in dev — loopback-only, harmless outside a dev machine
      'https://*.r2.cloudflarestorage.com',
      'https://app.tryme.com',
      ...(apiOrigin ? [apiOrigin] : []),
      ...(chatbotOrigin ? [chatbotOrigin] : []),
      ...(chatbotWsOrigin ? [chatbotWsOrigin] : []),
      ...(sentryOrigin ? [sentryOrigin] : []),
      ...(isDev ? ['ws://127.0.0.1:*', 'ws://localhost:*'] : []), // Next dev HMR websocket
    ],
    // youtube.com (not youtube-nocookie.com) — matches the embed URL host used
    // by both the Tutorials page and the Try-On demo video.
    'frame-src': [
      'https://api.razorpay.com',
      'https://checkout.razorpay.com',
      'https://www.youtube.com',
    ],
    'object-src': ["'none'"],
    'base-uri': ["'self'"],
    'form-action': ["'self'"],
    'frame-ancestors': ["'self'"],
  };

  return Object.entries(directives)
    .map(([directive, sources]) => `${directive} ${sources.join(' ')}`)
    .join('; ');
}
