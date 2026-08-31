# Merchant tryon history API — design

Date: 2026-08-21
Status: approved for planning

## Purpose

The `virtual_tryon_android` kiosk app has no way for a merchant to see their
own try-on activity over time. This adds a read-only daily-summary endpoint:
for each day, how many distinct customer photos were used as input and how
many result images were generated.

## Scope

- One new API endpoint, one new DB index. No new tables.
- Summary only — per-day counts, no per-job drill-down list (explicitly out
  of scope; a natural follow-up is `GET /v1/merchant/tryon/history/:date` if
  ever needed).
- Merchant-scoped (`requireMerchant` / `req.merchantClientId`), matching every
  other route in `apps/api/src/modules/merchant/tryon.routes.ts`. Not a
  per-device or per-user breakdown — a merchant can run several kiosk
  devices and this aggregates across all of them, same as job creation
  already does (jobs carry `merchant_id`, not a device id).

## Data model (existing, unchanged)

- `jobs` — one row per try-on job. `merchant_id`, `customer_photo_key`,
  `status`, `created_at` are the columns this endpoint reads.
- `job_outputs` — one row per completed job (1:1 via `job_id` primary key),
  so `COUNT(*) FILTER (status = 'COMPLETED')` on `jobs` already equals the
  number of generated result images; no join needed.

### Why input count ≠ generated count

`customer_photo_key` is stored per-job, not deduplicated — a merchant/kiosk
can reuse one uploaded customer photo across several jobs (same customer,
different garments in the same visit). So:

- **`inputCount`** = `COUNT(DISTINCT customer_photo_key)` — distinct photos
  used that day.
- **`generatedCount`** = `COUNT(*) FILTER (status = 'COMPLETED')` — completed
  jobs that day, each producing exactly one unique result image.

`generatedCount` can legitimately exceed `inputCount` (one photo → many
garment try-ons). This is intentional, not a bug — it directly reflects
kiosk usage, and was clarified during design review.

## API

### `GET /v1/merchant/tryon/history`

**Auth:** `preHandler: app.requireMerchant` (same as every route in
`tryon.routes.ts`). 401 if `req.merchantClientId` is missing, matching the
existing routes' `if (!merchantId) throw new AppError('UNAUTH', ...)` guard.

**Query params** (new Zod schema `MerchantTryonHistoryQuery` in
`packages/types/src/widget.ts`, next to the other `MerchantTryon*` schemas):

| Param | Type | Default | Notes |
|---|---|---|---|
| `limit` | int | 30 | max 90, min 1 |
| `before` | `YYYY-MM-DD` string | none | exclusive cursor — returns days strictly before this date |

**Response** (`MerchantTryonHistoryResponse`):

```json
{
  "days": [
    { "date": "2026-08-20", "inputCount": 8, "generatedCount": 12, "failedCount": 1 },
    { "date": "2026-08-19", "inputCount": 5, "generatedCount": 5, "failedCount": 0 }
  ],
  "nextCursor": "2026-08-19"
}
```

- `days` ordered newest first.
- Days with zero jobs are never emitted (no synthetic zero-rows) — the
  client only sees days that had activity.
- `failedCount` = `COUNT(*) FILTER (status = 'FAILED')` — included because
  it's free from the same aggregate query and gives context for why
  `generatedCount` might undercount `inputCount` on a given day (e.g. 3
  photos in, only 1 generated because 2 jobs failed). Mirrors the existing
  `total/completed/failed` shape of `GET /v1/batches/:id`.
- `nextCursor` = the oldest `date` in the current page, or `null` when the
  page is not full (i.e. no more history exists). The client pages with
  `?before=<nextCursor>` until `nextCursor` is `null`.

**Query shape:**

```sql
SELECT
  date_trunc('day', created_at at time zone 'UTC')::date AS day,
  COUNT(DISTINCT customer_photo_key) AS input_count,
  COUNT(*) FILTER (WHERE status = 'COMPLETED') AS generated_count,
  COUNT(*) FILTER (WHERE status = 'FAILED') AS failed_count
FROM jobs
WHERE merchant_id = $1
  AND ($2::date IS NULL OR created_at < $2::date)
GROUP BY day
ORDER BY day DESC
LIMIT $3
```

Day bucketing is UTC calendar day (`jobs.created_at` is `timestamptz`;
merchants have no stored timezone in `schema.merchants`, so UTC is the only
unambiguous default — documented here rather than silently assumed).

### Route placement

Added to `apps/api/src/modules/merchant/tryon.routes.ts` (existing file,
same auth pattern, no new route file needed for one endpoint).

## Index

`packages/db/src/schema/jobs.ts` currently indexes `jobs` only on
`(shopify_store_id, created_at)` and `(batch_id)` — there is **no index on
`merchant_id`** at all. The history query's `WHERE merchant_id = $1 ...
GROUP BY day` will sequential-scan the full `jobs` table as it grows without
one.

New migration adds:

```sql
CREATE INDEX jobs_merchant_created_idx ON jobs (merchant_id, created_at);
```

Added to the `(t) => ({...})` index block in `jobs.ts` alongside
`byShopifyStoreTime` and `byBatch`, named `byMerchant` to match that
naming convention.

## Android

- `ApiService.kt`: one new Retrofit method:
  ```kotlin
  @GET("v1/merchant/tryon/history")
  suspend fun getTryOnHistory(
      @Query("before") before: String? = null,
      @Query("limit") limit: Int = 30
  ): Response<TryOnHistoryResponse>
  ```
- One new response model in `data/models/` (`TryOnHistoryResponse`,
  `TryOnHistoryDay`), following the existing `TryOnModels.kt` style.
- No screen/UI design is implied by this task — API only. A future task can
  wire this into a history screen.

## Error handling

- Missing/invalid merchant auth → existing `requireMerchant` 401, unchanged.
- No history → `{ "days": [], "nextCursor": null }`, 200 (not a 404 — an
  empty history is a valid state, not a missing resource).
- Invalid `before` (not `YYYY-MM-DD`) or `limit` out of range → 400 via Zod
  schema validation, consistent with every other route in this file.

## Testing

- Integration test in `apps/api/test/integration/` (new file,
  `merchant-tryon-history.test.ts`), following the harness in
  `apps/api/test/helpers/`:
  - seeds jobs across multiple days/merchants, some sharing
    `customer_photo_key`, mixed statuses (COMPLETED/FAILED/QUEUED)
  - asserts `inputCount` counts distinct photos, `generatedCount` counts
    completed jobs, and `generatedCount > inputCount` is possible for a
    reused-photo day
  - asserts a second merchant's jobs never leak into the first merchant's
    response (merchant isolation)
  - asserts pagination: `before` cursor returns strictly older days, and
    `nextCursor` is `null` on the last page
  - asserts days with zero jobs are never emitted
