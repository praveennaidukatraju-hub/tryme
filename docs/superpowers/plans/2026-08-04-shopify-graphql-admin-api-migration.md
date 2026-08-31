# Shopify REST → GraphQL Admin API Migration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove every REST Admin API call from `apps/api/src/modules/shopify/`, replacing each with its GraphQL Admin API equivalent, to satisfy Shopify App Store requirement 2.2.4.

**Architecture:** One shared `shopifyGraphQL<T>()` helper in `service.ts`, layered on top of the existing `shopifyAdminFetch` so the 401-refresh-and-retry and `SHOPIFY_REAUTH_REQUIRED` mapping are reused rather than reimplemented. Each of the seven REST call sites migrates onto it. Numeric Shopify IDs (what Postgres stores) convert to/from `gid://shopify/...` at the call boundary via `toGid` / `numericIdFromGid`.

**Tech Stack:** TypeScript 5.6 ESM, Fastify 5, Drizzle ORM, Vitest, Shopify Admin GraphQL API version `2026-07`.

**Spec:** `docs/superpowers/specs/2026-08-04-shopify-graphql-admin-api-migration-design.md`

## Global Constraints

- Shopify Admin API version is `2026-07`, held in `SHOPIFY_API_VERSION` in `service.ts`. Do not change it, and do not hardcode a version at any call site.
- All GraphQL goes through `shopifyGraphQL()`. No call site may build its own `fetch` to `/graphql.json`.
- `shopifyAdminFetch` stays exported and unchanged. It becomes the internal transport for `shopifyGraphQL`.
- Numeric IDs are what Postgres stores (`shopify_product_id`, `shopify_collection_id` are `bigint`). Convert at the boundary only — never store a gid, never pass a numeric ID to GraphQL.
- Preserve every existing error type and HTTP status: `AppError('SHOPIFY', 502, …)` for Shopify-side failures, `SHOPIFY_REAUTH_REQUIRED` for auth failures, `CollectionNotFoundError` for a deleted collection.
- `writeWidgetConfigMetafield` returns `false` on failure and only rethrows `SHOPIFY_REAUTH_REQUIRED`. `writeWidgetKeyMetafield` never throws. These contracts are load-bearing — `publishLatestConfig` in `auth.routes.ts` relies on the callback not being consumed by a mirror failure.
- No `console.log`. Use the passed pino logger (`app.log`, `req.log`, or the `log` parameter).
- Run tests with `pnpm --filter @tryme/api test`. Requires `pnpm docker:up` running first.
- Do not commit to `main`. Do not push. Commit per task as specified.

## File Structure

| File | Responsibility after this plan |
|------|-------------------------------|
| `apps/api/src/modules/shopify/service.ts` | Adds `shopifyGraphQL`, `toGid`, `numericIdFromGid`, `assertNoUserErrors`. Keeps `shopifyAdminFetch` as internal transport. |
| `apps/api/src/modules/shopify/graphql.test.ts` | **New.** Unit tests for the four additions above. |
| `apps/api/src/modules/shopify/metafields.ts` | Both metafield writes via one shared `setShopMetafield` on `metafieldsSet`. |
| `apps/api/src/modules/shopify/auth.routes.ts` | Shop details via GraphQL `shop` query. Loses the webhook self-registration call (Task 7). |
| `apps/api/src/modules/shopify/collections.sync.ts` | Owns `fetchCollectionTitleMap` (moved here from `products.sync.ts`). Collection title + membership in one query. |
| `apps/api/src/modules/shopify/products.sync.ts` | Product sync via GraphQL. Loses `nextPageUrl`, `fetchCollectionTitleMap`, `fetchProductCollectionTitles`. |
| `apps/api/src/modules/shopify/products.routes.ts` | Live product images via GraphQL. |
| `apps/api/src/modules/shopify/webhook.routes.ts` | HTTP handlers only. `registerWebhooksDecorator` deleted. |
| `apps/api/src/modules/shopify/routes.ts` | Drops the `registerWebhooksDecorator` registration. |
| `apps/api/src/modules/shopify/catalog-publish.ts` | `createProductMedia` folded onto the shared helper. |
| `apps/shopify-extension/shopify.app.toml`, `shopify.app.dev.toml` | Gain four `[[webhooks.subscriptions]]` blocks. |

**Task ordering is load-bearing.** Task 1 must land first (everything depends on the helper). Task 2 must precede Task 3 (Task 3 updates the callsite of a signature Task 2 changes). **Task 4 must precede Task 5** — `collections.sync.ts` currently imports `fetchCollectionTitleMap` and `nextPageUrl` from `products.sync.ts`; Task 4 gives `collections.sync.ts` its own GraphQL implementation and stops importing them, so Task 5 can delete the orphans without breaking a sibling.

---

## Task 1: Shared GraphQL helper in `service.ts`

**Files:**
- Modify: `apps/api/src/modules/shopify/service.ts` (add after `shopifyAdminFetch`, which ends at line 76)
- Test: `apps/api/src/modules/shopify/graphql.test.ts` (create)

**Interfaces:**
- Consumes: `shopifyAdminFetch(shopDomain, accessToken, path, init, fetchImplOrOptions)`, `ShopifyAdminFetchOptions { fetchImpl?, onUnauthorized? }`, `AppError(code, status, message)` from `../../lib/errors.js` — all already present.
- Produces, for every later task:
  - `shopifyGraphQL<T>(shopDomain: string, accessToken: string, query: string, variables?: Record<string, unknown>, options?: ShopifyGraphQLOptions): Promise<T>` — returns `body.data`, throws `AppError('SHOPIFY', 502, …)` on any failure.
  - `ShopifyGraphQLOptions extends ShopifyAdminFetchOptions { sleepImpl?: (ms: number) => Promise<void> }`
  - `toGid(resource: string, id: number | string): string`
  - `numericIdFromGid(gid: string): number` — throws `AppError` on a malformed gid.
  - `assertNoUserErrors(errors: GraphQLUserError[] | undefined | null, context: string): void`
  - `GraphQLUserError { field?: string[] | null; message: string }`

- [ ] **Step 1: Write the failing tests**

