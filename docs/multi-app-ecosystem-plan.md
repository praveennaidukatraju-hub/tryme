# Multi-App Ecosystem Plan — Merchant Portal, Kiosk Migration, Admin Subdomain

> **Status:** Partially superseded — see per-phase status in [`docs/multi-app-ecosystem/README.md`](multi-app-ecosystem/README.md). Phase 0 and Phase 1 shipped and are accurate. **Phase 2 (Merchant Portal, §7) and Phase 5 (E-commerce Plugins, §10) describe `apps/merchant-web` and a `widget_clients`-based merchant identity — that app was deleted entirely on 2026-07-10, and the identity model was replaced by a `users`→`merchants` table link with admin-granted access (no self-serve signup, no separate subdomain).** Phase 3/3b were separately abandoned on 2026-07-07 (unrelated kiosk-app plan change). Treat §7, §10, and any Phase 3/3b references below as historical design rationale only, not a current or future implementation target.
> **Date:** 2026-07-04
> **Scope:** Phases 0–5 below. Each phase is independently shippable and testable.
> **Related:** `docs/virtual-tryon-system-design.md` (current system), `legacy_ecosystem/` (legacy PHP source being replaced), `apps/virtual-tryon-mobile&kiosk/` (Android kiosk app being migrated).
> **Implementation:** handed off phase-by-phase to Codex. Each phase has its own standalone, self-contained handoff document (with an explicit Definition of Done and a Report Back section) in [`docs/multi-app-ecosystem/`](multi-app-ecosystem/README.md) — hand one file at a time, review against this master doc after each, then proceed. This master document is the design rationale; the per-phase files in that folder are the actionable specs.

---

## §1 Context

Three things sit outside the documented monorepo today:

1. **`apps/virtual-tryon-mobile&kiosk`** — a native Android (Kotlin) kiosk-tablet app for in-store virtual try-on, currently wired to a completely different legacy backend (`https://api.tryme.com/`, a CodeIgniter 3 PHP monolith, source snapshot at `legacy_ecosystem/`). It never talks to this monorepo's `apps/api`/`apps/dispatcher`/R2/ComfyUI stack at all.
2. **The legacy PHP ecosystem** (`legacy_ecosystem/`) — one codebase/database serving *six* logical apps: an admin panel, a kiosk-operator ("merchant") dashboard, a near-duplicate "trytool" admin dashboard, a customer webtool, an embeddable JS widget, and the mobile/kiosk REST API the Android app hits.
3. **Today's Merchant Portal** — already built and production-grade, but living entirely inside `apps/catalogues-web` behind an `(merchant)` route group, serving widget-embed customers (e-commerce sites embedding the JS try-on widget) via the `widget_clients` table.

**Goal:** migrate the kiosk app onto the current backend, extract the merchant portal to `merchant.tryme.com`, split the admin SPA to `admin.tryme.com`, let merchants manage their **own private product catalog** that their kiosk devices display — a capability that **never actually existed** in the legacy system (verified by reading the legacy kiosk-operator dashboard controllers: they are read-only analytics, not product management; the garment catalog was always global) — feed the catalogues merchants create in the studio into that kiosk catalog (§7.3a), and package the widget as **Shopify/Wix marketplace plugins** (Phase 5). Everything shares one backend, one Postgres database, and one JWT/auth scheme — without inheriting the legacy system's confirmed security debt (§4).

### Decisions (confirmed, do not re-litigate)

- **(A)** Per-merchant catalogs are genuinely **private/isolated** — a net-new capability, not a migration.
- **(B)** One unified merchant identity: the existing `widget_clients` entity gains kiosk capability. No new parallel account type.
- **(C)** One consolidated JWT/auth scheme, but **independent per-subdomain logins** (no cross-domain SSO) — matches how `admin-web`/`catalogues-web` already behave.
- **(D)** Full phased spec, executable one phase at a time by an implementer without re-deriving design decisions.
- **(E)** The merchant portal is the merchant's **single management surface**: widget config, kiosk fleet + kiosk catalog, e-commerce integrations, billing — *and* management of the try-on catalogue data they create in `catalogues-web`. Catalogue **creation** stays in the catalogues-web studio (rebuilding the 4-step wizard inside merchant-web would be pure duplication); the portal consumes, manages, and publishes that data to the kiosk (§7.3a).
- **(F)** Platform plugins (Shopify, Wix) that package the existing embeddable widget for merchant e-commerce stores are in scope as Phase 5.

---

## §2 Target Topology

| Host | Serves | Backend path proxying |
|---|---|---|
| `app.tryme.com` | `apps/catalogues-web` (customer web) — unchanged | `/v1/` → api:4000, `/minio/` → minio:9000 (existing) |
| `admin.tryme.com` | `apps/admin-web` (Vite SPA) — moved from `app.tryme.com/panel/` | `/admin/` and `/v1/` → api:4000 (Phase 1) |
| `merchant.tryme.com` | `apps/merchant-web` (new Next.js app, extracted) | none — all API calls go through its own server-side BFF (Phase 2) |
| Android kiosk fleet | `apps/virtual-tryon-mobile&kiosk` | direct HTTPS to api `/v1/kiosk/*` with Bearer tokens (Phase 3) |

One Fastify API, one Postgres, one Redis, one MinIO/R2, one dispatcher — unchanged. Each browser portal has its own login and session; all principals resolve against the same database.

Principal types after this plan: `user` (customer), `admin` (JWT `aud:'admin'` + `admin_users` row), `merchant` (a `widget_clients` row, portal login), `widget client` (same row, `X-Widget-Key` server-to-server/embed), `kiosk device` (new — JWT `aud:'kiosk'`, one row in `kiosk_devices`, paired to exactly one merchant).

### Responsibility boundaries

| Surface | Audience | Owns |
|---|---|---|
| `admin.tryme.com` | **Company staff only.** | Merchant accounts (approval, credits, kiosk enablement, linked-user bridge), workflow templates, GPU workers, and the **global shared data every catalogues-web user consumes** (model faces/backgrounds/poses, garment types, global lower/shoe catalog). Oversight/moderation of merchant content — never day-to-day merchant product management. |
| `merchant.tryme.com` | Merchants. | Their widget (key, allowed origins, settings), their kiosk fleet (devices, pairing codes), their private kiosk catalog, their e-commerce integrations (Shopify/Wix — Phase 5), billing/credits, and management + kiosk-publishing of the catalogues they created in the studio (§7.3a). |
| `app.tryme.com` | End users — including merchants acting as creators. | The studio wizard: uploading garments, generating try-on catalogues. This is where merchant catalogue **data is created**. |
| Android kiosk | In-store shoppers. | Consuming the paired merchant's published catalog; try-on; like/cart. Read-only on everything else. |

