# User Pose Presets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user save named sets of poses (a "preset") in the studio pose
step and re-apply them in one click, plus an auto-tracked "last used" preset
that always reflects their most recent pose selection.

**Architecture:** New table `user_pose_presets` holds one row per named
preset plus one auto-updated row per user for "last used". A new API module
(`apps/api/src/modules/pose-presets/`) exposes list/create/delete. The
existing `/v1/jobs/tryon` handler (`createJob` in
`apps/api/src/modules/jobs/create.ts`) — the only endpoint the studio wizard's
pose step feeds into — upserts the last-used row as a best-effort side
effect after job creation succeeds. The studio wizard's pose step
(`apps/catalogues-web/src/app/(app)/studio/page.tsx`) gets a chip row above
the pose grid to apply/save/delete presets.

**Tech Stack:** Fastify 5 + `fastify-type-provider-zod`, Drizzle ORM /
PostgreSQL 16, Next.js 15 + TanStack Query, Vitest integration tests against
the docker-compose Postgres.

**Spec:** `docs/superpowers/specs/2026-08-21-user-pose-presets-design.md`

## Global Constraints

- Presets store `poseIds` only — no face/background/garment. (spec: Scope)
- Max 10 named presets per user, enforced in the API layer. (spec: Data model)
- Exactly one `isLastUsed` row per user, auto-updated by `/v1/jobs/tryon` —
  never user-creatable or user-deletable. (spec: Scope, API)
- No FK from `poseIds` array elements to `model_pose_assets.id` — Postgres
  can't constrain array elements. Staleness is filtered at read time.
  (spec: Data model)
- Last-used upsert must never throw back to the caller or roll back the
  job/credit transaction — log and swallow on failure. (spec: Last-used
  auto-upsert)
- All routes require the existing user-JWT auth (`app.requireUser`) — no new
  auth pattern. (spec: API)

---

### Task 1: `user_pose_presets` table + migration

**Files:**
- Modify: `packages/db/src/schema/models.ts` (append new table at end of file)
- Create: migration via `pnpm db:generate` (will land as
  `packages/db/src/migrations/0168_user_pose_presets.sql` or the next free
  number — check `packages/db/src/migrations/` for the current max before
  generating)

**Interfaces:**
- Produces: `schema.userPosePresets` (Drizzle table) with columns `id`,
  `userId`, `name`, `poseIds` (`uuid[]`), `isLastUsed`, `createdAt`,
  `updatedAt` — consumed by Task 2 (Zod schema), Task 3 (routes), and Task 4
  (last-used upsert).

- [ ] **Step 1: Add the table definition**

Add `uniqueIndex` to the existing `drizzle-orm/pg-core` import at the top of
`packages/db/src/schema/models.ts` (it currently imports `boolean, index,
integer, jsonb, pgTable, primaryKey, text, timestamp, unique, uuid` — add
`uniqueIndex` alphabetically into that list), then append at the end of the
file:

```ts
// Per-user saved pose sets for the studio wizard's pose step. isLastUsed rows
// are auto-managed by createJob (apps/api/src/modules/jobs/create.ts) after
// every /v1/jobs/tryon submission — never user-created or user-deleted.
// Named presets are explicit, capped at 10/user in the API layer (arrays
// can't carry a DB-level count constraint). poseIds has no FK to
// model_pose_assets — Postgres can't FK-constrain array elements, so
// staleness (a pose later deactivated) is filtered out at read time instead.
export const userPosePresets = pgTable(
  'user_pose_presets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    name: text('name'), // null only for the isLastUsed row
    poseIds: uuid('pose_ids').array().notNull(),
    isLastUsed: boolean('is_last_used').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // At most one last-used row per user.
    uniqueIndex('user_pose_presets_one_last_used_idx').on(t.userId).where(sql`${t.isLastUsed}`),
    // Exact-match safety net against the create-time case-insensitive app check
    // (Task 3) racing itself — not a full case-insensitive constraint (no
    // functional-index precedent elsewhere in this schema), just enough to stop
    // two concurrent requests from both landing the exact same name.
    uniqueIndex('user_pose_presets_unique_name_idx')
      .on(t.userId, t.name)
      .where(sql`NOT ${t.isLastUsed}`),
    index('user_pose_presets_user_id_idx').on(t.userId),
  ],
);
```

