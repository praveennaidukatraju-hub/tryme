# Google sign-in + merchant onboarding Implementation Plan

> Companion plan: [`2026-07-30-kiosk-demo-catalog-data.md`](./2026-07-30-kiosk-demo-catalog-data.md) — independent, can be done before or after this one.

Shared background — what already exists in the Android app and needs no work:

| Need | Existing surface |
|---|---|
| Password device login | `POST /v1/auth/device-login`, `/device-login/force`, `/device-refresh`, `/device-logout` — `apps/api/src/modules/auth/routes.ts:745-912` |
| Catalog read | `GET /v1/merchant/catalog/subcategories?category=`, `GET /v1/merchant/catalog` — `apps/api/src/modules/merchant/catalog.routes.ts:137,436` |
| Try-on | `POST /v1/merchant/tryon/presign` → R2 PUT → `POST /v1/merchant/tryon/jobs` → poll `GET /v1/merchant/tryon/jobs/:id` — `apps/api/src/modules/merchant/tryon.routes.ts` |

The app authenticates as the **merchant user** and hits `requireMerchant` routes
(`apps/api/src/plugins/portal-auth.ts:13`) — a merchant is a user with a `merchants` profile.


> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make Google Sign-In the Android app's signup path — verify a native Google ID token, create or link the user, then require a mandatory onboarding form that creates the merchant profile.

**Architecture:** A new `POST /v1/auth/device-login/google` verifies the Google ID token against Google's JWKS with `jose`, runs the same find-link-create user ladder the existing web OAuth callback uses (extracted into a shared helper so the two cannot drift), then issues a normal device session. The response carries a derived `merchantStatus`; when it is `ONBOARDING_REQUIRED` the app posts a form to a new `POST /v1/merchant/onboarding`, which creates the `merchants` row active-on-submit.

**Tech Stack:** Fastify 5 + `fastify-type-provider-zod`, Drizzle ORM / PostgreSQL 16, `jose` 5 for JWT/JWKS, Vitest, Kotlin + AndroidX Credential Manager on the client.

## Global Constraints

- ESM only. Every relative import inside `apps/api/src` ends in `.js`.
- No `console.log`. Use `app.log` / `@tryme/logger`.
- Zod request schemas only; response shapes are plain objects (routes declare no response schema).
- Google is authentication + signup only. No password is ever set for a Google-only user (`passwordHash: null`).
- `merchants` requires `companyName`, `contactName`, `phone`, `businessAddress` — all NOT NULL, no defaults.
- `platform` sent at login must equal the `platform` sent on refresh or `rotateTokenFamily` returns `INVALID_REFRESH`.
- Device cap is enforced for `platform:'kiosk'` and waived for `'mobile'` — Google login must match that exactly.
- Integration tests need `pnpm docker:up` running. No testcontainers.
- Never run migrations against production. Local/staging only, then ship through CI/CD.
- Do not touch `apps/admin-mobile` (paused per CLAUDE.md).

## Flagged risk (proceeding as instructed)

Merchant try-ons cost 0 credits (`apps/api/src/modules/merchant/create-tryon-job.ts:13`). With
self-serve Google signup active-on-submit, anyone with a Google account can create a merchant,
upload one product via the `tryon-library-app` PWA, and run unbounded free GPU try-ons. Not fixed
here per the activation decision. Task 5 adds `merchants.signup_source` and Task 6 surfaces it in
admin so these accounts are at least findable. Next step to schedule: a per-merchant daily try-on
cap for accounts never touched by an admin.

## File Structure

**Create**
- `apps/api/src/modules/auth/google-id-token.ts` — ID token verification + accepted-audience parsing. No DB, no Fastify.
- `apps/api/src/modules/auth/google-upsert.ts` — the find-link-create user ladder + free-credit lookup. Shared by the web callback and the device route.
- `apps/api/src/modules/merchant/status.ts` — `resolveMerchantStatus`. One tiny query, imported by auth and onboarding.
- `apps/api/src/modules/merchant/onboarding.routes.ts` — `GET`/`POST /v1/merchant/onboarding`.
- `packages/db/src/migrations/0133_merchant_signup_source.sql`
- Tests: `apps/api/test/google-id-token.test.ts`, `google-upsert.test.ts`, `device-merchant-status.test.ts`, `device-google-login.test.ts`, `merchant-onboarding.test.ts`

**Modify**
- `apps/api/src/env.ts` — add `GOOGLE_DEVICE_AUDIENCES`
- `apps/api/src/modules/auth/google.routes.ts` — call the extracted helper
- `apps/api/src/modules/auth/routes.ts` — new Google device route; `merchantStatus` on the two existing device-login responses
- `apps/api/src/modules/admin/merchants.routes.ts` — return `signupSource`
- `packages/db/src/schema/merchant.ts` — `signupSource` column
- `packages/types/src/widget.ts` — `MerchantOnboardingBody`, `MerchantStatus`
- `apps/api/src/server.ts` — register `merchantOnboardingRoutes`
- `apps/admin-web/src/pages/UsersPage.tsx` (merchants section) — signup-source badge
- Android: `gradle/libs.versions.toml`, `app/build.gradle.kts`, `ApiUtils/APIConstant.kt`, `viewmodel/category/SareeCategoryDataRepository.kt`, `activity/auth/LoginActivity.kt`, new `activity/auth/OnboardingActivity.kt` + layout

---

### Task 1: Google ID token verifier

**Files:**
- Create: `apps/api/src/modules/auth/google-id-token.ts`
- Modify: `apps/api/src/env.ts:36-38`
- Test: `apps/api/test/google-id-token.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface GoogleIdentity { sub: string; email: string; name?: string; picture?: string }`
  - `parseAcceptedAudiences(clientId?: string, extra?: string): string[]`
  - `verifyGoogleIdToken(idToken: string, audiences: string[], getKey?: JWTVerifyGetKey): Promise<GoogleIdentity>`
  - `setGoogleKeyGetterForTests(getKey: JWTVerifyGetKey | undefined): void`

- [x] **Step 1: Write the failing test**

Create `apps/api/test/google-id-token.test.ts`. This is a pure unit test — no containers, no
network. It signs real RS256 tokens with a locally generated key pair and verifies them against a
local JWKS, so issuer/audience/expiry logic is exercised for real.

```ts
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  type GoogleIdentity,
  parseAcceptedAudiences,
  verifyGoogleIdToken,
} from '../src/modules/auth/google-id-token.js';

const AUD = 'test-web-client-id.apps.googleusercontent.com';
let privateKey: CryptoKey;
let getKey: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  const jwk = await exportJWK(pair.publicKey);
  jwk.kid = 'test-kid';
  jwk.alg = 'RS256';
  getKey = createLocalJWKSet({ keys: [jwk] });
});

async function sign(claims: Record<string, unknown>, opts: { aud?: string; iss?: string; exp?: string } = {}) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'test-kid' })
    .setIssuer(opts.iss ?? 'https://accounts.google.com')
    .setAudience(opts.aud ?? AUD)
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? '5m')
    .sign(privateKey);
}

describe('parseAcceptedAudiences', () => {
  it('merges the client id with the comma-separated extras and de-dupes', () => {
    expect(parseAcceptedAudiences('a', 'b, c ,a')).toEqual(['a', 'b', 'c']);
  });

  it('returns an empty list when nothing is configured', () => {
    expect(parseAcceptedAudiences(undefined, undefined)).toEqual([]);
  });
});

describe('verifyGoogleIdToken', () => {
  it('returns the identity for a valid token', async () => {
    const token = await sign({
      sub: '1234567890',
      email: 'Person@Example.com',
      email_verified: true,
      name: 'A Person',
      picture: 'https://example.com/p.jpg',
    });
    const identity: GoogleIdentity = await verifyGoogleIdToken(token, [AUD], getKey);
    expect(identity).toEqual({
      sub: '1234567890',
      email: 'person@example.com',
      name: 'A Person',
      picture: 'https://example.com/p.jpg',
    });
  });

  it('rejects a token minted for a different audience', async () => {
    const token = await sign({ sub: 's', email: 'a@b.com', email_verified: true }, { aud: 'other' });
    await expect(verifyGoogleIdToken(token, [AUD], getKey)).rejects.toMatchObject({
      code: 'INVALID_GOOGLE_TOKEN',
      statusCode: 401,
    });
  });

  it('rejects a token from a non-Google issuer', async () => {
    const token = await sign({ sub: 's', email: 'a@b.com', email_verified: true }, { iss: 'https://evil.test' });
    await expect(verifyGoogleIdToken(token, [AUD], getKey)).rejects.toMatchObject({
      code: 'INVALID_GOOGLE_TOKEN',
    });
  });

  it('rejects an expired token', async () => {
    const token = await sign({ sub: 's', email: 'a@b.com', email_verified: true }, { exp: '-1m' });
    await expect(verifyGoogleIdToken(token, [AUD], getKey)).rejects.toMatchObject({
      code: 'INVALID_GOOGLE_TOKEN',
    });
  });

  it('rejects an unverified Google email', async () => {
    const token = await sign({ sub: 's', email: 'a@b.com', email_verified: false });
    await expect(verifyGoogleIdToken(token, [AUD], getKey)).rejects.toMatchObject({
      code: 'GOOGLE_EMAIL_UNVERIFIED',
      statusCode: 401,
    });
  });

  it('rejects a token with no email claim', async () => {
    const token = await sign({ sub: 's', email_verified: true });
    await expect(verifyGoogleIdToken(token, [AUD], getKey)).rejects.toMatchObject({
      code: 'INVALID_GOOGLE_TOKEN',
    });
  });

  it('rejects when no audience is configured at all', async () => {
    const token = await sign({ sub: 's', email: 'a@b.com', email_verified: true });
    await expect(verifyGoogleIdToken(token, [], getKey)).rejects.toMatchObject({
      code: 'GOOGLE_NOT_CONFIGURED',
      statusCode: 503,
    });
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- google-id-token`
Expected: FAIL — `Failed to resolve import "../src/modules/auth/google-id-token.js"`.