---

## §3 What the legacy system got right (and we keep)

- **Separation of concerns by app section** — legacy already had separate asset bundles per section (`assets/admin/`, `assets/useradmin/`, `assets/webtool/`, `public/widget/`); this plan completes the thought by giving each section its own deployable app.
- **bcrypt password hashing** where passwords were actually checked.
- **A single shared database** for all portals — correct call, kept.
- **Credit wallet + immutable ledger + Razorpay transaction log** — legacy modeled this well; the current system already has the superior version (`widget_client_credits`, `widget_credit_ledger`, `merchant_payments`).

## §4 Confirmed legacy debt this plan deliberately does NOT inherit

Verified by reading the legacy source directly — file and line references are to `legacy_ecosystem/`:

| # | Debt | Evidence | Fixed by |
|---|---|---|---|
| L1 | Login without password verification | `application/controllers/Authtool.php::toollogin_submit()` takes email only, no password field; `loginnew_submit()` has the field but `password_verify` is commented out | Retired entirely — merchant login is `apps/api`'s existing bcrypt/argon2 flow (Phase 2E hardens it further) |
| L2 | Hardcoded static shared secret in source | `e5e8ec37…e9c4` in `Tryon.php`, `Webtoolapi.php`, `config/webtool_api.php`, and the Android app's `APIConstant.kt` | Phase 3 deletes it with no equivalent — HTTPS + short-TTL pairing codes + per-device JWTs are the boundary |
| L3 | Client-supplied `device_id`, zero server-side pairing validation | `Tryonnew.php::app_signin_post()` (line ~4077) inserts a session for any never-seen device_id | Phase 0 — pairing is a merchant/admin-initiated, single-use, time-boxed code; device identity is a server-generated UUID |
| L4 | Three inconsistent token stores, no expiry/rotation | `webtool_api_tokens` (no expiry column), `users.api_key`, `user_sessions.api_key` | Phase 0 — one `refresh_tokens` table, one rotation/replay policy, shared with every portal |
| L5 | IDOR in likes/cart: identity from request body | `Tryonnew.php::likes_post()` (2544) / `cart_post()` (2627) read `user_id` from POST data after authenticating a different token | Phase 3 — owner identity always derived server-side from the verified token; the route schema has no field for it |
| L6 | Zero merchant scoping on the catalog | `web_models`/`web_models_lower`/`web_shoes` global; the one scoping attempt (`garment_list.branchname` filter) is commented out | Phase 2C — every `merchant_catalog_items` query filters by server-resolved `widgetClientId` |
| L7 | Dead code kept alive via filename suffixes | `Webtoolold.php`, `Tryonbkp151025.php`, `Tryonnew25-03.php`, `webtoolapi2026-04-28.php`, … | Phase 4 — repo convention: delete, don't rename |
| L8 | Two never-unified merchant identities | `trytooladmin` (kiosk operator) vs `webtoolusers` (web/API client), separate tables, separate logins | Decision B — one `widget_clients` row is both |

**A gap in the *current* system found during this research** (not legacy): `POST /v1/merchant/login` issues a single 7-day JWT with no refresh rotation and no revocation path (no `/v1/merchant/refresh` route exists). Originally deferred, but **pulled into scope as Phase 2E** — this plan makes the merchant portal the kiosk pairing-code authority, and a stolen 7-day irrevocable token would allow rogue-device pairing with no kill switch. The fix is nearly free once Phase 0 generalizes `refresh_tokens` ownership.

---

## §5 Phase 0 — Auth Foundation

No user-facing surface. Lands the JWT audience + device-pairing plumbing every later phase depends on. Safe to ship and sit unused.

### 5.1 DB

New `packages/db/src/schema/kiosk.ts`:

```ts
export const kioskDevices = pgTable('kiosk_devices', {
  id: uuid('id').primaryKey().defaultRandom(),
  widgetClientId: uuid('widget_client_id').notNull()
    .references(() => widgetClients.id, { onDelete: 'cascade' }),
  label: text('label').notNull(),                       // merchant-assigned, e.g. "Front Counter Tablet"
  status: text('status').notNull().default('pending'),  // 'pending' | 'active' | 'revoked'
  pairingCodeHash: text('pairing_code_hash'),            // sha256; cleared once claimed/expired
  pairingCodeExpiresAt: timestamp('pairing_code_expires_at', { withTimezone: true }),
  androidId: text('android_id'),                         // audit/support only — NEVER a trust boundary
  appVersion: text('app_version'),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  pairedAt: timestamp('paired_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
```

Modify `packages/db/src/schema/users.ts` (`refreshTokens`):
- `userId` becomes nullable.
- Add **two** nullable owner columns: `kioskDeviceId` (FK → `kiosk_devices`, cascade) and `widgetClientId` (FK → `widget_clients`, cascade). The latter is used by Phase 2E's merchant refresh — adding it now means the CHECK constraint is written once, not migrated twice.
- Migration adds `CHECK (num_nonnulls(user_id, kiosk_device_id, widget_client_id) = 1)`.

**Reuse, don't duplicate:** extending `refreshTokens` (rather than parallel per-portal token tables — legacy's exact mistake, L4) means `rotateTokenFamily()` in `apps/api/src/modules/auth/routes.ts` is reused as-is. Generalize its `userId: row.userId` return to an `ownerId` + owner-type.

**Kiosk refresh-token TTL: 30 days** (vs the 7-day default for user/admin portals). Rotation is sliding — an actively-used kiosk refreshes long before expiry and stays paired indefinitely — but a tablet powered off past the TTL must be re-paired with a fresh code. 7 days is too tight for store reality (seasonal closure, tablet in a drawer, festival weekend); 30 days keeps re-pairing rare while still bounding how long a stolen powered-off tablet stays valid.

Migration file: `packages/db/src/migrations/0083_kiosk_devices_and_refresh.sql` — `0082_watermarking_columns.sql` was the head when this plan was written; **re-check `packages/db/src/migrations/meta/_journal.json` at execution time** per CLAUDE.md's Migration Index Conflicts section.

### 5.2 API

- `apps/api/src/modules/auth/service.ts` — add `verifyKioskAccess()`, mirroring the existing `verifyAdminAccess()` (`aud: 'kiosk'`, HS256).
- `apps/api/src/plugins/widget-auth.ts` — add a `requireKioskDevice` decorator next to the existing `requireMerchant`/`requireWidgetClient`. Verifies `aud:'kiosk'` + `kind:'access'`, looks up `kiosk_devices` by `sub` **on every request** (same JWT-claim-AND-DB-row pattern CLAUDE.md mandates for admin), requires `status === 'active'`, sets `req.kioskDeviceId` and `req.merchantClientId` — reusing the exact property name `requireMerchant` already sets, so downstream handlers don't care whether the caller was a human or a device.