- [ ] **Step 2: Generate the migration**

Run: `pnpm db:generate` (from repo root)

Check `packages/db/src/migrations/` for the newly created file. Confirm it
contains a `CREATE TABLE "user_pose_presets"` statement with a `uuid[]`
`pose_ids` column, both partial unique indexes (`WHERE "is_last_used"` and
`WHERE NOT "is_last_used"`), and the plain user_id index — matching the
syntax already used for `chatbot_conversations_one_active_idx` in
`packages/db/src/migrations/0083_chatbot_schema.sql` and
`shopify_funnel_templates_single_default_idx` in
`packages/db/src/migrations/0137_shopify_funnel_default.sql`. If drizzle-kit
emitted anything materially different (e.g. missing a `NOT NULL`), fix the
schema in Step 1 and regenerate rather than hand-editing the SQL.

- [ ] **Step 3: Apply the migration locally**

Run: `pnpm docker:up` (if not already running), then `pnpm db:migrate`
Expected: migration applies cleanly, no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/db/src/schema/models.ts packages/db/src/migrations/
git commit -m "feat(db): add user_pose_presets table"
```

---

### Task 2: Zod schemas

**Files:**
- Create: `packages/types/src/posePresets.ts`
- Modify: `packages/types/src/index.ts:1-16` (add export line, alphabetically
  after `jobs.ts` and before `rate-limits.ts`)

**Interfaces:**
- Consumes: nothing (pure Zod, no DB/runtime deps).
- Produces: `PosePresetSchema`, `CreatePosePresetRequest`, and their inferred
  types `PosePreset`, `CreatePosePresetBody` — consumed by Task 3 (route
  request/response validation) and Task 5 (web client typing).

- [ ] **Step 1: Write the schemas**

```ts
import { z } from 'zod';

export const PosePresetSchema = z.object({
  id: z.string().uuid(),
  name: z.string().nullable(),
  poseIds: z.array(z.string().uuid()),
  isLastUsed: z.boolean(),
  updatedAt: z.string(),
});
export type PosePreset = z.infer<typeof PosePresetSchema>;

export const CreatePosePresetRequest = z.object({
  name: z.string().trim().min(1).max(40),
  poseIds: z.array(z.string().uuid()).min(1),
});
export type CreatePosePresetBody = z.infer<typeof CreatePosePresetRequest>;

export const ListPosePresetsResponse = z.object({
  lastUsed: PosePresetSchema.nullable(),
  named: z.array(PosePresetSchema),
});
export type ListPosePresetsResult = z.infer<typeof ListPosePresetsResponse>;
```

- [ ] **Step 2: Export from the package barrel**

In `packages/types/src/index.ts`, insert after the `jobs.js` line:

```ts
export * from './posePresets.js';
```

- [ ] **Step 3: Typecheck the package**

Run: `pnpm --filter @tryme/types typecheck` (or `pnpm typecheck` from
root if the package has no standalone script — check
`packages/types/package.json` first)
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/types/src/posePresets.ts packages/types/src/index.ts
git commit -m "feat(types): add pose preset Zod schemas"
```

---

### Task 3: `pose-presets` API module (list, create, delete)

**Files:**
- Create: `apps/api/src/modules/pose-presets/routes.ts`
- Modify: `apps/api/src/server.ts` (import + register, alongside the other
  `modules/*/routes.js` imports around line 64 and the
  `app.register(jobsRoutes)` call around line 360)
- Test: `apps/api/test/integration/pose-presets.test.ts`

**Interfaces:**
- Consumes: `schema.userPosePresets`, `schema.modelPoseAssets` (Task 1),
  `PosePresetSchema` / `CreatePosePresetRequest` / `ListPosePresetsResponse`
  (Task 2), `AppError` (`apps/api/src/lib/errors.js`), `app.requireUser`
  preHandler (`apps/api/src/plugins/auth.ts`), `req.userId`.
- Produces: `posePresetsRoutes(app: FastifyInstance)` — registered in
  `server.ts`. Routes: `GET /v1/pose-presets`, `POST /v1/pose-presets`,
  `DELETE /v1/pose-presets/:id`.

