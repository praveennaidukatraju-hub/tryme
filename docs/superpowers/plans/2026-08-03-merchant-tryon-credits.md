# Merchant Tryon Credits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Charge merchant-tagged android/kiosk tryon jobs against `merchantCredits` at the admin-configured Virtual Try-On Pricing rate, and grant new merchants an admin-configurable free-credit balance on signup.

**Architecture:** Reuse the existing `config:system` Redis blob + `getTryonCreditCost()` reader (already used by regular users, saree, and merchant catalogue jobs) as the single source of truth for the per-job cost, and reuse the existing `merchantCredits`/`merchantCreditLedger` tables + `atomicMerchantDeduct`/`merchantRefund` helpers (already used by kiosk) as the single balance merchants are billed against. No new tables, no new billing primitives — only wiring the android tryon path onto machinery that already exists, fixing kiosk's stale hardcoded cost, and adding one new admin-configurable field for the free-credit grant.

**Tech Stack:** Fastify 5, Drizzle ORM (Postgres), Redis (`config:system` JSON blob), Zod (`@tryme/types`), Vitest integration tests (real Postgres/Redis/MinIO via `pnpm docker:up`), React (admin-web Vite SPA).

## Global Constraints

- Never touch Shopify's `userCredits`-based billing (`apps/api/src/modules/shopify/customer.routes.ts`) — out of scope.
- Never touch the merchant catalogue-manager flows (`createMerchantCatalogJob`, `createMerchantSareeMannequinJob` in `apps/api/src/modules/merchant/create-job.ts`) — they stay on `userCredits`, unrelated to this change.
- `pnpm docker:up` must be running before any `pnpm test` (no testcontainers in this repo — see CLAUDE.md Testing Architecture section).
- All new/changed TypeScript must pass `pnpm --filter @tryme/api typecheck` (or `pnpm typecheck` at the root) and `pnpm --filter @tryme/api lint`.
- Only commit once each task's tests pass — see Task Structure below.

---

## File Structure

| File | Change |
|------|--------|
| `packages/types/src/jobs.ts` | Add `MERCHANT_FREE_CREDITS = 0` fallback constant, alongside `SIMPLE_TRYON_COST` etc. |
| `packages/types/src/admin.ts` | Add `merchantFreeCredits: z.number().int().min(0).max(100_000).optional()` to `SystemConfigBody`. |
| `apps/api/src/lib/resolution-config.ts` | Add `DEFAULT_MERCHANT_FREE_CREDITS_CONFIG` + `getMerchantFreeCredits(app)` reader, same pattern as `getTryonCreditCost`. |
| `apps/api/src/modules/admin/config.routes.ts` | `GET /admin/config` response includes `cfg.merchantFreeCredits` default fallback. |
| `apps/admin-web/src/pages/SettingsPage.tsx` | New "Merchant Free Credits" field in the System tab, next to Virtual Try-On Pricing. |
| `apps/api/src/modules/merchant/onboarding.routes.ts` | Grant `getMerchantFreeCredits(app)` into `merchantCredits.balance` + `merchantCreditLedger` row (`reason: 'FREE_TRIAL'`) instead of always inserting `balance: 0`. |
| `apps/api/src/modules/merchant/create-tryon-job.ts` | Charge `getTryonCreditCost(app)` via `atomicMerchantDeduct`, set `creditsCharged` to the real cost instead of hardcoded `0`. |
| `apps/api/src/modules/kiosk/create-job.ts` | Delete the hardcoded `KIOSK_JOB_COST` constant. |
| `apps/api/src/modules/kiosk/jobs.routes.ts` | Replace `cost: KIOSK_JOB_COST` with `cost: await getTryonCreditCost(app)`. |
| `apps/api/src/modules/merchant/me.routes.ts` | Switch balance source from `userCredits` (joined on `userId`) to `merchantCredits` (joined on `merchantId`). |
| `packages/db/src/schema/merchant.ts` | Update the now-stale `signupSource` comment ("Try-ons are free..."). |
| `apps/api/test/helpers/merchant.ts` | `createTestMerchant` inserts a `merchantCredits` row too, with a configurable balance, and exposes a `merchantCredits(n)` setter alongside the existing `credits(n)` (user-credits) setter. |
| `apps/api/test/integration/merchant-me.test.ts` | Assert on `merchantCredits` balance instead of `userCredits`. |
| `apps/api/test/integration/merchant-tryon.test.ts` | Update the "zero credits charged" test to assert the real cost is charged and deducted; add an insufficient-balance test. |
| `apps/api/test/integration/kiosk-jobs.test.ts` | Update the hardcoded `-10`/`90` ledger/balance assertions to the new admin-configured cost (test sets `config:system` explicitly rather than relying on the deleted constant). |
| `apps/api/test/merchant-onboarding.test.ts` | Add a test that a configured `merchantFreeCredits` value is granted + ledgered on self-serve onboarding. |

