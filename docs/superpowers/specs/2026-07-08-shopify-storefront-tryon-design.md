# Shopify Storefront Try-On Widget — Design Spec

## Summary

Storefront-facing piece of the Shopify plugin: a "Try It On" button on the product page that opens a modal, lets a shopper upload their photo, and shows the generated try-on result. Built as a Shopify theme app extension, calling the existing widget job API (`apps/api/src/modules/widget/routes.ts`) that Tasks 1–12 of the backend vertical slice already built and verified against a live Shopify store.

Explicitly out of scope: the embedded Polaris admin app (`apps/shopify/` — dashboard, billing tier selection UI, product mapping), and internal-admin views. Both remain deferred to their own follow-on plans, per the original backend plan's scope note.

---

## Architecture

```
Shopify Storefront (product page)
  +-------------------------------------+
  | tryon-block.liquid                   |
  |  - "Try It On" button                |
  |  - modal (upload / progress / result) |
  |  - reads shop.metafields.tryme.*  |
  |  - reads product.id                  |
  +-------------------+-------------------+
                      | fetch() (cross-origin)
                      v
              apps/api (Fastify)
  +---------------------------------------------+
  | plugins/cors.ts     — now origin-aware       |
  | modules/widget/routes.ts  (existing)         |
  |   POST /v1/widget/presign                    |
  |   POST /v1/widget/jobs                       |
  |   GET  /v1/widget/jobs/:id  (+resultUrl)      |
  | modules/shopify/auth.routes.ts (existing)    |
  |   + write widget_key metafield after install |
  +---------------------------------------------+
                      |
                      v
            Postgres / Redis / R2
```

Nothing in the dispatcher, job-processing, billing, or webhook code changes — this spec only adds a storefront UI and the two small backend prerequisites it depends on.

---

## Prerequisite 1: Dynamic CORS by widget origin

**Problem:** `apps/api/src/server.ts` registers `@fastify/cors` with a single static `origin: env.CORS_ORIGIN` (defaults to `http://localhost:3000`), evaluated once at server boot. `widget-auth.ts` already checks `client.allowedOrigins.includes(origin)` for authorization, but a browser blocks the cross-origin request before that check is ever reached, because the CORS preflight response never varies by origin. This predates the Shopify work — it would already block any non-Shopify merchant embedding the widget on their own site — but it directly blocks this feature, so the fix belongs in this plan.

**Fix:** Change the `origin` option to a function:
- If the request's `Origin` header matches `env.CORS_ORIGIN`, allow (existing app frontend behavior, unchanged).
- Otherwise, look up whether any `widgetClients.allowedOrigins` array contains that origin (`ANY(allowed_origins)` query or equivalent). If found, allow. If not, reject (default `@fastify/cors` behavior — no header set, browser blocks).

This is a plain function, not per-widget-key — it only needs to know "is this origin trusted by *some* widget client," since the actual widget-key authorization still happens in `widget-auth.ts` afterward. No caching needed at this volume; add one only if it becomes a measured bottleneck.

## Prerequisite 2: Write `widget_key` metafield at install

**Where:** `apps/api/src/modules/shopify/auth.routes.ts`, `upsertShopifyStore`'s callback site — right after the store row is created/reactivated (both the first-install and reactivate branches, since a reinstalled store's widgetKey doesn't change but the metafield could be missing if a customer uninstalled and the shop metafield persisted stale/absent).

**How:** One REST call to Shopify's Admin API using the just-obtained access token:
```
POST /admin/api/{SHOPIFY_API_VERSION}/metafields.json
{
  "metafield": {
    "namespace": "tryme",
    "key": "widget_key",
    "value": "<widgetClients.widgetKey>",
    "type": "single_line_text_field"
  }
}
```
Failure here must not fail the install — log and continue (mirrors the existing `shopifyRegisterWebhooks?.()` optional-chaining tolerance for non-critical post-install steps). A store with a missing metafield just means the button silently doesn't render (see Error Handling below) until the merchant reinstalls or an admin re-triggers it — not a broken storefront.

---

## Theme Extension Structure

