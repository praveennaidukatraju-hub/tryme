# Admin-Configurable Upload Limits Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace 9 hardcoded 20MB upload-size constants (spread across 9 files) plus one previously-unbounded bulk-import route with a single admin-configurable `uploadLimits` block in the existing `config:system` Redis blob, editable from the admin panel's Settings page.

**Architecture:** Extends the exact pattern already used for `maxOutputPx`/`resolutions`/`tryon.creditCost` in this codebase: one Zod-validated `uploadLimits` object added to `SystemConfigBody` (`packages/types/src/admin.ts`), read/written through the existing `GET`/`PATCH /admin/config` routes, with a new `apps/api/src/lib/upload-limits-config.ts` providing `DEFAULT_UPLOAD_LIMITS` + a single generic `getUploadLimitBytes(app, key)` async reader (fail-open to the hardcoded default on missing/malformed Redis data, mirroring `getMaxOutputPx`). Every call site swaps its static byte constant for an `await getUploadLimitBytes(app, 'xKey')` call. No new database tables, no new routes — `uploadLimits` rides along inside the existing config blob.

**Tech Stack:** Fastify 5, `@fastify/multipart`, Zod, Redis (ioredis), Vitest with real Postgres/Redis/MinIO via `apps/api/test/helpers/containers.ts`, React (admin-web).

---

## Field reference (used throughout this plan)

| Config key | Default | Max ceiling | File(s) it replaces |
|---|---:|---:|---|
| `merchantCatalogMaxBytes` | 20971520 (20MB) | 52428800 (50MB) | `apps/api/src/modules/merchant/upload-guard.ts` |
| `webGarmentMaxBytes` | 20971520 | 52428800 | `apps/api/src/lib/upload-ownership.ts` |
| `merchantTryonMaxBytes` | 20971520 | 52428800 | `apps/api/src/modules/merchant/tryon.routes.ts` |
| `kioskUploadMaxBytes` | 20971520 | 52428800 | `apps/api/src/modules/kiosk/jobs.routes.ts` |
| `devApiMaxBytes` | 20971520 | 52428800 | `apps/api/src/modules/dev/routes.ts` (2 handlers, 4 usages) |
| `shopifyCatalogSourceMaxBytes` | 20971520 | 52428800 | `apps/api/src/modules/shopify/catalog.routes.ts` |
| `shopifyCustomerPhotoMaxBytes` | 20971520 | 52428800 | `apps/api/src/modules/shopify/customer.routes.ts` |
| `shopifyProductImageMaxBytes` | 20971520 | 52428800 | `apps/api/src/modules/shopify/products.routes.ts` |
| `shopifyProductSyncMaxBytes` | 20971520 | 52428800 | `apps/api/src/modules/shopify/products.sync.ts` |
| `bulkImportMaxBytes` | 2684354560 (2.5GB) | 3221225472 (3GB) | `apps/api/src/modules/admin/models.routes.ts` (`/admin/assets/bulk-import` — previously had NO dedicated limit at all, just inherited the 2.5GB global Fastify default) |

All 10 fields are optional in the schema (omitted = use default), minimum validation is just "positive integer" (no floor).

---

### Task 1: Add `uploadLimits` to `SystemConfigBody`

**Files:**
- Modify: `packages/types/src/admin.ts:70-97`

- [ ] **Step 1: Add the `uploadLimits` field to the schema**

Find this block (lines 92-97):

```ts
  tryon: z
    .object({
      creditCost: z.number().int().positive().max(1_000),
    })
    .optional(),
});
```

Replace with:

```ts
  tryon: z
    .object({
      creditCost: z.number().int().positive().max(1_000),
    })
    .optional(),
  // Admin-configurable per-surface upload size ceilings. Each replaces a previously
  // hardcoded byte constant (see apps/api/src/lib/upload-limits-config.ts for
  // defaults/readers). Omitted = fall back to the hardcoded default. No minimum
  // floor is enforced deliberately — only a positive integer is required.
  uploadLimits: z
    .object({
      merchantCatalogMaxBytes: z.number().int().positive().max(52_428_800).optional(),
      webGarmentMaxBytes: z.number().int().positive().max(52_428_800).optional(),
      merchantTryonMaxBytes: z.number().int().positive().max(52_428_800).optional(),
      kioskUploadMaxBytes: z.number().int().positive().max(52_428_800).optional(),
      devApiMaxBytes: z.number().int().positive().max(52_428_800).optional(),
      shopifyCatalogSourceMaxBytes: z.number().int().positive().max(52_428_800).optional(),
      shopifyCustomerPhotoMaxBytes: z.number().int().positive().max(52_428_800).optional(),
      shopifyProductImageMaxBytes: z.number().int().positive().max(52_428_800).optional(),
      shopifyProductSyncMaxBytes: z.number().int().positive().max(52_428_800).optional(),
      // Different ceiling: this is a ZIP of many images (admin bulk asset import),
      // not a single photo.
      bulkImportMaxBytes: z.number().int().positive().max(3_221_225_472).optional(),
    })
    .optional(),
});
```

- [ ] **Step 2: Typecheck the types package**

Run: `pnpm --filter @tryme/types exec tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/types/src/admin.ts
git commit -m "feat(types): add uploadLimits to SystemConfigBody"
```

---

### Task 2: Create the upload-limits config reader

**Files:**
- Create: `apps/api/src/lib/upload-limits-config.ts`

- [ ] **Step 1: Write the file**

```ts
import type { FastifyInstance } from 'fastify';

const CONFIG_KEY = 'config:system';

export type UploadLimitKey =
  | 'merchantCatalogMaxBytes'
  | 'webGarmentMaxBytes'
  | 'merchantTryonMaxBytes'
  | 'kioskUploadMaxBytes'
  | 'devApiMaxBytes'
  | 'shopifyCatalogSourceMaxBytes'
  | 'shopifyCustomerPhotoMaxBytes'
  | 'shopifyProductImageMaxBytes'
  | 'shopifyProductSyncMaxBytes'
  | 'bulkImportMaxBytes';

export const DEFAULT_UPLOAD_LIMITS: Record<UploadLimitKey, number> = {
  merchantCatalogMaxBytes: 20 * 1024 * 1024,
  webGarmentMaxBytes: 20 * 1024 * 1024,
  merchantTryonMaxBytes: 20 * 1024 * 1024,
  kioskUploadMaxBytes: 20 * 1024 * 1024,
  devApiMaxBytes: 20 * 1024 * 1024,
  shopifyCatalogSourceMaxBytes: 20 * 1024 * 1024,
  shopifyCustomerPhotoMaxBytes: 20 * 1024 * 1024,
  shopifyProductImageMaxBytes: 20 * 1024 * 1024,
  shopifyProductSyncMaxBytes: 20 * 1024 * 1024,
  // Matches today's de facto behavior: this route previously had no dedicated
  // constant and just inherited the 2.5GB global Fastify multipart default.
  bulkImportMaxBytes: 2.5 * 1024 * 1024 * 1024,
};

/**
 * Reads an admin-configured upload size limit (bytes) from the same
 * `config:system` Redis key the admin panel edits (GET/PATCH /admin/config).
 * Falls back to the hardcoded default in DEFAULT_UPLOAD_LIMITS if nothing is
 * stored yet, or the entry is missing/malformed.
 */
export async function getUploadLimitBytes(
  app: FastifyInstance,
  key: UploadLimitKey,
): Promise<number> {
  try {
    const raw = await app.redis.get(CONFIG_KEY);
    const cfg = raw ? JSON.parse(raw) : {};
    const val = cfg.uploadLimits?.[key];
    return typeof val === 'number' ? val : DEFAULT_UPLOAD_LIMITS[key];
  } catch {
    return DEFAULT_UPLOAD_LIMITS[key];
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @tryme/api exec tsc --noEmit -p .`
Expected: no errors (this file has no callers yet, so it should just compile standalone).

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/lib/upload-limits-config.ts
git commit -m "feat(api): add admin-configurable upload-limit reader"
```

---

### Task 3: Wire `GET`/`PATCH /admin/config` to expose `uploadLimits`

**Files:**
- Modify: `apps/api/src/modules/admin/config.routes.ts:1-36`

- [ ] **Step 1: Import the defaults and default-fill the GET response**

Change the top of the file (lines 1-12):

```ts
import { schema } from '@tryme/db';
import { SystemConfigBody } from '@tryme/types';
import { and, count, countDistinct, eq, gte, lt, lte, sql, sum } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  DEFAULT_MAX_OUTPUT_PX,
  DEFAULT_RESOLUTION_CONFIG,
  DEFAULT_TRYON_CONFIG,
} from '../../lib/resolution-config.js';
import { requireAdmin } from './guard.js';

const KEY = 'config:system';
```

to:

```ts
import { schema } from '@tryme/db';
import { SystemConfigBody } from '@tryme/types';
import { and, count, countDistinct, eq, gte, lt, lte, sql, sum } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  DEFAULT_MAX_OUTPUT_PX,
  DEFAULT_RESOLUTION_CONFIG,
  DEFAULT_TRYON_CONFIG,
} from '../../lib/resolution-config.js';
import { DEFAULT_UPLOAD_LIMITS } from '../../lib/upload-limits-config.js';
import { requireAdmin } from './guard.js';

