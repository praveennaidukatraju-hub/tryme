# Shopify REST → GraphQL Admin API Migration — Design

**Date:** 2026-08-04
**Status:** Approved for planning
**Driver:** Shopify App Store requirement 2.2.4 — as of 2025-04-01 all new public apps must be built exclusively with the GraphQL Admin API. REST is legacy as of 2024-10-01. This is a hard blocker on App Store distribution, surfaced by the AI self-review run on 2026-08-04.

## Goal

Remove every REST Admin API call from `apps/api/src/modules/shopify/`, replacing each with its GraphQL Admin API equivalent, so the app satisfies App Store requirement 2.2.4.

## Scope

**In scope:** the seven REST call sites in the `shopify` module, the shared `shopifyAdminFetch` wrapper, the two `shopify.app*.toml` files, and the test mocks that assert REST request shapes.

**Out of scope:** the widget/storefront extension, the embedded admin SPA, billing (a separate App Store finding), and any behavior change to what the merchant sees. This migration is a transport swap — the only intentional user-visible changes are the two noted under "Accepted behavior changes".

## Current State

`shopifyAdminFetch(shopDomain, accessToken, path, init, options)` in `service.ts` builds
`https://{shop}/admin/api/2026-07{path}`. It centralizes 401-retry (via `onUnauthorized`) and maps 401/403 to `SHOPIFY_REAUTH_REQUIRED`. Every Shopify call goes through it — including the two that already speak GraphQL by passing `/graphql.json` as the path.

REST call sites:

| # | File | REST endpoint(s) | Purpose |
|---|------|------------------|---------|
| 1 | `auth.routes.ts:163` | `GET /shop.json` (raw `fetch`, not the wrapper) | Shop details at install |
| 2 | `metafields.ts:14` | `POST /metafields.json` | Write `widget_key` metafield |
| 3 | `products.sync.ts:224,243` | `GET /custom_collections.json`, `/smart_collections.json`, `/collects.json` | Collection titles per product |
| 4 | `products.sync.ts:341,372` | `GET /products/{id}.json`, `/products.json` | Product sync (single + full) |
| 5 | `collections.sync.ts:29,52` | `GET /custom_collections/{id}.json`, `/smart_collections/{id}.json`, `/collects.json` | One collection's title + membership |
| 6 | `products.routes.ts:43` | `GET /products/{id}/images.json` | Live product image picker |
| 7 | `webhook.routes.ts:195` | `POST /webhooks.json` | Register 4 non-GDPR webhook topics |

Already GraphQL (to be folded onto the new shared helper, not rewritten):
`metafields.ts:62` (`metafieldsSet`), `catalog-publish.ts:33` (`productCreateMedia`).

**Not a call site, despite appearances:** `onboarding.routes.ts` mentions `GET /themes.json?role=main` in a comment. It makes no API call — `buildThemeEditorDeepLink` is a pure string build, and the comment exists specifically to explain why calling the Admin API there would be a trap (it needs `read_themes`, which this app does not request; the resulting 403 becomes `SHOPIFY_REAUTH_REQUIRED` and loops the merchant through OAuth forever). Leave it alone.

## Architecture

### One shared GraphQL helper

Add `shopifyGraphQL<T>()` to `service.ts`, layered **on top of** `shopifyAdminFetch` rather than beside it. Every GraphQL call inherits the existing 401-refresh-and-retry and `SHOPIFY_REAUTH_REQUIRED` mapping for free; none of that logic is duplicated or reimplemented.

```ts
export async function shopifyGraphQL<T>(
  shopDomain: string,
  accessToken: string,
  query: string,
  variables?: Record<string, unknown>,
  options?: ShopifyAdminFetchOptions,
): Promise<T>
```

Responsibilities, in order:

1. POST `{ query, variables }` to `/graphql.json` through `shopifyAdminFetch`.
2. Non-2xx → `AppError('SHOPIFY', 502, ...)`.
3. Top-level `body.errors` non-empty → `AppError('SHOPIFY', 502, firstMessage)`. A GraphQL endpoint answers 200 on a query it refused; without this check every caller silently reads `undefined`.
4. `extensions.code === 'THROTTLED'` → retry with exponential backoff, up to 3 attempts, before giving up as above.
5. Return `body.data as T`.

`userErrors` stay the caller's business — they are mutation-specific and each callsite reacts differently (log-and-continue for metafields, throw for media). A small `assertNoUserErrors(errors, context)` helper covers the throwing cases.

**Why one helper and not inline fetches:** the alternative is seven hand-rolled GraphQL calls each re-deciding how to treat `errors` vs `userErrors` vs HTTP status. `metafields.ts` and `catalog-publish.ts` already demonstrate the drift — they check the same three failure classes in different orders with different error types. Folding both onto the helper is part of this work.

