# Saree Catalogue Android — Backend Cutover Design

## Context

`apps/saree_catalogue_android` is a legacy merchant-facing Android app: a merchant logs in, browses their saree product catalog, captures/uploads a flat saree photo, generates a draped preview image against an admin-chosen drape style ("pallu type"), and finalizes it as a priced catalog product with SKU. A second flow lets an in-store customer try on an existing catalog product against their own photo.

Today it talks to a standalone legacy backend at `https://api.tryme.com/` — a completely different system from this monorepo's `apps/api`, authenticated with a hardcoded shared-secret header plus a per-user `api_key` bearer token with no refresh, and no relationship to `merchant_catalog_items`/`merchant_catalog_subcategories` (this repo's actual merchant inventory tables, already rendered in `apps/catalogues-web`'s catalogue-manager under Women → Sarees).

This is a **full cutover**: retire the legacy backend connection for this app entirely, replace it with `apps/api`'s existing `/v1/auth/device-*` and `/v1/merchant/*` routes — no dual-backend adapter, no fallback path. Every endpoint this app needs already exists; this is a client rewrite, not new backend work.

A sibling Android app, `apps/virtual-tryon-mobile&kiosk_latest`, already solved "Android device talks to this merchant backend" in production. Its `ApiUtils/APICaller.kt` (coroutines, sealed `ApiException`, mutex-guarded refresh-on-401) and `utils/PrefsManager.kt` (`EncryptedSharedPreferences` token storage) are the proven reference implementation this cutover mirrors.

## Architecture

### Auth

`POST /v1/auth/device-login` (`DeviceLoginBody` = `{email, password, deviceId, deviceName?, platform}`, `apps/api/src/modules/auth/routes.ts:607`) replaces the legacy `app_loginnew` + static-secret scheme. Response: `{accessToken, refreshToken, user: {id, email, displayName, tier, maxActiveDevices}}` (`deviceLoginUserPayload()`, `routes.ts:258`).

- `deviceId` = `Settings.Secure.ANDROID_ID` (already fetched this way in the legacy `LoginActivity`/`ProfileActivity` — reused as-is).
- `platform` = `"mobile"` (this is not a kiosk device).
- A 409 `DEVICE_LIMIT_REACHED` response (merchant already logged in on `maxActiveDevices` other devices) is surfaced as a plain error message. No "force logout other device" UI is built — that's the sibling app's `device-login/force` flow, out of scope here (add later if product asks; the legacy app never had a device-limit concept at all, so this is a net-new constraint being accepted, not a regression).
- Token refresh: `POST /v1/auth/device-refresh` (`{refreshToken, platform: "mobile"}`) on any 401, mutex-guarded single-flight, retry the original request once.
- Logout: `POST /v1/auth/device-logout`.
- Every authenticated call sends `Authorization: Bearer <accessToken>` — no more static shared-secret header, no more `Bearer <api_key>`.

### Token storage

