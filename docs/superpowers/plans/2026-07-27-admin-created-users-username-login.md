# Admin-Created User Accounts (Username Login) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin create a customer account with just a username + password (email optional at creation time), let that customer log in with either their username or their email everywhere email/password login already works, and prompt any customer whose account is missing an email or phone number to fill it in via the existing profile-completion gate.

**Architecture:** Add a nullable `username` column to `users` (mutually exclusive character set from email — usernames can never contain `@`, so a single `WHERE email = $1 OR username = $1` lookup can never be ambiguous) and make `email` nullable. A new shared `findUserByIdentifier()` helper backs both existing password-login routes (`/v1/auth/login`, `/v1/auth/device-login`). A new admin-only `POST /admin/users` route creates the account; a new `POST /admin/users/:id/reset-password` covers the case where a username-only customer (who has no email, so no self-service "forgot password") needs a password reset. The existing `ProfileGate`/`ProfileCompletionModal` component (already shown app-wide on every catalogues-web page when phone is missing) is extended to also require email, reusing its existing "unlock free credits" mechanism rather than building a new one.

**Tech Stack:** Fastify 5 + Zod (`@tryme/types`), Drizzle ORM (`packages/db`), Postgres CHECK constraint, React (admin-web Vite SPA + catalogues-web Next.js), Vitest integration tests against real Postgres/Redis.

**Decisions locked in during brainstorming (do not re-litigate without asking):**
- `email` becomes nullable on `users`. Admin sets the initial password directly (no email dependency at account-creation time).
- The existing profile-completion modal (phone-only today) is extended to also require email, for **every** account missing it — not just admin-created ones. (In practice this only changes behavior for admin-created accounts: self-registered and Google accounts already always have an email.)
- Scope is `apps/api` + `apps/catalogues-web` (login + profile completion) + `apps/admin-web` (the new Create User form). Admin-mobile is untouched (paused, per CLAUDE.md). Admin's own login (`/admin/auth/login`) is untouched — this feature is about customer accounts, not admin accounts.
- Username charset is restricted to `[a-zA-Z0-9_.]`, normalized to lowercase at write and lookup time. This is what makes the single OR-lookup safe — emails always contain `@`, usernames never can, so the two identifier spaces can never collide.
- No re-verification email is sent when a customer adds their email via the profile-completion modal — this is a data-collection flow, not a security-critical email-ownership check (matches how phone numbers are already handled: format-validated, not verified).

---

### Task 1: Schema — nullable email, new `username` column

**Files:**
- Modify: `packages/db/src/schema/users.ts`

- [ ] **Step 1: Update the schema**

Open `packages/db/src/schema/users.ts`. The current `users` table definition (lines 15–31) is:

```ts
export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  email: text('email').notNull().unique(),
  passwordHash: text('password_hash'), // nullable — Google-only users have no password
  displayName: text('display_name'),
  phone: text('phone'), // nullable — user-provided, no format enforcement
  companyName: text('company_name'),
  // FK to credit_plans.slug added in migration 0080 (ON DELETE RESTRICT) — not
  // declared via .references() here to avoid a circular import with credits.ts.
  tier: text('tier').notNull().default('free'),
  emailVerified: boolean('email_verified').notNull().default(false),
  isBanned: boolean('is_banned').notNull().default(false),
  maxActiveDevices: integer('max_active_devices').notNull().default(1),
  banReason: text('ban_reason'),
  defaultResolution: text('default_resolution').notNull().default('HD'),
  defaultAspectRatio: text('default_aspect_ratio').notNull().default('1:1'),
  defaultPlatform: text('default_platform').notNull().default('Amazon'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
```

Replace it with:

```ts
export const users = pgTable(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Nullable — admin-created accounts (see /admin/users) may have no email at
    // creation time and log in via `username` instead. Self-registration and
    // Google OAuth always set this.
    email: text('email').unique(),
    passwordHash: text('password_hash'), // nullable — Google-only users have no password
    displayName: text('display_name'),
    phone: text('phone'), // nullable — user-provided, no format enforcement
    companyName: text('company_name'),
    // FK to credit_plans.slug added in migration 0080 (ON DELETE RESTRICT) — not
    // declared via .references() here to avoid a circular import with credits.ts.
    tier: text('tier').notNull().default('free'),
    emailVerified: boolean('email_verified').notNull().default(false),
    isBanned: boolean('is_banned').notNull().default(false),
    maxActiveDevices: integer('max_active_devices').notNull().default(1),
    banReason: text('ban_reason'),
    defaultResolution: text('default_resolution').notNull().default('HD'),
    defaultAspectRatio: text('default_aspect_ratio').notNull().default('1:1'),
    defaultPlatform: text('default_platform').notNull().default('Amazon'),
    // Nullable — only set by admin-created accounts (see POST /admin/users), as an
    // alternate login identifier alongside email. ALWAYS lowercase (both here and
    // wherever it's written or looked up). Restricted to [a-z0-9_.] so it can never
    // contain '@' — that's what guarantees `WHERE email = $1 OR username = $1` in
    // findUserByIdentifier() (apps/api/src/modules/auth/routes.ts) can never match
    // two different rows. Do not loosen this charset without re-checking that
    // invariant.
    username: text('username').unique(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check('users_username_format', sql`${t.username} IS NULL OR ${t.username} ~ '^[a-z0-9_.]{3,32}$'`),
  ],
);
```

`check` and `sql` are already imported at the top of this file (`import { sql } from 'drizzle-orm'; import { boolean, check, integer, ... } from 'drizzle-orm/pg-core';`) — no new imports needed.

- [ ] **Step 2: Generate the migration**

Run: `pnpm db:generate`

Expected: a new file `packages/db/src/migrations/0126_<generated-name>.sql` containing roughly:

```sql
ALTER TABLE "users" ALTER COLUMN "email" DROP NOT NULL;
ALTER TABLE "users" ADD COLUMN "username" text;
ALTER TABLE "users" ADD CONSTRAINT "users_username_unique" UNIQUE("username");
ALTER TABLE "users" ADD CONSTRAINT "users_username_format" CHECK ("username" IS NULL OR "username" ~ '^[a-z0-9_.]{3,32}$');
```

Plus a matching `packages/db/src/migrations/meta/0126_snapshot.json`. If `drizzle-kit generate` fails with a "pointing to a parent snapshot" collision error, follow the manual-snapshot procedure already documented in `CLAUDE.md` under "Migration Index Conflicts (diverged branches)" — clone the previous snapshot, add the new columns/constraint to its `users` table entry, bump `id`/`prevId`, and hand-write the SQL file + journal entry the same way `0125_add_user_defaults.sql` was done.

- [ ] **Step 3: Apply the migration**

Run: `pnpm db:migrate`

Expected: `Applied 0126_<name>` with no errors. NOTICE-level output is fine; only `ERROR` output means a problem.

