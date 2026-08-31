# Unified Credits — Remove the Separate Merchant Credit Pool — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the parallel merchant credit pool (`merchant_credits`, `merchant_credit_ledger`, `config:system.merchantFreeCredits`) into the existing `user_credits` / `credit_ledger` system, so every human has exactly one balance and one ledger.

**Architecture:** `apps/api/src/modules/merchant/ledger.ts` stops owning a balance and becomes a thin adapter that resolves `merchants.userId` and delegates to the existing helpers in `apps/api/src/modules/credits/ledger.ts`. Every call site keeps its `merchantId`-shaped signature, so the merchant→user mapping lives in exactly one file. Read paths, the merchant Razorpay flow, and the dispatcher's refund paths all repoint to `user_credits`. Rolled out in two releases: Release 1 (Tasks 1–8) changes code and additively backfills existing balances; Release 2 (Task 9) drops the two tables once production is verified.

**Tech Stack:** pnpm workspaces, TypeScript 5.6 ESM, Fastify 5, Drizzle ORM + PostgreSQL 16, Redis 7, Vitest, Biome, React (Vite) for `apps/admin-web`.

## Global Constraints

- **Package manager is pnpm.** Never introduce npm/yarn lockfiles.
- **ESM only** (`"type": "module"` everywhere). Relative imports inside `apps/api` and `apps/dispatcher` must carry the `.js` extension.
- **No `console.log`** in committed code. Use `@tryme/logger`.
- **Docker must be running** before any test task: `pnpm docker:up`. The Vitest integration harness creates a fresh Postgres database and MinIO bucket per test file against the localhost compose stack. There are no testcontainers; do not reintroduce the (installed but unused) `testcontainers` package.
- **`pnpm --filter @tryme/api test` and `test:unit` do NOT run integration tests.** `apps/api/vitest.config.ts` unconditionally excludes `test/integration/**` — CLAUDE.md's description of the plain `test` script as the "Full API integration suite" is stale. Every file this plan touches under `apps/api/test/integration/` (`merchant-tryon.test.ts`, `kiosk-jobs.test.ts`, `merchant-me.test.ts`, `merchant-kiosk-admin.test.ts`, `merchant-catalog*.test.ts`, `merchant-credit-unification.test.ts`, etc.) must instead be run with:
  ```bash
  cd apps/api && npx vitest run --config vitest.integration.config.ts -- <pattern>
  ```
  This config file exists (`apps/api/vitest.integration.config.ts`) but is wired to no package.json script and no automated hook — nothing in this repo runs it except by hand. Every command shown later in this plan as `pnpm --filter @tryme/api test -- <pattern>` targeting a file under `test/integration/` has already been corrected to the command above — if you spot the plain form pointed at an integration file, use the corrected command instead. `apps/api/test/merchant-onboarding.test.ts` is the one exception worth naming explicitly: despite the similar name, it lives directly under `apps/api/test/` (not `test/integration/`), so the plain `pnpm --filter @tryme/api test -- merchant-onboarding` is correct for it as written.
- **Known pre-existing integration-suite flakiness** (established 2026-08-04, before any task in this plan ran, two consecutive full runs of `vitest.integration.config.ts`, no filter, ~380s each): run 1 showed 13/84 files failing (39/436 tests); run 2, immediately after with no code change in between, showed 10/84 files failing (23/436 tests) — the failure count is not deterministic. The overlap includes `catalog.test.ts`, `catalogue-templates-public.test.ts`, `credit-plans.test.ts`, `credits.test.ts`, `e2e.test.ts`, `jobs-create.test.ts`, `saree-jobs.test.ts`, and `signup-campaign.test.ts` — all unrelated to merchant credits — plus one unhandled rejection in `signup-campaigns-admin.test.ts` (`UNDEFINED_VALUE` in a Postgres tx). The likely cause: several files intentionally simulate Redis failures (`shopify shopper limits`, etc.) for retry-behavior tests, and `fileParallelism: false` means all files share one process — a simulation that doesn't fully unwind can bleed into files that run after it. **This is out of scope for this plan; do not attempt to fix it.**

  One file in the flaky set is directly relevant here: **`merchant-kiosk-admin.test.ts`** — modified in Task 2 and re-run in Task 3 — appeared in the failing set in one baseline run. Before treating any full-suite failure in a file this plan touches as a regression, re-run that one file in isolation (`cd apps/api && npx vitest run --config vitest.integration.config.ts -- <that file's name>`) — the per-task steps in this plan already do this for every file they modify, precisely to sidestep this cross-file pollution. Only a failure that reproduces in isolation is this plan's problem to fix.
- **Never run schema or data migrations directly against production or `tryon_prod`.** Migrations ship through push → CI/CD → `db:migrate:prod` only. This is a hard rule from `CLAUDE.md`, following the 2026-07-27 incident.
- **`pnpm db:generate` is broken in this repo** — snapshots for migrations 0128–0142 were never committed, so drizzle-kit diffs against the stale `0127_snapshot.json` and regenerates already-applied schema. **Do not run `pnpm db:generate` anywhere in this plan.** Both migrations are hand-written SQL plus a hand-added `_journal.json` entry, exactly as `0142_jobs_queued_at` already is (it has no snapshot either).
- **Credit deduct + job insert must remain one Postgres transaction**, and refunds on terminal failure must remain transactional and idempotent.
- **All `/admin/*` routes double-check admin role**: JWT claim AND `admin_users` row. Do not weaken any `requireAdmin([...])` gate.
- Run `npx biome check --write <files>` before every commit; the pre-commit hook runs `biome-staged` and will reject unformatted code.
- Commit messages end with:
  ```
  Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
  ```

**Reference spec:** `docs/superpowers/specs/2026-08-04-unified-credits-remove-merchant-credits-design.md`

---

## File Structure

**Release 1 — modified**

| File | Responsibility after this plan |
|------|-------------------------------|
| `apps/api/src/modules/merchant/ledger.ts` | Adapter only: resolve `merchantId → merchants.userId`, delegate to `credits/ledger.ts`. Owns no SQL against any balance table. |
| `apps/api/src/modules/merchant/me.routes.ts` | Reads the merchant dashboard balance from `user_credits`. |
| `apps/api/src/modules/merchant/payments.routes.ts` | Razorpay merchant checkout unchanged; credit grant lands in `user_credits` / `credit_ledger`. |
| `apps/api/src/modules/merchant/onboarding.routes.ts` | Creates the `merchants` row only. Grants no credits. |
| `apps/api/src/modules/admin/merchants.routes.ts` | Merchant list/detail/grant read `user_credits`; detail ledger reads `credit_ledger`. No `merchant_credits` seed insert. |
| `apps/api/src/modules/admin/users.routes.ts` | `merchant.creditBalance` removed from the payload (the top-level `balance` is now the only balance). |
| `apps/api/src/modules/admin/config.routes.ts` | No `merchantFreeCredits` defaulting. |
| `apps/api/src/lib/resolution-config.ts` | `getMerchantFreeCredits` and `DEFAULT_MERCHANT_FREE_CREDITS` deleted. |
| `packages/types/src/admin.ts` | `merchantFreeCredits` removed from `SystemConfigBody`. |
| `packages/types/src/jobs.ts` | `MERCHANT_FREE_CREDITS` deleted. |
| `apps/dispatcher/src/job/processor.ts` | `markWidgetFailed` refunds `user_credits` via the merchant's owning user. |
| `apps/dispatcher/src/stream/sweeper.ts` | Single refund branch against `user_credits`. |
| `apps/admin-web/src/pages/SettingsPage.tsx` | "Merchant Free Credits" field removed. |
| `apps/admin-web/src/pages/UsersPage.tsx` | One balance row. The merchant-specific grant modal is deleted — the existing "Adjust credits" stat card already covers it, with broader role access and deduct support. |
| `apps/admin-web/src/types.ts` | `UserMerchant.creditBalance` removed. |
| `apps/api/test/helpers/merchant.ts` | Seeds only `user_credits`. |
| `packages/db/src/schema/merchant.ts` | `signupSource` comment no longer references `merchantFreeCredits` (Task 5); tables removed in Task 9. |

**Release 1 — created**

| File | Responsibility |
|------|----------------|
| `packages/db/src/migrations/0143_merchant_credits_backfill.sql` | Additive, re-runnable backfill of `merchant_credits` into `user_credits` + audit ledger rows. |
| `apps/api/test/integration/merchant-credit-unification.test.ts` | Covers the unified spend, refund idempotency, and no-grant-on-onboarding behaviours. |

**Release 2 — created**

