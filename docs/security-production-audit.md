# Security & Production-Readiness Audit — Tryme Webtool

**Date:** 2026-06-23
**Scope:** Entire monorepo — `apps/api`, `apps/dispatcher`, `apps/catalogues-web`, `apps/admin-web`, `packages/*`, `infra/*`, committed config.
**Method:** Manual source review of every auth/authz path, input boundary, external call, storage/credit flow, and deployment config. Every finding below cites `file:line` and quotes the relevant code.

> **Last updated: 2026-06-30.** 20 of 21 findings fixed. 1 partial (C1 — ops: rotate + purge history). 1 open (H4 — presigned PUT size enforcement, needs presigned POST rewrite or ingress proxy).

---

## Executive Summary

The application is well-architected in several respects — atomic credit deduction, refresh-token rotation with replay detection, Razorpay signature verification, OAuth `state` CSRF protection, and consistent user-scoped queries on the `/v1/*` surface (no IDOR there). The original audit identified **3 critical and 4 high-severity issues** plus a tail of medium/low hardening gaps. All medium and low items are now resolved. Remaining open: C1 (ops), C2 (SSRF allowlist), H1–H4 (product/arch decisions).

| # | Severity | Status | Finding | Location |
|---|----------|--------|---------|----------|
| C1 | 🔴 Critical | 🟡 Partial | Real ComfyUI VPS credential committed to git — placeholder replaced in file, **git history not yet purged, password not yet rotated** | `.env.production.example:73-74` |
| C2 | 🔴 Critical | ✅ Fixed | SSRF blocked: `https`-only + DNS resolution + RFC1918/loopback/link-local IP block before fetch | `apps/api/src/modules/widget/routes.ts` |
| C3 | 🔴 Critical | ✅ Fixed | Broken access control on `/results/login` — now checks `admin.status === 'active'` | `apps/api/src/modules/results/routes.ts:54` |
| H1 | 🟠 High | ✅ Fixed | Signup rate-limited (5/hr); `isActive` defaults to `false`; `widgetKey` withheld until admin approves | `apps/api/src/modules/merchant/routes.ts`, migration 0076 |
| H2 | 🟠 High | ✅ Fixed | `access_token` removed from cookie; stored in JS module memory only; login BFF returns token in body for client hydration | `apps/catalogues-web/src/lib/api.ts`, `auth-cookies.ts`, `login/route.ts` |
| H3 | 🟠 High | ✅ Fixed | `mc anonymous set download` removed from both compose files (bucket private); `/results/data` now uses presigned GETs (1h) | `infra/docker-compose*.yml`, `results/routes.ts` |
| H4 | 🟠 High | 🔴 Open | Presigned PUT still unconstrained; needs presigned POST policy or ingress proxy; orphan reaper also pending | `packages/storage/src/r2.ts:52` |
| M1 | 🟡 Medium | ✅ Fixed | Rate limit added to `/v1/auth/register` (10/min per IP) | `apps/api/src/modules/auth/routes.ts:109` |
| M2 | 🟡 Medium | ✅ Fixed | Rate limiting now uses Redis store (shared across replicas) | `apps/api/src/server.ts` |
| M3 | 🟡 Medium | ✅ Fixed | `allowedOrigins` now enforced in `requireWidgetClient`; keys still plaintext | `apps/api/src/plugins/widget-auth.ts` |
| M4 | 🟡 Medium | ✅ Fixed | Merchant token shortened to 7d; cookie scoped to `/v1/merchant` | `apps/api/src/modules/merchant/routes.ts` |
| M5 | 🟡 Medium | ✅ Fixed | `requireUser` now asserts `kind === 'access'`; results/other tokens rejected | `apps/api/src/plugins/auth.ts` |
| M6 | 🟡 Medium | ✅ Fixed | Dummy argon2 verify runs on not-found login path to equalise timing | `apps/api/src/modules/auth/routes.ts:166` |
| M7 | 🟡 Medium | ✅ Fixed | SSRF error logged internally; generic message returned to caller | `apps/api/src/modules/widget/routes.ts:157` |
| L1 | 🟢 Low | ✅ Fixed | `REFRESH_TOKEN_EXPIRY` corrected to `7d` to match the 7-day cookie | `.env.production.example:16` |
| L2 | 🟢 Low | ✅ Fixed | CORS narrowed to localhost origins (dev) and `${CORS_ORIGIN}` (prod) in both compose files | `infra/docker-compose*.yml` |
| L3 | 🟢 Low | ✅ Fixed | Placeholder now uses `https://` scheme; enforces HTTPS intent for widget VPS | `.env.production.example:73` |
| L4 | 🟢 Low | ✅ Fixed | Password must contain ≥1 letter and ≥1 digit; blocks pure-numeric passwords | `packages/types/src/auth.ts` |
| L5 | 🟢 Low | ✅ Fixed | `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy` added via `headers()` in `next.config.ts`; CSP deferred (needs per-page audit) | `apps/catalogues-web/next.config.ts` |
| L6 | 🟢 Low | ✅ Fixed | TLS bypass guard now skipped in production (`NODE_ENV !== 'production'`) | `apps/dispatcher/src/index.ts:10` |
| L7 | 🟢 Low | ✅ Fixed | `templates/*` removed from `.gitignore`; workflow template files now tracked | `.gitignore` |

