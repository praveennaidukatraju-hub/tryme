# Shopify Widget Design — Design

**Date:** 2026-07-31
**Status:** Approved
**Depends on:** `docs/superpowers/plans/2026-07-31-shopify-shopper-limits.md` (Tasks 6 and 7 in particular)

---

## Problem

Everything a merchant can change about the try-on widget lives in the Shopify
theme editor's app-embed panel — a cramped sidebar with seven settings, no
preview, and no access to the modal's copy. All modal text ("Ready to try it
on?", "See how it looks on you", the legal line, the empty-history message) is
hardcoded in `tryon-block.liquid` and cannot be changed at all.

Separately, the widget is delivered as an **app embed** (`target: "body"`),
which Shopify injects at the end of `<body>` on every page. The button then has
to relocate itself into the product form using a chain of guessed CSS
selectors. That guessing is the app's single largest source of placement bugs:
it breaks whenever a merchant switches themes, and the merchant's only recourse
is to hand-write a CSS selector into a text field.

## Goals

1. Move the try-on **button** from an app embed to an **app block** the merchant
   drags into the product template. Placement stops being guesswork.
2. Give merchants a **Widget Design** page in the embedded app that controls the
   try-on **modal** — accent color, all copy, and the result-step actions — with
   a live, pixel-accurate preview.
3. Add **Add to Cart** and **Share** actions to the result step.

## Non-Goals

- **Show remaining try-ons.** Requires a shopper-limits read endpoint that
  resolves counting identity and returns remaining quota *before* generation.
  Today the limit check runs only server-side at job creation. Deferred to its
  own spec.
- **Vintage (non-OS-2.0) theme support.** App blocks require JSON templates.
  Dropping the embed drops vintage themes. Accepted: the app has no installs
  beyond a dev store, so nothing breaks, and keeping a second render path to
  serve vintage themes costs a duplicate Liquid file, a shared-snippet
  extraction, and a runtime dedupe guard.
- **Staged draft/publish.** Save writes live. Nobody asked to stage copy.
- **Per-locale copy.** One set of strings, written by the merchant in their own
  language.
- **Button design in the app.** The button stays configured in the theme editor,
  as block settings. This page owns the modal only.

## Division of Responsibility

| Surface | Owns |
|---|---|
| Theme editor (app block settings) | Button — text, colors, radius, promo line, and placement by drag |
| Widget Design page (this spec) | Modal — accent color, all copy, result-step actions |

---

## 1. Data Model and Config Delivery

Config lives in the existing `shopify_stores.settings` jsonb column. **No
migration.**

```ts
// packages/db/src/schema/shopify.ts

export interface ShopifyWidgetTheme {
  /** Hex (#rrggbb). Drives modal CTA, step dots, choose-photo button, retry. */
  accentColor?: string | null;
}

export interface ShopifyWidgetCopy {
  heading?: string | null;
  subheading?: string | null;
  uploadTitle?: string | null;
  uploadLead?: string | null;
  chooseLabel?: string | null;
  ctaLabel?: string | null;
  legalText?: string | null;
  generatingText?: string | null;
  errorText?: string | null;
}

export interface ShopifyWidgetBehavior {
  addToCart?: boolean;
  addToCartLabel?: string | null;
  share?: boolean;
  shareLabel?: string | null;
}

export interface ShopifyWidgetConfig {
  theme?: ShopifyWidgetTheme;
  copy?: ShopifyWidgetCopy;
  behavior?: ShopifyWidgetBehavior;
}

// ShopifyStoreSettings gains:
//   widget?: ShopifyWidgetConfig;
```

### Delivery: shop metafield

On save the API writes `settings.widget` to Postgres, then mirrors the whole
`ShopifyWidgetConfig` object to a shop metafield:

```
namespace: tryme
key:       widget_config
type:      json
```

