# Developer Try-On API — Design

**Date:** 2026-07-16
**Status:** Approved, ready for implementation plan

## Problem

Third-party developers want programmatic try-on: send a person image and a garment image, say which
garment category it is, get a generated image back. Today the only ways in are the studio wizard
(cookie/JWT, human-driven, admin-curated faces), the Shopify widget (browser key, origin-locked), and
the kiosk flow. None of them is a server-to-server API a developer can integrate against.

## What already exists

The generation pipeline is **already built**. This design adds an auth layer, one endpoint, and a
dashboard — it does not build a new pipeline.

- `apps/dispatcher/src/job/processor.ts:134` — a job whose `job_inputs` has no `faceId`/`backgroundId`/
  `poseId` but does have `params.personKey` routes to the simple-tryon path. That path uploads person +
  garment to ComfyUI and runs the workflow named by `params.workflowTemplateId`.
- `tryon_categories` (`packages/db/src/schema/tryon.ts`) — admin-managed categories (`slug`, `name`,
  `workflowTemplateId`, `isActive`).
- `apps/api/src/modules/jobs/create.ts::createSimpleTryonJob` — the existing user-facing simple-tryon.
  It requires the garment to be a **prior completed job of the caller** (`sourceJobId`) and resolves the
  workflow through a `garment type → tryon category` chain. A developer has neither, so v1 needs its own
  creation path — but the same `job_inputs` shape.
- `merchants` — a merchant is a `users` row plus a merchant profile. Auth today via `app.requireMerchant`
  (`apps/api/src/plugins/portal-auth.ts:13`). `isActive` defaults to `false`, so signup is already
  admin-gated.
- `apps/api/src/plugins/shopify-widget-auth.ts` — the pattern to follow for a key-auth plugin.
- `@fastify/rate-limit` — registered globally (lax, 200/min) with per-route overrides.

**Not existing, despite appearances:** `apps/merchant-web/` has zero git-tracked files — it is stale
build output. The real merchant UI is `apps/catalogues-web/src/app/(app)/catalogue-manager/`.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| Dev identity | Extend `merchants` | Reuses login, admin activation gate, credits, billing. No new entity. |
| API surface | person + garment + category → image | Matches the product ask. No face/pose/background selection. |
| Response model | 202 + poll | GPU work takes seconds to minutes. No held connections, no proxy timeouts. |
| Image input | Multipart, one call | Matches the "two images and a category" story. One HTTP call. |
| Key storage | SHA-256 hash, shown once | Server-side secret. A DB dump must not yield live keys. |
| Billing | Merchant's `user_credits` | Jobs stay `userId`-owned, so the dispatcher's refund path works unchanged. |
| Dashboard | New route in `catalogues-web` | Reuses merchant auth, middleware, design tokens. No new deploy target. |
| Docs | OpenAPI from Zod + quickstart | Spec cannot drift from the routes because it is derived from them. |
| Access gate | Active merchants self-serve | `merchants.isActive` is already the human trust boundary. |
| Rate limit | Per-key, Redis, fixed | Isolates one runaway loop from the GPU pool. |
| Webhooks | **Deferred to v2** | Keeps v1 additive — zero dispatcher changes. Polling alone is complete. |

## Architecture

```
Dev server ──sk_live_… ──> POST /v1/dev/tryon (multipart: person, garment, category)
                              │ 1. hash key → api_keys lookup → merchant
                              │ 2. per-key rate limit (Redis)
                              │ 3. category slug → tryon_categories.workflowTemplateId
                              │ 4. stream both files → R2
                              │ 5. TX: insert job + atomicDeduct(merchant.userId)
                              │ 6. XADD jobs:{stream}
                              └─> 202 {jobId, status:"QUEUED"}

Dispatcher (UNCHANGED) ──> COMPLETED ──> job_outputs.r2Key

Dev ──> GET /v1/dev/jobs/:id ──> {status, imageUrl?}   (presigned R2 GET, 15 min)
```

**v1 touches no dispatcher code.** Existing job routing already handles this job shape.

## Data model

New table `api_keys`:

```ts
export const apiKeys = pgTable('api_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  merchantId: uuid('merchant_id').notNull().references(() => merchants.id, { onDelete: 'cascade' }),
  label: text('label').notNull(),
  keyHash: text('key_hash').notNull().unique(),
  keyPrefix: text('key_prefix').notNull(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
```

