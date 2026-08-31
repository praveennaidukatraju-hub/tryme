# Catalog Video Upload-Your-Own-Image Source Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user animate an arbitrary image they upload — not required to be an AI Vastra generation — through the "New Catalog Video" wizard, alongside the existing "pick a completed catalogue image" option.

**Architecture:** `POST /v1/jobs/catalog-video` accepts exactly one of `sourceJobId` (existing path) or a new `sourceImageKey` (a raw upload verified via the existing `assertOwnsUploadKey` ownership check). Everything downstream — credit cost, feature gate, PixVerse dispatch, refund-on-failure — is unchanged and shared by both paths. The wizard gets a tab toggle in step 1 and a dropzone that reuses the existing `/v1/uploads/presign` + `uploadToR2WithProgress` upload mechanics already proven in Studio.

**Tech Stack:** Fastify 5 + zod (`fastify-type-provider-zod`), Drizzle ORM, Next.js 15 + React Query, Vitest (API integration tests only — `apps/catalogues-web` has no frontend test runner).

## Global Constraints

- No testcontainers; API integration tests run against the docker-compose Postgres/Redis/MinIO already running on localhost (`pnpm docker:up`), via `apps/api/test/helpers/containers.ts` + `apps/api/test/helpers/api.ts`.
- Never use `console.log` in committed code — `@tryme/logger` only (not touched by this plan; no new logging needed).
- `packages/types` has no test runner — schema-validation behavior (the new XOR refine) is verified via `apps/api` integration tests hitting the real route, not an isolated unit test.
- Uploaded images are a one-time input to a single video job only — never saved as a catalogue/job entry, never surfaced in Catalogues or My Products (confirmed decision from brainstorming).
- Design spec: `docs/superpowers/specs/2026-08-06-catalog-video-upload-source-design.md`.

---

### Task 1: Backend — accept `sourceImageKey` in `POST /v1/jobs/catalog-video`

**Files:**
- Modify: `packages/types/src/jobs.ts:124-127` (`CreateCatalogVideoJobRequest`)
- Modify: `apps/api/src/modules/jobs/create.ts:943-1006` (`createCatalogVideoJob`)
- Modify: `apps/api/src/modules/jobs/routes.ts:398-406` (`GET /v1/catalogues` — preserve the video-job exclusion invariant)
- Test: `apps/api/test/integration/catalog-video-create.test.ts` (extend existing file)
- Test: `apps/api/test/integration/catalogues-exclude-mannequin.test.ts` (extend existing file)

**Interfaces:**
- Produces: `CreateCatalogVideoJobRequest` now has `sourceJobId?: string` (uuid) and `sourceImageKey?: string` (matches `INPUT_GARMENT_KEY`), exactly one required. `createCatalogVideoJob(app, userId, body)` return shape (`{ jobId }`) is unchanged.
- Consumes: `assertOwnsUploadKey(app, userId, key)` from `apps/api/src/lib/upload-ownership.ts` (already imported in `create.ts`) — throws `AppError('FORBIDDEN', 403, ...)` if the key isn't bound to this user in Redis, or `AppError('BAD_UPLOAD', 400/413, ...)` if the R2 object is missing/oversized.

**Why the routes.ts change is needed:** `GET /v1/catalogues` currently excludes catalog-video jobs from the catalogue grid via `params->>'sourceJobId' is null` — which only works because `sourceJobId` is *always* set on catalog-video jobs today. Once it becomes optional (the upload path never sets it), an upload-sourced video job would start appearing in the main catalogues list as if it were a catalogue image. Fix: exclude by `params->>'kind'` (always `'video'` for catalog-video jobs, confirmed as the *only* place `kind: 'video'` is written or read in the codebase), same style as the existing `saree_mannequin` exclusion right next to it.

- [ ] **Step 1: Write the failing tests**

In `apps/api/test/integration/catalog-video-create.test.ts`, add a `bindUploadKey` helper (mirrors the existing helper in `apps/api/test/integration/jobs-create-looks.test.ts:59-61`) and five new `it()` blocks inside the existing `describe('POST /v1/jobs/catalog-video', ...)`:

```ts
  async function bindUploadKey(userId: string, key: string) {
    await app.redis.set(`upload:owner:${key}`, userId, 'EX', 3600);
  }

  it('creates a job from an uploaded sourceImageKey, with no sourceJobId', async () => {
    const { token, userId } = await registerUser('cv-upload-happy@x.com');
    await grantCredits(userId, 200);
    const sourceImageKey = `inputs/${userId}/garment.jpg`;
    await bindUploadKey(userId, sourceImageKey);
    await app.storage.putObject(sourceImageKey, Buffer.from('uploaded-bytes'), 'image/jpeg');
    const sampleVideoId = await activeSample();
    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/catalog-video',
      headers: { authorization: `Bearer ${token}` },
      payload: { sourceImageKey, sampleVideoId },
    });
    expect(res.statusCode).toBe(201);
    const { jobId } = res.json();
    const [inputs] = await app.db
      .select()
      .from(schema.jobInputs)
      .where(eq(schema.jobInputs.jobId, jobId));
    const params = inputs.params as Record<string, unknown>;
    expect(params.sourceImageKey).toBe(sourceImageKey);
    expect(params).not.toHaveProperty('sourceJobId');
    expect(params.kind).toBe('video');
  });

  it('rejects with FORBIDDEN when sourceImageKey was never issued to this user', async () => {
    const { token, userId } = await registerUser('cv-upload-notowned@x.com');
    await grantCredits(userId, 100);
    const sourceImageKey = `inputs/${userId}/garment.jpg`;
    // deliberately not bound via bindUploadKey
    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/catalog-video',
      headers: { authorization: `Bearer ${token}` },
      payload: { sourceImageKey, sampleVideoId: await activeSample() },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects with BAD_UPLOAD when the sourceImageKey object does not exist in R2', async () => {
    const { token, userId } = await registerUser('cv-upload-missing@x.com');
    await grantCredits(userId, 100);
    const sourceImageKey = `inputs/${userId}/garment.jpg`;
    await bindUploadKey(userId, sourceImageKey);
    // deliberately not put to R2
    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/catalog-video',
      headers: { authorization: `Bearer ${token}` },
      payload: { sourceImageKey, sampleVideoId: await activeSample() },
    });
    expect(res.statusCode).toBe(400);
    // Asserting the error code (not just the status) matters here: before the
    // schema change, this same payload also 400s — but for a different reason
    // (sourceJobId missing → zod VALIDATION), not the object-missing check
    // this test is actually targeting. BAD_UPLOAD only appears once the schema
    // accepts sourceImageKey and assertGarmentObjectValid's headObject fails.
    expect(res.json().error.code).toBe('BAD_UPLOAD');
  });

  it('rejects with 400 when both sourceJobId and sourceImageKey are provided', async () => {
    const { token, userId } = await registerUser('cv-both@x.com');
    await grantCredits(userId, 100);
    const sourceJobId = await sourceJob(userId);
    const sourceImageKey = `inputs/${userId}/garment.jpg`;
    await bindUploadKey(userId, sourceImageKey);
    await app.storage.putObject(sourceImageKey, Buffer.from('x'), 'image/jpeg');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/catalog-video',
      headers: { authorization: `Bearer ${token}` },
      payload: { sourceJobId, sourceImageKey, sampleVideoId: await activeSample() },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects with 400 when neither sourceJobId nor sourceImageKey are provided', async () => {
    const { token, userId } = await registerUser('cv-neither@x.com');
    await grantCredits(userId, 100);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/catalog-video',
      headers: { authorization: `Bearer ${token}` },
      payload: { sampleVideoId: await activeSample() },
    });
    expect(res.statusCode).toBe(400);
  });
```

In `apps/api/test/integration/catalogues-exclude-mannequin.test.ts`, add a helper and a test inside the existing `describe`:

```ts
  async function seedUploadSourcedVideoJob(userId: string) {
    const [job] = await app.db
      .insert(schema.jobs)
      .values({ userId, status: 'QUEUED', priority: false, creditsCharged: 150 })
      .returning();
    await app.db.insert(schema.jobInputs).values({
      jobId: job.id,
      params: { kind: 'video', sourceImageKey: 'inputs/x/garment.jpg', sampleVideoId: 'y' },
    });
    return job.id;
  }

  it('GET /v1/catalogues does not include an upload-sourced catalog-video job', async () => {
    const { token, userId } = await registerUser('excl-video-catalogues@x.com');
    await seedUploadSourcedVideoJob(userId);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/catalogues',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toHaveLength(0);
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm --filter @tryme/api exec vitest run --config vitest.integration.config.ts test/integration/catalog-video-create.test.ts test/integration/catalogues-exclude-mannequin.test.ts`

Expected, per test (today's schema still requires `sourceJobId` and doesn't recognize `sourceImageKey`, so zod silently strips it):
- `creates a job from an uploaded sourceImageKey...` — **fails**: payload has no `sourceJobId`, so this 400s with `VALIDATION` instead of the expected 201.
- `rejects with FORBIDDEN when sourceImageKey was never issued...` — **fails**: 400 (`VALIDATION`, missing `sourceJobId`) instead of the expected 403.
- `rejects with BAD_UPLOAD when the sourceImageKey object does not exist...` — **fails**: the status code is coincidentally 400 either way, but `res.json().error.code` is `VALIDATION` today, not the expected `BAD_UPLOAD` — the assertion on `error.code` catches this.
- `rejects with 400 when both sourceJobId and sourceImageKey are provided` — **fails**: `sourceImageKey` is silently stripped by zod today, so the request succeeds (201) using the still-present `sourceJobId`, instead of the expected 400.
- `rejects with 400 when neither...are provided` — **already passes** today (sourceJobId is already required) — this one is a regression guard for the new schema, not a currently-broken behavior. That's expected; it doesn't need to go red first.

