# Shopify Virtual Try-On Plugin — Design Spec

## Summary

Public Shopify App Store virtual try-on plugin for clothing. Merchants install it, their product images auto-sync as garments, and shoppers upload a selfie to see the product on themselves. Built on top of the existing widget/merchant system (Approach A).

---

## Architecture

```
Shopify Storefront                    Shopify Admin
+-----------------+                  +------------------+
| Theme Extension  |                  | Embedded App UI  |
| (Try On button)  |                  | (apps/shopify/)  |
+--------+---------+                  +--------+---------+
         | widgetKey                           | session token
         v                                     v
+---------------------------------------------------------------------+
|                         Your API (Fastify)                           |
|  +----------------+  +----------------+  +-----------------------+  |
|  | modules/       |  | modules/       |  | modules/              |  |
|  | shopify/       |  | widget/        |  | jobs/                 |  |
|  | oauth,         |  | presign,       |  | create, SSE,          |  |
|  | webhooks,      |  | jobs, events   |  | presign               |  |
|  | billing        |  |                |  |                       |  |
|  +----------------+  +----------------+  +-----------------------+  |
+---------------------------------------------------------------------+
         |                    |                    |
         v                    v                    v
    +---------+         +---------+         +----------+
    | Postgres|         |  Redis  |         | R2/MinIO |
    +---------+         +---------+         +----------+
```

**What changes vs what stays:**

| Change area | What |
|-------------|------|
| New — `packages/db/src/schema/` | `shopifyStores`, `shopifyProductGarments`, `shopifyPlans` |
| New — `apps/api/src/modules/shopify/` | OAuth routes, webhook handlers, billing, admin plan CRUD |
| New — `apps/api/src/plugins/shopify-auth.ts` | Session token validation decorator |
| New — `apps/shopify/` | Embedded admin app (Next.js + Polaris) |
| New — `apps/shopify-extension/` | Theme app extension (Try On button block) |
| Extend — `widgetClients` | Add `clientType` column (`merchant` / `shopify`) |
| Extend — `modules/widget/` | Accept `shopifyProductId`, auto-resolve garment |
| Extend — `apps/dispatcher/` | Handle Shopify jobs (routed via `jobInputs.params.kind === 'shopify'`) |
| Extend — `apps/admin-web/` | Show Shopify store data in existing widget client views |
| Reuse — no changes | `modules/jobs/`, storage, SSE, `widgetClientCredits`, `widgetCreditLedger` |

---

## Data Model

### New Tables

```sql
-- Plans configurable by internal admin
CREATE TABLE shopifyPlans (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name            TEXT NOT NULL,                   -- "Trend", "Runway", "Unlimited"
  priceCents      INTEGER NOT NULL,                -- 1999 = $19.99
  includedTryons  INTEGER NOT NULL,                -- 100, 500, 2000
  overageCents    INTEGER NOT NULL,                -- 16 = $0.16 per overage
  trialDays       INTEGER NOT NULL DEFAULT 7,
  sortOrder       INTEGER NOT NULL DEFAULT 0,
  isActive        BOOLEAN NOT NULL DEFAULT true,
  createdAt       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Links Shopify store to existing widgetClient
CREATE TABLE shopifyStores (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  widgetClientId  UUID NOT NULL UNIQUE REFERENCES widgetClients(id) ON DELETE CASCADE,
  shopDomain      TEXT NOT NULL UNIQUE,           -- my-store.myshopify.com
  shopifyShopId   BIGINT NOT NULL UNIQUE,
  accessToken     TEXT NOT NULL,                  -- encrypted at rest
  scope           TEXT NOT NULL,                  -- granted OAuth scopes
  billingPlanId   BIGINT,                         -- Shopify recurring charge ID
  shopifyPlanId   UUID REFERENCES shopifyPlans(id),
  installedAt     TIMESTAMPTZ NOT NULL DEFAULT now(),
  uninstalledAt   TIMESTAMPTZ,
  settings        JSONB NOT NULL DEFAULT '{}',    -- buttonText, buttonColor, position, customCss, workflowTemplateId
  syncCursor      TEXT,                           -- last synced Shopify product ID
  createdAt       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updatedAt       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Auto-imported product→garment mapping
CREATE TABLE shopifyProductGarments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  storeId           UUID NOT NULL REFERENCES shopifyStores(id) ON DELETE CASCADE,
  shopifyProductId  BIGINT NOT NULL,
  shopifyVariantId  BIGINT,                       -- NULL = product-level image
  r2Key             TEXT NOT NULL,
  status            TEXT NOT NULL DEFAULT 'processing', -- active, processing, failed, deleted
  failedReason      TEXT,                         -- populated when status = 'failed'
  syncedAt          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE(storeId, shopifyProductId, shopifyVariantId)
);
```