- [ ] **Step 1: Write the route module**

```ts
import { schema } from '@tryme/db';
import { CreatePosePresetRequest, ListPosePresetsResponse } from '@tryme/types';
import { and, desc, eq, inArray, isNull, not } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';

const MAX_NAMED_PRESETS = 10;

async function activePoseIds(app: FastifyInstance, poseIds: string[]): Promise<string[]> {
  if (poseIds.length === 0) return [];
  const rows = await app.db
    .select({ id: schema.modelPoseAssets.id })
    .from(schema.modelPoseAssets)
    .where(
      and(
        inArray(schema.modelPoseAssets.id, poseIds),
        eq(schema.modelPoseAssets.isActive, true),
        isNull(schema.modelPoseAssets.deletedAt),
      ),
    );
  return rows.map((r) => r.id);
}

export async function posePresetsRoutes(app: FastifyInstance) {
  app.get('/v1/pose-presets', { preHandler: app.requireUser }, async (req) => {
    const rows = await app.db
      .select()
      .from(schema.userPosePresets)
      .where(eq(schema.userPosePresets.userId, req.userId))
      .orderBy(desc(schema.userPosePresets.updatedAt));

    const filtered = await Promise.all(
      rows.map(async (r) => ({
        id: r.id,
        name: r.name,
        poseIds: await activePoseIds(app, r.poseIds),
        isLastUsed: r.isLastUsed,
        updatedAt: r.updatedAt.toISOString(),
      })),
    );

    return ListPosePresetsResponse.parse({
      lastUsed: filtered.find((p) => p.isLastUsed) ?? null,
      named: filtered.filter((p) => !p.isLastUsed),
    });
  });

  app.post(
    '/v1/pose-presets',
    { preHandler: app.requireUser, schema: { body: CreatePosePresetRequest } },
    async (req, reply) => {
      const { name, poseIds } = req.body as z.infer<typeof CreatePosePresetRequest>;

      const valid = await activePoseIds(app, poseIds);
      if (valid.length !== poseIds.length) {
        throw new AppError('INVALID_POSE_IDS', 400, 'one or more poses are not active');
      }

      const named = await app.db
        .select({ id: schema.userPosePresets.id, name: schema.userPosePresets.name })
        .from(schema.userPosePresets)
        .where(
          and(
            eq(schema.userPosePresets.userId, req.userId),
            not(schema.userPosePresets.isLastUsed),
          ),
        );
      if (named.length >= MAX_NAMED_PRESETS) {
        throw new AppError('PRESET_LIMIT_REACHED', 409, `max ${MAX_NAMED_PRESETS} presets`);
      }
      if (named.some((r) => r.name?.toLowerCase() === name.toLowerCase())) {
        throw new AppError('PRESET_NAME_TAKEN', 409, 'a preset with this name already exists');
      }

      const [created] = await app.db
        .insert(schema.userPosePresets)
        .values({ userId: req.userId, name, poseIds })
        .returning();

      reply.code(201);
      return {
        id: created.id,
        name: created.name,
        poseIds: created.poseIds,
        isLastUsed: created.isLastUsed,
        updatedAt: created.updatedAt.toISOString(),
      };
    },
  );

  app.delete(
    '/v1/pose-presets/:id',
    { preHandler: app.requireUser, schema: { params: z.object({ id: z.string().uuid() }) } },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const [row] = await app.db
        .select()
        .from(schema.userPosePresets)
        .where(and(eq(schema.userPosePresets.id, id), eq(schema.userPosePresets.userId, req.userId)));
      if (!row) throw new AppError('NOT_FOUND', 404, 'preset not found');
      if (row.isLastUsed) {
        throw new AppError('VALIDATION', 400, 'the last-used preset cannot be deleted directly');
      }
      await app.db.delete(schema.userPosePresets).where(eq(schema.userPosePresets.id, id));
      reply.code(204);
    },
  );
}
```

The `named` query above is intentionally shared by both the cap check and
the name-conflict check — one round trip instead of two.

- [ ] **Step 2: Register the module in `server.ts`**

