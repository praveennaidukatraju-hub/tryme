# Merchant Catalogue Defaults — Lower Garment & Shoe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let admins configure a default lower garment and default shoe per gender category (men/women/boys/girls) for merchant-catalogue-generated jobs, applied only when the assigned pose's workflow actually needs one.

**Architecture:** Extend the existing per-category `merchantCatalogDefaults` Redis config (already holds `faceId`/`backgroundId`) with two new optional fields. `createMerchantCatalogJob` gains a hasLower/hasShoes check — mirroring the `poseGarmentConfigs` → `workflowTemplates` lookup `apps/api/src/modules/jobs/create.ts` already uses — and only requires/applies the configured defaults when the fixed pose's workflow needs them. No DB migration: `catalogItems`, `garmentSubcategories`, `poseGarmentConfigs`, and `workflowTemplates` already carry everything needed.

**Tech Stack:** Fastify 5, Drizzle ORM, Zod (`@tryme/types`), Vitest integration tests (real Postgres/Redis/MinIO via `apps/api/test/helpers/containers.ts`), React + Vite admin panel.

**Reference spec:** `docs/superpowers/specs/2026-07-27-merchant-catalogue-lower-shoe-defaults-design.md`

---

### Task 1: Config schema — accept lowerCatalogId/shoeCatalogId

**Files:**
- Modify: `packages/types/src/admin.ts:85-90`
- Test: `apps/api/test/integration/admin-config.test.ts`

- [ ] **Step 1: Write the failing test**

Add this test inside the existing `describe('admin config', ...)` block in `apps/api/test/integration/admin-config.test.ts`, after the existing `it(...)` block (before the closing `});` of the describe):

```ts
  it('PATCH accepts merchantCatalogDefaults with lowerCatalogId and shoeCatalogId', async () => {
    const patchRes = await app.inject({
      method: 'PATCH',
      url: '/admin/config',
      headers: { ...adminAuth, 'content-type': 'application/json' },
      payload: JSON.stringify({
        merchantCatalogDefaults: {
          men: {
            faceId: '11111111-1111-1111-1111-111111111111',
            backgroundId: '22222222-2222-2222-2222-222222222222',
            lowerCatalogId: '33333333-3333-3333-3333-333333333333',
            shoeCatalogId: '44444444-4444-4444-4444-444444444444',
          },
        },
      }),
    });
    expect(patchRes.statusCode).toBe(200);

    const getRes = await app.inject({ method: 'GET', url: '/admin/config', headers: adminAuth });
    expect(getRes.json().merchantCatalogDefaults.men.lowerCatalogId).toBe(
      '33333333-3333-3333-3333-333333333333',
    );
    expect(getRes.json().merchantCatalogDefaults.men.shoeCatalogId).toBe(
      '44444444-4444-4444-4444-444444444444',
    );
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- admin-config`
Expected: FAIL — the PATCH returns 400 because `lowerCatalogId`/`shoeCatalogId` aren't in the Zod schema yet (`SystemConfigBody` rejects unknown-shape fields on the `merchantCatalogDefaults` record's object values).

- [ ] **Step 3: Write minimal implementation**

In `packages/types/src/admin.ts`, replace lines 85-90:

```ts
  merchantCatalogDefaults: z
    .record(
      z.enum(['men', 'women', 'boys', 'girls']),
      z.object({ faceId: z.string().uuid(), backgroundId: z.string().uuid() }),
    )
    .optional(),
```

with:

```ts
  merchantCatalogDefaults: z
    .record(
      z.enum(['men', 'women', 'boys', 'girls']),
      z.object({
        faceId: z.string().uuid(),
        backgroundId: z.string().uuid(),
        lowerCatalogId: z.string().uuid().optional(),
        shoeCatalogId: z.string().uuid().optional(),
      }),
    )
    .optional(),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @tryme/api test -- admin-config`
Expected: PASS (both the new test and the pre-existing upload-limits test in the same file).

- [ ] **Step 5: Commit**

```bash
git add packages/types/src/admin.ts apps/api/test/integration/admin-config.test.ts
git commit -m "feat(types): accept lower/shoe catalog ids in merchant catalogue defaults"
```

---

### Task 2: createMerchantCatalogJob — resolve and validate lower/shoe only when the pose needs them

**Files:**
- Modify: `apps/api/src/modules/merchant/create-job.ts`
- Test: `apps/api/test/integration/merchant-catalog-generate.test.ts`

