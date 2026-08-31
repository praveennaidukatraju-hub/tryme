# Shopify Embedded Admin — Structural Restyle (Phase 2) — Design

## Context

The brand restyle plan (`docs/superpowers/specs/2026-07-10-shopify-admin-restyle-design.md`, implemented and merged on `feat/shopify-tryon-backend`) deliberately applied color-only theming via Polaris CSS custom-property overrides, per the user's explicit scoping at the time ("just a UI upgrade, don't follow the HTML hard, just follow the theme"). The result: brand pink/amber colors are live, but the page *structure* — card layout, table chrome, status badges, the link gate — is still 95% default Polaris arrangement, not the mock's actual layout.

The user has now asked to go further: bring the real Dashboard, Products, and link-gate screens structurally closer to the mock (`TryMe Shopify Admin Dashboard/TryMe Admin.dc.html`), not just color.

## Goal

Restructure Dashboard, Products, and the link gate to match the mock's actual layout (2-column dashboard grid with accent-bar credit card and dot-badge sync status, compact flex-row product table with dot+pill badges, vertically-centered link gate) while preserving every existing real feature and its behavior exactly (onboarding checklist, funnel-assignment dropdown, image picker, product-attribute funnel-rule engine, popup-based account-link flow). Funnel Setup's page itself needs no structural work (it's forms, not a table/grid) and stays exactly as the brand-restyle plan left it; its shopper-segment-routing concept in the mock remains explicitly out of scope, as already decided in the prior plan.

## Approach

**Principle: replace a Polaris component only where its own DOM/behavior genuinely cannot produce the mock's layout. Everywhere else, extend the existing brand-theme CSS (`apps/shopify/src/theme.css`) with shape tokens, or compose custom markup as children inside the existing Polaris components.**

This was chosen over two alternatives considered:
- *Polaris-only, token-restyle everywhere*: safer/less code, but literally cannot reproduce a 2-column accent-bar card, a dot+pill badge, a compact non-selectable table row, or a vertically-centered gate — these are DOM-shape differences a CSS variable can't close.
- *Full custom markup rebuild of every screen*: highest fidelity but throws away Polaris's accessibility/behavior everywhere, including the many spots (forms, selects, banners) where Polaris already matches the mock's intent closely enough that a rebuild would be pure risk for no visual gain.

The chosen middle path: two real component swaps (`IndexTable` → custom table on Products, `Page` chrome → custom centered layout on the link gate), and everywhere else, either token-level CSS or custom JSX composed as children inside the Polaris components already in place (which is always legal — `Card` just renders its children).

## Verified facts this design depends on

- Polaris (`@shopify/polaris@13.9.5`) exposes shape tokens (`--p-border-radius-*`, `--p-shadow-*`) as CSS custom properties the same way it exposes color tokens (`--p-color-bg-fill-brand`, etc., already overridden in `theme.css` by the prior plan) — confirmed by the same mechanism already proven working for color: a later `:root {...}` rule wins by source order.
- `Card`, `Page`, `Badge`, `IndexTable` accept **no** `className`/`style` prop (confirmed for `Button` in the prior plan via the installed package's `.d.ts` files; the same constraint holds across Polaris's component family — none of them expose a style-escape-hatch prop). This is why token overrides (not prop passthrough) are the mechanism for anything staying inside a Polaris component, and why children-composition (not prop injection) is the mechanism for custom markup living inside one.
- `IndexTable`'s `useIndexResourceState`/`selectedItemsCount` wiring on the Products page is not connected to any actual bulk-select UI today (no checkbox column is rendered, no bulk-action bar exists) — confirmed during the brand-restyle plan's Task 4 review. Dropping `IndexTable` for a custom table loses no real, currently-used functionality.
- Polaris's own semantic color tokens for success/attention/critical/subdued (already used via `STATUS_TONE`'s Badge `tone` prop on the Products page) are reused for the new dot-badge colors, rather than copying the mock's literal `oklch(...)` values — keeping the restyle inside the existing design system rather than introducing a second, parallel color palette. This is an explicit deviation from the mock's literal colors, made deliberately: the global constraint from the prior plan ("do not invent new colors, reuse the exact brand hex values") is about the pink/amber *brand* accent specifically, not the mock's separate green/amber/red/gray status semantics, which already have a system-consistent equivalent in place.
- Polaris's `Page` component accepts a `subtitle` prop (in addition to `title`) — confirmed via `apps/shopify/src/pages/DashboardPage.tsx`'s and `ProductsPage.tsx`'s current `<Page title="...">` usage and the installed package's props; using it gets the mock's title+domain pairing for free, without dropping `Page`.
- `InlineGrid` exists in this Polaris version (`build/ts/src/components/InlineGrid/InlineGrid.d.ts`) but its `columns` prop doesn't cleanly express the mock's uneven `1.1fr 1fr` ratio — a plain CSS grid `div` (matching the existing codebase pattern already used for the search/filter row in `ProductsPage.tsx`) is used instead for exact control, not `InlineGrid`.
- `Card`'s actual implementation (`build/esm/components/Card/Card.js`) renders via `<ShadowBevel boxShadow="100" borderRadius="300"><Box .../></ShadowBevel>` — i.e. it reads exactly the `--p-shadow-100` and `--p-border-radius-300` custom properties, confirmed by reading the component source directly (not inferred). These are the two tokens `theme.css` overrides; no other token names are involved for `Card`'s shape.