### Extensions to Existing Tables

```sql
ALTER TABLE widgetClients ADD COLUMN clientType TEXT NOT NULL DEFAULT 'merchant';
-- values: 'merchant' (existing self-serve), 'shopify' (new)
```

### Tables Reused (no changes)

- `widgetClients` — Shopify store gets a row, `clientType = 'shopify'`
- `widgetClientCredits` — tracks remaining try-ons per billing cycle
- `widgetCreditLedger` — full audit trail for all try-on charges
- `jobs` — already has `widgetClientId` FK and `customerPhotoKey` column. **No `jobType` column exists** — the dispatcher routes by inference (see Dispatcher section). Shopify jobs set `widgetClientId` and are distinguished from self-serve widget jobs by `jobInputs.params.kind === 'shopify'`.
- `jobInputs` — stores garment key, customer photo key, product ID
- `workflowTemplates` — new row for Shopify-optimized workflow

### Admin Plan Management

Internal admin CRUD for `shopifyPlans` via:
- `GET /admin/shopify-plans` — list all plans
- `POST /admin/shopify-plans` — create plan
- `PATCH /admin/shopify-plans/:id` — update plan
- `DELETE /admin/shopify-plans/:id` — soft-delete (set `isActive = false`)

When a store selects a plan, `shopifyStores.shopifyPlanId` is set. Pricing values (`includedTryons`, `overageCents`) are read from the plan row at job creation time for credit cap enforcement.

---

## OAuth & Auth Flow

### Install Flow

```
1. Merchant clicks "Install" on Shopify App Store
2. GET /v1/shopify/auth
   → Generate nonce (Redis, 10 min TTL), redirect to Shopify OAuth authorize URL
3. Shopify redirects back to GET /v1/shopify/auth/callback
   → Verify state nonce (Redis) + HMAC of callback query params
   → Exchange code for access token (Shopify REST API)
   → Fetch shop details (GET /admin/api/shop.json) → email, name, domain,
     myshopify_domain, primary custom domain (for allowedOrigins)
   → BEGIN TRANSACTION:
       -- widgetClients has ~9 NOT NULL columns with no defaults; synthesize
       -- from shop details so a Shopify store row is valid without self-serve signup:
       INSERT widgetClients (
         clientType   = 'shopify',
         isActive     = true,
         companyName  = shop.name,
         contactName  = shop.shop_owner ?? shop.name,
         email        = shop.email,                 -- see UNIQUE note below
         phone        = shop.phone ?? '',
         websiteUrl   = 'https://' || shopDomain,
         companySize  = 'unknown',
         purpose      = 'shopify',
         businessAddress = shop.address ?? '',
         passwordHash = '' ,                         -- Shopify stores never password-login;
                                                     -- login is session-token only
         allowedOrigins = [ 'https://' || myshopify_domain,
                            'https://' || primary_custom_domain ]  -- storefront origins
       )
       INSERT widgetClientCredits (balance=0)
       INSERT shopifyStores (accessToken encrypted, shopDomain, shopifyShopId)
       Register Shopify webhooks (app/uninstalled, products/update, products/delete,
         app_subscriptions/update, customers/data_request, customers/redact, shop/redact)
     COMMIT
   → Redirect to embedded app URL (shopify admin iframe)
4. Embedded app loads
   → App Bridge provides session token
   → GET /v1/shopify/me validates session token, returns store config + credit balance
```