Add the import near the other module imports (alphabetically, after the
`payments` import and before `merchant/*`, matching the existing
alphabetical-by-path ordering in that block):

```ts
import { posePresetsRoutes } from './modules/pose-presets/routes.js';
```

Add the registration call next to `await app.register(jobsRoutes);` (around
line 360):

```ts
  await app.register(posePresetsRoutes);
```

- [ ] **Step 3: Write integration tests**

```ts
import { schema } from '@tryme/db';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from '../helpers/api';
import { type Containers, startContainers } from '../helpers/containers';

describe('pose presets', () => {
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

  async function getToken(email: string) {
    await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { displayName: 'Preset User', email, password: 'password123' },
    });
    const [user] = await app.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, email));
    if (!user) throw new Error('user not found');
    await app.db
      .update(schema.users)
      .set({ emailVerified: true })
      .where(eq(schema.users.id, user.id));
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email, password: 'password123' },
    });
    return { token: login.json().accessToken as string, userId: user.id };
  }

  async function makePose(active = true) {
    const [pose] = await app.db
      .insert(schema.modelPoseAssets)
      .values({
        label: `pose-${Date.now()}-${Math.random()}`,
        genderSlug: 'women',
        r2Key: 'p.jpg',
        thumbnailKey: 'p-thumb.jpg',
        isActive: active,
      })
      .returning();
    return pose.id;
  }

  it('creates and lists a named preset', async () => {
    const { token } = await getToken('preset-crud@x.com');
    const poseId = await makePose();

    const create = await app.inject({
      method: 'POST',
      url: '/v1/pose-presets',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'My Look', poseIds: [poseId] },
    });
    expect(create.statusCode).toBe(201);
    expect(create.json().name).toBe('My Look');

    const list = await app.inject({
      method: 'GET',
      url: '/v1/pose-presets',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().named).toHaveLength(1);
    expect(list.json().named[0].poseIds).toEqual([poseId]);
  });

  it('rejects an 11th named preset with PRESET_LIMIT_REACHED', async () => {
    const { token } = await getToken('preset-cap@x.com');
    for (let i = 0; i < 10; i++) {
      const poseId = await makePose();
      const res = await app.inject({
        method: 'POST',
        url: '/v1/pose-presets',
        headers: { authorization: `Bearer ${token}` },
        payload: { name: `Look ${i}`, poseIds: [poseId] },
      });
      expect(res.statusCode).toBe(201);
    }
    const poseId = await makePose();
    const overflow = await app.inject({
      method: 'POST',
      url: '/v1/pose-presets',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Look 11', poseIds: [poseId] },
    });
    expect(overflow.statusCode).toBe(409);
    expect(overflow.json().error.code).toBe('PRESET_LIMIT_REACHED');
  });

  it('rejects a duplicate name (case-insensitive) with PRESET_NAME_TAKEN', async () => {
    const { token } = await getToken('preset-dupe@x.com');
    const poseId = await makePose();
    await app.inject({
      method: 'POST',
      url: '/v1/pose-presets',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Beach Day', poseIds: [poseId] },
    });
    const dupe = await app.inject({
      method: 'POST',
      url: '/v1/pose-presets',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'beach day', poseIds: [poseId] },
    });
    expect(dupe.statusCode).toBe(409);
    expect(dupe.json().error.code).toBe('PRESET_NAME_TAKEN');
  });

  it('filters out inactive poses on GET and 400s on create with an inactive pose', async () => {
    const { token } = await getToken('preset-inactive@x.com');
    const inactivePoseId = await makePose(false);
    const create = await app.inject({
      method: 'POST',
      url: '/v1/pose-presets',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Stale', poseIds: [inactivePoseId] },
    });
    expect(create.statusCode).toBe(400);
    expect(create.json().error.code).toBe('INVALID_POSE_IDS');
  });

  it('cannot delete another user\'s preset', async () => {
    const a = await getToken('preset-owner-a@x.com');
    const b = await getToken('preset-owner-b@x.com');
    const poseId = await makePose();
    const created = await app.inject({
      method: 'POST',
      url: '/v1/pose-presets',
      headers: { authorization: `Bearer ${a.token}` },
      payload: { name: 'Owned By A', poseIds: [poseId] },
    });
    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/pose-presets/${created.json().id}`,
      headers: { authorization: `Bearer ${b.token}` },
    });
    expect(del.statusCode).toBe(404);
  });

  it('rejects deleting the last-used row', async () => {
    const { token, userId } = await getToken('preset-last-used-del@x.com');
    const poseId = await makePose();
    const [lastUsed] = await app.db
      .insert(schema.userPosePresets)
      .values({ userId, poseIds: [poseId], isLastUsed: true })
      .returning();
    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/pose-presets/${lastUsed.id}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(del.statusCode).toBe(400);
  });
});
```

- [ ] **Step 4: Run the integration tests**

Run (from `apps/api`, with `pnpm docker:up` running):
`npx vitest run --config vitest.integration.config.ts test/integration/pose-presets.test.ts`
Expected: all 6 tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/pose-presets/ apps/api/src/server.ts apps/api/test/integration/pose-presets.test.ts
git commit -m "feat(api): add pose presets CRUD endpoints"
```

