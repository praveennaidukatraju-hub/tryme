# Garment Taxonomy — Schema Foundation (Plan A of N) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the new tables and columns from `docs/superpowers/specs/2026-07-16-garment-taxonomy-architecture-design.md` §5 to the database — `garment_families`, `workflow_profiles`, `workflow_profile_stages`, `workflow_profile_shot_types`, plus new nullable columns on `garment_subcategories` and `model_pose_assets`. This is Phase 1 of the spec's rollout (§11): purely additive, zero behavior change, no application code reads these columns yet.

**Architecture:** All new tables live in `packages/db/src/schema/models.ts`, alongside the existing `garmentSubcategories`/`workflowTemplates`/`modelPoseAssets` they relate to — this avoids the circular-import problem this codebase has already hit once (see the `tryonCategoryId` comment in `models.ts`: a typed FK across schema files was abandoned specifically to dodge that). Each table/column addition is its own `drizzle-kit generate` pass, producing its own small migration, mirroring the existing migration history's granularity (most existing migrations are single-table or single-column). No `packages/types`, `apps/api`, `apps/admin-web`, or `apps/catalogues-web` files are touched — wiring these columns into application logic is a later plan (spec §11 Phase 3).

This plan's task-by-task granularity (6 migrations) is for reviewability while executing it step-by-step — it is not a requirement on its own. If multiple tasks land together in one branch before anyone runs `pnpm db:generate`, collapsing them into fewer migration files is fine; the existing 118 migrations in this repo already span a wide range of granularity, from single-column changes to multi-table changes in one file.

**Tech Stack:** Drizzle ORM 0.36 (`packages/db/src/schema/models.ts`), drizzle-kit 0.28 (`pnpm db:generate`), Vitest 4 + `postgres` driver against the docker-compose Postgres (NOT testcontainers — see Known Issue below).

**A note on migration numbers below:** as of this plan's writing, the highest existing migration is `0112`, so the tasks below reference `0113` through `0118`. Those numbers are illustrative, not load-bearing — if another migration has landed on `master` by the time this plan is executed, `drizzle-kit generate` will assign whatever the actual next number is, and that's correct; don't rename files to force them to match this document (see CLAUDE.md's "Migration Index Conflicts" section). The `git add` commands in each task stage the whole `migrations/` and `migrations/meta/` directories rather than number-specific globs for exactly this reason — a glob like `0114_*.sql` would silently match nothing (and stage nothing) if the real number turns out to be different.

**Known issue found during planning (not fixed by this plan):** `packages/db/test/models-schema.test.ts` references `schema.modelPoses` and `schema.subcategoryTemplates`, both of which were dropped from `models.ts` (migration `0047_drop_model_poses.sql` and the `catalogueTemplates` redesign). `packages/db`'s `tsconfig.json` excludes `test/` from typecheck (`"include": ["src/**/*"]`), so `pnpm typecheck` doesn't catch this, but `pnpm --filter @tryme/db test` runs it via Vitest's default file discovery and it will fail at runtime. This is pre-existing and unrelated to this plan — every test command below scopes to the new file specifically (`vitest run garment-taxonomy`) to avoid confusing an unrelated pre-existing failure with a regression. Fixing `models-schema.test.ts` is out of scope here; flag it to the user separately.

---

### Task 1: `garment_families` table — failing test

**Files:**
- Create: `packages/db/test/garment-taxonomy.test.ts`

- [ ] **Step 1: Write the test harness and the first failing test**

```ts
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as schema from '../src/schema/index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Reuses the docker-compose Postgres on 127.0.0.1 (see apps/api/test/helpers/containers.ts
// for the identical pattern) — NOT testcontainers. packages/db/test/models-schema.test.ts
// uses testcontainers and is currently broken/stale; do not follow that file's pattern.
const pgPort = process.env.POSTGRES_PORT ?? '5432';
const pgUser = process.env.POSTGRES_USER ?? 'tryon';
const pgPassword = process.env.POSTGRES_PASSWORD ?? 'tryon_dev_pw';
const pgAdminDb = process.env.POSTGRES_DB ?? 'tryon_dev';
const dbName = `test_garment_taxonomy_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
const adminUrl = `postgres://${pgUser}:${pgPassword}@127.0.0.1:${pgPort}/${pgAdminDb}`;

let sql: ReturnType<typeof postgres>;
let db: ReturnType<typeof drizzle<typeof schema>>;

