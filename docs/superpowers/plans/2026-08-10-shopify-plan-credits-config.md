# Shopify Plan Credits — Admin Config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the per-plan Shopify credit grant (starter/growth/pro) admin-configurable via the existing Settings page, instead of hardcoded in `billing-plans.ts`, without changing behavior when no override is set.

**Architecture:** Same pattern as the already-shipped Shopify trial credits: a Redis-backed `config:system` value, read through a small helper in `apps/api/src/lib/resolution-config.ts`, editable from `apps/admin-web/src/pages/SettingsPage.tsx` via `GET`/`PATCH /admin/config`. `syncStoreSubscription` (`apps/api/src/modules/shopify/billing.ts`) switches from the synchronous `creditsForPlanName` lookup to the new async, config-aware `getShopifyPlanCredits`.

**Tech Stack:** Fastify 5, Drizzle ORM, Zod (`fastify-type-provider-zod`), Vitest, ioredis (`app.redis`), React (admin-web, no test suite for that app in this repo).

## Global Constraints

- The 3 plan handles (`starter`, `growth`, `pro`) stay hardcoded — not admin-configurable. Only their credit amounts become configurable.
- Default values are unchanged: starter 1925, growth 5000, pro 22000. Existing `shopify-billing-sync.test.ts` assertions must keep passing without modification.
- `planCredits` fields are `.positive()` (not `.min(0)`) — a paid plan granting 0 credits per cycle is not a meaningful state, unlike the trial's 0.
- `shopify.trialCredits` becomes `.optional()` in `SystemConfigBody` (small consistency fix, bundled into Task 2 since it's the same schema block).
- No change to `apps/shopify/src/lib/planFeatures.ts` (frontend display copy) — explicitly out of scope.
- Follow existing patterns exactly: `apps/api/src/lib/resolution-config.ts` for the config reader, `uploadLimits`'s nested-merge idiom in `config.routes.ts` for partial-override default-filling.

---

### Task 1: Export the default plan-credit map

**Files:**
- Modify: `apps/api/src/modules/shopify/billing-plans.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `DEFAULT_CREDITS_BY_PLAN_HANDLE: Record<ShopifyPlanHandle, number>`, exported from `apps/api/src/modules/shopify/billing-plans.ts`. Task 2 and Task 4 both import it.

No test step — this is a pure rename-and-export with the same values; `creditsForPlanName`'s behavior is unchanged and `billing-plans.test.ts` doesn't reference the map by name, only through `creditsForPlanName`. Verified by the existing test suite in Task 1's own commit step.

- [ ] **Step 1: Rename and export**

In `apps/api/src/modules/shopify/billing-plans.ts`, replace:

```ts
const CREDITS_BY_PLAN_HANDLE: Record<ShopifyPlanHandle, number> = {
  starter: 1925,
  growth: 5000,
  pro: 22000,
};
```

with:

```ts
export const DEFAULT_CREDITS_BY_PLAN_HANDLE: Record<ShopifyPlanHandle, number> = {
  starter: 1925,
  growth: 5000,
  pro: 22000,
};
```

Update the one reference to the old name in `creditsForPlanName`:

```ts
/** Credits granted per billing cycle, or null when the name is not a plan we know. */
export function creditsForPlanName(name: string): number | null {
  return (DEFAULT_CREDITS_BY_PLAN_HANDLE as Record<string, number>)[normalizePlanName(name)] ?? null;
}
```

- [ ] **Step 2: Run the existing test file to confirm nothing broke**

Run: `pnpm --filter @tryme/api test -- billing-plans`
Expected: PASS (4/4, unchanged)

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/modules/shopify/billing-plans.ts
git commit -m "refactor(api): export default Shopify plan-credit map"
```

---

### Task 2: Config-aware reader (`getShopifyPlanCredits`) and schema

**Files:**
- Modify: `apps/api/src/lib/resolution-config.ts`
- Modify: `packages/types/src/admin.ts`
- Test: `apps/api/test/resolution-config.test.ts`

**Interfaces:**
- Consumes: `DEFAULT_CREDITS_BY_PLAN_HANDLE`, `normalizePlanName`, `SHOPIFY_PLAN_HANDLES`, `type ShopifyPlanHandle` from `apps/api/src/modules/shopify/billing-plans.ts` (Task 1).
- Produces: `getShopifyPlanCredits(app: FastifyInstance, planName: string): Promise<number | null>`, exported from `apps/api/src/lib/resolution-config.ts`. Task 3 imports and calls this. `SystemConfigBody.shopify.planCredits` (Zod schema), consumed by Task 3's route.

- [ ] **Step 1: Write the failing tests**

In `apps/api/test/resolution-config.test.ts`, add a new `describe` block after the existing `describe('getShopifyTrialCredits', ...)` block (append at end of file):

```ts
describe('getShopifyPlanCredits', () => {
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

  it('falls back to the default amount for each known handle when nothing is stored', async () => {
    expect(await getShopifyPlanCredits(app, 'starter')).toBe(1925);
    expect(await getShopifyPlanCredits(app, 'growth')).toBe(5000);
    expect(await getShopifyPlanCredits(app, 'pro')).toBe(22000);
  });

  it('matches case-insensitively, same as normalizePlanName', async () => {
    expect(await getShopifyPlanCredits(app, 'Starter')).toBe(1925);
    expect(await getShopifyPlanCredits(app, '  GROWTH ')).toBe(5000);
  });

  it('returns null for an unrecognized plan name', async () => {
    expect(await getShopifyPlanCredits(app, 'enterprise')).toBeNull();
    expect(await getShopifyPlanCredits(app, '')).toBeNull();
  });

  it('reads an admin-configured override for one handle, leaving others at default', async () => {
    await app.redis.set(CONFIG_KEY, JSON.stringify({ shopify: { planCredits: { starter: 3000 } } }));
    expect(await getShopifyPlanCredits(app, 'starter')).toBe(3000);
    expect(await getShopifyPlanCredits(app, 'growth')).toBe(5000);
  });

  it('falls back to the default when the stored value is malformed', async () => {
    await app.redis.set(CONFIG_KEY, 'not json');
    expect(await getShopifyPlanCredits(app, 'pro')).toBe(22000);
  });
});
```

Add `getShopifyPlanCredits` to the existing import from `'../src/lib/resolution-config.js'` at the top of the file.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- resolution-config`
Expected: FAIL — `getShopifyPlanCredits` is not exported from `../src/lib/resolution-config.js`.

- [ ] **Step 3: Implement the reader**

In `apps/api/src/lib/resolution-config.ts`, add to the import list at the top of the file:

```ts
import {
  DEFAULT_CREDITS_BY_PLAN_HANDLE,
  normalizePlanName,
  SHOPIFY_PLAN_HANDLES,
  type ShopifyPlanHandle,
} from '../modules/shopify/billing-plans.js';
```

Add after `getShopifyTrialCredits` (end of file):

```ts
/**
 * Reads the admin-configured credit grant for one Shopify Managed Pricing
 * plan (starter/growth/pro) from the same `config:system` Redis key the
 * admin panel edits. Returns null for a plan name that doesn't match one of
 * SHOPIFY_PLAN_HANDLES — same "unrecognized plan grants nothing" behavior
 * creditsForPlanName had. Falls back to DEFAULT_CREDITS_BY_PLAN_HANDLE for a
 * known handle if nothing is stored yet, or the entry is missing/malformed.
 */
export async function getShopifyPlanCredits(
  app: FastifyInstance,
  planName: string,
): Promise<number | null> {
  const handle = normalizePlanName(planName);
  if (!(SHOPIFY_PLAN_HANDLES as readonly string[]).includes(handle)) return null;
  const knownHandle = handle as ShopifyPlanHandle;
  try {
    const raw = await app.redis.get(CONFIG_KEY);
    const cfg = raw ? JSON.parse(raw) : {};
    const credits = cfg.shopify?.planCredits?.[knownHandle];
    return typeof credits === 'number' ? credits : DEFAULT_CREDITS_BY_PLAN_HANDLE[knownHandle];
  } catch {
    return DEFAULT_CREDITS_BY_PLAN_HANDLE[knownHandle];
  }
}
```

- [ ] **Step 4: Extend the schema**

In `packages/types/src/admin.ts`, replace the `shopify` field:

```ts
  shopify: z
    .object({
      trialCredits: z.number().int().min(0).max(1000),
    })
    .optional(),
```

with:

```ts
  shopify: z
    .object({
      trialCredits: z.number().int().min(0).max(1000).optional(),
      planCredits: z
        .object({
          starter: z.number().int().positive().max(1_000_000),
          growth: z.number().int().positive().max(1_000_000),
          pro: z.number().int().positive().max(1_000_000),
        })
        .partial()
        .optional(),
    })
    .optional(),
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @tryme/api test -- resolution-config`
Expected: PASS (9/9 — 4 existing `getShopifyTrialCredits` + 5 new `getShopifyPlanCredits`)

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @tryme/api typecheck && pnpm --filter @tryme/types typecheck`
Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/lib/resolution-config.ts packages/types/src/admin.ts apps/api/test/resolution-config.test.ts
git commit -m "feat(api): add admin-configurable Shopify per-plan credit reader"
```

---

### Task 3: Wire `syncStoreSubscription` to the config-aware reader

**Files:**
- Modify: `apps/api/src/modules/shopify/billing.ts:1-90`
- Test: `apps/api/test/integration/shopify-billing-sync.test.ts`

**Interfaces:**
- Consumes: `getShopifyPlanCredits` from `apps/api/src/lib/resolution-config.ts` (Task 2).
- Produces: nothing new for later tasks.

- [ ] **Step 1: Write the failing test**

In `apps/api/test/integration/shopify-billing-sync.test.ts`, add a new `it` inside the existing `describe('syncStoreSubscription', ...)` block, after the last test in that block (`'does not forfeit the cycle when the plan name is unrecognized'`, currently ending right before the block's closing `});`):

```ts
  it('grants the admin-overridden amount when a planCredits override is configured', async () => {
    const { user, store } = await seedOwnerAndStore();
    await app.redis.set('config:system', JSON.stringify({ shopify: { planCredits: { growth: 9000 } } }));

    try {
      const result = await syncStoreSubscription(app, store, {
        getActiveSubscription: async () => sub({ name: 'growth' }),
      });

      expect(result.creditsGranted).toBe(9000);
      const [balanceRow] = await app.db
        .select({ balance: schema.userCredits.balance })
        .from(schema.userCredits)
        .where(eq(schema.userCredits.userId, user.id));
      expect(balanceRow?.balance).toBe(9000);
    } finally {
      await app.redis.del('config:system');
    }
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts test/integration/shopify-billing-sync.test.ts`
Expected: FAIL — `result.creditsGranted` is `5000` (the hardcoded default), not `9000`, because `syncStoreSubscription` doesn't consult `config:system` yet.

- [ ] **Step 3: Implement**

In `apps/api/src/modules/shopify/billing.ts`, change the import on line 4-5:

```ts
import { getShopifyTrialCredits } from '../../lib/resolution-config.js';
import { creditsForPlanName, normalizePlanName } from './billing-plans.js';
```

to:

```ts
import { getShopifyPlanCredits, getShopifyTrialCredits } from '../../lib/resolution-config.js';
import { normalizePlanName } from './billing-plans.js';
```

Change line 80:

```ts
  const amount = planHandle ? creditsForPlanName(planHandle) : null;
```

to:

```ts
  const amount = planHandle ? await getShopifyPlanCredits(app, planHandle) : null;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts test/integration/shopify-billing-sync.test.ts`
Expected: PASS — all tests in the file, including the 6 pre-existing `syncStoreSubscription` credit-amount assertions (unchanged, still pass because defaults are identical), the 4 `grantShopifyTrialCredits` tests, and the 1 new override test (16 total).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/shopify/billing.ts apps/api/test/integration/shopify-billing-sync.test.ts
git commit -m "feat(api): read Shopify per-plan credits from admin config in syncStoreSubscription"
```

---

### Task 4: Default-fill `planCredits` on `GET /admin/config`

**Files:**
- Modify: `apps/api/src/modules/admin/config.routes.ts:1-56`
- Test: `apps/api/test/integration/admin-config.test.ts`

**Interfaces:**
- Consumes: `DEFAULT_CREDITS_BY_PLAN_HANDLE` from `apps/api/src/modules/shopify/billing-plans.ts` (Task 1); `DEFAULT_SHOPIFY_TRIAL_CONFIG` (already imported in this file).
- Produces: `GET /admin/config` response always includes `shopify.planCredits.{starter,growth,pro}` (default-filled, nested merge). Nothing consumed by later tasks in this plan — Task 5 (admin-web) reads this shape but doesn't need any new export, just the response JSON shape.

- [ ] **Step 1: Write the failing test**

In `apps/api/test/integration/admin-config.test.ts`, add a new `it` block after the existing "GET /admin/config default-fills shopify trial credits, and PATCH persists an override" test:

```ts
  it('GET /admin/config default-fills shopify plan credits, and a partial PATCH keeps other plans at default', async () => {
    const getRes = await app.inject({ method: 'GET', url: '/admin/config', headers: adminAuth });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().shopify.planCredits).toEqual({ starter: 1925, growth: 5000, pro: 22000 });

    const patchRes = await app.inject({
      method: 'PATCH',
      url: '/admin/config',
      headers: { ...adminAuth, 'content-type': 'application/json' },
      payload: JSON.stringify({ shopify: { planCredits: { starter: 3000 } } }),
    });
    expect(patchRes.statusCode).toBe(200);

    const getRes2 = await app.inject({ method: 'GET', url: '/admin/config', headers: adminAuth });
    expect(getRes2.json().shopify.planCredits).toEqual({ starter: 3000, growth: 5000, pro: 22000 });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts test/integration/admin-config.test.ts`
Expected: FAIL — `getRes.json().shopify.planCredits` is `undefined`.

- [ ] **Step 3: Implement**

In `apps/api/src/modules/admin/config.routes.ts`, add `DEFAULT_CREDITS_BY_PLAN_HANDLE` as a new import (new module, `../shopify/billing-plans.js`) after the existing `import { DEFAULT_UPLOAD_LIMITS } from '../../lib/upload-limits-config.js';` line:

```ts
import { DEFAULT_CREDITS_BY_PLAN_HANDLE } from '../shopify/billing-plans.js';
```

Replace:

```ts
      cfg.shopify = cfg.shopify ?? DEFAULT_SHOPIFY_TRIAL_CONFIG;
```

with:

```ts
      cfg.shopify = {
        trialCredits: cfg.shopify?.trialCredits ?? DEFAULT_SHOPIFY_TRIAL_CONFIG.trialCredits,
        planCredits: { ...DEFAULT_CREDITS_BY_PLAN_HANDLE, ...cfg.shopify?.planCredits },
      };
```

`PATCH /admin/config` needs no change — already shallow-merges the validated body into stored JSON.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/api && npx vitest run --config vitest.integration.config.ts test/integration/admin-config.test.ts`
Expected: PASS (all tests in file)

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @tryme/api typecheck`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/admin/config.routes.ts apps/api/test/integration/admin-config.test.ts
git commit -m "feat(api): default-fill Shopify plan credits on GET /admin/config"
```

---

### Task 5: Admin Settings UI

**Files:**
- Modify: `apps/admin-web/src/pages/SettingsPage.tsx`

**Interfaces:**
- Consumes: `GET`/`PATCH /admin/config` `shopify.planCredits.{starter,growth,pro}` (Task 4).
- Produces: nothing consumed elsewhere — terminal task.

No test step: `apps/admin-web` has no test suite in this repo. Verified via typecheck/build and a manual check with `pnpm --filter @tryme/admin dev`, same as the trial-credits UI task.

- [ ] **Step 1: Add state**

In `apps/admin-web/src/pages/SettingsPage.tsx`, add after `const [shopifyTrialCredits, setShopifyTrialCredits] = useState(25);`:

```tsx
  const [shopifyPlanCredits, setShopifyPlanCredits] = useState({
    starter: 1925,
    growth: 5000,
    pro: 22000,
  });
```

- [ ] **Step 2: Read it from `GET /admin/config`**

In the `apiFetch<{...}>('/admin/config')` type literal, change:

```tsx
      shopify?: { trialCredits: number };
```

to:

```tsx
      shopify?: { trialCredits: number; planCredits?: { starter: number; growth: number; pro: number } };
```

In the `.then((cfg) => { ... })` body, change:

```tsx
        if (cfg.shopify) setShopifyTrialCredits(cfg.shopify.trialCredits);
```

to:

```tsx
        if (cfg.shopify) {
          setShopifyTrialCredits(cfg.shopify.trialCredits);
          if (cfg.shopify.planCredits) setShopifyPlanCredits(cfg.shopify.planCredits);
        }
```

- [ ] **Step 3: Include it in the `PATCH /admin/config` save payload**

Change:

```tsx
          shopify: { trialCredits: shopifyTrialCredits },
```

to:

```tsx
          shopify: { trialCredits: shopifyTrialCredits, planCredits: shopifyPlanCredits },
```

- [ ] **Step 4: Add the form fields**

In the JSX, inside the "Shopify Free Trial" block added previously, after the existing Trial Credits row's closing `</div>` and before that block's outer closing `</div>`, insert three more rows of the same shape (one per plan). Insert this immediately after the Trial Credits `<div style={{ display: 'flex', alignItems: 'center', gap: 12, ... }}>...</div>` block, still inside the "Shopify Free Trial" outer `<div style={{ marginTop: 24, marginBottom: 8 }}>`:

```tsx
                  <div style={{ marginTop: 12, display: 'grid', gap: 8 }}>
                    {(['starter', 'growth', 'pro'] as const).map((plan) => (
                      <div
                        key={plan}
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
                        <span className="setting-lbl" style={{ textTransform: 'capitalize' }}>
                          {plan}
                        </span>
                        <div
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 6,
                            marginLeft: 'auto',
                          }}
                        >
                          <input
                            className="input"
                            type="number"
                            min={1}
                            max={1000000}
                            style={{ width: 100, textAlign: 'right' }}
                            value={shopifyPlanCredits[plan]}
                            disabled={sysSaving}
                            onChange={(e) =>
                              setShopifyPlanCredits((prev) => ({
                                ...prev,
                                [plan]: Number(e.target.value),
                              }))
                            }
                          />
                          <span style={{ fontSize: 13, color: 'var(--muted)', whiteSpace: 'nowrap' }}>
                            credits / cycle
                          </span>
                        </div>
                      </div>
                    ))}
                  </div>
