# Shopify Merchant Account Link + Drop Shopify-Native Billing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Link a Shopify merchant's tryme user account to their `shopify_stores` row (mandatory gate in the embedded admin), and remove Shopify-native billing entirely in favor of `app.tryme.com/pricing`.

**Architecture:** Add `shopify_stores.ownerUserId` (nullable FK to `users`). Reuse the existing shopper popup-login infrastructure unchanged (`mintAccountLinkCode`, `resolveAccountLinkCode`, the `/widget-link-complete` page) — only a new merchant-side exchange endpoint (`POST /v1/shopify/store/account/link`, authenticated via the embedded admin's existing `requireShopifySession`) is net-new on the backend. The embedded admin (`apps/shopify`) gates every screen behind a link prompt until `ownerUserId` is set, then shows a read-only credit balance + a link out to `/pricing`. Shopify's `recurring_application_charge` billing flow, `shopify_plans` table, and all supporting admin CRUD are deleted.

**Tech Stack:** Fastify 5 + zod, Drizzle ORM/PostgreSQL, Redis (ioredis), React 18 + Shopify Polaris + React Router (Vite), Vitest.

## Global Constraints

- Never hand-write migration SQL or snapshot JSON — edit `packages/db/src/schema/*.ts`, then run `pnpm db:generate`. (Project convention, `CLAUDE.md`.)
- `pnpm docker:up` must be running before any `pnpm db:generate` / `pnpm db:migrate` / test run.
- Run `pnpm --filter @tryme/db build` after every `schema.ts` edit before running typecheck elsewhere — stale `dist/` output causes phantom type errors in `apps/api`.
- Biome pre-commit hook (lefthook) runs on every commit; if it fails on auto-fixable issues, run `pnpm biome check --write <file>` and re-commit — never `--no-verify`.
- Only commit when a task's own tests pass. Create a new commit per task; never amend.
- Do not touch `apps/admin-mobile` — it is explicitly paused per `CLAUDE.md`'s "Admin Mobile Paused" section (this supersedes the older Admin Parity Rule for the duration of the pause).
- No testcontainers. Use the existing harness: `apps/api/test/helpers/containers.ts` (`startContainers`) + `apps/api/test/helpers/api.ts` (`buildTestApp`). Requires `pnpm docker:up`.

---

### Task 1: Schema — add `ownerUserId`, drop Shopify-native billing tables/columns

**Files:**
- Modify: `packages/db/src/schema/shopify.ts`
- Migration (generated, not hand-written): `packages/db/src/migrations/01XX_*.sql` + matching `meta/01XX_snapshot.json`

**Interfaces:**
- Produces: `schema.shopifyStores.ownerUserId: string | null` (uuid, FK → `users.id`, `onDelete: 'set null'`) — every later task reads/writes this column via `schema.shopifyStores`.
- Removes: `schema.shopifyPlans` (entire export, deleted), `schema.shopifyStores.billingPlanId`, `schema.shopifyStores.shopifyPlanId`. Any remaining reference to these three anywhere in the codebase will now fail to compile — that's the signal for Task 2 to find and remove them.

- [ ] **Step 1: Edit `packages/db/src/schema/shopify.ts`**

Add the import at the top (alongside the existing `workflowTemplates` import):

```ts
import { workflowTemplates } from './models.js';
import { users } from './users.js';
```

Delete the entire `shopifyPlans` export block:

```ts
export const shopifyPlans = pgTable('shopify_plans', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  priceCents: integer('price_cents').notNull(),
  includedTryons: integer('included_tryons').notNull(),
  overageCents: integer('overage_cents').notNull(),
  trialDays: integer('trial_days').notNull().default(7),
  sortOrder: integer('sort_order').notNull().default(0),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
```

In the `shopifyStores` table definition, replace:

```ts
  billingPlanId: bigint('billing_plan_id', { mode: 'number' }),
  shopifyPlanId: uuid('shopify_plan_id').references(() => shopifyPlans.id),
```

with:

```ts
  ownerUserId: uuid('owner_user_id').references(() => users.id, { onDelete: 'set null' }),
```

(Leave every other field in `shopifyStores` — `storeKey`, `allowedOrigins`, `shopDomain`, etc. — untouched.)

- [ ] **Step 2: Rebuild `@tryme/db` and generate the migration**

```bash
pnpm docker:up
pnpm --filter @tryme/db build
pnpm db:generate
```

Expected: `drizzle-kit generate` prints a new migration file, e.g. `[✓] Your SQL migration file ➜ src/migrations/01XX_<generated-name>.sql`. Open it and confirm it contains exactly:
- `DROP TABLE "shopify_plans"` (and its FK drop on `shopify_stores`, if drizzle emits one first)
- `ALTER TABLE "shopify_stores" DROP COLUMN "billing_plan_id"`
- `ALTER TABLE "shopify_stores" DROP COLUMN "shopify_plan_id"`
- `ALTER TABLE "shopify_stores" ADD COLUMN "owner_user_id" uuid`
- an `ADD CONSTRAINT ... FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE SET NULL` (likely wrapped in the repo's usual `DO $$ ... EXCEPTION WHEN duplicate_object THEN null; END $$;` guard — that's fine, don't hand-edit it)

If drizzle-kit also proposes touching any unrelated table (a sign of the sparse-snapshot gap documented in `0090_backfill_migration_history.sql`), stop and re-check `packages/db/src/migrations/meta/` for the latest snapshot before proceeding — do not blindly apply an unrelated diff.

- [ ] **Step 3: Apply the migration and verify**

```bash
pnpm db:migrate
docker exec -i tryme-postgres psql -U tryon -d tryon_dev -c "\d shopify_stores" | grep -i owner
docker exec -i tryme-postgres psql -U tryon -d tryon_dev -c "\dt shopify_plans"
```

Expected: first command shows `owner_user_id | uuid |...`; second command shows `Did not find any relation named "shopify_plans"`.

- [ ] **Step 4: Rebuild db package (again, to pick up the migration's type-level effects) and commit**

```bash
pnpm --filter @tryme/db build
git add packages/db/src/schema/shopify.ts packages/db/src/migrations/
git commit -m "feat(db): add shopify_stores.ownerUserId, drop shopify_plans/billing columns"
```

---

### Task 2: Remove the Shopify-native billing surface

**Files:**
- Delete: `apps/api/src/modules/shopify/billing.routes.ts`
- Delete: `apps/api/src/modules/admin/shopify-plans.routes.ts`
- Delete: `apps/api/test/shopify-billing.test.ts`
- Delete: `apps/api/test/shopify-plans.test.ts`
- Modify: `apps/api/src/modules/shopify/routes.ts`
- Modify: `apps/api/src/server.ts`
- Delete: `apps/shopify/src/pages/BillingPage.tsx`
- Modify: `apps/shopify/src/App.tsx`
- Modify: `apps/shopify/src/components/AppShell.tsx`
- Modify: `apps/shopify/src/pages/DashboardPage.tsx`
- Modify: `apps/shopify/src/types.ts`

**Interfaces:**
- Consumes: Task 1's schema changes (this task's whole point is to delete every remaining reference to the now-gone `shopifyPlans`/`shopifyPlanId`/`billingPlanId`).
- Produces: nothing new — pure deletion. Task 4 (which edits `me.routes.ts`, one of the files that referenced `shopifyPlans`) depends on this task being done first so there's no leftover reference to remove twice.

- [ ] **Step 1: Delete the billing route file and its admin-CRUD counterpart**

```bash
git rm apps/api/src/modules/shopify/billing.routes.ts
git rm apps/api/src/modules/admin/shopify-plans.routes.ts
git rm apps/api/test/shopify-billing.test.ts
git rm apps/api/test/shopify-plans.test.ts
```

- [ ] **Step 2: Remove their registrations**

`shopifyBillingRoutes` is registered inside the Shopify module's own aggregator, not `server.ts` directly. In `apps/api/src/modules/shopify/routes.ts`, remove the import:

```ts
import { shopifyBillingRoutes } from './billing.routes.js';
```

and remove the registration line:

```ts
  await app.register(shopifyBillingRoutes);
```

`adminShopifyPlansRoutes`, on the other hand, **is** registered directly in `apps/api/src/server.ts`. Remove the import line:

```ts
import { adminShopifyPlansRoutes } from './modules/admin/shopify-plans.routes.js';
```

and the registration line:

```ts
  await app.register(adminShopifyPlansRoutes);
```

- [ ] **Step 3: Run typecheck to surface every remaining dangling reference**

```bash
pnpm --filter @tryme/api typecheck
```

Expected: errors pointing at every remaining usage of `schema.shopifyPlans`, `store.shopifyPlanId`, `store.billingPlanId` outside the files already deleted (at minimum `apps/api/src/modules/shopify/me.routes.ts` — leave that one for Task 4, which owns it). Fix any other TS error this surfaces the same way (delete the dead reference), but do **not** touch `me.routes.ts` in this task.

- [ ] **Step 4: Remove the Billing screen from the embedded admin**

```bash
git rm apps/shopify/src/pages/BillingPage.tsx
```

In `apps/shopify/src/App.tsx`, remove the import and route:

```ts
import BillingPage from './pages/BillingPage';
```

```tsx
          <Route path="/billing" element={<BillingPage />} />
```

In `apps/shopify/src/components/AppShell.tsx`, remove the nav entry:

```ts
  { to: '/billing', label: 'Billing' },
```

In `apps/shopify/src/pages/DashboardPage.tsx`, remove the "Manage Billing" button — find:

```tsx
              <InlineStack gap="200">
                <Button onClick={() => navigate('/products')}>Manage Products</Button>
                <Button onClick={() => navigate('/billing')}>Manage Billing</Button>
              </InlineStack>
```

replace with:

```tsx
              <InlineStack gap="200">
                <Button onClick={() => navigate('/products')}>Manage Products</Button>
              </InlineStack>
```

- [ ] **Step 5: Remove the now-dead `ShopifyPlan` type and `plan` field from `apps/shopify/src/types.ts`**

Delete this interface entirely:

```ts
export interface ShopifyPlan {
  id: string;
  name: string;
  priceCents: number;
  includedTryons: number;
  overageCents: number;
  trialDays: number;
  sortOrder: number;
  isActive: boolean;
  createdAt: string;
}
```

In the `ShopifyMe` interface, remove the `plan` field for now (Task 6 will redefine `ShopifyMe`'s full shape to match the new `/v1/shopify/me` response — this step just removes the dead reference so the file compiles cleanly in isolation):

```ts
export interface ShopifyMe {
  store: {
    shopDomain: string;
    settings: ShopifyStoreSettings;
  };
  plan: ShopifyPlan | null;
  stats: ShopifyStats;
}
```

becomes:

```ts
export interface ShopifyMe {
  store: {
    shopDomain: string;
    settings: ShopifyStoreSettings;
  };
  stats: ShopifyStats;
}
```

- [ ] **Step 6: Run the frontend typecheck/build**

```bash
pnpm --filter @tryme/shopify-admin typecheck
pnpm --filter @tryme/shopify-admin build
```

Expected: both pass (any remaining error means a reference to `BillingPage`/`ShopifyPlan`/`plan` was missed — fix before continuing).

- [ ] **Step 7: Commit**

```bash
git add -A apps/api/src/server.ts apps/api/src/modules/shopify/routes.ts apps/shopify apps/api/test
git commit -m "refactor(shopify): remove Shopify-native billing (recurring_application_charge, shopify_plans)"
```

---

### Task 3: New endpoint — `POST /v1/shopify/store/account/link`

**Files:**
- Modify: `apps/api/src/modules/shopify/auth.routes.ts`
- Test: `apps/api/test/shopify-store-account-link.test.ts` (new)

**Interfaces:**
- Consumes: `resolveAccountLinkCode(redis: Redis, code: string): Promise<string | null>` from `apps/api/src/modules/shopify/customer-auth.ts` (existing, unmodified — do not touch this file). `app.requireShopifySession` preHandler from `apps/api/src/plugins/shopify-auth.ts` (existing, unmodified) — decorates `req.shopifyStore: typeof schema.shopifyStores.$inferSelect | undefined`.
- Produces: `POST /v1/shopify/store/account/link` — body `{ code: string }`, requires a valid Shopify App Bridge session token (same auth as `GET /v1/shopify/me`), returns `{ ok: true }` on success and sets `shopify_stores.ownerUserId` for the requesting store. Task 6's frontend gate calls this endpoint directly.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/shopify-store-account-link.test.ts`:

```ts
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mintAccountLinkCode } from '../src/modules/shopify/customer-auth.js';
import { upsertShopifyStore } from '../src/modules/shopify/auth.routes.js';
import { createVerifiedUserToken } from './helpers/auth.js';
import { buildTestApp, type TestApp } from './helpers/api.js';
import { type Containers, startContainers } from './helpers/containers.js';
import { signSessionToken } from './helpers/shopify-session.js';

const ENC_KEY = Buffer.alloc(32, 7).toString('base64');
const API_SECRET = 'test-secret';
const API_KEY = 'test-key';

let c: Containers;
let app: TestApp;
let storeId: string;
let sessionToken: string;

beforeAll(async () => {
  c = await startContainers();
  app = await buildTestApp(c, {
    SHOPIFY_TOKEN_ENC_KEY: ENC_KEY,
    SHOPIFY_API_SECRET: API_SECRET,
    SHOPIFY_API_KEY: API_KEY,
  });
  const store = await upsertShopifyStore(
    app,
    {
      shopifyShopId: 77,
      shopDomain: 'link-test.myshopify.com',
      myshopifyDomain: 'link-test.myshopify.com',
      name: 'Link Test',
      email: 'link@test.com',
    },
    'tok',
    'read_products',
  );
  storeId = store.id;
  sessionToken = signSessionToken('link-test.myshopify.com', API_SECRET, API_KEY);
});
afterAll(async () => {
  await app?.close();
  await c?.stop();
});

describe('POST /v1/shopify/store/account/link', () => {
  it('sets ownerUserId given a valid code', async () => {
    const { userId } = await createVerifiedUserToken(app, 'merchant-link@test.com');
    const code = await mintAccountLinkCode(app.redis, userId);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/shopify/store/account/link',
      headers: { authorization: `Bearer ${sessionToken}` },
      payload: { code },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });

    const [store] = await app.db
      .select()
      .from(schema.shopifyStores)
      .where(eq(schema.shopifyStores.id, storeId));
    expect(store.ownerUserId).toBe(userId);
  });

  it('rejects an invalid or expired code', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/shopify/store/account/link',
      headers: { authorization: `Bearer ${sessionToken}` },
      payload: { code: 'not-a-real-code' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('rejects a code that was already burned by a previous exchange', async () => {
    const { userId } = await createVerifiedUserToken(app, 'merchant-link-2@test.com');
    const code = await mintAccountLinkCode(app.redis, userId);

    const first = await app.inject({
      method: 'POST',
      url: '/v1/shopify/store/account/link',
      headers: { authorization: `Bearer ${sessionToken}` },
      payload: { code },
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'POST',
      url: '/v1/shopify/store/account/link',
      headers: { authorization: `Bearer ${sessionToken}` },
      payload: { code },
    });
    expect(second.statusCode).toBe(401);
  });

  it('rejects a request with no session token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/shopify/store/account/link',
      payload: { code: 'irrelevant' },
    });
    expect(res.statusCode).toBe(401);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @tryme/api test -- shopify-store-account-link
```

Expected: FAIL — `404` (route not found) on the first test, since the endpoint doesn't exist yet.

- [ ] **Step 3: Implement the endpoint**

In `apps/api/src/modules/shopify/auth.routes.ts`, add the import (alongside the existing local imports):

```ts
import { resolveAccountLinkCode } from './customer-auth.js';
```

Add this route inside `shopifyAuthRoutes` (or wherever the existing `app.get('/v1/shopify/auth', ...)` / `app.get('/v1/shopify/auth/callback', ...)` routes are registered — same function, same file, right after them):

```ts
  app.post(
    '/v1/shopify/store/account/link',
    { preHandler: app.requireShopifySession },
    async (req) => {
      const { code } = req.body as { code?: string };
      if (!code) throw new AppError('VALIDATION', 400, 'code is required');
      const userId = await resolveAccountLinkCode(app.redis, code);
      if (!userId) throw new AppError('UNAUTHORIZED', 401, 'Link code invalid or expired');
      const store = req.shopifyStore;
      if (!store) throw new AppError('FORBIDDEN', 403, 'Store not installed');
      await app.db
        .update(schema.shopifyStores)
        .set({ ownerUserId: userId, updatedAt: new Date() })
        .where(eq(schema.shopifyStores.id, store.id));
      return { ok: true };
    },
  );
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @tryme/api test -- shopify-store-account-link
```

Expected: PASS (4/4).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/shopify/auth.routes.ts apps/api/test/shopify-store-account-link.test.ts
git commit -m "feat(api): add POST /v1/shopify/store/account/link to link a merchant's tryme account"
```

---

### Task 4: `GET /v1/shopify/me` — expose `ownerUserId` + credit balance, drop `plan`

**Files:**
- Modify: `apps/api/src/modules/shopify/me.routes.ts`
- Modify: `apps/api/test/shopify-me.test.ts`

**Interfaces:**
- Consumes: `schema.shopifyStores.ownerUserId` (Task 1), `schema.userCredits` (existing table, columns `userId`, `balance`).
- Produces: `GET /v1/shopify/me` response shape becomes:
  ```ts
  {
    store: { shopDomain: string; settings: ShopifyStoreSettings; ownerUserId: string | null };
    creditBalance: number | null; // null when ownerUserId is null (unlinked)
    stats: { totalTryOns: number; syncedProductCount: number; enabledProductCount: number; funnelConfigured: boolean };
  }
  ```
  Task 6's frontend (`apps/shopify`) reads exactly this shape.

- [ ] **Step 1: Write the failing test**

Add this test block to the end of `apps/api/test/shopify-me.test.ts` (inside the existing file, after the two existing `describe` blocks — reuses the same `beforeAll`-seeded `storeId`/`token`):

```ts
describe('GET /v1/shopify/me ownerUserId + creditBalance', () => {
  it('is unlinked by default: ownerUserId null, creditBalance null', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/shopify/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.json().store.ownerUserId).toBeNull();
    expect(res.json().creditBalance).toBeNull();
  });

  it('reflects the linked user\'s credit balance once ownerUserId is set', async () => {
    const [user] = await app.db
      .insert(schema.users)
      .values({ email: `me-owner-${randomUUID()}@test.com`, displayName: 'Owner' })
      .returning();
    await app.db.insert(schema.userCredits).values({ userId: user.id, balance: 42 });
    await app.db
      .update(schema.shopifyStores)
      .set({ ownerUserId: user.id })
      .where(eq(schema.shopifyStores.id, storeId));

    const res = await app.inject({
      method: 'GET',
      url: '/v1/shopify/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.json().store.ownerUserId).toBe(user.id);
    expect(res.json().creditBalance).toBe(42);
  });
});
```

(No new imports needed — `randomUUID`, `schema`, `eq` are already imported at the top of this file per its existing content.)

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @tryme/api test -- shopify-me
```

Expected: FAIL — `store.ownerUserId` is `undefined` (not in the response yet), `creditBalance` is `undefined`.

- [ ] **Step 3: Implement**

Replace the entire body of `apps/api/src/modules/shopify/me.routes.ts` with:

```ts
import { schema } from '@tryme/db';
import { and, count, eq, exists, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

export async function shopifyMeRoutes(app: FastifyInstance) {
  app.get('/v1/shopify/me', { preHandler: app.requireShopifySession }, async (req) => {
    const store = req.shopifyStore as typeof schema.shopifyStores.$inferSelect;

    let creditBalance: number | null = null;
    if (store.ownerUserId) {
      const [row] = await app.db
        .select({ balance: schema.userCredits.balance })
        .from(schema.userCredits)
        .where(eq(schema.userCredits.userId, store.ownerUserId))
        .limit(1);
      creditBalance = row?.balance ?? 0;
    }

    const [{ totalTryOns }] = await app.db
      .select({ totalTryOns: count() })
      .from(schema.jobs)
      .where(eq(schema.jobs.shopifyStoreId, store.id));

    const [{ syncedProductCount }] = await app.db
      .select({ syncedProductCount: count() })
      .from(schema.shopifyProductGarments)
      .where(eq(schema.shopifyProductGarments.storeId, store.id));

    const [{ enabledProductCount }] = await app.db
      .select({ enabledProductCount: count() })
      .from(schema.shopifyProductGarments)
      .where(
        and(
          eq(schema.shopifyProductGarments.storeId, store.id),
          eq(schema.shopifyProductGarments.enabled, true),
        ),
      );

    const [{ funnelConfigured }] = await app.db
      .select({
        funnelConfigured: exists(
          app.db
            .select()
            .from(schema.shopifyProductGarments)
            .where(
              and(
                eq(schema.shopifyProductGarments.storeId, store.id),
                sql`${schema.shopifyProductGarments.funnelTemplateId} is not null`,
              ),
            ),
        ),
      })
      .from(schema.shopifyStores)
      .where(eq(schema.shopifyStores.id, store.id))
      .limit(1);

    return {
      store: {
        shopDomain: store.shopDomain,
        settings: store.settings,
        ownerUserId: store.ownerUserId,
      },
      creditBalance,
      stats: { totalTryOns, syncedProductCount, enabledProductCount, funnelConfigured },
    };
  });
}
```

(This removes the `shopifyPlans` lookup block that previously computed `plan`, and adds the `ownerUserId`/`creditBalance` fields. Everything else — the four stat queries — is unchanged from the current file.)

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @tryme/api test -- shopify-me
```

Expected: PASS (all tests in the file, including the two pre-existing `stats` tests and the two new ones).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/shopify/me.routes.ts apps/api/test/shopify-me.test.ts
git commit -m "feat(api): GET /v1/shopify/me returns ownerUserId + linked user's credit balance"
```

---

### Task 5: `hasShopifyStore` on the main app's `GET /v1/me`

**Files:**
- Modify: `apps/api/src/modules/auth/routes.ts`
- Test: `apps/api/test/me-shopify-store-flag.test.ts` (new)

**Interfaces:**
- Consumes: `schema.shopifyStores.ownerUserId` (Task 1).
- Produces: `GET /v1/me` response gains a `hasShopifyStore: boolean` field. No other consumer in this plan reads it — it's the general-purpose "queryable signal" the whole feature was requested for, available to any future frontend/admin work.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/me-shopify-store-flag.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createVerifiedUserToken } from './helpers/auth.js';
import { buildTestApp, type TestApp } from './helpers/api.js';
import { type Containers, startContainers } from './helpers/containers.js';

let c: Containers;
let app: TestApp;

beforeAll(async () => {
  c = await startContainers();
  app = await buildTestApp(c);
});
afterAll(async () => {
  await app?.close();
  await c?.stop();
});

describe('GET /v1/me hasShopifyStore', () => {
  it('is false for a user with no linked store', async () => {
    const { token } = await createVerifiedUserToken(app, `no-store-${randomUUID()}@test.com`);
    const res = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.json().hasShopifyStore).toBe(false);
  });

  it('is true once a shopify_stores row has ownerUserId set to this user', async () => {
    const { token, userId } = await createVerifiedUserToken(
      app,
      `has-store-${randomUUID()}@test.com`,
    );
    await app.db.insert(schema.shopifyStores).values({
      shopDomain: `flag-test-${randomUUID()}.myshopify.com`,
      shopifyShopId: Date.now(),
      accessToken: 'enc',
      scope: 'read_products',
      ownerUserId: userId,
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.json().hasShopifyStore).toBe(true);
  });

  it('is false again once the linked store is uninstalled', async () => {
    const { token, userId } = await createVerifiedUserToken(
      app,
      `uninstalled-store-${randomUUID()}@test.com`,
    );
    await app.db.insert(schema.shopifyStores).values({
      shopDomain: `uninstalled-flag-test-${randomUUID()}.myshopify.com`,
      shopifyShopId: Date.now(),
      accessToken: 'enc',
      scope: 'read_products',
      ownerUserId: userId,
      uninstalledAt: new Date(),
    });

    const res = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.json().hasShopifyStore).toBe(false);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
pnpm --filter @tryme/api test -- me-shopify-store-flag
```

Expected: FAIL — `hasShopifyStore` is `undefined` on all three assertions.

- [ ] **Step 3: Implement**

In `apps/api/src/modules/auth/routes.ts`, change the import line:

```ts
import { and, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
```

to:

```ts
import { and, desc, eq, exists, gt, inArray, isNull, sql } from 'drizzle-orm';
```

Then replace the body of the `GET /v1/me` handler:

```ts
  app.get('/v1/me', { preHandler: app.requireUser }, async (req) => {
    const [user] = await app.db
      .select({
        id: schema.users.id,
        email: schema.users.email,
        displayName: schema.users.displayName,
        phone: schema.users.phone,
        companyName: schema.users.companyName,
        tier: schema.users.tier,
        passwordHash: schema.users.passwordHash,
      })
      .from(schema.users)
      .where(eq(schema.users.id, req.userId));
    if (!user) throw new AppError('NOT_FOUND', 404, 'user not found');
    const { passwordHash, ...rest } = user;
    return { ...rest, hasPassword: passwordHash !== null };
  });
```

with:

```ts
  app.get('/v1/me', { preHandler: app.requireUser }, async (req) => {
    const [user] = await app.db
      .select({
        id: schema.users.id,
        email: schema.users.email,
        displayName: schema.users.displayName,
        phone: schema.users.phone,
        companyName: schema.users.companyName,
        tier: schema.users.tier,
        passwordHash: schema.users.passwordHash,
      })
      .from(schema.users)
      .where(eq(schema.users.id, req.userId));
    if (!user) throw new AppError('NOT_FOUND', 404, 'user not found');
    const { passwordHash, ...rest } = user;

    const [{ hasShopifyStore }] = await app.db
      .select({
        hasShopifyStore: exists(
          app.db
            .select()
            .from(schema.shopifyStores)
            .where(
              and(
                eq(schema.shopifyStores.ownerUserId, req.userId),
                isNull(schema.shopifyStores.uninstalledAt),
              ),
            ),
        ),
      })
      .from(schema.users)
      .where(eq(schema.users.id, req.userId))
      .limit(1);

    return { ...rest, hasPassword: passwordHash !== null, hasShopifyStore };
  });
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
pnpm --filter @tryme/api test -- me-shopify-store-flag
```

Expected: PASS (3/3).

- [ ] **Step 5: Run the full API suite to catch any regression on the widely-used `/v1/me` route**

```bash
pnpm --filter @tryme/api test
```

Expected: all files pass, including this one.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/auth/routes.ts apps/api/test/me-shopify-store-flag.test.ts
git commit -m "feat(api): expose hasShopifyStore on GET /v1/me"
```

---

### Task 6: Embedded admin — mandatory link gate + minimal Dashboard

**Files:**
- Modify: `apps/shopify/src/types.ts`
- Create: `apps/shopify/src/components/LinkAccountGate.tsx`
- Modify: `apps/shopify/src/App.tsx`
- Modify: `apps/shopify/src/pages/DashboardPage.tsx`

**Interfaces:**
- Consumes: `POST /v1/shopify/store/account/link` (Task 3), `GET /v1/shopify/me` new response shape (Task 4), `apiFetch<T>(path, init)` from `apps/shopify/src/lib/api.ts` (existing, unmodified — already attaches the App Bridge session token as a Bearer header, retries once on 401).
- Produces: nothing consumed elsewhere in this plan — this is the terminal, user-facing task.

- [ ] **Step 1: Update `ShopifyMe` in `apps/shopify/src/types.ts` to match Task 4's response**

Replace:

```ts
export interface ShopifyMe {
  store: {
    shopDomain: string;
    settings: ShopifyStoreSettings;
  };
  stats: ShopifyStats;
}
```

with:

```ts
export interface ShopifyMe {
  store: {
    shopDomain: string;
    settings: ShopifyStoreSettings;
    ownerUserId: string | null;
  };
  creditBalance: number | null;
  stats: ShopifyStats;
}
```

- [ ] **Step 2: Create the gate component**

Create `apps/shopify/src/components/LinkAccountGate.tsx`. This mirrors the exact popup-opening, `postMessage`-listening, popup-closed-rejection pattern from `apps/shopify-extension/extensions/tryon-theme-extension/assets/tryon-widget.js`'s `linkAccount()` function, translated to TS/React:

```tsx
import { Banner, BlockStack, Button, Card, Page, Text } from '@shopify/polaris';
import { useState } from 'react';
import { apiFetch } from '../lib/api';

function openLinkPopup(): Promise<string> {
  return new Promise((resolve, reject) => {
    const nonce = Math.random().toString(36).slice(2);
    const origin = window.location.origin;
    const popup = window.open(
      `https://app.tryme.com/login?next=${encodeURIComponent(
        `/widget-link-complete?origin=${encodeURIComponent(origin)}&nonce=${nonce}`,
      )}`,
      'tryme-link',
      'width=480,height=640',
    );

    function onMessage(event: MessageEvent) {
      if (event.origin !== 'https://app.tryme.com') return;
      if (event.data?.type !== 'tryme-widget-link' || event.data.nonce !== nonce) return;
      window.removeEventListener('message', onMessage);
      resolve(event.data.code as string);
    }
    window.addEventListener('message', onMessage);

    const closeCheck = setInterval(() => {
      if (popup?.closed) {
        clearInterval(closeCheck);
        window.removeEventListener('message', onMessage);
        reject(new Error('Popup closed before linking completed'));
      }
    }, 500);
  });
}

export function LinkAccountGate({ onLinked }: { onLinked: () => void }) {
  const [linking, setLinking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function link() {
    setLinking(true);
    setError(null);
    try {
      const code = await openLinkPopup();
      await apiFetch('/v1/shopify/store/account/link', {
        method: 'POST',
        body: JSON.stringify({ code }),
      });
      onLinked();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLinking(false);
    }
  }

  return (
    <Page title="Link your tryme account">
      <Card>
        <BlockStack gap="300">
          <Text as="p">
            To use TryMe Try-On, link this store to your tryme account. Billing and
            credits are managed on app.tryme.com — nothing is charged through Shopify.
          </Text>
          {error && (
            <Banner tone="critical" title="Linking failed">
              {error}
            </Banner>
          )}
          <Button onClick={link} loading={linking} variant="primary">
            Link account
          </Button>
        </BlockStack>
      </Card>
    </Page>
  );
}
```

- [ ] **Step 3: Wire the gate into `App.tsx`**

Replace the full contents of `apps/shopify/src/App.tsx` with:

```tsx
import '@shopify/polaris/build/esm/styles.css';
import { AppProvider, Spinner } from '@shopify/polaris';
import { useCallback, useEffect, useState } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import { LinkAccountGate } from './components/LinkAccountGate';
import { apiFetch } from './lib/api';
import DashboardPage from './pages/DashboardPage';
import FunnelSetupPage from './pages/FunnelSetupPage';
import ProductsPage from './pages/ProductsPage';
import type { ShopifyMe } from './types';

export default function App() {
  const [me, setMe] = useState<ShopifyMe | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(() => {
    setLoading(true);
    apiFetch<ShopifyMe>('/v1/shopify/me')
      .then(setMe)
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  if (loading) {
    return (
      <AppProvider i18n={{}}>
        <Spinner accessibilityLabel="Loading" size="large" />
      </AppProvider>
    );
  }

  if (!me?.store.ownerUserId) {
    return (
      <AppProvider i18n={{}}>
        <LinkAccountGate onLinked={reload} />
      </AppProvider>
    );
  }

  return (
    <AppProvider i18n={{}}>
      <AppShell>
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/products" element={<ProductsPage />} />
          <Route path="/funnel-setup" element={<FunnelSetupPage />} />
          <Route path="/embedded" element={<Navigate to="/" replace />} />
        </Routes>
      </AppShell>
    </AppProvider>
  );
}
```

- [ ] **Step 4: Add the credit-balance + top-up card to `DashboardPage.tsx`**

In `apps/shopify/src/pages/DashboardPage.tsx`, find the closing `Card` block that currently ends the page (the one showing `me?.store.shopDomain` with the "Manage Products" button, already trimmed of "Manage Billing" in Task 2), and add a new `Card` right after the three-stat `InlineStack` block and before it:

```tsx
          <InlineStack gap="400">
            <Card>
              <Text as="h3" variant="headingSm">
                Try-Ons
              </Text>
              <Text as="p" variant="heading2xl">
                {me?.stats.totalTryOns ?? 0}
              </Text>
            </Card>
            <Card>
              <Text as="h3" variant="headingSm">
                Products Synced
              </Text>
              <Text as="p" variant="heading2xl">
                {me?.stats.syncedProductCount ?? 0}
              </Text>
            </Card>
            <Card>
              <Text as="h3" variant="headingSm">
                Products Enabled
              </Text>
              <Text as="p" variant="heading2xl">
                {me?.stats.enabledProductCount ?? 0}
              </Text>
            </Card>
          </InlineStack>

          <Card>
            <BlockStack gap="200">
              <Text as="h3" variant="headingSm">
                Credit Balance
              </Text>
              <Text as="p" variant="heading2xl">
                {me?.creditBalance ?? 0}
              </Text>
              <Button
                onClick={() => window.open('https://app.tryme.com/pricing', '_blank', 'noopener')}
              >
                Top up on tryme.com
              </Button>
            </BlockStack>
          </Card>

          <Card>
            <BlockStack gap="200">
              <Text as="h2" variant="headingMd">
                {me?.store.shopDomain}
              </Text>
              <InlineStack gap="200">
                <Button onClick={() => navigate('/products')}>Manage Products</Button>
              </InlineStack>
            </BlockStack>
          </Card>
```

(This is the `InlineStack`/final-`Card` region of the existing file with one new `Card` inserted between them — every other part of `DashboardPage.tsx`, including the "Getting Started" checklist above it, is unchanged.)

- [ ] **Step 5: Build and manually sanity-check**

```bash
pnpm --filter @tryme/shopify-admin typecheck
pnpm --filter @tryme/shopify-admin build
```

Expected: both pass. There is no automated test harness for `apps/shopify` (matches this repo's existing precedent — no test file exists for any page in this app today); this is verified by build + typecheck only, consistent with how `apps/shopify`'s prior features (Billing, Products) were verified in this codebase's history.

- [ ] **Step 6: Commit**

```bash
git add apps/shopify/src
git commit -m "feat(shopify-admin): mandatory account-link gate, credit balance on Dashboard"
```

---

## Self-Review Notes

- **Spec coverage:** §1 (schema) → Task 1. §2 (link flow, mandatory gate) → Tasks 3 + 6. §3 (dashboard content, billing redirect) → Tasks 2 + 6. §4 (`hasShopifyStore` signal) → Task 5. §5 (Partner logs) → no task, explicitly out of scope per the spec itself. Billing removal (§1's "drop entirely" confirmation) → Task 2.
- **Ordering rationale:** Task 2 (removal) is placed before Task 4 (which edits one of the files Task 2's typecheck pass will have already cleaned up) so there's no double-editing of `me.routes.ts`'s dead `plan` lookup.
- **Deferred, not part of this plan:** the admin-web analytics view (per-store product traffic, credit spend) — confirmed out of scope during brainstorming, gets its own spec/plan later.
