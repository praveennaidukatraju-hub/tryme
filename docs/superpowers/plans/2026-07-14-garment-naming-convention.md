# Garment Naming Convention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the generic `garment.jpg` filename (shown on the Assets page for every uploaded garment) and the generic `image-N.jpg` / `tryme-<jobId>.jpg` download filenames (on the Catalogues pages) with a descriptive `{gender}-{garmentType}-{n}.jpg` convention, without changing R2 storage layout, ownership binding, or any existing key-uniqueness guarantee.

**Architecture:** The R2 *folder* for an uploaded garment stays a UUID (`inputs/<uuid>/...`) — that's what actually guarantees uniqueness and backs the existing ownership binding. Only the *filename inside that folder* changes, computed server-side at presign time from an optional `genderSlug`/`garmentTypeSlug` pair the caller now provides, numbered via a plain Redis `INCR` counter (cosmetic-only — a counter reset is harmless since two different UUID folders can share a filename with zero collision). The studio wizard already knows the user's gender/garment-type selection at upload time; the saree flow has no gender picker at all, so it sends only `garmentTypeSlug: 'saree'`, producing a gender-less `saree-{n}.jpg` — the naming scheme supports a garment-type-only form for exactly this case, no fabricated gender. On the Catalogues side, the same prefix logic is resolved server-side per catalogue (from the job's pose/garment-type, or the fixed `'saree'` label with a null gender) and used to build download filenames — no new Redis counter needed there since a whole batch of images to download is known upfront and can be numbered locally.

**Tech Stack:** Fastify 5 + Zod, Drizzle ORM/Postgres, ioredis, Next.js 15/React (studio, saree, catalogues pages), Vitest integration tests against the existing docker-compose Postgres/Redis/MinIO.

---

### Task 1: Gendered filenames for uploaded garments (`/v1/uploads/presign`)

**Files:**
- Modify: `packages/storage/src/keys.ts:2`
- Modify: `packages/types/src/jobs.ts:33-34,91-98`
- Modify: `apps/api/src/modules/uploads/routes.ts`
- Test: `apps/api/test/integration/uploads.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `apps/api/test/integration/uploads.test.ts`, right after the existing `it('POST /v1/uploads/presign returns presigned URL with 5min expiry', ...)` block (before the closing `});` of the `describe`):

```ts
  it('builds a gender-garmentType-n.jpg filename when both slugs are provided, incrementing per (user, gender, type)', async () => {
    const token = await getToken();

    const first = await app.inject({
      method: 'POST',
      url: '/v1/uploads/presign',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        contentType: 'image/jpeg',
        contentLength: 1024,
        genderSlug: 'men',
        garmentTypeSlug: 'full-sleeve-shirt',
      },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().r2Key).toMatch(
      /^inputs\/[a-f0-9-]+\/men-full-sleeve-shirt-1\.jpg$/,
    );

    const second = await app.inject({
      method: 'POST',
      url: '/v1/uploads/presign',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        contentType: 'image/jpeg',
        contentLength: 1024,
        genderSlug: 'men',
        garmentTypeSlug: 'full-sleeve-shirt',
      },
    });
    expect(second.json().r2Key).toMatch(
      /^inputs\/[a-f0-9-]+\/men-full-sleeve-shirt-2\.jpg$/,
    );

    // A different garment type for the same user starts its own count at 1.
    const otherType = await app.inject({
      method: 'POST',
      url: '/v1/uploads/presign',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        contentType: 'image/jpeg',
        contentLength: 1024,
        genderSlug: 'men',
        garmentTypeSlug: 'trousers',
      },
    });
    expect(otherType.json().r2Key).toMatch(/^inputs\/[a-f0-9-]+\/men-trousers-1\.jpg$/);
  });

  it('accepts garmentTypeSlug alone (no gender axis) for flows like saree with no gender picker', async () => {
    const token = await getToken();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/uploads/presign',
      headers: { authorization: `Bearer ${token}` },
      payload: { contentType: 'image/jpeg', contentLength: 1024, garmentTypeSlug: 'saree' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().r2Key).toMatch(/^inputs\/[a-f0-9-]+\/saree-1\.jpg$/);
  });

  it('rejects providing genderSlug without garmentTypeSlug', async () => {
    const token = await getToken();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/uploads/presign',
      headers: { authorization: `Bearer ${token}` },
      payload: { contentType: 'image/jpeg', contentLength: 1024, genderSlug: 'men' },
    });
    expect(res.statusCode).toBe(400);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @tryme/api exec vitest run --config vitest.integration.config.ts test/integration/uploads.test.ts --reporter=verbose`

Expected: FAIL — `PresignUploadBody` doesn't accept `genderSlug`/`garmentTypeSlug` yet, so every new test's `r2Key` assertion fails (the route still always returns plain `garment.jpg`), and the "rejects genderSlug without garmentTypeSlug" test gets `200` instead of `400` since the extra field is currently just ignored.

- [ ] **Step 3: Let `keys.inputGarment` accept a filename override**

In `packages/storage/src/keys.ts`, find:

```ts
  inputGarment: (jobId: string) => `inputs/${jobId}/garment.jpg`,
