# Standard Admin Registration & Role-Based Access — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `ADMIN` role with restricted permissions (no workflow access, no asset deletion) and a user-request → super-admin-approve registration flow.

**Architecture:** Extend the existing `adminUsers` table with a `status` column (`pending`/`active`/`rejected`), add `ADMIN` to the role enum in the guard, split existing route preHandlers to differentiate read-write from delete, and add new endpoints for the approval flow.

**Tech Stack:** TypeScript, Fastify 5, Drizzle ORM (PostgreSQL), Vitest, Node 20+

---

## File Map

| File | Role |
|------|------|
| `packages/db/src/schema/admin.ts` | Drizzle table definition — add `status` column |
| `packages/db/src/migrations/0039_admin_status.sql` | New SQL migration |
| `apps/api/src/modules/admin/guard.ts` | Admin preHandler — add `ADMIN` role + `status` check |
| `apps/api/src/modules/auth/routes.ts` | Auth routes — add `POST /v1/auth/request-admin` |
| `apps/api/src/modules/admin/users.routes.ts` | Admin user management — add request list/approve/reject/revoke routes |
| `apps/api/src/modules/admin/models.routes.ts` | Asset routes — split `W` into `RW` + `D` |
| `apps/api/src/modules/admin/catalog.routes.ts` | Catalog routes — split `W` into `RW` + `D` |
| `apps/api/src/modules/admin/subcategories.routes.ts` | Garment type routes — split `W` into `RW` + `D` |
| `apps/api/src/modules/admin/jobs.routes.ts` | Job routes — add `ADMIN` to guards |
| `apps/api/src/modules/admin/credits.routes.ts` | Credit routes — add `ADMIN` to guards |
| `apps/api/src/modules/admin/workers.routes.ts` | Worker routes — add `ADMIN` to guards |
| `apps/api/src/modules/admin/me.routes.ts` | Admin me route — add `ADMIN` to guard |
| `apps/api/src/modules/admin/config.routes.ts` | Config routes — add `ADMIN` to read guard only |
| `apps/api/test/integration/admin-approval.test.ts` | New integration tests for approval flow |

---

### Task 1: DB Schema — Add `status` column

**Files:**
- Create: `packages/db/src/migrations/0039_admin_status.sql`
- Modify: `packages/db/src/schema/admin.ts:1-12`

- [ ] **Step 1: Write migration**

```sql
ALTER TABLE "admin_users" ADD COLUMN "status" text NOT NULL DEFAULT 'active';
```

Save to `packages/db/src/migrations/0039_admin_status.sql`.

- [ ] **Step 2: Update Drizzle schema**

In `packages/db/src/schema/admin.ts`, add the `status` column after `role`:

```typescript
import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { users } from './users.js';

export const adminUsers = pgTable('admin_users', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id')
    .notNull()
    .unique()
    .references(() => users.id, { onDelete: 'cascade' }),
  role: text('role').notNull().default('SUPPORT'), // SUPER_ADMIN | MODERATOR | SUPPORT | ADMIN
  status: text('status').notNull().default('active'), // pending | active | rejected
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
```

- [ ] **Step 3: Run migration to verify**

```bash
pnpm db:migrate
```

Expected: Migration runs successfully, `status` column appears in `admin_users` table.

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/schema/admin.ts packages/db/src/migrations/0039_admin_status.sql
git commit -m "feat(db): add status column to admin_users"
```

---

### Task 2: Update admin guard

**Files:**
- Modify: `apps/api/src/modules/admin/guard.ts:1-25`

- [ ] **Step 1: Replace guard.ts**

```typescript
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { AppError } from '../../lib/errors.js';

declare module 'fastify' {
  interface FastifyRequest {
    adminRole?: string;
  }
}

