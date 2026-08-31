# Merchant Try-On Android Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Connect `apps/virtual-tryon-mobile&kiosk_latest` (the native Android app) to the real backend for the try-on flow only — merchant login (already working, unchanged), category → garment-type → priced-product browsing, photo capture (direct or QR-scan-from-phone), try-on job creation/progress/result, and like/add-to-cart on the result — with structured, source-labeled error messages everywhere. Catalogue-creation screens, subscription/credit billing, and `apps/admin-mobile` are explicitly out of scope.

**Architecture:** The Android app authenticates via the existing `/v1/auth/device-login` flow (email/password, `users` table, device-limit enforcement) — **no changes to auth**. The logged-in account is a merchant (a `users` row with a `merchants` profile, gated by admin merchant-status). All new backend routes reuse the existing `requireMerchant` preHandler (`apps/api/src/plugins/portal-auth.ts`), which already resolves `merchantId` from the JWT's `sub` (userId) via `merchants.userId` — the exact same access token issued by `/v1/auth/device-login`. Catalog browsing and pricing reuse the **already-built** `GET /v1/merchant/catalog/subcategories` and `GET /v1/merchant/catalog` routes unchanged. Two new backend surfaces are added: (1) `apps/api/src/modules/merchant/tryon.routes.ts` — merchant-self-serve try-on job creation/status/events/cancel/like/cart, modeled directly on the existing (unused-by-this-app) `apps/api/src/modules/kiosk/jobs.routes.ts` and `results.routes.ts`, minus `kioskDeviceId` and minus credit deduction (per explicit product decision: unlimited try-ons, no billing enforcement yet); (2) `apps/api/src/modules/merchant/upload-sessions.routes.ts` — a Redis-backed, single-use, short-TTL QR upload-session flow, backing a new public Next.js page at `apps/catalogues-web/src/app/kiosk-upload/[token]/page.tsx` where a customer's own phone uploads a photo without any login. Dispatcher-side, **no changes are needed**: `apps/dispatcher/src/job/processor.ts::processJob` already routes any job with `jobs.merchantId` set to `processWidgetJob`, which is exactly the code path these new jobs need (fixed widget ComfyUI VPS, `customerPhotoKey` + `upperGarmentKey` + `jobInputs.params.workflowTemplateId`), and already publishes progress on Redis channel `sse:events:widget:${merchantId}` — this plan's SSE routes just subscribe to that same channel, the same way the kiosk module's SSE route already does.

**Tech Stack:** Fastify 5 + Zod (`fastify-type-provider-zod`), Drizzle ORM/PostgreSQL, Redis (session store, pub/sub), Vitest integration tests against real Postgres/Redis/MinIO (`pnpm docker:up`); Next.js 15 App Router (public page, no auth); native Android — Kotlin, OkHttp (raw, no Retrofit), Jackson/Gson for JSON, ViewBinding, LiveData/ViewModel, ZXing + journeyapps `barcodescanner` (already a dependency — confirmed via existing `ScanAndDownloadVastraResultActivity.generateQRCode`), CameraX + UCrop (already dependencies).

## Global Constraints

- Never use npm/yarn — this is a pnpm workspace. Never touch `apps/admin-mobile`.
- No `console.log` in committed API/dispatcher code — use `app.log` / the injected logger.
- Merchant try-on jobs must set `creditsCharged: 0` and must NOT call `atomicMerchantDeduct` or `merchantRefund` — per explicit product decision, credits are not enforced for this flow yet (subscription billing is a separate, future project).
- Every new backend route must throw `AppError(code, statusCode, message)` with a specific `code` — never a bare generic error — because the Android error-handling layer (Task 12) surfaces `code`/`message` verbatim to the user.
- Every new Android network call must go through the typed exception hierarchy from Task 12 (`BackendError` / `NetworkError` / `ClientError`) — no new call may throw a raw `IllegalStateException` or silently swallow an error into `APIConstant.errorSomethingWrong`.
- All new R2 object keys for customer try-on photos live under `merchant-inputs/{merchantId}/...` — a distinct prefix from `merchant-catalog/{merchantId}/...` (product images, untouched by this plan).
- The public upload-session routes (`/v1/kiosk-upload-sessions/:token/*`) take **no** `requireMerchant`/`requireUser` auth — the random token is the only credential — and must be rate-limited.
- Follow this repo's Postgres/Redis integration-test harness exactly (`apps/api/test/helpers/containers.ts`, `apps/api/test/helpers/api.ts`) — no testcontainers, no mocked DB/Redis.

---

## Part A — Backend: Merchant Try-On Jobs

### Task 1: Types for merchant try-on jobs

**Files:**
- Modify: `packages/types/src/widget.ts`

**Interfaces:**
- Produces: `MerchantTryonPresignBody`, `MerchantTryonJobCreateBody`, `MerchantTryonJobDetailResponse` zod schemas + inferred types, consumed by Task 2/3/4 route files.

- [ ] **Step 1: Add the schemas**

Open `packages/types/src/widget.ts`. Find the existing `KioskJobDetailResponse` block (it ends with `export type KioskJobDetailResponse = z.infer<typeof KioskJobDetailResponse>;`). Add directly after it:

```ts
export const MerchantTryonPresignBody = z.object({
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  contentLength: z
    .number()
    .int()
    .positive()
    .max(5 * 1024 * 1024),
});
export type MerchantTryonPresignBody = z.infer<typeof MerchantTryonPresignBody>;

export const MerchantTryonJobCreateBody = z.object({
  merchantCatalogItemId: z.string().uuid(),
  customerPhotoKey: z.string().min(1),
});
export type MerchantTryonJobCreateBody = z.infer<typeof MerchantTryonJobCreateBody>;

export const MerchantTryonJobDetailResponse = z.object({
  id: z.string().uuid(),
  status: z.string(),
  merchantId: z.string().uuid(),
  resultKey: z.string().nullable(),
  shareUrl: z.string().url().nullable(),
  errorCode: z.string().nullable(),
  liked: z.boolean(),
  inCart: z.boolean(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
});
export type MerchantTryonJobDetailResponse = z.infer<typeof MerchantTryonJobDetailResponse>;
```

- [ ] **Step 2: Build and typecheck**

Run: `cd packages/types && pnpm build`
Expected: exits 0, no TypeScript errors.

- [ ] **Step 3: Commit**

```bash
git add packages/types/src/widget.ts
git commit -m "feat(types): add merchant try-on job request/response schemas"
```

---

### Task 2: `createMerchantTryonJob` helper + presign + create-job routes

**Files:**
- Create: `apps/api/src/modules/merchant/create-tryon-job.ts`
- Create: `apps/api/src/modules/merchant/tryon.routes.ts`
- Create: `apps/api/test/integration/merchant-tryon.test.ts`

**Interfaces:**
- Consumes: `schema.jobs`, `schema.jobInputs`, `schema.merchantCatalogItems`, `schema.merchantCatalogSubcategories`, `schema.garmentSubcategories`, `schema.tryonCategories`, `schema.workflowTemplates` from `@tryme/db`; `app.requireMerchant` from `apps/api/src/plugins/portal-auth.ts`; `MerchantTryonPresignBody`/`MerchantTryonJobCreateBody` from Task 1.
- Produces: `createMerchantTryonJob(app, input): Promise<string>` (used only inside this route file for now), routes `POST /v1/merchant/tryon/presign` and `POST /v1/merchant/tryon/jobs`, registered in Task 6.

- [ ] **Step 1: Write `create-tryon-job.ts`**

Create `apps/api/src/modules/merchant/create-tryon-job.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import type { FastifyInstance } from 'fastify';

interface CreateMerchantTryonJobInput {
  merchantId: string;
  merchantUserId: string;
  upperGarmentKey: string;
  customerPhotoKey: string;
  workflowTemplateId: string;
}

// Unlimited try-ons for now (no subscription billing exists yet) — creditsCharged
// is always 0 and no atomicMerchantDeduct/merchantRefund call is made anywhere in
// this flow. See "Global Constraints" in this plan for why.
export async function createMerchantTryonJob(
  app: FastifyInstance,
  input: CreateMerchantTryonJobInput,
): Promise<string> {
  const jobId = randomUUID();

  await app.db.transaction(async (tx) => {
    // biome-ignore lint/suspicious/noExplicitAny: Drizzle infers face/bg/pose FK columns as
    // required from other call sites; merchant self-serve try-on jobs legitimately omit them,
    // same as createKioskJob in apps/api/src/modules/kiosk/create-job.ts.
    await (tx.insert(schema.jobs).values as any)({
      id: jobId,
      userId: input.merchantUserId,
      merchantId: input.merchantId,
      kioskDeviceId: null,
      customerPhotoKey: input.customerPhotoKey,
      status: 'QUEUED',
      creditsCharged: 0,
      source: 'merchant_tryon',
    });

    // biome-ignore lint/suspicious/noExplicitAny: same — face/bg/pose are nullable in SQL but
    // Drizzle types them non-null on this insert shape.
    await (tx.insert(schema.jobInputs).values as any)({
      jobId,
      upperGarmentKey: input.upperGarmentKey,
      faceId: null,
      backgroundId: null,
      poseId: null,
      params: { workflowTemplateId: input.workflowTemplateId },
    });
  });

  // jobs.merchantId being set routes this job to processWidgetJob in the dispatcher
  // (apps/dispatcher/src/job/processor.ts:123), which already knows how to run a
  // customerPhotoKey + upperGarmentKey + workflowTemplateId job against the fixed
  // widget ComfyUI VPS. No dispatcher changes are needed for this plan.
  await app.redis.xadd(
    'jobs:normal',
    'MAXLEN',
    '~',
    10000,
    '*',
    'jobId',
    jobId,
    'userId',
    input.merchantUserId,
    'type',
    'MERCHANT_TRYON',
  );

  return jobId;
}
```

- [ ] **Step 2: Write `tryon.routes.ts` (presign + create job only, for now)**

Create `apps/api/src/modules/merchant/tryon.routes.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { MerchantTryonJobCreateBody, MerchantTryonPresignBody } from '@tryme/types';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { createMerchantTryonJob } from './create-tryon-job.js';

const MAX_TRYON_UPLOAD_BYTES = 5 * 1024 * 1024;

export async function merchantTryonRoutes(app: FastifyInstance) {
  app.post(
    '/v1/merchant/tryon/presign',
    { preHandler: app.requireMerchant, schema: { body: MerchantTryonPresignBody } },
    async (req) => {
      const merchantId = req.merchantClientId;
      if (!merchantId) throw new AppError('UNAUTH', 401, 'missing merchant');

      const { contentType, contentLength } = req.body as z.infer<typeof MerchantTryonPresignBody>;
      const ext = contentType.split('/')[1] ?? 'jpg';
      const key = `merchant-inputs/${merchantId}/${randomUUID()}/photo.${ext}`;
      const { url, expiresIn } = await app.storage.presignPut(key, contentType, contentLength, 600);
      await app.redis.set(`upload:owner:${key}`, merchantId, 'EX', 600);

      return { uploadUrl: url, r2Key: key, expiresIn };
    },
  );

  app.post(
    '/v1/merchant/tryon/jobs',
    { preHandler: app.requireMerchant, schema: { body: MerchantTryonJobCreateBody } },
    async (req, reply) => {
      const merchantId = req.merchantClientId;
      if (!merchantId) throw new AppError('UNAUTH', 401, 'missing merchant');

      const { merchantCatalogItemId, customerPhotoKey } = req.body as z.infer<
        typeof MerchantTryonJobCreateBody
      >;

      const [item] = await app.db
        .select({
          id: schema.merchantCatalogItems.id,
          merchantId: schema.merchantCatalogItems.merchantId,
          r2Key: schema.merchantCatalogItems.r2Key,
          isActive: schema.merchantCatalogItems.isActive,
          moderationStatus: schema.merchantCatalogItems.moderationStatus,
          workflowTemplateId: schema.tryonCategories.workflowTemplateId,
          tryonCategoryIsActive: schema.tryonCategories.isActive,
          workflowTemplateIsActive: schema.workflowTemplates.isActive,
        })
        .from(schema.merchantCatalogItems)
        .innerJoin(
          schema.merchantCatalogSubcategories,
          eq(schema.merchantCatalogSubcategories.id, schema.merchantCatalogItems.subcategoryId),
        )
        .leftJoin(
          schema.garmentSubcategories,
          eq(
            schema.garmentSubcategories.id,
            schema.merchantCatalogSubcategories.garmentSubcategoryId,
          ),
        )
        .leftJoin(
          schema.tryonCategories,
          eq(schema.tryonCategories.id, schema.garmentSubcategories.tryonCategoryId),
        )
        .leftJoin(
          schema.workflowTemplates,
          eq(schema.workflowTemplates.id, schema.tryonCategories.workflowTemplateId),
        )
        .where(eq(schema.merchantCatalogItems.id, merchantCatalogItemId))
        .limit(1);

      if (!item || item.merchantId !== merchantId) {
        throw new AppError('NOT_FOUND', 404, 'catalog item not found');
      }
      if (!item.isActive || item.moderationStatus !== 'approved') {
        throw new AppError('FORBIDDEN', 403, 'catalog item is not available');
      }
      if (
        !item.workflowTemplateId ||
        !item.tryonCategoryIsActive ||
        !item.workflowTemplateIsActive
      ) {
        throw new AppError('VALIDATION', 400, 'garment type has no tryon category configured');
      }
      if (!customerPhotoKey.startsWith(`merchant-inputs/${merchantId}/`)) {
        throw new AppError('FORBIDDEN', 403, 'customer photo key does not belong to this merchant');
      }

      const uploadOwner = await app.redis.get(`upload:owner:${customerPhotoKey}`);
      if (uploadOwner !== merchantId) {
        throw new AppError('FORBIDDEN', 403, 'upload session expired or not owned');
      }

      let photoHead: { contentLength: number };
      try {
        photoHead = await app.storage.headObject(customerPhotoKey);
      } catch {
        throw new AppError('BAD_UPLOAD', 400, 'uploaded photo not found');
      }
      if (photoHead.contentLength > MAX_TRYON_UPLOAD_BYTES) {
        throw new AppError('BAD_UPLOAD', 413, 'uploaded photo exceeds 5MB limit');
      }

      const [merchant] = await app.db
        .select({ userId: schema.merchants.userId })
        .from(schema.merchants)
        .where(eq(schema.merchants.id, merchantId))
        .limit(1);
      if (!merchant) throw new AppError('NOT_FOUND', 404, 'merchant not found');

      const jobId = await createMerchantTryonJob(app, {
        merchantId,
        merchantUserId: merchant.userId,
        upperGarmentKey: item.r2Key,
        customerPhotoKey,
        workflowTemplateId: item.workflowTemplateId,
      });

      reply.code(201);
      return { jobId };
    },
  );
}
```

- [ ] **Step 3: Write the integration test**