This extends `apps/api/src/modules/shopify/metafields.ts`, which already writes
`tryme.widget_key` through the identical `POST /metafields.json` path. Same
code path means **identical scope requirements** — no scope change, no merchant
re-consent. (`shopify.app.toml` requests only `read_products,write_products`,
and the Liquid gate `widget_key != blank` means the widget would not render at
all if that existing write were failing.)

Liquid reads it server-side:

```liquid
{%- assign cfg = shop.metafields.tryme.widget_config.value -%}
<p class="tryme-tryon__heading">{{ cfg.copy.heading | default: 'Try It On' | escape }}</p>
```

Chosen over a client-side config fetch because it costs nothing per page view
and produces no flash of default copy. Liquid returns nil for property access on
nil, so an absent metafield safely falls through every `| default:`.

### Divergence between Postgres and the metafield

The DB write and the Admin API write cannot be one transaction. **Postgres is
authoritative; the metafield is a cache.**

`PATCH` returns `{ widget, synced: boolean }`. A failed metafield write returns
`synced: false` with **HTTP 200** — the save genuinely succeeded, and a 5xx would
wrongly tell the merchant to retype everything. The page then shows a warning
banner whose Retry hits `POST /v1/shopify/widget-config/republish`, which reads
the row and pushes the metafield only (idempotent, no DB write).

### Defaults live in one place

Default strings would otherwise exist three times — Liquid `| default:`, the
React preview, and the form placeholders. They are defined once as
`WIDGET_COPY_DEFAULTS` in `packages/types/src/widget.ts`. React imports it. A
test parses `tryon-button.liquid` and fails if any `| default:` string disagrees.

| Field | Default |
|---|---|
| `heading` | `Try It On` |
| `subheading` | `See how it looks on you` |
| `uploadTitle` | `Ready to try it on?` |
| `uploadLead` | `Upload your photo and see how it looks on you instantly` |
| `chooseLabel` | `Choose Your Photo` |
| `ctaLabel` | `Try It On Now` |
| `legalText` | `By using this service, you agree to our Terms and Privacy Policy.` |
| `generatingText` | `Generating your try-on...` |
| `errorText` | `Something went wrong. Please try again.` |
| `addToCartLabel` | `Add to Cart` |
| `shareLabel` | `Share` |

**Consolidation:** today the upload step and the ready step carry two different
legal sentences (`tryon-block.liquid:97-100` and `:111-115`). They collapse into
one `legalText` rendered on both. The literal `<br />AI can make mistakes.`
stays as markup outside the variable.

`ctaLabel`'s current value is derived — `{{ button_text }} Now`. It becomes an
independent field, because the modal CTA and the storefront button are now
configured on different surfaces.

Strings staying hardcoded or in `locales/en.default.json`, not configurable:
`tryon.pending`, `tryon.result_alt` (alt text), `tryon.try_again`, and the
empty-history line. Every configurable field must have a preview surface (see
§4); the empty-history state is by definition never populated in a preview, and
it is not worth a tab of its own.

---

## 2. Extension Rewrite

### App embed → app block

`blocks/tryon-block.liquid` is **deleted**. `blocks/tryon-button.liquid` is
created with:

```json
"target": "section",
"enabled_on": { "templates": ["product"] }
```

`enabled_on` stops the block being dropped onto a collection or page template,
where `product` is blank and it would render nothing.

Block schema keeps button-only settings: `api_base`, `promo_text`,
`button_text`, `text_color`, `button_color`, `border_radius`.

Dropped: `placement_selector`, `block_alignment`, and their
`data-placement-selector` / `data-block-alignment` attributes. The merchant
drags the block, so there is nothing to guess.

### JS deletions

`tryon-widget.js` loses `FALLBACK_PLACEMENT_SELECTORS` and `placeWidget()` —
lines 492-539, about 48 lines — plus the `placeWidget(widgets[i])` call at line
543. The boot loop becomes `initWidget` only.

### Deep link

`apps/api/src/modules/shopify/onboarding.routes.ts`:

- `TRYON_BLOCK_HANDLE` becomes `'tryon-button'`.
- The URL changes shape:

```
https://{shop}/admin/themes/current/editor
  ?template=product&addAppBlockId={apiKey}/tryon-button&target=mainSection
```

The 18-line comment above `buildThemeEditorDeepLink` ends with *"No `template`
param — that only applies to app blocks pinned to one template, and ours is a
`target: "body"` embed."* That sentence is now false and is rewritten. The
`read_themes` / `themes/current` reasoning in the same comment remains valid and
stays.

### Onboarding becomes load-bearing

An app embed, once activated, covers every page automatically. An app block that
the merchant never places renders **nothing, anywhere**. The Dashboard's
existing `themeBlockConfirmed` card goes from nice-to-have to the sole gate on
the app functioning; its copy is updated to say so.

### Accent color, additive

Modal-internal surfaces currently use `var(--tryme-button-color, #000000)` —
`tryon-widget.css` lines 265 (step dot), 329 (choose-photo), 435 (CTA), 475
(retry). They become:

```css
background: var(--tryme-accent, var(--tryme-button-color, #000000));
```

`--tryme-accent` comes from the metafield, `--tryme-button-color` from the
block setting. Unset accent renders exactly as today. The storefront trigger
button (line 131) keeps using `--tryme-button-color` alone — it is the
merchant's theme-editor button, not the modal.

### Result step actions

```liquid
<div class="tryme-tryon__result-actions">
  {%- unless cfg.behavior.addToCart == false -%}
    <button type="button" class="tryme-tryon__add-to-cart"
            data-default-variant-id="{{ product.selected_or_first_available_variant.id }}">
      {{ cfg.behavior.addToCartLabel | default: 'Add to Cart' | escape }}
    </button>
  {%- endunless -%}
  {%- unless cfg.behavior.share == false -%}
    <button type="button" class="tryme-tryon__share"
            aria-label="{{ cfg.behavior.shareLabel | default: 'Share' | escape }}">…</button>
  {%- endunless -%}
</div>
<a class="tryme-tryon__view-cart" href="/cart" hidden>View cart</a>
```

Absent config means both on.

**Add to Cart.** Variant is read at click time from
`form[action*="/cart/add"] [name="id"]` — the shopper's live selection — falling
back to `data-default-variant-id`. Then:

```js
POST /cart/add.js   { items: [{ id: variantId, quantity: 1 }] }
```

On success the button text swaps to `Added ✓` and disables,
`.tryme-tryon__view-cart` unhides, and
`document.dispatchEvent(new CustomEvent('cart:refresh', { bubbles: true }))`
fires. Themes that listen refresh their cart badge; themes that don't ignore an
unknown event harmlessly.

Sold-out is deliberately **not** pre-checked client-side — tracking variant
availability across each theme's own selector JS is fragile and silently rots.
`/cart/add.js` answers 422 with a human `description`; that string is shown
verbatim. Correct by construction, no state to keep in sync.

**Share.** The payload is always the result image URL. `resultUrl` is a stable
public R2 URL (`app.storage.publicUrl`, `customer.routes.ts:328`), so there is no
blob fetch and no CORS surface.

```js
if (navigator.share) navigator.share({ url: resultUrl }).catch(() => {});
else { navigator.clipboard.writeText(resultUrl); flash('Link copied'); }
```

The existing history-card share (`tryon-widget.js:231`) currently hides itself
when `navigator.share` is missing. It gets the same clipboard fallback so both
share affordances behave identically.

---

## 3. API

New file `apps/api/src/modules/shopify/widget-config.routes.ts`, registered in
`routes.ts`. Deliberately **not** folded into the `PATCH /v1/shopify/settings`
endpoint that shopper-limits Task 4 creates: that endpoint's contract is "merge a
settings sub-object", while this one additionally calls the Shopify Admin API and
reports sync state. One endpoint with two contracts costs more than a second
file.