export function requireAdmin(
  roles: ('SUPER_ADMIN' | 'MODERATOR' | 'SUPPORT' | 'ADMIN')[],
) {
  return async (req: FastifyRequest) => {
    const app = req.server as FastifyInstance;
    await app.requireUser(req as any, undefined as any);
    const [a] = await app.db
      .select()
      .from(schema.adminUsers)
      .where(eq(schema.adminUsers.userId, req.userId));
    if (!a) throw new AppError('FORBIDDEN', 403, 'admin required');
    if (a.status !== 'active')
      throw new AppError('FORBIDDEN', 403, 'admin account not active');
    if (!roles.includes(a.role as any))
      throw new AppError('FORBIDDEN', 403, 'insufficient admin role');
    req.adminRole = a.role;
  };
}
```

- [ ] **Step 2: Build check**

```bash
pnpm --filter @tryme/api exec tsc --noEmit
```

Expected: No type errors.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/modules/admin/guard.ts
git commit -m "feat(guard): add ADMIN role and status check"
```

---

### Task 3: Add admin request/approval endpoints

**Files:**
- Modify: `apps/api/src/modules/auth/routes.ts:1-387`
- Modify: `apps/api/src/modules/admin/users.routes.ts:1-169`

- [ ] **Step 1: Add `POST /v1/auth/request-admin`** — insert this code before the closing `}` of `authRoutes`:

```typescript
  app.post(
    '/v1/auth/request-admin',
    { preHandler: app.requireUser },
    async (req, reply) => {
      const [existing] = await app.db
        .select()
        .from(schema.adminUsers)
        .where(eq(schema.adminUsers.userId, req.userId));

      if (existing) {
        if (existing.status === 'active') {
          throw new AppError('CONFLICT', 409, 'already an active admin');
        }
        if (existing.status === 'pending') {
          return { status: 'pending', role: existing.role };
        }
        await app.db
          .update(schema.adminUsers)
          .set({ status: 'pending' })
          .where(eq(schema.adminUsers.userId, req.userId));
        reply.code(200);
        return { status: 'pending', role: existing.role };
      }

      await app.db.insert(schema.adminUsers).values({
        userId: req.userId,
        role: 'ADMIN',
        status: 'pending',
      });
      reply.code(201);
      return { status: 'pending', role: 'ADMIN' };
    },
  );
```

- [ ] **Step 2: Add import `and` to `users.routes.ts`** — update line 3 from:

```typescript
import { count, desc, eq, ilike, isNotNull, or, sql } from 'drizzle-orm';
```
to:
```typescript
import { and, count, desc, eq, ilike, isNotNull, or, sql } from 'drizzle-orm';
```

- [ ] **Step 3: Add admin request management endpoints** — insert before the closing `}` of `adminUsersRoutes`:

```typescript
  const SUPER = requireAdmin(['SUPER_ADMIN']);

  app.get('/admin/admin-requests', { preHandler: SUPER }, async () => {
    const rows = await app.db
      .select({
        userId: schema.adminUsers.userId,
        email: schema.users.email,
        displayName: schema.users.displayName,
        requestedAt: schema.adminUsers.createdAt,
      })
      .from(schema.adminUsers)
      .innerJoin(schema.users, eq(schema.adminUsers.userId, schema.users.id))
      .where(eq(schema.adminUsers.status, 'pending'))
      .orderBy(schema.adminUsers.createdAt);
    return { items: rows };
  });

  app.post(
    '/admin/admin-requests/:userId/approve',
    {
      preHandler: SUPER,
      schema: { params: z.object({ userId: z.string().uuid() }) },
    },
    async (req) => {
      const { userId } = req.params as { userId: string };
      const [row] = await app.db
        .update(schema.adminUsers)
        .set({ status: 'active' })
        .where(and(eq(schema.adminUsers.userId, userId), eq(schema.adminUsers.status, 'pending')))
        .returning({ userId: schema.adminUsers.userId });
      if (!row) throw new AppError('NOT_FOUND', 404, 'no pending admin request for this user');
      return { ok: true, status: 'active' };
    },
  );

  app.post(
    '/admin/admin-requests/:userId/reject',
    {
      preHandler: SUPER,
      schema: { params: z.object({ userId: z.string().uuid() }) },
    },
    async (req) => {
      const { userId } = req.params as { userId: string };
      const [row] = await app.db
        .update(schema.adminUsers)
        .set({ status: 'rejected' })
        .where(and(eq(schema.adminUsers.userId, userId), eq(schema.adminUsers.status, 'pending')))
        .returning({ userId: schema.adminUsers.userId });
      if (!row) throw new AppError('NOT_FOUND', 404, 'no pending admin request for this user');
      return { ok: true, status: 'rejected' };
    },
  );

  app.delete(
    '/admin/admin-users/:userId',
    {
      preHandler: SUPER,
      schema: { params: z.object({ userId: z.string().uuid() }) },
    },
    async (req) => {
      const { userId } = req.params as { userId: string };
      await app.db.delete(schema.adminUsers).where(eq(schema.adminUsers.userId, userId));
      return { ok: true };
    },
  );
```