Create `apps/api/src/modules/shopify/graphql.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../../lib/errors.js';
import {
  assertNoUserErrors,
  numericIdFromGid,
  shopifyGraphQL,
  toGid,
} from './service.js';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** Never actually sleeps — keeps the throttle-retry tests instant. */
const noSleep = async () => {};

describe('toGid / numericIdFromGid', () => {
  it('builds a global id from a resource and numeric id', () => {
    expect(toGid('Product', 42)).toBe('gid://shopify/Product/42');
    expect(toGid('Shop', '7')).toBe('gid://shopify/Shop/7');
  });

  it('round-trips back to the numeric id', () => {
    expect(numericIdFromGid(toGid('Collection', 500))).toBe(500);
    expect(numericIdFromGid('gid://shopify/ProductImage/111')).toBe(111);
  });

  it('throws on a malformed gid rather than returning NaN', () => {
    // A silently-NaN id would write a corrupt row, so this must be loud.
    expect(() => numericIdFromGid('not-a-gid')).toThrow(AppError);
    expect(() => numericIdFromGid('gid://shopify/Product/')).toThrow(AppError);
    expect(() => numericIdFromGid('gid://shopify/Product/abc')).toThrow(AppError);
  });
});

describe('assertNoUserErrors', () => {
  it('is a no-op for empty, undefined, or null', () => {
    expect(() => assertNoUserErrors([], 'ctx')).not.toThrow();
    expect(() => assertNoUserErrors(undefined, 'ctx')).not.toThrow();
    expect(() => assertNoUserErrors(null, 'ctx')).not.toThrow();
  });

  it('throws with the context and the first message', () => {
    expect(() =>
      assertNoUserErrors([{ field: ['value'], message: 'bad value' }], 'metafieldsSet widget_key'),
    ).toThrow(/metafieldsSet widget_key: bad value/);
  });
});

describe('shopifyGraphQL', () => {
  it('POSTs query and variables to /graphql.json and returns data', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: { shop: { name: 'S' } } }));

    const data = await shopifyGraphQL<{ shop: { name: string } }>(
      's.myshopify.com',
      'tok',
      'query Q { shop { name } }',
      { a: 1 },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );

    expect(data).toEqual({ shop: { name: 'S' } });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    // Deliberately not asserting the exact version segment — SHOPIFY_API_VERSION
    // is bumped centrally and this test must not become a second place to update.
    expect(url).toContain('https://s.myshopify.com/admin/api/');
    expect(url).toContain('/graphql.json');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': 'tok',
    });
    expect(JSON.parse(init.body as string)).toEqual({
      query: 'query Q { shop { name } }',
      variables: { a: 1 },
    });
  });

  it('throws on a non-2xx response', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 500));
    await expect(
      shopifyGraphQL('s.myshopify.com', 'tok', 'query Q { x }', {}, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/HTTP 500/);
  });

  it('throws on top-level GraphQL errors even though the status is 200', async () => {
    // A GraphQL endpoint answers 200 on a query it refused. Without this check
    // every caller would silently read undefined.
    const fetchImpl = vi.fn(async () => jsonResponse({ errors: [{ message: 'bad field' }] }));
    await expect(
      shopifyGraphQL('s.myshopify.com', 'tok', 'query Q { x }', {}, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/bad field/);
  });

  it('throws when a 200 response carries no data', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}));
    await expect(
      shopifyGraphQL('s.myshopify.com', 'tok', 'query Q { x }', {}, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toThrow(/no data/);
  });

  it('retries a THROTTLED response and returns the eventual success', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({ errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }] }),
      )
      .mockResolvedValueOnce(jsonResponse({ data: { ok: true } }));

    const data = await shopifyGraphQL<{ ok: boolean }>(
      's.myshopify.com',
      'tok',
      'query Q { ok }',
      {},
      { fetchImpl: fetchImpl as unknown as typeof fetch, sleepImpl: noSleep },
    );

    expect(data).toEqual({ ok: true });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('gives up after 3 throttled attempts', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ errors: [{ message: 'Throttled', extensions: { code: 'THROTTLED' } }] }),
    );

    await expect(
      shopifyGraphQL('s.myshopify.com', 'tok', 'query Q { ok }', {}, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
        sleepImpl: noSleep,
      }),
    ).rejects.toThrow(/throttled/i);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it('surfaces a 401 as SHOPIFY_REAUTH_REQUIRED via shopifyAdminFetch', async () => {
    // Delegated, not reimplemented — this asserts the delegation still holds.
    const fetchImpl = vi.fn(async () => jsonResponse({}, 401));
    await expect(
      shopifyGraphQL('s.myshopify.com', 'tok', 'query Q { x }', {}, {
        fetchImpl: fetchImpl as unknown as typeof fetch,
      }),
    ).rejects.toMatchObject({ code: 'SHOPIFY_REAUTH_REQUIRED' });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @tryme/api test -- graphql.test`
Expected: FAIL — `shopifyGraphQL`, `toGid`, `numericIdFromGid`, `assertNoUserErrors` are not exported from `./service.js`.

- [ ] **Step 3: Add the helper to `service.ts`**

Insert immediately after the closing brace of `shopifyAdminFetch` (currently line 76, just before `function safeEq`):

```ts
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm --filter @tryme/api test -- graphql.test`
Expected: PASS, 12 tests.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @tryme/api typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/shopify/service.ts apps/api/src/modules/shopify/graphql.test.ts
git commit -m "feat(shopify): add shared GraphQL Admin API helper

Layered on shopifyAdminFetch so 401 refresh-and-retry and the
SHOPIFY_REAUTH_REQUIRED mapping are inherited rather than duplicated at
each call site. Handles the failure mode REST does not have: GraphQL
reports a refused query as HTTP 200 with a body.errors entry, and reports
throttling the same way instead of via 429."
```

---

## Task 2: `metafields.ts` — both writes onto `metafieldsSet`

**Files:**
- Modify: `apps/api/src/modules/shopify/metafields.ts` (full rewrite, 114 lines)
- Test: `apps/api/src/modules/shopify/metafields.test.ts` (update), `apps/api/test/shopify-metafields.test.ts` (update)

**Interfaces:**
- Consumes: `shopifyGraphQL`, `toGid`, `assertNoUserErrors`, `GraphQLUserError` from Task 1.
- Produces:
  - `writeWidgetKeyMetafield(shop: string, accessToken: string, shopifyShopId: number, widgetKey: string, log: FastifyBaseLogger, fetchFn?: typeof fetch): Promise<void>` — **note the new third parameter**; Task 3 updates the one callsite.
  - `writeWidgetConfigMetafield(shop, accessToken, shopifyShopId, config, log, fetchFn?): Promise<boolean>` — signature unchanged.

**Why this task exists beyond compliance:** the current `writeWidgetKeyMetafield` uses REST `POST /metafields.json`, whose own code comment concedes it "gets away with REST because it runs exactly once, at install." That premise is false on reinstall — the OAuth callback runs again, the shop's `widget_key` metafield still exists, REST answers 422, and the `catch` swallows it. The storefront then reads a stale widget key. `metafieldsSet` is a true upsert and is correct on both install and reinstall.

- [ ] **Step 1: Replace `metafields.ts` entirely**

```ts
import type { ShopifyWidgetConfig } from '@tryme/db';
import type { FastifyBaseLogger } from 'fastify';
import { AppError } from '../../lib/errors.js';
import { assertNoUserErrors, type GraphQLUserError, shopifyGraphQL, toGid } from './service.js';

// One mutation serves both metafields. metafieldsSet is an upsert, which is
// what REST POST /metafields.json is not: that endpoint 422s when a metafield
// with the same namespace/key already exists, which is exactly what happens on
// every reinstall.
const METAFIELDS_SET = `
  mutation SetShopMetafield($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      userErrors { field message }
    }
  }
`;

interface MetafieldsSetData {
  metafieldsSet?: { userErrors?: GraphQLUserError[] };
}

/** Throws on any failure. The two exported wrappers below own the swallowing. */
async function setShopMetafield(
  shop: string,
  accessToken: string,
  shopifyShopId: number,
  key: string,
  type: string,
  value: string,
  fetchFn: typeof fetch,
): Promise<void> {
  const data = await shopifyGraphQL<MetafieldsSetData>(
    shop,
    accessToken,
    METAFIELDS_SET,
    {
      metafields: [
        {
          ownerId: toGid('Shop', shopifyShopId),
          namespace: 'tryme',
          key,
          type,
          value,
        },
      ],
    },
    { fetchImpl: fetchFn },
  );

  const result = data.metafieldsSet;
  if (!result) throw new AppError('SHOPIFY', 502, 'metafieldsSet missing from response');
  assertNoUserErrors(result.userErrors, `metafieldsSet ${key}`);
}

/**
 * Never throws. Runs inside the OAuth callback, where a metafield mirror
 * failure must not consume a valid callback and strand the merchant.
 */
export async function writeWidgetKeyMetafield(
  shop: string,
  accessToken: string,
  shopifyShopId: number,
  widgetKey: string,
  log: FastifyBaseLogger,
  fetchFn: typeof fetch = fetch,
): Promise<void> {
  try {
    await setShopMetafield(
      shop,
      accessToken,
      shopifyShopId,
      'widget_key',
      'single_line_text_field',
      widgetKey,
      fetchFn,
    );
  } catch (err) {
    log.error({ err, shop }, 'failed to write widget_key metafield');
  }
}

/**
 * Returns false rather than throwing — Postgres is authoritative for widget
 * config and a failed mirror surfaces to the merchant as `synced: false`.
 * SHOPIFY_REAUTH_REQUIRED is the one exception: it must propagate so the SPA
 * can send the merchant through reauth.
 */
