# Shopify Embedded Admin Brand Restyle — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Apply the TryMe brand gradient (pink `#f55c7a` → amber `#f6b553`) to `apps/shopify`'s existing screens via Polaris's CSS custom-property theming layer, plus two small backend additions (per-status product counts, a "connected since" date) the restyled Dashboard needs. Zero functional regressions.

**Architecture:** A single new `apps/shopify/src/theme.css` overrides Polaris's own `--p-*` CSS custom properties (verified against the actually-installed `@shopify/polaris@13.9.5` package — not guessed) so every existing Polaris component (`Card`, `Button`, `Page`, `IndexTable`, etc.) picks up the brand color automatically, with zero component-tree changes. `AppShell.tsx` (the one component not using Polaris) gets restyled directly, reading the same CSS variables. Two additive fields on `GET /v1/shopify/me` (`stats.statusCounts`, `store.connectedSince`) feed a new Dashboard card. `ProductsPage.tsx` gains client-side search/status-filter UI. `FunnelSetupPage.tsx` and `LinkAccountGate.tsx` get minor primary-button/visual touch-ups.

**Tech Stack:** Fastify 5, Drizzle ORM, Vitest, React 18, `@shopify/polaris@13.9.5`, React Router 7.

## Global Constraints

- This is a UI-upgrade / visual-restyle project. The mock's literal HTML/markup (`TryMe Shopify Admin Dashboard/TryMe Admin.dc.html`) is a loose reference only — do NOT replicate its raw div/inline-style structure. Keep all existing Polaris components — restyle via CSS custom-property overrides, not component replacement.
- Zero functional regressions: the onboarding checklist, funnel-assignment dropdown, image picker, product-attribute funnel-rule engine, and the popup-based account-link flow must all work exactly as they do today.
- Reuse the exact existing brand hex values `#f55c7a` (pink) and `#f6b553` (amber) — confirmed in `apps/catalogues-web/src/app/globals.css` (`--c-pink`, `--c-amber`) and `apps/catalogues-web/src/components/tokens.ts`'s `grad` export (`'linear-gradient(135deg, var(--c-pink), var(--c-amber))'`). Do not invent new colors or approximate the mock's `oklch()` values.
- Out of scope: shopper-segment/checkout-variant funnel routing, a distinct account-linked-at timestamp separate from `installedAt`, Shopify-native billing, any `apps/admin-mobile` changes, pixel-matching the mock's literal markup.
- `pnpm docker:up` must already be running before any test step (verified healthy: postgres/redis/minio).
- `apps/api/test/shopify-me.test.ts` is a **flat** test file (not under `test/integration/`), so it already runs in the default `pnpm test` / `npx vitest run` — no vitest.config.ts exclude-lifting needed for Task 1.
- After API changes: `pnpm --filter @tryme/api typecheck` must be clean.
- After `apps/shopify` changes: `cd apps/shopify && npx tsc -b` must be clean (this package's `typecheck` script is `tsc -b`, no `--noEmit` flag — confirmed from `apps/shopify/package.json`).
- Biome pre-commit hook (lefthook) runs automatically, but call `pnpm biome check --write <files>` explicitly at the end of each task anyway, per this repo's established pattern.
- Stage ONLY the exact files each task names — never `git add -A` (the working tree commonly has unrelated in-progress files from other work).
- Commit once per task: `git commit -m "$(cat <<'EOF' ... Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com> EOF )"`.

---

## Task 1: Backend — `statusCounts` + `connectedSince` on `GET /v1/shopify/me`

**Files:**
- Modify: `apps/api/src/modules/shopify/me.routes.ts`
- Modify: `apps/api/test/shopify-me.test.ts`
- Modify: `apps/shopify/src/types.ts`

**Interfaces:**
- Consumes: `schema.shopifyProductGarments` (`status: text`, `enabled: boolean` columns — confirmed values in practice are only `'active' | 'processing' | 'failed'`; `'deleted'` is documented in a schema comment but is **never actually written anywhere in the codebase** — confirmed via repo-wide grep, so no exclusion logic is needed for it), `schema.shopifyStores.installedAt` (`timestamp`, `notNull`, `defaultNow()`).
- Produces: `ShopifyStats.statusCounts: { active: number; processing: number; failed: number; disabled: number }` and `ShopifyMe.store.connectedSince: string` (ISO timestamp) — consumed by Task 3 (Dashboard).

**Reconciliation rule** (confirmed): a row buckets into `disabled` if `enabled = false`, **regardless of its `status` value**. Otherwise it buckets by its real `status` (`active` / `processing` / `failed`).

### Step 1: Write the failing test assertions

In `apps/api/test/shopify-me.test.ts`, the `beforeAll` already seeds exactly two `shopifyProductGarments` rows for `storeId` (lines 40–57):
```ts
{ storeId, shopifyProductId: 1, ..., status: 'active', enabled: true },
{ storeId, shopifyProductId: 2, ..., status: 'processing', enabled: false },
```
Row 2 already exercises the exact "enabled overrides status" edge case (processing + disabled) — no new seed data needed. Applying the reconciliation rule to this fixture: `active: 1, processing: 0, failed: 0, disabled: 1`.

Find the existing test (lines 76–90):
```ts
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
      funnelConfigured: false,
    });
  });
});
```

Change to:
```ts
describe('GET /v1/shopify/me stats', () => {
  it('includes totalTryOns, syncedProductCount, enabledProductCount, statusCounts', async () => {
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
      funnelConfigured: false,
      statusCounts: { active: 1, processing: 0, failed: 0, disabled: 1 },
    });
  });
});
```

Then add a new `describe` block after the existing `'GET /v1/shopify/me ownerUserId + creditBalance'` block (after line 165, before the final closing of the file):
```ts
describe('GET /v1/shopify/me store.connectedSince', () => {
  it("reflects the store's installedAt timestamp", async () => {
    const [store] = await app.db
      .select({ installedAt: schema.shopifyStores.installedAt })
      .from(schema.shopifyStores)
      .where(eq(schema.shopifyStores.id, storeId));

    const res = await app.inject({
      method: 'GET',
      url: '/v1/shopify/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.json().store.connectedSince).toBe(store.installedAt.toISOString());
  });
});
```

- [ ] **Make both test edits above.**

### Step 2: Run the test to verify it fails

```bash
cd /mnt/vol1/PycharmProjects/tryme_v1/apps/api
npx vitest run test/shopify-me.test.ts
```
Expected: FAIL — `body.stats` is missing `statusCounts`, and `body.store.connectedSince` is `undefined`.

- [ ] **Run and confirm FAIL.**

### Step 3: Implement `statusCounts` + `connectedSince`

In `apps/api/src/modules/shopify/me.routes.ts`, find (lines 29–37, right after the `enabledProductCount` query):
```ts
    const [{ enabledProductCount }] = await app.db
      .select({ enabledProductCount: count() })
      .from(schema.shopifyProductGarments)
      .where(
        and(
          eq(schema.shopifyProductGarments.storeId, store.id),
          eq(schema.shopifyProductGarments.enabled, true),
        ),
      );
```

Add immediately after it:
```ts
    const [{ activeCount, processingCount, failedCount, disabledCount }] = await app.db
      .select({
        activeCount: sql<number>`COUNT(*) FILTER (WHERE ${schema.shopifyProductGarments.enabled} = true AND ${schema.shopifyProductGarments.status} = 'active')::int`,
        processingCount: sql<number>`COUNT(*) FILTER (WHERE ${schema.shopifyProductGarments.enabled} = true AND ${schema.shopifyProductGarments.status} = 'processing')::int`,
        failedCount: sql<number>`COUNT(*) FILTER (WHERE ${schema.shopifyProductGarments.enabled} = true AND ${schema.shopifyProductGarments.status} = 'failed')::int`,
        disabledCount: sql<number>`COUNT(*) FILTER (WHERE ${schema.shopifyProductGarments.enabled} = false)::int`,
      })
      .from(schema.shopifyProductGarments)
      .where(eq(schema.shopifyProductGarments.storeId, store.id));
```

Then find the final return statement (lines 57–65):
```ts
    return {
      store: {
        shopDomain: store.shopDomain,
        settings: store.settings,
        ownerUserId: store.ownerUserId,
      },
      creditBalance,
      stats: { totalTryOns, syncedProductCount, enabledProductCount, funnelConfigured },
    };
```

Change to:
```ts
    return {
      store: {
        shopDomain: store.shopDomain,
        settings: store.settings,
        ownerUserId: store.ownerUserId,
        connectedSince: store.installedAt.toISOString(),
      },
      creditBalance,
      stats: {
        totalTryOns,
        syncedProductCount,
        enabledProductCount,
        funnelConfigured,
        statusCounts: {
          active: activeCount,
          processing: processingCount,
          failed: failedCount,
          disabled: disabledCount,
        },
      },
    };
```

- [ ] **Make this edit.**

### Step 4: Run the test to verify it passes

```bash
cd /mnt/vol1/PycharmProjects/tryme_v1/apps/api
npx vitest run test/shopify-me.test.ts
```
Expected: PASS — all 5 test blocks in this file green.

- [ ] **Run and confirm PASS.**

### Step 5: Update the frontend types

In `apps/shopify/src/types.ts`, find:
```ts
export interface ShopifyStats {
  totalTryOns: number;
  syncedProductCount: number;
  enabledProductCount: number;
  funnelConfigured: boolean;
}

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

Change to:
```ts
export interface ShopifyStats {
  totalTryOns: number;
  syncedProductCount: number;
  enabledProductCount: number;
  funnelConfigured: boolean;
  statusCounts: { active: number; processing: number; failed: number; disabled: number };
}

export interface ShopifyMe {
  store: {
    shopDomain: string;
    settings: ShopifyStoreSettings;
    ownerUserId: string | null;
    connectedSince: string;
  };
  creditBalance: number | null;
  stats: ShopifyStats;
}
```

- [ ] **Make this edit.**

### Step 6: Typecheck + Biome + commit

```bash
cd /mnt/vol1/PycharmProjects/tryme_v1
pnpm --filter @tryme/api typecheck
cd apps/shopify && npx tsc -b
cd /mnt/vol1/PycharmProjects/tryme_v1
pnpm biome check --write apps/api/src/modules/shopify/me.routes.ts apps/api/test/shopify-me.test.ts apps/shopify/src/types.ts
git add apps/api/src/modules/shopify/me.routes.ts apps/api/test/shopify-me.test.ts apps/shopify/src/types.ts
git commit -m "$(cat <<'EOF'
feat(shopify): add statusCounts + connectedSince to GET /v1/shopify/me

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Run the commands above.**

---

## Task 2: Brand theme CSS — Polaris token overrides + nav restyle

**Files:**
- Create: `apps/shopify/src/theme.css`
- Modify: `apps/shopify/src/App.tsx`
- Modify: `apps/shopify/src/components/AppShell.tsx`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces: every Polaris component in the app (via CSS custom properties) and `AppShell.tsx`'s nav (via direct references to the same `--p-*` variables) render in brand pink/amber. Tasks 3–5 rely on this being in place — specifically, they rely on `variant="primary"` `Button`s rendering with a solid brand-pink fill instead of Polaris's default near-black.

**Verified facts this step depends on (already checked against the installed package, do not re-derive from general Polaris knowledge):**
- `@shopify/polaris@13.9.5` defines all its design tokens as CSS custom properties on `:root, .p-theme-light` in `node_modules/@shopify/polaris/build/esm/styles.css` (the file already imported by `App.tsx`). A later `:root { ... }` rule in a stylesheet imported after Polaris's own wins by source order (same specificity).
- Real confirmed default values: `--p-color-bg-fill-brand: rgba(48, 48, 48, 1)` (near-black — this is what makes `Button variant="primary"` currently render dark gray), `--p-color-text-brand-on-bg-fill: rgba(255, 255, 255, 1)` (white — already correct contrast on our pink, do not touch), `--p-color-border-brand: rgba(227, 227, 227, 1)`, `--p-color-text-brand: rgba(74, 74, 74, 1)`.
- Polaris's `Button` component (`build/ts/src/components/Button/Button.d.ts`) does **not** accept a `className` or `style` prop — its full prop list is `id, children, url, disabled, external, download, target, submit, loading, pressed, accessibilityLabel, role, ariaControls, ariaExpanded, ariaDescribedBy, ariaChecked, onClick, onFocus, onBlur, onKeyDown, onKeyPress, onKeyUp, onMouseEnter, onTouchStart, onPointerDown, icon, disclosure, removeUnderline, size, textAlign, fullWidth, dataPrimaryLink, tone, variant`. It also renders via CSS Modules with build-hashed class names (confirmed in `build/esm/components/Button/Button.js`), so there is no stable selector to target it externally either. **This means a literal gradient-fill button is not feasibly/stably achievable** — the correct approach is a solid brand-pink fill via the `--p-color-bg-fill-brand*` tokens (which `Button variant="primary"` already reads), with `-hover`/`-active` states using the amber tone for a color-shift-on-interaction effect that nods at the mock's gradient without fighting Polaris internals.

### Step 1: Create the theme override file

```css
/* apps/shopify/src/theme.css
 * Brand palette (reuses the exact hex values from apps/catalogues-web's tokens —
 * do not introduce new colors here). Overrides Polaris's own `--p-*` custom
 * properties; must be imported AFTER `@shopify/polaris/build/esm/styles.css`
 * so this file wins on source order (same CSS specificity: :root vs :root).
 */
:root {
  --p-color-bg-fill-brand: #f55c7a;
  --p-color-bg-fill-brand-hover: #f6b553;
  --p-color-bg-fill-brand-active: #f6b553;
  --p-color-bg-fill-brand-selected: #f55c7a;
  --p-color-border-brand: #f55c7a;
  --p-color-text-brand: #f55c7a;
  --p-color-text-brand-hover: #f6b553;
}
```

- [ ] **Create the file above.**

### Step 2: Import it after Polaris's stylesheet

In `apps/shopify/src/App.tsx`, find the first line:
```ts
import '@shopify/polaris/build/esm/styles.css';
```

Change to:
```ts
import '@shopify/polaris/build/esm/styles.css';
import './theme.css';
```

- [ ] **Make this edit.**

### Step 3: Restyle the nav shell

`AppShell.tsx` is the one component in this app not using Polaris — it must reference the same `--p-*` variables directly (rather than duplicating a hardcoded hex) so there's a single source of truth for the brand color.

In `apps/shopify/src/components/AppShell.tsx`, replace the full file:
```tsx
import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';

const NAV_ITEMS = [
  { to: '/', label: 'Dashboard' },
  { to: '/products', label: 'Products' },
  { to: '/funnel-setup', label: 'Funnel Setup' },
];

export function AppShell({ children }: { children: ReactNode }) {
  const location = useLocation();

  return (
    <div>
      <nav
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '4px',
          padding: '0 20px',
          height: '52px',
          borderBottom: '1px solid var(--p-color-border)',
          background: 'var(--p-color-bg-surface)',
        }}
      >
        <div
          style={{
            width: '22px',
            height: '22px',
            borderRadius: '6px',
            marginRight: '16px',
            background:
              'linear-gradient(135deg, var(--p-color-bg-fill-brand), var(--p-color-bg-fill-brand-hover))',
          }}
        />
        {NAV_ITEMS.map((item) => {
          const active = location.pathname === item.to;
          return (
            <Link
              key={item.to}
              to={item.to}
              style={{
                display: 'flex',
                alignItems: 'center',
                height: '100%',
                padding: '0 14px',
                fontSize: '13.5px',
                fontWeight: active ? 600 : 500,
                color: active ? 'var(--p-color-text)' : 'var(--p-color-text-secondary)',
                textDecoration: 'none',
                borderBottom: active ? '2px solid var(--p-color-border-brand)' : '2px solid transparent',
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

- [ ] **Make this edit.**

### Step 4: Typecheck + Biome + commit

```bash
cd /mnt/vol1/PycharmProjects/tryme_v1/apps/shopify
npx tsc -b
cd /mnt/vol1/PycharmProjects/tryme_v1
pnpm biome check --write apps/shopify/src/theme.css apps/shopify/src/App.tsx apps/shopify/src/components/AppShell.tsx
git add apps/shopify/src/theme.css apps/shopify/src/App.tsx apps/shopify/src/components/AppShell.tsx
git commit -m "$(cat <<'EOF'
style(shopify): brand pink/amber Polaris theme override + nav restyle

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Run the commands above.**

### Step 5: Manual visual check

No automated visual test exists for this. Verify by hand:
```bash
pnpm --filter @tryme/shopify-admin dev
```
- [ ] Every `Button variant="primary"` (currently only `LinkAccountGate`'s "Link account" button) now renders pink, turning amber on hover.
- [ ] The top nav shows a small gradient logo mark and a pink underline on the active tab.
- [ ] No other component (default-variant buttons, `Badge` tones, `Banner` tones) visibly changed — only brand-token-driven elements should differ from before.

---

## Task 3: Dashboard — status-counts card, connected-since, primary CTAs

**Files:**
- Modify: `apps/shopify/src/pages/DashboardPage.tsx`

**Interfaces:**
- Consumes: `ShopifyMe.stats.statusCounts`, `ShopifyMe.store.connectedSince` (Task 1); brand-pink `Button variant="primary"` styling (Task 2).
- Produces: nothing consumed by later tasks.

### Step 1: Add `variant="primary"` to the two primary CTAs

In `apps/shopify/src/pages/DashboardPage.tsx`, find:
```tsx
                <Button onClick={syncProducts} loading={syncing} disabled={synced}>
                  Sync products now
                </Button>
```
Change to:
```tsx
                <Button onClick={syncProducts} loading={syncing} disabled={synced} variant="primary">
                  Sync products now
                </Button>
```

Find:
```tsx
              <Button
                onClick={() =>
                  window.open('https://app.tryme.com/pricing', '_blank', 'noopener')
                }
              >
                Top up on tryme.com
              </Button>
```
Change to:
```tsx
              <Button
                variant="primary"
                onClick={() =>
                  window.open('https://app.tryme.com/pricing', '_blank', 'noopener')
                }
              >
                Top up on tryme.com
              </Button>
```

- [ ] **Make both edits.**

### Step 2: Add the "Product sync status" card

Find the existing 3-stat `InlineStack` block:
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
```

Add immediately after its closing `</InlineStack>` (before the Credit Balance `Card`):
```tsx

          <Card>
            <BlockStack gap="200">
              <Text as="h3" variant="headingSm">
                Product sync status
              </Text>
              <InlineStack align="space-between">
                <Text as="p">Active</Text>
                <Text as="p" fontWeight="semibold">
                  {me?.stats.statusCounts.active ?? 0}
                </Text>
              </InlineStack>
              <InlineStack align="space-between">
                <Text as="p">Processing</Text>
                <Text as="p" fontWeight="semibold">
                  {me?.stats.statusCounts.processing ?? 0}
                </Text>
              </InlineStack>
              <InlineStack align="space-between">
                <Text as="p">Failed</Text>
                <Text as="p" fontWeight="semibold">
                  {me?.stats.statusCounts.failed ?? 0}
                </Text>
              </InlineStack>
              <InlineStack align="space-between">
                <Text as="p">Disabled</Text>
                <Text as="p" fontWeight="semibold">
                  {me?.stats.statusCounts.disabled ?? 0}
                </Text>
              </InlineStack>
            </BlockStack>
          </Card>
```

- [ ] **Make this edit.**

### Step 3: Add `connectedSince` to the Store card

Find:
```tsx
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
Change to:
```tsx
          <Card>
            <BlockStack gap="200">
              <Text as="h2" variant="headingMd">
                {me?.store.shopDomain}
              </Text>
              {me?.store.connectedSince && (
                <Text as="p" tone="subdued">
                  Connected since {new Date(me.store.connectedSince).toLocaleDateString()}
                </Text>
              )}
              <InlineStack gap="200">
                <Button onClick={() => navigate('/products')}>Manage Products</Button>
              </InlineStack>
            </BlockStack>
          </Card>
```

- [ ] **Make this edit.**

### Step 4: Typecheck + Biome + commit

```bash
cd /mnt/vol1/PycharmProjects/tryme_v1/apps/shopify
npx tsc -b
cd /mnt/vol1/PycharmProjects/tryme_v1
pnpm biome check --write apps/shopify/src/pages/DashboardPage.tsx
git add apps/shopify/src/pages/DashboardPage.tsx
git commit -m "$(cat <<'EOF'
feat(shopify): Dashboard — product sync status card, connected-since, brand CTAs

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Run the commands above.**

### Step 5: Manual visual check

```bash
pnpm --filter @tryme/shopify-admin dev
```
- [ ] Dashboard shows a new "Product sync status" card with 4 rows (Active/Processing/Failed/Disabled) matching real seeded data.
- [ ] Store card shows "Connected since <date>".
- [ ] "Sync products now" and "Top up on tryme.com" buttons render pink (brand primary).
- [ ] Onboarding checklist, 3 original stat cards, and "Manage Products" button are unchanged in behavior.

---

## Task 4: Products — search + status filter, reconciled status badge

**Files:**
- Modify: `apps/shopify/src/pages/ProductsPage.tsx`

**Interfaces:**
- Consumes: `ShopifyProductListItem.status`/`enabled` (unchanged from Task 1 — no new fields needed here, the reconciliation is purely a frontend display concern).
- Produces: nothing consumed by later tasks.

### Step 1: Replace the file with search/filter + reconciled status added

Full new content for `apps/shopify/src/pages/ProductsPage.tsx`:
```tsx
import {
  Badge,
  Banner,
  IndexTable,
  Page,
  Select,
  TextField,
  Thumbnail,
  useIndexResourceState,
} from '@shopify/polaris';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ImagePickerModal } from '../components/ImagePickerModal';
import { apiFetch } from '../lib/api';
import type { FunnelTemplateItem, ShopifyProductListItem } from '../types';

type DisplayStatus = 'active' | 'processing' | 'failed' | 'disabled';

// Reconciles two independent real-data axes (sync `status` and the `enabled`
// toggle) into the single status bucket shown in the UI: a disabled product
// always reads as "Disabled", regardless of its underlying sync status.
function displayStatus(item: ShopifyProductListItem): DisplayStatus {
  if (!item.enabled) return 'disabled';
  return item.status as DisplayStatus;
}

const STATUS_TONE: Record<DisplayStatus, 'success' | 'attention' | 'critical' | 'read-only'> = {
  active: 'success',
  processing: 'attention',
  failed: 'critical',
  disabled: 'read-only',
};

const STATUS_LABEL: Record<DisplayStatus, string> = {
  active: 'Active',
  processing: 'Processing',
  failed: 'Failed',
  disabled: 'Disabled',
};

const STATUS_FILTER_OPTIONS = [
  { label: 'All statuses', value: 'all' },
  { label: 'Active', value: 'active' },
  { label: 'Processing', value: 'processing' },
  { label: 'Failed', value: 'failed' },
  { label: 'Disabled', value: 'disabled' },
];

export default function ProductsPage() {
  const [items, setItems] = useState<ShopifyProductListItem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [pickerProductId, setPickerProductId] = useState<number | null>(null);
  const [funnelTemplates, setFunnelTemplates] = useState<FunnelTemplateItem[]>([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState('all');

  const filteredItems = useMemo(() => {
    return items
      .filter((item) => statusFilter === 'all' || displayStatus(item) === statusFilter)
      .filter((item) => (item.title ?? '').toLowerCase().includes(searchQuery.toLowerCase()));
  }, [items, statusFilter, searchQuery]);

  const { selectedResources } = useIndexResourceState(
    filteredItems.map((i) => ({ id: String(i.shopifyProductId) })),
  );

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([
      apiFetch<{ items: ShopifyProductListItem[] }>('/v1/shopify/products?pageSize=100'),
      apiFetch<{ items: FunnelTemplateItem[] }>('/v1/shopify/funnel-templates'),
    ])
      .then(([products, funnels]) => {
        setItems(products.items);
        setFunnelTemplates(funnels.items);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  async function toggleEnabled(shopifyProductId: number, enabled: boolean) {
    setError(null);
    try {
      const updated = await apiFetch<ShopifyProductListItem>(
        `/v1/shopify/products/${shopifyProductId}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ enabled }),
        },
      );
      setItems((prev) => prev.map((p) => (p.shopifyProductId === shopifyProductId ? updated : p)));
    } catch (err) {
      setError((err as Error).message);
    }
  }

  async function selectImage(shopifyProductId: number, src: string) {
    setError(null);
    try {
      const updated = await apiFetch<ShopifyProductListItem>(
        `/v1/shopify/products/${shopifyProductId}`,
        {
          method: 'PATCH',
          body: JSON.stringify({ garmentImageUrl: src }),
        },
      );
      setItems((prev) => prev.map((p) => (p.shopifyProductId === shopifyProductId ? updated : p)));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPickerProductId(null);
    }
  }

  async function setFunnel(shopifyProductId: number, funnelTemplateId: string | null) {
    setError(null);
    try {
      await apiFetch(`/v1/shopify/products/${shopifyProductId}/funnel`, {
        method: 'PATCH',
        body: JSON.stringify({ funnelTemplateId }),
      });
      load();
    } catch (err) {
      setError((err as Error).message);
    }
  }

  return (
    <Page title="Products">
      {error && (
        <Banner tone="critical" title="Something went wrong">
          {error}
        </Banner>
      )}
      <div style={{ display: 'flex', gap: '12px', marginBottom: '12px' }}>
        <div style={{ flex: 1 }}>
          <TextField
            label="Search products"
            labelHidden
            autoComplete="off"
            placeholder="Search products"
            value={searchQuery}
            onChange={setSearchQuery}
          />
        </div>
        <div style={{ width: '200px' }}>
          <Select
            label="Status"
            labelHidden
            options={STATUS_FILTER_OPTIONS}
            value={statusFilter}
            onChange={setStatusFilter}
          />
        </div>
      </div>
      <IndexTable
        resourceName={{ singular: 'product', plural: 'products' }}
        itemCount={filteredItems.length}
        selectedItemsCount={selectedResources.length}
        headings={[
          { title: 'Image' },
          { title: 'Title' },
          { title: 'Status' },
          { title: 'Try-on enabled' },
          { title: 'Funnel' },
        ]}
        loading={loading}
      >
        {filteredItems.map((item, index) => (
          <IndexTable.Row
            id={String(item.shopifyProductId)}
            key={item.shopifyProductId}
            position={index}
          >
            <IndexTable.Cell>
              <Thumbnail source={item.thumbnailUrl} alt={item.title ?? ''} size="small" />
              <button
                type="button"
                onClick={() => setPickerProductId(item.shopifyProductId)}
                style={{ display: 'block', marginTop: '4px' }}
              >
                Change image
              </button>
            </IndexTable.Cell>
            <IndexTable.Cell>{item.title}</IndexTable.Cell>
            <IndexTable.Cell>
              <Badge tone={STATUS_TONE[displayStatus(item)]}>
                {STATUS_LABEL[displayStatus(item)]}
              </Badge>
            </IndexTable.Cell>
            <IndexTable.Cell>
              <input
                type="checkbox"
                checked={item.enabled}
                disabled={item.status !== 'active' && !item.enabled}
                title={item.status !== 'active' ? 'Waiting for product sync' : undefined}
                onChange={(e) => toggleEnabled(item.shopifyProductId, e.target.checked)}
              />
            </IndexTable.Cell>
            <IndexTable.Cell>
              <select
                value={item.funnelTemplateId ?? ''}
                onChange={(e) => setFunnel(item.shopifyProductId, e.target.value || null)}
              >
                <option value="">Automated (no manual pin)</option>
                {funnelTemplates.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label}
                  </option>
                ))}
              </select>
            </IndexTable.Cell>
          </IndexTable.Row>
        ))}
      </IndexTable>
      {pickerProductId !== null && (
        <ImagePickerModal
          shopifyProductId={pickerProductId}
          onClose={() => setPickerProductId(null)}
          onSelect={(src) => selectImage(pickerProductId, src)}
        />
      )}
    </Page>
  );
}
```

Notes on what changed vs. the original (for the reviewer, not a step to execute): added `searchQuery`/`statusFilter` state + a `useMemo`-derived `filteredItems`; added a `displayStatus()` helper implementing the enabled-overrides-status reconciliation rule; `STATUS_TONE` now covers all 4 buckets (previously only 3, with `'disabled'` never actually reachable since `item.status` itself never held that value); `IndexTable`/`useIndexResourceState`/`.map()` now iterate `filteredItems` instead of `items` so `itemCount` stays consistent with rendered rows; all existing PATCH/funnel logic (`toggleEnabled`, `selectImage`, `setFunnel`) is untouched.

- [ ] **Replace the file with the content above.**

### Step 2: Typecheck + Biome + commit

```bash
cd /mnt/vol1/PycharmProjects/tryme_v1/apps/shopify
npx tsc -b
cd /mnt/vol1/PycharmProjects/tryme_v1
pnpm biome check --write apps/shopify/src/pages/ProductsPage.tsx
git add apps/shopify/src/pages/ProductsPage.tsx
git commit -m "$(cat <<'EOF'
feat(shopify): Products page — search + status filter, reconciled status badge

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Run the commands above.**

### Step 3: Manual visual check

```bash
pnpm --filter @tryme/shopify-admin dev
```
- [ ] Search box filters the table by product title as you type.
- [ ] Status filter narrows to each of All/Active/Processing/Failed/Disabled correctly — a product with `enabled: false` always shows under "Disabled" regardless of its real sync status.
- [ ] Image picker, funnel-assignment dropdown, and the enable/disable checkbox still work exactly as before.

---

## Task 5: Funnel Setup — primary CTA restyle

**Files:**
- Modify: `apps/shopify/src/pages/FunnelSetupPage.tsx`

**Interfaces:**
- Consumes: brand-pink `Button variant="primary"` styling (Task 2).
- Produces: nothing consumed by later tasks. (`LinkAccountGate.tsx` needs **no code change** — its "Link account" button already uses `variant="primary"`, so Task 2's CSS override alone restyles it.)

### Step 1: Mark the per-template "Save" button as primary

In `apps/shopify/src/pages/FunnelSetupPage.tsx`, find:
```tsx
                  <Button onClick={() => saveRule(item)} loading={savingId === item.id}>
                    Save
                  </Button>
```
Change to:
```tsx
                  <Button
                    onClick={() => saveRule(item)}
                    loading={savingId === item.id}
                    variant="primary"
                  >
                    Save
                  </Button>
```

- [ ] **Make this edit.**

### Step 2: Typecheck + Biome + commit

```bash
cd /mnt/vol1/PycharmProjects/tryme_v1/apps/shopify
npx tsc -b
cd /mnt/vol1/PycharmProjects/tryme_v1
pnpm biome check --write apps/shopify/src/pages/FunnelSetupPage.tsx
git add apps/shopify/src/pages/FunnelSetupPage.tsx
git commit -m "$(cat <<'EOF'
style(shopify): Funnel Setup — brand-primary Save button

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Run the commands above.**

### Step 3: Manual visual check

```bash
pnpm --filter @tryme/shopify-admin dev
```
- [ ] Each funnel template's "Save" button renders pink; "Add condition"/"Remove"/"Re-run rules" stay default (secondary) styling.
- [ ] Link gate's "Link account" button renders pink (via Task 2 alone — confirm no regression).
- [ ] The product-attribute rule engine (conditions, mode toggle, priority, re-run) behaves identically to before.

---

## Self-Review

**Spec coverage:**
- Theming mechanism (Polaris CSS custom-property overrides, verified real token names, no component swaps) → Task 2, with the `Button`-has-no-`className` finding correcting the spec's brief-stage assumption (documented inline rather than silently guessed).
- Backend `statusCounts` + `connectedSince` on `GET /v1/shopify/me`, reconciliation rule → Task 1, TDD against the real existing test file (`apps/api/test/shopify-me.test.ts` — corrected from the brief's assumption that this needed a new `test/integration/` file; it already exists as a flat, always-run test).
- Dashboard restyle + new stats card + connected-since → Task 3.
- Products search/filter + reconciled status → Task 4.
- Link gate + Funnel Setup restyle → Task 5 (plus the finding that `LinkAccountGate` needs zero code changes, already covered by Task 2).
- Nav restyle → folded into Task 2 (tightly coupled to "wire the theme into the shell", not a separate task).
- Zero functional regressions constraint → every task's steps only add fields/props/state, never remove or rewrite existing PATCH/link/rule logic; Task 4's full-file replacement is diffed inline in its own Step 1 notes so a reviewer can confirm only additive changes were made.
- Out-of-scope items (shopper-segment routing, Shopify billing, admin-mobile, pixel-matching) → no task touches any of these.

**Placeholder scan:** No TBD/TODO. Every step has complete, exact code or an exact command with expected output. The one explicitly-flagged uncertainty (Task 2's gradient-button feasibility) was resolved during plan-writing by inspecting the actual installed Polaris package — not left as an open question for the implementer.

**Type consistency:** `ShopifyStats.statusCounts` (Task 1) is `{ active: number; processing: number; failed: number; disabled: number }` — Task 3's Dashboard reads exactly `me?.stats.statusCounts.active/processing/failed/disabled`. `ShopifyMe.store.connectedSince: string` (Task 1) — Task 3 reads `me?.store.connectedSince` and passes it through `new Date(...)`. Task 4's `DisplayStatus` type (`'active' | 'processing' | 'failed' | 'disabled'`) is used consistently across its own `displayStatus()`, `STATUS_TONE`, `STATUS_LABEL`, and the status-filter `<Select>`'s options — no cross-task dependency, self-contained.