### Reinstall & UNIQUE Constraints

`widgetClients.email` is `UNIQUE` and `shopifyStores.shopDomain` / `shopifyShopId` are `UNIQUE`. Uninstall never deletes rows (sets `uninstalledAt` + `isActive=false`), so a reinstall of the same shop must **upsert, not insert**:

- On callback, look up `shopifyStores` by `shopifyShopId` first.
- If found → reactivate: update `accessToken`, `scope`, clear `uninstalledAt`, set `widgetClients.isActive=true`, refresh `allowedOrigins`. Do **not** insert new rows.
- If not found → run the INSERT transaction above.
- `email` collision guard: if `shop.email` already belongs to a **non-Shopify** `widgetClients` row, suffix the stored email (`owner+shop-<shopifyShopId>@…`) so the UNIQUE constraint holds. The stored email is not a login credential for Shopify stores (session-token auth only).

### Auth Contexts

| Context | Mechanism | Decorator |
|---------|-----------|-----------|
| Storefront (theme extension) | `X-Widget-Key` header (origin checked against `allowedOrigins`) | `requireWidgetClient` (existing) |
| Embedded admin iframe | Shopify session token (HMAC-SHA256 JWT, no DB call needed to validate — uses app secret) | `requireShopifySession` (new) |
| Internal admin | Existing `requireAdmin` | `requireAdmin(['SUPER_ADMIN', 'ADMIN'])` (existing) |

### New Plugin

`apps/api/src/plugins/shopify-auth.ts`:

```ts
// requireShopifySession
// Validates Shopify-issued session token (App Bridge) for embedded apps.
// Shopify session tokens are HS256, signed with the app's SHOPIFY_API_SECRET —
// there is NO key rotation / kid lookup (that only applies to RS256 with a JWKS).
// 1. Verify HS256 signature using SHOPIFY_API_SECRET (reject any other alg — no `none`)
// 2. Check exp / nbf (not expired; tokens are short-lived ~1 min)
// 3. Check aud === SHOPIFY_API_KEY
// 4. Check iss and dest share the same shop host (dest = shop domain)
// 5. Extract dest → shop domain; lookup shopifyStores by shopDomain
// 6. Set req.shopifyStore on Fastify request
```

### OAuth Scopes Required

Least privilege — a try-on plugin only reads products and installs a storefront button. Do **not** request write/orders/customers scopes; over-scoping is both a stored-token blast-radius risk and a common cause of App Store review rejection.

```
read_products          # resolve product images → garments
write_script_tags      # (only if injecting via script tag; NOT needed with a theme app extension)
```

The button is delivered as a **theme app extension** (`apps/shopify-extension/`), which needs no theme/script scopes at all — so the minimal viable grant is just `read_products`. Add `write_script_tags` only as a fallback for merchants on themes that don't support app blocks. Any scope beyond these must be justified against a concrete feature before it's added.

---

## Storefront Theme Extension

`apps/shopify-extension/` — Shopify CLI project, block type.

### Block: `tryon-block.liquid`

Injected into the product page. Renders:
- A styled "Try It On Yourself" button below product images
- File upload input (accepts camera + gallery on mobile)
- A result area that appears inline below the button

### Client JS: `tryon-widget.js`

```
On button click:
1. GET /v1/widget/config/:widgetKey → validate store is active
2. POST /v1/widget/presign → get presigned PUT URL for customer photo
3. PUT photo to R2 presigned URL
4. POST /v1/widget/jobs { shopifyProductId, customerPhotoKey }
   → returns { jobId }
5. Open SSE: GET /v1/widget/jobs/:jobId/events
   → on status='completed': render result image (presigned R2 URL)
   → on status='failed': show error with guidance message
6. Result renders inline: full-width image + "Save" / "Share" buttons
```

### Product→Garment Resolution

