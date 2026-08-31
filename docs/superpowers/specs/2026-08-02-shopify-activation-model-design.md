# Shopify Activation Model — Design

## Problem

The current Manage page (`apps/shopify/src/pages/ManagePage.tsx`) exposes exactly one
activation primitive: a per-product `enabled` boolean, toggled one product at a time from a
flat, searchable, status-tabbed list. That list is also un-paginated — it fetches
`pageSize=100` once and never asks for a second page, so any store with more than 100
products silently has products it cannot see or enable at all, filters or not.

For a merchant with a large catalog, enabling Try-On product-by-product doesn't scale, and
there's no way to say "on for everything except these" or "on for this whole collection."

## Goals

- A merchant can turn Try-On on for their entire catalog with one toggle.
- A merchant can enable Try-On per collection, and newly added products that match that
  collection (including smart-collection auto-matches) pick it up automatically, with no
  further action.
- A merchant can still enable individual products one at a time, for stores that don't want
  collection-level granularity.
- A merchant can exclude specific products or specific collections, and exclusion always
  wins — over individual enablement, over collection enablement, and over global mode.
- Sync-status visibility (Active / Processing / Failed) — established as load-bearing in the
  current Manage page, since it's the only way a merchant finds products that silently failed
  to sync — is preserved in the new UI regardless of activation mode, not scoped away by
  which tab a product happens to live in.
- The one real enforcement point, `customer.routes.ts:325`, is updated to respect the new
  model; a product that is "effectively enabled" under any rule above must be usable for an
  actual try-on, and one that isn't must be refused, exactly as `!garment.enabled` refuses
  today.

## Non-Goals

- No per-product / per-variant AI reference image overrides (front/back/default/variant
  images). This was in the original brainstorm but has no backend logic behind it today and
  is explicitly dropped from this spec's scope. It would be a separate spec if picked up later.
