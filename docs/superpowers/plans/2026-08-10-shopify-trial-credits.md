# Shopify Free Trial Credits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Grant a one-time, admin-configurable number of free credits to a Shopify store's owner the first time the store links to an TryMe account, independent of Shopify's own day-based `trialDays` billing trial.

**Architecture:** Reuses the existing `credit_ledger`/`user_credits` transactional-grant idiom already used by `syncStoreSubscription` (`apps/api/src/modules/shopify/billing.ts`) — a new sibling function `grantShopifyTrialCredits` inserts a `credit_ledger` row with `reason: 'SHOPIFY_TRIAL'` and an `external_ref` keyed on `store.id`, relying on the existing partial unique index on `external_ref` (migration 0148) for idempotency — no new migration. The credit amount is admin-configurable via the existing Redis-backed `config:system` surface (`GET`/`PATCH /admin/config`), following the exact pattern already used for `tryon.creditCost` / `pixverse.creditCost` in `apps/api/src/lib/resolution-config.ts`. The grant fires from `POST /v1/shopify/store/account/link` (`apps/api/src/modules/shopify/auth.routes.ts`), the moment `ownerUserId` is first set on a store row.

**Tech Stack:** Fastify 5, Drizzle ORM, Zod (`fastify-type-provider-zod`), Vitest, ioredis (`app.redis`), React (admin-web, no test suite for that app in this repo).

## Global Constraints

- No new database migration — `credit_ledger.reason` is `text`, not an enum; `external_ref` already has a partial unique index (migration 0148).
- New credit_ledger `reason` value is `'SHOPIFY_TRIAL'`, never `'FREE_TRIAL'` (that string already has its own *per-user* partial unique index for the web signup flow — reusing it would collide).
- `external_ref` for this grant is `` `shopify_trial:${store.id}` `` — keyed on store id alone (one-time per store, not per user or per cycle).
- Default trial credit amount is `25`, overridable via `PATCH /admin/config` body `{ shopify: { trialCredits: number } }`, `0 <= n <= 1000`.
- No UI feedback (toast/banner) on grant — out of scope per the approved design spec.
- No change to how credits are spent — trial credits land in the same `user_credits.balance` pool as every other grant.
- Follow existing code patterns exactly: `apps/api/src/lib/resolution-config.ts` for the config reader, `apps/api/src/modules/shopify/billing.ts`'s `syncStoreSubscription` for the transactional grant.

---

### Task 1: Admin-configurable trial credit amount (config reader)

**Files:**
- Modify: `apps/api/src/lib/resolution-config.ts`
- Test: `apps/api/test/resolution-config.test.ts` (new file)

**Interfaces:**
- Consumes: nothing new (uses `app.redis`, same as every other function in this file).
- Produces: `DEFAULT_SHOPIFY_TRIAL_CONFIG: { trialCredits: number }` and `getShopifyTrialCredits(app: FastifyInstance): Promise<number>`, both exported from `apps/api/src/lib/resolution-config.ts`. Task 2 and Task 3 both import these.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/resolution-config.test.ts`:

```ts
import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest';
import { getShopifyTrialCredits } from '../src/lib/resolution-config.js';
import { buildTestApp, type TestApp } from './helpers/api.js';
import { type Containers, startContainers } from './helpers/containers.js';

const CONFIG_KEY = 'config:system';

