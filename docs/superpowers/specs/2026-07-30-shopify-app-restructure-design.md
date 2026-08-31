# Shopify App Restructure — Design

**Date:** 2026-07-30
**Branch:** `feat/shopify-app-refactor`
**Status:** approved, ready for implementation plan

---

## Context

`apps/shopify` (the embedded Shopify admin app, package `@tryme/shopify-admin`) is being
reshaped around a new GUI direction: six merchant-facing destinations — Dashboard, Manage,
Analytics, Widget Design, Settings, Support — replacing today's five.

The full target needs four subsystems that do not exist yet:

| Subsystem | Needs |
|---|---|
| Activation + saree routing | store-scoped selection lists (products/collections) for global on/off, exclusions, and saree |
| Analytics | event pipeline (button click → upload → generation → order), revenue attribution |
| Plans & limits | plan model, generation quota, monthly cap, per-user try-on limits, watermark tiers, retention windows |
| Widget Design | theme/behaviour/copy overrides plus a live preview |

**That is too large for one spec.** This document covers **spec 1 of 5**: the restructure.
It removes what is being retired, migrates the UI to Polaris, and establishes the navigation
and workflow-routing baseline the four subsystem specs build on. It introduces no new
merchant-facing subsystem of its own.

Each subsystem gets its own spec → plan → implementation cycle afterward.

---

## Decisions taken

| Question | Decision |
|---|---|
| Slicing | Restructure first, then one spec per subsystem |
| "Tab view → pages" | Adopt App Bridge `<ui-nav-menu>`; pages appear in Shopify admin's own sidebar |
| Disable Catalog Generate / Generated Images | Remove UI only; API routes, table and tests untouched |
| Funnels | Rules engine removed entirely; template registry kept as the workflow registry |
| Workflow routing | `is_default` flag on `shopify_funnel_templates` |
| Saree routing | Deferred to spec 2 — an explicit merchant-managed list in Manage, **not** Shopify tags |
| UI framework | Polaris, stock tokens, no brand overrides |
| Pages in this spec | Only those backed by real data: Dashboard, Manage, Support. The other three arrive with their subsystems |
| Dashboard | Merge-and-grow: keep the setup checklist, add metrics as subsystems land |

### Why saree routing is not tag-based

Shopify tags are entered by hand during product creation and management, so they cannot be
relied on to be present or consistent. Spec 2 instead gives Manage an explicit saree list,
built on the same primitive as the exclusion list: a store-scoped selection of products or
collections. Until then every product resolves the default workflow.

---

## Scope

### Removed

Pages, their routes, their nav entries, and the components only they use:

- `pages/CatalogGeneratePage.tsx`, `pages/GeneratedImagesPage.tsx`, `components/CatalogJobThumb.tsx`
- `pages/FunnelSetupPage.tsx`
- `theme.ts`, `theme.css`, `components/icons.tsx`, `components/PageHeader.tsx`,
  `components/AppShell.tsx`, `components/Toast.tsx`, `lib/useToast.ts` — all superseded by Polaris

### Untouched

`catalog.routes.ts`, `catalog-options.routes.ts`, `catalog-publish.ts`, `shopify_catalog_jobs`,
and `shopify-catalog-generate.test.ts` / `shopify-catalog-jobs.test.ts` /
`shopify-catalog-publish.test.ts` / `shopify-catalog-options.test.ts` all stay registered and
passing. Removing the merchant UI does not require retiring the API behind it, and keeping it
makes the change reversible.

`shopify_funnel_rules`, `shopifyProductGarments.funnelTemplateId` and
`shopifyProductGarments.funnelAssignmentSource` are left in place but no longer read. Spec 2
decides their fate once the saree list is proven. No drop migration in this spec.

### Rebuilt in Polaris

Dashboard, Manage, and a new Support page.

**Manage in this spec is today's Products page, renamed** — product list, search, status
filter, enable toggle, sync — minus the funnel dropdown and the "No funnel" filter. The global
activation switch, collection targeting, exclusions and the saree list described in the GUI
document are spec 2; this spec does not build them.

The route moves `/products` → `/manage`. `/products` redirects to `/manage` so an existing
merchant bookmark still resolves, and the in-page link at `DashboardPage.tsx:723-726` is
updated to point at the new path directly.

### Nav

`<ui-nav-menu>` with three entries: Dashboard, Manage, Support. Analytics, Widget Design and
Settings are added to the nav by their own specs, when each has something to show. Merchants
never see a dead link.

### Relationship to commit `c914dfc7`

That commit built funnel-mapping visibility — rule matching, mapped/unmapped counts, a
"No funnel" filter. Removing funnels makes most of it dead code, and this spec deletes it.

**One behaviour from it must survive:** a product with no resolvable workflow is refused at
job creation, before credits are deducted, rather than enqueueing and failing in the
dispatcher with `NO_WORKFLOW_CONFIGURED`. The check and its log stay; only what they test
changes — the store default instead of the funnel chain.