- [ ] **Step 4: Build check**

```bash
pnpm --filter @tryme/api exec tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/auth/routes.ts apps/api/src/modules/admin/users.routes.ts
git commit -m "feat(api): add admin request/approval/reject/revoke endpoints"
```

---

### Task 4: Split model/asset route guards (models.routes.ts)

**Files:**
- Modify: `apps/api/src/modules/admin/models.routes.ts:26-27`

- [ ] **Step 1: Replace guard declarations**

Replace lines 26-27:
```typescript
export async function adminAssetsRoutes(app: FastifyInstance) {
  const W = requireAdmin(['SUPER_ADMIN', 'MODERATOR']);
```
With:
```typescript
export async function adminAssetsRoutes(app: FastifyInstance) {
  const RW = requireAdmin(['SUPER_ADMIN', 'MODERATOR', 'ADMIN']);
  const D = requireAdmin(['SUPER_ADMIN', 'MODERATOR']);
```

- [ ] **Step 2: Replace ALL `preHandler: W` with `preHandler: RW`, then fix DELETE routes**

Use `replaceAll` to change `preHandler: W` → `preHandler: RW`. Then manually change these DELETE routes back to `preHandler: D`:

| Line | Route |
|------|-------|
| 104 | `DELETE /admin/assets/faces/:id` |
| 133 | `DELETE /admin/assets/faces` (bulk) |
| 258 | `DELETE /admin/assets/backgrounds/:id` |
| 288 | `DELETE /admin/assets/backgrounds` (bulk) |
| 823 | `DELETE /admin/assets/poses` (bulk) |
| 855 | `DELETE /admin/assets/poses/:id` |
| 1490 | `DELETE /admin/assets/pose-assets/:id` |
| 1531 | `DELETE /admin/assets/pose-assets` (bulk) |
| 1615 | `DELETE /admin/assets/recycle-bin` (hard delete) |

Note: `GET /admin/assets/recycle-bin` and `POST /admin/assets/recycle-bin/restore` stay as `RW`.

- [ ] **Step 3: Build check**

```bash
pnpm --filter @tryme/api exec tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/admin/models.routes.ts
git commit -m "feat(assets): split guards — ADMIN can read/write, not delete"
```

---

### Task 5: Split catalog and subcategories route guards

**Files:**
- Modify: `apps/api/src/modules/admin/catalog.routes.ts:17-18`
- Modify: `apps/api/src/modules/admin/subcategories.routes.ts:15-16`

- [ ] **Step 1: catalog.routes.ts** — replace line 18, add D, update delete routes

Replace:
```typescript
  const W = requireAdmin(['SUPER_ADMIN', 'MODERATOR']);
```
With:
```typescript
  const RW = requireAdmin(['SUPER_ADMIN', 'MODERATOR', 'ADMIN']);
  const D = requireAdmin(['SUPER_ADMIN', 'MODERATOR']);
```

Replace all `preHandler: W` → `preHandler: RW`, then fix:
- Line 196: `DELETE /admin/catalog/items/:id` → `preHandler: D`
- Line 238: `DELETE /admin/catalog/categories/:id` → `preHandler: D`

- [ ] **Step 2: subcategories.routes.ts** — replace line 16, add D, update delete route

Replace:
```typescript
  const W = requireAdmin(['SUPER_ADMIN', 'MODERATOR']);
```
With:
```typescript
  const RW = requireAdmin(['SUPER_ADMIN', 'MODERATOR', 'ADMIN']);
  const D = requireAdmin(['SUPER_ADMIN', 'MODERATOR']);
```

Replace all `preHandler: W` → `preHandler: RW`, then fix:
- Line 117: `DELETE /admin/assets/garment-types/:id` → `preHandler: D`