---

### Task 4: Auto-upsert the last-used preset on job creation

**Files:**
- Modify: `apps/api/src/modules/jobs/create.ts:916` (inside `createJob`,
  just before the existing `return { catalogueId: plan.catalogueId, jobIds
  };`)
- Test: `apps/api/test/integration/pose-presets.test.ts` (append a new
  `describe` block, same file as Task 3)

**Interfaces:**
- Consumes: `plan.looks` (already in scope at that point in `createJob`,
  each look has a `poseId: string` field per the existing `for (const look of
  plan.looks)` loop at line 848), `schema.userPosePresets` (Task 1).
- Produces: nothing new consumed elsewhere — this is a terminal side effect.

- [ ] **Step 1: Add the upsert helper and call site**

In `apps/api/src/modules/jobs/create.ts`, add this function above
`createJob` (near the other helpers like `resolveQueueRouting`):

```ts
/**
 * Best-effort last-used pose preset update. Runs after job creation has
 * already committed and enqueued — never allowed to fail the request. A
 * delete+insert pair (not onConflictDoUpdate) because the "one row per user"
 * constraint is a partial unique index on isLastUsed=true, and there's no
 * existing precedent in this codebase for targeting a partial index as an
 * ON CONFLICT arbiter — plain delete+insert in one transaction is simpler
 * and just as atomic for this single-row case.
 */
async function updateLastUsedPosePreset(
  app: FastifyInstance,
  userId: string,
  poseIds: string[],
): Promise<void> {
  if (poseIds.length === 0) return;
  const unique = Array.from(new Set(poseIds));
  try {
    await app.db.transaction(async (tx) => {
      await tx
        .delete(schema.userPosePresets)
        .where(
          and(eq(schema.userPosePresets.userId, userId), eq(schema.userPosePresets.isLastUsed, true)),
        );
      await tx
        .insert(schema.userPosePresets)
        .values({ userId, name: null, poseIds: unique, isLastUsed: true });
    });
  } catch (err) {
    app.log.warn({ err, userId }, 'failed to update last-used pose preset');
  }
}
```

Then, in `createJob`, replace:

```ts
  return { catalogueId: plan.catalogueId, jobIds };
}
```

with:

```ts
  await updateLastUsedPosePreset(
    app,
    userId,
    plan.looks.map((l) => l.poseId),
  );

  return { catalogueId: plan.catalogueId, jobIds };
}
```

- [ ] **Step 2: Write the integration test**

`apps/api/test/integration/jobs-create.test.ts` already shows the minimal
fixture for a successful `/v1/jobs/tryon` call: a face + background + pose
row (no workflow template or garment type required at creation time — those
only matter at dispatch time), a credit grant, an upload-key Redis binding,
and a `looks: [{ poseId, backgroundId }]` payload. `apps/storage.headObject`
must be mocked the same way, since `createJob`'s `verifyGarmentKey` path
calls it. Reuse that exact pattern here rather than the `getToken`/`makePose`
helpers already in `pose-presets.test.ts` — this block needs its own
`beforeEach`/`afterEach` for the storage mock.