```
PATCH /v1/shopify/widget-config            -> { widget, synced: boolean }
POST  /v1/shopify/widget-config/republish   -> { synced: boolean }
```

Both behind `app.requireShopifySession`.

`PATCH` shallow-merges `theme` / `copy` / `behavior` into `settings.widget`,
preserving sibling keys (`limits`, `retention`, `themeBlockConfirmed`,
`workflowTemplateId`) and preserving unlisted keys within each sub-object.

### Validation

`ShopifyWidgetConfigPatch` in `packages/types/src/widget.ts`.

- `accentColor`: `z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional()`
- Copy maximums: `heading` 60, `subheading` 80, `uploadTitle` 80, `uploadLead`
  160, `chooseLabel` 40, `ctaLabel` 40, `legalText` 300, `generatingText` 80,
  `errorText` 160, `addToCartLabel` 30, `shareLabel` 30.
- Over-length is a 400, never a silent truncate.

### Escaping is mandatory

Liquid does **not** auto-escape; Shopify themes require explicit `| escape`,
which is why the current block writes
`{{ block.settings.button_text | default: 'Try It On' | escape }}`. Every
merchant-authored field renders through `| escape` on the same pattern. Merchant
copy is semi-trusted, but a compromised app session must not become stored XSS on
a live storefront.

Consequence: `legalText` is a single escaped line. No merchant input can
introduce tags.

Total payload is under ~1.5 KB — nowhere near the json metafield limit.

---

## 4. Widget Design Page

New page `apps/shopify/src/pages/WidgetDesignPage.tsx`, route `/widget-design`
in `App.tsx`, nav entry in `AppNavMenu.tsx`. Nav order becomes
Dashboard → Manage → **Widget Design** → Settings → Support. Shopper-limits Task
7 inserts Settings into that same `NAV_ITEMS` array.

### Layout

Two halves. `App.tsx` already wraps every route in a Polaris `<Frame>`, so
save-bar context exists.

```
<Page title="Widget Design">
  <Layout>
    <Layout.Section variant="oneHalf">        ← settings
      <BlockStack gap="400">
        <Card> Theme     — accent color
        <Card> Copy      — 9 TextFields
        <Card> Behavior  — 2 Checkboxes + 2 label TextFields
      </BlockStack>
    </Layout.Section>

    <Layout.Section variant="oneHalf">        ← preview
      <div className="widget-preview-sticky">
        <Card>
          <Tabs> Upload | Ready | Generating | Result | Error
          <WidgetPreview … />
        </Card>
      </div>
    </Layout.Section>
  </Layout>
</Page>
```

| Card | Controls |
|---|---|
| Theme | `<input type="color">` + hex `TextField` + "Use button color" reset (sets `null`) |
| Copy | 9 `TextField`s, each `placeholder`ed from `WIDGET_COPY_DEFAULTS` |
| Behavior | `Checkbox` Add to Cart + label `TextField`; `Checkbox` Share + label `TextField` |

The right column sticks via a local CSS class
(`position: sticky; top: var(--p-space-400)`) — Polaris ships no sticky
primitive — disabled under 768px.

The preview renders at the widget's **native 400×700**, no scaling transform.
The right column gets `min-width: 400px`. Below that viewport width Polaris
stacks `oneHalf` sections automatically, dropping the preview under the form at
full size with sticky off.

### Preview component

`apps/shopify/src/components/WidgetPreview.tsx` imports the real stylesheet:

```ts
import '../../../shopify-extension/extensions/tryon-theme-extension/assets/tryon-widget.css';
```

It renders `.tryme-tryon__modal-content` and inward — deliberately not the
`.tryme-tryon__modal` wrapper, which is `position: fixed` and would escape the
page. Class names are all `tryme-tryon__*`-prefixed, so injecting this
stylesheet into a Polaris page collides with nothing.