| File | Responsibility |
|------|----------------|
| `packages/db/src/migrations/0144_drop_merchant_credits.sql` | Drops `merchant_credits` and `merchant_credit_ledger`. |

---

## Task 1: Resolve blockers and confirm the baseline

No production code changes. This task exists because three things will break Tasks 2–9 if left unresolved, and one of them needs a human.

**Files:**
- Verify only: `packages/db/src/migrations/meta/_journal.json`
- Verify only: `apps/admin-web/src/pages/UsersPage.tsx`

- [ ] **Step 1: Confirm you are on the right branch with the prerequisite work present**

Run:
```bash
git branch --show-current
git log --oneline -3
```
Expected: branch is `refactor/unified-credits`; the log includes `docs(specs): design for unifying merchant credits into user_credits` and, beneath it, `fix(admin-web): let admins grant merchant tryon credits, fix mislabeled field`.

The second commit matters: `refactor/unified-credits` was branched from `fix/merchant-tryon-credit-grant`, so the Grant UI that Task 7 modifies is already in your working tree. You do **not** need to wait for that branch to merge before implementing.

- [ ] **Step 2: Confirm the Grant UI is present**

Run:
```bash
grep -n "showGrantMerchantCredits" apps/admin-web/src/pages/UsersPage.tsx | head -3
```
Expected: three or more matches (state declaration around line 97, modal around line 1276).

If this returns nothing, you are on the wrong branch — stop and re-branch from `fix/merchant-tryon-credit-grant`.

- [ ] **Step 3: Confirm the migration journal ends at 142**

Run:
```bash
grep -c '"idx"' packages/db/src/migrations/meta/_journal.json
grep -A1 '"idx": 142' packages/db/src/migrations/meta/_journal.json
```
Expected: the last entry is `"idx": 142` with tag `0142_jobs_queued_at`.

If a `143` already exists, someone has added a migration since this plan was written. Renumber the migrations in Tasks 8 and 9 upward accordingly — server index is canonical, your branch yields.

- [ ] **Step 4: Bring up infrastructure and confirm the suite is green before you change anything**

Run:
```bash
pnpm docker:up
pnpm --filter @tryme/types build
cd apps/api && npx vitest run --config vitest.integration.config.ts -- merchant-tryon
```
Expected: PASS. `merchant-tryon.test.ts` currently asserts deductions against `merchant_credits`; it must be green *before* you start so that its failure in Task 2 is meaningful. (This uses `vitest.integration.config.ts` directly, not `pnpm --filter @tryme/api test` — see the Global Constraints note on why the plain script excludes this file.)

If `pnpm --filter @tryme/types build` is skipped, downstream typechecks fail with `TS2305: Module '@tryme/types' has no exported member ...` from a stale `packages/types/dist`.

- [ ] **Step 5: Note the outstanding human gates (no action, just awareness)**

Two things are **not** blockers for implementation but are blockers for *deploying* Release 1:
1. `fix/merchant-tryon-credit-grant` is pushed but unmerged. It must merge to `main` before, or together with, this work.
2. A drizzle snapshot `prevId` fix for `0121`/`0122` is stashed on `main` (`git stash list` on `main` shows `drizzle snapshot chain fix (0121/0122 prevId)`). It is unrelated to this plan and must be landed or dropped separately. Do not pop it into this branch.

No commit for this task.

---

## Task 2: Route merchant spend through `user_credits`

The core change. `merchant/ledger.ts` stops owning a balance; test fixtures stop seeding one.

**Files:**
- Modify: `apps/api/test/helpers/merchant.ts:7-61`
- Modify: `apps/api/src/modules/merchant/ledger.ts` (full rewrite)
- Modify: `apps/api/test/integration/merchant-tryon.test.ts:12-33`
- Modify: `apps/api/test/integration/kiosk-jobs.test.ts:63`
- Modify: `apps/api/test/integration/merchant-kiosk-admin.test.ts:38`
- Modify: `apps/api/test/integration/merchant-catalog.test.ts:39`
- Modify: `apps/api/test/integration/merchant-catalog-generate.test.ts:32`
- Modify: `apps/api/test/integration/merchant-catalog-subcategories.test.ts:31`
- Modify: `apps/api/test/integration/merchant-catalog-bulk-hold.test.ts:114`
- Modify: `apps/api/test/integration/merchant-catalog-bulk-flat-lifecycle.test.ts:126`
- Modify: `apps/api/test/integration/merchant-catalog-publish-pending.test.ts:75`
- Modify: `apps/api/test/integration/merchant-catalog-reconcile-held.test.ts:76,223`
- Modify: `apps/api/test/demo-catalog-tryon.test.ts:109,206`
- Modify: `apps/api/test/integration/merchant-me.test.ts:22`

**Interfaces:**
- Consumes: `atomicDeduct(db, userId, amount, jobId)`, `refund(db, userId, amount, jobId, reason?)`, `adminGrant(db, userId, amount, reason, adminId)` from `apps/api/src/modules/credits/ledger.ts`.
- Produces: `atomicMerchantDeduct(db, merchantId, amount, jobId): Promise<number | undefined>`, `merchantRefund(db, merchantId, amount, jobId, reason?): Promise<void>`, `merchantAdminGrant(db, merchantId, amount, reason, adminId): Promise<void>` — signatures **unchanged** from today, so no call site changes. Also exports `resolveMerchantUserId(db, merchantId): Promise<string>`, used by Task 3 and Task 4.

- [ ] **Step 1: Repoint the shared test helper**

In `apps/api/test/helpers/merchant.ts`, replace lines 7–61 (the whole `createTestMerchant` function) with:

```ts
export async function createTestMerchant(
  app: TestApp,
  opts: {
    isActive?: boolean;
    balance?: number;
    demoData?: boolean;
  } = {},
) {
  const [user] = await app.db
    .insert(schema.users)
    .values({
      email: `merchant-${randomUUID()}@test.com`,
      displayName: 'Test Merchant',
      emailVerified: true,
    })
    .returning();
  if (!user) throw new Error('failed to create test user');

  const [merchant] = await app.db
    .insert(schema.merchants)
    .values({
      companyName: 'Test Co',
      contactName: 'Test Person',
      phone: '0000000000',
      businessAddress: 'Test Address',
      isActive: opts.isActive ?? true,
      demoData: opts.demoData ?? true,
      userId: user.id,
    })
    .returning();
  if (!merchant) throw new Error('failed to create test merchant');

  // One pool: merchant spend (kiosk, android tryon) and personal spend
  // (studio, catalogue generation) both draw from this balance.
  await app.db.insert(schema.userCredits).values({ userId: user.id, balance: opts.balance ?? 100 });

  return {
    merchantId: merchant.id,
    userId: user.id,
    async credits(n: number) {
      await app.db
        .update(schema.userCredits)
        .set({ balance: n })
        .where(eq(schema.userCredits.userId, user.id));
    },
  };
}
```

The `merchantBalance` option and the `merchantCredits(n)` method are gone.

- [ ] **Step 2: Update the three callers of the removed options**

In `apps/api/test/demo-catalog-tryon.test.ts`, at lines 109 and 206, change:
```ts
const merchant = await createTestMerchant(app, { merchantBalance: 100 });
```
to:
```ts
const merchant = await createTestMerchant(app, { balance: 100 });
```

In `apps/api/test/integration/merchant-me.test.ts` at line 22, change:
```ts
const { userId } = await createTestMerchant(app, { merchantBalance: 250 });
```
to:
```ts
const { userId } = await createTestMerchant(app, { balance: 250 });
```

- [ ] **Step 3: Delete the direct `merchantCredits` seed inserts from the remaining fixtures**

These files each contain a standalone `await app.db.insert(schema.merchantCredits).values({...});` statement used only to satisfy the old "the credit helper assumes this row exists" requirement. Delete the whole statement in each:

- `apps/api/test/integration/kiosk-jobs.test.ts:63`
- `apps/api/test/integration/merchant-kiosk-admin.test.ts:38`
- `apps/api/test/integration/merchant-catalog.test.ts:39`
- `apps/api/test/integration/merchant-catalog-generate.test.ts:32`
- `apps/api/test/integration/merchant-catalog-subcategories.test.ts:31`
- `apps/api/test/integration/merchant-catalog-bulk-hold.test.ts:114`
- `apps/api/test/integration/merchant-catalog-bulk-flat-lifecycle.test.ts:126`
- `apps/api/test/integration/merchant-catalog-publish-pending.test.ts:75`
- `apps/api/test/integration/merchant-catalog-reconcile-held.test.ts:76` and `:223`

