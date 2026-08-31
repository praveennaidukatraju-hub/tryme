# Admin Credit Analysis Page — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A new admin-web page ranking all users by credit spend (with day-range and job-source filters), and a per-user drill-down showing a daily spend chart, ledger history, and (for Shopify-linked users) a per-product try-on breakdown.

**Architecture:** A new nullable `jobs.source` column, set at 4 of the 5 job-creation call sites (kiosk excluded — attributed via `merchants.userId` instead), backed by a one-off backfill script for historical rows. Two new read-only admin API routes aggregate `jobs`/`creditLedger`/`shopifyProductGarments`. A new single-file admin-web page (list + detail in one component, matching `UsersPage.tsx`'s convention) consumes them.

**Tech Stack:** Fastify 5, Drizzle ORM, Postgres, Vitest (no testcontainers), React + `recharts` (admin-web).

## Global Constraints

- Schema changes go through `packages/db/src/schema/*.ts` + `pnpm --filter @tryme/db run generate` — never hand-write migration SQL.
- `pnpm docker:up` must be running before any DB/test step in this plan.
- The backfill script is a one-off data UPDATE, not a schema migration — no `drizzle.__drizzle_migrations` bookkeeping, run once via `tsx`, delete the script file after use.
- Tests: Vitest, no testcontainers. Integration tests live in `apps/api/test/integration/` — **`apps/api/vitest.config.ts` excludes this directory from `pnpm test` by default** (pre-existing repo quirk). To run an integration test file: temporarily edit that file's `exclude` array to drop `'test/integration/**'`, run `cd apps/api && npx vitest run test/integration/<file>.test.ts`, then revert with `git checkout -- apps/api/vitest.config.ts`. Never leave that revert undone.
- Biome pre-commit hook (lefthook) — new/modified `.ts`/`.tsx` files must pass `pnpm biome check --write` before committing.
- Commit once per task.
- After API tasks: `pnpm --filter @tryme/api typecheck` must be clean. After admin-web tasks: `cd apps/admin-web && npx tsc -b --noEmit` must be clean (this package has no separate `typecheck` script).

---

## Task 1: Schema — add `jobs.source`

**Files:**
- Modify: `packages/db/src/schema/jobs.ts`
- Generated: a new file under `packages/db/src/migrations/`

**Interfaces:**
- Produces: `schema.jobs.source: string | null` — consumed by every later task in this plan.

- [ ] **Step 1: Add the column**

In `packages/db/src/schema/jobs.ts`, add `source` right after `errorCode`:

```ts
  errorCode: text('error_code'),
  // Which flow created this job — 'catalog' | 'tryon' | 'saree' | 'shopify'.
  // Null for kiosk jobs (attributed via merchants.userId instead, see the
  // admin credit-analysis routes) and for historical rows not yet backfilled.
  source: text('source'),
```

- [ ] **Step 2: Generate the migration**

```bash
pnpm --filter @tryme/db run generate
```

Expected: a new `NNNN_<name>.sql` file appears under `packages/db/src/migrations/` containing `ALTER TABLE "jobs" ADD COLUMN "source" text;`.

- [ ] **Step 3: Apply it**

```bash
pnpm --filter @tryme/db run migrate
```

Expected: migration applies cleanly against the local dev DB (`pnpm docker:up` must already be running).

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/schema/jobs.ts packages/db/src/migrations/
git commit -m "$(cat <<'EOF'
feat(db): add jobs.source column for credit-analysis job-type filtering

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Tag `source` at the 4 relevant job-creation call sites

**Files:**
- Modify: `apps/api/src/modules/jobs/create.ts` (both `createJob` and `createSimpleTryonJob`)
- Modify: `apps/api/src/modules/jobs/createSaree.ts`
- Modify: `apps/api/src/modules/shopify/customer.routes.ts`
- Test: `apps/api/test/integration/regenerate.test.ts` (add one assertion)
- Test: `apps/api/test/integration/simple-tryon.test.ts` (add one assertion)
- Test: `apps/api/test/integration/saree-jobs.test.ts` (add one assertion)
- Test: `apps/api/test/integration/shopify-customer.test.ts` (add one assertion)

`apps/api/src/modules/kiosk/create-job.ts` is **not** touched — kiosk jobs never get a `source` value; they're attributed via `merchants.userId` at query time instead (Task 4).

**Interfaces:**
- Consumes: `schema.jobs.source` from Task 1.
- Produces: every `COMPLETED` job created via these 4 paths going forward has `source` set to one of `'catalog' | 'tryon' | 'saree' | 'shopify'`. Task 4's routes rely on these exact string values.

### Step 1: Add `source: 'catalog'` to the studio wizard (`createJob`)

In `apps/api/src/modules/jobs/create.ts`, inside `createJob`, find:

```ts
      const [job] = await tx
        .insert(schema.jobs)
        .values({
          userId,
          catalogueId,
          status: 'QUEUED',
          priority,
          queueStream,
          watermark,
          creditsCharged: COST,
        })
        .returning();
```

Change to:

```ts
      const [job] = await tx
        .insert(schema.jobs)
        .values({
          userId,
          catalogueId,
          status: 'QUEUED',
          priority,
          queueStream,
          watermark,
          creditsCharged: COST,
          source: 'catalog',
        })
        .returning();
```

- [ ] **Make this edit.**

### Step 2: Add `source: 'tryon'` to `createSimpleTryonJob`

In the same file, inside `createSimpleTryonJob`, find:

```ts
    const [newJob] = await tx
      .insert(schema.jobs)
      .values({
        userId,
        catalogueId,
        status: 'QUEUED',
        priority,
        queueStream,
        watermark,
        creditsCharged: COST,
      })
      .returning();
```

Change to:

```ts
    const [newJob] = await tx
      .insert(schema.jobs)
      .values({
        userId,
        catalogueId,
        status: 'QUEUED',
        priority,
        queueStream,
        watermark,
        creditsCharged: COST,
        source: 'tryon',
      })
      .returning();
```

- [ ] **Make this edit.**

### Step 3: Add `source: 'saree'` to `createSareeJob`

In `apps/api/src/modules/jobs/createSaree.ts`, find:

```ts
    const [newJob] = await tx
      .insert(schema.jobs)
      .values({
        userId,
        catalogueId,
        status: 'QUEUED',
        priority,
        queueStream,
        watermark,
        creditsCharged: COST,
      })
      .returning();
```

Change to:

```ts
    const [newJob] = await tx
      .insert(schema.jobs)
      .values({
        userId,
        catalogueId,
        status: 'QUEUED',
        priority,
        queueStream,
        watermark,
        creditsCharged: COST,
        source: 'saree',
      })
      .returning();
```

- [ ] **Make this edit.**

### Step 4: Add `source: 'shopify'` to the Shopify widget job

In `apps/api/src/modules/shopify/customer.routes.ts`, find:

```ts
        // biome-ignore lint/suspicious/noExplicitAny: Drizzle infers non-null for nullable FKs. The plan explicitly notes this is the intended pattern.
        await (tx.insert(schema.jobs).values as any)({
          id: jobId,
          userId,
          shopifyStoreId: storeId,
          customerPhotoKey,
          status: 'QUEUED',
          creditsCharged: jobCost,
        });
```

Change to:

```ts
        // biome-ignore lint/suspicious/noExplicitAny: Drizzle infers non-null for nullable FKs. The plan explicitly notes this is the intended pattern.
        await (tx.insert(schema.jobs).values as any)({
          id: jobId,
          userId,
          shopifyStoreId: storeId,
          customerPhotoKey,
          status: 'QUEUED',
          creditsCharged: jobCost,
          source: 'shopify',
        });
```

- [ ] **Make this edit.**

### Step 5: Add assertions to the 4 existing (currently-passing) tests that exercise these paths

Do **not** add tests to `apps/api/test/integration/jobs-create.test.ts` — it's a pre-existing known failure (stale field names, unrelated to this change; see the comment block in `apps/api/vitest.config.ts`).

In `apps/api/test/integration/regenerate.test.ts`, the test `'re-derives lower/shoe stripping from the CURRENT pose workflow, not the stale original inputs'` already exercises `createJob` via the regenerate route. Find:

```ts
      const [newJob] = await app.db.select().from(schema.jobs).where(eq(schema.jobs.id, newJobId));
      expect(newJob.parentJobId).toBe(original.id);
    });
```

Change to:

```ts
      const [newJob] = await app.db.select().from(schema.jobs).where(eq(schema.jobs.id, newJobId));
      expect(newJob.parentJobId).toBe(original.id);
      expect(newJob.source).toBe('catalog');
    });
```

In `apps/api/test/integration/simple-tryon.test.ts`, the test `'happy path: deducts 5 credits, uses keys.output(sourceJobId) as garment, resolves workflow'` — find:

```ts
    const [job] = await app.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
    expect(job.status).toBe('QUEUED');
    expect(job.creditsCharged).toBe(5);
```

Change to:

```ts
    const [job] = await app.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
    expect(job.status).toBe('QUEUED');
    expect(job.creditsCharged).toBe(5);
    expect(job.source).toBe('tryon');
```

In `apps/api/test/integration/saree-jobs.test.ts`, the test `'happy path: deducts 5 credits, inserts job+inputs, XADDs to jobs:normal'` — find:

```ts
    const [job] = await app.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
    expect(job.status).toBe('QUEUED');
    expect(job.creditsCharged).toBe(5);
```

Change to:

```ts
    const [job] = await app.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
    expect(job.status).toBe('QUEUED');
    expect(job.creditsCharged).toBe(5);
    expect(job.source).toBe('saree');
```

In `apps/api/test/integration/shopify-customer.test.ts`, the test `'creates a job billed to the store owner and deducts their credits, needing no shopper auth at all'` — find:

```ts
    const [job] = await app.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
    expect(job.userId).toBe(owner.id);
```

Change to:

```ts
    const [job] = await app.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
    expect(job.userId).toBe(owner.id);
    expect(job.source).toBe('shopify');
```

- [ ] **Make all 4 test edits above.**

### Step 6: Run all 4 test files, temporarily lifting the integration exclude

```bash
cd /mnt/vol1/PycharmProjects/tryme_v1
sed -i "s/exclude: \['test\/integration\/\*\*', /exclude: [/" apps/api/vitest.config.ts
cd apps/api
npx vitest run test/integration/regenerate.test.ts test/integration/simple-tryon.test.ts test/integration/saree-jobs.test.ts test/integration/shopify-customer.test.ts
```

Expected: all 4 files PASS, including the new `source` assertions.

- [ ] **Run and confirm PASS.**

### Step 7: Revert the vitest.config.ts exclude change

```bash
cd /mnt/vol1/PycharmProjects/tryme_v1
git checkout -- apps/api/vitest.config.ts
git status --short apps/api/vitest.config.ts
```

Expected: no output from `git status` (clean).

- [ ] **Run and confirm clean.**

### Step 8: Typecheck + Biome + commit

```bash
pnpm --filter @tryme/api typecheck
pnpm biome check --write apps/api/src/modules/jobs/create.ts apps/api/src/modules/jobs/createSaree.ts apps/api/src/modules/shopify/customer.routes.ts apps/api/test/integration/regenerate.test.ts apps/api/test/integration/simple-tryon.test.ts apps/api/test/integration/saree-jobs.test.ts apps/api/test/integration/shopify-customer.test.ts
git add apps/api/src/modules/jobs/create.ts apps/api/src/modules/jobs/createSaree.ts apps/api/src/modules/shopify/customer.routes.ts apps/api/test/integration/regenerate.test.ts apps/api/test/integration/simple-tryon.test.ts apps/api/test/integration/saree-jobs.test.ts apps/api/test/integration/shopify-customer.test.ts
git commit -m "$(cat <<'EOF'
feat(api): tag jobs with their creation source for credit analysis

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Run the commands above.**

---

## Task 3: Backfill `source` for historical jobs

**Files:**
- Create (temporary, delete at the end of this task): `packages/db/backfill-job-source.ts`

**Interfaces:**
- Consumes: `schema.jobs.source` (Task 1), `DATABASE_URL` env var.
- Produces: every pre-existing `jobs` row with `source IS NULL` gets backfilled. Task 4's routes assume this has run in every environment they query (dev DB now; staging/prod before deploy).

- [ ] **Step 1: Write the script**

```ts
// packages/db/backfill-job-source.ts — one-off data backfill, delete after use.
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL as string);

async function main() {
  const result = await sql`
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
    WHERE j.source IS NULL
  `;
  console.log(`Backfilled ${result.count} rows`);
  await sql.end();
}

main();
```

- [ ] **Step 2: Run it against the local dev DB**

```bash
node_modules/.bin/tsx --env-file=.env packages/db/backfill-job-source.ts
```

Expected: prints `Backfilled N rows` (N = however many historical jobs exist locally; 0 is fine on a fresh DB).

- [ ] **Run and confirm it completes without error.**

### Step 3: Verify the backfill with a quick spot-check

```bash
psql "$DATABASE_URL" -c "SELECT source, count(*) FROM jobs GROUP BY source ORDER BY source;"
```

Expected: no row with `source` NULL unless it's a kiosk-created row from before this backfill ran twice (kiosk rows do get backfilled to `'kiosk'` once, per the CASE statement, even though new kiosk jobs never get `source` set going forward — this is the intentional asymmetry documented in the spec).

- [ ] **Run and eyeball the counts.**

### Step 4: Delete the script and commit

```bash
rm packages/db/backfill-job-source.ts
git add -A packages/db/backfill-job-source.ts
git commit -m "$(cat <<'EOF'
chore(db): backfill jobs.source for historical rows (script run, then removed)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

Note: this commit has an empty diff if the file was never committed in the first place — if `git status` shows nothing to commit, skip this commit entirely (the script only ever needs to exist on disk long enough to run once).

- [ ] **Run the commands above (or skip the commit if there's nothing staged).**

---

## Task 4: Admin API — credit-analysis routes

**Files:**
- Create: `apps/api/src/modules/admin/credit-analysis.routes.ts`
- Modify: `apps/api/src/server.ts` (register the new route module)
- Test: `apps/api/test/integration/admin-credit-analysis.test.ts`

**Interfaces:**
- Consumes: `schema.jobs.source` (Task 1), `requireAdmin` (`apps/api/src/modules/admin/guard.ts`), `adminAuthHeader` test helper (`apps/api/test/helpers/admin.ts`).
- Produces:
  - `GET /admin/credit-analysis/users?page=&pageSize=&search=&days=7|30|90|all&source=all|catalog|tryon|saree|kiosk|shopify` → `{ page, pageSize, total, items: Array<{ id, email, displayName, tier, balance, hasShopifyStore, totalSpent, totalJobs, avgCostPerJob, lastActivityAt }> }`
  - `GET /admin/credit-analysis/users/:id?days=&source=` → `{ id, email, displayName, tier, balance, hasShopifyStore, dailySpend: Array<{date, spent}>, ledger: Array<{id, delta, reason, jobId, createdAt}>, topProducts: Array<{shopifyProductId, title, jobCount, creditsSpent}> }`
  - Task 5 (admin-web) calls both of these directly by URL and consumes this exact response shape.

### Step 1: Write the route file

```ts
// apps/api/src/modules/admin/credit-analysis.routes.ts
import { schema } from '@tryme/db';
import { and, desc, eq, exists, gte, inArray, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { requireAdmin } from './guard.js';

const SOURCES = ['catalog', 'tryon', 'saree', 'kiosk', 'shopify'] as const;
const DAY_RANGES = ['7', '30', '90', 'all'] as const;
type DayRange = (typeof DAY_RANGES)[number];
type SourceFilter = 'all' | (typeof SOURCES)[number];

const ListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  search: z.string().optional(),
  days: z.enum(DAY_RANGES).default('30'),
  source: z.enum(['all', ...SOURCES]).default('all'),
});

const DetailQuery = z.object({
  days: z.enum(DAY_RANGES).default('30'),
  source: z.enum(['all', ...SOURCES]).default('all'),
});

function sinceDate(days: DayRange): Date | null {
  if (days === 'all') return null;
  return new Date(Date.now() - Number(days) * 24 * 60 * 60 * 1000);
}

function sourceCondition(source: SourceFilter) {
  switch (source) {
    case 'shopify':
      return sql`${schema.jobs.shopifyStoreId} IS NOT NULL`;
    case 'kiosk':
      return sql`${schema.jobs.kioskDeviceId} IS NOT NULL`;
    case 'catalog':
    case 'tryon':
    case 'saree':
      return eq(schema.jobs.source, source);
    default:
      return sql`true`;
  }
}

// Jobs are attributed to whichever user "owns" them: jobs.userId directly,
// or — for kiosk jobs, which always have userId = null — the user who owns
// the merchant profile the kiosk device belongs to (merchants.userId is a
// real 1:1 link; a merchant IS a user).
const rankedUserId = sql<string>`COALESCE(${schema.jobs.userId}, ${schema.merchants.userId})`;

export async function adminCreditAnalysisRoutes(app: FastifyInstance) {
  const ALL = requireAdmin(['SUPER_ADMIN', 'MODERATOR', 'SUPPORT', 'ADMIN']);

  app.get(
    '/admin/credit-analysis/users',
    { preHandler: ALL, schema: { querystring: ListQuery } },
    async (req) => {
      const { page, pageSize, search, days, source } = req.query as z.infer<typeof ListQuery>;
      const since = sinceDate(days);

      let matchingUserIds: string[] | null = null;
      if (search) {
        const rows = await app.db
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(
            sql`${schema.users.email} ILIKE ${`%${search}%`} OR ${schema.users.displayName} ILIKE ${`%${search}%`}`,
          );
        matchingUserIds = rows.map((r) => r.id);
        if (matchingUserIds.length === 0) {
          return { page, pageSize, total: 0, items: [] };
        }
      }

      const conditions = [
        sourceCondition(source),
        since ? gte(schema.jobs.createdAt, since) : undefined,
        matchingUserIds ? inArray(rankedUserId, matchingUserIds) : undefined,
      ].filter((c): c is NonNullable<typeof c> => c !== undefined);

      const aggRows = await app.db
        .select({
          userId: rankedUserId,
          totalSpent: sql<number>`COALESCE(SUM(CASE WHEN ${schema.jobs.status} = 'COMPLETED' THEN ${schema.jobs.creditsCharged} ELSE 0 END), 0)::int`,
          totalJobs: sql<number>`COUNT(*) FILTER (WHERE ${schema.jobs.status} = 'COMPLETED')::int`,
          lastActivityAt: sql<string | null>`MAX(${schema.jobs.createdAt})`,
        })
        .from(schema.jobs)
        .leftJoin(schema.merchants, eq(schema.merchants.id, schema.jobs.merchantId))
        .where(and(...conditions))
        .groupBy(rankedUserId)
        .having(sql`COALESCE(${schema.jobs.userId}, ${schema.merchants.userId}) IS NOT NULL`)
        .orderBy(
          desc(
            sql`COALESCE(SUM(CASE WHEN ${schema.jobs.status} = 'COMPLETED' THEN ${schema.jobs.creditsCharged} ELSE 0 END), 0)`,
          ),
        )
        .limit(pageSize)
        .offset((page - 1) * pageSize);

      const rankedSubquery = app.db
        .select({ userId: rankedUserId })
        .from(schema.jobs)
        .leftJoin(schema.merchants, eq(schema.merchants.id, schema.jobs.merchantId))
        .where(and(...conditions))
        .groupBy(rankedUserId)
        .having(sql`COALESCE(${schema.jobs.userId}, ${schema.merchants.userId}) IS NOT NULL`)
        .as('ranked');
      const [{ total }] = await app.db
        .select({ total: sql<number>`COUNT(*)::int` })
        .from(rankedSubquery);

      const pageUserIds = aggRows.map((r) => r.userId);
      const userRows = pageUserIds.length
        ? await app.db
            .select({
              id: schema.users.id,
              email: schema.users.email,
              displayName: schema.users.displayName,
              tier: schema.users.tier,
              balance: sql<number>`COALESCE(${schema.userCredits.balance}, 0)`,
              hasShopifyStore: exists(
                app.db
                  .select()
                  .from(schema.shopifyStores)
                  .where(
                    and(
                      eq(schema.shopifyStores.ownerUserId, schema.users.id),
                      isNull(schema.shopifyStores.uninstalledAt),
                    ),
                  ),
              ),
            })
            .from(schema.users)
            .leftJoin(schema.userCredits, eq(schema.userCredits.userId, schema.users.id))
            .where(inArray(schema.users.id, pageUserIds))
        : [];
      const userMap = new Map(userRows.map((u) => [u.id, u]));

      const items = aggRows.map((r) => {
        const u = userMap.get(r.userId);
        return {
          id: r.userId,
          email: u?.email ?? '(unknown)',
          displayName: u?.displayName ?? null,
          tier: u?.tier ?? '',
          balance: u?.balance ?? 0,
          hasShopifyStore: u?.hasShopifyStore ?? false,
          totalSpent: r.totalSpent,
          totalJobs: r.totalJobs,
          avgCostPerJob: r.totalJobs > 0 ? Math.round((r.totalSpent / r.totalJobs) * 100) / 100 : 0,
          lastActivityAt: r.lastActivityAt,
        };
      });

      return { page, pageSize, total, items };
    },
  );

  app.get(
    '/admin/credit-analysis/users/:id',
    {
      preHandler: ALL,
      schema: { params: z.object({ id: z.string().uuid() }), querystring: DetailQuery },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const { days, source } = req.query as z.infer<typeof DetailQuery>;
      const since = sinceDate(days);

      const [user] = await app.db
        .select({
          id: schema.users.id,
          email: schema.users.email,
          displayName: schema.users.displayName,
          tier: schema.users.tier,
        })
        .from(schema.users)
        .where(eq(schema.users.id, id));
      if (!user) throw new AppError('NOT_FOUND', 404, 'user not found');

      const [credits] = await app.db
        .select({ balance: schema.userCredits.balance })
        .from(schema.userCredits)
        .where(eq(schema.userCredits.userId, id));

      const [linkedStore] = await app.db
        .select({ id: schema.shopifyStores.id })
        .from(schema.shopifyStores)
        .where(
          and(eq(schema.shopifyStores.ownerUserId, id), isNull(schema.shopifyStores.uninstalledAt)),
        )
        .limit(1);

      const conditions = [
        eq(rankedUserId, id),
        sourceCondition(source),
        since ? gte(schema.jobs.createdAt, since) : undefined,
      ].filter((c): c is NonNullable<typeof c> => c !== undefined);

      const dailySpend = await app.db
        .select({
          date: sql<string>`to_char(${schema.jobs.createdAt}, 'YYYY-MM-DD')`,
          spent: sql<number>`COALESCE(SUM(CASE WHEN ${schema.jobs.status} = 'COMPLETED' THEN ${schema.jobs.creditsCharged} ELSE 0 END), 0)::int`,
        })
        .from(schema.jobs)
        .leftJoin(schema.merchants, eq(schema.merchants.id, schema.jobs.merchantId))
        .where(and(...conditions))
        .groupBy(sql`to_char(${schema.jobs.createdAt}, 'YYYY-MM-DD')`)
        .orderBy(sql`to_char(${schema.jobs.createdAt}, 'YYYY-MM-DD')`);

      const ledger = await app.db
        .select({
          id: schema.creditLedger.id,
          delta: schema.creditLedger.delta,
          reason: schema.creditLedger.reason,
          jobId: schema.creditLedger.jobId,
          createdAt: schema.creditLedger.createdAt,
        })
        .from(schema.creditLedger)
        .where(eq(schema.creditLedger.userId, id))
        .orderBy(desc(schema.creditLedger.createdAt))
        .limit(50);

      let topProducts: {
        shopifyProductId: number;
        title: string | null;
        jobCount: number;
        creditsSpent: number;
      }[] = [];

      if (linkedStore) {
        const productConditions = [
          eq(schema.jobs.shopifyStoreId, linkedStore.id),
          since ? gte(schema.jobs.createdAt, since) : undefined,
        ].filter((c): c is NonNullable<typeof c> => c !== undefined);

        const rows = await app.db
          .select({
            shopifyProductId: sql<number>`(${schema.jobInputs.params}->>'shopifyProductId')::int`,
            jobCount: sql<number>`COUNT(*)::int`,
            creditsSpent: sql<number>`COALESCE(SUM(CASE WHEN ${schema.jobs.status} = 'COMPLETED' THEN ${schema.jobs.creditsCharged} ELSE 0 END), 0)::int`,
          })
          .from(schema.jobs)
          .innerJoin(schema.jobInputs, eq(schema.jobInputs.jobId, schema.jobs.id))
          .where(and(...productConditions))
          .groupBy(sql`(${schema.jobInputs.params}->>'shopifyProductId')::int`)
          .orderBy(
            desc(
              sql`COALESCE(SUM(CASE WHEN ${schema.jobs.status} = 'COMPLETED' THEN ${schema.jobs.creditsCharged} ELSE 0 END), 0)`,
            ),
          );

        const productIds = rows.map((r) => r.shopifyProductId).filter((v) => v != null);
        const garments = productIds.length
          ? await app.db
              .select({
                shopifyProductId: schema.shopifyProductGarments.shopifyProductId,
                title: schema.shopifyProductGarments.title,
              })
              .from(schema.shopifyProductGarments)
              .where(
                and(
                  eq(schema.shopifyProductGarments.storeId, linkedStore.id),
                  inArray(schema.shopifyProductGarments.shopifyProductId, productIds),
                ),
              )
          : [];
        const titleMap = new Map(garments.map((g) => [g.shopifyProductId, g.title]));

        topProducts = rows.map((r) => ({
          shopifyProductId: r.shopifyProductId,
          title: titleMap.get(r.shopifyProductId) ?? null,
          jobCount: r.jobCount,
          creditsSpent: r.creditsSpent,
        }));
      }

      return {
        id: user.id,
        email: user.email,
        displayName: user.displayName,
        tier: user.tier,
        balance: credits?.balance ?? 0,
        hasShopifyStore: !!linkedStore,
        dailySpend,
        ledger,
        topProducts,
      };
    },
  );
}
```

- [ ] **Create the file above.**

### Step 2: Register the route module

In `apps/api/src/server.ts`, add the import near the other admin route imports:

```ts
import { adminCreditAnalysisRoutes } from './modules/admin/credit-analysis.routes.js';
```

And add the registration near the other admin registrations (next to `adminUsersRoutes`/`adminShopifyFunnelsRoutes`):

```ts
  await app.register(adminCreditAnalysisRoutes);
```

- [ ] **Make this edit.**

### Step 3: Write the failing integration test

```ts
// apps/api/test/integration/admin-credit-analysis.test.ts
import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminAuthHeader } from '../helpers/admin.js';
import { buildTestApp } from '../helpers/api.js';
import { startContainers } from '../helpers/containers.js';

describe('admin credit analysis routes', () => {
  let ctx: Awaited<ReturnType<typeof startContainers>>;
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  let authHeader: Record<string, string>;

  beforeAll(async () => {
    ctx = await startContainers();
    app = await buildTestApp(ctx);
    authHeader = await adminAuthHeader(app, 'SUPER_ADMIN');
  });
  afterAll(async () => {
    await app.close();
    await ctx.stop();
  });

  async function seedUser(balance: number) {
    const [user] = await app.db
      .insert(schema.users)
      .values({
        email: `credit-analysis-${Date.now()}-${Math.random()}@example.com`,
        passwordHash: null,
        displayName: 'Spend Test User',
        companyName: null,
        emailVerified: true,
        tier: 'free',
      })
      .returning();
    await app.db.insert(schema.userCredits).values({ userId: user.id, balance });
    return user;
  }

  async function seedJob(userId: string, opts: { source: string; creditsCharged: number; status?: string }) {
    const [job] = await app.db
      .insert(schema.jobs)
      .values({
        userId,
        status: opts.status ?? 'COMPLETED',
        creditsCharged: opts.creditsCharged,
        source: opts.source,
      })
      .returning();
    return job;
  }

  it('ranks users by total completed-job spend, descending', async () => {
    const bigSpender = await seedUser(1000);
    const smallSpender = await seedUser(1000);
    await seedJob(bigSpender.id, { source: 'catalog', creditsCharged: 50 });
    await seedJob(smallSpender.id, { source: 'catalog', creditsCharged: 5 });

    const res = await app.inject({
      method: 'GET',
      url: '/admin/credit-analysis/users?days=all&pageSize=100',
      headers: authHeader,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { items: { id: string; totalSpent: number }[] };
    const bigIdx = body.items.findIndex((i) => i.id === bigSpender.id);
    const smallIdx = body.items.findIndex((i) => i.id === smallSpender.id);
    expect(bigIdx).toBeGreaterThanOrEqual(0);
    expect(smallIdx).toBeGreaterThan(bigIdx);
  });

  it('excludes non-COMPLETED jobs from the spend total', async () => {
    const user = await seedUser(1000);
    await seedJob(user.id, { source: 'catalog', creditsCharged: 50, status: 'FAILED' });

    const res = await app.inject({
      method: 'GET',
      url: '/admin/credit-analysis/users?days=all&search=' + encodeURIComponent(user.email),
      headers: authHeader,
    });
    const body = res.json() as { items: { totalSpent: number; totalJobs: number }[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0].totalSpent).toBe(0);
    expect(body.items[0].totalJobs).toBe(0);
  });

  it('filters by job source', async () => {
    const user = await seedUser(1000);
    await seedJob(user.id, { source: 'catalog', creditsCharged: 20 });
    await seedJob(user.id, { source: 'shopify', creditsCharged: 7 });

    const catalogRes = await app.inject({
      method: 'GET',
      url: `/admin/credit-analysis/users?days=all&source=catalog&search=${encodeURIComponent(user.email)}`,
      headers: authHeader,
    });
    const catalogBody = catalogRes.json() as { items: { totalSpent: number }[] };
    expect(catalogBody.items[0].totalSpent).toBe(20);

    const shopifyRes = await app.inject({
      method: 'GET',
      url: `/admin/credit-analysis/users?days=all&source=shopify&search=${encodeURIComponent(user.email)}`,
      headers: authHeader,
    });
    const shopifyBody = shopifyRes.json() as { items: { totalSpent: number }[] };
    expect(shopifyBody.items[0].totalSpent).toBe(7);
  });

  it('attributes kiosk jobs (userId=null) via the merchant owner', async () => {
    const merchantOwner = await seedUser(1000);
    const [merchant] = await app.db
      .insert(schema.merchants)
      .values({
        companyName: 'Kiosk Co',
        contactName: 'Owner',
        phone: '9999999999',
        websiteUrl: 'https://example.com',
        companySize: '1-10',
        purpose: 'test',
        businessAddress: 'Test St',
        isActive: true,
        userId: merchantOwner.id,
      })
      .returning();
    // biome-ignore lint/suspicious/noExplicitAny: kiosk jobs legitimately have null userId, matching apps/api/src/modules/kiosk/create-job.ts.
    await (app.db.insert(schema.jobs).values as any)({
      userId: null,
      merchantId: merchant.id,
      status: 'COMPLETED',
      creditsCharged: 15,
    });

    const res = await app.inject({
      method: 'GET',
      url: `/admin/credit-analysis/users?days=all&search=${encodeURIComponent(merchantOwner.email)}`,
      headers: authHeader,
    });
    const body = res.json() as { items: { id: string; totalSpent: number }[] };
    expect(body.items).toHaveLength(1);
    expect(body.items[0].id).toBe(merchantOwner.id);
    expect(body.items[0].totalSpent).toBe(15);
  });

  it('detail view returns dailySpend, ledger, and no topProducts for a non-Shopify user', async () => {
    const user = await seedUser(1000);
    await seedJob(user.id, { source: 'catalog', creditsCharged: 10 });
    await app.db
      .insert(schema.creditLedger)
      .values({ userId: user.id, delta: -10, reason: 'JOB_DISPATCH' });

    const res = await app.inject({
      method: 'GET',
      url: `/admin/credit-analysis/users/${user.id}?days=all`,
      headers: authHeader,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      dailySpend: unknown[];
      ledger: unknown[];
      topProducts: unknown[];
      hasShopifyStore: boolean;
    };
    expect(body.dailySpend.length).toBeGreaterThan(0);
    expect(body.ledger.length).toBeGreaterThan(0);
    expect(body.topProducts).toEqual([]);
    expect(body.hasShopifyStore).toBe(false);
  });

  it('detail view returns topProducts for a Shopify-linked user, scoped to their own store', async () => {
    const owner = await seedUser(1000);
    const [store] = await app.db
      .insert(schema.shopifyStores)
      .values({
        shopDomain: `credit-analysis-${Date.now()}.myshopify.com`,
        shopifyShopId: Date.now(),
        accessToken: 'enc',
        scope: 'read_products',
        ownerUserId: owner.id,
      })
      .returning();
    await app.db.insert(schema.shopifyProductGarments).values({
      storeId: store.id,
      shopifyProductId: 42,
      r2Key: `shopify-garments/${store.id}/42/garment.jpg`,
      title: 'Blue Shirt',
      status: 'active',
      enabled: true,
    });
    const job = await seedJob(owner.id, { source: 'shopify', creditsCharged: 8 });
    await app.db
      .update(schema.jobs)
      .set({ shopifyStoreId: store.id })
      .where(eq(schema.jobs.id, job.id));
    await app.db.insert(schema.jobInputs).values({
      jobId: job.id,
      upperGarmentKey: 'shopify-garments/x/42/garment.jpg',
      params: { kind: 'shopify', shopifyProductId: 42 },
    });

    const res = await app.inject({
      method: 'GET',
      url: `/admin/credit-analysis/users/${owner.id}?days=all`,
      headers: authHeader,
    });
    const body = res.json() as {
      hasShopifyStore: boolean;
      topProducts: { shopifyProductId: number; title: string | null; creditsSpent: number }[];
    };
    expect(body.hasShopifyStore).toBe(true);
    expect(body.topProducts).toHaveLength(1);
    expect(body.topProducts[0]).toMatchObject({
      shopifyProductId: 42,
      title: 'Blue Shirt',
      creditsSpent: 8,
    });
  });

  it('404s for an unknown user id', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/admin/credit-analysis/users/${randomUUID()}`,
      headers: authHeader,
    });
    expect(res.statusCode).toBe(404);
  });
});
```

- [ ] **Create the file above.**

### Step 4: Run the test, lifting the integration exclude

```bash
cd /mnt/vol1/PycharmProjects/tryme_v1
sed -i "s/exclude: \['test\/integration\/\*\*', /exclude: [/" apps/api/vitest.config.ts
cd apps/api
npx vitest run test/integration/admin-credit-analysis.test.ts
```

Expected: FAIL initially if the route file has any issue (e.g. a Drizzle typing mismatch on `eq(rankedUserId, id)` or the `sql<>`-typed group-by columns) — this is expected exploratory territory since these exact query shapes haven't been run against a live DB before. Iterate on the route file until every test in this file passes. Common fixes if TypeScript or Postgres complains:
- If `eq(rankedUserId, id)` doesn't typecheck cleanly, replace with `sql`${rankedUserId} = ${id}`` directly in the `conditions` array.
- If a `GROUP BY`/`HAVING` clause errors with "column must appear in GROUP BY", make sure every raw `sql` column reference inside `having()`/`orderBy()` textually matches the one used in `groupBy()`.

- [ ] **Run and iterate until all tests in this file PASS.**

### Step 5: Revert the vitest.config.ts exclude change

```bash
cd /mnt/vol1/PycharmProjects/tryme_v1
git checkout -- apps/api/vitest.config.ts
git status --short apps/api/vitest.config.ts
```

Expected: no output.

- [ ] **Run and confirm clean.**

### Step 6: Typecheck + Biome + commit

```bash
pnpm --filter @tryme/api typecheck
pnpm biome check --write apps/api/src/modules/admin/credit-analysis.routes.ts apps/api/src/server.ts apps/api/test/integration/admin-credit-analysis.test.ts
git add apps/api/src/modules/admin/credit-analysis.routes.ts apps/api/src/server.ts apps/api/test/integration/admin-credit-analysis.test.ts
git commit -m "$(cat <<'EOF'
feat(api): admin credit-analysis routes — ranked spend + per-user detail

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Run the commands above.**

---

## Task 5: Admin-web — Credit Analysis page

**Files:**
- Create: `apps/admin-web/src/pages/CreditAnalysisPage.tsx`
- Modify: `apps/admin-web/src/components/Sidebar.tsx`
- Modify: `apps/admin-web/src/App.tsx`

**Interfaces:**
- Consumes: `GET /admin/credit-analysis/users` and `GET /admin/credit-analysis/users/:id` (Task 4's exact response shapes), `apiFetch`/`apiErrorMessage` (`apps/admin-web/src/lib/data.ts`), `<Pager />` (`apps/admin-web/src/components/Pager.tsx`), `Icon.Coin` (`apps/admin-web/src/components/Icons.tsx`, already exists — confirmed this session).
- Produces: no exports consumed elsewhere — this is a leaf page.

There is no automated test harness for admin-web pages in this repo (confirmed this session — no `.test.tsx` files exist under `apps/admin-web/src/pages/`). Verification is `tsc -b --noEmit` plus manual check in the dev server.

### Step 1: Create the page

```tsx
// apps/admin-web/src/pages/CreditAnalysisPage.tsx
import { useCallback, useEffect, useState } from 'react';
import { Bar, BarChart, ResponsiveContainer, Tooltip, XAxis } from 'recharts';
import { Icon } from '../components/Icons';
import { Pager } from '../components/Pager';
import { apiErrorMessage, apiFetch } from '../lib/data';

type DayRange = '7' | '30' | '90' | 'all';
type SourceFilter = 'all' | 'catalog' | 'tryon' | 'saree' | 'kiosk' | 'shopify';

const SOURCE_LABELS: Record<SourceFilter, string> = {
  all: 'All sources',
  catalog: 'Catalog generation',
  tryon: 'Tryon (our app)',
  saree: 'Saree',
  kiosk: 'Kiosk',
  shopify: 'Shopify tryon',
};

interface CreditUserRow {
  id: string;
  email: string;
  displayName: string | null;
  tier: string;
  balance: number;
  hasShopifyStore: boolean;
  totalSpent: number;
  totalJobs: number;
  avgCostPerJob: number;
  lastActivityAt: string | null;
}

interface DailySpendPoint {
  date: string;
  spent: number;
}

interface LedgerEntry {
  id: string;
  delta: number;
  reason: string;
  jobId: string | null;
  createdAt: string;
}

interface TopProduct {
  shopifyProductId: number;
  title: string | null;
  jobCount: number;
  creditsSpent: number;
}

interface CreditUserDetail {
  id: string;
  email: string;
  displayName: string | null;
  tier: string;
  balance: number;
  hasShopifyStore: boolean;
  dailySpend: DailySpendPoint[];
  ledger: LedgerEntry[];
  topProducts: TopProduct[];
}

const PAGE_SIZE = 20;

interface Props {
  toast: (t: { kind?: 'error'; title: string; body?: string }) => void;
}

export default function CreditAnalysisPage({ toast }: Props) {
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [days, setDays] = useState<DayRange>('30');
  const [source, setSource] = useState<SourceFilter>('all');
  const [rows, setRows] = useState<CreditUserRow[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);

  const [detailId, setDetailId] = useState<string | null>(null);
  const [detail, setDetail] = useState<CreditUserDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({
        page: String(page + 1),
        pageSize: String(PAGE_SIZE),
        days,
        source,
      });
      if (query) params.set('search', query);
      const data = await apiFetch<{ items: CreditUserRow[]; total: number }>(
        `/admin/credit-analysis/users?${params}`,
      );
      setRows(data.items);
      setTotal(data.total);
    } catch (err) {
      toast({
        kind: 'error',
        title: 'Failed to load credit analysis',
        body: apiErrorMessage(err, 'Please try again.'),
      });
    } finally {
      setLoading(false);
    }
  }, [page, query, days, source, toast]);

  useEffect(() => {
    load();
  }, [load]);

  const openDetail = useCallback(
    async (id: string) => {
      setDetailId(id);
      setDetail(null);
      setDetailLoading(true);
      try {
        const params = new URLSearchParams({ days, source });
        const data = await apiFetch<CreditUserDetail>(
          `/admin/credit-analysis/users/${id}?${params}`,
        );
        setDetail(data);
      } catch (err) {
        toast({
          kind: 'error',
          title: 'Failed to load user detail',
          body: apiErrorMessage(err, 'Please try again.'),
        });
        setDetailId(null);
      } finally {
        setDetailLoading(false);
      }
    },
    [days, source, toast],
  );

  const handleSearch = (q: string) => {
    setQuery(q);
    setPage(0);
  };

  const totalPages = Math.ceil(total / PAGE_SIZE);

  if (detailId) {
    return (
      <>
        <div className="page-head">
          <div>
            <button className="btn ghost" onClick={() => setDetailId(null)}>
              <Icon.Back /> Back to credit analysis
            </button>
            {detail && (
              <>
                <h1 style={{ marginTop: 8 }}>{detail.displayName ?? detail.email}</h1>
                <p className="lede">
                  {detail.email} &middot; {detail.tier}
                </p>
              </>
            )}
          </div>
          <div className="head-tools">
            {detail?.hasShopifyStore && (
              <span
                className="badge dot"
                style={{ background: 'rgba(76,175,80,0.12)', color: 'var(--success, #4caf50)' }}
              >
                Shopify
              </span>
            )}
          </div>
        </div>

        {detailLoading || !detail ? (
          <p style={{ color: 'var(--muted)', fontSize: 13 }}>Loading&hellip;</p>
        ) : (
          <>
            <div className="kv-grid" style={{ gridTemplateColumns: 'repeat(3, 1fr)', marginBottom: 20 }}>
              <div className="kv">
                <span className="k">Balance</span>
                <span className="v">{detail.balance.toLocaleString()}</span>
              </div>
              <div className="kv">
                <span className="k">Ledger entries shown</span>
                <span className="v">{detail.ledger.length}</span>
              </div>
              <div className="kv">
                <span className="k">Filter</span>
                <span className="v">
                  {days === 'all' ? 'All time' : `${days}d`} &middot; {SOURCE_LABELS[source]}
                </span>
              </div>
            </div>

            <div className="card" style={{ marginBottom: 20 }}>
              <div className="card-head">
                <h3>Daily spend</h3>
              </div>
              <div className="card-body">
                <ResponsiveContainer width="100%" height={220}>
                  <BarChart data={detail.dailySpend}>
                    <XAxis
                      dataKey="date"
                      stroke="var(--muted)"
                      fontSize={12}
                      tickLine={false}
                      axisLine={false}
                    />
                    <Tooltip
                      cursor={{ fill: 'rgba(128,128,128,0.08)' }}
                      contentStyle={{
                        background: 'var(--surface-2)',
                        border: '1px solid var(--border)',
                        borderRadius: 8,
                        fontSize: 12,
                      }}
                    />
                    <Bar dataKey="spent" fill="var(--accent)" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>

            {detail.hasShopifyStore && (
              <div className="card" style={{ marginBottom: 20 }}>
                <div className="card-head">
                  <h3>Top products</h3>
                </div>
                <div className="card-body" style={{ padding: 0 }}>
                  {detail.topProducts.length ? (
                    <div className="table-wrap">
                      <table className="table">
                        <thead>
                          <tr>
                            <th>Product</th>
                            <th style={{ textAlign: 'right' }}>Try-ons</th>
                            <th style={{ textAlign: 'right' }}>Credits spent</th>
                          </tr>
                        </thead>
                        <tbody>
                          {detail.topProducts.map((p) => (
                            <tr key={p.shopifyProductId}>
                              <td>{p.title ?? `Product #${p.shopifyProductId}`}</td>
                              <td style={{ textAlign: 'right' }}>
                                <span className="mono">{p.jobCount}</span>
                              </td>
                              <td style={{ textAlign: 'right' }}>
                                <span className="mono">{p.creditsSpent}</span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div style={{ padding: 20, color: 'var(--muted)', fontSize: 13 }}>
                      No product try-ons in this window.
                    </div>
                  )}
                </div>
              </div>
            )}

            <div className="card">
              <div className="card-head">
                <h3>Recent ledger entries</h3>
              </div>
              <div className="card-body" style={{ padding: 0 }}>
                {detail.ledger.length ? (
                  detail.ledger.map((l) => (
                    <div
                      key={l.id}
                      style={{
                        padding: '10px 18px',
                        borderBottom: '1px solid var(--border)',
                        display: 'flex',
                        gap: 10,
                        alignItems: 'center',
                      }}
                    >
                      <span
                        className="mono"
                        style={{ color: l.delta < 0 ? 'var(--danger)' : 'var(--success, #4caf50)' }}
                      >
                        {l.delta > 0 ? '+' : ''}
                        {l.delta}
                      </span>
                      <span style={{ fontSize: 12, color: 'var(--muted)' }}>{l.reason}</span>
                      <span style={{ fontSize: 12, color: 'var(--muted)', marginLeft: 'auto' }}>
                        {new Date(l.createdAt).toLocaleString()}
                      </span>
                    </div>
                  ))
                ) : (
                  <div style={{ padding: 20, color: 'var(--muted)', fontSize: 13 }}>
                    No ledger entries in this window.
                  </div>
                )}
              </div>
            </div>
          </>
        )}
      </>
    );
  }

  return (
    <>
      <div className="page-head">
        <div>
          <h1>Credit Analysis</h1>
          <p className="lede">
            {loading ? '…' : total} users ranked by credit spend.
          </p>
        </div>
        <div className="head-tools">
          <div className="search">
            <Icon.Search />
            <input
              placeholder="Search by name or email…"
              value={query}
              onChange={(e) => handleSearch(e.target.value)}
            />
          </div>
        </div>
      </div>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', gap: 4 }}>
          {(['7', '30', '90', 'all'] as DayRange[]).map((d) => (
            <button
              key={d}
              className="btn sm ghost"
              onClick={() => {
                setDays(d);
                setPage(0);
              }}
              style={{
                background: days === d ? 'var(--bg-2)' : 'transparent',
                color: days === d ? 'var(--text)' : 'var(--muted)',
              }}
            >
              {d === 'all' ? 'All time' : `${d}d`}
            </button>
          ))}
        </div>
        <select
          className="select"
          value={source}
          onChange={(e) => {
            setSource(e.target.value as SourceFilter);
            setPage(0);
          }}
        >
          {(Object.keys(SOURCE_LABELS) as SourceFilter[]).map((s) => (
            <option key={s} value={s}>
              {SOURCE_LABELS[s]}
            </option>
          ))}
        </select>
      </div>

      {loading ? (
        <p style={{ color: 'var(--muted)', fontSize: 13, padding: '20px 0' }}>Loading&hellip;</p>
      ) : (
        <>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th style={{ textAlign: 'left' }}>User</th>
                  <th style={{ textAlign: 'right' }}>Spent</th>
                  <th style={{ textAlign: 'right' }}>Jobs</th>
                  <th style={{ textAlign: 'right' }}>Avg/job</th>
                  <th style={{ textAlign: 'right' }}>Last activity</th>
                  <th style={{ textAlign: 'right' }}>Balance</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} onClick={() => openDetail(r.id)} style={{ cursor: 'pointer' }}>
                    <td style={{ textAlign: 'left' }}>
                      <span className="semi" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                        {r.displayName ?? <span style={{ color: 'var(--muted)' }}>{r.email}</span>}
                        {r.hasShopifyStore && (
                          <span
                            className="badge dot"
                            style={{
                              background: 'rgba(76,175,80,0.12)',
                              color: 'var(--success, #4caf50)',
                              fontSize: 10,
                            }}
                          >
                            Shopify
                          </span>
                        )}
                      </span>
                      {r.displayName && (
                        <span className="sub" style={{ display: 'block' }}>
                          {r.email}
                        </span>
                      )}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <span className="mono">{r.totalSpent.toLocaleString()}</span>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <span className="mono">{r.totalJobs.toLocaleString()}</span>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <span className="mono">{r.avgCostPerJob}</span>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <span className="mono">
                        {r.lastActivityAt ? new Date(r.lastActivityAt).toLocaleDateString() : '—'}
                      </span>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <span className="mono">{r.balance.toLocaleString()}</span>
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td
                      colSpan={6}
                      style={{ padding: 20, color: 'var(--muted)', fontSize: 13, textAlign: 'center' }}
                    >
                      No users found for this filter.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <Pager
            page={page}
            totalPages={totalPages}
            onPage={setPage}
            totalItems={total}
            pageSize={PAGE_SIZE}
          />
        </>
      )}
    </>
  );
}
```

- [ ] **Create the file above.**

### Step 2: Add the Sidebar entry

In `apps/admin-web/src/components/Sidebar.tsx`, in the `'Operations'` group, add after `'recycle-bin'`:

```ts
      {
        k: 'credit-analysis',
        label: 'Credit Analysis',
        icon: Icon.Coin,
        roles: ['SUPER_ADMIN', 'SUPPORT', 'ADMIN'],
      },
```

- [ ] **Make this edit.**

### Step 3: Wire up App.tsx

Add the import near the other page imports:

```ts
import CreditAnalysisPage from './pages/CreditAnalysisPage';
```

Add to `PATH_LABELS`:

```ts
  'credit-analysis': 'Credit Analysis',
```

Add the route, next to `/shopify-funnels`:

```tsx
            <Route path="/credit-analysis" element={<CreditAnalysisPage {...pageProps} />} />
```

- [ ] **Make these 3 edits.**

### Step 4: Typecheck + Biome + commit

```bash
cd apps/admin-web && npx tsc -b --noEmit
cd /mnt/vol1/PycharmProjects/tryme_v1
pnpm biome check --write apps/admin-web/src/pages/CreditAnalysisPage.tsx apps/admin-web/src/components/Sidebar.tsx apps/admin-web/src/App.tsx
git add apps/admin-web/src/pages/CreditAnalysisPage.tsx apps/admin-web/src/components/Sidebar.tsx apps/admin-web/src/App.tsx
git commit -m "$(cat <<'EOF'
feat(admin): Credit Analysis page — ranked spend table + per-user detail

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Run the commands above.**

### Step 5: Manual verification checklist

No automated component tests exist for admin-web pages in this repo. Verify by hand in the dev server (`pnpm --filter @tryme/admin dev`):

- [ ] Sidebar shows "Credit Analysis" under Operations, with the coin icon.
- [ ] The list loads, shows the Shopify badge on linked users, and the day-range/source filters change the numbers shown.
- [ ] Search narrows the list by name/email.
- [ ] Pagination works past 20 rows (if enough seed data exists).
- [ ] Clicking a row opens the detail view: chart renders, ledger entries show, and the "Top products" card only appears for Shopify-linked users.
- [ ] "Back to credit analysis" returns to the list with filters/page preserved.

---

## Self-Review

**Spec coverage:**
- "Credit spend" definition (`SUM(creditsCharged) WHERE status='COMPLETED'`) → Task 4, both routes.
- `jobs.source` column + 4 call sites + backfill → Tasks 1, 2, 3.
- Kiosk attribution via `merchants.userId` → Task 4 (`rankedUserId` = `COALESCE(jobs.userId, merchants.userId)`), tested explicitly.
- Nav placement (Operations group, `Icon.Coin`, same role gate as Users) → Task 5, Step 2.
- Main table: server-side sort by spend desc, day-range + source filters, search, pagination → Task 4 (query) + Task 5 (UI).
- Per-user detail (own dedicated view, chart, ledger, Shopify-only product breakdown) → Task 4 (`/users/:id`) + Task 5 (detail render branch).
- 5 explicit source filter options (no `merchant_widget`) → `SOURCE_LABELS` in Task 5's page, `SOURCES` const in Task 4's route file — both list exactly `catalog, tryon, saree, kiosk, shopify`.
- `merchant/create-job.ts` untouched → confirmed, no task modifies it.
- Testing section (ranking correctness, filters, refund exclusion, product breakdown scoping, backfill script) → Task 4's integration test file covers all of these; Task 2's assertions cover source-tagging at the creation call sites; Task 3's spot-check covers the backfill.

**Placeholder scan:** No TBD/TODO; every step has complete runnable code or an exact command with expected output. The one place I flagged genuine uncertainty (Task 4, Step 4) is an explicit "iterate here" note for Drizzle query syntax that hasn't been run against a live DB yet — this is intentional (TDD: write, run, see what Postgres/TypeScript actually says, fix), not a placeholder for missing logic.

**Type consistency:** `CreditUserRow`/`CreditUserDetail`/`DailySpendPoint`/`LedgerEntry`/`TopProduct` field names in Task 5's page match exactly what Task 4's routes return (`totalSpent`, `totalJobs`, `avgCostPerJob`, `lastActivityAt`, `dailySpend[].spent`, `ledger[].delta/reason/jobId/createdAt`, `topProducts[].shopifyProductId/title/jobCount/creditsSpent`). `SourceFilter`/`DayRange` string literal unions match between Task 4's Zod enums and Task 5's TypeScript types (`'7'|'30'|'90'|'all'`, `'all'|'catalog'|'tryon'|'saree'|'kiosk'|'shopify'`).