- [x] **Step 3: Write the implementation**

Create `apps/api/src/modules/auth/google-id-token.ts`:

```ts
import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from 'jose';
import { AppError } from '../../lib/errors.js';

export interface GoogleIdentity {
  sub: string;
  email: string;
  name?: string;
  picture?: string;
}

// Google publishes both spellings in the `iss` claim depending on the flow.
const GOOGLE_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];
const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

// Module-level so the key set is fetched once per process and cached by jose.
// Building it per request would refetch Google's certs on every single login.
let remoteJwks: JWTVerifyGetKey | undefined;
let keyGetterOverride: JWTVerifyGetKey | undefined;

function googleJwks(): JWTVerifyGetKey {
  if (!remoteJwks) remoteJwks = createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));
  return remoteJwks;
}

/**
 * Test seam: lets the suite verify against a locally generated JWKS instead of
 * Google's, so the real issuer/audience/expiry checks still run for real.
 */
export function setGoogleKeyGetterForTests(getKey: JWTVerifyGetKey | undefined): void {
  keyGetterOverride = getKey;
}

/**
 * Accepted `aud` values. With Android Credential Manager configured with
 * serverClientId = the Web client ID, the ID token's aud IS that web client ID,
 * so GOOGLE_CLIENT_ID alone is normally enough. GOOGLE_DEVICE_AUDIENCES exists so
 * a separately-issued Android client ID can be accepted without a code change.
 */
export function parseAcceptedAudiences(clientId?: string, extra?: string): string[] {
  const candidates = [clientId, ...(extra ?? '').split(',')]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  return [...new Set(candidates)];
}

export async function verifyGoogleIdToken(
  idToken: string,
  audiences: string[],
  getKey?: JWTVerifyGetKey,
): Promise<GoogleIdentity> {
  if (audiences.length === 0) {
    throw new AppError('GOOGLE_NOT_CONFIGURED', 503, 'google sign-in is not configured');
  }

  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(idToken, getKey ?? keyGetterOverride ?? googleJwks(), {
      issuer: GOOGLE_ISSUERS,
      audience: audiences,
      algorithms: ['RS256'],
    }));
  } catch {
    throw new AppError('INVALID_GOOGLE_TOKEN', 401, 'google id token is invalid or expired');
  }

  const sub = typeof payload.sub === 'string' ? payload.sub : '';
  const email = typeof payload.email === 'string' ? payload.email : '';
  if (!sub || !email) {
    throw new AppError('INVALID_GOOGLE_TOKEN', 401, 'google id token is missing sub or email');
  }
  // Google sets email_verified as a boolean, but some legacy responses stringify it.
  if (payload.email_verified !== true && payload.email_verified !== 'true') {
    throw new AppError('GOOGLE_EMAIL_UNVERIFIED', 401, 'google email is not verified');
  }

  return {
    sub,
    email: email.toLowerCase(),
    name: typeof payload.name === 'string' ? payload.name : undefined,
    picture: typeof payload.picture === 'string' ? payload.picture : undefined,
  };
}
```

- [x] **Step 4: Add the env var**

In `apps/api/src/env.ts`, directly after `GOOGLE_CALLBACK_URL` (line 38):

```ts
  // Extra accepted `aud` values for POST /v1/auth/device-login/google, comma-separated.
  // Normally unset: the Android ID token's aud is GOOGLE_CLIENT_ID (the Web client ID
  // passed to Credential Manager as serverClientId).
  GOOGLE_DEVICE_AUDIENCES: z.string().optional(),
```

- [x] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @tryme/api test -- google-id-token`
Expected: PASS, 9 tests.

- [x] **Step 6: Commit**

```bash
git add apps/api/src/modules/auth/google-id-token.ts apps/api/src/env.ts apps/api/test/google-id-token.test.ts
git commit -m "feat(auth): verify native Google ID tokens against Google JWKS"
```

---

### Task 2: Extract the shared Google user upsert

**Files:**
- Create: `apps/api/src/modules/auth/google-upsert.ts`
- Modify: `apps/api/src/modules/auth/google.routes.ts:107-216`
- Test: `apps/api/test/google-upsert.test.ts`

**Interfaces:**
- Consumes: `GoogleIdentity` from Task 1.
- Produces:
  - `type DbOrTx`
  - `resolveFreeCredits(app: FastifyInstance): Promise<number>`
  - `upsertGoogleUser(tx: DbOrTx, googleUser: GoogleIdentity, freeCredits: number): Promise<string>` — returns `users.id`

- [x] **Step 1: Write the failing test**

Create `apps/api/test/google-upsert.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveFreeCredits, upsertGoogleUser } from '../src/modules/auth/google-upsert.js';
import { buildTestApp, type TestApp } from './helpers/api.js';
import { type Containers, startContainers } from './helpers/containers.js';

let c: Containers;
let app: TestApp;

beforeAll(async () => {
  c = await startContainers();
  app = await buildTestApp(c);
});

afterAll(async () => {
  await app?.close();
  await c?.stop();
});

function identity(over: Partial<{ sub: string; email: string; name: string }> = {}) {
  return {
    sub: over.sub ?? randomUUID(),
    email: over.email ?? `g-${randomUUID()}@example.com`,
    name: over.name ?? 'Google Person',
    picture: 'https://example.com/p.jpg',
  };
}

describe('upsertGoogleUser', () => {
  it('creates a passwordless verified user with a credits row', async () => {
    const g = identity();
    const userId = await app.db.transaction((tx) => upsertGoogleUser(tx, g, 0));

    const [user] = await app.db.select().from(schema.users).where(eq(schema.users.id, userId));
    expect(user?.email).toBe(g.email);
    expect(user?.passwordHash).toBeNull();
    expect(user?.emailVerified).toBe(true);

    const [credits] = await app.db
      .select()
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, userId));
    expect(credits?.balance).toBe(0);
  });

  it('grants the free plan credits and writes a FREE_TRIAL ledger row', async () => {
    const userId = await app.db.transaction((tx) => upsertGoogleUser(tx, identity(), 25));
    const [credits] = await app.db
      .select()
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, userId));
    expect(credits?.balance).toBe(25);

    const ledger = await app.db
      .select()
      .from(schema.creditLedger)
      .where(eq(schema.creditLedger.userId, userId));
    expect(ledger).toHaveLength(1);
    expect(ledger[0]?.reason).toBe('FREE_TRIAL');
  });

  it('returns the same user for a repeat login with the same provider id', async () => {
    const g = identity();
    const first = await app.db.transaction((tx) => upsertGoogleUser(tx, g, 0));
    const second = await app.db.transaction((tx) => upsertGoogleUser(tx, g, 0));
    expect(second).toBe(first);

    const links = await app.db
      .select()
      .from(schema.oauthAccounts)
      .where(eq(schema.oauthAccounts.userId, first));
    expect(links).toHaveLength(1);
  });

  it('links Google onto an existing password account with the same email', async () => {
    const email = `existing-${randomUUID()}@example.com`;
    const [existing] = await app.db
      .insert(schema.users)
      .values({ email, displayName: 'Password User', passwordHash: 'x', emailVerified: false })
      .returning();

    const userId = await app.db.transaction((tx) =>
      upsertGoogleUser(tx, identity({ email }), 0),
    );

    expect(userId).toBe(existing?.id);
    const [after] = await app.db.select().from(schema.users).where(eq(schema.users.id, userId));
    // Google confirmed ownership of the address, so the account becomes verified.
    expect(after?.emailVerified).toBe(true);
    expect(after?.passwordHash).toBe('x');
  });

  it('rejects a banned account', async () => {
    const email = `banned-${randomUUID()}@example.com`;
    await app.db
      .insert(schema.users)
      .values({ email, displayName: 'Banned', emailVerified: true, isBanned: true });

    await expect(
      app.db.transaction((tx) => upsertGoogleUser(tx, identity({ email }), 0)),
    ).rejects.toMatchObject({ code: 'BANNED', statusCode: 403 });
  });
});

