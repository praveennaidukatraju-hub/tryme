# Installable Try On Library Mini-App Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a standalone, installable (Chrome "Add to Home Screen") page at `/tryon-library-app` that shows only login + the Try On Library catalog UI for merchant accounts — no sidebar, and genuinely no access to any other authenticated route, even by direct URL.

**Architecture:** A new JWT audience/portal, `catalog-app`, alongside the existing `web`/`admin`/`mobile`/`kiosk` portals. `requireUser` (guarding Studio/Settings/Catalogs/etc.) gets one added check that rejects this audience — that's the actual boundary. Login extends the existing `/v1/auth/login`; refresh is one new thin route wrapping the already-shared `rotateTokenFamily` helper; logout widens the existing route to check either cookie name. The frontend is a new top-level route (outside the `(app)` layout group, so no Sidebar/AppShell) with its own small API client and cookie, and duplicated copies of the existing catalog-management UI components (they can't be reused as-is — see Task 9).

**Tech Stack:** Fastify 5 + Zod (`@tryme/types`), Drizzle ORM, `jose` JWTs, Next.js 15 App Router, React, Vitest integration tests.

**Design reference:** `docs/superpowers/specs/2026-07-27-tryon-library-installable-app-design.md`. Two corrections were found during planning that go beyond that spec, both mechanical necessities, not new architectural decisions — read the note at the top of Task 6 and Task 13 before starting.

---

### Task 1: Backend — `requireUser` rejects `catalog-app` tokens

**Files:**
- Modify: `apps/api/src/plugins/auth.ts`

- [ ] **Step 1: Add the check**

Current (`requireUser`, lines 20–45):
```ts
  app.decorate('requireUser', async (req, _reply) => {
    const h = req.headers.authorization;
    // Header-only: access tokens must never travel in the query string (they leak
    // into proxy/access logs, browser history, Referer). SSE clients use a
    // fetch-based reader that sends the Authorization header (see web/admin sse.ts).
    const token = h?.startsWith('Bearer ') ? h.slice(7) : undefined;
    if (!token) throw new AppError('UNAUTH', 401, 'missing bearer');
    let userId: string;
    try {
      const payload = await verifyAccess(secret, token);
      // Reject tokens not issued for the user portal (kind must be 'access')
      if ((payload as Record<string, unknown>).kind !== 'access')
        throw new AppError('UNAUTH', 401, 'invalid token');
      userId = String(payload.sub);
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError('UNAUTH', 401, 'invalid token');
    }
```
Replace the `kind` check line with two checks:
```ts
  app.decorate('requireUser', async (req, _reply) => {
    const h = req.headers.authorization;
    // Header-only: access tokens must never travel in the query string (they leak
    // into proxy/access logs, browser history, Referer). SSE clients use a
    // fetch-based reader that sends the Authorization header (see web/admin sse.ts).
    const token = h?.startsWith('Bearer ') ? h.slice(7) : undefined;
    if (!token) throw new AppError('UNAUTH', 401, 'missing bearer');
    let userId: string;
    try {
      const payload = await verifyAccess(secret, token);
      // Reject tokens not issued for the user portal (kind must be 'access')
      if ((payload as Record<string, unknown>).kind !== 'access')
        throw new AppError('UNAUTH', 401, 'invalid token');
      // Reject the Try On Library installed mini-app's restricted-scope tokens —
      // that portal may only reach requireMerchant-guarded routes and its own
      // auth routes. This is the boundary that makes the restriction real; see
      // docs/superpowers/specs/2026-07-27-tryon-library-installable-app-design.md.
      if ((payload as Record<string, unknown>).aud === 'catalog-app')
        throw new AppError('UNAUTH', 401, 'invalid token');
      userId = String(payload.sub);
    } catch (err) {
      if (err instanceof AppError) throw err;
      throw new AppError('UNAUTH', 401, 'invalid token');
    }
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @tryme/api exec tsc --noEmit -p .`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/plugins/auth.ts
git commit -m "feat(api): reject catalog-app-scoped tokens in requireUser"
```

(This is tested end-to-end in Task 4's test file, once the login extension exists to actually issue a `catalog-app` token to test against.)

---

### Task 2: Backend — `WebLoginBody` type + `createSessionTokens` portal parameter

**Files:**
- Modify: `packages/types/src/auth.ts`
- Modify: `apps/api/src/modules/auth/tokens.ts`

- [ ] **Step 1: Add `WebLoginBody`**

In `packages/types/src/auth.ts`, current (lines 12–15):
```ts
export const LoginBody = z.object({
  email: z.string().min(1).max(254),
  password: z.string().min(1).max(128),
});
```
Add right after it:
```ts
// Used only by POST /v1/auth/login (the main web login route) — NOT by
// LoginBody itself, so DeviceLoginBody (which extends LoginBody for the
// Android app) is unaffected.
export const WebLoginBody = LoginBody.extend({
  portal: z.enum(['catalog-app']).optional(),
});
```

- [ ] **Step 2: Typecheck the types package**

Run: `pnpm --filter @tryme/types exec tsc --noEmit`
Expected: no output.

- [ ] **Step 3: Extend `createSessionTokens`**

In `apps/api/src/modules/auth/tokens.ts`, current (lines 5–33):
```ts
export async function createSessionTokens(
  app: FastifyInstance,
  userId: string,
  reply: FastifyReply,
  status: number,
) {
  const secret = new TextEncoder().encode(app.env.JWT_SECRET);
  const accessToken = await signAccess(secret, userId, { kind: 'access' }, app.env.JWT_EXPIRY);
  const r = newRefreshToken();
  const expiresAt = new Date(Date.now() + parseDuration(app.env.REFRESH_TOKEN_EXPIRY));
  await app.db.insert(schema.refreshTokens).values({
    userId,
    familyId: crypto.randomUUID(),
    generation: 1,
    tokenHash: r.hash,
    expiresAt,
    portal: 'web',
  });
  reply.setCookie('refresh', r.plain, {
    httpOnly: true,
    secure: app.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/v1/auth',
    expires: expiresAt,
    signed: false,
  });
  reply.code(status);
  return { accessToken };
}
```
Replace with:
```ts
export async function createSessionTokens(
  app: FastifyInstance,
  userId: string,
  reply: FastifyReply,
  status: number,
  portal: 'web' | 'catalog-app' = 'web',
) {
  const secret = new TextEncoder().encode(app.env.JWT_SECRET);
  const audience = portal === 'catalog-app' ? 'catalog-app' : undefined;
  const accessToken = await signAccess(secret, userId, { kind: 'access' }, app.env.JWT_EXPIRY, audience);
  const r = newRefreshToken();
  const expiresAt = new Date(Date.now() + parseDuration(app.env.REFRESH_TOKEN_EXPIRY));
  await app.db.insert(schema.refreshTokens).values({
    userId,
    familyId: crypto.randomUUID(),
    generation: 1,
    tokenHash: r.hash,
    expiresAt,
    portal,
  });
  const cookieName = portal === 'catalog-app' ? 'catalog_app_refresh' : 'refresh';
  reply.setCookie(cookieName, r.plain, {
    httpOnly: true,
    secure: app.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/v1/auth',
    expires: expiresAt,
    signed: false,
  });
  reply.code(status);
  return { accessToken };
}
```
(Every existing caller passes only 4 arguments, so `portal` defaults to `'web'` and behavior is unchanged for them.)

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @tryme/api exec tsc --noEmit -p .`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add packages/types/src/auth.ts apps/api/src/modules/auth/tokens.ts
git commit -m "feat(api,types): add WebLoginBody and a portal parameter to createSessionTokens"
```

---

### Task 3: Backend — extend `POST /v1/auth/login` for the catalog-app portal

**Files:**
- Modify: `apps/api/src/modules/auth/routes.ts`
- Test: `apps/api/test/integration/catalog-app-auth.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/api/test/integration/catalog-app-auth.test.ts`:

```ts
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../../src/modules/auth/service.js';
import { buildTestApp, type TestApp } from '../helpers/api.js';
import { type Containers, startContainers } from '../helpers/containers.js';
import { createTestMerchant } from '../helpers/merchant.js';