const KEY = 'config:system';
```

- [ ] **Step 2: Default-fill `uploadLimits` in the admin `GET /admin/config` handler**

Change (lines 25-36):

```ts
  app.get(
    '/admin/config',
    { preHandler: requireAdmin(['SUPER_ADMIN', 'MODERATOR', 'SUPPORT', 'ADMIN']) },
    async () => {
      const raw = await app.redis.get(KEY);
      const cfg = raw ? JSON.parse(raw) : {};
      cfg.resolutions = cfg.resolutions ?? DEFAULT_RESOLUTION_CONFIG;
      cfg.maxOutputPx = cfg.maxOutputPx ?? DEFAULT_MAX_OUTPUT_PX;
      cfg.tryon = cfg.tryon ?? DEFAULT_TRYON_CONFIG;
      return cfg;
    },
  );
```

to:

```ts
  app.get(
    '/admin/config',
    { preHandler: requireAdmin(['SUPER_ADMIN', 'MODERATOR', 'SUPPORT', 'ADMIN']) },
    async () => {
      const raw = await app.redis.get(KEY);
      const cfg = raw ? JSON.parse(raw) : {};
      cfg.resolutions = cfg.resolutions ?? DEFAULT_RESOLUTION_CONFIG;
      cfg.maxOutputPx = cfg.maxOutputPx ?? DEFAULT_MAX_OUTPUT_PX;
      cfg.tryon = cfg.tryon ?? DEFAULT_TRYON_CONFIG;
      cfg.uploadLimits = { ...DEFAULT_UPLOAD_LIMITS, ...cfg.uploadLimits };
      return cfg;
    },
  );
```

(Note: `{ ...DEFAULT_UPLOAD_LIMITS, ...cfg.uploadLimits }` merges per-field, so an admin who's only ever set e.g. `bulkImportMaxBytes` still sees the other 9 defaults filled in, rather than needing every field set to appear.)

`PATCH /admin/config` needs no changes — it already does `{ ...cur, ...req.body }`, a shallow merge that will happily accept and persist a `uploadLimits` key once `SystemConfigBody` allows it (Task 1).

- [ ] **Step 3: Extend the admin-config integration test**

Find the existing admin config test file:

```bash
grep -rl "GET /admin/config\|PATCH /admin/config" apps/api/test/
```

Open whichever file that returns (likely `apps/api/test/admin-config.test.ts` or similar) and add this case inside its existing `describe` block, reusing that file's existing `app`/admin-auth-header helper (match whatever it's actually called in that file — e.g. if the file already has an `adminAuthHeader(...)` or `authHeader(...)` helper used by its other `PATCH /admin/config` tests, reuse it verbatim):

```ts
  it('GET /admin/config default-fills uploadLimits, and PATCH persists a partial override', async () => {
    const getRes = await app.inject({
      method: 'GET',
      url: '/admin/config',
      headers: adminAuth, // replace with this file's actual admin auth header variable/helper
    });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().uploadLimits.merchantCatalogMaxBytes).toBe(20 * 1024 * 1024);
    expect(getRes.json().uploadLimits.bulkImportMaxBytes).toBe(2.5 * 1024 * 1024 * 1024);

    const patchRes = await app.inject({
      method: 'PATCH',
      url: '/admin/config',
      headers: { ...adminAuth, 'content-type': 'application/json' },
      payload: JSON.stringify({ uploadLimits: { kioskUploadMaxBytes: 5 * 1024 * 1024 } }),
    });
    expect(patchRes.statusCode).toBe(200);

    const getRes2 = await app.inject({
      method: 'GET',
      url: '/admin/config',
      headers: adminAuth,
    });
    expect(getRes2.json().uploadLimits.kioskUploadMaxBytes).toBe(5 * 1024 * 1024);
    // Untouched fields still default-fill correctly alongside the override.
    expect(getRes2.json().uploadLimits.merchantCatalogMaxBytes).toBe(20 * 1024 * 1024);
  });
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @tryme/api exec vitest run --exclude 'test/integration/**' -t "uploadLimits"` (adjust the `--exclude` flag if the file you edited lives under `test/integration/` instead — in that case run `pnpm --filter @tryme/api exec vitest run test/integration/<file>.test.ts -t "uploadLimits"`)
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/admin/config.routes.ts apps/api/test/<the-file-you-edited>
git commit -m "feat(api): expose uploadLimits through GET/PATCH /admin/config"
```

---

### Task 4: Merchant catalogue upload (`upload-guard.ts`)

**Files:**
- Modify: `apps/api/src/modules/merchant/upload-guard.ts`
- Test: `apps/api/test/integration/merchant-catalog-generate.test.ts`

- [ ] **Step 1: Replace the hardcoded constant with the config reader**

Replace the entire file content with:

```ts
import type { FastifyInstance } from 'fastify';
import { AppError } from '../../lib/errors.js';
import { getUploadLimitBytes } from '../../lib/upload-limits-config.js';

const MERCHANT_CATALOG_CONTENT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

export async function assertMerchantUploadKey(
  app: FastifyInstance,
  merchantId: string,
  key: string,
  label: string,
) {
  if (!key.startsWith(`merchant-catalog/${merchantId}/`)) {
    throw new AppError('FORBIDDEN', 403, `${label} key does not belong to this merchant`);
  }

  const owner = await app.redis.get(`upload:owner:${key}`);
  if (owner !== merchantId) {
    throw new AppError('FORBIDDEN', 403, `${label} upload session expired or not owned`);
  }

  let head: { contentLength: number; contentType: string | null };
  try {
    head = await app.storage.headObject(key);
  } catch {
    throw new AppError('BAD_UPLOAD', 400, `${label} not found`);
  }

  const maxBytes = await getUploadLimitBytes(app, 'merchantCatalogMaxBytes');
  if (head.contentLength > maxBytes) {
    throw new AppError('BAD_UPLOAD', 413, `${label} exceeds ${maxBytes / (1024 * 1024)}MB limit`);
  }
  if (!head.contentType || !MERCHANT_CATALOG_CONTENT_TYPES.has(head.contentType)) {
    throw new AppError('BAD_UPLOAD', 400, `${label} must be jpeg, png, or webp`);
  }
}
```

- [ ] **Step 2: Add a regression test**

`apps/api/test/integration/merchant-catalog-generate.test.ts` already has a `CONFIG_KEY = 'config:system'` constant (line 11) and an `afterEach(() => app.redis.del(CONFIG_KEY))` cleanup (line 193) — reuse both. Add this test inside the file's existing `describe('merchant catalog generate (single, Path B)', ...)` block, after the existing happy-path test:

```ts
  it('rejects a merchant catalogue upload above the admin-configured limit', async () => {
    const { merchant, userId } = await createMerchant(app, 'catalog-limit@example.com');
    await grantUserCredits(app, userId, 100);
    const { garmentType, pose, face, bg } = await seedFullDefaults('women');

    await app.redis.set(
      CONFIG_KEY,
      JSON.stringify({
        merchantCatalogDefaults: { women: { faceId: face.id, backgroundId: bg.id } },
        merchantCatalogAspectRatio: '2:3',
        uploadLimits: { merchantCatalogMaxBytes: 1024 }, // 1KB — trivially exceeded below
      }),
    );

    const auth = await authHeader(userId);
    const presigned = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/presign',
      headers: auth,
      payload: { contentType: 'image/jpeg', contentLength: 2048 },
    });
    expect(presigned.statusCode).toBe(200);
    const { r2Key } = presigned.json() as { r2Key: string };
    await app.storage.putObject(r2Key, Buffer.alloc(2048), 'image/jpeg');

    const genRes = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/generate',
      headers: auth,
      payload: { garmentTypeId: garmentType.id, flatImageKey: r2Key },
    });
    expect(genRes.statusCode).toBe(413);
    expect(genRes.json().error.message).toContain('MB limit');
  });
```

