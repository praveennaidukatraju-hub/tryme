# Android tryon-library-app SSO Bypass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the native Android app's WebView open `https://app.tryme.com/tryon-library-app` already signed in, by exchanging the native app's existing device session for a `catalog-app` cookie session, instead of showing the PWA's own separate login form.

**Architecture:** A new backend endpoint, `POST /v1/auth/catalog-app-device-exchange`, verifies a bearer device access token (`aud: 'device'`, minted by the existing `/v1/auth/device-login` or `/device-login/google`) via the already-existing `app.requireDeviceUser` guard, checks the user has an active merchant profile, and mints a `catalog-app` cookie session using the existing `createSessionTokens` helper — the same session type the password-based `portal: 'catalog-app'` login already issues. On the web side, `apps/catalogues-web/src/middleware.ts` calls this endpoint server-to-server when the Android WebView sends a `X-Tryme-Device-Token` header on its first navigation to `/tryon-library-app`, and attaches the resulting cookie to its response — before `AuthGate.tsx`'s existing client-side session check ever runs, so that component needs no changes at all.

**Tech Stack:** Fastify 5, Drizzle ORM / PostgreSQL, `jose` (via existing `signAccess`/`verifyAccess`), Vitest; Next.js 15 Edge middleware.

Design doc: `docs/superpowers/specs/2026-08-18-android-tryon-library-app-sso-design.md`.

## Global Constraints

- ESM only. Every relative import inside `apps/api/src` ends in `.js`.
- No `console.log`. Use `app.log` / `@tryme/logger`.
- Integration tests need `pnpm docker:up` running first. No testcontainers.
- Never run migrations against production (not applicable here — no schema change in this plan).
- The Android native app itself lives in a separate repository and is **out of scope** — this plan only touches `apps/api` and `apps/catalogues-web`.
- The device token must never be put in a URL, only ever sent as a header — do not add a query-param fallback.

---

### Task 1: Backend — `POST /v1/auth/catalog-app-device-exchange`

**Files:**
- Modify: `apps/api/src/modules/auth/routes.ts:781` (insert immediately after the `POST /v1/auth/catalog-app-refresh` route's closing `});`, before the `// ── Mobile auth ...` comment)
- Test: `apps/api/test/integration/catalog-app-device-exchange.test.ts`

**Interfaces:**
- Consumes: `app.requireDeviceUser` (`apps/api/src/plugins/auth.ts:85`, unchanged), `createSessionTokens` (`apps/api/src/modules/auth/tokens.ts`, unchanged), `AppError`, `schema`, `eq` (all already imported in `routes.ts`).
- Produces: `POST /v1/auth/catalog-app-device-exchange` → `200 { accessToken }` + `Set-Cookie: catalog_app_refresh=...` on success; `403 NOT_A_MERCHANT` for a device user with no active merchant profile; `401` for a missing/invalid/expired/non-device-audience bearer token (all via the existing `requireDeviceUser` guard, unmodified).

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/integration/catalog-app-device-exchange.test.ts`:

```ts
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signAccess } from '../../src/modules/auth/service.js';
import { buildTestApp, type TestApp } from '../helpers/api.js';
import { type Containers, startContainers } from '../helpers/containers.js';
import { createTestMerchant } from '../helpers/merchant.js';