```

Replace with:

```ts
  inputGarment: (jobId: string, filename = 'garment.jpg') => `inputs/${jobId}/${filename}`,
```

- [ ] **Step 4: Relax `INPUT_GARMENT_KEY` to accept both the old and new filename shapes**

In `packages/types/src/jobs.ts`, find:

```ts
export const INPUT_GARMENT_KEY =
  /^inputs\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/garment\.jpg$/;
```

Replace with:

```ts
// Accepts either the legacy fixed filename ("garment.jpg", still used where no
// gender/garment-type context exists — e.g. the tryon person photo, studio's
// lower-garment upload) or the new descriptive form built by
// keys.inputGarment()'s filename override: "<gender>-<garment-type>-<n>.jpg".
// The UUID folder segment (unchanged) is what actually guarantees uniqueness
// and backs the ownership binding — this regex only bounds the filename shape.
export const INPUT_GARMENT_KEY =
  /^inputs\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/(?:garment|[a-z0-9]+(?:-[a-z0-9]+)*-\d+)\.jpg$/;
```

- [ ] **Step 5: Validate the new presign fields**

In `packages/types/src/jobs.ts`, find:

```ts
export const PresignUploadBody = z.object({
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  contentLength: z
    .number()
    .int()
    .positive()
    .max(10 * 1024 * 1024),
});
```

Replace with:

```ts
export const PresignUploadBody = z
  .object({
    contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
    contentLength: z
      .number()
      .int()
      .positive()
      .max(10 * 1024 * 1024),
    // Optional — when garmentTypeSlug is provided, the presigned key's filename
    // becomes descriptive instead of the generic "garment.jpg" (see
    // keys.inputGarment / uploads/routes.ts): "<garmentTypeSlug>-<n>.jpg" alone,
    // or "<genderSlug>-<garmentTypeSlug>-<n>.jpg" if genderSlug is also given.
    // genderSlug alone is invalid — it only makes sense alongside a garment
    // type. Flows with no naming context at all (tryon person photo, lower
    // garment upload) omit both and keep the old filename.
    genderSlug: z.enum(['men', 'women', 'boys', 'girls']).optional(),
    garmentTypeSlug: z
      .string()
      .min(1)
      .max(100)
      .regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, 'garmentTypeSlug must be lowercase kebab-case')
      .optional(),
  })
  .refine((d) => !d.genderSlug || Boolean(d.garmentTypeSlug), {
    message: 'genderSlug requires garmentTypeSlug',
  });