The `catalogues-exclude-mannequin.test.ts` addition also **already passes** today — the seeded row has no `sourceJobId`, so the existing `sourceJobId is null` filter already excludes it by coincidence. It becomes a real (not coincidental) regression guard once Step 4 makes `sourceJobId` optional for real upload-sourced jobs; it's included now so Step 5's fix is verifiably still correct.

Proceed to Step 3 regardless of which of the two "already passes" cases you confirmed.

- [ ] **Step 3: Update `CreateCatalogVideoJobRequest`**

In `packages/types/src/jobs.ts`, replace:

```ts
export const CreateCatalogVideoJobRequest = z.object({
  sourceJobId: z.string().uuid(),
  sampleVideoId: z.string().uuid(),
});
```

with:

```ts
export const CreateCatalogVideoJobRequest = z
  .object({
    // Exactly one of sourceJobId (an existing completed AI Vastra job) or
    // sourceImageKey (a fresh upload of any image the caller owns — not
    // required to have been generated by AI Vastra) is required — enforced
    // below, same XOR style as upperGarmentKey/mannequinJobId above.
    sourceJobId: z.string().uuid().optional(),
    sourceImageKey: z.string().regex(INPUT_GARMENT_KEY).optional(),
    sampleVideoId: z.string().uuid(),
  })
  .refine((d) => Boolean(d.sourceJobId) !== Boolean(d.sourceImageKey), {
    message: 'Provide either sourceJobId or sourceImageKey, not both',
    path: ['sourceJobId'],
  });
```

- [ ] **Step 4: Update `createCatalogVideoJob`**

In `apps/api/src/modules/jobs/create.ts`, replace the body of `createCatalogVideoJob` from `const cost = await getPixverseCreditCost(app);` through the `job_inputs` insert's `params` object (lines 948–1005 in the current file) with:

```ts
  const cost = await getPixverseCreditCost(app);

  // Exactly one of sourceJobId or sourceImageKey is present — enforced by
  // CreateCatalogVideoJobRequest's XOR refine. sourceImageKey lets the caller
  // animate any image they own, not required to be an AI Vastra generation;
  // sourceJobId reuses a completed AI Vastra job's own result.
  let resolvedSourceImageKey: string;
  if (body.sourceImageKey) {
    await assertOwnsUploadKey(app, userId, body.sourceImageKey);
    resolvedSourceImageKey = body.sourceImageKey;
  } else if (body.sourceJobId) {
    const sourceJobId = body.sourceJobId;
    const [source] = await app.db
      .select({
        userId: schema.jobs.userId,
        status: schema.jobs.status,
        // Tryon-direct results (source='tryon'/'api_tryon') are WebP-encoded, not
        // PNG (see apps/dispatcher/src/workflow/finalize.ts) — the actual uploaded
        // key must come from here, not be reconstructed via keys.output(sourceJobId).
        resultKey: schema.jobOutputs.resultKey,
      })
      .from(schema.jobs)
      .leftJoin(schema.jobOutputs, eq(schema.jobOutputs.jobId, schema.jobs.id))
      .where(eq(schema.jobs.id, sourceJobId));
    if (!source) throw new AppError('NOT_FOUND', 404, 'source image not found');
    if (source.userId !== userId)
      throw new AppError('FORBIDDEN', 403, 'source image not owned by caller');
    if (source.status !== 'COMPLETED')
      throw new AppError('VALIDATION', 400, 'source image is not a completed job');
    resolvedSourceImageKey = source.resultKey ?? keys.output(sourceJobId);
  } else {
    // Unreachable: CreateCatalogVideoJobRequest's XOR refine guarantees exactly
    // one of sourceJobId/sourceImageKey is present.
    throw new AppError('VALIDATION', 400, 'sourceJobId or sourceImageKey is required');
  }

  const [sample] = await app.db
    .select()
    .from(schema.sampleVideos)
    .where(eq(schema.sampleVideos.id, body.sampleVideoId));
  if (!sample || sample.deletedAt) throw new AppError('NOT_FOUND', 404, 'sample video not found');
  if (!sample.isActive) throw new AppError('VALIDATION', 400, 'sample video is not active');
  const [user] = await app.db.select().from(schema.users).where(eq(schema.users.id, userId));
  if (!user || user.isBanned) throw new AppError('FORBIDDEN', 403, 'banned');
  if (!isCatalogVideoAllowed(app.env, user.email)) {
    throw new AppError('FORBIDDEN', 403, 'catalog video is not enabled for this account');
  }
  const [job] = await app.db.transaction(async (tx) => {
    const [newJob] = await tx
      .insert(schema.jobs)
      .values({
        userId,
        status: 'QUEUED',
        priority: false,
        queueStream: 'video',
        watermark: false,
        creditsCharged: cost,
        source: JOB_SOURCE.CATALOG_VIDEO,
      })
      .returning();
    await atomicDeduct(tx as unknown as DB, userId, cost, newJob.id);
    await tx.insert(schema.jobInputs).values({
      jobId: newJob.id,
      params: {
        kind: 'video',
        ...(body.sourceJobId ? { sourceJobId: body.sourceJobId } : {}),
        sourceImageKey: resolvedSourceImageKey,
        sampleVideoId: body.sampleVideoId,
        prompt: sample.prompt,
      },
    });
    return [newJob];
  });
```