describe('POST /v1/auth/catalog-app-device-exchange', () => {
  let c: Containers;
  let app: TestApp;

  beforeAll(async () => {
    c = await startContainers();
    app = await buildTestApp(c);
  }, 60000);

  afterAll(async () => {
    await app?.close();
    await c?.stop();
  });

  async function deviceTokenFor(userId: string, exp = app.env.JWT_EXPIRY) {
    return signAccess(
      new TextEncoder().encode(app.env.JWT_SECRET),
      userId,
      { kind: 'access' },
      exp,
      'device',
    );
  }

  async function createPlainUser() {
    const [user] = await app.db
      .insert(schema.users)
      .values({
        email: `device-exchange-${Date.now()}@example.com`,
        displayName: 'Device User',
        emailVerified: true,
      })
      .returning();
    if (!user) throw new Error('failed to create user');
    return user.id;
  }

  function exchange(token: string) {
    return app.inject({
      method: 'POST',
      url: '/v1/auth/catalog-app-device-exchange',
      headers: { authorization: `Bearer ${token}` },
    });
  }

  it('mints a catalog-app session for an active merchant', async () => {
    const merchant = await createTestMerchant(app, { isActive: true });
    const token = await deviceTokenFor(merchant.userId);

    const res = await exchange(token);

    expect(res.statusCode).toBe(200);
    const cookies = res.cookies.map((ck) => ck.name);
    expect(cookies).toContain('catalog_app_refresh');
    expect(cookies).not.toContain('refresh');

    const { accessToken } = res.json() as { accessToken: string };
    const merchantRes = await app.inject({
      method: 'GET',
      url: '/v1/merchant/catalog/subcategories',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(merchantRes.statusCode).toBe(200);
  });

  it('rejects a device user with no merchant profile', async () => {
    const userId = await createPlainUser();
    const token = await deviceTokenFor(userId);

    const res = await exchange(token);

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('NOT_A_MERCHANT');
  });

  it('rejects a device user with an inactive merchant profile', async () => {
    const merchant = await createTestMerchant(app, { isActive: false });
    const token = await deviceTokenFor(merchant.userId);

    const res = await exchange(token);

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('NOT_A_MERCHANT');
  });

  it('rejects a non-device-audience token', async () => {
    const merchant = await createTestMerchant(app, { isActive: true });
    const webToken = await signAccess(
      new TextEncoder().encode(app.env.JWT_SECRET),
      merchant.userId,
      { kind: 'access' },
      app.env.JWT_EXPIRY,
    );

    const res = await exchange(webToken);

    expect(res.statusCode).toBe(401);
  });

  it('rejects an expired device token', async () => {
    const merchant = await createTestMerchant(app, { isActive: true });
    const token = await deviceTokenFor(merchant.userId, '-1m');

    const res = await exchange(token);

    expect(res.statusCode).toBe(401);
  });

  it('rejects a request with no bearer token', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/catalog-app-device-exchange',
    });
    expect(res.statusCode).toBe(401);
  });
});
```

Before running, confirm `schema.merchants.isActive` and `createTestMerchant`'s `opts.isActive` still match this shape (`apps/api/test/helpers/merchant.ts`) — the schema is the authority, not this snippet.

- [ ] **Step 2: Run test to verify it fails**

Run (from `apps/api`): `npx vitest run --config vitest.integration.config.ts catalog-app-device-exchange`
Expected: FAIL — all requests 404 (route doesn't exist yet).

- [ ] **Step 3: Write the implementation**

In `apps/api/src/modules/auth/routes.ts`, find the end of the `POST /v1/auth/catalog-app-refresh` route (the block ending at line 781) — it looks like this today:

```ts
    return {
      accessToken: await signAccess(
        secret,
        result.ownerId,
        { kind: 'access' },
        app.env.JWT_EXPIRY,
        'catalog-app',
      ),
    };
  });

  // ── Mobile auth (body-based tokens, no cookies) ──────────────────────────
```

Insert the new route between that route's closing `});` and the `// ── Mobile auth ...` comment:

```ts
    return {
      accessToken: await signAccess(
        secret,
        result.ownerId,
        { kind: 'access' },
        app.env.JWT_EXPIRY,
        'catalog-app',
      ),
    };
  });

  // Lets the Android app's WebView (already signed into the native device
  // session) pick up a catalog-app cookie session without showing the Try On
  // Library's own login form. requireDeviceUser proves this is a live
  // 'device'-audience session; the merchant-active gate matches the
  // password-based portal: 'catalog-app' branch of /v1/auth/login above.
  app.post(
    '/v1/auth/catalog-app-device-exchange',
    {
      preHandler: app.requireDeviceUser,
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const [merchantRow] = await app.db
        .select({ isActive: schema.merchants.isActive })
        .from(schema.merchants)
        .where(eq(schema.merchants.userId, req.userId));
      if (!merchantRow?.isActive) {
        throw new AppError('NOT_A_MERCHANT', 403, 'This account has no Try On Library access.');
      }
      return createSessionTokens(app, req.userId, reply, 200, 'catalog-app');
    },
  );

  // ── Mobile auth (body-based tokens, no cookies) ──────────────────────────
```

No new imports are needed — `AppError`, `schema`, `eq`, and `createSessionTokens` are already imported at the top of this file, and `app.requireDeviceUser` is a Fastify decorator registered globally by `apps/api/src/plugins/auth.ts`.

- [ ] **Step 4: Run test to verify it passes**

Run (from `apps/api`): `npx vitest run --config vitest.integration.config.ts catalog-app-device-exchange`
Expected: PASS, 6 tests.

- [ ] **Step 5: Run the full API test suite**

Run: `pnpm --filter @tryme/api test` and `pnpm --filter @tryme/api test:integration`
Expected: both green — this is a purely additive route, nothing else should change behavior.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/auth/routes.ts apps/api/test/integration/catalog-app-device-exchange.test.ts
git commit -m "feat(auth): exchange a device session for a catalog-app cookie session"
```

---

### Task 2: Web — middleware exchanges the Android device-token header

**Files:**
- Modify: `apps/catalogues-web/src/middleware.ts`

**Interfaces:**
- Consumes: `POST /v1/auth/catalog-app-device-exchange` (Task 1), `setCatalogAppCookies` (`apps/catalogues-web/src/lib/catalog-app-cookies.ts`, unchanged, already Edge-runtime-safe).
- Produces: no new exported interface — this is entirely internal middleware behavior. `AuthGate.tsx` and every other route are unaffected; only requests to `/tryon-library-app` (or its subpaths) carrying the new header are affected.

This repo has no automated test framework for `apps/catalogues-web` (see `docs/superpowers/specs/2026-07-27-tryon-library-installable-app-design.md`'s own testing plan) — this task is verified manually against a running dev stack instead of with an automated test.

- [ ] **Step 1: Add the import**

In `apps/catalogues-web/src/middleware.ts`, add to the existing import block at the top:

```ts
import { setAuthCookies } from '@/lib/auth-cookies';
import { setCatalogAppCookies } from '@/lib/catalog-app-cookies';
import { buildCsp } from '@/lib/csp';
```

(`setAuthCookies` and `buildCsp` are the two existing imports already there — insert the new line between them, alphabetically.)

- [ ] **Step 2: Add the device-token exchange branch**

Find this block (the `path` computation, currently followed immediately by the `/api/auth` and `/api/catalog-app` short-circuits):

```ts
  // Next.js strips basePath before middleware receives pathname.
  // Strip manually too in case it doesn't (varies by version/config).
  const path =
    BASE_PATH && pathname.startsWith(BASE_PATH)
      ? pathname.slice(BASE_PATH.length) || '/'
      : pathname;

  if (path.startsWith('/api/auth')) return next();
  if (path.startsWith('/api/catalog-app')) return next();