`POST /v1/widget/jobs` extended to accept `shopifyProductId`:
1. Validate widgetKey via `requireWidgetClient`
2. Resolve `shopifyStores` from `widgetClientId`
3. Lookup `shopifyProductGarments` by `storeId + shopifyProductId`
4. If not found and product not synced → trigger async sync, return `202` with message
5. Resolve `r2Key` → continues to existing job creation flow

### Edge Cases

| Scenario | Response |
|----------|----------|
| Product not yet synced | 202 Accepted, "We're preparing this product for try-on. Check back in a moment." + auto-sync queue |
| Store uninstalled/deactivated | 403 Forbidden |
| Customer photo too small / face not detectable | 400 Bad Request, "Please upload a clear, front-facing photo where your full body/face is visible" |
| Store out of credits | 402 Payment Required, "This store has reached its try-on limit. Please contact the store owner." |
| ComfyUI fails | SSE error event, user sees "Something went wrong. Please try again." |

---

## Shopify Try-On Pipeline

Shopify jobs extend the existing widget job infrastructure. **There is no `jobType` column** — the dispatcher routes by inference, so Shopify jobs are tagged with `jobInputs.params.kind = 'shopify'` (mirrors how saree jobs use `params.kind = 'saree'`).

### Job Creation (extends `POST /v1/widget/jobs`)

```
1. requireWidgetClient validates widgetKey (and origin vs allowedOrigins)
2. Lookup shopifyStores by widgetClientId (row must exist + not uninstalled)
3. Resolve shopifyProductGarments by storeId + shopifyProductId (status='active')
4. Presign R2 GET URL for garment (r2Key already in R2 — no external download,
   unlike the self-serve widget path which downloads garmentImageUrl)
5. Atomic credit deduct from widgetClientCredits — cost = SHOPIFY_JOB_COST credits
   (1 try-on = SHOPIFY_JOB_COST credits; plan.includedTryons is multiplied by
   SHOPIFY_JOB_COST when seeding the balance — see Billing → Credit Units)
6. INSERT into jobs (widgetClientId, customerPhotoKey, status='QUEUED',
   creditsCharged=SHOPIFY_JOB_COST)   -- no jobType column
7. INSERT into jobInputs (upperGarmentKey = resolved r2Key,
   params = { kind: 'shopify', shopifyProductId,
              workflowTemplateId: shopifyStores.settings.workflowTemplateId })
8. XADD to Redis Stream jobs:normal (or priority based on plan tier)
9. Return { jobId }
```

### Dispatcher (`apps/dispatcher/`) Extension

Routing lives in `processor.ts`. A Shopify job has `widgetClientId` set, so today's chain sends it to `processWidgetJob` (the `if (job.widgetClientId)` branch). Add a `kind` check **inside** `processWidgetJob` (or split it) so `params.kind === 'shopify'` dispatches to a `processShopifyJob` path — do **not** add a top-level `job.jobType` branch (no such field).

```
processShopifyJob(job, inputs):   // entered when inputs.params.kind === 'shopify'
    1. Load workflow template from inputs.params.workflowTemplateId
    2. Resolve garment from R2 (using inputs.upperGarmentKey)
    3. Resolve customer photo from R2 (using job.customerPhotoKey)
    4. Patch ComfyUI workflow JSON with garment + person photo
    5. Submit to ComfyUI
    6. On completion:
       - Upload result to R2: outputs/<jobId>/result.png
       - Upload thumbnail: outputs/<jobId>/result.thumb.jpg
       - Update job status = 'COMPLETED'   -- statuses are uppercase (schema default 'QUEUED')
       - Publish SSE: { event: 'completed', resultUrl }
    7. On failure:
       - Update job status = 'FAILED'
       - Refund credits via atomic refund (existing pattern)
       - Publish SSE: { event: 'failed', message }
```

### Workflow Template

A new row in `workflowTemplates` with a ComfyUI workflow optimized for:
- Customer self-photos (casual, varied lighting/backgrounds)
- Product flatlay/ghost-mannequin photos
- Garment warp to person body
- Skin tone preservation
- Natural photo-realistic output