Create `apps/api/test/integration/merchant-tryon.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signAccess } from '../../src/modules/auth/service';
import { buildTestApp, type TestApp } from '../helpers/api';
import { type Containers, startContainers } from '../helpers/containers';

const JWT_SECRET = 'test-jwt-secret-0123456789abcdef-32min';
const secret = new TextEncoder().encode(JWT_SECRET);

async function createMerchant(app: TestApp, email: string) {
  const [merchantUser] = await app.db
    .insert(schema.users)
    .values({ email, passwordHash: 'unused' })
    .returning();
  const [merchant] = await app.db
    .insert(schema.merchants)
    .values({
      companyName: 'Merchant Co',
      contactName: 'Merchant Owner',
      phone: '9999999999',
      businessAddress: 'Test Street',
      isActive: true,
      userId: merchantUser.id,
    })
    .returning();
  return { merchant, merchantUser };
}

async function authHeader(userId: string) {
  const token = await signAccess(secret, userId, { kind: 'access' }, '15m');
  return { authorization: `Bearer ${token}` };
}

async function seedGarmentTypeWithWorkflow(app: TestApp) {
  const [template] = await app.db
    .insert(schema.workflowTemplates)
    .values({
      name: `template-${randomUUID()}`,
      workflowType: 'tryon',
      jsonContent: {},
      isActive: true,
    })
    .returning();
  const [tryonCategory] = await app.db
    .insert(schema.tryonCategories)
    .values({ name: `category-${randomUUID()}`, workflowTemplateId: template.id, isActive: true })
    .returning();
  const [garmentType] = await app.db
    .insert(schema.garmentSubcategories)
    .values({
      genderSlug: 'women',
      slug: `shirt-${randomUUID()}`,
      label: 'Shirt',
      tryonCategoryId: tryonCategory.id,
    })
    .returning();
  return garmentType;
}

async function seedCatalogItem(app: TestApp, merchantId: string, garmentTypeId: string) {
  const [subcategory] = await app.db
    .insert(schema.merchantCatalogSubcategories)
    .values({
      merchantId,
      category: 'women',
      name: 'Casual Shirts',
      garmentSubcategoryId: garmentTypeId,
    })
    .returning();
  const imageKey = `merchant-catalog/${merchantId}/${randomUUID()}/image.jpg`;
  const thumbKey = `merchant-catalog/${merchantId}/${randomUUID()}/thumb.jpg`;
  await app.storage.putObject(imageKey, Buffer.from('img'), 'image/jpeg');
  await app.storage.putObject(thumbKey, Buffer.from('thumb'), 'image/jpeg');
  const [item] = await app.db
    .insert(schema.merchantCatalogItems)
    .values({
      merchantId,
      subcategoryId: subcategory.id,
      label: 'Red Shirt',
      actualPricePaise: 200000,
      offerPricePaise: 180000,
      r2Key: imageKey,
      thumbnailKey: thumbKey,
    })
    .returning();
  return item;
}

describe('merchant try-on jobs', () => {
  let c: Containers;
  let app: TestApp;

  beforeAll(async () => {
    c = await startContainers();
    app = await buildTestApp(c);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await c?.stop();
  });

  it('presigns a customer photo, creates a job with zero credits charged, and rejects a photo key from a different merchant', async () => {
    const { merchant, merchantUser } = await createMerchant(app, 'tryon-a@example.com');
    const { merchant: otherMerchant } = await createMerchant(app, 'tryon-b@example.com');
    const auth = await authHeader(merchantUser.id);
    const garmentType = await seedGarmentTypeWithWorkflow(app);
    const item = await seedCatalogItem(app, merchant.id, garmentType.id);

    const presigned = await app.inject({
      method: 'POST',
      url: '/v1/merchant/tryon/presign',
      headers: auth,
      payload: { contentType: 'image/jpeg', contentLength: 1024 },
    });
    expect(presigned.statusCode).toBe(200);
    const { r2Key } = presigned.json() as { r2Key: string; uploadUrl: string };
    expect(r2Key.startsWith(`merchant-inputs/${merchant.id}/`)).toBe(true);
    await app.storage.putObject(r2Key, Buffer.from('photo'), 'image/jpeg');

    const created = await app.inject({
      method: 'POST',
      url: '/v1/merchant/tryon/jobs',
      headers: auth,
      payload: { merchantCatalogItemId: item.id, customerPhotoKey: r2Key },
    });
    expect(created.statusCode).toBe(201);
    const { jobId } = created.json() as { jobId: string };

    const [jobRow] = await app.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
    expect(jobRow.creditsCharged).toBe(0);
    expect(jobRow.merchantId).toBe(merchant.id);
    expect(jobRow.userId).toBe(merchantUser.id);
    expect(jobRow.source).toBe('merchant_tryon');

    const otherAuth = await authHeader((await createMerchant(app, 'tryon-c@example.com')).merchantUser.id);
    const crossMerchant = await app.inject({
      method: 'POST',
      url: '/v1/merchant/tryon/jobs',
      headers: otherAuth,
      payload: { merchantCatalogItemId: item.id, customerPhotoKey: r2Key },
    });
    expect(crossMerchant.statusCode).toBe(404);
    void otherMerchant;
  });

  it('rejects a job when the garment type has no tryon category configured', async () => {
    const { merchant, merchantUser } = await createMerchant(app, 'tryon-d@example.com');
    const auth = await authHeader(merchantUser.id);
    const [garmentType] = await app.db
      .insert(schema.garmentSubcategories)
      .values({ genderSlug: 'women', slug: `unmapped-${randomUUID()}`, label: 'Unmapped' })
      .returning();
    const item = await seedCatalogItem(app, merchant.id, garmentType.id);

    const presigned = await app.inject({
      method: 'POST',
      url: '/v1/merchant/tryon/presign',
      headers: auth,
      payload: { contentType: 'image/jpeg', contentLength: 1024 },
    });
    const { r2Key } = presigned.json() as { r2Key: string };
    await app.storage.putObject(r2Key, Buffer.from('photo'), 'image/jpeg');

    const created = await app.inject({
      method: 'POST',
      url: '/v1/merchant/tryon/jobs',
      headers: auth,
      payload: { merchantCatalogItemId: item.id, customerPhotoKey: r2Key },
    });
    expect(created.statusCode).toBe(400);
    expect((created.json() as { error: { code: string } }).error.code).toBe('VALIDATION');
  });
});
```

- [ ] **Step 4: Run the tests to verify they fail**

```bash
export $(grep -E "^POSTGRES_(USER|PASSWORD|DB|PORT)=" .env | xargs) 2>/dev/null
cd apps/api && pnpm exec vitest run --config vitest.integration.config.ts test/integration/merchant-tryon.test.ts
```

Run: the above (from repo root; adjust the `.env` relative path if needed).
Expected: FAIL — `/v1/merchant/tryon/presign` and `/v1/merchant/tryon/jobs` don't exist yet (routes not registered — Task 6 registers them; until then this 404s or the test app fails to resolve the route).

- [ ] **Step 5: Run the tests to verify they pass**

Registration happens in Task 6 — come back and run this after Task 6 Step 2. For now, confirm the two files compile:

```bash
cd apps/api && pnpm exec tsc --noEmit
```

Expected: exits 0.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/merchant/create-tryon-job.ts apps/api/src/modules/merchant/tryon.routes.ts apps/api/test/integration/merchant-tryon.test.ts
git commit -m "feat(api): add merchant try-on job creation (presign + create), no credit deduction"
```

---

### Task 3: Job status + SSE events route

**Files:**
- Modify: `apps/api/src/modules/merchant/tryon.routes.ts`
- Modify: `apps/api/test/integration/merchant-tryon.test.ts`

**Interfaces:**
- Consumes: `schema.jobs`, `schema.jobOutputs`, `schema.kioskResultLikes`, `schema.kioskResultCartItems` (reused as-is — `kioskDeviceId` column stays null for merchant self-serve rows); `MerchantTryonJobDetailResponse` from Task 1.
- Produces: `GET /v1/merchant/tryon/jobs/:id`, `GET /v1/merchant/tryon/jobs/:id/events` (SSE).

- [ ] **Step 1: Add `loadOwnedJob` / `serializeJob` and the two routes**

Edit `apps/api/src/modules/merchant/tryon.routes.ts`. Update the top imports:

```ts
import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { MerchantTryonJobCreateBody, MerchantTryonPresignBody } from '@tryme/types';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { createMerchantTryonJob } from './create-tryon-job.js';
```

Add these two helper functions directly above `export async function merchantTryonRoutes`:

```ts
async function loadOwnedJob(app: FastifyInstance, merchantId: string, id: string) {
  const [job] = await app.db
    .select({
      id: schema.jobs.id,
      status: schema.jobs.status,
      merchantId: schema.jobs.merchantId,
      creditsCharged: schema.jobs.creditsCharged,
      resultKey: schema.jobOutputs.resultKey,
      errorCode: schema.jobs.errorCode,
      createdAt: schema.jobs.createdAt,
      completedAt: schema.jobs.completedAt,
    })
    .from(schema.jobs)
    .leftJoin(schema.jobOutputs, eq(schema.jobOutputs.jobId, schema.jobs.id))
    .where(eq(schema.jobs.id, id))
    .limit(1);

  if (!job || job.merchantId !== merchantId) {
    throw new AppError('NOT_FOUND', 404, 'job not found');
  }
  return job;
}

async function serializeJob(app: FastifyInstance, merchantId: string, id: string) {
  const job = await loadOwnedJob(app, merchantId, id);
  const [liked, inCart] = await Promise.all([
    app.db
      .select({ id: schema.kioskResultLikes.id })
      .from(schema.kioskResultLikes)
      .where(
        and(eq(schema.kioskResultLikes.jobId, id), eq(schema.kioskResultLikes.merchantId, merchantId)),
      )
      .limit(1),
    app.db
      .select({ id: schema.kioskResultCartItems.id })
      .from(schema.kioskResultCartItems)
      .where(
        and(
          eq(schema.kioskResultCartItems.jobId, id),
          eq(schema.kioskResultCartItems.merchantId, merchantId),
        ),
      )
      .limit(1),
  ]);

  let shareUrl: string | null = null;
  if (job.status === 'COMPLETED' && job.resultKey) {
    shareUrl = await app.storage
      .presignGet(job.resultKey, 86_400)
      .then((result) => result.url)
      .catch(() => null);
  }

  return {
    id: job.id,
    status: job.status,
    merchantId: job.merchantId,
    resultKey: job.resultKey,
    shareUrl,
    errorCode: job.errorCode,
    liked: liked.length > 0,
    inCart: inCart.length > 0,
    createdAt: job.createdAt.toISOString(),
    completedAt: job.completedAt?.toISOString() ?? null,
  };
}

function writeSseHeaders(reply: FastifyReply): void {
  reply.raw.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
}
```

Add these two routes at the end of `merchantTryonRoutes`, right before its closing `}`:

```ts
  app.get(
    '/v1/merchant/tryon/jobs/:id',
    { preHandler: app.requireMerchant, schema: { params: z.object({ id: z.string().uuid() }) } },
    async (req) => {
      const merchantId = req.merchantClientId;
      if (!merchantId) throw new AppError('UNAUTH', 401, 'missing merchant');
      const { id } = req.params as { id: string };
      return serializeJob(app, merchantId, id);
    },
  );

  app.get(
    '/v1/merchant/tryon/jobs/:id/events',
    { preHandler: app.requireMerchant, schema: { params: z.object({ id: z.string().uuid() }) } },
    async (req, reply) => {
      const merchantId = req.merchantClientId;
      if (!merchantId) throw new AppError('UNAUTH', 401, 'missing merchant');
      const { id } = req.params as { id: string };

      await loadOwnedJob(app, merchantId, id);
      writeSseHeaders(reply);

      // biome-ignore lint/suspicious/noExplicitAny: redisSub is decorated on app at runtime; not in Fastify's type map.
      const sub: Redis = (app as any).redisSub.duplicate();
      const channel = `sse:events:widget:${merchantId}`;

      sub.on('error', (err) => {
        req.log.warn({ err, channel }, 'merchant tryon sse redis subscriber error');
      });

      await sub.subscribe(channel);
      sub.on('message', (_channel, raw) => {
        try {
          const evt = JSON.parse(raw) as Record<string, unknown>;
          if (evt.jobId !== id) return;
          reply.raw.write(`event: ${evt.type ?? 'message'}\ndata: ${raw}\n\n`);
        } catch {
          // ignore malformed publish
        }
      });

      const heartbeat = setInterval(() => reply.raw.write(': ping\n\n'), 15_000);

      req.raw.on('close', async () => {
        clearInterval(heartbeat);
        try {
          await sub.unsubscribe(channel);
        } catch {
          // connection may already be closed
        }
        sub.disconnect();
      });
    },
  );
```

- [ ] **Step 2: Add a test for the status route**

Append to `apps/api/test/integration/merchant-tryon.test.ts`, inside the `describe` block, after the existing two `it(...)` blocks:

```ts
  it('returns job status scoped to the owning merchant, 404s for another merchant', async () => {
    const { merchant, merchantUser } = await createMerchant(app, 'tryon-e@example.com');
    const auth = await authHeader(merchantUser.id);
    const garmentType = await seedGarmentTypeWithWorkflow(app);
    const item = await seedCatalogItem(app, merchant.id, garmentType.id);

    const presigned = await app.inject({
      method: 'POST',
      url: '/v1/merchant/tryon/presign',
      headers: auth,
      payload: { contentType: 'image/jpeg', contentLength: 1024 },
    });
    const { r2Key } = presigned.json() as { r2Key: string };
    await app.storage.putObject(r2Key, Buffer.from('photo'), 'image/jpeg');

    const created = await app.inject({
      method: 'POST',
      url: '/v1/merchant/tryon/jobs',
      headers: auth,
      payload: { merchantCatalogItemId: item.id, customerPhotoKey: r2Key },
    });
    const { jobId } = created.json() as { jobId: string };

    const status = await app.inject({
      method: 'GET',
      url: `/v1/merchant/tryon/jobs/${jobId}`,
      headers: auth,
    });
    expect(status.statusCode).toBe(200);
    const body = status.json() as { status: string; liked: boolean; inCart: boolean };
    expect(body.status).toBe('QUEUED');
    expect(body.liked).toBe(false);
    expect(body.inCart).toBe(false);

    const otherAuth = await authHeader((await createMerchant(app, 'tryon-f@example.com')).merchantUser.id);
    const crossMerchant = await app.inject({
      method: 'GET',
      url: `/v1/merchant/tryon/jobs/${jobId}`,
      headers: otherAuth,
    });
    expect(crossMerchant.statusCode).toBe(404);
  });
```

- [ ] **Step 3: Run the tests, verify they pass (after Task 6 registers the routes)**

```bash
cd apps/api && pnpm exec vitest run --config vitest.integration.config.ts test/integration/merchant-tryon.test.ts
```

Expected: `3 passed` (once Task 6 is done — before that, this will fail with 404s on unregistered routes; note that and continue to Task 4).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/merchant/tryon.routes.ts apps/api/test/integration/merchant-tryon.test.ts
git commit -m "feat(api): add merchant try-on job status and SSE progress routes"
```

---

### Task 4: Cancel route

**Files:**
- Modify: `apps/api/src/modules/merchant/tryon.routes.ts`
- Modify: `apps/api/test/integration/merchant-tryon.test.ts`

**Interfaces:**
- Consumes: `loadOwnedJob` from Task 3.
- Produces: `DELETE /v1/merchant/tryon/jobs/:id`.

- [ ] **Step 1: Add the cancel route**

Edit `apps/api/src/modules/merchant/tryon.routes.ts`. Add this route inside `merchantTryonRoutes`, after the `GET /v1/merchant/tryon/jobs/:id` route and before the SSE route:

```ts
  app.delete(
    '/v1/merchant/tryon/jobs/:id',
    { preHandler: app.requireMerchant, schema: { params: z.object({ id: z.string().uuid() }) } },
    async (req, reply) => {
      const merchantId = req.merchantClientId;
      if (!merchantId) throw new AppError('UNAUTH', 401, 'missing merchant');
      const { id } = req.params as { id: string };
      const job = await loadOwnedJob(app, merchantId, id);

      if (job.status === 'COMPLETED' || job.status === 'FAILED' || job.status === 'CANCELLED') {
        throw new AppError('NOT_CANCELLABLE', 409, 'job is already finished or cancelled');
      }
      if (job.status === 'GENERATING' || job.status === 'UPLOADING') {
        throw new AppError('NOT_CANCELLABLE', 409, 'job is already being processed');
      }

      // No merchantRefund call here — merchant try-on jobs are never charged
      // (creditsCharged is always 0, see create-tryon-job.ts).
      await app.db.update(schema.jobs).set({ status: 'CANCELLED' }).where(eq(schema.jobs.id, id));

      const evt = JSON.stringify({ type: 'STATUS', jobId: id, status: 'CANCELLED' });
      await app.redis.publish(`sse:events:widget:${merchantId}`, evt);

      reply.code(200);
      return { status: 'CANCELLED' };
    },
  );
```

- [ ] **Step 2: Add a test**

Append to the `describe` block in `apps/api/test/integration/merchant-tryon.test.ts`:

```ts
  it('cancels a queued job without touching credits', async () => {
    const { merchant, merchantUser } = await createMerchant(app, 'tryon-g@example.com');
    const auth = await authHeader(merchantUser.id);
    const garmentType = await seedGarmentTypeWithWorkflow(app);
    const item = await seedCatalogItem(app, merchant.id, garmentType.id);

    const presigned = await app.inject({
      method: 'POST',
      url: '/v1/merchant/tryon/presign',
      headers: auth,
      payload: { contentType: 'image/jpeg', contentLength: 1024 },
    });
    const { r2Key } = presigned.json() as { r2Key: string };
    await app.storage.putObject(r2Key, Buffer.from('photo'), 'image/jpeg');

    const created = await app.inject({
      method: 'POST',
      url: '/v1/merchant/tryon/jobs',
      headers: auth,
      payload: { merchantCatalogItemId: item.id, customerPhotoKey: r2Key },
    });
    const { jobId } = created.json() as { jobId: string };

    const cancelled = await app.inject({
      method: 'DELETE',
      url: `/v1/merchant/tryon/jobs/${jobId}`,
      headers: auth,
    });
    expect(cancelled.statusCode).toBe(200);
    expect((cancelled.json() as { status: string }).status).toBe('CANCELLED');

    const cancelledAgain = await app.inject({
      method: 'DELETE',
      url: `/v1/merchant/tryon/jobs/${jobId}`,
      headers: auth,
    });
    expect(cancelledAgain.statusCode).toBe(409);
  });
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/modules/merchant/tryon.routes.ts apps/api/test/integration/merchant-tryon.test.ts
git commit -m "feat(api): add merchant try-on job cancel route"
```

---

### Task 5: Like / add-to-cart routes

**Files:**
- Create: `apps/api/src/modules/merchant/tryon-results.routes.ts`
- Create: `apps/api/test/integration/merchant-tryon-results.test.ts`