- [ ] **Step 4: Verify**

Run:
```bash
cd apps/api && node -e "
const postgres = require('postgres');
const sql = postgres(process.env.DATABASE_URL);
sql\`SELECT column_name, is_nullable FROM information_schema.columns WHERE table_name='users' AND column_name IN ('email','username')\`.then(r => { console.log(r); return sql.end(); });
"
```
Expected: two rows, `email` with `is_nullable = YES`, `username` with `is_nullable = YES`.

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema/users.ts packages/db/src/migrations/0126_*.sql packages/db/src/migrations/meta/0126_snapshot.json packages/db/src/migrations/meta/_journal.json
git commit -m "feat(db): add username column, make email nullable"
```

---

### Task 2: Shared types — CreateUserBody, ResetPasswordBody, loosened LoginBody

**Files:**
- Modify: `packages/types/src/admin.ts`
- Modify: `packages/types/src/auth.ts`

- [ ] **Step 1: Add `CreateUserBody` and `ResetPasswordBody` to `packages/types/src/admin.ts`**

Add this near the top of the file, right after the existing `UpdateUserBody` definition (currently lines 14–20):

```ts
export const CreateUserBody = z.object({
  username: z
    .string()
    .min(3)
    .max(32)
    .regex(/^[a-zA-Z0-9_.]+$/, 'Username may only contain letters, numbers, underscores, and dots'),
  password: z
    .string()
    .min(8)
    .max(128)
    .regex(/[a-zA-Z]/, 'Password must contain at least one letter')
    .regex(/[0-9]/, 'Password must contain at least one number'),
  displayName: z.string().min(1).max(80),
  email: z.string().email().max(254).optional(),
  phone: z.string().regex(/^\d{10}$/, 'phone must be a 10-digit number').optional(),
  companyName: z.string().max(160).optional(),
});
export const ResetPasswordBody = z.object({
  newPassword: z
    .string()
    .min(8)
    .max(128)
    .regex(/[a-zA-Z]/, 'Password must contain at least one letter')
    .regex(/[0-9]/, 'Password must contain at least one number'),
});
```

- [ ] **Step 2: Loosen `LoginBody` in `packages/types/src/auth.ts`**

Current (lines 12–15):
```ts
export const LoginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1).max(128),
});
```

Replace with:
```ts
// Field is still named `email` on the wire for backward compatibility with
// existing clients (web, the saree catalogue Android app) that already POST
// `{ email, password }` — but the value may now be an email OR a username
// (admin-created accounts, see CreateUserBody). Do not rename this field.
export const LoginBody = z.object({
  email: z.string().min(1).max(254),
  password: z.string().min(1).max(128),
});
```

`RegisterBody` is unchanged — self-registration always requires a real email.

- [ ] **Step 3: Typecheck the types package**

Run: `pnpm --filter @tryme/types exec tsc --noEmit`
Expected: no output (clean).

- [ ] **Step 4: Commit**

```bash
git add packages/types/src/admin.ts packages/types/src/auth.ts
git commit -m "feat(types): add CreateUserBody/ResetPasswordBody, loosen LoginBody for username login"
```

---

### Task 3: Backend — shared identifier resolver, wire into login routes

**Files:**
- Modify: `apps/api/src/modules/auth/routes.ts`
- Test: `apps/api/test/integration/admin-create-user.test.ts` (created in Task 4, extended here)

- [ ] **Step 1: Add the shared resolver**

In `apps/api/src/modules/auth/routes.ts`, add `or` to the existing drizzle-orm import (currently line 4):
```ts
import { and, desc, eq, exists, gt, inArray, isNull, sql } from 'drizzle-orm';
```
becomes:
```ts
import { and, desc, eq, exists, gt, inArray, isNull, or, sql } from 'drizzle-orm';
```

Then add this new function right before `async function authenticateDeviceUser(` (currently line 216):

```ts
// A user logs in with either their email or their username (username is only
// ever set on admin-created accounts — see POST /admin/users). Usernames are
// stored lowercase and restricted to [a-z0-9_.] (enforced by the DB CHECK
// constraint and CreateUserBody's regex) so they can never contain '@' — that
// guarantee is what makes this single OR-lookup unambiguous: a value typed at
// login can match at most one of the two columns, never both/either-of-two-rows.
async function findUserByIdentifier(app: FastifyInstance, identifier: string) {
  const [user] = await app.db
    .select()
    .from(schema.users)
    .where(or(eq(schema.users.email, identifier), eq(schema.users.username, identifier.toLowerCase())));
  return user ?? null;
}

```

- [ ] **Step 2: Use it in `authenticateDeviceUser`**

Current (lines 216–233):
```ts
async function authenticateDeviceUser(
  app: FastifyInstance,
  dummyHash: string,
  email: string,
  password: string,
) {
  const [user] = await app.db.select().from(schema.users).where(eq(schema.users.email, email));
  if (!user || user.isBanned) {
    await verifyPassword(dummyHash, password); // constant-time: prevent user enumeration via timing
    throw new AppError('INVALID', 401, 'invalid credentials');
  }
  if (!user.passwordHash) throw new AppError('INVALID', 401, 'invalid credentials');
  if (!(await verifyPassword(user.passwordHash, password))) {
    throw new AppError('INVALID', 401, 'invalid credentials');
  }
  if (!user.emailVerified) throw new AppError('EMAIL_NOT_VERIFIED', 403, 'email not verified');
  return user;
}
```

Replace with:
```ts
async function authenticateDeviceUser(
  app: FastifyInstance,
  dummyHash: string,
  identifier: string,
  password: string,
) {
  const user = await findUserByIdentifier(app, identifier);
  if (!user || user.isBanned) {
    await verifyPassword(dummyHash, password); // constant-time: prevent user enumeration via timing
    throw new AppError('INVALID', 401, 'invalid credentials');
  }
  if (!user.passwordHash) throw new AppError('INVALID', 401, 'invalid credentials');
  if (!(await verifyPassword(user.passwordHash, password))) {
    throw new AppError('INVALID', 401, 'invalid credentials');
  }
  // Only accounts that actually have an email need it verified. Admin-created
  // username-only accounts are created with emailVerified=true regardless (see
  // POST /admin/users) so this branch is defensive, not the primary gate.
  if (user.email && !user.emailVerified) {
    throw new AppError('EMAIL_NOT_VERIFIED', 403, 'email not verified');
  }
  return user;
}
```

- [ ] **Step 3: Update `deviceLoginUserPayload`'s type to allow null email**

Current (lines 258–272):
```ts
function deviceLoginUserPayload(user: {
  id: string;
  email: string;
  displayName: string | null;
  tier: string;
  maxActiveDevices: number;
}) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    tier: user.tier,
    maxActiveDevices: user.maxActiveDevices,
  };
}
```

Replace the parameter type's `email: string;` with `email: string | null;` (body unchanged):
```ts
function deviceLoginUserPayload(user: {
  id: string;
  email: string | null;
  displayName: string | null;
  tier: string;
  maxActiveDevices: number;
}) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.displayName,
    tier: user.tier,
    maxActiveDevices: user.maxActiveDevices,
  };
}
```

- [ ] **Step 4: Use the resolver in `/v1/auth/login`**

Current (lines 311–337):
```ts
  app.post(
    '/v1/auth/login',
    {
      schema: { body: LoginBody },
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const { email, password } = req.body as z.infer<typeof LoginBody>;
      const [user] = await app.db.select().from(schema.users).where(eq(schema.users.email, email));
      if (!user || user.isBanned) {
        await verifyPassword(dummyHash, password); // constant-time: prevent user enumeration via timing
        throw new AppError('INVALID', 401, 'invalid credentials');
      }
      if (!user.passwordHash) throw new AppError('INVALID', 401, 'invalid credentials');
      if (!(await verifyPassword(user.passwordHash, password)))
        throw new AppError('INVALID', 401, 'invalid credentials');
      if (!user.emailVerified) throw new AppError('EMAIL_NOT_VERIFIED', 403, 'email not verified');
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
      schema: { body: LoginBody },
      config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      // Field is named `email` on the wire (see LoginBody) but may hold a
      // username for admin-created accounts — see findUserByIdentifier.
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

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @tryme/api exec tsc --noEmit -p .`
Expected: no output. (This is also where you'll discover any other place in this file that assumed `user.email: string` — fix any such error the same way as Step 3 before moving on.)

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/auth/routes.ts
git commit -m "feat(api): resolve login by email or username via shared findUserByIdentifier"
```

(Login-by-username itself is exercised end-to-end in Task 4's test file, once `POST /admin/users` exists to create a username-only account to log in with.)

---

### Task 4: Backend — `POST /admin/users` (create user)

**Files:**
- Modify: `apps/api/src/modules/admin/users.routes.ts`
- Create: `apps/api/test/integration/admin-create-user.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `apps/api/test/integration/admin-create-user.test.ts`:

```ts
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminAuthHeader } from '../helpers/admin.js';
import { buildTestApp } from '../helpers/api.js';
import { startContainers } from '../helpers/containers.js';

describe('admin create user', () => {
  let ctx: Awaited<ReturnType<typeof startContainers>>;
  let app: Awaited<ReturnType<typeof buildTestApp>>;
  let authHeader: Record<string, string>;

  beforeAll(async () => {
    ctx = await startContainers();
    app = await buildTestApp(ctx);
    authHeader = await adminAuthHeader(app, 'ADMIN');
  });
  afterAll(async () => {
    await app.close();
    await ctx.stop();
  });

  it('creates a username-only account (no email) that can log in with the username', async () => {
    const username = `walkin${Date.now()}`;
    const createRes = await app.inject({
      method: 'POST',
      url: '/admin/users',
      headers: authHeader,
      payload: { username, password: 'password123', displayName: 'Walk-in Customer' },
    });
    expect(createRes.statusCode).toBe(201);
    const { userId } = createRes.json() as { userId: string };
    expect(userId).toBeTruthy();

    const [row] = await app.db.select().from(schema.users).where(eq(schema.users.id, userId));
    expect(row?.email).toBeNull();
    expect(row?.username).toBe(username.toLowerCase());
    expect(row?.emailVerified).toBe(true);

    const loginRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: username, password: 'password123' },
    });
    expect(loginRes.statusCode).toBe(200);
    expect(loginRes.json().accessToken).toBeTruthy();
  });

  it('logging in with the username is case-insensitive', async () => {
    const username = `caseinsensitive${Date.now()}`;
    await app.inject({
      method: 'POST',
      url: '/admin/users',
      headers: authHeader,
      payload: { username, password: 'password123', displayName: 'Case Test' },
    });

    const loginRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email: username.toUpperCase(), password: 'password123' },
    });
    expect(loginRes.statusCode).toBe(200);
  });

  it('rejects a duplicate username', async () => {
    const username = `dupe${Date.now()}`;
    await app.inject({
      method: 'POST',
      url: '/admin/users',
      headers: authHeader,
      payload: { username, password: 'password123', displayName: 'First' },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/admin/users',
      headers: authHeader,
      payload: { username, password: 'password123', displayName: 'Second' },
    });
    expect(second.statusCode).toBe(409);
    expect(second.json().error.code).toBe('USERNAME_TAKEN');
  });

  it('rejects a username shaped like an email', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/users',
      headers: authHeader,
      payload: { username: 'not@allowed', password: 'password123', displayName: 'X' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('accepts an optional email/phone and rejects a duplicate email', async () => {
    const existingEmail = `existing${Date.now()}@example.com`;
    await app.db.insert(schema.users).values({ email: existingEmail, tier: 'free' });

    const res = await app.inject({
      method: 'POST',
      url: '/admin/users',
      headers: authHeader,
      payload: {
        username: `withemail${Date.now()}`,
        password: 'password123',
        displayName: 'Has Email',
        email: existingEmail,
      },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.code).toBe('EMAIL_TAKEN');
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run:
```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts admin-create-user
```
Expected: FAIL — `/admin/users` POST doesn't exist yet (404s).

- [ ] **Step 3: Implement `POST /admin/users`**

In `apps/api/src/modules/admin/users.routes.ts`:

Change the import line (currently line 2):
```ts
import { UpdateUserBody } from '@tryme/types';
```
to:
```ts
import { CreateUserBody, ResetPasswordBody, UpdateUserBody } from '@tryme/types';
```

Add this new import (the file doesn't currently import from `../auth/service.js`):
```ts
import { hashPassword } from '../auth/service.js';
```

Add this new route directly after the closing `);` of the existing `POST /admin/users/:id` — actually there is no such route; add it directly before the `app.delete('/admin/users/:id', ...)` block (currently starting at line 225), i.e. right after the `PATCH /admin/users/:id` block ends (line 223):

```ts
  app.post(
    '/admin/users',
    { preHandler: WRITE, schema: { body: CreateUserBody } },
    async (req, reply) => {
      const { username, password, displayName, email, phone, companyName } = req.body as z.infer<
        typeof CreateUserBody
      >;
      const normalizedUsername = username.toLowerCase();

      const [usernameConflict] = await app.db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.username, normalizedUsername))
        .limit(1);
      if (usernameConflict) throw new AppError('USERNAME_TAKEN', 409, 'username already taken');

      if (email) {
        const [emailConflict] = await app.db
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(eq(schema.users.email, email))
          .limit(1);
        if (emailConflict) throw new AppError('EMAIL_TAKEN', 409, 'email already registered');
      }

      if (phone) {
        const [phoneConflict] = await app.db
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(eq(schema.users.phone, phone))
          .limit(1);
        if (phoneConflict) {
          throw new AppError('PHONE_TAKEN', 409, 'phone already assigned to another account');
        }
      }

      const passwordHash = await hashPassword(password);
      const [user] = await app.db
        .insert(schema.users)
        .values({
          username: normalizedUsername,
          passwordHash,
          displayName,
          email: email ?? null,
          phone: phone ?? null,
          companyName: companyName ?? null,
          tier: 'free',
          // Admin is vouching for this account directly — there is no inbox to
          // verify (may not even have an email), so verification doesn't apply.
          emailVerified: true,
        })
        .returning({ id: schema.users.id });
      if (!user) throw new AppError('INTERNAL', 500, 'failed to create user');
      await app.db.insert(schema.userCredits).values({ userId: user.id, balance: 0 });

      reply.code(201);
      return { ok: true, userId: user.id };
    },
  );

  app.post(
    '/admin/users/:id/reset-password',
    {
      preHandler: WRITE,
      schema: { params: z.object({ id: z.string().uuid() }), body: ResetPasswordBody },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const { newPassword } = req.body as z.infer<typeof ResetPasswordBody>;
      const passwordHash = await hashPassword(newPassword);
      const [updated] = await app.db
        .update(schema.users)
        .set({ passwordHash, updatedAt: new Date() })
        .where(eq(schema.users.id, id))
        .returning({ id: schema.users.id });
      if (!updated) throw new AppError('NOT_FOUND', 404, 'user not found');
      await app.db
        .update(schema.refreshTokens)
        .set({ revokedAt: new Date() })
        .where(eq(schema.refreshTokens.userId, id));
      return { ok: true };
    },
  );

```

- [ ] **Step 4: Run the tests again to confirm they pass**

Run:
```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts admin-create-user
```
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @tryme/api exec tsc --noEmit -p .`
Expected: no output.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/admin/users.routes.ts apps/api/test/integration/admin-create-user.test.ts
git commit -m "feat(api): add POST /admin/users (create) and /admin/users/:id/reset-password"
```

---

### Task 5: Backend — `/v1/me` accepts email, free-credit gate requires it too

**Files:**
- Modify: `apps/api/src/modules/auth/routes.ts`
- Create: `apps/api/test/integration/me-email.test.ts`

(`apps/api/test/integration/admin-me.test.ts` is a different, unrelated route — `GET /admin/me`, the admin panel's own identity check — not `/v1/me`. This task creates a new, dedicated test file instead.)

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/integration/me-email.test.ts`:

```ts
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../../src/modules/auth/service.js';
import { createSessionTokens } from '../../src/modules/auth/tokens.js';
import { buildTestApp, type TestApp } from '../helpers/api.js';
import { type Containers, startContainers } from '../helpers/containers.js';

describe('/v1/me email completion', () => {
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

  async function seedUsernameOnlyUser(username: string) {
    const passwordHash = await hashPassword('password123');
    const [user] = await app.db
      .insert(schema.users)
      .values({
        username,
        passwordHash,
        displayName: 'Test',
        email: null,
        emailVerified: true,
        tier: 'free',
      })
      .returning({ id: schema.users.id });
    if (!user) throw new Error('user not created');
    await app.db.insert(schema.userCredits).values({ userId: user.id, balance: 0 });
    let refreshPlain = '';
    const reply = {
      setCookie(name: string, value: string) {
        if (name === 'refresh') refreshPlain = value;
      },
      code() {
        return reply;
      },
    } as const;
    const { accessToken } = await createSessionTokens(app, user.id, reply as never, 200);
    return { userId: user.id, accessToken, refreshPlain };
  }

  it('accepts email on PATCH /v1/me and rejects a duplicate', async () => {
    const { accessToken } = await seedUsernameOnlyUser(`emailtest${Date.now()}`);
    const email = `newemail${Date.now()}@example.com`;

    const res = await app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { email },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().email).toBe(email);

    const { accessToken: token2 } = await seedUsernameOnlyUser(`emailtest2${Date.now()}`);
    const dupeRes = await app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: { authorization: `Bearer ${token2}` },
      payload: { email },
    });
    expect(dupeRes.statusCode).toBe(409);
  });

  it('only grants free credits once both phone and email are set', async () => {
    await app.db
      .insert(schema.creditPlans)
      .values({ slug: 'free', name: 'free', credits: 50, basePaise: 0 })
      .onConflictDoUpdate({ target: schema.creditPlans.slug, set: { credits: 50 } });

    const { userId, accessToken } = await seedUsernameOnlyUser(`credittest${Date.now()}`);

    await app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { phone: '9876543210' },
    });
    let [credits] = await app.db
      .select()
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, userId));
    expect(credits?.balance).toBe(0);

    await app.inject({
      method: 'PATCH',
      url: '/v1/me',
      headers: { authorization: `Bearer ${accessToken}` },
      payload: { email: `credittest${Date.now()}@example.com` },
    });
    [credits] = await app.db
      .select()
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, userId));
    expect(credits?.balance).toBe(50);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run:
```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts me-email
```
Expected: FAIL — `email` isn't accepted by the PATCH body schema yet (Fastify will 400 on the unrecognized-but-actually-just-ignored field, or the credits assertion will fail since email was never required before).

- [ ] **Step 3: Implement**

In `apps/api/src/modules/auth/routes.ts`, the `PATCH /v1/me` route (currently lines 499–606ish):

Body schema — current:
```ts
        body: z.object({
          displayName: z.string().min(1).max(60).optional(),
          phone: z
            .string()
            .regex(/^\d{10}$/, 'phone must be a 10-digit number')
            .nullable()
            .optional(),
          companyName: z.string().max(160).nullable().optional(),
          defaultResolution: z.enum(['HD', '2K', '4K']).optional(),
          defaultAspectRatio: z.enum(['1:1', '2:3', '3:4', '4:5']).optional(),
          defaultPlatform: z.string().max(60).optional(),
        }),
```
Add an `email` field:
```ts
        body: z.object({
          displayName: z.string().min(1).max(60).optional(),
          email: z.string().email().max(254).optional(),
          phone: z
            .string()
            .regex(/^\d{10}$/, 'phone must be a 10-digit number')
            .nullable()
            .optional(),
          companyName: z.string().max(160).nullable().optional(),
          defaultResolution: z.enum(['HD', '2K', '4K']).optional(),
          defaultAspectRatio: z.enum(['1:1', '2:3', '3:4', '4:5']).optional(),
          defaultPlatform: z.string().max(60).optional(),
        }),
```

Handler — current destructure:
```ts
      const {
        displayName,
        phone,
        companyName,
        defaultResolution,
        defaultAspectRatio,
        defaultPlatform,
      } = req.body as {
        displayName?: string;
        phone?: string | null;
        companyName?: string | null;
        defaultResolution?: string;
        defaultAspectRatio?: string;
        defaultPlatform?: string;
      };
```
Replace with:
```ts
      const {
        displayName,
        email,
        phone,
        companyName,
        defaultResolution,
        defaultAspectRatio,
        defaultPlatform,
      } = req.body as {
        displayName?: string;
        email?: string;
        phone?: string | null;
        companyName?: string | null;
        defaultResolution?: string;
        defaultAspectRatio?: string;
        defaultPlatform?: string;
      };
```

Right after the existing phone-uniqueness check block (which ends at the `}` before `const [updated] = await tx`), add an email-uniqueness check of the same shape:
```ts
        if (email) {
          const [conflict] = await tx
            .select({ id: schema.users.id })
            .from(schema.users)
            .where(and(eq(schema.users.email, email), sql`${schema.users.id} <> ${req.userId}`))
            .limit(1);
          if (conflict) {
            throw new AppError('EMAIL_TAKEN', 409, 'This email is already registered to another account.');
          }
        }
```

In the `.set({...})` object, add:
```ts
            ...(email !== undefined ? { email } : {}),
```
(alongside the existing `...(phone !== undefined ? ...)` line).

In the `.returning({...})` object, `email: schema.users.email,` is already present — no change needed there.

Finally, the free-credit gate — current:
```ts
        const complete = Boolean(updated.phone && /^\d{10}$/.test(updated.phone));
        if (!complete) return updated;
```
Replace with:
```ts
        const complete = Boolean(
          updated.phone && /^\d{10}$/.test(updated.phone) && updated.email,
        );
        if (!complete) return updated;
```

- [ ] **Step 4: Run the test again to confirm it passes**

Run:
```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts me-email
```
Expected: PASS (2 tests).

- [ ] **Step 5: Add `username` to the `GET /v1/me` response**

In the same file, the `GET /v1/me` route's select (currently lines 451–464) already selects several fields. Add `username: schema.users.username,` to that `.select({...})` object, right after `phone: schema.users.phone,`.

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @tryme/api exec tsc --noEmit -p .`
Expected: no output.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/auth/routes.ts apps/api/test/integration/me-email.test.ts
git commit -m "feat(api): accept email on PATCH /v1/me, require it for the free-credit unlock, expose username on GET /v1/me"
```

---

### Task 6: Backend — admin search matches username too

**Files:**
- Modify: `apps/api/src/modules/admin/jobs.routes.ts`
- Modify: `apps/api/src/modules/admin/users.routes.ts`

- [ ] **Step 1: Extend the `/admin/jobs` search**

In `apps/api/src/modules/admin/jobs.routes.ts`, current (lines ~43–49):
```ts
    if (search) {
      conditions.push(
        or(
          ilike(sql`${schema.jobs.id}::text`, `%${search}%`),
          ilike(schema.users.email, `%${search}%`),
        ) as ReturnType<typeof eq>,
      );
    }
```
Replace with:
```ts
    if (search) {
      conditions.push(
        or(
          ilike(sql`${schema.jobs.id}::text`, `%${search}%`),
          ilike(schema.users.email, `%${search}%`),
          ilike(schema.users.username, `%${search}%`),
        ) as ReturnType<typeof eq>,
      );
    }
```

- [ ] **Step 2: Extend the `/admin/users` search**

In `apps/api/src/modules/admin/users.routes.ts`, current (lines 27–32):
```ts
      const searchWhere = search
        ? or(
            ilike(schema.users.email, `%${search}%`),
            ilike(schema.users.displayName, `%${search}%`),
          )
        : undefined;
```
Replace with:
```ts
      const searchWhere = search
        ? or(
            ilike(schema.users.email, `%${search}%`),
            ilike(schema.users.displayName, `%${search}%`),
            ilike(schema.users.username, `%${search}%`),
          )
        : undefined;
```

Also add `username: schema.users.username,` to the two `.select({...})` objects in this file (the list route around line 44 and the detail route around line 104), right after `email: schema.users.email,` in each.

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @tryme/api exec tsc --noEmit -p .`
Expected: no output.

- [ ] **Step 4: Run the existing admin-jobs-type and admin-users tests to confirm no regression**

Run:
```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts admin-jobs-type
```
Expected: PASS (existing 3 tests, unaffected — search behavior wasn't covered before, this is additive).

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/admin/jobs.routes.ts apps/api/src/modules/admin/users.routes.ts
git commit -m "feat(api): admin search and list responses include username"
```

---

### Task 7: Frontend admin-web — types, Create User form, Reset Password action, null-email display fallbacks

**Files:**
- Modify: `apps/admin-web/src/types.ts`
- Modify: `apps/admin-web/src/pages/UsersPage.tsx`

- [ ] **Step 1: Update `User` type**

In `apps/admin-web/src/types.ts`, current `User` interface (lines 201–230) has:
```ts
export interface User {
  id: string;
  email: string;
  displayName: string | null;
  phone: string | null;
  ...
```
Change `email: string;` to `email: string | null;` and add `username: string | null;` right after it:
```ts
export interface User {
  id: string;
  email: string | null;
  username: string | null;
  displayName: string | null;
  phone: string | null;
  ...
```

- [ ] **Step 2: Add a shared display-label helper**

In `apps/admin-web/src/pages/UsersPage.tsx`, right after the existing `adminRoleLabel` function (currently lines 30–35), add:

```ts
function userLabel(u: { displayName: string | null; email: string | null; username: string | null }) {
  return u.displayName ?? u.email ?? u.username ?? 'User';
}
function userContact(u: { email: string | null; username: string | null }) {
  return u.email ?? (u.username ? `@${u.username}` : '—');
}
```

- [ ] **Step 3: Replace unguarded `u.email` reads with the helpers**

Every occurrence of the pattern `u.displayName ?? u.email` in this file (lines 408, 410, 444, 471, 745, 831, 918, 1148, 1158 — verify exact line numbers after Steps 1–2's edits shift them) becomes `userLabel(u)`.

The bare `{u.email}` display sites (lines 412, 1169) become `{userContact(u)}`.

The `<NameAvatar email={u.email} ... />` props (lines 408, 1148) become `<NameAvatar email={u.email ?? undefined} ... />` (NameAvatar's `email` prop is already optional — see `apps/admin-web/src/components/NameAvatar.tsx`).

The two `onNav('jobs', { page: 'jobs', search: u.email })` calls (lines 523, 659) become `onNav('jobs', { page: 'jobs', search: u.email ?? u.username ?? '' })`.

Line 328 (`email: detail.email` sent to `POST /admin/merchants` when granting merchant access) and line 971 (copy referencing `{u.email}` in the grant-merchant confirmation text) are left as-is: granting merchant access to a username-only account with no email will correctly fail with the existing validation error from `/admin/merchants` — a merchant record needs a real contact email, and that's a reasonable requirement, not a bug to fix here.

- [ ] **Step 4: Add "Create User" state and handler**

Near the other `EMPTY_..._FORM` constants (currently lines 17–28), add:
```ts
const EMPTY_CREATE_USER_FORM = {
  username: '',
  password: '',
  displayName: '',
  email: '',
  phone: '',
};
```

Near the other `useState` declarations in the component body (currently lines 48–77), add:
```ts
  const [showCreateUser, setShowCreateUser] = useState(false);
  const [createUserForm, setCreateUserForm] = useState(EMPTY_CREATE_USER_FORM);
  const [creatingUser, setCreatingUser] = useState(false);
  const [createUserError, setCreateUserError] = useState('');
```

Near the other handler functions (e.g. right after `handleToggleMerchantActive`, currently ending at line 391), add:
```ts
  function openCreateUser() {
    setCreateUserForm(EMPTY_CREATE_USER_FORM);
    setCreateUserError('');
    setShowCreateUser(true);
  }

  async function handleCreateUser() {
    setCreateUserError('');
    if (!createUserForm.username.trim() || !createUserForm.password || !createUserForm.displayName.trim()) {
      setCreateUserError('Username, password, and name are required.');
      return;
    }
    setCreatingUser(true);
    try {
      await apiFetch('/admin/users', {
        method: 'POST',
        body: JSON.stringify({
          username: createUserForm.username.trim(),
          password: createUserForm.password,
          displayName: createUserForm.displayName.trim(),
          email: createUserForm.email.trim() || undefined,
          phone: createUserForm.phone.trim() || undefined,
        }),
      });
      toast({ title: `Account created for ${createUserForm.displayName.trim()}` });
      setShowCreateUser(false);
      setPage(0);
      await load();
    } catch (err) {
      setCreateUserError(apiErrorMessage(err, 'Failed to create user'));
    } finally {
      setCreatingUser(false);
    }
  }

  async function handleResetPassword(newPassword: string) {
    if (!detail) return;
    await apiFetch(`/admin/users/${detail.id}/reset-password`, {
      method: 'POST',
      body: JSON.stringify({ newPassword }),
    });
    toast({ title: 'Password reset — share the new password with the customer' });
  }
```

`load` (currently defined via `useCallback` at line 79) is the existing function that refetches the paginated user list — `await load()` above is calling that same function, confirmed already in scope in this component.

- [ ] **Step 5: Add the "Create User" button to the list header**

In the list-view header (currently around line 1069, inside `<div className="head-tools">`, before the closing `</div>`), add:
```tsx
          <button className="btn" onClick={openCreateUser}>
            <Icon.Plus /> Create User
          </button>
```
`Icon.Plus` already exists (`apps/admin-web/src/components/Icons.tsx`) and is the icon most other "Add X" buttons in this codebase use (e.g. `ChatbotQnaPage.tsx`, `DevApiPage.tsx`, `WorkflowsPage.tsx`) — no new icon needed.

- [ ] **Step 6: Add the "Create User" modal**

Add this JSX block alongside the other modals (e.g. right after the `showGrantMerchant` modal block), following the exact same `modal-overlay`/`modal`/`modal-head`/`modal-body`/`modal-foot` + `.field`/`.field-row` + `className="input"` structure already used by the `showGrantMerchant` modal (see its `<div className="field"><label>...</label><input className="input" .../></div>` pattern a few hundred lines above in this same file):

```tsx
      {showCreateUser && (
        <div className="modal-overlay" onClick={() => setShowCreateUser(false)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-head">
              <h3>Create User</h3>
            </div>
            <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <p style={{ fontSize: 11.5, color: 'var(--muted)', margin: 0 }}>
                Give the account a username and password now. Email and phone are optional here —
                the customer will be prompted to add them the first time they log in.
              </p>
              {createUserError && (
                <div className="banner warn">
                  <p style={{ margin: 0, fontSize: 13 }}>{createUserError}</p>
                </div>
              )}
              <div className="field">
                <label>Username</label>
                <input
                  className="input"
                  value={createUserForm.username}
                  onChange={(e) => setCreateUserForm((f) => ({ ...f, username: e.target.value }))}
                  placeholder="e.g. priya_shop1"
                />
              </div>
              <div className="field">
                <label>Password</label>
                <input
                  className="input"
                  value={createUserForm.password}
                  onChange={(e) => setCreateUserForm((f) => ({ ...f, password: e.target.value }))}
                  placeholder="Share this with the customer directly"
                />
              </div>
              <div className="field">
                <label>Full name</label>
                <input
                  className="input"
                  value={createUserForm.displayName}
                  onChange={(e) => setCreateUserForm((f) => ({ ...f, displayName: e.target.value }))}
                />
              </div>
              <div className="field-row">
                <div className="field">
                  <label>Email</label>
                  <input
                    className="input"
                    value={createUserForm.email}
                    onChange={(e) => setCreateUserForm((f) => ({ ...f, email: e.target.value }))}
                    placeholder="Optional"
                  />
                </div>
                <div className="field">
                  <label>Phone</label>
                  <input
                    className="input"
                    value={createUserForm.phone}
                    onChange={(e) => setCreateUserForm((f) => ({ ...f, phone: e.target.value }))}
                    placeholder="Optional — 10-digit mobile number"
                  />
                </div>
              </div>
            </div>
            <div className="modal-foot">
              <button className="btn ghost" onClick={() => setShowCreateUser(false)} disabled={creatingUser}>
                Cancel
              </button>
              <button className="btn" onClick={() => void handleCreateUser()} disabled={creatingUser}>
                {creatingUser ? 'Creating…' : 'Create User'}
              </button>
            </div>
          </div>
        </div>
      )}
```

Check other input elements already in this file (e.g. inside the `showGrantMerchant` modal) for the exact CSS class used for text inputs (assumed `className="input"` above — confirm against an existing modal's `<input>` and correct if the actual class name differs).

- [ ] **Step 7: Add a "Reset Password" action to the user detail view**

In the detail view's `head-tools` (near the existing "Grant admin" button, currently around line 429), add a button that opens a small inline prompt. Reuse the existing `confirmSuspend`-style local modal pattern — add state:
```ts
  const [resettingPassword, setResettingPassword] = useState(false);
  const [newPasswordInput, setNewPasswordInput] = useState('');
```
and a button:
```tsx
            <button className="btn ghost" onClick={() => { setNewPasswordInput(''); setResettingPassword(true); }}>
              <Icon.Refresh /> Reset Password
            </button>
```
and a modal (same structure as the "Create User" one) with a single password input and a confirm button calling `handleResetPassword(newPasswordInput)` then closing itself.

- [ ] **Step 8: Update the search placeholder**

Current (line 1073): `placeholder="Search by name or email…"` → `placeholder="Search by name, email, or username…"`.

- [ ] **Step 9: Typecheck / build**

Run: `pnpm --filter @tryme/admin build`
Expected: builds cleanly (same pre-existing chunk-size warning as always, no new errors).

- [ ] **Step 10: Commit**

```bash
git add apps/admin-web/src/types.ts apps/admin-web/src/pages/UsersPage.tsx
git commit -m "feat(admin): add Create User form, Reset Password action, username-aware display"
```

---

### Task 8: Frontend catalogues-web — login accepts username, profile-completion collects email

**Files:**
- Modify: `apps/catalogues-web/src/app/(auth)/login/page.tsx`
- Modify: `apps/catalogues-web/src/components/profile-gate.tsx`
- Modify: `apps/catalogues-web/src/components/profile-completion-modal.tsx`
- Modify: `apps/catalogues-web/src/app/(app)/settings/page.tsx`

- [ ] **Step 1: Loosen the login form**

In `apps/catalogues-web/src/app/(auth)/login/page.tsx`:

Change the label (currently line 209) from `Email*` to `Email or Username*`.

Change the input (currently lines 215–222):
```tsx
                <input
                  id="email"
                  type="email"
                  placeholder="Enter your email"
                  autoComplete="email"
                  style={inputStyle}
                  {...register('email')}
                />
```
to:
```tsx
                <input
                  id="email"
                  type="text"
                  placeholder="Enter your email or username"
                  autoComplete="username"
                  style={inputStyle}
                  {...register('email')}
                />
```
(`type="email"` is removed because the value may now be a plain username, which the browser's native email-format validation would otherwise flag.)

The `zodResolver(LoginBody)` (line 107) automatically picks up the loosened validation from Task 2 — no change needed here.

- [ ] **Step 2: Extend `ProfileGate` to also require email**

`apps/catalogues-web/src/components/profile-gate.tsx` currently:
```tsx
'use client';

import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { api } from '@/lib/api';
import { ProfileCompletionModal } from './profile-completion-modal';

interface MeResponse {
  phone: string | null;
  companyName: string | null;
}

export function ProfileGate({ children }: { children: ReactNode }) {
  const { data, isLoading } = useQuery<MeResponse>({
    queryKey: ['me'],
    queryFn: () => api.get('/v1/me'),
    retry: false,
  });

  const complete = Boolean(data?.phone && /^\d{10}$/.test(data.phone));

  if (isLoading && !data) {
    return <div style={{ flex: 1, background: '#fff' }} />;
  }

  return (
    <>
      {children}
      <ProfileCompletionModal
        open={Boolean(data && !complete)}
        phone={data?.phone ?? null}
        companyName={data?.companyName ?? null}
      />
    </>
  );
}
```

Replace with:
```tsx
'use client';

import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { api } from '@/lib/api';
import { ProfileCompletionModal } from './profile-completion-modal';

interface MeResponse {
  email: string | null;
  phone: string | null;
  companyName: string | null;
}

export function ProfileGate({ children }: { children: ReactNode }) {
  const { data, isLoading } = useQuery<MeResponse>({
    queryKey: ['me'],
    queryFn: () => api.get('/v1/me'),
    retry: false,
  });

  const complete = Boolean(data?.phone && /^\d{10}$/.test(data.phone) && data?.email);

  if (isLoading && !data) {
    return <div style={{ flex: 1, background: '#fff' }} />;
  }

  return (
    <>
      {children}
      <ProfileCompletionModal
        open={Boolean(data && !complete)}
        email={data?.email ?? null}
        phone={data?.phone ?? null}
        companyName={data?.companyName ?? null}
      />
    </>
  );
}
```

- [ ] **Step 3: Add the email field to `ProfileCompletionModal`**

In `apps/catalogues-web/src/components/profile-completion-modal.tsx`:

Change the props signature (currently lines 11–19):
```tsx
export function ProfileCompletionModal({
  open,
  phone,
  companyName,
}: {
  open: boolean;
  phone: string | null;
  companyName: string | null;
}): React.ReactElement | null {
```
to:
```tsx
export function ProfileCompletionModal({
  open,
  email,
  phone,
  companyName,
}: {
  open: boolean;
  email: string | null;
  phone: string | null;
  companyName: string | null;
}): React.ReactElement | null {
```

Add an `EMAIL_REGEX` constant next to the existing `PHONE_REGEX` (line 8):
```ts
const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
```

Add `emailValue` state next to `phoneValue`/`companyValue` (currently lines 23–24):
```ts
  const [emailValue, setEmailValue] = useState('');
```

In the `useEffect` that resets form state on open (currently lines 28–33), add:
```ts
    setEmailValue(email ?? '');
```
right after `setPhoneValue(sanitizePhone(phone ?? ''));`, and add `email` to the effect's dependency array (`[open, phone, companyName]` → `[open, email, phone, companyName]`).

In `handleSave` (currently lines 67–94), the current validation only checks phone:
```ts
  async function handleSave() {
    const nextPhone = sanitizePhone(phoneValue);
    if (!PHONE_REGEX.test(nextPhone)) {
      setError('Enter a valid 10-digit mobile number.');
      return;
    }

    setSaving(true);
    setError('');
    try {
      await api.patch('/v1/me', {
        phone: nextPhone,
        companyName: companyValue.trim() || null,
      });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['me'] }),
        qc.invalidateQueries({ queryKey: ['credits'] }),
      ]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to save profile.';
      if (msg.includes('already assigned')) {
        setPhoneValue('');
      }
      setError(msg);
    } finally {
      setSaving(false);
    }
  }
```
Replace with:
```ts
  async function handleSave() {
    const nextPhone = sanitizePhone(phoneValue);
    if (!PHONE_REGEX.test(nextPhone)) {
      setError('Enter a valid 10-digit mobile number.');
      return;
    }
    const needsEmail = !email;
    if (needsEmail && !EMAIL_REGEX.test(emailValue.trim())) {
      setError('Enter a valid email address.');
      return;
    }

    setSaving(true);
    setError('');
    try {
      await api.patch('/v1/me', {
        phone: nextPhone,
        companyName: companyValue.trim() || null,
        ...(needsEmail ? { email: emailValue.trim() } : {}),
      });
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['me'] }),
        qc.invalidateQueries({ queryKey: ['credits'] }),
      ]);
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'Failed to save profile.';
      if (msg.includes('already assigned')) {
        setPhoneValue('');
      }
      if (msg.includes('already registered')) {
        setEmailValue('');
      }
      setError(msg);
    } finally {
      setSaving(false);
    }
  }
```

Add `emailValid` next to the existing `phoneValid` (currently line 96):
```ts
  const phoneValid = PHONE_REGEX.test(phoneValue);
  const emailValid = Boolean(email) || EMAIL_REGEX.test(emailValue.trim());
```

Add an email input field in the JSX, right before the existing "Mobile Number" field block (currently starting at line 168), shown only when there's no email on file yet:
```tsx
            {!email && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <label htmlFor="profile-email" style={{ fontSize: 14, fontWeight: 600, color: C.text }}>
                  Email Address *
                </label>
                <input
                  id="profile-email"
                  type="email"
                  value={emailValue}
                  onChange={(e) => setEmailValue(e.target.value)}
                  placeholder="you@example.com"
                  style={{
                    height: 44,
                    borderRadius: 10,
                    border: `1px solid ${error ? C.pink : C.border}`,
                    background: C.field,
                    color: C.text,
                    fontFamily: 'inherit',
                    fontSize: 14,
                    padding: '0 14px',
                    outline: 'none',
                  }}
                />
              </div>
            )}
```

Finally, update the submit button's `disabled` condition (currently line 240):
```tsx
              disabled={saving || !phoneValid}
```
to:
```tsx
              disabled={saving || !phoneValid || !emailValid}
```

- [ ] **Step 4: Update Settings page**

In `apps/catalogues-web/src/app/(app)/settings/page.tsx`:

`MeResponse` (currently lines 15–26): change `email: string;` to `email: string | null;` and add `username: string | null;` right after it:
```ts
interface MeResponse {
  id: string;
  email: string | null;
  username: string | null;
  displayName: string | null;
  phone: string | null;
  companyName: string | null;
  tier: string;
  hasPassword: boolean;
  defaultResolution: string;
  defaultAspectRatio: string;
  defaultPlatform: string;
}
```

Add `email` editing state next to the existing `name`/`phone`/`companyName` state (currently around line 212-214, right after `const [phone, setPhone] = useState<string | null>(null);`):
```ts
  const [email, setEmail] = useState<string | null>(null);
```

Current (line 293): `const email = me?.email ?? '';` — this local `const email` shadows the new state variable name. Rename it and derive editability:
```ts
  const emailVal = email ?? me?.email ?? '';
  const canEditEmail = !me?.email; // once an email is on file, it isn't editable here
```
Remove the old `const email = me?.email ?? '';` line entirely (it's superseded by `emailVal`).

Update the `saveProfile` PATCH payload (currently around line 312) to also send email when editable and non-empty:
```ts
      await api.patch('/v1/me', {
        displayName: nameVal.trim() || undefined,
        email: canEditEmail && emailVal.trim() ? emailVal.trim() : undefined,
        phone: phoneVal || null,
        companyName: companyNameVal.trim() || null,
        defaultAspectRatio: defaultAspectRatioVal,
        defaultPlatform: defaultPlatformVal,
        defaultResolution: defaultResolutionVal,
      });
```
(Match whatever the current exact field order/shape is in this call — the point is adding the `email` line, not reordering the others.)

Update the cancel handler (wherever `setName(null); setPhone(null); setCompanyName(null);` currently appears in the "Cancel" button's `onClick`) to also add `setEmail(null);`.

Change the Email Address field (currently line 487):
```tsx
                <Field label="Email Address" value={email} disabled />
```
to:
```tsx
                <Field
                  label="Email Address"
                  value={emailVal}
                  placeholder="you@example.com"
                  disabled={!editingProfile || !canEditEmail}
                  onChange={canEditEmail ? setEmail : undefined}
                />
```

If `me.username` is set, show it read-only right after the Email Address field (inside the same `<Row>`):
```tsx
                {me?.username && (
                  <Field label="Username" value={me.username} disabled />
                )}
```

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @tryme/web exec tsc --noEmit -p .`
Expected: no output.

- [ ] **Step 6: Biome check**

Run:
```bash
npx biome check "apps/catalogues-web/src/app/(auth)/login/page.tsx" "apps/catalogues-web/src/components/profile-gate.tsx" "apps/catalogues-web/src/components/profile-completion-modal.tsx" "apps/catalogues-web/src/app/(app)/settings/page.tsx"
```
Expected: clean (or only pre-existing warning-only findings — fix anything the formatter flags with `npx biome format --write <path>` and re-check).

- [ ] **Step 7: Commit**

```bash
git add "apps/catalogues-web/src/app/(auth)/login/page.tsx" apps/catalogues-web/src/components/profile-gate.tsx apps/catalogues-web/src/components/profile-completion-modal.tsx "apps/catalogues-web/src/app/(app)/settings/page.tsx"
git commit -m "feat(web): accept username at login, collect email in the profile-completion gate"
```

---

### Task 9: Final verification

- [ ] **Step 1: Full workspace typecheck**

Run: `pnpm typecheck`
Expected: clean across every package (`@tryme/db`, `@tryme/types`, `@tryme/api`, `@tryme/web`, `@tryme/admin`, etc.).

- [ ] **Step 2: Run every new/modified integration test together**

Run:
```bash
cd apps/api && npx vitest run --config vitest.integration.config.ts admin-create-user me-email admin-jobs-type
```
Expected: all PASS. If any fail when run together (shared Redis rate-limit state, per the known pre-existing test-isolation gap documented in `apps/api/vitest.integration.config.ts`), confirm each file still passes individually before treating it as a pre-existing, unrelated flake.

- [ ] **Step 3: Admin build**

Run: `pnpm --filter @tryme/admin build`
Expected: builds cleanly.

- [ ] **Step 4: Lint**

Run: `pnpm lint`
Expected: exit 0 — pre-existing warnings are fine, no new errors.

- [ ] **Step 5: Update `docs/progress.md`**

Add a new dated entry at the top summarizing what was built, what's verified, and explicitly note in "Failed / Not Done": no live browser click-through was performed (state whether one was possible in your environment), and that granting merchant access to a username-only account without an email will fail at the existing `/admin/merchants` validation (intentional, not a bug).

- [ ] **Step 6: Do not commit or push**

Per this repo's standing convention (`CLAUDE.md` "Git Commit & Push Policy" and the project's own remembered preference), commits happen per-task as instructed above, but do not `git push` or open a PR unless explicitly asked to in a later message.

---

## Open Questions / Follow-ups (flagged, not blocking)

- **Merchant grant on username-only accounts:** intentionally left failing (see Task 7 Step 3) — a merchant record needs a real contact email. If admins need to grant merchant access to a username-only customer, they'd need to have that customer add an email first (via the profile-completion modal) — this is existing behavior, not new friction introduced by this plan.
- **No email re-verification on profile-completion:** a customer could type any email into the profile-completion modal and it's accepted immediately (format + uniqueness checked, ownership not). This matches how phone numbers are already handled in this codebase (no OTP/verification), but is a lower bar than the self-registration flow's email-verification-link requirement. Flag to the user if this trade-off needs revisiting later.
- **Reset Password UX:** Task 7's reset-password modal takes a plain-text new password typed by the admin (no auto-generation). If a stronger requirement (auto-generate + show-once, force-change-on-next-login) is wanted later, that's a follow-up, not part of this plan.