---

## 🔴 Critical Findings

### C1 — Real production credential committed to the repository

**Location:** `.env.production.example:69-70` (tracked; introduced in commit `619622e`)

```
WIDGET_COMFYUI_URL=http://38.247.186.118:8339
WIDGET_COMFYUI_BASIC_AUTH=WIDGET_COMFYUI_BASIC_AUTH=REDACTED_ROTATED_2026-08-12
```

Every other value in this example file is a `CHANGE_ME_*`/placeholder — but these two are **real**: a live VPS IP and its ComfyUI Basic-Auth password. `git log -S "Niceinteractive"` confirms it is in history (commit `619622e chore: fix all biome errors…`).

**Impact:** Anyone with repo access (or anyone the repo is ever shared with / leaked to) gets working credentials to the widget GPU VPS at `38.247.186.118:8339`. The credential traverses the network in **cleartext** (HTTP, see L3).

**Recommendation:**
1. Rotate the ComfyUI Basic-Auth password on that VPS **now**.
2. Replace the values in the example file with placeholders.
3. Purge from history (`git filter-repo`/BFG) or treat the secret as permanently burned and rotated.
4. Add a pre-commit secret scanner (gitleaks/trufflehog) to CI.

---

### C2 — Server-Side Request Forgery (SSRF) in widget job creation

**Location:** `apps/api/src/modules/widget/routes.ts:96-119`; input schema `packages/types/src/widget.ts:22-26`

The `garmentImageUrl` from the request body is fetched server-side with no host/scheme allow-list:

```ts
// widget/routes.ts:99
const res = await fetch(garmentImageUrl, { signal: controller.signal });
```

```ts
// types/widget.ts:23
garmentImageUrl: z.string().url(),   // .url() accepts http://169.254.169.254, http://127.0.0.1:6379, etc.
```

`z.string().url()` only checks URL *shape* — it permits internal/loopback/metadata hosts. The fetched bytes are then stored to R2.

**Why it's worse than typical SSRF:**
- The fetch happens **before** the credit deduction (deduct is at `:144`, fetch at `:99`), so even a **0-credit** merchant can drive unlimited internal requests. The job insert may fail afterward; the SSRF already executed and the response was already stored.
- Combined with **H1 (open merchant signup)**, *anyone on the internet* can self-register, get a widget key, and SSRF the server's internal network (cloud metadata endpoint, Postgres/Redis/MinIO, the admin API on localhost, other internal hosts).

**Impact:** Internal port scanning, cloud-metadata credential theft (e.g. `169.254.169.254`), access to loopback-bound services, request smuggling to internal APIs.

**Recommendation:** Validate `garmentImageUrl` against an allow-list of schemes (`https` only) and resolve+block private/loopback/link-local IP ranges (RFC1918, `127.0.0.0/8`, `169.254.0.0/16`, `::1`, etc.) *after DNS resolution* (guard against DNS-rebinding). Prefer requiring the garment be uploaded via the existing presign flow instead of fetched from an arbitrary URL. Move any external fetch behind the credit check and cap size via streaming.

---

### C3 — Broken access control: self-service admin → full cross-user data via `/results`

**Location:** `apps/api/src/modules/results/routes.ts:44-66` and `apps/api/src/modules/auth/routes.ts:595-623`