In `apps/api/test/integration/merchant-tryon.test.ts`, delete lines 28–30:
```ts
  await app.db
    .insert(schema.merchantCredits)
    .values({ merchantId: merchant.id, balance: merchantBalance });
```
and change the `createMerchant` helper signature at line 12 so the balance lands in `user_credits`. The function currently reads `async function createMerchant(app: TestApp, email: string, merchantBalance = 100)`. Rename the parameter and point the existing `userCredits` insert at it — the file already inserts `userCredits`; set its balance to this parameter:
```ts
async function createMerchant(app: TestApp, email: string, balance = 100) {
```
and ensure the `schema.userCredits` insert in that function uses `balance: balance`.

After deleting, verify no stragglers remain:
```bash
grep -rn "merchantCredits\|merchantBalance" apps/api/test/ | grep -v "merchant-onboarding"
```
Expected: no output. (`merchant-onboarding.test.ts` is handled in Task 5.)

- [ ] **Step 4: Run the tests to verify they now fail**

Run:
```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts -- merchant-tryon
```
Expected: FAIL. Multiple assertions fail with a 402 / `INSUFFICIENT_CREDITS`, because `atomicMerchantDeduct` still updates `merchant_credits` and no such row exists any more.

- [ ] **Step 5: Rewrite `merchant/ledger.ts` as an adapter**

Replace the entire contents of `apps/api/src/modules/merchant/ledger.ts` with:

```ts
import type { DB } from '@tryme/db';
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { AppError } from '../../lib/errors.js';
import { adminGrant, atomicDeduct, refund } from '../credits/ledger.js';

/**
 * A merchant is a tag on a user, not a separate financial entity: there is one
 * credit pool per human, keyed by `users.id`. These helpers keep their
 * merchantId-shaped signatures so call sites (kiosk + android tryon job
 * creation, cancellation refunds, admin grants) stay unchanged, and resolve
 * the owning user here — the single place that mapping lives.
 */
export async function resolveMerchantUserId(db: DB, merchantId: string): Promise<string> {
  const [row] = await db
    .select({ userId: schema.merchants.userId })
    .from(schema.merchants)
    .where(eq(schema.merchants.id, merchantId))
    .limit(1);
  // merchants.user_id is NOT NULL, so a missing userId means a missing merchant.
  // Throw rather than no-op: a charge that cannot be attributed must fail the
  // enclosing transaction, not silently succeed for free.
  if (!row?.userId) throw new AppError('NOT_FOUND', 404, 'merchant not found');
  return row.userId;
}

export async function atomicMerchantDeduct(
  db: DB,
  merchantId: string,
  amount: number,
  jobId: string,
) {
  const userId = await resolveMerchantUserId(db, merchantId);
  return atomicDeduct(db, userId, amount, jobId);
}

export async function merchantRefund(
  db: DB,
  merchantId: string,
  amount: number,
  jobId: string,
  reason = 'REFUND',
) {
  const userId = await resolveMerchantUserId(db, merchantId);
  await refund(db, userId, amount, jobId, reason);
}

export async function merchantAdminGrant(
  db: DB,
  merchantId: string,
  amount: number,
  reason: string,
  adminId: string,
) {
  const userId = await resolveMerchantUserId(db, merchantId);
  await adminGrant(db, userId, amount, reason, adminId);
}
```

Two behaviour changes come for free and are intended: merchant spend now increments the `creditsDeductedTotal` / `creditsRefundedTotal` Prometheus counters it previously bypassed, and `merchantRefund` inherits the `credit_ledger_job_reason_uniq` partial unique index instead of the previous racy SELECT-then-INSERT.

- [ ] **Step 6: Run the tests to verify they pass**

Run:
```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts -- merchant-tryon
cd apps/api && npx vitest run --config vitest.integration.config.ts -- kiosk-jobs
```
Expected: PASS for both.

- [ ] **Step 7: Run the full API suite (unit + integration)**

Run:
```bash
pnpm --filter @tryme/api test
cd apps/api && npx vitest run --config vitest.integration.config.ts
```
Expected: the unit run (first command) PASSes outright. The integration run (second command, ~6 minutes — `fileParallelism` is disabled) has a known-flaky pre-existing set of failures unrelated to credits (see Global Constraints — the failure count varies run to run). Beyond that set, expect new failures confined to `merchant-onboarding.test.ts` (free-credit assertions, fixed in Task 5) and any admin merchant/user route tests reading `creditBalance` (fixed in Task 3). For any other failing file, re-run it alone before concluding it's a regression; note exactly which ones reproduce in isolation — they must all be green by the end of Task 5.

- [ ] **Step 8: Commit**

```bash
npx biome check --write apps/api/src/modules/merchant/ledger.ts apps/api/test/
git add apps/api/src/modules/merchant/ledger.ts apps/api/test/
git commit -m "$(cat <<'EOF'
refactor(api): route merchant credit spend through user_credits

merchant/ledger.ts becomes a thin adapter that resolves merchants.userId
and delegates to credits/ledger.ts. Call-site signatures are unchanged.
Merchant spend now also records to the shared Prometheus credit counters
and picks up credit_ledger's (job_id, reason) unique index for refund
idempotency.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Repoint admin and merchant read paths

**Files:**
- Modify: `apps/api/src/modules/merchant/me.routes.ts:11-20`
- Modify: `apps/api/src/modules/admin/merchants.routes.ts:128-141,255-279,398-404`
- Modify: `apps/api/src/modules/admin/users.routes.ts:155-173`
- Test: `apps/api/test/integration/merchant-me.test.ts`

**Interfaces:**
- Consumes: `schema.userCredits`, `schema.creditLedger` from `@tryme/db`.
- Produces: `GET /v1/merchant/me` returns `{ displayName, email, balance }` (shape unchanged, source changed). `GET /admin/merchants` and `GET /admin/merchants/:id` still return `creditBalance`, now sourced from `user_credits`. `GET /admin/users/:id` no longer returns `merchant.creditBalance`.

- [ ] **Step 1: Update the merchant dashboard balance test**

`apps/api/test/integration/merchant-me.test.ts` line 22 already seeds `{ balance: 250 }` after Task 2. Confirm the assertion expects `250`:

```bash
grep -n "250" apps/api/test/integration/merchant-me.test.ts
```
Expected: the seed and an assertion such as `expect(body.balance).toBe(250)`. If the assertion expects a different number, change it to `250`.

- [ ] **Step 2: Run it to verify it fails**

Run:
```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts -- merchant-me
```
Expected: FAIL — `balance` comes back `0`, because `me.routes.ts` still `leftJoin`s `merchant_credits`, which now has no row for this merchant.

- [ ] **Step 3: Repoint `me.routes.ts`**

In `apps/api/src/modules/merchant/me.routes.ts`, replace the query at lines 11–20 with:

```ts
    const [row] = await app.db
      .select({
        displayName: schema.users.displayName,
        email: schema.users.email,
        balance: sql<number>`COALESCE(${schema.userCredits.balance}, 0)`,
      })
      .from(schema.merchants)
      .innerJoin(schema.users, eq(schema.users.id, schema.merchants.userId))
      .leftJoin(schema.userCredits, eq(schema.userCredits.userId, schema.merchants.userId))
      .where(eq(schema.merchants.id, merchantId));
```

- [ ] **Step 4: Run it to verify it passes**

Run:
```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts -- merchant-me
```
Expected: PASS.

- [ ] **Step 5: Repoint the admin merchant list**

In `apps/api/src/modules/admin/merchants.routes.ts`, in the list query, change the selected column at line 134 from:
```ts
          creditBalance: schema.merchantCredits.balance,
```
to:
```ts
          creditBalance: schema.userCredits.balance,
```
and change the `leftJoin` at lines 138–141 from:
```ts
        .leftJoin(
          schema.merchantCredits,
          eq(schema.merchants.id, schema.merchantCredits.merchantId),
        )
```
to:
```ts
        .leftJoin(schema.userCredits, eq(schema.merchants.userId, schema.userCredits.userId))
```

- [ ] **Step 6: Repoint the admin merchant detail and its ledger**

In the same file, in the detail query, change line 259 from:
```ts
          creditBalance: schema.merchantCredits.balance,
```
to:
```ts
          creditBalance: schema.userCredits.balance,
```
and the `leftJoin` at lines 265–268 from:
```ts
        .leftJoin(
          schema.merchantCredits,
          eq(schema.merchants.id, schema.merchantCredits.merchantId),
        )
```
to:
```ts
        .leftJoin(schema.userCredits, eq(schema.merchants.userId, schema.userCredits.userId))