*Wrinkle:* that import crosses a package boundary. Vite's `server.fs.allow`
defaults to the workspace root and monorepo detection should cover it; if the dev
server refuses to serve the file, the fix is
`server.fs.allow: ['..', '../..']` in `apps/shopify/vite.config.ts`.

**Five tabs, one per widget step — the governing rule is that every configurable
field has a preview surface.** Upload/Result alone would leave `ctaLabel`
(ready step), `generatingText`, and `errorText` edited blind. The three extra
states are tiny — a heading and a button apiece — so they cost one tab each.

| Tab | Renders |
|---|---|
| Upload | Step indicator, `uploadTitle`, `uploadLead`, avatar circle, `chooseLabel` button, `legalText` |
| Ready | Sample photo thumbnail, "Change Photo", `ctaLabel` button, `legalText` |
| Generating | `generatingText`, progress bar frozen at 60% fill so it is visible |
| Result | Sample image, then the live `addToCartLabel` / `shareLabel` action row |
| Error | `errorText`, retry button |

The header (`heading`, `subheading`) renders on every tab. The history button
stays hidden — preview history is empty, which is why the empty-history line is
not configurable (§1).

Coverage check: all 9 copy fields and both behavior labels appear on at least one
tab.

Live propagation is plain React state passed as props: every keystroke
re-renders, no debounce, no network. Accent rides in as an inline
`style={{ '--tryme-accent': accent }}` on the preview root, so the same CSS
cascade the storefront uses drives it.

The Result tab uses a **bundled static sample image** in
`apps/shopify/src/assets/` with a visible "Sample" caption. No store has a real
try-on result at config time, and an uncaptioned placeholder reads as the
merchant's own data.

### Save and unsaved changes

Mirrors the nav split already in `AppNavMenu.tsx` — App Bridge component when
embedded, Polaris fallback in dev:

- **Embedded:** `<ui-save-bar id="widget-design-save">` with Save and Discard
  buttons, shown via `shopify.saveBar.show(...)` when the form goes dirty and
  hidden on save or discard. Renders in the admin's own top bar, outside the
  iframe.
- **Dev (no App Bridge):** Polaris `<ContextualSaveBar>` inside the existing
  `<Frame>`.

Both need declarations added to `apps/shopify/src/lib/appBridge.ts`:
`'ui-save-bar'` in the `React.JSX.IntrinsicElements` block that already declares
`'ui-nav-menu'`, and `saveBar` on the `Window['shopify']` interface.

Dirty tracking compares current form state against the last-saved snapshot, so
editing a field and undoing it clears the bar. Discard restores the snapshot.

Navigating away dirty is blocked by react-router's `useBlocker` with a Polaris
`Modal` — Save / Discard / Cancel. Without it a merchant clicks Manage in the nav
and silently loses the copy they just wrote.

On `synced: false`, a Polaris `Banner tone="warning"` pins to the top of the left
column: *"Settings saved, but your storefront wasn't updated. Shoppers still see
the previous text."* with a **Retry** action hitting `republish`. Warning, not
critical — the data is safe, only the mirror is stale.

---

## 5. Failure Modes

| Failure | Behavior |
|---|---|
| Metafield write fails | `synced: false`, HTTP 200. Save succeeded; a 5xx would wrongly imply retyping |
| Access token expired | Existing `SHOPIFY_REAUTH_REQUIRED` path in `apps/shopify/src/lib/api.ts` handles it — no new code |
| No metafield yet | Every `\| default:` fires. Storefront identical to today |
| `/cart/add.js` returns 422 | Show Shopify's own `description` string verbatim |
| `navigator.share` absent | Clipboard copy of `resultUrl` + "Link copied" flash |
| Merchant never places the block | Nothing renders anywhere. Dashboard onboarding card is the recovery path |

---

## 6. Testing

**`apps/shopify` has no test runner today.** Adding vitest: one devDependency,
one config file, one `test` script, wired into turbo like the other packages.