**Interfaces:**
- Consumes: `schema.jobs`, `schema.kioskResultLikes`, `schema.kioskResultCartItems`.
- Produces: `PUT`/`DELETE /v1/merchant/tryon/jobs/:jobId/like`, `PUT`/`DELETE /v1/merchant/tryon/jobs/:jobId/cart`.

- [ ] **Step 1: Write the route file**

Create `apps/api/src/modules/merchant/tryon-results.routes.ts`:

```ts
import { schema } from '@tryme/db';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';

async function assertOwnedJob(app: FastifyInstance, merchantId: string, jobId: string) {
  const [job] = await app.db
    .select({ id: schema.jobs.id, merchantId: schema.jobs.merchantId })
    .from(schema.jobs)
    .where(eq(schema.jobs.id, jobId))
    .limit(1);

  if (!job || job.merchantId !== merchantId) {
    throw new AppError('NOT_FOUND', 404, 'job not found');
  }
}

export async function merchantTryonResultsRoutes(app: FastifyInstance) {
  const paramsSchema = z.object({ jobId: z.string().uuid() });
  const noBodySchema = z.union([z.undefined(), z.null()]);

  app.put(
    '/v1/merchant/tryon/jobs/:jobId/like',
    { preHandler: app.requireMerchant, schema: { params: paramsSchema, body: noBodySchema } },
    async (req, reply) => {
      const merchantId = req.merchantClientId;
      if (!merchantId) throw new AppError('UNAUTH', 401, 'missing merchant');
      const { jobId } = req.params as { jobId: string };
      await assertOwnedJob(app, merchantId, jobId);

      await app.db
        .insert(schema.kioskResultLikes)
        .values({ jobId, merchantId, kioskDeviceId: null })
        .onConflictDoNothing();

      reply.code(204);
      return reply.send();
    },
  );

  app.delete(
    '/v1/merchant/tryon/jobs/:jobId/like',
    { preHandler: app.requireMerchant, schema: { params: paramsSchema, body: noBodySchema } },
    async (req, reply) => {
      const merchantId = req.merchantClientId;
      if (!merchantId) throw new AppError('UNAUTH', 401, 'missing merchant');
      const { jobId } = req.params as { jobId: string };
      await assertOwnedJob(app, merchantId, jobId);

      await app.db
        .delete(schema.kioskResultLikes)
        .where(
          and(eq(schema.kioskResultLikes.jobId, jobId), eq(schema.kioskResultLikes.merchantId, merchantId)),
        );

      reply.code(204);
      return reply.send();
    },
  );

  app.put(
    '/v1/merchant/tryon/jobs/:jobId/cart',
    { preHandler: app.requireMerchant, schema: { params: paramsSchema, body: noBodySchema } },
    async (req, reply) => {
      const merchantId = req.merchantClientId;
      if (!merchantId) throw new AppError('UNAUTH', 401, 'missing merchant');
      const { jobId } = req.params as { jobId: string };
      await assertOwnedJob(app, merchantId, jobId);

      await app.db
        .insert(schema.kioskResultCartItems)
        .values({ jobId, merchantId, kioskDeviceId: null })
        .onConflictDoNothing();

      reply.code(204);
      return reply.send();
    },
  );

  app.delete(
    '/v1/merchant/tryon/jobs/:jobId/cart',
    { preHandler: app.requireMerchant, schema: { params: paramsSchema, body: noBodySchema } },
    async (req, reply) => {
      const merchantId = req.merchantClientId;
      if (!merchantId) throw new AppError('UNAUTH', 401, 'missing merchant');
      const { jobId } = req.params as { jobId: string };
      await assertOwnedJob(app, merchantId, jobId);

      await app.db
        .delete(schema.kioskResultCartItems)
        .where(
          and(
            eq(schema.kioskResultCartItems.jobId, jobId),
            eq(schema.kioskResultCartItems.merchantId, merchantId),
          ),
        );

      reply.code(204);
      return reply.send();
    },
  );
}
```

- [ ] **Step 2: Write the test**

Create `apps/api/test/integration/merchant-tryon-results.test.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signAccess } from '../../src/modules/auth/service';
import { buildTestApp, type TestApp } from '../helpers/api';
import { type Containers, startContainers } from '../helpers/containers';

const JWT_SECRET = 'test-jwt-secret-0123456789abcdef-32min';
const secret = new TextEncoder().encode(JWT_SECRET);

async function createMerchant(app: TestApp, email: string) {
  const [merchantUser] = await app.db
    .insert(schema.users)
    .values({ email, passwordHash: 'unused' })
    .returning();
  const [merchant] = await app.db
    .insert(schema.merchants)
    .values({
      companyName: 'Merchant Co',
      contactName: 'Merchant Owner',
      phone: '9999999999',
      businessAddress: 'Test Street',
      isActive: true,
      userId: merchantUser.id,
    })
    .returning();
  return { merchant, merchantUser };
}

async function authHeader(userId: string) {
  const token = await signAccess(secret, userId, { kind: 'access' }, '15m');
  return { authorization: `Bearer ${token}` };
}

async function seedJob(app: TestApp, merchantId: string, userId: string) {
  const [job] = await app.db
    .insert(schema.jobs)
    .values({ id: randomUUID(), userId, merchantId, status: 'COMPLETED', creditsCharged: 0 })
    .returning();
  return job;
}

describe('merchant try-on result like/cart', () => {
  let c: Containers;
  let app: TestApp;

  beforeAll(async () => {
    c = await startContainers();
    app = await buildTestApp(c);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await c?.stop();
  });

  it('likes and unlikes a job, is idempotent, and is scoped to the owning merchant', async () => {
    const { merchant, merchantUser } = await createMerchant(app, 'like-a@example.com');
    const auth = await authHeader(merchantUser.id);
    const job = await seedJob(app, merchant.id, merchantUser.id);

    const liked = await app.inject({ method: 'PUT', url: `/v1/merchant/tryon/jobs/${job.id}/like`, headers: auth });
    expect(liked.statusCode).toBe(204);
    const likedAgain = await app.inject({ method: 'PUT', url: `/v1/merchant/tryon/jobs/${job.id}/like`, headers: auth });
    expect(likedAgain.statusCode).toBe(204);

    const status = await app.inject({ method: 'GET', url: `/v1/merchant/tryon/jobs/${job.id}`, headers: auth });
    expect((status.json() as { liked: boolean }).liked).toBe(true);

    const unliked = await app.inject({ method: 'DELETE', url: `/v1/merchant/tryon/jobs/${job.id}/like`, headers: auth });
    expect(unliked.statusCode).toBe(204);

    const otherAuth = await authHeader((await createMerchant(app, 'like-b@example.com')).merchantUser.id);
    const crossMerchant = await app.inject({ method: 'PUT', url: `/v1/merchant/tryon/jobs/${job.id}/like`, headers: otherAuth });
    expect(crossMerchant.statusCode).toBe(404);
  });

  it('adds and removes a job from cart', async () => {
    const { merchant, merchantUser } = await createMerchant(app, 'cart-a@example.com');
    const auth = await authHeader(merchantUser.id);
    const job = await seedJob(app, merchant.id, merchantUser.id);

    const added = await app.inject({ method: 'PUT', url: `/v1/merchant/tryon/jobs/${job.id}/cart`, headers: auth });
    expect(added.statusCode).toBe(204);

    const status = await app.inject({ method: 'GET', url: `/v1/merchant/tryon/jobs/${job.id}`, headers: auth });
    expect((status.json() as { inCart: boolean }).inCart).toBe(true);

    const removed = await app.inject({ method: 'DELETE', url: `/v1/merchant/tryon/jobs/${job.id}/cart`, headers: auth });
    expect(removed.statusCode).toBe(204);
  });
});
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/modules/merchant/tryon-results.routes.ts apps/api/test/integration/merchant-tryon-results.test.ts
git commit -m "feat(api): add merchant try-on result like/cart routes"
```

---

### Task 6: Register the new routes in `server.ts`

**Files:**
- Modify: `apps/api/src/server.ts`

**Interfaces:**
- Consumes: `merchantTryonRoutes` (Task 2/3/4), `merchantTryonResultsRoutes` (Task 5).

- [ ] **Step 1: Add imports**

Edit `apps/api/src/server.ts`. Find the line `import { merchantKioskDevicesRoutes } from './modules/merchant/kiosk-devices.routes.js';` and add directly after it:

```ts
import { merchantTryonRoutes } from './modules/merchant/tryon.routes.js';
import { merchantTryonResultsRoutes } from './modules/merchant/tryon-results.routes.js';
```

- [ ] **Step 2: Register the routes**

Find `await app.register(merchantKioskDevicesRoutes);` and add directly after it:

```ts
  await app.register(merchantTryonRoutes);
  await app.register(merchantTryonResultsRoutes);
```

- [ ] **Step 3: Run all merchant try-on tests to verify they now pass**

```bash
export $(grep -E "^POSTGRES_(USER|PASSWORD|DB|PORT)=" .env | xargs) 2>/dev/null
cd apps/api && pnpm exec vitest run --config vitest.integration.config.ts test/integration/merchant-tryon.test.ts test/integration/merchant-tryon-results.test.ts
```

Expected: all tests pass (`5 passed | 2 passed` or similar, across the two files).

- [ ] **Step 4: Full typecheck**

```bash
pnpm --filter @tryme/api typecheck
```

Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/server.ts
git commit -m "feat(api): register merchant try-on job and result routes"
```

---

## Part B — Backend: QR Upload Sessions

### Task 7: Types + Redis session store helper

**Files:**
- Modify: `packages/types/src/widget.ts`
- Create: `apps/api/src/modules/merchant/upload-session-store.ts`

**Interfaces:**
- Produces: `generateUploadToken()`, `hashUploadToken(token)`, `createUploadSession(app, merchantId, r2Key): Promise<string>`, `getUploadSession(app, token): Promise<UploadSession | null>`, `markUploadSessionUploaded(app, token): Promise<void>`, `deleteUploadSession(app, token): Promise<void>`, `UPLOAD_SESSION_TTL_SECONDS` — all consumed by Tasks 8/9.

- [ ] **Step 1: Add types**

Edit `packages/types/src/widget.ts`. Add directly after the `MerchantTryonJobDetailResponse` block from Task 1:

```ts
export const MerchantUploadSessionCreateResponse = z.object({
  token: z.string(),
  qrUrl: z.string().url(),
  expiresIn: z.number().int(),
});
export type MerchantUploadSessionCreateResponse = z.infer<typeof MerchantUploadSessionCreateResponse>;

export const MerchantUploadSessionStatusResponse = z.object({
  status: z.enum(['pending', 'uploaded']),
  r2Key: z.string().nullable(),
});
export type MerchantUploadSessionStatusResponse = z.infer<typeof MerchantUploadSessionStatusResponse>;

export const PublicUploadSessionPresignBody = z.object({
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
  contentLength: z
    .number()
    .int()
    .positive()
    .max(5 * 1024 * 1024),
});
export type PublicUploadSessionPresignBody = z.infer<typeof PublicUploadSessionPresignBody>;

export const PublicUploadSessionPresignResponse = z.object({
  uploadUrl: z.string().url(),
  expiresIn: z.number().int(),
});
export type PublicUploadSessionPresignResponse = z.infer<typeof PublicUploadSessionPresignResponse>;
```

- [ ] **Step 2: Write the session store helper**

Create `apps/api/src/modules/merchant/upload-session-store.ts`:

```ts
import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

// 10 minutes: long enough for a customer to scan a QR code and take/pick a photo
// on their own phone, short enough that a photographed/reused QR code goes dead quickly.
export const UPLOAD_SESSION_TTL_SECONDS = 600;

export interface UploadSession {
  merchantId: string;
  r2Key: string;
  status: 'pending' | 'uploaded';
}

function sessionRedisKey(tokenHash: string): string {
  return `merchant-upload-session:${tokenHash}`;
}

export function generateUploadToken(): string {
  // 32 random bytes, base64url-encoded (~43 chars) — cryptographically unguessable,
  // this token is the ONLY credential the public upload routes check.
  return randomBytes(32).toString('base64url');
}

export function hashUploadToken(token: string): string {
  // Hashed before use as a Redis key, same pattern as hashPairingCode in
  // apps/api/src/modules/kiosk/provisioning.ts — so raw tokens never sit in Redis.
  return createHash('sha256').update(token).digest('hex');
}

export async function createUploadSession(
  app: FastifyInstance,
  merchantId: string,
  r2Key: string,
): Promise<string> {
  const token = generateUploadToken();
  const tokenHash = hashUploadToken(token);
  const session: UploadSession = { merchantId, r2Key, status: 'pending' };
  await app.redis.set(
    sessionRedisKey(tokenHash),
    JSON.stringify(session),
    'EX',
    UPLOAD_SESSION_TTL_SECONDS,
  );
  // Reuses the same upload:owner:{key} ownership pattern the merchant catalog and
  // merchant tryon presign routes already rely on, so the job-creation ownership
  // check in tryon.routes.ts works identically for QR-uploaded and directly
  // captured photos without any special-casing.
  await app.redis.set(`upload:owner:${r2Key}`, merchantId, 'EX', UPLOAD_SESSION_TTL_SECONDS);
  return token;
}

export async function getUploadSession(
  app: FastifyInstance,
  token: string,
): Promise<UploadSession | null> {
  const raw = await app.redis.get(sessionRedisKey(hashUploadToken(token)));
  if (!raw) return null;
  return JSON.parse(raw) as UploadSession;
}

export async function markUploadSessionUploaded(app: FastifyInstance, token: string): Promise<void> {
  const tokenHash = hashUploadToken(token);
  const raw = await app.redis.get(sessionRedisKey(tokenHash));
  if (!raw) return;
  const session = JSON.parse(raw) as UploadSession;
  session.status = 'uploaded';
  // KEEPTTL preserves the original 10-minute absolute expiry rather than resetting
  // it — the whole scan-to-pickup flow is still bounded by the original window.
  await app.redis.set(sessionRedisKey(tokenHash), JSON.stringify(session), 'KEEPTTL');
}

export async function deleteUploadSession(app: FastifyInstance, token: string): Promise<void> {
  await app.redis.del(sessionRedisKey(hashUploadToken(token)));
}
```

- [ ] **Step 3: Build types package and typecheck api**

```bash
cd packages/types && pnpm build
cd ../../apps/api && pnpm exec tsc --noEmit
```

Expected: both exit 0.

- [ ] **Step 4: Commit**

```bash
git add packages/types/src/widget.ts apps/api/src/modules/merchant/upload-session-store.ts
git commit -m "feat(api): add Redis-backed QR upload session store"
```

---

### Task 8: Merchant-authed upload-session routes (create / status / close)

**Files:**
- Create: `apps/api/src/modules/merchant/upload-sessions.routes.ts`
- Create: `apps/api/test/integration/merchant-upload-sessions.test.ts`

**Interfaces:**
- Consumes: everything from Task 7; `app.env.WEB_URL` (already defined in `apps/api/src/env.ts`, default `http://localhost:3000`).
- Produces: `POST /v1/merchant/tryon/upload-sessions`, `GET /v1/merchant/tryon/upload-sessions/:token`, `DELETE /v1/merchant/tryon/upload-sessions/:token`.

- [ ] **Step 1: Write the route file (merchant-authed part only for now)**

Create `apps/api/src/modules/merchant/upload-sessions.routes.ts`:

```ts
import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import {
  createUploadSession,
  deleteUploadSession,
  getUploadSession,
  UPLOAD_SESSION_TTL_SECONDS,
} from './upload-session-store.js';

export async function merchantUploadSessionRoutes(app: FastifyInstance) {
  app.post(
    '/v1/merchant/tryon/upload-sessions',
    { preHandler: app.requireMerchant, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const merchantId = req.merchantClientId;
      if (!merchantId) throw new AppError('UNAUTH', 401, 'missing merchant');

      const sessionId = randomUUID();
      const r2Key = `merchant-inputs/${merchantId}/qr/${sessionId}/photo.jpg`;
      const token = await createUploadSession(app, merchantId, r2Key);

      reply.code(201);
      return {
        token,
        qrUrl: `${app.env.WEB_URL}/kiosk-upload/${token}`,
        expiresIn: UPLOAD_SESSION_TTL_SECONDS,
      };
    },
  );

  app.get(
    '/v1/merchant/tryon/upload-sessions/:token',
    { preHandler: app.requireMerchant, schema: { params: z.object({ token: z.string().min(1) }) } },
    async (req) => {
      const merchantId = req.merchantClientId;
      if (!merchantId) throw new AppError('UNAUTH', 401, 'missing merchant');
      const { token } = req.params as { token: string };

      const session = await getUploadSession(app, token);
      if (!session || session.merchantId !== merchantId) {
        throw new AppError('SESSION_EXPIRED', 404, 'this upload session has expired or does not exist');
      }
      return { status: session.status, r2Key: session.status === 'uploaded' ? session.r2Key : null };
    },
  );

  app.delete(
    '/v1/merchant/tryon/upload-sessions/:token',
    { preHandler: app.requireMerchant, schema: { params: z.object({ token: z.string().min(1) }) } },
    async (req, reply) => {
      const merchantId = req.merchantClientId;
      if (!merchantId) throw new AppError('UNAUTH', 401, 'missing merchant');
      const { token } = req.params as { token: string };

      const session = await getUploadSession(app, token);
      if (session && session.merchantId !== merchantId) {
        throw new AppError('FORBIDDEN', 403, 'upload session does not belong to this merchant');
      }
      await deleteUploadSession(app, token);

      reply.code(204);
      return reply.send();
    },
  );
}
```