(If the actual presign/generate route URLs or payload shape in this file differ from the above — check the file's existing happy-path test around the `describe` block for the real `/v1/merchant/catalog/presign` and `/v1/merchant/catalog/generate` request shapes and match them exactly; the assertions on status code 413 and the error-message substring are what matters.)

- [ ] **Step 3: Run the test**

Run: `pnpm --filter @tryme/api exec vitest run test/integration/merchant-catalog-generate.test.ts -t "admin-configured limit"`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/merchant/upload-guard.ts apps/api/test/integration/merchant-catalog-generate.test.ts
git commit -m "feat(api): make merchant catalogue upload limit admin-configurable"
```

---

### Task 5: Studio/web garment upload (`upload-ownership.ts`)

**Files:**
- Modify: `apps/api/src/lib/upload-ownership.ts`
- Test: `apps/api/test/integration/uploads.test.ts`

- [ ] **Step 1: Replace the hardcoded constant with the config reader**

Replace the entire file content with:

```ts
import type { FastifyInstance } from 'fastify';
import { AppError } from './errors.js';
import { getUploadLimitBytes } from './upload-limits-config.js';

/**
 * Verifies the object exists in storage and is within the accepted size limit.
 * Does not check ownership - callers that have already established ownership
 * through another means (e.g. regenerating an already-owned completed job)
 * use this directly instead of the full Redis-binding check below.
 */
export async function assertGarmentObjectValid(app: FastifyInstance, key: string) {
  let head: { contentLength: number };
  try {
    head = await app.storage.headObject(key);
  } catch {
    throw new AppError('BAD_UPLOAD', 400, 'uploaded garment not found');
  }
  const maxBytes = await getUploadLimitBytes(app, 'webGarmentMaxBytes');
  if (head.contentLength > maxBytes) {
    throw new AppError('BAD_UPLOAD', 413, 'uploaded garment exceeds size limit');
  }
}

/**
 * Reject a garment key that was not presigned for this user. The presign route
 * records `upload:owner:<key> -> userId` in Redis with a 24h TTL; a key bound
 * to nobody (expired/never issued) or to another user fails here. This is the
 * check for a fresh upload - regeneration of an old job uses
 * `trustedGarmentKeys` in `createJob` instead, since the 24h binding will
 * usually have expired long before an old job is regenerated even though the
 * caller's ownership of that job (and therefore its garment keys) is still valid.
 */
export async function assertOwnsUploadKey(app: FastifyInstance, userId: string, key: string) {
  const owner = await app.redis.get(`upload:owner:${key}`);
  if (owner !== userId) {
    throw new AppError('FORBIDDEN', 403, 'upload key not owned by caller');
  }
  await assertGarmentObjectValid(app, key);
}
```

Note: `MAX_GARMENT_BYTES` is no longer exported. Check for any other importers before deleting it:

```bash
grep -rn "MAX_GARMENT_BYTES" apps/api/src apps/api/test --include="*.ts"
```

If this shows any importer other than `upload-ownership.ts` itself (there shouldn't be — it was only used internally), update that call site the same way (`await getUploadLimitBytes(app, 'webGarmentMaxBytes')`) before proceeding.

- [ ] **Step 2: Add a regression test**

Add this test to `apps/api/test/integration/uploads.test.ts`, inside the existing `describe('uploads', ...)` block, after the existing presign test. This test exercises `assertGarmentObjectValid` indirectly via the presign route + a direct MinIO put + Redis config override (no full job-creation flow needed):

```ts
  it('a garment upload above the admin-configured limit is rejected once ownership is checked', async () => {
    const token = await getToken();
    await app.redis.set(
      'config:system',
      JSON.stringify({ uploadLimits: { webGarmentMaxBytes: 1024 } }),
    );
    try {
      const presign = await app.inject({
        method: 'POST',
        url: '/v1/uploads/presign',
        headers: { authorization: `Bearer ${token}` },
        payload: { contentType: 'image/jpeg', contentLength: 2048 },
      });
      expect(presign.statusCode).toBe(200);
      const { r2Key } = presign.json() as { r2Key: string };
      await app.storage.putObject(r2Key, Buffer.alloc(2048), 'image/jpeg');

      const { assertGarmentObjectValid } = await import('../../src/lib/upload-ownership.js');
      await expect(assertGarmentObjectValid(app, r2Key)).rejects.toThrow(/exceeds size limit/);
    } finally {
      await app.redis.del('config:system');
    }
  });
```

- [ ] **Step 3: Run the test**

Run: `pnpm --filter @tryme/api exec vitest run test/integration/uploads.test.ts`
Expected: both tests PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/lib/upload-ownership.ts apps/api/test/integration/uploads.test.ts
git commit -m "feat(api): make studio/web garment upload limit admin-configurable"
```

---

### Task 6: Merchant try-on customer photo (`tryon.routes.ts`)

**Files:**
- Modify: `apps/api/src/modules/merchant/tryon.routes.ts:1-11,175-196`
- Test: `apps/api/test/integration/merchant-tryon.test.ts`

- [ ] **Step 1: Remove the hardcoded constant, import the reader**

Change (lines 1-10):

```ts
import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { MerchantTryonJobCreateBody, MerchantTryonPresignBody } from '@tryme/types';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { createMerchantTryonJob } from './create-tryon-job.js';

const MAX_TRYON_UPLOAD_BYTES = 20 * 1024 * 1024;
```

to:

```ts
import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { MerchantTryonJobCreateBody, MerchantTryonPresignBody } from '@tryme/types';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { getUploadLimitBytes } from '../../lib/upload-limits-config.js';
import { createMerchantTryonJob } from './create-tryon-job.js';
```

- [ ] **Step 2: Replace the check at the call site**

Change (lines 184-196):

```ts
      let photoHead: { contentLength: number };
      try {
        photoHead = await app.storage.headObject(customerPhotoKey);
      } catch {
        throw new AppError('BAD_UPLOAD', 400, 'uploaded photo not found');
      }
      if (photoHead.contentLength > MAX_TRYON_UPLOAD_BYTES) {
        throw new AppError(
          'BAD_UPLOAD',
          413,
          `uploaded photo exceeds ${MAX_TRYON_UPLOAD_BYTES / (1024 * 1024)}MB limit`,
        );
      }
```

to:

```ts
      let photoHead: { contentLength: number };
      try {
        photoHead = await app.storage.headObject(customerPhotoKey);
      } catch {
        throw new AppError('BAD_UPLOAD', 400, 'uploaded photo not found');
      }
      const maxTryonBytes = await getUploadLimitBytes(app, 'merchantTryonMaxBytes');
      if (photoHead.contentLength > maxTryonBytes) {
        throw new AppError(
          'BAD_UPLOAD',
          413,
          `uploaded photo exceeds ${maxTryonBytes / (1024 * 1024)}MB limit`,
        );
      }
```

- [ ] **Step 3: Add a regression test**

Add this test to `apps/api/test/integration/merchant-tryon.test.ts`, inside `describe('merchant try-on jobs', ...)`, after the existing happy-path test. Reuses this file's existing `createMerchant`/`authHeader`/`seedGarmentTypeWithWorkflow`/`seedCatalogItem` helpers:

```ts
  it('rejects a customer photo above the admin-configured limit', async () => {
    const { merchant, merchantUser } = await createMerchant(app, 'tryon-limit@example.com');
    const auth = await authHeader(merchantUser.id);
    const garmentType = await seedGarmentTypeWithWorkflow(app);
    const item = await seedCatalogItem(app, merchant.id, garmentType.id);

    await app.redis.set(
      'config:system',
      JSON.stringify({ uploadLimits: { merchantTryonMaxBytes: 1024 } }),
    );
    try {
      const presigned = await app.inject({
        method: 'POST',
        url: '/v1/merchant/tryon/presign',
        headers: auth,
        payload: { contentType: 'image/jpeg', contentLength: 2048 },
      });
      expect(presigned.statusCode).toBe(200);
      const { r2Key } = presigned.json() as { r2Key: string };
      await app.storage.putObject(r2Key, Buffer.alloc(2048), 'image/jpeg');

      const jobRes = await app.inject({
        method: 'POST',
        url: '/v1/merchant/tryon/jobs',
        headers: auth,
        payload: { customerPhotoKey: r2Key, catalogItemId: item.id },
      });
      expect(jobRes.statusCode).toBe(413);
      expect(jobRes.json().error.message).toContain('MB limit');
    } finally {
      await app.redis.del('config:system');
    }
  });
```

(Match the exact `/v1/merchant/tryon/jobs` payload shape to whatever the existing happy-path test in this file already sends — check it around line 130+ for the real field names, e.g. it may be `catalogItemId` or a differently-named field.)

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @tryme/api exec vitest run test/integration/merchant-tryon.test.ts -t "admin-configured limit"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/merchant/tryon.routes.ts apps/api/test/integration/merchant-tryon.test.ts
git commit -m "feat(api): make merchant try-on upload limit admin-configurable"
```

---

### Task 7: Kiosk customer photo (`kiosk/jobs.routes.ts`)

**Files:**
- Modify: `apps/api/src/modules/kiosk/jobs.routes.ts:1-12,214-226`
- Test: `apps/api/test/integration/kiosk-jobs.test.ts`

- [ ] **Step 1: Remove the hardcoded constant, import the reader**

Change (lines 1-12):

```ts
import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { KioskJobCreateBody, KioskPresignBody } from '@tryme/types';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { merchantRefund } from '../merchant/ledger.js';
import { createKioskJob, KIOSK_JOB_COST } from './create-job.js';

const MAX_KIOSK_UPLOAD_BYTES = 20 * 1024 * 1024;
```

to:

```ts
import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { KioskJobCreateBody, KioskPresignBody } from '@tryme/types';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Redis } from 'ioredis';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { getUploadLimitBytes } from '../../lib/upload-limits-config.js';
import { merchantRefund } from '../merchant/ledger.js';
import { createKioskJob, KIOSK_JOB_COST } from './create-job.js';
```

- [ ] **Step 2: Replace the check at the call site**

Change (lines 214-226):

```ts
      let photoHead: { contentLength: number };
      try {
        photoHead = await app.storage.headObject(customerPhotoKey);
      } catch {
        throw new AppError('BAD_UPLOAD', 400, 'uploaded photo not found');
      }
      if (photoHead.contentLength > MAX_KIOSK_UPLOAD_BYTES) {
        throw new AppError(
          'BAD_UPLOAD',
          413,
          `uploaded photo exceeds ${MAX_KIOSK_UPLOAD_BYTES / (1024 * 1024)}MB limit`,
        );
      }