describe('catalog-app portal login', () => {
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

  async function setPassword(userId: string, password: string) {
    const passwordHash = await hashPassword(password);
    await app.db.update(schema.users).set({ passwordHash }).where(eq(schema.users.id, userId));
  }

  it('issues a catalog_app_refresh cookie (not refresh) for a merchant account', async () => {
    const { userId } = await createTestMerchant(app);
    await setPassword(userId, 'password123');
    const [user] = await app.db.select().from(schema.users).where(eq(schema.users.id, userId));

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: user?.email, password: 'password123', portal: 'catalog-app' },
    });
    expect(res.statusCode).toBe(200);
    const cookies = res.cookies.map((c) => c.name);
    expect(cookies).toContain('catalog_app_refresh');
    expect(cookies).not.toContain('refresh');
  });

  it('rejects a non-merchant account with portal: catalog-app', async () => {
    const passwordHash = await hashPassword('password123');
    const [user] = await app.db
      .insert(schema.users)
      .values({
        email: `notmerchant${Date.now()}@example.com`,
        passwordHash,
        emailVerified: true,
        tier: 'free',
      })
      .returning();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: user?.email, password: 'password123', portal: 'catalog-app' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('a catalog-app token is rejected by requireUser but accepted by requireMerchant', async () => {
    const { userId } = await createTestMerchant(app);
    await setPassword(userId, 'password123');
    const [user] = await app.db.select().from(schema.users).where(eq(schema.users.id, userId));

    const loginRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: user?.email, password: 'password123', portal: 'catalog-app' },
    });
    const { accessToken } = loginRes.json() as { accessToken: string };

    const meRes = await app.inject({
      method: 'GET',
      url: '/v1/me',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(meRes.statusCode).toBe(401);

    const merchantRes = await app.inject({
      method: 'GET',
      url: '/v1/merchant/catalog/subcategories',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(merchantRes.statusCode).toBe(200);
  });

  it('plain /v1/auth/login (no portal) is unaffected — sets refresh, not catalog_app_refresh', async () => {
    const passwordHash = await hashPassword('password123');
    const [user] = await app.db
      .insert(schema.users)
      .values({
        email: `plainlogin${Date.now()}@example.com`,
        passwordHash,
        emailVerified: true,
        tier: 'free',
      })
      .returning();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: user?.email, password: 'password123' },
    });
    expect(res.statusCode).toBe(200);
    const cookies = res.cookies.map((c) => c.name);
    expect(cookies).toContain('refresh');
    expect(cookies).not.toContain('catalog_app_refresh');
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run:
```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts catalog-app-auth
```
Expected: FAIL — `portal` isn't accepted/acted on by `/v1/auth/login` yet, and `/v1/merchant/catalog/subcategories` will 401 for the plain token (no catalog-app audience exists yet to test the exclusion against).

- [ ] **Step 3: Implement**

In `apps/api/src/modules/auth/routes.ts`, change the `/v1/auth/login` route's schema (currently `schema: { body: LoginBody }`) to use the new type — first add `WebLoginBody` to the `@tryme/types` import (currently line 3):
```ts
import { LoginBody, RegisterBody } from '@tryme/types';
```
becomes:
```ts
import { LoginBody, RegisterBody, WebLoginBody } from '@tryme/types';
```

Current route registration and handler (the `/v1/auth/login` block found in Task 3 review — search for `'/v1/auth/login'`):
```ts
  app.post(
    '/v1/auth/login',
    {
      schema: { body: LoginBody },
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      // Field is named `email` on the wire (see LoginBody) but may hold a
      // username for admin-created accounts -- see findUserByIdentifier.
      const { email: identifier, password } = req.body as z.infer<typeof LoginBody>;
      const user = await findUserByIdentifier(app, identifier);
      if (!user || user.isBanned) {
        await verifyPassword(dummyHash, password); // constant-time: prevent user enumeration via timing
        throw new AppError('INVALID', 401, 'invalid credentials');
      }
      if (!user.passwordHash) throw new AppError('INVALID', 401, 'invalid credentials');
      if (!(await verifyPassword(user.passwordHash, password)))
        throw new AppError('INVALID', 401, 'invalid credentials');
      if (user.email && !user.emailVerified) {
        throw new AppError('EMAIL_NOT_VERIFIED', 403, 'email not verified');
      }
      const [adminRow] = await app.db
        .select({ role: schema.adminUsers.role, status: schema.adminUsers.status })
        .from(schema.adminUsers)
        .where(eq(schema.adminUsers.userId, user.id));
      if (adminRow?.status === 'active' && adminRow.role === 'SUPER_ADMIN') {
        throw new AppError('FORBIDDEN', 403, 'Super admin accounts must use the admin panel.');
      }
      return createSessionTokens(app, user.id, reply, 200);
    },
  );
```
Replace with:
```ts
  app.post(
    '/v1/auth/login',
    {
      schema: { body: WebLoginBody },
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      // Field is named `email` on the wire (see LoginBody) but may hold a
      // username for admin-created accounts -- see findUserByIdentifier.
      const { email: identifier, password, portal } = req.body as z.infer<typeof WebLoginBody>;
      const user = await findUserByIdentifier(app, identifier);
      if (!user || user.isBanned) {
        await verifyPassword(dummyHash, password); // constant-time: prevent user enumeration via timing
        throw new AppError('INVALID', 401, 'invalid credentials');
      }
      if (!user.passwordHash) throw new AppError('INVALID', 401, 'invalid credentials');
      if (!(await verifyPassword(user.passwordHash, password)))
        throw new AppError('INVALID', 401, 'invalid credentials');
      if (user.email && !user.emailVerified) {
        throw new AppError('EMAIL_NOT_VERIFIED', 403, 'email not verified');
      }
      if (portal === 'catalog-app') {
        const [merchantRow] = await app.db
          .select({ isActive: schema.merchants.isActive })
          .from(schema.merchants)
          .where(eq(schema.merchants.userId, user.id));
        if (!merchantRow?.isActive) {
          throw new AppError('NOT_A_MERCHANT', 403, 'This account has no Try On Library access.');
        }
        return createSessionTokens(app, user.id, reply, 200, 'catalog-app');
      }
      const [adminRow] = await app.db
        .select({ role: schema.adminUsers.role, status: schema.adminUsers.status })
        .from(schema.adminUsers)
        .where(eq(schema.adminUsers.userId, user.id));
      if (adminRow?.status === 'active' && adminRow.role === 'SUPER_ADMIN') {
        throw new AppError('FORBIDDEN', 403, 'Super admin accounts must use the admin panel.');
      }
      return createSessionTokens(app, user.id, reply, 200);
    },
  );
```

- [ ] **Step 4: Run the tests again to confirm they pass**

Run:
```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts catalog-app-auth
```
Expected: all 4 tests PASS.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @tryme/api exec tsc --noEmit -p .`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/auth/routes.ts apps/api/test/integration/catalog-app-auth.test.ts
git commit -m "feat(api): accept portal: catalog-app on /v1/auth/login"
```

---

### Task 4: Backend — new thin refresh route

**Files:**
- Modify: `apps/api/src/modules/auth/routes.ts`
- Test: extend `apps/api/test/integration/catalog-app-auth.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `apps/api/test/integration/catalog-app-auth.test.ts` (inside the existing `describe` block, after the last `it`):

```ts
  it('catalog-app-refresh rotates the catalog_app_refresh cookie and reissues a catalog-app-audience token', async () => {
    const { userId } = await createTestMerchant(app);
    await setPassword(userId, 'password123');
    const [user] = await app.db.select().from(schema.users).where(eq(schema.users.id, userId));

    const loginRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: user?.email, password: 'password123', portal: 'catalog-app' },
    });
    const refreshCookie = loginRes.cookies.find((c) => c.name === 'catalog_app_refresh');
    expect(refreshCookie).toBeTruthy();

    const refreshRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/catalog-app-refresh',
      cookies: { catalog_app_refresh: refreshCookie?.value ?? '' },
    });
    expect(refreshRes.statusCode).toBe(200);
    expect(refreshRes.json().accessToken).toBeTruthy();

    const merchantRes = await app.inject({
      method: 'GET',
      url: '/v1/merchant/catalog/subcategories',
      headers: { authorization: `Bearer ${refreshRes.json().accessToken}` },
    });
    expect(merchantRes.statusCode).toBe(200);
  });

  it('rejects a plain web refresh token presented at catalog-app-refresh', async () => {
    const { userId } = await createTestMerchant(app);
    await setPassword(userId, 'password123');
    const [user] = await app.db.select().from(schema.users).where(eq(schema.users.id, userId));

    const loginRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: user?.email, password: 'password123' },
    });
    const refreshCookie = loginRes.cookies.find((c) => c.name === 'refresh');

    const refreshRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/catalog-app-refresh',
      cookies: { catalog_app_refresh: refreshCookie?.value ?? '' },
    });
    expect(refreshRes.statusCode).toBe(401);
  });