- [ ] **Step 3: Build check**

```bash
pnpm --filter @tryme/api exec tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/admin/catalog.routes.ts apps/api/src/modules/admin/subcategories.routes.ts
git commit -m "feat(catalog): split guards — ADMIN can read/write, not delete"
```

---

### Task 6: Add ADMIN to remaining route guards

**Files:**
- Modify: `apps/api/src/modules/admin/jobs.routes.ts:28-29`
- Modify: `apps/api/src/modules/admin/credits.routes.ts:11,62,79`
- Modify: `apps/api/src/modules/admin/users.routes.ts:16-17`
- Modify: `apps/api/src/modules/admin/workers.routes.ts:8,27`
- Modify: `apps/api/src/modules/admin/me.routes.ts:10`
- Modify: `apps/api/src/modules/admin/config.routes.ts:12,35`

Skip `creditPlans.routes.ts` — SUPER_ADMIN only, unchanged.

- [ ] **Step 1: jobs.routes.ts** — lines 28-29

```typescript
  const R = requireAdmin(['SUPER_ADMIN', 'MODERATOR', 'SUPPORT', 'ADMIN']);
  const W = requireAdmin(['SUPER_ADMIN', 'MODERATOR', 'ADMIN']);
```

- [ ] **Step 2: credits.routes.ts** — line 11 + 62 + 79

Line 11: `const W = requireAdmin(['SUPER_ADMIN', 'MODERATOR', 'ADMIN']);`
Line 62: `preHandler: requireAdmin(['SUPER_ADMIN', 'MODERATOR', 'SUPPORT', 'ADMIN'])`
Line 79: `preHandler: requireAdmin(['SUPER_ADMIN', 'MODERATOR', 'SUPPORT', 'ADMIN'])`

- [ ] **Step 3: users.routes.ts** — lines 16-17 (add ADMIN, keep SUPER_ADMIN for user delete at line 142)

```typescript
  const ALL = requireAdmin(['SUPER_ADMIN', 'MODERATOR', 'SUPPORT', 'ADMIN']);
  const WRITE = requireAdmin(['SUPER_ADMIN', 'MODERATOR', 'ADMIN']);
```

- [ ] **Step 4: workers.routes.ts** — lines 8, 27

Line 8: `{ preHandler: requireAdmin(['SUPER_ADMIN', 'MODERATOR', 'SUPPORT', 'ADMIN']) }`
Line 27: `preHandler: requireAdmin(['SUPER_ADMIN', 'MODERATOR', 'ADMIN'])`

- [ ] **Step 5: me.routes.ts** — line 10

```typescript
    { preHandler: requireAdmin(['SUPER_ADMIN', 'MODERATOR', 'SUPPORT', 'ADMIN']) },
```

- [ ] **Step 6: config.routes.ts** — lines 12, 35 (NOT 22 — SUPER_ADMIN only write stays)

Line 12: `{ preHandler: requireAdmin(['SUPER_ADMIN', 'MODERATOR', 'SUPPORT', 'ADMIN']) }`
Line 35: `{ preHandler: requireAdmin(['SUPER_ADMIN', 'MODERATOR', 'SUPPORT', 'ADMIN']) }`

- [ ] **Step 7: Build check**

```bash
pnpm --filter @tryme/api exec tsc --noEmit
```

- [ ] **Step 8: Commit**

```bash
git add apps/api/src/modules/admin/jobs.routes.ts apps/api/src/modules/admin/credits.routes.ts apps/api/src/modules/admin/users.routes.ts apps/api/src/modules/admin/workers.routes.ts apps/api/src/modules/admin/me.routes.ts apps/api/src/modules/admin/config.routes.ts
git commit -m "feat(admin): add ADMIN role to remaining route guards"
```

---

### Task 7: Write integration tests

**Files:**
- Create: `apps/api/test/integration/admin-approval.test.ts`

Test harness: `buildTestApp()` from `test/helpers/api.js`, uses `app.inject()`. Pattern from `admin-users.test.ts`.

- [ ] **Step 1: Create test file**

