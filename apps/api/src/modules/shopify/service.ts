import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { Redis } from 'ioredis';
import { AppError } from '../../lib/errors.js';

// Shopify Admin API version used by every outbound call in this module.
// Shopify retires versions ~1 year after release — bump this centrally,
// not per-callsite, so it never goes stale in only some places.
export const SHOPIFY_API_VERSION = '2026-07';

/**
 * Turns one specific Shopify userError into an unmissable operator signal.
 *
 * Shopify answers every Billing API charge mutation with "Managed Pricing Apps
 * cannot use the Billing API (to create charges)" once the app has been put on
 * Shopify App Pricing (formerly Managed Pricing) in the Partner Dashboard —
 * which is what editing the public plans on the App Store listing can do. From
 * inside the app it is indistinguishable from any other userError, so without
 * this it surfaces as a generic 502 on a single merchant's purchase while in
 * fact *every* charge in the app, on every store, is dead until the app is
 * switched back to Manual pricing. That distinction is the whole reason this
 * exists: one merchant's failed purchase is a support ticket, this is an
 * outage.
 */
export function warnIfManagedPricing(
  log: FastifyBaseLogger,
  shopDomain: string,
  message: string,
): void {
  if (!/managed pricing/i.test(message)) return;
  log.fatal(
    { shopDomain, shopifyMessage: message },
    'BILLING DISABLED FOR ALL STORES — the app is on Shopify App Pricing; switch it back to Manual pricing in the Partner Dashboard, then re-test a purchase',
  );
}

// Every direct call to Shopify's Admin API (REST or GraphQL) must go through
// this wrapper instead of a raw fetch(). A store's granted OAuth scope can
// fall behind app.env.SHOPIFY_SCOPES after we ship a scope bump — Shopify
// then rejects the stored offline token with a 401/403 that looks identical
// to "token is just broken". Centralizing the call here means every route
// gets the same SHOPIFY_REAUTH_REQUIRED signal instead of each callsite
// reinventing (or forgetting) that distinction.
//
// The fifth argument accepts either a bare fetch (legacy callers, mostly tests)
// or an options object. Passing `onUnauthorized` opts into one refresh-and-retry
// on a 401, which is the backstop for expiring offline tokens: getValidAccessToken
// refreshes ahead of expiry, but only this covers a token that lapses after the
// check and before the call.
export interface ShopifyAdminFetchOptions {
  fetchImpl?: typeof fetch;
  /**
   * Called once on a 401 to obtain a fresh access token, after which the
   * request is retried. Supply it wherever a store row is in hand — it is what
   * saves a caller holding a token across a long run, where the hour can lapse
   * between acquiring the token and this particular call going out.
   *
   * Only 401 triggers it. A 403 is an authorization verdict on a token Shopify
   * accepted, so a newer token of the same scope would be refused identically.
   */
  onUnauthorized?: () => Promise<string>;
}

export async function shopifyAdminFetch(
  shopDomain: string,
  accessToken: string,
  path: string,
  init: RequestInit = {},
  fetchImplOrOptions: typeof fetch | ShopifyAdminFetchOptions = {},
): Promise<Response> {
  const opts: ShopifyAdminFetchOptions =
    typeof fetchImplOrOptions === 'function'
      ? { fetchImpl: fetchImplOrOptions }
      : fetchImplOrOptions;
  const fetchImpl = opts.fetchImpl ?? fetch;

  const url = path.startsWith('http')
    ? path
    : `https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}${path}`;
  const send = (token: string) =>
    fetchImpl(url, {
      ...init,
      headers: { ...init.headers, 'X-Shopify-Access-Token': token },
    });

  let res = await send(accessToken);

  if (res.status === 401 && opts.onUnauthorized) {
    const refreshed = await opts.onUnauthorized();
    // Only retry on a genuinely different token. Re-sending the same one would
    // burn a second call to reach the identical 401.
    if (refreshed && refreshed !== accessToken) res = await send(refreshed);
  }

  if (res.status === 401 || res.status === 403) {
    throw new AppError(
      'SHOPIFY_REAUTH_REQUIRED',
      403,
      'This store needs to reauthorize TryMe to grant updated permissions',
    );
  }
  return res;
}