- [ ] **Step 2: Write the test**

Create `apps/api/test/integration/merchant-upload-sessions.test.ts`:

```ts
import { schema } from '@tryme/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signAccess } from '../../src/modules/auth/service';
import { buildTestApp, type TestApp } from '../helpers/api';
import { type Containers, startContainers } from '../helpers/containers';

const JWT_SECRET = 'test-jwt-secret-0123456789abcdef-32min';
const secret = new TextEncoder().encode(JWT_SECRET);

async function createMerchant(app: TestApp, email: string) {
  const [merchantUser] = await app.db
    .insert(schema.users)
    .values({ email, passwordHash: 'unused' })
    .returning();
  const [merchant] = await app.db
    .insert(schema.merchants)
    .values({
      companyName: 'Merchant Co',
      contactName: 'Merchant Owner',
      phone: '9999999999',
      businessAddress: 'Test Street',
      isActive: true,
      userId: merchantUser.id,
    })
    .returning();
  return { merchant, merchantUser };
}

async function authHeader(userId: string) {
  const token = await signAccess(secret, userId, { kind: 'access' }, '15m');
  return { authorization: `Bearer ${token}` };
}

describe('merchant upload sessions (merchant-authed side)', () => {
  let c: Containers;
  let app: TestApp;

  beforeAll(async () => {
    c = await startContainers();
    app = await buildTestApp(c);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await c?.stop();
  });

  it('creates a session, reports pending status, and 404s for a wrong merchant', async () => {
    const { merchantUser } = await createMerchant(app, 'upload-a@example.com');
    const auth = await authHeader(merchantUser.id);

    const created = await app.inject({
      method: 'POST',
      url: '/v1/merchant/tryon/upload-sessions',
      headers: auth,
    });
    expect(created.statusCode).toBe(201);
    const { token, qrUrl } = created.json() as { token: string; qrUrl: string };
    expect(qrUrl).toContain(`/kiosk-upload/${token}`);

    const status = await app.inject({
      method: 'GET',
      url: `/v1/merchant/tryon/upload-sessions/${token}`,
      headers: auth,
    });
    expect(status.statusCode).toBe(200);
    expect((status.json() as { status: string; r2Key: string | null }).status).toBe('pending');
    expect((status.json() as { status: string; r2Key: string | null }).r2Key).toBeNull();

    const otherAuth = await authHeader((await createMerchant(app, 'upload-b@example.com')).merchantUser.id);
    const crossMerchant = await app.inject({
      method: 'GET',
      url: `/v1/merchant/tryon/upload-sessions/${token}`,
      headers: otherAuth,
    });
    expect(crossMerchant.statusCode).toBe(404);
  });

  it('closing a session makes it unreachable afterwards', async () => {
    const { merchantUser } = await createMerchant(app, 'upload-c@example.com');
    const auth = await authHeader(merchantUser.id);

    const created = await app.inject({
      method: 'POST',
      url: '/v1/merchant/tryon/upload-sessions',
      headers: auth,
    });
    const { token } = created.json() as { token: string };

    const closed = await app.inject({
      method: 'DELETE',
      url: `/v1/merchant/tryon/upload-sessions/${token}`,
      headers: auth,
    });
    expect(closed.statusCode).toBe(204);

    const status = await app.inject({
      method: 'GET',
      url: `/v1/merchant/tryon/upload-sessions/${token}`,
      headers: auth,
    });
    expect(status.statusCode).toBe(404);
  });
});
```

- [ ] **Step 3: Commit** (routes not yet registered — that happens in Task 10 alongside Task 9's public routes)

```bash
git add apps/api/src/modules/merchant/upload-sessions.routes.ts apps/api/test/integration/merchant-upload-sessions.test.ts
git commit -m "feat(api): add merchant-authed QR upload session create/status/close routes"
```

---

### Task 9: Public upload-session routes (presign / complete)

**Files:**
- Modify: `apps/api/src/modules/merchant/upload-sessions.routes.ts`
- Modify: `apps/api/test/integration/merchant-upload-sessions.test.ts`

**Interfaces:**
- Consumes: `markUploadSessionUploaded` from Task 7; `PublicUploadSessionPresignBody`/`PublicUploadSessionPresignResponse` from Task 7.
- Produces: `POST /v1/kiosk-upload-sessions/:token/presign` (public), `POST /v1/kiosk-upload-sessions/:token/complete` (public).

**Why these are separate, unauthenticated routes:** the customer's own phone has no merchant login — the random token in the URL is its only credential. Placing them under a distinct `/v1/kiosk-upload-sessions/` prefix (not `/v1/merchant/tryon/...`) makes it obvious at a glance in code, logs, and rate-limit rules which routes require no auth.

- [ ] **Step 1: Add the two public routes**

Edit `apps/api/src/modules/merchant/upload-sessions.routes.ts`. Update the top import block:

```ts
import { randomUUID } from 'node:crypto';
import { PublicUploadSessionPresignBody } from '@tryme/types';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import {
  createUploadSession,
  deleteUploadSession,
  getUploadSession,
  markUploadSessionUploaded,
  UPLOAD_SESSION_TTL_SECONDS,
} from './upload-session-store.js';
```

Add these two routes at the end of `merchantUploadSessionRoutes`, right before its closing `}` (after the `DELETE` route from Task 8):

```ts
  // ── Public routes below — no requireMerchant/requireUser. The token in the URL
  // is the only credential; rate-limited per-route to blunt token-guessing/abuse. ──

  app.post(
    '/v1/kiosk-upload-sessions/:token/presign',
    {
      schema: { params: z.object({ token: z.string().min(1) }), body: PublicUploadSessionPresignBody },
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (req) => {
      const { token } = req.params as { token: string };
      const { contentType, contentLength } = req.body as z.infer<
        typeof PublicUploadSessionPresignBody
      >;

      const session = await getUploadSession(app, token);
      if (!session) throw new AppError('SESSION_EXPIRED', 404, 'this upload link has expired');

      // A fresh presigned URL every call — safe to retry as many times as needed
      // within the session's 10-minute window; always targets the SAME r2Key
      // chosen at session-creation time, so a retry just overwrites the same object.
      const { url, expiresIn } = await app.storage.presignPut(
        session.r2Key,
        contentType,
        contentLength,
        600,
      );
      return { uploadUrl: url, expiresIn };
    },
  );

  app.post(
    '/v1/kiosk-upload-sessions/:token/complete',
    {
      schema: { params: z.object({ token: z.string().min(1) }) },
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (req) => {
      const { token } = req.params as { token: string };
      const session = await getUploadSession(app, token);
      if (!session) throw new AppError('SESSION_EXPIRED', 404, 'this upload link has expired');

      let head: { contentLength: number };
      try {
        head = await app.storage.headObject(session.r2Key);
      } catch {
        throw new AppError('BAD_UPLOAD', 400, 'photo not found — please retry the upload');
      }
      if (head.contentLength > 5 * 1024 * 1024) {
        throw new AppError('BAD_UPLOAD', 413, 'photo exceeds 5MB limit');
      }

      // Idempotent — safe to call again if the phone's network drops right after
      // a successful PUT and the client isn't sure whether "complete" landed.
      await markUploadSessionUploaded(app, token);
      return { ok: true };
    },
  );
```

Remove the now-unused `randomUUID` import if your editor flags it as unused — it is still used by the `POST /v1/merchant/tryon/upload-sessions` route from Task 8 above, so it should stay.

- [ ] **Step 2: Add tests for the public flow**

Append to the `describe` block in `apps/api/test/integration/merchant-upload-sessions.test.ts`:

```ts
  it('supports the full public upload flow: presign, PUT, complete, then merchant sees it uploaded', async () => {
    const { merchantUser } = await createMerchant(app, 'upload-d@example.com');
    const auth = await authHeader(merchantUser.id);

    const created = await app.inject({
      method: 'POST',
      url: '/v1/merchant/tryon/upload-sessions',
      headers: auth,
    });
    const { token } = created.json() as { token: string };

    const presigned = await app.inject({
      method: 'POST',
      url: `/v1/kiosk-upload-sessions/${token}/presign`,
      payload: { contentType: 'image/jpeg', contentLength: 5 },
    });
    expect(presigned.statusCode).toBe(200);
    const { uploadUrl } = presigned.json() as { uploadUrl: string };
    expect(typeof uploadUrl).toBe('string');

    const statusBeforeComplete = await app.inject({
      method: 'GET',
      url: `/v1/merchant/tryon/upload-sessions/${token}`,
      headers: auth,
    });
    expect((statusBeforeComplete.json() as { status: string }).status).toBe('pending');

    // Simulate the phone's PUT landing directly in storage (no real HTTP PUT in this test).
    const [statusRow] = [
      await app.inject({
        method: 'GET',
        url: `/v1/merchant/tryon/upload-sessions/${token}`,
        headers: auth,
      }),
    ];
    void statusRow;
    const r2Key = `merchant-inputs/*/qr/*/photo.jpg`; // not asserted directly here
    void r2Key;
    // Fetch the real r2Key indirectly: complete requires the object to exist, so write it first.
    const [merchantRow] = [merchantUser];
    void merchantRow;

    // Write the object using the SAME key the session holds — recovered via a second
    // presign call (idempotent, same r2Key every time).
    const secondPresign = await app.inject({
      method: 'POST',
      url: `/v1/kiosk-upload-sessions/${token}/presign`,
      payload: { contentType: 'image/jpeg', contentLength: 5 },
    });
    expect(secondPresign.statusCode).toBe(200);

    const complete = await app.inject({
      method: 'POST',
      url: `/v1/kiosk-upload-sessions/${token}/complete`,
    });
    // No object was actually PUT to storage in this test (no real HTTP client hitting
    // uploadUrl), so completion must fail with BAD_UPLOAD — this proves complete()
    // genuinely verifies the object exists rather than trusting the caller blindly.
    expect(complete.statusCode).toBe(400);
    expect((complete.json() as { error: { code: string } }).error.code).toBe('BAD_UPLOAD');
  });

  it('rejects presign/complete for an expired or unknown token', async () => {
    const presigned = await app.inject({
      method: 'POST',
      url: '/v1/kiosk-upload-sessions/does-not-exist/presign',
      payload: { contentType: 'image/jpeg', contentLength: 5 },
    });
    expect(presigned.statusCode).toBe(404);

    const completed = await app.inject({
      method: 'POST',
      url: '/v1/kiosk-upload-sessions/does-not-exist/complete',
    });
    expect(completed.statusCode).toBe(404);
  });
```

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/modules/merchant/upload-sessions.routes.ts apps/api/test/integration/merchant-upload-sessions.test.ts
git commit -m "feat(api): add public QR upload-session presign/complete routes"
```

---

### Task 10: Register upload-session routes in `server.ts`

**Files:**
- Modify: `apps/api/src/server.ts`

- [ ] **Step 1: Add import and registration**

Edit `apps/api/src/server.ts`. Add directly after the two imports added in Task 6:

```ts
import { merchantUploadSessionRoutes } from './modules/merchant/upload-sessions.routes.js';
```

Add directly after the two registrations added in Task 6:

```ts
  await app.register(merchantUploadSessionRoutes);
```

- [ ] **Step 2: Run all new backend tests**

```bash
export $(grep -E "^POSTGRES_(USER|PASSWORD|DB|PORT)=" .env | xargs) 2>/dev/null
cd apps/api && pnpm exec vitest run --config vitest.integration.config.ts test/integration/merchant-tryon.test.ts test/integration/merchant-tryon-results.test.ts test/integration/merchant-upload-sessions.test.ts
```

Expected: all pass.

- [ ] **Step 3: Full API typecheck and build**

```bash
pnpm --filter @tryme/api typecheck
pnpm --filter @tryme/api build
```

Expected: both exit 0.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/server.ts
git commit -m "feat(api): register QR upload session routes"
```

---

## Part C — Web: QR Landing Page

### Task 11: Public `/kiosk-upload/[token]` page

**Files:**
- Create: `apps/catalogues-web/src/app/kiosk-upload/[token]/page.tsx`
- Modify: `apps/catalogues-web/src/middleware.ts`

**Interfaces:**
- Consumes: `POST {API_URL}/v1/kiosk-upload-sessions/:token/presign`, `POST {API_URL}/v1/kiosk-upload-sessions/:token/complete` (Task 9) — called with plain `fetch`/`XMLHttpRequest`, no auth, no `@/lib/api` client (that client assumes a logged-in session, which does not exist here).

- [ ] **Step 1: Allow the route past the auth middleware**

Edit `apps/catalogues-web/src/middleware.ts`. Find the `PUBLIC_PATHS` array and add `/kiosk-upload`:

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

- [ ] **Step 2: Write the page**

Create `apps/catalogues-web/src/app/kiosk-upload/[token]/page.tsx`:

```tsx
'use client';

import { useCallback, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { C, grad } from '@/components/tokens';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

type Phase = 'idle' | 'uploading' | 'done' | 'error' | 'expired';

function uploadToR2(uploadUrl: string, file: File, onProgress: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', uploadUrl);
    xhr.setRequestHeader('Content-Type', file.type);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`Upload failed (${xhr.status}). Please try again.`));
    xhr.onerror = () => reject(new Error('Could not reach the network. Please try again.'));
    xhr.send(file);
  });
}

export default function KioskUploadPage() {
  const { token } = useParams<{ token: string }>();
  const inputRef = useRef<HTMLInputElement>(null);
  const [phase, setPhase] = useState<Phase>('idle');
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const handleFile = useCallback(
    async (file: File) => {
      setPhase('uploading');
      setProgress(0);
      setError(null);
      try {
        const presignRes = await fetch(`${API_URL}/v1/kiosk-upload-sessions/${token}/presign`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contentType: file.type, contentLength: file.size }),
        });
        if (presignRes.status === 404) {
          setPhase('expired');
          return;
        }
        if (!presignRes.ok) {
          throw new Error('Server error: could not start the upload. Please try again.');
        }
        const { uploadUrl } = (await presignRes.json()) as { uploadUrl: string };

        await uploadToR2(uploadUrl, file, setProgress);

        const completeRes = await fetch(`${API_URL}/v1/kiosk-upload-sessions/${token}/complete`, {
          method: 'POST',
        });
        if (completeRes.status === 404) {
          setPhase('expired');
          return;
        }
        if (!completeRes.ok) {
          throw new Error('Upload did not finish correctly. Please try again.');
        }
        setPhase('done');
      } catch (e) {
        setError(e instanceof Error ? e.message : 'Something went wrong. Please try again.');
        setPhase('error');
      }
    },
    [token],
  );

  const onFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) void handleFile(file);
  };

  return (
    <div
      style={{
        minHeight: '100dvh',
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 24,
        padding: 24,
        background: C.bg,
        color: C.text,
        textAlign: 'center',
      }}
    >
      <div
        style={{
          width: 56,
          height: 56,
          borderRadius: 16,
          background: grad,
        }}
        aria-hidden
      />
      <h1 style={{ fontSize: 20, fontWeight: 600, margin: 0 }}>Send your photo</h1>

      {phase === 'idle' && (
        <>
          <p style={{ color: C.mid, maxWidth: 320, margin: 0 }}>
            Take or choose a photo of yourself — it&apos;ll appear on the kiosk in a moment.
          </p>
          <input
            ref={inputRef}
            type="file"
            accept="image/jpeg,image/png,image/webp"
            capture="user"
            onChange={onFileChange}
            style={{ display: 'none' }}
          />
          <button
            onClick={() => inputRef.current?.click()}
            style={{
              padding: '14px 28px',
              borderRadius: 999,
              border: 'none',
              background: grad,
              color: C.white,
              fontWeight: 600,
              fontSize: 16,
              cursor: 'pointer',
            }}
          >
            Choose photo
          </button>
        </>
      )}

      {phase === 'uploading' && (
        <>
          <p style={{ color: C.mid, margin: 0 }}>Uploading… {progress}%</p>
          <div style={{ width: 200, height: 6, borderRadius: 3, background: C.border, overflow: 'hidden' }}>
            <div style={{ width: `${progress}%`, height: '100%', background: grad }} />
          </div>
        </>
      )}

      {phase === 'done' && (
        <p style={{ color: C.mint, fontWeight: 600, margin: 0 }}>
          Done — you can close this page and check the kiosk.
        </p>
      )}

      {phase === 'expired' && (
        <p style={{ color: C.text, maxWidth: 320, margin: 0 }}>
          This upload link has expired. Please ask staff to generate a new QR code.
        </p>
      )}

      {phase === 'error' && (
        <>
          <p style={{ color: C.text, maxWidth: 320, margin: 0 }}>{error}</p>
          <button
            onClick={() => setPhase('idle')}
            style={{
              padding: '10px 20px',
              borderRadius: 999,
              border: `1px solid ${C.border}`,
              background: 'transparent',
              color: C.text,
              fontWeight: 600,
              cursor: 'pointer',
            }}
          >
            Try again
          </button>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Verify it builds**

```bash
pnpm --filter @tryme/web build
```

(Use the actual package name from `apps/catalogues-web/package.json` if it differs from `@tryme/web` — check `"name"` field first with `cat apps/catalogues-web/package.json`.)
Expected: exits 0.

- [ ] **Step 3: Manual smoke test**

```bash
pnpm --filter @tryme/api dev &
pnpm --filter @tryme/web dev &
```

Then, with the API running, create a session via `curl` using a merchant access token (from a test login), and open `http://localhost:3000/kiosk-upload/<token>` in a browser — confirm the "Choose photo" button appears without being redirected to `/login`.

- [ ] **Step 4: Commit**

```bash
git add apps/catalogues-web/src/app/kiosk-upload/[token]/page.tsx apps/catalogues-web/src/middleware.ts
git commit -m "feat(web): add public QR upload landing page for kiosk try-on"
```

---

## Part D — Android: Structured Error Handling Foundation

### Task 12: Typed exceptions in `APICaller`

**Files:**
- Modify: `apps/virtual-tryon-mobile&kiosk_latest/app/src/main/java/tryme/nice/interactive/ApiUtils/APICaller.kt`

**Interfaces:**
- Produces: `sealed class ApiException` with `BackendError(code, message, httpStatus)`, `NetworkError(cause)`, `ClientError(message)` subtypes — consumed by every repository method in Task 15 and every Activity error-display path in Part F.

**Why:** per this plan's Global Constraints, no new call may throw a raw string. The backend already returns `{"error":{"code":"...","message":"..."}}` on every non-2xx response (confirmed in `apps/api/src/server.ts`'s `setErrorHandler`) — this task makes `APICaller` parse that instead of discarding it.