```typescript
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from '../helpers/api';
import { type Containers, startContainers } from '../helpers/containers';

describe('admin-approval', () => {
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

  async function registerAndVerify(email: string, password = 'password123') {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email, password },
    });
    const token = res.json().accessToken;
    const userId = JSON.parse(
      Buffer.from(token.split('.')[1], 'base64').toString(),
    ).sub;
    await app.db
      .update(schema.users)
      .set({ emailVerified: true })
      .where(eq(schema.users.id, userId));
    return { token, userId };
  }

  it('regular user can request admin', async () => {
    const { token, userId } = await registerAndVerify('req1@test.com');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/request-admin',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(201);
    expect(res.json().status).toBe('pending');
    const [row] = await app.db
      .select()
      .from(schema.adminUsers)
      .where(eq(schema.adminUsers.userId, userId));
    expect(row.status).toBe('pending');
  });

  it('re-request while pending is idempotent', async () => {
    const { token } = await registerAndVerify('req2@test.com');
    await app.inject({
      method: 'POST',
      url: '/v1/auth/request-admin',
      headers: { authorization: `Bearer ${token}` },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/request-admin',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('pending');
  });

  it('active admin cannot re-request', async () => {
    const { token, userId } = await registerAndVerify('req3@test.com');
    await app.db
      .insert(schema.adminUsers)
      .values({ userId, role: 'ADMIN', status: 'active' });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/request-admin',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(409);
  });

  it('pending user blocked from admin routes', async () => {
    const { token, userId } = await registerAndVerify('req4@test.com');
    await app.db
      .insert(schema.adminUsers)
      .values({ userId, role: 'ADMIN', status: 'pending' });
    const res = await app.inject({
      method: 'GET',
      url: '/admin/users',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejected user blocked from admin routes', async () => {
    const { token, userId } = await registerAndVerify('req5@test.com');
    await app.db
      .insert(schema.adminUsers)
      .values({ userId, role: 'ADMIN', status: 'rejected' });
    const res = await app.inject({
      method: 'GET',
      url: '/admin/users',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejected user can re-apply', async () => {
    const { token, userId } = await registerAndVerify('req6@test.com');
    await app.db
      .insert(schema.adminUsers)
      .values({ userId, role: 'ADMIN', status: 'rejected' });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/request-admin',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const [row] = await app.db
      .select()
      .from(schema.adminUsers)
      .where(eq(schema.adminUsers.userId, userId));
    expect(row.status).toBe('pending');
  });

  it('super admin can list pending requests', async () => {
    const { token: superToken, userId: superId } =
      await registerAndVerify('super-lr@test.com');
    await app.db
      .insert(schema.adminUsers)
      .values({ userId: superId, role: 'SUPER_ADMIN', status: 'active' });
    const { token: pendingToken } =
      await registerAndVerify('pending-lr@test.com');
    await app.inject({
      method: 'POST',
      url: '/v1/auth/request-admin',
      headers: { authorization: `Bearer ${pendingToken}` },
    });
    const res = await app.inject({
      method: 'GET',
      url: '/admin/admin-requests',
      headers: { authorization: `Bearer ${superToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().items.length).toBeGreaterThanOrEqual(1);
  });

  it('super admin can approve a request', async () => {
    const { token: superToken, userId: superId } =
      await registerAndVerify('super-ap@test.com');
    await app.db
      .insert(schema.adminUsers)
      .values({ userId: superId, role: 'SUPER_ADMIN', status: 'active' });
    const { userId: reqId } = await registerAndVerify('approve-me@test.com');
    // Use a fresh register to get the token, then directly insert pending via DB
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/request-admin',
      headers: {
        authorization: `Bearer ${
          (await registerAndVerify('approve-me2@test.com')).token
        }`,
      },
    });
    expect(res.statusCode).toBe(201);

    // Actually, let's use a simpler approach — get user's token and use it
    const { token: reqToken, userId: requestUserId } =
      await registerAndVerify('approve-target@test.com');
    await app.inject({
      method: 'POST',
      url: '/v1/auth/request-admin',
      headers: { authorization: `Bearer ${reqToken}` },
    });

    const approveRes = await app.inject({
      method: 'POST',
      url: `/admin/admin-requests/${requestUserId}/approve`,
      headers: { authorization: `Bearer ${superToken}` },
    });
    expect(approveRes.statusCode).toBe(200);
    expect(approveRes.json().ok).toBe(true);

    const [row] = await app.db
      .select()
      .from(schema.adminUsers)
      .where(eq(schema.adminUsers.userId, requestUserId));
    expect(row.status).toBe('active');
  });

  it('super admin can reject a request', async () => {
    const { token: superToken, userId: superId } =
      await registerAndVerify('super-rj@test.com');
    await app.db
      .insert(schema.adminUsers)
      .values({ userId: superId, role: 'SUPER_ADMIN', status: 'active' });
    const { token: reqToken, userId: requestUserId } =
      await registerAndVerify('reject-target@test.com');
    await app.inject({
      method: 'POST',
      url: '/v1/auth/request-admin',
      headers: { authorization: `Bearer ${reqToken}` },
    });

    const rejectRes = await app.inject({
      method: 'POST',
      url: `/admin/admin-requests/${requestUserId}/reject`,
      headers: { authorization: `Bearer ${superToken}` },
    });
    expect(rejectRes.statusCode).toBe(200);
    expect(rejectRes.json().ok).toBe(true);

    const [row] = await app.db
      .select()
      .from(schema.adminUsers)
      .where(eq(schema.adminUsers.userId, requestUserId));
    expect(row.status).toBe('rejected');
  });

  it('super admin can revoke an active admin', async () => {
    const { token: superToken, userId: superId } =
      await registerAndVerify('super-rv@test.com');
    await app.db
      .insert(schema.adminUsers)
      .values({ userId: superId, role: 'SUPER_ADMIN', status: 'active' });
    const { userId: adminId } = await registerAndVerify('revoke-me@test.com');
    await app.db
      .insert(schema.adminUsers)
      .values({ userId: adminId, role: 'ADMIN', status: 'active' });

    const res = await app.inject({
      method: 'DELETE',
      url: `/admin/admin-users/${adminId}`,
      headers: { authorization: `Bearer ${superToken}` },
    });
    expect(res.statusCode).toBe(200);

    const [row] = await app.db
      .select()
      .from(schema.adminUsers)
      .where(eq(schema.adminUsers.userId, adminId));
    expect(row).toBeUndefined();
  });

  it('approved ADMIN can access admin routes', async () => {
    const { token, userId } = await registerAndVerify('admin-ok@test.com');
    await app.db
      .insert(schema.adminUsers)
      .values({ userId, role: 'ADMIN', status: 'active' });
    const res = await app.inject({
      method: 'GET',
      url: '/admin/users',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.json().items)).toBe(true);
  });

  it('ADMIN cannot delete assets', async () => {
    const { token, userId } = await registerAndVerify('admin-nodel@test.com');
    await app.db
      .insert(schema.adminUsers)
      .values({ userId, role: 'ADMIN', status: 'active' });
    const res = await app.inject({
      method: 'DELETE',
      url: '/admin/assets/faces/00000000-0000-0000-0000-000000000001',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('ADMIN cannot access workflows', async () => {
    const { token, userId } = await registerAndVerify('admin-nowf@test.com');
    await app.db
      .insert(schema.adminUsers)
      .values({ userId, role: 'ADMIN', status: 'active' });
    const res = await app.inject({
      method: 'GET',
      url: '/admin/workflows',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('non-admin cannot approve/reject', async () => {
    const { token, userId } = await registerAndVerify('rando@test.com');
    // Not an admin at all
    const res = await app.inject({
      method: 'POST',
      url: `/admin/admin-requests/${userId}/approve`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(403);
  });
});
```

- [ ] **Step 2: Run tests**

```bash
pnpm --filter @tryme/api test -- -t 'admin-approval'
```

Expected: All tests pass.

- [ ] **Step 3: Commit**

```bash
git add apps/api/test/integration/admin-approval.test.ts
git commit -m "test: admin approval flow integration tests"
```

---

### Task 8: Full verification

- [ ] **Step 1: Full build**

```bash
pnpm build
```

Expected: All packages build successfully.

- [ ] **Step 2: Full API test suite**

```bash
pnpm --filter @tryme/api test
```

Expected: All tests pass.

- [ ] **Step 3: Fix and commit any issues found**