Append to `apps/api/test/integration/pose-presets.test.ts`, inside the same
top-level `describe('pose presets', ...)` block (`app`/`c` are already in
scope from the outer `beforeAll`):

```ts
  describe('last-used auto-tracking', () => {
    let realHeadObject: typeof app.storage.headObject | undefined;
    beforeEach(() => {
      realHeadObject = app.storage.headObject?.bind(app.storage);
      app.storage.headObject = (async () => ({ contentLength: 1024 })) as typeof app.storage.headObject;
    });
    afterEach(() => {
      if (realHeadObject) app.storage.headObject = realHeadObject;
    });

    async function seedFaceAndLook(suffix: string) {
      const [face] = await app.db
        .insert(schema.modelFaces)
        .values({
          gender: 'women',
          label: `Face${suffix}`,
          r2Key: `f${suffix}.jpg`,
          thumbnailKey: `f${suffix}.jpg`,
        })
        .returning();
      const [background] = await app.db
        .insert(schema.modelBackgrounds)
        .values({ label: `Bg${suffix}`, r2Key: `b${suffix}.jpg`, thumbnailKey: `b${suffix}.jpg` })
        .returning();
      const [pose] = await app.db
        .insert(schema.modelPoseAssets)
        .values({ label: `Pose${suffix}`, r2Key: `p${suffix}.jpg`, thumbnailKey: `p${suffix}.jpg` })
        .returning();
      return { faceId: face.id, backgroundId: background.id, poseId: pose.id };
    }

    async function submitTryonJob(token: string, userId: string, suffix: string) {
      const { faceId, backgroundId, poseId } = await seedFaceAndLook(suffix);
      const garmentKey = `inputs/${userId}/garment-${suffix}.jpg`;
      await app.redis.set(`upload:owner:${garmentKey}`, userId, 'EX', 3600);
      const res = await app.inject({
        method: 'POST',
        url: '/v1/jobs/tryon',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          inputs: { upperGarmentKey: garmentKey, faceId, looks: [{ poseId, backgroundId }] },
          aspectRatio: '1:1',
          resolution: '2K',
        },
      });
      return { res, poseId };
    }

    it('upserts the last-used preset after a successful tryon job, overwriting on resubmit', async () => {
      const { token, userId } = await getToken('preset-last-used-job@x.com');
      await app.db
        .insert(schema.userCredits)
        .values({ userId, balance: 100 })
        .onConflictDoUpdate({ target: schema.userCredits.userId, set: { balance: 100 } });

      const first = await submitTryonJob(token, userId, 'a');
      expect(first.res.statusCode).toBe(201);

      const [lastUsedAfterFirst] = await app.db
        .select()
        .from(schema.userPosePresets)
        .where(
          and(
            eq(schema.userPosePresets.userId, userId),
            eq(schema.userPosePresets.isLastUsed, true),
          ),
        );
      expect(lastUsedAfterFirst).toBeDefined();
      expect(lastUsedAfterFirst.poseIds).toEqual([first.poseId]);

      const second = await submitTryonJob(token, userId, 'b');
      expect(second.res.statusCode).toBe(201);

      const rows = await app.db
        .select()
        .from(schema.userPosePresets)
        .where(
          and(
            eq(schema.userPosePresets.userId, userId),
            eq(schema.userPosePresets.isLastUsed, true),
          ),
        );
      expect(rows).toHaveLength(1);
      expect(rows[0].poseIds).toEqual([second.poseId]);
    });
  });
```

This requires `beforeEach`/`afterEach` to be imported from `vitest` in
`pose-presets.test.ts` — add them to the existing `import { afterAll,
beforeAll, describe, expect, it } from 'vitest';` line at the top of the
file (Task 3, Step 3), turning it into `import { afterAll, afterEach,
beforeAll, beforeEach, describe, expect, it } from 'vitest';`.

- [ ] **Step 3: Run the full pose-presets integration test file**

