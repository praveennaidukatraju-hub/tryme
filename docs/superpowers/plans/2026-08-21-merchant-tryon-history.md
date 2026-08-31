# Merchant Tryon History API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a merchant-scoped `GET /v1/merchant/tryon/history` endpoint returning a paginated, per-day summary of distinct input photos vs. generated (completed) result images, plus the Android Retrofit client to call it.

**Architecture:** One new read-only Fastify route in the existing `apps/api/src/modules/merchant/tryon.routes.ts` file, backed by a single grouped SQL aggregate over the existing `jobs` table (no new tables). A new composite index on `jobs(merchant_id, created_at)` keeps that query cheap. Request/response shapes are shared Zod schemas in `packages/types`. The Android kiosk app gets a matching Retrofit method, response model, and repository wrapper, following the exact patterns already used for every other endpoint in that app.

**Tech Stack:** Fastify 5 + `fastify-type-provider-zod`, Drizzle ORM (raw `sql` aggregates), PostgreSQL 16, Vitest integration tests (docker-compose Postgres, no testcontainers), Kotlin + Retrofit + Gson (`virtual_tryon_android`).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-21-merchant-tryon-history-design.md` — read it before starting; this plan implements it verbatim.
- Day bucketing is **UTC calendar day** (`jobs.created_at` is `timestamptz`; merchants have no stored timezone in `schema.merchants`).
- `inputCount` = `COUNT(DISTINCT customer_photo_key)` per day. `generatedCount` = `COUNT(*) FILTER (status = 'COMPLETED')` per day. These are allowed to diverge (one photo, many garment try-ons) — this is intentional, not a bug.
- Days with zero jobs are never emitted in the response.
- No schema/data changes against production (per root `CLAUDE.md`) — all DB work here targets the local dev database only.
- Follow the existing file's auth pattern exactly: `preHandler: app.requireMerchant`, then `if (!req.merchantClientId) throw new AppError('UNAUTH', 401, 'missing merchant')`.

---

### Task 1: Add the missing `jobs(merchant_id, created_at)` index

**Files:**
- Modify: `packages/db/src/schema/jobs.ts:75-80` (the `(t) => ({...})` index block)
- Generate (via `pnpm db:generate`, do not hand-write): a new `packages/db/src/migrations/017X_<auto-name>.sql`, its matching `meta/017X_snapshot.json`, and an updated `meta/_journal.json`

**Interfaces:**
- Consumes: nothing (schema-only change)
- Produces: DB index `jobs_merchant_created_idx` on `jobs(merchant_id, created_at)`, which Task 2's query relies on for performance (not correctness — the query is correct without it, just slow at scale)

- [ ] **Step 1: Add the index to the schema**

In `packages/db/src/schema/jobs.ts`, the index block currently reads:

```ts
  (t) => ({
    // Every Shopify analytics query filters on exactly this pair. Without it
    // each one degrades to a sequential scan of every job in the system.
    byShopifyStoreTime: index('jobs_shopify_store_created_idx').on(t.shopifyStoreId, t.createdAt),
    byBatch: index('jobs_batch_idx').on(t.batchId),
  }),
```

Change it to:

```ts
  (t) => ({
    // Every Shopify analytics query filters on exactly this pair. Without it
    // each one degrades to a sequential scan of every job in the system.
    byShopifyStoreTime: index('jobs_shopify_store_created_idx').on(t.shopifyStoreId, t.createdAt),
    byBatch: index('jobs_batch_idx').on(t.batchId),
    // GET /v1/merchant/tryon/history groups by (merchant_id, day) — without
    // this, that query sequential-scans the whole jobs table as it grows.
    byMerchant: index('jobs_merchant_created_idx').on(t.merchantId, t.createdAt),
  }),