New module `apps/api/src/modules/kiosk/`:
- `provisioning.ts` — shared `createKioskDevice(app, widgetClientId, label)`: random 10-char base32 pairing code, sha256-hashed at rest, 15-minute TTL. Used by both merchant-portal and admin provisioning routes so code generation isn't duplicated.
- `auth.routes.ts`:

| Method + Path | Auth | Notes |
|---|---|---|
| `POST /v1/kiosk/auth/claim` | public | `{pairingCode, appVersion?, androidId?}`. Rate-limited (10/min/IP); brute force is bounded by the code's ~50-bit entropy + 15-min TTL (a wrong code matches no row under hash lookup, so per-row attempt counters can't work — don't add one). Success: `status→'active'`, `pairedAt=now()`, clears `pairingCodeHash`, issues `{accessToken, refreshToken}` (`aud:'kiosk'`, `sub` = device id). |
| `POST /v1/kiosk/auth/refresh` | body refresh token | Mirrors `/v1/auth/refresh-body`'s shape but **do not reuse that route** — it hardcodes `aud:'admin'` on reissue; pointing kiosks at it would mint admin-audience tokens for a kiosk device. New route, `aud:'kiosk'`. **Must assert the token row's owner type**: reject any refresh token whose row has `userId` or `widgetClientId` set — only `kioskDeviceId` rows accepted. Every portal's refresh route gets the mirror-image assertion; this is what prevents a stolen token from one portal being laundered into another portal's audience. Also touches `lastSeenAt`/`appVersion` here (not on every request — keeps the hot path free of an extra write). |
| `POST /v1/kiosk/auth/logout` | body refresh token | Revokes the token family **and** sets `kiosk_devices.status='revoked'`. A kiosk has no password to log back in with, so logout means unpair; reuse of the physical tablet requires a fresh pairing code. Deliberate UX choice. |

- Extend `apps/api/src/modules/merchant/` with `kiosk-devices.routes.ts` (same file-split pattern as the existing `payments.routes.ts`): `POST` / `GET` / `PATCH /v1/merchant/kiosk-devices[/:id]`, plus `POST /v1/merchant/kiosk-devices/:id/pairing-code` (regenerate — for `pending`/`revoked` rows: new hash + fresh TTL, status back to `pending`; prevents duplicate device rows piling up every time a code expires or a tablet is re-paired). All `requireMerchant`. PATCH covers rename and `{status:'revoked'}`. Only non-revoked rows count toward Phase 2's `maxKioskDevices` limit.
- Extend `apps/api/src/modules/admin/widget-clients.routes.ts` (already owns nested per-client resources like `/credits`): `POST /v1/admin/widget-clients/:id/kiosk-devices`, `PATCH /v1/admin/widget-clients/:id/kiosk-devices/:deviceId` — `requireAdmin`. *(Convention note: 112 of 117 admin routes live at `/admin/*`; only the widget-clients module is at `/v1/admin/*`. These nest under the existing outlier rather than spreading it; genuinely new admin surfaces in later phases use the dominant `/admin/*`.)*

### 5.3 Verification

New `apps/api/test/integration/kiosk-auth.test.ts` (standard harness — fresh `CREATE DATABASE` + Drizzle migrate per test file, against already-running `pnpm docker:up` infra; see `apps/api/test/helpers/containers.ts`):