- [ ] **Step 1: Add test helpers**

In `apps/api/test/integration/merchant-catalog-generate.test.ts`, add these two helpers right after the existing `seedWorkflowTemplate` function (after line 64):

```ts
async function seedWorkflowTemplateWithLowerShoe(
  app: TestApp,
  lowerNodeId: string | null,
  shoeNodeId: string | null,
) {
  const [wf] = await app.db
    .insert(schema.workflowTemplates)
    .values({
      slug: `regular-wf-lowershoe-${randomUUID()}`,
      label: 'Regular workflow with lower/shoe',
      jsonContent: {},
      faceNodeId: '1',
      poseNodeId: '1',
      bgNodeId: '1',
      upperNodeIds: ['2'],
      lowerNodeId,
      shoeNodeId,
      facePhasePromptNode: '1',
      garmentPhasePromptNode: '1',
    })
    .returning();
  return wf;
}

async function seedCatalogItem(
  app: TestApp,
  type: 'lower' | 'shoe',
  genderSlug: string,
  isActive = true,
) {
  const [item] = await app.db
    .insert(schema.catalogItems)
    .values({
      type,
      genderSlug,
      label: `${type} ${randomUUID()}`,
      r2Key: `catalog/${type}/${randomUUID()}.jpg`,
      thumbnailKey: `catalog/${type}/${randomUUID()}.thumb.jpg`,
      isActive,
    })
    .returning();
  return item;
}
```

- [ ] **Step 2: Write the failing tests**

Add these four tests inside the top-level `describe('merchant catalog generate (single, Path B)', ...)` block in the same file, right after the `it('rejects with 400 when no merchantCatalogDefaults are configured for the category', ...)` block (after line 379, before the `it('marks a completed job COMPLETED...` block):

