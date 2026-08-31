# Shopify Product Catalog Generation — Design Spec

**Date:** 2026-07-18
**Status:** Approved (pending user review of this doc)
**Branch:** `feat/shopify-product-catalog-generation`

## Problem

Merchants can currently install the TryMe try-on widget on their storefront
(customer uploads their own photo, wears the garment). There's no way for a
*merchant* to generate professional catalog photos (an AI model wearing the
product, in a chosen background/pose) directly from Shopify — they'd have to
leave Shopify admin, go to the separate `apps/catalogues-web` studio, run the
wizard there, download the result, and manually re-upload it to the product.

## Goal

Add a "Generate catalog images" action on the Shopify product page (both add
and edit) that:
1. Uses one of the product's own images as the garment.
2. Lets the merchant pick garment type, model face, background(s)/pose(s)
   (multi-select, batch), and lower/shoe items where applicable — same input
   shape as the existing studio wizard.
3. Shows generated results inline for approval.
4. On approval, attaches the chosen image(s) directly to the product's media
   gallery in Shopify.

## Non-goals

- No change to the existing storefront widget (`processShopifyJob`, customer
  own-photo try-on) — architecturally unrelated, not touched by this work.
- No automatic/unattended publishing — every generated image requires an
  explicit merchant approval before it touches product media.
- No cross-product garment reuse in v1 — garment source is always an image
  from the product being edited.

## Architecture overview

Reuses the existing Studio job pipeline end-to-end rather than building a
parallel one:

```
Shopify product page
  → Admin UI Extension block ("Generate catalog images" button)
    → Modal (src=) iframes a new page in apps/shopify (Vite SPA, App Bridge session-token auth)
      → new page: garment-type/face/background/pose/lower/shoe picker (ported from studio's step UI)
      → POST /v1/shopify/catalog/generate
          → resolves store.ownerUserId, pulls the picked product image into R2
          → calls createJob() (same function studio's /v1/jobs/tryon route calls)
          → same dispatcher path as every other studio job (no dispatcher changes)
      → poll GET /v1/shopify/catalog/jobs?catalogueId= for status + preview
      → POST /v1/shopify/catalog/jobs/:id/publish on approval
          → Shopify Admin GraphQL productCreateMedia
```

## 1. Extension surface

