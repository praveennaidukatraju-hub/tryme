# Shopify Funnel Templates — Workflow Routing Design

## Summary

Shopify try-on jobs currently resolve their ComfyUI workflow template from a single `shopify_stores.settings.workflowTemplateId` field — but nothing anywhere writes that field, so every Shopify job dead-ends with a confusing `WIDGET_NOT_CONFIGURED`/`SHOPIFY_INPUTS_MISSING` failure. Separately, a single store-wide workflow is wrong for merchants selling mixed apparel (e.g. shirts and pants need different ComfyUI node wiring), the way the main studio flow already routes by garment subcategory.

This design introduces **funnel templates**: named, admin-curated links from a friendly label (e.g. "Upper Garment") to one of the existing `workflow_templates` rows. Each Shopify store assigns its own products to funnel templates — either manually (per product) or automatically (via rules on `product_type`/`tags`/`vendor`) — giving merchants control over routing without ever touching a raw `workflow_templates` UUID.

Explicitly out of scope for this design: Shopify's newer structured product-category taxonomy (only `product_type`/`tags`/`vendor` are supported condition fields), OR-combined conditions (all conditions within one rule are AND-combined), "most specific rule wins" conflict resolution (merchant-defined priority order instead), and per-variant funnel assignment (funnel assignment is per-product, matching the existing `NO_VARIANT_SENTINEL` product-level convention in `shopify_product_garments`).

---

## Data Model

```sql
-- Global, admin-owned — mirrors workflow_templates' existing ownership model.
-- Merchants only ever see the label; the workflow_template_id link is admin-only.
CREATE TABLE shopify_funnel_templates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE,
  label text NOT NULL,
  workflow_template_id uuid NOT NULL REFERENCES workflow_templates(id),
  is_active boolean NOT NULL DEFAULT true,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Per-store — each store decides Manual vs Automated per funnel template.
CREATE TABLE shopify_funnel_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  store_id uuid NOT NULL REFERENCES shopify_stores(id) ON DELETE CASCADE,
  funnel_template_id uuid NOT NULL REFERENCES shopify_funnel_templates(id) ON DELETE CASCADE,
  mode text NOT NULL DEFAULT 'manual', -- 'manual' | 'automated'
  conditions jsonb NOT NULL DEFAULT '[]', -- [{field, operator, value}], AND-combined, only read when mode='automated'
  priority integer NOT NULL DEFAULT 0, -- lower evaluates first; only meaningful among mode='automated' rows
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (store_id, funnel_template_id)
);

-- Existing table, new columns:
ALTER TABLE shopify_product_garments
  ADD COLUMN funnel_template_id uuid REFERENCES shopify_funnel_templates(id),
  ADD COLUMN funnel_assignment_source text, -- 'manual' | 'automated', null = never assigned
  ADD COLUMN product_type text,
  ADD COLUMN tags text[],
  ADD COLUMN vendor text;
```

`conditions` field shape: `{ field: 'product_type' | 'tags' | 'vendor', operator: 'equals' | 'contains', value: string }[]`. `'equals'` does exact string match (`vendor`/`product_type`) or array-membership (`tags`); `'contains'` does substring match (`product_type`/`vendor`) or array-membership check identical to `'equals'` for `tags` (no separate substring semantics needed for an array field).