```

Then replace the ledger query at lines 274–279:
```ts
      const ledger = await app.db
        .select()
        .from(schema.merchantCreditLedger)
        .where(eq(schema.merchantCreditLedger.merchantId, id))
        .orderBy(desc(schema.merchantCreditLedger.createdAt))
        .limit(20);
```
with:
```ts
      const ledger = await app.db
        .select()
        .from(schema.creditLedger)
        .where(eq(schema.creditLedger.userId, client.userId))
        .orderBy(desc(schema.creditLedger.createdAt))
        .limit(20);
```

This requires `userId` on the detail row. Add it to the detail `select` object alongside `creditBalance`:
```ts
          userId: schema.merchants.userId,
```

The ledger row shape changes from `{ merchantId, ... }` to `{ userId, ... }`. Check whether the admin UI reads `merchantId` off these rows:
```bash
grep -rn "merchantId" apps/admin-web/src/pages/MerchantsPage.tsx | head
```
If it does, update those references to `userId`; if it only renders `delta`, `reason`, and `createdAt`, no UI change is needed.

- [ ] **Step 7: Repoint the admin grant response**

In the same file, replace the balance read at lines 398–402:
```ts
      const [credits] = await app.db
        .select({ balance: schema.merchantCredits.balance })
        .from(schema.merchantCredits)
        .where(eq(schema.merchantCredits.merchantId, id))
        .limit(1);
```
with:
```ts
      const [credits] = await app.db
        .select({ balance: schema.userCredits.balance })
        .from(schema.merchants)
        .innerJoin(schema.userCredits, eq(schema.userCredits.userId, schema.merchants.userId))
        .where(eq(schema.merchants.id, id))
        .limit(1);
```

- [ ] **Step 8: Drop the `merchant_credits` seed from admin merchant creation**

In the same file, delete lines 211–214 entirely:
```ts
        await tx.insert(schema.merchantCredits).values({
          merchantId: created.id,
          balance: 0,
        });
```
The optional `initialCredits` grant immediately below still works — `merchantAdminGrant` upserts `user_credits` via `adminGrant`.

- [ ] **Step 9: Remove `creditBalance` from the admin user detail**

In `apps/api/src/modules/admin/users.routes.ts`, delete line 166:
```ts
          creditBalance: schema.merchantCredits.balance,
```
and delete the `leftJoin` at lines 169–172:
```ts
        .leftJoin(
          schema.merchantCredits,
          eq(schema.merchantCredits.merchantId, schema.merchants.id),
        )
```
The top-level `balance` field on this endpoint (already sourced from `user_credits`) is now the only balance, which is the point.

- [ ] **Step 10: Typecheck and run the affected suites**

Run:
```bash
pnpm --filter @tryme/api typecheck
cd apps/api && npx vitest run --config vitest.integration.config.ts -- merchant-me
cd apps/api && npx vitest run --config vitest.integration.config.ts -- merchant-kiosk-admin
```
Expected: typecheck clean, both suites PASS.

- [ ] **Step 11: Commit**

```bash
npx biome check --write apps/api/src/modules/merchant/me.routes.ts apps/api/src/modules/admin/merchants.routes.ts apps/api/src/modules/admin/users.routes.ts
git add apps/api/src/modules/merchant/me.routes.ts apps/api/src/modules/admin/merchants.routes.ts apps/api/src/modules/admin/users.routes.ts
git commit -m "$(cat <<'EOF'
refactor(api): read merchant balances from user_credits

Merchant dashboard, admin merchant list/detail/grant, and the admin user
detail all now source the balance and ledger from the unified pool. Drops
the merchant_credits seed insert on admin merchant creation.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Land merchant Razorpay payments in `user_credits`

The merchant checkout, its own `MERCHANT_PLAN_BILLING` pricing, GST maths, signature verification, and webhook handling are all unchanged. Only the destination of the credit grant moves.

**Files:**
- Modify: `apps/api/src/modules/merchant/payments.routes.ts:37-75,173-178`

**Interfaces:**
- Consumes: `resolveMerchantUserId(db, merchantId)` from `apps/api/src/modules/merchant/ledger.ts` (Task 2).
- Produces: `POST /v1/merchant/payments/verify` returns `{ ok, alreadyCredited, balance }` — shape unchanged.

- [ ] **Step 1: Rewrite `grantMerchantCredits`**

In `apps/api/src/modules/merchant/payments.routes.ts`, replace the function at lines 37–75 with:

```ts
// Idempotent credit grant to a merchant's (single, unified) credit pool + ledger entry.
async function grantMerchantCredits(
  app: FastifyInstance,
  merchantId: string,
  razorpayOrderId: string,
  razorpayPaymentId: string,
  credits: number,
  signature?: string,
): Promise<void> {
  // biome-ignore lint/suspicious/noExplicitAny: DB type narrowing
  const userId = await resolveMerchantUserId(app.db as any, merchantId);

  await app.db.transaction(async (tx) => {
    await tx
      .update(schema.merchantPayments)
      .set({
        status: 'paid',
        razorpayPaymentId,
        ...(signature ? { razorpaySignature: signature } : {}),
        paidAt: new Date(),
      })
      .where(eq(schema.merchantPayments.razorpayOrderId, razorpayOrderId));

    await tx
      .insert(schema.userCredits)
      .values({ userId, balance: credits })
      .onConflictDoUpdate({
        target: schema.userCredits.userId,
        set: {
          balance: sql`${schema.userCredits.balance} + ${credits}`,
          updatedAt: new Date(),
        },
      });

    await tx.insert(schema.creditLedger).values({
      userId,
      delta: credits,
      reason: 'PAYMENT',
      adminId: null,
    });
  });
}
```

Add the import at the top of the file, after the existing `AppError` import:
```ts
import { resolveMerchantUserId } from './ledger.js';
```

Replay protection is unchanged in shape: the `payment.status === 'paid'` guard in both the verify route and the webhook still prevents double-crediting.

- [ ] **Step 2: Repoint the post-verify balance read**

Replace lines 173–176:
```ts
      const [bal] = await app.db
        .select({ balance: schema.merchantCredits.balance })
        .from(schema.merchantCredits)
        .where(eq(schema.merchantCredits.merchantId, clientId));
```
with:
```ts
      const [bal] = await app.db
        .select({ balance: schema.userCredits.balance })
        .from(schema.merchants)
        .innerJoin(schema.userCredits, eq(schema.userCredits.userId, schema.merchants.userId))
        .where(eq(schema.merchants.id, clientId));
```

- [ ] **Step 3: Verify no `merchantCredits` references remain in the API**

Run:
```bash
grep -rn "merchantCredits\|merchantCreditLedger" apps/api/src/
```
Expected: no output.

- [ ] **Step 4: Typecheck**

Run:
```bash
pnpm --filter @tryme/api typecheck
```
Expected: clean.

- [ ] **Step 5: Commit**

```bash
npx biome check --write apps/api/src/modules/merchant/payments.routes.ts
git add apps/api/src/modules/merchant/payments.routes.ts
git commit -m "$(cat <<'EOF'
refactor(api): land merchant Razorpay purchases in user_credits

Merchant checkout keeps its own MERCHANT_PLAN_BILLING pricing, GST maths,
signature verification, and webhook handling. Only the credit destination
moves to the unified pool.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Remove `merchantFreeCredits` end to end

A user gets one free-trial grant, at signup, from the `credit_plans` row with `slug: 'free'`. Becoming a merchant is a tag, not a second entitlement.

**Files:**
- Modify: `apps/api/test/merchant-onboarding.test.ts:140-180`
- Modify: `apps/api/src/modules/merchant/onboarding.routes.ts:7,47,89-99`
- Modify: `apps/api/src/lib/resolution-config.ts:1-8,34,120-134`
- Modify: `apps/api/src/modules/admin/config.routes.ts:8,41`
- Modify: `packages/types/src/admin.ts:139-141`
- Modify: `packages/types/src/jobs.ts:119-120`
- Modify: `packages/db/src/schema/merchant.ts:33-38`
- Modify: `apps/admin-web/src/pages/SettingsPage.tsx:617,667,679-680,796,1638-1678`

**Interfaces:**
- Produces: `SystemConfigBody` no longer accepts `merchantFreeCredits`. `GET /admin/config` no longer returns it. `POST /v1/merchant/onboarding` creates a `merchants` row and grants no credits.

- [ ] **Step 1: Rewrite the onboarding free-credit assertions**

In `apps/api/test/merchant-onboarding.test.ts`, find the two tests asserting granted credits (around lines 140–180, each querying `schema.merchantCredits`). Replace both blocks so they assert that onboarding grants nothing. The replacement test:

```ts
  it('grants no credits on merchant onboarding — the user already has their signup free trial', async () => {
    const { token, userId } = await createDeviceUser(app);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/merchant/onboarding',
      headers: { authorization: `Bearer ${token}` },
      payload: { companyName: 'Acme', phone: '9999999999' },
    });
    expect(res.statusCode).toBe(201);

    const [credits] = await app.db
      .select({ balance: schema.userCredits.balance })
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, userId));

    // Whatever the user had before onboarding is what they have after.
    expect(credits?.balance ?? 0).toBe(0);

    const ledger = await app.db
      .select()
      .from(schema.creditLedger)
      .where(eq(schema.creditLedger.userId, userId));
    expect(ledger.filter((r) => r.reason === 'FREE_TRIAL')).toHaveLength(0);
  });