New extension target (`admin.product-details.block.render`) added alongside
the existing `tryon-theme-extension` in `apps/shopify-extension/extensions/`.
Built with Shopify's Admin UI Extension component API (Preact-based sandbox —
no raw DOM/iframe access inline). The block itself is minimal: a button that
opens a `Modal` component with `src` pointing at a new route in the existing
embedded `apps/shopify` app, passing `shopifyProductId` (and, once saved, the
product's current images) as query params.

**Open question / spike:** whether `admin.product-details.block.render`
(and the `Modal src=` action) is available on the *unsaved* "Add product"
page, or only after the product has a real ID. If unavailable pre-save, the
block shows a "save the product first" state on the add page — this doesn't
change the architecture, just gates when the button is enabled. Verify during
implementation.

## 2. Frontend — new page in `apps/shopify`

New page, e.g. `apps/shopify/src/pages/CatalogGeneratePage.tsx`, in the
existing Shopify-embedded React SPA (not `apps/catalogues-web` — that app
uses cookie/BFF auth, incompatible with the App Bridge session-token model
this page needs, and Shopify's embedding rules expect the iframe to be
served from the app's own registered domain).

Step UI (garment type → face → background/pose multi-select → lower/shoe)
is **ported** from studio's step components — same UX and validation logic
(`hasLower`/`hasShoes` conditional display), reimplemented in this app's
stack (Vite SPA vs. Next.js App Router — not a literal import). Garment
upload step is replaced with a product-image picker (list of the product's
existing Shopify images).

On submit: calls `/v1/shopify/catalog/generate`, then polls
`/v1/shopify/catalog/jobs?catalogueId=` and renders per-look preview cards
with "Add to product" / "Discard" once each job completes — no redirect to
any `/catalogues/:id` view (that's the studio wizard's own destination for
a different, unrelated flow).

## 3. Backend — new route module

`apps/api/src/modules/shopify/catalog.routes.ts`, all routes behind
`app.requireShopifySession` (same session-token pattern as
`funnel.routes.ts`/`products.routes.ts`):

- `GET /v1/shopify/catalog/options` — garment-types/faces/backgrounds/poses,
  thin wrapper around the existing `/v1/models/*` resolvers.
- `POST /v1/shopify/catalog/generate` — body:
  `{shopifyProductId, sourceImageUrl, faceId, garmentTypeId, looks[], lowerCatalogId?, shoeCatalogId?}`.
  See §4/§5.
- `GET /v1/shopify/catalog/jobs?catalogueId=` — status + preview URLs for
  each job in the batch, scoped to the session store via
  `shopify_catalog_jobs` (§6).
- `POST /v1/shopify/catalog/jobs/:id/publish` — see §7.

## 4. Garment source resolution

`POST /v1/shopify/catalog/generate` receives `sourceImageUrl` (Shopify CDN
URL of the product image the merchant picked from *that product's own
media*). The server fetches those bytes and `putObject`s them into R2 under
a fresh key (`shopify-catalog-garments/{storeId}/{shopifyProductId}/{uuid}.jpg`).

## 5. Job creation — reuse `createJob`

Resolves `store.ownerUserId` as the acting `userId` (same
store→owner-credits precedent already established in
`customer.routes.ts`'s `requireStoreOwnerWithCredits`), then calls the
existing `createJob()` (`apps/api/src/modules/jobs/create.ts` — the same
function the studio wizard's `/v1/jobs/tryon` route calls) directly:

```ts
createJob(app, store.ownerUserId, {
  inputs: { faceId, garmentTypeId, upperGarmentKey: r2Key, looks, lowerCatalogId, shoeCatalogId },
  ...
}, { trustedGarmentKeys: new Set([r2Key]) })
```

`trustedGarmentKeys` bypasses the presign-ownership check (`assertOwnsUploadKey`)
since this key never went through the normal upload flow — same bypass
pattern already used for saree-mannequin/regeneration flows
(`resolveMannequinGarmentKey`, `opts.trustedGarmentKeys` in `create.ts`).

This gets native batch support (`looks[]`), resolution-based credit cost
(already distinct from the storefront widget's flat `SHOPIFY_JOB_COST`),
watermark/priority handling, and lower/shoe validation for free — no
dispatcher changes required, this runs through the exact same worker path
as every other studio job.

## 6. Data model

New table `shopify_catalog_jobs`:

| Column | Type | Notes |
|---|---|---|
| `job_id` | uuid, PK, FK → `jobs.id` | one row per generated look |
| `store_id` | uuid, FK → `shopify_stores.id` | |
| `shopify_product_id` | bigint | |
| `source_image_url` | text | which product image was used as garment (audit) |
| `shopify_media_id` | text, nullable | Shopify's media GID once published — doubles as the idempotency guard |
| `published_at` | timestamp, nullable | |
| `created_at` | timestamp | |

Inserted right after `createJob` returns each `jobId`. Kept as a separate
table (not new columns on `jobs`) to avoid touching the shared `createJob`
function's signature/insert, which every other job-creation caller depends
on.

## 7. Publish flow

`POST /v1/shopify/catalog/jobs/:id/publish`:

1. Look up the `shopify_catalog_jobs` row, verify `store_id` matches the
   session store.
2. If `shopify_media_id` already set → return it as-is (idempotent, no
   duplicate media on a double-click).
3. Verify the job's `status === 'COMPLETED'`, else 409.
4. `presignGet` the job's output R2 key (`keys.output(jobId)`) for a
   short-lived signed URL.
5. Call Shopify Admin GraphQL `productCreateMedia(productId, media: [{originalSource: signedUrl, mediaContentType: IMAGE}])`
   using the store's decrypted access token.
6. Store the returned media GID + `published_at`, return `{ok, mediaId}`.

## 8. Scopes / reauth

Requires `write_products`, which no installed store currently has
(`SHOPIFY_SCOPES=read_products` only). Changes needed:
- `SHOPIFY_SCOPES` env → `read_products,write_products`
- `access_scopes.scopes` in both `apps/shopify-extension/shopify.app.toml`
  and `shopify.app.dev.toml` → `"read_products,write_products"`

Existing installed stores won't have the new scope automatically. First
publish attempt against a store that hasn't re-consented will fail with a
Shopify 403 — catch that specifically and surface "reconnect the app to
grant additional permissions," linking to the existing `/v1/shopify/auth?shop=...`
reauth redirect (already-existing infra, not new).

## 9. Error handling

- **Generate**: reuses `createJob`'s existing validation errors
  (`VALIDATION`/`BAD_CATALOG`) and 402 insufficient-credits response as-is —
  no new error paths to design.
- **Publish**: 409 if job not yet completed; idempotent 200-with-existing-id
  if already published; 403→reauth-link on missing scope; 502 on other
  Shopify API failures (no credit re-charge on retry — credits were spent on
  generation, which already succeeded; publish failure is a separate,
  retryable concern).

## Testing

- Integration tests (`apps/api/test/integration/`) for `generate` (happy
  path, insufficient credits, invalid/inactive garment type or pose) and
  `publish` (happy path, already-published idempotency, missing-scope
  simulation).
- Extension + `apps/shopify` frontend: manual QA against a real dev store —
  not covered by Vitest, same as the rest of the Shopify extension surface.

## Open risks / things to verify during implementation

1. Whether the Admin UI Extension block/Modal is available on the unsaved
   "Add product" page (§1) — gates button-enabled state, not the
   architecture.
2. Exact CSP/frame-ancestors requirements Shopify imposes on `Modal src=`
   iframe targets — confirm `apps/shopify`'s registered `application_url`
   satisfies them without extra config.
3. Re-auth UX for already-installed stores hitting the new `write_products`
   requirement on first publish — confirm the existing `/v1/shopify/auth`
   flow correctly requests the *combined* scope set (not just the delta) on
   re-consent.