---

### Task 1: Admin-configurable `merchantFreeCredits` in `config:system`

**Files:**
- Modify: `packages/types/src/jobs.ts`
- Modify: `packages/types/src/admin.ts`
- Modify: `apps/api/src/lib/resolution-config.ts`
- Modify: `apps/api/src/modules/admin/config.routes.ts`
- Test: `apps/api/test/integration/admin-config.test.ts` (existing file — follow its established pattern, see below)

**Interfaces:**
- Produces: `getMerchantFreeCredits(app: FastifyInstance): Promise<number>` — exported from `apps/api/src/lib/resolution-config.ts`, same signature shape as `getTryonCreditCost`. Later tasks (Task 3) call this.
- Produces: `MERCHANT_FREE_CREDITS` (number, value `0`) — exported from `packages/types/src/jobs.ts`.

- [ ] **Step 1: Write the failing test**

`apps/api/test/integration/admin-config.test.ts` already exists and covers exactly this kind of admin/config field (see its `'GET /admin/config default-fills pixverse cost, and PATCH persists an override'` test) — it already has `adminAuth` set up in `beforeAll` and clears `config:system` in `afterEach`, so no new file or scaffolding needed. Add a new test inside its `describe('admin config', ...)` block, right after the pixverse test:

```ts
it('GET /admin/config default-fills merchantFreeCredits, and PATCH persists an override', async () => {
  const getRes = await app.inject({ method: 'GET', url: '/admin/config', headers: adminAuth });
  expect(getRes.statusCode).toBe(200);
  expect(getRes.json().merchantFreeCredits).toBe(0);

  const patchRes = await app.inject({
    method: 'PATCH',
    url: '/admin/config',
    headers: { ...adminAuth, 'content-type': 'application/json' },
    payload: JSON.stringify({ merchantFreeCredits: 20 }),
  });
  expect(patchRes.statusCode).toBe(200);

  const getRes2 = await app.inject({ method: 'GET', url: '/admin/config', headers: adminAuth });
  expect(getRes2.json().merchantFreeCredits).toBe(20);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- admin-config.test.ts -t "merchantFreeCredits"`
Expected: FAIL — `merchantFreeCredits` not accepted by `SystemConfigBody` / not present in the `GET` response.

- [ ] **Step 3: Add the fallback constant**

In `packages/types/src/jobs.ts`, after `PIXVERSE_VIDEO_COST` (line 117):

```ts
/** Fallback default — the actual granted amount is admin-configurable, see getMerchantFreeCredits(). */
export const MERCHANT_FREE_CREDITS = 0;
```

- [ ] **Step 4: Add the Zod field**

In `packages/types/src/admin.ts`, inside `SystemConfigBody` (after the `pixverse` field, before `uploadLimits`):

```ts
  // Credits auto-granted to a new merchant on self-serve android onboarding
  // (POST /v1/merchant/onboarding). See getMerchantFreeCredits().
  merchantFreeCredits: z.number().int().min(0).max(100_000).optional(),
```

- [ ] **Step 5: Add the reader function**

In `apps/api/src/lib/resolution-config.ts`, add the import and function:

```ts
import {
  MERCHANT_FREE_CREDITS,
  PIXVERSE_VIDEO_COST,
  RESOLUTION_COSTS,
  type Resolution,
  SAREE_MANNEQUIN_DEV_COST,
  SIMPLE_TRYON_COST,
} from '@tryme/types';
```

(add `MERCHANT_FREE_CREDITS` to the existing import block)

```ts
export const DEFAULT_MERCHANT_FREE_CREDITS = MERCHANT_FREE_CREDITS;

/**
 * Reads the admin-configured free-credit grant for a newly self-serve-onboarded
 * merchant from the same `config:system` Redis key. Falls back to
 * MERCHANT_FREE_CREDITS (0) if nothing is stored yet, or the entry is malformed.
 */
export async function getMerchantFreeCredits(app: FastifyInstance): Promise<number> {
  try {
    const raw = await app.redis.get(CONFIG_KEY);
    const cfg = raw ? JSON.parse(raw) : {};
    const credits = cfg.merchantFreeCredits;
    return typeof credits === 'number' ? credits : MERCHANT_FREE_CREDITS;
  } catch {
    return MERCHANT_FREE_CREDITS;
  }
}
```

- [ ] **Step 6: Wire the default into `GET /admin/config`**

