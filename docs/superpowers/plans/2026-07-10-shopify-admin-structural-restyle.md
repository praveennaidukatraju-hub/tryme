# Shopify Embedded Admin Structural Restyle (Phase 2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure the Shopify embedded admin's Dashboard, Products, and link-gate screens to match the mock's actual layout (2-column dashboard grid with an accent-bar credit card and dot-badge sync status, a compact flex-row product table with dot+pill badges, a vertically-centered link gate) — not just color, which the prior plan already handled. Zero functional regressions.

**Architecture:** Two Polaris components get genuinely swapped for custom markup where their own DOM/behavior cannot produce the mock's layout (`IndexTable` → custom flex-table on Products; `Page`'s title-bar chrome → a custom centered layout on the link gate). Everywhere else, the existing `apps/shopify/src/theme.css` gains shape tokens (`--p-border-radius-300`, `--p-shadow-100` — confirmed to be the exact two tokens Polaris's `Card` reads, via its own source), and custom JSX (colored dots, an accent bar, a 2-column grid) is composed as plain children inside the Polaris components already in place, which is always legal since `Card` just renders `children`.

**Tech Stack:** React 18, `@shopify/polaris@13.9.5`, React Router 7, Vite.

## Global Constraints

- This is a structural restyle: colors were already handled by the prior plan (`docs/superpowers/plans/2026-07-10-shopify-admin-restyle.md`, merged). Do not re-touch `theme.css`'s existing color block or re-litigate brand hex values (`#f55c7a` pink, `#f6b553` amber) — only add shape tokens to the same file.
- Zero functional regressions: the onboarding checklist, funnel-assignment dropdown, image picker, product-attribute funnel-rule engine, and the popup-based account-link flow must all work exactly as they do today. Every data-fetching function, PATCH call, and state transition in the touched files is unchanged — only the JSX wrapping it changes.
- Status dot/badge colors reuse Polaris's own existing semantic tokens (success/warning/critical/secondary — the same 4-way mapping already expressed via `ProductsPage.tsx`'s `STATUS_TONE`), not the mock's literal `oklch(...)` values. This keeps the restyle inside the existing design system.
- Funnel Setup (`FunnelSetupPage.tsx`) gets **no changes** in this plan — it's forms, not a grid/table, so there's no structural mismatch to fix; it inherits the new shape tokens automatically. Its shopper-segment-routing concept in the mock remains out of scope, as already decided in the prior plan.
- `cd apps/shopify && npx tsc -b` must be clean after every task.
- Biome pre-commit hook (lefthook) runs automatically, but call `pnpm biome check --write <files>` explicitly at the end of each task anyway, per this repo's established pattern.
- Stage ONLY the exact files each task names — never `git add -A` (the working tree commonly has unrelated in-progress files from other work).
- Commit once per task: `git commit -m "$(cat <<'EOF' ... Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com> EOF )"`.
- No automated test harness exists for `apps/shopify` pages (matches the established pattern — no `.test.tsx` files for pages in this repo). Verification is `tsc -b` clean + a manual visual check via `pnpm --filter @tryme/shopify-admin dev`, matching the prior plan's precedent exactly.

---

## Task 1: Theme shape tokens

**Files:**
- Modify: `apps/shopify/src/theme.css`

