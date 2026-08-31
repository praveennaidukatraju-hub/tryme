# Shopify tryon widget: merge History page into Result step

## Problem

The storefront popup (`apps/shopify-extension/extensions/tryon-theme-extension`) has two
separate "pages": `page--main` (the step flow: upload → ready → email → progress → pending →
result → error) and a standalone `page--history` reached via a header icon, showing a small
thumbnail-row list of past results with only a Share action.

This doesn't match the states the merchant-facing "Widget Design" preview
(`apps/shopify/src/components/WidgetPreview.tsx`) already documents — `[Upload, Ready,
Generating, Result, Error]`, with no History state. The popup should collapse into those same
five states: the Result step becomes the single landing surface that stores and displays every
generated image, scrollable, with the History page removed.

## Scope

- **In scope**: `apps/shopify-extension/extensions/tryon-theme-extension` (`tryon-button.liquid`,
  `tryon-widget.js`, `tryon-widget.css`).
- **Out of scope**: `apps/shopify/src/components/WidgetPreview.tsx` (the admin "Widget Design"
  preview) stays as-is — a single sample result frame per state, since it's a static mockup, not
  live data. Confirmed with product owner: no need to fake a multi-result gallery there.

## Design

### Page/step model

Today: two pages (`main`, `history`), `main` has 7 steps, `history` has its own header state
(back button) and rendering path. After this change: one page, `result` step is the merged
surface. `showPage()` and the `pages` map are deleted; `showStep()` is the only navigation
primitive left.

### Result step becomes a feed

`localStorage['tryme_tryon_history']` (shape: `{resultUrl, createdAt, productTitle,
productUrl}`, capped at 12 entries, per-browser, newest-first) stays the source of truth — it
already gets the newest result unshifted to the front via `addToHistory()`. The `result` step
renders this array directly: every entry (including the one just generated) is an identical
full-width card — result image, Add to Cart button, Share button — stacked vertically with a
thin, low-opacity divider between cards, scrollable.

`renderHistoryList()` is renamed `renderResultList()` and becomes the only renderer for the
`result` step, replacing both today's static single-result markup and the separate small
history-card renderer.

### Add to Cart is per-card

Every card gets its own Add to Cart button, independently stateful (idle → adding → "Added ✓" /
error), built dynamically the same way Share buttons are already built per-card today. Per
product-owner decision: every card's Add to Cart always adds the *current page's* product
variant (via the existing `resolveVariantId()`), even when a card's photo was generated against
a different product on a different page visit. This is an accepted simplification — no per-entry
variant tracking.

The static `<img class="tryme-tryon__result-image">` + single `result-actions` block in
`tryon-button.liquid` is removed; the `result` step becomes an empty scrollable container
(`tryme-tryon__result-list`) populated entirely by JS, mirroring today's `history-list`
pattern.

### Header entry point stays

The history icon + badge remain in the (now single) header, showing total result count.
Clicking it calls `showStep('result')` directly — no page swap, no back button, since there is
only one page. It works even when nothing was generated this session, rendering whatever is in
localStorage. The button stays hidden when the count is 0, same as today.

`page--history`, `header-history` (and its back button), and the old thumbnail-row history-card
rendering path are deleted.

### Data plumbing for dynamic Add to Cart

Add to Cart's label text and default variant id currently live as attributes on the *static*
button (`data-default-variant-id` on the button itself, label read via `.textContent`). Since the
button is now built dynamically per card, these move to `data-*` attributes on the widget root
(`.tryme-tryon`), alongside the existing `data-product-id` etc.:

- `data-default-variant-id`
- `data-add-to-cart-label`
- `data-share-label`
- boolean flags for whether Add to Cart / Share are enabled (from `cfg.behavior.addToCart` /
  `cfg.behavior.share`)

JS reads these once at init instead of introspecting a template DOM node.

### Error handling

Per-card Add to Cart errors (sold-out message from Shopify, generic "Could not add to cart")
render inline under that specific card only — same UX as today's single error paragraph, now
scoped per-card. A card whose image 404s (retention deleted the object) is pruned from
localStorage and the list re-renders, same as today's history-card image-error handling.

## Testing

`apps/shopify/src/__tests__/widget-drift.test.ts` asserts every class referenced in
`WidgetPreview.tsx` exists somewhere in the liquid source. Since `WidgetPreview.tsx` is
unchanged, this still passes as long as the classes it references
(`tryme-tryon__step--result`, `tryme-tryon__result-image`, `tryme-tryon__result-actions`,
`tryme-tryon__add-to-cart`, `tryme-tryon__share`) still appear in the liquid file — the test
only checks the class string exists, not that it's static markup, so generating those elements
dynamically in JS instead of statically in Liquid is fine as long as the liquid file still
contains the class name (e.g. in a comment, a JS template string embedded in the asset, or a
hidden template node) that the drift test can find. This needs verifying during implementation —
if the test only scans the `.liquid` file (not `tryon-widget.js`), moving markup fully into JS
may require keeping a reference class name in the liquid comments or CSS file for the check to
still find it.

`tryon-widget.js` has no existing automated test coverage (untested vanilla JS) — manual
verification in a dev store is the plan for this change.

## Out of scope / non-goals

- No change to the "reuse last photo" flow (`enterMainFlow`, `REUSE_STORAGE_KEY`) — unrelated to
  history/result merging.
- No change to `HISTORY_MAX_ITEMS` (stays 12) or the localStorage key name.
- No server-side changes — this is entirely client-side widget behavior.