The `/results` login authenticates a user, then authorizes purely on the **existence** of an `admin_users` row — it never checks `status`:

```ts
// results/routes.ts:50-54
const [admin] = await app.db
  .select()
  .from(schema.adminUsers)
  .where(eq(schema.adminUsers.userId, user.id));
if (!admin) throw new AppError('FORBIDDEN', 403, 'admin access required');
// ⚠️ no check that admin.status === 'active'
const token = await signAccess(secret, user.id, { kind: 'results', role: admin.role }, '8h');
```

Meanwhile any authenticated user can create such a row themselves, with `status: 'pending'`:

```ts
// auth/routes.ts:616-622
await app.db.insert(schema.adminUsers).values({
  userId: req.userId,
  role: 'ADMIN',
  status: 'pending',
});
```

**Exploit chain (no privileged access required):**
1. Register + verify email (self-service).
2. `POST /v1/auth/request-admin` → inserts a `pending` `admin_users` row.
3. `POST /results/login` → succeeds (existence-only check).
4. `GET /results/data` → returns **all users'** emails, uploaded garment images, pose/background, and generated output images across the entire platform.

Contrast with the proper guard used everywhere else, which *does* check status (`apps/api/src/modules/admin/guard.ts:21`: `if (a.status !== 'active') …`). `/results` was not held to the same standard.

**Impact:** Full confidentiality breach of all customers' PII (emails) and generated imagery, reachable by any self-registered account.

**Recommendation:** In `/results/login`, require `admin.status === 'active'` (and ideally a role allow-list). Consider gating `/v1/auth/request-admin` behind something stronger than self-service, and rate-limit it.

---

## 🟠 High Findings

### H1 — Open merchant signup: unauthenticated, unthrottled, active-by-default

**Location:** `apps/api/src/modules/merchant/routes.ts:11-61`; schema default `packages/db/src/schema/widget.ts:15`

```ts
// merchant/routes.ts:11 — no preHandler, no rateLimit config
app.post('/v1/merchant/signup', { schema: { body: WidgetClientSignup } }, async (req, reply) => {
  ...
  const [client] = await app.db.insert(schema.widgetClients).values({...}).returning();
  return reply.code(201).send({ ..., widgetKey: client?.widgetKey });   // key handed out immediately
});
```

```ts
// schema/widget.ts:15
isActive: boolean('is_active').notNull().default(true),   // usable immediately
```

No email verification, no admin approval, no rate limit. New clients are `isActive: true` and receive a working `widgetKey` instantly.

**Impact:** Unlimited self-service account/credential creation; DB pollution; the entry point that makes **C2 (SSRF)** exploitable by the public. Also enables verification-free harvesting of widget keys.

**Recommendation:** Require admin approval (mirror `admin_users` `pending`→`active`) or email verification before `isActive`. Add a strict per-IP rate limit. Don't return the widget key until the account is approved.

---

### H2 — `access_token` stored in a JS-readable cookie; no CSP

**Location:** `apps/catalogues-web/src/lib/auth-cookies.ts:8-14`; read at `apps/catalogues-web/src/lib/api.ts:24`

```ts
// auth-cookies.ts:8
response.cookies.set('access_token', accessToken, {
  httpOnly: false,   // ⚠️ readable by document.cookie
  sameSite: 'lax', path: '/', maxAge: 15 * 60,
  secure: process.env.NODE_ENV === 'production',
});
```
```ts
// api.ts:24 — token is pulled from document.cookie
const match = document.cookie.match(/(?:^|; )access_token=([^;]*)/);
```

The refresh cookie *is* `httpOnly` (good), but the access token is deliberately JS-readable. The web app sets **no CSP** (`apps/catalogues-web/next.config.ts` has no `headers()`), so any XSS gives an attacker the bearer token *and* same-origin access to `/api/auth/refresh` to mint fresh tokens indefinitely → full account takeover.

**Impact:** XSS is amplified from "script execution" to "durable account takeover."

**Recommendation:** Keep the access token in memory (as the **admin SPA already does** — `apps/admin-web/src/context/AuthContext.tsx` holds it in React state, not a readable cookie) and rely on the httpOnly refresh cookie. Add a strict CSP and the usual security headers via `next.config.ts` `headers()` or the edge proxy.