```
apps/shopify-extension/
  shopify.extension.toml       # type = "theme"
  blocks/
    tryon-block.liquid          # button + modal skeleton
  assets/
    tryon-widget.js             # all client-side behavior
    tryon-widget.css            # modal styling
  locales/
    en.default.json             # button/modal copy
```

Scaffolded and deployed via Shopify CLI (`shopify app generate extension`, `shopify app deploy`) — not a plain file-write-and-commit like the backend tasks. The extension attaches to the same Partner app created earlier this session.

**Block schema:** minimal — `name` and `target: "section"` only. No merchant-configurable settings; the widget key and product ID come from Liquid globals (`shop.metafields.tryme.widget_key`, `product.id`), not merchant input. Setup is "add block in theme editor," nothing else.

**If the metafield is empty/missing:** the block renders nothing (no button). A broken/invisible feature is preferable to a button that always errors.

---

## Modal Flow

1. **Click "Try It On"** → JS shows the modal (CSS class toggle, already in the DOM, hidden by default).
2. **Upload step** → file input (client-side validation: image mime type, ≤5MB, matching the existing widget backend's own limit) → on valid selection:
   - `POST /v1/widget/presign` with `x-widget-key` header (from the metafield) → `{ uploadUrl, r2Key, expiresIn }`
   - `PUT` the file directly to `uploadUrl`
   - Modal switches to a "Generating..." state
3. **Create job** → `POST /v1/widget/jobs` with `x-widget-key` header, body `{ shopifyProductId: <product.id>, customerPhotoKey: r2Key }`:
   - `201 { jobId }` → begin polling
   - `202` → show "We're preparing this product for try-on — check back in a moment" and stop (Task 9's not-yet-synced path; no job exists to poll)
   - Any error status → show the generic failure message (step 5)
4. **Poll** → `GET /v1/widget/jobs/:jobId` with `x-widget-key` header every 2s, capped at 60 attempts (~2 minutes):
   - `status: COMPLETED` → render `resultUrl` (new field on this endpoint's response, see below) as an image in the modal
   - `status: FAILED` → generic failure message; never surface `errorCode` to shoppers
   - attempts exhausted → same generic failure message ("this is taking longer than expected, please try again shortly")
5. **Generic failure message** → "Something went wrong. Please try again." plus a retry button that resets to step 2. No internal error text, codes, or stack details ever reach the shopper.
6. **Close / retry** → modal has a close (×) and a "Try another photo" button (resets to step 2) once a result or failure is shown.

**Backend addition required:** `GET /v1/widget/jobs/:id`'s response gains a `resultUrl` field — `app.storage.publicUrl(resultKey)` computed server-side when `resultKey` is present — so the widget never needs to know the R2/MinIO bucket layout or construct URLs itself.

---

## Testing Approach

This extension cannot be covered by the existing Vitest suite — it has no server-side logic of its own (pure Liquid + client-side JS calling already-tested backend endpoints). Verification is manual, mirroring how the backend itself was live-tested this session:

1. `shopify app dev` (or deploy a new extension version) → add the block to the product template in the theme editor on the already-installed dev store.
2. Manual pass through the modal flow end-to-end against the real dev store: upload → job creation → poll → result.
3. Manual edge cases: unsynced product (202 path), oversized/invalid file (client-side rejection), a deliberately failed job (e.g. temporarily misconfigured `workflowTemplateId`) to confirm the generic failure message and no leaked internals.

The two backend prerequisites (CORS function, metafield write, `resultUrl` field) DO get Vitest coverage, same TDD discipline as the rest of the backend — only the Liquid/JS layer itself is manually verified.

---

## Deferred (unchanged from the original backend plan)

- `apps/shopify/` — Polaris embedded admin (dashboard, billing tier selection, product mapping UI)
- `apps/admin-web` / `apps/admin-mobile` — internal admin views for Shopify stores/plans
- Real ComfyUI workflow template for Shopify try-on (still needed before any job can actually complete end-to-end in production — jobs will fail-fast-and-refund without one, per existing Task 10 operational note)