- `keyHash` — `sha256(full key)`. Unique, so the auth lookup is an index probe.
- `keyPrefix` — e.g. `sk_live_a1b2`. Dashboard display only. Never sufficient to authenticate.
- Multiple live keys per merchant, so rotation is zero-downtime.

New column `jobs.apiKeyId` — nullable uuid FK to `api_keys.id`. Stamps the creating key so the dashboard
can show per-key usage without a second credit balance. Nullable because every non-API job has no key.

New `jobs.source` value `'api'`. `source` is a free-text column (`packages/db/src/schema/jobs.ts:34`), not
an enum — no migration needed for the value itself.

No other schema changes. No new credit tables.

## API surface

All under `/v1/dev/*`, all authed by `Authorization: Bearer sk_live_…`.

| Endpoint | Request | Response |
|---|---|---|
| `POST /v1/dev/tryon` | multipart: `person` file, `garment` file, `category` slug | `202 {jobId, status}` |
| `GET /v1/dev/jobs/:id` | — | `{jobId, status, imageUrl?, error?}` |
| `GET /v1/dev/categories` | — | `[{slug, name}]` — active categories |
| `GET /v1/dev/me` | — | `{merchantId, companyName, credits}` — key smoke test |

Lives in a **new module** `apps/api/src/modules/dev/`, not as a branch inside `jobs/create.ts`. That file
is long and security-load-bearing (see its S1/S6/H2 comments) and handles multi-pose/lower/shoe cases this
flow never needs. This mirrors the reasoning `merchant/create-job.ts` documents at its top.

### `POST /v1/dev/tryon` order of operations

1. Auth (plugin) → `merchantId`, `merchantUserId`, `apiKeyId`.
2. Per-key rate limit.
3. Resolve `category` slug → `tryon_categories` row. **Both the category and its workflow template must be
   `isActive`** or 400 — kill-switch parity with `createSimpleTryonJob`. Fails before any credits move.
4. Validate + stream both files to R2 under `keys.devUpload(merchantId, uuid)`.
5. Single transaction: insert `jobs` (`userId` = merchant's user, `source: 'api'`, `apiKeyId`) +
   `atomicDeduct(merchantUserId, cost, jobId)` + insert `job_inputs`:
   ```ts
   { jobId, upperGarmentKey: garmentKey, params: { personKey, workflowTemplateId } }
   ```
   Note no `faceId`/`backgroundId`/`poseId` — that absence is exactly what routes the job to the tryon
   path in the dispatcher.
6. `XADD jobs:{queueStream}`. On failure: refund + mark FAILED + 503, same as the existing path.

Cost from `getTryonCreditCost(app)` — the same price as the in-product simple-tryon.

## Auth plugin

`apps/api/src/plugins/dev-api-auth.ts`, decorating `app.requireApiKey`. Same shape as
`shopify-widget-auth.ts`:

1. Read `Authorization: Bearer …`. Missing/malformed → 401.
2. Format regex **before any DB hit**. `shopify-widget-auth.ts` guards its UUID this way for a concrete
   reason: a malformed value reaching Postgres surfaces as an unhandled invalid-input 500 instead of the
   intended 401.
3. `sha256(key)` → indexed lookup on `keyHash`. Constant-time by construction — a hash index probe, not a
   string compare, so no timing oracle.
4. Reject if `revokedAt` is set, the merchant is missing, or `merchant.isActive` is false → 401.
5. Bump `lastUsedAt` fire-and-forget, throttled to ~1/min per key via a Redis flag, so a busy key does not
   write on every request.
6. Decorate `req.apiKeyId`, `req.merchantId`, `req.merchantUserId`.

**Key generation:** `sk_live_` + 32 `crypto.randomBytes` rendered base62. Returned exactly once, in the
create response. Never stored in plaintext, never logged. Confirm `authorization` is in the
`@tryme/logger` redaction list and extend it if not.

**Rate limit:** `@fastify/rate-limit` with a `keyGenerator` on `req.apiKeyId`, Redis-backed, 60 req/min.
429 + `Retry-After`. Credits remain the cap on total spend; this caps burst.

## Upload safety

Multipart is the main new attack surface.

- Max 2 files, ~10MB each, enforced by `@fastify/multipart` limits.
- Allowed: `image/jpeg`, `image/png`, `image/webp`.
- MIME validated by **magic-byte sniff on the stream** — never the client-declared `Content-Type`.
- Files stream to R2 via `StorageProvider.putObject` under a new `keys.devUpload(merchantId, uuid)` builder.
- No `upload:owner:{key}` Redis binding needed: the API wrote these keys itself, so ownership is not
  forgeable. This is why the multipart choice removes a class of risk the presign flow has to defend
  against.

## Result delivery

`GET /v1/dev/jobs/:id` returns a **presigned R2 GET URL, 15-minute expiry**, via the existing `presignGet`
— not a public URL. API results stay private to the owning merchant.

Ownership check: the job's `apiKeyId` must resolve to the **same merchant** as the calling key (not the
same key — a merchant that rotates keys must still read its older jobs). Anything else → 404, not 403, so
job IDs are not enumerable.