export async function writeWidgetConfigMetafield(
  shop: string,
  accessToken: string,
  shopifyShopId: number,
  config: ShopifyWidgetConfig,
  log: FastifyBaseLogger,
  fetchFn: typeof fetch = fetch,
): Promise<boolean> {
  try {
    await setShopMetafield(
      shop,
      accessToken,
      shopifyShopId,
      'widget_config',
      'json',
      JSON.stringify(config),
      fetchFn,
    );
    return true;
  } catch (err) {
    if (err instanceof AppError && err.code === 'SHOPIFY_REAUTH_REQUIRED') throw err;
    log.error({ err, shop }, 'failed to write widget_config metafield');
    return false;
  }
}
```

- [ ] **Step 2: Update the unit test's mutation-name assertion**

In `apps/api/src/modules/shopify/metafields.test.ts` line 37, the mutation was renamed from `SetWidgetConfig` to `SetShopMetafield` (it now serves both metafields):

```ts
    expect(sent.query).toContain('mutation SetShopMetafield');
```

Every other assertion in that file stays as-is — `ownerId`, `namespace`, `key`, `type`, `value`, and all six return-value contracts are unchanged by design.

- [ ] **Step 3: Rewrite the `writeWidgetKeyMetafield` tests**

In `apps/api/test/shopify-metafields.test.ts`, replace the first test (currently lines 10-36, asserting `/metafields.json` and a REST body) with:

```ts
describe('writeWidgetKeyMetafield', () => {
  it('upserts the widget key as a shop metafield via metafieldsSet', async () => {
    const calls: { url: string; body: unknown }[] = [];
    const fakeFetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: init?.body ? JSON.parse(init.body as string) : undefined });
      return new Response(JSON.stringify({ data: { metafieldsSet: { userErrors: [] } } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });

    await writeWidgetKeyMetafield(
      'shop.myshopify.com',
      'shpat_token',
      4242,
      'wk-123',
      log,
      fakeFetch as unknown as typeof fetch,
    );

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain('/admin/api/');
    expect(calls[0].url).toContain('/graphql.json');
    const sent = calls[0].body as { query: string; variables: { metafields: unknown[] } };
    expect(sent.query).toContain('mutation SetShopMetafield');
    expect(sent.variables.metafields[0]).toEqual({
      ownerId: 'gid://shopify/Shop/4242',
      namespace: 'tryme',
      key: 'widget_key',
      type: 'single_line_text_field',
      value: 'wk-123',
    });
  });
```

Then update the remaining `writeWidgetKeyMetafield` calls in that file to pass the new `shopifyShopId` third argument (`4242`) — the "does not throw when the request fails" test and any others. Their assertions (that the function resolves without throwing) are unchanged.

- [ ] **Step 4: Run the metafield tests**

Run: `pnpm --filter @tryme/api test -- metafields`
Expected: PASS — both `src/modules/shopify/metafields.test.ts` (6 tests) and `test/shopify-metafields.test.ts`.

- [ ] **Step 5: Typecheck — expect ONE known error**

Run: `pnpm --filter @tryme/api typecheck`
Expected: exactly one error, at `auth.routes.ts:196` — along the lines of `Expected 5-6 arguments, but got 4`, because the callsite has not yet been given the new `shopifyShopId` argument. **This is correct and expected.** Task 3 fixes that callsite. Do not "fix" it here by reverting the signature or by passing a placeholder id.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/shopify/metafields.ts \
        apps/api/src/modules/shopify/metafields.test.ts \
        apps/api/test/shopify-metafields.test.ts
git commit -m "refactor(shopify): write both shop metafields via metafieldsSet

Replaces REST POST /metafields.json for widget_key. That endpoint 422s
when the metafield already exists, which is every reinstall — and the
error was swallowed, leaving the storefront reading a stale widget key.
metafieldsSet is a real upsert, so install and reinstall both work.

writeWidgetKeyMetafield gains a shopifyShopId parameter (GraphQL needs an
ownerId gid); its callsite is updated in the following commit."
```

---

## Task 3: `auth.routes.ts` — shop details via GraphQL

**Files:**
- Modify: `apps/api/src/modules/shopify/auth.routes.ts` (lines 1-11 imports, 162-196)

**Interfaces:**
- Consumes: `shopifyGraphQL`, `numericIdFromGid` (Task 1); `writeWidgetKeyMetafield(shop, accessToken, shopifyShopId, widgetKey, log, fetchFn?)` (Task 2).
- Produces: nothing new. The exported `ShopDetails` interface and `upsertShopifyStore` are unchanged, so no downstream caller is affected.

This is the one REST call that bypasses `shopifyAdminFetch` entirely — a raw `fetch` at line 163.

- [ ] **Step 1: Update the imports**

In the import block at the top of `auth.routes.ts`, change the `./service.js` import to add the two new helpers:

```ts
import { numericIdFromGid, shopifyGraphQL, verifyQueryHmac } from './service.js';
```

`SHOPIFY_API_VERSION` was only used by the raw `fetch` being deleted — remove it from the import. Leave every other import alone.

- [ ] **Step 2: Add the query and its response type**

Insert above `export async function shopifyAuthRoutes(app: FastifyInstance) {` (currently line 105):

```ts
const SHOP_DETAILS = `
  query ShopDetails {
    shop {
      id
      name
      email
      myshopifyDomain
      primaryDomain { host }
      shopOwnerName
      billingAddress { phone address1 city country }
      ianaTimezone
    }
  }
`;

interface ShopDetailsData {
  shop: {
    id: string;
    name: string;
    email: string;
    myshopifyDomain: string;
    primaryDomain?: { host?: string | null } | null;
    shopOwnerName?: string | null;
    billingAddress?: {
      phone?: string | null;
      address1?: string | null;
      city?: string | null;
      country?: string | null;
    } | null;
    ianaTimezone?: string | null;
  };
}
```

- [ ] **Step 3: Replace the shop fetch and the details mapping**

Replace everything from `// Fetch shop details` (line 162) through the close of the `details` object literal (line 193) with:

```ts
    // Shop details
    const { shop: s } = await shopifyGraphQL<ShopDetailsData>(
      q.shop,
      access_token,
      SHOP_DETAILS,
    );
    const details: ShopDetails = {
      shopifyShopId: numericIdFromGid(s.id),
      shopDomain: s.myshopifyDomain,
      myshopifyDomain: s.myshopifyDomain,
      primaryDomain: s.primaryDomain?.host ?? undefined,
      name: s.name,
      shopOwner: s.shopOwnerName ?? undefined,
      email: s.email,
      phone: s.billingAddress?.phone ?? undefined,
      address: [s.billingAddress?.address1, s.billingAddress?.city, s.billingAddress?.country]
        .filter(Boolean)
        .join(', '),
      ianaTimezone: s.ianaTimezone ?? undefined,
    };
```

- [ ] **Step 4: Update the `writeWidgetKeyMetafield` callsite**

Line 196 becomes:

```ts
    await writeWidgetKeyMetafield(
      q.shop,
      access_token,
      details.shopifyShopId,
      store.storeKey,
      req.log,
    );
```

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @tryme/api typecheck`
Expected: clean — the Task 2 error at line 196 is now resolved.

- [ ] **Step 6: Run the Shopify test suite**

Run: `pnpm --filter @tryme/api test -- shopify`
Expected: PASS. `upsertShopifyStore` is called directly by several test files with a hand-built `ShopDetails`; since that interface did not change, they are unaffected.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/shopify/auth.routes.ts
git commit -m "refactor(shopify): fetch shop details via GraphQL at install

Replaces the one REST call that bypassed shopifyAdminFetch entirely (a
raw fetch to /shop.json). ShopDetails and upsertShopifyStore are
unchanged, so nothing downstream moves."
```

---

## Task 4: `collections.sync.ts` — title, membership, and search via GraphQL

**Files:**
- Modify: `apps/api/src/modules/shopify/collections.sync.ts` (full rewrite, 134 lines)
- Test: `apps/api/test/shopify-collections-sync.test.ts`, `apps/api/test/shopify-collections-resync-scheduler.test.ts`

**Interfaces:**
- Consumes: `shopifyGraphQL`, `toGid`, `numericIdFromGid` (Task 1); `getValidAccessToken(app, store)` (unchanged, from `./token.js`).
- Produces:
  - `fetchCollectionTitleMap(shop: string, token: string): Promise<Map<number, string>>` — **moves here from `products.sync.ts`**. Task 5 deletes the old copy.
  - `syncCollectionMembership(app, store, shopifyCollectionId): Promise<{ title: string; productCount: number }>` — signature unchanged.
  - `searchCollections(app, store, q): Promise<Array<{ shopifyCollectionId: number; title: string }>>` — signature unchanged.
  - `CollectionNotFoundError` — unchanged class and semantics.

**Must precede Task 5.** This file currently imports `fetchCollectionTitleMap` and `nextPageUrl` from `products.sync.ts`. After this task it imports neither, freeing Task 5 to delete them.

**What disappears, and why it is not scope creep:** `fetchOneCollectionTitle` currently queries `custom_collections/{id}.json`, then `smart_collections/{id}.json`, and infers deletion only when *both* 404 — carefully distinguishing that from a 5xx so a rate limit is never misread as a deletion. GraphQL's `collection(id:)` returns `null` for a deleted collection and throws for everything else, so one nullable field replaces the entire dance. The long comment explaining why the two fetches must be sequential goes with the code it explains.

- [ ] **Step 1: Replace `collections.sync.ts` entirely**

```ts
import { schema } from '@tryme/db';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { numericIdFromGid, shopifyGraphQL, toGid } from './service.js';
import { getValidAccessToken } from './token.js';

/**
 * Thrown when Shopify reports no collection at this id — i.e. it was deleted.
 * The scheduled resync treats this specifically as "clean up this collection's
 * rows"; every other failure (rate limit, 5xx, network) throws from
 * shopifyGraphQL instead and is retried next cycle unchanged.
 */
export class CollectionNotFoundError extends Error {
  constructor(shopifyCollectionId: number) {
    super(`collection ${shopifyCollectionId} not found`);
    this.name = 'CollectionNotFoundError';
  }
}

const COLLECTION_MEMBERS = `
  query CollectionMembers($id: ID!, $cursor: String) {
    collection(id: $id) {
      title
      products(first: 250, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes { id }
      }
    }
  }
`;

interface CollectionMembersData {
  collection: {
    title: string;
    products: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: Array<{ id: string }>;
    };
  } | null;
}

const COLLECTION_LIST = `
  query CollectionList($cursor: String) {
    collections(first: 250, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { id title }
    }
  }
`;

interface CollectionListData {
  collections: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: Array<{ id: string; title: string }>;
  };
}

/**
 * One collection's title and its full membership.
 *
 * GraphQL returns both in a single query, and returns `collection: null` for a
 * deleted collection — which is the whole of the not-found detection. The REST
 * version needed two probing fetches (custom then smart) plus explicit status
 * discrimination to reach the same conclusion.
 */
async function fetchCollectionTitleAndMembers(
  shop: string,
  token: string,
  shopifyCollectionId: number,
): Promise<{ title: string; productIds: number[] }> {
  const id = toGid('Collection', shopifyCollectionId);
  const productIds: number[] = [];
  let title = '';
  let cursor: string | null = null;

  do {
    const data: CollectionMembersData = await shopifyGraphQL<CollectionMembersData>(
      shop,
      token,
      COLLECTION_MEMBERS,
      { id, cursor },
    );
    if (!data.collection) throw new CollectionNotFoundError(shopifyCollectionId);
    title = data.collection.title;
    for (const node of data.collection.products.nodes) {
      productIds.push(numericIdFromGid(node.id));
    }
    const page = data.collection.products.pageInfo;
    cursor = page.hasNextPage ? page.endCursor : null;
  } while (cursor);

  return { title, productIds };
}

/**
 * id → title for every collection on the store.
 *
 * GraphQL exposes one `collections` connection, so the REST split between
 * custom_collections and smart_collections is gone.
 */
export async function fetchCollectionTitleMap(
  shop: string,
  token: string,
): Promise<Map<number, string>> {
  const titleById = new Map<number, string>();
  let cursor: string | null = null;

  do {
    const data: CollectionListData = await shopifyGraphQL<CollectionListData>(
      shop,
      token,
      COLLECTION_LIST,
      { cursor },
    );
    for (const node of data.collections.nodes) {
      titleById.set(numericIdFromGid(node.id), node.title);
    }
    cursor = data.collections.pageInfo.hasNextPage ? data.collections.pageInfo.endCursor : null;
  } while (cursor);

  return titleById;
}

/**
 * Pulls one collection's title and full membership from Shopify and replaces
 * (not diffs) that collection's rows in `shopify_collection_products`, in one
 * transaction — a failure here must not leave a collection showing partial
 * membership.
 */
export async function syncCollectionMembership(
  app: FastifyInstance,
  store: typeof schema.shopifyStores.$inferSelect,
  shopifyCollectionId: number,
): Promise<{ title: string; productCount: number }> {
  const token = await getValidAccessToken(app, store);
  const { title, productIds } = await fetchCollectionTitleAndMembers(
    store.shopDomain,
    token,
    shopifyCollectionId,
  );

  await app.db.transaction(async (tx) => {
    await tx
      .insert(schema.shopifyCollections)
      .values({ storeId: store.id, shopifyCollectionId, title })
      .onConflictDoUpdate({
        target: [schema.shopifyCollections.storeId, schema.shopifyCollections.shopifyCollectionId],
        set: { title, syncedAt: new Date() },
      });

    await tx
      .delete(schema.shopifyCollectionProducts)
      .where(
        and(
          eq(schema.shopifyCollectionProducts.storeId, store.id),
          eq(schema.shopifyCollectionProducts.shopifyCollectionId, shopifyCollectionId),
        ),
      );

    if (productIds.length > 0) {
      await tx.insert(schema.shopifyCollectionProducts).values(
        productIds.map((shopifyProductId) => ({
          storeId: store.id,
          shopifyCollectionId,
          shopifyProductId,
        })),
      );
    }
  });

  return { title, productCount: productIds.length };
}

/**
 * Live search over every collection, for the "Add collections"/"Exclude
 * collections" picker modal.
 *
 * Fetches the full list and filters in memory. Shopify's native
 * `query: "title:*needle*"` search was considered and rejected: it tokenizes on
 * word boundaries, so it would silently change which collections a merchant
 * sees for mid-word queries. Not worth a UX regression inside a compliance
 * migration.
 */
export async function searchCollections(
  app: FastifyInstance,
  store: typeof schema.shopifyStores.$inferSelect,
  q: string,
): Promise<Array<{ shopifyCollectionId: number; title: string }>> {
  const token = await getValidAccessToken(app, store);
  const titleById = await fetchCollectionTitleMap(store.shopDomain, token);
  const needle = q.toLowerCase();
  return [...titleById.entries()]
    .filter(([, title]) => title.toLowerCase().includes(needle))
    .map(([shopifyCollectionId, title]) => ({ shopifyCollectionId, title }));
}
```

- [ ] **Step 2: Rewrite the membership test mock**

In `apps/api/test/shopify-collections-sync.test.ts`, replace the `global.fetch` stub inside the first test (currently lines 55-76) with a GraphQL one:

```ts
    const originalFetch = global.fetch;
    global.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: {
            collection: {
              title: 'Summer',
              products: {
                pageInfo: { hasNextPage: false, endCursor: null },
                nodes: [
                  { id: 'gid://shopify/Product/1' },
                  { id: 'gid://shopify/Product/2' },
                ],
              },
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )) as typeof fetch;
```

Every assertion in that test — `{ title: 'Summer', productCount: 2 }`, the `[1, 2]` membership, the stale `999` row being gone, the persisted collection title — stays exactly as written.

- [ ] **Step 3: Rewrite the deleted-collection and rate-limit test mocks**

In the same file, the "throws CollectionNotFoundError when both resources 404" test: rename it and swap the mock. Under GraphQL a deleted collection is a 200 with `collection: null`, not a 404.

```ts
  it('throws CollectionNotFoundError when Shopify reports no such collection', async () => {
    const [store] = await app.db
      .select()
      .from(schema.shopifyStores)
      .where(eq(schema.shopifyStores.id, storeId));

    const originalFetch = global.fetch;
    global.fetch = (async () =>
      new Response(JSON.stringify({ data: { collection: null } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;

    try {
      const { CollectionNotFoundError } = await import(
        '../src/modules/shopify/collections.sync.js'
      );
      await expect(syncCollectionMembership(app, store, 12345)).rejects.toBeInstanceOf(
        CollectionNotFoundError,
      );
    } finally {
      global.fetch = originalFetch;
    }
  });
```

For "does not classify a rate-limit response as not-found", keep the test name and intent; a throttled GraphQL response is a 200 carrying a `THROTTLED` error. Supply `sleepImpl` is not reachable from here, so use a plain non-throttle GraphQL error instead — it exercises the same "not a deletion" branch without a multi-second retry:

```ts
    const originalFetch = global.fetch;
    global.fetch = (async () =>
      new Response(JSON.stringify({ errors: [{ message: 'Too many requests' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;
```

The assertion (`rejects.not.toBeInstanceOf(CollectionNotFoundError)`) is unchanged.

- [ ] **Step 4: Rewrite the search test mock**

Replace the stub in the `searchCollections` describe (currently lines 163-180) with the unified collections connection:

```ts
    const originalFetch = global.fetch;
    global.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: {
            collections: {
              pageInfo: { hasNextPage: false, endCursor: null },
              nodes: [
                { id: 'gid://shopify/Collection/1', title: 'Summer Dresses' },
                { id: 'gid://shopify/Collection/2', title: 'Winter Coats' },
              ],
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      )) as typeof fetch;
```

Rename the test to drop the now-meaningless custom/smart distinction: `'filters the full collection list by a case-insensitive title substring'`. The assertion `[{ shopifyCollectionId: 1, title: 'Summer Dresses' }]` is unchanged.

- [ ] **Step 5: Rewrite the resync scheduler mock**

In `apps/api/test/shopify-collections-resync-scheduler.test.ts`, replace the stub at lines 119-121:

```ts
    const originalFetch = global.fetch;
    global.fetch = (async () =>
      new Response(JSON.stringify({ data: { collection: null } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as typeof fetch;
```

All assertions unchanged.

- [ ] **Step 6: Run the collection tests**

Run: `pnpm --filter @tryme/api test -- collections`
Expected: PASS — `shopify-collections-sync.test.ts` (4 tests) and `shopify-collections-resync-scheduler.test.ts`.

- [ ] **Step 7: Typecheck**

Run: `pnpm --filter @tryme/api typecheck`
Expected: clean. `products.sync.ts` still exports its own `fetchCollectionTitleMap` and `nextPageUrl` — now unused by anyone, but not yet an error. Task 5 removes them.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/modules/shopify/collections.sync.ts \
        apps/api/test/shopify-collections-sync.test.ts \
        apps/api/test/shopify-collections-resync-scheduler.test.ts
git commit -m "refactor(shopify): fetch collections via GraphQL

collection(id:) returns null for a deleted collection, which replaces the
two-resource 404-probing dance that had to query custom_collections then
smart_collections and discriminate 404 from 5xx to avoid misreading a rate
limit as a deletion. Title and membership now arrive in one query, and the
custom/smart split disappears into a single collections connection.

fetchCollectionTitleMap moves here from products.sync.ts, its only
remaining consumer being searchCollections."
```

---

## Task 5: `products.sync.ts` — product sync via GraphQL

**Files:**
- Modify: `apps/api/src/modules/shopify/products.sync.ts` (lines 1-45 imports/types, 121-152 `syncProduct` field reads, 207-253 delete, 340-387 `syncOneTask`)
- Test: `apps/api/test/shopify-sync.test.ts`

**Interfaces:**
- Consumes: `shopifyGraphQL`, `toGid`, `numericIdFromGid` (Task 1).
- Produces:
  - `ShopifyProduct` — **now a normalized internal shape, not the raw Shopify wire shape**: `{ id: number; title: string; imageUrl?: string | null; productType?: string | null; tags?: string[] | null; vendor?: string | null; collections?: string[] | null }`
  - `syncProduct(app, storeId, product: ShopifyProduct, fetchFn?): Promise<void>` — signature unchanged in shape; the `product` argument's field names change.
  - `assertShopifyCdn(url: string): void` — unchanged, still consumed by `products.routes.ts`.
  - **Deletes** `nextPageUrl` and `fetchCollectionTitleMap` (the latter now lives in `collections.sync.ts` per Task 4).

**Design note — why `ShopifyProduct` becomes normalized.** Today it mirrors the REST wire format (`image.src`, `product_type`, `tags` as a CSV string). Keeping it as a wire shape would drag GraphQL's shape into `syncProduct`, which is pure business logic and is what `shopify-sync.test.ts` tests directly. Normalizing at the fetch boundary keeps `syncProduct` transport-agnostic, deletes the CSV-splitting entirely (GraphQL `tags` is already `[String!]!`), and means the test file's changes are field renames rather than mock rewrites.

**Highest-risk task in the plan.** This is the core catalog path, its comments record two prior silent-failure incidents, and it interacts with token refresh mid-run. Two behaviors must survive verbatim:
1. `onUnauthorized` is passed on the full-sync page fetch and reassigns the outer `token`, because a large catalog outlives the one-hour token.
2. A failed page fetch **throws** (it used to silently `break`, which made "My Products" look permanently empty with no log line). `shopifyGraphQL` throws on failure, so this is preserved by construction — do not wrap it in a try/catch that swallows.

- [ ] **Step 1: Update imports and the product type**

Replace lines 1-18 (imports through the `ShopifyProduct` interface):

```ts
import { schema } from '@tryme/db';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { getUploadLimitBytes } from '../../lib/upload-limits-config.js';
import { numericIdFromGid, shopifyGraphQL, type SyncTask, toGid } from './service.js';
import { getValidAccessToken } from './token.js';

/**
 * Normalized product shape consumed by syncProduct.
 *
 * Deliberately not Shopify's wire format: syncProduct is business logic and is
 * tested directly, so the GraphQL response is mapped into this at the fetch
 * boundary by toShopifyProduct below.
 */
export interface ShopifyProduct {
  id: number;
  title: string;
  imageUrl?: string | null;
  productType?: string | null;
  tags?: string[] | null;
  vendor?: string | null;
  collections?: string[] | null;
}
```

Leave lines 20-45 (`FetchLikeResponse`, `FetchLike`, `ALLOWED_HOSTS`, `FETCH_TIMEOUT_MS`, `NO_VARIANT_SENTINEL`, `assertShopifyCdn`) untouched.

- [ ] **Step 2: Add the GraphQL queries and the mapper**

Insert immediately after `assertShopifyCdn` (after line 45):

```ts
// Shared selection set. Product.collections returns titles inline, which is why
// there is no longer a collects.json call or a collection-title map here: the
// REST version needed one extra request per product to learn the same thing.
//
// collections(first: 25) caps what REST paginated fully. That is safe because
// shopify_product_garments.collections is written and never read — activation
// resolves membership through shopify_collection_products (populated by
// collections.sync.ts), not this column.
const PRODUCT_FIELDS = `
  id
  title
  productType
  tags
  vendor
  featuredImage { url }
  collections(first: 25) { nodes { title } }
`;

const PRODUCTS_PAGE = `
  query ProductsPage($cursor: String) {
    products(first: 25, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { ${PRODUCT_FIELDS} }
    }
  }
`;

const ONE_PRODUCT = `
  query OneProduct($id: ID!) {
    product(id: $id) { ${PRODUCT_FIELDS} }
  }
`;

interface GraphQLProductNode {
  id: string;
  title: string;
  productType?: string | null;
  tags?: string[] | null;
  vendor?: string | null;
  featuredImage?: { url?: string | null } | null;
  collections?: { nodes: Array<{ title: string }> } | null;
}

interface ProductsPageData {
  products: {
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: GraphQLProductNode[];
  };
}

/** GraphQL wire shape → the normalized shape syncProduct consumes. */
function toShopifyProduct(node: GraphQLProductNode): ShopifyProduct {
  return {
    id: numericIdFromGid(node.id),
    title: node.title,
    imageUrl: node.featuredImage?.url ?? null,
    // Empty string is Shopify's "unset" for these, and the columns are nullable.
    productType: node.productType || null,
    tags: node.tags && node.tags.length > 0 ? node.tags : null,
    vendor: node.vendor || null,
    collections: node.collections?.nodes.map((c) => c.title) ?? null,
  };
}
```

- [ ] **Step 3: Update `syncProduct`'s field reads**

In `syncProduct` (starting line 121 in the original), replace the five destructuring lines:

```ts
  const r2Key = `shopify-garments/${storeId}/${product.id}/garment.jpg`;
  const productType = product.productType ?? null;
  const tags = product.tags ?? null;
  const vendor = product.vendor ?? null;
  const collections = product.collections ?? null;
  const src = product.imageUrl;
```

The rest of `syncProduct` — the no-image failure path, `assertShopifyCdn`, the abort-signal download, both size caps, the `putObject`, both `upsertGarment` calls, the try/catch — is unchanged. The CSV `.split(',').map(trim).filter(Boolean)` is deleted, not rewritten: GraphQL `tags` is already an array.

- [ ] **Step 4: Delete the REST pagination and collects machinery**

Delete outright:
- `nextPageUrl` (lines 207-211)
- `fetchCollectionTitleMap` (lines 213-232) — now lives in `collections.sync.ts`
- `fetchProductCollectionTitles` (lines 234-253)

Also delete the two stale comments that reference `collects.json`: the one inside the old `ShopifyProduct` interface (already gone with Step 1) and the `// full sync: paginate (250/page)…` block that mentions "One extra collects.json call per product".

- [ ] **Step 5: Rewrite the product-mode branch of `syncOneTask`**

Replace the `if (task.mode === 'product' && task.shopifyProductId) { … }` block (lines 340-364):

```ts
  if (task.mode === 'product' && task.shopifyProductId) {
    let node: GraphQLProductNode | null;
    try {
      const data = await shopifyGraphQL<{ product: GraphQLProductNode | null }>(
        shop,
        token,
        ONE_PRODUCT,
        { id: toGid('Product', task.shopifyProductId) },
        { onUnauthorized },
      );
      node = data.product;
    } catch (err) {
      // Previously a silent no-op: no row, no log — a persistently-failing
      // product re-enqueued via customer.routes.ts on every try-on attempt and
      // never left a trace to debug from.
      app.log.warn(
        { err, storeId: store.id, productId: task.shopifyProductId },
        'shopify product fetch failed during sync',
      );
      await upsertGarmentFailure(
        app,
        store.id,
        task.shopifyProductId,
        `product fetch failed: ${(err as Error).message}`,
      );
      return;
    }

    if (!node) {
      app.log.warn(
        { storeId: store.id, productId: task.shopifyProductId },
        'shopify product not found during sync',
      );
      await upsertGarmentFailure(
        app,
        store.id,
        task.shopifyProductId,
        'product not found on Shopify',
      );
      return;
    }

    await syncProduct(app, store.id, toShopifyProduct(node));
    return;
  }
```

- [ ] **Step 6: Rewrite the full-sync loop**

Replace the trailing full-sync block (lines 366-387):

```ts
  // Full sync, 25 products a page. Page size is bounded by Shopify's calculated
  // query cost (1000 per query): products(25) with a nested collections(25) is
  // roughly 25 + 25×25 = 650.
  let cursor: string | null = null;
  do {
    // onUnauthorized reassigns the outer `token`: a full sync of a large catalog
    // outlives the one-hour token, and this runs unattended with no merchant
    // present to reauthorize.
    const data: ProductsPageData = await shopifyGraphQL<ProductsPageData>(
      shop,
      token,
      PRODUCTS_PAGE,
      { cursor },
      { onUnauthorized },
    );
    for (const node of data.products.nodes) {
      await syncProduct(app, store.id, toShopifyProduct(node));
    }
    cursor = data.products.pageInfo.hasNextPage ? data.products.pageInfo.endCursor : null;
    if (cursor) await new Promise((r) => setTimeout(r, 500)); // throttle
  } while (cursor);
```

Note there is no `if (!res.ok) throw` here any more: `shopifyGraphQL` already throws on every failure, which preserves the deliberate "throw, don't silently break" behavior the deleted code documented. `sync-consumer.ts`'s existing catch still logs it as a failed task.

Delete the now-unused `const titleById = await fetchCollectionTitleMap(shop, token);` line that preceded the loop.

- [ ] **Step 7: Update the product literals in `shopify-sync.test.ts`**

This file tests `syncProduct` directly and never mocked the Admin API — only the image download. So every change is a field rename in the product literals:

- `image: { src: 'https://cdn.shopify.com/x.jpg' }` → `imageUrl: 'https://cdn.shopify.com/x.jpg'` (ids 42, 44, 45, 46, 47, 48, 501, 504)
- `image: null` → `imageUrl: null` (id 43)
- `product_type: 'Shirts'` → `productType: 'Shirts'` (id 501)
- `tags: 'Sale, Cotton'` → `tags: ['Sale', 'Cotton']` (id 501)

`vendor` and `collections` already match the new names. Every assertion — including `expect(row.tags).toEqual(['Sale', 'Cotton'])` — stays as written, which is the point: the persisted result is identical.

- [ ] **Step 8: Run the sync tests**

Run: `pnpm --filter @tryme/api test -- shopify-sync`
Expected: PASS, 8 tests.

- [ ] **Step 9: Typecheck and run the full Shopify suite**

Run: `pnpm --filter @tryme/api typecheck && pnpm --filter @tryme/api test -- shopify`
Expected: clean typecheck; all Shopify tests pass.

- [ ] **Step 10: Commit**

```bash
git add apps/api/src/modules/shopify/products.sync.ts apps/api/test/shopify-sync.test.ts
git commit -m "refactor(shopify): sync products via GraphQL

Product.collections returns titles inline, so the per-product collects.json
call disappears entirely rather than being ported — the REST path made one
extra request per product to learn the same thing, as its own comment
conceded. GraphQL tags is already an array, so the CSV split goes too.

ShopifyProduct becomes a normalized internal shape instead of the REST wire
format, keeping syncProduct transport-agnostic. Both prior silent-failure
fixes are preserved: a failed page still throws rather than breaking, and a
product that cannot be fetched still records a failed garment row.

Deletes nextPageUrl and the local fetchCollectionTitleMap, both now unused."
```

---

## Task 6: `products.routes.ts` — live product images via GraphQL

**Files:**
- Modify: `apps/api/src/modules/shopify/products.routes.ts` (lines 1-10 imports, 37-54 `fetchLiveProductImages`)
- Test: `apps/api/test/shopify-products.test.ts`, `apps/api/test/shopify-catalog-generate.test.ts`

**Interfaces:**
- Consumes: `shopifyGraphQL`, `toGid`, `numericIdFromGid` (Task 1); `assertShopifyCdn` from `./products.sync.js` (unchanged).
- Produces: `fetchLiveProductImages(app, store, shopifyProductId: string): Promise<{ id: number; src: string }[]>` — **return type deliberately unchanged**, so both consumers (the `/images` route and the `garmentImageUrl` validation in `PATCH /v1/shopify/products/:id`) need no edits.

- [ ] **Step 1: Update the imports**

Change the `./service.js` import line:

```ts
import { numericIdFromGid, shopifyGraphQL, toGid } from './service.js';
```

- [ ] **Step 2: Replace `fetchLiveProductImages`**

Replace lines 37-54 entirely:

```ts
const PRODUCT_IMAGES = `
  query ProductImages($id: ID!) {
    product(id: $id) {
      images(first: 250) { nodes { id url } }
    }
  }
`;

interface ProductImagesData {
  product: { images: { nodes: Array<{ id: string; url: string }> } } | null;
}

export async function fetchLiveProductImages(
  app: FastifyInstance,
  store: typeof schema.shopifyStores.$inferSelect,
  shopifyProductId: string,
): Promise<{ id: number; src: string }[]> {
  const token = await getValidAccessToken(app, store);
  const data = await shopifyGraphQL<ProductImagesData>(
    store.shopDomain,
    token,
    PRODUCT_IMAGES,
    { id: toGid('Product', shopifyProductId) },
  );
  if (!data.product) {
    throw new AppError('SHOPIFY', 502, 'failed to fetch product images');
  }
  const images = data.product.images.nodes;
  // Still guarded before any of these URLs is handed to a downloader.
  for (const img of images) assertShopifyCdn(img.url);
  return images.map((img) => ({ id: numericIdFromGid(img.id), src: img.url }));
}
```

Image gids are `gid://shopify/ProductImage/111`, which `numericIdFromGid` handles — its resource segment matches `[A-Za-z]+`.

- [ ] **Step 3: Rewrite the images mock in `shopify-products.test.ts`**

In the `GET /v1/shopify/products/:id/images` describe (currently lines 188-219), replace the stub:

```ts
    const originalFetch = global.fetch;
    global.fetch = (async (url: string) => {
      expect(url).toContain('/graphql.json');
      return new Response(
        JSON.stringify({
          data: {
            product: {
              images: {
                nodes: [
                  { id: 'gid://shopify/ProductImage/111', url: 'https://cdn.shopify.com/s/files/1/one.jpg' },
                  { id: 'gid://shopify/ProductImage/222', url: 'https://cdn.shopify.com/s/files/1/two.jpg' },
                ],
              },
            },
          },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as typeof fetch;
```

The response assertion is unchanged — it still expects `{ images: [{ id: 111, src: '…one.jpg' }, { id: 222, src: '…two.jpg' }] }`, which is exactly the point of preserving the return type.

- [ ] **Step 4: Rewrite the two PATCH mocks in the same file**

Both PATCH tests branch on `url.includes('/images.json')`. Change the branch condition to `url.includes('/graphql.json')` and the returned body to the GraphQL shape. For the "rejects a garment image above the admin-configured limit" test (around line 227):

```ts
      if (typeof url === 'string' && url.includes('/graphql.json')) {
        return new Response(
          JSON.stringify({
            data: {
              product: {
                images: {
                  nodes: [
                    { id: 'gid://shopify/ProductImage/1', url: 'https://cdn.shopify.com/oversized.jpg' },
                  ],
                },
              },
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
```

For "swaps the garment image to a real one from the product's image list" (around line 320), the same change with `url: 'https://cdn.shopify.com/s/files/1/new.jpg'` and id `gid://shopify/ProductImage/1`.

Both tests' assertions are unchanged.

- [ ] **Step 5: Rewrite the images stub in `shopify-catalog-generate.test.ts`**

At lines 118-138, the `LIVE_IMAGE_URLS` stub branches on `/images.json`. Replace that branch:

```ts
      if (typeof url === 'string' && url.includes('/graphql.json')) {
        return new Response(
          JSON.stringify({
            data: {
              product: {
                images: {
                  nodes: LIVE_IMAGE_URLS.map((imageUrl, i) => ({
                    id: `gid://shopify/ProductImage/${i}`,
                    url: imageUrl,
                  })),
                },
              },
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
```

Keep the `cdn.shopify.com` download branch below it exactly as-is. Note the ordering matters: the `/graphql.json` check must come first, since the CDN branch matches on a broader substring.

Update the stale comment above the stub — it says "the Shopify Admin REST images.json endpoint"; make it "the Shopify Admin GraphQL endpoint".

- [ ] **Step 6: Run the affected tests**

Run: `pnpm --filter @tryme/api test -- shopify-products` then `pnpm --filter @tryme/api test -- shopify-catalog-generate`
Expected: PASS both.

- [ ] **Step 7: Typecheck**

Run: `pnpm --filter @tryme/api typecheck`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/modules/shopify/products.routes.ts \
        apps/api/test/shopify-products.test.ts \
        apps/api/test/shopify-catalog-generate.test.ts
git commit -m "refactor(shopify): fetch live product images via GraphQL

fetchLiveProductImages keeps its {id, src} return type, so the images
route and the garmentImageUrl validation in PATCH both stay untouched.
assertShopifyCdn still guards every URL before it reaches a downloader."
```

