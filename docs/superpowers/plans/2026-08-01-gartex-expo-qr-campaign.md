# Gartex Expo QR Signup Campaign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** QR-sourced signups (`?src=gartex2026`) get +25% credits on their first plan purchase and +25% on their free signup credit grant, driven by an admin-configurable `signup_campaigns` table.

**Architecture:** One new DB table (`signup_campaigns`) + one new nullable FK column on `users` (`signup_campaign_id`, set once at signup, never changed). Two existing credit-grant code paths (`FREE_TRIAL` on profile completion, `PAYMENT` on first purchase) read that attribution and apply a bonus. A new admin CRUD module manages campaigns; the register page and Google OAuth flow both thread a `src` query param through to attribution.

**Tech Stack:** Fastify 5, Drizzle ORM (Postgres), Zod, Next.js 15 (catalogues-web), Vite + React (admin-web), Vitest integration tests.

**Spec:** `docs/superpowers/specs/2026-08-01-gartex-expo-qr-campaign-design.md` — read it for the "why" behind each decision below; this plan only covers the "how".

---

## Task 1: DB schema — `signup_campaigns` table + `users.signupCampaignId`

**Files:**
- Create: `packages/db/src/schema/campaigns.ts`
- Modify: `packages/db/src/schema/users.ts`
- Modify: `packages/db/src/schema/index.ts`

- [ ] **Step 1: Create the new schema file**

Create `packages/db/src/schema/campaigns.ts`:

```ts
import { boolean, integer, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

export const signupCampaigns = pgTable('signup_campaigns', {
  id: uuid('id').primaryKey().defaultRandom(),
  // Matches the ?src= query param on the signup link, e.g. 'gartex2026'.
  code: text('code').notNull().unique(),
  name: text('name').notNull(),
  // Applied to both the first-purchase bonus and the free signup-credit boost.
  bonusPercent: integer('bonus_percent').notNull(),
  startAt: timestamp('start_at', { withTimezone: true }).notNull(),
  endAt: timestamp('end_at', { withTimezone: true }).notNull(),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
```

- [ ] **Step 2: Add the FK column to `users`**

In `packages/db/src/schema/users.ts`, add the import (alongside the existing sibling-table imports):

```ts
import { kioskDevices } from './kiosk.js';
import { merchants } from './merchant.js';
```

becomes:

```ts
import { signupCampaigns } from './campaigns.js';
import { kioskDevices } from './kiosk.js';
import { merchants } from './merchant.js';
```

Then add the column to the `users` table definition, right after the `username` field and before `createdAt`:

```ts
    username: text('username').unique(),
    // Set once at signup (email/password register or Google OAuth new-account
    // branch), never updated afterward — see docs/superpowers/specs/2026-08-01-gartex-expo-qr-campaign-design.md §3.1.
    signupCampaignId: uuid('signup_campaign_id').references(() => signupCampaigns.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
```

- [ ] **Step 3: Re-export the new schema file**

In `packages/db/src/schema/index.ts`, `campaigns.js` sorts alphabetically between `api-keys.js` and `catalog.js` (`'api' < 'cam' < 'cat'`). Change:

```ts
export * from './admin.js';
export * from './api-keys.js';
export * from './catalog.js';
```

to:

```ts
export * from './admin.js';
export * from './api-keys.js';
export * from './campaigns.js';
export * from './catalog.js';
```

- [ ] **Step 4: Verify the package builds**

Run: `pnpm --filter @tryme/db typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema/campaigns.ts packages/db/src/schema/users.ts packages/db/src/schema/index.ts
git commit -m "feat(db): add signup_campaigns table and users.signupCampaignId"
```

---

## Task 2: Generate and apply the migration

**Files:**
- Create: `packages/db/src/migrations/NNNN_signup_campaigns.sql` (exact index determined below)
- Modify (auto-generated): `packages/db/src/migrations/meta/_journal.json`, `packages/db/src/migrations/meta/NNNN_snapshot.json`

- [ ] **Step 1: Check the current migration head**

Run: `python3 -c "import json; d=json.load(open('packages/db/src/migrations/meta/_journal.json')); print(d['entries'][-1])"`

(if `python3` isn't available, `tail -c 400 packages/db/src/migrations/meta/_journal.json` and read the last `idx`/`tag` manually)

Expected output as of this writing: `idx: 136, tag: '0136_merchant_demo_data'`. Your migration will be `0137_...` — but if the branch has moved on since this plan was written, use `head + 1`, never hardcode 137 blindly. Per `CLAUDE.md`'s migration-index rule, the server's index is canonical.

- [ ] **Step 2: Ensure local infra is up**

Run: `pnpm docker:up`
Expected: postgres/redis/minio containers running (or already running — command is idempotent).

- [ ] **Step 3: Generate the migration**

Run: `pnpm db:generate`

This runs `tsc && drizzle-kit generate` inside `packages/db` — it compiles the schema changes from Task 1 and diffs them against the last snapshot, writing a new file at `packages/db/src/migrations/0137_<auto-name>.sql` (drizzle-kit picks the descriptive suffix; rename the file to `0137_signup_campaigns.sql` for clarity if it picks something generic, and update the matching `tag` field in `_journal.json` and the snapshot filename to match).

Expected generated SQL (verify it matches this shape — exact quoting/constraint-naming is drizzle-kit's call, don't hand-edit unless it's wrong):

```sql
CREATE TABLE "signup_campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"bonus_percent" integer NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signup_campaigns_code_unique" UNIQUE("code")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "signup_campaign_id" uuid;
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_signup_campaign_id_signup_campaigns_id_fk" FOREIGN KEY ("signup_campaign_id") REFERENCES "public"."signup_campaigns"("id") ON DELETE set null ON UPDATE no action;
```

If `pnpm db:generate` prompts an interactive question (e.g. asking whether this is a new table vs. a rename) — it shouldn't for a brand-new table + a brand-new column, but if it does, answer "create new" for both, never "rename from".

- [ ] **Step 4: Apply the migration to your local dev DB**

Run: `pnpm db:migrate`
Expected: log line confirming migration `0137_signup_campaigns` applied, no errors. ("already exists" NOTICEs for unrelated tables are fine per `CLAUDE.md`; there should be none here since this is a brand-new table.)

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/migrations/
git commit -m "chore(db): migration for signup_campaigns table"
```

---

## Task 3: `RegisterBody.signupSource`

**Files:**
- Modify: `packages/types/src/auth.ts`

- [ ] **Step 1: Add the field**

In `packages/types/src/auth.ts`:

```ts
export const RegisterBody = z.object({
  email: z.string().email().max(254),
  password: z
    .string()
    .min(8)
    .max(128)
    .regex(/[a-zA-Z]/, 'Password must contain at least one letter')
    .regex(/[0-9]/, 'Password must contain at least one number'),
  displayName: z.string().min(1).max(80),
  // ?src= query param from the signup link, e.g. a QR-code campaign code.
  // Resolved against signup_campaigns server-side; an unknown/expired code is
  // silently ignored, never a validation error.
  signupSource: z.string().max(64).optional(),
});
```

- [ ] **Step 2: Verify the package builds**

Run: `pnpm --filter @tryme/types typecheck` (if no `typecheck` script exists in that package, run `pnpm build` from repo root and confirm no type errors from this package)

- [ ] **Step 3: Commit**

```bash
git add packages/types/src/auth.ts
git commit -m "feat(types): add optional signupSource to RegisterBody"
```

---

## Task 4: Campaign resolution helper + wire into email/password register

**Files:**
- Create: `apps/api/src/modules/auth/campaign.ts`
- Modify: `apps/api/src/modules/auth/routes.ts:328-360` (the `POST /v1/auth/register` handler)
- Test: `apps/api/test/integration/signup-campaign.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/integration/signup-campaign.test.ts`:

```ts
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from '../helpers/api';
import { type Containers, startContainers } from '../helpers/containers';

describe('signup campaign attribution — register', () => {
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

  async function seedCampaign(overrides: Partial<typeof schema.signupCampaigns.$inferInsert> = {}) {
    const now = new Date();
    const [campaign] = await app.db
      .insert(schema.signupCampaigns)
      .values({
        code: 'gartex2026',
        name: 'Gartex Expo Delhi 2026',
        bonusPercent: 25,
        startAt: new Date(now.getTime() - 86_400_000),
        endAt: new Date(now.getTime() + 86_400_000),
        isActive: true,
        ...overrides,
      })
      .returning();
    return campaign;
  }

  it('attributes a new user to the campaign when signupSource matches an active, in-window code', async () => {
    const campaign = await seedCampaign({ code: 'attr-test-1' });

    await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        displayName: 'QR User',
        email: 'qr-user-1@x.com',
        password: 'password123',
        signupSource: 'attr-test-1',
      },
    });

    const [user] = await app.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, 'qr-user-1@x.com'));
    expect(user?.signupCampaignId).toBe(campaign?.id);
  });

  it('leaves signupCampaignId null for an unknown code (no error)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        displayName: 'No Campaign User',
        email: 'no-campaign@x.com',
        password: 'password123',
        signupSource: 'not-a-real-code',
      },
    });
    expect(res.statusCode).toBe(201);

    const [user] = await app.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, 'no-campaign@x.com'));
    expect(user?.signupCampaignId).toBeNull();
  });

  it('leaves signupCampaignId null for a code outside its date window', async () => {
    const now = new Date();
    await seedCampaign({
      code: 'expired-test',
      startAt: new Date(now.getTime() - 2 * 86_400_000),
      endAt: new Date(now.getTime() - 86_400_000), // ended yesterday
    });

    await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        displayName: 'Late User',
        email: 'late-user@x.com',
        password: 'password123',
        signupSource: 'expired-test',
      },
    });

    const [user] = await app.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, 'late-user@x.com'));
    expect(user?.signupCampaignId).toBeNull();
  });

  it('leaves signupCampaignId null for an inactive campaign', async () => {
    await seedCampaign({ code: 'inactive-test', isActive: false });

    await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        displayName: 'Inactive User',
        email: 'inactive-user@x.com',
        password: 'password123',
        signupSource: 'inactive-test',
      },
    });

    const [user] = await app.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, 'inactive-user@x.com'));
    expect(user?.signupCampaignId).toBeNull();
  });

  it('leaves signupCampaignId null when no signupSource is sent at all', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        displayName: 'Plain User',
        email: 'plain-user@x.com',
        password: 'password123',
      },
    });
    expect(res.statusCode).toBe(201);

    const [user] = await app.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, 'plain-user@x.com'));
    expect(user?.signupCampaignId).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @tryme/api test -- signup-campaign`
Expected: FAIL — `signupCampaignId` is undefined/never set (the column exists from Task 1/2, but nothing writes it yet), and TypeScript may also complain that `RegisterBody`'s inferred type already has `signupSource` (from Task 3) but the route handler doesn't read it.

- [ ] **Step 3: Create the campaign resolution helper**

Create `apps/api/src/modules/auth/campaign.ts`:

```ts
import { schema } from '@tryme/db';
import { and, eq, gte, lte } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

