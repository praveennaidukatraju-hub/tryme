import { getIdToken } from './appBridge';

export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// In dev, Vite proxies /v1 to the local API (vite.config.ts) so a relative path
// works. In prod this SPA is served from admin.tryme.com, which doesn't proxy
// /v1/* — the API is only reachable at app.tryme.com, so requests there must
// be absolute + cross-origin (CORS-allowed, Bearer-token auth, no cookies).
const API_BASE = import.meta.env.VITE_API_BASE_URL ?? '';

// Set once at app boot (see App.tsx) from /v1/shopify/me, so apiFetch can
// kick off a reauth redirect without every callsite threading it through.
let currentShopDomain: string | null = null;
export function setShopDomain(domain: string): void {
  currentShopDomain = domain;
}

async function parseErrorBody(res: Response): Promise<{ message: string; code?: string }> {
  const text = await res.text();
  try {
    const parsed = JSON.parse(text) as { error?: { code?: string; message?: string } };
    if (parsed.error?.message) return { message: parsed.error.message, code: parsed.error.code };
  } catch {
    // not JSON — fall through to raw text
  }
  return { message: text || res.statusText };
}

// Shopify's OAuth consent page refuses to be framed — must break out of the
// embedded admin iframe with a top-level navigation, not a fetch/redirect.
// Assigning window.top.location.href directly is a script-driven navigation,
// which some browsers (Chrome, notably) restrict for a cross-origin iframe
// unless it has active user activation — exactly the situation here, since
// this fires from an async fetch().then()/.catch() continuation, not a click
// handler. An <a target="_top"> element's native click handling is not
// subject to that restriction, so route through one instead of assigning
// location directly.
export function navigateTopLevel(url: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.target = '_top';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

// Exported for App.tsx's fresh-install redirect, where there is no
// currentShopDomain yet to fall back on.
export function redirectToShopifyAuth(shop: string): void {
  navigateTopLevel(`${API_BASE}/v1/shopify/auth?shop=${encodeURIComponent(shop)}`);
}

// The store's granted OAuth scope can fall behind what this app currently
// requires (e.g. after a scope bump ships) — Shopify then rejects our stored
// offline token. The backend surfaces that as SHOPIFY_REAUTH_REQUIRED so we
// can send the merchant through the existing one-click reauth flow instead of
// them (or us) having to notice and manually reinstall the app.
function handleReauthIfNeeded(code: string | undefined): void {
  if (code !== 'SHOPIFY_REAUTH_REQUIRED' || !currentShopDomain) return;
  redirectToShopifyAuth(currentShopDomain);
}

// Plain fetch() has no built-in timeout — a stalled connection (dead tunnel,
// backend hang) would otherwise leave callers awaiting forever with no way to
// recover short of a full page reload.
const FETCH_TIMEOUT_MS = 12_000;

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      throw Object.assign(new Error('Request timed out — check your connection and try again.'), {
        code: 'TIMEOUT',
      });
    }
    // A dead tunnel, DNS failure, CORS block, or offline browser all surface
    // here as a plain TypeError from fetch() itself — there's no response to
    // parse an ApiError out of. Tag it the same way as the timeout above so
    // lib/errors.ts's classifyError can recognize it without string-matching
    // err.message.
    if (err instanceof TypeError) {
      throw Object.assign(
        new Error("Couldn't reach TryMe — check your connection and try again."),
        { code: 'NETWORK_ERROR' },
      );
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Authenticated request returning the raw Response.
 *
 * Every callsite must go through this (or `apiFetch`, which wraps it) rather
 * than a bare `fetch` or an `<a href>`: it is the only place that applies the
 * absolute API base, the App Bridge bearer token, the 401 re-acquire retry and
 * the reauth redirect. Exported for responses that are not JSON — a CSV
 * download, for instance, needs the Blob, not a parsed body.
 */
export async function apiFetchResponse(path: string, init: RequestInit = {}): Promise<Response> {
  const url = `${API_BASE}${path}`;
  const token = await getIdToken();
  const res = await fetchWithTimeout(
    url,
    {
      ...init,
      headers: {
        ...init.headers,
        Authorization: `Bearer ${token}`,
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      },
    },
    FETCH_TIMEOUT_MS,
  );

  if (res.status === 401) {
    // Session token may have expired between acquisition and use (~60s lifetime) — retry once with a fresh one.
    const freshToken = await getIdToken();
    const retryRes = await fetchWithTimeout(
      url,
      {
        ...init,
        headers: {
          ...init.headers,
          Authorization: `Bearer ${freshToken}`,
          ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        },
      },
      FETCH_TIMEOUT_MS,
    );
    if (!retryRes.ok) {
      const { message, code } = await parseErrorBody(retryRes);
      handleReauthIfNeeded(code);
      throw new ApiError(retryRes.status, message, code);
    }
    return retryRes;
  }

  if (!res.ok) {
    const { message, code } = await parseErrorBody(res);
    handleReauthIfNeeded(code);
    throw new ApiError(res.status, message, code);
  }
  return res;
}

export async function apiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await apiFetchResponse(path, init);
  try {
    return (await res.json()) as T;
  } catch {
    // A 2xx response with a non-JSON or empty body — a malformed proxy
    // response, most likely — would otherwise throw a raw SyntaxError that
    // bypasses ApiError entirely and can't be classified.
    throw new ApiError(
      res.status,
      'Received an unexpected response from the server.',
      'BAD_RESPONSE',
    );
  }
}