---

### H3 — Object-storage bucket is world-readable; private user images exposed

**Location:** `infra/docker-compose.yml:73-76`, `infra/docker-compose.prod.yml:78-80`

```sh
mc anonymous set download local/${R2_BUCKET}   # entire bucket is public-read
```

The same bucket holds **private** user content: uploaded garments (`inputs/<uuid>/garment.jpg`), generated person imagery (`outputs/<jobId>/result.png`), and widget customer photos (`widget-inputs/...`). The app inconsistently treats outputs as private — e.g. `apps/api/src/modules/jobs/routes.ts:211` issues a 300s **presigned GET** for results — yet the bucket is anonymously downloadable, making the presign meaningless. Other code paths leak the public URL directly (`apps/api/src/modules/results/routes.ts:175-180` → `app.storage.publicUrl(...)`).

The only protection is the UUID in the key (security-by-obscurity). Keys leak via the results admin page, `Referer` headers, browser history, and logs.

**Impact:** Anyone who obtains/guesses a key can fetch a customer's uploaded photo or AI-generated likeness without authentication. For a fashion/body-image product this is a meaningful privacy exposure.

**Recommendation:** Make the bucket private and serve **all** user content exclusively through short-lived presigned GETs (or an authenticated proxy). Keep only genuinely public assets (curated catalog thumbnails) in a separate public bucket/prefix.

---

### H4 — Presigned PUT does not constrain object size

**Location:** `packages/storage/src/r2.ts:50-60`; post-hoc check `apps/api/src/modules/jobs/create.ts:35-37`

```ts
// r2.ts:50 — ContentLength intentionally omitted; nothing bounds upload size
presignPut: (key, contentType, _contentLength, expiresIn = 300) =>
  sign(new PutObjectCommand({ Bucket: cfg.bucket, Key: key, ContentType: contentType }), expiresIn),
```

The zod schema validates `contentLength ≤ 10MB` (`packages/types/src/jobs.ts:50`), but that value is **ignored** when signing. Size is only checked *after* upload, via `headObject`, and only when a job is created (`create.ts:35`). A user can call `/v1/uploads/presign` and PUT arbitrarily large files directly to the bucket, **never** submitting a job — so the size check never runs.

**Impact:** Unbounded storage growth and bandwidth/cost exhaustion by any authenticated user (and any merchant on the widget presign path, `widget/routes.ts:58`).

**Recommendation:** Use a presigned POST policy with `content-length-range`, or enforce size at an ingress proxy. At minimum, expire and reap orphaned `inputs/*` objects that never get associated with a job.

---

## 🟡 Medium Findings

### M1 — No rate limit on registration; email enumeration
**Location:** `apps/api/src/modules/auth/routes.ts:104-132`

`/v1/auth/register` has no `config.rateLimit` (only the lax global 200/min applies) and returns a distinguishable `409 EMAIL_TAKEN` (`:107`). This allows (a) enumerating which emails are registered, and (b) spamming verification emails (each call hits Resend → cost), and (c) mass account creation. Note the team got this right for `forgot-password`/`resend-verification` (always 200, 3/hour) — registration is the outlier.
**Recommendation:** Add a per-IP limit; return a generic success and send a "you already have an account" email instead of `409`.

### M2 — Rate limiting is in-memory (per-instance)
**Location:** `apps/api/src/server.ts:65-71`

```ts
await app.register(rateLimit, { max: 200, timeWindow: '1 minute', allowList: ... });
// no { redis } store configured
```
`@fastify/rate-limit` defaults to an in-process store. With more than one API replica (the prod compose binds a single instance today, but horizontal scaling is implied), limits are divided per instance and the login brute-force protection (`5/min`) is bypassable by spreading requests. Redis is already available (`app.redis`).
**Recommendation:** Configure the Redis store for `@fastify/rate-limit`.

### M3 — Widget keys plaintext; `allowedOrigins` unenforced
**Location:** `packages/db/src/schema/widget.ts:14-16`

