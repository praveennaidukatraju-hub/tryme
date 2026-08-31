# Credit Plans subview tabs — design spec

## Context

`apps/admin-web/src/pages/SettingsPage.tsx` (2297 lines) has a top-level tab
bar (`SETTING_SECTIONS`) with 6 tabs. Two of them are relevant here:

- **Credit Plans** (`credit-plans`, lines ~1079–1387) — shows the read-only
  Free Signup Plan card plus a Paid Credit Plans CRUD grid (add/edit/delete
  via `PlanModal` + `ConfirmModal`). This is the `credit_plans` DB table —
  purchasable plans a user buys.
- **System** (`system`, lines ~1495–2230) — an overloaded catch-all mixing 6
  distinct per-operation/per-plan credit-cost widgets (Resolution Pricing,
  Virtual Try-On, Dev API Saree Mannequin, Catalog Video/PixVerse, Shopify
  Free Trial, Shopify Plan Credits) with 5 unrelated config widgets (Max
  Output Resolution, Max Batch Size, App Video, Upload Limits, Merchant
  Catalogue Defaults), all sharing one `useEffect` fetch, one
  `saveSysConfig` PATCH, and one Save button.

These two concepts — purchasable plans vs. per-action cost config — are both
"credit-related" but live in physically separate tabs today, with the cost
config oddly buried inside a tab named "System" alongside things that have
nothing to do with credits. All 6 credit-cost values were made
admin-configurable incrementally in prior sessions (trial credits, then
per-plan Shopify credits), each landing in System because that's where
`tryon.creditCost` etc. already lived — the tab was never reorganized to
match.

## Goals

- Group everything credit-related under the existing "Credit Plans" top-level
  tab, as 3 subview tabs: **Purchasable Plans**, **Job Costs**, **Shopify**.
- Each subview independently fetches and independently saves — no shared
  Save button spanning unrelated concerns (today's biggest pain point: a
  System-tab save silently re-saves upload limits when you only meant to
  change a credit cost, or vice versa).
- Leave System with only what's actually systemic: Max Output Resolution,
  Max Batch Size, App Video, Upload Limits, Merchant Catalogue Defaults.
- No visual/behavioral change to any individual widget — same labels, same
  inputs, same min/max, same descriptions. This is a structural move, not a
  redesign.

## Non-goals

- No backend change. `GET`/`PATCH /admin/config` already return/accept the
  full `config:system` shape or any partial subset of it — nothing there
  needs to change for this to work.
- No new persistence concept — this is not introducing a "credit plans"
  backend grouping, just a frontend IA change. `config:system` stays one
  flat Redis JSON blob; only how the admin-web page reads/writes slices of
  it changes.
- No change to `PlanModal`'s behavior, the `credit_plans` CRUD API, or any
  DB schema.

## Design

### Subview 1 — Purchasable Plans

Exactly today's `credit-plans` tab content (Free Signup Plan card + Paid
Credit Plans grid + `PlanModal` add/edit + `ConfirmModal` delete), moved
verbatim into a new self-contained component
`apps/admin-web/src/pages/settings/PurchasablePlansTab.tsx`. Owns its own
`plans`/`plansLoading`/`planModal`/`confirmDelete`/`deleting` state, its own
`GET /admin/credit-plans` fetch, and its own delete handler — none of this
needs to change since it was already independent of the System-tab state;
it's purely being relocated into its own file and rendered as the default
subview instead of the whole tab's content.

### Subview 2 — Job Costs

Resolution Pricing, Virtual Try-On, Dev API — Saree Mannequin, and Catalog
Video (PixVerse) — the 4 "cost per generation" widgets, moved verbatim into
`apps/admin-web/src/pages/settings/JobCostsTab.tsx`. Own state
(`resolutions`, `tryonCreditCost`, `sareeMannequinDevCreditCost`,
`pixverseCreditCost`), own `GET /admin/config` fetch (reading only these 4
fields off the response), own `PATCH /admin/config` save sending only
`{ resolutions, tryon, sareeMannequinDev, pixverse }`.

### Subview 3 — Shopify

Shopify Free Trial (trial credits) and Shopify Plan Credits (starter/growth/
pro), moved verbatim into
`apps/admin-web/src/pages/settings/ShopifyCreditsTab.tsx`. Own state
(`shopifyTrialCredits`, `shopifyPlanCredits`), own fetch (reading only
`shopify.*`), own save sending only `{ shopify: { trialCredits,
planCredits } }`. Keeps the same client-side Save-button validation these
fields already had in System (integer bounds on trial credits and each plan
handle).

### System tab — what's left

Max Output Resolution, Max Batch Size, App Video, Upload Limits, Merchant
Catalogue Defaults stay exactly where they are, in `SettingsPage.tsx`
itself (not extracted — out of scope for this pass; only the credit-related
widgets move). `saveSysConfig`'s PATCH body and the Save button's
`disabled` validation both drop every field that moved to the two new
subviews.

### Subview switcher

A small local-state tab bar (`creditSubTab`, one of `'purchasable' |
'job-costs' | 'shopify'`, default `'purchasable'`) rendered inside the
existing `{section === 'credit-plans' && (...)}` block, reusing the same
`.tabs`/`.tab` CSS classes the top-level `SETTING_SECTIONS` bar already
uses. Not URL-synced (no new search param) — matches the lighter pattern
`apps/admin-web/src/pages/AssetsPage.tsx` already uses for its own
sub-tabs, rather than adding a second URL param alongside the existing
`?s=`.

### File organization

New directory `apps/admin-web/src/pages/settings/`, one file per subview,
mirroring the existing `apps/admin-web/src/pages/assets/` split (that page
already extracts each of its tabs into its own file — `SettingsPage.tsx` is
the one page that never got this treatment, growing to 2297 lines as a
result). `SettingsPage.tsx` shrinks by roughly 900 lines once the 3 new
files absorb the extracted state, effects, handlers, and JSX.

## Testing

No test suite exists for `apps/admin-web` in this repo. Verification is
`pnpm --filter @tryme/admin build` (typecheck + bundle) after each
extraction, plus a manual dev-server pass at the end confirming: System
tab shows only the 5 remaining widgets, Credit Plans tab shows 3 working
subviews each with independent load/save, and the Purchasable Plans
add/edit/delete flow is unchanged.

## Open follow-up (not part of this spec)

- None identified. This is a self-contained frontend reorganization.