```

to:

```ts
      let photoHead: { contentLength: number };
      try {
        photoHead = await app.storage.headObject(customerPhotoKey);
      } catch {
        throw new AppError('BAD_UPLOAD', 400, 'uploaded photo not found');
      }
      const maxKioskBytes = await getUploadLimitBytes(app, 'kioskUploadMaxBytes');
      if (photoHead.contentLength > maxKioskBytes) {
        throw new AppError(
          'BAD_UPLOAD',
          413,
          `uploaded photo exceeds ${maxKioskBytes / (1024 * 1024)}MB limit`,
        );
      }
```

- [ ] **Step 3: Add a regression test**

Add this test to `apps/api/test/integration/kiosk-jobs.test.ts`, reusing the file's existing `seedMerchant`/`claimDevice`/`uploadCustomerPhoto`/`seedCatalogItem` helpers (see the file's imports/helpers at the top). Place it inside whatever `describe` block already contains the happy-path kiosk job creation test:

```ts
  it('rejects a kiosk customer photo above the admin-configured limit', async () => {
    const merchant = await seedMerchant(app, 'kiosk-limit@example.com', 100);
    const { accessToken } = await claimDevice(app, merchant.id, 'Device 1', 'android-1');
    const item = await seedCatalogItem(app, merchant.id);

    await app.redis.set(
      'config:system',
      JSON.stringify({ uploadLimits: { kioskUploadMaxBytes: 1024 } }),
    );
    try {
      const r2Key = await uploadCustomerPhoto(app, accessToken, Buffer.alloc(2048));

      const jobRes = await app.inject({
        method: 'POST',
        url: '/v1/kiosk/jobs',
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { customerPhotoKey: r2Key, catalogItemId: item.id },
      });
      expect(jobRes.statusCode).toBe(413);
      expect(jobRes.json().error.message).toContain('MB limit');
    } finally {
      await app.redis.del('config:system');
    }
  });
```

(Match the exact `/v1/kiosk/jobs` URL/payload field names to this file's existing happy-path test — `seedCatalogItem`'s returned shape and the real job-creation payload may use a different field name than `catalogItemId`; check the file around its existing `it(...)` block for the real request shape.)

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @tryme/api exec vitest run test/integration/kiosk-jobs.test.ts -t "admin-configured limit"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/kiosk/jobs.routes.ts apps/api/test/integration/kiosk-jobs.test.ts
git commit -m "feat(api): make kiosk upload limit admin-configurable"
```

---

### Task 8: Dev API upload (`dev/routes.ts`, 2 handlers)

**Files:**
- Modify: `apps/api/src/modules/dev/routes.ts:20-21,121-193,258-315`
- Test: `apps/api/test/dev-tryon-create.test.ts`, `apps/api/test/dev-saree-mannequin-create.test.ts`

`MAX_FILE_BYTES` is used 4 times across 2 route handlers (`/v1/dev/tryon` starting at line 121, `/v1/dev/saree-mannequin` starting at line 258). Each handler reads the config once at the top and reuses the local variable for both its JSON-body branch and its multipart branch.

- [ ] **Step 1: Remove the module-level constant, import the reader**

Change (line 20-21, keep everything else in that import block unchanged):

```ts
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const EXT_BY_MIME = {
```

to:

```ts
const EXT_BY_MIME = {
```

Add this import alongside the file's other relative imports (near the top, e.g. right after the `AppError` import):

```ts
import { getUploadLimitBytes } from '../../lib/upload-limits-config.js';
```

- [ ] **Step 2: Update the `/v1/dev/tryon` handler**

Change the start of the handler (line 121-125):

```ts
    async (req, reply) => {
      const merchantId = req.merchantId as string;
      const merchantUserId = req.merchantUserId as string;
      const apiKeyId = req.apiKeyId as string;

      let categorySlug: string | undefined;
```

to:

```ts
    async (req, reply) => {
      const merchantId = req.merchantId as string;
      const merchantUserId = req.merchantUserId as string;
      const apiKeyId = req.apiKeyId as string;
      const maxFileBytes = await getUploadLimitBytes(req.server, 'devApiMaxBytes');

      let categorySlug: string | undefined;
```

Then within that same handler, replace every remaining `MAX_FILE_BYTES` reference with `maxFileBytes` — there are 3 more in this handler (JSON-body size check + its error message at lines 144/148, and the `req.parts({ limits: { fileSize: MAX_FILE_BYTES, files: 2 } })` call at line 166):

```ts
          if (buf.length === 0 || buf.length > MAX_FILE_BYTES) {
            throw new AppError(
              'VALIDATION',
              400,
              `${fieldname} exceeds the ${MAX_FILE_BYTES / (1024 * 1024)}MB limit`,
            );
          }
```
→
```ts
          if (buf.length === 0 || buf.length > maxFileBytes) {
            throw new AppError(
              'VALIDATION',
              400,
              `${fieldname} exceeds the ${maxFileBytes / (1024 * 1024)}MB limit`,
            );
          }
```

```ts
        const parts = req.parts({ limits: { fileSize: MAX_FILE_BYTES, files: 2 } });
```
→
```ts
        const parts = req.parts({ limits: { fileSize: maxFileBytes, files: 2 } });
```

and its two `part.toBuffer()`/`part.file.truncated` error messages (originally lines 175-186 in the multipart branch) — replace `MAX_FILE_BYTES` with `maxFileBytes` in both:

```ts
          const buf = await part.toBuffer().catch(() => {
            throw new AppError(
              'VALIDATION',
              400,
              `${part.fieldname} exceeds the ${MAX_FILE_BYTES / (1024 * 1024)}MB limit`,
            );
          });
          if (part.file.truncated) {
            throw new AppError(
              'VALIDATION',
              400,
              `${part.fieldname} exceeds the ${MAX_FILE_BYTES / (1024 * 1024)}MB limit`,
            );
          }
```
→
```ts
          const buf = await part.toBuffer().catch(() => {
            throw new AppError(
              'VALIDATION',
              400,
              `${part.fieldname} exceeds the ${maxFileBytes / (1024 * 1024)}MB limit`,
            );
          });
          if (part.file.truncated) {
            throw new AppError(
              'VALIDATION',
              400,
              `${part.fieldname} exceeds the ${maxFileBytes / (1024 * 1024)}MB limit`,
            );
          }
```

- [ ] **Step 3: Update the `/v1/dev/saree-mannequin` handler**

Change the start of the handler (line 258-263):

```ts
    async (req, reply) => {
      const merchantId = req.merchantId as string;
      const merchantUserId = req.merchantUserId as string;
      const apiKeyId = req.apiKeyId as string;

      let garmentFile: { buf: Buffer; mime: string } | undefined;
```

to:

```ts
    async (req, reply) => {
      const merchantId = req.merchantId as string;
      const merchantUserId = req.merchantUserId as string;
      const apiKeyId = req.apiKeyId as string;
      const maxFileBytes = await getUploadLimitBytes(req.server, 'devApiMaxBytes');

      let garmentFile: { buf: Buffer; mime: string } | undefined;
```

Then within this handler, replace the remaining 5 `MAX_FILE_BYTES` references (JSON-body check at lines 278-282, `req.parts` call at line 291, and the multipart `toBuffer()`/`truncated` checks) with `maxFileBytes` the same way as Step 2 — same substitution pattern, same file, different handler.

- [ ] **Step 4: Confirm no `MAX_FILE_BYTES` references remain**

```bash
grep -n "MAX_FILE_BYTES" apps/api/src/modules/dev/routes.ts
```

Expected: no output.

- [ ] **Step 5: Add regression tests**