```

Adapt `createDeviceUser` and the payload to whatever the surrounding file already uses — read the existing tests in that file first and match their setup helper and request shape exactly. Delete the old `merchantCredits`-based assertions entirely.

- [ ] **Step 2: Run it to verify it fails**

Run:
```bash
pnpm --filter @tryme/api test -- merchant-onboarding
```
Expected: FAIL — the route still calls `getMerchantFreeCredits` and inserts into `merchant_credits` (which no longer has a fixture row), or grants a nonzero amount when config is set.

- [ ] **Step 3: Strip the grant from the onboarding route**

In `apps/api/src/modules/merchant/onboarding.routes.ts`:

Delete the import at line 7:
```ts
import { getMerchantFreeCredits } from '../../lib/resolution-config.js';
```

Delete line 47:
```ts
      const freeCredits = await getMerchantFreeCredits(app);
```

Delete lines 89–99 entirely:
```ts
        // Every merchant credit helper assumes this row exists.
        await tx
          .insert(schema.merchantCredits)
          .values({ merchantId: created.id, balance: freeCredits });
        if (freeCredits > 0) {
          await tx.insert(schema.merchantCreditLedger).values({
            merchantId: created.id,
            delta: freeCredits,
            reason: 'FREE_TRIAL',
          });
        }
```

Also update the doc comment above the route (lines 15–21), which says onboarding "creates an active, zero-review, 0-credit merchant". Replace that clause with "creates an active, zero-review merchant profile that shares the user's existing credit balance".

- [ ] **Step 4: Delete the config reader**

In `apps/api/src/lib/resolution-config.ts`:
- Remove `MERCHANT_FREE_CREDITS,` from the `@tryme/types` import block at lines 1–8.
- Delete line 34: `export const DEFAULT_MERCHANT_FREE_CREDITS = MERCHANT_FREE_CREDITS;`
- Delete the entire `getMerchantFreeCredits` function and its doc comment (lines 120–134).

- [ ] **Step 5: Delete the config route defaulting**

In `apps/api/src/modules/admin/config.routes.ts`:
- Remove `DEFAULT_MERCHANT_FREE_CREDITS,` from the import block at line 8.
- Delete line 41: `cfg.merchantFreeCredits = cfg.merchantFreeCredits ?? DEFAULT_MERCHANT_FREE_CREDITS;`

- [ ] **Step 6: Delete the shared types**

In `packages/types/src/admin.ts`, delete lines 139–141:
```ts
  // Credits auto-granted to a new merchant on self-serve android onboarding
  // (POST /v1/merchant/onboarding). See getMerchantFreeCredits().
  merchantFreeCredits: z.number().int().min(0).max(100_000).optional(),
```

In `packages/types/src/jobs.ts`, delete lines 119–120:
```ts
/** Fallback default — the actual granted amount is admin-configurable, see getMerchantFreeCredits(). */
export const MERCHANT_FREE_CREDITS = 0;
```

- [ ] **Step 7: Update the now-stale schema comment**

In `packages/db/src/schema/merchant.ts`, replace the `signupSource` comment at lines 33–38 with:

```ts
  // 'admin'          -- created through POST /admin/merchants (an admin IS the approval)
  // 'android_google' -- self-serve Google signup from the Android app via
  //                    POST /v1/merchant/onboarding. No separate free-credit
  //                    grant: the user already received their signup free trial,
  //                    and merchant spend draws from that same user_credits
  //                    balance, so watch for accounts burning through it via
  //                    GPU abuse.
```

- [ ] **Step 8: Rebuild types and verify the API compiles**

Run:
```bash
pnpm --filter @tryme/types build
pnpm --filter @tryme/api typecheck
```
Expected: both clean. The types rebuild is mandatory — `apps/api` resolves `@tryme/types` from `dist`, so skipping it produces a misleading `TS2305`.

- [ ] **Step 9: Remove the admin Settings field**

In `apps/admin-web/src/pages/SettingsPage.tsx`:
- Delete line 617: `const [merchantFreeCredits, setMerchantFreeCredits] = useState(0);`
- Delete line 667: `merchantFreeCredits?: number;` from the `/admin/config` response type.
- Delete lines 679–680:
  ```ts
        if (typeof cfg.merchantFreeCredits === 'number')
          setMerchantFreeCredits(cfg.merchantFreeCredits);
  ```
- Delete line 796: `merchantFreeCredits,` from the PATCH body.
- Delete the entire "Merchant Free Credits" block, which starts at line 1638 with `<div style={{ marginTop: 24, marginBottom: 8 }}>` containing `Merchant Free Credits` and ends with the matching `</div>` after the `credits / new merchant` span (around line 1678). Delete the whole outer `<div>` element, not just its inner contents.

- [ ] **Step 10: Verify no references remain and typecheck the admin app**

Run:
```bash
grep -rn "merchantFreeCredits\|MERCHANT_FREE_CREDITS\|getMerchantFreeCredits" apps/ packages/
cd apps/admin-web && npx tsc -b --noEmit && cd ../..
```
Expected: `grep` returns no output; `tsc` clean.

- [ ] **Step 11: Run the onboarding test to verify it passes**

Run:
```bash
pnpm --filter @tryme/api test -- merchant-onboarding
```
Expected: PASS.

- [ ] **Step 12: Run the full API suite (unit + integration)**

Run:
```bash
pnpm --filter @tryme/api test
cd apps/api && npx vitest run --config vitest.integration.config.ts
```
Expected: unit PASSes outright. Integration shows no failures beyond the known-flaky pre-existing set (see Global Constraints) — re-run any other failing file alone before treating it as real. Every deferred failure from Task 2 Step 7 should now be resolved.

- [ ] **Step 13: Commit**

```bash
npx biome check --write apps/api/src packages/types/src apps/admin-web/src/pages/SettingsPage.tsx packages/db/src/schema/merchant.ts
git add apps/api packages/types packages/db/src/schema/merchant.ts apps/admin-web/src/pages/SettingsPage.tsx
git commit -m "$(cat <<'EOF'
refactor: remove merchantFreeCredits, merchants get no second free grant

A user receives one free-trial grant at signup from the 'free' credit_plans
row. Merchant onboarding is a tag, not a second entitlement, so it now
creates the profile row and grants nothing. Removes the config knob, its
reader, its Zod field, and its admin Settings input.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: Unify the dispatcher's refund paths

**Files:**
- Modify: `apps/dispatcher/src/job/processor.ts:2173-2230`
- Modify: `apps/dispatcher/src/stream/sweeper.ts:139-188`

**Interfaces:**
- Consumes: `schema.merchants`, `schema.userCredits`, `schema.creditLedger` from `@tryme/db`.
- Produces: no exported signature changes. `markWidgetFailed` keeps its `(cfg, jobId, merchantId, creditsCharged, stream, messageId, errorCode, log, startedAt)` signature; `failAndRefund` keeps `(db, pub, job, errorCode, log)`.

The dispatcher cannot import from `apps/api`, so the `merchantId → userId` lookup is written inline in both files, matching the existing inline-SQL style of these functions.

- [ ] **Step 1: Repoint `markWidgetFailed` in the processor**

In `apps/dispatcher/src/job/processor.ts`, replace the refund transaction at lines 2186–2205:

```ts
  // Refund widget credits (idempotent)
  await db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(schema.merchantCreditLedger)
      .where(
        and(
          eq(schema.merchantCreditLedger.jobId, jobId),
          eq(schema.merchantCreditLedger.reason, 'JOB_FAIL_REFUND'),
        ),
      );
    if (existing.length) return;
    await tx
      .update(schema.merchantCredits)
      .set({ balance: sql`${schema.merchantCredits.balance} + ${creditsCharged}` })
      .where(eq(schema.merchantCredits.merchantId, merchantId));
    await tx
      .insert(schema.merchantCreditLedger)
      .values({ merchantId, delta: creditsCharged, reason: 'JOB_FAIL_REFUND', jobId });
  });
```

