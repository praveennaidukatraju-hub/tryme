# Admin Credit Analysis Page — Design

## Context

Earlier this session, while scoping the Shopify merchant billing-reversal work, the user asked for "credits analysis for each user" and visibility into "how each user is performing" — deferred at the time to a separate plan since it was out of scope for the billing/linking work. This spec is that deferred work: a new admin-web page ranking users by credit spend, with a per-user drill-down, filterable by which product/flow generated the spend.

## Why this doesn't duplicate existing pages

- `DashboardPage.tsx` shows **global** daily jobs/credits trends (one number per day, across all users) — no per-user or per-store breakdown.
- `JobsPage.tsx` shows a flat, unranked list of individual jobs with their `creditsCharged` — no aggregation, no "who spends the most" ranking.

Neither answers "which users/stores are the heaviest credit spenders" or "which of a merchant's products get tried on most" — this page is genuinely new ground.

## What "credit spend" means

Spend is defined as `SUM(jobs.creditsCharged) WHERE status = 'COMPLETED'`, not a scan of `creditLedger` reason strings. Jobs that fail get refunded transactionally already (`terminateJob` in the dispatcher), so a failed job's charge should never count as real spend — using `creditsCharged` on `COMPLETED` jobs directly sidesteps that entirely and matches the intuitive meaning ("credits actually consumed on successful generations"). `creditLedger` is still shown as raw transaction history in the per-user drill-down (grants, deductions, refunds, job charges) for full transparency, but does not drive the ranking number.

## Job-type filter — persisted `jobs.source` column

Nothing in the current schema distinguishes *which flow* created a job at the SQL level. The filter this page needs ("catalog generation" vs "tryon (our app)" vs "Shopify tryon" vs "saree" vs "kiosk") requires a new persisted column: `jobs.source` — nullable `text` (not a native Postgres enum, so adding new sources later — Wix, WooCommerce — is an app-level change only, no migration required).

Values set going forward, one per job-creation call site:

| Source value | Set in | Trigger |
|---|---|---|
| `catalog` | `apps/api/src/modules/jobs/create.ts` → `createJob` | Studio wizard (`POST /v1/jobs/tryon`) |
| `tryon` | `apps/api/src/modules/jobs/create.ts` → `createSimpleTryonJob` | `POST /v1/jobs/simple-tryon` |
| `saree` | `apps/api/src/modules/jobs/createSaree.ts` | Saree job creation |
| `kiosk` | `apps/api/src/modules/kiosk/create-job.ts` | Kiosk job creation |
| `shopify` | `apps/api/src/modules/shopify/customer.routes.ts` | Shopify widget try-on |

`regenerateJob` (`apps/api/src/modules/jobs/regenerate.ts`) needs no change — it delegates back to `createJob`/`createSimpleTryonJob`/`createSareeJob`, so a regenerated job automatically inherits the correct `source` from whichever of those it calls.

`apps/api/src/modules/merchant/create-job.ts` (merchant-widget-catalog jobs) is **not** touched — those jobs keep `source = NULL`. Per explicit direction, this flow doesn't need its own filter bucket right now; NULL-source jobs still count toward "All" totals, they just don't surface under any specific filter option.

### Backfill for existing rows

One-off script (not a schema migration — this is a data backfill), run once after the column is added:

```sql
UPDATE jobs j SET source = CASE
  WHEN j.shopify_store_id IS NOT NULL THEN 'shopify'
  WHEN j.kiosk_device_id IS NOT NULL THEN 'kiosk'
  WHEN EXISTS (
    SELECT 1 FROM job_inputs ji WHERE ji.job_id = j.id AND ji.params->>'kind' = 'saree'
  ) THEN 'saree'
  WHEN EXISTS (
    SELECT 1 FROM job_inputs ji WHERE ji.job_id = j.id AND ji.params->>'personKey' IS NOT NULL
  ) THEN 'tryon'
  ELSE 'catalog'
END
WHERE j.source IS NULL;
```

The `params.kind = 'saree'` and `params.personKey IS NOT NULL` signals are not guesses — they're the exact same checks `regenerateJob` already uses (`isSaree`, `isTryonDirect`) to distinguish these flows, so this backfill logic is proven, not new. Rows matching neither Shopify, kiosk, saree, nor tryon-direct default to `catalog` (the studio wizard, which is by far the majority of historical rows and has no distinguishing marker of its own — it's the fallback case).