export interface GraphQLUserError {
  field?: string[] | null;
  message: string;
}

export interface ShopifyGraphQLOptions extends ShopifyAdminFetchOptions {
  /**
   * Injectable so throttle-retry tests don't spend real seconds sleeping.
   * Production callers omit it and get the exponential backoff.
   */
  sleepImpl?: (ms: number) => Promise<void>;
}

interface GraphQLBody<T> {
  data?: T;
  errors?: Array<{ message: string; extensions?: { code?: string } }>;
}

const THROTTLE_MAX_ATTEMPTS = 3;
const THROTTLE_BASE_DELAY_MS = 1000;

const defaultSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Every Admin API call in this module goes through here.
 *
 * Layered on shopifyAdminFetch rather than beside it, so the 401
 * refresh-and-retry and the 401/403 → SHOPIFY_REAUTH_REQUIRED mapping are
 * inherited rather than duplicated — pass `onUnauthorized` through `options`
 * and it keeps working exactly as it does for the REST callers.
 *
 * Throws on every failure mode, including the one that arrives as HTTP 200:
 * GraphQL reports a refused query in `body.errors` with a 200 status, so a
 * caller that only checked `res.ok` would read `undefined` and carry on.
 */
export async function shopifyGraphQL<T>(
  shopDomain: string,
  accessToken: string,
  query: string,
  variables: Record<string, unknown> = {},
  options: ShopifyGraphQLOptions = {},
): Promise<T> {
  const { sleepImpl = defaultSleep, ...fetchOptions } = options;
  let lastThrottleMessage = 'throttled';

  for (let attempt = 1; attempt <= THROTTLE_MAX_ATTEMPTS; attempt++) {
    const res = await shopifyAdminFetch(
      shopDomain,
      accessToken,
      '/graphql.json',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables }),
      },
      fetchOptions,
    );
    if (!res.ok) {
      throw new AppError('SHOPIFY', 502, `Shopify GraphQL request failed: HTTP ${res.status}`);
    }

    const body = (await res.json()) as GraphQLBody<T>;

    // Throttling arrives as a 200 with an errors entry, not REST's 429.
    const throttled = body.errors?.find((e) => e.extensions?.code === 'THROTTLED');
    if (throttled) {
      lastThrottleMessage = throttled.message;
      if (attempt < THROTTLE_MAX_ATTEMPTS) {
        await sleepImpl(THROTTLE_BASE_DELAY_MS * 2 ** (attempt - 1));
        continue;
      }
      break;
    }

    if (body.errors?.length) {
      throw new AppError('SHOPIFY', 502, body.errors[0].message);
    }
    if (!body.data) {
      throw new AppError('SHOPIFY', 502, 'Shopify GraphQL response contained no data');
    }
    return body.data;
  }

  throw new AppError('SHOPIFY', 502, `Shopify GraphQL throttled: ${lastThrottleMessage}`);
}

/** Postgres stores numeric Shopify ids; GraphQL speaks gids. Convert at the boundary. */
export function toGid(resource: string, id: number | string): string {
  return `gid://shopify/${resource}/${id}`;
}

/**
 * Inverse of toGid. Throws rather than returning NaN: a silently-NaN product id
 * would be written into a bigint column as a corrupt row.
 */
export function numericIdFromGid(gid: string): number {
  const match = /^gid:\/\/shopify\/[A-Za-z]+\/(\d+)$/.exec(gid);
  if (!match) throw new AppError('SHOPIFY', 502, `unexpected Shopify global id: ${gid}`);
  return Number(match[1]);
}

/**
 * A GraphQL mutation can answer 200, pass the `errors` check, and still have
 * refused the write via `userErrors`. Callers that must fail loudly use this;
 * callers with a log-and-continue contract check the array themselves.
 */