with:

```ts
  // Refund to the merchant's owning user — one credit pool per human. Kiosk jobs
  // carry jobs.user_id = null (the shopper is anonymous), so the billing owner is
  // resolved through the merchants row rather than read off the job.
  await db.transaction(async (tx) => {
    const [owner] = await tx
      .select({ userId: schema.merchants.userId })
      .from(schema.merchants)
      .where(eq(schema.merchants.id, merchantId))
      .limit(1);
    if (!owner?.userId) {
      log.error({ jobId, merchantId }, 'refund skipped — merchant has no owning user');
      return;
    }
    const existing = await tx
      .select()
      .from(schema.creditLedger)
      .where(
        and(
          eq(schema.creditLedger.jobId, jobId),
          eq(schema.creditLedger.reason, 'JOB_FAIL_REFUND'),
        ),
      );
    if (existing.length) return;
    await tx
      .update(schema.userCredits)
      .set({ balance: sql`${schema.userCredits.balance} + ${creditsCharged}` })
      .where(eq(schema.userCredits.userId, owner.userId));
    await tx
      .insert(schema.creditLedger)
      .values({ userId: owner.userId, delta: creditsCharged, reason: 'JOB_FAIL_REFUND', jobId });
  });
```

Then update the log line at line 2229 from:
```ts
  log.warn({ jobId, errorCode }, 'widget job FAILED — widget credits refunded');
```
to:
```ts
  log.warn({ jobId, errorCode }, 'widget job FAILED — credits refunded');
```

Leave everything else in the function — the `transitionJob` call, the `sse:events:widget:${merchantId}` publish, the `webhooks:outbound` XADD, and the XACK — exactly as it is.

- [ ] **Step 2: Collapse the sweeper's two branches into one**

In `apps/dispatcher/src/stream/sweeper.ts`, replace the transaction body at lines 146–185 with:

```ts
  await db.transaction(async (tx) => {
    // One credit pool per human. A job's billing owner is its user_id when set;
    // kiosk jobs have user_id = null and are billed to the merchant's owning user.
    let userId = job.userId;
    if (!userId && job.merchantId) {
      const [owner] = await tx
        .select({ userId: schema.merchants.userId })
        .from(schema.merchants)
        .where(eq(schema.merchants.id, job.merchantId))
        .limit(1);
      userId = owner?.userId ?? null;
    }
    if (!userId) return;

    const existing = await tx
      .select()
      .from(schema.creditLedger)
      .where(eq(schema.creditLedger.jobId, job.id));
    if (existing.some((e) => e.reason === 'JOB_FAIL_REFUND')) return;
    await tx
      .update(schema.userCredits)
      .set({ balance: sql`${schema.userCredits.balance} + ${job.creditsCharged}` })
      .where(eq(schema.userCredits.userId, userId));
    await tx.insert(schema.creditLedger).values({
      userId,
      delta: job.creditsCharged,
      reason: 'JOB_FAIL_REFUND',
      jobId: job.id,
    });
  });
```

The `transitionJob` call on line 187 stays unchanged.

If `and` is now unused in `sweeper.ts`, remove it from the `drizzle-orm` import — Biome will flag it.

- [ ] **Step 3: Verify no `merchantCredits` references remain in the dispatcher**

Run:
```bash
grep -rn "merchantCredits\|merchantCreditLedger" apps/dispatcher/
```
Expected: no output.

- [ ] **Step 4: Typecheck and run the dispatcher suite**

Run:
```bash
pnpm --filter @tryme/dispatcher typecheck
pnpm --filter @tryme/dispatcher test
```
Expected: both clean/PASS.

- [ ] **Step 5: Commit**