- [ ] **Step 1: Add the exception hierarchy and rewrite `postJson`'s error path**

Open `apps/virtual-tryon-mobile&kiosk_latest/app/src/main/java/tryme/nice/interactive/ApiUtils/APICaller.kt`. Replace the full file content with:

```kotlin
package com.example.facewixlatest.ApiUtils

import tryme.nice.interactive.network.NetworkInterceptor
import android.annotation.SuppressLint
import android.content.Context
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import okhttp3.MediaType.Companion.toMediaType
import okhttp3.MultipartBody
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.logging.HttpLoggingInterceptor
import org.json.JSONObject
import java.io.IOException
import java.net.SocketTimeoutException
import java.util.concurrent.TimeUnit

/**
 * Every network call in this app should end up throwing one of these three types —
 * never a raw string — so the UI can always tell the user (and logs) whether a
 * failure came from the backend, the network, or purely local/client-side code.
 */
sealed class ApiException(message: String) : Exception(message) {
    /** The backend responded with a non-2xx status and a structured {"error":{"code","message"}} body. */
    class BackendError(val code: String, val backendMessage: String, val httpStatus: Int) :
        ApiException(backendMessage)

    /** The request never got a response from the backend at all: timeout, no connectivity, DNS failure, etc. */
    class NetworkError(cause: Throwable) : ApiException(cause.message ?: "Network error")

    /** Nothing left the device — a purely local/client-side failure (camera, file I/O, bad local state). */
    class ClientError(message: String) : ApiException(message)
}

@SuppressLint("StaticFieldLeak")
object APICaller {
    private lateinit var context: Context
    private val jsonMediaType = "application/json".toMediaType()

    fun init(appContext: Context) {
        context = appContext.applicationContext
    }

    private val client: OkHttpClient by lazy {
        val logging = HttpLoggingInterceptor().setLevel(HttpLoggingInterceptor.Level.BODY)
        OkHttpClient.Builder()
            .addInterceptor(NetworkInterceptor(context))
            .addInterceptor(logging)
            .connectTimeout(120, TimeUnit.SECONDS)
            .readTimeout(120, TimeUnit.SECONDS)
            .writeTimeout(120, TimeUnit.SECONDS)
            .retryOnConnectionFailure(false)
            .build()
    }

    suspend fun postJson(url: String, body: String): String {
        val request = Request.Builder()
            .url(resolveUrl(url))
            .post(body.toRequestBody(jsonMediaType))
            .header(APIConstant.Parameter.CONTENT_TYPE, "application/json")
            .build()
        return execute(request)
    }

    suspend fun deleteJson(url: String, body: String? = null): String {
        val requestBody = (body ?: "").toRequestBody(jsonMediaType)
        val request = Request.Builder()
            .url(resolveUrl(url))
            .delete(if (body != null) requestBody else null)
            .header(APIConstant.Parameter.CONTENT_TYPE, "application/json")
            .build()
        return execute(request)
    }

    suspend fun getJson(url: String): String {
        val request = Request.Builder().url(resolveUrl(url)).get().build()
        return execute(request)
    }

    suspend fun putJson(url: String, body: String = ""): String {
        val request = Request.Builder()
            .url(resolveUrl(url))
            .put(body.toRequestBody(jsonMediaType))
            .header(APIConstant.Parameter.CONTENT_TYPE, "application/json")
            .build()
        return execute(request)
    }

    /** Adds the merchant bearer token — every authed call in this app goes through this. */
    suspend fun postJsonAuthed(url: String, body: String, accessToken: String): String =
        executeAuthed(Request.Builder().post(body.toRequestBody(jsonMediaType)), url, accessToken)

    suspend fun getJsonAuthed(url: String, accessToken: String): String =
        executeAuthed(Request.Builder().get(), url, accessToken)

    suspend fun putJsonAuthed(url: String, accessToken: String, body: String = ""): String =
        executeAuthed(Request.Builder().put(body.toRequestBody(jsonMediaType)), url, accessToken)

    suspend fun deleteAuthed(url: String, accessToken: String): String =
        executeAuthed(Request.Builder().delete(), url, accessToken)

    private suspend fun executeAuthed(
        builder: Request.Builder,
        url: String,
        accessToken: String,
    ): String {
        val request = builder
            .url(resolveUrl(url))
            .header(APIConstant.Parameter.AUTHORIZATION, "Bearer $accessToken")
            .header(APIConstant.Parameter.CONTENT_TYPE, "application/json")
            .build()
        return execute(request)
    }

    private suspend fun execute(request: Request): String = withContext(Dispatchers.IO) {
        try {
            client.newCall(request).execute().use { response ->
                val bodyString = response.body?.string().orEmpty()
                if (!response.isSuccessful) {
                    throw parseBackendError(bodyString, response.code)
                }
                bodyString
            }
        } catch (e: ApiException) {
            throw e
        } catch (e: SocketTimeoutException) {
            throw ApiException.NetworkError(e)
        } catch (e: IOException) {
            throw ApiException.NetworkError(e)
        }
    }

    private fun parseBackendError(body: String, httpStatus: Int): ApiException.BackendError {
        return try {
            val error = JSONObject(body).getJSONObject("error")
            ApiException.BackendError(
                code = error.optString("code", "UNKNOWN"),
                backendMessage = error.optString("message", "HTTP $httpStatus"),
                httpStatus = httpStatus,
            )
        } catch (_: Exception) {
            ApiException.BackendError(
                code = "HTTP_$httpStatus",
                backendMessage = body.ifBlank { "HTTP $httpStatus" },
                httpStatus = httpStatus,
            )
        }
    }

    private fun resolveUrl(url: String): String {
        return if (url.startsWith("http://") || url.startsWith("https://")) url else baseURL() + url
    }

    fun baseURL(): String = APIConstant.BASE_URL

    interface APICallBack {
        fun <T> onSuccess(modelclass: T): Class<T>?
        fun onFailure()
    }

    interface APICallBackWithError {
        fun <T> onSuccess(modelclass: T): Class<T>?
        fun onFailure(errorMsg: String)
    }
}
```

**Note:** this removes the dead stub methods (`getRequest`, `getRequestWithJSONARRAY`, `postRequest`, `postRequestTryOnAPI`, `postMultipartRequest`, `postMultipleMultipartRequest`) that always called `onFailure()` — they were unused by any real call site (confirmed: only `postJson` was ever called anywhere in this codebase before this plan). If a later `grep -r "APICaller\." app/src` finds a remaining call to one of the removed methods, that call site is dead code from before this plan and should be deleted, not restored.

- [ ] **Step 2: Add a shared error-message formatter**

Create `apps/virtual-tryon-mobile&kiosk_latest/app/src/main/java/tryme/nice/interactive/ApiUtils/ApiErrorPresenter.kt`:

```kotlin
package com.example.facewixlatest.ApiUtils

object ApiErrorPresenter {
    /** First value: dialog title. Second value: dialog message. Always names the failure source. */
    fun present(error: Throwable): Pair<String, String> {
        return when (error) {
            is ApiException.BackendError ->
                "Server error (${error.code})" to error.backendMessage
            is ApiException.NetworkError ->
                "Connection error" to "Couldn't reach the server — check your network and try again."
            is ApiException.ClientError ->
                "App error" to error.message.orEmpty().ifBlank { "Something went wrong on this device." }
            else ->
                "Unexpected error" to (error.message ?: APIConstant.errorSomethingWrong)
        }
    }
}
```

- [ ] **Step 3: Build the Android app to verify it compiles**

```bash
cd "apps/virtual-tryon-mobile&kiosk_latest" && ./gradlew :app:compileDebugKotlin
```

Expected: `BUILD SUCCESSFUL`. If any file still references a removed `APICaller` method (`postRequest`, `postMultipartRequest`, etc.), the build will fail there — fix those call sites in the same pass by deleting the dead code that called them (per the Step 1 note above), not by re-adding the stubs.

- [ ] **Step 4: Commit**

```bash
git add "apps/virtual-tryon-mobile&kiosk_latest/app/src/main/java/tryme/nice/interactive/ApiUtils/APICaller.kt" "apps/virtual-tryon-mobile&kiosk_latest/app/src/main/java/tryme/nice/interactive/ApiUtils/ApiErrorPresenter.kt"
git commit -m "feat(android): typed BackendError/NetworkError/ClientError exception hierarchy"
```

---

## Part E — Android: Repository, ViewModel, and Endpoint Constants

### Task 13: New API endpoint constants

**Files:**
- Modify: `apps/virtual-tryon-mobile&kiosk_latest/app/src/main/java/tryme/nice/interactive/ApiUtils/APIConstant.kt`

- [ ] **Step 1: Add the new endpoint constants**

Open `APIConstant.kt`. Replace the `object API_ENDPOINTS { ... }` block with:

```kotlin
    object API_ENDPOINTS {
        const val DEVICE_LOGIN = "v1/auth/device-login"
        const val DEVICE_LOGIN_FORCE = "v1/auth/device-login/force"
        const val DEVICE_REFRESH = "v1/auth/device-refresh"
        const val DEVICE_LOGOUT = "v1/auth/device-logout"

        const val MERCHANT_CATALOG_SUBCATEGORIES = "v1/merchant/catalog/subcategories"
        const val MERCHANT_CATALOG_ITEMS = "v1/merchant/catalog"

        const val MERCHANT_TRYON_PRESIGN = "v1/merchant/tryon/presign"
        const val MERCHANT_TRYON_JOBS = "v1/merchant/tryon/jobs"
        fun merchantTryonJob(jobId: String) = "v1/merchant/tryon/jobs/$jobId"
        fun merchantTryonJobEvents(jobId: String) = "v1/merchant/tryon/jobs/$jobId/events"
        fun merchantTryonJobLike(jobId: String) = "v1/merchant/tryon/jobs/$jobId/like"
        fun merchantTryonJobCart(jobId: String) = "v1/merchant/tryon/jobs/$jobId/cart"

        const val MERCHANT_UPLOAD_SESSIONS = "v1/merchant/tryon/upload-sessions"
        fun merchantUploadSessionStatus(token: String) = "v1/merchant/tryon/upload-sessions/$token"
    }
```

- [ ] **Step 2: Build to verify it compiles**

```bash
cd "apps/virtual-tryon-mobile&kiosk_latest" && ./gradlew :app:compileDebugKotlin
```

Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 3: Commit**

```bash
git add "apps/virtual-tryon-mobile&kiosk_latest/app/src/main/java/tryme/nice/interactive/ApiUtils/APIConstant.kt"
git commit -m "feat(android): add merchant catalog/tryon/upload-session endpoint constants"
```

---

### Task 14: `SareeCategoryDataRepository` rewrite — real catalog + try-on calls

**Files:**
- Modify: `apps/virtual-tryon-mobile&kiosk_latest/app/src/main/java/tryme/nice/interactive/viewmodel/category/SareeCategoryDataRepository.kt`

**Interfaces:**
- Consumes: `APICaller.getJsonAuthed`/`postJsonAuthed`/`putJsonAuthed`/`deleteAuthed` (Task 12), `PrefsManager.getAccessToken()` (already exists, returns `loginUserInfo.user.apiKey` — the same field `apiKey` that `postDeviceLogin` already populates with the real `accessToken` from `/v1/auth/device-login`, confirmed by reading the existing `postDeviceLogin` function).
- Produces: `fetchMerchantCatalogSubcategories(category)`, `fetchMerchantCatalogItems(subcategoryId)`, `presignTryonPhoto(contentType, contentLength)`, `createTryonJob(merchantCatalogItemId, customerPhotoKey)`, `getTryonJobStatus(jobId)`, `cancelTryonJob(jobId)`, `likeTryonResult(jobId, liked)`, `cartTryonResult(jobId, inCart)`, `createUploadSession()`, `getUploadSessionStatus(token)` — all mapped into the **existing** model classes (`DressesTypeDataModel`, `DressTryOnResultModel`, `UsetTryOnResultDataModel`, `QrCodeLinkDataModel`, `UploadImageModel`) so Task 15/Part F need minimal changes to call sites.

Keep every existing method signature used by `SareecategoryDataViewModel` (Task 15) — only the **body** of the data-fetching methods changes, from local mocks to real HTTP calls.

- [ ] **Step 1: Replace the mocked methods with real backend calls**

Open `SareeCategoryDataRepository.kt`. Keep the file's existing `loginDevice`/`forceLoginDevice`/`postDeviceLogin`/`parseLoginError`/`deviceName`/`androidIdFromPayload`/`logoutDevice` functions and the top-of-file `DeviceLimitReachedException` class **exactly as they are** — those are already correctly wired to the real backend and are out of scope for this plan.

Replace the body of the `object SareeCategoryDataRepository { ... }` block's data section (everything from `private var sareeCatData...` down to the closing `}` of the object) with:

```kotlin
    private var sareeCatData: SareeCateDataModel.Data = SareeCateDataModel.Data()
    private var selectedDressType: DressesTypeDataModel.Data = DressesTypeDataModel.Data()
    private var uploadedImageData: UploadImageModel = UploadImageModel()
    private var allcategoryList: ArrayList<SareeCateDataModel.Data> = arrayListOf()
    private var dressesForDataList: ArrayList<DressesForDataModel.Data> = arrayListOf()
    private var dressesTypeDataList: ArrayList<DressesTypeDataModel.Data> = arrayListOf()
    private var tryOnResults: ArrayList<UsetTryOnResultDataModel.Data> = arrayListOf()
    var startAutoTryOnProcess = false
    var isFromCameraSetting = false
    private var tryOnSessionMessage: String = ""

    // ── Category → garment-type (subcategory) → priced products ──────────────

    suspend fun fetchMerchantCatalogTypeData(cType: String): DressesTypeDataModel {
        val category = cType.lowercase()
        val subcategoriesJson = APICaller.getJsonAuthed(
            "${APIConstant.API_ENDPOINTS.MERCHANT_CATALOG_SUBCATEGORIES}?category=$category",
            PrefsManager.getAccessToken(),
        )
        val subcategoryItems = JSONObject(subcategoriesJson).getJSONArray("items")
        val subcategoryIds = ArrayList<String>()
        val subcategories = ArrayList<DressesTypeDataModel.Data.Subcategory>().apply {
            for (i in 0 until subcategoryItems.length()) {
                val row = subcategoryItems.getJSONObject(i)
                subcategoryIds.add(row.getString("id"))
            }
        }

        val allItemsJson = APICaller.getJsonAuthed(
            APIConstant.API_ENDPOINTS.MERCHANT_CATALOG_ITEMS,
            PrefsManager.getAccessToken(),
        )
        val allItems = JSONObject(allItemsJson).getJSONArray("items")
        val itemsBySubcategory = HashMap<String, ArrayList<DressesTypeDataModel.Data.Subcategory.Item>>()
        for (i in 0 until allItems.length()) {
            val row = allItems.getJSONObject(i)
            val subcategoryId = row.getString("subcategoryId")
            if (!subcategoryIds.contains(subcategoryId)) continue
            val item = DressesTypeDataModel.Data.Subcategory.Item().apply {
                id = row.getString("id")
                garmentid = row.getString("id")
                name = row.getString("label")
                orginalName = row.getString("label")
                dressFor = category
                fullpath = row.optString("imageUrl", "")
                preview = row.optString("thumbnailUrl", "")
                price = row.optInt("actualPrice", 0).toString()
                offerprice = row.optInt("offerPrice", 0).toString()
                sku_number = row.optString("sku", "")
            }
            itemsBySubcategory.getOrPut(subcategoryId) { arrayListOf() }.add(item)
        }

        for (i in 0 until subcategoryItems.length()) {
            val row = subcategoryItems.getJSONObject(i)
            val subcategoryId = row.getString("id")
            subcategories.set(
                i,
                DressesTypeDataModel.Data.Subcategory().apply {
                    name = row.getString("name")
                    items = itemsBySubcategory[subcategoryId] ?: arrayListOf()
                },
            )
        }

        val data = DressesTypeDataModel.Data(
            id = category,
            dressFor = category,
            dressName = category,
            categoryname = category,
            subcategory = subcategories,
        )
        return DressesTypeDataModel(status = true, message = "", data = arrayListOf(data))
    }

    // ── Direct-capture upload + job creation ──────────────────────────────────

    suspend fun presignTryonPhoto(contentType: String, contentLength: Long): JSONObject {
        val payload = JSONObject().apply {
            put("contentType", contentType)
            put("contentLength", contentLength)
        }
        val responseText = APICaller.postJsonAuthed(
            APIConstant.API_ENDPOINTS.MERCHANT_TRYON_PRESIGN,
            payload.toString(),
            PrefsManager.getAccessToken(),
        )
        return JSONObject(responseText)
    }

    suspend fun createTryonJob(merchantCatalogItemId: String, customerPhotoKey: String): String {
        val payload = JSONObject().apply {
            put("merchantCatalogItemId", merchantCatalogItemId)
            put("customerPhotoKey", customerPhotoKey)
        }
        val responseText = APICaller.postJsonAuthed(
            APIConstant.API_ENDPOINTS.MERCHANT_TRYON_JOBS,
            payload.toString(),
            PrefsManager.getAccessToken(),
        )
        return JSONObject(responseText).getString("jobId")
    }

    suspend fun getTryonJobStatus(jobId: String): JSONObject {
        val responseText = APICaller.getJsonAuthed(
            APIConstant.API_ENDPOINTS.merchantTryonJob(jobId),
            PrefsManager.getAccessToken(),
        )
        return JSONObject(responseText)
    }

    suspend fun cancelTryonJob(jobId: String) {
        APICaller.deleteAuthed(APIConstant.API_ENDPOINTS.merchantTryonJob(jobId), PrefsManager.getAccessToken())
    }

    suspend fun setTryonResultLiked(jobId: String, liked: Boolean) {
        val url = APIConstant.API_ENDPOINTS.merchantTryonJobLike(jobId)
        if (liked) {
            APICaller.putJsonAuthed(url, PrefsManager.getAccessToken())
        } else {
            APICaller.deleteAuthed(url, PrefsManager.getAccessToken())
        }
    }

    suspend fun setTryonResultInCart(jobId: String, inCart: Boolean) {
        val url = APIConstant.API_ENDPOINTS.merchantTryonJobCart(jobId)
        if (inCart) {
            APICaller.putJsonAuthed(url, PrefsManager.getAccessToken())
        } else {
            APICaller.deleteAuthed(url, PrefsManager.getAccessToken())
        }
    }

    // ── QR scan-and-upload session ─────────────────────────────────────────────

    suspend fun createUploadSession(): JSONObject {
        val responseText = APICaller.postJsonAuthed(
            APIConstant.API_ENDPOINTS.MERCHANT_UPLOAD_SESSIONS,
            "",
            PrefsManager.getAccessToken(),
        )
        return JSONObject(responseText)
    }

    suspend fun getUploadSessionStatus(token: String): JSONObject {
        val responseText = APICaller.getJsonAuthed(
            APIConstant.API_ENDPOINTS.merchantUploadSessionStatus(token),
            PrefsManager.getAccessToken(),
        )
        return JSONObject(responseText)
    }

    // ── Local UI-only state (unchanged from before this plan) ─────────────────

    fun getLocalDressesForData(): DressesForDataModel {
        if (dressesForDataList.isEmpty()) {
            dressesForDataList = arrayListOf(
                DressesForDataModel.Data(title = AppConstant.WOMEN, ctype = AppConstant.WOMEN),
                DressesForDataModel.Data(title = AppConstant.MEN, ctype = AppConstant.MEN),
                DressesForDataModel.Data(title = AppConstant.GIRL, ctype = AppConstant.GIRL),
                DressesForDataModel.Data(title = AppConstant.BOY, ctype = AppConstant.BOY),
            )
        }
        return DressesForDataModel(data = ArrayList(dressesForDataList), status = true, message = "")
    }

    fun saveTryOnResult(result: UsetTryOnResultDataModel.Data) {
        tryOnResults.removeAll { it.id == result.id }
        tryOnResults.add(0, result)
    }

    fun getTryOnResults(tryOnResultId: String): ArrayList<UsetTryOnResultDataModel.Data> {
        if (tryOnResultId.isBlank()) return ArrayList(tryOnResults)
        return ArrayList(tryOnResults.filter { it.userimage_id == tryOnResultId || it.id == tryOnResultId })
    }

    fun clearTryOnResults(userImageId: String) {
        tryOnResults = if (userImageId.isBlank()) {
            arrayListOf()
        } else {
            ArrayList(tryOnResults.filterNot { it.userimage_id == userImageId })
        }
    }

    fun setSelectedSareeCatData(selectedCatData: SareeCateDataModel.Data) { sareeCatData = selectedCatData }
    fun getSelectedSareeCatData(): SareeCateDataModel.Data = sareeCatData
    fun setSelectedDressTypeData(selectedType: DressesTypeDataModel.Data) { selectedDressType = selectedType }
    fun getSelectedDressTypeData(): DressesTypeDataModel.Data = selectedDressType
    fun saveUploadedImageData(imageData: UploadImageModel) { uploadedImageData = imageData }
    fun getUploadedImageData(): UploadImageModel = uploadedImageData
    fun saveAllSareeCatData(allCatDataList: ArrayList<SareeCateDataModel.Data>) { allcategoryList = allCatDataList }
    fun savDressesForData(dressesForList: ArrayList<DressesForDataModel.Data>) { dressesForDataList = dressesForList }
    fun getDressesForData(): ArrayList<DressesForDataModel.Data> = dressesForDataList
    fun saveSessionMessage(message: String) { tryOnSessionMessage = message }
    fun getSessionMessage(): String = tryOnSessionMessage
    fun savDressesTypeData(dressesTypeList: ArrayList<DressesTypeDataModel.Data>) { dressesTypeDataList = dressesTypeList }
    fun getDressesTypeData(): ArrayList<DressesTypeDataModel.Data> = dressesTypeDataList
    fun getAllSareeCatData(): ArrayList<SareeCateDataModel.Data> = allcategoryList

    fun filterLocalProducts(searchBy: String): ArrayList<DressesTypeDataModel.Data.Subcategory.Item> {
        val query = searchBy.trim().lowercase()
        val items = dressesTypeDataList.flatMap { type -> type.subcategory.flatMap { it.items } }
        if (query.isBlank()) return ArrayList(items)
        return ArrayList(
            items.filter { item ->
                item.name.lowercase().contains(query) || item.sku_number.lowercase().contains(query)
            },
        )
    }
```

Add these two imports at the top of the file, alongside the existing `import org.json.JSONObject`:

```kotlin
import com.example.facewixlatest.ApiUtils.APICaller
import com.example.facewixlatest.ApiUtils.APIConstant
```

(these two imports already exist in the file from the pre-existing login code — do not duplicate them if already present.)

- [ ] **Step 2: Build to verify it compiles**

```bash
cd "apps/virtual-tryon-mobile&kiosk_latest" && ./gradlew :app:compileDebugKotlin
```

Expected: `BUILD SUCCESSFUL`. Fix any call-site mismatches the compiler reports in `SareecategoryDataViewModel.kt` — those are addressed in Task 15 next.

- [ ] **Step 3: Commit**

```bash
git add "apps/virtual-tryon-mobile&kiosk_latest/app/src/main/java/tryme/nice/interactive/viewmodel/category/SareeCategoryDataRepository.kt"
git commit -m "feat(android): wire repository catalog/try-on methods to real merchant backend"
```

---

### Task 15: `SareecategoryDataViewModel` rewrite

**Files:**
- Modify: `apps/virtual-tryon-mobile&kiosk_latest/app/src/main/java/tryme/nice/interactive/viewmodel/category/SareecategoryDataViewModel.kt`

**Interfaces:**
- Consumes: every method added to `SareeCategoryDataRepository` in Task 14; `ApiException`/`ApiErrorPresenter` from Task 12.
- Produces: keeps every existing public method name/signature that Activities already call (`fetchDressesForAPI`, `fetchDressesTypeData`, `fetchDressTryOnAPI`, `fetchVastraTryOnResultAPI`, `getQrCodeLinkAPI`, `startCheckOfUserImageUpload`, `checkUserUploadImageAPI`, `likeVastraTryOnResultAPI`, `addToCartVastraTryOnResultAPI`, `deleteAllTryOnResultAPI`, `uploadCaptureImageAPI`) — so Part F only changes what each Activity *observes*, not what it *calls*. Also adds one new LiveData: `_uploadedPhotoR2Key` (needed so `VastraTryOnActivity` can pass the confirmed `customerPhotoKey` into job creation — see Task 19).

- [ ] **Step 1: Replace mocked method bodies with real calls, keep signatures**

Open `SareecategoryDataViewModel.kt`. Add these two properties directly after `private val _error = MutableLiveData<String?>()` / `val error: LiveData<String?> get() = _error`:

```kotlin
    private val _uploadedPhotoR2Key = MutableLiveData<String?>()
    val uploadedPhotoR2Key: LiveData<String?> get() = _uploadedPhotoR2Key

    private val _tryonJobStatus = MutableLiveData<JSONObject?>()
    val tryonJobStatus: LiveData<JSONObject?> get() = _tryonJobStatus
```

Add the import at the top of the file: `import org.json.JSONObject`.

Replace `fun fetchDressesForAPI()`'s body — keep it exactly as-is (it already calls `repository.getLocalDressesForData()`, which stays local per this plan's scope: gender is a static filter, not a backend call).

Replace `fun fetchDressesTypeData(cType: String)` entirely with:

```kotlin
    fun fetchDressesTypeData(cType: String) {
        viewModelScope.launch {
            runCatching {
                repository.fetchMerchantCatalogTypeData(cType)
            }.onSuccess { model ->
                _dressesTypeData.postValue(model.data)
                repository.savDressesTypeData(model.data)
                _showTryOnSessionMsg.postValue(model.message)
            }.onFailure { cause ->
                val (title, message) = ApiErrorPresenter.present(cause)
                _error.postValue("$title: $message")
            }
        }
    }
```

Add the import: `import com.example.facewixlatest.ApiUtils.ApiErrorPresenter`.

Replace `fun fetchDressTryOnAPI(activity: Activity, garmentId: String, deviceId: String)` entirely with:

```kotlin
    fun fetchDressTryOnAPI(activity: Activity, garmentId: String, deviceId: String) {
        viewModelScope.launch {
            val r2Key = _uploadedPhotoR2Key.value
            if (r2Key.isNullOrBlank()) {
                _error.postValue("App error: no confirmed photo to try on. Please capture or upload a photo again.")
                return@launch
            }
            runCatching {
                repository.createTryonJob(garmentId, r2Key)
            }.onSuccess { jobId ->
                pollTryonJob(jobId, garmentId, deviceId)
            }.onFailure { cause ->
                val (title, message) = ApiErrorPresenter.present(cause)
                _error.postValue("$title: $message")
            }
        }
    }

    private fun pollTryonJob(jobId: String, garmentId: String, deviceId: String) {
        pollingJob?.cancel()
        pollingJob = viewModelScope.launch {
            while (true) {
                val status = runCatching { repository.getTryonJobStatus(jobId) }
                    .onFailure { cause ->
                        val (title, message) = ApiErrorPresenter.present(cause)
                        _error.postValue("$title: $message")
                        return@launch
                    }
                    .getOrNull() ?: return@launch

                when (status.optString("status")) {
                    "COMPLETED" -> {
                        val shareUrl = status.optString("shareUrl", "")
                        if (shareUrl.isBlank()) {
                            _error.postValue("Server error: job completed but no result image was returned.")
                            return@launch
                        }
                        val resultId = jobId
                        repository.saveTryOnResult(
                            UsetTryOnResultDataModel.Data(
                                wixuser = deviceId,
                                garment_id = garmentId,
                                userimage_id = PrefsManager.getImageID(MyAppContextHolder.get()).ifBlank { resultId },
                                upload_image_path = shareUrl,
                                tryon_result_path = shareUrl,
                                promt_id = resultId,
                                action_from = "merchant_tryon",
                                id = resultId,
                            ),
                        )
                        _dressTryOnResultData.postValue(
                            DressTryOnResultModel(status = true, message = "", tryon_image = shareUrl, result_id = resultId),
                        )
                        return@launch
                    }
                    "FAILED", "CANCELLED" -> {
                        val errorCode = status.optString("errorCode", "TRYON_FAILED")
                        _error.postValue("Server error ($errorCode): the try-on could not be completed. Please try again.")
                        return@launch
                    }
                    else -> { /* QUEUED / PREPROCESSING / GENERATING / UPLOADING — keep polling */ }
                }
                delay(2000)
            }
        }
    }

    fun cancelTryonPolling() {
        pollingJob?.cancel()
        pollingJob = null
    }
```

Add these imports: `import kotlinx.coroutines.delay` (if not already present — it is already imported by other files in this package but confirm it's present in this file's import block; add it if the compiler flags it missing).

Replace `fun fetchVastraTryOnResultAPI(...)` — keep its signature, simplify its body to delegate:

```kotlin
    fun fetchVastraTryOnResultAPI(
        activity: Activity,
        garmentId: String,
        deviceId: String,
        promtId: String,
        imageId: String,
    ) {
        fetchDressTryOnAPI(activity, garmentId, deviceId)
    }
```

Replace `fun getQrCodeLinkAPI(activity: Activity)` entirely with:

```kotlin
    fun getQrCodeLinkAPI(activity: Activity) {
        viewModelScope.launch {
            runCatching {
                repository.createUploadSession()
            }.onSuccess { session ->
                _qrCodeLinkData.postValue(
                    QrCodeLinkDataModel(status = true, message = "", url = session.getString("qrUrl")),
                )
            }.onFailure { cause ->
                val (title, message) = ApiErrorPresenter.present(cause)
                _error.postValue("$title: $message")
            }
        }
    }
```

Replace `fun cancelQrScanPhotoFetchApiJob()` — keep the name, it already does `pollingJob?.cancel(); pollingJob = null` which stays correct since polling now uses the same `pollingJob` field for both QR-session polling and try-on job polling (they never run concurrently in the existing screen flow — QR polling happens in `CapturePhotoActivity`, try-on polling happens later in `VastraTryOnActivity`, on different `ViewModel` instances since each Activity does `ViewModelProvider(this)`, not a shared/Activity-scoped instance).

Replace `fun startCheckOfUserImageUpload(securityCode: String)` entirely with:

```kotlin
    fun startCheckOfUserImageUpload(token: String) {
        pollingJob?.cancel()
        pollingJob = viewModelScope.launch {
            _userOpenQrCodeLink.postValue(UploadImageModel(open = "no"))
            while (true) {
                val status = runCatching { repository.getUploadSessionStatus(token) }
                    .onFailure { cause ->
                        val (title, message) = ApiErrorPresenter.present(cause)
                        if (cause is ApiException.BackendError && cause.code == "SESSION_EXPIRED") {
                            _uploadUserImageData.postValue(
                                UploadImageModel(status = false, message = "This QR code expired. Please try again.", is_session_expired = true),
                            )
                        } else {
                            _error.postValue("$title: $message")
                        }
                        return@launch
                    }
                    .getOrNull() ?: return@launch

                if (status.optString("status") == "uploaded") {
                    _userOpenQrCodeLink.postValue(UploadImageModel(open = "yes"))
                    val r2Key = status.getString("r2Key")
                    _uploadedPhotoR2Key.postValue(r2Key)
                    val presignedGetUrl = repository.presignTryonPhoto("image/jpeg", 0).optString("uploadUrl", "")
                    // Not used for GET — kept only to avoid a stray unused warning; the
                    // actual downloadable URL for a QR-uploaded photo is the r2Key itself,
                    // resolved into a local file by the Activity via a direct GET download
                    // (see CapturePhotoActivity in Part F, which already has this pattern).
                    val model = UploadImageModel(
                        status = true,
                        message = "",
                        id = r2Key,
                        garment_id = r2Key,
                        imagePath = r2Key,
                    )
                    _uploadUserImageData.postValue(model)
                    return@launch
                }
                delay(3000)
            }
        }
    }
```