## Per-screen changes

### Nav (`AppShell.tsx`)
Add the shop domain, right-aligned, matching the mock's nav bar (currently the custom nav shows only the logo mark + 3 tabs, missing the domain the mock displays on the right). Small addition to the existing non-Polaris custom nav; no other change.

### Theme shape tokens (`theme.css`)
Add `--p-border-radius-300` and `--p-shadow-100` overrides, matching the mock's `border-radius: 8-10px` / `box-shadow: 0 0 0 1px rgba(0,0,0,.06)` card treatment — these are the exact two tokens `Card` reads (confirmed directly from `Card.js`'s source, see Verified Facts). This is additive to the existing color-token block from the prior plan, same file, same mechanism.

### Dashboard (`DashboardPage.tsx`)
- `<Page title="Home" subtitle={me?.store.shopDomain}>` — title changes from "TryMe Try-On" to "Home" to match the mock; domain moves from the Store card into the page subtitle (removed from its old spot in the Store card, see below).
- Getting Started checklist: unchanged logic and unchanged Polaris `Card`, inherits the new shape tokens automatically.
- The 3 stat cards (Try-Ons / Products Synced / Products Enabled — real data the mock doesn't have): kept as their own row, unchanged logic, inherits new shape tokens.
- The existing separate "Product sync status" `Card` and "Credit Balance" `Card` (both currently full-width, stacked) are replaced by a two-column CSS grid row (`display: grid; grid-template-columns: 1.1fr 1fr; gap: 16px`) containing:
  - **Credit Balance card**: existing `Card` + `BlockStack`, with a new plain `<div>` child absolutely positioned at the top (`position: absolute; top:0; left:0; right:0; height:3px; background: var brand gradient`) as a decorative accent bar — the `Card` itself needs `position: relative` inline (allowed — this is a plain style prop on a plain wrapping div if `Card` doesn't accept `style` directly; a `Card` always renders inside normal flow so a wrapping `<div style={{position:'relative'}}>` around it is sufficient and needs no Polaris API access). Credit number and "Top up" button unchanged.
  - **Product sync status card**: same `Card`, but each of the 4 rows (Active/Processing/Failed/Disabled) gains a small colored dot (`<span>` circle, 8px, background from the same success/attention/critical/subdued color mapping as `STATUS_TONE`) before the label, matching the mock's dot+label+count row.
- Store card: changed from a vertical `BlockStack` (domain heading, then "Manage Products" button) to a horizontal flex row — domain + "Manage Products" button grouped on the left, "Connected since" text on the right (`justify-content: space-between`). The domain heading itself is removed from here since it now lives in the page subtitle — this card becomes purely about the "since" fact + the manage-products action.

### Products (`ProductsPage.tsx`)
- `<Page title="Products" subtitle="Manage which products show the TryMe try-on widget.">` — mock has this subtitle line, currently missing; uses the `subtitle` prop rather than a separate `Text` element.
- Search `TextField` + status `Select` row: unchanged component choice, inherits new shape tokens for border-radius.
- **`IndexTable` replaced with a custom flex-based table**: a header row (`Image | Title | Status | Try-on enabled | Funnel` — the app's real 5 columns, since the mock's simpler 3-column table doesn't cover the real feature set) styled as a thin-bordered flex row matching the mock's header treatment (`border-bottom: 1px solid`, subdued gray label text, `font-weight:600`), followed by body rows in the same flex-row style (`border-bottom: 1px solid` between rows, consistent padding) replacing `IndexTable.Row`/`IndexTable.Cell`. `useIndexResourceState` and `selectedItemsCount` are removed along with `IndexTable` since nothing consumes them (confirmed unused, see Verified Facts).
- **`Badge` replaced with a custom dot+pill `<span>`**: matches the mock's `badge with a small colored dot + label` treatment, using the same 4-way color mapping (active/processing/failed/disabled) already expressed via `STATUS_TONE`, translated from Polaris tone names to explicit background/text/dot colors read from Polaris's own semantic tokens (e.g. `var(--p-color-bg-fill-success-secondary)` / `var(--p-color-text-success)` and the `critical`/`caution`/`neutral` equivalents) rather than new hardcoded hex — keeps the badge colors theme-aware and consistent with the rest of the app.
- `Thumbnail`, the "Change image" button, the enabled-checkbox, and the funnel `<select>` stay exactly as they are today (same components, same handlers) — only their surrounding row markup changes from `IndexTable.Cell` to a plain flex cell `<div>`.
- All existing logic (`toggleEnabled`, `selectImage`, `setFunnel`, `load`, `filteredItems`, `displayStatus`) is unchanged — this task only changes what wraps that logic in JSX, not what it does.

### Link gate (`LinkAccountGate.tsx`)
- `Page` (with its top-anchored title bar) is dropped for this one screen — replaced with a full-viewport-height, vertically-and-horizontally-centered flex container (`min-height: 100vh; display:flex; align-items:center; justify-content:center`) holding a custom card: icon block (same gradient-square treatment already used in the nav logo mark), a heading, the existing description text, the existing `Banner` on error, and the existing brand-primary `Button` — unchanged content and behavior, only the surrounding container/card markup changes from Polaris `Page`+`Card` to a custom centered div, since `Page` structurally cannot produce a vertically-centered, non-full-width gate screen.
- `openLinkPopup()` and the link-confirmation flow are entirely untouched.

### Funnel Setup (`FunnelSetupPage.tsx`)
No changes in this pass. It's forms (Card + Select + TextField + Button), not a grid or table, so there's no structural mismatch worth solving — it already inherits the broadened shape tokens (task above) automatically, same as the Getting Started checklist. Its shopper-segment-routing concept from the mock remains out of scope, as already decided in the prior plan.

## Testing

- No behavior changes to verify via automated test in this pass — every data-fetching function, PATCH call, and state transition is unchanged; only the JSX wrapping it changes. This matches the established pattern (no `.test.tsx` files exist for `apps/shopify` pages).
- Manual verification via `pnpm --filter @tryme/shopify-admin dev` against a real embedded-admin session: Dashboard's 2-column grid renders correctly and the accent bar/dots show real data; Products' custom table shows all 5 columns with working search/filter/toggle/funnel-select/image-picker exactly as before; the link gate centers correctly and its Link Account flow still completes; Funnel Setup is visually unchanged apart from inherited shape-token polish.
- `cd apps/shopify && npx tsc -b` must be clean after each task, matching the prior plan's constraint.

## Out of scope

- Everything the prior plan already scoped out (shopper-segment/checkout-variant funnel routing, a distinct account-linked-at timestamp, Shopify-native billing, `apps/admin-mobile`, pixel-matching the mock's literal markup) remains out of scope here too.
- Funnel Setup's own screen — no structural work planned, per above.
- Any change to the mock's literal HTML/inline-style values (colors, exact pixel spacing) is a loose reference only, same standing instruction as the prior plan: the goal is matching the mock's *layout and structural language*, not byte-for-byte markup replication.