```bash
npx biome check --write apps/dispatcher/src/job/processor.ts apps/dispatcher/src/stream/sweeper.ts
git add apps/dispatcher/src/job/processor.ts apps/dispatcher/src/stream/sweeper.ts
git commit -m "$(cat <<'EOF'
refactor(dispatcher): refund merchant job failures to user_credits

markWidgetFailed and the stuck-job sweeper now resolve the merchant's
owning user and refund the unified pool, collapsing the duplicated
merchant/user refund branches into one.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Remove the now-redundant merchant grant UI in admin-web

This task **reverts** the UI added on `fix/merchant-tryon-credit-grant`, and that is the correct outcome. That branch existed to expose the orphaned `merchant_credits` pool. With one pool, the page already has a complete grant path: the "Credit balance" stat card (`UsersPage.tsx:753`) opens the existing "Adjust credits" modal, which posts to `/admin/credits/grant` and `/admin/credits/deduct`.

That existing path is strictly better than the merchant-specific one: `/admin/credits/grant` is gated to `SUPER_ADMIN, MODERATOR, ADMIN` (`apps/api/src/modules/admin/credits.routes.ts:11`), whereas `/admin/merchants/:id/credits` is `SUPER_ADMIN` only. It also supports deduct, which the merchant modal never did. So the merchant modal is deleted rather than rewired — nothing is lost.

`POST /admin/merchants/:id/credits` stays on the server: it is still used by `MerchantsPage.tsx` and by the `initialCredits` path in merchant creation.

**Files:**
- Modify: `apps/admin-web/src/pages/UsersPage.tsx:97-100,455-480,903-925,1276-1345`
- Modify: `apps/admin-web/src/types.ts`

**Interfaces:**
- Produces: no exported interface changes. `UserMerchant` loses its `creditBalance` field.

- [ ] **Step 1: Delete the duplicate KV row**

In `apps/admin-web/src/pages/UsersPage.tsx`, delete the entire `<KV k="Tryon credits" ... />` element at lines 903–925 — from the opening `<KV` through its closing `/>`.

- [ ] **Step 2: Delete the merchant-credits grant modal**

Delete the whole `{showGrantMerchantCredits && u.merchant && ( ... )}` block, which starts at line 1276 and ends with its matching `)}`. It is bounded by the `{showGrantMerchant && (` block that follows it — do not delete that one; "Grant merchant access" is a different feature (it turns a user into a merchant) and must stay.

- [ ] **Step 3: Delete the modal's state and handlers**

Delete the four state declarations at lines 97–100:
```tsx
  const [showGrantMerchantCredits, setShowGrantMerchantCredits] = useState(false);
  const [grantMerchantCreditsAmount, setGrantMerchantCreditsAmount] = useState('');
  const [grantMerchantCreditsReason, setGrantMerchantCreditsReason] = useState('');
  const [grantingMerchantCredits, setGrantingMerchantCredits] = useState(false);
```

Delete the `openGrantMerchantCredits` function and the entire `handleGrantMerchantCredits` async function (they sit together immediately after `handleGrantMerchant`, around lines 455–480).

- [ ] **Step 4: Remove `creditBalance` from the shared type**

In `apps/admin-web/src/types.ts`, delete the `creditBalance: number | null;` line from the `UserMerchant` interface.

- [ ] **Step 5: Verify nothing dangles and typecheck**

Run:
```bash
grep -n "GrantMerchantCredits\|creditBalance" apps/admin-web/src/pages/UsersPage.tsx apps/admin-web/src/types.ts
cd apps/admin-web && npx tsc -b --noEmit && cd ../..
```
Expected: `grep` returns no output; `tsc` clean. An unused-import or unused-variable error here means a fragment of the deleted feature survived — remove it.

`apps/admin-web/src/pages/MerchantsPage.tsx` may still reference `creditBalance`; that is correct and must be left alone. `/admin/merchants` still returns the field, now sourced from `user_credits` (Task 3).

- [ ] **Step 6: Commit**

```bash
npx biome check --write apps/admin-web/src/pages/UsersPage.tsx apps/admin-web/src/types.ts
git add apps/admin-web/src/pages/UsersPage.tsx apps/admin-web/src/types.ts
git commit -m "$(cat <<'EOF'
refactor(admin-web): drop the merchant-specific credit grant UI

With one unified pool the "Tryon credits" row duplicated the personal
balance, and its grant modal duplicated the existing "Adjust credits"
flow — which is gated more broadly (SUPER_ADMIN/MODERATOR/ADMIN) and also
supports deduct. Reverts the UI added for the now-removed second pool.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Backfill migration (Release 1, final task)

Hand-written. **Do not run `pnpm db:generate`** — see Global Constraints.

**Files:**
- Create: `packages/db/src/migrations/0143_merchant_credits_backfill.sql`
- Modify: `packages/db/src/migrations/meta/_journal.json`
- Create: `apps/api/test/integration/merchant-credit-unification.test.ts`

**Interfaces:**
- Produces: every merchant's `merchant_credits.balance` folded into their owning user's `user_credits.balance`, with one `credit_ledger` row per merchant at `reason = 'MERCHANT_CREDITS_MIGRATION'`.

- [ ] **Step 1: Write the migration SQL**

Create `packages/db/src/migrations/0143_merchant_credits_backfill.sql`:

```sql
-- Fold each merchant's separate credit balance into the owning user's personal
-- balance. A merchant is a tag on a user, not a separate financial entity, so
-- from here on kiosk and android-tryon spend draws from user_credits like
-- everything else.
--
-- merchants.user_id is UNIQUE, so there is at most one merchant per user and no
-- aggregation is needed. Balances are added, never replaced -- a merchant who
-- also has a personal balance keeps both.
--
-- Re-runnable: the NOT EXISTS guard keys off the audit ledger row this migration
-- writes, so applying it twice cannot double-credit. That matters because this
-- moves real money and the hand-written journal path has no snapshot to diff
-- against.

INSERT INTO "user_credits" ("user_id", "balance")
SELECT m."user_id", mc."balance"
FROM "merchant_credits" mc
JOIN "merchants" m ON m."id" = mc."merchant_id"
WHERE mc."balance" <> 0
  AND NOT EXISTS (
    SELECT 1 FROM "credit_ledger" cl
    WHERE cl."user_id" = m."user_id"
      AND cl."reason" = 'MERCHANT_CREDITS_MIGRATION'
  )
ON CONFLICT ("user_id") DO UPDATE
  SET "balance" = "user_credits"."balance" + EXCLUDED."balance",
      "updated_at" = now();

INSERT INTO "credit_ledger" ("user_id", "delta", "reason")
SELECT m."user_id", mc."balance", 'MERCHANT_CREDITS_MIGRATION'
FROM "merchant_credits" mc
JOIN "merchants" m ON m."id" = mc."merchant_id"
WHERE mc."balance" <> 0
  AND NOT EXISTS (
    SELECT 1 FROM "credit_ledger" cl
    WHERE cl."user_id" = m."user_id"
      AND cl."reason" = 'MERCHANT_CREDITS_MIGRATION'
  );
```

- [ ] **Step 2: Add the journal entry**

In `packages/db/src/migrations/meta/_journal.json`, append to the `entries` array, immediately after the `"idx": 142` object (mind the comma on the preceding closing brace):

```json
    {
      "idx": 143,
      "version": "7",
      "when": 1785624000000,
      "tag": "0143_merchant_credits_backfill",
      "breakpoints": true
    }
```

No `meta/0143_snapshot.json` is created. Snapshots have been absent since 0128; `0142_jobs_queued_at` has none either.

- [ ] **Step 3: Write the integration test**

Create `apps/api/test/integration/merchant-credit-unification.test.ts`. Model the harness setup on `apps/api/test/integration/merchant-tryon.test.ts` — read that file first and copy its `beforeAll`/`afterAll` and app-building boilerplate verbatim, then use these test bodies:

```ts
  it('merchant tryon deducts from user_credits, not a separate pool', async () => {
    const merchant = await createTestMerchant(app, { balance: 100 });
    const cost = await getTryonCreditCost(app);

    const jobId = await createMerchantTryonJob(app, {
      merchantId: merchant.merchantId,
      merchantUserId: merchant.userId,
      upperGarmentKey: 'test/garment.jpg',
      customerPhotoKey: 'test/photo.jpg',
      workflowTemplateId: workflowTemplateId,
    });
    expect(jobId).toBeTruthy();

    const [credits] = await app.db
      .select({ balance: schema.userCredits.balance })
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, merchant.userId));
    expect(credits?.balance).toBe(100 - cost);
  });

  it('kiosk jobs bill the merchant owner but leave jobs.user_id null', async () => {
    const merchant = await createTestMerchant(app, { balance: 100 });

    const jobId = await createKioskJob(app, {
      merchantId: merchant.merchantId,
      upperGarmentKey: 'test/garment.jpg',
      customerPhotoKey: 'test/photo.jpg',
      cost: 10,
      workflowTemplateId: workflowTemplateId,
    });

    const [job] = await app.db
      .select({ userId: schema.jobs.userId })
      .from(schema.jobs)
      .where(eq(schema.jobs.id, jobId));
    // The shopper is anonymous — the job has no owning user, only a payer.
    expect(job?.userId).toBeNull();

    const [credits] = await app.db
      .select({ balance: schema.userCredits.balance })
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, merchant.userId));
    expect(credits?.balance).toBe(90);
  });

  it('refunding a merchant job twice credits it only once', async () => {
    const merchant = await createTestMerchant(app, { balance: 100 });
    const jobId = randomUUID();

    await merchantRefund(app.db, merchant.merchantId, 25, jobId, 'JOB_FAIL_REFUND');
    await merchantRefund(app.db, merchant.merchantId, 25, jobId, 'JOB_FAIL_REFUND');

    const [credits] = await app.db
      .select({ balance: schema.userCredits.balance })
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, merchant.userId));
    expect(credits?.balance).toBe(125);

    const ledger = await app.db
      .select()
      .from(schema.creditLedger)
      .where(eq(schema.creditLedger.jobId, jobId));
    expect(ledger).toHaveLength(1);
  });

  it('deducting more than the balance throws and leaves the balance untouched', async () => {
    const merchant = await createTestMerchant(app, { balance: 5 });

    await expect(
      atomicMerchantDeduct(app.db, merchant.merchantId, 50, randomUUID()),
    ).rejects.toThrow();

    const [credits] = await app.db
      .select({ balance: schema.userCredits.balance })
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, merchant.userId));
    expect(credits?.balance).toBe(5);
  });
```

`app.db` is passed to these helpers with no cast, matching `apps/api/src/modules/admin/credits.routes.ts:18` (`adminGrant(app.db, userId, ...)`). If TypeScript complains that the test harness exposes a narrower type, add `as any` with a `// biome-ignore lint/suspicious/noExplicitAny: DB type narrowing` comment above it — the same pattern already used at the `atomicMerchantDeduct` call sites in `merchant/create-tryon-job.ts:47` and `kiosk/create-job.ts:46`.

Required imports for this file:
```ts
import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { getTryonCreditCost } from '../../src/lib/resolution-config.js';
import { createKioskJob } from '../../src/modules/kiosk/create-job.js';
import { atomicMerchantDeduct, merchantRefund } from '../../src/modules/merchant/ledger.js';
import { createMerchantTryonJob } from '../../src/modules/merchant/create-tryon-job.js';
import { createTestMerchant, createTestTryonCategory } from '../helpers/merchant.js';
```

`workflowTemplateId` comes from `createTestTryonCategory(app, { slug: \`unif-${randomUUID()}\` })` in the `beforeAll` — the same way `merchant-tryon.test.ts` obtains it.

- [ ] **Step 4: Apply the migration locally and run the new test**

Run:
```bash
pnpm db:migrate
cd apps/api && npx vitest run --config vitest.integration.config.ts -- merchant-credit-unification
```
Expected: migration applies without error (a `NOTICE` is harmless); the test file PASSes all four cases.

If `pnpm db:migrate` silently skips 0143, apply it manually using the `packages/db/apply-one.ts` recipe documented in `CLAUDE.md` under "Migration Index Conflicts", then delete that scratch file.

- [ ] **Step 5: Verify the backfill arithmetic directly**

Run against your local dev database:
```bash
docker exec -i tryme-postgres psql -U postgres -d tryon -c "SELECT count(*) FROM credit_ledger WHERE reason = 'MERCHANT_CREDITS_MIGRATION';"
```
Expected: a count equal to the number of local `merchant_credits` rows with a non-zero balance (likely `0` on a clean dev DB — that is fine, the test in Step 3 is what proves the logic).

Adapt the container name and database name if your compose stack differs; check with `docker ps`.

- [ ] **Step 6: Run the full suite one more time**

Run:
```bash
pnpm --filter @tryme/api test
cd apps/api && npx vitest run --config vitest.integration.config.ts
pnpm --filter @tryme/dispatcher test
pnpm typecheck
```
Expected: unit and dispatcher PASS outright, typecheck clean. Integration shows no failures beyond the known-flaky pre-existing set (see Global Constraints) — re-run any other failing file alone before treating it as real. This is the Release 1 gate.

- [ ] **Step 7: Commit**

```bash
npx biome check --write apps/api/test/integration/merchant-credit-unification.test.ts
git add packages/db/src/migrations/0143_merchant_credits_backfill.sql packages/db/src/migrations/meta/_journal.json apps/api/test/integration/merchant-credit-unification.test.ts
git commit -m "$(cat <<'EOF'
feat(db): backfill merchant_credits into user_credits

Additive, re-runnable migration folding each merchant's separate balance
into the owning user's, with a MERCHANT_CREDITS_MIGRATION ledger row per
merchant for audit continuity. Hand-written: db:generate is unusable while
snapshots 0128-0142 are missing.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## 🚦 Release 1 / Release 2 gate

**Stop here.** Task 9 must not ship in the same release as Tasks 1–8.

Deploy Release 1 (Tasks 1–8), then verify in production before proceeding:

1. The two largest known balances landed **on top of** existing personal balances rather than replacing them — Rahul Goolla (`rahulgoolla.nicedigitals@gmail.com`, ≈ 99,860) and Nice Interactive (`satyamcreations@gmail.com`, 100,000) — each with a matching `MERCHANT_CREDITS_MIGRATION` row in `credit_ledger`.
2. A live kiosk or Android tryon draws the unified balance down by `config:system.tryon.creditCost`.
3. No `INSUFFICIENT_CREDITS` errors are appearing for merchants who visibly have credits.

Only once all three hold should Task 9 be started. Until it runs, `merchant_credits` remains in place as the reconciliation source of truth.

---

## Task 9: Drop the merchant credit tables (Release 2)

**Files:**
- Create: `packages/db/src/migrations/0144_drop_merchant_credits.sql`
- Modify: `packages/db/src/migrations/meta/_journal.json`
- Modify: `packages/db/src/schema/merchant.ts:71-77,97-107`

**Interfaces:**
- Produces: `schema.merchantCredits` and `schema.merchantCreditLedger` no longer exist on the `@tryme/db` schema namespace.

- [ ] **Step 1: Confirm nothing references the tables**

Run:
```bash
grep -rn "merchantCredits\|merchantCreditLedger\|merchant_credits\|merchant_credit_ledger" apps/ packages/ --include=*.ts --include=*.tsx | grep -v migrations/
```
Expected: no output. If anything matches, it was missed in Tasks 2–7 — fix it before dropping the tables.

- [ ] **Step 2: Write the drop migration**

Create `packages/db/src/migrations/0144_drop_merchant_credits.sql`:

```sql
-- Release 2 of the credit unification. 0143 folded every merchant_credits
-- balance into the owning user's user_credits row and wrote a
-- MERCHANT_CREDITS_MIGRATION ledger entry for each. Both tables have been
-- unread and unwritten since that release deployed and production balances
-- were verified, so they can now go.
--
-- merchant_payments is deliberately retained: merchants keep their own Razorpay
-- checkout and their own MERCHANT_PLAN_BILLING pricing. Only the credit
-- destination moved.

DROP TABLE IF EXISTS "merchant_credit_ledger";
DROP TABLE IF EXISTS "merchant_credits";
```

- [ ] **Step 3: Add the journal entry**

In `packages/db/src/migrations/meta/_journal.json`, append after the `"idx": 143` object:

```json
    {
      "idx": 144,
      "version": "7",
      "when": 1785710400000,
      "tag": "0144_drop_merchant_credits",
      "breakpoints": true
    }
```

- [ ] **Step 4: Remove the Drizzle table definitions**

In `packages/db/src/schema/merchant.ts`, delete the `merchantCredits` table definition (lines 71–77) and the `merchantCreditLedger` table definition (lines 97–107). Leave `merchantPayments` (lines 79–95) in place.

- [ ] **Step 5: Apply and verify**

Run:
```bash
pnpm db:migrate
pnpm --filter @tryme/db build
pnpm typecheck
```
Expected: migration applies, build and typecheck clean.

- [ ] **Step 6: Run the full suite**

Run:
```bash
pnpm --filter @tryme/api test
cd apps/api && npx vitest run --config vitest.integration.config.ts
pnpm --filter @tryme/dispatcher test
```
Expected: unit and dispatcher PASS outright. Integration shows no failures beyond the known-flaky pre-existing set (see Global Constraints) — re-run any other failing file alone before treating it as real.

- [ ] **Step 7: Commit**

```bash
npx biome check --write packages/db/src/schema/merchant.ts
git add packages/db/src/migrations/0144_drop_merchant_credits.sql packages/db/src/migrations/meta/_journal.json packages/db/src/schema/merchant.ts
git commit -m "$(cat <<'EOF'
feat(db)!: drop merchant_credits and merchant_credit_ledger

Release 2 of the credit unification. Balances were folded into user_credits
by 0143 and verified in production. merchant_payments is retained --
merchants keep their own checkout and pricing.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Update project documentation

**Files:**
- Modify: `CLAUDE.md`
- Modify: `docs/progress.md`

- [ ] **Step 1: Fix the stale "Widget / Merchant" schema section in CLAUDE.md**

The table under "Widget / Merchant" documents `widget_clients`, `widget_client_credits`, and `widget_credit_ledger` — none of which exist in the schema; they were replaced by the `merchants` system. Replace those three rows with:

```markdown
| `merchants` | Merchant profile attached to a `users` row (company, kiosk config, catalogue settings, webhook). One per user; login lives on `users`. No credit balance of its own — merchant spend draws from `user_credits` |
| `merchant_payments` | Merchant-portal Razorpay orders, priced by `MERCHANT_PLAN_BILLING`. Credits land in `user_credits` |
| `kiosk_devices` | Per-merchant kiosk device registrations |
```

Verify the `kiosk_devices` table name before writing it:
```bash
grep -n "pgTable('kiosk" packages/db/src/schema/*.ts
```

Also confirm the `jobs` table row in that document no longer claims a `widgetClientId` column:
```bash
grep -n "widgetClientId" packages/db/src/schema/jobs.ts
```
If it returns nothing, remove `widgetClientId` from the `jobs` row description in CLAUDE.md.

- [ ] **Step 2: Add the progress log entry**

Add a new dated entry at the **top** of `docs/progress.md`:

```markdown
## 2026-08-04 — Unified credit system

**Done**
- Collapsed `merchant_credits` / `merchant_credit_ledger` into `user_credits` / `credit_ledger`. `merchant/ledger.ts` is now a thin adapter resolving `merchants.userId` and delegating to `credits/ledger.ts`.
- Merchant Razorpay purchases (`merchant_payments`, `MERCHANT_PLAN_BILLING`) now credit `user_credits`. The checkout and its pricing are unchanged.
- Removed `config:system.merchantFreeCredits` and the merchant-onboarding free grant — a user gets one free trial, at signup.
- Dispatcher refunds (`markWidgetFailed`, stuck-job sweeper) unified onto `user_credits`.
- admin-web shows one balance per user; the Grant action moved onto it.
- Migration 0143 backfilled existing balances additively with `MERCHANT_CREDITS_MIGRATION` ledger rows; 0144 dropped the tables.

**Failed / Not Done**
- `pnpm db:generate` remains unusable — snapshots 0128–0142 are still missing, so 0143 and 0144 were hand-written. Backfilling those snapshots is still outstanding.

**Open Questions / Decisions**
- Merchant plan pricing (`MERCHANT_PLAN_BILLING`) and personal plan pricing (`credit_plans`) remain two price lists feeding one pool. Deliberate for now — different customer segments — but worth revisiting if they drift.
```

- [ ] **Step 3: Commit**

```bash
git add CLAUDE.md docs/progress.md
git commit -m "$(cat <<'EOF'
docs: record the credit unification, fix stale widget_clients schema docs

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

## Self-Review Notes

Spec coverage check against `2026-08-04-unified-credits-remove-merchant-credits-design.md`:

| Spec section | Task |
|--------------|------|
| §1 ledger adapter | Task 2 |
| §2 kiosk keeps `userId: null` | Task 2 (unchanged behaviour), asserted in Task 8 Step 3 |
| §3 read paths | Task 3 |
| §4 payments | Task 4 |
| §5 remove `merchantFreeCredits` | Task 5 |
| §6 dispatcher | Task 6 |
| §7 admin-web | Task 7 |
| §8 schema drop | Task 9 |
| Rollout: Release 1 backfill | Task 8 |
| Rollout: Release 2 drop | Task 9, gated |
| Known blockers | Task 1 |
| Testing | Tasks 2, 5, 8 |
| Post-deploy verification | Release gate between Tasks 8 and 9 |