describe('resolveFreeCredits', () => {
  it('returns 0 when no active free plan exists', async () => {
    await expect(resolveFreeCredits(app)).resolves.toBe(0);
  });

  it('returns the active free plan credits', async () => {
    await app.db.insert(schema.creditPlans).values({
      slug: 'free',
      name: 'Free',
      credits: 40,
      pricePaise: 0,
      isActive: true,
    });
    await expect(resolveFreeCredits(app)).resolves.toBe(40);
  });
});
```

Before running: open `packages/db/src/schema/credits.ts` and confirm the `creditPlans` NOT NULL
columns. If `pricePaise`/`name` are named differently or more columns are required, fix the insert
in the last test to match — the schema is the authority, not this snippet.

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- google-upsert`
Expected: FAIL — cannot resolve `../src/modules/auth/google-upsert.js`.

- [x] **Step 3: Write the implementation**

Create `apps/api/src/modules/auth/google-upsert.ts`. The body is the ladder currently inlined at
`google.routes.ts:107-216`, moved verbatim — same order, same `onConflictDoNothing` + re-select
concurrency guard, same `BANNED` throw:

```ts
import { schema } from '@tryme/db';
import { and, eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { AppError } from '../../lib/errors.js';
import type { GoogleIdentity } from './google-id-token.js';

type Db = FastifyInstance['db'];
export type DbOrTx = Db | Parameters<Parameters<Db['transaction']>[0]>[0];

/** Credits granted to a brand-new account, from the active `free` credit plan. */
export async function resolveFreeCredits(app: FastifyInstance): Promise<number> {
  const [plan] = await app.db
    .select({ credits: schema.creditPlans.credits })
    .from(schema.creditPlans)
    .where(and(eq(schema.creditPlans.slug, 'free'), eq(schema.creditPlans.isActive, true)));
  return plan?.credits ?? 0;
}

/**
 * Find-link-create ladder for a verified Google identity. Shared by the browser
 * OAuth callback (/v1/auth/google/callback) and the native device route
 * (/v1/auth/device-login/google) so the two can never drift apart.
 *
 * Must be called inside a transaction — it writes across users, user_credits,
 * credit_ledger and oauth_accounts.
 */
export async function upsertGoogleUser(
  tx: DbOrTx,
  googleUser: GoogleIdentity,
  freeCredits: number,
): Promise<string> {
  // 1. Existing OAuth link wins outright.
  const [existingLink] = await tx
    .select({ userId: schema.oauthAccounts.userId })
    .from(schema.oauthAccounts)
    .where(
      and(
        eq(schema.oauthAccounts.provider, 'google'),
        eq(schema.oauthAccounts.providerId, googleUser.sub),
      ),
    );

  if (existingLink) {
    await tx
      .update(schema.oauthAccounts)
      .set({ displayName: googleUser.name, avatarUrl: googleUser.picture })
      .where(
        and(
          eq(schema.oauthAccounts.provider, 'google'),
          eq(schema.oauthAccounts.providerId, googleUser.sub),
        ),
      );
    const [user] = await tx
      .select({ isBanned: schema.users.isBanned })
      .from(schema.users)
      .where(eq(schema.users.id, existingLink.userId));
    if (user?.isBanned) throw new AppError('BANNED', 403, 'account banned');
    // Ensure emailVerified on every Google login (handles pre-existing unverified accounts).
    await tx
      .update(schema.users)
      .set({ emailVerified: true })
      .where(eq(schema.users.id, existingLink.userId));
    return existingLink.userId;
  }

  // 2. Same email — link Google onto the existing account.
  let uid: string;
  const [byEmail] = await tx
    .select({ id: schema.users.id, isBanned: schema.users.isBanned })
    .from(schema.users)
    .where(eq(schema.users.email, googleUser.email));

  if (byEmail) {
    if (byEmail.isBanned) throw new AppError('BANNED', 403, 'account banned');
    uid = byEmail.id;
    // Google confirmed ownership of the address.
    await tx.update(schema.users).set({ emailVerified: true }).where(eq(schema.users.id, uid));
  } else {
    // 3. Brand-new account — Google accounts are pre-verified and passwordless.
    const [newUser] = await tx
      .insert(schema.users)
      .values({
        email: googleUser.email,
        passwordHash: null,
        displayName: googleUser.name ?? null,
        companyName: null,
        emailVerified: true,
        tier: 'free',
      })
      .returning({ id: schema.users.id });
    if (!newUser) throw new AppError('INTERNAL', 500, 'failed to create user');
    uid = newUser.id;
    await tx.insert(schema.userCredits).values({ userId: uid, balance: 0 });
    if (freeCredits > 0) {
      await tx
        .update(schema.userCredits)
        .set({
          balance: sql`${schema.userCredits.balance} + ${freeCredits}`,
          updatedAt: new Date(),
        })
        .where(eq(schema.userCredits.userId, uid));
      await tx
        .insert(schema.creditLedger)
        .values({ userId: uid, delta: freeCredits, reason: 'FREE_TRIAL' });
    }
  }

  // 4. Create the OAuth link. onConflictDoNothing + re-select handles the race
  // where a concurrent request already inserted the same (provider, providerId).
  await tx
    .insert(schema.oauthAccounts)
    .values({
      userId: uid,
      provider: 'google',
      providerId: googleUser.sub,
      email: googleUser.email,
      displayName: googleUser.name ?? null,
      avatarUrl: googleUser.picture ?? null,
    })
    .onConflictDoNothing();

  const [linked] = await tx
    .select({ userId: schema.oauthAccounts.userId })
    .from(schema.oauthAccounts)
    .where(
      and(
        eq(schema.oauthAccounts.provider, 'google'),
        eq(schema.oauthAccounts.providerId, googleUser.sub),
      ),
    );
  if (!linked) throw new AppError('INTERNAL', 500, 'failed to link google account');
  return linked.userId;
}
```

- [x] **Step 4: Rewrite the web callback to use it**

In `apps/api/src/modules/auth/google.routes.ts`, replace lines 107-216 (the `freePlan` lookup and
the whole `app.db.transaction` block) with:

```ts
    const freeCredits = await resolveFreeCredits(app);
    const userId = await app.db.transaction((tx) =>
      upsertGoogleUser(
        tx,
        {
          sub: googleUser.sub,
          email: googleUser.email.toLowerCase(),
          name: googleUser.name,
          picture: googleUser.picture,
        },
        freeCredits,
      ),
    );
```

Add `import { resolveFreeCredits, upsertGoogleUser } from './google-upsert.js';` and drop any
now-unused imports (`sql`, and `and`/`eq` only if nothing else in the file uses them — check before
deleting).

- [x] **Step 5: Run the tests**

Run: `pnpm --filter @tryme/api test -- google-upsert`
Expected: PASS, 7 tests.

Run: `pnpm --filter @tryme/api test`
Expected: the whole suite still green — the web callback behaviour is unchanged.

- [x] **Step 6: Commit**

```bash
git add apps/api/src/modules/auth/google-upsert.ts apps/api/src/modules/auth/google.routes.ts apps/api/test/google-upsert.test.ts
git commit -m "refactor(auth): share the Google user upsert between web and device flows"
```

---

### Task 3: `merchantStatus` on the existing device-login responses

**Files:**
- Create: `apps/api/src/modules/merchant/status.ts`
- Modify: `apps/api/src/modules/auth/routes.ts:792-799` and `:852-858`
- Test: `apps/api/test/device-merchant-status.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type MerchantStatus = 'ONBOARDING_REQUIRED' | 'PENDING_ACTIVATION' | 'ACTIVE'`
  - `resolveMerchantStatus(app: FastifyInstance, userId: string): Promise<MerchantStatus>`

- [x] **Step 1: Write the failing test**