1. Seed a `widgetClients` row, call `createKioskDevice` → pairing code hash set, `status='pending'`.
2. `POST /v1/kiosk/auth/claim` with the plaintext code → 200, `status='active'`, tokens returned.
3. Replay the same code → rejected (hash already cleared).
4. `POST /v1/kiosk/auth/refresh` → new access token, decodable with `aud:'kiosk'`.
5. A `requireKioskDevice`-gated stub hit with an `aud:'admin'` token → 401 (audiences don't cross).
6. Logout → device flips to `revoked`; refresh with the same token family → 401.
7. 11th claim attempt in a minute from one IP → 429.
8. A **user** refresh token presented to `/v1/kiosk/auth/refresh` → 401 (owner-type assertion — the cross-portal laundering check).

---

## §6 Phase 1 — Subdomain Infra (admin.tryme.com)

Pure deployment change. Zero feature diff. Independent of Phase 0/2 — can run in parallel.

### 6.1 Changes

- `apps/admin-web/vite.config.ts`: `base: '/panel/'` → `base: '/'`. Admin-web now only ever deploys at its own subdomain root; the env-conditional subpath complexity disappears entirely.
- `apps/api/src/env.ts`: `CORS_ORIGIN` becomes a comma-separated list parsed to `string[]` via `.transform()`. `apps/api/src/server.ts`'s cors registration needs no other change — `@fastify/cors`'s `origin` option accepts `string[]` natively. No new dependency.
- `infra/docker-compose.prod.yml`: the `minio-bootstrap` step's `mc cors set` JSON currently interpolates a single `${CORS_ORIGIN}` — this is a **separate CORS surface** (browsers PUT/GET directly against MinIO via presigned URLs) and must independently become a multi-origin array. Easy to miss.
- New CloudPanel/NGINX vhost:

  ```
  admin.tryme.com/        → 127.0.0.1:3001   (admin-web container, unchanged)
  admin.tryme.com/admin/  → 127.0.0.1:4000   (api — dominant /admin/* prefix)
  admin.tryme.com/v1/     → 127.0.0.1:4000   (api — covers the /v1/admin/widget-clients outlier)
  ```

  `admin-web` makes 100% relative-path `fetch()` calls with no base URL (confirmed in `apps/admin-web/src/lib/data.ts`) — which is exactly why both API prefixes must be proxied on the new subdomain, not just static files served. This also makes admin→API traffic *same-origin*, so its cookie-based refresh keeps working with no code change.
- Optional: `return 301` on `app.tryme.com/panel/*` → `https://admin.tryme.com/$1` for old bookmarks.
- `.env.production`: `CORS_ORIGIN=https://app.tryme.com,https://admin.tryme.com`. Update `.env.production.example` to document the comma-separated format.

**CORS precision note:** because admin→API is same-origin behind the proxy, adding the admin origin to API CORS is belt-and-suspenders. The **load-bearing** multi-origin change is MinIO's — presigned uploads/downloads go directly browser→MinIO host, which is genuinely cross-origin from the new subdomain (admin asset uploads use presigned PUTs).

**Operational note:** existing admin sessions are stranded on the old host after the move — admins log in once on the new subdomain. Announce it; nothing to code.

### 6.2 Verification

- `pnpm --filter @tryme/admin build` (production) → built `index.html` references `/assets/...`, not `/panel/assets/...`.
- Local smoke: run the API with two dev-port origins in `CORS_ORIGIN`; both get a matching `Access-Control-Allow-Origin` echo; a third origin is rejected.
- Existing `apps/api/test/integration/admin-*.test.ts` suite passes unmodified — proves auth/route behavior is untouched.

---

## §7 Phase 2 — Merchant Portal Extraction + Unification (merchant.tryme.com)

### 7.1 (2A) Extract the `(merchant)` route group into new `apps/merchant-web`

New Next.js 15 app, package `@tryme/merchant`, `Dockerfile` mirrors `apps/catalogues-web/Dockerfile`.

`git mv` (preserve history), **dropping the redundant `/merchant` URL segment** — the subdomain is the namespace now, matching how `admin-web` doesn't prefix its own routes with `/admin/`:

- `apps/catalogues-web/src/app/(merchant)/merchant/*` → `apps/merchant-web/src/app/*`
- `apps/catalogues-web/src/app/api/merchant/*` → `apps/merchant-web/src/app/api/merchant/*` (BFF proxy layer, unchanged shape — still calls Fastify server-side via `NEXT_PUBLIC_API_URL`)
- `apps/catalogues-web/src/app/(merchant)/lib.ts` → `apps/merchant-web/src/app/lib.ts` (the `requireMerchant()` server helper)

Copied, not shared (two small files don't justify a new shared UI package): `SupportModal.tsx`, the icon components the merchant `layout.tsx` imports, and the `--c-merchant-*` CSS variables block.

Dropped: `NEXT_PUBLIC_BASE_PATH` handling — `merchant-web`'s `basePath` is always empty.

> **Do NOT move `apps/catalogues-web/public/widget/loader.js`.** Verified: the embeddable widget script is served by `catalogues-web` at `app.tryme.com/widget/loader.js`, and existing merchant e-commerce sites hotlink that exact URL. It is widget infrastructure, not merchant-portal UI — it stays in `catalogues-web` even though everything else merchant-flavored moves out. Moving or renaming it breaks every live embed on deploy. The dashboard's embed-snippet copy in `merchant-web` keeps generating the `app.tryme.com` URL.

Cleanup in `apps/catalogues-web/src/middleware.ts`: remove the `/merchant/*` public-path entries, the `/api/merchant` passthrough, and the merchant cookie-check branch. Delete `(merchant)/` and `api/merchant/` from `catalogues-web` after the move.

Deployment: new `merchant` service in `infra/docker-compose.prod.yml` (mirrors the `web` block, `127.0.0.1:3002:3000`). New vhost `merchant.tryme.com/` → `127.0.0.1:3002` — **no `/v1/` proxy needed**: every merchant-portal→API call goes through the Next.js server-side BFF (confirmed: the `app/api/merchant/*/route.ts` files call Fastify server-side; the browser never hits Fastify directly for this surface). Add `https://merchant.tryme.com` to `CORS_ORIGIN` **and** the MinIO bootstrap CORS JSON (needed for the portal's presigned catalog-image uploads, §7.3).

### 7.2 (2B) `widget_clients` kiosk-capability extension

```sql
ALTER TABLE widget_clients ADD COLUMN kiosk_enabled boolean NOT NULL DEFAULT false;
ALTER TABLE widget_clients ADD COLUMN max_kiosk_devices integer NOT NULL DEFAULT 5;
```

Admin-settable only: extend `PATCH /v1/admin/widget-clients/:id` to accept `kioskEnabled` / `maxKioskDevices`. `POST /v1/merchant/kiosk-devices` (Phase 0) checks both before creating a device row.

### 7.3 (2C) Merchant-private catalog — the net-new capability (Decision A)

New table in `packages/db/src/schema/widget.ts` (co-locates with `merchantPayments` — the "hangs off `widgetClients`" grouping already used there):

```ts
export const merchantCatalogItems = pgTable('merchant_catalog_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  widgetClientId: uuid('widget_client_id').notNull()
    .references(() => widgetClients.id, { onDelete: 'cascade' }),
  label: text('label').notNull(),
  sku: text('sku'),                        // merchant's own free-text code, no cross-merchant uniqueness
  gender: text('gender'),                  // 'men' | 'women' | 'boy' | 'girl' | null — drives kiosk theme screen
  category: text('category'),              // merchant's free-text grouping (e.g. "Sarees") — drives kiosk category screen
  r2Key: text('r2_key').notNull(),         // garment image fed to try-on jobs — always owned/copied, never a reference into another surface's storage
  thumbnailKey: text('thumbnail_key').notNull(), // grid display image (for imports: the generated model shot, which sells better than a flat garment photo)
  sourceJobId: uuid('source_job_id').references(() => jobs.id, { onDelete: 'set null' }), // provenance when imported from a catalogues-web job (§7.3a); null for direct uploads
  isActive: boolean('is_active').notNull().default(true),
  moderationStatus: text('moderation_status').notNull().default('approved'), // 'approved' | 'rejected'
  moderationNote: text('moderation_note'),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ widgetClientIdx: index('merchant_catalog_items_widget_client_idx').on(t.widgetClientId, t.isActive) }));
// migration also adds: UNIQUE (widget_client_id, source_job_id) WHERE source_job_id IS NOT NULL  — blocks double-import of the same job
```

Structurally flat — no category *tables* or hierarchy. But the `gender` and `category` denormalized text columns are **required for UX preservation, not gold-plating**: the kiosk app's existing navigation (`HomeDressesForActivity` gender/theme screen → `SelectVastraCategoryActivity` → item grid) needs grouping data to render, and the mandate is to keep those screens as-is. The kiosk client groups a single flat `GET /v1/kiosk/catalog` response by these two fields client-side — no category CRUD, no join tables, no extra endpoints. A merchant catalog is dozens-to-low-hundreds of SKUs; `label ILIKE` + `sortOrder` is the only search. `moderationStatus` defaults `'approved'` — the merchant *account* already went through admin approval to become active; moderation is reactive takedown, not a pre-publish gate.

New key builders in `packages/storage/src/keys.ts`: `merchantCatalogItem(widgetClientId, id)`, `merchantCatalogItemThumb(widgetClientId, id)`.

**Upload hygiene:** presign restricted to an image content-type allowlist (`image/jpeg`, `image/png`, `image/webp`) with the same size cap the widget presign enforces. On `POST /v1/merchant/catalog` the API `headObject`s both keys to confirm the objects exist before inserting the row (`StorageProvider.headObject` already exists). **Thumbnails are generated client-side in the portal** (canvas downscale before upload — two presigned PUTs, full + thumb). The API has no image-processing dependency and shouldn't grow one; sharp lives only in the dispatcher.

New `apps/api/src/modules/merchant/catalog.routes.ts` (all `requireMerchant`, ownership-checked against `req.merchantClientId`):

| Method + Path | Notes |
|---|---|
| `POST /v1/merchant/catalog/presign` | Mirrors `/v1/widget/presign`; key prefix `merchant-catalog/{clientId}/{uuid}/...` |
| `GET /v1/merchant/catalog` | |
| `POST /v1/merchant/catalog` | `{label, sku?, gender?, category?, r2Key, thumbnailKey}` — `r2Key` ownership bound via the same Redis `upload:owner:*` pattern `assertOwnsUploadKey` uses |
| `PATCH /v1/merchant/catalog/:id` | |
| `DELETE /v1/merchant/catalog/:id` | Hard delete for v1 — no recycle-bin parity yet |

New `apps/api/src/modules/admin/merchant-catalog.routes.ts` (`/admin/*` — the dominant convention): `GET /admin/merchant-catalog?widgetClientId=&search=`, `PATCH /admin/merchant-catalog/:id` (`{isActive?, moderationStatus?, moderationNote?}`). Both `requireAdmin`. No global cross-merchant moderation inbox — admins moderate per-merchant from the widget-client detail view; add a queue page only if volume warrants it.

### 7.3a (2C-interop) Studio interop — using catalogues-web data on the kiosk

The catalogue data a merchant creates in the studio belongs to a `users` row; the merchant portal authenticates a `widget_clients` row. These are different identities today, so interop needs a bridge — **one nullable column, not an identity merge**:

```sql
ALTER TABLE widget_clients ADD COLUMN user_id uuid REFERENCES users(id) ON DELETE SET NULL;
```

- **Set by admin during merchant approval** (the admin is already reviewing the account). The admin UI auto-suggests a match when `widget_clients.email` equals a verified `users.email`, but the link is always an explicit admin confirm — never a silent auto-link, because merchant signup email is unverified pre-approval and email-match auto-linking would let an attacker claim a victim's studio data by signing up with their address.
- A full single-identity merge (one credential row acting as both user and merchant) is **deliberately deferred** — the link column delivers all the interop actually required.

**New merchant-portal surface** (all `requireMerchant`):

| Method + Path | Notes |
|---|---|
| `GET /v1/merchant/catalogues` | Lists the linked user's catalogues and their COMPLETED jobs (labels, thumbnails, created dates), read via `widget_clients.userId`. Unlinked merchant → empty list; the portal shows an empty state ("create catalogues in the studio / ask support to link your account"). |
| `POST /v1/merchant/catalog/import` | Body `{jobId}`. Verifies the job belongs to the linked user and is COMPLETED, then **server-side copies** the garment image (`job_inputs.upperGarmentKey`) and the result thumbnail (`job_outputs.thumbnailKey`) into `merchant-catalog/{clientId}/...` keys (`StorageProvider.getObject` → `putObject` — both already exist), and inserts a `merchant_catalog_items` row with `sourceJobId` set and label defaulted from the catalogue name. Re-import of the same job → 409 (the partial unique index). |

**Copy, don't reference — this is load-bearing.** If kiosk items pointed at studio-owned R2 keys, deleting a catalogue in catalogues-web (or the admin recycle-bin purging it) would silently break live kiosk items in stores. Copying at import time decouples the two lifecycles completely; `sourceJobId` stays as provenance only (`set null` on job deletion, item keeps working).

**Merchant-web UI:** a "My Catalogues" page (browse linked studio output, one-click *Publish to kiosk* per job) and a provenance badge (imported vs uploaded) on the kiosk-catalog page. Deeper studio-data management (rename/regenerate/delete catalogues) stays in catalogues-web where it already exists — the portal manages *kiosk visibility*, not the studio itself.

**Legacy debt fixed here:** this is the modern replacement for what legacy never had — its kiosk catalog was admin-uploaded and global (L6); now a merchant's own studio output flows to *their* kiosks and no one else's.

### 7.4 (2D) Admin Parity Rule

`apps/admin-web/src/pages/WidgetClientDetail.tsx` gains: a **Kiosk Devices** section (list, generate-pairing-code showing the plaintext code once, revoke), a **Kiosk-Enabled** toggle + max-devices field, a **Linked User** field (sets `widget_clients.userId` with an email-match suggestion — §7.3a), and a **Private Catalog** tab (list/moderate this merchant's items). Port the same additions to `apps/admin-mobile/src/app/(tabs)/more/widget-clients/[id].tsx` per CLAUDE.md's Admin Parity Rule — additive sections on an existing detail screen, not new routes, on both platforms.

**Legacy debt fixed here (L6, L8):** every read/write on `merchant_catalog_items` filters by `widgetClientId` resolved server-side from the authenticated principal — never a client-supplied param. Finishes what legacy's `garment_list.branchname` scoping attempted and abandoned. One `widget_clients` row is now both the widget-embed identity and the kiosk-operator identity.

### 7.5 (2E) Merchant auth hardening (pulled into scope by this plan)

Today `POST /v1/merchant/login` mints a single 7-day JWT with no refresh, no rotation, no revocation. Tolerable for a read-only dashboard; **not acceptable once this portal can mint kiosk pairing codes and manage what kiosks display** — a stolen token means a week of rogue-device pairing with no kill switch.

- Shorten the merchant access JWT to the standard short TTL (same `JWT_EXPIRY` the other portals use); keep the `portal:'merchant'` claim as-is.
- Add `POST /v1/merchant/refresh` using the Phase 0-generalized `rotateTokenFamily` with `refresh_tokens.widgetClientId` as owner (column + CHECK constraint already landed in Phase 0 — this is why). Same owner-type assertion as every other refresh route: only `widgetClientId` rows accepted.
- Merchant-web's BFF adopts the same silent-refresh-on-401, single-flight pattern `catalogues-web`'s `src/lib/api.ts` already implements — copy that logic, don't invent a new one.
- Revocation: `PATCH /v1/admin/widget-clients/:id` with `isActive=false` already exists; verify `requireMerchant` checks `isActive` on its per-request DB lookup (add if missing) so deactivation takes effect within one access-token TTL instead of up to 7 days.

### 7.6 Verification

- `apps/api/test/integration/merchant-catalog.test.ts`: seed an active merchant, presign → PUT to MinIO → create → list. **Isolation check (the point of Decision A):** a second merchant's token gets nothing for the first merchant's item.
- Studio import: seed a linked user with a COMPLETED job (garment key + output thumb in MinIO) → `POST /v1/merchant/catalog/import` → new item has its **own** copied keys under `merchant-catalog/{clientId}/`, `sourceJobId` set; delete the source job → kiosk item still serves (copied objects untouched, `sourceJobId` nulled); re-import same job → 409; an **unlinked** merchant importing any job → rejected; a linked merchant importing **another user's** job → rejected.
- `POST /v1/admin/widget-clients/:id/kiosk-devices` end-to-end; `kioskEnabled=false` merchants rejected.
- Merchant refresh: login → wait/force-expire access token → BFF silently refreshes → original request succeeds; a revoked family → 401 → redirected to login.
- Manual: `pnpm --filter @tryme/merchant dev` — `/dashboard`, `/login`, `/api-keys` render and round-trip to a local `apps/api`.
- `pnpm --filter @tryme/web build` still succeeds after `(merchant)` removal — no dangling imports in `catalogues-web`.

---

## §8 Phase 3 — Kiosk Android Migration

Networking-layer rewrite only. Every Activity/screen stays as-is except the one that structurally can't (login → pairing).

### 8.1 The one big simplification: reuse the widget job pipeline

Confirmed directly in `apps/dispatcher/src/job/processor.ts` (~line 121): routing to `processWidgetJob` is a plain `if (job.widgetClientId)` check on the DB row — not a queue-message type tag. **Kiosk try-on jobs are widget jobs with a different auth front door and a private-catalog-resolved garment instead of a URL-fetched one. Zero dispatcher changes.** Consequence: kiosk try-on is a single garment-overlay result, matching the widget workflow template's node shape (no lower/shoe nodes on `workflowType='widget'` templates). Lower/shoe compositing at a kiosk is explicitly out of scope — it would need a new workflow type.

Factor the transaction currently inline in `apps/api/src/modules/widget/routes.ts`'s `POST /v1/widget/jobs` handler into a shared `createWidgetStyleJob(app, {widgetClientId, kioskDeviceId?, upperGarmentKey, customerPhotoKey, cost})` in `apps/api/src/modules/widget/create-job.ts`, called by both the existing widget route and the new kiosk route — one credit-deduct-plus-insert transaction implementation, not two that can drift.

Kiosk jobs cost the existing `WIDGET_JOB_COST` (10 credits — same constant, same refund on cancel/failure). On insufficient balance, reuse the widget flow's existing insufficient-credits error code so the kiosk shows store staff an actionable "top up in the merchant portal" message. Kiosk job creation gets the same 60/min rate limit as the widget route, keyed per device.

### 8.2 DB

Add to `packages/db/src/schema/kiosk.ts` (alongside `kioskDevices`):

```ts
export const kioskResultLikes = pgTable('kiosk_result_likes', {
  id: uuid('id').primaryKey().defaultRandom(),
  jobId: uuid('job_id').notNull().references(() => jobs.id, { onDelete: 'cascade' }),
  widgetClientId: uuid('widget_client_id').notNull().references(() => widgetClients.id, { onDelete: 'cascade' }),
  kioskDeviceId: uuid('kiosk_device_id').references(() => kioskDevices.id, { onDelete: 'set null' }), // audit only
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ uniq: unique('kiosk_result_likes_job_widget_unique').on(t.jobId, t.widgetClientId) }));

export const kioskResultCartItems = pgTable('kiosk_result_cart_items', {
  id: uuid('id').primaryKey().defaultRandom(),
  jobId: uuid('job_id').notNull().references(() => jobs.id, { onDelete: 'cascade' }),
  widgetClientId: uuid('widget_client_id').notNull().references(() => widgetClients.id, { onDelete: 'cascade' }),
  kioskDeviceId: uuid('kiosk_device_id').references(() => kioskDevices.id, { onDelete: 'set null' }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ uniq: unique('kiosk_result_cart_items_job_widget_unique').on(t.jobId, t.widgetClientId) }));
```

Scoped by `(jobId, widgetClientId)`, not per-device — legacy's like/cart is store-side curation (the kiosk authenticates an operator/device, not an individual shopper account), so merchant-level dedup is correct. `kioskDeviceId` is audit-only (`set null` on delete) so revoking a device never deletes like/cart history.

Also add a nullable `kioskDeviceId` column to **`jobs`** (`onDelete: 'set null'`), populated by `createWidgetStyleJob` when the kiosk route calls it. Audit/ops only — dispatcher routing stays exactly `if (job.widgetClientId)`. Without it, a store with five kiosks can't answer "which tablet is generating all these jobs?" — kiosk jobs would be indistinguishable from the merchant's web-widget jobs in every support/billing query.

### 8.3 API

New `apps/api/src/modules/kiosk/catalog.routes.ts`: `GET /v1/kiosk/catalog` (`requireKioskDevice`) — the paired merchant's active + approved `merchant_catalog_items` (flat list; client groups by `gender`/`category`).

New `apps/api/src/modules/kiosk/jobs.routes.ts` (all `requireKioskDevice`):

| Method + Path | Notes |
|---|---|
| `POST /v1/kiosk/presign` | Mirrors `/v1/widget/presign`; key prefix `kiosk-inputs/{deviceId}/{uuid}/photo.{ext}` |
| `POST /v1/kiosk/jobs` | `{merchantCatalogItemId, customerPhotoKey, aspectRatio?}` — resolves item → `r2Key`, rejects if it doesn't belong to `req.merchantClientId`, calls `createWidgetStyleJob` |
| `GET /v1/kiosk/jobs/:id` | Includes `liked`/`inCart` booleans (left-join by `widgetClientId`). When COMPLETED, also includes `shareUrl`: a presigned GET for the result (~24h TTL, via the existing `StorageProvider.presignGet`) — this is what the app's QR-download screen (`ScanAndDownloadVastraResultActivity`) encodes so shoppers pull their try-on onto their own phone. **Do not build a public result endpoint** — verified the existing `results/` module is a password-gated internal gallery, not reusable; a TTL'd presigned URL needs no new auth surface. |
| `DELETE /v1/kiosk/jobs/:id` | Mirrors widget cancel + refund |
| `GET /v1/kiosk/jobs/:id/events` | Same `sse:events:widget:{clientId}` Redis channel the dispatcher already publishes to — no dispatcher change |

New `apps/api/src/modules/kiosk/results.routes.ts` (all `requireKioskDevice`): `PUT`/`DELETE /v1/kiosk/results/:jobId/like`, `PUT`/`DELETE /v1/kiosk/results/:jobId/cart`.

**Owner identity (`widgetClientId`) always comes from `req.merchantClientId`, set server-side by `requireKioskDevice`'s DB lookup — never from a request body field.** Direct fix for legacy IDOR L5; the route schema doesn't even have a field to spoof.

### 8.4 Android app changes (`apps/virtual-tryon-mobile&kiosk`)

| File | Change |
|---|---|
| `ApiUtils/APIConstant.kt` | New API host; endpoints → `/v1/kiosk/*`; **delete the hardcoded shared-secret constant entirely** (L2) |
| `ApiUtils/APICaller.kt` | Header injection → `Authorization: Bearer <accessToken>`; add 401→refresh→retry, mirroring `apps/admin-mobile`'s token-refresh pattern |
| `ApiUtils/APIInterface.kt` | Unchanged — already a generic Retrofit interface |
| `utils/PrefsManager.kt` | Refresh-token storage moves from plaintext `SharedPreferences` to `androidx.security.crypto.EncryptedSharedPreferences` (already-available AndroidX artifact) |
| `viewmodel/category/SareecategoryDataViewModel.kt` | `likeVastraTryOnResultAPI`/`addToCartVastraTryOnResultAPI` stop sending a client-side user id; call the new `PUT`/`DELETE` endpoints |
| `viewmodel/category/SareeCategoryDataRepository.kt` | Login call repointed to `/v1/kiosk/auth/claim` with `{pairingCode}`; customer-photo upload changes from legacy multipart POST to presign → raw PUT → pass key to job creation (the same two-step flow every other client of this backend uses) |
| `activity/auth/LoginActivity.kt` | **The one unavoidable UX change** — username/password fields become a single pairing-code field; server-validated pairing can't be a username+password flow by construction |
| `activity/launch/SplashScreenActivity.kt` | Session check becomes "stored kiosk refresh token → silent refresh → success/failure", mirroring `admin-mobile`'s bootstrap |
| `activity/vastra/VastraTryOnResultActivity.kt` | **Unchanged** — icon-tint toggle + toast UX preserved exactly; only the ViewModel calls underneath change |

The `com.example.facewixlatest` package naming (still present in `APIConstant.kt`) gets renamed to the app's real package as a natural side-effect of touching every file in this layer — not separate scope.

**Legacy debt fixed here:** L2 (static secret deleted, no equivalent replacement — HTTPS + short-TTL pairing codes + per-device JWTs are the boundary), L4 (one token store + one rotation policy), L5 (identity server-derived), plus plaintext token storage → `EncryptedSharedPreferences`.

### 8.5 Cutover & rollout (operational, not code)

- **No data migration.** The legacy kiosk backend's schema (`users`/`garments`/`user_sessions` MySQL tables) shares nothing with the new model, and its catalog was global anyway — nothing worth porting. Existing store operators are onboarded fresh: admin creates a `widget_clients` row per store (or the merchant self-signs-up), sets `kioskEnabled`, merchant uploads their catalog, generates pairing codes.
- **Parallel-run, per-store rollout.** The legacy PHP API stays up while tablets are updated store-by-store: install new APK → enter pairing code → verify one try-on end-to-end → next store. Old APKs keep working against legacy until updated; nothing in this plan touches the legacy backend.
- **Decommission legacy only after the fleet is migrated** — it is the rollback path until then (rollback = reinstall old APK, which still points at the untouched legacy API).

### 8.6 Verification

- `apps/api/test/integration/kiosk-jobs.test.ts`: claim device → presign → PUT photo → seed catalog item → create job → assert `jobs.widgetClientId` **and** `jobs.kioskDeviceId` set and `widget_client_credits.balance` decremented atomically (the CLAUDE.md credit-deduct-plus-insert invariant, now exercised for kiosk) → confirm the *existing* `processWidgetJob` path picks it up with no dispatcher changes.
- Completed-job response includes a `shareUrl` that GETs the result bytes from MinIO with no auth header (the QR flow's contract).
- Likes/cart: a second merchant's device gets nothing for a job it doesn't own; the route schema has no field that could accept a spoofed `widgetClientId`.
- Android manual smoke: pair via a portal-generated code; kill-and-relaunch confirms silent refresh; like/cart UX and the gender→category→item navigation render identically to before (driven by the new `gender`/`category` fields).

---

## §9 Phase 4 — Process Note (not a migration task)

The PHP codebase is being replaced, not carried forward. The only carry-over is a convention, added as one line to `CLAUDE.md`'s "Git Commit & Push Policy" section:

> Never keep a superseded file alive with a suffix/date/"old"/"bkp" in its name. Delete it — git history is the undo button.

(Confirmed pattern in legacy: `Tryonbkp151025.php`, `Tryonnew25-03.php`, `Webtoolold.php`, `Webtoolold07-05.php`, `Webtoololdnew.php`, `webtoolapi2026-04-28.php`, plus superseded-duplicate pairs like `Adminweb_lower.php`/`Adminweb_shoes.php`.)

---

## §10 Phase 5 — E-commerce Platform Plugins (Shopify, Wix)

**Goal:** package the existing embeddable widget as installable marketplace apps so a merchant adds virtual try-on to their store without touching code.

### 10.1 Why this is small: the widget pipeline already fits

`POST /v1/widget/jobs` already accepts an external `garmentImageUrl` — which is exactly what a product image URL on a Shopify/Wix product page is. The entire job pipeline (auth via widget key, credit deduct, dispatcher `processWidgetJob`, SSE progress) is reused unchanged. A "plugin" is three things: platform install/OAuth plumbing, automatic `allowedOrigins` management, and a storefront snippet that injects `loader.js` with the right widget key + product image URL. *(Historical echo: legacy's DB had `wixuser` columns and the Android app's old package name was `facewixlatest` — a Wix integration existed once; this rebuilds the idea on the current stack.)*

### 10.2 DB

New table in `packages/db/src/schema/widget.ts`:

```ts
export const merchantIntegrations = pgTable('merchant_integrations', {
  id: uuid('id').primaryKey().defaultRandom(),
  widgetClientId: uuid('widget_client_id').notNull()
    .references(() => widgetClients.id, { onDelete: 'cascade' }),
  platform: text('platform').notNull(),        // 'shopify' | 'wix'
  shopDomain: text('shop_domain').notNull(),   // e.g. mystore.myshopify.com / Wix site id
  accessTokenEnc: text('access_token_enc'),    // platform OAuth token, AES-GCM encrypted at rest (key from new env INTEGRATION_TOKEN_KEY)
  installedAt: timestamp('installed_at', { withTimezone: true }),
  uninstalledAt: timestamp('uninstalled_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({ uniq: unique('merchant_integrations_platform_shop_unique').on(t.platform, t.shopDomain) }));
```

### 10.3 API

New module `apps/api/src/modules/integrations/`:

| Method + Path | Auth | Notes |
|---|---|---|
| `GET /v1/integrations` | `requireMerchant` | List the merchant's connected platforms + state — powers the portal's Integrations page |
| `GET /v1/integrations/shopify/install` | `requireMerchant` | Begins Shopify OAuth (merchant clicks *Connect* in the portal, so the callback can bind the shop to *their* `widgetClientId` — no guessing which merchant a shop belongs to) |
| `GET /v1/integrations/shopify/callback` | OAuth state param | Verifies HMAC + state, stores encrypted token, upserts `merchant_integrations`, **auto-appends the shop's domains (myshopify + custom) to `widget_clients.allowedOrigins`** |
| `POST /v1/integrations/shopify/webhooks` | Shopify HMAC | `app/uninstalled` → set `uninstalledAt`, remove the shop's domains from `allowedOrigins`; plus Shopify's three mandatory GDPR webhooks (ack + delete what we hold, which is nothing shopper-identifying beyond job photos already governed by existing retention) |
| `…/wix/install`, `…/wix/callback`, `…/wix/webhooks` | same shapes | Wix OAuth + app-removed webhook, same binding + origin management |

The `allowedOrigins` automation is the production-grade detail: today merchants hand-maintain that array in settings; the #1 support ticket for a marketplace install would be "widget blocked by origin check." Install/uninstall keeping origins in sync removes that failure mode.

### 10.4 Extension code

- `apps/shopify-app/` — Shopify CLI project: a **theme app extension** (app embed block) that injects `loader.js` with the merchant's widget key and the product image URL from Liquid (`{{ product.featured_image }}`); app settings page is just the connect status. Check `loader.js`'s existing data-attribute contract and add a `data-garment-url` per-page override if it doesn't already exist (the widget job API already takes the URL, so this is a loader-only change at most).
- `apps/wix-app/` — Wix app wrapping the same script injection for Wix product pages.
- **Merchant-web:** new **Integrations** page — Connect/Disconnect per platform, install state, shop domain shown (backed by `GET /v1/integrations`).

### 10.5 Out of scope (v1)

Marketplace listing/review polish (copy, screenshots, app-store approval cycles — real work, not engineering design), per-product enable/disable rules, and other platforms (WooCommerce/Magento — add when a merchant asks).

### 10.6 Verification

- Shopify dev store: install from the portal → product page shows the try-on entry point → shopper photo → job completes through the **existing** widget pipeline (no API/dispatcher diff beyond the integrations module) → uninstall → webhook flips `uninstalledAt` and the shop's origins disappear from `allowedOrigins`.
- Wix test site: same loop.
- Integration test: callback handler with a forged HMAC → 401; valid install for a shop already bound to a *different* merchant → 409 (the unique index).

---

## §11 Sequencing & Dependencies

```
Phase 0 (auth foundation) ──┬──> Phase 2 (merchant portal + catalog + 2E refresh)──┬──> Phase 3 (kiosk)
                            └──> (kiosk provisioning routes)                       └──> Phase 5 (Shopify/Wix plugins)
Phase 1 (admin subdomain) ──── independent; parallel with 0/2
Phase 4 (convention note) ──── any time
```

- Phase 0 ships with no visible surface — land early, sit unused.
- Phase 1 ⟂ Phase 2 (disjoint files) — parallelizable across two implementers.
- Phase 2 needs Phase 0's `kiosk_devices` table and the `refresh_tokens` three-way owner CHECK (2E's merchant refresh).
- Phase 3 needs Phase 0 (kiosk auth) and Phase 2 (a private catalog to pick garments from — via §7.3a studio import and/or direct upload).
- Phase 5 needs Phase 2 (the portal hosts the Connect flow and the merchant identity); independent of Phases 1 and 3 — can run in parallel with the kiosk migration.
- The CORS/MinIO multi-origin change starts in Phase 1 and is **revisited in Phase 2** to add `merchant.tryme.com` — both the API list *and* the MinIO bootstrap JSON, both times.

## §12 Deliberately Skipped (add only when the trigger fires)

- **Kiosk-vs-widget metrics label** in `@tryme/observability` — `jobs.kioskDeviceId` makes the split queryable in SQL; add a Prometheus label only when a dashboard actually needs it.
- **Per-merchant kiosk branding** (idle video, store logo on tablet) — the app ships bundled branding; revisit when a second brand asks.
- **Cross-merchant moderation inbox** — per-merchant moderation from the widget-client detail page suffices at current merchant counts.
- **Recycle-bin parity for merchant catalog deletes** — hard delete for v1; add if merchants actually lose items they want back.
- **Offline/queue mode for kiosk jobs** — the app already surfaces network errors; a store with no internet has bigger problems than try-on.
- **Lower/shoe compositing for kiosk jobs** — would require a new `workflowType`; out of scope until a merchant asks.
- **Embedding the studio wizard inside merchant-web** — creation stays in catalogues-web (§7.3a); revisit only if merchants refuse to use two apps in practice.
- **Single-identity merge (one credential row acting as user + merchant)** — the `widget_clients.userId` link delivers the required interop; a full merge is a cross-cutting auth rework with no current payoff.
- **WooCommerce / Magento / other platform plugins** — Shopify + Wix first (Phase 5); add others when a real merchant asks.

## §13 Critical Files Index

| File | Why it matters |
|---|---|
| `apps/api/src/plugins/widget-auth.ts` | Home for the new `requireKioskDevice`, alongside existing `requireMerchant`/`requireWidgetClient` |
| `apps/api/src/modules/auth/routes.ts` | `rotateTokenFamily` is generalized here for kiosk + merchant reuse — never duplicated |
| `packages/db/src/schema/widget.ts` | `widgetClients` kiosk columns + new `merchantCatalogItems` table |
| `packages/db/src/schema/kiosk.ts` | New file: `kioskDevices`, `kioskResultLikes`, `kioskResultCartItems` |
| `apps/dispatcher/src/job/processor.ts` (~line 121) | The `if (job.widgetClientId)` branch the whole job-pipeline reuse rests on — confirmed; rely on it, don't re-derive |
| `apps/api/src/modules/widget/routes.ts` + `ledger.ts` | Transaction/credit-deduct shape to factor into `createWidgetStyleJob` |
| `apps/virtual-tryon-mobile&kiosk/.../ApiUtils/APIConstant.kt` | Defines every legacy endpoint/secret Phase 3 replaces |
| `infra/docker-compose.prod.yml` | New `merchant` service + the easy-to-miss `minio-bootstrap` CORS JSON |
| `apps/catalogues-web/public/widget/loader.js` | The one merchant-flavored file that must **stay** in catalogues-web — live third-party embeds hotlink its URL; Phase 5's snippet injects this same script with a per-page garment URL |
| `apps/api/src/modules/integrations/` | New in Phase 5 — Shopify/Wix OAuth + webhooks + `allowedOrigins` automation |