```

- [ ] **Step 2: Run it to confirm it fails**

Run:
```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts catalog-app-auth
```
Expected: FAIL — `/v1/auth/catalog-app-refresh` doesn't exist yet (404).

- [ ] **Step 3: Implement**

In `apps/api/src/modules/auth/routes.ts`, add this new route directly after the closing `);` of `/v1/auth/logout` (search for `app.post('/v1/auth/logout'` — add the new route right after that block ends, before the `// ── Mobile auth` comment section):

```ts
  app.post('/v1/auth/catalog-app-refresh', async (req, reply) => {
    const plain = req.cookies.catalog_app_refresh;
    if (!plain) throw new AppError('NO_REFRESH', 401, 'no refresh token');
    const result = await rotateTokenFamily(app, plain, 'catalog-app');
    if (result.kind === 'invalid') throw new AppError('INVALID_REFRESH', 401, 'refresh invalid');
    const secret = new TextEncoder().encode(app.env.JWT_SECRET);
    if (result.kind === 'reissue') {
      return {
        accessToken: await signAccess(
          secret,
          result.userId,
          { kind: 'access' },
          app.env.JWT_EXPIRY,
          'catalog-app',
        ),
      };
    }
    reply.setCookie('catalog_app_refresh', result.refreshPlain, {
      httpOnly: true,
      secure: app.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/v1/auth',
      expires: result.expiresAt,
      signed: false,
    });
    return {
      accessToken: await signAccess(
        secret,
        result.userId,
        { kind: 'access' },
        app.env.JWT_EXPIRY,
        'catalog-app',
      ),
    };
  });
```
`rotateTokenFamily` and `signAccess` are already imported/defined in this file (used by the existing `/v1/auth/device-login/force` and `/v1/auth/login` routes respectively) — no new imports needed.

- [ ] **Step 4: Run the tests again to confirm they pass**

Run:
```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts catalog-app-auth
```
Expected: all 6 tests PASS.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @tryme/api exec tsc --noEmit -p .`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/auth/routes.ts apps/api/test/integration/catalog-app-auth.test.ts
git commit -m "feat(api): add POST /v1/auth/catalog-app-refresh"
```

---

### Task 5: Backend — widen `/v1/auth/logout` to accept either cookie name

**Files:**
- Modify: `apps/api/src/modules/auth/routes.ts`

- [ ] **Step 1: Update the route**

Current (`/v1/auth/logout`, search for `app.post('/v1/auth/logout'`):
```ts
  app.post('/v1/auth/logout', async (req) => {
    const plain = req.cookies.refresh;
    if (plain) {
```
Replace the first two lines with:
```ts
  app.post('/v1/auth/logout', async (req) => {
    const plain = req.cookies.refresh ?? req.cookies.catalog_app_refresh;
    if (plain) {
```
(The rest of the handler — revoking by `tokenHash`/`familyId` — is already portal-agnostic and needs no change.)

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @tryme/api exec tsc --noEmit -p .`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/modules/auth/routes.ts
git commit -m "feat(api): widen /v1/auth/logout to accept the catalog-app refresh cookie"
```

---

### Task 6: Backend — new `GET /v1/merchant/me`

> **Correction found during planning, not in the original spec:** the credits chip and avatar shown in the screenshot (the thing this whole feature is meant to display) come from `/v1/credits` and `GET /v1/me` — both guarded by `requireUser`, which Task 1 just excluded `catalog-app` tokens from. Reusing them unmodified would silently break the credits/name display for this new page. Rather than loosen `requireUser` (which would defeat Task 1's whole purpose) or add a second guard to two existing generic routes, this adds one small new route under the existing `requireMerchant` guard (which already accepts `catalog-app` tokens with no changes) returning exactly the two pieces of information this page's header needs.

**Files:**
- Create: `apps/api/src/modules/merchant/me.routes.ts`
- Modify: `apps/api/src/server.ts`
- Test: `apps/api/test/integration/merchant-me.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/integration/merchant-me.test.ts`:

```ts
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from '../helpers/api.js';
import { type Containers, startContainers } from '../helpers/containers.js';
import { createTestMerchant } from '../helpers/merchant.js';
import { signAccess } from '../../src/modules/auth/service.js';

describe('GET /v1/merchant/me', () => {
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

  it("returns the merchant's display name, email, and credit balance", async () => {
    const { userId } = await createTestMerchant(app, { balance: 250 });
    await app.db
      .update(schema.users)
      .set({ displayName: 'Store Owner' })
      .where(eq(schema.users.id, userId));
    const secret = new TextEncoder().encode(app.env.JWT_SECRET);
    const token = await signAccess(secret, userId, { kind: 'access' }, '15m');

    const res = await app.inject({
      method: 'GET',
      url: '/v1/merchant/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { displayName: string | null; email: string | null; balance: number };
    expect(body.displayName).toBe('Store Owner');
    expect(body.balance).toBe(250);
  });

  it('rejects a non-merchant account', async () => {
    const secret = new TextEncoder().encode(app.env.JWT_SECRET);
    const [user] = await app.db
      .insert(schema.users)
      .values({ email: `plain${Date.now()}@example.com`, emailVerified: true, tier: 'free' })
      .returning();
    const token = await signAccess(secret, user?.id ?? '', { kind: 'access' }, '15m');

    const res = await app.inject({
      method: 'GET',
      url: '/v1/merchant/me',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run:
```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts merchant-me
```
Expected: FAIL — `/v1/merchant/me` doesn't exist (404).

- [ ] **Step 3: Implement the route**

Create `apps/api/src/modules/merchant/me.routes.ts`:

```ts
import { schema } from '@tryme/db';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { AppError } from '../../lib/errors.js';

export async function merchantMeRoutes(app: FastifyInstance) {
  app.get('/v1/merchant/me', { preHandler: app.requireMerchant }, async (req) => {
    const merchantId = req.merchantClientId;
    if (!merchantId) throw new AppError('UNAUTH', 401, 'missing merchant');

    const [row] = await app.db
      .select({
        displayName: schema.users.displayName,
        email: schema.users.email,
        balance: sql<number>`COALESCE(${schema.userCredits.balance}, 0)`,
      })
      .from(schema.merchants)
      .innerJoin(schema.users, eq(schema.users.id, schema.merchants.userId))
      .leftJoin(schema.userCredits, eq(schema.userCredits.userId, schema.merchants.userId))
      .where(eq(schema.merchants.id, merchantId));
    if (!row) throw new AppError('NOT_FOUND', 404, 'merchant not found');

    return row;
  });
}
```

- [ ] **Step 4: Register the route**

In `apps/api/src/server.ts`, add the import next to the existing merchant route imports (currently line 62):
```ts
import { merchantTryonRoutes } from './modules/merchant/tryon.routes.js';
```
becomes:
```ts
import { merchantMeRoutes } from './modules/merchant/me.routes.js';
import { merchantTryonRoutes } from './modules/merchant/tryon.routes.js';
```
And add the registration next to the existing one (currently line 272):
```ts
  await app.register(merchantTryonRoutes);
```
becomes:
```ts
  await app.register(merchantTryonRoutes);
  await app.register(merchantMeRoutes);
```

- [ ] **Step 5: Run the tests again to confirm they pass**

Run:
```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts merchant-me
```
Expected: both tests PASS.

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @tryme/api exec tsc --noEmit -p .`
Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/merchant/me.routes.ts apps/api/src/server.ts apps/api/test/integration/merchant-me.test.ts
git commit -m "feat(api): add GET /v1/merchant/me for the Try On Library mini-app header"
```

---

### Task 7: Backend verification checkpoint

- [ ] **Step 1: Run every new/modified backend test together**

Run:
```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts catalog-app-auth merchant-me
```
Expected: all PASS (6 + 2 = 8 tests).

- [ ] **Step 2: Full API typecheck**

Run: `pnpm --filter @tryme/api exec tsc --noEmit -p .`
Expected: no output.

All backend work is done. Tasks 8+ are frontend-only.

---

### Task 8: Frontend — cookie helper + 3 BFF proxy routes

**Files:**
- Create: `apps/catalogues-web/src/lib/catalog-app-cookies.ts`
- Create: `apps/catalogues-web/src/app/api/catalog-app/login/route.ts`
- Create: `apps/catalogues-web/src/app/api/catalog-app/refresh/route.ts`
- Create: `apps/catalogues-web/src/app/api/catalog-app/logout/route.ts`
- Modify: `apps/catalogues-web/src/middleware.ts`

- [ ] **Step 1: Cookie helper**

Create `apps/catalogues-web/src/lib/catalog-app-cookies.ts` (mirrors `apps/catalogues-web/src/lib/auth-cookies.ts`, but for the `catalog_app_refresh` cookie instead of `refresh`):

```ts
import type { NextResponse } from 'next/server';

export function setCatalogAppCookies(response: NextResponse, setCookieHeader: string | null): void {
  if (!setCookieHeader) return;
  const match = setCookieHeader.match(/catalog_app_refresh=([^;]+)/);
  if (!match?.[1]) return;
  response.cookies.set('catalog_app_refresh', match[1], {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 7 * 24 * 60 * 60,
    secure: process.env.NODE_ENV === 'production',
  });
}

export function clearCatalogAppCookies(response: NextResponse): void {
  response.cookies.set('catalog_app_refresh', '', { maxAge: 0, path: '/' });
}
```

- [ ] **Step 2: Login BFF route**

Create `apps/catalogues-web/src/app/api/catalog-app/login/route.ts`:

```ts
import { type NextRequest, NextResponse } from 'next/server';
import { setCatalogAppCookies } from '@/lib/catalog-app-cookies';
import { safeJson } from '@/lib/bff';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const res = await fetch(`${API_URL}/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, portal: 'catalog-app' }),
    });

    const [data, ok] = await safeJson(res);
    if (!ok) return NextResponse.json(data, { status: res.status });

    const typed = data as { accessToken?: string };
    const response = NextResponse.json({ ok: true, accessToken: typed.accessToken });
    const h = res.headers as Headers & { getSetCookie?: () => string[] };
    const setCookieStr = h.getSetCookie
      ? h.getSetCookie().join(', ') || null
      : res.headers.get('set-cookie');
    setCatalogAppCookies(response, setCookieStr);
    return response;
  } catch (err) {
    console.error('catalog-app login BFF route failed:', err);
    return NextResponse.json({ error: { message: 'Service unavailable' } }, { status: 503 });
  }
}
```
(Mirrors `apps/catalogues-web/src/app/api/auth/login/route.ts` exactly, with `portal: 'catalog-app'` forced into the forwarded body and `setCatalogAppCookies` instead of `setAuthCookies`. Check `@/lib/bff`'s `safeJson` export exists — it's already used by the existing login route.)

- [ ] **Step 3: Refresh BFF route**

Create `apps/catalogues-web/src/app/api/catalog-app/refresh/route.ts`:

```ts
import { type NextRequest, NextResponse } from 'next/server';
import { setCatalogAppCookies } from '@/lib/catalog-app-cookies';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export async function POST(req: NextRequest) {
  const refreshToken = req.cookies.get('catalog_app_refresh')?.value;
  if (!refreshToken) return NextResponse.json({ error: { message: 'no refresh token' } }, { status: 401 });

  const res = await fetch(`${API_URL}/v1/auth/catalog-app-refresh`, {
    method: 'POST',
    headers: { Cookie: `catalog_app_refresh=${refreshToken}` },
  });
  if (!res.ok) return NextResponse.json({ error: { message: 'refresh failed' } }, { status: res.status });

  const data = (await res.json()) as { accessToken?: string };
  const response = NextResponse.json({ accessToken: data.accessToken });
  const h = res.headers as Headers & { getSetCookie?: () => string[] };
  const setCookieStr = h.getSetCookie
    ? h.getSetCookie().join(', ') || null
    : res.headers.get('set-cookie');
  setCatalogAppCookies(response, setCookieStr);
  return response;
}
```

- [ ] **Step 4: Logout BFF route**

Create `apps/catalogues-web/src/app/api/catalog-app/logout/route.ts`:

```ts
import { type NextRequest, NextResponse } from 'next/server';
import { clearCatalogAppCookies } from '@/lib/catalog-app-cookies';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export async function POST(req: NextRequest) {
  const refreshToken = req.cookies.get('catalog_app_refresh')?.value;
  if (refreshToken) {
    await fetch(`${API_URL}/v1/auth/logout`, {
      method: 'POST',
      headers: { Cookie: `catalog_app_refresh=${refreshToken}` },
    }).catch(() => {});
  }
  const response = NextResponse.json({ ok: true });
  clearCatalogAppCookies(response);
  return response;
}
```

- [ ] **Step 5: Middleware changes**

In `apps/catalogues-web/src/middleware.ts`:

Current (lines 7–15):
```ts
const PUBLIC_PATHS = [
  '/login',
  '/register',
  '/home',
  '/verify-email',
  '/forgot-password',
  '/reset-password',
  '/kiosk-upload',
];
```
Add `/tryon-library-app`:
```ts
const PUBLIC_PATHS = [
  '/login',
  '/register',
  '/home',
  '/verify-email',
  '/forgot-password',
  '/reset-password',
  '/kiosk-upload',
  '/tryon-library-app',
];
```

Current (line 34):
```ts
  if (path.startsWith('/api/auth')) return NextResponse.next();
```
Add a second bypass right after it:
```ts
  if (path.startsWith('/api/auth')) return NextResponse.next();
  if (path.startsWith('/api/catalog-app')) return NextResponse.next();
```

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @tryme/web exec tsc --noEmit -p .`
Expected: no output.

- [ ] **Step 7: Biome check**

Run:
```bash
npx biome check apps/catalogues-web/src/lib/catalog-app-cookies.ts apps/catalogues-web/src/app/api/catalog-app apps/catalogues-web/src/middleware.ts
```
Expected: clean (fix anything the formatter flags with `npx biome format --write <path>` and re-check).

- [ ] **Step 8: Commit**

```bash
git add apps/catalogues-web/src/lib/catalog-app-cookies.ts apps/catalogues-web/src/app/api/catalog-app apps/catalogues-web/src/middleware.ts
git commit -m "feat(web): add catalog-app BFF auth routes and middleware bypass"
```

---

### Task 9: Frontend — `catalog-app-api.ts` client module

> **Why this can't just be `lib/api.ts`:** that module holds its access token and a `BroadcastChannel('tryme-auth')` at module scope, and on an unrecoverable 401 it hardcodes `window.location.href = '/login'` — the wrong login page for this route, and cross-talk risk with a regular session open in another tab. This is a from-scratch (but structurally identical) client scoped to this route.

**Files:**
- Create: `apps/catalogues-web/src/app/tryon-library-app/catalog-app-api.ts`

- [ ] **Step 1: Write the module**

Create `apps/catalogues-web/src/app/tryon-library-app/catalog-app-api.ts`:

```ts
import {
  ApiError,
  networkError,
  readResponseBody,
  responseError,
} from '@/lib/errors';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

// Kept in module memory only, isolated from lib/api.ts's own in-memory token —
// this route's session must not read/write the main site's session state.
let _memToken: string | null = null;

export function initCatalogAppToken(token: string): void {
  _memToken = token;
}

export function getCatalogAppToken(): string | null {
  return _memToken;
}

export function clearCatalogAppToken(): void {
  _memToken = null;
}

let refreshInFlight: Promise<string | null> | null = null;

function tryRefresh(): Promise<string | null> {
  if (!refreshInFlight) {
    refreshInFlight = (async () => {
      try {
        const res = await fetch(`${BASE}/api/catalog-app/refresh`, { method: 'POST' });
        if (!res.ok) return null;
        const data = (await res.json()) as { accessToken?: string };
        if (!data.accessToken) return null;
        _memToken = data.accessToken;
        return data.accessToken;
      } catch {
        return null;
      }
    })().finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

async function fetchApi(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (err) {
    throw networkError(err);
  }
}

async function readApiResponse<T>(res: Response): Promise<T> {
  if (!res.ok) throw await responseError(res);
  return (await readResponseBody(res)) as T;
}

/** Thrown when a request 401s and the silent refresh also fails — the page should show its login form again. */
export class CatalogAppSessionExpiredError extends Error {
  constructor() {
    super('Your session has expired. Sign in again.');
    this.name = 'CatalogAppSessionExpiredError';
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const token = getCatalogAppToken();
  const headers: Record<string, string> = { ...(options.headers as Record<string, string>) };
  if (options.body != null && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }
  if (token) headers.Authorization = `Bearer ${token}`;

  let res = await fetchApi(`${API_URL}${path}`, { ...options, headers, credentials: 'include' });

  if (res.status === 401) {
    const refreshed = await tryRefresh();
    if (refreshed) {
      headers.Authorization = `Bearer ${refreshed}`;
      res = await fetchApi(`${API_URL}${path}`, { ...options, headers, credentials: 'include' });
    } else {
      clearCatalogAppToken();
      throw new CatalogAppSessionExpiredError();
    }
  }

  return readApiResponse<T>(res);
}

export const catalogAppApi = {
  get: <T>(path: string, options?: RequestInit) => request<T>(path, options),
  post: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'POST', body: JSON.stringify(body) }),
  patch: <T>(path: string, body: unknown) =>
    request<T>(path, { method: 'PATCH', body: JSON.stringify(body) }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
  uploadToR2: async (uploadUrl: string, file: File): Promise<void> => {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', uploadUrl);
      xhr.setRequestHeader('Content-Type', file.type);
      xhr.onload = () =>
        xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Upload failed (${xhr.status})`));
      xhr.onerror = () => reject(new Error('Unable to upload the file. Check your connection and try again.'));
      xhr.send(file);
    });
  },
};

export async function catalogAppLogin(identifier: string, password: string): Promise<void> {
  const res = await fetch(`${BASE}/api/catalog-app/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: identifier, password }),
  });
  const body = await readResponseBody(res);
  if (!res.ok) throw new ApiError(res.status, body);
  const typed = body as { accessToken?: string };
  if (typed.accessToken) initCatalogAppToken(typed.accessToken);
}

export async function catalogAppLogout(): Promise<void> {
  await fetch(`${BASE}/api/catalog-app/logout`, { method: 'POST' }).catch(() => {});
  clearCatalogAppToken();
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @tryme/web exec tsc --noEmit -p .`
Expected: no output (this file has no consumers yet, so this only checks the file compiles standalone).

- [ ] **Step 3: Commit**

```bash
git add apps/catalogues-web/src/app/tryon-library-app/catalog-app-api.ts
git commit -m "feat(web): add the isolated catalog-app API client module"
```

---

### Task 10: Frontend — duplicate `SubcategoryModal.tsx` unchanged

**Files:**
- Create: `apps/catalogues-web/src/app/tryon-library-app/SubcategoryModal.tsx`

- [ ] **Step 1: Copy the file byte-for-byte**

```bash
cp "apps/catalogues-web/src/app/(app)/catalogue-manager/SubcategoryModal.tsx" apps/catalogues-web/src/app/tryon-library-app/SubcategoryModal.tsx
```
No edits needed — this component takes all its data via props and has no direct `api` import (verify this is still true by checking for `from '@/lib/api'` in the copied file — if the source file has changed since this plan was written and now does import it, stop and adapt Task 13's approach for it instead of this task's "no changes" approach).

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @tryme/web exec tsc --noEmit -p .`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add apps/catalogues-web/src/app/tryon-library-app/SubcategoryModal.tsx
git commit -m "feat(web): duplicate SubcategoryModal for the Try On Library mini-app"
```

---

### Task 11: Frontend — duplicate the local `api.ts` helper as `catalog-app-helpers.ts`

**Files:**
- Create: `apps/catalogues-web/src/app/tryon-library-app/catalog-app-helpers.ts`

- [ ] **Step 1: Copy and adapt**

```bash
cp "apps/catalogues-web/src/app/(app)/catalogue-manager/api.ts" apps/catalogues-web/src/app/tryon-library-app/catalog-app-helpers.ts
```

In the new file, current line 2:
```ts
import { api } from '@/lib/api';
```
Replace with:
```ts
import { catalogAppApi as api } from './catalog-app-api';
```
(Aliasing to `api` means every other line in this file — `api.post(...)`, `api.get(...)`, `api.uploadToR2(...)`, `api.del(...)` — needs no further changes.)

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @tryme/web exec tsc --noEmit -p .`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add apps/catalogues-web/src/app/tryon-library-app/catalog-app-helpers.ts
git commit -m "feat(web): duplicate catalog helper functions for the Try On Library mini-app"
```

---

### Task 12: Frontend — duplicate `ProductModal.tsx` and `BulkUploadModal.tsx`

**Files:**
- Create: `apps/catalogues-web/src/app/tryon-library-app/ProductModal.tsx`
- Create: `apps/catalogues-web/src/app/tryon-library-app/BulkUploadModal.tsx`

- [ ] **Step 1: Copy both files**

```bash
cp "apps/catalogues-web/src/app/(app)/catalogue-manager/ProductModal.tsx" apps/catalogues-web/src/app/tryon-library-app/ProductModal.tsx
cp "apps/catalogues-web/src/app/(app)/catalogue-manager/BulkUploadModal.tsx" apps/catalogues-web/src/app/tryon-library-app/BulkUploadModal.tsx
```

- [ ] **Step 2: Adapt `ProductModal.tsx`'s imports**

Current (lines 6–8):
```ts
import { GradBtn } from '@/components/ui/grad-btn';
import { api } from '@/lib/api';
import { deleteProduct, finalizeGeneratedProduct, pollGenerateJob, presignAndUpload } from './api';
```
Replace with:
```ts
import { GradBtn } from '@/components/ui/grad-btn';
import { catalogAppApi as api } from './catalog-app-api';
import { deleteProduct, finalizeGeneratedProduct, pollGenerateJob, presignAndUpload } from './catalog-app-helpers';
```

- [ ] **Step 3: Adapt `BulkUploadModal.tsx`'s imports**

Current (lines 5–12):
```ts
import { GradBtn } from '@/components/ui/grad-btn';
import { api } from '@/lib/api';
import {
  deleteProduct,
  finalizeGeneratedProduct,
  pollGenerateBatch,
  presignAndUpload,
} from './api';
```
Replace with:
```ts
import { GradBtn } from '@/components/ui/grad-btn';
import { catalogAppApi as api } from './catalog-app-api';
import {
  deleteProduct,
  finalizeGeneratedProduct,
  pollGenerateBatch,
  presignAndUpload,
} from './catalog-app-helpers';
```

- [ ] **Step 4: Typecheck**

Run: `pnpm --filter @tryme/web exec tsc --noEmit -p .`
Expected: no output.

- [ ] **Step 5: Commit**

```bash
git add apps/catalogues-web/src/app/tryon-library-app/ProductModal.tsx apps/catalogues-web/src/app/tryon-library-app/BulkUploadModal.tsx
git commit -m "feat(web): duplicate ProductModal and BulkUploadModal for the Try On Library mini-app"
```

---

### Task 13: Frontend — `LibraryUserMenu.tsx` and `LibraryTopBar.tsx`

> **Second correction found during planning:** `TopBar` hardwires the shared `UserMenu` (credits chip linking to `/pricing`, a "Settings" link to `/settings`, both out of scope for this restricted app) and `SupportButton` (posts to `/v1/support`, which is `requireUser`-guarded and will now reject `catalog-app` tokens per Task 1). Neither can be reused as-is. This task builds two small new components instead of duplicating the originals unchanged: `LibraryUserMenu` (credits chip is plain text, no Pricing link; dropdown has only Log Out, no Settings; logout calls `catalogAppLogout()`) and `LibraryTopBar` (same phone number, no Support button, renders `LibraryUserMenu`).

**Files:**
- Create: `apps/catalogues-web/src/app/tryon-library-app/LibraryUserMenu.tsx`
- Create: `apps/catalogues-web/src/app/tryon-library-app/LibraryTopBar.tsx`

- [ ] **Step 1: `LibraryUserMenu.tsx`**

Create `apps/catalogues-web/src/app/tryon-library-app/LibraryUserMenu.tsx` (based on `apps/catalogues-web/src/components/user-menu.tsx`, with the Pricing link, Settings link, and its API calls changed):

```tsx
'use client';
import { useQuery } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { C } from '@/components/tokens';
import { catalogAppApi, catalogAppLogout } from './catalog-app-api';
import { LogOutIcon } from '@/components/icons';

const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

interface MerchantMeResponse {
  displayName: string | null;
  email: string | null;
  balance: number;
}

export function LibraryUserMenu({ onLoggedOut }: { onLoggedOut: () => void }) {
  const [popupOpen, setPopupOpen] = useState(false);
  const [popupRect, setPopupRect] = useState<{ bottom: number; right: number } | null>(null);
  const [profileHover, setProfileHover] = useState(false);
  const popupRef = useRef<HTMLDivElement>(null);

  const { data: me } = useQuery<MerchantMeResponse>({
    queryKey: ['catalog-app-me'],
    queryFn: () => catalogAppApi.get('/v1/merchant/me'),
    retry: false,
  });

  const balance = me?.balance ?? 0;
  const displayName = me?.displayName ?? me?.email?.split('@')[0] ?? 'User';
  const initials = displayName.slice(0, 2).toUpperCase() || 'U';

  async function handleSignOut() {
    await catalogAppLogout();
    onLoggedOut();
  }

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '0 14px',
          height: 40,
          boxSizing: 'border-box',
          borderRadius: 8,
          background: C.bg,
          border: `1px solid ${C.border}`,
        }}
      >
        <span style={{ display: 'flex' }}>
          {/* biome-ignore lint/performance/noImgElement: credit icon, standalone page not using next/image */}
          <img src={`${BASE}/assets/credit.png`} alt="" width={16} height={16} />
        </span>
        <span style={{ color: C.text, fontSize: 13, fontWeight: 500 }}>{balance} Credits</span>
      </div>

      <div ref={popupRef} style={{ position: 'relative' }}>
        {popupOpen && (
          <>
            {/* biome-ignore lint/a11y/noStaticElementInteractions: backdrop closes popup */}
            <div
              role="presentation"
              onClick={(e) => {
                e.stopPropagation();
                setPopupOpen(false);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Escape') setPopupOpen(false);
              }}
              style={{ position: 'fixed', inset: 0, zIndex: 99 }}
            />
            <div
              style={{
                position: 'fixed',
                top: popupRect ? popupRect.bottom + 8 : 80,
                right: popupRect ? popupRect.right : 10,
                width: 200,
                background: C.card,
                border: `1px solid ${C.border}`,
                borderRadius: 10,
                overflow: 'hidden',
                zIndex: 100,
                boxShadow: '0 8px 24px rgba(0,0,0,0.12)',
              }}
            >
              <button
                type="button"
                className="hover-danger-tint"
                onClick={(e) => {
                  e.stopPropagation();
                  setPopupOpen(false);
                  void handleSignOut();
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  width: '100%',
                  padding: '12px 16px',
                  background: 'none',
                  border: 'none',
                  cursor: 'pointer',
                  color: '#F87171',
                  fontSize: 13,
                  fontWeight: 500,
                  fontFamily: 'inherit',
                  textAlign: 'left',
                }}
              >
                <span style={{ opacity: 0.8, display: 'flex' }}>
                  <LogOutIcon />
                </span>
                Log Out
              </button>
            </div>
          </>
        )}

        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            if (!popupOpen && popupRef.current) {
              const r = popupRef.current.getBoundingClientRect();
              setPopupRect({ bottom: r.bottom, right: window.innerWidth - r.right });
            }
            setPopupOpen((v) => !v);
          }}
          title={displayName}
          onMouseEnter={() => setProfileHover(true)}
          onMouseLeave={() => setProfileHover(false)}
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            background: popupOpen || profileHover ? C.bg : 'none',
            border: 'none',
            cursor: 'pointer',
            padding: 0,
            borderRadius: 8,
          }}
        >
          <div
            style={{
              width: 40,
              height: 40,
              borderRadius: '50%',
              background:
                'linear-gradient(rgba(0,0,0,0.15), rgba(0,0,0,0.15)), linear-gradient(91.84deg, #521D9C 0.33%, #BD2587 50.77%, #F96657 99.67%)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: 13,
              fontWeight: 600,
              color: '#ffffff',
              flexShrink: 0,
            }}
          >
            {initials}
          </div>
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: `LibraryTopBar.tsx`**