Create `apps/api/test/device-merchant-status.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../src/modules/auth/service.js';
import { buildTestApp, type TestApp } from './helpers/api.js';
import { type Containers, startContainers } from './helpers/containers.js';
import { createTestMerchant } from './helpers/merchant.js';

let c: Containers;
let app: TestApp;

beforeAll(async () => {
  c = await startContainers();
  app = await buildTestApp(c);
});

afterAll(async () => {
  await app?.close();
  await c?.stop();
});

const PASSWORD = 'Passw0rdTest';

async function createPasswordUser() {
  const email = `dev-${randomUUID()}@example.com`;
  const [user] = await app.db
    .insert(schema.users)
    .values({
      email,
      displayName: 'Device User',
      passwordHash: await hashPassword(PASSWORD),
      emailVerified: true,
    })
    .returning();
  if (!user) throw new Error('failed to create user');
  return { email, userId: user.id };
}

async function login(email: string) {
  return app.inject({
    method: 'POST',
    url: '/v1/auth/device-login',
    payload: { email, password: PASSWORD, deviceId: randomUUID(), platform: 'mobile' },
  });
}

describe('device-login merchantStatus', () => {
  it('reports ONBOARDING_REQUIRED for a user with no merchant profile', async () => {
    const { email } = await createPasswordUser();
    const res = await login(email);
    expect(res.statusCode).toBe(200);
    expect(res.json().merchantStatus).toBe('ONBOARDING_REQUIRED');
  });

  it('reports ACTIVE for an active merchant', async () => {
    const merchant = await createTestMerchant(app, { isActive: true });
    const email = `active-${randomUUID()}@example.com`;
    await app.db
      .update(schema.users)
      .set({ email, passwordHash: await hashPassword(PASSWORD) })
      .where(eq(schema.users.id, merchant.userId));

    const res = await login(email);
    expect(res.statusCode).toBe(200);
    expect(res.json().merchantStatus).toBe('ACTIVE');
  });

  it('reports PENDING_ACTIVATION for an inactive merchant', async () => {
    const merchant = await createTestMerchant(app, { isActive: false });
    const email = `pending-${randomUUID()}@example.com`;
    await app.db
      .update(schema.users)
      .set({ email, passwordHash: await hashPassword(PASSWORD) })
      .where(eq(schema.users.id, merchant.userId));

    const res = await login(email);
    expect(res.statusCode).toBe(200);
    expect(res.json().merchantStatus).toBe('PENDING_ACTIVATION');
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- device-merchant-status`
Expected: FAIL — `expected undefined to be 'ONBOARDING_REQUIRED'`.

- [x] **Step 3: Write the implementation**

Create `apps/api/src/modules/merchant/status.ts`:

```ts
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

/**
 * Derived, never stored. The Android app branches on this at login:
 * ONBOARDING_REQUIRED -> show the onboarding form (no merchants row yet),
 * PENDING_ACTIVATION  -> show a blocking "awaiting activation" screen,
 * ACTIVE              -> proceed to Home.
 * Without it a user with no merchant profile logs in fine and then 403s on
 * every single requireMerchant call with no way to explain why.
 */
export type MerchantStatus = 'ONBOARDING_REQUIRED' | 'PENDING_ACTIVATION' | 'ACTIVE';

export async function resolveMerchantStatus(
  app: FastifyInstance,
  userId: string,
): Promise<MerchantStatus> {
  const [row] = await app.db
    .select({ isActive: schema.merchants.isActive })
    .from(schema.merchants)
    .where(eq(schema.merchants.userId, userId))
    .limit(1);
  if (!row) return 'ONBOARDING_REQUIRED';
  return row.isActive ? 'ACTIVE' : 'PENDING_ACTIVATION';
}
```

- [x] **Step 4: Wire it into both existing device-login responses**

In `apps/api/src/modules/auth/routes.ts`, add
`import { resolveMerchantStatus } from '../merchant/status.js';`

Replace the tail of `/v1/auth/device-login` (lines 792-799) with:

```ts
      const tokens = await issueDeviceSession(app, {
        userId: user.id,
        deviceId,
        deviceName,
        platform,
      });
      const [logoUrl, merchantStatus] = await Promise.all([
        resolveMerchantLogoUrl(app, user.id),
        resolveMerchantStatus(app, user.id),
      ]);
      return { ...tokens, user: deviceLoginUserPayload(user), logoUrl, merchantStatus };
```

Replace the tail of `/v1/auth/device-login/force` (lines 852-858) with:

```ts
      const tokens = await issueDeviceSession(app, {
        userId: user.id,
        deviceId,
        deviceName: deviceName ?? claim.deviceName,
        platform,
      });
      const merchantStatus = await resolveMerchantStatus(app, user.id);
      return { ...tokens, user: deviceLoginUserPayload(user), merchantStatus };
```

- [x] **Step 5: Run the tests**

Run: `pnpm --filter @tryme/api test -- device-merchant-status`
Expected: PASS, 3 tests.

- [x] **Step 6: Commit**

```bash
git add apps/api/src/modules/merchant/status.ts apps/api/src/modules/auth/routes.ts apps/api/test/device-merchant-status.test.ts
git commit -m "feat(auth): return merchantStatus from device login"
```

---

### Task 4: `POST /v1/auth/device-login/google`

**Files:**
- Modify: `apps/api/src/modules/auth/routes.ts` (add body schema near line 37; add the route after `/v1/auth/device-login/force`, line 860)
- Test: `apps/api/test/device-google-login.test.ts`

**Interfaces:**
- Consumes: `verifyGoogleIdToken`, `parseAcceptedAudiences`, `setGoogleKeyGetterForTests` (Task 1); `resolveFreeCredits`, `upsertGoogleUser` (Task 2); `resolveMerchantStatus` (Task 3); existing `activeDeviceSessions`, `createForceLogoutToken`, `issueDeviceSession`, `publicDeviceSession`, `deviceLoginUserPayload`, `resolveMerchantLogoUrl` (all local to `routes.ts`).
- Produces: `POST /v1/auth/device-login/google` returning `{ accessToken, refreshToken, user, logoUrl, merchantStatus, onboarding? }`.

- [x] **Step 1: Write the failing test**

Create `apps/api/test/device-google-login.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setGoogleKeyGetterForTests } from '../src/modules/auth/google-id-token.js';
import { buildTestApp, type TestApp } from './helpers/api.js';
import { type Containers, startContainers } from './helpers/containers.js';
import { createTestMerchant } from './helpers/merchant.js';

const AUD = 'web-client.apps.googleusercontent.com';
let c: Containers;
let app: TestApp;
let privateKey: CryptoKey;

beforeAll(async () => {
  c = await startContainers();
  app = await buildTestApp(c, { GOOGLE_CLIENT_ID: AUD });

  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  const jwk = await exportJWK(pair.publicKey);
  jwk.kid = 'test-kid';
  jwk.alg = 'RS256';
  setGoogleKeyGetterForTests(createLocalJWKSet({ keys: [jwk] }));
});

afterAll(async () => {
  setGoogleKeyGetterForTests(undefined);
  await app?.close();
  await c?.stop();
});

async function idToken(over: Partial<{ sub: string; email: string; name: string }> = {}, aud = AUD) {
  return new SignJWT({
    sub: over.sub ?? randomUUID(),
    email: over.email ?? `g-${randomUUID()}@example.com`,
    email_verified: true,
    name: over.name ?? 'Google Person',
  })
    .setProtectedHeader({ alg: 'RS256', kid: 'test-kid' })
    .setIssuer('https://accounts.google.com')
    .setAudience(aud)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
}

function post(payload: Record<string, unknown>) {
  return app.inject({ method: 'POST', url: '/v1/auth/device-login/google', payload });
}

describe('POST /v1/auth/device-login/google', () => {
  it('creates the account and asks for onboarding', async () => {
    const email = `new-${randomUUID()}@example.com`;
    const res = await post({
      idToken: await idToken({ email, name: 'New Person' }),
      deviceId: randomUUID(),
      platform: 'mobile',
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.accessToken).toBeTruthy();
    expect(body.refreshToken).toBeTruthy();
    expect(body.user.email).toBe(email);
    expect(body.merchantStatus).toBe('ONBOARDING_REQUIRED');
    expect(body.onboarding.suggestedContactName).toBe('New Person');

    const merchants = await app.db
      .select()
      .from(schema.merchants)
      .where(eq(schema.merchants.userId, body.user.id));
    expect(merchants).toHaveLength(0);
  });

  it('links onto an existing merchant account by email and reports ACTIVE', async () => {
    const merchant = await createTestMerchant(app, { isActive: true });
    const email = `linked-${randomUUID()}@example.com`;
    await app.db.update(schema.users).set({ email }).where(eq(schema.users.id, merchant.userId));

    const res = await post({
      idToken: await idToken({ email }),
      deviceId: randomUUID(),
      platform: 'mobile',
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().user.id).toBe(merchant.userId);
    expect(res.json().merchantStatus).toBe('ACTIVE');
    expect(res.json().onboarding).toBeUndefined();
  });

  it('returns the same user on a repeat login with the same google sub', async () => {
    const sub = randomUUID();
    const email = `repeat-${randomUUID()}@example.com`;
    const first = await post({ idToken: await idToken({ sub, email }), deviceId: randomUUID(), platform: 'mobile' });
    const second = await post({ idToken: await idToken({ sub, email }), deviceId: randomUUID(), platform: 'mobile' });
    expect(second.json().user.id).toBe(first.json().user.id);
  });

  it('rejects a banned account', async () => {
    const email = `banned-${randomUUID()}@example.com`;
    await app.db
      .insert(schema.users)
      .values({ email, displayName: 'B', emailVerified: true, isBanned: true });

    const res = await post({ idToken: await idToken({ email }), deviceId: randomUUID(), platform: 'mobile' });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('BANNED');
  });

  it('rejects a token minted for another audience', async () => {
    const res = await post({
      idToken: await idToken({}, 'someone-else'),
      deviceId: randomUUID(),
      platform: 'mobile',
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('INVALID_GOOGLE_TOKEN');
  });

  it('enforces the device cap on kiosk and hands back a usable forceLogoutToken', async () => {
    const email = `kiosk-${randomUUID()}@example.com`;
    const sub = randomUUID();
    const first = await post({
      idToken: await idToken({ sub, email }),
      deviceId: 'device-a',
      platform: 'kiosk',
    });
    expect(first.statusCode).toBe(200);

    const second = await post({
      idToken: await idToken({ sub, email }),
      deviceId: 'device-b',
      platform: 'kiosk',
    });
    expect(second.statusCode).toBe(409);
    const { code, forceLogoutToken } = second.json().error;
    expect(code).toBe('DEVICE_LIMIT_REACHED');

    const forced = await app.inject({
      method: 'POST',
      url: '/v1/auth/device-login/force',
      payload: { forceLogoutToken, deviceId: 'device-b', platform: 'kiosk' },
    });
    expect(forced.statusCode).toBe(200);
    expect(forced.json().accessToken).toBeTruthy();
  });

  it('does not enforce the cap on mobile', async () => {
    const email = `mob-${randomUUID()}@example.com`;
    const sub = randomUUID();
    await post({ idToken: await idToken({ sub, email }), deviceId: 'm-a', platform: 'mobile' });
    const second = await post({
      idToken: await idToken({ sub, email }),
      deviceId: 'm-b',
      platform: 'mobile',
    });
    expect(second.statusCode).toBe(200);
  });

  it('issues a refresh token that works against device-refresh with the same platform', async () => {
    const res = await post({ idToken: await idToken(), deviceId: randomUUID(), platform: 'kiosk' });
    const refreshed = await app.inject({
      method: 'POST',
      url: '/v1/auth/device-refresh',
      payload: { refreshToken: res.json().refreshToken, platform: 'kiosk' },
    });
    expect(refreshed.statusCode).toBe(200);
    expect(refreshed.json().accessToken).toBeTruthy();
  });
});

describe('POST /v1/auth/device-login/google without GOOGLE_CLIENT_ID', () => {
  it('returns 503', async () => {
    const bare = await buildTestApp(c, { GOOGLE_CLIENT_ID: undefined });
    try {
      const res = await bare.inject({
        method: 'POST',
        url: '/v1/auth/device-login/google',
        payload: { idToken: 'x', deviceId: randomUUID(), platform: 'mobile' },
      });
      expect(res.statusCode).toBe(503);
      expect(res.json().error.code).toBe('GOOGLE_NOT_CONFIGURED');
    } finally {
      await bare.close();
    }
  });
});
```