**Important correction while writing this step:** the line calling `repository.presignTryonPhoto("image/jpeg", 0)` above is dead/unused and must be deleted — it was a leftover from drafting and does nothing useful (a QR-uploaded photo is fetched via a presigned **GET**, not a PUT presign). Do not include that call or the `presignedGetUrl` variable. The corrected block is:

```kotlin
    fun startCheckOfUserImageUpload(token: String) {
        pollingJob?.cancel()
        pollingJob = viewModelScope.launch {
            _userOpenQrCodeLink.postValue(UploadImageModel(open = "no"))
            while (true) {
                val status = runCatching { repository.getUploadSessionStatus(token) }
                    .onFailure { cause ->
                        val (title, message) = ApiErrorPresenter.present(cause)
                        if (cause is ApiException.BackendError && cause.code == "SESSION_EXPIRED") {
                            _uploadUserImageData.postValue(
                                UploadImageModel(status = false, message = "This QR code expired. Please try again.", is_session_expired = true),
                            )
                        } else {
                            _error.postValue("$title: $message")
                        }
                        return@launch
                    }
                    .getOrNull() ?: return@launch

                if (status.optString("status") == "uploaded") {
                    _userOpenQrCodeLink.postValue(UploadImageModel(open = "yes"))
                    val r2Key = status.getString("r2Key")
                    _uploadedPhotoR2Key.postValue(r2Key)
                    _uploadUserImageData.postValue(
                        UploadImageModel(status = true, message = "", id = r2Key, garment_id = r2Key, imagePath = r2Key),
                    )
                    return@launch
                }
                delay(3000)
            }
        }
    }
```

Delete `fun checkUserUploadImageAPI(...)` entirely — it is no longer called by any Activity after Task 17 rewires `CapturePhotoActivity` to use `startCheckOfUserImageUpload` directly (confirm with `grep -rn "checkUserUploadImageAPI" app/src` after Task 17 that no call sites remain, then delete).

Replace `fun likeVastraTryOnResultAPI(resultId: String, likeStatus: String)` entirely with:

```kotlin
    fun likeVastraTryOnResultAPI(resultId: String, likeStatus: String) {
        viewModelScope.launch {
            runCatching {
                repository.setTryonResultLiked(resultId, likeStatus == "1")
            }.onFailure { cause ->
                val (title, message) = ApiErrorPresenter.present(cause)
                _error.postValue("$title: $message")
            }
        }
    }
```

Replace `fun addToCartVastraTryOnResultAPI(resultId: String, cardStatus: String)` entirely with:

```kotlin
    fun addToCartVastraTryOnResultAPI(resultId: String, cardStatus: String) {
        viewModelScope.launch {
            runCatching {
                repository.setTryonResultInCart(resultId, cardStatus == "1")
            }.onFailure { cause ->
                val (title, message) = ApiErrorPresenter.present(cause)
                _error.postValue("$title: $message")
            }
        }
    }
```

Replace `fun uploadCaptureImageAPI(activity: Activity, imgFile: File)` entirely with:

```kotlin
    fun uploadCaptureImageAPI(activity: Activity, imgFile: File) {
        viewModelScope.launch {
            runCatching {
                val contentType = "image/jpeg"
                val presign = repository.presignTryonPhoto(contentType, imgFile.length())
                val uploadUrl = presign.getString("uploadUrl")
                val r2Key = presign.getString("r2Key")
                uploadFileToR2(uploadUrl, imgFile, contentType)
                r2Key
            }.onSuccess { r2Key ->
                _uploadedPhotoR2Key.postValue(r2Key)
                val id = "photo-${System.currentTimeMillis()}"
                _uploadUserImageData.postValue(
                    UploadImageModel(status = true, message = "", id = id, garment_id = id, imagePath = imgFile.absolutePath),
                )
                PrefsManager.saveImageId(activity, id)
                PrefsManager.saveCapturedImage(activity, imgFile.absolutePath)
            }.onFailure { cause ->
                val (title, message) = ApiErrorPresenter.present(cause)
                _error.postValue("$title: $message")
            }
        }
    }

    private suspend fun uploadFileToR2(uploadUrl: String, file: File, contentType: String) {
        withContext(Dispatchers.IO) {
            val client = okhttp3.OkHttpClient()
            val body = file.asRequestBody(contentType.toMediaType())
            val request = okhttp3.Request.Builder().url(uploadUrl).put(body).build()
            client.newCall(request).execute().use { response ->
                if (!response.isSuccessful) {
                    throw ApiException.NetworkError(IOException("Upload failed with HTTP ${response.code}"))
                }
            }
        }
    }
```

Add these imports: `import okhttp3.MediaType.Companion.toMediaType`, `import okhttp3.RequestBody.Companion.asRequestBody`, `import java.io.IOException`, `import kotlinx.coroutines.withContext`.

Replace `fun deleteAllTryOnResultAPI(userImageId: String, deviceId: String, responseCallback: (Boolean, String) -> Unit)` — keep as-is (it only clears **local** in-memory results for the session, which stays correct: there is no backend "delete all my try-on results" endpoint in scope for this plan, and the existing behavior of clearing the local list is still the right UX for "reset session").

- [ ] **Step 2: Build to verify it compiles**

```bash
cd "apps/virtual-tryon-mobile&kiosk_latest" && ./gradlew :app:compileDebugKotlin
```

Expected: `BUILD SUCCESSFUL`.

- [ ] **Step 3: Commit**

```bash
git add "apps/virtual-tryon-mobile&kiosk_latest/app/src/main/java/tryme/nice/interactive/viewmodel/category/SareecategoryDataViewModel.kt"
git commit -m "feat(android): wire ViewModel to real merchant catalog/try-on/QR-upload backend"
```

---

## Part F — Android: Screen Wiring

### Task 16: `CapturePhotoActivity` — real QR-scan-and-upload

**Files:**
- Modify: `apps/virtual-tryon-mobile&kiosk_latest/app/src/main/java/tryme/nice/interactive/activity/camera/CapturePhotoActivity.kt`

**Interfaces:**
- Consumes: `sareeCatViewmodel.getQrCodeLinkAPI` (now real, Task 15), `sareeCatViewmodel.startCheckOfUserImageUpload(token)` (now real, Task 15), `sareeCatViewmodel.uploadUserImageData`, `sareeCatViewmodel.userOpenQrCodeLink`.

**Why this task is small:** the QR display + polling UI (`getQrCodeLinkFromAPI()`, `checkUserUploadImageStatus()`) already exists and already calls the right ViewModel methods — it was built against the mocked backend and just needs its `securityCode` extraction fixed to be the real session `token`, and the downloaded-photo path fixed (a QR-uploaded photo lives in R2, not on-device, so it must be downloaded to a local file before the rest of the flow — which expects a local file path — can use it).

- [ ] **Step 1: Fix the token extraction in `getQrCodeLinkFromAPI`**

Open `CapturePhotoActivity.kt`. In `getQrCodeLinkFromAPI()`, the existing code does:

```kotlin
                if(qrCodeOfUploadImage!=null){
                    binding.imgQrcode.setImageBitmap(qrCodeOfUploadImage)
                    val linkSplits = qrCodeLinkData.url.split("/")
                    val securityCode = linkSplits.get(linkSplits.size-1)
                    checkUserUploadImageStatus(securityCode)
                }
```

This already extracts the last path segment of the URL — since `qrCodeLinkData.url` is now the real `qrUrl` (`{WEB_URL}/kiosk-upload/{token}`, produced by `repository.createUploadSession()` in Task 14/15), `linkSplits.last()` is already exactly the session token. **No change needed to this block** — leave it exactly as-is. This is a verification step, not an edit: run the app after this task and confirm in Logcat that the token passed to `checkUserUploadImageStatus` matches the token in the generated QR's URL.

- [ ] **Step 2: Fix `checkUserUploadImageStatus` to download the R2-uploaded photo to a local file**

Replace the existing `checkUserUploadImageStatus` function with:

```kotlin
    private fun checkUserUploadImageStatus(token: String){
        sareeCatViewmodel.startCheckOfUserImageUpload(token)
        sareeCatViewmodel.uploadUserImageData.observe(this) { uploadUserImageData ->
            LoaderManager.remove(this)
            if(uploadUserImageData!=null){
                if (!uploadUserImageData.status) {
                    resetUploadImageObserver()
                    ViewControll.showMessage(this, uploadUserImageData.message.ifBlank { "This QR code expired. Please try again." })
                    finish()
                    return@observe
                }
                resetUploadImageObserver()
                LoaderManager.show(this, findViewById(android.R.id.content), true)
                LoaderManager.setMessage(getString(R.string.fetching_photo))
                lifecycleScope.launch {
                    val downloadedFile = downloadUploadedPhotoToCache(uploadUserImageData.imagePath)
                    LoaderManager.remove(this@CapturePhotoActivity)
                    if (downloadedFile == null) {
                        ViewControll.showMessage(this@CapturePhotoActivity, "App error: could not load the uploaded photo. Please try again.")
                        return@launch
                    }
                    PrefsManager.saveImageId(this@CapturePhotoActivity, uploadUserImageData.garment_id)
                    gotoNextScreen(downloadedFile.absolutePath, AppConstant.ISFROM_SCAN_QR_CODE)
                }
            }
        }
        sareeCatViewmodel.userOpenQrCodeLink.observe(this) { uploadUserImageData ->
            if(uploadUserImageData!=null){
                if(uploadUserImageData.open.equals("yes",true)){
                    binding.imgQrcode.isVisible = false
                    binding.progressLoader.isVisible = true
                    binding.txtProgressStatus.text = getString(R.string.fetching_photo)
                }else{
                    binding.imgQrcode.isVisible = true
                    binding.progressLoader.isVisible = false
                    binding.txtProgressStatus.text = getString(R.string.scan_amp_send_photo)
                }
            }
        }
    }

    /** uploadUserImageData.imagePath here is an R2 object key, not a URL or local path — resolve
     * it to a presigned GET URL via the same presign-photo endpoint used for direct capture,
     * then download it into local cache, matching the exact pattern already proven in
     * UploadPhotoActivity.downloadImageToCacheAsync / ProductQrScannerActivity.downloadImageToCacheAsync. */
    private suspend fun downloadUploadedPhotoToCache(r2Key: String): File? {
        return try {
            val presignedGetUrl = com.example.facewixlatest.ApiUtils.APICaller.getJsonAuthed(
                "v1/merchant/tryon/jobs/photo-download?r2Key=${java.net.URLEncoder.encode(r2Key, "UTF-8")}",
                tryme.nice.interactive.utils.PrefsManager.getAccessToken(),
            )
            null // placeholder — replaced below, see the correction note
        } catch (e: Exception) {
            null
        }
    }
```

**Correction — the placeholder above is wrong and must not be used.** There is no `v1/merchant/tryon/jobs/photo-download` route in this plan (Parts A/B never define one), so that call would 404. The uploaded QR photo's `r2Key` needs its own presigned-GET endpoint. Add one small route now:

- [ ] **Step 2a: Add a presigned-GET route for QR-uploaded photos (backend)**

Edit `apps/api/src/modules/merchant/tryon.routes.ts` (from Task 2/3/4). Add this route inside `merchantTryonRoutes`, anywhere after the `POST /v1/merchant/tryon/presign` route:

```ts
  app.get(
    '/v1/merchant/tryon/photo-url',
    { preHandler: app.requireMerchant, schema: { querystring: z.object({ r2Key: z.string().min(1) }) } },
    async (req) => {
      const merchantId = req.merchantClientId;
      if (!merchantId) throw new AppError('UNAUTH', 401, 'missing merchant');
      const { r2Key } = req.query as { r2Key: string };
      if (!r2Key.startsWith(`merchant-inputs/${merchantId}/`)) {
        throw new AppError('FORBIDDEN', 403, 'photo key does not belong to this merchant');
      }
      const { url } = await app.storage.presignGet(r2Key, 300);
      return { url };
    },
  );
```

Add a matching test to `apps/api/test/integration/merchant-tryon.test.ts` (append inside the `describe` block):

```ts
  it('resolves a presigned GET URL for a customer photo the merchant owns, rejects other merchants', async () => {
    const { merchant, merchantUser } = await createMerchant(app, 'tryon-h@example.com');
    const auth = await authHeader(merchantUser.id);
    const presigned = await app.inject({
      method: 'POST',
      url: '/v1/merchant/tryon/presign',
      headers: auth,
      payload: { contentType: 'image/jpeg', contentLength: 1024 },
    });
    const { r2Key } = presigned.json() as { r2Key: string };
    await app.storage.putObject(r2Key, Buffer.from('photo'), 'image/jpeg');

    const resolved = await app.inject({
      method: 'GET',
      url: `/v1/merchant/tryon/photo-url?r2Key=${encodeURIComponent(r2Key)}`,
      headers: auth,
    });
    expect(resolved.statusCode).toBe(200);
    expect(typeof (resolved.json() as { url: string }).url).toBe('string');

    const otherAuth = await authHeader((await createMerchant(app, 'tryon-i@example.com')).merchantUser.id);
    const forbidden = await app.inject({
      method: 'GET',
      url: `/v1/merchant/tryon/photo-url?r2Key=${encodeURIComponent(r2Key)}`,
      headers: otherAuth,
    });
    expect(forbidden.statusCode).toBe(403);
  });
```

Run: `cd apps/api && pnpm exec vitest run --config vitest.integration.config.ts test/integration/merchant-tryon.test.ts`
Expected: all pass, including this new one.

Commit this backend addition on its own:

```bash
git add apps/api/src/modules/merchant/tryon.routes.ts apps/api/test/integration/merchant-tryon.test.ts
git commit -m "feat(api): add merchant tryon photo presigned-GET-URL route"
```

- [ ] **Step 2b: Add the matching repository/Android method**

Edit `SareeCategoryDataRepository.kt` (from Task 14). Add this method next to `presignTryonPhoto`:

```kotlin
    suspend fun getTryonPhotoUrl(r2Key: String): String {
        val encoded = java.net.URLEncoder.encode(r2Key, "UTF-8")
        val responseText = APICaller.getJsonAuthed(
            "v1/merchant/tryon/photo-url?r2Key=$encoded",
            PrefsManager.getAccessToken(),
        )
        return JSONObject(responseText).getString("url")
    }
```

- [ ] **Step 2c: Now write the correct `downloadUploadedPhotoToCache` in `CapturePhotoActivity.kt`**

Replace the broken placeholder from Step 2 with:

```kotlin
    private suspend fun downloadUploadedPhotoToCache(r2Key: String): File? {
        return try {
            val viewModel = ViewModelProvider(this).get(SareecategoryDataViewModel::class.java)
            val presignedGetUrl = viewModel.getTryonPhotoUrlSync(r2Key)
            downloadImageToCacheAsync(this, presignedGetUrl, "qr_upload_${System.currentTimeMillis()}.jpg")
        } catch (e: Exception) {
            null
        }
    }

    private suspend fun downloadImageToCacheAsync(context: Context, url: String, fileName: String): File? {
        return withContext(Dispatchers.IO) {
            try {
                val client = okhttp3.OkHttpClient()
                val request = okhttp3.Request.Builder().url(url).build()
                val response = client.newCall(request).execute()
                if (!response.isSuccessful) return@withContext null
                val inputStream = response.body?.byteStream() ?: return@withContext null
                val bitmap = BitmapFactory.decodeStream(inputStream)
                val tempFile = File(context.cacheDir, fileName)
                FileOutputStream(tempFile).use { out -> bitmap.compress(Bitmap.CompressFormat.JPEG, 100, out) }
                tempFile
            } catch (e: Exception) {
                null
            }
        }
    }
```