export function assertNoUserErrors(
  errors: GraphQLUserError[] | undefined | null,
  context: string,
): void {
  if (!errors || errors.length === 0) return;
  throw new AppError('SHOPIFY', 502, `${context}: ${errors[0].message}`);
}

function safeEq(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

export function verifyWebhookHmac(rawBody: Buffer, hmacHeader: string, secret: string): boolean {
  if (!hmacHeader) return false;
  const digest = createHmac('sha256', secret).update(rawBody).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(hmacHeader, 'base64');
  } catch {
    return false;
  }
  return safeEq(digest, provided);
}

export function verifyQueryHmac(query: Record<string, string>, secret: string): boolean {
  const { hmac, signature, ...rest } = query;
  if (!hmac) return false;
  const msg = Object.keys(rest)
    .sort()
    .map((k) => `${k}=${rest[k]}`)
    .join('&');
  const digest = createHmac('sha256', secret).update(msg).digest('hex');
  return safeEq(Buffer.from(digest, 'utf8'), Buffer.from(hmac, 'utf8'));
}

/**
 * App Proxy signature verification (distinct scheme from verifyQueryHmac's OAuth
 * `hmac` param above — this is `signature`, not `hmac`). Per Shopify's docs:
 * exclude `signature`, format each remaining param as `key=value1,value2` (comma
 * joins multi-values), sort by key, and concatenate with NO delimiter between
 * pairs — unlike the OAuth scheme's `&`-joined string. Getting this delimiter
 * wrong silently breaks every request rather than failing loudly, so don't
 * "simplify" it to match verifyQueryHmac above.
 */
export function verifyAppProxySignature(
  query: Record<string, string | string[]>,
  secret: string,
): boolean {
  const { signature, ...rest } = query;
  if (!signature || typeof signature !== 'string') return false;
  const msg = Object.keys(rest)
    .sort()
    .map((k) => {
      const v = rest[k];
      return `${k}=${Array.isArray(v) ? v.join(',') : v}`;
    })
    .join('');
  const digest = createHmac('sha256', secret).update(msg).digest('hex');
  return safeEq(Buffer.from(digest, 'utf8'), Buffer.from(signature, 'utf8'));
}

export function shopHostFromDomain(domain: string): string {
  return domain.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
}

interface SessionClaims {
  iss?: string;
  dest?: string;
  aud?: string;
  exp?: number;
  nbf?: number;
}

export function verifySessionToken(
  token: string,
  secret: string,
  apiKey: string,
): { dest: string; shopDomain: string } {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed session token');
  const [headB64, bodyB64, sigB64] = parts;
  const header = JSON.parse(Buffer.from(headB64, 'base64url').toString()) as { alg?: string };
  if (header.alg !== 'HS256') throw new Error('unexpected token alg'); // never accept `none`
  const expected = createHmac('sha256', secret).update(`${headB64}.${bodyB64}`).digest('base64url');
  if (!safeEq(Buffer.from(expected), Buffer.from(sigB64))) throw new Error('bad signature');

  const claims = JSON.parse(Buffer.from(bodyB64, 'base64url').toString()) as SessionClaims;
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== 'number' || claims.exp < now) throw new Error('token expired');
  if (typeof claims.nbf === 'number' && claims.nbf > now + 5)
    throw new Error('token not yet valid');
  if (claims.aud !== apiKey) throw new Error('aud mismatch');
  if (!claims.dest || !claims.iss) throw new Error('missing dest/iss');
  if (shopHostFromDomain(claims.dest) !== shopHostFromDomain(claims.iss))
    throw new Error('iss/dest host mismatch');
  const shopDomain = shopHostFromDomain(claims.dest);
  return { dest: claims.dest, shopDomain };
}

export interface SyncTask {
  storeId: string;
  mode: 'full' | 'product' | 'collection';
  shopifyProductId?: number;
  shopifyCollectionId?: number;
}

export async function enqueueSync(redis: Redis, task: SyncTask): Promise<void> {
  await redis.xadd('shopify:sync', '*', 'task', JSON.stringify(task));
}