- No new Shopify OAuth scopes. Collections are covered by the already-granted `read_products`
  scope (Shopify's `collections.json` / `collects.json` resources live under it).
- No attempt to make collection membership tracking realtime via webhook. Shopify does not
  reliably fire a webhook for smart-collection auto-add, so this spec uses bounded polling
  instead (see Section 2) — that is a deliberate trade-off, not an oversight.

## Data Model

Reuses the existing `settings` jsonb convention already used for `shopify_stores.settings.widget`:

```ts
// shopify_stores.settings.activation
{ mode: 'global' | 'selective' }
```

Defaults to `'selective'` — this is what every existing store is on today, so shipping this
column changes nothing for anyone until a merchant flips it.

New tables (`packages/db/src/schema/shopify.ts`):

- **`shopify_collections`** — `storeId`, `shopifyCollectionId` (bigint), `title`, `syncedAt`.
  Cached collection metadata; only populated for collections a merchant has actually selected
  (enabled or excluded), never eagerly for the whole store.
- **`shopify_collection_products`** — junction: `storeId`, `shopifyCollectionId`,
  `shopifyProductId`. Rebuilt per collection on sync (delete + reinsert for that one
  collection ID — membership sets are small enough that a diff isn't worth the complexity).
- **`shopify_enabled_collections`** — `storeId`, `shopifyCollectionId`. The Collections tab's
  picks.
- **`shopify_excluded_collections`** — `storeId`, `shopifyCollectionId`. Exclusion tab,
  collections sub-section.

Changes to `shopifyProductGarments`:

- `enabled` (existing column) — meaning unchanged: "individually enabled," now read through
  the resolver instead of directly. This is what backs the Individual Products tab.
- `excluded: boolean not null default false` (new) — Exclusion tab, products sub-section.

## Effective Enablement (Resolver)

Computed on every read, never materialized as a stored column — the underlying signals
(mode, individual flags, collection membership) change independently and a materialized
column would need invalidation logic that's just the resolver again, one layer removed.

```
function isEffectivelyEnabled(store, product):
  if product.excluded: return false
  if product.shopifyProductId in store.excludedCollectionProductIds: return false
  if store.activation.mode === 'global': return true
  if product.enabled: return true
  if product.shopifyProductId in store.enabledCollectionProductIds: return true
  return false
```

Exclusion is checked first in every branch, including the `global` branch — this is the
"exclusion always wins" rule confirmed during brainstorming, and it must never regress: a
product excluded while global mode is on stays excluded.

This does not replace the existing sync-status gate. A product must still have
`status === 'active'` (successfully synced) to actually be usable for a try-on — effective
enablement answers "does the merchant want this on," sync status answers "is it ready."
Both must hold. This mirrors the current invariant in `products.routes.ts:121-123` (you
cannot enable a product that isn't `active`).

Lives in a single new module, `apps/api/src/modules/shopify/activation.ts`, so there is
exactly one place in the codebase that encodes the precedence rule. Every consumer —
the enforcement point, every list endpoint, every summary count — calls into it rather than
re-deriving it.

## Collection Sync Mechanism

**Picking:** both "Add products" and "Add collections" use Shopify's native App Bridge
resource picker — a live query against Shopify's own data, so nothing needs to be pre-synced
into our DB just to populate a picker list.

**On selection:** when a merchant picks a collection (either side — enable or exclude), that
collection ID is upserted into `shopify_collections` and its full membership pulled via
`collects.json?collection_id=X`, written into `shopify_collection_products` for that
collection only, in one transaction. If the pull fails, nothing is partially committed — the
add action fails outright and the merchant can retry; a collection is never shown as "added"
with incomplete or wrong membership.

**Staying current:** a scheduled resync job (same pattern as the existing retention sweep —
a periodic worker pass) re-pulls membership only for collection IDs currently present in
`shopify_enabled_collections` or `shopify_excluded_collections`. This is bounded regardless of
total catalog size or total collection count, since an unselected collection's membership is
never queried at all. Cadence: hourly.

Rationale for polling over webhooks: Shopify does not reliably fire a webhook when a product
is auto-added to a smart collection by rule match, so there is no realtime signal to hook
into. Polling only the collections a merchant actually cares about keeps the cost bounded
without needing one.

**Removal:** when a merchant removes a collection from the enabled or excluded list, its
`shopify_collection_products` rows are deleted at the same time, not left to expire on the
next sweep.

## API

All routes under the existing `requireShopifyStoreKey` auth, in a new
`apps/api/src/modules/shopify/activation.routes.ts`:

| Route | Purpose |
|---|---|
| `GET /v1/shopify/activation` | mode + summary counts (enabled collections, individually enabled products, excluded products, excluded collections, failed-to-sync) |
| `GET /v1/shopify/activation/failed?page=&pageSize=` | catalog-wide failed-sync list (Failed to Sync card), independent of activation source, paginated |
| `PATCH /v1/shopify/activation/mode` | `{ mode: 'global' \| 'selective' }` |
| `GET /v1/shopify/activation/products?enabled=true&page=&pageSize=&q=` | Individual Products tab, **paginated from day one** — the current Manage page's un-paginated `pageSize=100` fetch is not repeated here |
| `POST /v1/shopify/activation/products` | `{ shopifyProductIds: number[] }` — add to individually-enabled |
| `DELETE /v1/shopify/activation/products/:shopifyProductId` | remove (the "Remove" button) |
| `GET /v1/shopify/activation/collections` | enabled-collections list (collection counts are small; no pagination needed) |
| `POST /v1/shopify/activation/collections` | `{ shopifyCollectionIds: number[] }` — add + synchronously syncs that collection's membership before responding |
| `DELETE /v1/shopify/activation/collections/:shopifyCollectionId` | remove |
| `GET/POST/DELETE /v1/shopify/activation/exclusions/products[...]` | same shape, products sub-section of Exclusion tab |
| `GET/POST/DELETE /v1/shopify/activation/exclusions/collections[...]` | same shape, collections sub-section of Exclusion tab |

`customer.routes.ts:325`'s `if (!garment.enabled)` is replaced with a call into the resolver.

## Manage Page (full replace)

Full replace of the current Manage page — no coexistence with the old flat list.

- **Header** — global toggle, "Enable Try-On on all products (except exclusions)", always
  live regardless of mode (exclusion still applies when global is on).
- **Summary cards** (5, always visible) — Enabled Collections, Individually Enabled Products,
  Excluded Products, Excluded Collections, and **Failed to Sync**. The first four are direct
  count queries against their backing tables, not a per-product resolver run. Failed to Sync
  is a plain `COUNT(*) WHERE status = 'failed'` over the whole catalog — deliberately
  independent of activation source, since a product enabled via a collection or via global
  mode never appears in the Individual Products tab's `enabled=true`-filtered list, and would
  otherwise have no status visibility at all while broken. Clicking it opens a read-only list
  (thumbnail, name, `failedReason`) with no Add/Remove actions.
- **Tab strip**:
  - **Collections** — enabled collections: title, product count, Remove. "Add collections"
    opens the Shopify collection picker.
  - **Individual Products** — thumbnail, name, sync-status badge (Active / Processing /
    Failed, scoped to this tab's own product set), search box, Remove. "Add products" opens
    the Shopify product picker.
  - **Exclusion** — two sub-sections, Products and Collections, each with its own
    Exclude-products / Exclude-collections button and list.
- When global mode is **on**, the Collections and Individual Products tabs stay
  **read-only**, not hidden: their lists (including sync-status badges) remain visible so a
  merchant can still find failed/processing products while global mode is active — only the
  Add/Remove actions and the collection/product pickers are disabled. Data is untouched, so
  turning global back off restores exactly what was there before. The Exclusion tab stays
  fully live and editable in both modes.

## Failure Modes

- Collection membership sync fails mid-pull on add — the whole `POST .../collections` call
  fails, nothing partially committed, merchant retries. Never show a collection as added with
  incomplete membership.
- Scheduled resync fails for one collection (rate limit, deleted collection) — logged,
  skipped, retried next cycle; one bad collection ID must not abort the sweep for the rest.
  A collection confirmed deleted on Shopify's side (404) has its row and junction rows
  removed.
- A product can simultaneously be individually enabled and excluded (merchant enabled it,
  later excluded it without clearing the individual flag) — allowed and expected; the
  resolver's exclusion-first check makes this inert without the UI needing to enforce mutual
  exclusivity between tabs.
- Global mode on with no products yet synced/active — toggle still flips, summary cards
  reflect real state; the existing `status === 'active'` sync gate still blocks try-on for
  anything not yet synced, unchanged from today.

## Testing

- Resolver unit tests: table-driven matrix over every combination of
  global on/off × individually enabled/not × in enabled collection/not ×
  individually excluded/not × in excluded collection/not. Every exclusion-present case is its
  own row — this is the one rule (exclusion always wins) that must never regress, including
  "excluded while global is on."
- Integration tests per endpoint: mode toggle; add/remove individual product; add/remove
  collection (Shopify `collects.json` fetch stubbed via `vi.stubGlobal('fetch', …)`, matching
  the existing pattern in this module); same four shapes for exclusions.
- `customer.routes.ts` regression: existing enabled-gate tests updated to route through the
  resolver; new cases for collection-based enablement and for exclusion overriding global
  mode.
- Scheduled resync job: only touches collection IDs present in the enabled/excluded
  collections tables; zero selected collections means zero Shopify calls; one collection's
  fetch failure doesn't abort the sweep for others; a 404'd collection gets cleaned up.
- No test for the App Bridge picker component itself (Shopify-hosted UI, same reasoning as
  the theme extension having no test runner) — only the API glue it calls into is tested.
- `GET /v1/shopify/activation/failed`: returns products with `status = 'failed'` regardless
  of `enabled`, individual-collection membership, or global mode — a case explicitly covers a
  failed product that is enabled only via global mode (never touches the `enabled` column),
  to guard the exact gap this section was written to close.

## Sequencing

1. Schema — `packages/db/src/schema/shopify.ts`: four new tables, `excluded` column,
   migration.
2. `apps/api/src/modules/shopify/activation.ts` — resolver + unit tests.
3. `apps/api/src/modules/shopify/collections.sync.ts` — `collects.json` pull, upsert,
   scheduled resync worker.
4. `apps/api/src/modules/shopify/activation.routes.ts` — all endpoints above, wired into
   `routes.ts`.
5. `customer.routes.ts:325` — swap to resolver call.
6. `apps/shopify/src/pages/ManagePage.tsx` — full rebuild per the layout above.
7. `docs/progress.md` entry.

## Files Touched

- `packages/db/src/schema/shopify.ts` (+ generated migration)
- `apps/api/src/modules/shopify/activation.ts` (new)
- `apps/api/src/modules/shopify/collections.sync.ts` (new)
- `apps/api/src/modules/shopify/activation.routes.ts` (new)
- `apps/api/src/modules/shopify/customer.routes.ts`
- `apps/api/src/modules/shopify/routes.ts` (wiring)
- `apps/shopify/src/pages/ManagePage.tsx` (full rebuild)
- `docs/progress.md`
