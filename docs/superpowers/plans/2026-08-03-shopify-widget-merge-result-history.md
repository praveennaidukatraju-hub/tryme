# Shopify Widget: Merge Result & History Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Collapse the storefront tryon popup's separate History page into the Result step, so Result becomes one scrollable feed of every generated image (newest first), each card with its own Add to Cart + Share, matching the five states already documented on the Widget Design preview (`[Upload, Ready, Generating, Result, Error]`).

**Architecture:** `localStorage['tryme_tryon_history']` already holds every past result, newest-first. Instead of a second `page--history` with small thumbnail-row cards, the `result` step renders that same array as full-size cards (a `<template>` element in the Liquid file, cloned per entry by JS). `showPage()`/the two-page model is deleted entirely — `showStep()` is the only navigation primitive left.

**Tech Stack:** Vanilla JS (`tryon-widget.js`), Shopify Liquid (`tryon-button.liquid`), plain CSS — no build step, no framework, no existing test coverage for this file.

## Global Constraints

- Scope is confined to `apps/shopify-extension/extensions/tryon-theme-extension/blocks/tryon-button.liquid`, `.../assets/tryon-widget.js`, `.../assets/tryon-widget.css`. `apps/shopify/src/components/WidgetPreview.tsx` (the merchant-facing admin preview) stays unchanged — confirmed with product owner, it keeps showing a single sample result frame per state.
- `apps/shopify/src/__tests__/widget-drift.test.ts` must keep passing **unmodified**. It reads `tryon-button.liquid` as raw text and asserts every `tryme-tryon__*` class `WidgetPreview.tsx` uses appears somewhere in that text, plus that the `cfg.copy.*` / `cfg.behavior.*` Liquid `| default: '...'` fallbacks byte-match `WIDGET_COPY_DEFAULTS` / `WIDGET_BEHAVIOR_DEFAULTS` in `apps/shopify/src/lib/widgetDefaults.ts`. It's a plain text scan (`environment: 'node'` in `apps/shopify/vitest.config.ts`), so classes/defaults living inside a `<template>` tag satisfy it exactly the same as static markup.
- No server-side or API changes.
- `HISTORY_STORAGE_KEY` (`'tryme_tryon_history'`), `HISTORY_MAX_ITEMS` (`12`), and `REUSE_STORAGE_KEY` stay unchanged — this is purely a rendering/navigation change, not a data-model change.
- Every card's Add to Cart always adds the **current page's** product variant via the existing `resolveVariantId()` helper, even for a card whose photo was generated on a different product page. This is an accepted product-owner decision, not a bug to fix.
- No automated test exercises `tryon-widget.js` at runtime (it's untested vanilla JS, no DOM test harness in this repo for it). The closing task is a manual dev-store checklist.

---

### Task 1: Liquid markup — merge the History page into the Result step

**Files:**
- Modify: `apps/shopify-extension/extensions/tryon-theme-extension/blocks/tryon-button.liquid`

**Interfaces:**
- Produces (DOM structure Task 3's JS will query): `.tryme-tryon__result-list` (empty container inside the `result` step), `.tryme-tryon__result-empty` (empty-state paragraph), `.tryme-tryon__result-card-template` (a `<template>` element whose content is one card: `.tryme-tryon__result-card` wrapping `.tryme-tryon__result-image`, `.tryme-tryon__result-actions` (`.tryme-tryon__add-to-cart` / `.tryme-tryon__share`, each conditionally present per `cfg.behavior`), `.tryme-tryon__cart-error`, `.tryme-tryon__share-flash`, `.tryme-tryon__view-cart`).
- Removes: `.tryme-tryon__header-history`, `.tryme-tryon__history-back`, `.tryme-tryon__page--history`, `.tryme-tryon__history-list`, `.tryme-tryon__history-empty` — none of these are referenced by `WidgetPreview.tsx`, so removing them cannot break the drift test.

- [ ] **Step 1: Remove the header's History sub-header**

  Find (inside the `.tryme-tryon__header` block):

  ```liquid
            <div class="tryme-tryon__header-history" hidden>
              <button type="button" class="tryme-tryon__history-back" aria-label="Back">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5"/><path d="m12 19-7-7 7-7"/></svg>
              </button>
              <div>
                <p class="tryme-tryon__heading">Your Try-Ons</p>
                <p class="tryme-tryon__subheading">Results</p>
              </div>
            </div>
            <div class="tryme-tryon__header-actions">
              <button type="button" class="tryme-tryon__history-btn" aria-label="View history" hidden>
  ```

  Replace with:

  ```liquid
            <div class="tryme-tryon__header-actions">
              <button type="button" class="tryme-tryon__history-btn" aria-label="View your try-ons" hidden>
  ```

  There is now only one header state — the history icon lives directly in `header-actions` and stays visible across every step, same as `close` already does.

- [ ] **Step 2: Replace the static Result step with an empty scrollable container**

  Find:

  ```liquid
            <div class="tryme-tryon__step tryme-tryon__step--result" hidden>
              <img class="tryme-tryon__result-image" alt="{{ 'tryon.result_alt' | t }}" />

              <div class="tryme-tryon__result-actions">
                {%- unless cfg.behavior.addToCart == false -%}
                  <button
                    type="button"
                    class="tryme-tryon__add-to-cart"
                    data-default-variant-id="{{ product.selected_or_first_available_variant.id }}"
                  >
                    {{ cfg.behavior.addToCartLabel | default: 'Add to Cart' | escape }}
                  </button>
                {%- endunless -%}
                {%- unless cfg.behavior.share == false -%}
                  <button
                    type="button"
                    class="tryme-tryon__share"
                    aria-label="{{ cfg.behavior.shareLabel | default: 'Share' | escape }}"
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="2.2"/><circle cx="6" cy="12" r="2.2"/><circle cx="18" cy="19" r="2.2"/><path d="m8 11 7.8-4.6M8 13l7.8 4.6"/></svg>
                  </button>
                {%- endunless -%}
              </div>

              <p class="tryme-tryon__cart-error" hidden></p>
              <span class="tryme-tryon__share-flash" hidden></span>
              <a class="tryme-tryon__view-cart" href="/cart" hidden>View cart</a>
            </div>

            <div class="tryme-tryon__step tryme-tryon__step--error" hidden>
              <p>{{ cfg.copy.errorText | default: 'Something went wrong. Please try again.' | escape }}</p>
              <button type="button" class="tryme-tryon__retry">
                {{ 'tryon.try_again' | t }}
              </button>
            </div>
          </div>

          <div class="tryme-tryon__page tryme-tryon__page--history" hidden>
            <div class="tryme-tryon__history-list"></div>
            <p class="tryme-tryon__history-empty" hidden>
              No try-ons yet — results you generate will show up here.
            </p>
          </div>
        </div>
      </div>
    </div>
  ```

  Replace with:

  ```liquid
            <div class="tryme-tryon__step tryme-tryon__step--result" hidden>
              <div class="tryme-tryon__result-list"></div>
              <p class="tryme-tryon__result-empty" hidden>
                No try-ons yet — results you generate will show up here.
              </p>
            </div>

            <div class="tryme-tryon__step tryme-tryon__step--error" hidden>
              <p>{{ cfg.copy.errorText | default: 'Something went wrong. Please try again.' | escape }}</p>
              <button type="button" class="tryme-tryon__retry">
                {{ 'tryon.try_again' | t }}
              </button>
            </div>
          </div>

          <template class="tryme-tryon__result-card-template">
            <div class="tryme-tryon__result-card">
              <img class="tryme-tryon__result-image" alt="{{ 'tryon.result_alt' | t }}" />

              <div class="tryme-tryon__result-actions">
                {%- unless cfg.behavior.addToCart == false -%}
                  <button
                    type="button"
                    class="tryme-tryon__add-to-cart"
                    data-default-variant-id="{{ product.selected_or_first_available_variant.id }}"
                  >
                    {{ cfg.behavior.addToCartLabel | default: 'Add to Cart' | escape }}
                  </button>
                {%- endunless -%}
                {%- unless cfg.behavior.share == false -%}
                  <button
                    type="button"
                    class="tryme-tryon__share"
                    aria-label="{{ cfg.behavior.shareLabel | default: 'Share' | escape }}"
                  >
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="2.2"/><circle cx="6" cy="12" r="2.2"/><circle cx="18" cy="19" r="2.2"/><path d="m8 11 7.8-4.6M8 13l7.8 4.6"/></svg>
                  </button>
                {%- endunless -%}
              </div>

              <p class="tryme-tryon__cart-error" hidden></p>
              <span class="tryme-tryon__share-flash" hidden></span>
              <a class="tryme-tryon__view-cart" href="/cart" hidden>View cart</a>
            </div>
          </template>
        </div>
      </div>
    </div>
  ```

  `<template>` content is inert (no image request fires, nothing renders) until JS clones it in Task 3 — this is what lets the exact same Liquid-rendered defaults (label text, `data-default-variant-id`, the `{%- unless -%}` conditionals) keep working per-card without any new plumbing.

- [ ] **Step 3: Verify the file is well-formed**

  Run: `pnpm --filter @tryme/shopify-admin test -- widget-drift`

  Expected: all tests in `widget-drift.test.ts` PASS. This confirms every class `WidgetPreview.tsx` needs (`tryme-tryon__step--result`, `tryme-tryon__result-image`, `tryme-tryon__result-actions`, `tryme-tryon__add-to-cart`, `tryme-tryon__share`, `tryme-tryon__header-main`, etc.) still exists in the Liquid file, and the `cfg.behavior.addToCartLabel`/`shareLabel` defaults are unchanged.

- [ ] **Step 4: Commit**

  ```bash
  git add apps/shopify-extension/extensions/tryon-theme-extension/blocks/tryon-button.liquid
  git commit -m "feat(shopify-widget): merge history page into result step markup"
  ```

---

### Task 2: CSS — retire the History-page styles, add the Result feed styles

**Files:**
- Modify: `apps/shopify-extension/extensions/tryon-theme-extension/assets/tryon-widget.css`

**Interfaces:**
- Consumes: none (pure styling; Task 1's new class names `.tryme-tryon__result-list` / `.tryme-tryon__result-card` / `.tryme-tryon__result-empty` are what this task styles).
- Produces: same visual language the old `.tryme-tryon__history-*` rules gave the History page, now applied to `.tryme-tryon__result-*`, plus a thin low-opacity divider between stacked cards (per product-owner decision).

- [ ] **Step 1: Drop the now-dead History header rules**

  Find:

  ```css
  .tryme-tryon__header-main[hidden],
  .tryme-tryon__header-history[hidden] {
    display: none;
  }

  .tryme-tryon__header-history {
    display: flex;
    align-items: center;
    gap: 10px;
  }

  .tryme-tryon__history-back {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 28px;
    height: 28px;
    background: none;
    border: none;
    color: #374151;
    cursor: pointer;
    padding: 0;
    flex-shrink: 0;
  }

  .tryme-tryon__header-actions {
  ```

  Replace with:

  ```css
  .tryme-tryon__header-main[hidden] {
    display: none;
  }

  .tryme-tryon__header-actions {
  ```

- [ ] **Step 2: Replace the History-card rules with Result-card rules**

  Find:

  ```css
  .tryme-tryon__history-list {
    display: flex;
    flex-direction: column;
    gap: 20px;
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }

  .tryme-tryon__history-card {
    display: block;
  }

  .tryme-tryon__history-media {
    position: relative;
    width: 100%;
    aspect-ratio: 3 / 4;
    border-radius: 16px;
    overflow: hidden;
    background: #f9fafb;
  }

  .tryme-tryon__history-media img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }

  .tryme-tryon__history-meta {
    margin: 10px 2px 8px;
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
  }

  .tryme-tryon__history-meta strong {
    font-size: 14px;
    font-weight: 700;
    color: #111827;
  }

  .tryme-tryon__history-meta span {
    color: #9ca3af;
    font-size: 11px;
    flex-shrink: 0;
  }

  .tryme-tryon__history-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }

  .tryme-tryon__history-share {
    width: 44px;
    height: 40px;
    border-radius: 10px;
    border: 1px solid #e5e7eb;
    background: #fff;
    color: #4b5563;
    display: grid;
    place-items: center;
  }

  .tryme-tryon__history-empty {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    margin: 0;
    text-align: center;
    font-size: 13px;
    color: #6b7280;
  }

  .tryme-tryon__history-empty[hidden] {
    display: none;
  }
  ```

  Replace with:

  ```css
  .tryme-tryon__result-list {
    display: flex;
    flex-direction: column;
    gap: 20px;
    flex: 1;
    min-height: 0;
    overflow-y: auto;
  }

  .tryme-tryon__result-card {
    display: block;
  }

  .tryme-tryon__result-card + .tryme-tryon__result-card {
    padding-top: 20px;
    border-top: 1px solid rgba(17, 24, 39, 0.08);
  }

  .tryme-tryon__result-empty {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    margin: 0;
    text-align: center;
    font-size: 13px;
    color: #6b7280;
  }

  .tryme-tryon__result-empty[hidden] {
    display: none;
  }
  ```

  `.tryme-tryon__result-image` and `.tryme-tryon__result-actions` (further down the file) are untouched — they already render the full-width photo + action row today's single result used, and now apply identically inside every `.tryme-tryon__result-card`.

- [ ] **Step 3: Let the Result step scroll instead of centering a single image**

  Find:

  ```css
  .tryme-tryon__step--pending,
  .tryme-tryon__step--error {
    align-items: center;
    justify-content: center;
    text-align: center;
  }

  .tryme-tryon__step--result {
    justify-content: center;
  }

  .tryme-tryon__ready-preview {
  ```

  Replace with:

  ```css
  .tryme-tryon__step--pending,
  .tryme-tryon__step--error {
    align-items: center;
    justify-content: center;
    text-align: center;
  }

  .tryme-tryon__ready-preview {
  ```

  `.tryme-tryon__step` (the base rule) already gives every step `flex: 1; min-height: 0; display: flex; flex-direction: column;`. Dropping the `justify-content: center` override means the Result step's cards stack from the top and `.tryme-tryon__result-list`'s own `flex: 1; overflow-y: auto` handles the scrolling — same pattern the old `.tryme-tryon__history-list` used.

- [ ] **Step 4: Verify**

  Run: `pnpm --filter @tryme/shopify-admin test -- widget-drift`

  Expected: PASS. (This suite's only CSS-specific assertion is that the `.tryme-tryon__retry` margin rule stays more specific than the preview's button reset — untouched by this task — plus the class-existence check from Task 1, which this task doesn't affect since it removes only classes `WidgetPreview.tsx` never references.)

- [ ] **Step 5: Commit**

  ```bash
  git add apps/shopify-extension/extensions/tryon-theme-extension/assets/tryon-widget.css
  git commit -m "feat(shopify-widget): style the merged result feed, drop history-page CSS"
  ```

---

### Task 3: JS — render every result as a per-card feed, delete the History page navigation

**Files:**
- Modify: `apps/shopify-extension/extensions/tryon-theme-extension/assets/tryon-widget.js`

**Interfaces:**
- Consumes: `.tryme-tryon__result-list`, `.tryme-tryon__result-empty`, `.tryme-tryon__result-card-template` (Task 1), `.tryme-tryon__result-card` and friends inside the template (Task 1).
- Produces (used by later steps in this same task): `renderResultList()` — re-reads `getHistory()` and repopulates `.tryme-tryon__result-list`; `buildResultCard(entry)` — returns one populated `.tryme-tryon__result-card` element, fully wired; `addVariantToCart(btn, errorEl, viewCartEl)` — adds the current page's variant to cart, updating only the three passed elements; `shareResult(url, flashEl)` and `flashShare(flashEl, message)` — now take the flash element to update instead of a module-level singleton.
- Removes: `showPage()`, the `pages` map, `headerMain`/`headerHistory`/`historyBackBtn`/`historyList`/`historyEmpty` refs, `resetResultActions()`, `addCurrentVariantToCart()`, `renderHistoryList()`, `formatHistoryDate()`, the module-level `resultImage`/`addToCartBtn`/`shareBtn`/`viewCartLink`/`cartError`/`shareFlash`/`addToCartLabel`/`currentResultUrl` singletons.

- [ ] **Step 1: Swap the singular result DOM refs for the list/template refs**

  Find:

  ```js
      const resultImage = root.querySelector('.tryme-tryon__result-image');
      const addToCartBtn = root.querySelector('.tryme-tryon__add-to-cart');
      const shareBtn = root.querySelector('.tryme-tryon__share');
      const viewCartLink = root.querySelector('.tryme-tryon__view-cart');
      const cartError = root.querySelector('.tryme-tryon__cart-error');
      const shareFlash = root.querySelector('.tryme-tryon__share-flash');
      const addToCartLabel = addToCartBtn ? addToCartBtn.textContent.trim() : '';
      let currentResultUrl = null;
      const readyImage = root.querySelector('.tryme-tryon__ready-image');
  ```

  Replace with:

  ```js
      const resultList = root.querySelector('.tryme-tryon__result-list');
      const resultEmpty = root.querySelector('.tryme-tryon__result-empty');
      const resultCardTemplate = root.querySelector('.tryme-tryon__result-card-template');
      const readyImage = root.querySelector('.tryme-tryon__ready-image');
  ```

- [ ] **Step 2: Drop the two-page model's refs**

  Find:

  ```js
      const pages = {
        main: root.querySelector('.tryme-tryon__page--main'),
        history: root.querySelector('.tryme-tryon__page--history'),
      };
      const headerMain = root.querySelector('.tryme-tryon__header-main');
      const headerHistory = root.querySelector('.tryme-tryon__header-history');
      const historyBtn = root.querySelector('.tryme-tryon__history-btn');
      const historyBackBtn = root.querySelector('.tryme-tryon__history-back');
      const historyBadge = root.querySelector('.tryme-tryon__history-badge');
      const historyList = root.querySelector('.tryme-tryon__history-list');
      const historyEmpty = root.querySelector('.tryme-tryon__history-empty');
      const HISTORY_STORAGE_KEY = 'tryme_tryon_history';
      const HISTORY_MAX_ITEMS = 12;
  ```

  Replace with:

  ```js
      const historyBtn = root.querySelector('.tryme-tryon__history-btn');
      const historyBadge = root.querySelector('.tryme-tryon__history-badge');
      const HISTORY_STORAGE_KEY = 'tryme_tryon_history';
      const HISTORY_MAX_ITEMS = 12;
  ```

- [ ] **Step 3: Delete `showPage()`**

  Find:

  ```js
      function showPage(name) {
        for (const key in pages) {
          if (pages[key]) pages[key].hidden = key !== name;
        }
        const onHistory = name === 'history';
        if (headerMain) headerMain.hidden = onHistory;
        if (headerHistory) headerHistory.hidden = !onHistory;
        if (historyBtn) historyBtn.hidden = onHistory || getHistory().length === 0;
        if (onHistory) renderHistoryList();
      }

      function getHistory() {
  ```

  Replace with:

  ```js
      function getHistory() {
  ```

- [ ] **Step 4: Make `shareResult`/`flashShare` take a target flash element instead of a module-level singleton**

  Find:

  ```js
      function shareResult(url) {
        trackEvent('share');
        if (!url) return;
        if (typeof navigator.share === 'function') {
          navigator.share({ url }).catch(() => {
            /* user cancelled the share sheet — nothing to do */
          });
          return;
        }
        if (!navigator.clipboard) return;
        navigator.clipboard.writeText(url).then(
          () => flashShare('Link copied'),
          () => flashShare('Copy failed'),
        );
      }
  ```

  Replace with:

  ```js
      function shareResult(url, flashEl) {
        trackEvent('share');
        if (!url) return;
        if (typeof navigator.share === 'function') {
          navigator.share({ url }).catch(() => {
            /* user cancelled the share sheet — nothing to do */
          });
          return;
        }
        if (!navigator.clipboard) return;
        navigator.clipboard.writeText(url).then(
          () => flashShare(flashEl, 'Link copied'),
          () => flashShare(flashEl, 'Copy failed'),
        );
      }
  ```

- [ ] **Step 5: Replace the singular-result plumbing (`resetResultActions`, `addCurrentVariantToCart`, the module-level click wiring, `flashShare`, `renderHistoryList`) with the per-card feed renderer**

  Find (this is the whole block from `resetResultActions` through the end of `renderHistoryList`):

  ```js
      function resetResultActions() {
        if (addToCartBtn) {
          addToCartBtn.disabled = false;
          addToCartBtn.textContent = addToCartLabel;
        }
        if (viewCartLink) viewCartLink.hidden = true;
        if (cartError) {
          cartError.hidden = true;
          cartError.textContent = '';
        }
      }

      async function addCurrentVariantToCart() {
        const variantId = resolveVariantId();
        if (!variantId || !addToCartBtn) return;

        addToCartBtn.disabled = true;
        if (cartError) cartError.hidden = true;

        try {
          const res = await fetch('/cart/add.js', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ items: [{ id: variantId, quantity: 1 }] }),
          });

          if (!res.ok) {
            // Sold-out and every other refusal comes back as a 422 with a human
            // message. Showing Shopify's own string beats tracking variant
            // availability client-side across each theme's selector JS.
            const body = await res.json().catch(() => ({}));
            if (cartError) {
              cartError.textContent = body.description || 'Could not add to cart.';
              cartError.hidden = false;
            }
            addToCartBtn.disabled = false;
            return;
          }

          addToCartBtn.textContent = 'Added ✓';
          trackEvent('add_to_cart');
          if (viewCartLink) viewCartLink.hidden = false;
          // Themes that listen refresh their cart badge; the rest ignore an
          // unknown event. Cheaper and safer than detecting each theme's drawer.
          document.dispatchEvent(new CustomEvent('cart:refresh', { bubbles: true }));
        } catch {
          if (cartError) {
            cartError.textContent = 'Could not add to cart.';
            cartError.hidden = false;
          }
          addToCartBtn.disabled = false;
        }
      }

      if (addToCartBtn) addToCartBtn.addEventListener('click', addCurrentVariantToCart);
      if (shareBtn) shareBtn.addEventListener('click', () => shareResult(currentResultUrl));

      let shareFlashTimer = null;
      function flashShare(message) {
        if (!shareFlash) return;
        shareFlash.textContent = message;
        shareFlash.hidden = false;
        clearTimeout(shareFlashTimer);
        shareFlashTimer = setTimeout(() => {
          shareFlash.hidden = true;
        }, 2000);
      }

      function renderHistoryList() {
        const history = getHistory();
        updateHistoryBadge(history.length);
        if (!historyList) return;
        historyList.innerHTML = '';
        if (historyEmpty) historyEmpty.hidden = history.length > 0;
        for (let i = 0; i < history.length; i++) {
          const entry = history[i];
          const card = document.createElement('div');
          card.className = 'tryme-tryon__history-card';

          const media = document.createElement('div');
          media.className = 'tryme-tryon__history-media';
          const img = document.createElement('img');
          img.src = entry.resultUrl;
          img.alt = '';
          // Retention may have deleted this result since it was cached locally.
          // A broken image is worse than a missing row, so drop the entry and
          // rewrite the stored history.
          img.addEventListener('error', () => {
            const remaining = getHistory().filter((h) => h.resultUrl !== entry.resultUrl);
            try {
              localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(remaining));
            } catch (_err) {
              // Storage blocked — the entry reappears next load; harmless.
            }
            renderHistoryList();
          });
          media.appendChild(img);
          card.appendChild(media);

          const meta = document.createElement('div');
          meta.className = 'tryme-tryon__history-meta';
          const title = document.createElement('strong');
          title.textContent = entry.productTitle || 'Try-on';
          meta.appendChild(title);
          const date = document.createElement('span');
          date.textContent = formatHistoryDate(entry.createdAt);
          meta.appendChild(date);
          card.appendChild(meta);

          const actions = document.createElement('div');
          actions.className = 'tryme-tryon__history-actions';
          const historyShareBtn = document.createElement('button');
          historyShareBtn.type = 'button';
          historyShareBtn.className = 'tryme-tryon__history-share';
          historyShareBtn.setAttribute('aria-label', 'Share');
          historyShareBtn.innerHTML =
            '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="2.2"/><circle cx="6" cy="12" r="2.2"/><circle cx="18" cy="19" r="2.2"/><path d="m8 11 7.8-4.6M8 13l7.8 4.6"/></svg>';
          historyShareBtn.addEventListener('click', () => shareResult(entry.resultUrl));
          actions.appendChild(historyShareBtn);
          if (actions.childNodes.length > 0) card.appendChild(actions);

          historyList.appendChild(card);
        }
      }
  ```

  Replace with:

  ```js
      let shareFlashTimer = null;
      function flashShare(flashEl, message) {
        if (!flashEl) return;
        flashEl.textContent = message;
        flashEl.hidden = false;
        clearTimeout(shareFlashTimer);
        shareFlashTimer = setTimeout(() => {
          flashEl.hidden = true;
        }, 2000);
      }

      async function addVariantToCart(btn, errorEl, viewCartEl) {
        const variantId = resolveVariantId();
        if (!variantId) return;

        btn.disabled = true;
        if (errorEl) errorEl.hidden = true;

        try {
          const res = await fetch('/cart/add.js', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ items: [{ id: variantId, quantity: 1 }] }),
          });

          if (!res.ok) {
            // Sold-out and every other refusal comes back as a 422 with a human
            // message. Showing Shopify's own string beats tracking variant
            // availability client-side across each theme's selector JS.
            const body = await res.json().catch(() => ({}));
            if (errorEl) {
              errorEl.textContent = body.description || 'Could not add to cart.';
              errorEl.hidden = false;
            }
            btn.disabled = false;
            return;
          }

          btn.textContent = 'Added ✓';
          trackEvent('add_to_cart');
          if (viewCartEl) viewCartEl.hidden = false;
          // Themes that listen refresh their cart badge; the rest ignore an
          // unknown event. Cheaper and safer than detecting each theme's drawer.
          document.dispatchEvent(new CustomEvent('cart:refresh', { bubbles: true }));
        } catch {
          if (errorEl) {
            errorEl.textContent = 'Could not add to cart.';
            errorEl.hidden = false;
          }
          btn.disabled = false;
        }
      }

      // One full-size card per stored result — the just-generated one lands on
      // top because addToHistory() unshifts it. Every card is a fresh clone of
      // the Liquid <template>, so each has its own Add to Cart / Share state;
      // nothing needs resetting between renders.
      function buildResultCard(entry) {
        const fragment = resultCardTemplate.content.cloneNode(true);
        const card = fragment.querySelector('.tryme-tryon__result-card');

        const img = card.querySelector('.tryme-tryon__result-image');
        img.src = entry.resultUrl;
        // Retention may have deleted this result since it was cached locally. A
        // broken image is worse than a missing card, so drop the entry and
        // rewrite the stored history.
        img.addEventListener('error', () => {
          const remaining = getHistory().filter((h) => h.resultUrl !== entry.resultUrl);
          try {
            localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(remaining));
          } catch (_err) {
            // Storage blocked — the entry reappears next load; harmless.
          }
          renderResultList();
        });

        const addToCartBtn = card.querySelector('.tryme-tryon__add-to-cart');
        const cartError = card.querySelector('.tryme-tryon__cart-error');
        const viewCartLink = card.querySelector('.tryme-tryon__view-cart');
        if (addToCartBtn) {
          addToCartBtn.addEventListener('click', () =>
            addVariantToCart(addToCartBtn, cartError, viewCartLink),
          );
        }

        const shareBtn = card.querySelector('.tryme-tryon__share');
        const shareFlash = card.querySelector('.tryme-tryon__share-flash');
        if (shareBtn) {
          shareBtn.addEventListener('click', () => shareResult(entry.resultUrl, shareFlash));
        }

        return card;
      }

      function renderResultList() {
        const history = getHistory();
        updateHistoryBadge(history.length);
        if (!resultList) return;
        resultList.innerHTML = '';
        if (resultEmpty) resultEmpty.hidden = history.length > 0;
        for (let i = 0; i < history.length; i++) {
          resultList.appendChild(buildResultCard(history[i]));
        }
      }
  ```

- [ ] **Step 6: Delete `formatHistoryDate` — nothing renders a date anymore (full-size cards match today's Result layout, not the old thumbnail-row metadata)**

  Find:

  ```js
      function formatHistoryDate(timestamp) {
        try {
          return new Date(timestamp).toLocaleDateString(undefined, {
            month: 'short',
            day: 'numeric',
          });
        } catch (_err) {
          return '';
        }
      }

      // navigator.share is absent on desktop Firefox and older Safari. The
  ```

  Replace with:

  ```js
      // navigator.share is absent on desktop Firefox and older Safari. The
  ```

- [ ] **Step 7: Stop opening a second page in `openModal()`**

  Find:

  ```js
      function openModal() {
        trackEvent('button_click');
        modal.hidden = false;
        showPage('main');
        startOver();
      }
  ```

  Replace with:

  ```js
      function openModal() {
        trackEvent('button_click');
        modal.hidden = false;
        startOver();
      }
  ```

- [ ] **Step 8: Drop the `showPage('main')` call in the 402 (try-on unavailable) handler**

  Find:

  ```js
        if (res.status === 402) {
          showPage('main');
          showStep('error');
  ```

  Replace with:

  ```js
        if (res.status === 402) {
          showStep('error');
  ```

- [ ] **Step 9: Update `proceedWithPhoto` to render the feed instead of setting a single image**

  Find:

  ```js
      async function proceedWithPhoto(customerPhotoKey, isReuse) {
        try {
          rememberPhoto(customerPhotoKey);
          const jobResult = await createJob(customerPhotoKey);
          if (jobResult.pending) {
            showPage('main');
            if (jobResult.reason === 'email_required') {
              // Hold the photo key: the retry reuses the same upload (its Redis
              // ownership record lives 600s), so nothing is re-uploaded.
              awaitingEmailForPhotoKey = customerPhotoKey;
              showStep('email');
              return;
            }
            if (jobResult.message) {
              const pendingStep = steps.pending;
              if (pendingStep) pendingStep.querySelector('p').textContent = jobResult.message;
            }
            showStep('pending');
            return;
          }
          const resultUrl = await waitForResult(jobResult.jobId);
          currentResultUrl = resultUrl;
          resetResultActions();
          resultImage.src = resultUrl;
          showPage('main');
          showStep('result');
          trackEvent('result_view');
          addToHistory(resultUrl);
        } catch (err) {
          if (isReuse && err && err.expiredReuse) {
            forgetPhoto();
            showPage('main');
            showStep('upload');
            if (reuseExpiredNote) reuseExpiredNote.hidden = false;
            return;
          }
          showPage('main');
          showStep('error');
        }
      }
  ```

  Replace with:

  ```js
      async function proceedWithPhoto(customerPhotoKey, isReuse) {
        try {
          rememberPhoto(customerPhotoKey);
          const jobResult = await createJob(customerPhotoKey);
          if (jobResult.pending) {
            if (jobResult.reason === 'email_required') {
              // Hold the photo key: the retry reuses the same upload (its Redis
              // ownership record lives 600s), so nothing is re-uploaded.
              awaitingEmailForPhotoKey = customerPhotoKey;
              showStep('email');
              return;
            }
            if (jobResult.message) {
              const pendingStep = steps.pending;
              if (pendingStep) pendingStep.querySelector('p').textContent = jobResult.message;
            }
            showStep('pending');
            return;
          }
          const resultUrl = await waitForResult(jobResult.jobId);
          addToHistory(resultUrl);
          renderResultList();
          showStep('result');
          trackEvent('result_view');
        } catch (err) {
          if (isReuse && err && err.expiredReuse) {
            forgetPhoto();
            showStep('upload');
            if (reuseExpiredNote) reuseExpiredNote.hidden = false;
            return;
          }
          showStep('error');
        }
      }
  ```

  `addToHistory()` unshifts the newest result to the front of the array before `renderResultList()` reads it, so the just-generated photo is always the first card.

- [ ] **Step 10: Drop the `showPage('main')` call in `confirmReady`'s catch block**

  Find:

  ```js
        if (file) {
          showStep('progress');
          try {
            const customerPhotoKey = await uploadPhoto(file);
            await proceedWithPhoto(customerPhotoKey, false);
          } catch (_err) {
            showPage('main');
            showStep('error');
          }
        } else if (reuseKey) {
  ```

  Replace with:

  ```js
        if (file) {
          showStep('progress');
          try {
            const customerPhotoKey = await uploadPhoto(file);
            await proceedWithPhoto(customerPhotoKey, false);
          } catch (_err) {
            showStep('error');
          }
        } else if (reuseKey) {
  ```

- [ ] **Step 11: Point the history button at the merged Result step, delete the back-button listener**

  Find:

  ```js
      button.addEventListener('click', openModal);
      closeBtn.addEventListener('click', closeModal);
      if (ctaBtn) ctaBtn.addEventListener('click', confirmReady);
      if (changePhotoBtn) changePhotoBtn.addEventListener('click', () => fileInput.click());
      if (historyBtn) historyBtn.addEventListener('click', () => showPage('history'));
      if (historyBackBtn) historyBackBtn.addEventListener('click', () => showPage('main'));
      updateHistoryBadge(getHistory().length);
  ```

  Replace with:

  ```js
      button.addEventListener('click', openModal);
      closeBtn.addEventListener('click', closeModal);
      if (ctaBtn) ctaBtn.addEventListener('click', confirmReady);
      if (changePhotoBtn) changePhotoBtn.addEventListener('click', () => fileInput.click());
      if (historyBtn) {
        historyBtn.addEventListener('click', () => {
          renderResultList();
          showStep('result');
        });
      }
      updateHistoryBadge(getHistory().length);
  ```

  This is the "Yes, keep a header entry point" behavior from the design: a shopper can jump straight to every past result without generating a new one, they just land on the same merged Result step instead of a separate History page.

- [ ] **Step 12: Sanity-check there are no leftover references**

  Run:

  ```bash
  grep -n "showPage\|historyBackBtn\|headerHistory\|headerMain\b\|historyList\b\|historyEmpty\b\|renderHistoryList\|resetResultActions\|addCurrentVariantToCart\|formatHistoryDate\|resultImage\b\|currentResultUrl" apps/shopify-extension/extensions/tryon-theme-extension/assets/tryon-widget.js
  ```

  Expected: no output. Any match means a call site was missed in Steps 1–11.

- [ ] **Step 13: Verify the drift test still passes**

  Run: `pnpm --filter @tryme/shopify-admin test -- widget-drift`

  Expected: PASS. This task didn't touch the Liquid file, so this is a regression check, not new coverage — it confirms Task 3 didn't accidentally change any class name Task 1 established.

- [ ] **Step 14: Commit**

  ```bash
  git add apps/shopify-extension/extensions/tryon-theme-extension/assets/tryon-widget.js
  git commit -m "feat(shopify-widget): render results as a per-card feed, remove history page nav"
  ```

---

### Task 4: Manual verification in a dev store

**Files:** none — this task runs the built widget, it doesn't change code. Any bug found gets fixed and committed as a normal follow-up commit before this task is considered done.

There is no automated test that loads `tryon-widget.js` in a browser, so this is the actual regression gate for the feature. Use a Shopify dev store with the `tryon-theme-extension` app block installed on a product page (see `apps/shopify-extension/extensions/tryon-theme-extension/blocks/tryon-button.liquid` header comment for how the block is installed — it's dragged into the product template in the theme editor).

- [ ] **Step 1: Deploy the extension to the dev store**

  ```bash
  cd apps/shopify-extension && shopify app dev
  ```

  (Or `shopify app deploy` to a dev/staging app per your existing workflow — do not deploy to the production app config without first checking the `application_url` drift warning already flagged in `shopify.app.toml`.)

- [ ] **Step 2: Fresh shopper, first try-on**

  Open a product page with the widget in a private/incognito window (no localStorage yet). Click "Try It On" → upload a photo → confirm → wait for generation.

  Expected: lands on the Result step showing exactly one card (the new result), Add to Cart and Share both present and functional, no History icon visible in the header before this point (count was 0), History icon now visible showing badge "1".

- [ ] **Step 3: Second try-on, same session**

  Close the modal, reopen, click "Change Photo" or go through upload again with a different photo, generate again.

  Expected: Result step now shows 2 cards, newest on top, thin divider between them, both independently scrollable in one list, both cards' Add to Cart / Share work independently (clicking one card's Add to Cart doesn't disable or change the other card's button).

- [ ] **Step 4: History icon jumps straight to results without generating**

  Close the modal, reopen (lands on Ready/Upload per the remembered-photo flow). Click the header History icon.

  Expected: jumps directly to the Result step showing both previously generated cards — no separate page, no back button, `Try It On` step flow underneath is untouched (closing and reopening still goes through upload/ready normally).

- [ ] **Step 5: Add to Cart on an older (non-top) card**

  With 2+ cards showing, click Add to Cart on the second (older) card while on the *same* product's page.

  Expected: adds the current page's product variant (per the accepted design decision), button shows "Added ✓", "View cart" link appears under that specific card only — the top card's button is untouched.

- [ ] **Step 6: Empty state**

  Clear `localStorage` for the storefront domain (or open a fresh private window) and confirm the History icon is hidden (count 0), and manually navigating to the Result step is not possible without generating first (there is no way to click into it — this matches Step 2's "no History icon" expectation).

- [ ] **Step 7: Image 404 pruning**

  In devtools, edit one card's `<img>` `src` to a broken URL and reload isn't representative (localStorage persists the real URL) — instead, confirm the existing behavior by inspecting `buildResultCard`'s `img.addEventListener('error', ...)` path: manually corrupt one `resultUrl` in `localStorage.tryme_tryon_history` via devtools console, reopen the modal / click History.

  Expected: the corrupted card's image fails to load, it's silently dropped from the list and from `localStorage`, remaining cards still render correctly.

- [ ] **Step 8: Run the full Shopify admin test suite one more time**

  ```bash
  pnpm --filter @tryme/shopify-admin test
  ```

  Expected: all PASS, confirming the manual QA pass didn't require any Liquid/CSS changes that would re-break the drift test.
