# Credit Plans Subview Tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move all 6 credit-cost widgets (Resolution Pricing, Virtual Try-On, Dev API Saree Mannequin, Catalog Video/PixVerse, Shopify Free Trial, Shopify Plan Credits) out of the overloaded "System" tab and the existing "Purchasable Plans" content out of a flat "Credit Plans" tab, into 3 independently-saving subviews under "Credit Plans": **Purchasable Plans**, **Job Costs**, **Shopify**.

**Architecture:** `apps/admin-web/src/pages/SettingsPage.tsx` (2297 lines) currently renders one shared `.card.settings-card` for the whole "System" tab with one `useEffect` fetch, one `saveSysConfig` PATCH, and one Save button covering everything from resolution pricing to upload limits. This plan extracts three self-contained components into a new `apps/admin-web/src/pages/settings/` directory — `PurchasablePlansTab.tsx`, `JobCostsTab.tsx`, `ShopifyCreditsTab.tsx` — each with its own state, its own `GET /admin/config` fetch, and its own `PATCH /admin/config` save (a partial body — the route already shallow-merges). This follows `apps/admin-web/src/pages/assets/*.tsx`'s existing precedent of splitting a tabbed page's bodies into per-tab files. `SettingsPage.tsx` gains a small local-state subview switcher (same `.tabs`/`.tab` CSS the top-level tab bar already uses) inside the `credit-plans` section, and loses ~900 lines (the migrated state/effects/handlers/JSX plus the corresponding fields from `saveSysConfig`'s payload and the System Save button's validation).

**Tech Stack:** React, TypeScript, `apiFetch`/`apiErrorMessage` from `../lib/data` (or `../../lib/data` from the new `settings/` subdirectory), existing `Icon`, `Switch`, `ConfirmModal` components.

## Global Constraints

- No backend changes — `PATCH /admin/config` already shallow-merges partial bodies; `GET /admin/config` already returns every field regardless of who asks.
- Every moved JSX block is moved **verbatim** — same class names, same inline styles, same input min/max/labels. This is a structural extraction, not a redesign.
- Each new subview does its own independent `GET /admin/config` fetch and its own independent `PATCH /admin/config` save — no shared save button across subviews, and no shared save button with the System tab.
- The System tab keeps: Max Output Resolution, Max Batch Size, App Video, Upload Limits, Merchant Catalogue Defaults. Its `saveSysConfig`/fetch/Save-button-validation drop every field that moved.
- No test step in any task — `apps/admin-web` has no test suite in this repo. Every task is verified via `pnpm --filter @tryme/admin build` (typecheck + bundle) and, in the final task, a manual dev-server check.
- New files live in `apps/admin-web/src/pages/settings/`, matching the `apps/admin-web/src/pages/assets/` precedent for per-tab file splitting.

---

### Task 1: `JobCostsTab.tsx` — Resolution, Try-On, Saree Mannequin, PixVerse

**Files:**
- Create: `apps/admin-web/src/pages/settings/JobCostsTab.tsx`
- Modify: `apps/admin-web/src/pages/SettingsPage.tsx`

**Interfaces:**
- Consumes: `apiFetch`, `apiErrorMessage` from `../../lib/data`; `Icon` from `../../components/Icons`; `Switch` from `../../components/Switch`; `toast` prop (same signature as `Props['toast']` in `SettingsPage.tsx`: `(t: { kind?: 'error'; title: string; body?: string }) => void`).
- Produces: `export default function JobCostsTab({ toast }: { toast: ... })` — a fully self-contained component. Task 4 imports and renders it.

- [ ] **Step 1: Create the new file**

