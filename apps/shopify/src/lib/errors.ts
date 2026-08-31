import { ApiError } from './api';

export interface ClassifiedError {
  message: string;
  tone: 'critical' | 'warning' | 'info';
  retryable: boolean;
  code: string | null;
  status: number | null;
}

// Two distinct "rate limited" codes exist on the backend (see
// apps/api/src/server.ts and customer.routes.ts) but this SPA only ever hits
// the global @fastify/rate-limit plugin (RATE_LIMIT) — RATE_LIMITED is the
// storefront-widget-only code. Both are handled the same way here in case
// that ever changes.
const RATE_LIMIT_CODES = new Set(['RATE_LIMIT', 'RATE_LIMITED']);
// Server misconfiguration or an unhandled exception — never a merchant's
// problem to retry, and retrying can't fix either one.
const NOT_ACTIONABLE_CODES = new Set(['CONFIG', 'INTERNAL']);

/**
 * Normalizes anything a call site's catch block might see — an ApiError from
 * the backend's `{error:{code,message}}` envelope, a plain Error tagged with
 * a synthetic `.code` (timeout/network failure), or an arbitrary thrown value
 * — into a shape pages can render consistently: what to say, how urgent it
 * looks, and whether a Retry action makes sense.
 */
export function classifyError(err: unknown): ClassifiedError {
  const status = err instanceof ApiError ? err.status : null;
  const code = err instanceof Error ? ((err as { code?: string }).code ?? null) : null;
  const message = err instanceof Error ? err.message : 'Something went wrong.';

  if (code === 'SHOPIFY_REAUTH_REQUIRED') {
    // apiFetch already fired a top-level redirect into the reauth flow by the
    // time a caller sees this — an error banner would only race it.
    return {
      message:
        "We're reconnecting your store to Shopify to fix a permissions issue — this only takes a moment, no action needed.",
      tone: 'info',
      retryable: false,
      code,
      status,
    };
  }
  if (code && RATE_LIMIT_CODES.has(code)) {
    return {
      message: "You're doing that a bit fast. Wait a few seconds, then try again.",
      tone: 'warning',
      retryable: true,
      code,
      status,
    };
  }
  if (code === 'LOCKED') {
    // A background operation (token refresh, widget-config publish) is
    // already in flight for this store — our own lock contention, not an
    // upstream Shopify failure, and always resolves within seconds.
    return { message, tone: 'warning', retryable: true, code, status };
  }
  if (code === 'TIMEOUT') {
    return {
      message: `${message} If it keeps happening, reload the page.`,
      tone: 'warning',
      retryable: true,
      code,
      status,
    };
  }
  if (code === 'NETWORK_ERROR') {
    return { message, tone: 'warning', retryable: true, code, status };
  }
  if (code && NOT_ACTIONABLE_CODES.has(code)) {
    return {
      // Not a "try again" situation — retrying can't fix a misconfigured
      // server or an unhandled exception, so the guidance points at support
      // instead of a Retry action (retryable stays false).
      message: `${message} This isn't something retrying will fix — if it keeps happening, contact support and let us know what you were doing.`,
      tone: 'critical',
      retryable: false,
      code,
      status,
    };
  }
  // SHOPIFY covers genuine upstream Shopify call failures (throttling,
  // timeouts, a bad response) — transient by nature. Any other 5xx is
  // presumed transient too. (Our own lock contention uses LOCKED, above, not
  // this code — see token.ts/widget-config.routes.ts.)
  if (code === 'SHOPIFY' || (status !== null && status >= 500)) {
    return {
      message: `${message} This usually clears up on its own — try again in a moment, and contact support if it keeps happening.`,
      tone: 'critical',
      retryable: true,
      code,
      status,
    };
  }
  // Ordinary 4xx (BAD_REQUEST, FORBIDDEN, NOT_FOUND, CONFLICT, VALIDATION,
  // ...): the backend already writes these messages for merchants to read
  // and act on directly, and retrying the same request won't change the
  // outcome, so they're shown as-is rather than padded with generic advice.
  return { message, tone: 'critical', retryable: false, code, status };
}
