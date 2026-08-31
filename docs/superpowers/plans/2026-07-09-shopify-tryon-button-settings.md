# Shopify Try-On Button — Customizable Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give merchants a theme-editor settings panel (promo text, button text, text color, button color, border radius) for the "Try It On" app-embed button, instead of the current hardcoded copy/styling.

**Architecture:** Add five new fields to the block's `{% schema %}`. Thread `block.settings.*` into the existing markup (button text, optional promo text) and into inline CSS custom properties on the widget root `<div>` (colors, radius). `tryon-widget.css` consumes those custom properties via `var(...)`. No JS changes — the upload/poll/result flow in `tryon-widget.js` is untouched.

**Tech Stack:** Shopify theme app extension (Liquid + CSS), `shopify app deploy` (Shopify CLI 4.4.0).

## Global Constraints

- **No JS changes** — `assets/tryon-widget.js` is untouched; this is a pure Liquid + CSS change.
- **Empty `promo_text` means hidden** — no separate on/off checkbox, matching this session's approved design.
- **Defaults:** `button_text` = `"Try It On"`, `text_color` = `#FFFFFF`, `button_color` = `#000000`, `border_radius` = `4`.
- **No automated test harness** for this extension (matches the rest of `apps/shopify-extension/` — Liquid isn't part of the Vitest suite). Verification is `shopify app deploy` succeeding (theme-check clean) plus manual check in the theme editor.

---

## File Structure

**Modify:**
- `apps/shopify-extension/extensions/tryon-theme-extension/blocks/tryon-block.liquid` — schema settings + markup wiring
- `apps/shopify-extension/extensions/tryon-theme-extension/assets/tryon-widget.css` — button styling driven by CSS custom properties

---

## Task 1: Add customizable settings to the Try-On button

**Files:**
- Modify: `apps/shopify-extension/extensions/tryon-theme-extension/blocks/tryon-block.liquid`
- Modify: `apps/shopify-extension/extensions/tryon-theme-extension/assets/tryon-widget.css`

**Interfaces:**
- Consumes: nothing new — same `shop.metafields.tryme.widget_key` / `product` guards already in the file.
- Produces: nothing consumed by other tasks — this is the only task in this plan.

- [ ] **Step 1: Replace the block file with the settings-driven version**

Replace `apps/shopify-extension/extensions/tryon-theme-extension/blocks/tryon-block.liquid` with:

```liquid
{% comment %}
  Renders a "Try It On" button + upload modal for the current product.
  App-embed target: injected on every page by Shopify once the merchant
  toggles it on under Theme editor -> App embeds (no per-template block
  placement needed). Only renders on product pages (`product` is blank
  everywhere else) and only once the widget_key metafield exists (install
  incomplete, or metafield write failed) — a missing/broken button is
  safer on a live storefront than one that always errors.
{% endcomment %}

{%- assign widget_key = shop.metafields.tryme.widget_key -%}
{%- if product != blank and widget_key != blank -%}
  <div
    class="tryme-tryon"
    data-widget-key="{{ widget_key }}"
    data-product-id="{{ product.id }}"
    data-api-base="{{ block.settings.api_base | default: 'https://api.tryme.com' }}"
    style="--tryme-button-color: {{ block.settings.button_color }}; --tryme-text-color: {{ block.settings.text_color }}; --tryme-border-radius: {{ block.settings.border_radius }}px;"
  >
    {%- if block.settings.promo_text != blank -%}
      <p class="tryme-tryon__promo">{{ block.settings.promo_text }}</p>
    {%- endif -%}

    <button type="button" class="tryme-tryon__button">
      {{ block.settings.button_text | default: 'Try It On' }}
    </button>

    <div class="tryme-tryon__modal" hidden>
      <div class="tryme-tryon__modal-content">
        <button type="button" class="tryme-tryon__close" aria-label="Close">&times;</button>

        <div class="tryme-tryon__step tryme-tryon__step--upload">
          <p>{{ 'tryon.upload_prompt' | t }}</p>
          <input type="file" accept="image/*" class="tryme-tryon__file-input" />
        </div>

        <div class="tryme-tryon__step tryme-tryon__step--progress" hidden>
          <p>{{ 'tryon.generating' | t }}</p>
        </div>

        <div class="tryme-tryon__step tryme-tryon__step--pending" hidden>
          <p>{{ 'tryon.pending' | t }}</p>
        </div>

        <div class="tryme-tryon__step tryme-tryon__step--result" hidden>
          <img class="tryme-tryon__result-image" alt="{{ 'tryon.result_alt' | t }}" />
          <button type="button" class="tryme-tryon__retry">
            {{ 'tryon.try_another' | t }}
          </button>
        </div>

        <div class="tryme-tryon__step tryme-tryon__step--error" hidden>
          <p>{{ 'tryon.error' | t }}</p>
          <button type="button" class="tryme-tryon__retry">
            {{ 'tryon.try_again' | t }}
          </button>
        </div>
      </div>
    </div>
  </div>

  {{ 'tryon-widget.css' | asset_url | stylesheet_tag }}
  <script src="{{ 'tryon-widget.js' | asset_url }}" defer></script>
{%- endif -%}

{% schema %}
{
  "name": "Try It On",
  "target": "body",
  "settings": [
    {
      "type": "text",
      "id": "api_base",
      "label": "API base URL",
      "default": "https://api.tryme.com"
    },
    {
      "type": "text",
      "id": "promo_text",
      "label": "Promotional text above button",
      "default": ""
    },
    {
      "type": "text",
      "id": "button_text",
      "label": "Button text",
      "default": "Try It On"
    },
    {
      "type": "color",
      "id": "text_color",
      "label": "Text color",
      "default": "#FFFFFF"
    },
    {
      "type": "color",
      "id": "button_color",
      "label": "Button color",
      "default": "#000000"
    },
    {
      "type": "range",
      "id": "border_radius",
      "label": "Border radius",
      "min": 0,
      "max": 20,
      "step": 1,
      "unit": "px",
      "default": 4
    }
  ]
}
{% endschema %}
```

Only the `style` attribute, the `promo_text` block, the `button_text` interpolation, and the five new schema settings are additions — the modal markup, locale keys, and existing `api_base` setting are unchanged.

- [ ] **Step 2: Add button styling driven by the new CSS custom properties**

In `apps/shopify-extension/extensions/tryon-theme-extension/assets/tryon-widget.css`, append:

```css
.tryme-tryon__promo {
  margin: 0 0 8px;
  font-size: 14px;
}

.tryme-tryon__button {
  background: var(--tryme-button-color, #000000);
  color: var(--tryme-text-color, #ffffff);
  border: none;
  border-radius: var(--tryme-border-radius, 4px);
  padding: 10px 20px;
  font-size: 14px;
  cursor: pointer;
}
```

- [ ] **Step 3: Deploy and verify theme-check passes**

Run (from `apps/shopify-extension/`):
```bash
cd apps/shopify-extension
npx shopify app deploy
```
Expected: "Release a new version of TryMe?" → confirm yes. Theme check may print the pre-existing `ImgWidthAndHeight` warning (unrelated, non-blocking) but must not print any new errors. Ends with "New version released to users."

- [ ] **Step 4: Manual verification against the real dev store**

No automated test applies. Verification:
1. In the dev store's theme editor → App embeds → "Try It On" → confirm the settings panel now shows: Promotional text, Button text, Text color, Button color, Border radius (in addition to the existing API base URL field).
2. Change button color and border radius to non-default values, save, and open a product page — confirm the live button reflects the new color/radius.
3. Type text into "Promotional text" — confirm it appears above the button; clear it — confirm it disappears.
4. Confirm the existing upload → generate → result flow still works end-to-end (this task didn't touch `tryon-widget.js`, but confirm no regression).

- [ ] **Step 5: Commit**

```bash
git add apps/shopify-extension/extensions/tryon-theme-extension/blocks/tryon-block.liquid apps/shopify-extension/extensions/tryon-theme-extension/assets/tryon-widget.css
git commit -m "feat(shopify-extension): customizable try-on button settings (text, colors, radius)"
```

---

## Task 2: Selector-driven button placement

**Context:** Shopify always injects a `target: "body"` block right before `</body>`, regardless of theme-editor position — there's no drag-to-place UI for app embeds. Antla's own `settings_data.json` (merchant-provided reference) confirms their block is also `target: "body"`, and it reads `general_block_selector` (default `.product-form`) + `block_alignment` settings, then uses JS to move the button element into that DOM location on load. This task adds the same mechanism so the button appears inline near the Buy button instead of floating at the page bottom.

**Files:**
- Modify: `apps/shopify-extension/extensions/tryon-theme-extension/blocks/tryon-block.liquid`
- Modify: `apps/shopify-extension/extensions/tryon-theme-extension/assets/tryon-widget.js`

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing consumed by other tasks — last task of this plan.

- [ ] **Step 1: Add placement settings + data attributes**

In `apps/shopify-extension/extensions/tryon-theme-extension/blocks/tryon-block.liquid`, add two data attributes to the root `<div>` (after the existing `style` attribute):

```liquid
    data-placement-selector="{{ block.settings.placement_selector }}"
    data-block-alignment="{{ block.settings.block_alignment }}"
```

And add two settings to the `{% schema %}` block's `"settings"` array (after `border_radius`):

```json
    {
      "type": "text",
      "id": "placement_selector",
      "label": "Insert button at CSS selector",
      "info": "By default the button is placed near the Buy button. If it doesn't appear in the right spot on your theme, enter a different CSS selector here.",
      "default": ".product-form"
    },
    {
      "type": "select",
      "id": "block_alignment",
      "label": "Position within that element",
      "options": [
        { "value": "start", "label": "Start" },
        { "value": "end", "label": "End" }
      ],
      "default": "start"
    }
```

- [ ] **Step 2: Move the button on load in `tryon-widget.js`**

In `apps/shopify-extension/extensions/tryon-theme-extension/assets/tryon-widget.js`, add a `placeWidget` function and call it before `initWidget` in the bottom `forEach`:

```js
function placeWidget(root) {
  const selector = root.dataset.placementSelector;
  if (!selector) return;
  const target = document.querySelector(selector);
  if (!target) return;
  if (root.dataset.blockAlignment === 'end') {
    target.appendChild(root);
  } else {
    target.insertBefore(root, target.firstChild);
  }
}
```

Replace the final line:
```js
  document.querySelectorAll('.tryme-tryon').forEach(initWidget);
```
with:
```js
  document.querySelectorAll('.tryme-tryon').forEach((root) => {
    placeWidget(root);
    initWidget(root);
  });
```

`placeWidget` runs first so `initWidget`'s `root.querySelector(...)` calls for the button/modal/etc. still work — moving a DOM node preserves its children and event-listener-free state, so calling `initWidget` after the move is safe either way, but placing first matches the natural reading order.

- [ ] **Step 3: Deploy and verify theme-check passes**

Run (from `apps/shopify-extension/`):
```bash
cd apps/shopify-extension
npx shopify app deploy
```
Expected: confirm "Yes, release this new version" → ends with "New version released to users." No new theme-check errors beyond the pre-existing `ImgWidthAndHeight` warning.

- [ ] **Step 4: Manual verification against the real dev store**

No automated test applies. Verification:
1. In the theme editor → App embeds → "Try It On", confirm two new fields appear: "Insert button at CSS selector" (default `.product-form`) and "Position within that element" (Start/End).
2. Open a real product page — confirm the button now renders inline near the Buy button, not floating at the bottom of the page.
3. If it doesn't appear in the right spot (selector mismatch for this theme), change the selector field to match this theme's actual buy-button wrapper class and confirm the button moves.
4. Confirm the upload → generate → result modal still opens and works from the new position (moving the container preserves the `position: fixed` modal overlay behavior).

- [ ] **Step 5: Commit**

```bash
git add apps/shopify-extension/extensions/tryon-theme-extension/blocks/tryon-block.liquid apps/shopify-extension/extensions/tryon-theme-extension/assets/tryon-widget.js
git commit -m "feat(shopify-extension): selector-driven button placement (matches Antla's technique)"
```