In `apps/api/src/modules/admin/config.routes.ts`, add the import (`DEFAULT_MERCHANT_FREE_CREDITS` from `../../lib/resolution-config.js`) and, inside the `GET /admin/config` handler after `cfg.pixverse = ...`:

```ts
cfg.merchantFreeCredits = cfg.merchantFreeCredits ?? DEFAULT_MERCHANT_FREE_CREDITS;
```

- [ ] **Step 7: Run test to verify it passes**

Run: `pnpm --filter @tryme/api test -- admin-config.test.ts -t "merchantFreeCredits"`
Expected: PASS

- [ ] **Step 8: Typecheck**

Run: `pnpm --filter @tryme/types typecheck && pnpm --filter @tryme/api typecheck`
Expected: no errors

- [ ] **Step 9: Commit**

```bash
git add packages/types/src/jobs.ts packages/types/src/admin.ts apps/api/src/lib/resolution-config.ts apps/api/src/modules/admin/config.routes.ts apps/api/test/integration/admin-config.test.ts
git commit -m "feat(api): add admin-configurable merchantFreeCredits to system config"
```

---

### Task 2: Settings UI — "Merchant Free Credits" field

**Files:**
- Modify: `apps/admin-web/src/pages/SettingsPage.tsx`

**Interfaces:**
- Consumes: `GET /admin/config` now returns `merchantFreeCredits: number` (Task 1). `PATCH /admin/config` accepts `merchantFreeCredits` in its body.
- No new exports — this is leaf UI state, nothing later depends on names here.

- [ ] **Step 1: Add state**

In `apps/admin-web/src/pages/SettingsPage.tsx`, near `tryonCreditCost` (line 408):

```ts
const [merchantFreeCredits, setMerchantFreeCredits] = useState(0);
```

- [ ] **Step 2: Read it from `/admin/config`**

In the `useEffect` fetching `/admin/config` (around line 440), add `merchantFreeCredits?: number;` to the inline response type, and after `if (cfg.pixverse) setPixverseCreditCost(cfg.pixverse.creditCost);` (line 461):

```ts
if (typeof cfg.merchantFreeCredits === 'number') setMerchantFreeCredits(cfg.merchantFreeCredits);
```

- [ ] **Step 3: Include it in the PATCH payload**

In `saveSysConfig` (around line 574), add alongside `pixverse: { creditCost: pixverseCreditCost },`:

```ts
merchantFreeCredits,
```

- [ ] **Step 4: Add the UI block**

After the "Virtual Try-On Pricing" `</div>` block (ends at line 1267, right before the "Dev API — Saree Mannequin" section starts at line 1269), insert:

```tsx
<div style={{ marginTop: 24, marginBottom: 8 }}>
  <div className="setting-lbl" style={{ marginBottom: 4 }}>
    Merchant Free Credits
  </div>
  <div className="setting-desc" style={{ marginBottom: 12 }}>
    Credits automatically granted to a merchant on self-serve android app
    signup (Google onboarding). Does not apply to merchants created directly
    from the admin panel.
  </div>
  <div
    style={{
      display: 'flex',
      alignItems: 'center',
      gap: 12,
      padding: '10px 12px',
      border: '1px solid var(--border)',
      borderRadius: 'var(--r)',
      background: 'var(--surface-2)',
    }}
  >
    <span className="setting-lbl">Free Credits</span>
    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
      <input
        className="input"
        type="number"
        min={0}
        max={100000}
        style={{ width: 80, textAlign: 'right' }}
        value={merchantFreeCredits}
        disabled={sysSaving}
        onChange={(e) => setMerchantFreeCredits(Number(e.target.value))}
      />
      <span style={{ fontSize: 13, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
        credits / new merchant
      </span>
    </div>
  </div>
</div>
```

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm --filter @tryme/admin build && pnpm --filter @tryme/admin lint`
(the admin-web package has no standalone `typecheck` script — `build` runs `tsc -b` first)
Expected: no errors

- [ ] **Step 6: Manual verification**

Run: `pnpm --filter @tryme/admin dev`, log in as SUPER_ADMIN, navigate to Settings → System, confirm "Merchant Free Credits" appears under Virtual Try-On Pricing, change the value, click Save, reload the page, confirm the value persisted.

- [ ] **Step 7: Commit**

```bash
git add apps/admin-web/src/pages/SettingsPage.tsx
git commit -m "feat(admin-web): add Merchant Free Credits field to Settings System tab"
```

---

### Task 3: Grant free credits on merchant self-serve onboarding

**Files:**
- Modify: `apps/api/src/modules/merchant/onboarding.routes.ts`
- Test: `apps/api/test/merchant-onboarding.test.ts`

**Interfaces:**
- Consumes: `getMerchantFreeCredits(app)` from Task 1 (`apps/api/src/lib/resolution-config.ts`).
- No new exports.

- [ ] **Step 1: Write the failing test**

In `apps/api/test/merchant-onboarding.test.ts`, add a new test inside the `describe('POST /v1/merchant/onboarding', ...)` block (after the existing "creates an active merchant from the phone number alone" test):

```ts
it('grants the admin-configured free-credit amount and ledgers it', async () => {
  await app.redis.set('config:system', JSON.stringify({ merchantFreeCredits: 25 }));
  try {
    const { userId, token } = await createGoogleUser('Free Credits Person');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/merchant/onboarding',
      headers: auth(token),
      payload: { phone: '9876500001' },
    });
    expect(res.statusCode).toBe(201);

    const [merchant] = await app.db
      .select()
      .from(schema.merchants)
      .where(eq(schema.merchants.userId, userId));

    const [credits] = await app.db
      .select()
      .from(schema.merchantCredits)
      .where(eq(schema.merchantCredits.merchantId, merchant?.id ?? ''));
    expect(credits?.balance).toBe(25);

    const [ledgerRow] = await app.db
      .select()
      .from(schema.merchantCreditLedger)
      .where(eq(schema.merchantCreditLedger.merchantId, merchant?.id ?? ''));
    expect(ledgerRow?.delta).toBe(25);
    expect(ledgerRow?.reason).toBe('FREE_TRIAL');
  } finally {
    await app.redis.del('config:system');
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- merchant-onboarding -t "grants the admin-configured free-credit"`
Expected: FAIL — `credits?.balance` is `0`, not `25`.

- [ ] **Step 3: Implement the grant**

In `apps/api/src/modules/merchant/onboarding.routes.ts`, add the import:

```ts
import { getMerchantFreeCredits } from '../../lib/resolution-config.js';
```

Then change the transaction body. Before the transaction starts (so the Redis read isn't inside the DB transaction), add:

```ts
const freeCredits = await getMerchantFreeCredits(app);
```

right before `const merchantId = await app.db.transaction(async (tx) => {` (line 46). Then replace the existing insert (lines 86-87):

```ts
        // Every merchant credit helper assumes this row exists.
        await tx.insert(schema.merchantCredits).values({ merchantId: created.id, balance: 0 });
```

with:

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

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @tryme/api test -- merchant-onboarding -t "grants the admin-configured free-credit"`
Expected: PASS

- [ ] **Step 5: Run the full onboarding test file to confirm no regressions**

Run: `pnpm --filter @tryme/api test -- merchant-onboarding.test.ts`
Expected: all PASS, including the existing "creates an active merchant from the phone number alone" test (which asserts `credits?.balance` is `0` with no `config:system` override present — still true since `MERCHANT_FREE_CREDITS` defaults to `0`).

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @tryme/api typecheck`
Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/merchant/onboarding.routes.ts apps/api/test/merchant-onboarding.test.ts
git commit -m "feat(api): grant admin-configured free credits on merchant self-serve onboarding"
```

---

### Task 4: Test helper — `createTestMerchant` seeds `merchantCredits`

**Files:**
- Modify: `apps/api/test/helpers/merchant.ts`
- Modify: `apps/api/test/integration/merchant-me.test.ts`

**Interfaces:**
- Produces: `createTestMerchant(app, opts)` return value gains a `merchantCredits(n: number): Promise<void>` setter, alongside the existing `credits(n: number)` (userCredits) setter. `opts` gains an optional `merchantBalance?: number` (default `0`) — separate from the existing `balance` option, which stays scoped to `userCredits` since several existing tests already depend on that meaning.
- This task must land before Task 5 and Task 6, both of which need merchant-scoped test balances.

- [ ] **Step 1: Modify the helper**

In `apps/api/test/helpers/merchant.ts`, update `createTestMerchant`:

```ts
export async function createTestMerchant(
  app: TestApp,
  opts: {
    isActive?: boolean;
    balance?: number;
    merchantBalance?: number;
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

  await app.db.insert(schema.userCredits).values({ userId: user.id, balance: opts.balance ?? 100 });
  await app.db
    .insert(schema.merchantCredits)
    .values({ merchantId: merchant.id, balance: opts.merchantBalance ?? 0 });

  return {
    merchantId: merchant.id,
    userId: user.id,
    async credits(n: number) {
      await app.db
        .update(schema.userCredits)
        .set({ balance: n })
        .where(eq(schema.userCredits.userId, user.id));
    },
    async merchantCredits(n: number) {
      await app.db
        .update(schema.merchantCredits)
        .set({ balance: n })
        .where(eq(schema.merchantCredits.merchantId, merchant.id));
    },
  };
}
```

- [ ] **Step 2: Update `merchant-me.test.ts` to match the (upcoming) Task 6 balance source**

This test asserts on the balance `/v1/merchant/me` returns. Since Task 6 switches that route to read `merchantCredits`, update the test now (it will fail until Task 6 lands — that's fine, this task's own test-running step only checks the helper compiles and other consumers aren't broken):

In `apps/api/test/integration/merchant-me.test.ts`, change:

```ts
it("returns the merchant's display name, email, and credit balance", async () => {
  const { userId } = await createTestMerchant(app, { merchantBalance: 250 });
  await app.db
    .update(schema.users)
    .set({ displayName: 'Store Owner' })
    .where(eq(schema.users.id, userId));
  const secret = new TextEncoder().encode(app.env.JWT_SECRET);
  const token = await signAccess(secret, userId, { kind: 'access' }, '15m');

  const res = await app.inject({
    method: 'GET',
    url: '/v1/merchant/me',
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.statusCode).toBe(200);
  const body = res.json() as {
    displayName: string | null;
    email: string | null;
    balance: number;
  };
  expect(body.displayName).toBe('Store Owner');
  expect(body.balance).toBe(250);
});
```

(only the `createTestMerchant` call changes — `{ balance: 250 }` → `{ merchantBalance: 250 }`)

- [ ] **Step 3: Run the full test suite for files using `createTestMerchant` to confirm no other regressions from the helper's added insert**

Run: `pnpm --filter @tryme/api test -- merchant-onboarding merchant-api-keys device-merchant-status demo-catalog-merchant dev-api-auth`
Expected: all PASS except `merchant-me.test.ts`'s first test (still failing — fixed in Task 6). Every other test should be unaffected, since `createTestMerchant` now additionally inserts a `merchantCredits` row (which those tests don't assert against) — this insert must not violate any constraint (there is no existing `merchantCredits` row for these merchants prior to this change, so no conflict).

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @tryme/api typecheck`
Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add apps/api/test/helpers/merchant.ts apps/api/test/integration/merchant-me.test.ts
git commit -m "test(api): seed merchantCredits in createTestMerchant test helper"
```

---

### Task 5: Bill android merchant tryon jobs against `merchantCredits`

**Files:**
- Modify: `apps/api/src/modules/merchant/create-tryon-job.ts`
- Test: `apps/api/test/integration/merchant-tryon.test.ts`

**Interfaces:**
- Consumes: `getTryonCreditCost(app)` (existing, `apps/api/src/lib/resolution-config.ts`), `atomicMerchantDeduct(db, merchantId, amount, jobId)` (existing, `apps/api/src/modules/merchant/ledger.ts`), `createTestMerchant` with `merchantBalance` option (Task 4).
- Produces: `createMerchantTryonJob` now throws `AppError('INSUFFICIENT_CREDITS', 402, ...)` (propagated from `atomicMerchantDeduct`) when the merchant's `merchantCredits.balance` is insufficient — callers (`merchant/tryon.routes.ts`) already let thrown `AppError`s propagate to Fastify's error handler unchanged, so no route-level change is needed.

- [ ] **Step 1: Update the existing "zero credits charged" test to expect real billing**

In `apps/api/test/integration/merchant-tryon.test.ts`, the first `it` block (lines 114-158) currently does:

```ts
const { merchant, merchantUser } = await createMerchant(app, 'tryon-a@example.com');
```

This file has its own local `createMerchant` helper (lines 12-29), not the shared one from `helpers/merchant.ts`. Update that local helper to also seed `merchantCredits`:

```ts
async function createMerchant(app: TestApp, email: string, merchantBalance = 100) {
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
  await app.db.insert(schema.merchantCredits).values({ merchantId: merchant.id, balance: merchantBalance });
  return { merchant, merchantUser };
}
```

Then change the first test's assertion (was `expect(jobRow.creditsCharged).toBe(0);`) and rename the test to match:

```ts
it('presigns a customer photo, creates a job charging the admin-configured tryon cost, and rejects a photo key from a different merchant', async () => {
  const { merchant, merchantUser } = await createMerchant(app, 'tryon-a@example.com');
  const { merchant: otherMerchant } = await createMerchant(app, 'tryon-b@example.com');
  const auth = await authHeader(merchantUser.id);
  const garmentType = await seedGarmentTypeWithWorkflow(app);
  const item = await seedCatalogItem(app, merchant.id, garmentType.id);

  const presigned = await app.inject({
    method: 'POST',
    url: '/v1/merchant/tryon/presign',
    headers: auth,
    payload: { contentType: 'image/jpeg', contentLength: 1024 },
  });
  expect(presigned.statusCode).toBe(200);
  const { r2Key } = presigned.json() as { r2Key: string; uploadUrl: string };
  expect(r2Key.startsWith(`merchant-inputs/${merchant.id}/`)).toBe(true);
  await app.storage.putObject(r2Key, Buffer.from('photo'), 'image/jpeg');

  const created = await app.inject({
    method: 'POST',
    url: '/v1/merchant/tryon/jobs',
    headers: auth,
    payload: { merchantCatalogItemId: item.id, customerPhotoKey: r2Key },
  });
  expect(created.statusCode).toBe(201);
  const { jobId } = created.json() as { jobId: string };

  const [jobRow] = await app.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
  expect(jobRow.creditsCharged).toBe(5); // SIMPLE_TRYON_COST default, no config:system override in this test
  expect(jobRow.merchantId).toBe(merchant.id);
  expect(jobRow.userId).toBe(merchantUser.id);
  expect(jobRow.source).toBe('merchant_tryon');

  const [credits] = await app.db
    .select()
    .from(schema.merchantCredits)
    .where(eq(schema.merchantCredits.merchantId, merchant.id));
  expect(credits.balance).toBe(95);

  const otherAuth = await authHeader(
    (await createMerchant(app, 'tryon-c@example.com')).merchantUser.id,
  );
  const crossMerchant = await app.inject({
    method: 'POST',
    url: '/v1/merchant/tryon/jobs',
    headers: otherAuth,
    payload: { merchantCatalogItemId: item.id, customerPhotoKey: r2Key },
  });
  expect(crossMerchant.statusCode).toBe(404);
  void otherMerchant;
});
```

- [ ] **Step 2: Add a new insufficient-balance test**

Add after the updated test above (before the "rejects a customer photo above the admin-configured limit" test):

```ts
it('402s with no job row when merchant credits are insufficient', async () => {
  const { merchant, merchantUser } = await createMerchant(app, 'tryon-low-balance@example.com', 2);
  const auth = await authHeader(merchantUser.id);
  const garmentType = await seedGarmentTypeWithWorkflow(app);
  const item = await seedCatalogItem(app, merchant.id, garmentType.id);

  const presigned = await app.inject({
    method: 'POST',
    url: '/v1/merchant/tryon/presign',
    headers: auth,
    payload: { contentType: 'image/jpeg', contentLength: 1024 },
  });
  const { r2Key } = presigned.json() as { r2Key: string };
  await app.storage.putObject(r2Key, Buffer.from('photo'), 'image/jpeg');

  const created = await app.inject({
    method: 'POST',
    url: '/v1/merchant/tryon/jobs',
    headers: auth,
    payload: { merchantCatalogItemId: item.id, customerPhotoKey: r2Key },
  });
  expect(created.statusCode).toBe(402);
  expect(created.json()).toMatchObject({
    error: { code: 'INSUFFICIENT_CREDITS', message: 'insufficient credits' },
  });

  const jobs = await app.db
    .select({ id: schema.jobs.id })
    .from(schema.jobs)
    .where(eq(schema.jobs.merchantId, merchant.id));
  expect(jobs).toHaveLength(0);

  const [credits] = await app.db
    .select()
    .from(schema.merchantCredits)
    .where(eq(schema.merchantCredits.merchantId, merchant.id));
  expect(credits.balance).toBe(2);
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @tryme/api test -- merchant-tryon.test.ts`
Expected: FAIL — `jobRow.creditsCharged` is `0` not `5`; `merchantCredits.balance` unchanged at `100`; insufficient-balance test gets `201` not `402`.

- [ ] **Step 4: Implement the billing**

In `apps/api/src/modules/merchant/create-tryon-job.ts`, replace the full file:

```ts
import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { JOB_SOURCE } from '@tryme/types';
import type { FastifyInstance } from 'fastify';
import { getTryonCreditCost } from '../../lib/resolution-config.js';
import { atomicMerchantDeduct } from './ledger.js';

interface CreateMerchantTryonJobInput {
  merchantId: string;
  merchantUserId: string;
  upperGarmentKey: string;
  customerPhotoKey: string;
  workflowTemplateId: string;
}

export async function createMerchantTryonJob(
  app: FastifyInstance,
  input: CreateMerchantTryonJobInput,
): Promise<string> {
  const jobId = randomUUID();
  const cost = await getTryonCreditCost(app);

  await app.db.transaction(async (tx) => {
    // biome-ignore lint/suspicious/noExplicitAny: nullable widget inputs are wider than Drizzle's inferred insert type.
    await (tx.insert(schema.jobs).values as any)({
      id: jobId,
      userId: input.merchantUserId,
      merchantId: input.merchantId,
      kioskDeviceId: null,
      customerPhotoKey: input.customerPhotoKey,
      status: 'QUEUED',
      creditsCharged: cost,
      source: JOB_SOURCE.MERCHANT_TRYON,
    });

    // biome-ignore lint/suspicious/noExplicitAny: nullable widget inputs are wider than Drizzle's inferred insert type.
    await (tx.insert(schema.jobInputs).values as any)({
      jobId,
      upperGarmentKey: input.upperGarmentKey,
      faceId: null,
      backgroundId: null,
      poseId: null,
      params: { workflowTemplateId: input.workflowTemplateId },
    });

    // biome-ignore lint/suspicious/noExplicitAny: tx type narrowing loses the custom methods added by the merchant ledger helper.
    await atomicMerchantDeduct(tx as any, input.merchantId, cost, jobId);
  });

  await app.redis.xadd(
    'jobs:normal',
    'MAXLEN',
    '~',
    10000,
    '*',
    'jobId',
    jobId,
    'userId',
    input.merchantUserId,
    'type',
    'MERCHANT_TRYON',
  );

  return jobId;
}
```

Note: `atomicMerchantDeduct` throwing inside the `app.db.transaction` callback causes Drizzle to roll back the whole transaction (jobs + jobInputs inserts included) before the error propagates — same behavior `createKioskJob` already relies on for its "fails atomically when merchant credits are insufficient" test.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @tryme/api test -- merchant-tryon.test.ts`
Expected: all PASS

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @tryme/api typecheck`
Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/merchant/create-tryon-job.ts apps/api/test/integration/merchant-tryon.test.ts
git commit -m "feat(api): charge admin-configured tryon cost against merchantCredits for android merchant tryons"
```

---

### Task 6: Fix kiosk's hardcoded cost, drop `KIOSK_JOB_COST`

**Files:**
- Modify: `apps/api/src/modules/kiosk/create-job.ts`
- Modify: `apps/api/src/modules/kiosk/jobs.routes.ts`
- Test: `apps/api/test/integration/kiosk-jobs.test.ts`

**Interfaces:**
- Consumes: `getTryonCreditCost(app)` (existing).
- No new exports — `createKioskJob`'s `cost` field in its input interface is unchanged (caller still supplies it, just now sourced from `getTryonCreditCost` instead of a constant).

- [ ] **Step 1: Update the kiosk-jobs test to reflect the admin-configured cost**

In `apps/api/test/integration/kiosk-jobs.test.ts`, the main test ("creates kiosk jobs atomically...") currently asserts (lines 246, 253):

```ts
expect(credits.balance).toBe(90);
...
expect(ledgerRows[0]?.delta).toBe(-10);
```

Since `KIOSK_JOB_COST = 10` is being deleted and replaced by `getTryonCreditCost(app)` (default `SIMPLE_TRYON_COST = 5` with no `config:system` override), update to:

```ts
expect(credits.balance).toBe(95);
...
expect(ledgerRows[0]?.delta).toBe(-5);
```

Also update the "fails atomically when merchant credits are insufficient" test — it seeds a merchant with balance `5` (line 430, `seedMerchant(app, 'merchant-low-balance@example.com', 5)`). With cost now `5` instead of `10`, a balance of `5` would *succeed*, not fail insufficiency. Change the seeded balance to `4`:

```ts
const merchant = await seedMerchant(app, 'merchant-low-balance@example.com', 4);
```

and update the final assertion:

```ts
expect(credits.balance).toBe(4);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- kiosk-jobs.test.ts`
Expected: FAIL — balance/ledger deltas still reflect the old hardcoded `10`.

- [ ] **Step 3: Delete the hardcoded constant**

In `apps/api/src/modules/kiosk/create-job.ts`, delete line 7:

```ts
export const KIOSK_JOB_COST = 10;
```

- [ ] **Step 4: Update the route to use the admin-configured cost**

In `apps/api/src/modules/kiosk/jobs.routes.ts`:

Change the import (line 12):
```ts
import { createKioskJob } from './create-job.js';
```

Add the new import:
```ts
import { getTryonCreditCost } from '../../lib/resolution-config.js';
```

Change the `createKioskJob` call (around line 181-188):
```ts
const jobId = await createKioskJob(app, {
  merchantId,
  kioskDeviceId,
  upperGarmentKey: garment.r2Key,
  customerPhotoKey,
  cost: await getTryonCreditCost(app),
  workflowTemplateId: garment.workflowTemplateId,
});
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @tryme/api test -- kiosk-jobs.test.ts`
Expected: all PASS

- [ ] **Step 6: Search for any other references to the deleted constant**

Run: `grep -rn "KIOSK_JOB_COST" apps/`
Expected: no matches remain.

- [ ] **Step 7: Typecheck**

Run: `pnpm --filter @tryme/api typecheck`
Expected: no errors

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/modules/kiosk/create-job.ts apps/api/src/modules/kiosk/jobs.routes.ts apps/api/test/integration/kiosk-jobs.test.ts
git commit -m "fix(api): kiosk tryon jobs use admin-configured Virtual Try-On Pricing instead of hardcoded cost"
```

---

### Task 7: Merchant dashboard balance reads `merchantCredits`

**Files:**
- Modify: `apps/api/src/modules/merchant/me.routes.ts`

**Interfaces:**
- Consumes: `createTestMerchant` with `merchantBalance` (Task 4); `merchant-me.test.ts` was already updated to call it with `merchantBalance: 250` in Task 4, Step 2 — this task makes that assertion actually pass.

- [ ] **Step 1: Confirm the test from Task 4 currently fails**

Run: `pnpm --filter @tryme/api test -- merchant-me.test.ts`
Expected: FAIL — first test expects `body.balance` to be `250` (from `merchantBalance`), but the route still reads `userCredits` (which defaults to `100` from `createTestMerchant`'s unrelated `balance` option).

- [ ] **Step 2: Update the route**

Replace `apps/api/src/modules/merchant/me.routes.ts` in full:

```ts
import { schema } from '@tryme/db';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { AppError } from '../../lib/errors.js';

export async function merchantMeRoutes(app: FastifyInstance) {
  app.get('/v1/merchant/me', { preHandler: app.requireMerchant }, async (req) => {
    const merchantId = req.merchantClientId;
    if (!merchantId) throw new AppError('UNAUTH', 401, 'missing merchant');

    const [row] = await app.db
      .select({
        displayName: schema.users.displayName,
        email: schema.users.email,
        balance: sql<number>`COALESCE(${schema.merchantCredits.balance}, 0)`,
      })
      .from(schema.merchants)
      .innerJoin(schema.users, eq(schema.users.id, schema.merchants.userId))
      .leftJoin(schema.merchantCredits, eq(schema.merchantCredits.merchantId, schema.merchants.id))
      .where(eq(schema.merchants.id, merchantId));
    if (!row) throw new AppError('NOT_FOUND', 404, 'merchant not found');

    return row;
  });
}
```

- [ ] **Step 3: Run test to verify it passes**

Run: `pnpm --filter @tryme/api test -- merchant-me.test.ts`
Expected: PASS

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @tryme/api typecheck`
Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/merchant/me.routes.ts
git commit -m "fix(api): merchant dashboard balance reads merchantCredits instead of userCredits"
```

---

### Task 8: Update stale schema comment, run full suite

**Files:**
- Modify: `packages/db/src/schema/merchant.ts:34-36`

**Interfaces:**
- None — doc-only change plus a full-suite sanity check.

- [ ] **Step 1: Update the comment**

In `packages/db/src/schema/merchant.ts`, change:

```ts
  // 'admin'          -- created through POST /admin/merchants (an admin IS the approval)
  // 'android_google' -- self-serve Google signup from the Android app via
  //                    POST /v1/merchant/onboarding. Try-ons are free, so these
  //                    accounts are the ones to watch for GPU abuse.
```

to:

```ts
  // 'admin'          -- created through POST /admin/merchants (an admin IS the approval)
  // 'android_google' -- self-serve Google signup from the Android app via
  //                    POST /v1/merchant/onboarding. Free-credit signup bonus is
  //                    admin-configurable (config:system.merchantFreeCredits) and
  //                    tryons are billed like any other merchant, so watch for
  //                    accounts burning through their balance via GPU abuse.
```

- [ ] **Step 2: Run the full API test suite**

Run: `pnpm --filter @tryme/api test`
Expected: all PASS. (Requires `pnpm docker:up` already running.)

- [ ] **Step 3: Full typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: no errors across the monorepo.

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/schema/merchant.ts
git commit -m "docs(db): update stale merchant signupSource comment now that android tryons are billed"
```

---

## Post-Plan Follow-ups (explicitly out of scope for this plan)

- Auto free-credit grant on admin-created merchants (`POST /admin/merchants`) — admin already has `merchantAdminGrant` for manual grants there.
- Making `MERCHANT_PLAN_BILLING` (top-up plans) admin-configurable/DB-backed.
- Shopify store-owner billing — untouched, still `userCredits`-based.

After finishing, update `docs/progress.md` with a new dated entry per CLAUDE.md's Progress Tracking section.