/**
 * Resolves a `?src=` signup-campaign code to its DB id — only if the campaign
 * is active and `now` falls inside its date window. Returns null for any
 * non-match (unknown code, expired, inactive, or no code at all): a bad code
 * must be indistinguishable from no code to the caller.
 */
export async function resolveCampaignId(
  app: FastifyInstance,
  code: string | undefined | null,
): Promise<string | null> {
  if (!code) return null;
  const now = new Date();
  const [campaign] = await app.db
    .select({ id: schema.signupCampaigns.id })
    .from(schema.signupCampaigns)
    .where(
      and(
        eq(schema.signupCampaigns.code, code),
        eq(schema.signupCampaigns.isActive, true),
        lte(schema.signupCampaigns.startAt, now),
        gte(schema.signupCampaigns.endAt, now),
      ),
    );
  return campaign?.id ?? null;
}
```

- [ ] **Step 4: Wire it into the register route**

In `apps/api/src/modules/auth/routes.ts`, add the import alongside the other local imports near the top:

```ts
import { isCatalogVideoAllowed } from '../../lib/catalog-video-access.js';
import { AppError } from '../../lib/errors.js';
```

becomes:

```ts
import { isCatalogVideoAllowed } from '../../lib/catalog-video-access.js';
import { resolveCampaignId } from './campaign.js';
import { AppError } from '../../lib/errors.js';
```

(Biome will re-sort this on lint if the ordering convention differs — don't fight it, just make sure the import exists somewhere in the top import block.)

Then change the register handler body (currently `apps/api/src/modules/auth/routes.ts:328-360`):

```ts
    async (req, reply) => {
      const { email, password, displayName } = req.body as z.infer<typeof RegisterBody>;
      const exists = await app.db.select().from(schema.users).where(eq(schema.users.email, email));
      if (exists.length) throw new AppError('EMAIL_TAKEN', 409, 'email already registered');
      const passwordHash = await hashPassword(password);
      const [user] = await app.db
        .insert(schema.users)
        .values({ email, passwordHash, displayName, companyName: null, tier: 'free' })
        .returning();
      await app.db.insert(schema.userCredits).values({ userId: user.id, balance: 0 });
```

becomes:

```ts
    async (req, reply) => {
      const { email, password, displayName, signupSource } = req.body as z.infer<
        typeof RegisterBody
      >;
      const exists = await app.db.select().from(schema.users).where(eq(schema.users.email, email));
      if (exists.length) throw new AppError('EMAIL_TAKEN', 409, 'email already registered');
      const passwordHash = await hashPassword(password);
      const signupCampaignId = await resolveCampaignId(app, signupSource);
      const [user] = await app.db
        .insert(schema.users)
        .values({
          email,
          passwordHash,
          displayName,
          companyName: null,
          tier: 'free',
          signupCampaignId,
        })
        .returning();
      await app.db.insert(schema.userCredits).values({ userId: user.id, balance: 0 });
```

(The rest of the handler — sending the verification email, `reply.code(201)` — is unchanged.)

- [ ] **Step 5: Run the test again to verify it passes**

Run: `pnpm --filter @tryme/api test -- signup-campaign`
Expected: PASS, 5 tests.

- [ ] **Step 6: Run the full auth test file to check for regressions**

Run: `pnpm --filter @tryme/api test -- auth.test`
Expected: PASS, no regressions.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/auth/campaign.ts apps/api/src/modules/auth/routes.ts apps/api/test/integration/signup-campaign.test.ts
git commit -m "feat(api): attribute email/password signups to a QR campaign via ?src="
```

---

## Task 5: Boost the `FREE_TRIAL` grant for campaign-attributed users

**Files:**
- Modify: `apps/api/src/modules/auth/routes.ts:571-696` (the `PATCH /v1/me` handler)
- Test: `apps/api/test/integration/signup-campaign.test.ts` (same file as Task 4 — append)

- [ ] **Step 1: Write the failing test**

Append to `apps/api/test/integration/signup-campaign.test.ts`, inside the existing `describe` block (reuse the `seedCampaign` helper already defined there):

```ts
  it('boosts the FREE_TRIAL grant by bonusPercent when the user completed profile is campaign-attributed', async () => {
    // Free plan must actually grant something for the boost to be observable.
    await app.db
      .update(schema.creditPlans)
      .set({ credits: 100 })
      .where(eq(schema.creditPlans.slug, 'free'));

    const campaign = await seedCampaign({ code: 'boost-test', bonusPercent: 25 });

    await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        displayName: 'Boosted User',
        email: 'boosted-user@x.com',
        password: 'password123',
        signupSource: 'boost-test',
      },
    });
    const [user] = await app.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, 'boosted-user@x.com'));
    expect(user?.signupCampaignId).toBe(campaign?.id);

    await app.db
      .update(schema.users)
      .set({ emailVerified: true })
      .where(eq(schema.users.id, user?.id));
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'boosted-user@x.com', password: 'password123' },
    });
    const { accessToken } = login.json() as { accessToken: string };

    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { phone: '9876543210' }, // email already set at register — this completes the profile
    });
    expect(res.statusCode).toBe(200);

    const [credits] = await app.db
      .select()
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, user?.id));
    expect(credits?.balance).toBe(125); // 100 base * 1.25

    const ledger = await app.db
      .select()
      .from(schema.creditLedger)
      .where(eq(schema.creditLedger.userId, user?.id));
    expect(ledger.some((l) => l.delta === 125 && l.reason === 'FREE_TRIAL')).toBe(true);
  });

  it('grants the plain (non-boosted) FREE_TRIAL amount for a non-attributed user', async () => {
    await app.db
      .update(schema.creditPlans)
      .set({ credits: 100 })
      .where(eq(schema.creditPlans.slug, 'free'));

    await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        displayName: 'Plain Trial User',
        email: 'plain-trial@x.com',
        password: 'password123',
      },
    });
    const [user] = await app.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, 'plain-trial@x.com'));

    await app.db
      .update(schema.users)
      .set({ emailVerified: true })
      .where(eq(schema.users.id, user?.id));
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: 'plain-trial@x.com', password: 'password123' },
    });
    const { accessToken } = login.json() as { accessToken: string };

    await app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { phone: '9876543211' },
    });

    const [credits] = await app.db
      .select()
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, user?.id));
    expect(credits?.balance).toBe(100); // unboosted
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @tryme/api test -- signup-campaign`
Expected: FAIL on the first new test — balance is `100`, not `125` (no boost logic exists yet).

- [ ] **Step 3: Implement the boost**

In `apps/api/src/modules/auth/routes.ts`, the `PATCH /v1/me` handler currently does (around line 640-673):

```ts
        const [updated] = await tx
          .update(schema.users)
          .set({
            ...(displayName !== undefined ? { displayName } : {}),
            ...(email !== undefined ? { email } : {}),
            ...(phone !== undefined ? { phone: phone ?? null } : {}),
            ...(companyName !== undefined ? { companyName: companyName?.trim() || null } : {}),
            ...(defaultResolution !== undefined ? { defaultResolution } : {}),
            ...(defaultAspectRatio !== undefined ? { defaultAspectRatio } : {}),
            ...(defaultPlatform !== undefined ? { defaultPlatform } : {}),
          })
          .where(eq(schema.users.id, req.userId))
          .returning({
            id: schema.users.id,
            email: schema.users.email,
            displayName: schema.users.displayName,
            phone: schema.users.phone,
            companyName: schema.users.companyName,
            tier: schema.users.tier,
            defaultResolution: schema.users.defaultResolution,
            defaultAspectRatio: schema.users.defaultAspectRatio,
            defaultPlatform: schema.users.defaultPlatform,
          });
        if (!updated) throw new AppError('NOT_FOUND', 404, 'user not found');

        const complete = Boolean(updated.phone && /^\d{10}$/.test(updated.phone) && updated.email);
        if (!complete) return updated;

        const [freePlan] = await tx
          .select({ credits: schema.creditPlans.credits })
          .from(schema.creditPlans)
          .where(and(eq(schema.creditPlans.slug, 'free'), eq(schema.creditPlans.isActive, true)));
        const freeCredits = freePlan?.credits ?? 0;
        if (freeCredits <= 0) return updated;
```

Change the `returning()` call to also select `signupCampaignId`, and boost `freeCredits` when it's set:

```ts
        const [updated] = await tx
          .update(schema.users)
          .set({
            ...(displayName !== undefined ? { displayName } : {}),
            ...(email !== undefined ? { email } : {}),
            ...(phone !== undefined ? { phone: phone ?? null } : {}),
            ...(companyName !== undefined ? { companyName: companyName?.trim() || null } : {}),
            ...(defaultResolution !== undefined ? { defaultResolution } : {}),
            ...(defaultAspectRatio !== undefined ? { defaultAspectRatio } : {}),
            ...(defaultPlatform !== undefined ? { defaultPlatform } : {}),
          })
          .where(eq(schema.users.id, req.userId))
          .returning({
            id: schema.users.id,
            email: schema.users.email,
            displayName: schema.users.displayName,
            phone: schema.users.phone,
            companyName: schema.users.companyName,
            tier: schema.users.tier,
            defaultResolution: schema.users.defaultResolution,
            defaultAspectRatio: schema.users.defaultAspectRatio,
            defaultPlatform: schema.users.defaultPlatform,
            signupCampaignId: schema.users.signupCampaignId,
          });
        if (!updated) throw new AppError('NOT_FOUND', 404, 'user not found');

        const complete = Boolean(updated.phone && /^\d{10}$/.test(updated.phone) && updated.email);
        if (!complete) return updated;

        const [freePlan] = await tx
          .select({ credits: schema.creditPlans.credits })
          .from(schema.creditPlans)
          .where(and(eq(schema.creditPlans.slug, 'free'), eq(schema.creditPlans.isActive, true)));
        let freeCredits = freePlan?.credits ?? 0;
        if (freeCredits > 0 && updated.signupCampaignId) {
          const [campaign] = await tx
            .select({ bonusPercent: schema.signupCampaigns.bonusPercent })
            .from(schema.signupCampaigns)
            .where(eq(schema.signupCampaigns.id, updated.signupCampaignId));
          if (campaign) {
            freeCredits = Math.round(freeCredits * (1 + campaign.bonusPercent / 100));
          }
        }
        if (freeCredits <= 0) return updated;
```

The rest of the block (the `creditLedger`/`userCredits` insert with `reason: 'FREE_TRIAL'`) is unchanged — it already just uses the `freeCredits` variable, which is now the boosted value when applicable.

- [ ] **Step 4: Run the tests again to verify they pass**

Run: `pnpm --filter @tryme/api test -- signup-campaign`
Expected: PASS, 7 tests total.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/auth/routes.ts apps/api/test/integration/signup-campaign.test.ts
git commit -m "feat(api): boost FREE_TRIAL grant by campaign bonusPercent"
```

---

## Task 6: Google OAuth — thread `src` through to attribution

**Files:**
- Modify: `apps/api/src/modules/auth/google.routes.ts:27-129` (init + callback)
- Modify: `apps/api/src/modules/auth/google-upsert.ts` (`resolveFreeCredits`, `upsertGoogleUser`)
- Test: `apps/api/test/integration/google-oauth.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to the `describe('google oauth', ...)` block in `apps/api/test/integration/google-oauth.test.ts` (it already imports `schema as dbSchema`, `eq`, and has the `mockFetch`-style pattern used below):

```ts
  it('attributes a brand-new Google signup to the campaign when ?src= is threaded through init -> callback', async () => {
    const now = new Date();
    await app.db.insert(dbSchema.signupCampaigns).values({
      code: 'gartex2026',
      name: 'Gartex Expo Delhi 2026',
      bonusPercent: 25,
      startAt: new Date(now.getTime() - 86_400_000),
      endAt: new Date(now.getTime() + 86_400_000),
      isActive: true,
    });

    const initRes = await app.inject({
      method: 'GET',
      url: '/v1/auth/google/init?src=gartex2026',
    });
    expect(initRes.statusCode).toBe(302);
    const initCookies = Array.isArray(initRes.headers['set-cookie'])
      ? initRes.headers['set-cookie']
      : [initRes.headers['set-cookie'] as string];
    const stateCookie = initCookies.find((c) => c.startsWith('google_state='));
    const srcCookie = initCookies.find((c) => c.startsWith('google_src='));
    expect(srcCookie).toBeTruthy();
    const state = stateCookie?.split(';')[0]?.split('=')[1];
    const encodedSrc = srcCookie?.split(';')[0]?.split('=')[1];

    const mockFetch = async (url: string | URL | Request): Promise<Response> => {
      const urlStr = url.toString();
      if (urlStr.includes('oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'mock-token' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (urlStr.includes('googleapis.com/oauth2/v3/userinfo')) {
        return new Response(
          JSON.stringify({
            sub: 'google-sub-campaign-001',
            email: 'gartex-google-user@example.com',
            name: 'Gartex Google User',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected fetch to: ${urlStr}`);
    };
    vi.spyOn(global, 'fetch').mockImplementation(mockFetch as typeof fetch);

    const callbackRes = await app.inject({
      method: 'GET',
      url: `/v1/auth/google/callback?code=auth_code_campaign&state=${state}`,
      headers: { cookie: `google_state=${state}; google_src=${encodedSrc}` },
    });
    expect(callbackRes.statusCode).toBe(302);

    const [user] = await app.db
      .select({ id: dbSchema.users.id, signupCampaignId: dbSchema.users.signupCampaignId })
      .from(dbSchema.users)
      .where(eq(dbSchema.users.email, 'gartex-google-user@example.com'));
    expect(user).toBeTruthy();
    expect(user?.signupCampaignId).toBeTruthy();

    const [campaign] = await app.db
      .select()
      .from(dbSchema.signupCampaigns)
      .where(eq(dbSchema.signupCampaigns.code, 'gartex2026'));
    expect(user?.signupCampaignId).toBe(campaign?.id);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @tryme/api test -- google-oauth`
Expected: FAIL — `google_src` cookie is never set by `/init` (doesn't exist yet), so `srcCookie` is `undefined` and the test throws before reaching the assertions.

- [ ] **Step 3: Update `google.routes.ts`**

In `apps/api/src/modules/auth/google.routes.ts`, add the import:

```ts
import { resolveFreeCredits, upsertGoogleUser } from './google-upsert.js';
```

becomes:

```ts
import { resolveCampaignId } from './campaign.js';
import { resolveFreeCredits, upsertGoogleUser } from './google-upsert.js';
```

The `/init` handler currently reads (around line 27-63):

```ts
  app.get('/v1/auth/google/init', async (req, reply) => {
    reply.header('Cross-Origin-Opener-Policy', 'unsafe-none');
    const { next } = req.query as { next?: string };
    const state = randomBytes(32).toString('base64url');
    reply.setCookie('google_state', state, {
      httpOnly: true,
      secure: app.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/v1/auth/google',
      maxAge: 300,
      signed: false,
    });
    if (next) {
      reply.setCookie('google_next', encodeURIComponent(next), {
        httpOnly: true,
        secure: app.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/v1/auth/google',
        maxAge: 300,
        signed: false,
      });
    }
```

Add a `src` cookie the same way, mirroring `google_next` exactly:

```ts
  app.get('/v1/auth/google/init', async (req, reply) => {
    reply.header('Cross-Origin-Opener-Policy', 'unsafe-none');
    const { next, src } = req.query as { next?: string; src?: string };
    const state = randomBytes(32).toString('base64url');
    reply.setCookie('google_state', state, {
      httpOnly: true,
      secure: app.env.NODE_ENV === 'production',
      sameSite: 'lax',
      path: '/v1/auth/google',
      maxAge: 300,
      signed: false,
    });
    if (next) {
      reply.setCookie('google_next', encodeURIComponent(next), {
        httpOnly: true,
        secure: app.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/v1/auth/google',
        maxAge: 300,
        signed: false,
      });
    }
    if (src) {
      reply.setCookie('google_src', encodeURIComponent(src), {
        httpOnly: true,
        secure: app.env.NODE_ENV === 'production',
        sameSite: 'lax',
        path: '/v1/auth/google',
        maxAge: 300,
        signed: false,
      });
    }
```

The `/callback` handler currently reads (around line 66-129):

```ts
  app.get('/v1/auth/google/callback', async (req, reply) => {
    reply.header('Cross-Origin-Opener-Policy', 'unsafe-none');
    const { code, state } = req.query as { code?: string; state?: string };
    const storedState = req.cookies.google_state;
    const next = req.cookies.google_next ? decodeURIComponent(req.cookies.google_next) : undefined;

    if (!code || !state || !storedState || state !== storedState) {
      throw new AppError('INVALID_STATE', 400, 'invalid OAuth state');
    }

    reply.clearCookie('google_state', { path: '/v1/auth/google' });
    if (next) reply.clearCookie('google_next', { path: '/v1/auth/google' });
```

and further down:

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

Change both:

```ts
  app.get('/v1/auth/google/callback', async (req, reply) => {
    reply.header('Cross-Origin-Opener-Policy', 'unsafe-none');
    const { code, state } = req.query as { code?: string; state?: string };
    const storedState = req.cookies.google_state;
    const next = req.cookies.google_next ? decodeURIComponent(req.cookies.google_next) : undefined;
    const src = req.cookies.google_src ? decodeURIComponent(req.cookies.google_src) : undefined;

    if (!code || !state || !storedState || state !== storedState) {
      throw new AppError('INVALID_STATE', 400, 'invalid OAuth state');
    }

    reply.clearCookie('google_state', { path: '/v1/auth/google' });
    if (next) reply.clearCookie('google_next', { path: '/v1/auth/google' });
    if (src) reply.clearCookie('google_src', { path: '/v1/auth/google' });
```

and:

```ts
    const campaignId = await resolveCampaignId(app, src);
    const freeCredits = await resolveFreeCredits(app, campaignId);
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
        campaignId,
      ),
    );
```

- [ ] **Step 4: Update `google-upsert.ts`**

In `apps/api/src/modules/auth/google-upsert.ts`, `resolveFreeCredits` currently reads:

```ts
/** Credits granted to a brand-new account, from the active `free` credit plan. */
export async function resolveFreeCredits(app: FastifyInstance): Promise<number> {
  const [plan] = await app.db
    .select({ credits: schema.creditPlans.credits })
    .from(schema.creditPlans)
    .where(and(eq(schema.creditPlans.slug, 'free'), eq(schema.creditPlans.isActive, true)));
  return plan?.credits ?? 0;
}
```

Change to:

```ts
/**
 * Credits granted to a brand-new account, from the active `free` credit plan --
 * boosted by campaignId's bonusPercent if the signup is campaign-attributed.
 * campaignId is null for the native Android device-login route (no QR concept
 * there) and for any signup that didn't carry a matching ?src=.
 */
export async function resolveFreeCredits(
  app: FastifyInstance,
  campaignId: string | null = null,
): Promise<number> {
  const [plan] = await app.db
    .select({ credits: schema.creditPlans.credits })
    .from(schema.creditPlans)
    .where(and(eq(schema.creditPlans.slug, 'free'), eq(schema.creditPlans.isActive, true)));
  const baseCredits = plan?.credits ?? 0;
  if (baseCredits <= 0 || !campaignId) return baseCredits;

  const [campaign] = await app.db
    .select({ bonusPercent: schema.signupCampaigns.bonusPercent })
    .from(schema.signupCampaigns)
    .where(eq(schema.signupCampaigns.id, campaignId));
  if (!campaign) return baseCredits;

  return Math.round(baseCredits * (1 + campaign.bonusPercent / 100));
}
```

Then `upsertGoogleUser` currently reads:

```ts
export async function upsertGoogleUser(
  tx: DbOrTx,
  googleUser: GoogleIdentity,
  freeCredits: number,
): Promise<string> {
```

and, in the brand-new-account branch:

```ts
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
```

Change to:

```ts
export async function upsertGoogleUser(
  tx: DbOrTx,
  googleUser: GoogleIdentity,
  freeCredits: number,
  campaignId: string | null = null,
): Promise<string> {
```

and:

```ts
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
        signupCampaignId: campaignId,
      })
      .returning({ id: schema.users.id });
```

The default `= null` on both functions means the two other call sites — `/v1/auth/device-login/google` (`apps/api/src/modules/auth/routes.ts:898-899`, the native Android route, which has no `src`/QR concept) — need **no code change** and keep today's behavior exactly.

- [ ] **Step 5: Run the tests again to verify they pass**

Run: `pnpm --filter @tryme/api test -- google-oauth`
Expected: PASS, all tests including the new one.

- [ ] **Step 6: Run the broader auth suite to check for regressions**

Run: `pnpm --filter @tryme/api test -- auth`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/auth/google.routes.ts apps/api/src/modules/auth/google-upsert.ts apps/api/test/integration/google-oauth.test.ts
git commit -m "feat(api): thread QR campaign attribution through Google OAuth signup"
```

---

## Task 7: First-purchase campaign bonus

**Files:**
- Modify: `apps/api/src/modules/payments/routes.ts`
- Test: `apps/api/test/integration/payments-tier.test.ts` (append)

- [ ] **Step 1: Write the failing test**

Append to the `describe('payments -> tier promotion', ...)` block in `apps/api/test/integration/payments-tier.test.ts` (it already has `registerUser`, `seedPlan`, `seedPendingPayment`, and `signature` helpers defined — reuse them):

```ts
  async function seedCampaign(overrides: Partial<{ code: string; bonusPercent: number }> = {}) {
    const now = new Date();
    const [campaign] = await app.db
      .insert(schema.signupCampaigns)
      .values({
        code: overrides.code ?? 'gartex2026',
        name: 'Gartex Expo Delhi 2026',
        bonusPercent: overrides.bonusPercent ?? 25,
        startAt: new Date(now.getTime() - 86_400_000),
        endAt: new Date(now.getTime() + 86_400_000),
        isActive: true,
      })
      .returning();
    return campaign;
  }

  it('grants a 25% CAMPAIGN_BONUS on top of PAYMENT for a campaign-attributed user\'s first purchase', async () => {
    const campaign = await seedCampaign({ code: 'purchase-bonus-1' });
    const { token, userId } = await registerUser('campaign-purchase@x.com');
    await app.db
      .update(schema.users)
      .set({ signupCampaignId: campaign?.id })
      .where(eq(schema.users.id, userId));

    const plan = await seedPlan('campaign-bonus-plan');
    const orderId = 'order_campaign_bonus_1';
    await seedPendingPayment({
      userId,
      planId: plan?.slug,
      razorpayOrderId: orderId,
      credits: 1000,
    });

    const paymentId = 'pay_campaign_bonus_1';
    const res = await app.inject({
      method: 'POST',
      url: '/v1/payments/verify',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        razorpayOrderId: orderId,
        razorpayPaymentId: paymentId,
        razorpaySignature: signature(orderId, paymentId),
      },
    });
    expect(res.statusCode).toBe(200);

    const [credits] = await app.db
      .select()
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, userId));
    expect(credits?.balance).toBe(1250); // 1000 PAYMENT + 250 CAMPAIGN_BONUS (25%)

    const ledger = await app.db
      .select()
      .from(schema.creditLedger)
      .where(eq(schema.creditLedger.userId, userId));
    expect(ledger.some((l) => l.delta === 1000 && l.reason === 'PAYMENT')).toBe(true);
    expect(ledger.some((l) => l.delta === 250 && l.reason === 'CAMPAIGN_BONUS')).toBe(true);
  });

  it('does not grant a second CAMPAIGN_BONUS on a campaign-attributed user\'s second purchase', async () => {
    const campaign = await seedCampaign({ code: 'purchase-bonus-2' });
    const { token, userId } = await registerUser('campaign-second-purchase@x.com');
    await app.db
      .update(schema.users)
      .set({ signupCampaignId: campaign?.id })
      .where(eq(schema.users.id, userId));

    const plan = await seedPlan('campaign-bonus-plan-2');

    const firstOrderId = 'order_second_purchase_first';
    await seedPendingPayment({
      userId,
      planId: plan?.slug,
      razorpayOrderId: firstOrderId,
      credits: 500,
    });
    await app.inject({
      method: 'POST',
      url: '/v1/payments/verify',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        razorpayOrderId: firstOrderId,
        razorpayPaymentId: 'pay_second_purchase_first',
        razorpaySignature: signature(firstOrderId, 'pay_second_purchase_first'),
      },
    });

    const secondOrderId = 'order_second_purchase_second';
    await seedPendingPayment({
      userId,
      planId: plan?.slug,
      razorpayOrderId: secondOrderId,
      credits: 500,
    });
    await app.inject({
      method: 'POST',
      url: '/v1/payments/verify',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        razorpayOrderId: secondOrderId,
        razorpayPaymentId: 'pay_second_purchase_second',
        razorpaySignature: signature(secondOrderId, 'pay_second_purchase_second'),
      },
    });

    const ledger = await app.db
      .select()
      .from(schema.creditLedger)
      .where(eq(schema.creditLedger.userId, userId));
    const bonusEntries = ledger.filter((l) => l.reason === 'CAMPAIGN_BONUS');
    expect(bonusEntries).toHaveLength(1);
    expect(bonusEntries[0]?.delta).toBe(125); // 25% of the FIRST purchase's 500 credits only

    const [credits] = await app.db
      .select()
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, userId));
    expect(credits?.balance).toBe(1125); // 500 + 500 + 125
  });

  it('grants no CAMPAIGN_BONUS for a non-attributed user\'s purchase', async () => {
    const { token, userId } = await registerUser('no-campaign-purchase@x.com');
    const plan = await seedPlan('no-campaign-plan');
    const orderId = 'order_no_campaign_1';
    await seedPendingPayment({
      userId,
      planId: plan?.slug,
      razorpayOrderId: orderId,
      credits: 800,
    });

    await app.inject({
      method: 'POST',
      url: '/v1/payments/verify',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        razorpayOrderId: orderId,
        razorpayPaymentId: 'pay_no_campaign_1',
        razorpaySignature: signature(orderId, 'pay_no_campaign_1'),
      },
    });

    const [credits] = await app.db
      .select()
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, userId));
    expect(credits?.balance).toBe(800);

    const ledger = await app.db
      .select()
      .from(schema.creditLedger)
      .where(eq(schema.creditLedger.userId, userId));
    expect(ledger.some((l) => l.reason === 'CAMPAIGN_BONUS')).toBe(false);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @tryme/api test -- payments-tier`
Expected: FAIL on the first two new tests — balance is `1000`/`1125` short of the expected bonus, and no `CAMPAIGN_BONUS` ledger rows exist.

- [ ] **Step 3: Extract the shared grant helper and add the bonus logic**

In `apps/api/src/modules/payments/routes.ts`, add a type alias and the helper function right after the existing `maybeSendReceipt` function (before `export async function paymentsRoutes`):

```ts
type DbOrTx = Parameters<Parameters<FastifyInstance['db']['transaction']>[0]>[0];

// Credits `payment.credits` (the base plan grant) plus, for a campaign-attributed
// user's first successful purchase, a CAMPAIGN_BONUS ledger row on top. Shared by
// /verify and the webhook handler so the two credit-grant paths can't drift.
async function grantPurchaseCredits(
  tx: DbOrTx,
  userId: string,
  payment: { id: string; credits: number },
): Promise<void> {
  await tx
    .insert(schema.userCredits)
    .values({ userId, balance: payment.credits })
    .onConflictDoUpdate({
      target: schema.userCredits.userId,
      set: {
        balance: sql`${schema.userCredits.balance} + ${payment.credits}`,
        updatedAt: new Date(),
      },
    });

  await tx.insert(schema.creditLedger).values({
    userId,
    delta: payment.credits,
    reason: 'PAYMENT',
    adminId: null,
  });

  const [priorPaid] = await tx
    .select({ id: schema.payments.id })
    .from(schema.payments)
    .where(
      and(
        eq(schema.payments.userId, userId),
        eq(schema.payments.status, 'paid'),
        ne(schema.payments.id, payment.id),
      ),
    )
    .limit(1);
  if (priorPaid) return; // not their first purchase — no campaign bonus

  const [user] = await tx
    .select({ campaignId: schema.users.signupCampaignId })
    .from(schema.users)
    .where(eq(schema.users.id, userId));
  if (!user?.campaignId) return;

  const [campaign] = await tx
    .select({ bonusPercent: schema.signupCampaigns.bonusPercent })
    .from(schema.signupCampaigns)
    .where(eq(schema.signupCampaigns.id, user.campaignId));
  if (!campaign) return;

  const bonus = Math.round(payment.credits * (campaign.bonusPercent / 100));
  if (bonus <= 0) return;

  await tx
    .update(schema.userCredits)
    .set({ balance: sql`${schema.userCredits.balance} + ${bonus}`, updatedAt: new Date() })
    .where(eq(schema.userCredits.userId, userId));

  await tx.insert(schema.creditLedger).values({
    userId,
    delta: bonus,
    reason: 'CAMPAIGN_BONUS',
  });
}
```

Now replace the two duplicated grant blocks with calls to this helper.

In `/v1/payments/verify`, this block (currently `apps/api/src/modules/payments/routes.ts:238-254`):

```ts
        credited = true;

        await tx
          .insert(schema.userCredits)
          .values({ userId: req.userId, balance: payment.credits })
          .onConflictDoUpdate({
            target: schema.userCredits.userId,
            set: {
              balance: sql`${schema.userCredits.balance} + ${payment.credits}`,
              updatedAt: new Date(),
            },
          });

        await tx.insert(schema.creditLedger).values({
          userId: req.userId,
          delta: payment.credits,
          reason: 'PAYMENT',
          adminId: null,
        });

        // Promote the user's tier to this plan's slug so job queue priority kicks in.
```

becomes:

```ts
        credited = true;

        await grantPurchaseCredits(tx, req.userId, payment);

        // Promote the user's tier to this plan's slug so job queue priority kicks in.
```

In the webhook handler, this block (currently `apps/api/src/modules/payments/routes.ts:375-393`):

```ts
          webhookCredited = true;

          await tx
            .insert(schema.userCredits)
            .values({ userId: payment.userId, balance: payment.credits })
            .onConflictDoUpdate({
              target: schema.userCredits.userId,
              set: {
                balance: sql`${schema.userCredits.balance} + ${payment.credits}`,
                updatedAt: new Date(),
              },
            });

          await tx.insert(schema.creditLedger).values({
            userId: payment.userId,
            delta: payment.credits,
            reason: 'PAYMENT',
            adminId: null,
          });

          await tx
```

becomes:

```ts
          webhookCredited = true;

          await grantPurchaseCredits(tx, payment.userId, payment);

          await tx
```

- [ ] **Step 4: Run the tests again to verify they pass**

Run: `pnpm --filter @tryme/api test -- payments-tier`
Expected: PASS, all tests including the 3 new ones.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/payments/routes.ts apps/api/test/integration/payments-tier.test.ts
git commit -m "feat(api): grant a first-purchase CAMPAIGN_BONUS for QR-attributed users"
```

---

## Task 8: Admin CRUD for signup campaigns

**Files:**
- Create: `apps/api/src/modules/admin/signupCampaigns.routes.ts`
- Modify: `apps/api/src/server.ts`
- Test: `apps/api/test/integration/signup-campaigns-admin.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/integration/signup-campaigns-admin.test.ts`:

```ts
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from '../helpers/api';
import { type Containers, startContainers } from '../helpers/containers';

describe('signup-campaigns admin CRUD', () => {
  let c: Containers;
  let app: TestApp;
  let adminToken: string;

  beforeAll(async () => {
    c = await startContainers();
    app = await buildTestApp(c);

    await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        displayName: 'Campaigns Admin',
        email: 'campaigns-admin@x.com',
        password: 'password123',
      },
    });
    const [user] = await app.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, 'campaigns-admin@x.com'));
    const userId = user?.id;
    await app.db
      .update(schema.users)
      .set({ emailVerified: true })
      .where(eq(schema.users.id, userId));
    await app.db.insert(schema.adminUsers).values({
      userId,
      role: 'SUPER_ADMIN',
      passwordHash: user?.passwordHash,
    });

    const loginRes = await app.inject({
      method: 'POST',
      url: '/admin/auth/login',
      payload: { email: 'campaigns-admin@x.com', password: 'password123' },
    });
    adminToken = loginRes.json().accessToken;
  }, 60000);

  afterAll(async () => {
    await app?.close();
    await c?.stop();
  });

  function authed(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) {
    return app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${adminToken}` },
      payload,
    });
  }

  it('creates, lists, updates, and deletes a campaign', async () => {
    const created = await authed('POST', '/admin/signup-campaigns', {
      code: 'crud-test-1',
      name: 'CRUD Test Campaign',
      bonusPercent: 25,
      startAt: '2026-08-06T00:00:00.000Z',
      endAt: '2026-08-08T23:59:59.000Z',
      isActive: true,
    });
    expect(created.statusCode).toBe(200);
    const campaign = created.json();
    expect(campaign.code).toBe('crud-test-1');
    expect(campaign.bonusPercent).toBe(25);

    const list = await authed('GET', '/admin/signup-campaigns');
    expect(list.statusCode).toBe(200);
    expect(list.json().some((c: { id: string }) => c.id === campaign.id)).toBe(true);

    const updated = await authed('PATCH', `/admin/signup-campaigns/${campaign.id}`, {
      bonusPercent: 30,
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().bonusPercent).toBe(30);

    const deleted = await authed('DELETE', `/admin/signup-campaigns/${campaign.id}`);
    expect(deleted.statusCode).toBe(204);
  });

  it('rejects a window where endAt is before startAt (400)', async () => {
    const res = await authed('POST', '/admin/signup-campaigns', {
      code: 'bad-window',
      name: 'Bad Window',
      bonusPercent: 25,
      startAt: '2026-08-08T00:00:00.000Z',
      endAt: '2026-08-06T00:00:00.000Z',
      isActive: true,
    });
    expect(res.statusCode).toBe(400);
  });

  it('blocks deleting a campaign that a user is attributed to (409)', async () => {
    const created = await authed('POST', '/admin/signup-campaigns', {
      code: 'attributed-delete-test',
      name: 'Attributed Delete Test',
      bonusPercent: 25,
      startAt: '2026-08-06T00:00:00.000Z',
      endAt: '2026-08-08T23:59:59.000Z',
      isActive: true,
    });
    const campaign = created.json();

    await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        displayName: 'Attributed User',
        email: 'attributed-delete-user@x.com',
        password: 'password123',
      },
    });
    const [user] = await app.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, 'attributed-delete-user@x.com'));
    await app.db
      .update(schema.users)
      .set({ signupCampaignId: campaign.id })
      .where(eq(schema.users.id, user?.id));

    const delRes = await authed('DELETE', `/admin/signup-campaigns/${campaign.id}`);
    expect(delRes.statusCode).toBe(409);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @tryme/api test -- signup-campaigns-admin`
Expected: FAIL — 404s, since `/admin/signup-campaigns` doesn't exist yet.

- [ ] **Step 3: Create the admin routes module**

Create `apps/api/src/modules/admin/signupCampaigns.routes.ts`:

```ts
import { schema } from '@tryme/db';
import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { requireAdmin } from './guard.js';

const CampaignBody = z.object({
  code: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/, 'code must be lowercase letters, numbers, hyphens only'),
  name: z.string().min(1).max(100),
  bonusPercent: z.number().int().min(0).max(100),
  startAt: z.coerce.date(),
  endAt: z.coerce.date(),
  isActive: z.boolean().default(true),
});

export async function adminSignupCampaignsRoutes(app: FastifyInstance) {
  const W = requireAdmin(['SUPER_ADMIN']);

  app.get('/admin/signup-campaigns', { preHandler: W }, async () => {
    return app.db
      .select()
      .from(schema.signupCampaigns)
      .orderBy(asc(schema.signupCampaigns.createdAt));
  });

  app.post(
    '/admin/signup-campaigns',
    { preHandler: W, schema: { body: CampaignBody } },
    async (req) => {
      const body = req.body as z.infer<typeof CampaignBody>;
      if (body.endAt <= body.startAt) {
        throw new AppError('INVALID_WINDOW', 400, 'endAt must be after startAt');
      }
      const [campaign] = await app.db.insert(schema.signupCampaigns).values(body).returning();
      return campaign;
    },
  );

  app.patch(
    '/admin/signup-campaigns/:id',
    {
      preHandler: W,
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: CampaignBody.partial(),
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const body = req.body as Partial<z.infer<typeof CampaignBody>>;
      const [existing] = await app.db
        .select()
        .from(schema.signupCampaigns)
        .where(eq(schema.signupCampaigns.id, id));
      if (!existing) throw new AppError('NOT_FOUND', 404, 'campaign not found');

      const nextStart = body.startAt ?? existing.startAt;
      const nextEnd = body.endAt ?? existing.endAt;
      if (nextEnd <= nextStart) {
        throw new AppError('INVALID_WINDOW', 400, 'endAt must be after startAt');
      }

      const [campaign] = await app.db
        .update(schema.signupCampaigns)
        .set({ ...body, updatedAt: new Date() })
        .where(eq(schema.signupCampaigns.id, id))
        .returning();
      if (!campaign) throw new AppError('NOT_FOUND', 404, 'campaign not found');
      return campaign;
    },
  );

  app.delete(
    '/admin/signup-campaigns/:id',
    { preHandler: W, schema: { params: z.object({ id: z.string().uuid() }) } },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const [campaign] = await app.db
        .select({ id: schema.signupCampaigns.id })
        .from(schema.signupCampaigns)
        .where(eq(schema.signupCampaigns.id, id));
      if (!campaign) throw new AppError('NOT_FOUND', 404, 'campaign not found');

      const [attributedUser] = await app.db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.signupCampaignId, id))
        .limit(1);
      if (attributedUser) {
        throw new AppError(
          'CONFLICT',
          409,
          'campaign has users attributed to it; deactivate instead of deleting',
        );
      }

      await app.db.delete(schema.signupCampaigns).where(eq(schema.signupCampaigns.id, id));
      reply.code(204).send();
    },
  );
}
```

- [ ] **Step 4: Register the module in `server.ts`**

In `apps/api/src/server.ts`, add the import — alphabetically it sorts between `shopify-funnels.routes.js` and `subcategories.routes.js`:

```ts
import { adminShopifyFunnelsRoutes } from './modules/admin/shopify-funnels.routes.js';
import { adminGarmentTypesRoutes } from './modules/admin/subcategories.routes.js';
```

becomes:

```ts
import { adminShopifyFunnelsRoutes } from './modules/admin/shopify-funnels.routes.js';
import { adminSignupCampaignsRoutes } from './modules/admin/signupCampaigns.routes.js';
import { adminGarmentTypesRoutes } from './modules/admin/subcategories.routes.js';
```

And register it next to the other credit-related admin routes:

```ts
  await app.register(adminCreditsRoutes);
  await app.register(adminCreditPlansRoutes);
  await app.register(adminCreditAnalysisRoutes);
```

becomes:

```ts
  await app.register(adminCreditsRoutes);
  await app.register(adminCreditPlansRoutes);
  await app.register(adminCreditAnalysisRoutes);
  await app.register(adminSignupCampaignsRoutes);
```

- [ ] **Step 5: Run the tests again to verify they pass**

Run: `pnpm --filter @tryme/api test -- signup-campaigns-admin`
Expected: PASS, 3 tests.

- [ ] **Step 6: Run the full API test suite**

Run: `pnpm --filter @tryme/api test`
Expected: PASS, no regressions anywhere.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/admin/signupCampaigns.routes.ts apps/api/src/server.ts apps/api/test/integration/signup-campaigns-admin.test.ts
git commit -m "feat(api): admin CRUD for signup campaigns"
```

---

## Task 9: Admin-web UI — Signup Campaigns tab

`apps/admin-web` has no test runner (per `CLAUDE.md` — confirmed zero workspace-package deps, no test script). Verification for this task is `tsc -b` (via the `build` script) plus manual smoke-check instructions at the end.

**Files:**
- Modify: `apps/admin-web/src/types.ts`
- Modify: `apps/admin-web/src/pages/SettingsPage.tsx`

- [ ] **Step 1: Add the `SignupCampaign` type**

In `apps/admin-web/src/types.ts`, right after the `CreditPlan` interface (currently ending at line 328):

```ts
export interface CreditPlan {
  id: string;
  slug: string;
  name: string;
  subtext: string;
  credits: number;
  basePaise: number;
  isActive: boolean;
  isHighlighted: boolean;
  badge: string | null;
  sortOrder: number;
  queueStream: 'priority' | 'normal' | 'low';
  watermark: boolean;
  createdAt: string;
  updatedAt: string;
}
```

Add directly below it:

```ts
export interface SignupCampaign {
  id: string;
  code: string;
  name: string;
  bonusPercent: number;
  startAt: string;
  endAt: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}
```

- [ ] **Step 2: Import the type in `SettingsPage.tsx`**

Change:

```ts
import type { CreditPlan } from '../types';
```

to:

```ts
import type { CreditPlan, SignupCampaign } from '../types';
```

- [ ] **Step 3: Add the new tab to the section list**

Change:

```ts
type SettingsSection = 'appearance' | 'notifications' | 'credit-plans' | 'system' | 'session';
```

to:

```ts
type SettingsSection =
  | 'appearance'
  | 'notifications'
  | 'credit-plans'
  | 'signup-campaigns'
  | 'system'
  | 'session';
```

Change:

```ts
const SETTING_SECTIONS: { k: SettingsSection; label: string }[] = [
  { k: 'appearance', label: 'Appearance' },
  { k: 'notifications', label: 'Notifications' },
  { k: 'credit-plans', label: 'Credit Plans' },
  { k: 'system', label: 'System' },
  { k: 'session', label: 'Session' },
];
```

to:

```ts
const SETTING_SECTIONS: { k: SettingsSection; label: string }[] = [
  { k: 'appearance', label: 'Appearance' },
  { k: 'notifications', label: 'Notifications' },
  { k: 'credit-plans', label: 'Credit Plans' },
  { k: 'signup-campaigns', label: 'Signup Campaigns' },
  { k: 'system', label: 'System' },
  { k: 'session', label: 'Session' },
];
```

- [ ] **Step 4: Add the `CampaignModal` component**

Directly after the `PlanModal` function's closing brace (currently ending at line 374, right before `export default function SettingsPage(...)`), insert:

```ts
const EMPTY_CAMPAIGN_FORM = {
  code: '',
  name: '',
  bonusPercent: 25,
  startAt: '',
  endAt: '',
  isActive: true,
};

// "2026-08-06T00:00:00.000Z" -> "2026-08-06T00:00" for <input type="datetime-local">
function toDatetimeLocal(iso: string): string {
  return iso.slice(0, 16);
}

function CampaignModal({
  campaign,
  onSaved,
  onClose,
  toast,
}: {
  campaign: SignupCampaign | null;
  onSaved: (c: SignupCampaign) => void;
  onClose: () => void;
  toast: Props['toast'];
}) {
  const [form, setForm] = useState(
    campaign
      ? {
          code: campaign.code,
          name: campaign.name,
          bonusPercent: campaign.bonusPercent,
          startAt: toDatetimeLocal(campaign.startAt),
          endAt: toDatetimeLocal(campaign.endAt),
          isActive: campaign.isActive,
        }
      : EMPTY_CAMPAIGN_FORM,
  );
  const [saving, setSaving] = useState(false);

  const set = <K extends keyof typeof form>(k: K, v: (typeof form)[K]) =>
    setForm((f) => ({ ...f, [k]: v }));

  const handleSave = async () => {
    setSaving(true);
    try {
      const body = {
        ...form,
        startAt: new Date(form.startAt).toISOString(),
        endAt: new Date(form.endAt).toISOString(),
      };
      const saved = campaign
        ? await apiFetch<SignupCampaign>(`/admin/signup-campaigns/${campaign.id}`, {
            method: 'PATCH',
            body: JSON.stringify(body),
          })
        : await apiFetch<SignupCampaign>('/admin/signup-campaigns', {
            method: 'POST',
            body: JSON.stringify(body),
          });
      onSaved(saved);
      toast({ title: campaign ? `${saved.name} updated` : `${saved.name} created` });
      onClose();
    } catch (err) {
      toast({
        kind: 'error',
        title: campaign ? 'Failed to update campaign' : 'Failed to create campaign',
        body: apiErrorMessage(err, 'Please try again.'),
      });
    } finally {
      setSaving(false);
    }
  };

  const valid =
    form.code.trim().length > 0 &&
    form.name.trim().length > 0 &&
    form.bonusPercent >= 0 &&
    form.bonusPercent <= 100 &&
    form.startAt.length > 0 &&
    form.endAt.length > 0 &&
    new Date(form.endAt) > new Date(form.startAt);

  return (
    <div className="modal-overlay" onClick={saving ? undefined : onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h2>{campaign ? 'Edit campaign' : 'Add campaign'}</h2>
          <button
            className="btn sm ghost"
            onClick={onClose}
            disabled={saving}
            style={{ marginLeft: 'auto' }}
          >
            <Icon.Close />
          </button>
        </div>

        <div className="drawer-body" style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div style={{ display: 'flex', gap: 16 }}>
            <div className="field" style={{ flex: 1 }}>
              <label>Code</label>
              <input
                className="input"
                value={form.code}
                disabled={saving || !!campaign}
                placeholder="e.g. gartex2026"
                onChange={(e) =>
                  set('code', e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))
                }
              />
              {!campaign && (
                <span style={{ fontSize: 11, color: 'var(--muted)' }}>
                  Matches the ?src= value on the signup link. Cannot change later.
                </span>
              )}
            </div>
            <div className="field" style={{ flex: 1.5 }}>
              <label>Name</label>
              <input
                className="input"
                value={form.name}
                disabled={saving}
                placeholder="e.g. Gartex Expo Delhi 2026"
                onChange={(e) => set('name', e.target.value)}
              />
            </div>
          </div>

          <div className="field">
            <label>Bonus % (applied to first purchase and signup free credits)</label>
            <input
              className="input"
              type="number"
              min={0}
              max={100}
              value={form.bonusPercent}
              disabled={saving}
              onChange={(e) => set('bonusPercent', Number(e.target.value))}
            />
          </div>

          <div style={{ display: 'flex', gap: 16 }}>
            <div className="field" style={{ flex: 1 }}>
              <label>Starts</label>
              <input
                className="input"
                type="datetime-local"
                value={form.startAt}
                disabled={saving}
                onChange={(e) => set('startAt', e.target.value)}
              />
            </div>
            <div className="field" style={{ flex: 1 }}>
              <label>Ends</label>
              <input
                className="input"
                type="datetime-local"
                value={form.endAt}
                disabled={saving}
                onChange={(e) => set('endAt', e.target.value)}
              />
            </div>
          </div>

          <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Switch checked={form.isActive} onChange={(v) => set('isActive', v)} disabled={saving} />
            Active
          </label>
        </div>

        <div className="drawer-foot">
          <button className="btn ghost" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button className="btn primary" onClick={handleSave} disabled={saving || !valid}>
            {saving ? 'Saving…' : campaign ? 'Save changes' : 'Create campaign'}
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Add state, load effect, and handlers inside `SettingsPage`**

Right after the existing plan-related state (currently ending at line 437):

```ts
  const [confirmDelete, setConfirmDelete] = useState<CreditPlan | null>(null);
  const [deleting, setDeleting] = useState(false);
```

add:

```ts
  const [confirmDelete, setConfirmDelete] = useState<CreditPlan | null>(null);
  const [deleting, setDeleting] = useState(false);

  const [campaigns, setCampaigns] = useState<SignupCampaign[]>([]);
  const [campaignsLoading, setCampaignsLoading] = useState(true);
  const [campaignModal, setCampaignModal] = useState<{
    open: boolean;
    campaign: SignupCampaign | null;
  }>({ open: false, campaign: null });
  const [confirmDeleteCampaign, setConfirmDeleteCampaign] = useState<SignupCampaign | null>(null);
  const [deletingCampaign, setDeletingCampaign] = useState(false);
```

Right after the existing plans-loading `useEffect` (currently ending at line 614):

```ts
  useEffect(() => {
    apiFetch<CreditPlan[]>('/admin/credit-plans')
      .then(setPlans)
      .catch((e) =>
        toast({
          kind: 'error',
          title: 'Failed to load credit plans',
          body: apiErrorMessage(e, 'Please try again.'),
        }),
      )
      .finally(() => setPlansLoading(false));
  }, [toast]);
```

add:

```ts
  useEffect(() => {
    apiFetch<SignupCampaign[]>('/admin/signup-campaigns')
      .then(setCampaigns)
      .catch((e) =>
        toast({
          kind: 'error',
          title: 'Failed to load signup campaigns',
          body: apiErrorMessage(e, 'Please try again.'),
        }),
      )
      .finally(() => setCampaignsLoading(false));
  }, [toast]);
```

Right after `handleDelete` (the credit-plan delete handler, currently ending around line 645), add:

```ts
  const handleCampaignSaved = (saved: SignupCampaign) => {
    setCampaigns((prev) => {
      const idx = prev.findIndex((c) => c.id === saved.id);
      if (idx >= 0) {
        const next = [...prev];
        next[idx] = saved;
        return next;
      }
      return [...prev, saved];
    });
  };

  const handleDeleteCampaign = async () => {
    if (!confirmDeleteCampaign) return;
    setDeletingCampaign(true);
    try {
      await apiFetch(`/admin/signup-campaigns/${confirmDeleteCampaign.id}`, { method: 'DELETE' });
      setCampaigns((prev) => prev.filter((c) => c.id !== confirmDeleteCampaign.id));
      toast({ title: `${confirmDeleteCampaign.name} deleted` });
    } catch (err) {
      toast({
        kind: 'error',
        title: 'Failed to delete campaign',
        body: apiErrorMessage(err, 'Please try again.'),
      });
    } finally {
      setDeletingCampaign(false);
      setConfirmDeleteCampaign(null);
    }
  };
```

- [ ] **Step 6: Render the tab content**

The credit-plans section block currently closes around line 1107-1112:

```tsx
          )}
        </>
      )}

      {/* System */}
      {section === 'system' && (
```

Insert a new block between them:

```tsx
          )}
        </>
      )}

      {/* Signup Campaigns */}
      {section === 'signup-campaigns' && (
        <>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'space-between',
              marginBottom: 20,
            }}
          >
            <h3
              style={{
                margin: 0,
                fontSize: 18,
                fontWeight: 500,
                color: 'var(--ink)',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <Icon.Coin /> Signup Campaigns
            </h3>
            <button
              className="btn sm primary"
              onClick={() => setCampaignModal({ open: true, campaign: null })}
            >
              <Icon.Add /> Add campaign
            </button>
          </div>

          {campaignsLoading ? (
            <div style={{ color: 'var(--muted)', fontSize: 13 }}>Loading…</div>
          ) : campaigns.length === 0 ? (
            <div
              style={{
                textAlign: 'center',
                padding: '40px 20px',
                color: 'var(--muted)',
                background: 'var(--surface-2)',
                borderRadius: 'var(--r-lg)',
                border: '1px dashed var(--border)',
              }}
            >
              No signup campaigns yet — click "Add campaign" to create one.
            </div>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Code</th>
                    <th>Name</th>
                    <th>Bonus %</th>
                    <th>Window</th>
                    <th>Status</th>
                    <th></th>
                  </tr>
                </thead>
                <tbody>
                  {campaigns.map((c) => (
                    <tr key={c.id} style={{ opacity: c.isActive ? 1 : 0.55 }}>
                      <td className="mono">{c.code}</td>
                      <td>{c.name}</td>
                      <td>{c.bonusPercent}%</td>
                      <td style={{ fontSize: 12, color: 'var(--muted)' }}>
                        {new Date(c.startAt).toLocaleDateString()} –{' '}
                        {new Date(c.endAt).toLocaleDateString()}
                      </td>
                      <td>
                        {c.isActive ? (
                          <span className="badge">Active</span>
                        ) : (
                          <span className="badge dot">Inactive</span>
                        )}
                      </td>
                      <td>
                        <div style={{ display: 'flex', gap: 6 }}>
                          <button
                            className="btn sm ghost"
                            onClick={() => setCampaignModal({ open: true, campaign: c })}
                            title="Edit"
                          >
                            <Icon.Edit />
                          </button>
                          <button
                            className="btn sm ghost"
                            onClick={() => setConfirmDeleteCampaign(c)}
                            title="Delete"
                            style={{ color: 'var(--danger)' }}
                          >
                            <Icon.Trash />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* System */}
      {section === 'system' && (
```

- [ ] **Step 7: Render the modal and confirm-delete dialog**

The `planModal`/`confirmDelete` instantiation currently reads (near the end of the file, lines 1732-1751):

```tsx
      {planModal.open && (
        <PlanModal
          plan={planModal.plan}
          onSaved={handlePlanSaved}
          onClose={() => setPlanModal({ open: false, plan: null })}
          toast={toast}
        />
      )}

      {confirmDelete && (
        <ConfirmModal
          title="Delete plan"
          body={`Are you sure you want to delete "${confirmDelete.name}"? This cannot be undone.`}
          what={`slug: ${confirmDelete.slug}`}
          danger
          confirmLabel={deleting ? 'Deleting…' : 'Delete'}
          onConfirm={handleDelete}
          onClose={() => setConfirmDelete(null)}
        />
      )}
    </>
  );
```

Insert the campaign modal/dialog right before the closing `</>` / `);`:

```tsx
      {planModal.open && (
        <PlanModal
          plan={planModal.plan}
          onSaved={handlePlanSaved}
          onClose={() => setPlanModal({ open: false, plan: null })}
          toast={toast}
        />
      )}

      {confirmDelete && (
        <ConfirmModal
          title="Delete plan"
          body={`Are you sure you want to delete "${confirmDelete.name}"? This cannot be undone.`}
          what={`slug: ${confirmDelete.slug}`}
          danger
          confirmLabel={deleting ? 'Deleting…' : 'Delete'}
          onConfirm={handleDelete}
          onClose={() => setConfirmDelete(null)}
        />
      )}

      {campaignModal.open && (
        <CampaignModal
          campaign={campaignModal.campaign}
          onSaved={handleCampaignSaved}
          onClose={() => setCampaignModal({ open: false, campaign: null })}
          toast={toast}
        />
      )}

      {confirmDeleteCampaign && (
        <ConfirmModal
          title="Delete campaign"
          body={`Are you sure you want to delete "${confirmDeleteCampaign.name}"? This cannot be undone.`}
          what={`code: ${confirmDeleteCampaign.code}`}
          danger
          confirmLabel={deletingCampaign ? 'Deleting…' : 'Delete'}
          onConfirm={handleDeleteCampaign}
          onClose={() => setConfirmDeleteCampaign(null)}
        />
      )}
    </>
  );
```

- [ ] **Step 8: Verify it builds**

Run: `pnpm --filter @tryme/admin build`
Expected: `tsc -b` succeeds with no type errors, then `vite build` succeeds.

Run: `pnpm --filter @tryme/admin lint`
Expected: no new biome errors (it may auto-fix import ordering — accept those).

- [ ] **Step 9: Manual smoke test**

Run: `pnpm --filter @tryme/admin dev`, open the admin panel, log in, go to Settings → Signup Campaigns. Confirm: the tab renders, "Add campaign" opens the modal, creating a campaign with `code: gartex2026`, `bonusPercent: 25`, a start/end date, and Active checked succeeds and appears in the table, editing it works, and deleting it (with no attributed users) succeeds.

- [ ] **Step 10: Commit**

```bash
git add apps/admin-web/src/types.ts apps/admin-web/src/pages/SettingsPage.tsx
git commit -m "feat(admin-web): Signup Campaigns tab in Settings"
```

---

## Task 10: Frontend — thread `?src=` through register (email/password + Google)

**Files:**
- Modify: `apps/catalogues-web/src/app/(auth)/register/page.tsx`
- Modify: `apps/catalogues-web/src/components/ui/google-btn.tsx`

- [ ] **Step 1: Update `GoogleBtn` to accept and forward `src`**

In `apps/catalogues-web/src/components/ui/google-btn.tsx`, change:

```tsx
export function GoogleBtn({ label, next }: { label: string; next?: string }) {
  const href = next
    ? `${API_URL}/v1/auth/google/init?next=${encodeURIComponent(next)}`
    : `${API_URL}/v1/auth/google/init`;
```

to:

```tsx
export function GoogleBtn({
  label,
  next,
  src,
}: {
  label: string;
  next?: string;
  src?: string;
}) {
  const params = new URLSearchParams();
  if (next) params.set('next', next);
  if (src) params.set('src', src);
  const qs = params.toString();
  const href = qs ? `${API_URL}/v1/auth/google/init?${qs}` : `${API_URL}/v1/auth/google/init`;
```

(The rest of the component — the `<a>` element using `href` — is unchanged.)

- [ ] **Step 2: Restructure the register page to read `?src=` and thread it through**

`apps/catalogues-web/src/app/(auth)/register/page.tsx` currently exports `RegisterPage` directly as a component using hooks (`useRouter`, `useForm`, etc.) with no `Suspense` boundary. Reading `useSearchParams()` in the Next.js App Router requires wrapping the component in `<Suspense>` (see the identical pattern already used in `apps/catalogues-web/src/app/(auth)/login/page.tsx`, which splits into `LoginFormInner` + a `Suspense`-wrapped default export).

Change the import line:

```tsx
'use client';
import { RegisterBody } from '@tryme/types';
import { zodResolver } from '@hookform/resolvers/zod';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
```

to:

```tsx
'use client';
import { RegisterBody } from '@tryme/types';
import { zodResolver } from '@hookform/resolvers/zod';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useState } from 'react';
import { useForm } from 'react-hook-form';
```

Change the component declaration and body:

```tsx
export default function RegisterPage(): React.ReactElement {
  const router = useRouter();
  const [error, setError] = useState('');
```

to:

```tsx
function RegisterFormInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const src = searchParams.get('src') ?? undefined;
  const [error, setError] = useState('');
```

Change the `onSubmit` body:

```tsx
  async function onSubmit(data: RegisterForm) {
    setError('');
    const res = await fetch(`${BASE}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
```

to:

```tsx
  async function onSubmit(data: RegisterForm) {
    setError('');
    const res = await fetch(`${BASE}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...data, signupSource: src }),
    });
```

Change the Google button usage:

```tsx
          <GoogleBtn label="Sign Up with Google" />
```

to:

```tsx
          <GoogleBtn label="Sign Up with Google" src={src} />
```

Finally, change the closing of the file — the function that was `RegisterFormInner` needs its closing brace kept exactly where `RegisterPage`'s was (just the `return (...)` JSX and its closing `}` are otherwise unchanged), and add a new default export below it:

```tsx
        <ImagePanel />
      </div>
    </div>
  );
}
```

becomes:

```tsx
        <ImagePanel />
      </div>
    </div>
  );
}

export default function RegisterPage(): React.ReactElement {
  return (
    <Suspense
      fallback={
        <div
          style={{
            minHeight: '100vh',
            background: `#000 url('${BASE}/assets/auth-screen-bg.png') center center / cover no-repeat`,
          }}
        />
      }
    >
      <RegisterFormInner />
    </Suspense>
  );
}
```

- [ ] **Step 3: Verify it builds**

Run: `pnpm --filter @tryme/web build`
Expected: build succeeds, no type errors, no "useSearchParams() should be wrapped in a suspense boundary" warning/error.

- [ ] **Step 4: Manual smoke test**

Run: `pnpm --filter @tryme/web dev`. With the API and a seeded `gartex2026` campaign (from Task 9's manual test) running locally, visit `http://localhost:3000/register?src=gartex2026`, complete signup with a new email, verify the email (or bypass via DB in dev), and confirm in the DB that `users.signup_campaign_id` is set for that user. Then repeat via "Sign Up with Google" from the same `?src=gartex2026` URL and confirm the same for the resulting Google-linked user.

- [ ] **Step 5: Commit**

```bash
git add apps/catalogues-web/src/app/\(auth\)/register/page.tsx apps/catalogues-web/src/components/ui/google-btn.tsx
git commit -m "feat(web): thread ?src= campaign code through register (email + Google)"
```

---

## Task 11: Progress log + final full-suite verification

**Files:**
- Modify: `docs/progress.md`

- [ ] **Step 1: Run the full API test suite one more time**

Run: `pnpm --filter @tryme/api test`
Expected: PASS, all tests (including all new ones from Tasks 4-8).

- [ ] **Step 2: Run the full typecheck and build across the monorepo**

Run: `pnpm typecheck`
Expected: no errors.

Run: `pnpm build`
Expected: succeeds for all packages/apps.

- [ ] **Step 3: Add a dated entry to `docs/progress.md`**

`docs/progress.md` entries follow this exact format (most recent first, no blank line between entries — see the existing top entry for the pattern):

```
## YYYY-MM-DD - Title

### Done
- ...

### Failed / Not Done
- ...

### Open Questions / Decisions
- ...
```

Prepend this entry at the very top of the file (replace `YYYY-MM-DD` with today's actual date):

```
## YYYY-MM-DD - Gartex expo QR signup campaign (25% bonus credits)

### Done
- Added `signup_campaigns` table (code, name, bonusPercent, date window, isActive) and `users.signupCampaignId` FK, set once at signup.
- Email/password register (`?src=` query param -> `RegisterBody.signupSource`) and Google OAuth (`google_src` cookie, mirroring `google_next`) both attribute brand-new signups to a matching active, in-window campaign.
- `FREE_TRIAL` grant (both the `PATCH /v1/me` profile-completion path and the Google new-account path) is boosted by the campaign's `bonusPercent` when attributed.
- First plan purchase for a campaign-attributed user grants an extra `CAMPAIGN_BONUS` ledger entry (bonusPercent of the plan's credits), applied once via a shared `grantPurchaseCredits` helper used by both `/v1/payments/verify` and the Razorpay webhook.
- Admin CRUD (`/admin/signup-campaigns`) + a new "Signup Campaigns" tab in the admin Settings page (`apps/admin-web/src/pages/SettingsPage.tsx`).

### Failed / Not Done
- None.

### Open Questions / Decisions
- The actual `gartex2026` campaign row still needs to be created via the admin UI in production, with the real expo dates, before the QR code is printed (see `docs/superpowers/specs/2026-08-01-gartex-expo-qr-campaign-design.md` §3.6) — this is an operational step, not a code task.
```

- [ ] **Step 4: Commit**

```bash
git add docs/progress.md
git commit -m "docs: log Gartex expo QR campaign implementation"
```

---

## Post-implementation (operational, not code)

Once this ships to production: create the real `gartex2026` campaign row via the admin panel (Settings → Signup Campaigns → Add campaign) with the actual expo dates, generate the QR code pointing at `https://app.tryme.com/register?src=gartex2026`, and smoke-test the full flow end-to-end in production before printing/deploying the physical QR code at the booth.