Admin UI for workflow management: existing `admin/models.routes.ts` can manage this template.

---

## Billing (Hybrid)

### Plans (from `shopifyPlans` table, admin-managed)

| Field | Example: Trend | Example: Runway | Example: Unlimited |
|-------|---------------|-----------------|-------------------|
| name | Trend | Runway | Unlimited |
| priceCents | 1999 | 4999 | 19999 |
| includedTryons | 100 | 500 | 2000 |
| overageCents | 16 | 12 | 9 |
| trialDays | 7 | 7 | 7 |

### Credit Units

`shopifyPlans.includedTryons` is measured in **try-ons**; `widgetClientCredits.balance` is measured in **credits** (same integer column reused by self-serve widget jobs). One try-on costs `SHOPIFY_JOB_COST` credits (constant, mirrors `WIDGET_JOB_COST`). When a plan activates, seed/refill the balance as `includedTryons * SHOPIFY_JOB_COST`. Cap enforcement and overage math therefore happen in credits, not try-ons — `includedTryons` is only the human-facing quota. Keep `SHOPIFY_JOB_COST` in `apps/api/src/env.ts` (or a shared constant) so job creation and balance seeding never drift.

### Flow

```
1. After install → free trial (trialDays from selected plan)
   POST /recurring_application_charges to Shopify Billing API
   with trial_days, price, name from shopifyPlans row
   
2. Merchant selects plan in embedded admin
   → POST /v1/shopify/billing/select { planId }
   → Creates Shopify recurring charge
   → Returns confirmationUrl for Shopify charge acceptance modal

3. Shopify charge activated
   → GET /v1/shopify/billing/callback
   → HMAC validates charge_id
   → Update shopifyStores.billingPlanId, shopifyPlanId

4. Usage overage
   → When widgetClientCredits.balance hits 0 mid-cycle
   → POST /usage_charges for top-up pack (10/25/50 credits)
   → Merchant approves in Shopify admin
   → On confirmation: add credits to widgetClientCredits

5. App uninstalled
   → Shopify auto-cancels all recurring charges
   → Our webhook sets uninstalledAt, disables widgetKey
   → No data deleted (GDPR: retained 30 days for dispute)
```

### Endpoints

| Endpoint | Purpose |
|----------|---------|
| `GET /v1/shopify/billing/plans` | Available plans + current plan |
| `POST /v1/shopify/billing/select` | Start subscription for selected plan |
| `GET /v1/shopify/billing/callback` | Shopify charge confirmation webhook |

---

## Webhooks

All verified with HMAC-SHA256 using `SHOPIFY_API_SECRET`.

**Raw body required:** Shopify HMAC is computed over the raw request bytes. Fastify's default JSON parser consumes the body before the handler runs, so the webhook routes must register a `addContentTypeParser('application/json', { parseAs: 'buffer' })` (scoped to the `/v1/shopify/webhooks/*` prefix via an encapsulated plugin) to capture the raw buffer for HMAC verification, then `JSON.parse` after verifying. Verify → respond `200` **immediately**; do all real work (image download/upload, token re-validation) on a background queue, because Shopify retries any webhook that doesn't respond within ~5s.

| Webhook | Handler | Action |
|---------|---------|--------|
| `app/uninstalled` | `POST /v1/shopify/webhooks/app_uninstalled` | Set `uninstalledAt`, `isActive=false`, disable widgetKey. Cancel billing. Log. |
| `app_subscriptions/update` | `POST /v1/shopify/webhooks/app_subscriptions_update` | Re-validate OAuth token if scopes changed |
| `products/update` | `POST /v1/shopify/webhooks/products_update` | Enqueue re-sync (verify + 200 fast; download/upload happens on the sync queue, never inline) |
| `products/delete` | `POST /v1/shopify/webhooks/products_delete` | Set `shopifyProductGarments.status = 'deleted'` |
| `customers/data_request` | `POST /v1/shopify/webhooks/customers_data_request` | **GDPR mandatory.** Return any stored data for the customer (we store none beyond transient photos → respond with empty payload + log). Required for App Store approval. |
| `customers/redact` | `POST /v1/shopify/webhooks/customers_redact` | **GDPR mandatory.** Delete any customer photos/PII for the given customer. |
| `shop/redact` | `POST /v1/shopify/webhooks/shop_redact` | **GDPR mandatory.** Fires 48h after uninstall — purge store R2 assets + PII, keep only anonymized ledger for dispute window. |