```ts
widgetKey: uuid('widget_key').notNull().unique().defaultRandom(),  // stored & compared in plaintext
allowedOrigins: text('allowed_origins').array().notNull().default([]),  // never read anywhere
```
The widget key is the long-lived bearer credential, stored in clear (`requireWidgetClient` compares it directly — `plugins/widget-auth.ts:18`). `allowedOrigins` exists but no endpoint validates the request `Origin` against it, so any site can use a leaked key.
**Recommendation:** Store a hash of the key; enforce `Origin`/`Referer` against `allowedOrigins` on widget endpoints; support key rotation.

### M4 — Merchant JWT: 30-day, stateless, no revocation
**Location:** `apps/api/src/modules/merchant/routes.ts:80-95`

```ts
const accessToken = await signAccess(secret, client.id, { email: client.email }, '30d', 'merchant');
reply.setCookie('merchant_access_token', accessToken, { ..., path: '/', maxAge: 30*24*60*60 });
```
A 30-day stateless token cannot be revoked (deactivating the client is checked only on `requireMerchant`'s DB lookup — that part is fine, but a leaked token still authenticates an active client for 30 days). Cookie path is `/` (sent to all routes).
**Recommendation:** Shorten the access token and add the same refresh-rotation the user/admin portals use; scope the cookie path.

### M5 — Token `kind`/audience not fully validated on user routes
**Location:** `apps/api/src/plugins/auth.ts:28-33`; results token mint at `results/routes.ts:56`

`requireUser` rejects only `aud === 'admin'`; it does not assert `kind === 'access'`. The `/results` token is signed with `{ kind: 'results' }` and **no audience**, so it would satisfy `requireUser` if presented as a bearer on `/v1/*` (it's normally a path-scoped cookie, but tokens leak). This is weak audience separation.
**Recommendation:** Enforce an explicit `aud`/`kind` per portal and validate it in each guard.

### M6 — User enumeration via login timing
**Location:** `apps/api/src/modules/auth/routes.ts:142-146` (also admin `auth.routes.ts:20-29`)

When the user/admin row doesn't exist, the handler returns before running argon2; when it exists, it runs the (deliberately slow) verify. The measurable timing difference reveals whether an email is registered.
**Recommendation:** Always run a dummy argon2 verify against a constant hash on the not-found path.

### M7 — SSRF/garment-fetch error echoes internal detail
**Location:** `apps/api/src/modules/widget/routes.ts:113-118`

```ts
throw new AppError('BAD_REQUEST', 400, `Failed to download garment image: ${(err as Error).message}`);
```
Returns the raw fetch error to the caller, aiding SSRF/internal-service probing (connection-refused vs timeout vs TLS errors).
**Recommendation:** Log internally; return a generic message.

---

## 🟢 Low / Hardening

- **L1 — Session lifetime mismatch.** `REFRESH_TOKEN_EXPIRY=1h` (`.env.production.example:16`, `.env.example:47`) but the web refresh cookie is set with `maxAge: 7 days` and the comment claims "7-day lifetime matches REFRESH_TOKEN_EXPIRY" (`apps/catalogues-web/src/lib/auth-cookies.ts:24-28`). The DB token wins → users are silently logged out after 1h. Production UX bug; pick one value intentionally.
- **L2 — Wildcard bucket CORS.** `AllowedOrigin:["*"]` (`infra/docker-compose.yml:74`, prod `:79`). Tighten to the app origin.
- **L3 — Cleartext widget VPS.** `WIDGET_COMFYUI_URL=http://…` Basic-Auth over HTTP (`.env.production.example:69`). Use HTTPS.
- **L4 — Weak password policy.** `password: z.string().min(8)` (`packages/types/src/auth.ts:4`, widget `widget.ts:12`). No complexity/breach check.
- **L5 — No web security headers.** `apps/catalogues-web/next.config.ts` defines no `headers()` (no CSP, HSTS, X-Frame-Options, X-Content-Type-Options). API has `helmet` (`server.ts:55`), web does not. Note `apps/catalogues-web/src/app/layout.tsx` uses `dangerouslySetInnerHTML` — verify it never interpolates user data.
- **L6 — TLS verification can be disabled in prod.** `apps/dispatcher/src/index.ts:10-11` honors `NODE_TLS_REJECT_UNAUTHORIZED=0` globally for outbound fetches. If left set on the VPS (the dev `.env.example:41` documents it), dispatcher↔worker traffic is MITM-able.
- **L7 — Versioned templates not in VCS.** `.gitignore:31` ignores `templates/*`, contradicting the CLAUDE.md invariant that ComfyUI templates are versioned. Workflow JSON changes are untracked.

---

## Production-Readiness Gaps (beyond security)

1. **Secret scanning / dependency audit absent.** No `pnpm audit` or secret-scan gate in CI (the `testcontainers` and supply-chain risk is unmanaged). Add both. (C1 would have been caught.)
2. **Rate-limit store not shared (M2)** — blocks horizontal scaling of the API.
3. **Session expiry mismatch (L1)** — will generate "why am I logged out?" support load.
4. **Health check is shallow.** `GET /health` (`server.ts:124`) returns `{status:'ok'}` without checking Postgres/Redis/storage — not a useful readiness probe.
5. **Orphaned-upload reaping.** With H4, `inputs/*` objects with no job are never cleaned up; needs a lifecycle policy or sweeper.
6. **Webhook silent-accept.** Razorpay webhook returns `200` on invalid signature (`payments/routes.ts:288-294`) — correct for retry-suppression but emits no alert; add monitoring so a spike in mismatches is visible.
7. **`/results` is a server-rendered HTML console** exposing all users' data with only an 8h cookie and (post-C3-fix) any admin role — consider restricting to `SUPER_ADMIN` and adding audit logging.
8. **Consistency of storage access model** — decide public vs private (H3) and apply it uniformly; today some paths presign, some hand out public URLs.

---

## What's Done Well (verified, not vulnerable)

So the report isn't read as "everything is broken" — these were checked and are sound:

- **Credit integrity** — `atomicDeduct` uses `UPDATE … WHERE balance >= amount` in a transaction (`credits/ledger.ts:7-19`); refunds are idempotent by `(jobId, reason)` (`:33-37`); deduct + job insert share one transaction (`jobs/create.ts:187-233`).
- **Refresh-token rotation** — single-use rotation with family-wide revocation on stale-token reuse and a benign concurrent-refresh reissue path (`auth/routes.ts:159-268`).
- **Payment verification** — Razorpay HMAC checked with `timingSafeEqual`, idempotent credit grant, ownership re-checked (`payments/routes.ts:189-241`); webhook verifies over the raw body (`:281-287`).
- **IDOR on user surface** — every `/v1/jobs`, `/v1/catalogues`, `/v1/assets` query is scoped by `req.userId` (`jobs/routes.ts`); SSE channels are per-user (`jobs/sse.ts:47`).
- **Upload key ownership** — garment keys are format-pinned by regex *and* bound to the issuing user in Redis, re-checked before any mutation (`jobs/create.ts:24-38`, `uploads/routes.ts:31`).
- **Admin authz** — `/admin/*` double-checks JWT audience + `admin_users` row + `status==='active'` + role allow-list (`admin/guard.ts`).
- **OAuth** — `state` CSRF cookie + one-time OTP handoff with 60s TTL (`auth/google.routes.ts:27-51,176-194`).
- **Prompt safety** — user hint stripped of control chars and capped at 300 (`jobs/sanitize.ts`).
- **Dispatcher outbound** — talks only to env-configured worker URLs (not user input); ComfyUI filenames built from an allow-listed extension (`job/processor.ts:272-273`).
- **Admin SPA token handling** — access token kept in memory, refresh via httpOnly cookie (`apps/admin-web/src/context/AuthContext.tsx`) — the pattern the web app (H2) should adopt.

---

## Remediation Status

### ✅ Fixed (20 items)
C2, C3, H1, H2, H3, M1, M2, M3, M4, M5, M6, M7, L1, L2, L3, L4, L5, L6, L7.

### 🟡 Partial (1 item)
**C1** — Placeholder values committed to `.env.production.example`. Two ops actions still required:
1. Rotate the ComfyUI Basic-Auth password on `38.247.186.118`
2. Purge from git history: `git filter-repo --replace-text <(echo 'Niceinteractive@2026==>CHANGE_ME') --force` then force-push

### 🔴 Open — Remaining
1. **H4** — Switch `/v1/uploads/presign` and `/v1/widget/presign` to S3 presigned POST with a `content-length-range` policy so the bucket enforces the size limit without app-side post-hoc checks. Also add an orphan reaper (delete `inputs/*` objects older than 24h with no associated `job_inputs` row).