### ID translation at the boundary

Postgres stores numeric Shopify IDs (`shopify_product_id bigint`, `shopify_collection_id bigint`). GraphQL speaks `gid://shopify/Product/123`. Two utilities in `service.ts` handle the conversion, applied at the call boundary so no numeric-vs-gid ambiguity leaks into the database layer or the route handlers:

```ts
export function toGid(resource: string, id: number | string): string
export function numericIdFromGid(gid: string): number
```

`numericIdFromGid` throws on a malformed gid rather than returning `NaN` — a silently-`NaN` product ID would write a corrupt row.

### Pagination

REST Link-header pagination (`nextPageUrl`, which parses `<url>; rel="next"`) is replaced by GraphQL cursor pagination (`pageInfo.hasNextPage` / `pageInfo.endCursor`) at all three paginating sites. `nextPageUrl` is deleted; it has no other consumer.

### Query cost budget

Shopify's GraphQL calculated-cost model allows 1000 points per single query. A connection costs its `first` value; a nested connection multiplies by its parent. Chosen page sizes:

| Query | Page size | Nested | Approx. cost |
|-------|-----------|--------|--------------|
| Products (sync) | `products(first: 25)` | `collections(first: 25)` | ~650 |
| Collections (title map / search) | `collections(first: 250)` | — | ~250 |
| Collection membership | `products(first: 250)` | — | ~251 |
| Product images | `images(first: 250)` | — | ~250 |

The full-sync loop keeps its existing 500 ms inter-page sleep. That delay is proven and its removal is not required by this migration; the helper's THROTTLED retry is a safety net beneath it, not a replacement.

## Component Changes

### 1. `service.ts`
Add `shopifyGraphQL`, `toGid`, `numericIdFromGid`, `assertNoUserErrors`. `shopifyAdminFetch` itself is unchanged and remains exported — it is now an internal transport for `shopifyGraphQL` rather than a public API surface.

### 2. `auth.routes.ts` — shop details

Replaces the raw `fetch` to `/shop.json` (the one REST call that bypasses the wrapper entirely).

```graphql
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
```

Field mapping into the existing `ShopDetails` interface: `shop.id` → `numericIdFromGid` → `shopifyShopId`; `primaryDomain.host` → `primaryDomain`; `shopOwnerName` → `shopOwner`; `billingAddress.{address1,city,country}` joined as today → `address`; `billingAddress.phone` → `phone`. The interface itself does not change, so `upsertShopifyStore` is untouched.

Also delete the `app.shopifyRegisterWebhooks?.(q.shop, access_token)` call (see §7) and its `declare module 'fastify'` augmentation at the bottom of the file.

### 3. `metafields.ts` — widget_key metafield

`writeWidgetKeyMetafield` moves from `POST /metafields.json` to the same `metafieldsSet` mutation `writeWidgetConfigMetafield` already uses, with `type: 'single_line_text_field'` and `ownerId: toGid('Shop', shopifyShopId)`.

This **fixes a latent bug rather than merely porting it.** The existing code's own comment concedes that REST `POST /metafields.json` returns 422 when a metafield with the same namespace/key already exists, and that it "gets away with REST because it runs exactly once, at install." That premise is false on reinstall: the OAuth callback runs again, the shop's `widget_key` metafield still exists from the previous install, and the write 422s. It fails silently (the function catches and logs), leaving the storefront widget reading a stale key. `metafieldsSet` is a true upsert and is correct on both install and reinstall.

Requires a signature change: `writeWidgetKeyMetafield` gains a `shopifyShopId: number` parameter, available at its one callsite in `auth.routes.ts` as `details.shopifyShopId`.

Both functions then route through `shopifyGraphQL`, collapsing their duplicated `!res.ok` / `body.errors` / `userErrors` ladders.

### 4. `products.sync.ts` — product sync

Full sync:

```graphql
query Products($cursor: String) {
  products(first: 25, after: $cursor) {
    pageInfo { hasNextPage endCursor }
    nodes {
      id
      title
      productType
      tags
      vendor
      featuredImage { url }
      collections(first: 25) { nodes { title } }
    }
  }
}
```

Single-product sync uses the same node selection under `product(id: $id)`.

Three simplifications fall out, none of them optional extras — they are what the GraphQL shape makes redundant:

- **`collects.json` disappears.** `Product.collections` returns titles inline. `fetchProductCollectionTitles` and `fetchCollectionTitleMap` are deleted, along with the one-extra-call-per-product cost the existing code comment flags ("roughly doubles outbound REST calls").
- **Tag splitting disappears.** GraphQL `tags` is already `[String!]!`; the `.split(',').map(trim).filter(Boolean)` dance goes away.
- **The custom/smart collection split disappears.** GraphQL exposes one unified `collections` connection.