---

## Task 7: Delete webhook self-registration, declare subscriptions in TOML

**Files:**
- Modify: `apps/api/src/modules/shopify/webhook.routes.ts` (delete lines 170-209 and the now-unused import)
- Modify: `apps/api/src/modules/shopify/routes.ts` (lines 15, 19-24)
- Modify: `apps/api/src/modules/shopify/auth.routes.ts` (line 214 and lines 256-260)
- Modify: `apps/shopify-extension/shopify.app.toml`, `apps/shopify-extension/shopify.app.dev.toml`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: removes `registerWebhooksDecorator` and the `FastifyInstance.shopifyRegisterWebhooks` augmentation from the codebase.

**⚠️ Deploy ordering — the one constraint outside this repo.** These subscriptions take effect only after `shopify app deploy`. Deleting the runtime registration and shipping to production *before* that deploy lands would leave new installs with no non-GDPR webhooks — no uninstall tracking, no product sync on change. **Confirm with the repo owner that the deploy is sequenced with this change before merging.** The GDPR block added on 2026-08-04 carries the same dependency and is not yet deployed either.

**Why this removes a failure class rather than just a REST call:** runtime registration is per-shop, fire-and-forget, and its callsite uses optional chaining (`app.shopifyRegisterWebhooks?.()`). A registration failure is therefore invisible — the install succeeds, the webhooks never arrive, and nothing surfaces it. Declared subscriptions apply automatically to every install with no runtime call that can fail.