In `apps/api/test/dev-tryon-create.test.ts`, add (reusing the file's existing `form()`, `post()`, `base`, `key` helpers/variables):

```ts
describe('POST /v1/dev/tryon upload limit', () => {
  afterEach(async () => {
    await app.redis.del('config:system');
  });

  it('rejects a garment file above the admin-configured limit', async () => {
    await app.redis.set('config:system', JSON.stringify({ uploadLimits: { devApiMaxBytes: 10 } }));
    const res = await post(form({ garment: Buffer.alloc(1024) }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain('MB limit');
  });
});
```

In `apps/api/test/dev-saree-mannequin-create.test.ts`, check that file's existing helper names first (it likely has its own `form()`/`post()` equivalents targeting `/v1/dev/saree-mannequin` instead of `/v1/dev/tryon`) and add the equivalent test using its actual helpers:

```bash
grep -n "^function \|^const post\|^const form" apps/api/test/dev-saree-mannequin-create.test.ts
```

Then add a test of the same shape as above, calling that file's real request-building helper with an oversized `garment` buffer and a `config:system` override of `{ uploadLimits: { devApiMaxBytes: 10 } }`, asserting a 400 with `'MB limit'` in the message.

- [ ] **Step 6: Run both test files**

Run: `pnpm --filter @tryme/api exec vitest run test/dev-tryon-create.test.ts test/dev-saree-mannequin-create.test.ts`
Expected: all PASS, including the two new cases.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/dev/routes.ts apps/api/test/dev-tryon-create.test.ts apps/api/test/dev-saree-mannequin-create.test.ts
git commit -m "feat(api): make dev API upload limit admin-configurable"
```

---

### Task 9: Shopify catalogue source image (`shopify/catalog.routes.ts`)

**Files:**
- Modify: `apps/api/src/modules/shopify/catalog.routes.ts` (the `MAX_GARMENT_SOURCE_BYTES` constant and `downloadProductImageToR2` function)
- Test: `apps/api/test/shopify-catalog-generate.test.ts`

- [ ] **Step 1: Remove the constant, use the reader inside the function**

Find:

```ts
const MAX_GARMENT_SOURCE_BYTES = 20 * 1024 * 1024;

/** Mirrors PATCH /v1/shopify/products/:id's download-to-R2 logic (products.routes.ts):
 *  20MB cap, 10s abort timeout, no-redirect fetch. Namespaced by store+product so
 *  concurrent generations across stores/products never collide on the same key. */
async function downloadProductImageToR2(
  app: FastifyInstance,
  storeId: string,
  shopifyProductId: number,
  sourceImageUrl: string,
): Promise<string> {
  assertShopifyCdn(sourceImageUrl);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  let res: Response;
  try {
    res = await fetch(sourceImageUrl, { redirect: 'error', signal: controller.signal });
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') {
      throw new AppError('SHOPIFY', 504, 'timed out downloading the selected product image');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) throw new AppError('SHOPIFY', 502, 'failed to download the selected product image');
  const contentLength = res.headers.get('content-length');
  if (contentLength && parseInt(contentLength, 10) > MAX_GARMENT_SOURCE_BYTES) {
    throw new AppError(
      'BAD_REQUEST',
      400,
      `source image exceeds ${MAX_GARMENT_SOURCE_BYTES / (1024 * 1024)}MB`,
    );
  }
  const arrayBuffer = await res.arrayBuffer();
  if (arrayBuffer.byteLength > MAX_GARMENT_SOURCE_BYTES) {
    throw new AppError(
      'BAD_REQUEST',
      400,
      `source image exceeds ${MAX_GARMENT_SOURCE_BYTES / (1024 * 1024)}MB`,
    );
  }
```

Replace with:

```ts
/** Mirrors PATCH /v1/shopify/products/:id's download-to-R2 logic (products.routes.ts):
 *  admin-configured cap (default 20MB), 10s abort timeout, no-redirect fetch.
 *  Namespaced by store+product so concurrent generations across stores/products
 *  never collide on the same key. */
async function downloadProductImageToR2(
  app: FastifyInstance,
  storeId: string,
  shopifyProductId: number,
  sourceImageUrl: string,
): Promise<string> {
  assertShopifyCdn(sourceImageUrl);
  const maxSourceBytes = await getUploadLimitBytes(app, 'shopifyCatalogSourceMaxBytes');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  let res: Response;
  try {
    res = await fetch(sourceImageUrl, { redirect: 'error', signal: controller.signal });
  } catch (err) {
    if ((err as { name?: string }).name === 'AbortError') {
      throw new AppError('SHOPIFY', 504, 'timed out downloading the selected product image');
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
  if (!res.ok) throw new AppError('SHOPIFY', 502, 'failed to download the selected product image');
  const contentLength = res.headers.get('content-length');
  if (contentLength && parseInt(contentLength, 10) > maxSourceBytes) {
    throw new AppError(
      'BAD_REQUEST',
      400,
      `source image exceeds ${maxSourceBytes / (1024 * 1024)}MB`,
    );
  }
  const arrayBuffer = await res.arrayBuffer();
  if (arrayBuffer.byteLength > maxSourceBytes) {
    throw new AppError(
      'BAD_REQUEST',
      400,
      `source image exceeds ${maxSourceBytes / (1024 * 1024)}MB`,
    );
  }
```

Add the import alongside this file's other relative imports:

```ts
import { getUploadLimitBytes } from '../../lib/upload-limits-config.js';
```

- [ ] **Step 2: Add a regression test**

`apps/api/test/shopify-catalog-generate.test.ts` already stubs `global.fetch` to serve both `/images.json` and `cdn.shopify.com` requests (see its `beforeAll`). Add this test after the file's existing generate tests, inside its `describe` block, reusing `storeId`/`token`/`faceId`/`backgroundId`/`poseId`:

```ts
  it('rejects a source image above the admin-configured Shopify catalogue limit', async () => {
    await app.redis.set(
      'config:system',
      JSON.stringify({ uploadLimits: { shopifyCatalogSourceMaxBytes: 5 } }), // 5 bytes
    );
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/shopify/catalog/generate',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        payload: JSON.stringify({
          shopifyProductId: 1,
          sourceImageUrl: 'https://cdn.shopify.com/s/files/1/0/0/products/shirt.jpg',
          faceId,
          backgroundId,
          poseId,
        }),
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toContain('MB');
    } finally {
      await app.redis.del('config:system');
    }
  });
```

(Match the exact `/v1/shopify/catalog/generate` payload field names to this file's existing generate test(s) — check for the real request body shape used elsewhere in the file, since the fake-jpeg stub response is only 15 bytes long ("fake-jpeg-bytes"), which is enough to exceed a 5-byte configured limit either via the content-length path or the arrayBuffer-length path.)

- [ ] **Step 3: Run the test**

Run: `pnpm --filter @tryme/api exec vitest run test/shopify-catalog-generate.test.ts -t "admin-configured Shopify catalogue limit"`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/shopify/catalog.routes.ts apps/api/test/shopify-catalog-generate.test.ts
git commit -m "feat(api): make Shopify catalogue source-image limit admin-configurable"
```

---

### Task 10: Shopify storefront customer photo (`shopify/customer.routes.ts`)

**Files:**
- Modify: `apps/api/src/modules/shopify/customer.routes.ts` (imports + the inline `20 * 1024 * 1024` check around line 172)
- Test: `apps/api/test/integration/shopify-customer.test.ts`

- [ ] **Step 1: Add the import**

Add near this file's other relative imports:

```ts
import { getUploadLimitBytes } from '../../lib/upload-limits-config.js';
```

- [ ] **Step 2: Replace the inline check**

Change:

```ts
      let photoHead: { contentLength: number };
      try {
        photoHead = await app.storage.headObject(customerPhotoKey);
      } catch {
        throw new AppError('BAD_UPLOAD', 400, 'uploaded photo not found');
      }
      if (photoHead.contentLength > 20 * 1024 * 1024) {
        throw new AppError('BAD_UPLOAD', 413, 'uploaded photo exceeds 20MB limit');
      }
```

to:

```ts
      let photoHead: { contentLength: number };
      try {
        photoHead = await app.storage.headObject(customerPhotoKey);
      } catch {
        throw new AppError('BAD_UPLOAD', 400, 'uploaded photo not found');
      }
      const maxCustomerPhotoBytes = await getUploadLimitBytes(app, 'shopifyCustomerPhotoMaxBytes');
      if (photoHead.contentLength > maxCustomerPhotoBytes) {
        throw new AppError(
          'BAD_UPLOAD',
          413,
          `uploaded photo exceeds ${maxCustomerPhotoBytes / (1024 * 1024)}MB limit`,
        );
      }
```

- [ ] **Step 3: Add a regression test**

Add this test to `apps/api/test/integration/shopify-customer.test.ts`, inside `describe('shopify customer routes', ...)`, reusing the file's existing `seedOwner`/`seedStore`/`seedGarment`/`uploadCustomerPhoto` helpers:

```ts
  it('rejects a customer photo above the admin-configured limit', async () => {
    const owner = await seedOwner(100);
    const store = await seedStore(owner.id);
    await seedGarment(store.id, 8);

    await app.redis.set(
      'config:system',
      JSON.stringify({ uploadLimits: { shopifyCustomerPhotoMaxBytes: 1024 } }),
    );
    try {
      const r2Key = await uploadCustomerPhoto(store.storeKey, Buffer.alloc(2048));

      const res = await app.inject({
        method: 'POST',
        url: '/v1/shopify/customer/jobs',
        headers: { 'x-widget-key': store.storeKey },
        payload: { customerPhotoKey: r2Key, shopifyProductId: 8 },
      });
      expect(res.statusCode).toBe(413);
      expect(res.json().error.message).toContain('MB limit');
    } finally {
      await app.redis.del('config:system');
    }
  });
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @tryme/api exec vitest run test/integration/shopify-customer.test.ts -t "admin-configured limit"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/shopify/customer.routes.ts apps/api/test/integration/shopify-customer.test.ts
git commit -m "feat(api): make Shopify customer photo limit admin-configurable"
```

---

### Task 11: Shopify product-image import (`shopify/products.routes.ts`)

**Files:**
- Modify: `apps/api/src/modules/shopify/products.routes.ts` (imports + the two inline `20 * 1024 * 1024` checks around lines 154-160)
- Test: `apps/api/test/shopify-products.test.ts`

- [ ] **Step 1: Add the import**

Add near this file's other relative imports:

```ts
import { getUploadLimitBytes } from '../../lib/upload-limits-config.js';
```

- [ ] **Step 2: Replace both inline checks with one config read**

Change:

```ts
        if (!res.ok) throw new AppError('SHOPIFY', 502, 'failed to download the selected image');
        const contentLength = res.headers.get('content-length');
        if (contentLength && parseInt(contentLength, 10) > 20 * 1024 * 1024) {
          throw new AppError('BAD_REQUEST', 400, 'image exceeds 20MB');
        }
        const arrayBuffer = await res.arrayBuffer();
        if (arrayBuffer.byteLength > 20 * 1024 * 1024) {
          throw new AppError('BAD_REQUEST', 400, 'image exceeds 20MB');
        }
```

to:

```ts
        if (!res.ok) throw new AppError('SHOPIFY', 502, 'failed to download the selected image');
        const maxProductImageBytes = await getUploadLimitBytes(app, 'shopifyProductImageMaxBytes');
        const contentLength = res.headers.get('content-length');
        if (contentLength && parseInt(contentLength, 10) > maxProductImageBytes) {
          throw new AppError(
            'BAD_REQUEST',
            400,
            `image exceeds ${maxProductImageBytes / (1024 * 1024)}MB`,
          );
        }
        const arrayBuffer = await res.arrayBuffer();
        if (arrayBuffer.byteLength > maxProductImageBytes) {
          throw new AppError(
            'BAD_REQUEST',
            400,
            `image exceeds ${maxProductImageBytes / (1024 * 1024)}MB`,
          );
        }
```

- [ ] **Step 3: Add a regression test**

`apps/api/test/shopify-products.test.ts` stubs `global.fetch` per-test (see its `GET /v1/shopify/products/:id/images` test). Add this test inside its `describe('PATCH /v1/shopify/products/:id', ...)` block, reusing `storeId`/`token`:

```ts
  it('rejects a garment image above the admin-configured limit', async () => {
    const originalFetch = global.fetch;
    global.fetch = (async (url: string) => {
      if (typeof url === 'string' && url.includes('/images.json')) {
        return {
          ok: true,
          json: async () => ({ images: [{ id: 1, src: 'https://cdn.shopify.com/oversized.jpg' }] }),
        } as Response;
      }
      return {
        ok: true,
        headers: new Map([['content-type', 'image/jpeg']]),
        arrayBuffer: async () => new Uint8Array(2048).buffer,
      } as unknown as Response;
    }) as typeof fetch;

    await app.redis.set(
      'config:system',
      JSON.stringify({ uploadLimits: { shopifyProductImageMaxBytes: 1024 } }),
    );
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: '/v1/shopify/products/1',
        headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
        payload: { garmentImageUrl: 'https://cdn.shopify.com/oversized.jpg' },
      });
      expect(res.statusCode).toBe(400);
      expect(res.json().error.message).toContain('MB');
    } finally {
      await app.redis.del('config:system');
      global.fetch = originalFetch;
    }
  });
```

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @tryme/api exec vitest run test/shopify-products.test.ts -t "admin-configured limit"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/shopify/products.routes.ts apps/api/test/shopify-products.test.ts
git commit -m "feat(api): make Shopify product-image import limit admin-configurable"
```

---

### Task 12: Shopify webhook product sync (`shopify/products.sync.ts`)

**Files:**
- Modify: `apps/api/src/modules/shopify/products.sync.ts:29-30,176-182`
- Test: `apps/api/test/shopify-sync.test.ts`

- [ ] **Step 1: Remove the constant, import the reader**

Change (line 29-30):

```ts
const ALLOWED_HOSTS = /(^|\.)(myshopify\.com|shopify\.com|cdn\.shopify\.com)$/;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 10_000;
```

to:

```ts
const ALLOWED_HOSTS = /(^|\.)(myshopify\.com|shopify\.com|cdn\.shopify\.com)$/;
const FETCH_TIMEOUT_MS = 10_000;
```

Add the import at the top of the file, alongside the existing relative imports:

```ts
import { getUploadLimitBytes } from '../../lib/upload-limits-config.js';
```

- [ ] **Step 2: Update the check (inside the function that already receives `app`)**

Change (lines 176-182):

```ts
    if (!res.ok) throw new Error(`download HTTP ${res.status}`);
    const contentLength = res.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > MAX_IMAGE_BYTES) {
      throw new Error(`product image exceeds ${MAX_IMAGE_BYTES / (1024 * 1024)}MB`);
    }
    const arrayBuffer = await res.arrayBuffer();
    if (arrayBuffer.byteLength > MAX_IMAGE_BYTES) {
      throw new Error(`product image exceeds ${MAX_IMAGE_BYTES / (1024 * 1024)}MB`);
    }
```

to:

```ts
    if (!res.ok) throw new Error(`download HTTP ${res.status}`);
    const maxSyncBytes = await getUploadLimitBytes(app, 'shopifyProductSyncMaxBytes');
    const contentLength = res.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > maxSyncBytes) {
      throw new Error(`product image exceeds ${maxSyncBytes / (1024 * 1024)}MB`);
    }
    const arrayBuffer = await res.arrayBuffer();
    if (arrayBuffer.byteLength > maxSyncBytes) {
      throw new Error(`product image exceeds ${maxSyncBytes / (1024 * 1024)}MB`);
    }