**Interfaces:**
- Consumes: nothing.
- Produces: every Polaris `Card` (and any other Polaris surface reading the same two tokens — confirmed via the installed package that `--p-shadow-100` is referenced in 7 places and `--p-border-radius-300` in 18 places across Polaris's stylesheet, e.g. `Popover`, `Modal` — this is an intentional, systemwide "rounder/softer" look, not a Card-only change) picks up the mock's `border-radius: 12px` / thin single-layer shadow treatment. Tasks 3-5 rely on this being in place for their custom accent-bar/badge/gate markup to look visually consistent with restyled `Card`s.

### Step 1: Add the shape token overrides

In `apps/shopify/src/theme.css`, find the existing `:root { ... }` block (added by the prior plan):
```css
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

Change to:
```css
:root {
  --p-color-bg-fill-brand: #f55c7a;
  --p-color-bg-fill-brand-hover: #f6b553;
  --p-color-bg-fill-brand-active: #f6b553;
  --p-color-bg-fill-brand-selected: #f55c7a;
  --p-color-border-brand: #f55c7a;
  --p-color-text-brand: #f55c7a;
  --p-color-text-brand-hover: #f6b553;

  /* Shape tokens — Card's own source (build/esm/components/Card/Card.js)
   * renders via <ShadowBevel boxShadow="100" borderRadius="300">, i.e. these
   * are the exact two tokens Card reads. Default is --p-border-radius-300:
   * 0.75rem (12px, already close) and --p-shadow-100: a thin bottom-only
   * shadow; overriding to a single-layer ring shadow matches the mock's
   * `box-shadow: 0 0 0 1px rgba(0,0,0,.06)` card treatment. */
  --p-border-radius-300: 0.75rem;
  --p-shadow-100: 0 0 0 1px rgba(0, 0, 0, 0.06);
}
```

- [ ] **Make this edit.**

### Step 2: Typecheck + Biome + commit

```bash
cd /mnt/vol1/PycharmProjects/tryme_v1/apps/shopify
npx tsc -b
cd /mnt/vol1/PycharmProjects/tryme_v1
pnpm biome check --write apps/shopify/src/theme.css
git add apps/shopify/src/theme.css
git commit -m "$(cat <<'EOF'
style(shopify): broaden theme with card shape tokens (radius + shadow)

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Run the commands above.**

### Step 3: Manual visual check

```bash
pnpm --filter @tryme/shopify-admin dev
```
- [ ] Every `Card` across all pages now shows a subtle single-ring shadow instead of the default bottom-only shadow (visible on Dashboard's Getting Started card, for example).
- [ ] No layout breakage on any page (Popover/Modal, if triggered anywhere, still render sensibly with the same border radius).

---

## Task 2: Nav — show shop domain

**Files:**
- Modify: `apps/shopify/src/components/AppShell.tsx`
- Modify: `apps/shopify/src/App.tsx`

**Interfaces:**
- Consumes: `ShopifyMe.store.shopDomain` (already fetched in `App.tsx`'s `me` state, added by an earlier plan — no backend change needed).
- Produces: `AppShell` now accepts a `shopDomain: string` prop; nothing else consumes this.

### Step 1: Add the `shopDomain` prop to `AppShell`

In `apps/shopify/src/components/AppShell.tsx`, find:
```tsx
export function AppShell({ children }: { children: ReactNode }) {
```

Change to:
```tsx
export function AppShell({
  children,
  shopDomain,
}: {
  children: ReactNode;
  shopDomain: string;
}) {
```

Find the closing `</nav>` and the elements just before it (the `NAV_ITEMS.map(...)` block):
```tsx
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
                borderBottom: active
                  ? '2px solid var(--p-color-border-brand)'
                  : '2px solid transparent',
              }}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
```

Change to (adds a right-aligned domain label after the tabs, using `marginLeft: 'auto'` to push it to the far right of the flex nav):
```tsx
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
                borderBottom: active
                  ? '2px solid var(--p-color-border-brand)'
                  : '2px solid transparent',
              }}
            >
              {item.label}
            </Link>
          );
        })}
        <div
          style={{
            marginLeft: 'auto',
            fontSize: '12px',
            color: 'var(--p-color-text-secondary)',
          }}
        >
          {shopDomain}
        </div>
      </nav>
```

- [ ] **Make both edits.**

### Step 2: Pass `shopDomain` from `App.tsx`

In `apps/shopify/src/App.tsx`, find:
```tsx
  return (
    <AppProvider i18n={{}}>
      <AppShell>
```

Change to:
```tsx
  return (
    <AppProvider i18n={{}}>
      <AppShell shopDomain={me.store.shopDomain}>
```

`me` is guaranteed non-null here — the preceding `if (!me?.store.ownerUserId)` branch above already returns early, so this line is only reached when `me` is a real, loaded `ShopifyMe` object.

- [ ] **Make this edit.**

### Step 3: Typecheck + Biome + commit

```bash
cd /mnt/vol1/PycharmProjects/tryme_v1/apps/shopify
npx tsc -b
cd /mnt/vol1/PycharmProjects/tryme_v1
pnpm biome check --write apps/shopify/src/components/AppShell.tsx apps/shopify/src/App.tsx
git add apps/shopify/src/components/AppShell.tsx apps/shopify/src/App.tsx
git commit -m "$(cat <<'EOF'
feat(shopify): show shop domain in nav bar

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Run the commands above.**

### Step 4: Manual visual check

```bash
pnpm --filter @tryme/shopify-admin dev
```
- [ ] Nav bar shows the shop domain right-aligned, on all 3 routes.
- [ ] Tab navigation (Dashboard/Products/Funnel Setup) still works exactly as before.

---

## Task 3: Shared status colors + Dashboard restructure

**Files:**
- Create: `apps/shopify/src/lib/statusColors.ts`
- Modify: `apps/shopify/src/pages/DashboardPage.tsx`

**Interfaces:**
- Consumes: `ShopifyMe.stats.statusCounts`, `ShopifyMe.store.connectedSince` (already on the type, from an earlier plan).
- Produces: `apps/shopify/src/lib/statusColors.ts` exports `type ProductStatus = 'active' | 'processing' | 'failed' | 'disabled'`, `STATUS_DOT_COLOR: Record<ProductStatus, string>`, `STATUS_BADGE_BG: Record<ProductStatus, string>`, `STATUS_BADGE_TEXT: Record<ProductStatus, string>` (each value is a CSS `var(--p-color-...)` string, not a literal hex) — Task 4 (Products) imports these same three constants and indexes them with its own structurally-identical `DisplayStatus` type.

### Step 1: Create the shared status-color module

Create `apps/shopify/src/lib/statusColors.ts`:
```ts
export type ProductStatus = 'active' | 'processing' | 'failed' | 'disabled';

// Reuses Polaris's own semantic color tokens (success/warning/critical/secondary)
// rather than the mock's literal colors, so the restyle stays inside the
// existing design system instead of introducing a second, parallel palette.
export const STATUS_DOT_COLOR: Record<ProductStatus, string> = {
  active: 'var(--p-color-icon-success)',
  processing: 'var(--p-color-icon-warning)',
  failed: 'var(--p-color-icon-critical)',
  disabled: 'var(--p-color-icon-secondary)',
};

export const STATUS_BADGE_BG: Record<ProductStatus, string> = {
  active: 'var(--p-color-bg-fill-success-secondary)',
  processing: 'var(--p-color-bg-surface-warning)',
  failed: 'var(--p-color-bg-fill-critical-secondary)',
  disabled: 'var(--p-color-bg-surface-secondary)',
};

export const STATUS_BADGE_TEXT: Record<ProductStatus, string> = {
  active: 'var(--p-color-text-success)',
  processing: 'var(--p-color-text-warning)',
  failed: 'var(--p-color-text-critical)',
  disabled: 'var(--p-color-text-secondary)',
};
```

- [ ] **Create the file above.**

### Step 2: Replace `DashboardPage.tsx` with the restructured version

Full new content for `apps/shopify/src/pages/DashboardPage.tsx`:
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
import { STATUS_DOT_COLOR } from '../lib/statusColors';
import type { ShopifyMe, ShopifyOnboardingConfirmResponse } from '../types';

function StatusDotRow({ label, count, dotColor }: { label: string; count: number; dotColor: string }) {
  return (
    <InlineStack align="space-between">
      <InlineStack gap="200">
        <span
          style={{
            display: 'inline-block',
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            background: dotColor,
          }}
        />
        <Text as="p">{label}</Text>
      </InlineStack>
      <Text as="p" fontWeight="semibold">
        {count}
      </Text>
    </InlineStack>
  );
}

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
      <Page title="Home">
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
  const funnelConfigured = me?.stats.funnelConfigured ?? false;
  const doneCount = [synced, enabled, themeBlockDone, funnelConfigured].filter(Boolean).length;

  return (
    <Page title="Home" subtitle={me?.store.shopDomain}>
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
                <Badge tone={doneCount === 4 ? 'success' : 'info'}>{`${doneCount}/4`}</Badge>
              </InlineStack>

              <InlineStack align="space-between">
                <Text as="p">{synced ? '✅' : '⭕'} Sync your products</Text>
                <Button
                  onClick={syncProducts}
                  loading={syncing}
                  disabled={synced}
                  variant="primary"
                >
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

              <InlineStack align="space-between">
                <Text as="p">
                  {funnelConfigured ? '✅' : '⭕'} Set up your funnel templates
                </Text>
                <Button onClick={() => navigate('/funnel-setup')}>Go to Funnel Setup</Button>
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

          <div style={{ display: 'grid', gridTemplateColumns: '1.1fr 1fr', gap: '16px' }}>
            <div style={{ position: 'relative' }}>
              <div
                style={{
                  position: 'absolute',
                  top: 0,
                  left: 0,
                  right: 0,
                  height: '3px',
                  background:
                    'linear-gradient(90deg, var(--p-color-bg-fill-brand), var(--p-color-bg-fill-brand-hover))',
                  borderTopLeftRadius: 'var(--p-border-radius-300)',
                  borderTopRightRadius: 'var(--p-border-radius-300)',
                  zIndex: 1,
                }}
              />
              <Card>
                <BlockStack gap="200">
                  <Text as="h3" variant="headingSm">
                    Credit Balance
                  </Text>
                  <Text as="p" variant="heading2xl">
                    {me?.creditBalance ?? 0}
                  </Text>
                  <Button
                    variant="primary"
                    onClick={() =>
                      window.open('https://app.tryme.com/pricing', '_blank', 'noopener')
                    }
                  >
                    Top up on tryme.com
                  </Button>
                </BlockStack>
              </Card>
            </div>

            <Card>
              <BlockStack gap="200">
                <Text as="h3" variant="headingSm">
                  Product sync status
                </Text>
                <StatusDotRow
                  label="Active"
                  count={me?.stats.statusCounts.active ?? 0}
                  dotColor={STATUS_DOT_COLOR.active}
                />
                <StatusDotRow
                  label="Processing"
                  count={me?.stats.statusCounts.processing ?? 0}
                  dotColor={STATUS_DOT_COLOR.processing}
                />
                <StatusDotRow
                  label="Failed"
                  count={me?.stats.statusCounts.failed ?? 0}
                  dotColor={STATUS_DOT_COLOR.failed}
                />
                <StatusDotRow
                  label="Disabled"
                  count={me?.stats.statusCounts.disabled ?? 0}
                  dotColor={STATUS_DOT_COLOR.disabled}
                />
              </BlockStack>
            </Card>
          </div>

          <Card>
            <InlineStack align="space-between">
              <Button onClick={() => navigate('/products')}>Manage Products</Button>
              {me?.store.connectedSince && (
                <Text as="p" tone="subdued">
                  Connected since {new Date(me.store.connectedSince).toLocaleDateString()}
                </Text>
              )}
            </InlineStack>
          </Card>
        </Layout.Section>
      </Layout>
    </Page>
  );
}
```

Notes on what changed vs. the original (for the reviewer, not a step to execute): `Page`'s `title` changed from `"TryMe Try-On"` to `"Home"` and gained a `subtitle={me?.store.shopDomain}` (matches the mock's title+domain pairing, using Polaris's own `subtitle` prop — `Page` itself is not dropped). The standalone "Product sync status" and "Credit Balance" `Card`s (previously stacked full-width) are now a 2-column CSS grid row; the Credit Balance card gained a decorative gradient accent-bar `div` (absolutely positioned inside a `position: relative` wrapper `div` around the `Card` — no Polaris API needed for this, since it's just a sibling `div`, not a prop on `Card`); the sync-status rows gained a colored dot via the new `StatusDotRow` local component. The Store `Card` changed from a vertical `BlockStack` (with a repeated domain heading) to a horizontal `InlineStack` — domain heading removed here since it now lives in the page subtitle, "Manage Products" and "Connected since" placed at opposite ends via `align="space-between"`. The Getting Started card and the 3 stat cards are byte-for-byte unchanged. All data-fetching functions (`load`, `syncProducts`, `confirmThemeBlock`) are unchanged.

- [ ] **Make both edits (create the new file, replace `DashboardPage.tsx`).**

### Step 3: Typecheck + Biome + commit

```bash
cd /mnt/vol1/PycharmProjects/tryme_v1/apps/shopify
npx tsc -b
cd /mnt/vol1/PycharmProjects/tryme_v1
pnpm biome check --write apps/shopify/src/lib/statusColors.ts apps/shopify/src/pages/DashboardPage.tsx
git add apps/shopify/src/lib/statusColors.ts apps/shopify/src/pages/DashboardPage.tsx
git commit -m "$(cat <<'EOF'
feat(shopify): Dashboard — 2-column grid, accent-bar credit card, dot-badge sync status

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Run the commands above.**

### Step 4: Manual visual check

```bash
pnpm --filter @tryme/shopify-admin dev
```
- [ ] Page title reads "Home" with the shop domain as a subtitle underneath.
- [ ] Credit Balance and Product sync status cards sit side-by-side in a 2-column row; Credit Balance shows a thin gradient bar across its top edge.
- [ ] Each Product sync status row shows a colored dot (green/amber/red/gray) before its label.
- [ ] Store card shows "Manage Products" on the left and "Connected since <date>" on the right, no repeated domain text.
- [ ] Getting Started checklist and the 3 stat cards behave exactly as before (sync/confirm buttons, nav buttons).

---

## Task 4: Products — custom table + dot-pill badges

**Files:**
- Modify: `apps/shopify/src/pages/ProductsPage.tsx`

**Interfaces:**
- Consumes: `STATUS_DOT_COLOR`, `STATUS_BADGE_BG`, `STATUS_BADGE_TEXT` from `apps/shopify/src/lib/statusColors.ts` (Task 3), indexed with this file's own existing `DisplayStatus` type (structurally identical to `ProductStatus`, so no import of that type itself is needed here — only the three color-map constants).
- Produces: nothing consumed by later tasks.

### Step 1: Replace the file with the custom table + dot-pill badges

Full new content for `apps/shopify/src/pages/ProductsPage.tsx`:
```tsx
import { Banner, Page, Select, TextField, Thumbnail } from '@shopify/polaris';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ImagePickerModal } from '../components/ImagePickerModal';
import { apiFetch } from '../lib/api';
import { STATUS_BADGE_BG, STATUS_BADGE_TEXT, STATUS_DOT_COLOR } from '../lib/statusColors';
import type { FunnelTemplateItem, ShopifyProductListItem } from '../types';

type DisplayStatus = 'active' | 'processing' | 'failed' | 'disabled';

// Reconciles two independent real-data axes (sync `status` and the `enabled`
// toggle) into the single status bucket shown in the UI: a disabled product
// always reads as "Disabled", regardless of its underlying sync status.
function displayStatus(item: ShopifyProductListItem): DisplayStatus {
  if (!item.enabled || item.status === 'deleted') return 'disabled';
  return item.status as DisplayStatus;
}

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

function StatusBadge({ status }: { status: DisplayStatus }) {
  return (
    <span
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '5px',
        padding: '3px 10px',
        borderRadius: 'var(--p-border-radius-full)',
        fontSize: '12px',
        fontWeight: 600,
        background: STATUS_BADGE_BG[status],
        color: STATUS_BADGE_TEXT[status],
      }}
    >
      <span
        style={{
          display: 'inline-block',
          width: '6px',
          height: '6px',
          borderRadius: '50%',
          background: STATUS_DOT_COLOR[status],
        }}
      />
      {STATUS_LABEL[status]}
    </span>
  );
}

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
    <Page title="Products" subtitle="Manage which products show the TryMe try-on widget.">
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

      <div
        style={{
          background: 'var(--p-color-bg-surface)',
          borderRadius: 'var(--p-border-radius-300)',
          boxShadow: 'var(--p-shadow-100)',
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            padding: '10px 16px',
            borderBottom: '1px solid var(--p-color-border-secondary)',
            color: 'var(--p-color-text-secondary)',
            fontSize: '12px',
            fontWeight: 600,
          }}
        >
          <div style={{ flex: '1 1 auto' }}>Product</div>
          <div style={{ width: '120px' }}>Status</div>
          <div style={{ width: '140px' }}>Try-on enabled</div>
          <div style={{ width: '220px' }}>Funnel</div>
        </div>

        {loading && (
          <div
            style={{
              padding: '24px 16px',
              textAlign: 'center',
              color: 'var(--p-color-text-secondary)',
              fontSize: '13px',
            }}
          >
            Loading products…
          </div>
        )}

        {!loading &&
          filteredItems.map((item) => (
            <div
              key={item.shopifyProductId}
              style={{
                display: 'flex',
                alignItems: 'center',
                padding: '10px 16px',
                borderBottom: '1px solid var(--p-color-border-secondary)',
                gap: '12px',
              }}
            >
              <div style={{ flex: '1 1 auto', display: 'flex', alignItems: 'center', gap: '12px' }}>
                <Thumbnail source={item.thumbnailUrl} alt={item.title ?? ''} size="small" />
                <div>
                  <div style={{ fontSize: '13.5px', fontWeight: 500 }}>{item.title}</div>
                  <button
                    type="button"
                    onClick={() => setPickerProductId(item.shopifyProductId)}
                    style={{ marginTop: '2px', fontSize: '12px' }}
                  >
                    Change image
                  </button>
                </div>
              </div>
              <div style={{ width: '120px' }}>
                <StatusBadge status={displayStatus(item)} />
              </div>
              <div style={{ width: '140px' }}>
                <input
                  type="checkbox"
                  checked={item.enabled}
                  disabled={item.status !== 'active' && !item.enabled}
                  title={item.status !== 'active' ? 'Waiting for product sync' : undefined}
                  onChange={(e) => toggleEnabled(item.shopifyProductId, e.target.checked)}
                />
              </div>
              <div style={{ width: '220px' }}>
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
              </div>
            </div>
          ))}

        {!loading && filteredItems.length === 0 && (
          <div
            style={{
              padding: '28px',
              textAlign: 'center',
              color: 'var(--p-color-text-secondary)',
              fontSize: '13px',
            }}
          >
            No products match your search.
          </div>
        )}
      </div>

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