`ShopifyProduct`'s internal shape changes (`image.src` → `featuredImage.url`, `product_type` → `productType`, `tags: string` → `tags: string[]`). `syncProduct` keeps its signature and its `upsertGarment` behavior; only the field reads inside it change.

`assertShopifyCdn` still guards the image URL before download — unchanged, and still necessary.

### 5. `collections.sync.ts` — collection title + membership

```graphql
query CollectionMembers($id: ID!, $cursor: String) {
  collection(id: $id) {
    title
    products(first: 250, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { id }
    }
  }
}
```

`collection(id:)` returns `null` for a deleted collection. That maps directly onto `CollectionNotFoundError` and **removes the two-resource 404-probing dance** in `fetchOneCollectionTitle` — the current code queries `custom_collections/{id}.json`, then `smart_collections/{id}.json`, and infers deletion only when both 404, carefully distinguishing that from a 5xx. One nullable field replaces all of it. The existing sequential-not-parallel comment (which exists to keep the two error classes from racing) becomes moot and is deleted with the code it explains.

`CollectionNotFoundError` and its downstream cleanup in `syncOneTask` are unchanged — same class, same semantics, cleaner trigger.

`searchCollections` swaps to a paginated `collections(first: 250, after:)` query and **keeps its existing in-memory substring filter** — a transport-only swap. Shopify's native `query: "title:*needle*"` search was considered and rejected: it tokenizes on word boundaries, so it would silently change which collections a merchant sees in the picker for mid-word queries. Not worth a UX regression inside a compliance migration.

### 6. `products.routes.ts` — live product images

```graphql
query ProductImages($id: ID!) {
  product(id: $id) { images(first: 250) { nodes { id url } } }
}
```

`fetchLiveProductImages` keeps its `{ id: number; src: string }[]` return type — `id` via `numericIdFromGid`, `src` from `url` — so both callers (the `/images` route and the `garmentImageUrl` validation in `PATCH /v1/shopify/products/:id`) are untouched.

### 7. `webhook.routes.ts` + `shopify.app*.toml` — webhook registration

Delete `registerWebhooksDecorator` entirely, along with its `POST /webhooks.json` call, its `app.decorate` and the `shopifyRegisterWebhooks` module augmentation in `auth.routes.ts`. Declare the four non-GDPR topics in both TOML files instead, beside the GDPR block added on 2026-08-04:

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

One block per topic, because each topic targets a distinct handler path. The `shopify.app.dev.toml` copy uses the ngrok host, matching the GDPR block already there.

The HTTP handlers themselves — the `for (const topic of topics)` loop registering seven POST routes, the HMAC verification, all post-processing — are unchanged. Only the self-registration call goes away.

**This removes a whole class of failure.** Runtime registration is per-shop, fire-and-forget, and its callsite uses optional chaining (`app.shopifyRegisterWebhooks?.()`), so a registration failure is invisible: the install succeeds, the webhooks never arrive, and nothing surfaces it. Declared subscriptions apply automatically to every install with no runtime call to fail.

**Deploy dependency:** like the GDPR fix, these take effect only on `shopify app deploy`. Until that deploy runs, deleting the runtime registration would leave *new* installs with no non-GDPR webhooks. The plan must sequence the deploy before or with this change reaching production — this is the one task in the migration with an ordering constraint outside the repo.

### 8. `catalog-publish.ts`
Fold `createProductMedia` onto `shopifyGraphQL` + `assertNoUserErrors`. Behavior identical; ~25 lines of hand-rolled error ladder removed.

## Accepted behavior changes

Two, both deliberate:

1. **Per-product collection titles cap at 25** (was: fully paginated via `collects.json`). `shopifyProductGarments.collections` is **written but never read anywhere in the codebase** — verified by grep across `apps/api/src`. It is currently dead data. A cap on a column nothing reads has no user-visible effect. (Deleting the column outright is the obvious follow-up, but it is unrelated to this migration and is left alone.)

2. **`widget_key` metafield write becomes an upsert**, fixing the silent 422-on-reinstall described in §3.

## Error Handling

Unchanged in shape — every existing error path keeps its type and its HTTP status:

- Transport/auth failures still surface as `SHOPIFY_REAUTH_REQUIRED` via `shopifyAdminFetch`, which `shopifyGraphQL` sits on top of. The SPA's existing reauth redirect keeps working untouched.
- `AppError('SHOPIFY', 502, ...)` remains the failure type for Shopify-side errors.
- `CollectionNotFoundError` keeps its identity and its cleanup semantics.
- `products.sync.ts`'s existing failure recording (`upsertGarmentFailure`, the throw-don't-silently-break on a failed page fetch) is preserved. Both exist because of past silent-failure incidents documented in their comments; the migration must not regress them.