```

(`app` is already in scope here — it's a parameter of the enclosing function, used elsewhere in the same function via `app.storage.putObject(...)`.)

- [ ] **Step 3: Update the existing 20MB tests to use a configurable value, and add one proving the config actually overrides the default**

The two existing tests at lines 160-192 and 194-223 ("marks failed when the content-length header exceeds the 20MB cap..." / "...actual downloaded body exceeds the 20MB cap...") still pass unmodified, since 20MB is still the default. Add one new test after them, inside `describe('syncProduct', ...)`, proving the admin override actually changes behavior (a size that would have passed under the old hardcoded 20MB now fails under a lower admin-configured cap):

```ts
  it('respects an admin-configured limit lower than the default 20MB cap', async () => {
    await app.redis.set(
      'config:system',
      JSON.stringify({ uploadLimits: { shopifyProductSyncMaxBytes: 5 } }), // 5 bytes
    );
    try {
      const fakeFetch = (async () =>
        ({
          ok: true,
          arrayBuffer: async () => new Uint8Array([1, 2, 3, 4, 5, 6]).buffer, // 6 bytes > 5
          headers: new Map([['content-type', 'image/jpeg']]),
        }) as unknown as Response) as typeof fetch;
      await syncProduct(
        app,
        storeId,
        { id: 48, title: 'Configured Limit Product', image: { src: 'https://cdn.shopify.com/c.jpg' } },
        fakeFetch,
      );
      const [row] = await app.db
        .select()
        .from(schema.shopifyProductGarments)
        .where(
          and(
            eq(schema.shopifyProductGarments.storeId, storeId),
            eq(schema.shopifyProductGarments.shopifyProductId, 48),
          ),
        );
      expect(row.status).toBe('failed');
      expect(row.failedReason).toContain('MB');
    } finally {
      await app.redis.del('config:system');
    }
  });
```

- [ ] **Step 4: Run the tests**

Run: `pnpm --filter @tryme/api exec vitest run test/shopify-sync.test.ts`
Expected: all existing tests still PASS (20MB default unchanged), plus the new one PASSes.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/shopify/products.sync.ts apps/api/test/shopify-sync.test.ts
git commit -m "feat(api): make Shopify product-sync image limit admin-configurable"
```

---

### Task 13: Admin bulk-import ZIP (`admin/models.routes.ts`) — new limit + missing truncation handling

**Files:**
- Modify: `apps/api/src/modules/admin/models.routes.ts:17-18,847-857`
- Create: `apps/api/test/integration/admin-bulk-import.test.ts`

This route currently has **no dedicated size limit at all** — it inherits whatever the global Fastify `multipart` registration allows (2.5GB, `server.ts:171`), and has no truncation check, so an oversized upload today fails with Busboy's raw internal error rather than a clean message. This task fixes both.

- [ ] **Step 1: Add the import**

Add alongside this file's existing relative imports (near `import { AppError } from '../../lib/errors.js';`):

```ts
import { getUploadLimitBytes } from '../../lib/upload-limits-config.js';
```

- [ ] **Step 2: Set an explicit `fileSize` limit and add truncation handling**

Change:

```ts
  // ── Bulk import from ZIP ──────────────────────────────────────────────────
  app.post('/admin/assets/bulk-import', { preHandler: RW }, async (req, reply) => {
    const data = await req.file();
    if (!data) throw new AppError('VALIDATION', 400, 'no file uploaded');
```

to:

```ts
  // ── Bulk import from ZIP ──────────────────────────────────────────────────
  app.post('/admin/assets/bulk-import', { preHandler: RW }, async (req, reply) => {
    const maxBulkImportBytes = await getUploadLimitBytes(app, 'bulkImportMaxBytes');
    const data = await req.file({ limits: { fileSize: maxBulkImportBytes } });
    if (!data) throw new AppError('VALIDATION', 400, 'no file uploaded');

    // Buffering below can hit the limit above; toBuffer() itself doesn't throw on
    // truncation (busboy just stops the stream early), so check the flag explicitly —
    // mirrors the same pattern already used for the /v1/dev/* multipart routes.
```

Then find:

```ts
    // Buffer the ZIP
    const zipBuffer = await data.toBuffer();
    const zip = new AdmZip(zipBuffer);
```

and change to:

```ts
    // Buffer the ZIP
    const zipBuffer = await data.toBuffer();
    if (data.file.truncated) {
      throw new AppError(
        'VALIDATION',
        413,
        `uploaded ZIP exceeds ${maxBulkImportBytes / (1024 * 1024)}MB limit`,
      );
    }
    const zip = new AdmZip(zipBuffer);
```