Rate limiting: the route uses `max: 10, timeWindow: '1 minute'` and this file makes more than 10
calls. Check how the existing suite handles that for `/v1/auth/device-login` (which is `max: 5`) —
if the test env disables `@fastify/rate-limit`, nothing more is needed; if not, mirror whatever
opt-out those tests use.

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- device-google-login`
Expected: FAIL — 404 on `/v1/auth/device-login/google`.

- [x] **Step 3: Add the body schema**

In `apps/api/src/modules/auth/routes.ts`, after `DeviceLogoutBody` (line 37):

```ts
const DeviceGoogleLoginBody = z.object({
  // The `id_token` from Android Credential Manager's GetGoogleIdOption, NOT an
  // OAuth access token — this route verifies it against Google's JWKS itself.
  idToken: z.string().min(1).max(4096),
  deviceId: z.string().min(1).max(200),
  deviceName: z.string().max(120).optional(),
  platform: z.enum(['mobile', 'kiosk']).default('mobile'),
});
```

- [x] **Step 4: Add the route**

Insert after `/v1/auth/device-login/force` closes (line 860). Add the imports:

```ts
import {
  parseAcceptedAudiences,
  verifyGoogleIdToken,
} from './google-id-token.js';
import { resolveFreeCredits, upsertGoogleUser } from './google-upsert.js';
```

```ts
  // Native Google sign-in for the Android app. The browser flow in google.routes.ts
  // cannot serve this: it is a 302 redirect chain that ends in cookies on the web
  // origin. Here the client already holds a verified ID token, so there is no
  // code exchange and no state cookie — just verify, upsert, issue a device session.
  app.post(
    '/v1/auth/device-login/google',
    {
      schema: { body: DeviceGoogleLoginBody },
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const audiences = parseAcceptedAudiences(
        app.env.GOOGLE_CLIENT_ID,
        app.env.GOOGLE_DEVICE_AUDIENCES,
      );
      const { idToken, deviceId, deviceName, platform } = req.body as z.infer<
        typeof DeviceGoogleLoginBody
      >;
      const identity = await verifyGoogleIdToken(idToken, audiences);

      const freeCredits = await resolveFreeCredits(app);
      const userId = await app.db.transaction((tx) => upsertGoogleUser(tx, identity, freeCredits));

      const [user] = await app.db
        .select({
          id: schema.users.id,
          email: schema.users.email,
          displayName: schema.users.displayName,
          tier: schema.users.tier,
          maxActiveDevices: schema.users.maxActiveDevices,
        })
        .from(schema.users)
        .where(eq(schema.users.id, userId));
      if (!user) throw new AppError('UNAUTH', 401, 'user not found');

      // Cap logic is deliberately identical to the password route above: kiosk is a
      // single shared terminal per account, mobile is staff sharing one account
      // across tablets.
      const sessions = await activeDeviceSessions(app, user.id);
      const otherSessions = sessions.filter((session) => session.deviceId !== deviceId);
      if (platform !== 'mobile' && otherSessions.length >= user.maxActiveDevices) {
        const forceLogoutToken = await createForceLogoutToken(app, {
          userId: user.id,
          deviceId,
          deviceName,
          platform,
        });
        return reply.code(409).send({
          error: {
            code: 'DEVICE_LIMIT_REACHED',
            message: 'This account is already active on another device.',
            forceLogoutToken,
            maxActiveDevices: user.maxActiveDevices,
            activeDevices: otherSessions.map(publicDeviceSession),
          },
        });
      }

      await app.db
        .update(schema.refreshTokens)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(schema.refreshTokens.userId, user.id),
            inArray(schema.refreshTokens.portal, [...DEVICE_SESSION_PORTALS]),
            eq(schema.refreshTokens.deviceId, deviceId),
            isNull(schema.refreshTokens.revokedAt),
          ),
        );

      const tokens = await issueDeviceSession(app, {
        userId: user.id,
        deviceId,
        deviceName,
        platform,
      });
      const [logoUrl, merchantStatus] = await Promise.all([
        resolveMerchantLogoUrl(app, user.id),
        resolveMerchantStatus(app, user.id),
      ]);

      return {
        ...tokens,
        user: deviceLoginUserPayload(user),
        logoUrl,
        merchantStatus,
        // Prefill for the onboarding form; omitted once a merchants row exists.
        ...(merchantStatus === 'ONBOARDING_REQUIRED'
          ? {
              onboarding: {
                suggestedContactName: identity.name ?? null,
                suggestedCompanyName: identity.name ?? null,
              },
            }
          : {}),
      };
    },
  );
```

`publicDeviceSession` already exists in this file (used at line 775). If it is declared below this
insertion point, move the route insertion after it or hoist the function — `const` arrow functions
are not hoisted.

- [x] **Step 5: Run the tests**

Run: `pnpm --filter @tryme/api test -- device-google-login`
Expected: PASS, 9 tests.

- [x] **Step 6: Commit**

```bash
git add apps/api/src/modules/auth/routes.ts apps/api/test/device-google-login.test.ts
git commit -m "feat(auth): add native Google device login for the Android app"
```

---

### Task 5: Merchant onboarding + `signup_source`

**Files:**
- Create: `apps/api/src/modules/merchant/onboarding.routes.ts`, `packages/db/src/migrations/0133_merchant_signup_source.sql`
- Modify: `packages/db/src/schema/merchant.ts:16-40`, `packages/types/src/widget.ts`, `apps/api/src/server.ts`
- Test: `apps/api/test/merchant-onboarding.test.ts`

**Interfaces:**
- Consumes: `resolveMerchantStatus` (Task 3); `app.requireUser` (`apps/api/src/plugins/auth.ts:21`).
- Produces:
  - `MerchantOnboardingBody`, `MerchantStatusSchema` in `@tryme/types`
  - `merchantOnboardingRoutes(app: FastifyInstance): Promise<void>`
  - `merchants.signupSource: 'admin' | 'android_google'`

- [x] **Step 1: Write the failing test**

Create `apps/api/test/merchant-onboarding.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signAccess } from '../src/modules/auth/service.js';
import { buildTestApp, type TestApp } from './helpers/api.js';
import { type Containers, startContainers } from './helpers/containers.js';
import { createTestMerchant } from './helpers/merchant.js';

let c: Containers;
let app: TestApp;

beforeAll(async () => {
  c = await startContainers();
  app = await buildTestApp(c);
});

afterAll(async () => {
  await app?.close();
  await c?.stop();
});

async function tokenFor(userId: string) {
  return signAccess(
    new TextEncoder().encode(app.env.JWT_SECRET),
    userId,
    { kind: 'access' },
    app.env.JWT_EXPIRY,
  );
}