New: THROTTLED retry inside the helper. GraphQL surfaces throttling as a 200 with an `errors` entry rather than REST's 429, so without this a throttled call would read as a hard failure.

## Testing

Seven test files mock REST request shapes and must be rewritten to GraphQL:

| File | What changes |
|------|--------------|
| `test/shopify-sync.test.ts` | Product sync mocks: `products.json` → `products` connection |
| `test/shopify-collections-sync.test.ts` | `custom_collections`/`smart_collections`/`collects` → `collection` query |
| `test/shopify-collections-resync-scheduler.test.ts` | Same collection mocks |
| `test/shopify-products.test.ts` | `images.json` → `product.images` |
| `test/shopify-catalog-generate.test.ts` | `images.json` stub |
| `test/shopify-metafields.test.ts`, `src/modules/shopify/metafields.test.ts` | Asserts `/metafields.json` in the request URL; becomes a `metafieldsSet` mutation assertion |

New unit tests: `toGid` / `numericIdFromGid` round-trip and malformed-gid throw; `shopifyGraphQL` error paths (non-2xx, top-level `errors`, THROTTLED retry then success, THROTTLED exhausted).

The 401-refresh-retry path is already covered against `shopifyAdminFetch` and needs no new test — `shopifyGraphQL` delegates to it rather than reimplementing it.

Every test in the affected files must pass before and after; a mock rewrite that changes what a test asserts about *behavior* (rather than about transport) is a defect, not a migration.

## Risks

**Highest — `products.sync.ts`.** It is the core catalog path, it interacts with token refresh mid-run (`onUnauthorized` reassigning `token` across a long full sync), and its data shape changes most. Its comments record two prior silent-failure incidents. Mitigation: it gets its own task, and the token-refresh interaction must be preserved verbatim — `shopifyGraphQL` accepts and forwards `ShopifyAdminFetchOptions` specifically so `onUnauthorized` keeps working.

**Query cost.** The estimates above are calculated, not measured. Implementation must read `extensions.cost.requestedQueryCost` from a real response and lower the page size if it exceeds 1000. This is a verification step in the plan, not an open question.

**Deploy ordering** on the webhook change, as described in §7.

## Task Decomposition

Eight tasks, each independently testable:

1. `shopifyGraphQL` + `toGid` / `numericIdFromGid` / `assertNoUserErrors` + unit tests
2. `auth.routes.ts` shop details
3. `metafields.ts` — both metafield writes onto the helper
4. `products.sync.ts` — product sync, delete collects/title-map machinery
5. `collections.sync.ts` — title, membership, search
6. `products.routes.ts` — live product images
7. `webhook.routes.ts` deletion + both TOML files
8. `catalog-publish.ts` fold onto helper

Task 1 must land first — every other task depends on the helper. Tasks 2–8 are mutually independent. Task 7 carries the external deploy dependency.

## Success Criteria

- No `shopifyAdminFetch` call in the module passes a path other than `/graphql.json`.
- This returns no REST paths (comments and `res.json()` calls excluded; template-literal paths **are** caught, which a naive `'/…json'` quote-match would miss):

  ```bash
  grep -rn "\.json" apps/api/src/modules/shopify --include=*.ts \
    | grep -v "\.test\.ts" | grep -v "graphql\.json" | grep -v "\.json()"
  ```

  Remaining hits must be prose in comments only — including `onboarding.routes.ts`'s deliberate `/themes.json` reference, which stays.
- `pnpm --filter @tryme/api test:unit` passes (499+ tests).
- `pnpm typecheck` clean.
- A full product sync against the dev store produces the same `shopify_product_garments` rows as before the migration.

## Known Deviation: Deprecated GraphQL Fields

Three fields this migration adopted are deprecated by Shopify — still functional today, with non-deprecated successors already available:

- `Product.featuredImage` (successor: `featuredMedia`) — `apps/api/src/modules/shopify/products.sync.ts`
- `Product.images` (successor: `media`) — `apps/api/src/modules/shopify/products.routes.ts`
- `Shop.billingAddress` (no listed successor field at time of writing; Shopify's own guidance is to source address data via the REST-free `Shop` fields already in use elsewhere) — `apps/api/src/modules/shopify/auth.routes.ts`

This was a deliberate call: this pass was scoped to eliminating REST Admin API usage (App Store requirement 2.2.4), not to eliminating GraphQL field deprecation, and migrating these three was out of scope. Recommendation: migrate to `featuredMedia`/`media` in a follow-up pass.