Create `apps/admin-web/src/pages/settings/JobCostsTab.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { Icon } from '../../components/Icons';
import { Switch } from '../../components/Switch';
import { apiErrorMessage, apiFetch } from '../../lib/data';

interface Props {
  toast: (t: { kind?: 'error'; title: string; body?: string }) => void;
}

export default function JobCostsTab({ toast }: Props) {
  const [resolutions, setResolutions] = useState<
    Record<string, { enabled: boolean; creditCost: number }>
  >({
    HD: { enabled: false, creditCost: 10 },
    '2K': { enabled: true, creditCost: 25 },
    '4K': { enabled: true, creditCost: 40 },
  });
  const [tryonCreditCost, setTryonCreditCost] = useState(5);
  const [sareeMannequinDevCreditCost, setSareeMannequinDevCreditCost] = useState(10);
  const [pixverseCreditCost, setPixverseCreditCost] = useState(150);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    apiFetch<{
      resolutions?: Record<string, { enabled: boolean; creditCost: number }>;
      tryon?: { creditCost: number };
      sareeMannequinDev?: { creditCost: number };
      pixverse?: { creditCost: number };
    }>('/admin/config')
      .then((cfg) => {
        if (cfg.resolutions) setResolutions(cfg.resolutions);
        if (cfg.tryon) setTryonCreditCost(cfg.tryon.creditCost);
        if (cfg.sareeMannequinDev) setSareeMannequinDevCreditCost(cfg.sareeMannequinDev.creditCost);
        if (cfg.pixverse) setPixverseCreditCost(cfg.pixverse.creditCost);
      })
      .catch((e) =>
        toast({
          kind: 'error',
          title: 'Failed to load job costs',
          body: apiErrorMessage(e, 'Please try again.'),
        }),
      )
      .finally(() => setLoading(false));
  }, [toast]);

  const save = async () => {
    setSaving(true);
    try {
      await apiFetch('/admin/config', {
        method: 'PATCH',
        body: JSON.stringify({
          resolutions,
          tryon: { creditCost: tryonCreditCost },
          sareeMannequinDev: { creditCost: sareeMannequinDevCreditCost },
          pixverse: { creditCost: pixverseCreditCost },
        }),
      });
      toast({ title: 'Job costs saved' });
    } catch (e) {
      toast({
        kind: 'error',
        title: 'Failed to save job costs',
        body: apiErrorMessage(e, 'Please try again.'),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card settings-card">
      <div className="card-head">
        <h3>
          <Icon.Coin /> Job Costs
        </h3>
      </div>
      <div className="card-body">
        {loading ? (
          <div style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</div>
        ) : (
          <>
            {/* PASTE_RESOLUTION_PRICING_BLOCK */}
            {/* PASTE_VIRTUAL_TRYON_BLOCK */}
            {/* PASTE_SAREE_MANNEQUIN_BLOCK */}
            {/* PASTE_PIXVERSE_BLOCK */}

            <div className="setting-actions">
              <button className="btn primary" onClick={save} disabled={saving}>
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
```