> The three `customers/*` + `shop/redact` webhooks are **not optional** — Shopify blocks public App Store listing without them.

### Product Sync

**Sync runs on a background queue, never in a request/webhook handler.** A dedicated Redis Stream `shopify:sync` carries sync tasks (`{ storeId, mode: 'full' | 'product', shopifyProductId? }`); a consumer (in the dispatcher, or a small worker in `apps/api`) drains it. Install, the admin "Auto-Sync All" button, and the `products/update` webhook all just `XADD` a task and return immediately.

**Initial sync** (task `mode: 'full'`, enqueued after install and on-demand from admin):

```
1. Paginate Shopify REST API: GET /admin/api/products.json?limit=250
2. For each product with images:
   - Validate image URL is HTTPS + Shopify CDN host, then download first image
   - Upload to R2: shopify-garments/<storeId>/<productId>/garment.jpg
   - Upsert shopifyProductGarments row with status = 'active'
3. Store cursor (last product ID) in shopifyStores.syncCursor (resume on failure)
4. Respect Shopify API rate limits (2 req/s, 4 req/s burst) — leaky-bucket throttle
```

**Ongoing sync:** Webhook-driven — `products/update` / `products/delete` enqueue a `mode: 'product'` task (or set `status='deleted'` directly for delete).

---

## Embedded Admin UI

`apps/shopify/` — Next.js app rendered inside Shopify Admin iframe.

**Tech:** Next.js, `@shopify/polaris`, `@shopify/app-bridge-react`

**Screens:**

### Dashboard
- Try-ons this month, credits remaining, avg result time
- Daily try-on chart (last 30 days) — data from `GET /v1/shopify/analytics`

### Product Mapping
- Paginated list of products with sync status badges
- "Auto-Sync All" button (triggers bulk sync)
- Per-product: status indicator (active/processing/failed), retry/remove actions

### Appearance
- Button text, button color, position, custom CSS
- Saved to `shopifyStores.settings`

### Billing
- Current plan info (pulled from `shopifyPlans`)
- Usage summary (included + overage)
- "Change Plan" button → plan selection modal
- "View Invoices" links to Shopify admin billing page

### API Endpoints (all under `/v1/shopify/`)

| Endpoint | Purpose |
|----------|---------|
| `GET /me` | Store config, credits, current plan |
| `GET /products` | Paginated product mapping status |
| `POST /products/sync` | Trigger bulk sync |
| `POST /products/:productId/sync` | Re-sync single product |
| `DELETE /products/:productId` | Remove garment mapping |
| `PATCH /settings` | Update appearance settings |
| `GET /analytics` | Try-on stats (daily counts, avg time) |

---

## R2 Key Convention

New prefix for Shopify products:
```
shopify-garments/<storeId>/<productId>/garment.jpg
shopify-garments/<storeId>/<productId>/garment.thumb.jpg
shopify-photos/<storeId>/<jobId>/customer.jpg
outputs/<jobId>/result.png
outputs/<jobId>/result.thumb.jpg
```

---

## Security