Create `apps/catalogues-web/src/app/tryon-library-app/LibraryTopBar.tsx` (based on `apps/catalogues-web/src/components/topbar.tsx`, with `SupportButton` removed and `UserMenu` replaced):

```tsx
'use client';
import { PhoneCall } from 'lucide-react';
import { C } from '@/components/tokens';
import { LibraryUserMenu } from './LibraryUserMenu';

export function LibraryTopBar({
  title,
  subtitle,
  right,
  lead,
  onLoggedOut,
}: {
  title?: string;
  subtitle?: string;
  right?: React.ReactNode;
  lead?: React.ReactNode;
  onLoggedOut: () => void;
}) {
  return (
    <div
      style={{
        height: 76,
        background: C.white,
        borderBottom: `1px solid ${C.border}`,
        padding: '0 28px',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        flexShrink: 0,
      }}
    >
      {lead ?? (
        <div>
          {title && (
            <div style={{ fontWeight: 600, fontSize: 20, lineHeight: '32px', color: C.text }}>
              {title}
            </div>
          )}
          {subtitle && (
            <div
              style={{ fontWeight: 500, fontSize: 14, lineHeight: '20px', color: C.mid, marginTop: 2 }}
            >
              {subtitle}
            </div>
          )}
        </div>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        {right}

        <a
          href="tel:+917729883692"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            color: C.text,
            fontSize: 14,
            fontWeight: 500,
            textDecoration: 'none',
            whiteSpace: 'nowrap',
            flexShrink: 0,
          }}
        >
          <PhoneCall size={18} />
          +91 77298 83692
        </a>

        <LibraryUserMenu onLoggedOut={onLoggedOut} />
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @tryme/web exec tsc --noEmit -p .`
Expected: no output (not yet used by any page, so this only checks these two files compile standalone — `LibraryUserMenu` isn't imported anywhere yet, giving an unused-export state that's fine until Task 14 wires it in).