---

## Architecture

### Shell

A new `components/AppNavMenu.tsx` renders App Bridge's `<ui-nav-menu>` with plain anchors.

- Hrefs carry the router basename — `/shopify-admin` in prod, `/` in dev (`main.tsx:6`).
- A click handler routes through react-router so the iframe never does a full document load.
- `components/AppShell.tsx` is deleted. Layout comes from Polaris `Frame` plus a per-page `Page`.

`window.shopify` is undefined outside the admin iframe (`lib/appBridge.ts:33`), so
`<ui-nav-menu>` renders nothing in local dev. Gate on that: App Bridge present →
`<ui-nav-menu>` only; absent → a dev-only Polaris `Navigation` inside the `Frame`. Never both.

### Component mapping

| Today | Polaris |
|---|---|
| `AppShell` pill bar | `<ui-nav-menu>` + `Frame` |
| `PageHeader` | `Page` (`backAction`, `title`, `subtitle`, `primaryAction`) |
| `Toast` + `useToast` | `Frame` + Polaris `Toast` |
| Dashboard `StepRow` checklist | `Card` + `ResourceList`, `Badge` for done state |
| Dashboard stat cards | `InlineGrid` of `Card` + `Text` |
| Sync-status dots (`pulseDot` keyframes) | `Badge` with tone (`success`/`attention`/`critical`/`info`) |
| Disconnect confirm (hand-rolled backdrop, ~90 lines) | `Modal` — also removes the a11y suppressions at `DashboardPage.tsx:762,778` |
| Products search + status `<select>` | `IndexFilters` |
| Product rows + enabled toggle | `IndexTable` + `Badge` + `Button` |
| `ProductPickerGrid`, `ImagePickerModal` | `ResourceList` / `Modal` |
| `icons.tsx` (262 lines of hand-drawn SVG) | `@shopify/polaris-icons` — **new dependency** |
| `theme.ts`, `theme.css` | deleted (stock Polaris) |

`@shopify/polaris` v13.9.5 is already a dependency. `@shopify/polaris-icons` is not and must
be added.

Styling is stock Polaris with no `--p-*` overrides, so the app matches native Shopify admin
surfaces exactly.

### Files after this spec

```
apps/shopify/src/
  App.tsx
  main.tsx
  components/AppNavMenu.tsx
  components/LinkAccountGate.tsx     (Polaris rewrite)
  pages/DashboardPage.tsx
  pages/ManagePage.tsx                (was ProductsPage.tsx)
  pages/SupportPage.tsx
  lib/api.ts
  lib/appBridge.ts
  types.ts
```

Everything else is deleted.

### Dashboard consequence

The onboarding checklist drops from four steps to three — synced, enabled, theme block. The
funnel step and the "Funnel Mapped" stat card both go, along with `funnelCounts` from
`/v1/shopify/me`.

---

## Data flow

### Workflow resolution

```
before  garment.funnelTemplateId → funnel_templates.workflowTemplateId
        else store.settings.workflowTemplateId          (never written)

after   funnel_templates WHERE is_default → workflowTemplateId
        (spec 2 inserts the saree-list check above this)
```

`settings.workflowTemplateId` is dead weight: the only write to `shopify_stores.settings`
anywhere in the codebase is `themeBlockConfirmed` (`onboarding.routes.ts:46`), and no admin
route touches `shopify_stores` at all. Falling back to it would leave every store unroutable.

`shopify_funnel_templates` is already an admin-curated registry of named workflow bindings
(`admin/shopify-funnels.routes.ts`), which is exactly the "two workflows" model — saree and
everything-else. It is kept and given a default flag.

Resolution happens once, in the API, at job creation, and is pinned onto
`job_inputs.params.workflowTemplateId`. The dispatcher then trusts it, matching the existing
invariant that the API resolves and the dispatcher consumes.

### API changes

| Endpoint | Change |
|---|---|
| `GET /v1/shopify/me` | Drop `funnelCounts` and `funnelConfigured` |
| `GET /v1/shopify/funnel-templates` | Deleted |
| `PUT /v1/shopify/funnel-templates/:id/rule` | Deleted |
| `POST /v1/shopify/funnel-templates/re-run` | Deleted |
| `PATCH /v1/shopify/products/:id/funnel` | Deleted |
| `GET /v1/shopify/products` | Drop `funnelTemplateId`, `funnelAssignmentSource` from items |
| `POST /v1/shopify/customer/jobs` | `resolveWorkflowTemplateId` reads the `is_default` template; create-time refusal and log stay |

`funnel.routes.ts`, `funnel-rules.ts` and `funnel-rules.test.ts` are deleted, and `routes.ts:26`
unregisters `shopifyFunnelRoutes`.

### Dispatcher