- [ ] **Step 1: Add the four subscription blocks to the production TOML**

Append to `apps/shopify-extension/shopify.app.toml`, after the existing `[webhooks.privacy_compliance]` block. One block per topic, because each topic targets a distinct handler path:

```toml
  [[webhooks.subscriptions]]
  topics = [ "app/uninstalled" ]
  uri = "https://app.tryme.com/v1/shopify/webhooks/app_uninstalled"

  [[webhooks.subscriptions]]
  topics = [ "app_subscriptions/update" ]
  uri = "https://app.tryme.com/v1/shopify/webhooks/app_subscriptions_update"

  [[webhooks.subscriptions]]
  topics = [ "products/update" ]
  uri = "https://app.tryme.com/v1/shopify/webhooks/products_update"

  [[webhooks.subscriptions]]
  topics = [ "products/delete" ]
  uri = "https://app.tryme.com/v1/shopify/webhooks/products_delete"
```

- [ ] **Step 2: Add the same blocks to the dev TOML**

Append to `apps/shopify-extension/shopify.app.dev.toml`, using the ngrok host that the file's existing entries use:

```toml
  [[webhooks.subscriptions]]
  topics = [ "app/uninstalled" ]
  uri = "https://wispy-plaza-mullets.ngrok-free.dev/v1/shopify/webhooks/app_uninstalled"

  [[webhooks.subscriptions]]
  topics = [ "app_subscriptions/update" ]
  uri = "https://wispy-plaza-mullets.ngrok-free.dev/v1/shopify/webhooks/app_subscriptions_update"

  [[webhooks.subscriptions]]
  topics = [ "products/update" ]
  uri = "https://wispy-plaza-mullets.ngrok-free.dev/v1/shopify/webhooks/products_update"

  [[webhooks.subscriptions]]
  topics = [ "products/delete" ]
  uri = "https://wispy-plaza-mullets.ngrok-free.dev/v1/shopify/webhooks/products_delete"
```