beforeAll(async () => {
  const adminClient = postgres(adminUrl, { max: 1 });
  await adminClient.unsafe(`CREATE DATABASE "${dbName}"`);
  await adminClient.end();

  sql = postgres(`postgres://${pgUser}:${pgPassword}@127.0.0.1:${pgPort}/${dbName}`, { max: 1 });
  db = drizzle(sql, { schema });
  await migrate(db, { migrationsFolder: path.join(__dirname, '../src/migrations') });
}, 60_000);

afterAll(async () => {
  await sql.end();
  const adminClient = postgres(adminUrl, { max: 1 });
  await adminClient.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`);
  await adminClient.end();
});

describe('garment_families', () => {
  it('inserts and retrieves a family', async () => {
    const [family] = await db
      .insert(schema.garmentFamilies)
      .values({ slug: 'upper', label: 'Upper Garment', primaryUploadSlot: 'upper' })
      .returning();

    expect(family.id).toBeTruthy();
    expect(family.slug).toBe('upper');
    expect(family.primaryUploadSlot).toBe('upper');
    expect(family.sortOrder).toBe(0);
  });

  it('rejects a duplicate slug', async () => {
    await db
      .insert(schema.garmentFamilies)
      .values({ slug: 'lower', label: 'Lower Garment', primaryUploadSlot: 'lower' });

    await expect(
      db
        .insert(schema.garmentFamilies)
        .values({ slug: 'lower', label: 'Duplicate', primaryUploadSlot: 'lower' }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/db test -- garment-taxonomy`
Expected: FAIL — `schema.garmentFamilies` is `undefined` (table not yet defined), so `db.insert(schema.garmentFamilies)` throws a TypeError.

---

### Task 2: `garment_families` table — implementation

**Files:**
- Modify: `packages/db/src/schema/models.ts` (append at end of file)

- [ ] **Step 1: Add the table to the schema**

Append to `packages/db/src/schema/models.ts`:

```ts
// Small, admin-managed lookup of garment families — see
// docs/superpowers/specs/2026-07-16-garment-taxonomy-architecture-design.md §5.
// Two families can share the same primaryUploadSlot (e.g. full_body_draped and
// upper both mechanically route through job_inputs.upper_garment_key) — the
// family is a semantic label, primaryUploadSlot is its technical routing detail.
export const garmentFamilies = pgTable('garment_families', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  label: text('label').notNull(),
  // 'upper' | 'lower' — validated at the Zod layer, not a DB enum, so adding a
  // family later is a one-line change, not a migration (matches the existing
  // shotType convention on model_pose_assets above).
  primaryUploadSlot: text('primary_upload_slot').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
```

- [ ] **Step 2: Generate the migration**

Run: `pnpm db:generate`
Expected: creates `packages/db/src/migrations/0113_<auto_name>.sql` containing `CREATE TABLE "garment_families" (...)`, plus `packages/db/src/migrations/meta/0113_snapshot.json`, and appends an entry to `packages/db/src/migrations/meta/_journal.json`. If drizzle-kit prompts interactively (it shouldn't, for a brand-new table with no rename ambiguity), accept the "create table" option.

- [ ] **Step 3: Inspect the generated SQL**

Read the new `packages/db/src/migrations/0113_*.sql` file and confirm it contains exactly one `CREATE TABLE "garment_families"` statement with the five columns above, a `PRIMARY KEY` on `id`, and a `UNIQUE` constraint on `slug`. If drizzle-kit named the file something other than the pattern below, that's fine — the auto-generated name is cosmetic.

- [ ] **Step 4: Apply the migration**

Run: `pnpm db:migrate`
Expected: `applying migrations...done` with no errors. A `NOTICE "already exists"` for anything other than `garment_families` would indicate a stale local DB state — investigate before continuing, don't ignore it.

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @tryme/db test -- garment-taxonomy`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema/models.ts packages/db/src/migrations/ packages/db/test/garment-taxonomy.test.ts
git commit -m "feat(db): add garment_families table"
```

---

### Task 3: `workflow_profiles` + `workflow_profile_stages` — failing test

**Files:**
- Modify: `packages/db/test/garment-taxonomy.test.ts`

- [ ] **Step 1: Add the failing test**

Append to `packages/db/test/garment-taxonomy.test.ts`:

```ts
async function insertTestWorkflowTemplate(slug: string) {
  const [tmpl] = await db
    .insert(schema.workflowTemplates)
    .values({
      slug,
      label: slug,
      jsonContent: {},
      poseNodeId: '1',
      upperNodeIds: [],
      garmentPhasePromptNode: '2',
    })
    .returning();
  return tmpl;
}

describe('workflow_profiles + workflow_profile_stages', () => {
  it('inserts a profile with two ordered stages', async () => {
    const stage1Tmpl = await insertTestWorkflowTemplate('wf-profile-test-stage1');
    const stage2Tmpl = await insertTestWorkflowTemplate('wf-profile-test-stage2');

    const [profile] = await db
      .insert(schema.workflowProfiles)
      .values({ slug: 'saree-two-step-test', label: 'Saree Two-Step (test)' })
      .returning();

    const stages = await db
      .insert(schema.workflowProfileStages)
      .values([
        {
          profileId: profile.id,
          stageOrder: 1,
          workflowTemplateId: stage1Tmpl.id,
          inputSource: 'primary_upload',
        },
        {
          profileId: profile.id,
          stageOrder: 2,
          workflowTemplateId: stage2Tmpl.id,
          // inputSource omitted — verifies the column default below
        },
      ])
      .returning();

    expect(stages).toHaveLength(2);
    expect(stages[0].inputSource).toBe('primary_upload');
    expect(stages[1].inputSource).toBe('previous_stage'); // column default
  });

  it('rejects a duplicate stageOrder within the same profile', async () => {
    const tmpl = await insertTestWorkflowTemplate('wf-profile-test-dupe');
    const [profile] = await db
      .insert(schema.workflowProfiles)
      .values({ slug: 'dupe-order-test', label: 'Dupe Order Test' })
      .returning();

    await db.insert(schema.workflowProfileStages).values({
      profileId: profile.id,
      stageOrder: 1,
      workflowTemplateId: tmpl.id,
      inputSource: 'primary_upload',
    });

    await expect(
      db.insert(schema.workflowProfileStages).values({
        profileId: profile.id,
        stageOrder: 1,
        workflowTemplateId: tmpl.id,
        inputSource: 'previous_stage',
      }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/db test -- garment-taxonomy`
Expected: FAIL — `schema.workflowProfiles`/`schema.workflowProfileStages` are `undefined`.

---

### Task 4: `workflow_profiles` + `workflow_profile_stages` — implementation

**Files:**
- Modify: `packages/db/src/schema/models.ts`

- [ ] **Step 1: Add the tables**

Append to `packages/db/src/schema/models.ts` (this file already imports `check` is NOT yet imported — add it to the existing `drizzle-orm/pg-core` import list at the top, alongside `unique`):

First, update the existing import block at the top of `models.ts` from:

```ts
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
```

to:

```ts
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
```

Then append the two new tables:

```ts
export const workflowProfiles = pgTable('workflow_profiles', {
  id: uuid('id').primaryKey().defaultRandom(),
  slug: text('slug').notNull().unique(),
  label: text('label').notNull(),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Ordered pipeline stages for a Workflow Profile. Generalizes the old saree-only
// requiresMannequinStep/mannequinWorkflowTemplateId/sareeStep2WorkflowTemplateId
// columns into an N-stage mechanism any future multi-pass garment family can use.
export const workflowProfileStages = pgTable(
  'workflow_profile_stages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => workflowProfiles.id, { onDelete: 'cascade' }),
    stageOrder: integer('stage_order').notNull(),
    workflowTemplateId: uuid('workflow_template_id')
      .notNull()
      .references(() => workflowTemplates.id),
    // 'primary_upload' | 'previous_stage' — validated at the Zod layer, not a DB
    // enum (same convention as garmentFamilies.primaryUploadSlot above). Stage 1
    // of every profile must be 'primary_upload'; that invariant is enforced by
    // whatever creates these rows (a later plan's admin API), not here.
    inputSource: text('input_source').notNull().default('previous_stage'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('workflow_profile_stages_profile_order_unique').on(table.profileId, table.stageOrder),
  ],
);
```

- [ ] **Step 2: Generate the migration**

Run: `pnpm db:generate`
Expected: creates `packages/db/src/migrations/0114_<auto_name>.sql` with two `CREATE TABLE` statements (`workflow_profiles`, `workflow_profile_stages`) and one `ADD CONSTRAINT ... UNIQUE` (or an inline `UNIQUE` in the `CREATE TABLE`, depending on how drizzle-kit renders it), plus the matching snapshot/journal updates.

- [ ] **Step 3: Apply the migration**

Run: `pnpm db:migrate`
Expected: applies cleanly.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @tryme/db test -- garment-taxonomy`
Expected: PASS (4 tests total).

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema/models.ts packages/db/src/migrations/ packages/db/test/garment-taxonomy.test.ts
git commit -m "feat(db): add workflow_profiles and workflow_profile_stages tables"
```

---

### Task 5: `workflow_profile_shot_types` — failing test

**Files:**
- Modify: `packages/db/test/garment-taxonomy.test.ts`

- [ ] **Step 1: Add the failing test**

Append to `packages/db/test/garment-taxonomy.test.ts`:

```ts
describe('workflow_profile_shot_types', () => {
  it('inserts a shot-type default and enforces uniqueness per profile+shotType', async () => {
    const tmpl = await insertTestWorkflowTemplate('wf-shot-type-test');
    const [profile] = await db
      .insert(schema.workflowProfiles)
      .values({ slug: 'shot-type-profile-test', label: 'Shot Type Profile Test' })
      .returning();

    const [row] = await db
      .insert(schema.workflowProfileShotTypes)
      .values({ profileId: profile.id, shotType: 'full', workflowTemplateId: tmpl.id })
      .returning();

    expect(row.shotType).toBe('full');

    await expect(
      db.insert(schema.workflowProfileShotTypes).values({
        profileId: profile.id,
        shotType: 'full',
        workflowTemplateId: tmpl.id,
      }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/db test -- garment-taxonomy`
Expected: FAIL — `schema.workflowProfileShotTypes` is `undefined`.

---

### Task 6: `workflow_profile_shot_types` — implementation

**Files:**
- Modify: `packages/db/src/schema/models.ts`

- [ ] **Step 1: Add the table**

Append to `packages/db/src/schema/models.ts`:

```ts
// Generalizes garmentShotTypeWorkflows (below) from per-garment-type scoping to
// per-profile scoping, so multiple garment types sharing a profile share this
// config too instead of duplicating it per type.
export const workflowProfileShotTypes = pgTable(
  'workflow_profile_shot_types',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    profileId: uuid('profile_id')
      .notNull()
      .references(() => workflowProfiles.id, { onDelete: 'cascade' }),
    shotType: text('shot_type').notNull(), // 'full' | 'half' | 'closeup'
    workflowTemplateId: uuid('workflow_template_id')
      .notNull()
      .references(() => workflowTemplates.id, { onDelete: 'cascade' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('workflow_profile_shot_types_profile_shot_type_unique').on(
      table.profileId,
      table.shotType,
    ),
  ],
);
```

- [ ] **Step 2: Generate the migration**

Run: `pnpm db:generate`
Expected: creates `packages/db/src/migrations/0115_<auto_name>.sql`.

- [ ] **Step 3: Apply the migration**

Run: `pnpm db:migrate`

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @tryme/db test -- garment-taxonomy`
Expected: PASS (5 tests total).

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema/models.ts packages/db/src/migrations/ packages/db/test/garment-taxonomy.test.ts
git commit -m "feat(db): add workflow_profile_shot_types table"
```

---

### Task 7: `garment_subcategories` new columns — failing test

**Files:**
- Modify: `packages/db/test/garment-taxonomy.test.ts`

- [ ] **Step 1: Add the failing test**

Append to `packages/db/test/garment-taxonomy.test.ts`:

```ts
describe('garment_subcategories new columns', () => {
  it('defaults capabilities to {} and audience to "all", accepts familyId/workflowProfileId', async () => {
    const [family] = await db
      .insert(schema.garmentFamilies)
      .values({ slug: `upper-${Date.now()}`, label: 'Upper (test)', primaryUploadSlot: 'upper' })
      .returning();
    const [profile] = await db
      .insert(schema.workflowProfiles)
      .values({ slug: `profile-${Date.now()}`, label: 'Profile (test)' })
      .returning();

    const [sub] = await db
      .insert(schema.garmentSubcategories)
      .values({
        genderSlug: 'men',
        slug: `subcat-defaults-${Date.now()}`,
        label: 'Subcat Defaults Test',
        familyId: family.id,
        workflowProfileId: profile.id,
      })
      .returning();

    expect(sub.capabilities).toEqual({});
    expect(sub.audience).toBe('all');
    expect(sub.familyId).toBe(family.id);
    expect(sub.workflowProfileId).toBe(profile.id);
  });

  it('stores arbitrary capability flags in jsonb', async () => {
    const [sub] = await db
      .insert(schema.garmentSubcategories)
      .values({
        genderSlug: 'women',
        slug: `subcat-caps-${Date.now()}`,
        label: 'Subcat Capabilities Test',
        capabilities: { requiresLegAlignment: true, drapePreservation: true },
      })
      .returning();

    expect(sub.capabilities).toEqual({ requiresLegAlignment: true, drapePreservation: true });
  });

  it('rejects audience=adult combined with a minor gender slug', async () => {
    await expect(
      db.insert(schema.garmentSubcategories).values({
        genderSlug: 'girls',
        slug: `subcat-blocked-${Date.now()}`,
        label: 'Subcat Blocked Test',
        audience: 'adult',
      }),
    ).rejects.toThrow();

    await expect(
      db.insert(schema.garmentSubcategories).values({
        genderSlug: 'boys',
        slug: `subcat-blocked-2-${Date.now()}`,
        label: 'Subcat Blocked Test 2',
        audience: 'adult',
      }),
    ).rejects.toThrow();
  });

  it('accepts audience=adult combined with an adult gender slug', async () => {
    const [sub] = await db
      .insert(schema.garmentSubcategories)
      .values({
        genderSlug: 'women',
        slug: `subcat-allowed-${Date.now()}`,
        label: 'Subcat Allowed Test',
        audience: 'adult',
      })
      .returning();

    expect(sub.audience).toBe('adult');
  });

  it('rejects an invalid audience value', async () => {
    await expect(
      db.insert(schema.garmentSubcategories).values({
        genderSlug: 'men',
        slug: `subcat-invalid-audience-${Date.now()}`,
        label: 'Subcat Invalid Audience Test',
        audience: 'teen',
      }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/db test -- garment-taxonomy`
Expected: FAIL — `familyId`/`workflowProfileId`/`capabilities`/`audience` are not recognized columns on `garmentSubcategories` (Drizzle throws on unknown keys in `.values()`).

---

### Task 8: `garment_subcategories` new columns — implementation

**Files:**
- Modify: `packages/db/src/schema/models.ts:54-93` (the `garmentSubcategories` table definition)

- [ ] **Step 1: Add the columns and constraints**

In `packages/db/src/schema/models.ts`, change the `garmentSubcategories` definition from a plain `pgTable('garment_subcategories', { ... })` call (two arguments) to a three-argument call so the CHECK constraints can be attached. Add these four columns just before the existing `createdAt` field:

```ts
  // Garment Family (§5 of the design doc) — nullable until the Phase 2 backfill
  // populates every row, then made NOT NULL in a later cleanup migration.
  familyId: uuid('family_id').references(() => garmentFamilies.id),
  workflowProfileId: uuid('workflow_profile_id').references(() => workflowProfiles.id),
  // Generation-affecting flags only (e.g. requiresLegAlignment, drapePreservation).
  // Never consulted for workflow routing — see Architectural Principle #3.
  capabilities: jsonb('capabilities').notNull().default(sql`'{}'::jsonb`),
  // Compliance classification, deliberately a real column with a DB-level guard
  // rather than folded into capabilities — see Architectural Principle #6.
  audience: text('audience').notNull().default('all'),
```

And change the table's closing signature from:

```ts
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
```

to (adding the third argument):

```ts
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  check('garment_subcategories_audience_valid', sql`audience IN ('all', 'adult')`),
  check(
    'garment_subcategories_audience_minor_guard',
    sql`NOT (audience = 'adult' AND gender_slug IN ('boys', 'girls'))`,
  ),
]);
```

(`sql` is already imported at the top of `models.ts`; `jsonb` is already imported.)

- [ ] **Step 2: Generate the migration**

Run: `pnpm db:generate`
Expected: creates `packages/db/src/migrations/0116_<auto_name>.sql` with `ALTER TABLE "garment_subcategories" ADD COLUMN` statements for all four columns and two `ADD CONSTRAINT ... CHECK` statements.

- [ ] **Step 3: Apply the migration**

Run: `pnpm db:migrate`

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @tryme/db test -- garment-taxonomy`
Expected: PASS (10 tests total).

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema/models.ts packages/db/src/migrations/ packages/db/test/garment-taxonomy.test.ts
git commit -m "feat(db): add family/profile/capabilities/audience columns to garment_subcategories"
```

---

### Task 9: `model_pose_assets.poseCapabilities` — failing test

**Files:**
- Modify: `packages/db/test/garment-taxonomy.test.ts`

- [ ] **Step 1: Add the failing test**

Append to `packages/db/test/garment-taxonomy.test.ts`:

```ts
describe('model_pose_assets.poseCapabilities', () => {
  it('defaults to {} and stores arbitrary pose capability flags', async () => {
    const [poseDefault] = await db
      .insert(schema.modelPoseAssets)
      .values({
        label: `pose-default-${Date.now()}`,
        r2Key: 'poses/test-default.jpg',
        thumbnailKey: 'poses/test-default-thumb.jpg',
      })
      .returning();
    expect(poseDefault.poseCapabilities).toEqual({});

    const [poseWithCaps] = await db
      .insert(schema.modelPoseAssets)
      .values({
        label: `pose-caps-${Date.now()}`,
        r2Key: 'poses/test-caps.jpg',
        thumbnailKey: 'poses/test-caps-thumb.jpg',
        poseCapabilities: { showsLegs: true, showsWaist: true, showsFullBody: false },
      })
      .returning();
    expect(poseWithCaps.poseCapabilities).toEqual({
      showsLegs: true,
      showsWaist: true,
      showsFullBody: false,
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/db test -- garment-taxonomy`
Expected: FAIL — `poseCapabilities` is not a recognized column on `modelPoseAssets`.

---

### Task 10: `model_pose_assets.poseCapabilities` — implementation

**Files:**
- Modify: `packages/db/src/schema/models.ts:144-170` (the `modelPoseAssets` table definition)

- [ ] **Step 1: Add the column**

In `packages/db/src/schema/models.ts`, add to the `modelPoseAssets` definition, just before `deletedAt`:

```ts
  // Pose-side half of the capability compatibility check (§7 of the design doc)
  // — e.g. { showsLegs: true, showsWaist: true, showsFullBody: false }.
  poseCapabilities: jsonb('pose_capabilities').notNull().default(sql`'{}'::jsonb`),
```

- [ ] **Step 2: Generate the migration**

Run: `pnpm db:generate`
Expected: creates `packages/db/src/migrations/0117_<auto_name>.sql` with an `ALTER TABLE "model_pose_assets" ADD COLUMN "pose_capabilities"` statement.

- [ ] **Step 3: Apply the migration**

Run: `pnpm db:migrate`

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @tryme/db test -- garment-taxonomy`
Expected: PASS (11 tests total).

- [ ] **Step 5: Commit**

```bash
git add packages/db/src/schema/models.ts packages/db/src/migrations/
git commit -m "feat(db): add poseCapabilities column to model_pose_assets"
```

---

### Task 11: Seed the 4 `garment_families` rows

**Files:**
- Create: `packages/db/src/migrations/0118_garment_families_seed.sql`
- Modify: `packages/db/test/garment-taxonomy.test.ts`

- [ ] **Step 1: Write the failing test**

Append to `packages/db/test/garment-taxonomy.test.ts`:

```ts
describe('garment_families seed data', () => {
  it('seeds the 4 baseline families', async () => {
    const rows = await db
      .select({ slug: schema.garmentFamilies.slug, primaryUploadSlot: schema.garmentFamilies.primaryUploadSlot })
      .from(schema.garmentFamilies)
      .where(
        inArray(schema.garmentFamilies.slug, ['upper', 'lower', 'full_body_draped', 'full_body_fitted']),
      );

    const bySlug = Object.fromEntries(rows.map((r) => [r.slug, r.primaryUploadSlot]));
    expect(bySlug.upper).toBe('upper');
    expect(bySlug.lower).toBe('lower');
    expect(bySlug.full_body_draped).toBe('upper');
    expect(bySlug.full_body_fitted).toBe('upper');
  });
});
```

Add `inArray` to the existing `drizzle-orm` import at the top of the test file (currently there is no top-level `drizzle-orm` import in this file other than `drizzle`/`migrate` from submodules — add a new import line: `import { inArray } from 'drizzle-orm';`).

Note: Task 1's tests insert rows with `slug: 'upper'` / `slug: 'lower'`, which collide with the seed data's slugs (`'upper'`, `'lower'`) — since every task's tests run against the same migrated database within a test run, the seed migration's `ON CONFLICT (slug) DO NOTHING` (Step 2 below) would find them already present and silently skip seeding, and this task's own assertions would then be unable to tell "seed data exists" apart from "Task 1's manual test rows happen to have the same slugs." Go back to Task 1's test and change its literal slugs from `'upper'`/`'lower'` to `'upper-manual-test'`/`'lower-manual-test'` so they don't collide with the seed data. This keeps the two concerns independently verifiable: Task 1 proves the table mechanics (insert, unique constraint) work regardless of seed data, and this task proves the seed data itself is correct — a manual test row should never be able to masquerade as a production seed row:

```ts
// In Task 1's test, change:
.values({ slug: 'upper', label: 'Upper Garment', primaryUploadSlot: 'upper' })
// to:
.values({ slug: 'upper-manual-test', label: 'Upper Garment', primaryUploadSlot: 'upper' })
// and change the corresponding assertion:
expect(family.slug).toBe('upper-manual-test');
```

```ts
// In Task 1's duplicate-slug test, change both occurrences of 'lower' to 'lower-manual-test':
.values({ slug: 'lower-manual-test', label: 'Lower Garment', primaryUploadSlot: 'lower' });
// ...
db.insert(schema.garmentFamilies).values({ slug: 'lower-manual-test', label: 'Duplicate', primaryUploadSlot: 'lower' }),
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/db test -- garment-taxonomy`
Expected: FAIL — the `bySlug` lookups return `undefined` because no seed data exists yet.

- [ ] **Step 3: Scaffold an empty custom migration**

From `packages/db/`, run:

```bash
npx drizzle-kit generate --custom --name=garment_families_seed
```

Expected: creates an empty `packages/db/src/migrations/0118_garment_families_seed.sql` and correctly appends its entry to `packages/db/src/migrations/meta/_journal.json` (matching the existing `{ idx, version, when, tag, breakpoints }` shape used by every other entry in that file). This is the idiomatic way to add a hand-written, data-only migration in Drizzle — it avoids hand-editing the journal JSON, which is easy to get subtly wrong (timestamp ordering, missed trailing comma).

- [ ] **Step 4: Fill in the seed SQL**

Replace the (empty) contents of the generated `packages/db/src/migrations/0118_garment_families_seed.sql` with (following the existing `0006_catalog_types_seed.sql` idempotent-seed convention):

```sql
-- seed the 4 baseline garment families (see docs/superpowers/specs/2026-07-16-garment-taxonomy-architecture-design.md §5)
INSERT INTO garment_families (slug, label, primary_upload_slot, sort_order)
VALUES
  ('upper', 'Upper Garment', 'upper', 1),
  ('lower', 'Lower Garment', 'lower', 2),
  ('full_body_draped', 'Full-Body Draped (Saree, Lehenga)', 'upper', 3),
  ('full_body_fitted', 'Full-Body Fitted (Dress, Jumpsuit, Gown)', 'upper', 4)
ON CONFLICT (slug) DO NOTHING;
```

- [ ] **Step 5: Apply the migration**

Run: `pnpm db:migrate`
Expected: applies `0118_garment_families_seed.sql` cleanly.

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @tryme/db test -- garment-taxonomy`
Expected: PASS (12 tests total).

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/migrations/ packages/db/test/garment-taxonomy.test.ts
git commit -m "feat(db): seed baseline garment_families rows"
```

---

### Task 12: Full verification pass

**Files:** none (verification only)

- [ ] **Step 1: Full typecheck**

Run: `pnpm --filter @tryme/db typecheck`
Expected: no errors.

- [ ] **Step 2: Full new-file test run**

Run: `pnpm --filter @tryme/db test -- garment-taxonomy`
Expected: PASS, 12 tests, 0 failures.

- [ ] **Step 3: Confirm the pre-existing stale test is the only other failure, if run**

Run: `pnpm --filter @tryme/db test`
Expected: `test/garment-taxonomy.test.ts` passes; `test/models-schema.test.ts` fails for the pre-existing reason documented at the top of this plan (references to dropped `modelPoses`/`subcategoryTemplates` tables), not for any reason introduced by this plan. If `models-schema.test.ts` now fails differently than before this plan's changes, investigate — that would mean this plan broke something.

- [ ] **Step 4: Lint**

Run: `pnpm lint`
Expected: no errors in `packages/db/src/schema/models.ts` or `packages/db/test/garment-taxonomy.test.ts`.

- [ ] **Step 5: Root build**

Run: `pnpm build`
Expected: succeeds — confirms nothing downstream (`apps/api`, `apps/dispatcher`, etc.) breaks by importing the updated `@tryme/db` schema, since Phase 1 is purely additive and no existing code references the new tables/columns yet.

---

## Definition of Done

- [ ] All 4 new tables exist in the migrated schema: `garment_families`, `workflow_profiles`, `workflow_profile_stages`, `workflow_profile_shot_types`.
- [ ] `garment_subcategories` has `familyId`, `workflowProfileId`, `capabilities`, `audience`, with both CHECK constraints present (verify with the SQL in "Production Verification" below).
- [ ] `model_pose_assets` has `poseCapabilities`.
- [ ] The 4 baseline `garment_families` rows are seeded (`upper`, `lower`, `full_body_draped`, `full_body_fitted`).
- [ ] `git diff --stat` against the branch point touches only files under `packages/db/` — no `apps/api`, `apps/admin-web`, `apps/catalogues-web`, `apps/dispatcher`, or `packages/types` file is modified. This is what actually guarantees zero behavior change; it's a stronger and more directly checkable statement than "existing API responses are unchanged," since no API code changed at all.
- [ ] `requiresLowerUpload`, `requiresMannequinStep`, `mannequinWorkflowTemplateId`, `sareeStep2WorkflowTemplateId`, and `garment_shot_type_workflows` all still exist, untouched — nothing is dropped in this plan.
- [ ] `pnpm --filter @tryme/db test -- garment-taxonomy` passes (12 tests).
- [ ] A fresh database migrated from `0000` through the final new migration succeeds with no errors — already exercised by every run of the test suite's `beforeAll` (Task 1), called out here as an explicit criterion rather than an incidental side effect.
- [ ] `pnpm build` succeeds at the repo root, confirming no downstream package broke from the `@tryme/db` schema change.

## Rollback

Phase 1 only adds tables, nullable columns, and CHECK constraints that default-satisfy on every existing row (`audience` defaults to `'all'`, which never violates the minor-audience guard) — no existing row is mutated, and no application code reads any of it yet. That makes rollback simpler here than for a typical migration:

- **Before this plan is merged/deployed:** rollback is just not merging — nothing to clean up.
- **After it's deployed but before Plan B (backfill) runs:** this repo's migrations are forward-only — there is no generated down-migration mechanism (no `down.sql` counterpart exists anywhere in `packages/db/src/migrations/`). Rolling back means writing one new forward migration that drops the 4 new tables and the 5 new columns. No data transformation or backfill-reversal is needed, because Plan B hasn't run yet — there is nothing in the new columns to lose.
- **After Plan B has backfilled data:** rolling back Phase 1's schema would also discard that backfilled data. At that point it's a Plan B rollback question, out of scope for this plan.

## Production Verification

After migrating a real environment, confirm directly with SQL rather than relying only on the test suite:

```sql
-- Expect exactly 4 rows
SELECT slug, primary_upload_slot FROM garment_families ORDER BY sort_order;

-- Expect 4 rows: family_id, workflow_profile_id, capabilities, audience
SELECT column_name, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 'garment_subcategories'
  AND column_name IN ('family_id', 'workflow_profile_id', 'capabilities', 'audience');

-- Expect one row
SELECT column_name FROM information_schema.columns
WHERE table_name = 'model_pose_assets' AND column_name = 'pose_capabilities';

-- Expect both constraint names present
SELECT conname FROM pg_constraint
WHERE conrelid = 'garment_subcategories'::regclass
  AND conname IN ('garment_subcategories_audience_valid', 'garment_subcategories_audience_minor_guard');
```

## What this plan deliberately does not do

Per the spec's phased rollout (§11), this plan stops at Phase 1. It does **not**: backfill `familyId`/`workflowProfileId` on existing `garment_subcategories` rows (Phase 2 — a later plan), change any `apps/api` route or `packages/types` Zod schema to read/write these columns (Phase 3), change any admin or studio UI (Phase 3), or drop the legacy `requiresLowerUpload`/`requiresMannequinStep`/`mannequinWorkflowTemplateId`/`sareeStep2WorkflowTemplateId` columns or the `garment_shot_type_workflows` table (Phase 4). Those are separate plans, written after this one lands.