`processShopifyJob` (`apps/dispatcher/src/job/processor.ts:1834-1849`) drops the
`garmentRow.funnelTemplateId` → `shopifyFunnelTemplates` lookup and reads
`params.workflowTemplateId` only. Terminal failure if absent, as today.

### Admin

`admin/shopify-funnels.routes.ts` stays and gains `isDefault` on create and update, plus a
guard rejecting an attempt to clear the last default. `admin/workflows.routes.ts:748` — which
blocks deleting a workflow template still referenced by a funnel template — is unaffected.

The admin funnels list gains a banner when no default is set, since nothing else reveals that
state until a shopper hits it.

### Migration

One migration on `shopify_funnel_templates`:

- `is_default boolean not null default false`
- `CREATE UNIQUE INDEX ... ON shopify_funnel_templates (is_default) WHERE is_default` — makes
  two defaults impossible
- backfill sets it on the lowest-`sortOrder` active row

### Deploy ordering

Migration → API → dispatcher. A dispatcher that has dropped the funnel lookup, paired with an
old API that does not pin `params.workflowTemplateId`, fails every Shopify job. Reverse the
order on rollback.

### Frontend types

`types.ts` drops `ShopifyFunnelCounts`, `FunnelRule`, `FunnelRuleCondition`,
`FunnelTemplateItem`, and the funnel fields on `ShopifyProductListItem`. `CatalogOptions` and
`CatalogGenerateJob` go with the catalog pages.

---

## Error handling

The create-time refusal in `customer.routes.ts` stays, but its meaning changes. Today an
unresolvable workflow is a *merchant* configuration gap. Afterward it can only mean no
`is_default` row exists — a *system* misconfiguration the merchant cannot fix.

- Log level goes `warn` → `error`, with `storeId` / `shopifyProductId` / `garmentId`.
- The shopper still gets the same soft 202 "not available for try-on right now". No internal
  state leaks to the storefront.
- Credits are still not deducted and no `FAILED` job row is written. This is the behaviour
  `c914dfc7` bought and it must not regress.

Two failure modes the migration can produce, both handled rather than assumed away:

- **Zero active templates at backfill** → nothing receives `is_default`. Surfaced by the admin
  banner described above.
- **Admin clears the last default** → rejected at the route with a 4xx, not silently allowed.

App Bridge failure handling carries over verbatim: `lib/appBridge.ts` is untouched, and the
one-shot recovery reload in `App.tsx:41-44` survives the Polaris rewrite. Page-level load
failures keep the existing `Banner` plus full-reload retry, restyled to Polaris.

---

## Testing

API changes are test-driven: write the failing test first, then the change.

| File | Action |
|---|---|
| `src/modules/shopify/funnel-rules.test.ts` | delete |
| `test/shopify-funnel-routes.test.ts` | delete |
| `test/shopify-me.test.ts` | drop `funnelCounts` / `funnelConfigured` assertions |
| `test/integration/shopify-customer.test.ts` | rewrite resolution cases against `is_default` |
| `test/shopify-products.test.ts` | drop funnel fields from list assertions |
| `test/shopify-funnel-templates-admin.test.ts` | add `isDefault` set/clear and last-default guard |
| catalog tests (4), oauth, sync, webhooks, token, cors, crypto, service, metafields, onboarding, store-account-link | untouched, must stay green |

New cases:

- default template resolves → job enqueued with `params.workflowTemplateId` set to it
- no `is_default` row → 202 refusal, **credit balance unchanged**, no job row
- partial unique index rejects a second default
- backfill picks the lowest-`sortOrder` active row

Integration tests live under `test/integration/**`, which `vitest.config.ts` excludes; they run
via `vitest.integration.config.ts`. `pnpm docker:up` must be running first.

### Frontend

`apps/shopify` has no test files today and this spec does not add a harness. The rewrite is
presentational — the logic it exercises lives in the API and is covered above. Verification is
`pnpm --filter @tryme/shopify-admin typecheck` plus a manual smoke in a real embedded admin:
nav renders, three pages load, disconnect modal works, product enable toggle works, sync works.

Subsystem specs that introduce real client-side logic should revisit this.

**Not covered by any automated test:** that `<ui-nav-menu>` actually renders in Shopify's
sidebar. It only works inside the real admin iframe, so it is a manual check on a dev store.

---

## Follow-on specs

1. **Activation + saree routing** — store-scoped selection lists; global activation, exclusions,
   saree. Decides the fate of `shopify_funnel_rules` and the unused garment columns.
2. **Analytics** — event pipeline and order attribution; adds the Analytics page and grows the
   Dashboard toward the metrics view.
3. **Plans & limits** — plan model, quota, caps, watermark tiers, retention.
4. **Widget Design** — theme, behaviour and copy overrides with live preview.

Settings spans 2–4 and is specced alongside whichever lands its first tab.