## Nav placement

New sidebar item **"Credit Analysis"** under the **Operations** group (next to Jobs/Workers) — read-only analytics fits there better than Content. Same role gate as the Users page: `SUPER_ADMIN`, `SUPPORT`, `ADMIN`.

## Main page — ranked table

- Filters: day-range (7/30/90/all-time — matches `DashboardPage`'s existing `days` selector convention) and job-source (`All`, `Catalog generation`, `Tryon (our app)`, `Saree`, `Kiosk`, `Shopify tryon`).
- Search by name/email (matches `UsersPage` convention).
- Columns: user (name/email, reusing the `hasShopifyStore` badge already added to `UsersPage`), total spent (in the selected window/source), total completed jobs, avg cost/job, last activity, current balance.
- **Sorted server-side by total spent, descending** — not client-column-sortable like `UsersPage`'s table, because ranking must span the full result set, not just the current page. This is a deliberate deviation from the `Th`-click-to-sort pattern elsewhere in admin-web.
- Paginated with the existing `Pager` component.

### Kiosk job attribution

Kiosk jobs (`apps/api/src/modules/kiosk/create-job.ts`) set `jobs.userId = null` — they're billed from a separate `merchantCredits` pool via `jobs.merchantId`, not `userCredits`. Since `merchants.userId` is a real 1:1 link (a merchant *is* a user, per `packages/db/src/schema/merchant.ts`), the ranking query groups by `COALESCE(jobs.userId, merchants.userId)` (via a `LEFT JOIN merchants ON merchants.id = jobs.merchant_id`) so kiosk-operating merchants appear as rows and the "Kiosk" filter returns real data instead of always being empty.

## Per-user detail view

A dedicated view (not the existing Users-page detail — kept separate per this session's earlier decision), showing:

- Header: email/display name, tier, current balance, the Shopify badge if linked.
- Spend-over-time bar chart, daily buckets within the selected window, using the same `recharts`/`BarChart` component `DashboardPage` already uses.
- Recent ledger entries (delta, reason, job ID, date) — last 50 rows, matching the existing `recentJobs.limit(20)` convention in `/admin/users/:id`.
- If the user has a linked, active Shopify store: a "Top products" table scoped to that store — product title, try-on count, credits spent, sourced by joining `jobs` (`shopifyStoreId` = their store's id) → `jobInputs.params->>'shopifyProductId'` → `shopifyProductGarments` (matched on `storeId` + `shopifyProductId`) for the title. Ordered by credits spent, descending.

The day-range and job-source filters from the main page carry into this view (e.g., drilling into a user while filtered to "Shopify tryon" shows only their Shopify-sourced spend/chart/ledger).

## Backend

Two new admin routes, both read-only, using the existing `requireAdmin(['SUPER_ADMIN', 'MODERATOR', 'ADMIN', 'SUPPORT'])`-style guard pattern already used in `apps/api/src/modules/admin/users.routes.ts`:

- `GET /admin/credit-analysis/users?page=&pageSize=&search=&days=&source=` — paginated, ranked list.
- `GET /admin/credit-analysis/users/:id?days=&source=` — detail: user info, daily spend series, recent ledger entries, and (if Shopify-linked) the product breakdown.

## Testing

- API: integration tests (matching the `apps/api/test/integration/` harness pattern) covering: ranking order is correct across multiple users with different spend; day-range and source filters narrow the numbers correctly; a failed-then-refunded job does not count toward spend; the per-user detail endpoint's product breakdown only appears for Shopify-linked users and is scoped to their own store.
- Backfill script: a small test seeding jobs with each of the five distinguishing signals (shopifyStoreId, kioskDeviceId, params.kind=saree, params.personKey, and a plain studio job) and asserting the script assigns the correct `source` to each.
- Frontend: no new automated test harness exists for admin-web (matches this repo's existing state — no page in `apps/admin-web` currently has component tests); verify manually via the dev server.

## Out of scope

- A global "top products across all stores" view (explicitly deferred — per-user drill-down only, per earlier decision in this session).
- Wix/WooCommerce as actual filter options (the `source` column is designed to accept them later with no migration, but no UI/backend work for them happens now).
- Any change to `apps/api/src/modules/merchant/create-job.ts` — those jobs remain `source = NULL`.