The rest of the function (the `xadd`/refund block) is unchanged.

- [ ] **Step 5: Fix the `/v1/catalogues` exclusion filter**

In `apps/api/src/modules/jobs/routes.ts`, in the `GET /v1/catalogues` handler, find:

```ts
      .where(
        and(
          eq(schema.jobs.userId, req.userId),
          sql`${schema.jobInputs.params}->>'sourceJobId' is null`,
          sql`${schema.jobInputs.params}->>'kind' is distinct from 'saree_mannequin'`,
        ),
      )
      .orderBy(desc(schema.jobs.createdAt))
      .limit(200);
```

Replace with:

```ts
      .where(
        and(
          eq(schema.jobs.userId, req.userId),
          sql`${schema.jobInputs.params}->>'sourceJobId' is null`,
          sql`${schema.jobInputs.params}->>'kind' is distinct from 'saree_mannequin'`,
          // Catalog-video jobs always set kind='video' regardless of source
          // (an existing AI Vastra job vs. a fresh upload) — the sourceJobId-is-null
          // check above only excludes them by coincidence (today sourceJobId is
          // always set on these jobs) and stops working once sourceJobId becomes
          // optional for the upload path. Exclude by kind explicitly instead.
          sql`${schema.jobInputs.params}->>'kind' is distinct from 'video'`,
        ),
      )
      .orderBy(desc(schema.jobs.createdAt))
      .limit(200);
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @tryme/api exec vitest run --config vitest.integration.config.ts test/integration/catalog-video-create.test.ts test/integration/catalogues-exclude-mannequin.test.ts`
Expected: all tests pass (5 new + existing in `catalog-video-create.test.ts`; 3 in `catalogues-exclude-mannequin.test.ts`).

- [ ] **Step 7: Typecheck**