async function createGoogleUser(displayName: string | null = 'Google Person') {
  const [user] = await app.db
    .insert(schema.users)
    .values({
      email: `onb-${randomUUID()}@example.com`,
      displayName,
      passwordHash: null,
      emailVerified: true,
    })
    .returning();
  if (!user) throw new Error('failed to create user');
  return { userId: user.id, token: await tokenFor(user.id) };
}

function auth(token: string) {
  return { authorization: `Bearer ${token}` };
}

describe('GET /v1/merchant/onboarding', () => {
  it('reports ONBOARDING_REQUIRED with a prefill before onboarding', async () => {
    const { token } = await createGoogleUser('Prefill Person');
    const res = await app.inject({
      method: 'GET',
      url: '/v1/merchant/onboarding',
      headers: auth(token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      merchantStatus: 'ONBOARDING_REQUIRED',
      prefill: { contactName: 'Prefill Person', companyName: 'Prefill Person', phone: '' },
    });
  });

  it('reports ACTIVE once a merchant exists', async () => {
    const merchant = await createTestMerchant(app, { isActive: true });
    const res = await app.inject({
      method: 'GET',
      url: '/v1/merchant/onboarding',
      headers: auth(await tokenFor(merchant.userId)),
    });
    expect(res.json().merchantStatus).toBe('ACTIVE');
  });

  it('401s without a bearer token', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/merchant/onboarding' });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /v1/merchant/onboarding', () => {
  it('creates an active merchant from the phone number alone', async () => {
    const { userId, token } = await createGoogleUser('Only Name');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/merchant/onboarding',
      headers: auth(token),
      payload: { phone: '9876543210' },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json().merchantStatus).toBe('ACTIVE');

    const [merchant] = await app.db
      .select()
      .from(schema.merchants)
      .where(eq(schema.merchants.userId, userId));
    expect(merchant).toMatchObject({
      contactName: 'Only Name',
      companyName: 'Only Name',
      businessAddress: 'Not Provided',
      phone: '9876543210',
      isActive: true,
      signupSource: 'android_google',
    });

    const [credits] = await app.db
      .select()
      .from(schema.merchantCredits)
      .where(eq(schema.merchantCredits.merchantId, merchant?.id ?? ''));
    expect(credits?.balance).toBe(0);

    const [user] = await app.db.select().from(schema.users).where(eq(schema.users.id, userId));
    expect(user?.phone).toBe('9876543210');
  });

  it('uses all four supplied fields when given', async () => {
    const { userId, token } = await createGoogleUser();
    await app.inject({
      method: 'POST',
      url: '/v1/merchant/onboarding',
      headers: auth(token),
      payload: {
        phone: '9000000001',
        contactName: 'Real Contact',
        companyName: 'Real Shop',
        businessAddress: '1 Real Street',
      },
    });

    const [merchant] = await app.db
      .select()
      .from(schema.merchants)
      .where(eq(schema.merchants.userId, userId));
    expect(merchant).toMatchObject({
      contactName: 'Real Contact',
      companyName: 'Real Shop',
      businessAddress: '1 Real Street',
    });
  });

  it('unblocks requireMerchant immediately', async () => {
    const { token } = await createGoogleUser();
    const before = await app.inject({
      method: 'GET',
      url: '/v1/merchant/catalog',
      headers: auth(token),
    });
    expect(before.statusCode).toBe(403);

    await app.inject({
      method: 'POST',
      url: '/v1/merchant/onboarding',
      headers: auth(token),
      payload: { phone: '9000000002' },
    });

    const after = await app.inject({
      method: 'GET',
      url: '/v1/merchant/catalog',
      headers: auth(token),
    });
    expect(after.statusCode).toBe(200);
    expect(after.json().items).toEqual([]);
  });

  it('409s on a second submit', async () => {
    const { token } = await createGoogleUser();
    await app.inject({
      method: 'POST',
      url: '/v1/merchant/onboarding',
      headers: auth(token),
      payload: { phone: '9000000003' },
    });
    const again = await app.inject({
      method: 'POST',
      url: '/v1/merchant/onboarding',
      headers: auth(token),
      payload: { phone: '9000000003' },
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('CONFLICT');
  });

  it('409s for an admin-created merchant and leaves signupSource as admin', async () => {
    const merchant = await createTestMerchant(app, { isActive: true });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/merchant/onboarding',
      headers: auth(await tokenFor(merchant.userId)),
      payload: { phone: '9000000004' },
    });
    expect(res.statusCode).toBe(409);

    const [row] = await app.db
      .select({ signupSource: schema.merchants.signupSource })
      .from(schema.merchants)
      .where(eq(schema.merchants.id, merchant.merchantId));
    expect(row?.signupSource).toBe('admin');
  });

  it('400s on a missing or malformed phone number', async () => {
    const { token } = await createGoogleUser();
    for (const payload of [{}, { phone: '123' }, { phone: 'not-a-number' }]) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/merchant/onboarding',
        headers: auth(token),
        payload,
      });
      expect(res.statusCode).toBe(400);
    }
  });
});
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- merchant-onboarding`
Expected: FAIL — 404 on `/v1/merchant/onboarding`.

- [x] **Step 3: Add the schema column and migration**

In `packages/db/src/schema/merchant.ts`, inside `merchants` after `logoKey` (line 31):

```ts
  // 'admin'          — created through POST /admin/merchants (an admin IS the approval)
  // 'android_google' — self-serve Google signup from the Android app via
  //                    POST /v1/merchant/onboarding. Try-ons are free, so these
  //                    accounts are the ones to watch for GPU abuse.
  signupSource: text('signup_source').notNull().default('admin'),
```

Create `packages/db/src/migrations/0133_merchant_signup_source.sql`:

```sql
ALTER TABLE "merchants" ADD COLUMN "signup_source" text NOT NULL DEFAULT 'admin';
```

Then run `pnpm db:generate` and reconcile: if drizzle-kit emits its own file for this change, delete
the hand-written one and keep drizzle's, making sure the index stays `0133` and `_journal.json` lists
it. Never renumber below an index the server already has.

- [x] **Step 4: Add the types**

Append to `packages/types/src/widget.ts`:

```ts
export const MerchantStatusSchema = z.enum([
  'ONBOARDING_REQUIRED',
  'PENDING_ACTIVATION',
  'ACTIVE',
]);
export type MerchantStatusSchema = z.infer<typeof MerchantStatusSchema>;

// Phone is the only mandatory field: contactName falls back to the Google
// display name, companyName to contactName, businessAddress to 'Not Provided'.
export const MerchantOnboardingBody = z.object({
  phone: z
    .string()
    .trim()
    .regex(/^\+?[0-9]{10,15}$/, 'Enter a valid mobile number'),
  contactName: z.string().max(120).optional(),
  companyName: z.string().max(200).optional(),
  businessAddress: z.string().max(500).optional(),
});
export type MerchantOnboardingBody = z.infer<typeof MerchantOnboardingBody>;
```

- [x] **Step 5: Write the routes**

Create `apps/api/src/modules/merchant/onboarding.routes.ts`:

```ts
import { schema } from '@tryme/db';
import { MerchantOnboardingBody } from '@tryme/types';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { resolveMerchantStatus } from './status.js';

function fallbackContactName(displayName: string | null, email: string | null): string {
  return displayName?.trim() || email?.split('@')[0] || 'Merchant';
}

/**
 * Guarded by requireUser, NOT requireMerchant — the entire point is that no
 * merchants row exists yet, so requireMerchant would 403 every caller.
 */
export async function merchantOnboardingRoutes(app: FastifyInstance) {
  app.get('/v1/merchant/onboarding', { preHandler: app.requireUser }, async (req) => {
    const [user] = await app.db
      .select({
        displayName: schema.users.displayName,
        email: schema.users.email,
        phone: schema.users.phone,
      })
      .from(schema.users)
      .where(eq(schema.users.id, req.userId));
    if (!user) throw new AppError('UNAUTH', 401, 'user not found');

    const contactName = fallbackContactName(user.displayName, user.email);
    return {
      merchantStatus: await resolveMerchantStatus(app, req.userId),
      prefill: { contactName, companyName: contactName, phone: user.phone ?? '' },
    };
  });

  app.post(
    '/v1/merchant/onboarding',
    { preHandler: app.requireUser, schema: { body: MerchantOnboardingBody } },
    async (req, reply) => {
      const body = req.body as z.infer<typeof MerchantOnboardingBody>;

      const merchantId = await app.db.transaction(async (tx) => {
        const [existing] = await tx
          .select({ id: schema.merchants.id })
          .from(schema.merchants)
          .where(eq(schema.merchants.userId, req.userId))
          .limit(1);
        if (existing) {
          throw new AppError('CONFLICT', 409, 'This account is already registered as a merchant');
        }

        const [user] = await tx
          .select({
            displayName: schema.users.displayName,
            email: schema.users.email,
            phone: schema.users.phone,
          })
          .from(schema.users)
          .where(eq(schema.users.id, req.userId))
          .limit(1);
        if (!user) throw new AppError('UNAUTH', 401, 'user not found');

        const contactName =
          body.contactName?.trim() || fallbackContactName(user.displayName, user.email);

        const [created] = await tx
          .insert(schema.merchants)
          .values({
            companyName: body.companyName?.trim() || contactName,
            contactName,
            phone: body.phone,
            // Same placeholder convention as POST /admin/merchants.
            businessAddress: body.businessAddress?.trim() || 'Not Provided',
            isActive: true,
            signupSource: 'android_google',
            userId: req.userId,
          })
          .returning({ id: schema.merchants.id });
        if (!created) throw new AppError('INTERNAL', 500, 'failed to create merchant');

        // Every merchant credit helper assumes this row exists.
        await tx.insert(schema.merchantCredits).values({ merchantId: created.id, balance: 0 });

        if (!user.phone) {
          await tx
            .update(schema.users)
            .set({ phone: body.phone })
            .where(eq(schema.users.id, req.userId));
        }

        return created.id;
      });

      app.log.info(
        { userId: req.userId, merchantId, signupSource: 'android_google' },
        'merchant onboarding completed',
      );
      reply.code(201);
      return { merchantStatus: 'ACTIVE' as const, merchantId };
    },
  );
}
```

Register it in `apps/api/src/server.ts` next to `merchantCatalogRoutes` (line 293):

```ts
  await app.register(merchantOnboardingRoutes);