- [ ] **Step 3: Delete `registerWebhooksDecorator`**

In `apps/api/src/modules/shopify/webhook.routes.ts`, delete everything from the comment beginning `// Wrapped in fp() (matching every other decorator plugin…` through the end of the file (lines 170-209).

Then fix the imports at the top: `shopifyAdminFetch` and `fp` are no longer used. Line 3 and line 7 become:

```ts
import type { FastifyInstance, FastifyRequest } from 'fastify';
```
```ts
import { enqueueSync, verifyWebhookHmac } from './service.js';
```

Delete the `import fp from 'fastify-plugin';` line entirely.

Also delete the now-obsolete NOTE comment at lines 9-13, which explains where `shopifyRegisterWebhooks` is declared — that declaration is going away in Step 5.

Everything else in the file — the seven POST route registrations, the raw-body content-type parser, HMAC verification, `logRedactResult`, all post-processing — is unchanged.

- [ ] **Step 4: Drop the registration from `routes.ts`**

In `apps/api/src/modules/shopify/routes.ts`, change line 15 to import only the routes:

```ts
import { shopifyWebhookRoutes } from './webhook.routes.js';
```

Delete lines 19-24 — the four-line comment explaining the registration-order requirement, and `await app.register(registerWebhooksDecorator);` itself. `shopifyAuthRoutes` becomes the first registration in the function.