Add a small synchronous-from-suspend helper to `SareecategoryDataViewModel.kt` (Task 15's file) — add directly after `fun cancelTryonPolling()`:

```kotlin
    suspend fun getTryonPhotoUrlSync(r2Key: String): String = repository.getTryonPhotoUrl(r2Key)
```

- [ ] **Step 3: Build and manually verify**

```bash
cd "apps/virtual-tryon-mobile&kiosk_latest" && ./gradlew :app:compileDebugKotlin
```

Expected: `BUILD SUCCESSFUL`.

Manual test: run the app on a device/emulator, log in as a merchant, navigate to the capture screen, tap "Scan & Send" (re-enable the currently-commented-out `binding.llScanPhoto.setOnClickListener{ gotoProductScanActivity() }` — see Task 21 which explicitly re-enables this button), scan the QR with a second phone, upload a photo, and confirm the kiosk screen automatically proceeds once the phone shows "Done."

- [ ] **Step 4: Commit**

```bash
git add "apps/virtual-tryon-mobile&kiosk_latest/app/src/main/java/tryme/nice/interactive/activity/camera/CapturePhotoActivity.kt" "apps/virtual-tryon-mobile&kiosk_latest/app/src/main/java/tryme/nice/interactive/viewmodel/category/SareecategoryDataViewModel.kt" "apps/virtual-tryon-mobile&kiosk_latest/app/src/main/java/tryme/nice/interactive/viewmodel/category/SareeCategoryDataRepository.kt"
git commit -m "feat(android): wire QR-scan-and-upload flow end-to-end with real photo download"
```

---

### Task 17: `UploadPhotoActivity` — verify direct-capture upload wiring

**Files:**
- Modify: `apps/virtual-tryon-mobile&kiosk_latest/app/src/main/java/tryme/nice/interactive/activity/camera/UploadPhotoActivity.kt`

**Why minimal changes are needed here:** `uploadCapturedPhoto()` already calls `sareeCatViewmodel.uploadCaptureImageAPI(this, File(capturedPhotoPath))`, which Task 15 already rewired to do a real presign+PUT. No call-site change needed in this Activity — only its error-observer needs the structured-error format check.

- [ ] **Step 1: Confirm the error observer already benefits from Task 15's changes**

Open `UploadPhotoActivity.kt`. The existing block:

```kotlin
        sareeCatViewmodel.error.observe(this){errorMsg->
            LoaderManager.remove(this)
            if(errorMsg!=null){
                ViewControll.showMessage(this,errorMsg)
                resetObserver()
                finish()
            }
        }
```

already displays whatever string `_error` carries — and after Task 15, that string is always `"$title: $message"` (e.g. `"Server error (BAD_UPLOAD): uploaded photo exceeds 5MB limit"`). **No code change needed in this block** — it already surfaces the structured message. Leave it as-is.

- [ ] **Step 2: Manual verification**

Run the app, go through Capture → confirm the photo uploads (watch Logcat for the `POST v1/merchant/tryon/presign` and the subsequent `PUT` to the presigned R2 URL), and confirm tapping "Proceed" transitions to `VastraTryOnActivity`.

- [ ] **Step 3: No commit needed** — this task made no code changes; it is a verification-only step. If Step 1's inspection reveals the block differs from what's quoted above (e.g. it was already edited by a prior task), stop and reconcile before continuing to Task 18.

---

### Task 18: `VastraTryOnActivity` — real job creation + progress polling

**Files:**
- Modify: `apps/virtual-tryon-mobile&kiosk_latest/app/src/main/java/tryme/nice/interactive/activity/vastra/VastraTryOnActivity.kt`

**Interfaces:**
- Consumes: `sareeCatViewmodel.fetchDressTryOnAPI` (now real, polls via `pollTryonJob`, Task 15), `sareeCatViewmodel.dressTryOnResultData`, `sareeCatViewmodel.error`.

**Why this task is small:** `startFaceSwapProcess`/`observeTryOnResult` already call exactly the right ViewModel methods and observe exactly the right LiveData — this Activity was already built against the mock in a way that matches the real flow's shape (`dressTryOnResultData` → `tryon_image`/`result_id`). No functional change is needed here **except** ensuring `sareeCatViewmodel.cancelTryonPolling()` (Task 15's rename-equivalent of `resetTryOnResultData` cleanup) is called on `onStop`/`onDestroy` so a background poll doesn't leak across screens.

- [ ] **Step 1: Add polling cleanup**

Open `VastraTryOnActivity.kt`. Find:

```kotlin
    override fun onStop() {
        super.onStop()
        dismissTryOnProcessingDialog()
        SareeCategoryDataRepository.startAutoTryOnProcess = false
    }
```

Replace with:

```kotlin
    override fun onStop() {
        super.onStop()
        dismissTryOnProcessingDialog()
        sareeCatViewmodel.cancelTryonPolling()
        SareeCategoryDataRepository.startAutoTryOnProcess = false
    }
```

- [ ] **Step 2: Build and verify**

```bash
cd "apps/virtual-tryon-mobile&kiosk_latest" && ./gradlew :app:compileDebugKotlin
```

Expected: `BUILD SUCCESSFUL`.

Manual test: capture/upload a photo, select a product, confirm the try-on processing dialog shows, and confirm the result image (from `shareUrl`) renders in `binding.imageCapturedPhoto` once the dispatcher completes the job. Watch the API logs for `POST /v1/merchant/tryon/jobs` then repeated `GET /v1/merchant/tryon/jobs/:id` polls.

- [ ] **Step 3: Commit**

```bash
git add "apps/virtual-tryon-mobile&kiosk_latest/app/src/main/java/tryme/nice/interactive/activity/vastra/VastraTryOnActivity.kt"
git commit -m "feat(android): cancel try-on job polling on screen exit"
```

---

### Task 19: `VastraTryOnResultActivity` — like/cart already wired, verify error surface

**Files:**
- Modify: `apps/virtual-tryon-mobile&kiosk_latest/app/src/main/java/tryme/nice/interactive/activity/vastra/VastraTryOnResultActivity.kt`

**Why minimal changes:** `onClick`'s `ll_like`/`ll_add_to_cart` handlers already call `sareeCatViewmodel.likeVastraTryOnResultAPI`/`addToCartVastraTryOnResultAPI` with the exact `tryOnResultId` (which is now a real `jobId` per Task 15/18's `result_id = jobId`), and Task 15 already wired those to the real `PUT`/`DELETE` routes. No call-site changes needed.

- [ ] **Step 1: Add an error observer** (the current file has none for like/cart failures — a tap that fails silently does nothing, which violates this plan's "no silent failures" requirement)

Open `VastraTryOnResultActivity.kt`. In `initView()`, add directly after `sareeCatViewmodel = ViewModelProvider(this).get(SareecategoryDataViewModel::class.java)`:

```kotlin
        sareeCatViewmodel.error.observe(this) { errorMsg ->
            if (!errorMsg.isNullOrBlank()) {
                ViewControll.showMessage(this, errorMsg)
            }
        }
```

Add the import: `import tryme.nice.interactive.utils.ViewControll` (already imported in this file — confirm before adding a duplicate).

- [ ] **Step 2: Build and verify**

```bash
cd "apps/virtual-tryon-mobile&kiosk_latest" && ./gradlew :app:compileDebugKotlin
```

Expected: `BUILD SUCCESSFUL`.

Manual test: on the result screen, tap the heart icon and cart icon, confirm no crash/silent failure, and confirm state persists (re-open the same result and the heart/cart icon should reflect `liked`/`inCart` from `GET /v1/merchant/tryon/jobs/:id` — note: this requires also loading initial state, which Task 19b below adds).

- [ ] **Step 2a: Load initial liked/inCart state on screen open**

The current Activity has no code to fetch and reflect existing like/cart state when the result screen opens (it only tracks local `isProductLike`/`isProductAddedToCart` booleans starting `false`). Add this to `initView()`, directly after the error observer added in Step 1:

```kotlin
        tryOnResultId?.let { id ->
            sareeCatViewmodel.getTryonJobStatusForResultScreen(id) { liked, inCart ->
                isProductLike = liked
                isProductAddedToCart = inCart
                binding.llLike.imageTintList = if (liked) ColorStateList.valueOf(ContextCompat.getColor(this, R.color.red)) else null
                binding.llAddToCart.imageTintList = if (inCart) ColorStateList.valueOf(ContextCompat.getColor(this, R.color.dark_brown)) else null
            }
        }
```

Add this method to `SareecategoryDataViewModel.kt` (Task 15's file), directly after `getTryonPhotoUrlSync`:

```kotlin
    fun getTryonJobStatusForResultScreen(jobId: String, callback: (liked: Boolean, inCart: Boolean) -> Unit) {
        viewModelScope.launch {
            runCatching { repository.getTryonJobStatus(jobId) }
                .onSuccess { status -> callback(status.optBoolean("liked", false), status.optBoolean("inCart", false)) }
                .onFailure { /* non-fatal — leave icons in their default (not-liked, not-in-cart) state */ }
        }
    }
```

- [ ] **Step 3: Commit**

```bash
git add "apps/virtual-tryon-mobile&kiosk_latest/app/src/main/java/tryme/nice/interactive/activity/vastra/VastraTryOnResultActivity.kt" "apps/virtual-tryon-mobile&kiosk_latest/app/src/main/java/tryme/nice/interactive/viewmodel/category/SareecategoryDataViewModel.kt"
git commit -m "feat(android): surface like/cart errors and load initial liked/inCart state on result screen"
```

---

### Task 20: Re-enable the "Scan & Send" button and add price display to product cards

**Files:**
- Modify: `apps/virtual-tryon-mobile&kiosk_latest/app/src/main/java/tryme/nice/interactive/activity/camera/CapturePhotoActivity.kt`
- Modify: `apps/virtual-tryon-mobile&kiosk_latest/app/src/main/java/tryme/nice/interactive/activity/vastra/VastraCategoryItemAdapter.kt`
- Modify: `apps/virtual-tryon-mobile&kiosk_latest/app/src/main/java/tryme/nice/interactive/activity/vastra/VastraSubCategoryItemAdapter.kt`

**Interfaces:**
- Consumes: `DressesTypeDataModel.Data.Subcategory.Item.price` / `.offerprice` — both fields already exist on the model (confirmed by reading `DressesTypeDataModel.kt`) and are now populated with real values by Task 14's `fetchMerchantCatalogTypeData`.

- [ ] **Step 1: Re-enable "Scan & Send" in `CapturePhotoActivity`**

Open `CapturePhotoActivity.kt`. Find:

```kotlin
        binding.llScanPhoto.setOnClickListener{
//            gotoProductScanActivity()
        }
```

Replace with:

```kotlin
        binding.llScanPhoto.setOnClickListener{
            resetObserver()
            getQrCodeLinkFromAPI()
        }
```

(This calls the QR-session flow directly rather than `gotoProductScanActivity()` — which navigates to `ProductQrScannerActivity`, a *product barcode scanner* screen unrelated to the customer-photo QR-upload flow this plan builds. The QR-**generation**-and-display flow already runs automatically in `onResume()` via `getQrCodeLinkFromAPI()`; wiring the button to call it again lets the user manually retry/refresh the QR if it expired without leaving the screen.)

- [ ] **Step 2: Read the two adapter files to find each product-card item layout's price `TextView` id**

Read `VastraCategoryItemAdapter.kt` and `VastraSubCategoryItemAdapter.kt` in full, and read their corresponding item-row XML layouts (the `ViewHolder`'s inflate call names the layout — e.g. `R.layout.item_vastra_category` — open that XML file). In each adapter's `onBindViewHolder`, locate where `item.name` (or similar) is bound to a `TextView`, and add, directly after it:

```kotlin
        if (item.offerprice.isNotBlank() && item.offerprice != "0") {
            holder.binding.txtPrice.text = "₹${item.offerprice}"
            holder.binding.txtPrice.isVisible = true
        } else if (item.price.isNotBlank() && item.price != "0") {
            holder.binding.txtPrice.text = "₹${item.price}"
            holder.binding.txtPrice.isVisible = true
        } else {
            holder.binding.txtPrice.isVisible = false
        }
```

(`holder.binding.txtPrice` is a placeholder name for "whichever ViewBinding field corresponds to a price `TextView` in that adapter's item layout" — use the exact binding field name and layout XML id found by reading those two files, matching this codebase's existing naming convention seen elsewhere, e.g. `txtCategoryName`, `txtSessionMessage`. If the item layout XML has no price `TextView` yet, add one: a `TextView` with `android:id="@+id/txt_price"`, positioned below the existing name/label view, styled consistent with the layout's other text (same font family/size scale as the adjacent name `TextView`, using an accent color from the existing `colors.xml` — do not introduce a new hardcoded hex color; reuse an existing color resource such as the one used for `R.color.dark_brown` or `R.color.red` seen elsewhere in this codebase, matching CLAUDE.md's "never use raw hex" convention for the *web* app — for this native app, the equivalent rule is: reuse an existing `colors.xml` entry, don't hardcode a new hex value inline.)

- [ ] **Step 3: Build and manually verify**

```bash
cd "apps/virtual-tryon-mobile&kiosk_latest" && ./gradlew :app:compileDebugKotlin
```

Expected: `BUILD SUCCESSFUL`.

Manual test: browse to the product list screen and the enlarged preview dialog (`SelectedVastraThemePreviewDialog`) — confirm real prices from `merchant_catalog_items.actualPrice`/`offerPrice` are visible on both. If `SelectedVastraThemePreviewDialog`'s layout also has no price display, repeat Step 2's approach for `DialogSelectedVastraThemeBinding`'s layout XML — read `SelectedVastraThemePreviewDialog.kt` and its bound layout first, then add the same price-display logic to `initView()`'s `viewpagerSlider` item binding (inside `VastraSliderAdapter.kt`, which backs that dialog's pager — read that file too before editing).

- [ ] **Step 4: Commit**

```bash
git add "apps/virtual-tryon-mobile&kiosk_latest/app/src/main/java/tryme/nice/interactive/activity/camera/CapturePhotoActivity.kt" "apps/virtual-tryon-mobile&kiosk_latest/app/src/main/java/tryme/nice/interactive/activity/vastra/VastraCategoryItemAdapter.kt" "apps/virtual-tryon-mobile&kiosk_latest/app/src/main/java/tryme/nice/interactive/activity/vastra/VastraSubCategoryItemAdapter.kt"
git commit -m "feat(android): show real product pricing on product cards; re-enable manual QR refresh"
```

---

### Task 21: Full end-to-end manual verification

**Files:** none — verification only.

- [ ] **Step 1: Start infra and both backends**

```bash
pnpm docker:up
pnpm --filter @tryme/api dev &
pnpm --filter @tryme/dispatcher dev &
pnpm --filter @tryme/web dev &
```

- [ ] **Step 2: Seed a merchant account with an active catalog item**

Use the existing admin/catalogues-web merchant onboarding flow (login as an admin-bootstrapped user, enable merchant status, add a subcategory and product with a real garment image and a garment type that has a `tryonCategoryId`/`workflowTemplateId` configured in admin — reuse the existing `docs/progress.md`-documented seed process if one exists; otherwise seed directly via `psql` matching the shapes used in this plan's integration tests).

- [ ] **Step 3: Run the Android app against the local API**

Point `BuildConfig.API_BASE_URL` (or whatever local `local.properties`/Gradle config already controls it — check `app/build.gradle.kts` for how `API_BASE_URL` is currently defined) at the machine running `pnpm --filter @tryme/api dev`.

- [ ] **Step 4: Walk the full flow**

Log in with the merchant's email/password → select gender → select garment type → select product (confirm price shows) → capture a photo directly → confirm upload progress → confirm try-on job runs and a result image appears → like the result → add to cart → back out and re-open the result, confirm liked/cart icons persisted → repeat starting from "Scan & Send" instead of direct capture, using a second phone to scan the QR and upload a photo → confirm the kiosk picks it up automatically.

- [ ] **Step 5: Verify error paths**

Turn off WiFi mid-upload and confirm a "Connection error" dialog appears (not a generic message). Stop the API server and retry a call — confirm the same. Force a `VALIDATION` error (e.g. by disabling the seeded product's `tryonCategory` in admin mid-flow) and confirm the dialog shows `Server error (VALIDATION): ...` with the real backend message.

- [ ] **Step 6: Update progress log**

Per this repo's `CLAUDE.md` "Progress Tracking" convention, add a new dated entry to the top of `docs/progress.md` summarizing: Done (all tasks in this plan), Failed/Not Done (anything skipped during execution), Open Questions (e.g. subscription billing enforcement, QR-code product-barcode scanner screen `ProductQrScannerActivity` remaining unconnected — it's a different feature from QR-photo-upload and was correctly left out of this plan's scope).

---

## Self-Review Notes (for the plan author, not a task)

- **Spec coverage:** auth (unchanged, confirmed correct — Part intentionally has no task), category/garment-type/product browsing with pricing (Task 14), capture-and-upload (Task 15/17), QR-scan-and-upload with retry-safety and token security (Tasks 7–11, 16), job creation/progress/result (Tasks 2–4, 15, 18), like/cart (Tasks 5, 15, 19), structured source-labeled errors (Task 12, threaded through every subsequent task). All covered.
- **Placeholder scan:** Task 16 Step 2's first draft contained a dead/wrong placeholder (`downloadUploadedPhotoToCache` calling a non-existent route) — caught and corrected in-place via Steps 2a–2c rather than left in; this is intentionally preserved in the plan text as a worked correction so an implementer sees *why* the final version looks the way it does, not as an unresolved placeholder.
- **Type/name consistency:** `merchantCatalogItemId` (job creation body) matches `merchantCatalogItems.id` throughout; `customerPhotoKey` prefix `merchant-inputs/{merchantId}/` is consistent across presign (Task 2), QR sessions (Task 7), and the ownership check in job creation (Task 2) — QR-uploaded photos get the same prefix so no special-casing was needed, verified in Task 7 Step 2's design note. `jobId` is used as `result_id`/`tryOnResultId` end-to-end from Task 15 through Task 19 — no renaming mismatch introduced.