Run (from `apps/api`): `npx vitest run --config vitest.integration.config.ts test/integration/pose-presets.test.ts`
Expected: all tests pass, including the new last-used one.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/jobs/create.ts apps/api/test/integration/pose-presets.test.ts
git commit -m "feat(api): auto-track last-used pose preset on job creation"
```

---

### Task 5: Studio wizard UI — apply, save, delete presets

**Files:**
- Modify: `apps/catalogues-web/src/app/(app)/studio/page.tsx`
  - Add a `useQuery` for presets near the existing `poses` query (around
    line 920)
  - Add `handleSavePosePreset` / `handleDeletePosePreset` / `handleApplyPosePreset`
    handler functions near `handleDeleteMyBackground` (around line 824)
  - Add the chip row JSX inside the "Choose Poses" section, between the
    `SectionHead` (ends line 3722) and the `posesError ?` conditional (line
    3723)

**Interfaces:**
- Consumes: `GET/POST/DELETE /v1/pose-presets` (Task 3), `PosePreset` /
  `ListPosePresetsResult` types (Task 2, importable from `@tryme/types`),
  existing `poses` query result (`PoseItem[]`), existing `poseIds` /
  `setPoseIds` state, existing `showToast`, `api.get`/`api.post`/`api.del`
  (`@/lib/api`), existing `ApiError` (`@/lib/errors`).
- Produces: nothing consumed by later tasks — this is the last task.

- [ ] **Step 1: Add the presets query**

Near the existing `poses` query (after its closing `});` around line 929),
add:

```ts
  const { data: posePresets, refetch: refetchPosePresets } = useQuery<{
    lastUsed: { id: string; name: string | null; poseIds: string[] } | null;
    named: { id: string; name: string | null; poseIds: string[] }[];
  }>({
    queryKey: ['pose-presets'],
    queryFn: () => api.get('/v1/pose-presets'),
  });
```

- [ ] **Step 2: Add the handler functions**

Near `handleDeleteMyBackground` (after its closing `}` around line 824), add:

```ts
  const [isSavingPosePreset, setIsSavingPosePreset] = useState(false);
  const [presetNameInput, setPresetNameInput] = useState('');
  const [presetNameModalOpen, setPresetNameModalOpen] = useState(false);

  function handleApplyPosePreset(preset: { poseIds: string[] }) {
    const availableIds = new Set((poses?.items ?? []).map((p) => p.id));
    const applicable = preset.poseIds.filter((id) => availableIds.has(id));
    const dropped = preset.poseIds.length - applicable.length;
    if (applicable.length === 0) {
      showToast('All poses in this preset are no longer available.');
      return;
    }
    setPoseIds(applicable);
    if (dropped > 0) {
      showToast(`${dropped} pose${dropped === 1 ? '' : 's'} no longer available, removed from preset.`);
    }
  }

  async function handleSavePosePreset() {
    const name = presetNameInput.trim();
    if (!name || poseIds.length === 0 || isSavingPosePreset) return;
    setIsSavingPosePreset(true);
    try {
      await api.post('/v1/pose-presets', { name, poseIds });
      await refetchPosePresets();
      setPresetNameInput('');
      setPresetNameModalOpen(false);
    } catch (e) {
      if (e instanceof ApiError && e.code === 'PRESET_LIMIT_REACHED') {
        showToast('Max 10 presets — delete one first.');
      } else if (e instanceof ApiError && e.code === 'PRESET_NAME_TAKEN') {
        showToast('Name already used.');
      } else {
        showToast(`Couldn't save preset: ${(e as Error).message || 'please try again'}`);
      }
    } finally {
      setIsSavingPosePreset(false);
    }
  }

  async function handleDeletePosePreset(id: string) {
    try {
      await api.del(`/v1/pose-presets/${id}`);
      await refetchPosePresets();
    } catch (e) {
      showToast(`Couldn't delete preset: ${(e as Error).message || 'please try again'}`);
    }
  }