Two drift guards, both pure text comparison, no DOM:

1. Parse `tryon-button.liquid` for `tryme-tryon__*` class names inside the
   modal markup; parse `WidgetPreview.tsx` for the same; fail on set mismatch.
2. Parse every `| default: '…'` string out of the Liquid; fail if any disagrees
   with `WIDGET_COPY_DEFAULTS`.

Both catch the exact failure this design invites — a preview that quietly stops
matching the thing it previews.

**`apps/api/test/shopify-widget-config.test.ts`** (integration, real Postgres per
the existing harness; auth via `upsertShopifyStore` + `signSessionToken` + Bearer,
matching `apps/api/test/shopify-me.test.ts`):

- `PATCH` merges `widget` without clobbering `limits`, `retention`,
  `themeBlockConfirmed`, or `workflowTemplateId`.
- `PATCH` merges within a sub-object — patching `copy.heading` leaves
  `copy.subheading` intact.
- Malformed accent hex returns 400.
- Over-length copy returns 400.
- Returns `synced: false` (HTTP 200) when the stubbed Admin API write fails, and
  the DB row is still updated.
- `republish` pushes the metafield without writing the row.

**Manual, dev store:** block placement in the product template via the deep link;
Add to Cart honoring a changed variant selection; sold-out 422 message; share on
mobile (native sheet) and desktop Firefox (clipboard fallback).

---

## 7. Sequencing

This work **must execute after** the shopper-limits plan
(`docs/superpowers/plans/2026-07-31-shopify-shopper-limits.md`), specifically its
Tasks 6 and 7.

- Task 6 adds email-gate markup to `tryon-block.liquid` and identity code to
  `tryon-widget.js`. This spec **deletes** `tryon-block.liquid`, so that markup
  must be **ported into** `tryon-button.liquid`. Missing this silently removes
  the email gate.
- Task 7 adds the Settings entry to `NAV_ITEMS` in `AppNavMenu.tsx`; Widget
  Design is inserted before it.

## 8. Files Touched

**Created**

- `apps/shopify-extension/extensions/tryon-theme-extension/blocks/tryon-button.liquid`
- `apps/api/src/modules/shopify/widget-config.routes.ts`
- `apps/shopify/src/pages/WidgetDesignPage.tsx`
- `apps/shopify/src/components/WidgetPreview.tsx`
- `apps/shopify/src/assets/` — sample images (source photo for the Ready tab, result for the Result tab)
- `apps/shopify/vitest.config.ts` + two drift tests
- `apps/api/test/shopify-widget-config.test.ts`

**Modified**

- `packages/db/src/schema/shopify.ts` — three new interfaces, `ShopifyStoreSettings.widget`
- `packages/types/src/widget.ts` — `ShopifyWidgetConfigPatch`, `WIDGET_COPY_DEFAULTS`
- `apps/api/src/modules/shopify/metafields.ts` — `writeWidgetConfigMetafield`
- `apps/api/src/modules/shopify/onboarding.routes.ts` — block handle, deep link, comment
- `apps/api/src/modules/shopify/routes.ts` — register the new routes
- `apps/shopify-extension/extensions/tryon-theme-extension/assets/tryon-widget.js` — delete placement, add cart/share
- `apps/shopify-extension/extensions/tryon-theme-extension/assets/tryon-widget.css` — accent var chain, result-actions styles
- `apps/shopify/src/App.tsx` — route
- `apps/shopify/src/components/AppNavMenu.tsx` — nav entry
- `apps/shopify/src/lib/appBridge.ts` — `ui-save-bar` + `saveBar` declarations
- `apps/shopify/src/types.ts` — client-side config types
- `apps/shopify/src/pages/DashboardPage.tsx` — onboarding card copy
- `apps/shopify/package.json` — vitest

**Deleted**

- `apps/shopify-extension/extensions/tryon-theme-extension/blocks/tryon-block.liquid`