- [ ] **Step 3: Write the new test file**

This route has no existing test coverage at all. Create `apps/api/test/integration/admin-bulk-import.test.ts`:

```ts
import { schema } from '@tryme/db';
import AdmZip from 'adm-zip';
import { and, eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { signAccess } from '../../src/modules/auth/service.js';
import { buildTestApp, type TestApp } from '../helpers/api.js';
import { type Containers, startContainers } from '../helpers/containers.js';

const JWT_SECRET = 'test-jwt-secret-0123456789abcdef-32min';
const secret = new TextEncoder().encode(JWT_SECRET);
const CONFIG_KEY = 'config:system';

describe('POST /admin/assets/bulk-import', () => {
  let c: Containers;
  let app: TestApp;
  let adminAuth: { authorization: string };

  beforeAll(async () => {
    c = await startContainers();
    app = await buildTestApp(c);

    const [adminUser] = await app.db
      .insert(schema.users)
      .values({ email: 'bulk-admin@example.com', passwordHash: 'unused', emailVerified: true })
      .returning();
    await app.db
      .insert(schema.adminUsers)
      .values({ userId: adminUser.id, role: 'SUPER_ADMIN' });
    const token = await signAccess(
      secret,
      adminUser.id,
      { kind: 'access', admin: true },
      '15m',
    );
    adminAuth = { authorization: `Bearer ${token}` };
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await c?.stop();
  });

  afterEach(async () => {
    await app.redis.del(CONFIG_KEY);
  });

  function zipWithEntry(entryName: string, content: Buffer): Buffer {
    const zip = new AdmZip();
    zip.addFile(entryName, content);
    return zip.toBuffer();
  }

  it('rejects a ZIP above the admin-configured bulk-import limit', async () => {
    await app.redis.set(CONFIG_KEY, JSON.stringify({ uploadLimits: { bulkImportMaxBytes: 100 } }));

    const zipBuf = zipWithEntry('backgrounds/bg1.jpg', Buffer.alloc(1000, 1));
    const form = new FormData();
    form.set('file', new Blob([zipBuf], { type: 'application/zip' }), 'assets.zip');

    await app.ready();
    const addr = app.server.address();
    const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    const res = await fetch(`${base}/admin/assets/bulk-import`, {
      method: 'POST',
      headers: adminAuth,
      body: form,
    });
    expect(res.status).toBe(413);
    const body = await res.json();
    expect(body.error.message).toContain('MB limit');
  });

  it('accepts a ZIP within the admin-configured bulk-import limit', async () => {
    await app.redis.set(
      CONFIG_KEY,
      JSON.stringify({ uploadLimits: { bulkImportMaxBytes: 10 * 1024 * 1024 } }),
    );

    const zipBuf = zipWithEntry('backgrounds/bg2.jpg', Buffer.alloc(1000, 1));
    const form = new FormData();
    form.set('file', new Blob([zipBuf], { type: 'application/zip' }), 'assets.zip');
    form.set('genderSlug', 'men');

    await app.ready();
    const addr = app.server.address();
    const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    const res = await fetch(`${base}/admin/assets/bulk-import`, {
      method: 'POST',
      headers: adminAuth,
      body: form,
    });
    expect(res.status).toBe(200);
  });
});
```

Note: `req.file()`'s multipart parser needs a real streaming HTTP request body (not Fastify's `.inject()`, which is documented in `CLAUDE.md` as unreliable for streaming — hence using raw `fetch()` against `app.server.address()`, the same pattern this codebase already uses for SSE tests). If `schema.adminUsers`'s actual column names differ from `userId`/`role` (check `packages/db/src/schema/` for the real `adminUsers` table shape) or the real admin-auth-token shape used elsewhere in this test suite differs from `signAccess(..., { kind: 'access', admin: true }, ...)`, match whatever `apps/api/test/integration/admin-workflows.test.ts` or a similar existing admin-route test file actually uses to build its admin auth header, and use that instead — grep for it first:

```bash
grep -n "adminUsers\|SUPER_ADMIN\|signAccess" apps/api/test/integration/admin-workflows.test.ts | head -20
```

- [ ] **Step 4: Run the new test**

Run: `pnpm --filter @tryme/api exec vitest run test/integration/admin-bulk-import.test.ts`
Expected: both tests PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/admin/models.routes.ts apps/api/test/integration/admin-bulk-import.test.ts
git commit -m "feat(api): add admin-configurable bulk-import size limit with truncation handling"
```

---

### Task 14: Admin-web Settings UI

**Files:**
- Modify: `apps/admin-web/src/pages/SettingsPage.tsx`

- [ ] **Step 1: Add state for all 10 fields**

Find (around line 388, right after `tryonCreditCost`):

```ts
  const [tryonCreditCost, setTryonCreditCost] = useState(5);
  const [sysLoading, setSysLoading] = useState(true);
  const [sysSaving, setSysSaving] = useState(false);
```

Change to:

```ts
  const [tryonCreditCost, setTryonCreditCost] = useState(5);
  const [uploadLimitsMb, setUploadLimitsMb] = useState({
    merchantCatalogMaxBytes: 20,
    webGarmentMaxBytes: 20,
    merchantTryonMaxBytes: 20,
    kioskUploadMaxBytes: 20,
    devApiMaxBytes: 20,
    shopifyCatalogSourceMaxBytes: 20,
    shopifyCustomerPhotoMaxBytes: 20,
    shopifyProductImageMaxBytes: 20,
    shopifyProductSyncMaxBytes: 20,
  });
  const [bulkImportMaxGb, setBulkImportMaxGb] = useState(2.5);
  const [sysLoading, setSysLoading] = useState(true);
  const [sysSaving, setSysSaving] = useState(false);