- [ ] **Step 4: Commit**

```bash
git add apps/catalogues-web/src/app/tryon-library-app/LibraryUserMenu.tsx apps/catalogues-web/src/app/tryon-library-app/LibraryTopBar.tsx
git commit -m "feat(web): add LibraryTopBar/LibraryUserMenu (no Settings/Pricing links, no Support button)"
```

---

### Task 14: Frontend — duplicate `CatalogueManagerContent.tsx` as `LibraryContent.tsx`

**Files:**
- Create: `apps/catalogues-web/src/app/tryon-library-app/LibraryContent.tsx`

- [ ] **Step 1: Copy the file**

```bash
cp "apps/catalogues-web/src/app/(app)/catalogue-manager/CatalogueManagerContent.tsx" apps/catalogues-web/src/app/tryon-library-app/LibraryContent.tsx
```

- [ ] **Step 2: Rename the exported function and adapt imports**

In the new file, current (line 17):
```ts
import { api } from '@/lib/api';
```
Replace with:
```ts
import { catalogAppApi as api } from './catalog-app-api';
```

Current (line 14):
```ts
import { TopBar } from '@/components/topbar';
```
Replace with:
```ts
import { LibraryTopBar } from './LibraryTopBar';
```

Current (line 35):
```ts
export function CatalogueManagerContent() {
```
Replace with:
```ts
export function LibraryContent({ onLoggedOut }: { onLoggedOut: () => void }) {
```

