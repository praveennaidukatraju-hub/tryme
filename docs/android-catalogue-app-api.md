# Android Catalogue App — API Reference

**Audience:** external/Android developer building the merchant catalogue-creation
app (native, not a WebView of `apps/catalogues-web`).
**Source of truth:** this document is generated from the live route/schema code
(`apps/api/src/modules/auth/routes.ts`, `modules/merchant/*.routes.ts`,
`packages/types/src/{auth,widget}.ts`) as of 2026-08-20. If behavior here ever
disagrees with the running API, the code wins — treat this as a snapshot, not a
contract.

A prior Android build already exists against most of this surface (see code
comments referencing "the saree catalogue Android app") — this doc covers the
full catalogue-creation surface it uses, generalized to any garment category.

---

## 1. Base URL

Production is a single host, path-routed (`infra/docker-compose.prod.yml`):

```
https://app.tryme.com/v1/...
```

(`admin.tryme.com/v1/...` also reaches the same API — either works, but use
`app.tryme.com` as the canonical base.) Confirm the staging host with the
team before pointing a debug build at it — staging uses different hostnames per
`docs/staging-runbook.md`.

All endpoints below are relative to this base, e.g. `POST /v1/auth/device-login`
means `POST https://app.tryme.com/v1/auth/device-login`.

---

## 2. Auth model

This app does **not** use cookies. Every authenticated request sends:

```
Authorization: Bearer <accessToken>
```

Two token flavors matter here:

- **Device session** (`aud: 'device'`) — minted by `/v1/auth/device-login`,
  `/v1/auth/device-login/google`, `/v1/auth/device-login/force`. Required for
  onboarding (`/v1/merchant/onboarding`), because onboarding must be
  unreachable from a plain web login.
- **Merchant-scoped routes** (`requireMerchant`, everything under
  `/v1/merchant/catalog/*` and `/v1/merchant/me`) accept **any** valid access
  token — device or otherwise — as long as the underlying user has an active
  `merchants` row. In practice: log in with device-login, then use that same
  `accessToken` everywhere, including catalogue routes.

Access tokens are short-lived (`JWT_EXPIRY`, minutes). Refresh proactively or
on a 401 using `/v1/auth/device-refresh`.

### Error envelope

Every error response has this shape, regardless of endpoint:

```json
{ "error": { "code": "STRING_CODE", "message": "human-readable", "...extra": "optional" } }
```

Common codes: `UNAUTH` (401), `FORBIDDEN` (403), `NOT_FOUND` (404),
`VALIDATION` (400), `CONFLICT` (409), `RATE_LIMIT` (429),
`INSUFFICIENT_CREDITS` (402), `INTERNAL` (500).

---

## 3. Auth & onboarding endpoints

