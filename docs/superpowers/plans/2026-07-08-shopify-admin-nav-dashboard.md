# Shopify Admin Nav Shell + Dashboard Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the "stuck on Products page" navigation gap and rebuild the Dashboard into a real home screen (Getting Started checklist + stat tiles), scoped to only what this app can honestly track today.

**Architecture:** Two small backend additions (a `stats` field on the existing `GET /v1/shopify/me`, and a new narrow `POST /v1/shopify/onboarding/confirm-theme-block`), then two frontend changes (a shared `AppShell` nav component wrapping every route, and a rebuilt `DashboardPage`).

**Tech Stack:** Fastify 5, Drizzle ORM, Zod, Vitest (backend tasks); React 18 + `@shopify/polaris` + `react-router-dom` v7 (frontend tasks, no test harness — matches every prior frontend task in this session).

## Global Constraints

- **No fabricated stats** — only `totalTryOns`, `syncedProductCount`, `enabledProductCount` are shown. No conversion %, no revenue $ (neither is tracked anywhere in this codebase).
- **`confirm-theme-block` is a narrow, single-purpose endpoint** — not a general settings-patch endpoint. The other `ShopifyStoreSettings` fields (`buttonText`, `buttonColor`, `position`, `customCss`) stay unused until a real settings-editing screen is its own future spec.
- **`totalTryOns` needs no extra filter beyond `widgetClientId`** — each Shopify store has its own dedicated `widgetClients` row (`upsertShopifyStore`), so every job under that `widgetClientId` is inherently a Shopify try-on job.
- **ESM only** (`.js` import specifiers in the backend), pnpm workspaces, pino via `@tryme/logger`, ASCII quotes, no `console.log` in committed code.
- **Backend tasks are full TDD** (RED/GREEN evidence required). **Frontend tasks have no automated test harness** — verification is `pnpm --filter @tryme/shopify-admin build` succeeding plus manual smoke-testing.

---

## File Structure

**Create:**
- `apps/api/test/shopify-me.test.ts` — tests for the new `stats` field
- `apps/api/src/modules/shopify/onboarding.routes.ts` — `confirm-theme-block` endpoint
- `apps/api/test/shopify-onboarding.test.ts` — tests for it
- `apps/shopify/src/components/AppShell.tsx` — persistent nav wrapper

**Modify:**
- `apps/api/src/modules/shopify/me.routes.ts` — adds `stats` to the response
- `apps/api/src/modules/shopify/routes.ts` — registers the new onboarding route
- `apps/shopify/src/App.tsx` — wraps routes in `AppShell`, adds `/embedded` route
- `apps/shopify/src/pages/DashboardPage.tsx` — rebuilt: checklist + stats
- `apps/shopify/src/types.ts` — `ShopifyMe` gains `stats`, new `ShopifyOnboardingConfirmResponse`

---

## Task 1: `stats` field on `GET /v1/shopify/me`

**Files:**
- Modify: `apps/api/src/modules/shopify/me.routes.ts`
- Create: `apps/api/test/shopify-me.test.ts`

**Interfaces:**
- Consumes: `schema.jobs` (existing, `widgetClientId` column), `schema.shopifyProductGarments` (existing, `enabled`/`storeId` columns), `count` from `drizzle-orm` (already the pattern used in `products.routes.ts`).
- Produces: `GET /v1/shopify/me` response gains `stats: { totalTryOns: number, syncedProductCount: number, enabledProductCount: number }` — Task 4's Dashboard consumes this exact shape.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/shopify-me.test.ts`:

```ts
import { schema } from '@tryme/db';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { upsertShopifyStore } from '../src/modules/shopify/auth.routes.js';
import { signSessionToken } from './helpers/shopify-session.js';
import { buildTestApp, type TestApp } from './helpers/api.js';
import { type Containers, startContainers } from './helpers/containers.js';

const ENC_KEY = Buffer.alloc(32, 11).toString('base64');
const API_SECRET = 'test-secret';
const API_KEY = 'test-key';
let c: Containers;
let app: TestApp;
let storeId: string;
let widgetClientId: string;
let token: string;

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
      shopifyShopId: 66,
      shopDomain: 'm.myshopify.com',
      myshopifyDomain: 'm.myshopify.com',
      name: 'M',
      email: 'm@m.com',
    },
    'tok',
    'read_products',
  );
  storeId = store.id;
  widgetClientId = store.widgetClientId;
  token = signSessionToken('m.myshopify.com', API_SECRET, API_KEY);

  await app.db.insert(schema.shopifyProductGarments).values([
    {
      storeId,
      shopifyProductId: 1,
      shopifyVariantId: null,
      r2Key: `shopify-garments/${storeId}/1/garment.jpg`,
      status: 'active',
      enabled: true,
    },
    {
      storeId,
      shopifyProductId: 2,
      shopifyVariantId: null,
      r2Key: `shopify-garments/${storeId}/2/garment.jpg`,
      status: 'processing',
      enabled: false,
    },
  ]);

  for (let i = 0; i < 3; i++) {
    // biome-ignore lint/suspicious/noExplicitAny: Drizzle infers userId as non-null; widget jobs legitimately have null userId
    await (app.db.insert(schema.jobs).values as any)({
      id: randomUUID(),
      userId: null,
      widgetClientId,
      status: 'COMPLETED',
      creditsCharged: 10,
    });
  }
});
afterAll(async () => {
  await app?.close();
  await c?.stop();
});

describe('GET /v1/shopify/me stats', () => {
  it('includes totalTryOns, syncedProductCount, enabledProductCount', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/shopify/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.stats).toEqual({
      totalTryOns: 3,
      syncedProductCount: 2,
      enabledProductCount: 1,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- shopify-me`
Expected: FAIL — `body.stats` is `undefined`.

- [ ] **Step 3: Implement the stats field**

In `apps/api/src/modules/shopify/me.routes.ts`, replace the full file with:

```ts
import { schema } from '@tryme/db';
import { and, count, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

export async function shopifyMeRoutes(app: FastifyInstance) {
  app.get('/v1/shopify/me', { preHandler: app.requireShopifySession }, async (req) => {
    const store = req.shopifyStore as typeof schema.shopifyStores.$inferSelect;

    const [credits] = await app.db
      .select({ balance: schema.widgetClientCredits.balance })
      .from(schema.widgetClientCredits)
      .where(eq(schema.widgetClientCredits.widgetClientId, store.widgetClientId))
      .limit(1);

    let plan: typeof schema.shopifyPlans.$inferSelect | null = null;
    if (store.shopifyPlanId) {
      const [row] = await app.db
        .select()
        .from(schema.shopifyPlans)
        .where(eq(schema.shopifyPlans.id, store.shopifyPlanId))
        .limit(1);
      plan = row ?? null;
    }

    const [{ totalTryOns }] = await app.db
      .select({ totalTryOns: count() })
      .from(schema.jobs)
      .where(eq(schema.jobs.widgetClientId, store.widgetClientId));

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

    return {
      store: { shopDomain: store.shopDomain, settings: store.settings },
      credits: credits?.balance ?? 0,
      plan,
      stats: { totalTryOns, syncedProductCount, enabledProductCount },
    };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @tryme/api test -- shopify-me`
Expected: PASS.

- [ ] **Step 5: Run the full API suite + typecheck**

Run: `pnpm --filter @tryme/api test && pnpm --filter @tryme/api typecheck`
Expected: PASS, no regressions (this is an additive field on an existing response object).

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/shopify/me.routes.ts apps/api/test/shopify-me.test.ts
git commit -m "feat(api): add stats (totalTryOns, product counts) to GET /v1/shopify/me"
```

---

## Task 2: `POST /v1/shopify/onboarding/confirm-theme-block`

**Files:**
- Create: `apps/api/src/modules/shopify/onboarding.routes.ts`
- Create: `apps/api/test/shopify-onboarding.test.ts`
- Modify: `apps/api/src/modules/shopify/routes.ts`

**Interfaces:**
- Consumes: `app.requireShopifySession` (existing), `schema.shopifyStores.settings` (existing jsonb column, typed via `ShopifyStoreSettings` in `packages/db/src/schema/shopify.ts`).
- Produces: `shopifyOnboardingRoutes(app: FastifyInstance): Promise<void>` — registered in `routes.ts`. `POST /v1/shopify/onboarding/confirm-theme-block` response: `{ settings: ShopifyStoreSettings }` (the updated settings object) — Task 4's frontend uses this to update local state without a second `/me` fetch.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/shopify-onboarding.test.ts`:

```ts
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { upsertShopifyStore } from '../src/modules/shopify/auth.routes.js';
import { signSessionToken } from './helpers/shopify-session.js';
import { buildTestApp, type TestApp } from './helpers/api.js';
import { type Containers, startContainers } from './helpers/containers.js';

const ENC_KEY = Buffer.alloc(32, 12).toString('base64');
const API_SECRET = 'test-secret';
const API_KEY = 'test-key';
let c: Containers;
let app: TestApp;
let storeId: string;
let token: string;

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
      shopDomain: 'o.myshopify.com',
      myshopifyDomain: 'o.myshopify.com',
      name: 'O',
      email: 'o@o.com',
    },
    'tok',
    'read_products',
  );
  storeId = store.id;
  token = signSessionToken('o.myshopify.com', API_SECRET, API_KEY);
});
afterAll(async () => {
  await app?.close();
  await c?.stop();
});

describe('POST /v1/shopify/onboarding/confirm-theme-block', () => {
  it('sets settings.themeBlockConfirmed to true', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/shopify/onboarding/confirm-theme-block',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().settings.themeBlockConfirmed).toBe(true);

    const [row] = await app.db
      .select()
      .from(schema.shopifyStores)
      .where(eq(schema.shopifyStores.id, storeId));
    expect(row.settings.themeBlockConfirmed).toBe(true);
  });

  it('is idempotent — calling it twice does not error', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/v1/shopify/onboarding/confirm-theme-block',
      headers: { authorization: `Bearer ${token}` },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/v1/shopify/onboarding/confirm-theme-block',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().settings.themeBlockConfirmed).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- shopify-onboarding`
Expected: FAIL — 404, route doesn't exist yet.

- [ ] **Step 3: Implement the endpoint**

Create `apps/api/src/modules/shopify/onboarding.routes.ts`:

```ts
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

export async function shopifyOnboardingRoutes(app: FastifyInstance) {
  app.post(
    '/v1/shopify/onboarding/confirm-theme-block',
    { preHandler: app.requireShopifySession },
    async (req) => {
      const store = req.shopifyStore as typeof schema.shopifyStores.$inferSelect;
      const settings = { ...store.settings, themeBlockConfirmed: true };

      await app.db
        .update(schema.shopifyStores)
        .set({ settings, updatedAt: new Date() })
        .where(eq(schema.shopifyStores.id, store.id));

      return { settings };
    },
  );
}
```

Note: `ShopifyStoreSettings` (in `packages/db/src/schema/shopify.ts`) needs a new optional field for this to typecheck — add it alongside the existing ones:

```ts
export interface ShopifyStoreSettings {
  buttonText?: string;
  buttonColor?: string;
  position?: string;
  customCss?: string;
  workflowTemplateId?: string;
  themeBlockConfirmed?: boolean;
}
```

- [ ] **Step 4: Register the route**

In `apps/api/src/modules/shopify/routes.ts`, add the import and registration:

```ts
import { shopifyOnboardingRoutes } from './onboarding.routes.js';
```

```ts
  await app.register(shopifyProductsRoutes);
  await app.register(shopifyOnboardingRoutes);
```

(Insert the new `await app.register(shopifyOnboardingRoutes);` line right after the existing `shopifyProductsRoutes` registration.)

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @tryme/api test -- shopify-onboarding`
Expected: PASS (2 tests).

- [ ] **Step 6: Run the full API suite + typecheck**

Run: `pnpm --filter @tryme/api test && pnpm --filter @tryme/api typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/schema/shopify.ts apps/api/src/modules/shopify/onboarding.routes.ts apps/api/src/modules/shopify/routes.ts apps/api/test/shopify-onboarding.test.ts
git commit -m "feat(api): POST /v1/shopify/onboarding/confirm-theme-block"
```

---

## Task 3: `AppShell` — persistent navigation

**Files:**
- Create: `apps/shopify/src/components/AppShell.tsx`
- Modify: `apps/shopify/src/App.tsx`

**Interfaces:**
- Consumes: `react-router-dom`'s `useLocation`, `Link` (existing dependency).
- Produces: `AppShell` component wrapping `{children}` — Task 4 renders inside it (no new interface Task 4 needs beyond "the Dashboard still renders as a normal route element").

**No TDD** — matches every prior frontend task. Verification is the build succeeding.

- [ ] **Step 1: Read the current `App.tsx`**

Confirm its exact current content (it should have `/`, `/billing`, `/products`, `/embedded` routes from the prior plan) before editing — if it's drifted, adjust the following steps to match reality rather than guessing.

- [ ] **Step 2: Create the nav shell**

Create `apps/shopify/src/components/AppShell.tsx`:

```tsx
import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';

const NAV_ITEMS = [
  { to: '/', label: 'Dashboard' },
  { to: '/billing', label: 'Billing' },
  { to: '/products', label: 'Products' },
];