```
plus the matching import alongside the other merchant imports.

- [x] **Step 6: Apply the migration and run the tests**

```bash
pnpm docker:up
pnpm db:migrate
pnpm --filter @tryme/api test -- merchant-onboarding
```
Expected: PASS, 9 tests.

Then the whole suite: `pnpm --filter @tryme/api test` — still green.

- [x] **Step 7: Commit**

```bash
git add packages/db/src/schema/merchant.ts packages/db/src/migrations packages/types/src/widget.ts \
  apps/api/src/modules/merchant/onboarding.routes.ts apps/api/src/server.ts \
  apps/api/test/merchant-onboarding.test.ts
git commit -m "feat(merchant): self-serve onboarding for Google signups"
```

---

### Task 6: Surface `signupSource` in admin

**Files:**
- Modify: `apps/api/src/modules/admin/merchants.routes.ts:87` (the list route's select), `apps/admin-web/src/pages/UsersPage.tsx` (merchants table)
- Test: `apps/api/test/merchant-onboarding.test.ts` (add one case)

**Interfaces:**
- Consumes: `merchants.signupSource` (Task 5).
- Produces: `signupSource` on each row of `GET /admin/merchants`.

- [x] **Step 1: Write the failing test**

Append to `apps/api/test/merchant-onboarding.test.ts`. Read
`apps/api/test/helpers/admin.ts` first for the existing admin-token helper and use it rather than
hand-rolling one:

```ts
describe('GET /admin/merchants signupSource', () => {
  it('reports android_google for a self-serve signup and admin for the rest', async () => {
    const adminToken = await createAdminToken(app, 'SUPER_ADMIN'); // from ./helpers/admin.js
    const seeded = await createTestMerchant(app, { isActive: true });
    const { token } = await createGoogleUser();
    await app.inject({
      method: 'POST',
      url: '/v1/merchant/onboarding',
      headers: auth(token),
      payload: { phone: '9000000005' },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/admin/merchants',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);

    const rows = res.json().items as Array<{ id: string; signupSource: string }>;
    expect(rows.find((r) => r.id === seeded.merchantId)?.signupSource).toBe('admin');
    expect(rows.some((r) => r.signupSource === 'android_google')).toBe(true);
  });
});
```

If the list route returns a differently-named envelope than `items`, match what the route actually
returns.

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- merchant-onboarding`
Expected: FAIL — `expected undefined to be 'admin'`.

- [x] **Step 3: Add the column to the list select**

In `apps/api/src/modules/admin/merchants.routes.ts`, add to the `GET /admin/merchants` select
object:

```ts
        signupSource: schema.merchants.signupSource,
```

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @tryme/api test -- merchant-onboarding`
Expected: PASS.

- [x] **Step 5: Show it in the admin merchants table**

In `apps/admin-web/src/pages/UsersPage.tsx`, find the merchants table row rendering and add a badge
cell. Follow the file's own badge markup — the codebase convention is
`statusBadge()` from `../lib/data` returning `[variant, label]`, rendered as
`<span className={\`badge ${variant}\`}>{label}</span>`. Add to the merchant row type
`signupSource: string;` and render:

```tsx
<td>
  {m.signupSource === 'android_google' ? (
    <span className="badge warn">Self-signup</span>
  ) : (
    <span className="badge">Admin</span>
  )}
</td>
```

Add the matching `<th>Signup</th>` to the header row so column counts stay aligned.

- [x] **Step 6: Verify the admin app builds**

```bash
pnpm --filter @tryme/admin build
```
Expected: clean build.

- [x] **Step 7: Commit**

```bash
git add apps/api/src/modules/admin/merchants.routes.ts apps/admin-web/src/pages/UsersPage.tsx apps/api/test/merchant-onboarding.test.ts
git commit -m "feat(admin): flag self-serve Google merchant signups"
```

---

### Task 7: Android — Google button + onboarding screen

No JVM test infrastructure exists in this module (only `ExampleInstrumentedTest.kt`), so this task is
verified by running the app against a local API. Do not add a test framework as part of it.

**Files:**
- Modify: `gradle/libs.versions.toml`, `app/build.gradle.kts`
- Modify: `app/src/main/java/tryme/nice/interactive/ApiUtils/APIConstant.kt:18-31`
- Modify: `app/src/main/java/tryme/nice/interactive/viewmodel/category/SareeCategoryDataRepository.kt:35-121`
- Modify: `app/src/main/java/tryme/nice/interactive/activity/auth/LoginActivity.kt`
- Create: `app/src/main/java/tryme/nice/interactive/activity/auth/OnboardingActivity.kt`, `app/src/main/res/layout/activity_onboarding.xml`
- Modify: `app/src/main/AndroidManifest.xml` (register the activity)

All paths are relative to `apps/virtual-tryon-mobile&kiosk_latest/`.

**Interfaces:**
- Consumes: `POST /v1/auth/device-login/google` (Task 4), `GET`/`POST /v1/merchant/onboarding` (Task 5).
- Produces: `SareeCategoryDataRepository.loginWithGoogle(idToken: String, androidId: String): UserLoginDataModel`, `SareeCategoryDataRepository.submitOnboarding(...)`, `SareeCategoryDataRepository.lastMerchantStatus: String`.

- [x] **Step 1: Add the Credential Manager dependencies**

`gradle/libs.versions.toml` — in `[versions]`:

```toml
credentials = "1.3.0"
googleid = "1.1.1"
```

in `[libraries]`:

```toml
androidx-credentials = { group = "androidx.credentials", name = "credentials", version.ref = "credentials" }
androidx-credentials-play-services = { group = "androidx.credentials", name = "credentials-play-services-auth", version.ref = "credentials" }
googleid = { group = "com.google.android.libraries.identity.googleid", name = "googleid", version.ref = "googleid" }
```

`app/build.gradle.kts` — in `dependencies`:

```kotlin
    implementation(libs.androidx.credentials)
    implementation(libs.androidx.credentials.play.services)
    implementation(libs.googleid)
```

In the same file's `defaultConfig`, add the Web client ID as a build config field next to the
existing `API_BASE_URL` field (read it from `gradle.properties` / an env var — do not hardcode a
real client ID into a committed file):

```kotlin
        buildConfigField(
            "String",
            "GOOGLE_WEB_CLIENT_ID",
            "\"${project.findProperty("GOOGLE_WEB_CLIENT_ID") ?: ""}\"",
        )
```

- [x] **Step 2: Verify it compiles**

Run: `cd "apps/virtual-tryon-mobile&kiosk_latest" && ./gradlew :app:assembleDebug`
Expected: BUILD SUCCESSFUL.

- [x] **Step 3: Add the endpoints**

`ApiUtils/APIConstant.kt`, inside `API_ENDPOINTS`:

```kotlin
        const val DEVICE_LOGIN_GOOGLE = "v1/auth/device-login/google"
        const val MERCHANT_ONBOARDING = "v1/merchant/onboarding"
```

- [x] **Step 4: Add the repository calls**

`SareeCategoryDataRepository.kt`. Add a field and three functions. `postDeviceLogin` already
persists the refresh token and maps `DEVICE_LIMIT_REACHED`, so reuse it verbatim:

```kotlin
    /** merchantStatus from the most recent login: ONBOARDING_REQUIRED | PENDING_ACTIVATION | ACTIVE. */
    var lastMerchantStatus: String = ""
        private set

    var onboardingSuggestedName: String = ""
        private set

    suspend fun loginWithGoogle(idToken: String, androidId: String): UserLoginDataModel {
        val payload = JSONObject().apply {
            put("idToken", idToken)
            put("deviceId", androidId)
            put("deviceName", deviceName())
            // Must match the value APICaller.refreshAccessToken sends, or the
            // refresh is rejected with INVALID_REFRESH.
            put("platform", "kiosk")
        }
        return postDeviceLogin(APIConstant.API_ENDPOINTS.DEVICE_LOGIN_GOOGLE, payload)
    }

    suspend fun submitOnboarding(
        phone: String,
        contactName: String?,
        companyName: String?,
        businessAddress: String?,
    ) {
        val payload = JSONObject().apply {
            put("phone", phone)
            if (!contactName.isNullOrBlank()) put("contactName", contactName)
            if (!companyName.isNullOrBlank()) put("companyName", companyName)
            if (!businessAddress.isNullOrBlank()) put("businessAddress", businessAddress)
        }
        APICaller.postJsonAuthed(
            APIConstant.API_ENDPOINTS.MERCHANT_ONBOARDING,
            payload.toString(),
            PrefsManager.getAccessToken(),
        )
        lastMerchantStatus = "ACTIVE"
    }

    suspend fun fetchOnboardingState(): JSONObject = JSONObject(
        APICaller.getJsonAuthed(
            APIConstant.API_ENDPOINTS.MERCHANT_ONBOARDING,
            PrefsManager.getAccessToken(),
        ),
    )
```

In `postDeviceLogin`, capture the two new response fields right after `val user = ...` (line 68):

```kotlin
        lastMerchantStatus = response.optString("merchantStatus", "ACTIVE")
        onboardingSuggestedName = response
            .optJSONObject("onboarding")
            ?.optString("suggestedContactName", "")
            .orEmpty()
```

- [x] **Step 5: Add the Google button to LoginActivity**

In `LoginActivity.kt`, add a "Continue with Google" button to `activity_login.xml` (match the
existing `btn_login` styling) and wire it:

```kotlin
    private fun startGoogleSignIn() {
        val clientId = BuildConfig.GOOGLE_WEB_CLIENT_ID
        if (clientId.isBlank()) {
            ShowErrorAlertDialog.show(this, "Google sign-in is not configured for this build.")
            return
        }
        val option = GetGoogleIdOption.Builder()
            .setServerClientId(clientId)
            // false so a first-time user can pick any account, not only ones already
            // linked to this app — this is the signup path, not just login.
            .setFilterByAuthorizedAccounts(false)
            .build()
        val request = GetCredentialRequest.Builder().addCredentialOption(option).build()

        lifecycleScope.launch {
            try {
                val result = CredentialManager.create(this@LoginActivity)
                    .getCredential(this@LoginActivity, request)
                val idToken = GoogleIdTokenCredential
                    .createFrom(result.credential.data)
                    .idToken
                val androidId = PrefsManager.getOrCreateDeviceId()
                val login = SareeCategoryDataRepository.loginWithGoogle(idToken, androidId)
                PrefsManager.updateAccessToken(login.user.apiKey)
                routeAfterLogin()
            } catch (e: GetCredentialException) {
                ShowErrorAlertDialog.show(this@LoginActivity, "Google sign-in was cancelled.")
            } catch (e: DeviceLimitReachedException) {
                promptForceLogin(e.forceLogoutToken)
            } catch (e: Exception) {
                ShowErrorAlertDialog.show(this@LoginActivity, ApiErrorPresenter.message(e))
            }
        }
    }

    private fun routeAfterLogin() {
        when (SareeCategoryDataRepository.lastMerchantStatus) {
            "ONBOARDING_REQUIRED" -> startActivity(Intent(this, OnboardingActivity::class.java))
            "PENDING_ACTIVATION" -> ShowAppAlertDialog.show(
                this,
                "Your account is awaiting activation. Please contact support.",
            )
            else -> startActivity(Intent(this, HomeDressesForActivity::class.java))
        }
        if (SareeCategoryDataRepository.lastMerchantStatus != "PENDING_ACTIVATION") finish()
    }
```

Call `routeAfterLogin()` from the **existing** password-login success path too, replacing whatever
unconditional navigation to Home is there now — otherwise a password login by a
merchant-less user still lands on a screen that 403s. Adapt `PrefsManager.getOrCreateDeviceId()`,
`promptForceLogin`, `ShowErrorAlertDialog.show`, `ShowAppAlertDialog.show` and
`ApiErrorPresenter.message` to whatever those helpers are actually called in this codebase — read
the current `LoginActivity.kt` and `ApiErrorPresenter.kt` before writing.

- [x] **Step 6: Create the onboarding screen**

`res/layout/activity_onboarding.xml`: a vertical form with four `EditText`s — mobile number
(`inputType="phone"`, required), contact name (prefilled, `android:hint="Your name"`), shop name
(optional), business address (optional) — plus a submit button. Reuse
`@drawable/app_background_corner` and the `popins_regular` font so it matches the login screen.

`OnboardingActivity.kt`:

```kotlin
class OnboardingActivity : BaseActivity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val binding = ActivityOnboardingBinding.inflate(layoutInflater)
        setContentView(binding.root)

        binding.etContactName.setText(SareeCategoryDataRepository.onboardingSuggestedName)

        binding.btnSubmit.setOnClickListener {
            val phone = binding.etPhone.text.toString().trim()
            // Mirrors the server-side MerchantOnboardingBody regex so the user sees
            // the problem before a round trip.
            if (!Regex("^\\+?[0-9]{10,15}$").matches(phone)) {
                binding.etPhone.error = "Enter a valid mobile number"
                return@setOnClickListener
            }
            binding.btnSubmit.isEnabled = false
            lifecycleScope.launch {
                try {
                    SareeCategoryDataRepository.submitOnboarding(
                        phone = phone,
                        contactName = binding.etContactName.text.toString().trim(),
                        companyName = binding.etShopName.text.toString().trim(),
                        businessAddress = binding.etAddress.text.toString().trim(),
                    )
                    startActivity(Intent(this@OnboardingActivity, HomeDressesForActivity::class.java))
                    finish()
                } catch (e: Exception) {
                    binding.btnSubmit.isEnabled = true
                    ShowErrorAlertDialog.show(this@OnboardingActivity, ApiErrorPresenter.message(e))
                }
            }
        }
    }
}
```

If this module does not use view binding, replace `ActivityOnboardingBinding` with
`findViewById` lookups matching the pattern in the sibling activities.

Register in `AndroidManifest.xml` next to `LoginActivity`:

```xml
<activity android:name=".activity.auth.OnboardingActivity" android:exported="false" />
```

- [ ] **Step 7: Manual verification against a local API**

1. In Google Cloud console, add an Android OAuth client with the debug keystore SHA-1 and package
   `tryme.nice.interactive`. Put the existing **Web** client ID in `gradle.properties` as
   `GOOGLE_WEB_CLIENT_ID`.
2. `pnpm docker:up && pnpm --filter @tryme/api dev`; point `API_BASE_URL` at that host.
3. `./gradlew :app:installDebug`. Sign in with a Google account never used with Tryme → the
   onboarding form appears, **not** Home.
4. Submit with the mobile number only → Home. Verify in psql:
   `select company_name, phone, is_active, signup_source from merchants order by created_at desc limit 1;`
   → `is_active = t`, `signup_source = android_google`.
5. Admin panel → the merchant appears with the "Self-signup" badge.
6. Force-close and reopen → session restored. Wait past `JWT_EXPIRY` and act → the 401 →
   `/device-refresh` → retry path in `APICaller.kt:110-163` still works.
7. Sign in with Google using the email of an existing password merchant → straight to Home, and
   that account's password login still works.

- [x] **Step 8: Commit**

```bash
git add "apps/virtual-tryon-mobile&kiosk_latest"
git commit -m "feat(android): Google sign-in and merchant onboarding form"
```

---

## Plan A self-review

- **Spec coverage.** Google ID token verification → T1. Shared upsert (no drift with web) → T2.
  `merchantStatus` on all device-login responses → T3, T4. Google device route incl. device cap and
  force-login → T4. Onboarding form, phone mandatory, other three optional with fallbacks,
  active-on-submit, `merchant_credits` row → T5. Self-signup visibility for the flagged risk → T5
  (`signup_source`) + T6 (admin badge). Both platforms get the button → T4 (`platform` enum
  unchanged) + T7. App-side button, routing and form → T7.
- **Placeholders.** None. Where a codebase detail must be confirmed before writing (credit-plan
  columns in T2, rate-limit handling in T4, view binding and helper names in T7, the admin list
  envelope in T6) the step says exactly what to read and what to reconcile against.
- **Type consistency.** `GoogleIdentity` (T1) is the input type of `upsertGoogleUser` (T2) and is
  built in T4 from the same verifier. `MerchantStatus` (T3) is the union `resolveMerchantStatus`
  returns and matches the string literals branched on in T7's `routeAfterLogin`. `MerchantStatusSchema`
  (T5, the zod mirror) is deliberately a separate name so it cannot collide with the T3 TS union.
  `signupSource` is spelled the same in schema (T5), route select (T6) and tests.