There are three `<TopBar` usages in this file. Each needs renaming to `<LibraryTopBar` with `onLoggedOut={onLoggedOut}` added.

First (the `merchantGated` early-return branch — in the duplicated file this branch is unreachable in practice, since login already rejects non-merchant accounts before this page ever renders, but leave it in place unchanged otherwise, just renamed, rather than deleting reachable-looking code as a drive-by cleanup):
```tsx
        <TopBar
          title="Try On Library"
          subtitle="Organize your products by category and garment type."
        />
```
becomes:
```tsx
        <LibraryTopBar
          title="Try On Library"
          subtitle="Organize your products by category and garment type."
          onLoggedOut={onLoggedOut}
        />
```

Second (the main subcategory-grid view):
```tsx
          <TopBar
            title="Try On Library"
            subtitle="Organize your products by category and garment type."
            right={<GradBtn onClick={openAddSubcategory}>Add Subcategory</GradBtn>}
          />
```
becomes:
```tsx
          <LibraryTopBar
            title="Try On Library"
            subtitle="Organize your products by category and garment type."
            right={<GradBtn onClick={openAddSubcategory}>Add Subcategory</GradBtn>}
            onLoggedOut={onLoggedOut}
          />
```

Third (the per-subcategory product drill-down view — this one uses the `lead` prop instead of `title`/`subtitle`, which is exactly why Task 13's `LibraryTopBar` must support `lead`; don't drop it):
```tsx
          <TopBar
            lead={
```
becomes:
```tsx
          <LibraryTopBar
            onLoggedOut={onLoggedOut}
            lead={
```
(Leave the rest of that `lead={...}` JSX value and everything after it untouched — only the opening tag name and the added `onLoggedOut` prop change. Its closing `/>` needs no change since it isn't self-closing on the same line as the opening tag.)

No other changes — the rest of the file's logic (subcategory/product queries, mutations, modal wiring to `SubcategoryModal`/`ProductModal`/`BulkUploadModal`) is unchanged, since those sibling imports (`./BulkUploadModal`, `./ProductModal`, `./SubcategoryModal`) already resolve correctly to the Task 10/12 duplicates living in this same new directory.

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @tryme/web exec tsc --noEmit -p .`
Expected: no output.

- [ ] **Step 4: Commit**

```bash
git add apps/catalogues-web/src/app/tryon-library-app/LibraryContent.tsx
git commit -m "feat(web): duplicate CatalogueManagerContent as LibraryContent for the mini-app"
```

---

### Task 15: Frontend — the page itself (login form or content) + layout

**Files:**
- Create: `apps/catalogues-web/src/app/tryon-library-app/layout.tsx`
- Create: `apps/catalogues-web/src/app/tryon-library-app/page.tsx`
- Modify: `apps/catalogues-web/src/app/tryon-library-app/LibraryContent.tsx` (created in Task 14 — this task adds a session-expiry effect to it, see Step 2)

- [ ] **Step 1: Layout**

Create `apps/catalogues-web/src/app/tryon-library-app/layout.tsx`:

```tsx
export const metadata = {
  title: 'Try On Library',
  manifest: '/tryon-library-app/manifest.webmanifest',
};

export default function TryonLibraryAppLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
```
This lives outside the `(app)` route group, so it does not inherit `AppShell` (Sidebar) or `ProfileGate` — it only inherits the root `apps/catalogues-web/src/app/layout.tsx` (html/body/providers), same as `/kiosk-upload/[token]` and `/widget-link-complete` already do.

- [ ] **Step 2: Page**

Create `apps/catalogues-web/src/app/tryon-library-app/page.tsx`:

```tsx
'use client';
import { useEffect, useState } from 'react';
import { C } from '@/components/tokens';
import { catalogAppLogin, initCatalogAppToken } from './catalog-app-api';
import { LibraryContent } from './LibraryContent';

type AuthState = 'checking' | 'authed' | 'unauthed';

function LoginForm({ onLoggedIn }: { onLoggedIn: () => void }) {
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError('');
    setSubmitting(true);
    try {
      await catalogAppLogin(identifier, password);
      onLoggedIn();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Login failed');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div
      style={{
        minHeight: '100vh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        background: C.bg,
        padding: 20,
      }}
    >
      <form
        onSubmit={(e) => void handleSubmit(e)}
        style={{
          width: 360,
          maxWidth: '100%',
          background: C.white,
          borderRadius: 14,
          padding: 28,
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
          boxShadow: '0 12px 48px rgba(0,0,0,0.12)',
        }}
      >
        <h1 style={{ fontSize: 20, fontWeight: 700, color: C.text, margin: 0 }}>Try On Library</h1>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label htmlFor="identifier" style={{ fontSize: 13, fontWeight: 600, color: C.text }}>
            Email or Username
          </label>
          <input
            id="identifier"
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            required
            style={{
              height: 44,
              borderRadius: 8,
              border: `1px solid ${C.border}`,
              padding: '0 14px',
              fontSize: 14,
              fontFamily: 'inherit',
            }}
          />
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <label htmlFor="password" style={{ fontSize: 13, fontWeight: 600, color: C.text }}>
            Password
          </label>
          <input
            id="password"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            style={{
              height: 44,
              borderRadius: 8,
              border: `1px solid ${C.border}`,
              padding: '0 14px',
              fontSize: 14,
              fontFamily: 'inherit',
            }}
          />
        </div>
        {error && <p style={{ fontSize: 13, color: C.pink, margin: 0 }}>{error}</p>}
        <button
          type="submit"
          disabled={submitting}
          style={{
            height: 44,
            borderRadius: 8,
            border: 'none',
            background: C.dark,
            color: C.onDark,
            fontFamily: 'inherit',
            fontWeight: 600,
            fontSize: 14,
            cursor: submitting ? 'not-allowed' : 'pointer',
            opacity: submitting ? 0.6 : 1,
          }}
        >
          {submitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}

export default function TryonLibraryAppPage() {
  const [authState, setAuthState] = useState<AuthState>('checking');

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(`${process.env.NEXT_PUBLIC_BASE_PATH ?? ''}/api/catalog-app/refresh`, {
          method: 'POST',
        });
        if (cancelled) return;
        if (res.ok) {
          const data = (await res.json()) as { accessToken?: string };
          if (data.accessToken) {
            initCatalogAppToken(data.accessToken);
            setAuthState('authed');
            return;
          }
        }
        setAuthState('unauthed');
      } catch {
        if (!cancelled) setAuthState('unauthed');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  function handleLoggedOut() {
    setAuthState('unauthed');
  }

  if (authState === 'checking') {
    return <div style={{ minHeight: '100vh', background: C.white }} />;
  }
  if (authState === 'unauthed') {
    return <LoginForm onLoggedIn={() => setAuthState('authed')} />;
  }
  return <LibraryContent onLoggedOut={handleLoggedOut} />;
}
```

TanStack Query doesn't throw query errors into the render tree by default (they land in `query.error` instead), so a session-expiry signal from `catalog-app-api.ts`'s `request()` needs to be picked up from `useQuery`'s own `error` field, not a React error boundary. In `apps/catalogues-web/src/app/tryon-library-app/LibraryContent.tsx` (created in Task 14), right after the `subcategoriesQuery` declaration (the `useQuery` call reading `/v1/merchant/catalog/subcategories`), add:

```tsx
useEffect(() => {
  if (subcategoriesQuery.error instanceof CatalogAppSessionExpiredError) {
    onLoggedOut();
  }
}, [subcategoriesQuery.error, onLoggedOut]);
```
This requires importing `CatalogAppSessionExpiredError` from `./catalog-app-api` and `useEffect` from `react` in `LibraryContent.tsx` (add `useEffect` to its existing `import { useState } from 'react';` line, making it `import { useEffect, useState } from 'react';`).

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @tryme/web exec tsc --noEmit -p .`
Expected: no output.

- [ ] **Step 4: Biome check**

Run: `npx biome check apps/catalogues-web/src/app/tryon-library-app`
Expected: clean (fix anything flagged and re-check).

- [ ] **Step 5: Commit**

```bash
git add apps/catalogues-web/src/app/tryon-library-app/layout.tsx apps/catalogues-web/src/app/tryon-library-app/page.tsx apps/catalogues-web/src/app/tryon-library-app/LibraryContent.tsx
git commit -m "feat(web): add the Try On Library mini-app page (login or content)"
```

---

### Task 16: Frontend — PWA manifest, icons, service worker

**Files:**
- Create: `apps/catalogues-web/src/app/tryon-library-app/manifest.webmanifest/route.ts`
- Create: `apps/catalogues-web/public/tryon-library-app-icon-192.png`
- Create: `apps/catalogues-web/public/tryon-library-app-icon-512.png`
- Create: `apps/catalogues-web/public/tryon-library-app-sw.js`

- [ ] **Step 1: Generate the two icon PNGs**

`sharp` is already a dependency at the workspace root (`package.json`). The existing logo (`apps/catalogues-web/public/assets/logo.svg`) is a wide 175×120 wordmark, not square — resize with `fit: 'contain'` against the app's dark background rather than stretching it.

Run from the repo root:
```bash
node -e "
const sharp = require('sharp');
const src = 'apps/catalogues-web/public/assets/logo.svg';
const bg = { r: 8, g: 12, b: 24, alpha: 1 };
Promise.all([
  sharp(src).resize(192, 192, { fit: 'contain', background: bg }).flatten({ background: bg }).png().toFile('apps/catalogues-web/public/tryon-library-app-icon-192.png'),
  sharp(src).resize(512, 512, { fit: 'contain', background: bg }).flatten({ background: bg }).png().toFile('apps/catalogues-web/public/tryon-library-app-icon-512.png'),
]).then(() => console.log('icons written')).catch((e) => { console.error(e); process.exit(1); });
"
```
Expected: `icons written`, and both files exist under `apps/catalogues-web/public/`.

- [ ] **Step 2: Manifest route**

Next.js App Router serves a dynamic manifest from a `manifest.ts` (or, since the directory name must literally be `manifest.webmanifest` per this plan's `layout.tsx` reference, use a route handler instead for full control over the filename). Create `apps/catalogues-web/src/app/tryon-library-app/manifest.webmanifest/route.ts`:

```ts
import { NextResponse } from 'next/server';

export function GET() {
  const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? '';
  return NextResponse.json({
    name: 'Try On Library',
    short_name: 'Try On',
    start_url: `${BASE}/tryon-library-app`,
    scope: `${BASE}/tryon-library-app`,
    display: 'standalone',
    background_color: '#080C18',
    theme_color: '#080C18',
    icons: [
      { src: `${BASE}/tryon-library-app-icon-192.png`, sizes: '192x192', type: 'image/png' },
      { src: `${BASE}/tryon-library-app-icon-512.png`, sizes: '512x512', type: 'image/png' },
    ],
  });
}
```
This produces a real file at the URL `/tryon-library-app/manifest.webmanifest`, matching what `layout.tsx`'s `metadata.manifest` field already points to.

- [ ] **Step 3: Minimal service worker**

Create `apps/catalogues-web/public/tryon-library-app-sw.js`:
```js
// Minimal service worker — exists only to satisfy Chrome's PWA install-eligibility
// criteria (a registered SW with a fetch handler). No offline caching is done here.
self.addEventListener('fetch', () => {});
```

- [ ] **Step 4: Register the service worker from the page**

In `apps/catalogues-web/src/app/tryon-library-app/page.tsx`, add a registration effect. In the `useEffect` block added in Task 15 (the one that calls `/api/catalog-app/refresh`), add this right before the existing `(async () => { ... })();` call:
```tsx
    if ('serviceWorker' in navigator) {
      const BASE = process.env.NEXT_PUBLIC_BASE_PATH ?? '';
      navigator.serviceWorker.register(`${BASE}/tryon-library-app-sw.js`, { scope: `${BASE}/tryon-library-app` }).catch(() => {});
    }
```

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @tryme/web exec tsc --noEmit -p .`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add apps/catalogues-web/src/app/tryon-library-app/manifest.webmanifest apps/catalogues-web/public/tryon-library-app-icon-192.png apps/catalogues-web/public/tryon-library-app-icon-512.png apps/catalogues-web/public/tryon-library-app-sw.js apps/catalogues-web/src/app/tryon-library-app/page.tsx
git commit -m "feat(web): add PWA manifest, icons, and install-eligibility service worker"
```

---

### Task 17: Final verification

- [ ] **Step 1: Full workspace typecheck**

Run: `pnpm typecheck`
Expected: clean across every package.

- [ ] **Step 2: Run every new backend test together**

Run:
```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts catalog-app-auth merchant-me
```
Expected: all PASS (8 tests).

- [ ] **Step 3: Admin build unaffected**

Run: `pnpm --filter @tryme/admin build`
Expected: builds cleanly (this feature doesn't touch admin-web — this just confirms nothing else broke).

- [ ] **Step 4: Lint**

Run: `pnpm lint`
Expected: exit 0 on every file this plan touched.

- [ ] **Step 5: Manual verification (documented, not automated — no browser automation available)**

Start the dev servers (`pnpm dev`) and manually confirm:
- Visiting `/tryon-library-app` while logged out shows the login form, not a redirect to `/login`.
- Logging in with a merchant account's credentials shows the Try On Library content (categories, subcategories, credits chip, avatar) with no sidebar.
- Logging in with a non-merchant account's credentials shows a clear error, not a blank/broken page.
- In Chrome, an install icon/prompt appears for `/tryon-library-app` (may need `chrome://flags` or DevTools → Application → Manifest to confirm eligibility if no visible prompt appears immediately).
- Opening `/studio` or `/settings` in the same browser tab while only the catalog-app session exists redirects to the normal `/login` (not the Try On Library) and does not show Studio/Settings content.
- Logging into the main site (`/login`) in one tab and `/tryon-library-app` in another tab of the same browser — confirm both sessions remain active simultaneously (separate cookies).
- Logging out of `/tryon-library-app` returns to its own login form and does not affect a simultaneously open main-site session in another tab.

- [ ] **Step 6: Update `docs/progress.md`**

Add a new dated entry: what was built (new `catalog-app` portal, `/tryon-library-app` route, duplicated catalog UI, PWA manifest), what's verified (typecheck, 8 new integration tests, admin build), and explicitly note in "Failed / Not Done": no live browser/Chrome-install verification was performed (state whether one was possible in your environment), and the two corrections found during planning (the new `/v1/merchant/me` route, and duplicating `TopBar`/`UserMenu` instead of the catalog-management components alone) versus what the original spec anticipated.

- [ ] **Step 7: Do not commit or push beyond the per-task commits above**

Per this repo's standing convention (`CLAUDE.md` "Git Commit & Push Policy"), do not `git push` or open a PR unless explicitly asked to in a later message.