```

Insert a new branch between the `path` computation and those two lines:

```ts
  // Next.js strips basePath before middleware receives pathname.
  // Strip manually too in case it doesn't (varies by version/config).
  const path =
    BASE_PATH && pathname.startsWith(BASE_PATH)
      ? pathname.slice(BASE_PATH.length) || '/'
      : pathname;

  // Android app WebView SSO bypass
  // (docs/superpowers/specs/2026-08-18-android-tryon-library-app-sso-design.md):
  // the native app sends its device access token as a header on the WebView's
  // first navigation only. Exchange it for a catalog_app_refresh cookie before
  // AuthGate's own client-side check ever runs, so an already-signed-in
  // merchant never sees this PWA's separate login form. No-op for every other
  // visitor (no header, or the cookie is already set).
  if (path === '/tryon-library-app' || path.startsWith('/tryon-library-app/')) {
    const deviceToken = request.headers.get('x-tryme-device-token');
    const hasCatalogCookie = request.cookies.get('catalog_app_refresh');
    if (deviceToken && !hasCatalogCookie) {
      try {
        const res = await fetch(`${API_URL}/v1/auth/catalog-app-device-exchange`, {
          method: 'POST',
          headers: { authorization: `Bearer ${deviceToken}` },
        });
        if (res.ok) {
          const h = res.headers as Headers & { getSetCookie?: () => string[] };
          const setCookieStr = h.getSetCookie
            ? h.getSetCookie().join(', ') || null
            : res.headers.get('set-cookie');
          const response = NextResponse.next({ request: { headers: requestHeaders } });
          setCatalogAppCookies(response, setCookieStr);
          return withCsp(response);
        }
      } catch {
        // Exchange failed (expired token, not a merchant, network error) — fall
        // through to the page's own client-side login form, same as today.
      }
    }
    return next();
  }

  if (path.startsWith('/api/auth')) return next();
  if (path.startsWith('/api/catalog-app')) return next();
```

`/tryon-library-app` stays listed in `PUBLIC_PATHS` further down in this file — that list still governs unauthenticated visitors reaching the page at all. This new branch only adds an opportunistic cookie-mint step ahead of that, and returns early for this one path either way (mirroring how `/api/auth` and `/api/catalog-app` already return early above it).

- [ ] **Step 3: Manual verification**

With `pnpm docker:up` running and `pnpm dev` started (api on `:4000`, web on `:3000`):

1. Pick or create a merchant account with a known password (any account for which `createTestMerchant`-equivalent data exists — an admin-created merchant works, or reuse a local dev seed).
2. Get a device access token:
   ```bash
   curl -s -X POST http://localhost:4000/v1/auth/device-login \
     -H 'Content-Type: application/json' \
     -d '{"email":"<merchant-email>","password":"<password>","deviceId":"manual-test","platform":"mobile"}'
   ```
   Copy the `accessToken` value from the response.
3. Request the page with the header:
   ```bash
   curl -i http://localhost:3000/tryon-library-app \
     -H "X-Tryme-Device-Token: <accessToken from step 2>"
   ```
   Expected: response headers include a `set-cookie: catalog_app_refresh=...` line.
4. Repeat the same request **without** the header:
   ```bash
   curl -i http://localhost:3000/tryon-library-app
   ```
   Expected: no `catalog_app_refresh` in `set-cookie` — regular visitors are unaffected.
5. Repeat step 3 with an obviously invalid token (e.g. `X-Tryme-Device-Token: garbage`):
   Expected: no `catalog_app_refresh` cookie set, and the response still renders the page normally (no 500).

Report the actual `curl -i` output for steps 3–5 rather than just "it worked" — this task has no automated test, so this transcript is the only verification record.

- [ ] **Step 4: Commit**

```bash
git add apps/catalogues-web/src/middleware.ts
git commit -m "feat(web): exchange Android device token for catalog-app session in middleware"
```

---

## Definition of Done

- Both tasks' checkboxes checked off.
- `pnpm --filter @tryme/api test`, `pnpm --filter @tryme/api test:integration`, `pnpm typecheck`, and `pnpm lint` all clean.
- Manual verification transcript from Task 2 Step 3 recorded in the PR description or commit message body.
- `docs/progress.md` updated per `CLAUDE.md`'s progress-tracking convention: a dated entry noting the new `POST /v1/auth/catalog-app-device-exchange` endpoint and the `X-Tryme-Device-Token` header contract, since the Android-side implementation (separate repo) will need this documented somewhere discoverable.