```

(State is kept in MB/GB for display — converted to/from bytes only at load/save time, since raw byte values like `20971520` aren't human-friendly in a form.)

- [ ] **Step 2: Load `uploadLimits` in the existing config-fetch effect**

Find (around line 400):

```ts
  useEffect(() => {
    apiFetch<{
      resolutions?: Record<string, { enabled: boolean; creditCost: number }>;
      maxOutputPx?: number;
      merchantCatalogDefaults?: Record<string, { faceId: string; backgroundId: string }>;
      merchantCatalogAspectRatio?: string;
      tryon?: { creditCost: number };
    }>('/admin/config')
      .then((cfg) => {
        if (cfg.resolutions) setResolutions(cfg.resolutions);
        if (cfg.maxOutputPx) setMaxOutputPx(cfg.maxOutputPx);
        if (cfg.merchantCatalogDefaults) setMerchantCatalogDefaults(cfg.merchantCatalogDefaults);
        if (cfg.merchantCatalogAspectRatio)
          setMerchantCatalogAspectRatio(cfg.merchantCatalogAspectRatio);
        if (cfg.tryon) setTryonCreditCost(cfg.tryon.creditCost);
      })
```

Change to:

```ts
  useEffect(() => {
    apiFetch<{
      resolutions?: Record<string, { enabled: boolean; creditCost: number }>;
      maxOutputPx?: number;
      merchantCatalogDefaults?: Record<string, { faceId: string; backgroundId: string }>;
      merchantCatalogAspectRatio?: string;
      tryon?: { creditCost: number };
      uploadLimits?: Record<string, number>;
    }>('/admin/config')
      .then((cfg) => {
        if (cfg.resolutions) setResolutions(cfg.resolutions);
        if (cfg.maxOutputPx) setMaxOutputPx(cfg.maxOutputPx);
        if (cfg.merchantCatalogDefaults) setMerchantCatalogDefaults(cfg.merchantCatalogDefaults);
        if (cfg.merchantCatalogAspectRatio)
          setMerchantCatalogAspectRatio(cfg.merchantCatalogAspectRatio);
        if (cfg.tryon) setTryonCreditCost(cfg.tryon.creditCost);
        if (cfg.uploadLimits) {
          const bytesToMb = (b: number) => Math.round((b / (1024 * 1024)) * 100) / 100;
          setUploadLimitsMb({
            merchantCatalogMaxBytes: bytesToMb(cfg.uploadLimits.merchantCatalogMaxBytes ?? 20 * 1024 * 1024),
            webGarmentMaxBytes: bytesToMb(cfg.uploadLimits.webGarmentMaxBytes ?? 20 * 1024 * 1024),
            merchantTryonMaxBytes: bytesToMb(cfg.uploadLimits.merchantTryonMaxBytes ?? 20 * 1024 * 1024),
            kioskUploadMaxBytes: bytesToMb(cfg.uploadLimits.kioskUploadMaxBytes ?? 20 * 1024 * 1024),
            devApiMaxBytes: bytesToMb(cfg.uploadLimits.devApiMaxBytes ?? 20 * 1024 * 1024),
            shopifyCatalogSourceMaxBytes: bytesToMb(
              cfg.uploadLimits.shopifyCatalogSourceMaxBytes ?? 20 * 1024 * 1024,
            ),
            shopifyCustomerPhotoMaxBytes: bytesToMb(
              cfg.uploadLimits.shopifyCustomerPhotoMaxBytes ?? 20 * 1024 * 1024,
            ),
            shopifyProductImageMaxBytes: bytesToMb(
              cfg.uploadLimits.shopifyProductImageMaxBytes ?? 20 * 1024 * 1024,
            ),
            shopifyProductSyncMaxBytes: bytesToMb(
              cfg.uploadLimits.shopifyProductSyncMaxBytes ?? 20 * 1024 * 1024,
            ),
          });
          const bytesToGb = (b: number) => Math.round((b / (1024 * 1024 * 1024)) * 100) / 100;
          setBulkImportMaxGb(
            bytesToGb(cfg.uploadLimits.bulkImportMaxBytes ?? 2.5 * 1024 * 1024 * 1024),
          );
        }
      })
```

- [ ] **Step 3: Include `uploadLimits` in the save payload**

Find (around line 436):

```ts
  const saveSysConfig = async () => {
    setSysSaving(true);
    try {
      await apiFetch('/admin/config', {
        method: 'PATCH',
        body: JSON.stringify({
          resolutions,
          maxOutputPx,
          merchantCatalogDefaults,
          merchantCatalogAspectRatio,
          tryon: { creditCost: tryonCreditCost },
        }),
      });
```

Change to:

```ts
  const saveSysConfig = async () => {
    setSysSaving(true);
    try {
      const mbToBytes = (mb: number) => Math.round(mb * 1024 * 1024);
      const gbToBytes = (gb: number) => Math.round(gb * 1024 * 1024 * 1024);
      await apiFetch('/admin/config', {
        method: 'PATCH',
        body: JSON.stringify({
          resolutions,
          maxOutputPx,
          merchantCatalogDefaults,
          merchantCatalogAspectRatio,
          tryon: { creditCost: tryonCreditCost },
          uploadLimits: {
            merchantCatalogMaxBytes: mbToBytes(uploadLimitsMb.merchantCatalogMaxBytes),
            webGarmentMaxBytes: mbToBytes(uploadLimitsMb.webGarmentMaxBytes),
            merchantTryonMaxBytes: mbToBytes(uploadLimitsMb.merchantTryonMaxBytes),
            kioskUploadMaxBytes: mbToBytes(uploadLimitsMb.kioskUploadMaxBytes),
            devApiMaxBytes: mbToBytes(uploadLimitsMb.devApiMaxBytes),
            shopifyCatalogSourceMaxBytes: mbToBytes(uploadLimitsMb.shopifyCatalogSourceMaxBytes),
            shopifyCustomerPhotoMaxBytes: mbToBytes(uploadLimitsMb.shopifyCustomerPhotoMaxBytes),
            shopifyProductImageMaxBytes: mbToBytes(uploadLimitsMb.shopifyProductImageMaxBytes),
            shopifyProductSyncMaxBytes: mbToBytes(uploadLimitsMb.shopifyProductSyncMaxBytes),
            bulkImportMaxBytes: gbToBytes(bulkImportMaxGb),
          },
        }),
      });
```

- [ ] **Step 4: Add the UI section**

Find the closing of the "Virtual Try-On Pricing" block (the `</div>` right after the `tryonCreditCost` input's wrapping `<div>`, immediately before `<div style={{ marginTop: 24, marginBottom: 8 }}>` that starts "Merchant Catalogue Defaults" — this is the same block already read from lines 1085-1123). Insert a new section immediately after it, before "Merchant Catalogue Defaults":

```tsx
                <div style={{ marginTop: 24, marginBottom: 8 }}>
                  <div className="setting-lbl" style={{ marginBottom: 4 }}>
                    Upload Limits
                  </div>
                  <div className="setting-desc" style={{ marginBottom: 12 }}>
                    Maximum accepted file size per upload surface. Existing uploads already in
                    progress are unaffected; this only applies to uploads made after saving.
                  </div>
                  {(
                    [
                      ['merchantCatalogMaxBytes', 'Merchant catalogue (Android flat photo)'],
                      ['webGarmentMaxBytes', 'Studio / web garment upload'],
                      ['merchantTryonMaxBytes', 'Merchant try-on customer photo'],
                      ['kioskUploadMaxBytes', 'Kiosk customer photo'],
                      ['devApiMaxBytes', 'Dev API upload'],
                      ['shopifyCatalogSourceMaxBytes', 'Shopify catalogue source image'],
                      ['shopifyCustomerPhotoMaxBytes', 'Shopify storefront customer photo'],
                      ['shopifyProductImageMaxBytes', 'Shopify product-image import'],
                      ['shopifyProductSyncMaxBytes', 'Shopify webhook product sync'],
                    ] as const
                  ).map(([key, label]) => (
                    <div
                      key={key}
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 12,
                        padding: '10px 12px',
                        marginBottom: 8,
                        border: '1px solid var(--border)',
                        borderRadius: 'var(--r)',
                        background: 'var(--surface-2)',
                      }}
                    >
                      <span className="setting-lbl">{label}</span>
                      <div
                        style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}
                      >
                        <input
                          className="input"
                          type="number"
                          min={0}
                          max={50}
                          step={0.1}
                          style={{ width: 80, textAlign: 'right' }}
                          value={uploadLimitsMb[key]}
                          disabled={sysSaving}
                          onChange={(e) =>
                            setUploadLimitsMb((prev) => ({
                              ...prev,
                              [key]: Number(e.target.value),
                            }))
                          }
                        />
                        <span style={{ fontSize: 13, color: 'var(--muted)' }}>MB</span>
                      </div>
                    </div>
                  ))}
                  <div
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 12,
                      padding: '10px 12px',
                      border: '1px solid var(--border)',
                      borderRadius: 'var(--r)',
                      background: 'var(--surface-2)',
                    }}
                  >
                    <span className="setting-lbl">Admin bulk-import ZIP</span>
                    <div
                      style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}
                    >
                      <input
                        className="input"
                        type="number"
                        min={0}
                        max={3}
                        step={0.1}
                        style={{ width: 80, textAlign: 'right' }}
                        value={bulkImportMaxGb}
                        disabled={sysSaving}
                        onChange={(e) => setBulkImportMaxGb(Number(e.target.value))}
                      />
                      <span style={{ fontSize: 13, color: 'var(--muted)' }}>GB</span>
                    </div>
                  </div>
                </div>

```

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @tryme/admin exec tsc -b`
Expected: no errors.

- [ ] **Step 6: Manual verification**

Run: `pnpm --filter @tryme/admin dev`, log in as an admin, navigate to Settings, confirm:
- The new "Upload Limits" section renders 10 rows with the correct labels and current values (20 for the 9 MB fields, 2.5 for the GB field).
- Changing a value and clicking Save persists it (reload the page and confirm the new value is shown).

- [ ] **Step 7: Commit**

```bash
git add apps/admin-web/src/pages/SettingsPage.tsx
git commit -m "feat(admin-web): add Upload Limits section to Settings page"
```

---

### Task 15: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Full monorepo typecheck**

Run: `pnpm -r --filter "!@tryme/admin-mobile" run typecheck`
Expected: no errors.

- [ ] **Step 2: Biome check**

Run: `pnpm biome check .`
Expected: no errors (warnings only, matching this repo's existing baseline).

- [ ] **Step 3: Run every touched test file together**

Run:
```bash
pnpm --filter @tryme/api exec vitest run \
  test/integration/uploads.test.ts \
  test/integration/merchant-catalog-generate.test.ts \
  test/integration/merchant-tryon.test.ts \
  test/integration/kiosk-jobs.test.ts \
  test/dev-tryon-create.test.ts \
  test/dev-saree-mannequin-create.test.ts \
  test/shopify-catalog-generate.test.ts \
  test/integration/shopify-customer.test.ts \
  test/shopify-products.test.ts \
  test/shopify-sync.test.ts \
  test/integration/admin-bulk-import.test.ts
```
Expected: all PASS.

- [ ] **Step 4: Update `docs/progress.md`**

Add a new dated entry at the top of the log (per `CLAUDE.md`'s Progress Tracking rule) summarizing what was done, any failures/gaps, and open questions (e.g., note the manual admin-web walkthrough from Task 14 Step 6 if it wasn't actually run in this environment).

- [ ] **Step 5: Commit**

```bash
git add docs/progress.md
git commit -m "docs: record admin-configurable upload limits rollout"
```

---

## Self-Review Notes

- **Spec coverage**: all 10 fields from the design are covered (Tasks 4-13), schema + reader + admin route wiring (Tasks 1-3), UI (Task 14), verification (Task 15).
- **Type consistency**: `UploadLimitKey` (Task 2) is used identically as the second argument to `getUploadLimitBytes` in every one of Tasks 4-13; the `SystemConfigBody.uploadLimits` field names (Task 1) match `DEFAULT_UPLOAD_LIMITS`'s keys (Task 2) and the admin-web state object's keys (Task 14) exactly.
- **Known follow-ups intentionally left to the implementer to verify against real file state at execution time** (flagged inline in the relevant tasks, not placeholders — these are places where the plan tells you exactly what to check and why): the exact request payload shape for a few routes whose full body I didn't reconfirm byte-for-byte (Tasks 4, 6, 7, 9 note this explicitly with a `grep` command to find the real shape before writing the test), and the real `adminUsers`/admin-auth-token shape for Task 13's new test file.