`utils/PrefsManager.kt` currently keeps everything — including the login blob with the bearer token — in one plain-text `SharedPreferences` file (`"FaceWix"`). This is the same defect already fixed on the sibling app (see `docs/progress.md`'s 2026-07-17 Android Security Remediation entry). Fix applied identically here: split into `appPrefs()` (plain, non-sensitive: captured-image path, saree try-on preview cache, generic key/value helpers) and `securePrefs()` (`EncryptedSharedPreferences`, `MasterKeys.AES256_GCM_SPEC`, `AES256_SIV`/`AES256_GCM`) for the login/session blob and refresh token.

### Merchant catalog browse (replaces `app_forcategoryv1`, `app_drappinglist`, `app_drappinggarments`)

`GET /v1/merchant/catalog/subcategories?category=women` returns this merchant's subcategories under Women (each one is a specific drape style — see "Pallu type" below). `GET /v1/merchant/catalog?subcategoryId=<id>` returns items in that subcategory. No merchant ID is sent client-side; `requireMerchant` resolves it server-side from the JWT.

The legacy screen (`VastraProductCategoryFragment`) has two nesting levels — an outer "dress type" category and inner subcategories — because it was built for a multi-garment-type backend. This app is saree-only, so the outer level collapses: the subcategory list from `/v1/merchant/catalog/subcategories?category=women` becomes the single top-level list the fragment renders (previously the *inner* level), and tapping one loads its items via `/v1/merchant/catalog?subcategoryId=`.

**SKU search gap:** the legacy app searches by exact SKU (`app_searchproductv1`, `SKU_NUMBER` param). The existing `GET /v1/merchant/catalog?search=` filters on `label` via `ilike`, not `sku` (`apps/api/src/modules/merchant/catalog.routes.ts:339-342`) — `merchant_catalog_items.sku` exists as a column but isn't part of the search predicate. This spec does **not** change the backend search endpoint (out of scope for this cutover — a client-only rewrite). The Android search box is wired to the same endpoint as-is; search-by-label is an accepted, documented behavior change from search-by-SKU-only. Revisit if this proves disruptive in practice.

### Generate + finalize product (replaces `app_custome_drapping`, `app_tryonresultv1`, `app_addthemev1`, and the pallu-type dropdown)

**Correction from initial framing:** `app_custome_drapping`/`app_tryonresultv1` (`UploadPhotoDialog.kt`'s `fetchCustomSareeTryOnAPI` + `ProductUploadViewModel.pollTryOnResult`) are not a separate customer-facing try-on feature — this app has no such screen anywhere (`SelectedVastraThemePreviewDialog` is a static image slider over already-generated product photos, no API calls). They're the drape-preview-generation step of the merchant's own product-creation flow: capture flat photo → generate a preview → (separately) pick category/SKU/price → finalize. `/v1/merchant/tryon/*` (customer-photo-against-existing-product try-on, used by the sibling kiosk app) does not apply to this app at all and is not used anywhere in this cutover.

This is a client-orchestrated sequence, mirroring `apps/catalogues-web/src/app/(app)/catalogue-manager/api.ts` and `BulkUploadModal.tsx`'s `handleGenerateAll`/`finalizeCompletedJob` exactly:

1. `POST /v1/merchant/catalog/presign` (`{kind: 'flat', contentType, contentLength}`) → `{assetId, uploadUrl, r2Key}`; `PUT` the flat saree photo bytes to `uploadUrl`.
2. `POST /v1/merchant/catalog/generate` (`{subcategoryId, flatImageKey: r2Key}`) → `{jobId}`.
3. Poll `GET /v1/merchant/catalog/generate/:jobId` every 2500ms (same interval as the web reference) until `status` is `COMPLETED`/`FAILED`/`CANCELLED`, timeout 180s. On `COMPLETED`, `resultUrl` is the generated preview (shown the same way `customSareeTryOnResultData.tryon_image` was shown in the legacy `imgTryonResult`).
4. `POST /v1/merchant/catalog/import` (`{jobId, subcategoryId}`) → creates the `merchant_catalog_items` row (default `$0` pricing, auto label) and is what makes it appear in the web catalogue-manager. **Not automatic** — must be called explicitly.
5. `PATCH /v1/merchant/catalog/:id` (`{sku?, actualPrice, offerPrice}`, rupees — converted to paise server-side) — sets the SKU/pricing the merchant enters, same fields the legacy "Add Product" step collected.

**Pallu type ⇒ subcategory, collapsing two legacy pickers into one:** in the legacy flow, "pallu type" (drape style) is chosen *before* capturing the photo (`UploadVastraFragment`'s `selectedPalluType`, sent to `app_custome_drapping`), and a separate "product category" is chosen *after* generating, before finalizing (`app_addthemev1`'s `story_id`). In the new backend, drape style is not a runtime parameter at all — an admin pre-configures one `garment_subcategories` row (with its own `defaultPoseId`) plus one `merchant_catalog_subcategories` row per drape style (e.g. "Sarees – Front Pallu", "Sarees – Back Pallu"), all under `category='women'`. Both legacy pickers become the same thing: **one subcategory choice**, made once, before capturing the photo (since `generate` needs `subcategoryId` up front). This is a deliberate UX simplification, not an oversight — fewer choices for the same outcome.

**Rollout prerequisite (not a code task):** before this app is usable end-to-end, an admin must create the drape-style `garment_subcategories` + `merchant_catalog_subcategories` rows in the existing admin panel. Until that data exists, the subcategory picker will be empty and generation cannot proceed. This blocks manual QA of Task 6/9 below but not the code changes themselves.

### Error handling

`apps/api` returns `{"error": {"code": "...", "message": "..."}}` on failure (`apps/api/src/server.ts`'s `setErrorHandler`) — nothing like legacy's raw JSON + `"false"` string sentinel. Mirror the sibling app's `parseBackendError()` / sealed `ApiException` (`BackendError(code, backendMessage, httpStatus)`, `NetworkError`, `ClientError`) exactly. `SocketTimeoutException`/`IOException` map to `NetworkError`; any non-2xx response is parsed for the `error` envelope, falling back to `HTTP_<status>` if the body isn't in that shape.

### Explicitly out of scope

- The sibling app's `NetworkInterceptor`/`NetworkMonitor`/`NetworkState`/`NetworkUtils` connectivity-banner system — a global "you're offline"/"slow connection" UI layer unrelated to the backend swap itself. `ApiException.NetworkError` already surfaces connectivity failures per-call; that's sufficient here.
- "Force device login" override UI for `DEVICE_LIMIT_REACHED`.
- `/v1/merchant/tryon/*` (customer-photo-against-existing-product try-on) — this app has no customer-facing try-on screen; not wired up anywhere.
- Changing the `/v1/merchant/catalog` search endpoint to also match `sku` (see SKU search gap above).
- Any change to `apps/api`, `packages/db`, `packages/types`, or any other backend/web code — this is an Android-app-only change against existing, unmodified endpoints.
- Profile screen fields with no backend equivalent: legacy shows `merchantPhoto` and `companyLogo` (Glide-loaded images); `deviceLoginUserPayload()` has no such fields (`id, email, displayName, tier, maxActiveDevices` only — no photo/logo anywhere in the `merchants` schema either). These `Glide.load()` calls are removed, not silently left pointed at now-missing data; profile displays `displayName ?: email` and `email`.

## Testing

This codebase's established Android testing convention (confirmed via `docs/progress.md`'s prior Android work, e.g. "2026-07-17 - Merchant Try-On Android Integration") is compile/assemble verification plus a manual device/emulator walkthrough — there is no existing JVM unit-test suite or instrumentation-test convention to extend, and building one is out of scope for a backend-cutover task. Verification is `:app:compileDebugKotlin` and `:app:assembleDebug`, plus a manual walkthrough (login → browse subcategories → capture a flat photo → generate+finalize a product with SKU/price → confirm it's visible via `GET /v1/merchant/catalog` or the web catalogue-manager). Any genuinely pure function introduced (URL resolution, a poll-status classifier) gets one small JUnit test under `app/src/test/java/...`, per this project's general practice of leaving one runnable check behind non-trivial logic — not a broader suite.

## Self-review

- **Placeholders:** none — every endpoint, body shape, and field name above is taken directly from `packages/types/src/{auth,widget}.ts` and the corresponding route files, not invented.
- **Internal consistency:** the "pallu type ⇒ subcategory" collapse is stated once here and is the single source of truth the implementation plan follows; the SKU-search gap and the missing profile-photo fields are stated as accepted, out-of-scope gaps rather than silently glossed over.
- **Scope:** single subsystem (one Android app's networking + auth layer), no backend changes — appropriately scoped for one implementation plan.
- **Ambiguity:** "pallu type" resolution required tracing actual legacy call sites (`UploadPhotoDialog.kt`, `UploadVastraFragment.kt`) rather than trusting the label alone — confirmed it's a generation-time choice, not a static tag, before mapping it to subcategory selection.