- Shopify access tokens encrypted at rest (AES-256-GCM). Key from `SHOPIFY_TOKEN_ENC_KEY` env (32-byte, base64), validated in `apps/api/src/env.ts`. Stored as `iv:authTag:ciphertext`.
- Webhooks HMAC-verified on every request (over the raw body — see Webhooks section)
- Session-token signature validated without a DB call (HS256 with app secret); the subsequent `shopifyStores` lookup loads the store, it is not part of signature validation
- Product image downloads validated: HTTPS only, Shopify CDN hosts only (allowlist `*.myshopify.com`, `cdn.shopify.com`), following the existing `assertSafeExternalUrl` SSRF-guard pattern used by the widget garment download
- Customer photos: 5MB max, `image/jpeg` + `image/png` only, magic-byte (content-sniff) check that the bytes match the declared type. (No AV scanner exists in the stack — do **not** claim malware scanning; the mitigation is type+size validation and that photos are only ever passed to ComfyUI, never executed/served as HTML.)
- Rate limiting: honor Shopify's API limits (leaky bucket) outbound; our storefront endpoints rate-limited per widgetKey (existing `checkRateLimit`)

---

## File Structure

```
New files:
  apps/shopify/                          # Embedded admin app
    package.json
    src/
      pages/
        index.tsx                        # Dashboard
        products.tsx                     # Product mapping
        appearance.tsx                   # UI customization
        billing.tsx                      # Plan management
      hooks/
        useShopifySession.ts             # App Bridge session
        useShopifyApi.ts                 # Authenticated fetch to our API
    shopify.app.toml

  apps/shopify-extension/                # Theme app extension
    blocks/
      tryon-block.liquid
    assets/
      tryon-widget.js
      tryon-widget.css
    shopify.extension.toml

  apps/api/src/modules/shopify/
    routes.ts                            # Route registration
    auth.routes.ts                       # OAuth initiate + callback
    me.routes.ts                         # Store config for embedded admin
    webhook.routes.ts                    # Shopify webhook handlers
    billing.routes.ts                    # Plan selection, charge callback
    analytics.routes.ts                  # Dashboard stats
    products.routes.ts                   # Product sync listing + triggers
    products.sync.ts                     # Sync logic (download + upload)
    service.ts                           # Shopify API client helpers

  apps/api/src/plugins/
    shopify-auth.ts                      # requireShopifySession decorator

  packages/db/src/schema/
    shopify.ts                           # shopifyStores, shopifyProductGarments, shopifyPlans

  apps/admin-web/                        # Extension
    src/pages/shopify-plans/             # Plan CRUD management
    src/pages/widget-clients/            # Add shopify store data to views

Modified files:
  apps/api/src/server.ts                 # Register shopify routes + shopify-auth plugin (plugins register here, not in auth.ts)
  apps/api/src/modules/widget/routes.ts  # Accept shopifyProductId, resolve garment
  apps/api/src/env.ts                    # SHOPIFY_API_KEY, SHOPIFY_API_SECRET, SHOPIFY_APP_URL,
                                         #   SHOPIFY_TOKEN_ENC_KEY (32-byte base64, AES-256-GCM),
                                         #   SHOPIFY_SCOPES, SHOPIFY_JOB_COST
  apps/dispatcher/src/                   # Route inputs.params.kind==='shopify' → processShopifyJob (no jobType column)
  packages/db/src/schema/index.ts        # Export new shopify tables
  packages/db/src/schema/widget.ts       # Add clientType column
```

---

## Implementation Order

1. **Database** — `shopifyStores`, `shopifyProductGarments`, `shopifyPlans` schema + migration
2. **Admin plan management** — internal admin CRUD for plans
3. **OAuth + auth plugin** — `modules/shopify/auth.routes.ts`, `plugins/shopify-auth.ts`
4. **Webhooks** — `modules/shopify/webhook.routes.ts` (required for install to work)
5. **Product sync** — `modules/shopify/products.sync.ts` + routes
6. **Extend widget jobs** — accept `shopifyProductId`, resolve garment
7. **Billing** — `modules/shopify/billing.routes.ts`
8. **Embedded admin UI** — `apps/shopify/`
9. **Theme extension** — `apps/shopify-extension/`
10. **Dispatcher extension** — branch on `inputs.params.kind === 'shopify'` inside `processWidgetJob` → `processShopifyJob`
11. **Internal admin extension** — show Shopify store data