describe('getShopifyTrialCredits', () => {
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

  afterEach(async () => {
    await app.redis.del(CONFIG_KEY);
  });

  it('falls back to the default (25) when nothing is stored', async () => {
    expect(await getShopifyTrialCredits(app)).toBe(25);
  });

  it('reads the admin-configured value', async () => {
    await app.redis.set(CONFIG_KEY, JSON.stringify({ shopify: { trialCredits: 40 } }));
    expect(await getShopifyTrialCredits(app)).toBe(40);
  });

  it('falls back to the default when the stored value is malformed', async () => {
    await app.redis.set(CONFIG_KEY, 'not json');
    expect(await getShopifyTrialCredits(app)).toBe(25);
  });

  it('falls back to the default when shopify.trialCredits is not a number', async () => {
    await app.redis.set(CONFIG_KEY, JSON.stringify({ shopify: { trialCredits: 'lots' } }));
    expect(await getShopifyTrialCredits(app)).toBe(25);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- resolution-config`
Expected: FAIL — `getShopifyTrialCredits` is not exported from `../src/lib/resolution-config.js`.

- [ ] **Step 3: Implement**

In `apps/api/src/lib/resolution-config.ts`, add after `DEFAULT_PIXVERSE_CONFIG` (after line 31):

```ts
export const DEFAULT_SHOPIFY_TRIAL_CONFIG: { trialCredits: number } = { trialCredits: 25 };
```

Add after `getPixverseCreditCost` (end of file):

```ts
/**
 * Reads the admin-configured number of free trial credits granted once,
 * automatically, when a Shopify store first links to an TryMe account
 * (see grantShopifyTrialCredits in modules/shopify/billing.ts). Independent
 * of Shopify's own day-based trialDays billing trial. Falls back to
 * DEFAULT_SHOPIFY_TRIAL_CONFIG.trialCredits if nothing is stored yet, or the
 * entry is missing/malformed.
 */
export async function getShopifyTrialCredits(app: FastifyInstance): Promise<number> {
  try {
    const raw = await app.redis.get(CONFIG_KEY);
    const cfg = raw ? JSON.parse(raw) : {};
    const credits = cfg.shopify?.trialCredits;
    return typeof credits === 'number' ? credits : DEFAULT_SHOPIFY_TRIAL_CONFIG.trialCredits;
  } catch {
    return DEFAULT_SHOPIFY_TRIAL_CONFIG.trialCredits;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @tryme/api test -- resolution-config`
Expected: PASS (4/4)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/lib/resolution-config.ts apps/api/test/resolution-config.test.ts
git commit -m "feat(api): add admin-configurable Shopify trial credit reader"
```

---

### Task 2: Expose the setting on `GET`/`PATCH /admin/config`

**Files:**
- Modify: `packages/types/src/admin.ts`
- Modify: `apps/api/src/modules/admin/config.routes.ts`
- Test: `apps/api/test/integration/admin-config.test.ts`

**Interfaces:**
- Consumes: `DEFAULT_SHOPIFY_TRIAL_CONFIG` from `apps/api/src/lib/resolution-config.ts` (Task 1).
- Produces: `SystemConfigBody` (Zod schema, `packages/types/src/admin.ts`) now validates an optional `shopify: { trialCredits: number }` field. `GET /admin/config` response always includes `shopify.trialCredits` (default-filled). Task 5 (admin-web) reads/writes this shape.

- [ ] **Step 1: Write the failing test**

In `apps/api/test/integration/admin-config.test.ts`, add a new `it` block after "GET /admin/config default-fills pixverse cost, and PATCH persists an override" (after line 71):

```ts
  it('GET /admin/config default-fills shopify trial credits, and PATCH persists an override', async () => {
    const getRes = await app.inject({ method: 'GET', url: '/admin/config', headers: adminAuth });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().shopify.trialCredits).toBe(25);

    const patchRes = await app.inject({
      method: 'PATCH',
      url: '/admin/config',
      headers: { ...adminAuth, 'content-type': 'application/json' },
      payload: JSON.stringify({ shopify: { trialCredits: 50 } }),
    });
    expect(patchRes.statusCode).toBe(200);

    const getRes2 = await app.inject({ method: 'GET', url: '/admin/config', headers: adminAuth });
    expect(getRes2.json().shopify.trialCredits).toBe(50);
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- admin-config`
Expected: FAIL — `getRes.json().shopify` is `undefined`.

- [ ] **Step 3: Implement**

In `packages/types/src/admin.ts`, add to `SystemConfigBody` right after the `pixverse` field:

```ts
  shopify: z
    .object({
      trialCredits: z.number().int().min(0).max(1000),
    })
    .optional(),
```

In `apps/api/src/modules/admin/config.routes.ts`:
- Add `DEFAULT_SHOPIFY_TRIAL_CONFIG` to the import from `../../lib/resolution-config.js` (line 6-12).
- In the `GET /admin/config` handler, add after `cfg.pixverse = cfg.pixverse ?? DEFAULT_PIXVERSE_CONFIG;` (line 51):

```ts
      cfg.shopify = cfg.shopify ?? DEFAULT_SHOPIFY_TRIAL_CONFIG;
```

`PATCH /admin/config` needs no change — it already shallow-merges the validated body into stored JSON.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @tryme/api test -- admin-config`
Expected: PASS (5/5)

- [ ] **Step 5: Run full API typecheck**

Run: `pnpm --filter @tryme/api typecheck && pnpm --filter @tryme/types typecheck`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add packages/types/src/admin.ts apps/api/src/modules/admin/config.routes.ts apps/api/test/integration/admin-config.test.ts
git commit -m "feat(api): expose Shopify trial credits on GET/PATCH /admin/config"
```

---

### Task 3: Transactional grant helper (`grantShopifyTrialCredits`)

**Files:**
- Modify: `apps/api/src/modules/shopify/billing.ts`
- Test: `apps/api/test/integration/shopify-billing-sync.test.ts`

**Interfaces:**
- Consumes: `getShopifyTrialCredits` from `apps/api/src/lib/resolution-config.ts` (Task 1). `Store` type (`typeof schema.shopifyStores.$inferSelect`), already defined at the top of `billing.ts`.
- Produces: `grantShopifyTrialCredits(app: FastifyInstance, store: Store, userId: string): Promise<{ creditsGranted: number }>`, exported from `apps/api/src/modules/shopify/billing.ts`. Task 4 imports and calls this from the account-link route.

- [ ] **Step 1: Write the failing test**

In `apps/api/test/integration/shopify-billing-sync.test.ts`, add a new top-level `describe` block after the closing `});` of the `syncStoreSubscription` describe block (after line 329, before the `describe('buildPlanSelectionUrl', ...)` block). This reuses the `app`/`c` setup already running in the file and the existing `seedOwnerAndStore` — but that helper is scoped inside the `syncStoreSubscription` describe block, so this new block needs its own copy (same shape, different describe scope — this file has no shared top-level helper to import):

```ts
describe('grantShopifyTrialCredits', () => {
  let c: Containers;
  let app: TestApp;
  beforeAll(async () => {
    c = await startContainers();
    app = await buildTestApp(c);
  }, 60000);
  afterAll(async () => {
    await app?.close();
    await c?.stop();
  });

  async function seedOwnerAndStore() {
    const [user] = await app.db
      .insert(schema.users)
      .values({
        email: `trial-owner-${Date.now()}-${Math.random()}@example.com`,
        passwordHash: null,
        displayName: 'Trial Store Owner',
        companyName: null,
        emailVerified: true,
        tier: 'free',
      })
      .returning();
    const [store] = await app.db
      .insert(schema.shopifyStores)
      .values({
        shopDomain: `trial-${Date.now()}-${Math.random()}.myshopify.com`,
        shopifyShopId: Date.now(),
        accessToken: 'enc',
        scope: 'read_products',
        ownerUserId: user.id,
      })
      .returning();
    return { user, store };
  }

  it('grants the configured trial credits on first call', async () => {
    const { user, store } = await seedOwnerAndStore();

    const result = await grantShopifyTrialCredits(app, store, user.id);

    expect(result.creditsGranted).toBe(25);
    const [balanceRow] = await app.db
      .select({ balance: schema.userCredits.balance })
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, user.id));
    expect(balanceRow?.balance).toBe(25);
    const [ledgerRow] = await app.db
      .select({ reason: schema.creditLedger.reason, externalRef: schema.creditLedger.externalRef })
      .from(schema.creditLedger)
      .where(eq(schema.creditLedger.userId, user.id));
    expect(ledgerRow?.reason).toBe('SHOPIFY_TRIAL');
    expect(ledgerRow?.externalRef).toBe(`shopify_trial:${store.id}`);
  });

  it('does not re-grant on a second call for the same store', async () => {
    const { user, store } = await seedOwnerAndStore();
    await grantShopifyTrialCredits(app, store, user.id);

    const second = await grantShopifyTrialCredits(app, store, user.id);

    expect(second.creditsGranted).toBe(0);
    const [balanceRow] = await app.db
      .select({ balance: schema.userCredits.balance })
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, user.id));
    expect(balanceRow?.balance).toBe(25); // only granted once
  });

  it('grants again for a second, different store linked to the same owner', async () => {
    const { user, store: firstStore } = await seedOwnerAndStore();
    await grantShopifyTrialCredits(app, firstStore, user.id);

    const [secondStore] = await app.db
      .insert(schema.shopifyStores)
      .values({
        shopDomain: `trial-2nd-${Date.now()}-${Math.random()}.myshopify.com`,
        shopifyShopId: Date.now() + 1,
        accessToken: 'enc',
        scope: 'read_products',
        ownerUserId: user.id,
      })
      .returning();

    const result = await grantShopifyTrialCredits(app, secondStore!, user.id);

    expect(result.creditsGranted).toBe(25);
    const [balanceRow] = await app.db
      .select({ balance: schema.userCredits.balance })
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, user.id));
    expect(balanceRow?.balance).toBe(50); // 25 + 25, one per store
  });

  it('short-circuits without a DB write when the admin sets trial credits to 0', async () => {
    const { user, store } = await seedOwnerAndStore();
    await app.redis.set('config:system', JSON.stringify({ shopify: { trialCredits: 0 } }));

    try {
      const result = await grantShopifyTrialCredits(app, store, user.id);
      expect(result.creditsGranted).toBe(0);
      const ledgerRows = await app.db
        .select()
        .from(schema.creditLedger)
        .where(eq(schema.creditLedger.userId, user.id));
      expect(ledgerRows).toHaveLength(0);
    } finally {
      await app.redis.del('config:system');
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- shopify-billing-sync`
Expected: FAIL — `grantShopifyTrialCredits` is not exported from `../../src/modules/shopify/billing.js`.

- [ ] **Step 3: Implement**

In `apps/api/src/modules/shopify/billing.ts`, add to the import from `./billing-plans.js`-adjacent import block — add a new import line after the existing `import { ... } from './billing-plans.js';` (line 4):

```ts
import { getShopifyTrialCredits } from '../../lib/resolution-config.js';
```

Add the function after `syncStoreSubscription` (after its closing `}` at line 157), before `buildPlanSelectionUrl`:

```ts
/**
 * Grants a one-time, admin-configured number of free trial credits to a
 * store's owner the moment the store first gets linked to an TryMe
 * account (POST /v1/shopify/store/account/link). Independent of Shopify's
 * own day-based trialDays billing trial and of any paid subscription — this
 * exists so a merchant can try the feature before picking a plan.
 *
 * Idempotent via the same external_ref partial unique index (migration 0148)
 * syncStoreSubscription relies on above, keyed on store id alone so this is
 * strictly one-time per store: unlinking and relinking the same store does
 * not re-grant, but a different store linked to the same owner does.
 */
export async function grantShopifyTrialCredits(
  app: FastifyInstance,
  store: Store,
  userId: string,
): Promise<{ creditsGranted: number }> {
  const amount = await getShopifyTrialCredits(app);
  if (amount <= 0) return { creditsGranted: 0 };

  const externalRef = `shopify_trial:${store.id}`;
  const granted = await app.db.transaction(async (tx) => {
    const inserted = await tx
      .insert(schema.creditLedger)
      .values({ userId, delta: amount, reason: 'SHOPIFY_TRIAL', externalRef })
      .onConflictDoNothing()
      .returning({ id: schema.creditLedger.id });
    if (!inserted.length) return false;
    await tx
      .insert(schema.userCredits)
      .values({ userId, balance: amount })
      .onConflictDoUpdate({
        target: schema.userCredits.userId,
        set: { balance: sql`${schema.userCredits.balance} + ${amount}`, updatedAt: new Date() },
      });
    return true;
  });

  return { creditsGranted: granted ? amount : 0 };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @tryme/api test -- shopify-billing-sync`
Expected: PASS (all tests in file, including the 4 new ones)

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/shopify/billing.ts apps/api/test/integration/shopify-billing-sync.test.ts
git commit -m "feat(api): add grantShopifyTrialCredits transactional grant helper"
```

---

### Task 4: Wire the grant into account-link

**Files:**
- Modify: `apps/api/src/modules/shopify/auth.routes.ts:269-285`
- Test: `apps/api/test/shopify-store-account-link.test.ts`

**Interfaces:**
- Consumes: `grantShopifyTrialCredits` from `./billing.js` (Task 3).
- Produces: nothing new for later tasks — this is the final backend wiring point.

- [ ] **Step 1: Write the failing test**

`apps/api/test/shopify-store-account-link.test.ts` already imports `schema` from `@tryme/db` and `eq` from `drizzle-orm` (lines 1-2) — no new imports needed.

Extend the `it('sets ownerUserId given a valid code', ...)` test (lines 48-67) — add after the existing `expect(store.ownerUserId).toBe(userId);` assertion:

```ts
    const [credits] = await app.db
      .select({ balance: schema.userCredits.balance })
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, userId));
    expect(credits?.balance).toBe(25);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- shopify-store-account-link`
Expected: FAIL — `credits` is `undefined` (no `user_credits` row was created).

- [ ] **Step 3: Implement**

In `apps/api/src/modules/shopify/auth.routes.ts`, add to the imports at the top (after line 11, `import { markWidgetConfigUnsynced, publishLatestConfig } from './widget-config.routes.js';`):

```ts
import { grantShopifyTrialCredits } from './billing.js';
```

In the `POST /v1/shopify/store/account/link` handler (lines 269-285), replace:

```ts
      await app.db
        .update(schema.shopifyStores)
        .set({ ownerUserId: userId, updatedAt: new Date() })
        .where(eq(schema.shopifyStores.id, store.id));
      return { ok: true };
```

with:

```ts
      await app.db
        .update(schema.shopifyStores)
        .set({ ownerUserId: userId, updatedAt: new Date() })
        .where(eq(schema.shopifyStores.id, store.id));
      const { creditsGranted } = await grantShopifyTrialCredits(app, store, userId);
      req.log.debug({ storeId: store.id, userId, creditsGranted }, 'shopify trial credit grant');
      return { ok: true };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @tryme/api test -- shopify-store-account-link`
Expected: PASS (all tests in file)

- [ ] **Step 5: Run the full API test suite and typecheck**

Run: `pnpm --filter @tryme/api test && pnpm --filter @tryme/api typecheck`
Expected: all pass, no type errors

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/shopify/auth.routes.ts apps/api/test/shopify-store-account-link.test.ts
git commit -m "feat(shopify): grant free trial credits on account link"
```

---

### Task 5: Admin Settings UI

**Files:**
- Modify: `apps/admin-web/src/pages/SettingsPage.tsx`

**Interfaces:**
- Consumes: `GET`/`PATCH /admin/config` `shopify.trialCredits` field (Task 2).
- Produces: nothing consumed elsewhere — terminal task.

No test step: `apps/admin-web` has no test suite in this repo (confirmed — no `.test.tsx` files exist under `apps/admin-web`). This task is verified via typecheck and a manual check with `pnpm --filter @tryme/admin dev`.

- [ ] **Step 1: Add state**

In `apps/admin-web/src/pages/SettingsPage.tsx`, add after `const [pixverseCreditCost, setPixverseCreditCost] = useState(150);` (line 617):

```tsx
  const [shopifyTrialCredits, setShopifyTrialCredits] = useState(25);
```

- [ ] **Step 2: Read it from `GET /admin/config`**

In the `apiFetch<{...}>('/admin/config')` type literal (around line 656-668), add a field after `pixverse?: { creditCost: number };`:

```tsx
      shopify?: { trialCredits: number };
```

In the `.then((cfg) => { ... })` body, add after `if (cfg.pixverse) setPixverseCreditCost(cfg.pixverse.creditCost);` (line 679):

```tsx
        if (cfg.shopify) setShopifyTrialCredits(cfg.shopify.trialCredits);
```

- [ ] **Step 3: Include it in the `PATCH /admin/config` save payload**

In the `saveSysConfig` body (around line 785-808), add after `pixverse: { creditCost: pixverseCreditCost },` (line 795):

```tsx
          shopify: { trialCredits: shopifyTrialCredits },
```

- [ ] **Step 4: Add the form field**

In the JSX, after the "Catalog Video (PixVerse)" block closes (after the `</div>` at line 1749, before the `<div style={{ marginTop: 24, marginBottom: 8 }}>` "App Video" block starting at line 1751), insert:

```tsx
                <div style={{ marginTop: 24, marginBottom: 8 }}>
                  <div className="setting-lbl" style={{ marginBottom: 4 }}>
                    Shopify Free Trial
                  </div>
                  <div className="setting-desc" style={{ marginBottom: 12 }}>
                    Credits granted once, automatically, the first time a Shopify store links to
                    an TryMe account — before the merchant picks a paid plan. Independent of any
                    day-based trial configured in Partner Dashboard.
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
                    <span className="setting-lbl">Trial Credits</span>
                    <div
                      style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}
                    >
                      <input
                        className="input"
                        type="number"
                        min={0}
                        max={1000}
                        style={{ width: 80, textAlign: 'right' }}
                        value={shopifyTrialCredits}
                        disabled={sysSaving}
                        onChange={(e) => setShopifyTrialCredits(Number(e.target.value))}
                      />
                      <span style={{ fontSize: 13, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                        credits / store
                      </span>
                    </div>
                  </div>
                </div>
```

- [ ] **Step 5: Extend Save-button validation**

In the `disabled={...}` prop of the Save button (around line 2096-2104), add:

```tsx
                      sysSaving ||
                      !Number.isInteger(maxOutputPx) ||
                      maxOutputPx < 512 ||
                      maxOutputPx > 4096 ||
                      !Number.isInteger(maxBatchJobs) ||
                      maxBatchJobs < 1 ||
                      maxBatchJobs > 2000 ||
                      !Number.isInteger(shopifyTrialCredits) ||
                      shopifyTrialCredits < 0 ||
                      shopifyTrialCredits > 1000
```

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @tryme/admin typecheck`
Expected: no errors

- [ ] **Step 7: Manual verification**

Run: `pnpm --filter @tryme/admin dev`, open Settings, confirm the "Shopify Free Trial" field loads with the value from `GET /admin/config` (25 by default), edit it, click Save, reload the page, confirm the new value persists.

- [ ] **Step 8: Commit**

```bash
git add apps/admin-web/src/pages/SettingsPage.tsx
git commit -m "feat(admin): add Shopify trial credits field to Settings"
```

---

## Follow-up (not part of this plan)

- No UI feedback to the merchant when trial credits land (deliberately deferred per the design spec's Non-goals).
- No interaction with Shopify Partner Dashboard's own `trialDays` setting — that remains a separate, orthogonal lever the store owner may also configure there.