```ts
  it("applies configured default lower garment and shoe when the pose's workflow needs them", async () => {
    const { userId } = await createMerchant(app, 'lower-shoe-happy@example.com');
    await grantUserCredits(app, userId, 100);
    const auth = await authHeader(userId);
    const wf = await seedWorkflowTemplateWithLowerShoe(app, '3', '4');
    const pose = await seedPose(app, 'men', wf.id);
    const face = await seedFace(app, 'men');
    const bg = await seedBackground(app);
    const garmentType = await seedGarmentType(app, 'men', pose.id);
    const lowerItem = await seedCatalogItem(app, 'lower', 'men');
    const shoeItem = await seedCatalogItem(app, 'shoe', 'men');
    await app.redis.set(
      CONFIG_KEY,
      JSON.stringify({
        merchantCatalogDefaults: {
          men: {
            faceId: face.id,
            backgroundId: bg.id,
            lowerCatalogId: lowerItem.id,
            shoeCatalogId: shoeItem.id,
          },
        },
        merchantCatalogAspectRatio: '2:3',
      }),
    );

    const subcatRes = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/subcategories',
      headers: auth,
      payload: { category: 'men', name: 'Shirts', garmentSubcategoryId: garmentType.id },
    });
    const subcategoryId = (subcatRes.json() as { id: string }).id;

    const presign = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/presign',
      headers: auth,
      payload: { kind: 'flat', contentType: 'image/jpeg', contentLength: 4 },
    });
    const { r2Key: flatImageKey, uploadUrl } = presign.json() as {
      r2Key: string;
      uploadUrl: string;
    };
    await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg' },
      body: Buffer.from('flat'),
    });

    const generate = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/generate',
      headers: auth,
      payload: { subcategoryId, flatImageKey },
    });
    expect(generate.statusCode).toBe(201);
    const { jobId } = generate.json() as { jobId: string };

    const [inputs] = await app.db
      .select()
      .from(schema.jobInputs)
      .where(eq(schema.jobInputs.jobId, jobId));
    expect(inputs.lowerCatalogId).toBe(lowerItem.id);
    expect(inputs.shoeCatalogId).toBe(shoeItem.id);
  });

  it('rejects with 400 when the pose needs a lower garment but no default lower catalog item is configured', async () => {
    const { userId } = await createMerchant(app, 'lower-shoe-missing@example.com');
    await grantUserCredits(app, userId, 100);
    const auth = await authHeader(userId);
    const wf = await seedWorkflowTemplateWithLowerShoe(app, '3', null);
    const pose = await seedPose(app, 'men', wf.id);
    const face = await seedFace(app, 'men');
    const bg = await seedBackground(app);
    const garmentType = await seedGarmentType(app, 'men', pose.id);
    await app.redis.set(
      CONFIG_KEY,
      JSON.stringify({
        merchantCatalogDefaults: { men: { faceId: face.id, backgroundId: bg.id } },
        merchantCatalogAspectRatio: '2:3',
      }),
    );

    const subcatRes = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/subcategories',
      headers: auth,
      payload: { category: 'men', name: 'Shirts', garmentSubcategoryId: garmentType.id },
    });
    const subcategoryId = (subcatRes.json() as { id: string }).id;

    const generate = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/generate',
      headers: auth,
      payload: { subcategoryId, flatImageKey: 'merchant-catalog/x/flat/y/garment.jpg' },
    });
    expect(generate.statusCode).toBe(400);
    expect(generate.json().error.message).toContain('default lower garment');
  });

  it("does not apply configured lower/shoe defaults when the pose's workflow does not need them", async () => {
    const { userId } = await createMerchant(app, 'lower-shoe-unneeded@example.com');
    await grantUserCredits(app, userId, 100);
    const auth = await authHeader(userId);
    const { garmentType, face, bg } = await seedFullDefaults('women');
    const lowerItem = await seedCatalogItem(app, 'lower', 'women');
    const shoeItem = await seedCatalogItem(app, 'shoe', 'women');
    await app.redis.set(
      CONFIG_KEY,
      JSON.stringify({
        merchantCatalogDefaults: {
          women: {
            faceId: face.id,
            backgroundId: bg.id,
            lowerCatalogId: lowerItem.id,
            shoeCatalogId: shoeItem.id,
          },
        },
        merchantCatalogAspectRatio: '2:3',
      }),
    );

    const subcatRes = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/subcategories',
      headers: auth,
      payload: { category: 'women', name: 'Sarees', garmentSubcategoryId: garmentType.id },
    });
    const subcategoryId = (subcatRes.json() as { id: string }).id;

    const presign = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/presign',
      headers: auth,
      payload: { kind: 'flat', contentType: 'image/jpeg', contentLength: 4 },
    });
    const { r2Key: flatImageKey, uploadUrl } = presign.json() as {
      r2Key: string;
      uploadUrl: string;
    };
    await fetch(uploadUrl, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg' },
      body: Buffer.from('flat'),
    });

    const generate = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/generate',
      headers: auth,
      payload: { subcategoryId, flatImageKey },
    });
    expect(generate.statusCode).toBe(201);
    const { jobId } = generate.json() as { jobId: string };

    const [inputs] = await app.db
      .select()
      .from(schema.jobInputs)
      .where(eq(schema.jobInputs.jobId, jobId));
    expect(inputs.lowerCatalogId).toBeNull();
    expect(inputs.shoeCatalogId).toBeNull();
  });

  it('rejects with 400 when the configured default lower catalog item is inactive', async () => {
    const { userId } = await createMerchant(app, 'lower-shoe-inactive@example.com');
    await grantUserCredits(app, userId, 100);
    const auth = await authHeader(userId);
    const wf = await seedWorkflowTemplateWithLowerShoe(app, '3', null);
    const pose = await seedPose(app, 'men', wf.id);
    const face = await seedFace(app, 'men');
    const bg = await seedBackground(app);
    const garmentType = await seedGarmentType(app, 'men', pose.id);
    const inactiveLower = await seedCatalogItem(app, 'lower', 'men', false);
    await app.redis.set(
      CONFIG_KEY,
      JSON.stringify({
        merchantCatalogDefaults: {
          men: { faceId: face.id, backgroundId: bg.id, lowerCatalogId: inactiveLower.id },
        },
        merchantCatalogAspectRatio: '2:3',
      }),
    );

    const subcatRes = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/subcategories',
      headers: auth,
      payload: { category: 'men', name: 'Shirts', garmentSubcategoryId: garmentType.id },
    });
    const subcategoryId = (subcatRes.json() as { id: string }).id;

    const generate = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/generate',
      headers: auth,
      payload: { subcategoryId, flatImageKey: 'merchant-catalog/x/flat/y/garment.jpg' },
    });
    expect(generate.statusCode).toBe(400);
    expect(generate.json().error.message).toContain('lower garment not found or inactive');
  });
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `pnpm --filter @tryme/api test -- merchant-catalog-generate`
Expected: the 4 new tests FAIL — `inputs.lowerCatalogId`/`shoeCatalogId` are always `null` today (never set by `createMerchantCatalogJob`), and no "default lower garment" validation error exists yet.

- [ ] **Step 4: Write the implementation**

In `apps/api/src/modules/merchant/create-job.ts`:

Replace the import line (line 4):

```ts
import { and, eq, ilike } from 'drizzle-orm';
```

with:

```ts
import { aliasedTable, and, eq, ilike } from 'drizzle-orm';
```

Replace the `MerchantCatalogDefaults` interface (lines 17-22):

```ts
interface MerchantCatalogDefaults {
  merchantCatalogDefaults?: Partial<
    Record<'men' | 'women' | 'boys' | 'girls', { faceId: string; backgroundId: string }>
  >;
  merchantCatalogAspectRatio?: string;
}
```

with:

```ts
interface MerchantCatalogDefaults {
  merchantCatalogDefaults?: Partial<
    Record<
      'men' | 'women' | 'boys' | 'girls',
      { faceId: string; backgroundId: string; lowerCatalogId?: string; shoeCatalogId?: string }
    >
  >;
  merchantCatalogAspectRatio?: string;
}
```

Replace the entire body of `createMerchantCatalogJob` (lines 33-179, i.e. from the function signature through its closing `}` right before the `/**` comment for `createMerchantSareeMannequinJob`) with:

```ts
export async function createMerchantCatalogJob(
  app: FastifyInstance,
  params: {
    userId: string;
    garmentSubcategoryId: string;
    category: string;
    flatImageKey: string;
    subcategoryId: string;
    merchantId: string;
  },
): Promise<{ jobId: string }> {
  const [garmentType] = await app.db
    .select({
      defaultPoseId: schema.garmentSubcategories.defaultPoseId,
      requiresMannequinStep: schema.garmentSubcategories.requiresMannequinStep,
    })
    .from(schema.garmentSubcategories)
    .where(
      and(
        eq(schema.garmentSubcategories.id, params.garmentSubcategoryId),
        eq(schema.garmentSubcategories.isActive, true),
      ),
    )
    .limit(1);
  if (!garmentType) throw new AppError('BAD_CATALOG', 400, 'garment type not found or inactive');
  if (!garmentType.defaultPoseId) {
    throw new AppError(
      'VALIDATION',
      400,
      'admin has not configured a default pose for this garment type',
    );
  }

  const raw = await app.redis.get(CONFIG_KEY);
  const cfg = (raw ? JSON.parse(raw) : {}) as MerchantCatalogDefaults;
  const categoryDefaults =
    cfg.merchantCatalogDefaults?.[params.category as 'men' | 'women' | 'boys' | 'girls'];
  if (!categoryDefaults?.faceId || !categoryDefaults?.backgroundId) {
    throw new AppError(
      'VALIDATION',
      400,
      `admin has not configured default face/background for category "${params.category}"`,
    );
  }
  const aspectRatio = cfg.merchantCatalogAspectRatio ?? '2:3';

  // Determine whether the fixed pose's workflow (honoring any per-garment-type
  // override in pose_garment_configs) actually needs a lower garment / shoe —
  // mirrors the pose-workflow resolution in jobs/create.ts so both paths agree
  // on what a given pose+garment-type combo requires.
  const defaultWorkflow = aliasedTable(schema.workflowTemplates, 'default_workflow');
  const overrideWorkflow = aliasedTable(schema.workflowTemplates, 'override_workflow');
  const [poseWorkflow] = await app.db
    .select({
      defaultLowerNodeId: defaultWorkflow.lowerNodeId,
      defaultShoeNodeId: defaultWorkflow.shoeNodeId,
      configWorkflowTemplateId: schema.poseGarmentConfigs.workflowTemplateId,
      overrideLowerNodeId: overrideWorkflow.lowerNodeId,
      overrideShoeNodeId: overrideWorkflow.shoeNodeId,
    })
    .from(schema.modelPoseAssets)
    .leftJoin(defaultWorkflow, eq(schema.modelPoseAssets.workflowTemplateId, defaultWorkflow.id))
    .leftJoin(
      schema.poseGarmentConfigs,
      and(
        eq(schema.poseGarmentConfigs.poseAssetId, schema.modelPoseAssets.id),
        eq(schema.poseGarmentConfigs.subcategoryId, params.garmentSubcategoryId),
      ),
    )
    .leftJoin(
      overrideWorkflow,
      eq(schema.poseGarmentConfigs.workflowTemplateId, overrideWorkflow.id),
    )
    .where(eq(schema.modelPoseAssets.id, garmentType.defaultPoseId))
    .limit(1);
  const needsLower =
    (poseWorkflow?.configWorkflowTemplateId != null
      ? poseWorkflow.overrideLowerNodeId
      : poseWorkflow?.defaultLowerNodeId) != null;
  const needsShoes =
    (poseWorkflow?.configWorkflowTemplateId != null
      ? poseWorkflow.overrideShoeNodeId
      : poseWorkflow?.defaultShoeNodeId) != null;

  if (needsLower && !categoryDefaults.lowerCatalogId) {
    throw new AppError(
      'VALIDATION',
      400,
      `admin has not configured a default lower garment for category "${params.category}"`,
    );
  }
  if (needsShoes && !categoryDefaults.shoeCatalogId) {
    throw new AppError(
      'VALIDATION',
      400,
      `admin has not configured a default shoe for category "${params.category}"`,
    );
  }

  const [face] = await app.db
    .select({ id: schema.modelFaces.id })
    .from(schema.modelFaces)
    .where(
      and(eq(schema.modelFaces.id, categoryDefaults.faceId), eq(schema.modelFaces.isActive, true)),
    );
  const [background] = await app.db
    .select({ id: schema.modelBackgrounds.id })
    .from(schema.modelBackgrounds)
    .where(
      and(
        eq(schema.modelBackgrounds.id, categoryDefaults.backgroundId),
        eq(schema.modelBackgrounds.isActive, true),
      ),
    );
  const [pose] = await app.db
    .select({ id: schema.modelPoseAssets.id })
    .from(schema.modelPoseAssets)
    .where(
      and(
        eq(schema.modelPoseAssets.id, garmentType.defaultPoseId),
        eq(schema.modelPoseAssets.isActive, true),
      ),
    );
  const [lowerItem] = needsLower
    ? await app.db
        .select({ id: schema.catalogItems.id })
        .from(schema.catalogItems)
        .where(
          and(
            eq(schema.catalogItems.id, categoryDefaults.lowerCatalogId!),
            eq(schema.catalogItems.isActive, true),
          ),
        )
    : [];
  const [shoeItem] = needsShoes
    ? await app.db
        .select({ id: schema.catalogItems.id })
        .from(schema.catalogItems)
        .where(
          and(
            eq(schema.catalogItems.id, categoryDefaults.shoeCatalogId!),
            eq(schema.catalogItems.isActive, true),
          ),
        )
    : [];
  if (!face)
    throw new AppError('BAD_CATALOG', 400, 'configured default face not found or inactive');
  if (!background)
    throw new AppError('BAD_CATALOG', 400, 'configured default background not found or inactive');
  if (!pose)
    throw new AppError('BAD_CATALOG', 400, 'configured default pose not found or inactive');
  if (needsLower && !lowerItem)
    throw new AppError(
      'BAD_CATALOG',
      400,
      'configured default lower garment not found or inactive',
    );
  if (needsShoes && !shoeItem)
    throw new AppError('BAD_CATALOG', 400, 'configured default shoe not found or inactive');

  await assertMerchantUploadKey(app, params.merchantId, params.flatImageKey, 'flat garment');

  const requestedDims = ASPECT_DIMENSIONS[aspectRatio] ?? ASPECT_DIMENSIONS['2:3'];
  const maxOutputPx = await getMaxOutputPx(app);
  const requestedLongEdge = Math.max(requestedDims.width, requestedDims.height);
  const outputDims =
    requestedLongEdge > maxOutputPx
      ? requestedDims.width >= requestedDims.height
        ? {
            width: maxOutputPx,
            height: Math.round(maxOutputPx * (requestedDims.height / requestedDims.width)),
          }
        : {
            width: Math.round(maxOutputPx * (requestedDims.width / requestedDims.height)),
            height: maxOutputPx,
          }
      : requestedDims;
  const resolution: Resolution = resolutionFromDims(outputDims.width, outputDims.height);
  const cost = await getResolutionCreditCost(app, resolution);

  const jobId = randomUUID();
  await app.db.transaction(async (tx) => {
    await tx.insert(schema.jobs).values({
      id: jobId,
      userId: params.userId,
      status: 'QUEUED',
      // Merchant-generated catalogue images are never watermarked, regardless of
      // the user's plan tier — merchants are paying customers of a distinct product.
      watermark: false,
      queueStream: 'normal',
      creditsCharged: cost,
    });
    await atomicDeduct(tx as unknown as typeof app.db, params.userId, cost, jobId);
    await tx.insert(schema.jobInputs).values({
      jobId,
      upperGarmentKey: params.flatImageKey,
      faceId: face.id,
      backgroundId: background.id,
      poseId: pose.id,
      garmentTypeId: params.garmentSubcategoryId,
      lowerCatalogId: lowerItem?.id ?? null,
      shoeCatalogId: shoeItem?.id ?? null,
      params: {
        kind: 'merchant_catalog',
        subcategoryId: params.subcategoryId,
        outputWidth: outputDims.width,
        outputHeight: outputDims.height,
        aspectRatio,
        resolution,
        // The merchant's flatImageKey is always a raw, never-processed photo -
        // tells the dispatcher to run the mannequin compositing step inline
        // before the real generation. See apps/dispatcher/src/job/processor.ts's
        // requiresMannequinStep branch.
        needsMannequinStep: garmentType.requiresMannequinStep,
      },
    });
  });

  await app.redis.xadd(
    'jobs:normal',
    'MAXLEN',
    '~',
    10000,
    '*',
    'jobId',
    jobId,
    'userId',
    params.userId,
  );

  return { jobId };
}
```

Leave `createMerchantSareeMannequinJob` (the function after this one) completely untouched.

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm --filter @tryme/api test -- merchant-catalog-generate`
Expected: PASS — all pre-existing tests in the file still pass, plus the 4 new ones.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/merchant/create-job.ts apps/api/test/integration/merchant-catalog-generate.test.ts
git commit -m "feat(api): resolve merchant catalogue lower/shoe defaults only when the pose needs them"
```

---

### Task 3: Admin UI — lower/shoe selectors in Merchant Catalogue Defaults

**Files:**
- Modify: `apps/admin-web/src/pages/SettingsPage.tsx`

- [ ] **Step 1: Widen state types**

Replace lines 378-380:

```ts
  const [merchantCatalogDefaults, setMerchantCatalogDefaults] = useState<
    Record<string, { faceId: string; backgroundId: string }>
  >({});
```

with:

```ts
  const [merchantCatalogDefaults, setMerchantCatalogDefaults] = useState<
    Record<
      string,
      { faceId: string; backgroundId: string; lowerCatalogId?: string; shoeCatalogId?: string }
    >
  >({});
  const [catalogItemsList, setCatalogItemsList] = useState<
    Array<{ id: string; label: string; type: 'lower' | 'shoe'; genderSlug: string | null }>
  >([]);
```

- [ ] **Step 2: Widen the GET /admin/config response type**

Replace line 419:

```ts
      merchantCatalogDefaults?: Record<string, { faceId: string; backgroundId: string }>;
```

with:

```ts
      merchantCatalogDefaults?: Record<
        string,
        { faceId: string; backgroundId: string; lowerCatalogId?: string; shoeCatalogId?: string }
      >;
```

- [ ] **Step 3: Fetch catalog items**

Replace the effect at lines 476-483:

```ts
  useEffect(() => {
    apiFetch<{ items: Array<{ id: string; label: string; gender: string }> }>('/admin/assets/faces')
      .then((res) => setModelFacesList(res.items))
      .catch(() => {});
    apiFetch<{ items: Array<{ id: string; label: string }> }>('/admin/assets/backgrounds')
      .then((res) => setModelBackgroundsList(res.items))
      .catch(() => {});
  }, []);
```

with:

```ts
  useEffect(() => {
    apiFetch<{ items: Array<{ id: string; label: string; gender: string }> }>('/admin/assets/faces')
      .then((res) => setModelFacesList(res.items))
      .catch(() => {});
    apiFetch<{ items: Array<{ id: string; label: string }> }>('/admin/assets/backgrounds')
      .then((res) => setModelBackgroundsList(res.items))
      .catch(() => {});
    apiFetch<
      Array<{ id: string; label: string; type: 'lower' | 'shoe'; genderSlug: string | null }>
    >('/admin/catalog/items')
      .then(setCatalogItemsList)
      .catch(() => {});
  }, []);
```

- [ ] **Step 4: Sanitize the save payload**

In `saveSysConfig` (starting at line 485), add a sanitizer right after the `gbToBytes` line (line 489) and use it in the PATCH body:

Replace:

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
```

with:

```ts
  const saveSysConfig = async () => {
    setSysSaving(true);
    try {
      const mbToBytes = (mb: number) => Math.round(mb * 1024 * 1024);
      const gbToBytes = (gb: number) => Math.round(gb * 1024 * 1024 * 1024);
      const sanitizedMerchantCatalogDefaults = Object.fromEntries(
        Object.entries(merchantCatalogDefaults).map(([cat, v]) => [
          cat,
          {
            faceId: v.faceId,
            backgroundId: v.backgroundId,
            ...(v.lowerCatalogId ? { lowerCatalogId: v.lowerCatalogId } : {}),
            ...(v.shoeCatalogId ? { shoeCatalogId: v.shoeCatalogId } : {}),
          },
        ]),
      );
      await apiFetch('/admin/config', {
        method: 'PATCH',
        body: JSON.stringify({
          resolutions,
          maxOutputPx,
          merchantCatalogDefaults: sanitizedMerchantCatalogDefaults,
          merchantCatalogAspectRatio,
```

(The rest of the PATCH body — `tryon`, `sareeMannequinDev`, `uploadLimits` — is unchanged.)

- [ ] **Step 5: Extend the per-category grid UI**

Replace the entire block at lines 1360-1409 (from `<div style={{ marginTop: 24, marginBottom: 8 }}>` through the `))}` that closes the `.map((cat) => (...))`):

```tsx
                <div style={{ marginTop: 24, marginBottom: 8 }}>
                  <div className="setting-lbl" style={{ marginBottom: 4 }}>
                    Merchant Catalogue Defaults
                  </div>
                  <div className="setting-desc" style={{ marginBottom: 12 }}>
                    Fixed model/background used when a merchant generates a catalogue image from a
                    flat garment photo — guarantees every generated image is try-on-suitable.
                  </div>
                  {(['men', 'women', 'boys', 'girls'] as const).map((cat) => (
                    <div
                      key={cat}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '80px 1fr 1fr',
                        gap: 12,
                        alignItems: 'center',
                        marginBottom: 10,
                      }}
                    >
                      <label style={{ textTransform: 'capitalize' }}>{cat}</label>
                      <SearchableSelect
                        options={modelFacesList.filter((f) => f.gender === cat)}
                        value={merchantCatalogDefaults[cat]?.faceId ?? ''}
                        disabled={sysSaving}
                        placeholder="— search face —"
                        onChange={(faceId) =>
                          setMerchantCatalogDefaults((prev) => ({
                            ...prev,
                            [cat]: {
                              ...prev[cat],
                              faceId,
                              backgroundId: prev[cat]?.backgroundId ?? '',
                            },
                          }))
                        }
                      />
                      <SearchableSelect
                        options={modelBackgroundsList}
                        value={merchantCatalogDefaults[cat]?.backgroundId ?? ''}
                        disabled={sysSaving}
                        placeholder="— search background —"
                        onChange={(backgroundId) =>
                          setMerchantCatalogDefaults((prev) => ({
                            ...prev,
                            [cat]: { faceId: prev[cat]?.faceId ?? '', backgroundId },
                          }))
                        }
                      />
                    </div>
                  ))}
```

with:

```tsx
                <div style={{ marginTop: 24, marginBottom: 8 }}>
                  <div className="setting-lbl" style={{ marginBottom: 4 }}>
                    Merchant Catalogue Defaults
                  </div>
                  <div className="setting-desc" style={{ marginBottom: 12 }}>
                    Fixed model/background used when a merchant generates a catalogue image from a
                    flat garment photo — guarantees every generated image is try-on-suitable. Lower
                    garment and shoe defaults are only applied when the assigned pose's workflow
                    needs one.
                  </div>
                  {(['men', 'women', 'boys', 'girls'] as const).map((cat) => (
                    <div
                      key={cat}
                      style={{
                        display: 'grid',
                        gridTemplateColumns: '80px 1fr 1fr 1fr 1fr',
                        gap: 12,
                        alignItems: 'center',
                        marginBottom: 10,
                      }}
                    >
                      <label style={{ textTransform: 'capitalize' }}>{cat}</label>
                      <SearchableSelect
                        options={modelFacesList.filter((f) => f.gender === cat)}
                        value={merchantCatalogDefaults[cat]?.faceId ?? ''}
                        disabled={sysSaving}
                        placeholder="— search face —"
                        onChange={(faceId) =>
                          setMerchantCatalogDefaults((prev) => ({
                            ...prev,
                            [cat]: {
                              ...prev[cat],
                              faceId,
                              backgroundId: prev[cat]?.backgroundId ?? '',
                            },
                          }))
                        }
                      />
                      <SearchableSelect
                        options={modelBackgroundsList}
                        value={merchantCatalogDefaults[cat]?.backgroundId ?? ''}
                        disabled={sysSaving}
                        placeholder="— search background —"
                        onChange={(backgroundId) =>
                          setMerchantCatalogDefaults((prev) => ({
                            ...prev,
                            [cat]: {
                              ...prev[cat],
                              faceId: prev[cat]?.faceId ?? '',
                              backgroundId,
                            },
                          }))
                        }
                      />
                      <SearchableSelect
                        options={catalogItemsList.filter(
                          (c) =>
                            c.type === 'lower' && (c.genderSlug == null || c.genderSlug === cat),
                        )}
                        value={merchantCatalogDefaults[cat]?.lowerCatalogId ?? ''}
                        disabled={sysSaving}
                        placeholder="— search lower garment —"
                        emptyLabel="— none / not needed —"
                        onChange={(lowerCatalogId) =>
                          setMerchantCatalogDefaults((prev) => ({
                            ...prev,
                            [cat]: {
                              ...prev[cat],
                              faceId: prev[cat]?.faceId ?? '',
                              backgroundId: prev[cat]?.backgroundId ?? '',
                              lowerCatalogId,
                            },
                          }))
                        }
                      />
                      <SearchableSelect
                        options={catalogItemsList.filter(
                          (c) =>
                            c.type === 'shoe' && (c.genderSlug == null || c.genderSlug === cat),
                        )}
                        value={merchantCatalogDefaults[cat]?.shoeCatalogId ?? ''}
                        disabled={sysSaving}
                        placeholder="— search shoe —"
                        emptyLabel="— none / not needed —"
                        onChange={(shoeCatalogId) =>
                          setMerchantCatalogDefaults((prev) => ({
                            ...prev,
                            [cat]: {
                              ...prev[cat],
                              faceId: prev[cat]?.faceId ?? '',
                              backgroundId: prev[cat]?.backgroundId ?? '',
                              shoeCatalogId,
                            },
                          }))
                        }
                      />
                    </div>
                  ))}
```

- [ ] **Step 6: Typecheck**

Run: `pnpm --filter @tryme/admin-web typecheck`
Expected: no errors. (`SearchableSelect`'s `options` prop is typed `Option[]` = `{id, label}[]`; `catalogItemsList` items have extra `type`/`genderSlug` fields, which is allowed by structural typing since each element still satisfies `{id, label}`.)

- [ ] **Step 7: Manually verify in the browser**

Run `pnpm --filter @tryme/admin-web dev`, open Settings, and confirm:
- The "Merchant Catalogue Defaults" section now shows 4 columns per category (face, background, lower, shoe).
- Selecting a lower/shoe item and clicking Save persists it (reload the page and confirm the selection sticks).
- Clearing a lower/shoe selection back to "— none / not needed —" and saving removes it (reload and confirm it's empty again, not stuck as an invalid empty string).

- [ ] **Step 8: Commit**

```bash
git add apps/admin-web/src/pages/SettingsPage.tsx
git commit -m "feat(admin-web): add lower garment and shoe selectors to Merchant Catalogue Defaults"
```

---

### Task 4: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Full typecheck**

Run: `pnpm typecheck`
Expected: no errors across all workspace packages.

- [ ] **Step 2: Full API test suite**

Run: `pnpm --filter @tryme/api test`
Expected: all tests pass, including every test touched in Tasks 1-2.

- [ ] **Step 3: Lint**

Run: `pnpm lint`
Expected: no errors.

- [ ] **Step 4: Update progress log**

Add a new dated entry at the top of `docs/progress.md` summarizing: extended merchant catalogue defaults with per-category lower garment/shoe selections, applied only when the assigned pose's workflow needs one; no DB migration; spec at `docs/superpowers/specs/2026-07-27-merchant-catalogue-lower-shoe-defaults-design.md`.

- [ ] **Step 5: Commit**

```bash
git add docs/progress.md
git commit -m "docs: record merchant catalogue lower/shoe defaults work"
```