```

- [ ] **Step 2: Generate the migration**

Run from the repo root:

```bash
pnpm db:generate
```

Expected: drizzle-kit prints something like `packages/db/src/migrations/0170_<random-name>.sql` created, plus a matching `meta/0170_snapshot.json` and an updated `meta/_journal.json`. It should **not** prompt you to resolve a rename/ambiguity — this is a pure addition. If it does prompt, something else changed in the schema since the last migration; stop and investigate before continuing.

- [ ] **Step 3: Verify the generated SQL is exactly the index**

Read the new `packages/db/src/migrations/017X_*.sql` file it created. Expected content (column order may render slightly differently but must be an index on `merchant_id, created_at`):

```sql
CREATE INDEX "jobs_merchant_created_idx" ON "jobs" USING btree ("merchant_id","created_at");
```

If it contains anything else (a dropped/altered column, a different table), stop — do not apply it. That would mean the schema diff picked up unrelated drift.

- [ ] **Step 4: Apply the migration to the local dev database**

```bash
pnpm db:migrate
```

Expected output ends with `Applied  0170_<random-name>` and `Done: 1 applied, 0 reconciled.`

- [ ] **Step 5: Verify the index exists in Postgres**

```bash
docker exec $(docker ps --filter "publish=5432" -q) psql -U tryon -d tryon_dev -c "\d jobs" | grep jobs_merchant_created_idx
```

Expected: one line showing `jobs_merchant_created_idx` on `(merchant_id, created_at)`.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema/jobs.ts packages/db/src/migrations/
git commit -m "$(cat <<'EOF'
feat(db): add jobs(merchant_id, created_at) index

Backs the new merchant tryon history endpoint's per-day aggregate
query. jobs had no merchant_id index at all before this.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: `GET /v1/merchant/tryon/history` endpoint

**Files:**
- Modify: `packages/types/src/widget.ts` (add three new Zod schemas after the existing `MerchantTryonJobDetailResponse` block, i.e. after line 329 in the current file)
- Modify: `apps/api/src/modules/merchant/tryon.routes.ts` (extend the top import lines, add one new route at the end of `merchantTryonRoutes`)
- Create: `apps/api/test/integration/merchant-tryon-history.test.ts`

**Interfaces:**
- Consumes: `app.db`, `schema.jobs` (from `@tryme/db`), `app.requireMerchant` / `req.merchantClientId` (from `apps/api/src/plugins/portal-auth.ts`), `AppError` (from `apps/api/src/lib/errors.js`) — all already imported/available in `tryon.routes.ts`
- Produces: `MerchantTryonHistoryQuery`, `MerchantTryonHistoryDay`, `MerchantTryonHistoryResponse` (exported from `@tryme/types`) — Task 3 (Android) mirrors this response shape by hand in Kotlin, so keep the JSON field names (`date`, `inputCount`, `generatedCount`, `failedCount`, `days`, `nextCursor`) exact.

- [ ] **Step 1: Write the failing integration test**

Create `apps/api/test/integration/merchant-tryon-history.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signAccess } from '../../src/modules/auth/service';
import { buildTestApp, type TestApp } from '../helpers/api';
import { type Containers, startContainers } from '../helpers/containers';

const JWT_SECRET = 'test-jwt-secret-0123456789abcdef-32min';
const secret = new TextEncoder().encode(JWT_SECRET);

async function createMerchant(app: TestApp, email: string) {
  const [merchantUser] = await app.db
    .insert(schema.users)
    .values({ email, passwordHash: 'unused' })
    .returning();
  const [merchant] = await app.db
    .insert(schema.merchants)
    .values({
      companyName: 'Merchant Co',
      contactName: 'Merchant Owner',
      phone: '9999999999',
      businessAddress: 'Test Street',
      isActive: true,
      userId: merchantUser.id,
    })
    .returning();
  return { merchant, merchantUser };
}

async function authHeader(userId: string) {
  const token = await signAccess(secret, userId, { kind: 'access' }, '15m');
  return { authorization: `Bearer ${token}` };
}

async function seedJob(
  app: TestApp,
  opts: {
    merchantId: string;
    userId: string;
    customerPhotoKey: string;
    status: string;
    createdAt: string;
  },
) {
  await app.db.insert(schema.jobs).values({
    merchantId: opts.merchantId,
    userId: opts.userId,
    customerPhotoKey: opts.customerPhotoKey,
    status: opts.status,
    createdAt: new Date(opts.createdAt),
  });
}