### `POST /v1/auth/register`
Standard email/password signup (only if you're not using Google sign-in).
Rate limit: 5/min per IP... actually 10/min.

Request:
```json
{ "email": "a@b.com", "password": "min8chars1", "displayName": "Store Name", "signupSource": "optional" }
```
Response `201`:
```json
{ "requiresEmailVerification": true }
```
The account cannot log in via device-login until the verification email link is
clicked (`emailVerified` must be true) — factor this into the signup UX, or
prefer Google sign-in below which skips it.

### `POST /v1/auth/device-login`
Password login. Rate limit: 5/min.

Request:
```json
{
  "email": "identifier",          // email OR username
  "password": "...",
  "deviceId": "stable-device-uuid",
  "deviceName": "optional, e.g. \"Pixel 7\"",
  "platform": "mobile"            // default "mobile" — do NOT send "kiosk" for this app
}
```
Response `200`:
```json
{
  "accessToken": "...",
  "refreshToken": "...",
  "user": { "id": "...", "email": "...", "displayName": "...", "tier": "free", "maxActiveDevices": 1 },
  "logoUrl": "https://... | null",
  "merchantStatus": "ONBOARDING_REQUIRED" | "PENDING_ACTIVATION" | "ACTIVE"
}
```
`platform: 'mobile'` has **no device cap** — merchant staff commonly share one
account across tablets, so simultaneous logins from multiple devices are fine.
(A `platform: 'kiosk'` session, unrelated to this app, does enforce a device
cap and can 409 with `DEVICE_LIMIT_REACHED` — you won't hit this unless you
reuse kiosk platform by mistake.)

Branch on `merchantStatus` immediately after login:
| Value | Meaning | UI |
|---|---|---|
| `ONBOARDING_REQUIRED` | no `merchants` row yet | show onboarding form |
| `PENDING_ACTIVATION` | merchant row exists but `isActive=false` (admin hasn't approved) | blocking "awaiting activation" screen |
| `ACTIVE` | ready | go to Home / catalogue |

### `POST /v1/auth/device-login/google`
Native Google sign-in (Android Credential Manager). Preferred over
password auth — no email verification step, upserts the user automatically.

Request:
```json
{
  "idToken": "<Google ID token from GetGoogleIdOption, NOT an OAuth access token>",
  "deviceId": "...",
  "deviceName": "optional",
  "platform": "mobile"
}
```
Response `200`: same shape as device-login, plus (only when
`merchantStatus === 'ONBOARDING_REQUIRED'`):
```json
{ "onboarding": { "suggestedContactName": "...", "suggestedCompanyName": "..." } }
```
Use these to prefill the onboarding form.

### `POST /v1/auth/device-refresh`
Request: `{ "refreshToken": "...", "platform": "mobile" }`
Response `200`: `{ "accessToken": "...", "refreshToken": "... | null" }`
(`refreshToken` is `null` on a benign concurrent-refresh race — keep using the
old one in that case; it's still valid.) A `401 INVALID_REFRESH` means the
session is dead — send the user back to login.

### `POST /v1/auth/device-logout`
Request: `{ "refreshToken": "..." }` → `{ "ok": true }`. Revokes the whole
token family (all rotations of that refresh token).

---

## 4. Merchant onboarding

Guarded by a **device** access token specifically (`requireDeviceUser`) — a
web session cannot reach these.

### `GET /v1/merchant/onboarding`
```json
{
  "merchantStatus": "ONBOARDING_REQUIRED",
  "prefill": { "contactName": "...", "companyName": "...", "phone": "" }
}
```

### `POST /v1/merchant/onboarding`
Only `phone` is mandatory — everything else falls back sensibly server-side.
```json
{
  "phone": "9876543210",           // regex: ^\+?[0-9]{10,15}$
  "contactName": "optional, max 120",
  "companyName": "optional, max 200",
  "businessAddress": "optional, max 500"
}
```
Response `201`:
```json
{ "merchantStatus": "ACTIVE", "merchantId": "uuid" }
```
Creates the `merchants` row **active immediately, zero admin review**. `409
CONFLICT` if the account is already a merchant — don't show onboarding again
after that; just re-derive status from the next login/refresh.

---

## 5. Merchant profile / credits

### `GET /v1/merchant/me` — `requireMerchant`
```json
{ "displayName": "...", "email": "...", "balance": 4200, "used": 1800 }
```
`balance` = current credit balance, `used` = lifetime credits spent (not a
rolling window).

### `GET /v1/credits` — accepts device token too
```json
{ "balance": 4200, "recent": [{ "id": "...", "delta": -50, "reason": "JOB_DISPATCH", "createdAt": "..." }] }
```

Credits are deducted **at generate-request time** (see §7), before the image
is produced. A `402 INSUFFICIENT_CREDITS` on a generate call means top-up is
needed — there is currently no in-app purchase route documented for this app;
confirm with the team how merchants top up (web pricing page, or manual admin
grant).

---

## 6. Reference data

### `GET /v1/models/garment-types?gender=men|women|boys|girls`
Needed to populate the "garment type" picker when creating a subcategory.
```json
{
  "items": [
    {
      "id": "uuid",              // <- this is garmentSubcategoryId elsewhere
      "slug": "kurta",
      "label": "Kurta",
      "sortOrder": 1,
      "thumbnailUrl": "https://... | null",
      "instructionImageUrl": "https://... | null",
      "requiresLowerUpload": false,
      "upperUploadLabel": "...",
      "lowerUploadLabel": "... | null",
      "requiresThirdUpload": false,
      "thirdUploadLabel": "... | null",
      "requiresMannequinStep": false,   // true => this is a "saree-style" garment type, see §9
      "mannequinTwoInputWorkflowTemplateId": "uuid | null"
    }
  ]
}
```

---

## 7. Catalogue creation

A **product** (`merchant_catalog_items`) always belongs to a **subcategory**
(`merchant_catalog_subcategories`), which is scoped to one garment type
(`garmentSubcategoryId`, from §6) and one `category` (`men|women|boys|girls`).

### 7.1 Subcategories

**`GET /v1/merchant/catalog/subcategories?category=&includeDemo=true|false`**
`includeDemo` (default depends on caller — pass explicitly) appends admin-authored
demo rows tagged `isDemo:true, readOnly:true` for merchants assigned to a demo
set. Never let the UI allow editing/deleting a row where `isDemo === true`.
```json
{ "items": [ { "id":"uuid","merchantId":"uuid","category":"women","name":"Sarees",
  "garmentSubcategoryId":"uuid","sortOrder":0,"productCount":12,
  "createdAt":"...","updatedAt":"...","isDemo":false } ] }
```

**`POST /v1/merchant/catalog/subcategories`**
```json
{ "category": "women", "name": "Sarees", "garmentSubcategoryId": "uuid-from-§6" }
```
→ `201` with the created subcategory object (same shape as above).

**`PATCH /v1/merchant/catalog/subcategories/:id`** — any subset of
`{ name, garmentSubcategoryId, sortOrder }`, at least one required.

**`DELETE /v1/merchant/catalog/subcategories/:id`** → `204`. Cascades — every
product in it is deleted along with its R2 images. Confirm with the user
before calling this.

### 7.2 Upload flow (used for every image: flat garment, manual product photo, thumbnail)

Two-step, direct-to-storage — the API never receives the image bytes.

**`POST /v1/merchant/catalog/presign`**
```json
{ "kind": "flat" | "image" | "thumbnail", "contentType": "image/jpeg", "contentLength": 214532, "assetId": "optional uuid" }
```
→
```json
{ "assetId": "uuid", "uploadUrl": "https://...presigned-PUT-url...", "r2Key": "merchants/.../....jpg", "expiresIn": 600 }
```
Then `PUT` the raw image bytes to `uploadUrl` directly (no auth header, no
JSON body — just the bytes with the matching `Content-Type`). The URL expires
in 600s. Keep the returned `r2Key` — every route below wants it, not the URL.

### 7.3 Manual product (merchant already has a finished, try-on-suitable photo)

**`POST /v1/merchant/catalog`**
```json
{
  "subcategoryId": "uuid",
  "label": "Red Silk Saree",
  "sku": "optional, max 120",
  "actualPrice": 2499,     // rupees, integer
  "offerPrice": 1999,      // rupees, integer
  "r2Key": "from presign kind=image",
  "thumbnailKey": "from presign kind=thumbnail"
}
```
→ `201` with the full product object (see `MerchantCatalogItem` shape in §7.6).

### 7.4 AI-generated product (merchant uploads a flat garment; the pipeline composites it onto a model)

This is the multi-step flow, and it costs credits at step 1.

**Step 1 — kick off generation.**
`POST /v1/merchant/catalog/generate`
```json
{
  "subcategoryId": "uuid",
  "flatImageKey": "from presign kind=flat",
  "mannequinOnly": false,          // true only for saree-style garment types, see §9
  "sareeStyleId": "optional",
  "secondFlatImageKey": "optional, second presigned upload"
}
```
→ `201 { "jobId": "uuid" }`. Deducts credits immediately; `402
INSUFFICIENT_CREDITS` if the balance can't cover it. Other rejects you must
handle: `400 VALIDATION` ("admin has not configured a default pose/face/
background/lower/shoe for this category") — this means the category has no
admin defaults configured yet; surface it plainly, it's not something the app
can work around.

**Step 2 — poll until done.**
`GET /v1/merchant/catalog/generate/:jobId`
```json
{ "jobId": "uuid", "status": "QUEUED"|"PROCESSING"|"COMPLETED"|"FAILED", "resultUrl": "https://... | null", "errorCode": "... | null" }
```
Poll every few seconds; `resultUrl` is populated (a 1-hour presigned GET) once
`status === 'COMPLETED'`.

**Step 3 — finalize into a real product.**
`POST /v1/merchant/catalog/import`
```json
{ "jobId": "uuid", "subcategoryId": "uuid" }
```
→ `201` with the full `MerchantCatalogItem`. Only works once the job is
`COMPLETED`; `409 CONFLICT` if that job was already imported.

The generate → poll → import sequence is the **interactive** path — the
merchant is watching the screen. For **bulk** uploads (many flat garments at
once), use §7.5 instead; it skips straight to a materialized product without
a per-item import call.

### 7.5 Bulk generation (held batch, no interactive import step)

**`POST /v1/merchant/catalog/generate-bulk`**
```json
{ "subcategoryId": "uuid", "flatImageKeys": ["r2Key1", "r2Key2", "..."] }
```
(max 50 per call) → `201`:
```json
{ "jobIds": ["uuid", "..."], "failures": [{ "flatImageKey": "...", "error": "message" }] }
```
Jobs here are queued as `HELD` and processed later (bulk backfill during
off-peak GPU hours), **not** immediately dispatched — do not poll
`generate/:jobId` expecting quick completion.

**`GET /v1/merchant/catalog/generate/status?jobIds=id1,id2,id3`** — bulk status
check for a set of job IDs:
```json
{ "items": [ { "jobId":"uuid","status":"COMPLETED","resultUrl":"...","errorCode":null } ] }
```

**`POST /v1/merchant/catalog/reconcile-held`** — call this **once, on app
launch** (not per-job). It scans for any of the caller's held-batch jobs that
have since completed and auto-materializes them as products — landed
**`isActive: false`**, `actualPrice`/`offerPrice` = 0. Response:
```json
{ "created": [ /* MerchantCatalogItem[] */ ], "failed": 0 }
```
The merchant must then `PATCH` each created item with a real `sku` + prices
(§7.6) — doing so **auto-activates** it (flips `isActive: true`) as long as
you don't explicitly send `isActive` yourself.

### 7.6 List / update / delete products

**`GET /v1/merchant/catalog?search=&subcategoryId=&includeDemo=true|false`**
```json
{ "items": [ MerchantCatalogItem, ... ] }
```
where `MerchantCatalogItem` is:
```json
{
  "id": "uuid", "merchantId": "uuid", "subcategoryId": "uuid",
  "label": "string", "sku": "string | null",
  "actualPrice": 2499, "offerPrice": 1999,
  "r2Key": "string", "thumbnailKey": "string",
  "imageUrl": "https://... | null", "thumbnailUrl": "https://... | null",
  "sourceJobId": "uuid | null", "sourceKind": "uploaded" | "generated" | "imported",
  "flatSourceKey": "string | null",
  "isActive": true, "moderationStatus": "approved" | "rejected", "moderationNote": "string | null",
  "sortOrder": 0, "createdAt": "...", "updatedAt": "...",
  "isDemo": false, "readOnly": false
}
```
(`imageUrl`/`thumbnailUrl` are 1-hour presigned GETs — re-fetch the list if
they expire, don't cache them long-term.)

**`PATCH /v1/merchant/catalog/:id`** — any subset of `{ subcategoryId, label,
sku, actualPrice, offerPrice, isActive, sortOrder }`, at least one required.

**`DELETE /v1/merchant/catalog/:id`** → `204`. Deletes the R2 image + thumbnail
too — irreversible, confirm before calling.

### 7.7 Importing from the merchant's own studio history (optional, alternate path)

If the merchant has existing completed try-on jobs (created via the web
Studio under this same account), you can list and import those instead of
generating fresh:

**`GET /v1/merchant/catalogues`**
```json
{ "catalogues": [ { "catalogueId":"uuid","label":"...","createdAt":"...",
  "jobs":[{"jobId":"uuid","catalogueId":"uuid","label":"...","thumbnailUrl":"...","createdAt":"...","imported":false}] } ] }
```
Then call `POST /v1/merchant/catalog/import` (§7.4 step 3) with that `jobId`.

---

## 8. Standard flow (put it together)

1. `POST /v1/auth/device-login` (or `/device-login/google`) → get tokens +
   `merchantStatus`.
2. If `ONBOARDING_REQUIRED`: `POST /v1/merchant/onboarding` → status becomes
   `ACTIVE`.
3. On every app launch: `POST /v1/merchant/catalog/reconcile-held` (harmless
   no-op if nothing's pending).
4. `GET /v1/models/garment-types?gender=...` + `GET
   /v1/merchant/catalog/subcategories?category=...` to populate pickers;
   `POST .../subcategories` if the merchant needs a new one.
5. To add a product:
   - Manual: presign → PUT image + thumbnail → `POST /v1/merchant/catalog`.
   - AI single: presign flat → `POST generate` → poll `GET generate/:jobId` →
     `POST import`.
   - AI bulk: presign N flats → `POST generate-bulk` → rely on step 3's
     reconcile on a later launch → `PATCH` each to add SKU/price (auto-activates).
6. `GET /v1/merchant/catalog` to render the product grid; `PATCH`/`DELETE` per
   item as the merchant edits.

---

## 9. Saree-specific variants (only if this app also handles saree-style garment types)

Some garment types have `requiresMannequinStep: true` (§6) — a saree needs a
"drape onto mannequin" step before the normal face/background compositing.
Two dedicated endpoints exist so a saree-only client doesn't have to filter
the general lists itself:

**`GET /v1/merchant/catalog/saree-subcategories?category=&includeDemo=`** —
same shape as §7.1, pre-filtered to mannequin-step garment types only. Also
**self-provisions** one subcategory per active admin-configured saree garment
type on first call for a category the merchant hasn't touched yet — so an
empty list on first load is normal; it'll be populated after that first call.

**`GET /v1/merchant/catalog/saree-styles`**
```json
{ "items": [ { "id":"uuid","label":"Bengali Drape","previewUrl":"https://...|null","sortOrder":0,"supportsTwoInput":true } ] }
```
Pass the chosen style's `label` (not `id`) as `sareeStyleId` in
`POST .../generate` (§7.4) — matched case-insensitively server-side.
`supportsTwoInput: true` means this style accepts a second image
(`secondFlatImageKey`, e.g. a separate "pallu" shot) — only offer that upload
field when the selected style supports it.

For saree garment types, `mannequinOnly: true` in the generate call skips the
normal pose/background/face step entirely and finalizes on the mannequin-drape
output directly — this is the mobile-only "quick" saree flow.

---

## 10. Things you must not build around

- Do not cache `imageUrl`/`thumbnailUrl` past their 1-hour presign window —
  re-fetch the list instead of storing them.
- Do not call `/v1/merchant/catalog/reconcile-held` per-job or in a tight
  loop — it's a full scan, call it once per app launch.
- `platform` must be `"mobile"` for every device-auth call from this app —
  sending `"kiosk"` opts into a different (single-device) session model that
  isn't meant for this app.
- Prices in requests/responses are **rupees**, not paise — the API converts
  internally; don't multiply by 100 yourself.