```

- [ ] **Step 6: Build the gendered filename in the presign route**

In `apps/api/src/modules/uploads/routes.ts`, find:

```ts
    async (req) => {
      const { contentType, contentLength } = req.body as z.infer<typeof PresignUploadBody>;
      const jobToken = randomUUID(); // pre-job upload identifier
      const r2Key = keys.inputGarment(jobToken);
      const { url, expiresIn } = await app.storage.presignPut(
        r2Key,
        contentType,
        contentLength,
        1800,
      );
```

Replace with:

```ts
    async (req) => {
      const { contentType, contentLength, genderSlug, garmentTypeSlug } = req.body as z.infer<
        typeof PresignUploadBody
      >;
      const jobToken = randomUUID(); // pre-job upload identifier

      let filename: string | undefined;
      if (garmentTypeSlug) {
        // Cosmetic-only counter — a Redis flush just restarts a user's count at 1,
        // which is harmless since two different UUID folders can share a filename
        // with zero real collision (the folder is what guarantees uniqueness).
        // Counter is scoped by genderSlug too (when present) so e.g. men's and
        // women's "t-shirt" counts don't collide.
        const n = await app.redis.incr(
          `garment-seq:${req.userId}:${genderSlug ?? '_'}:${garmentTypeSlug}`,
        );
        filename = genderSlug ? `${genderSlug}-${garmentTypeSlug}-${n}.jpg` : `${garmentTypeSlug}-${n}.jpg`;
      }

      const r2Key = keys.inputGarment(jobToken, filename);
      const { url, expiresIn } = await app.storage.presignPut(
        r2Key,
        contentType,
        contentLength,
        1800,
      );
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm --filter @tryme/api exec vitest run --config vitest.integration.config.ts test/integration/uploads.test.ts --reporter=verbose`

Expected: PASS — all 4 tests (2 existing + 2 new) green.

- [ ] **Step 8: Run the full unit suite to confirm the regex relaxation didn't break anything**

Run: `pnpm --filter @tryme/api test:unit`

Expected: all passing (the regex change is strictly more permissive — every string the old regex accepted, the new one still accepts).

- [ ] **Step 9: Typecheck**

Run: `pnpm --filter @tryme/types typecheck && pnpm --filter @tryme/storage typecheck && pnpm --filter @tryme/api typecheck`

Expected: no errors.

- [ ] **Step 10: Commit**

```bash
git add packages/storage/src/keys.ts packages/types/src/jobs.ts apps/api/src/modules/uploads/routes.ts apps/api/test/integration/uploads.test.ts
git commit -m "feat(api): gendered filenames for uploaded garments"
```

---

### Task 2: Expose `genderSlug`/`garmentTypeSlug` on the Catalogues API

**Files:**
- Modify: `apps/api/src/modules/jobs/routes.ts:263-405`
- Test: `apps/api/test/integration/catalogues-naming.test.ts`

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/integration/catalogues-naming.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createVerifiedUserToken } from '../helpers/auth.js';
import { buildTestApp, type TestApp } from '../helpers/api.js';
import { type Containers, startContainers } from '../helpers/containers.js';

describe('catalogue naming fields (genderSlug / garmentTypeSlug)', () => {
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

  it('resolves genderSlug + garmentTypeSlug for a studio (catalog) job from its pose + garment type', async () => {
    const { token, userId } = await createVerifiedUserToken(
      app,
      `cat-naming-${Date.now()}@x.com`,
    );

    const [pose] = await app.db
      .insert(schema.modelPoseAssets)
      .values({ label: 'P', r2Key: 'p.jpg', thumbnailKey: 'p.jpg', genderSlug: 'men' })
      .returning();
    const [garmentType] = await app.db
      .insert(schema.garmentSubcategories)
      .values({ genderSlug: 'men', slug: 'full-sleeve-shirt', label: 'Full Sleeve Shirt' })
      .returning();

    const catalogueId = randomUUID();
    const [job] = await app.db
      .insert(schema.jobs)
      .values({
        userId,
        catalogueId,
        status: 'COMPLETED',
        priority: false,
        creditsCharged: 1,
        source: 'catalog',
      })
      .returning();
    await app.db.insert(schema.jobInputs).values({
      jobId: job?.id,
      upperGarmentKey: `inputs/${job?.id}/garment.jpg`,
      poseId: pose?.id,
      garmentTypeId: garmentType?.id,
    });

    const listRes = await app.inject({
      method: 'GET',
      url: '/v1/catalogues',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(listRes.statusCode).toBe(200);
    const group = listRes
      .json()
      .find((g: { catalogueId: string }) => g.catalogueId === catalogueId);
    expect(group.genderSlug).toBe('men');
    expect(group.garmentTypeSlug).toBe('full-sleeve-shirt');

    const detailRes = await app.inject({
      method: 'GET',
      url: `/v1/catalogues/${catalogueId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(detailRes.statusCode).toBe(200);
    expect(detailRes.json().genderSlug).toBe('men');
    expect(detailRes.json().garmentTypeSlug).toBe('full-sleeve-shirt');
  });

  it('falls back to a null gender + fixed "saree" garmentTypeSlug for a saree job (no gender axis, no garmentTypeId/poseId)', async () => {
    const { token, userId } = await createVerifiedUserToken(
      app,
      `saree-naming-${Date.now()}@x.com`,
    );

    const catalogueId = randomUUID();
    const [job] = await app.db
      .insert(schema.jobs)
      .values({
        userId,
        catalogueId,
        status: 'COMPLETED',
        priority: false,
        creditsCharged: 1,
        source: 'saree',
      })
      .returning();
    await app.db.insert(schema.jobInputs).values({
      jobId: job?.id,
      upperGarmentKey: `inputs/${job?.id}/garment.jpg`,
    });

    const listRes = await app.inject({
      method: 'GET',
      url: '/v1/catalogues',
      headers: { authorization: `Bearer ${token}` },
    });
    const group = listRes
      .json()
      .find((g: { catalogueId: string }) => g.catalogueId === catalogueId);
    expect(group.genderSlug).toBeNull();
    expect(group.garmentTypeSlug).toBe('saree');

    const detailRes = await app.inject({
      method: 'GET',
      url: `/v1/catalogues/${catalogueId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(detailRes.json().genderSlug).toBeNull();
    expect(detailRes.json().garmentTypeSlug).toBe('saree');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm --filter @tryme/api exec vitest run --config vitest.integration.config.ts test/integration/catalogues-naming.test.ts --reporter=verbose`

Expected: FAIL — `group.garmentTypeSlug` and `detailRes.json().garmentTypeSlug` are `undefined` (fields don't exist in either response yet).

- [ ] **Step 3: Add the fields to `GET /v1/catalogues`**

In `apps/api/src/modules/jobs/routes.ts`, find:

```ts
    const rows = await app.db
      .select({
        id: schema.jobs.id,
        catalogueId: schema.jobs.catalogueId,
        status: schema.jobs.status,
        createdAt: schema.jobs.createdAt,
        creditsCharged: schema.jobs.creditsCharged,
        genderSlug: schema.modelPoseAssets.genderSlug,
        params: schema.jobInputs.params,
      })
      .from(schema.jobs)
      .leftJoin(schema.jobInputs, eq(schema.jobInputs.jobId, schema.jobs.id))
      .leftJoin(schema.modelPoseAssets, eq(schema.modelPoseAssets.id, schema.jobInputs.poseId))
      .where(
        and(
          eq(schema.jobs.userId, req.userId),
          sql`${schema.jobInputs.params}->>'sourceJobId' is null`,
        ),
      )
      .orderBy(desc(schema.jobs.createdAt))
      .limit(200);

    // Group by catalogueId; jobs without catalogueId use their own id
    type Row = (typeof rows)[number];
    const map = new Map<string, Row[]>();
    for (const row of rows) {
      const key = row.catalogueId ?? row.id;
      if (!map.has(key)) map.set(key, []);
      map.get(key)?.push(row);
    }

    const groups = Array.from(map.entries()).map(([catalogueId, cJobs]) => ({
      catalogueId,
      // genderSlug + platform come from the first job that has one (all jobs in a catalogue share these)
      genderSlug: cJobs.find((j) => j.genderSlug)?.genderSlug ?? null,
      platform: ((cJobs[0]?.params as Record<string, unknown> | null)?.platform as string) ?? null,
      jobs: cJobs.map(({ genderSlug: _g, params: _p, ...j }) => j),
      createdAt: cJobs[cJobs.length - 1].createdAt,
    }));
```

Replace with:

```ts
    const rows = await app.db
      .select({
        id: schema.jobs.id,
        catalogueId: schema.jobs.catalogueId,
        status: schema.jobs.status,
        createdAt: schema.jobs.createdAt,
        creditsCharged: schema.jobs.creditsCharged,
        source: schema.jobs.source,
        genderSlug: schema.modelPoseAssets.genderSlug,
        garmentTypeSlug: schema.garmentSubcategories.slug,
        params: schema.jobInputs.params,
      })
      .from(schema.jobs)
      .leftJoin(schema.jobInputs, eq(schema.jobInputs.jobId, schema.jobs.id))
      .leftJoin(schema.modelPoseAssets, eq(schema.modelPoseAssets.id, schema.jobInputs.poseId))
      .leftJoin(
        schema.garmentSubcategories,
        eq(schema.garmentSubcategories.id, schema.jobInputs.garmentTypeId),
      )
      .where(
        and(
          eq(schema.jobs.userId, req.userId),
          sql`${schema.jobInputs.params}->>'sourceJobId' is null`,
        ),
      )
      .orderBy(desc(schema.jobs.createdAt))
      .limit(200);

    // Group by catalogueId; jobs without catalogueId use their own id
    type Row = (typeof rows)[number];
    const map = new Map<string, Row[]>();
    for (const row of rows) {
      const key = row.catalogueId ?? row.id;
      if (!map.has(key)) map.set(key, []);
      map.get(key)?.push(row);
    }

    const groups = Array.from(map.entries()).map(([catalogueId, cJobs]) => {
      // Saree jobs never set garmentTypeId/poseId (no gender/garment-type picker in
      // that flow) — fixed 'saree' label, no gender axis (matches the Assets-page
      // saree upload naming, which is also gender-less: "saree-N.jpg").
      const isSaree = cJobs.some((j) => j.source === 'saree');
      return {
        catalogueId,
        // genderSlug + platform come from the first job that has one (all jobs in a catalogue share these)
        genderSlug: isSaree ? null : (cJobs.find((j) => j.genderSlug)?.genderSlug ?? null),
        garmentTypeSlug: isSaree
          ? 'saree'
          : (cJobs.find((j) => j.garmentTypeSlug)?.garmentTypeSlug ?? null),
        platform:
          ((cJobs[0]?.params as Record<string, unknown> | null)?.platform as string) ?? null,
        jobs: cJobs.map(({ genderSlug: _g, garmentTypeSlug: _gt, source: _s, params: _p, ...j }) => j),
        createdAt: cJobs[cJobs.length - 1].createdAt,
      };
    });
```

- [ ] **Step 4: Add the fields to `GET /v1/catalogues/:id`**

In the same file, find:

```ts
      // All jobs in a catalogue share the same aspectRatio and garment (set once at creation).
      // Pull both from any one job's inputs.
      const [anyInput] = await app.db
        .select({
          params: schema.jobInputs.params,
          upperGarmentKey: schema.jobInputs.upperGarmentKey,
        })
        .from(schema.jobInputs)
        .innerJoin(schema.jobs, eq(schema.jobInputs.jobId, schema.jobs.id))
        .where(and(eq(schema.jobs.catalogueId, id), eq(schema.jobs.userId, req.userId)))
        .limit(1);
      const aspectRatio =
        (anyInput?.params as { aspectRatio?: string } | null)?.aspectRatio ?? null;
```

Replace with:

```ts
      // All jobs in a catalogue share the same aspectRatio, gender, and garment type
      // (set once at creation). Pull all from any one job's inputs.
      const [anyInput] = await app.db
        .select({
          params: schema.jobInputs.params,
          upperGarmentKey: schema.jobInputs.upperGarmentKey,
          source: schema.jobs.source,
          genderSlug: schema.modelPoseAssets.genderSlug,
          garmentTypeSlug: schema.garmentSubcategories.slug,
        })
        .from(schema.jobInputs)
        .innerJoin(schema.jobs, eq(schema.jobInputs.jobId, schema.jobs.id))
        .leftJoin(schema.modelPoseAssets, eq(schema.modelPoseAssets.id, schema.jobInputs.poseId))
        .leftJoin(
          schema.garmentSubcategories,
          eq(schema.garmentSubcategories.id, schema.jobInputs.garmentTypeId),
        )
        .where(and(eq(schema.jobs.catalogueId, id), eq(schema.jobs.userId, req.userId)))
        .limit(1);
      const aspectRatio =
        (anyInput?.params as { aspectRatio?: string } | null)?.aspectRatio ?? null;
      // Same saree fallback as GET /v1/catalogues — see comment there.
      const isSareeCatalogue = anyInput?.source === 'saree';
      const genderSlug = isSareeCatalogue ? null : (anyInput?.genderSlug ?? null);
      const garmentTypeSlug = isSareeCatalogue ? 'saree' : (anyInput?.garmentTypeSlug ?? null);
```

Then find:

```ts
      return { catalogueId: id, jobs, aspectRatio, garmentUrl, currentPlanWatermark };
```

Replace with:

```ts
      return {
        catalogueId: id,
        jobs,
        aspectRatio,
        garmentUrl,
        currentPlanWatermark,
        genderSlug,
        garmentTypeSlug,
      };
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm --filter @tryme/api exec vitest run --config vitest.integration.config.ts test/integration/catalogues-naming.test.ts --reporter=verbose`

Expected: PASS — both tests green.

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @tryme/api typecheck`

Expected: no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/jobs/routes.ts apps/api/test/integration/catalogues-naming.test.ts
git commit -m "feat(api): expose genderSlug/garmentTypeSlug on catalogues list + detail"
```

---

### Task 3: Studio wizard sends gender + garment-type slug on upload

**Files:**
- Modify: `apps/catalogues-web/src/app/(app)/studio/page.tsx:982-1002`

- [ ] **Step 1: Pass the slugs on the main garment upload**

In `apps/catalogues-web/src/app/(app)/studio/page.tsx`, find:

```tsx
  async function handleGarmentUpload(file: File) {
    if (isUploading) return;
    if (file.size > 10 * 1024 * 1024) {
      showToast('File exceeds 10 MB. Please choose a smaller image.');
      return;
    }
    if (!(await isSupportedImageBytes(file))) {
      showToast('Unsupported file type. Please upload a JPEG, PNG, or WebP image.');
      return;
    }
    setGarmentFile(file);
    setIsUploading(true);
    setUploadProgress(0);
    const abort = new AbortController();
    uploadAbortRef.current = abort;
    try {
      const { uploadUrl, r2Key } = await api.post<{
        uploadUrl: string;
        r2Key: string;
        expiresIn: number;
      }>('/v1/uploads/presign', { contentType: file.type, contentLength: file.size });
```

Replace with:

```tsx
  async function handleGarmentUpload(file: File) {
    if (isUploading) return;
    if (file.size > 10 * 1024 * 1024) {
      showToast('File exceeds 10 MB. Please choose a smaller image.');
      return;
    }
    if (!(await isSupportedImageBytes(file))) {
      showToast('Unsupported file type. Please upload a JPEG, PNG, or WebP image.');
      return;
    }
    setGarmentFile(file);
    setIsUploading(true);
    setUploadProgress(0);
    const abort = new AbortController();
    uploadAbortRef.current = abort;
    try {
      const currentGarmentType = garmentTypes?.items.find((g) => g.id === garmentTypeId);
      const { uploadUrl, r2Key } = await api.post<{
        uploadUrl: string;
        r2Key: string;
        expiresIn: number;
      }>('/v1/uploads/presign', {
        contentType: file.type,
        contentLength: file.size,
        // Naming context — Assets page shows the resulting filename directly
        // (r2Key.split('/').pop()), so a real gender+garment-type pair here
        // produces a descriptive name instead of the generic fallback.
        ...(currentGarmentType ? { genderSlug: gender, garmentTypeSlug: currentGarmentType.slug } : {}),
      });
```

(This intentionally reuses the same `garmentTypeId`/`garmentTypes` lookup already used elsewhere in the file for `selectedGarmentType` — done inline here since `selectedGarmentType` itself is declared later in the component body, which is fine for a closure but this keeps the diff local and obviously correct without depending on declaration order.)

- [ ] **Step 2: Typecheck + lint**

Run: `pnpm --filter @tryme/web typecheck`

Expected: no errors.

Run: `npx biome check "apps/catalogues-web/src/app/(app)/studio/page.tsx"`

Expected: no errors (or auto-fixable formatting only).

- [ ] **Step 3: Manual check**

Start the web dev server (`pnpm --filter @tryme/web dev`), go through the studio wizard picking a gender + garment type, upload a garment photo, then open `/assets` and confirm the card's filename is `{gender}-{garmentTypeSlug}-1.jpg` (or `-2.jpg` etc. on a repeat upload of the same type) instead of `garment.jpg`.

- [ ] **Step 4: Commit**

```bash
git add "apps/catalogues-web/src/app/(app)/studio/page.tsx"
git commit -m "feat(web): send gender+garmentType to presign for descriptive Assets naming"
```

---

### Task 4: Saree upload sends the fixed "saree" label (no gender axis)

**Files:**
- Modify: `apps/catalogues-web/src/app/(app)/saree/page.tsx:363-366`

- [ ] **Step 1: Pass the fixed garment-type slug**

In `apps/catalogues-web/src/app/(app)/saree/page.tsx`, find:

```tsx
      const presign = await api.post<{ uploadUrl: string; r2Key: string }>('/v1/uploads/presign', {
        contentType: sareeFile.type,
        contentLength: sareeFile.size,
      });
```

Replace with:

```tsx
      const presign = await api.post<{ uploadUrl: string; r2Key: string }>('/v1/uploads/presign', {
        contentType: sareeFile.type,
        contentLength: sareeFile.size,
        // The saree flow has no gender picker, so only garmentTypeSlug is sent —
        // the presign route builds a gender-less "saree-N.jpg" filename for this case.
        garmentTypeSlug: 'saree',
      });
```

- [ ] **Step 2: Typecheck + lint**

Run: `pnpm --filter @tryme/web typecheck`

Expected: no errors.

Run: `npx biome check "apps/catalogues-web/src/app/(app)/saree/page.tsx"`

Expected: no errors (or auto-fixable formatting only).

- [ ] **Step 3: Manual check**

Upload a saree photo via `/saree`, then open `/assets` and confirm the filename is `saree-{n}.jpg`.

- [ ] **Step 4: Commit**

```bash
git add "apps/catalogues-web/src/app/(app)/saree/page.tsx"
git commit -m "feat(web): send fixed saree naming label on saree upload (no gender axis)"
```

---

### Task 5: Descriptive ZIP filenames on the Catalogues list page

**Files:**
- Modify: `apps/catalogues-web/src/app/(app)/catalogues/page.tsx:36-44,547-566`

- [ ] **Step 1: Add the new field to the `Catalogue` interface**

In `apps/catalogues-web/src/app/(app)/catalogues/page.tsx`, find:

```tsx
interface Catalogue {
  catalogueId: string;
  jobs: JobSummary[];
  createdAt: string;
  genderSlug: string | null;
  platform: string | null;
  coverUrl: string | null;
  coverThumbUrl: string | null;
}
```

Replace with:

```tsx
interface Catalogue {
  catalogueId: string;
  jobs: JobSummary[];
  createdAt: string;
  genderSlug: string | null;
  garmentTypeSlug: string | null;
  platform: string | null;
  coverUrl: string | null;
  coverThumbUrl: string | null;
}
```

- [ ] **Step 2: Name each ZIP entry from the catalogue's gender + garment type**

Find:

```tsx
      // Phase 3: build ZIP — UUIDs are filesystem-safe, no sanitization needed
      const JSZip = (await import('jszip')).default;
      const zip = new JSZip();

      const byCat = new Map<string, Array<{ blob: Blob }>>();
      for (const item of succeeded) {
        const existing = byCat.get(item.catalogueId);
        if (!existing) {
          byCat.set(item.catalogueId, [{ blob: item.blob }]);
        } else {
          existing.push({ blob: item.blob });
        }
      }

      for (const [catalogueId, items] of byCat.entries()) {
        const folder = zip.folder(catalogueId.slice(0, 8));
        items.forEach((item, idx) => {
          folder?.file(`image-${idx + 1}.jpg`, item.blob);
        });
      }
```

Replace with:

```tsx
      // Phase 3: build ZIP — UUIDs are filesystem-safe, no sanitization needed
      const JSZip = (await import('jszip')).default;
      const zip = new JSZip();

      // gender+garmentType prefix per catalogue (garmentType alone for saree,
      // which has no gender axis — see /v1/catalogues). Falls back to the old
      // generic "image-N.jpg" naming when garmentTypeSlug isn't known at all
      // (e.g. pre-existing catalogues created before garmentTypeId was tracked).
      const catNamePrefix = new Map(
        snapshotCatalogues.map((cat) => [
          cat.catalogueId,
          cat.garmentTypeSlug
            ? cat.genderSlug
              ? `${cat.genderSlug}-${cat.garmentTypeSlug}`
              : cat.garmentTypeSlug
            : null,
        ]),
      );

      const byCat = new Map<string, Array<{ blob: Blob }>>();
      for (const item of succeeded) {
        const existing = byCat.get(item.catalogueId);
        if (!existing) {
          byCat.set(item.catalogueId, [{ blob: item.blob }]);
        } else {
          existing.push({ blob: item.blob });
        }
      }

      for (const [catalogueId, items] of byCat.entries()) {
        const folder = zip.folder(catalogueId.slice(0, 8));
        const prefix = catNamePrefix.get(catalogueId) ?? null;
        items.forEach((item, idx) => {
          folder?.file(prefix ? `${prefix}-${idx + 1}.jpg` : `image-${idx + 1}.jpg`, item.blob);
        });
      }
```

- [ ] **Step 3: Typecheck + lint**

Run: `pnpm --filter @tryme/web typecheck`

Expected: no errors.

Run: `npx biome check "apps/catalogues-web/src/app/(app)/catalogues/page.tsx"`

Expected: no errors (or auto-fixable formatting only).

- [ ] **Step 4: Manual check**

On `/catalogues`, select one or more completed catalogues and click "Download". Unzip the result and confirm each catalogue's folder contains files named `{gender}-{garmentType}-1.jpg`, `-2.jpg`, etc. (or `image-1.jpg` for any catalogue predating garment-type tracking).

- [ ] **Step 5: Commit**

```bash
git add "apps/catalogues-web/src/app/(app)/catalogues/page.tsx"
git commit -m "feat(web): descriptive ZIP filenames on the catalogues bulk download"
```

---

### Task 6: Descriptive filenames on the Catalogue detail page

**Files:**
- Modify: `apps/catalogues-web/src/app/(app)/catalogues/[id]/page.tsx:53-58,141-153,509-537,673-754,880-889`

- [ ] **Step 1: Add the new fields to `CatalogueDetail`**

In `apps/catalogues-web/src/app/(app)/catalogues/[id]/page.tsx`, find:

```tsx
interface CatalogueDetail {
  catalogueId: string;
  jobs: Job[];
  garmentUrl?: string | null;
  currentPlanWatermark: boolean;
}
```

Replace with:

```tsx
interface CatalogueDetail {
  catalogueId: string;
  jobs: Job[];
  garmentUrl?: string | null;
  currentPlanWatermark: boolean;
  genderSlug?: string | null;
  garmentTypeSlug?: string | null;
}
```

- [ ] **Step 2: Add a `fileName` prop to `ImageCard`**

Find:

```tsx
function ImageCard({
  job,
  catalogueId,
  queuePosition,
  garmentUrl,
  onZoom,
}: {
  job: Job;
  catalogueId: string;
  queuePosition: number;
  garmentUrl?: string | null;
  onZoom: (data: { url: string; job: Job }) => void;
}) {
```

Replace with:

```tsx
function ImageCard({
  job,
  catalogueId,
  queuePosition,
  garmentUrl,
  fileName,
  onZoom,
}: {
  job: Job;
  catalogueId: string;
  queuePosition: number;
  garmentUrl?: string | null;
  fileName: string;
  onZoom: (data: { url: string; job: Job }) => void;
}) {
```

- [ ] **Step 3: Use `fileName` in the single-download handler**

Find:

```tsx
                      const objectUrl = URL.createObjectURL(blob);
                      const a = document.createElement('a');
                      a.href = objectUrl;
                      a.download = `tryme-${job.id.slice(0, 8)}.jpg`;
                      document.body.appendChild(a);
                      a.click();
                      a.remove();
                      URL.revokeObjectURL(objectUrl);
                    } catch (e) {
                      alert(
                        e instanceof Error
                          ? e.message
                          : 'The image could not be downloaded. Try again.',
                      );
```

Replace with:

```tsx
                      const objectUrl = URL.createObjectURL(blob);
                      const a = document.createElement('a');
                      a.href = objectUrl;
                      a.download = fileName;
                      document.body.appendChild(a);
                      a.click();
                      a.remove();
                      URL.revokeObjectURL(objectUrl);
                    } catch (e) {
                      alert(
                        e instanceof Error
                          ? e.message
                          : 'The image could not be downloaded. Try again.',
                      );
```

- [ ] **Step 4: Compute a stable per-job filename map in the page component**

Find:

```tsx
  // Ordered queue positions — oldest QUEUED job = position 1
  const queuedIds = useMemo(
    () =>
      (data?.jobs ?? [])
        .filter((j) => j.status === 'QUEUED')
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
        .map((j) => j.id),
    [data?.jobs],
  );
```

Replace with:

```tsx
  // Ordered queue positions — oldest QUEUED job = position 1
  const queuedIds = useMemo(
    () =>
      (data?.jobs ?? [])
        .filter((j) => j.status === 'QUEUED')
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
        .map((j) => j.id),
    [data?.jobs],
  );

  // Stable per-job download filename — same value whether downloaded from the
  // individual card or via "Download all". garmentType alone (no gender
  // prefix) for saree, which has no gender axis — see /v1/catalogues. Falls
  // back to the old tryme-<jobId> naming when garmentTypeSlug isn't known
  // at all (pre-existing catalogues created before garmentTypeId was tracked).
  const jobFileNames = useMemo(() => {
    const prefix = data?.garmentTypeSlug
      ? data?.genderSlug
        ? `${data.genderSlug}-${data.garmentTypeSlug}`
        : data.garmentTypeSlug
      : null;
    const map = new Map<string, string>();
    (data?.jobs ?? []).forEach((j, i) => {
      map.set(j.id, prefix ? `${prefix}-${i + 1}.jpg` : `tryme-${j.id.slice(0, 8)}.jpg`);
    });
    return map;
  }, [data]);
```

- [ ] **Step 5: Use the map in "Download all"**

Find:

```tsx
      // Trigger individual downloads
      for (const { jobId, blob } of succeeded) {
        const objectUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = objectUrl;
        a.download = `tryme-${jobId.slice(0, 8)}.jpg`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(objectUrl);
      }
```

Replace with:

```tsx
      // Trigger individual downloads
      for (const { jobId, blob } of succeeded) {
        const objectUrl = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = objectUrl;
        a.download = jobFileNames.get(jobId) ?? `tryme-${jobId.slice(0, 8)}.jpg`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        URL.revokeObjectURL(objectUrl);
      }
```

- [ ] **Step 6: Pass `fileName` into `ImageCard`**

Find:

```tsx
            {data.jobs.map((job) => (
              <ImageCard
                key={job.id}
                job={job}
                catalogueId={id}
                queuePosition={queuedIds.indexOf(job.id) + 1}
                garmentUrl={data.garmentUrl}
                onZoom={setZoom}
              />
            ))}
```

Replace with:

```tsx
            {data.jobs.map((job) => (
              <ImageCard
                key={job.id}
                job={job}
                catalogueId={id}
                queuePosition={queuedIds.indexOf(job.id) + 1}
                garmentUrl={data.garmentUrl}
                fileName={jobFileNames.get(job.id) ?? `tryme-${job.id.slice(0, 8)}.jpg`}
                onZoom={setZoom}
              />
            ))}
```

- [ ] **Step 7: Typecheck + lint**

Run: `pnpm --filter @tryme/web typecheck`

Expected: no errors.

Run: `npx biome check "apps/catalogues-web/src/app/(app)/catalogues/[id]/page.tsx"`

Expected: no errors (or auto-fixable formatting only).

- [ ] **Step 8: Manual check**

Open a completed catalogue's detail page. Download a single image via its card button and confirm the saved filename is `{gender}-{garmentType}-{n}.jpg`. Then use "Download all" and confirm every file gets the same naming, with the SAME number for the same job as the single-download used (open the same card twice — once via the card button, once via "Download all" — and confirm identical filenames).

- [ ] **Step 9: Commit**

```bash
git add "apps/catalogues-web/src/app/(app)/catalogues/[id]/page.tsx"
git commit -m "feat(web): descriptive per-job filenames on the catalogue detail page"
```

---

### Task 7: Update progress log

**Files:**
- Modify: `docs/progress.md`

- [ ] **Step 1: Add a dated entry at the top**

Prepend to `docs/progress.md`:

```markdown
## 2026-07-14 - Garment Naming Convention (Assets + Catalogues pages)

### Done
- Uploaded garments now get a descriptive R2 filename — `{genderSlug}-{garmentTypeSlug}-{n}.jpg` — instead of the generic `garment.jpg`, shown directly on the Assets page (`r2Key.split('/').pop()`, unchanged). The UUID *folder* still guarantees real uniqueness and backs the existing ownership binding; only the filename inside it changed. Numbered per (user, gender, garment type) via a plain Redis `INCR` — cosmetic-only, a counter reset is harmless.
- Studio wizard's main garment upload passes the user's actual gender + garment-type selection. The saree flow (no gender picker at all) sends only `garmentTypeSlug: 'saree'`, producing a gender-less `saree-{n}.jpg` — confirmed intentional, not a gap: the naming convention supports a garment-type-only form for exactly this case.
- Out of scope, still generic `garment.jpg`: the tryon page's person-photo upload (never shown on Assets — see `docs/superpowers/specs/2026-07-13-tryon-media-retention-design.md`'s scope note) and studio's lower-garment upload (also never shown on Assets — `/v1/assets` only ever reads `upperGarmentKey`).
- `/v1/catalogues` and `/v1/catalogues/:id` now resolve and return `genderSlug`/`garmentTypeSlug` per catalogue (saree catalogues: `genderSlug: null`, `garmentTypeSlug: 'saree'`), used to name Catalogues-page downloads: the bulk ZIP's per-catalogue folder entries, the single-image download button on each generated image, and "Download all" on the catalogue detail page — all three now agree on the same filename for a given job, and all three drop the gender segment when `genderSlug` is null.
- `INPUT_GARMENT_KEY` (packages/types) relaxed to accept the legacy fixed `garment.jpg`, the two-segment `<gender>-<garmentType>-<n>.jpg`, and the single-segment `<garmentType>-<n>.jpg` shapes; still tightly bound to the UUID folder + `.jpg` extension.

### Failed / Not Done
- None.

### Open Questions / Decisions
- Catalogues predating garment-type tracking (or any future source that never sets `garmentTypeId`) fall back to the old generic download naming (`image-N.jpg` / `tryme-<jobId>.jpg`) rather than guessing — intentional, not a gap to close later.
```

- [ ] **Step 2: Commit**

```bash
git add docs/progress.md
git commit -m "docs(progress): log garment naming convention feature"
```
