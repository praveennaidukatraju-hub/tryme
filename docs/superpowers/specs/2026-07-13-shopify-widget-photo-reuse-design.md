# Shopify Storefront Widget — Photo Reuse — Design Spec

## Summary

Today the storefront try-on widget (`apps/shopify-extension/extensions/tryon-theme-extension`) forces a shopper to upload a fresh photo every single time, even if they just tried on a different product a minute ago. This spec lets a shopper's browser remember their last uploaded photo (per store) and reuse it for a new product's try-on without re-uploading, while still offering "upload a new photo" (a different pose/angle) as an equally-visible choice on the same screen.

There is no shopper account/login anywhere in this system — Shopify storefront visitors are anonymous to the API, and billing already flows through the merchant's own TryMe account (`shopifyStores.ownerUserId`), not an individual customer. So "reuse" is scoped to **the shopper's browser on this store's storefront domain**, not a durable per-customer identity. It disappears if they clear their browser data or switch devices — that's an accepted trade-off, not a gap to fix here.

Explicitly out of scope: multi-photo batch upload (uploading several photos in one step to get several results at once), any actual shopper login/account system, and any change to dispatcher/job-processing logic — a reused photo produces a job identical in every way to a freshly-uploaded one.

---

## Architecture

```
Shopify Storefront (product page)
  +---------------------------------------------+
  | tryon-block.liquid / tryon-widget.js          |
  |  - checks localStorage for a remembered photo |
  |  - shows "Use this photo" + thumbnail,        |
  |    or falls back to today's plain upload UI   |
  +---------------------+-------------------------+
                        | fetch() (cross-origin, x-widget-key)
                        v
                apps/api (Fastify)
  +----------------------------------------------------+
  | modules/shopify/customer.routes.ts                  |
  |   POST /v1/shopify/customer/presign     (existing)   |
  |   POST /v1/shopify/customer/photo/preview  (NEW)     |
  |   POST /v1/shopify/customer/jobs         (existing,   |
  |         now extends the Redis ownership TTL to 24h   |
  |         on success)                                  |
  +----------------------------------------------------+
                        |
                        v
              Redis (ownership TTL) / R2 or MinIO
```

Nothing in the dispatcher, credit billing, or job schema changes. This is a widget UI + two small backend touch-points.

---

## Backend changes

### 1. Extend the ownership window on successful job creation

`apps/api/src/modules/shopify/customer.routes.ts`, in `POST /v1/shopify/customer/jobs`: the `shopify:upload:${key}` Redis marker is currently set with `EX 600` at presign time (`customer.routes.ts:96`) and never touched again — it's meant to bound "use this within the presigned URL's own lifetime." After the job's transaction commits successfully (right before the `XADD`/`return reply.code(201)`), re-set that same key to `EX 86400` (24h). This is the only thing that currently prevents reuse — the R2/MinIO object itself is already kept indefinitely (no lifecycle policy exists today, confirmed by objects from prior sessions still present in the bucket).

Extending is idempotent: reusing the same photo for a second, third, etc. product each re-extends the 24h window from that point, so an actively-shopping visitor's photo doesn't expire mid-session.

### 2. New endpoint: thumbnail preview URL

```
POST /v1/shopify/customer/photo/preview
Headers: x-widget-key
Body: { r2Key: string }
Response: { previewUrl: string, expiresIn: number }
```

Guarded by the same `requireShopifyStoreKey` preHandler and `checkRateLimit` as the sibling routes. Validates, in order:
1. `r2Key` starts with `shopify-inputs/${storeId}/` — same ownership-prefix check already used in the jobs route.
2. `shopify:upload:${r2Key}` Redis marker exists and equals this `storeId` — the exact same check that gates job creation, so there is one single source of truth for "is this photo still reusable," not two independently-maintained rules.

If both pass, calls the existing `storage.presignGet(r2Key, 300)` (5 minutes — just long enough to load one `<img>`) and returns the URL. If either check fails: `404 NOT_FOUND` ("photo not available") — the widget treats this as "no reusable photo," not as an error to surface.