```

- [ ] **Step 5: Extend Save-button validation**

In the Save button's `disabled={...}` prop, add after the `shopifyTrialCredits` checks:

```tsx
                      !Number.isInteger(shopifyPlanCredits.starter) ||
                      shopifyPlanCredits.starter < 1 ||
                      shopifyPlanCredits.starter > 1000000 ||
                      !Number.isInteger(shopifyPlanCredits.growth) ||
                      shopifyPlanCredits.growth < 1 ||
                      shopifyPlanCredits.growth > 1000000 ||
                      !Number.isInteger(shopifyPlanCredits.pro) ||
                      shopifyPlanCredits.pro < 1 ||
                      shopifyPlanCredits.pro > 1000000
```

- [ ] **Step 6: Typecheck / build**

Run: `pnpm --filter @tryme/admin build`
Expected: no errors, build succeeds

- [ ] **Step 7: Manual verification**

Run: `pnpm --filter @tryme/admin dev`, open Settings, confirm the "Shopify Free Trial" section now also shows Starter/Growth/Pro credit fields loaded from `GET /admin/config` (1925/5000/22000 by default), edit one, click Save, reload, confirm it persists and the other two are unaffected.

- [ ] **Step 8: Commit**

```bash
git add apps/admin-web/src/pages/SettingsPage.tsx
git commit -m "feat(admin): add Shopify per-plan credit fields to Settings"
```

---

## Follow-up (not part of this plan)

- Whether to feed `apps/shopify/src/lib/planFeatures.ts`'s display numbers from this same config, so the in-app pricing page can't drift from actual billing amounts — deferred per the design spec's Non-goals.