Status maps directly from `jobs.status`: `QUEUED` / `RUNNING` → no URL; `COMPLETED` → `imageUrl`;
`FAILED` → `error` with the job's `errorCode`. Credits for failed jobs are refunded by the dispatcher's
existing path, unchanged.

## Dashboard — `apps/catalogues-web/src/app/(app)/developers/`

Beside `catalogue-manager`. Reuses merchant cookie auth, the middleware guard, and the `C` design tokens.

Backed by `/v1/merchant/api-keys` routes under the existing `app.requireMerchant` (cookie/JWT) — **never**
the API key itself. Key management must not be reachable with a key.

- **Keys** — list (prefix, label, created, last used), create (full key shown once, copy-to-clipboard,
  explicit "you will not see this again"), revoke.
- **Usage** — recent jobs where `apiKeyId` is not null: status, category, credits, timestamp, grouped per key.
- **Quickstart** — a working curl carrying the merchant's real key prefix, linking to full docs.

Webhook config is **not** in v1 (see Deferred).

## Docs

- `@fastify/swagger` derives OpenAPI 3 from the Zod route schemas already in use. Served at
  `/v1/dev/openapi.json` plus a Scalar reference UI. The spec cannot drift, because it *is* the route
  schemas.
- One hand-written quickstart at `/developers/docs`: auth, the three-call flow
  (`categories` → `tryon` → poll), curl + Node examples, error-code table, limits, credit cost.

## Testing

Existing harness — fresh Postgres DB + fresh MinIO bucket per file, no testcontainers. `pnpm docker:up`
must be running.

**Auth** — valid key passes; revoked → 401; malformed → 401 **not 500**; inactive merchant → 401;
merchant A's key cannot read merchant B's job (→ 404).

**Create** — happy path → 202, job row with correct `apiKeyId`/`source`, credits deducted, `job_inputs`
carries `personKey` + `workflowTemplateId` and **no** face/bg/pose; inactive category → 400 **with no
credit movement**; inactive workflow template → 400 with no credit movement; oversized file → 400;
non-image with a spoofed image `Content-Type` → 400; insufficient credits → 402.

**Poll** — QUEUED → no `imageUrl`; COMPLETED → presigned URL present; FAILED → `error` populated.

**Rate limit** — N+1 requests inside the window → 429.

## Deferred (v2+)

- **Webhooks.** The dispatcher owns terminal transitions, so it is the natural sender — but that would be
  the only dispatcher change in an otherwise additive design, and it needs retry/backoff to be worth
  shipping. Polling alone is a complete product. `merchants.webhookUrl` / `webhookSecret` already exist for
  when this lands.
- **Test-mode keys** (`sk_test_`, stub pipeline, zero credits). Consequence: v1 devs integrate against live
  keys that spend real credits. Acceptable for a gated merchant audience; revisit if onboarding friction
  appears.
- **Per-key configurable rate limits** — fixed ceiling until tiering is a real requirement.
- **Separate merchant credit balance** — would require a merchant-scoped deduct *and* a dispatcher refund
  path that credits the merchant instead of the user, touching the transactional refund invariant.
- **Key scopes/permissions**, **SDK packages**, **image-URL input** (SSRF surface).

## Invariants preserved

- Credit deduct + job insert stay one Postgres transaction; refund on terminal failure stays transactional
  and dispatcher-owned.
- Category → workflow template resolution happens in the API before enqueue. The dispatcher continues to
  trust `job_inputs`.
- Workflow templates are never inline-mutated.
- The `/v1/dev/*` surface never exposes admin-curated faces, poses, or backgrounds.