describe('merchant try-on history', () => {
  let c: Containers;
  let app: TestApp;

  beforeAll(async () => {
    c = await startContainers();
    app = await buildTestApp(c);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await c?.stop();
  });

  it('counts distinct input photos separately from completed (generated) jobs, and omits empty days', async () => {
    const { merchant, merchantUser } = await createMerchant(app, 'history-a@example.com');
    const auth = await authHeader(merchantUser.id);

    // 2026-08-19: two jobs reuse the same photo (P1), both completed; one job
    // uses a different photo (P2) and fails. inputCount=2 (P1,P2), generatedCount=2, failedCount=1.
    await seedJob(app, {
      merchantId: merchant.id,
      userId: merchantUser.id,
      customerPhotoKey: 'merchant-inputs/p1.jpg',
      status: 'COMPLETED',
      createdAt: '2026-08-19T09:00:00.000Z',
    });
    await seedJob(app, {
      merchantId: merchant.id,
      userId: merchantUser.id,
      customerPhotoKey: 'merchant-inputs/p1.jpg',
      status: 'COMPLETED',
      createdAt: '2026-08-19T10:00:00.000Z',
    });
    await seedJob(app, {
      merchantId: merchant.id,
      userId: merchantUser.id,
      customerPhotoKey: 'merchant-inputs/p2.jpg',
      status: 'FAILED',
      createdAt: '2026-08-19T11:00:00.000Z',
    });

    // 2026-08-20: one queued job, not yet completed or failed.
    await seedJob(app, {
      merchantId: merchant.id,
      userId: merchantUser.id,
      customerPhotoKey: 'merchant-inputs/p3.jpg',
      status: 'QUEUED',
      createdAt: '2026-08-20T08:00:00.000Z',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/merchant/tryon/history',
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      days: Array<{ date: string; inputCount: number; generatedCount: number; failedCount: number }>;
      nextCursor: string | null;
    };

    expect(body.days).toEqual([
      { date: '2026-08-20', inputCount: 1, generatedCount: 0, failedCount: 0 },
      { date: '2026-08-19', inputCount: 2, generatedCount: 2, failedCount: 1 },
    ]);
    expect(body.nextCursor).toBeNull();
  });

  it('never leaks another merchant\'s jobs into the response', async () => {
    const { merchant, merchantUser } = await createMerchant(app, 'history-b@example.com');
    const { merchant: otherMerchant, merchantUser: otherUser } = await createMerchant(
      app,
      'history-c@example.com',
    );
    const auth = await authHeader(merchantUser.id);

    await seedJob(app, {
      merchantId: merchant.id,
      userId: merchantUser.id,
      customerPhotoKey: 'merchant-inputs/mine.jpg',
      status: 'COMPLETED',
      createdAt: '2026-08-18T09:00:00.000Z',
    });
    await seedJob(app, {
      merchantId: otherMerchant.id,
      userId: otherUser.id,
      customerPhotoKey: 'merchant-inputs/theirs.jpg',
      status: 'COMPLETED',
      createdAt: '2026-08-18T09:00:00.000Z',
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/merchant/tryon/history',
      headers: auth,
    });
    const body = res.json() as {
      days: Array<{ date: string; inputCount: number; generatedCount: number; failedCount: number }>;
    };
    // Only this merchant's one distinct photo — the other merchant's job must not add to the count.
    expect(body.days).toEqual([{ date: '2026-08-18', inputCount: 1, generatedCount: 1, failedCount: 0 }]);
  });

  it('paginates with the before cursor, oldest page has nextCursor null', async () => {
    const { merchant, merchantUser } = await createMerchant(app, 'history-d@example.com');
    const auth = await authHeader(merchantUser.id);

    for (const date of ['2026-08-01', '2026-08-02', '2026-08-03']) {
      await seedJob(app, {
        merchantId: merchant.id,
        userId: merchantUser.id,
        customerPhotoKey: `merchant-inputs/${date}.jpg`,
        status: 'COMPLETED',
        createdAt: `${date}T09:00:00.000Z`,
      });
    }

    const page1 = await app.inject({
      method: 'GET',
      url: '/v1/merchant/tryon/history?limit=2',
      headers: auth,
    });
    const body1 = page1.json() as { days: Array<{ date: string }>; nextCursor: string | null };
    expect(body1.days.map((d) => d.date)).toEqual(['2026-08-03', '2026-08-02']);
    expect(body1.nextCursor).toBe('2026-08-02');

    const page2 = await app.inject({
      method: 'GET',
      url: `/v1/merchant/tryon/history?limit=2&before=${body1.nextCursor}`,
      headers: auth,
    });
    const body2 = page2.json() as { days: Array<{ date: string }>; nextCursor: string | null };
    expect(body2.days.map((d) => d.date)).toEqual(['2026-08-01']);
    expect(body2.nextCursor).toBeNull();
  });

  it('returns an empty history for a merchant with no jobs, and rejects an out-of-range limit and a malformed before cursor with 400', async () => {
    const { merchantUser } = await createMerchant(app, 'history-e@example.com');
    const auth = await authHeader(merchantUser.id);

    const empty = await app.inject({
      method: 'GET',
      url: '/v1/merchant/tryon/history',
      headers: auth,
    });
    expect(empty.statusCode).toBe(200);
    expect(empty.json()).toEqual({ days: [], nextCursor: null });

    const badLimit = await app.inject({
      method: 'GET',
      url: '/v1/merchant/tryon/history?limit=200',
      headers: auth,
    });
    expect(badLimit.statusCode).toBe(400);

    const badBefore = await app.inject({
      method: 'GET',
      url: '/v1/merchant/tryon/history?before=not-a-date',
      headers: auth,
    });
    expect(badBefore.statusCode).toBe(400);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

From `apps/api`:

```bash
npx vitest run --config vitest.integration.config.ts merchant-tryon-history
```

Expected: FAIL — every `app.inject` call returns 404 (route doesn't exist yet), since `pnpm docker:up` must already be running (it should be, from earlier in this session).

- [ ] **Step 3: Add the Zod schemas**

In `packages/types/src/widget.ts`, immediately after the existing block:

```ts
export type MerchantTryonJobDetailResponse = z.infer<typeof MerchantTryonJobDetailResponse>;
```

(currently line 329) add:

```ts

export const MerchantTryonHistoryQuery = z.object({
  before: z.string().date().optional(),
  limit: z.coerce.number().int().min(1).max(90).default(30),
});
export type MerchantTryonHistoryQuery = z.infer<typeof MerchantTryonHistoryQuery>;

export const MerchantTryonHistoryDay = z.object({
  date: z.string(),
  inputCount: z.number().int(),
  generatedCount: z.number().int(),
  failedCount: z.number().int(),
});
export type MerchantTryonHistoryDay = z.infer<typeof MerchantTryonHistoryDay>;

export const MerchantTryonHistoryResponse = z.object({
  days: z.array(MerchantTryonHistoryDay),
  nextCursor: z.string().nullable(),
});
export type MerchantTryonHistoryResponse = z.infer<typeof MerchantTryonHistoryResponse>;
```

Then rebuild the package (the API resolves workspace packages via their built `dist/`, not source):

```bash
pnpm --filter @tryme/types build
```

- [ ] **Step 4: Add the route**

In `apps/api/src/modules/merchant/tryon.routes.ts`:

Change the import line:

```ts
import { MerchantTryonJobCreateBody, MerchantTryonPresignBody } from '@tryme/types';
```

to:

```ts
import {
  MerchantTryonHistoryQuery,
  MerchantTryonJobCreateBody,
  MerchantTryonPresignBody,
} from '@tryme/types';
```

Change the drizzle-orm import line:

```ts
import { and, eq } from 'drizzle-orm';
```

to:

```ts
import { and, desc, eq, lt, sql } from 'drizzle-orm';
```

Then, immediately before the closing `}` of `merchantTryonRoutes` (i.e. right after the `/v1/merchant/tryon/jobs/:id` DELETE handler's closing `);` and before the function's final `}`), add:

```ts

  app.get(
    '/v1/merchant/tryon/history',
    {
      preHandler: app.requireMerchant,
      schema: { querystring: MerchantTryonHistoryQuery },
    },
    async (req) => {
      const merchantId = req.merchantClientId;
      if (!merchantId) throw new AppError('UNAUTH', 401, 'missing merchant');

      const { before, limit } = req.query as z.infer<typeof MerchantTryonHistoryQuery>;

      // customer_photo_key is stored per-job, not deduplicated — a merchant can
      // reuse one uploaded photo across several jobs (same customer, different
      // garments), so job count and distinct-photo count are different things.
      // See docs/superpowers/specs/2026-08-21-merchant-tryon-history-design.md.
      const dayBucket = sql`(date_trunc('day', ${schema.jobs.createdAt} at time zone 'UTC'))::date::text`;

      const conditions = [eq(schema.jobs.merchantId, merchantId)];
      if (before) {
        conditions.push(lt(schema.jobs.createdAt, new Date(`${before}T00:00:00.000Z`)));
      }

      const rows = await app.db
        .select({
          day: dayBucket.as('day'),
          inputCount: sql<number>`COUNT(DISTINCT ${schema.jobs.customerPhotoKey})`.as('inputCount'),
          generatedCount: sql<number>`COUNT(*) FILTER (WHERE ${schema.jobs.status} = 'COMPLETED')`.as(
            'generatedCount',
          ),
          failedCount: sql<number>`COUNT(*) FILTER (WHERE ${schema.jobs.status} = 'FAILED')`.as(
            'failedCount',
          ),
        })
        .from(schema.jobs)
        .where(and(...conditions))
        .groupBy(dayBucket)
        .orderBy(desc(dayBucket))
        .limit(limit);

      // Raw sql`` aggregates come back from the driver as strings regardless of
      // the sql<number> annotations — those generics are TypeScript-only (same
      // caveat as GET /v1/batches/:id above). day is cast to ::text in SQL so
      // it arrives as a plain 'YYYY-MM-DD' string, no Date round-trip needed.
      const days = rows.map((r) => ({
        date: r.day,
        inputCount: Number(r.inputCount),
        generatedCount: Number(r.generatedCount),
        failedCount: Number(r.failedCount),
      }));

      const nextCursor = days.length === limit ? days[days.length - 1].date : null;

      return { days, nextCursor };
    },
  );
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
npx vitest run --config vitest.integration.config.ts merchant-tryon-history
```

Expected: PASS, all 4 tests green.

- [ ] **Step 6: Run the full API unit + integration suites to check for regressions**

```bash
pnpm --filter @tryme/api test
npx vitest run --config vitest.integration.config.ts
```

Expected: both PASS (the second command runs the whole integration suite, not just this file — confirms the shared `tryon.routes.ts` import changes didn't break the existing `merchant-tryon.test.ts` / `merchant-tryon-results.test.ts` suites).

- [ ] **Step 7: Typecheck**

```bash
pnpm --filter @tryme/api typecheck
pnpm --filter @tryme/types typecheck
```

Expected: both PASS with no errors.

- [ ] **Step 8: Commit**

```bash
git add packages/types/src/widget.ts apps/api/src/modules/merchant/tryon.routes.ts apps/api/test/integration/merchant-tryon-history.test.ts
git commit -m "$(cat <<'EOF'
feat(api): add GET /v1/merchant/tryon/history

Per-day summary of distinct input photos vs completed (generated)
jobs for the calling merchant, paginated by an exclusive date cursor.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Android client (Retrofit method + response model + repository)

**Files:**
- Create: `apps/virtual_tryon_android/app/src/main/java/tryme/nice/interactive/data/models/TryOnHistoryModels.kt`
- Modify: `apps/virtual_tryon_android/app/src/main/java/tryme/nice/interactive/api/ApiService.kt`
- Create: `apps/virtual_tryon_android/app/src/main/java/tryme/nice/interactive/data/repository/TryOnHistoryRepository.kt`

**Interfaces:**
- Consumes: `ApiClient.apiService` (existing authenticated Retrofit client, `apps/virtual_tryon_android/app/src/main/java/tryme/nice/interactive/api/ApiClient.kt`) — same bearer-token client every other repository in this app uses
- Produces: `TryOnHistoryRepository.getHistory(before: String?, limit: Int): TryOnHistoryResult<TryOnHistoryResponse>` — for a future screen to call; no screen is built in this task (API only, per the approved design)

- [ ] **Step 1: Add the response models**

Create `apps/virtual_tryon_android/app/src/main/java/tryme/nice/interactive/data/models/TryOnHistoryModels.kt`:

```kotlin
package tryme.nice.interactive.data.models

import com.google.gson.annotations.SerializedName

data class TryOnHistoryDay(
    @SerializedName("date") val date: String,
    @SerializedName("inputCount") val inputCount: Int,
    @SerializedName("generatedCount") val generatedCount: Int,
    @SerializedName("failedCount") val failedCount: Int
)

data class TryOnHistoryResponse(
    @SerializedName("days") val days: List<TryOnHistoryDay>,
    @SerializedName("nextCursor") val nextCursor: String?
)
```

- [ ] **Step 2: Add the Retrofit method**

In `apps/virtual_tryon_android/app/src/main/java/tryme/nice/interactive/api/ApiService.kt`, add this import alongside the other `data.models` imports at the top:

```kotlin
import tryme.nice.interactive.data.models.TryOnHistoryResponse
```

Then add this method inside the `ApiService` interface, right after `getCatalogAppDeviceCode()` (the last method, just before the interface's closing `}`):

```kotlin

    /**
     * Per-day summary of distinct input photos vs completed (generated) jobs
     * for this merchant. Paginated newest-first; pass `before` (the previous
     * response's nextCursor) to fetch older days. nextCursor is null on the
     * last page.
     */
    @GET("v1/merchant/tryon/history")
    suspend fun getTryOnHistory(
        @Query("before") before: String? = null,
        @Query("limit") limit: Int = 30
    ): Response<TryOnHistoryResponse>
```

- [ ] **Step 3: Add the repository**

Create `apps/virtual_tryon_android/app/src/main/java/tryme/nice/interactive/data/repository/TryOnHistoryRepository.kt`:

```kotlin
package tryme.nice.interactive.data.repository

import tryme.nice.interactive.api.ApiClient
import tryme.nice.interactive.api.ApiService
import tryme.nice.interactive.data.models.TryOnHistoryResponse

sealed interface TryOnHistoryResult<out T> {
    data class Success<T>(val data: T) : TryOnHistoryResult<T>
    data class Failure(val message: String) : TryOnHistoryResult<Nothing>
}

class TryOnHistoryRepository(
    private val apiService: ApiService = ApiClient.apiService
) {
    suspend fun getHistory(
        before: String? = null,
        limit: Int = 30
    ): TryOnHistoryResult<TryOnHistoryResponse> {
        return try {
            val response = apiService.getTryOnHistory(before, limit)
            val body = response.body()
            if (response.isSuccessful && body != null) {
                TryOnHistoryResult.Success(body)
            } else {
                TryOnHistoryResult.Failure(
                    response.errorBody()?.string() ?: "Unable to load history (${response.code()})"
                )
            }
        } catch (e: Exception) {
            TryOnHistoryResult.Failure(e.message ?: "Network error. Check your connection.")
        }
    }
}
```

- [ ] **Step 4: Compile-check**

From `apps/virtual_tryon_android`:

```bash
./gradlew :app:compileDebugKotlin
```

Expected: `BUILD SUCCESSFUL`. (Requires the Android SDK to be configured locally, same as any other build in this app — if it isn't set up in your environment, at minimum re-read the three new/changed files and confirm every import resolves to a symbol defined in this task or already present in the file.)

- [ ] **Step 5: Commit**

```bash
git add apps/virtual_tryon_android/app/src/main/java/tryme/nice/interactive/data/models/TryOnHistoryModels.kt \
        apps/virtual_tryon_android/app/src/main/java/tryme/nice/interactive/api/ApiService.kt \
        apps/virtual_tryon_android/app/src/main/java/tryme/nice/interactive/data/repository/TryOnHistoryRepository.kt
git commit -m "$(cat <<'EOF'
feat(android): add try-on history API client

Retrofit method, response models, and repository wrapper for
GET /v1/merchant/tryon/history. No screen wired up yet — API client
only, per the approved design.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```