Now replace the 4 `{/* PASTE_..._BLOCK */}` placeholder comments with the exact JSX cut verbatim from `apps/admin-web/src/pages/SettingsPage.tsx` (as it currently exists, before Task 1's Step 2 edits it), using `sysSaving` renamed to `saving` in each `disabled={...}` prop (the only token that changes — everything else, including every state setter name, is identical):

1. **Resolution Pricing** — the block beginning `<div style={{ marginTop: 24, marginBottom: 8 }}>` whose first `setting-lbl` text is `Resolution Pricing`, through its matching closing `</div>` (this block contains the `(['HD', '2K', '4K'] as const).map(...)` loop using `<Switch>` and `resolutions`/`setResolutions`).
2. **Virtual Try-On Pricing** — the block whose `setting-lbl` text is `Virtual Try-On Pricing`, using `tryonCreditCost`/`setTryonCreditCost`.
3. **Dev API — Saree Mannequin** — the block whose `setting-lbl` text is `Dev API — Saree Mannequin`, using `sareeMannequinDevCreditCost`/`setSareeMannequinDevCreditCost`.
4. **Catalog Video (PixVerse)** — the block whose `setting-lbl` text is `Catalog Video (PixVerse)`, using `pixverseCreditCost`/`setPixverseCreditCost`.

Each of these 4 blocks currently has `disabled={sysSaving}` (or, for Resolution Pricing's cost input, `disabled={sysSaving || !cfg.enabled}`) on its `<input>` — change `sysSaving` to `saving` in all 4 (this is the only substitution).

- [ ] **Step 2: Remove the 4 blocks and their state from `SettingsPage.tsx`**

In `apps/admin-web/src/pages/SettingsPage.tsx`:

- Delete the 4 JSX blocks just copied (Resolution Pricing, Virtual Try-On Pricing, Dev API — Saree Mannequin, Catalog Video (PixVerse)) from the `system` tab's JSX — they currently sit between the tab's opening (`{sysLoading ? (...) : (<>`) and the `Max Output Resolution` block on one side, and between `Max Batch Size` and `Shopify Free Trial` on the other. After deletion, `Max Output Resolution` should immediately follow the `<>` opening, and `Max Batch Size` should be immediately followed by `Shopify Free Trial` (not yet moved — that's Task 2).
- Delete the state declarations: `const [resolutions, setResolutions] = useState<...>(...)`, `const [tryonCreditCost, setTryonCreditCost] = useState(5);`, `const [sareeMannequinDevCreditCost, setSareeMannequinDevCreditCost] = useState(10);`, `const [pixverseCreditCost, setPixverseCreditCost] = useState(150);`.
- In the shared `useEffect` fetch (the one reading `/admin/config` into `sysLoading`), remove `resolutions?: ...`, `tryon?: ...`, `sareeMannequinDev?: ...`, `pixverse?: ...` from the response type literal, and remove the 4 corresponding `if (cfg.X) setX(...)` lines from the `.then((cfg) => { ... })` body.
- In `saveSysConfig`'s PATCH body, remove the `resolutions,`, `tryon: { creditCost: tryonCreditCost },`, `sareeMannequinDev: { creditCost: sareeMannequinDevCreditCost },`, and `pixverse: { creditCost: pixverseCreditCost },` lines.
- `Switch` import stays in `SettingsPage.tsx` — it's still used by the Notifications tab's `soundEnabled` toggle.

- [ ] **Step 3: Typecheck / build**

Run: `pnpm --filter @tryme/admin build`
Expected: no errors, build succeeds (some unused-variable errors are expected until Task 4 wires `JobCostsTab` into the render tree and finishes cleanup — if `tsc -b` fails here on an unused import/variable inside `SettingsPage.tsx` from this step's deletions, remove that specific unused import/variable now rather than deferring)

- [ ] **Step 4: Commit**

```bash
git add apps/admin-web/src/pages/settings/JobCostsTab.tsx apps/admin-web/src/pages/SettingsPage.tsx
git commit -m "refactor(admin): extract Job Costs into its own settings subview"
```

---

### Task 2: `ShopifyCreditsTab.tsx` — Trial Credits and Plan Credits

**Files:**
- Create: `apps/admin-web/src/pages/settings/ShopifyCreditsTab.tsx`
- Modify: `apps/admin-web/src/pages/SettingsPage.tsx`

**Interfaces:**
- Consumes: same imports as Task 1 (`apiFetch`, `apiErrorMessage`, `Icon`), plus `toast` prop.
- Produces: `export default function ShopifyCreditsTab({ toast }: { toast: ... })`. Task 4 imports and renders it.

- [ ] **Step 1: Create the new file**

Create `apps/admin-web/src/pages/settings/ShopifyCreditsTab.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { Icon } from '../../components/Icons';
import { apiErrorMessage, apiFetch } from '../../lib/data';

interface Props {
  toast: (t: { kind?: 'error'; title: string; body?: string }) => void;
}

export default function ShopifyCreditsTab({ toast }: Props) {
  const [shopifyTrialCredits, setShopifyTrialCredits] = useState(25);
  const [shopifyPlanCredits, setShopifyPlanCredits] = useState({
    starter: 1925,
    growth: 5000,
    pro: 22000,
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    apiFetch<{
      shopify?: {
        trialCredits: number;
        planCredits?: { starter: number; growth: number; pro: number };
      };
    }>('/admin/config')
      .then((cfg) => {
        if (cfg.shopify) {
          setShopifyTrialCredits(cfg.shopify.trialCredits);
          if (cfg.shopify.planCredits) setShopifyPlanCredits(cfg.shopify.planCredits);
        }
      })
      .catch((e) =>
        toast({
          kind: 'error',
          title: 'Failed to load Shopify credits',
          body: apiErrorMessage(e, 'Please try again.'),
        }),
      )
      .finally(() => setLoading(false));
  }, [toast]);

  const save = async () => {
    setSaving(true);
    try {
      await apiFetch('/admin/config', {
        method: 'PATCH',
        body: JSON.stringify({
          shopify: { trialCredits: shopifyTrialCredits, planCredits: shopifyPlanCredits },
        }),
      });
      toast({ title: 'Shopify credits saved' });
    } catch (e) {
      toast({
        kind: 'error',
        title: 'Failed to save Shopify credits',
        body: apiErrorMessage(e, 'Please try again.'),
      });
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="card settings-card">
      <div className="card-head">
        <h3>
          <Icon.Coin /> Shopify
        </h3>
      </div>
      <div className="card-body">
        {loading ? (
          <div style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</div>
        ) : (
          <>
            {/* PASTE_SHOPIFY_FREE_TRIAL_BLOCK */}

            <div className="setting-actions">
              <button
                className="btn primary"
                onClick={save}
                disabled={
                  saving ||
                  !Number.isInteger(shopifyTrialCredits) ||
                  shopifyTrialCredits < 0 ||
                  shopifyTrialCredits > 1000 ||
                  !Number.isInteger(shopifyPlanCredits.starter) ||
                  shopifyPlanCredits.starter < 1 ||
                  shopifyPlanCredits.starter > 1000000 ||
                  !Number.isInteger(shopifyPlanCredits.growth) ||
                  shopifyPlanCredits.growth < 1 ||
                  shopifyPlanCredits.growth > 1000000 ||
                  !Number.isInteger(shopifyPlanCredits.pro) ||
                  shopifyPlanCredits.pro < 1 ||
                  shopifyPlanCredits.pro > 1000000
                }
              >
                {saving ? 'Saving…' : 'Save'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
```

Replace the `{/* PASTE_SHOPIFY_FREE_TRIAL_BLOCK */}` placeholder with the exact JSX cut verbatim from `SettingsPage.tsx` (as it exists before Task 2's Step 2 edits): the block beginning `<div style={{ marginTop: 24, marginBottom: 8 }}>` whose first `setting-lbl` text is `Shopify Free Trial`, through its matching closing `</div>` — this block contains both the single Trial Credits row (`shopifyTrialCredits`/`setShopifyTrialCredits`) AND the nested `(['starter', 'growth', 'pro'] as const).map(...)` grid for `shopifyPlanCredits`/`setShopifyPlanCredits`. Change every `disabled={sysSaving}` inside this block to `disabled={saving}` (the only substitution).

- [ ] **Step 2: Remove the block and its state from `SettingsPage.tsx`**

In `apps/admin-web/src/pages/SettingsPage.tsx`:

- Delete the Shopify Free Trial JSX block just copied — it currently sits between the (already-moved-in-Task-1) `Catalog Video (PixVerse)` position and `App Video`. After Task 1 and this step, `Max Batch Size` should be immediately followed by `App Video`.
- Delete the state declarations: `const [shopifyTrialCredits, setShopifyTrialCredits] = useState(25);` and `const [shopifyPlanCredits, setShopifyPlanCredits] = useState({...});`.
- In the shared `useEffect` fetch, remove `shopify?: { trialCredits: number; planCredits?: {...} };` from the response type literal, and remove the `if (cfg.shopify) { setShopifyTrialCredits(...); if (cfg.shopify.planCredits) setShopifyPlanCredits(...); }` block from `.then((cfg) => { ... })`.
- In `saveSysConfig`'s PATCH body, remove the `shopify: { trialCredits: shopifyTrialCredits, planCredits: shopifyPlanCredits },` line.
- In the System tab's Save button `disabled={...}` prop, remove all 9 `shopifyTrialCredits`/`shopifyPlanCredits.*` checks (everything from `!Number.isInteger(shopifyTrialCredits) ||` through `shopifyPlanCredits.pro > 1000000` inclusive) — what remains should be just the `sysSaving`, `maxOutputPx`, and `maxBatchJobs` checks.

- [ ] **Step 3: Typecheck / build**

Run: `pnpm --filter @tryme/admin build`
Expected: no errors (same note as Task 1 Step 3 — fix any newly-unused import/variable in `SettingsPage.tsx` surfaced by this step's deletions)

- [ ] **Step 4: Commit**

```bash
git add apps/admin-web/src/pages/settings/ShopifyCreditsTab.tsx apps/admin-web/src/pages/SettingsPage.tsx
git commit -m "refactor(admin): extract Shopify credits into its own settings subview"
```

---

### Task 3: `PurchasablePlansTab.tsx` — Free Plan Display + Paid Plan CRUD

**Files:**
- Create: `apps/admin-web/src/pages/settings/PurchasablePlansTab.tsx`
- Modify: `apps/admin-web/src/pages/SettingsPage.tsx`

**Interfaces:**
- Consumes: `apiFetch`, `apiErrorMessage` from `../../lib/data`; `Icon` from `../../components/Icons`; `Switch` from `../../components/Switch`; `ConfirmModal` from `../../components/ConfirmModal`; `CreditPlan` type from `../../types`; `toast` prop.
- Produces: `export default function PurchasablePlansTab({ toast }: { toast: ... })`, containing its own `PlanModal` sub-component (moved, not shared). Task 4 imports and renders `PurchasablePlansTab`.

- [ ] **Step 1: Create the new file**

Create `apps/admin-web/src/pages/settings/PurchasablePlansTab.tsx` with this structure — imports, the `EMPTY_FORM` constant, the `PlanModal` function, then the `PurchasablePlansTab` component:

```tsx
import { useEffect, useState } from 'react';
import { ConfirmModal } from '../../components/ConfirmModal';
import { Icon } from '../../components/Icons';
import { Switch } from '../../components/Switch';
import { apiErrorMessage, apiFetch } from '../../lib/data';
import type { CreditPlan } from '../../types';

interface ToastFn {
  (t: { kind?: 'error'; title: string; body?: string }): void;
}

const EMPTY_FORM = {
  slug: '',
  name: '',
  subtext: '',
  credits: 0,
  priceRupees: 0,
  isActive: true,
  isHighlighted: false,
  badge: '',
  sortOrder: 0,
  queueStream: 'normal' as 'priority' | 'normal' | 'low',
  watermark: false,
};

// PASTE_PLAN_MODAL_FUNCTION

interface Props {
  toast: ToastFn;
}

export default function PurchasablePlansTab({ toast }: Props) {
  const [plans, setPlans] = useState<CreditPlan[]>([]);
  const [plansLoading, setPlansLoading] = useState(true);
  const [planModal, setPlanModal] = useState<{ open: boolean; plan: CreditPlan | null }>({
    open: false,
    plan: null,
  });
  const [confirmDelete, setConfirmDelete] = useState<CreditPlan | null>(null);
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    apiFetch<CreditPlan[]>('/admin/credit-plans')
      .then(setPlans)
      .catch((e) =>
        toast({
          kind: 'error',
          title: 'Failed to load credit plans',
          body: apiErrorMessage(e, 'Please try again.'),
        }),
      )
      .finally(() => setPlansLoading(false));
  }, [toast]);

  const handlePlanSaved = (saved: CreditPlan) => {
    setPlans((prev) => {
      const idx = prev.findIndex((p) => p.id === saved.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = saved;
        return next.sort((a, b) => a.sortOrder - b.sortOrder);
      }
      return [...prev, saved].sort((a, b) => a.sortOrder - b.sortOrder);
    });
  };

  const handleDelete = async () => {
    if (!confirmDelete) return;
    setDeleting(true);
    try {
      await apiFetch(`/admin/credit-plans/${confirmDelete.id}`, { method: 'DELETE' });
      setPlans((prev) => prev.filter((p) => p.id !== confirmDelete.id));
      toast({ title: `${confirmDelete.name} deleted` });
    } catch (err) {
      toast({
        kind: 'error',
        title: 'Failed to delete plan',
        body: apiErrorMessage(err, 'Please try again.'),
      });
    } finally {
      setDeleting(false);
      setConfirmDelete(null);
    }
  };

  const freePlan = plans.find((plan) => plan.slug === 'free') ?? null;
  const paidPlans = plans.filter((plan) => plan.slug !== 'free');

  return (
    <>
      {/* PASTE_CREDIT_PLANS_JSX */}

      {planModal.open && (
        <PlanModal
          plan={planModal.plan}
          onSaved={handlePlanSaved}
          onClose={() => setPlanModal({ open: false, plan: null })}
          toast={toast}
        />
      )}

      {confirmDelete && (
        <ConfirmModal
          title="Delete plan"
          body={`Are you sure you want to delete "${confirmDelete.name}"? This cannot be undone.`}
          what={`slug: ${confirmDelete.slug}`}
          danger
          confirmLabel={deleting ? 'Deleting…' : 'Delete'}
          onConfirm={handleDelete}
          onClose={() => setConfirmDelete(null)}
        />
      )}
    </>
  );
}
```

Now fill in the two placeholders:

1. `// PASTE_PLAN_MODAL_FUNCTION` — replace with the entire `PlanModal` function, cut verbatim from `apps/admin-web/src/pages/SettingsPage.tsx` (as it currently exists): starts at `function PlanModal({` and ends at its matching closing `}` (the block immediately before `const EMPTY_CAMPAIGN_FORM = {`). Its `toast` prop type is currently typed as `Props['toast']` (referring to `SettingsPage`'s own `Props` interface) — change that one type annotation to `ToastFn` (defined above in this new file). No other changes — every state variable, handler, and JSX line inside `PlanModal` stays identical.

2. `{/* PASTE_CREDIT_PLANS_JSX */}` — replace with the JSX cut verbatim from `SettingsPage.tsx`'s `credit-plans` section body: everything between `{section === 'credit-plans' && (` `<>` and its matching `</>` `)}` — i.e. the Free Signup Plan card and the Paid Credit Plans grid. No changes needed — this JSX already only references `plansLoading`, `freePlan`, `paidPlans`, `setPlanModal`, `paidPlans`, and `setConfirmDelete`, all of which exist identically in this new component.

- [ ] **Step 2: Remove the moved code from `SettingsPage.tsx`**

In `apps/admin-web/src/pages/SettingsPage.tsx`:

- Delete `EMPTY_FORM` (the constant right before `function PlanModal`).
- Delete the entire `PlanModal` function.
- Delete the state declarations: `plans`, `plansLoading`, `planModal`, `confirmDelete`, `deleting` (the `useState` calls for each).
- Delete the `useEffect` that fetches `/admin/credit-plans` into `plans`.
- Delete `handlePlanSaved` and `handleDelete`.
- Delete the `freePlan`/`paidPlans` derivation (`const freePlan = ...` / `const paidPlans = ...`).
- Delete the entire `{section === 'credit-plans' && (...)}` JSX block (this becomes Task 4's subview switcher instead).
- Delete the `{planModal.open && (<PlanModal .../>)}` and `{confirmDelete && (<ConfirmModal .../>)}` render blocks near the end of the file (just before the `campaignModal.open` block, which stays — that's for signup campaigns, unrelated).
- `ConfirmModal` import stays in `SettingsPage.tsx` — it's still used by the `confirmDeleteCampaign` block. `CreditPlan` import from `../types` is no longer used in `SettingsPage.tsx` after this — remove it from the `import type { CreditPlan, SignupCampaign } from '../types';` line, leaving `import type { SignupCampaign } from '../types';`.

- [ ] **Step 3: Typecheck / build**

Run: `pnpm --filter @tryme/admin build`
Expected: no errors (fix any newly-unused import/variable surfaced by this step's deletions)

- [ ] **Step 4: Commit**

```bash
git add apps/admin-web/src/pages/settings/PurchasablePlansTab.tsx apps/admin-web/src/pages/SettingsPage.tsx
git commit -m "refactor(admin): extract Purchasable Plans into its own settings subview"
```

---

### Task 4: Wire the 3 subviews into the Credit Plans tab

**Files:**
- Modify: `apps/admin-web/src/pages/SettingsPage.tsx`

**Interfaces:**
- Consumes: `PurchasablePlansTab` (Task 3), `JobCostsTab` (Task 1), `ShopifyCreditsTab` (Task 2), all from `./settings/*.tsx`.
- Produces: nothing consumed elsewhere — this is the integration point.

- [ ] **Step 1: Import the 3 new components**

In `apps/admin-web/src/pages/SettingsPage.tsx`, add near the top with the other imports:

```tsx
import JobCostsTab from './settings/JobCostsTab';
import PurchasablePlansTab from './settings/PurchasablePlansTab';
import ShopifyCreditsTab from './settings/ShopifyCreditsTab';
```

- [ ] **Step 2: Add subview state**

Inside `export default function SettingsPage(...)`, add near the top of the component body (alongside `const section = ...`):

```tsx
  const [creditSubTab, setCreditSubTab] = useState<'purchasable' | 'job-costs' | 'shopify'>(
    'purchasable',
  );
```

- [ ] **Step 3: Render the subview switcher**

Replace the (now-empty, per Task 3 Step 2) former `{section === 'credit-plans' && (...)}` location with:

```tsx
      {/* Credit Plans */}
      {section === 'credit-plans' && (
        <>
          <div className="tabs" style={{ marginBottom: 20 }}>
            {(
              [
                { k: 'purchasable', label: 'Purchasable Plans' },
                { k: 'job-costs', label: 'Job Costs' },
                { k: 'shopify', label: 'Shopify' },
              ] as const
            ).map((t) => (
              <button
                key={t.k}
                className={`tab ${creditSubTab === t.k ? 'active' : ''}`}
                onClick={() => setCreditSubTab(t.k)}
              >
                {t.label}
              </button>
            ))}
          </div>

          {creditSubTab === 'purchasable' && <PurchasablePlansTab toast={toast} />}
          {creditSubTab === 'job-costs' && <JobCostsTab toast={toast} />}
          {creditSubTab === 'shopify' && <ShopifyCreditsTab toast={toast} />}
        </>
      )}
```

- [ ] **Step 4: Typecheck / build**

Run: `pnpm --filter @tryme/admin build`
Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add apps/admin-web/src/pages/SettingsPage.tsx
git commit -m "feat(admin): add Credit Plans subview tabs (Purchasable Plans / Job Costs / Shopify)"
```

---

### Task 5: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Full build**

Run: `pnpm --filter @tryme/admin build`
Expected: no errors, bundle produced

- [ ] **Step 2: Manual check**

Run: `pnpm --filter @tryme/admin dev`, open Settings → System tab, confirm it now shows only Max Output Resolution, Max Batch Size, App Video, Upload Limits, and Merchant Catalogue Defaults (no credit widgets, no leftover validation referencing removed state). Open Settings → Credit Plans tab, confirm 3 subview buttons appear (Purchasable Plans / Job Costs / Shopify), each loads its own data, each has its own Save button, and Purchasable Plans' Add/Edit/Delete plan flow still works exactly as before.

- [ ] **Step 3: Grep for orphaned references**

Run: `grep -n "sysSaving\|sysLoading" apps/admin-web/src/pages/SettingsPage.tsx`
Expected: only hits inside the still-present System tab code (max output px, max batch jobs, app video, upload limits, merchant catalogue defaults) — no hits inside anything related to resolutions/tryon/saree/pixverse/shopify (those must all reference their own new local `loading`/`saving` state, not `sysLoading`/`sysSaving`).

No commit for this task — it's verification only. If Step 3 finds an orphaned reference, fix it as part of whichever earlier task's file it's in and amend that task's commit is not appropriate (per version-control conventions, create a new commit) — `git commit -m "fix(admin): remove orphaned sysSaving reference in <file>"`.

---

## Follow-up (not part of this plan)

- None — this is a pure UI reorganization with no deferred backend work.