export function AppShell({ children }: { children: ReactNode }) {
  const location = useLocation();

  return (
    <div>
      <nav
        style={{
          display: 'flex',
          gap: '16px',
          padding: '12px 20px',
          borderBottom: '1px solid #e1e3e5',
        }}
      >
        {NAV_ITEMS.map((item) => {
          const active = location.pathname === item.to;
          return (
            <Link
              key={item.to}
              to={item.to}
              style={{
                fontWeight: active ? 700 : 400,
                textDecoration: active ? 'underline' : 'none',
              }}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
      {children}
    </div>
  );
}
```

- [ ] **Step 3: Wire it into `App.tsx`**

Replace the current `apps/shopify/src/App.tsx` with:

```tsx
import '@shopify/polaris/build/esm/styles.css';
import { AppProvider } from '@shopify/polaris';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AppShell } from './components/AppShell';
import BillingPage from './pages/BillingPage';
import DashboardPage from './pages/DashboardPage';
import ProductsPage from './pages/ProductsPage';

export default function App() {
  return (
    <AppProvider i18n={{}}>
      <AppShell>
        <Routes>
          <Route path="/" element={<DashboardPage />} />
          <Route path="/billing" element={<BillingPage />} />
          <Route path="/products" element={<ProductsPage />} />
          <Route path="/embedded" element={<Navigate to="/" replace />} />
        </Routes>
      </AppShell>
    </AppProvider>
  );
}
```

(Only the `AppShell` import and wrapping changed — the `<Route>` list is unchanged from what Task 8's own follow-up fix already added.)

- [ ] **Step 4: Build**

Run: `pnpm --filter @tryme/shopify-admin build`
Expected: succeeds with no type errors.

- [ ] **Step 5: Commit**

```bash
git add apps/shopify/src/components/AppShell.tsx apps/shopify/src/App.tsx
git commit -m "feat(shopify-admin): persistent nav shell across Dashboard/Billing/Products"
```

---

## Task 4: Redesigned Dashboard — checklist + stats

**Files:**
- Modify: `apps/shopify/src/pages/DashboardPage.tsx`
- Modify: `apps/shopify/src/types.ts`

**Interfaces:**
- Consumes: `GET /v1/shopify/me` (Task 1, now returns `stats`), `POST /v1/shopify/onboarding/confirm-theme-block` (Task 2, returns `{ settings }`), `POST /v1/shopify/products/sync` (existing, returns `202 { queued: true }`), `apiFetch` (existing), `AppShell` (Task 3, already wraps this page via `App.tsx` — nothing this task does directly touches `AppShell`).
- Produces: nothing consumed by later tasks — last task of this plan.

**No TDD** — matches every prior frontend task. Verification is the build succeeding plus manual smoke-testing.

- [ ] **Step 1: Update `types.ts`**

In `apps/shopify/src/types.ts`, update `ShopifyStoreSettings` and `ShopifyMe`, and add a response type for the confirm endpoint:

```ts
export interface ShopifyStoreSettings {
  buttonText?: string;
  buttonColor?: string;
  position?: string;
  customCss?: string;
  workflowTemplateId?: string;
  themeBlockConfirmed?: boolean;
}

export interface ShopifyStats {
  totalTryOns: number;
  syncedProductCount: number;
  enabledProductCount: number;
}

export interface ShopifyMe {
  store: {
    shopDomain: string;
    settings: ShopifyStoreSettings;
  };
  credits: number;
  plan: ShopifyPlan | null;
  stats: ShopifyStats;
}

export interface ShopifyOnboardingConfirmResponse {
  settings: ShopifyStoreSettings;
}
```

(Only `ShopifyStoreSettings`'s new field, `ShopifyMe`'s new `stats` field, and the new `ShopifyStats`/`ShopifyOnboardingConfirmResponse` interfaces are additions — `ShopifyPlan`, `ShopifyProductListItem`, `ShopifyProductImage` stay as they are.)

- [ ] **Step 2: Rebuild the Dashboard**

Replace `apps/shopify/src/pages/DashboardPage.tsx` with:

```tsx
import {
  Badge,
  Banner,
  BlockStack,
  Button,
  Card,
  InlineStack,
  Layout,
  Page,
  SkeletonBodyText,
  Text,
} from '@shopify/polaris';
import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiFetch } from '../lib/api';
import type { ShopifyMe, ShopifyOnboardingConfirmResponse } from '../types';

export default function DashboardPage() {
  const [me, setMe] = useState<ShopifyMe | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [syncing, setSyncing] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const navigate = useNavigate();

  const load = useCallback(() => {
    setLoading(true);
    apiFetch<ShopifyMe>('/v1/shopify/me')
      .then(setMe)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function syncProducts() {
    setSyncing(true);
    setError(null);
    try {
      await apiFetch('/v1/shopify/products/sync', { method: 'POST' });
      load();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSyncing(false);
    }
  }

  async function confirmThemeBlock() {
    setConfirming(true);
    setError(null);
    try {
      const { settings } = await apiFetch<ShopifyOnboardingConfirmResponse>(
        '/v1/shopify/onboarding/confirm-theme-block',
        { method: 'POST' },
      );
      setMe((prev) => (prev ? { ...prev, store: { ...prev.store, settings } } : prev));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setConfirming(false);
    }
  }

  if (loading) {
    return (
      <Page title="TryMe Try-On">
        <Layout>
          <Layout.Section>
            <Card>
              <SkeletonBodyText lines={6} />
            </Card>
          </Layout.Section>
        </Layout>
      </Page>
    );
  }

  const synced = (me?.stats.syncedProductCount ?? 0) > 0;
  const enabled = (me?.stats.enabledProductCount ?? 0) > 0;
  const themeBlockDone = me?.store.settings.themeBlockConfirmed ?? false;
  const doneCount = [synced, enabled, themeBlockDone].filter(Boolean).length;

  return (
    <Page title="TryMe Try-On">
      <Layout>
        <Layout.Section>
          {error && (
            <Banner tone="critical" title="Something went wrong">
              {error}
            </Banner>
          )}

          <Card>
            <BlockStack gap="300">
              <InlineStack align="space-between">
                <Text as="h2" variant="headingMd">
                  Getting Started
                </Text>
                <Badge tone={doneCount === 3 ? 'success' : 'info'}>{`${doneCount}/3`}</Badge>
              </InlineStack>

              <InlineStack align="space-between">
                <Text as="p">{synced ? '✅' : '⭕'} Sync your products</Text>
                <Button onClick={syncProducts} loading={syncing} disabled={synced}>
                  Sync products now
                </Button>
              </InlineStack>

              <InlineStack align="space-between">
                <Text as="p">{enabled ? '✅' : '⭕'} Enable try-on on a product</Text>
                <Button onClick={() => navigate('/products')}>Go to Products</Button>
              </InlineStack>

              <InlineStack align="space-between">
                <Text as="p">
                  {themeBlockDone ? '✅' : '⭕'} Add the Try It On block to your theme
                </Text>
                {!themeBlockDone && (
                  <Button onClick={confirmThemeBlock} loading={confirming}>
                    I've added it
                  </Button>
                )}
              </InlineStack>
            </BlockStack>
          </Card>

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
              <Text as="h2" variant="headingMd">
                {me?.store.shopDomain}
              </Text>
              <Text as="p">Credit balance: {me?.credits ?? 0}</Text>
              <InlineStack gap="200">
                <Button onClick={() => navigate('/products')}>Manage Products</Button>
                <Button onClick={() => navigate('/billing')}>Manage Billing</Button>
              </InlineStack>
            </BlockStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
```

> **Note on the checkmark/circle characters:** `✅`/`⭕` are plain Unicode escapes for "check mark" and "heavy large circle" — used directly rather than a Polaris icon component to avoid pulling in `@shopify/polaris-icons` for two glyphs; swap to a real `Icon` component later if the plan's own visual bar needs to match Polaris more closely. Not worth a review round-trip either way.

- [ ] **Step 3: Build**

Run: `pnpm --filter @tryme/shopify-admin build`
Expected: succeeds with no type errors.

- [ ] **Step 4: Commit**

```bash
git add apps/shopify/src/pages/DashboardPage.tsx apps/shopify/src/types.ts
git commit -m "feat(shopify-admin): redesign dashboard (getting-started checklist + stats)"
```

- [ ] **Step 5: Manual verification against the real dev store**

No automated test applies to this task. Verification:
1. Reload the embedded app in the already-installed dev store (`ai-vastra-store` or `tryme`, whichever this session's ngrok tunnel is currently pointed at — repoint if needed per this session's earlier setup).
2. Confirm the nav bar (Dashboard/Billing/Products) appears on all three screens and correctly highlights the active one.
3. Confirm the Getting Started checklist shows the right state given the store's actual data (products synced/enabled so far this session), and that "Sync products now" and "I've added it" both work and update the checklist without a full page reload.
4. Confirm the three stat tiles show real numbers (not zero, if jobs/products already exist from this session's earlier testing).
5. Confirm navigating Products → Billing → Dashboard and back works via the nav bar alone, with no dead ends.