```

Add `ApiError` to the existing `@/lib/errors`... there is currently no
top-level import from `@/lib/errors` in this file — add one:

```ts
import { ApiError } from '@/lib/errors';
```

(insert alphabetically among the existing `@/...` imports, after `@/lib/breakpoints` and before `@/lib/image-validation`)

- [ ] **Step 3: Add the chip row UI**

Inside the "Choose Poses" `<section>`, immediately after the `<SectionHead
... />` closing (line 3722) and before `{posesError ? (` (line 3723), add:

```tsx
                  {((posePresets?.named.length ?? 0) > 0 || posePresets?.lastUsed) && (
                    <div
                      style={{
                        display: 'flex',
                        flexWrap: 'wrap',
                        gap: 8,
                        marginBottom: 12,
                      }}
                    >
                      {posePresets?.lastUsed && (
                        <button
                          type="button"
                          onClick={() => handleApplyPosePreset(posePresets.lastUsed!)}
                          style={{
                            fontSize: 12,
                            fontWeight: 600,
                            padding: '6px 12px',
                            borderRadius: 999,
                            border: `1px solid ${C.border}`,
                            background: '#fff',
                            color: C.text,
                            cursor: 'pointer',
                          }}
                        >
                          Last Used
                        </button>
                      )}
                      {posePresets?.named.map((preset) => (
                        <div
                          key={preset.id}
                          style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 4,
                            borderRadius: 999,
                            border: `1px solid ${C.border}`,
                            background: '#fff',
                            paddingRight: 6,
                          }}
                        >
                          <button
                            type="button"
                            onClick={() => handleApplyPosePreset(preset)}
                            style={{
                              fontSize: 12,
                              fontWeight: 600,
                              padding: '6px 8px',
                              border: 'none',
                              background: 'none',
                              color: C.text,
                              cursor: 'pointer',
                            }}
                          >
                            {preset.name}
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDeletePosePreset(preset.id)}
                            aria-label={`Delete preset ${preset.name}`}
                            style={{
                              display: 'flex',
                              border: 'none',
                              background: 'none',
                              cursor: 'pointer',
                              color: C.mid,
                              padding: 2,
                            }}
                          >
                            <XIcon width={12} height={12} />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                  {poseIds.length > 0 && (
                    <div style={{ marginBottom: 12 }}>
                      {presetNameModalOpen ? (
                        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                          <input
                            type="text"
                            value={presetNameInput}
                            onChange={(e) => setPresetNameInput(e.target.value)}
                            placeholder="Preset name"
                            maxLength={40}
                            style={{
                              fontSize: 12,
                              padding: '6px 10px',
                              borderRadius: 6,
                              border: `1px solid ${C.border}`,
                            }}
                          />
                          <button
                            type="button"
                            onClick={handleSavePosePreset}
                            disabled={isSavingPosePreset || !presetNameInput.trim()}
                            style={{
                              fontSize: 12,
                              fontWeight: 600,
                              padding: '6px 12px',
                              borderRadius: 6,
                              border: 'none',
                              background: grad,
                              color: '#fff',
                              cursor: 'pointer',
                            }}
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              setPresetNameModalOpen(false);
                              setPresetNameInput('');
                            }}
                            style={{
                              fontSize: 12,
                              padding: '6px 10px',
                              border: 'none',
                              background: 'none',
                              color: C.mid,
                              cursor: 'pointer',
                            }}
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setPresetNameModalOpen(true)}
                          style={{
                            fontSize: 12,
                            fontWeight: 600,
                            padding: 0,
                            border: 'none',
                            background: 'none',
                            color: C.pink,
                            cursor: 'pointer',
                          }}
                        >
                          + Save as preset
                        </button>
                      )}
                    </div>
                  )}
```

- [ ] **Step 4: Manually verify in the browser**

Run: `pnpm --filter @tryme/web dev` (and `pnpm docker:up` /
`pnpm --filter @tryme/api dev` if not already running)

In the studio wizard: reach the pose step, select 2+ poses, click "+ Save as
preset", name it, save — confirm the chip appears. Deselect poses, click the
new chip — confirm it reapplies the same selection. Submit a tryon job,
return to the pose step — confirm a "Last Used" chip appears reflecting that
submission. Click the × on a named preset — confirm it disappears. Try
saving an 11th preset (or temporarily lower `MAX_NAMED_PRESETS` locally to
test this faster) — confirm the "Max 10 presets" toast.

- [ ] **Step 5: Commit**

```bash
git add apps/catalogues-web/src/app/\(app\)/studio/page.tsx
git commit -m "feat(web): save/apply pose presets in studio wizard"
```