Workflow resolution at job-dispatch time becomes a fallback chain:
1. `shopify_product_garments.funnel_template_id` → `shopify_funnel_templates.workflow_template_id`, if set.
2. `shopify_stores.settings.workflowTemplateId` (today's single store-wide field), if set — kept as a safety-net default, not removed.
3. Neither set → job fails immediately with a new `NO_WORKFLOW_CONFIGURED` error code (replacing today's misleading `WIDGET_NOT_CONFIGURED`/`SHOPIFY_INPUTS_MISSING`), refunding credits the same way any other terminal widget-job failure does.

---

## Global Funnel Template Management (`apps/admin-web`)

New CRUD tab (same shape as the existing `workflow_templates`/`garment_subcategories` admin screens): a table listing all funnel templates (label, slug, linked workflow template's label, active, sort order) with Add/Edit actions. The workflow-template picker in the Add/Edit form is a dropdown of active `workflow_templates` rows (any `workflowType`, not filtered to `'tryon'` — admin judgment, matching how other admin screens don't second-guess which workflows are valid to attach). No bulk tooling needed — this list is expected to stay small (single digits to low tens of rows).

Nothing here is code-defined. Creating, renaming, deactivating, or reordering a funnel template, or changing which `workflow_templates` row it points to, is a pure data change through this UI — no deploy required.

---

## Per-Store Rules + Manual Assignment (`apps/shopify`)

**New "Funnel Setup" page**, added as a 4th `AppShell` nav link. Lists every active `shopify_funnel_templates` row for the merchant to configure:

- **Manual mode** (default for a template the store has never configured — inserted lazily as a `shopify_funnel_rules` row on first touch, not pre-created for every store): no rule UI. Products are assigned to this funnel individually via the Products page.
- **Automated mode**: reveals the condition builder — add/remove `(field, operator, value)` rows, AND-combined. A drag handle sets `priority` among the store's other Automated-mode rules.

A **"Re-run rules"** button re-evaluates every product in the store currently at `funnel_assignment_source != 'manual'` against the current rule set (see Resolution Logic). Confirmation dialog before running, since it's a bulk mutation across potentially the whole catalog.

**Products page** gains a "Funnel" column: a dropdown (all active funnel templates, any mode) per product row. Picking one sets `funnel_template_id` + `funnel_assignment_source = 'manual'` directly via a new endpoint — this product is now pinned regardless of what any Automated rule says, until the merchant explicitly picks "Automated" again from that same dropdown (a special option that clears `funnel_assignment_source` back to null and re-evaluates just that one product against current rules immediately).

---

## Resolution Logic

**At sync** (webhook-triggered or manual `POST /v1/shopify/products/sync`): persist `product_type`/`tags`/`vendor` from Shopify's product payload (new fields on the existing sync fetch — `ShopifyProduct` interface in `products.sync.ts` gains these three). Then, if `funnel_assignment_source !== 'manual'`, evaluate the store's Automated-mode `shopify_funnel_rules` rows in `priority` order; the first row whose `conditions` all match (AND) wins — write its `funnel_template_id` and set `funnel_assignment_source = 'automated'`. No match → `funnel_template_id` stays null, falling through to the store-default/error chain at job time.

**Manual assignment** (Products page): sets `funnel_template_id` + `funnel_assignment_source = 'manual'` directly, bypassing rule evaluation entirely. Future syncs and "Re-run rules" both skip this product.

**"Re-run rules"**: same per-product evaluation as sync, batched across every non-manual product in the store.

---

## Error Handling

Job creation/dispatch gets the new `NO_WORKFLOW_CONFIGURED` error code (dispatcher `processShopifyJob`, replacing the current fallthrough into generic-widget error codes) when neither a funnel-resolved nor store-default workflow exists — this is a real, actionable state for the merchant, not an infra bug, so it should be distinguishable in job-history/support tooling from actual ComfyUI/worker failures.

The Shopify Dashboard's Getting Started checklist (built earlier this session) gains a 4th item: "Set up your funnel templates" — done once at least one product in the store has a non-null `funnel_template_id` (mirrors the existing "sync products"/"enable a product" checklist items' done-condition pattern).

---

## Testing Approach

Backend pieces get full TDD, matching every other backend task this session: rule-matching logic (AND-combined, `equals`/`contains`, priority-ordered first-match), sync-time persistence of `product_type`/`tags`/`vendor`, manual-assignment endpoint (source flag set correctly, survives a subsequent sync), "Re-run rules" endpoint (skips manual, honors current priority), and the job-dispatch resolution fallback chain (funnel → store default → `NO_WORKFLOW_CONFIGURED`).

`apps/admin-web` and `apps/shopify` UI pieces stay manual-verification-only — no automated test harness in either app, matching every prior frontend task in this project.

---

## Deferred

- Shopify's structured product-category taxonomy as a condition field (only `product_type`/`tags`/`vendor` for v1).
- OR-combined (or mixed AND/OR) conditions within a single rule.
- "Most specific rule wins" or other conflict-resolution strategies beyond merchant-defined priority order.
- Per-variant funnel assignment (stays product-level, matching the existing `NO_VARIANT_SENTINEL` convention).
- Bulk condition-builder tooling (CSV import/export of rules) if the rule list ever grows large enough to need it.