No new endpoint is needed for reuse itself — `/v1/shopify/customer/jobs` already accepts `customerPhotoKey` as a plain string with no requirement that it came from a presign call in the current request cycle.

---

## Widget UI flow

`tryon-block.liquid`'s existing `.tryme-tryon__step--upload` step gains a conditional sub-view, not a new step:

- **On modal open**, the widget reads `localStorage` for `{ r2Key, uploadedAt }`. If present and `Date.now() - uploadedAt < 24h`, it fires `POST /v1/shopify/customer/photo/preview` in the background.
  - On success: show a small reuse panel — thumbnail (`previewUrl`), a **"Use this photo"** button, and a quiet **"Not you? Remove"** link — positioned above the existing file-picker, which remains visible either way as the "upload a new photo" option.
  - On failure, absence, or expiry: show today's plain upload UI, unchanged. No error is surfaced for this case — it's a convenience feature quietly not being offered, not a broken feature.
- **"Use this photo"** skips `presignPut`/`PUT` entirely and calls `createJob(rememberedKey)` directly, then follows the identical progress → result/error flow as a fresh upload. The current `handleFile`'s post-upload logic (`createJob` → `waitForResult` → render result) is factored into a shared `proceedWithPhoto(key)` helper so both paths — fresh upload and reuse — drive through the same, already-working job/polling code with zero duplication.
- **After a successful fresh upload**, the widget writes `{ r2Key, uploadedAt: Date.now() }` to `localStorage`, overwriting whatever was previously remembered. That upload becomes the new "last photo" for next time, on this store's storefront domain.
- **"Not you? Remove"** clears the localStorage entry and re-renders the plain upload view. No server call, and deliberately so — it doesn't revoke the Redis ownership marker server-side. The photo is already scoped by store prefix and a widget key that's never exposed as a guessable/shareable link, and the marker expires on its own within 24h regardless; explicit server-side revocation would add a call for a case ("someone else uses this browser and undoes the remove") that isn't a real threat model here.
- **If `createJob` 403s** on a reused key (server-side window expired despite the client's own 24h check passing — e.g. clock skew), the widget clears localStorage and falls back to the plain upload view with a small inline note, rather than the generic error step used for actual job failures.

No new build tooling, dependencies, or frameworks — same vanilla JS/Liquid/CSS pattern the widget already uses throughout.

---

## Error handling summary

| Scenario | Behavior |
|---|---|
| No remembered photo (first visit, or cleared) | Plain upload UI, unchanged from today |
| Remembered photo, preview-url call fails/404s | Treated as "none remembered" — plain upload UI, no error shown |
| Remembered photo, reuse job-creation 403s (expired server-side) | Clear localStorage, fall back to upload UI with a small inline note |
| Remembered photo, reuse job-creation succeeds | Identical progress/result/error flow as a fresh upload |
| Fresh upload succeeds | Overwrites the remembered photo for next time |

---

## Testing

- **Backend** (`apps/api/test/integration/shopify-customer.test.ts`, extending the existing presign → jobs → job-status coverage):
  - `POST /v1/shopify/customer/photo/preview` returns a presigned URL for a key owned by this store within the window.
  - Returns 404 for a key belonging to a different store (prefix mismatch).
  - Returns 404 for a key whose Redis ownership marker has expired or never existed.
  - After a successful `POST /v1/shopify/customer/jobs`, assert (via `redis.ttl()`) that the ownership marker's TTL is now ~86400s, not the original ~600s.
  - A second job-creation call reusing the same `customerPhotoKey` (simulating "different product, same photo") succeeds and re-extends the TTL.
- **Widget JS** (no existing automated test harness for `tryon-widget.js` — it's untested vanilla JS today, consistent with the rest of the theme extension): manually verified against the local dev tunnel setup — upload once, reload the product page, confirm the reuse panel appears with the correct thumbnail, click "Use this photo," confirm a job completes end-to-end; verify "Not you? Remove"; verify the expired-marker fallback by deleting the Redis key mid-test.
- No dispatcher-side testing needed — job processing is identical regardless of whether the input photo is fresh or reused.