Run: `pnpm --filter @tryme/api exec tsc --noEmit -p .` and `pnpm --filter @tryme/types exec tsc --noEmit -p .` (adjust filter name if different — check `packages/types/package.json`'s `"name"` field first).
Expected: no new errors (the dispatcher's pre-existing unrelated `jobE2eDuration` error, if present, is not introduced by this change — confirm via `git stash` if unsure).

- [ ] **Step 8: Commit**

```bash
git add packages/types/src/jobs.ts apps/api/src/modules/jobs/create.ts apps/api/src/modules/jobs/routes.ts apps/api/test/integration/catalog-video-create.test.ts apps/api/test/integration/catalogues-exclude-mannequin.test.ts
git commit -m "feat(api): accept sourceImageKey upload as catalog-video source

Lets a user animate an arbitrary image they own, not required to be
an AI Vastra generation, via POST /v1/jobs/catalog-video. Also fixes
GET /v1/catalogues' catalog-video exclusion filter, which relied on
sourceJobId always being set — no longer true for the upload path.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Frontend — extract shared `isSupportedImageBytes` helper

**Files:**
- Create: `apps/catalogues-web/src/lib/image-validation.ts`
- Modify: `apps/catalogues-web/src/app/(app)/studio/page.tsx:11` (add import), `:936-960` (remove local definition)

**Interfaces:**
- Produces: `isSupportedImageBytes(file: File): Promise<boolean>` — sniffs the first 12 bytes to confirm JPEG/PNG/WebP, regardless of declared MIME type or extension.
- Consumes: nothing (pure function, no dependencies).

**Why:** Task 3's upload dropzone needs the exact same file-type validation Studio's garment upload already does. `apps/catalogues-web/src/app/(app)/studio/page.tsx` defines it as a local, non-exported function — extracting it avoids a second copy of image-sniffing logic that could silently drift out of sync between the two upload flows.

- [ ] **Step 1: Create the shared helper**

Write `apps/catalogues-web/src/lib/image-validation.ts`:

```ts
/** Sniffs the first bytes of a File to confirm it's actually a JPEG, PNG, or
 *  WebP — a declared MIME type or file extension alone can't be trusted. */
export async function isSupportedImageBytes(file: File): Promise<boolean> {
  const buf = await file.slice(0, 12).arrayBuffer();
  const b = new Uint8Array(buf);
  const isJpeg = b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
  const isPng =
    b[0] === 0x89 &&
    b[1] === 0x50 &&
    b[2] === 0x4e &&
    b[3] === 0x47 &&
    b[4] === 0x0d &&
    b[5] === 0x0a &&
    b[6] === 0x1a &&
    b[7] === 0x0a;
  const isWebp =
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50;
  return isJpeg || isPng || isWebp;
}
```

- [ ] **Step 2: Point Studio at the shared helper**

In `apps/catalogues-web/src/app/(app)/studio/page.tsx`, add the import after the existing `@/lib/api` import (currently line 11):

```ts
import { api } from '@/lib/api';
import { isSupportedImageBytes } from '@/lib/image-validation';
```

Then delete the local definition (currently lines 936–960):

```ts
  async function isSupportedImageBytes(file: File): Promise<boolean> {
    const buf = await file.slice(0, 12).arrayBuffer();
    const b = new Uint8Array(buf);
    const isJpeg = b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
    const isPng =
      b[0] === 0x89 &&
      b[1] === 0x50 &&
      b[2] === 0x4e &&
      b[3] === 0x47 &&
      b[4] === 0x0d &&
      b[5] === 0x0a &&
      b[6] === 0x1a &&
      b[7] === 0x0a;
    const isWebp =
      b[0] === 0x52 &&
      b[1] === 0x49 &&
      b[2] === 0x46 &&
      b[3] === 0x46 &&
      b[8] === 0x57 &&
      b[9] === 0x45 &&
      b[10] === 0x42 &&
      b[11] === 0x50;
    return isJpeg || isPng || isWebp;
  }

```

(Leave the 5 call sites — `handleGarmentUpload` and the lower/third/pallu equivalents — untouched; they call it the same way either way.)

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @tryme/web exec tsc --noEmit -p .`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/catalogues-web/src/lib/image-validation.ts "apps/catalogues-web/src/app/(app)/studio/page.tsx"
git commit -m "refactor(catalogues-web): extract isSupportedImageBytes into shared lib

Prep for the catalog-video upload dropzone, which needs the same
file-type sniffing Studio's garment upload already does.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Frontend — "Upload New" tab in the Catalog Video wizard

**Files:**
- Modify: `apps/catalogues-web/src/app/(app)/catalog-video/CatalogVideoWizard.tsx` (whole file — see steps below for exact regions)

**Interfaces:**
- Consumes: `api.post<{ uploadUrl: string; r2Key: string; expiresIn: number }>('/v1/uploads/presign', { contentType, contentLength })`, `api.uploadToR2WithProgress(uploadUrl, file, onProgress, signal?)` (both from `@/lib/api`, unchanged), `isSupportedImageBytes(file)` (from Task 2), `POST /v1/jobs/catalog-video` now accepting `{ sourceImageKey, sampleVideoId }` as an alternative to `{ sourceJobId, sampleVideoId }` (Task 1).
- Produces: no new exports — this is a leaf component.

- [ ] **Step 1: Add the `ImageSource` type and imports**

Replace the top of the file (imports through the `JobThumbnail` component, i.e. lines 1–50) with:

```tsx
'use client';

import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ChevronLeft, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import { C } from '@/components/tokens';
import { GradBtn } from '@/components/ui/grad-btn';
import { Tooltip } from '@/components/ui/tooltip';
import { api } from '@/lib/api';
import { isSupportedImageBytes } from '@/lib/image-validation';

interface CatalogueImageOption {
  jobId: string;
  catalogueId: string;
}

interface SampleVideoOption {
  id: string;
  title: string;
  thumbnailUrl: string;
  previewVideoUrl: string;
}

type CatalogueResponse = Array<{
  catalogueId: string;
  jobs: Array<{ id: string; status: string }>;
}>;

// The two ways a video can be sourced: an existing completed AI Vastra job
// (from the catalogues grid), or a fresh upload of any image the user owns —
// not required to have been generated by AI Vastra at all.
type ImageSource =
  | { kind: 'existing'; jobId: string }
  | { kind: 'upload'; r2Key: string; previewUrl: string };

// `/v1/catalogues` only carries one cover thumbnail per catalogue (correct for
// the catalogue grid, which shows one card per catalogue) — a catalogue with
// several completed pose jobs has no per-job thumbnail there. Fetch each job's
// own thumbnail directly, same as the catalogue detail page's ImageCard, so
// every option in this picker shows its own generated image instead of all
// jobs from one catalogue displaying that catalogue's single cover photo.
function JobThumbnail({ jobId, alt }: { jobId: string; alt: string }): React.ReactElement {
  const { data } = useQuery<{ url: string }>({
    queryKey: ['job-thumb', jobId],
    queryFn: () => api.get(`/v1/jobs/${jobId}/thumbnail`),
    staleTime: 55 * 60 * 1000,
  });

  if (!data?.url) {
    return <span style={{ color: C.mid, fontSize: 12 }}>Image unavailable</span>;
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element
    // biome-ignore lint/performance/noImgElement: presigned R2 URL
    <img src={data.url} alt={alt} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
  );
}

// Click-to-browse or drag-and-drop upload, mirroring Studio's garment upload
// (handleGarmentUpload in apps/(app)/studio/page.tsx): magic-byte validation,
// 10MB soft cap, local blob-URL preview before the network round trip.
function UploadDropzone({
  onFile,
  uploading,
  progress,
  error,
  previewUrl,
}: {
  onFile: (file: File) => void;
  uploading: boolean;
  progress: number;
  error: string | null;
  previewUrl: string | null;
}): React.ReactElement {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  return (
    <div>
      {/* biome-ignore lint/a11y/noStaticElementInteractions: dropzone; the hidden file input below is the accessible activation path */}
      <div
        onClick={() => !uploading && inputRef.current?.click()}
        onDragOver={(event) => {
          event.preventDefault();
          if (!uploading) setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragOver(false);
          const file = event.dataTransfer.files?.[0];
          if (file && !uploading) onFile(file);
        }}
        style={{
          position: 'relative',
          aspectRatio: '3 / 4',
          maxWidth: 220,
          overflow: 'hidden',
          border: `2px dashed ${dragOver ? C.pink : C.border}`,
          borderRadius: 6,
          background: C.lighter,
          cursor: uploading ? 'not-allowed' : 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          style={{ display: 'none' }}
          onChange={(event) => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (file) onFile(file);
          }}
        />
        {previewUrl ? (
          // eslint-disable-next-line @next/next/no-img-element
          // biome-ignore lint/performance/noImgElement: local blob URL preview
          <img
            src={previewUrl}
            alt="Uploaded"
            style={{ width: '100%', height: '100%', objectFit: 'cover' }}
          />
        ) : (
          <div style={{ textAlign: 'center', padding: 16, color: C.mid, fontSize: 12 }}>
            {uploading ? `Uploading… ${progress}%` : 'Click or drag an image here'}
          </div>
        )}
      </div>
      {error && <p style={{ margin: '8px 0 0', color: '#D63B4C', fontSize: 12 }}>{error}</p>}
    </div>
  );
}
```

- [ ] **Step 2: Replace `sourceJobId` state with `source` + upload state**

In the `CatalogVideoWizard` function body, replace:

```tsx
  const qc = useQueryClient();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [sourceJobId, setSourceJobId] = useState<string | null>(null);
  const [sampleVideoId, setSampleVideoId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
```

with:

```tsx
  const qc = useQueryClient();
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [sourceTab, setSourceTab] = useState<'existing' | 'upload'>('existing');
  const [source, setSource] = useState<ImageSource | null>(null);
  const [sampleVideoId, setSampleVideoId] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const uploadAbortRef = useRef<AbortController | null>(null);

  // Revoke the previous upload's blob URL whenever `source` changes away from
  // it (a new upload, switching to an existing-image selection, or unmount) —
  // never the currently active one.
  useEffect(() => {
    return () => {
      if (source?.kind === 'upload') URL.revokeObjectURL(source.previewUrl);
    };
  }, [source]);
```

- [ ] **Step 3: Replace `imageOptions`/`selectedImage` and add `handleUpload`/`handleClose`**

Replace:

```tsx
  const imageOptions: CatalogueImageOption[] = (catalogues ?? []).flatMap((catalogue) =>
    catalogue.jobs
      .filter((job) => job.status === 'COMPLETED')
      .map((job) => ({
        jobId: job.id,
        catalogueId: catalogue.catalogueId,
      })),
  );
  const selectedImage = imageOptions.find((option) => option.jobId === sourceJobId);
  const selectedSample = sampleVideos?.items.find((option) => option.id === sampleVideoId);

  const handleSubmit = async () => {
    if (!sourceJobId || !sampleVideoId || insufficientCredits) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.post('/v1/jobs/catalog-video', { sourceJobId, sampleVideoId });
      await qc.invalidateQueries({ queryKey: ['catalog-videos'] });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start video generation');
    } finally {
      setSubmitting(false);
    }
  };

  const nextDisabled = (step === 1 && !sourceJobId) || (step === 2 && !sampleVideoId) || submitting;
```

with:

```tsx
  const imageOptions: CatalogueImageOption[] = (catalogues ?? []).flatMap((catalogue) =>
    catalogue.jobs
      .filter((job) => job.status === 'COMPLETED')
      .map((job) => ({
        jobId: job.id,
        catalogueId: catalogue.catalogueId,
      })),
  );
  const selectedSample = sampleVideos?.items.find((option) => option.id === sampleVideoId);

  async function handleUpload(file: File) {
    if (uploading) return;
    if (file.size > 10 * 1024 * 1024) {
      setUploadError('File exceeds 10 MB. Please choose a smaller image.');
      return;
    }
    if (!(await isSupportedImageBytes(file))) {
      setUploadError('Unsupported file type. Please upload a JPEG, PNG, or WebP image.');
      return;
    }
    setUploadError(null);
    setUploading(true);
    setUploadProgress(0);
    const abort = new AbortController();
    uploadAbortRef.current = abort;
    const previewUrl = URL.createObjectURL(file);
    try {
      const { uploadUrl, r2Key } = await api.post<{
        uploadUrl: string;
        r2Key: string;
        expiresIn: number;
      }>('/v1/uploads/presign', { contentType: file.type, contentLength: file.size });
      await api.uploadToR2WithProgress(uploadUrl, file, setUploadProgress, abort.signal);
      setSource({ kind: 'upload', r2Key, previewUrl });
    } catch (e) {
      URL.revokeObjectURL(previewUrl);
      if (e instanceof DOMException && e.name === 'AbortError') return;
      const msg = e instanceof Error ? e.message : '';
      setUploadError(
        msg.includes('403')
          ? 'Upload session expired. Please re-upload your image and try again.'
          : `Upload failed: ${msg}`,
      );
    } finally {
      setUploading(false);
    }
  }

  function handleClose() {
    if (submitting) return;
    uploadAbortRef.current?.abort();
    onClose();
  }

  const handleSubmit = async () => {
    if (!source || !sampleVideoId || insufficientCredits) return;
    setSubmitting(true);
    setError(null);
    try {
      await api.post('/v1/jobs/catalog-video', {
        ...(source.kind === 'existing'
          ? { sourceJobId: source.jobId }
          : { sourceImageKey: source.r2Key }),
        sampleVideoId,
      });
      await qc.invalidateQueries({ queryKey: ['catalog-videos'] });
      onCreated();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start video generation');
    } finally {
      setSubmitting(false);
    }
  };

  const nextDisabled =
    (step === 1 && !source) || (step === 2 && !sampleVideoId) || submitting || uploading;
```

- [ ] **Step 4: Wire `handleClose` into the backdrop and X button**

Replace:

```tsx
        onMouseDown={(event) => {
          if (event.target === event.currentTarget && !submitting) onClose();
        }}
```

with:

```tsx
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) handleClose();
        }}
```

and replace the X button's `onClick={onClose}` with `onClick={handleClose}` (keep `disabled={submitting}` as-is).

- [ ] **Step 5: Add the tab toggle and upload tab to step 1**

Replace the `{step === 1 && (...)}` block with:

```tsx
            {step === 1 && (
              <>
                <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
                  {(['existing', 'upload'] as const).map((tab) => (
                    <button
                      key={tab}
                      type="button"
                      aria-pressed={sourceTab === tab}
                      onClick={() => setSourceTab(tab)}
                      style={{
                        padding: '8px 16px',
                        borderRadius: 999,
                        border: `1px solid ${sourceTab === tab ? C.pink : C.border}`,
                        background: sourceTab === tab ? 'rgba(245,92,122,0.08)' : 'transparent',
                        color: sourceTab === tab ? C.pink : C.mid,
                        fontSize: 13,
                        fontWeight: 600,
                        cursor: 'pointer',
                      }}
                    >
                      {tab === 'existing' ? 'My Catalogue Images' : 'Upload New'}
                    </button>
                  ))}
                </div>

                {sourceTab === 'existing' ? (
                  <>
                    <p style={{ margin: '0 0 16px', color: C.mid, fontSize: 13 }}>
                      Choose a completed catalogue image.
                    </p>
                    {cataloguesLoading ? (
                      <p style={{ color: C.mid, fontSize: 13 }}>Loading images...</p>
                    ) : imageOptions.length === 0 ? (
                      <p style={{ color: C.mid, fontSize: 13 }}>
                        No completed catalogue images are available.
                      </p>
                    ) : (
                      <div className="wizard-step1-grid">
                        {imageOptions.map((option) => {
                          const selected = source?.kind === 'existing' && source.jobId === option.jobId;
                          return (
                            <button
                              key={option.jobId}
                              type="button"
                              aria-pressed={selected}
                              onClick={() => setSource({ kind: 'existing', jobId: option.jobId })}
                              style={{
                                position: 'relative',
                                aspectRatio: '3 / 4',
                                overflow: 'hidden',
                                border: selected ? `2px solid ${C.pink}` : `1px solid ${C.border}`,
                                borderRadius: 6,
                                padding: 0,
                                background: C.lighter,
                                cursor: 'pointer',
                              }}
                            >
                              <JobThumbnail jobId={option.jobId} alt="" />
                              {selected && (
                                <span
                                  style={{
                                    position: 'absolute',
                                    top: 8,
                                    right: 8,
                                    width: 22,
                                    height: 22,
                                    borderRadius: 999,
                                    background: C.pink,
                                    color: C.white,
                                    display: 'grid',
                                    placeItems: 'center',
                                  }}
                                >
                                  <Check size={14} />
                                </span>
                              )}
                            </button>
                          );
                        })}
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <p style={{ margin: '0 0 16px', color: C.mid, fontSize: 13 }}>
                      Upload any photo you own — it doesn't need to be an AI Vastra generation.
                    </p>
                    <UploadDropzone
                      onFile={handleUpload}
                      uploading={uploading}
                      progress={uploadProgress}
                      error={uploadError}
                      previewUrl={source?.kind === 'upload' ? source.previewUrl : null}
                    />
                  </>
                )}
              </>
            )}
```

- [ ] **Step 6: Update step 3's preview panel**

Replace:

```tsx
                  <div style={{ aspectRatio: '3 / 4', background: C.lighter }}>
                    {selectedImage && (
                      <JobThumbnail jobId={selectedImage.jobId} alt="Selected catalogue" />
                    )}
                  </div>
                  <div style={{ padding: 10, color: C.mid, fontSize: 12 }}>Catalogue image</div>
```

with:

```tsx
                  <div style={{ aspectRatio: '3 / 4', background: C.lighter }}>
                    {source?.kind === 'existing' && (
                      <JobThumbnail jobId={source.jobId} alt="Selected catalogue" />
                    )}
                    {source?.kind === 'upload' && (
                      // eslint-disable-next-line @next/next/no-img-element
                      // biome-ignore lint/performance/noImgElement: local blob URL preview
                      <img
                        src={source.previewUrl}
                        alt="Selected upload"
                        style={{ width: '100%', height: '100%', objectFit: 'cover' }}
                      />
                    )}
                  </div>
                  <div style={{ padding: 10, color: C.mid, fontSize: 12 }}>
                    {source?.kind === 'upload' ? 'Uploaded image' : 'Catalogue image'}
                  </div>
```

- [ ] **Step 7: Typecheck**

Run: `pnpm --filter @tryme/web exec tsc --noEmit -p .`
Expected: no errors.

- [ ] **Step 8: Lint**

Run: `npx biome check "apps/catalogues-web/src/app/(app)/catalog-video/CatalogVideoWizard.tsx"`
Expected: no errors. Fix any `noStaticElementInteractions`/`noImgElement` complaints by confirming the existing `biome-ignore` comments carried over correctly (they're already present in the code above).

- [ ] **Step 9: Commit**

```bash
git add "apps/catalogues-web/src/app/(app)/catalog-video/CatalogVideoWizard.tsx"
git commit -m "feat(catalogues-web): add upload-your-own-image tab to catalog video wizard

Lets a user animate any photo they own via a new 'Upload New' tab
alongside the existing catalogue-image picker, reusing the same
presign+upload mechanics Studio's garment upload already uses.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Manual verification in browser

**Files:** none (verification only).

- [ ] **Step 1: Start the dev stack**

Run: `pnpm docker:up` (if not already running), then `pnpm --filter @tryme/web dev` and `pnpm --filter @tryme/api dev` in separate terminals (or `pnpm dev` for everything via turbo).

- [ ] **Step 2: Verify the existing-image path still works**

In the browser, open Catalog Video → New Catalog Video. Confirm the "My Catalogue Images" tab is selected by default, the grid shows distinct thumbnails per job (not the duplicate-cover bug from the earlier fix), pick one, proceed through steps 2–3, and confirm the preview in step 3 matches the picked image.

- [ ] **Step 3: Verify the upload path**

Switch to "Upload New". Confirm:
- Click-to-browse and drag-and-drop both work.
- A non-image file (e.g. a `.txt` renamed to `.jpg`) is rejected with the "Unsupported file type" message.
- A valid JPEG/PNG/WebP uploads with a visible progress indicator, then shows as the preview inside the dropzone.
- `Next` is disabled until the upload finishes.
- Proceeding to step 3 shows the uploaded image (not a broken image), labeled "Uploaded image".
- Submitting creates the video job (check the Catalog Videos list afterward) and does **not** create any new entry in Catalogues.

- [ ] **Step 4: Verify abort-on-close**

Start an upload, then close the wizard (X button or backdrop click) before it finishes. Confirm no error is thrown in the console and reopening the wizard starts fresh (no stuck "Uploading…" state).

- [ ] **Step 5: Verify session-expiry error copy**

In the browser devtools, after selecting a file but before the presign call resolves, block or fail the `/v1/uploads/presign` request (e.g. via devtools network throttling → offline, or by temporarily stopping the API) and confirm the dropzone shows the "Upload failed: ..." message without crashing the wizard.

- [ ] **Step 6: Update `docs/progress.md`**

Add a dated entry at the top per this repo's Progress Tracking convention: what was done (upload-your-own-image catalog video source), any follow-ups, and confirmation that manual browser verification passed.