- [ ] **Step 5: Remove the call and the augmentation from `auth.routes.ts`**

Delete line 213-214:

```ts
    // Webhook registration is Task 7; call registerWebhooks(app, q.shop, access_token) here once it exists.
    await app.shopifyRegisterWebhooks?.(q.shop, access_token);
```

Delete the module augmentation at the end of the file (lines 256-260):

```ts
declare module 'fastify' {
  interface FastifyInstance {
    shopifyRegisterWebhooks?: (shop: string, accessToken: string) => Promise<void>;
  }
}
```

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @tryme/api typecheck`
Expected: clean. If it reports `shopifyRegisterWebhooks` still referenced anywhere, that reference was missed — remove it.

- [ ] **Step 7: Run the full Shopify suite**

Run: `pnpm --filter @tryme/api test -- shopify`
Expected: PASS. No existing test covers webhook self-registration, so nothing should need rewriting here. If a test fails referencing `shopifyRegisterWebhooks`, delete that assertion — the behavior it covers has moved to app configuration.

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/modules/shopify/webhook.routes.ts \
        apps/api/src/modules/shopify/routes.ts \
        apps/api/src/modules/shopify/auth.routes.ts \
        apps/shopify-extension/shopify.app.toml \
        apps/shopify-extension/shopify.app.dev.toml
git commit -m "refactor(shopify): declare webhook subscriptions in app config

Removes the last REST Admin API call (POST /webhooks.json) by moving the
four non-GDPR topics into shopify.app.toml beside the compliance webhooks.

This also removes a silent failure class: runtime registration was
per-shop and fire-and-forget behind optional chaining, so a failure left
the install succeeding with no webhooks and nothing to surface it.
Declared subscriptions apply to every install with no call that can fail.

Takes effect on shopify app deploy."
```