Notes on what changed vs. the original (for the reviewer, not a step to execute): `IndexTable`/`Badge`/`useIndexResourceState` are no longer imported or used — replaced with a hand-rolled flex-based table (header row + body rows, `border-bottom` between rows) and a `StatusBadge` local component (dot+pill `span`, colored via the Task 3 shared tokens). `useIndexResourceState`/`selectedResources` are removed since nothing consumed `selectedItemsCount` beyond `IndexTable`'s own now-removed header (confirmed unused during the prior plan's Task 4 review — no bulk-action UI exists). A "No products match your search." empty state is added (present in the mock, and a genuine gap the prior plan's review flagged as missing). `Page` gained a `subtitle`. All logic — `toggleEnabled`, `selectImage`, `setFunnel`, `load`, `displayStatus`, `filteredItems`, `searchQuery`/`statusFilter` state — is byte-for-byte unchanged; only the JSX wrapping it changed from `IndexTable.Row`/`IndexTable.Cell` to plain flex `div`s.

- [ ] **Replace the file with the content above.**

### Step 2: Typecheck + Biome + commit

```bash
cd /mnt/vol1/PycharmProjects/tryme_v1/apps/shopify
npx tsc -b
cd /mnt/vol1/PycharmProjects/tryme_v1
pnpm biome check --write apps/shopify/src/pages/ProductsPage.tsx
git add apps/shopify/src/pages/ProductsPage.tsx
git commit -m "$(cat <<'EOF'
feat(shopify): Products — custom compact table with dot-pill status badges

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Run the commands above.**

### Step 3: Manual visual check

```bash
pnpm --filter @tryme/shopify-admin dev
```
- [ ] Table renders as a compact card with a thin header row and thin borders between product rows (not the default Polaris `IndexTable` chrome).
- [ ] Status badges show a colored dot + label (green/active, amber/processing, red/failed, gray/disabled).
- [ ] Search box, status filter, image picker, enable/disable checkbox, and funnel dropdown all still work exactly as before.
- [ ] Searching or filtering to zero results shows "No products match your search."

---

## Task 5: Link gate — vertically-centered layout

**Files:**
- Modify: `apps/shopify/src/components/LinkAccountGate.tsx`

**Interfaces:**
- Consumes: brand gradient tokens (`--p-color-bg-fill-brand`, `--p-color-bg-fill-brand-hover`) and shape tokens (`--p-border-radius-300`, `--p-shadow-100`) from `theme.css` (Tasks 1 and the prior plan).
- Produces: nothing consumed by later tasks (this is the last task in this plan).

### Step 1: Replace the file with the centered gate layout

Full new content for `apps/shopify/src/components/LinkAccountGate.tsx`:
```tsx
import { Banner, BlockStack, Button, Text } from '@shopify/polaris';
import { useState } from 'react';
import { apiFetch } from '../lib/api';

const TRYME_APP_URL = import.meta.env.VITE_TRYME_APP_URL || 'https://app.tryme.com';

function openLinkPopup(): Promise<string> {
  return new Promise((resolve, reject) => {
    const nonce = Math.random().toString(36).slice(2);
    const origin = window.location.origin;
    const popup = window.open(
      `${TRYME_APP_URL}/login?next=${encodeURIComponent(
        `/widget-link-complete?origin=${encodeURIComponent(origin)}&nonce=${nonce}`,
      )}`,
      'tryme-link',
      'width=480,height=640',
    );

    function onMessage(event: MessageEvent) {
      if (event.origin !== TRYME_APP_URL) return;
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
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: '32px',
      }}
    >
      <div
        style={{
          width: '420px',
          maxWidth: '100%',
          background: 'var(--p-color-bg-surface)',
          borderRadius: 'var(--p-border-radius-300)',
          boxShadow: 'var(--p-shadow-100)',
          padding: '36px 32px',
          textAlign: 'center',
        }}
      >
        <div
          style={{
            width: '52px',
            height: '52px',
            borderRadius: '14px',
            margin: '0 auto 20px',
            background:
              'linear-gradient(135deg, var(--p-color-bg-fill-brand), var(--p-color-bg-fill-brand-hover))',
          }}
        />
        <BlockStack gap="300">
          <Text as="h1" variant="headingLg" alignment="center">
            Connect your TryMe account
          </Text>
          <Text as="p" tone="subdued" alignment="center">
            To use TryMe Try-On, link this store to your tryme account. Billing and credits
            are managed on app.tryme.com — nothing is charged through Shopify.
          </Text>
          {error && (
            <Banner tone="critical" title="Linking failed">
              {error}
            </Banner>
          )}
          <Button onClick={link} loading={linking} variant="primary" fullWidth>
            Link account
          </Button>
        </BlockStack>
      </div>
    </div>
  );
}
```

Notes on what changed vs. the original (for the reviewer, not a step to execute): `Page` and `Card` are no longer imported or used — replaced with a full-viewport-height flex container centering a fixed-width (`420px`) custom card, matching the mock's gate layout (a `Page` cannot render vertically centered, non-full-width content). The icon-block gradient square, heading, and description are new markup matching the mock; the `Banner` (on error) and the brand-primary `Button` are unchanged Polaris components, just relocated into the new card. `openLinkPopup()` and the `link()` function (including the popup/message/close-check flow) are entirely unchanged.

- [ ] **Replace the file with the content above.**

### Step 2: Typecheck + Biome + commit

```bash
cd /mnt/vol1/PycharmProjects/tryme_v1/apps/shopify
npx tsc -b
cd /mnt/vol1/PycharmProjects/tryme_v1
pnpm biome check --write apps/shopify/src/components/LinkAccountGate.tsx
git add apps/shopify/src/components/LinkAccountGate.tsx
git commit -m "$(cat <<'EOF'
style(shopify): link gate — vertically-centered layout matching mock

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```

- [ ] **Run the commands above.**

### Step 3: Manual visual check

```bash
pnpm --filter @tryme/shopify-admin dev
```
(Test against an unlinked store, or temporarily simulate `ownerUserId: null` in a local response, to reach this screen.)
- [ ] Gate renders as a vertically-and-horizontally-centered card (not a top-anchored Polaris `Page`).
- [ ] Clicking "Link account" still opens the popup and completes the link flow exactly as before.
- [ ] An error during linking still shows the `Banner` correctly inside the card.

---

## Self-Review

**Spec coverage:**
- Theme shape tokens (`--p-border-radius-300`, `--p-shadow-100`, confirmed exact via `Card.js`'s source) → Task 1.
- Nav shop domain → Task 2.
- Shared status-color tokens (reusing Polaris semantic tokens, not the mock's literal colors) → Task 3, consumed by Task 4.
- Dashboard 2-column grid, accent-bar credit card, dot-badge sync status, restructured Store card, `Page` `subtitle` → Task 3.
- Products custom table, dot-pill badges, empty-state message → Task 4.
- Link gate vertically-centered custom layout → Task 5.
- Funnel Setup — explicitly no task, per the spec's "no structural mismatch to fix" call; it inherits Task 1's shape tokens automatically.
- Zero functional regressions constraint → every task's notes section explicitly confirms which functions/handlers are byte-for-byte unchanged; only JSX wrapping changed.
- Out-of-scope items (shopper-segment routing, pixel-matching the mock's literal markup, etc.) → no task touches any of these.

**Placeholder scan:** No TBD/TODO. Every step has complete, exact code or an exact command with expected output.

**Type consistency:** `apps/shopify/src/lib/statusColors.ts`'s `ProductStatus` type (`'active' | 'processing' | 'failed' | 'disabled'`) is structurally identical to `ProductsPage.tsx`'s own `DisplayStatus` type — Task 4's `StatusBadge` component indexes the imported `STATUS_BADGE_BG`/`STATUS_BADGE_TEXT`/`STATUS_DOT_COLOR` (typed `Record<ProductStatus, string>`) with a `DisplayStatus` value; TypeScript accepts this since the two string-literal unions are exactly equal. Task 3's `StatusDotRow` component takes `dotColor: string` (a plain string prop, not tied to either type), so no cross-file type dependency exists there beyond the `STATUS_DOT_COLOR` constant's own value type. `ShopifyMe.store.shopDomain`/`connectedSince` and `ShopifyStats.statusCounts` (all defined in an earlier, already-merged plan) are consumed identically to how the already-merged Task 3/Task 1 (brand-restyle plan) used them — no new backend fields needed for this plan.