---

## Task 8: `catalog-publish.ts` — fold onto the shared helper

**Files:**
- Modify: `apps/api/src/modules/shopify/catalog-publish.ts` (full rewrite, 64 lines)

**Interfaces:**
- Consumes: `shopifyGraphQL`, `toGid`, `assertNoUserErrors`, `GraphQLUserError` (Task 1).
- Produces: `createProductMedia(shopDomain, accessToken, shopifyProductId, imageUrl): Promise<string>` — signature and throwing behavior unchanged.

Already GraphQL, so this is not a compliance fix — it removes the hand-rolled error ladder that duplicates what the helper now owns, which is the drift the shared helper exists to prevent.

- [ ] **Step 1: Replace the file**

```ts
import { AppError } from '../../lib/errors.js';
import { assertNoUserErrors, type GraphQLUserError, shopifyGraphQL, toGid } from './service.js';

interface ProductCreateMediaData {
  productCreateMedia?: {
    media: { id: string }[];
    mediaUserErrors: GraphQLUserError[];
  };
}

const MUTATION = `
  mutation productCreateMedia($productId: ID!, $media: [CreateMediaInput!]!) {
    productCreateMedia(productId: $productId, media: $media) {
      media { id }
      mediaUserErrors { message }
    }
  }
`;

/** Attaches an image (by URL — Shopify fetches it server-side) to a product's
 *  media gallery via the Admin GraphQL API. Throws on any GraphQL-level or
 *  mediaUserErrors failure so the caller can surface a clear error instead of
 *  silently returning no media. */
export async function createProductMedia(
  shopDomain: string,
  accessToken: string,
  shopifyProductId: number,
  imageUrl: string,
): Promise<string> {
  const data = await shopifyGraphQL<ProductCreateMediaData>(
    shopDomain,
    accessToken,
    MUTATION,
    {
      productId: toGid('Product', shopifyProductId),
      media: [{ originalSource: imageUrl, mediaContentType: 'IMAGE' }],
    },
  );

  const result = data.productCreateMedia;
  if (!result) {
    throw new AppError('SHOPIFY', 502, 'productCreateMedia missing from response');
  }
  assertNoUserErrors(result.mediaUserErrors, 'productCreateMedia');

  const media = result.media[0];
  if (!media) {
    throw new AppError('SHOPIFY', 502, 'productCreateMedia returned no media');
  }
  return media.id;
}
```

- [ ] **Step 2: Typecheck and run the catalog tests**

Run: `pnpm --filter @tryme/api typecheck && pnpm --filter @tryme/api test -- shopify-catalog`
Expected: clean typecheck; catalog tests pass.

- [ ] **Step 3: Verify no REST paths remain**

Run:

```bash
grep -rn "\.json" apps/api/src/modules/shopify --include=*.ts \
  | grep -v "\.test\.ts" | grep -v "graphql\.json" | grep -v "\.json()"
```

Expected: only prose in comments. Specifically, `onboarding.routes.ts`'s `/themes.json` reference **must remain** — it is a comment explaining why calling that endpoint would be a trap (it needs `read_themes`, which this app does not request; the resulting 403 becomes `SHOPIFY_REAUTH_REQUIRED` and loops the merchant through OAuth forever). Any hit that is an actual code path is a miss — go back and fix it.

- [ ] **Step 4: Run the full API unit suite**

Run: `pnpm --filter @tryme/api test:unit`
Expected: PASS, 499+ tests. This takes roughly 7 minutes — run it backgrounded rather than letting a tool timeout kill it.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/shopify/catalog-publish.ts
git commit -m "refactor(shopify): route createProductMedia through the shared helper

Already GraphQL, so this is not a compliance fix — it removes a
hand-rolled error ladder that checked the same three failure classes in a
different order from metafields.ts, which is the drift the shared helper
exists to prevent."
```

---

## Manual Verification (after all tasks)

Not automatable — requires the dev store and a Partner Dashboard deploy.

- [ ] `shopify app deploy` from `apps/shopify-extension/`, confirming it does not alter `application_url` (see the warning comment in `shopify.app.toml`).
- [ ] Fresh install on the dev store → OAuth completes → embedded app loads.
- [ ] Partner Dashboard → app → Configuration shows all seven webhook topics (three compliance + four subscriptions).
- [ ] Dashboard → "Sync products now" → product rows appear with correct titles, images, tags, vendor, and collections.
- [ ] Manage → open a product's image picker → live images list loads.
- [ ] Manage → swap a product's garment image → succeeds.
- [ ] Widget Design → save a change → `synced: true` (exercises `metafieldsSet` for `widget_config`).
- [ ] Uninstall the app → confirm `shopify_stores.uninstalled_at` is set (exercises the declared `app/uninstalled` subscription).
- [ ] Reinstall → confirm the widget key metafield is written without error (the reinstall upsert this migration fixes).
- [ ] Read `extensions.cost.requestedQueryCost` from a real products-page response and confirm it is under 1000. Lower `products(first:)` if not.

## Success Criteria

- The REST-detection grep in Task 8 Step 3 returns comments only.
- `pnpm --filter @tryme/api test:unit` passes.
- `pnpm typecheck` clean across the monorepo.
- A full product sync against the dev store produces the same `shopify_product_garments` rows as before the migration.
