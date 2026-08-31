# Merchant Catalog Saree Two-Input (Body & Pallu) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The merchant "Add Product" flow (`apps/catalogues-web`, `apps/(app)/tryon/ProductModal.tsx`,
"Flat Image" mode) generates saree catalogue images from a single flat photo, forcing the
mannequin-drape step to guess how a two-piece saree (body + pallu) actually looks. This
already produced a real, dated support complaint: a merchant's catalogue image showed a
"completely different saree" than what was uploaded (`contact_requests`, 2026-08-19,
`venkatalakshmicp34@gmail.com`). Fix: let the merchant upload body + pallu separately and
route both into the drape step, exactly the way Studio's own two-input flow already does —
without touching the shared single-image mannequin path every other merchant catalog job
still uses.

**Architecture:** No dispatcher code changes. Studio's existing "mannequin job now, real job
later" pattern — a standalone `saree_mannequin`-kind job plus a step-2 job created with
`status: 'PENDING_MANNEQUIN'` and `params.mannequinJobId` pointing at it — is promoted
automatically by the dispatcher's `promoteSareeStep2Jobs` sweep
(`apps/dispatcher/src/job/saree-step2-promoter.ts`), which is entirely generic: it matches
on job status and a JSON field, never on `jobs.source`. The only backend work is teaching
`createMerchantCatalogJob` (`apps/api/src/modules/merchant/create-job.ts`) to build that same
two-row shape when a second image is supplied, instead of running the mannequin phase inline
via `runMannequinPhase` (which only ever accepts one image and is shared by every merchant
catalog job — not touched by this plan).

**Tech stack:** Fastify 5, Drizzle ORM (Postgres 16), Next.js 15 (`apps/catalogues-web`),
Vitest (container-backed integration tests, no testcontainers).

---

## Context (verified against code and production data)

- `ProductModal.tsx`'s "Flat Image" mode uploads one image and calls
  `POST /v1/merchant/catalog/generate` with just `flatImageKey`. For a saree garment type
  (`garment_subcategories.requires_mannequin_step = true`), this hits
  `createMerchantCatalogJob`, which runs the mannequin drape step **inline**, in the same job,
  via `runMannequinPhase` (`apps/dispatcher/src/job/mannequin-phase.ts`) — a function that
  takes exactly one `garmentKey` and has no second-image concept anywhere in it. This is the
  shared path for **every** merchant catalog job requiring a mannequin step, saree or
  otherwise — this plan does not touch it.
- Studio (`apps/catalogues-web`'s `/studio` page) already ships true two-input saree upload,
  but through a completely different mechanism:
  `POST /v1/jobs/saree-mannequin` (`apps/api/src/modules/jobs/createSareeMannequin.ts`)
  creates **two job rows in one transaction**: a standalone mannequin job
  (`source: JOB_SOURCE.SAREE_MANNEQUIN`, `status: 'QUEUED'`, 0 credits, `job_inputs.params`
  = `{ kind: 'saree_mannequin', workflowTemplateId? }`, `upperGarmentKey`/`thirdGarmentKey`
  set to the body/pallu keys) and one step-2 job per look
  (`status: 'PENDING_MANNEQUIN'`, `upperGarmentKey: null`,
  `params: { ...normalParams, mannequinJobId: <the mannequin job's id> }`). Only the
  mannequin job is `XADD`ed to Redis; the step-2 job is not enqueued yet.
- The dispatcher's `promoteSareeStep2Jobs` sweep (`saree-step2-promoter.ts`, runs on a 5s
  interval — wired in `apps/dispatcher/src/index.ts`) is what turns a completed mannequin job
  into a real queued job: it finds every `PENDING_MANNEQUIN` row, looks up its
  `params.mannequinJobId`'s status, and once that job is `COMPLETED`, atomically claims the
  step-2 row (compare-and-swap `UPDATE ... WHERE status = 'PENDING_MANNEQUIN'`, so concurrent
  sweep overlaps can't double-enqueue), writes `upperGarmentKey = keys.output(mannequinJobId)`
  into `job_inputs`, flips status to `QUEUED`, and `XADD`s it. **This function does not
  branch on `jobs.source` anywhere** — it is safe to reuse for a non-Studio job pair.
  Verified `keys.output(jobId)` (`packages/storage/src/keys.ts`) is exactly what
  `finalizeOutput` (`apps/dispatcher/src/workflow/finalize.ts`, called by
  `processSareeMannequinJob` in `apps/dispatcher/src/job/processor.ts`) writes a completed
  mannequin job's result to — the promoter's assumption is correct, verified end to end, not
  inferred.
- `processSareeMannequinJob` already fully supports two inputs today: it reads
  `template.tryonGarmentNodeId2` (the pallu node) and `inputs.thirdGarmentKey`, uploads both
  images to ComfyUI, and fails closed if one is present without the other
  (`MANNEQUIN_NODES_NOT_CONFIGURED` / `MANNEQUIN_INPUTS_MISSING`). Confirmed by production
  data: `merchant_catalog_saree_mannequin`-source jobs already use this two-input path (33 of
  99 total merchant-saree-mannequin jobs since 2026-07-29), with a face-node check
  (`personNodeId && !faceId → MANNEQUIN_INPUTS_MISSING`) that only matters if the specific
  workflow template bakes a `tryonPersonNodeId` in — harmless to pass a `faceId` even when the
  template doesn't use one (`apps/dispatcher/src/job/processor.ts`, `processSareeMannequinJob`:
  "Templates with no person node bake the face in directly... faceId is accepted but unused").
- Verified in production (2026-08-20): the one `garment_subcategories` row with
  `requires_mannequin_step = true` (the "Saree" type) has `mannequin_two_input_workflow_
  template_id` fully configured, and Studio's own two-input jobs run at 88% success (38/43),
  no distinct failure mode vs. single-input (77%, 209/272) — the underlying mechanism this
  plan reuses is production-proven, not speculative.
- `MerchantCatalogGenerateBody` (`packages/types/src/widget.ts`) **already** has
  `secondFlatImageKey` and `sareeStyleId` as optional fields — no schema change needed there.
  The route handler (`POST /v1/merchant/catalog/generate`,
  `apps/api/src/modules/merchant/catalog.routes.ts` around line 866) already destructures
  both, but only ever forwards them to `createMerchantSareeMannequinJob`, which only runs when
  `mannequinOnly: true` — a **different, terminal, full-credit-cost, no-step-2 job type**
  (`source: JOB_SOURCE.MERCHANT_CATALOG_SAREE_MANNEQUIN`) used by the Android app's own
  standalone try-on preview feature. Confirmed via `apps/api/test/integration/merchant-
  catalog-generate.test.ts`: every existing `secondFlatImageKey` test sends `mannequinOnly:
  true`; there is no test coverage — and no code path — for `secondFlatImageKey` on the
  regular (non-`mannequinOnly`) "Add Product" generate path. **This plan does not touch
  `createMerchantSareeMannequinJob` or the `mannequinOnly` branch at all** — that is a
  separate, already-working feature for a different product surface.
- `MerchantCatalogSubcategory` (`packages/types/src/widget.ts`) does not currently expose
  whether its linked garment type supports two-input mannequin generation — the frontend has
  no way today to decide whether to show a second upload box. `serializeSubcategory`
  (`apps/api/src/modules/merchant/catalog.routes.ts`) is the single shared serializer used by
  the subcategory list/create/update routes.
- `CatalogueManagerContent.tsx` already computes `selectedSub = subcategories.find((s) =>
  s.id === selectedSubcategoryId)` (line 229) but only passes the bare `subcategoryId` string
  down to `<ProductModal subcategoryId={selectedSubcategoryId} ... />` (line 816) — the full
  subcategory object (which will carry the new capability flag from Task 1) is already in
  scope at the call site and just needs to be threaded through as a prop.
- `sareeStyleId` support is deliberately **out of scope** — `ProductModal.tsx` has no style
  picker UI today and Studio's own (already-shipped) two-input flow doesn't have one either;
  adding one would be new, unrequested UI surface. The garment type's own default two-input
  workflow (`garment_subcategories.mannequin_two_input_workflow_template_id`) is sufficient.

---

## Global Constraints

(Carried over from this repo's other plans — still true.)

- Never run `db:generate`/`drizzle-kit`/ad-hoc `psql` against production. This plan needs
  **no migration** — every column and job-status value it uses already exists.
- Match existing comment density/idiom in every file touched — comment the *why*.
- Integration tests: `apps/api/test/integration/**`, run via
  `pnpm --filter @tryme/api test:integration` against the docker-compose
  Postgres/Redis/MinIO (`pnpm docker:up` first, no testcontainers).
- Credits are still deducted at step-2 job creation time (same transaction, same as today's
  single-input path) — **not** deferred until the mannequin job completes. This matches
  Studio's `createSareeMannequinJob` exactly and must not change: a merchant should not be
  able to spend the mannequin step's free compute and walk away before paying for step 2.

---

## Task 1: Expose two-input mannequin capability on the subcategory list

**Files:**
- Modify: `apps/api/src/modules/merchant/catalog.routes.ts` — `serializeSubcategory`
- Modify: `packages/types/src/widget.ts` — `MerchantCatalogSubcategory`
- Test: `apps/api/test/integration/merchant-catalog-subcategories.test.ts`

- [x] **Step 1: Add the field to the shared type**

In `packages/types/src/widget.ts`, add one field to `MerchantCatalogSubcategory` (right
after `garmentSubcategoryId`, around line 180):

```ts
export const MerchantCatalogSubcategory = z.object({
  id: z.string().uuid(),
  merchantId: z.string().uuid(),
  category: MerchantCatalogCategory,
  name: z.string(),
  garmentSubcategoryId: z.string().uuid(),
  // True only when the linked garment type both requires the mannequin step AND has a
  // two-input (body + pallu) step-1 workflow configured. Drives whether ProductModal
  // shows a second "Pallu" upload box for this subcategory — see docs/superpowers/plans/
  // 2026-08-20-merchant-catalog-saree-two-input.md.
  supportsTwoInputMannequin: z.boolean(),
  sortOrder: z.number().int(),
  productCount: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
  isDemo: z.boolean().optional(),
  readOnly: z.boolean().optional(),
});
```

- [x] **Step 2: Compute it in `serializeSubcategory`**

In `apps/api/src/modules/merchant/catalog.routes.ts`, replace `serializeSubcategory`
(currently lines 131-140):

```ts
async function serializeSubcategory(
  app: FastifyInstance,
  row: typeof schema.merchantCatalogSubcategories.$inferSelect,
) {
  const [{ n }] = await app.db
    .select({ n: count() })
    .from(schema.merchantCatalogItems)
    .where(eq(schema.merchantCatalogItems.subcategoryId, row.id));
  // Mirrors the existing per-row productCount lookup above — same N+1-per-row shape this
  // function already has, not a new performance concern for a merchant's subcategory list
  // (bounded by how many subcategories one merchant creates, never paginated at scale).
  const [garmentType] = await app.db
    .select({
      requiresMannequinStep: schema.garmentSubcategories.requiresMannequinStep,
      mannequinTwoInputWorkflowTemplateId:
        schema.garmentSubcategories.mannequinTwoInputWorkflowTemplateId,
    })
    .from(schema.garmentSubcategories)
    .where(eq(schema.garmentSubcategories.id, row.garmentSubcategoryId));
  return {
    ...row,
    productCount: n,
    supportsTwoInputMannequin: Boolean(
      garmentType?.requiresMannequinStep && garmentType?.mannequinTwoInputWorkflowTemplateId,
    ),
  };
}
```

- [x] **Step 3: Write the test**

Add to `apps/api/test/integration/merchant-catalog-subcategories.test.ts` (check the file's
existing `createMerchant`/`authHeader`/seed-helper conventions first and match them — this
file already has its own copies of those helpers, don't assume they're identical to
`merchant-catalog-generate.test.ts`'s):

```ts
it('supportsTwoInputMannequin is true only when the garment type requires the mannequin step and has a two-input workflow configured', async () => {
  const { userId } = await createMerchant(app, 'two-input-flag@example.com');
  const auth = await authHeader(userId);

  const twoInputWf = await seedMannequinWorkflowTemplateWithSecondNode(app); // or existing equivalent helper
  const [sareeType] = await app.db
    .insert(schema.garmentSubcategories)
    .values({
      genderSlug: 'women',
      slug: `saree-two-input-${randomUUID()}`,
      label: 'Saree',
      requiresMannequinStep: true,
      mannequinTwoInputWorkflowTemplateId: twoInputWf.id,
    })
    .returning();
  const [plainType] = await app.db
    .insert(schema.garmentSubcategories)
    .values({ genderSlug: 'women', slug: `shirt-${randomUUID()}`, label: 'Shirt' })
    .returning();

  const sareeSubRes = await app.inject({
    method: 'POST',
    url: '/v1/merchant/catalog/subcategories',
    headers: auth,
    payload: { category: 'women', name: 'Sarees', garmentSubcategoryId: sareeType.id },
  });
  const plainSubRes = await app.inject({
    method: 'POST',
    url: '/v1/merchant/catalog/subcategories',
    headers: auth,
    payload: { category: 'women', name: 'Shirts', garmentSubcategoryId: plainType.id },
  });
  expect((sareeSubRes.json() as { supportsTwoInputMannequin: boolean }).supportsTwoInputMannequin).toBe(true);
  expect((plainSubRes.json() as { supportsTwoInputMannequin: boolean }).supportsTwoInputMannequin).toBe(false);

  const list = await app.inject({
    method: 'GET',
    url: '/v1/merchant/catalog/subcategories?category=women',
    headers: auth,
  });
  const items = (list.json() as { items: Array<{ id: string; supportsTwoInputMannequin: boolean }> }).items;
  expect(items.find((i) => i.id === sareeSubRes.json().id)?.supportsTwoInputMannequin).toBe(true);
  expect(items.find((i) => i.id === plainSubRes.json().id)?.supportsTwoInputMannequin).toBe(false);
});
```

If `seedMannequinWorkflowTemplateWithSecondNode` doesn't already exist in this test file,
write it inline (mirrors `merchant-catalog-generate.test.ts`'s `seedTwoInputWorkflowTemplate`
— insert a `workflowTemplates` row with `tryonGarmentNodeId2` set).

- [x] **Step 4: Run it**

Run (from `apps/api`, `pnpm docker:up` first):
`npx vitest run --config vitest.integration.config.ts test/integration/merchant-catalog-subcategories.test.ts`
Expected: all pass, including the new test.

- [x] **Step 5: Commit**

```bash
git add packages/types/src/widget.ts apps/api/src/modules/merchant/catalog.routes.ts apps/api/test/integration/merchant-catalog-subcategories.test.ts
git commit -m "feat(merchant-catalog): expose supportsTwoInputMannequin on subcategories"
```

---

## Task 2: Two-phase job creation in `createMerchantCatalogJob`

**Files:**
- Modify: `apps/api/src/modules/merchant/create-job.ts`
- Test: `apps/api/test/integration/merchant-catalog-generate.test.ts`

- [x] **Step 1: Add the new param and branch the final insert**

In `apps/api/src/modules/merchant/create-job.ts`, `createMerchantCatalogJob`'s signature
(currently lines 41-55) gains one optional field:

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
    hold?: boolean;
    // Pallu image for the "Body & Pallu" two-input mannequin step. Only meaningful when
    // the garment type requires the mannequin step AND has a two-input workflow
    // configured — validated below. When present, the mannequin drape runs as its own
    // job (see saree-step2-promoter.ts) instead of the inline single-image path every
    // other merchant catalog job uses — see docs/superpowers/plans/
    // 2026-08-20-merchant-catalog-saree-two-input.md.
    secondFlatImageKey?: string;
  },
): Promise<{ jobId: string }> {
```

Everything from the current function body up through the `outputDims`/`resolution`/`cost`
calculation (currently ending around line 224, right before `const jobId = randomUUID();`)
stays **completely unchanged** — face/background/pose/lower/shoe resolution, upload-limit
checks, and cost calculation are identical whether this is a one-image or two-image request,
since two-input only changes how the *drape* step resolves, not the compositing step that
follows it.

Add the two-input validation right after the existing `garmentType` lookup (after line 70,
`if (!garmentType) throw new AppError(...)`), before anything else in the function:

```ts
  if (params.secondFlatImageKey) {
    if (!garmentType.requiresMannequinStep) {
      throw new AppError(
        'VALIDATION',
        400,
        'this garment type does not use the mannequin step',
      );
    }
    if (!garmentType.mannequinTwoInputWorkflowTemplateId) {
      throw new AppError(
        'CONFIG',
        400,
        'garment type missing two-input step-1 workflow configuration',
      );
    }
  }
```

This requires adding `mannequinTwoInputWorkflowTemplateId` to the existing `garmentType`
`select` (currently lines 57-61):

```ts
  const [garmentType] = await app.db
    .select({
      defaultPoseId: schema.garmentSubcategories.defaultPoseId,
      requiresMannequinStep: schema.garmentSubcategories.requiresMannequinStep,
      mannequinTwoInputWorkflowTemplateId:
        schema.garmentSubcategories.mannequinTwoInputWorkflowTemplateId,
    })
```

Then validate ownership of the second key alongside the existing single-key check (currently
line 206, `await assertMerchantUploadKey(app, params.merchantId, params.flatImageKey, 'flat garment');`):

```ts
  await assertMerchantUploadKey(app, params.merchantId, params.flatImageKey, 'flat garment');
  if (params.secondFlatImageKey) {
    await assertMerchantUploadKey(app, params.merchantId, params.secondFlatImageKey, 'pallu');
  }
```

Finally, replace the job-creation transaction + enqueue block (currently lines 226-286 — from
`const jobId = randomUUID();` through the closing `return { jobId };`) with a branch:

```ts
  const jobId = randomUUID();

  if (params.secondFlatImageKey) {
    // Two-input path: create a standalone mannequin job now (0 credits, matches
    // Studio's createSareeMannequinJob convention — the real charge is on the step-2
    // job below), and the step-2 job as PENDING_MANNEQUIN pointing at it. Only the
    // mannequin job is enqueued here; apps/dispatcher/src/job/saree-step2-promoter.ts
    // (already running, unmodified) promotes the step-2 job to QUEUED once the
    // mannequin job completes, exactly as it already does for Studio's own two-input
    // flow. No dispatcher changes needed — verified promoteSareeStep2Jobs does not
    // branch on jobs.source anywhere.
    const mannequinJobId = randomUUID();
    await app.db.transaction(async (tx) => {
      await tx.insert(schema.jobs).values({
        id: mannequinJobId,
        userId: params.userId,
        status: 'QUEUED',
        watermark: false,
        queueStream: 'normal',
        creditsCharged: 0,
        source: JOB_SOURCE.SAREE_MANNEQUIN,
      });
      await tx.insert(schema.jobInputs).values({
        jobId: mannequinJobId,
        upperGarmentKey: params.flatImageKey,
        thirdGarmentKey: params.secondFlatImageKey,
        // Reuses the same category-configured face the step-2 composite below will
        // use — consistent model across drape and final composite. Harmless if the
        // two-input template has no person node: processSareeMannequinJob only reads
        // faceId when the template's tryonPersonNodeId is set.
        faceId: face.id,
        garmentTypeId: params.garmentSubcategoryId,
        params: { kind: 'saree_mannequin' },
      });

      await tx.insert(schema.jobs).values({
        id: jobId,
        userId: params.userId,
        status: params.hold ? 'HELD' : 'PENDING_MANNEQUIN',
        watermark: false,
        queueStream: params.hold ? 'low' : 'normal',
        creditsCharged: cost,
        source: JOB_SOURCE.MERCHANT_CATALOG,
      });
      await atomicDeduct(tx as unknown as typeof app.db, params.userId, cost, jobId);
      await tx.insert(schema.jobInputs).values({
        jobId,
        upperGarmentKey: null,
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
          mannequinJobId,
          ...(params.hold ? { heldBatch: true } : {}),
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
      mannequinJobId,
      'userId',
      params.userId,
    );

    return { jobId };
  }

  // Single-input path — unchanged from before this task.
  await app.db.transaction(async (tx) => {
    await tx.insert(schema.jobs).values({
      id: jobId,
      userId: params.userId,
      status: params.hold ? 'HELD' : 'QUEUED',
      watermark: false,
      queueStream: params.hold ? 'low' : 'normal',
      creditsCharged: cost,
      source: JOB_SOURCE.MERCHANT_CATALOG,
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
        needsMannequinStep: garmentType.requiresMannequinStep,
        ...(params.hold ? { heldBatch: true } : {}),
      },
    });
  });

  if (!params.hold) {
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
  }

  return { jobId };
}
```

Note the `JOB_SOURCE` import at the top of the file already includes what's needed —
`JOB_SOURCE.MERCHANT_CATALOG` and `JOB_SOURCE.SAREE_MANNEQUIN` are both existing values in
`packages/types/src/job-taxonomy.ts`; no new source needs to be added.

**A held two-input batch is deliberately not supported by this branch's `hold` handling
above being present but untested** — bulk generate (`generate-bulk`, `createMerchantCatalogJob`'s only other caller) never passes `secondFlatImageKey` (Task 3 only wires it into the single
`/generate` route, not `/generate-bulk`), so `hold: true` and `secondFlatImageKey` set
never co-occur in practice today. The `hold`-aware status ( `HELD` vs `PENDING_MANNEQUIN`)
above is included for correctness/future-proofing since the field exists on the same params
object, but nothing calls it that way yet — do not spend test-writing effort on that
combination in Task 2's tests below.

- [x] **Step 2: Write the failing tests**

Add a new `describe` block to `apps/api/test/integration/merchant-catalog-generate.test.ts`
(the file already has `seedTwoInputGarmentType`/`seedTwoInputWorkflowTemplate`/`presignFlat`
helpers from the existing `mannequinOnly` two-input tests — reuse them as-is):

```ts
describe('secondFlatImageKey on the full-composite (non-mannequinOnly) path', () => {
  it('creates a mannequin job + a PENDING_MANNEQUIN step-2 job, deducts credits on the step-2 job, and enqueues only the mannequin job', async () => {
    const { userId } = await createMerchant(app, 'two-input-full-happy@example.com');
    await grantUserCredits(app, userId, 100);
    const auth = await authHeader(userId);

    // seedTwoInputGarmentType (not seedFullDefaults — that helper's garment type has no
    // two-input workflow) gives a garment type with both requiresMannequinStep and
    // mannequinTwoInputWorkflowTemplateId set. It has no defaultPoseId, so wire one up
    // the same way seedFullDefaults does internally, plus a face/background for the
    // merchantCatalogDefaults config the step-2 compositing needs.
    const { garmentType: sareeType, twoInputWorkflowTemplate } = await seedTwoInputGarmentType(
      app,
      'women',
      { withSingleInput: true },
    );
    const wf = await seedWorkflowTemplate(app);
    const pose = await seedPose(app, 'women', wf.id);
    const face = await seedFace(app, 'women');
    const bg = await seedBackground(app);
    await app.db
      .update(schema.garmentSubcategories)
      .set({ defaultPoseId: pose.id })
      .where(eq(schema.garmentSubcategories.id, sareeType.id));
    await app.redis.set(
      CONFIG_KEY,
      JSON.stringify({
        merchantCatalogDefaults: { women: { faceId: face.id, backgroundId: bg.id } },
        merchantCatalogAspectRatio: '2:3',
      }),
    );

    const subcatRes = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/subcategories',
      headers: auth,
      payload: { category: 'women', name: 'Sarees', garmentSubcategoryId: sareeType.id },
    });
    const subcategoryId = (subcatRes.json() as { id: string }).id;

    const flatImageKey = await presignFlat(app, auth);
    const secondFlatImageKey = await presignFlat(app, auth);

    const [balBefore] = await app.db
      .select()
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, userId));

    const generate = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/generate',
      headers: auth,
      payload: { subcategoryId, flatImageKey, secondFlatImageKey },
    });
    expect(generate.statusCode).toBe(201);
    const { jobId } = generate.json() as { jobId: string };

    const [step2] = await app.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
    expect(step2.status).toBe('PENDING_MANNEQUIN');
    expect(step2.source).toBe('merchant_catalog');

    const [step2Inputs] = await app.db
      .select()
      .from(schema.jobInputs)
      .where(eq(schema.jobInputs.jobId, jobId));
    expect(step2Inputs.upperGarmentKey).toBeNull();
    const step2Params = step2Inputs.params as Record<string, unknown>;
    const mannequinJobId = step2Params.mannequinJobId as string;
    expect(mannequinJobId).toBeTruthy();
    expect(step2Params.kind).toBe('merchant_catalog');

    const [mannequinJob] = await app.db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.id, mannequinJobId));
    expect(mannequinJob.status).toBe('QUEUED');
    expect(mannequinJob.source).toBe('saree_mannequin');
    expect(mannequinJob.creditsCharged).toBe(0);

    const [mannequinInputs] = await app.db
      .select()
      .from(schema.jobInputs)
      .where(eq(schema.jobInputs.jobId, mannequinJobId));
    expect(mannequinInputs.upperGarmentKey).toBe(flatImageKey);
    expect(mannequinInputs.thirdGarmentKey).toBe(secondFlatImageKey);
    expect(mannequinInputs.faceId).toBe(face.id);

    // Credits deducted once, on the step-2 job, at creation time — not deferred.
    const [balAfter] = await app.db
      .select()
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, userId));
    expect(balAfter.balance).toBeLessThan(balBefore.balance);

    // Only the mannequin job is enqueued; the step-2 job is not.
    const stream = await app.redis.xrange('jobs:normal', '-', '+');
    const enqueuedJobIds = stream.map(([, fields]) => fields[fields.indexOf('jobId') + 1]);
    expect(enqueuedJobIds).toContain(mannequinJobId);
    expect(enqueuedJobIds).not.toContain(jobId);

    void twoInputWorkflowTemplate; // referenced only for setup symmetry
  });

  it('rejects with 400 when the garment type has no two-input workflow configured', async () => {
    const { userId } = await createMerchant(app, 'two-input-full-noconf@example.com');
    await grantUserCredits(app, userId, 100);
    const auth = await authHeader(userId);
    const { garmentType, face, bg } = await seedFullDefaults('women');

    const subcatRes = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/subcategories',
      headers: auth,
      payload: { category: 'women', name: 'Sarees', garmentSubcategoryId: garmentType.id },
    });
    const subcategoryId = (subcatRes.json() as { id: string }).id;

    const flatImageKey = await presignFlat(app, auth);
    const secondFlatImageKey = await presignFlat(app, auth);

    const generate = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/generate',
      headers: auth,
      payload: { subcategoryId, flatImageKey, secondFlatImageKey },
    });
    expect(generate.statusCode).toBe(400);
    void face;
    void bg;
  });

  it('promotes the step-2 job to QUEUED with the mannequin output as upperGarmentKey once the mannequin job completes (simulated)', async () => {
    const { userId } = await createMerchant(app, 'two-input-full-promote@example.com');
    await grantUserCredits(app, userId, 100);
    const auth = await authHeader(userId);
    const { garmentType: sareeType } = await seedTwoInputGarmentType(app, 'women', {
      withSingleInput: true,
    });
    const wf = await seedWorkflowTemplate(app);
    const pose = await seedPose(app, 'women', wf.id);
    const face = await seedFace(app, 'women');
    const bg = await seedBackground(app);
    await app.db
      .update(schema.garmentSubcategories)
      .set({ defaultPoseId: pose.id })
      .where(eq(schema.garmentSubcategories.id, sareeType.id));
    await app.redis.set(
      CONFIG_KEY,
      JSON.stringify({
        merchantCatalogDefaults: { women: { faceId: face.id, backgroundId: bg.id } },
        merchantCatalogAspectRatio: '2:3',
      }),
    );

    const subcatRes = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/subcategories',
      headers: auth,
      payload: { category: 'women', name: 'Sarees', garmentSubcategoryId: sareeType.id },
    });
    const subcategoryId = (subcatRes.json() as { id: string }).id;
    const flatImageKey = await presignFlat(app, auth);
    const secondFlatImageKey = await presignFlat(app, auth);

    const generate = await app.inject({
      method: 'POST',
      url: '/v1/merchant/catalog/generate',
      headers: auth,
      payload: { subcategoryId, flatImageKey, secondFlatImageKey },
    });
    const { jobId: step2JobId } = generate.json() as { jobId: string };
    const [step2Inputs] = await app.db
      .select()
      .from(schema.jobInputs)
      .where(eq(schema.jobInputs.jobId, step2JobId));
    const mannequinJobId = (step2Inputs.params as Record<string, unknown>).mannequinJobId as string;

    // Simulate the dispatcher completing the mannequin job (dispatcher is not running
    // in this integration test — same convention as merchant-catalog-generate.test.ts's
    // own "marks a completed job COMPLETED" test).
    const mannequinResultKey = `outputs/${mannequinJobId}/result.png`;
    await app.storage.putObject(mannequinResultKey, Buffer.from('drape-output'), 'image/png');
    await app.db
      .update(schema.jobs)
      .set({ status: 'COMPLETED' })
      .where(eq(schema.jobs.id, mannequinJobId));

    // Run the actual promoter sweep against the real dispatcher config shape.
    const { promoteSareeStep2Jobs } = await import('../../../apps/dispatcher/src/job/saree-step2-promoter.js');
    await promoteSareeStep2Jobs({
      db: app.db,
      redis: app.redis,
      pub: app.redis,
      log: app.log,
    } as never);

    const [step2] = await app.db.select().from(schema.jobs).where(eq(schema.jobs.id, step2JobId));
    expect(step2.status).toBe('QUEUED');
    const [step2InputsAfter] = await app.db
      .select()
      .from(schema.jobInputs)
      .where(eq(schema.jobInputs.jobId, step2JobId));
    expect(step2InputsAfter.upperGarmentKey).toBe(mannequinResultKey);

    const stream = await app.redis.xrange('jobs:normal', '-', '+');
    const enqueuedJobIds = stream.map(([, fields]) => fields[fields.indexOf('jobId') + 1]);
    expect(enqueuedJobIds).toContain(step2JobId);
  });
});
```

**The dispatcher-import in the third test is the one part of this plan requiring
verification at implementation time**: `apps/dispatcher` and `apps/api` are separate
workspace packages, and importing dispatcher source directly from an API-package test file
may not resolve cleanly (relative path, or dispatcher's own tsconfig/module settings may not
be reachable from `apps/api`'s test runner). **If the relative import above does not work**,
the fallback is to skip step-by-step promoter verification in this integration test and
instead cover it with a dispatcher-side test in `apps/dispatcher/test/` (check whether that
directory exists and what pattern it uses — `saree-step2-promoter.ts` may already have direct
test coverage from when it was built for Studio's flow; if so, this task's job is only to
prove `createMerchantCatalogJob` produces the exact same PENDING_MANNEQUIN + mannequinJobId
shape Studio's `createSareeMannequinJob` does, which the first two tests above already do
without needing the promoter import at all — the third test is a nice-to-have full-loop proof,
not the only test carrying this task's real coverage).

- [x] **Step 3: Run the tests, confirm the new ones fail correctly, then confirm they pass**

Run (from `apps/api`, `pnpm docker:up` first):
`npx vitest run --config vitest.integration.config.ts test/integration/merchant-catalog-generate.test.ts`
Expected before the Step 1 code change: new tests fail (no `secondFlatImageKey` handling on
this path yet, `garmentType` select missing the new column, etc.). After Step 1: all pass,
including every pre-existing test in this file (no regression to the single-input or
`mannequinOnly` paths).

- [x] **Step 4: Commit**

```bash
git add apps/api/src/modules/merchant/create-job.ts apps/api/test/integration/merchant-catalog-generate.test.ts
git commit -m "feat(merchant-catalog): two-input mannequin drape for the full-composite generate path"
```

---

## Task 3: Wire `secondFlatImageKey` through the route handler

**Files:**
- Modify: `apps/api/src/modules/merchant/catalog.routes.ts`

- [x] **Step 1: Pass the field through**

The `/v1/merchant/catalog/generate` handler (around line 859-909) currently reads:

```ts
      const { subcategoryId, flatImageKey, mannequinOnly, sareeStyleId, secondFlatImageKey } =
        req.body as z.infer<typeof MerchantCatalogGenerateBody>;
```

and later:

```ts
      const { jobId } = mannequinOnly
        ? await createMerchantSareeMannequinJob(app, {
            userId: row.userId,
            garmentSubcategoryId: row.garmentSubcategoryId,
            flatImageKey,
            merchantId,
            sareeStyleId,
            secondFlatImageKey,
          })
        : await createMerchantCatalogJob(app, {
            userId: row.userId,
            garmentSubcategoryId: row.garmentSubcategoryId,
            category: row.category,
            flatImageKey,
            subcategoryId,
            merchantId,
          });
```

Change only the non-`mannequinOnly` branch to also forward `secondFlatImageKey` (leave the
`mannequinOnly` branch untouched — it already forwards it, that's the existing, working,
different feature):

```ts
        : await createMerchantCatalogJob(app, {
            userId: row.userId,
            garmentSubcategoryId: row.garmentSubcategoryId,
            category: row.category,
            flatImageKey,
            subcategoryId,
            merchantId,
            secondFlatImageKey,
          });
```

`sareeStyleId` is deliberately **not** forwarded to `createMerchantCatalogJob` — see Context
above on why style selection is out of scope for this path.

- [x] **Step 2: Run Task 2's tests again to confirm the route-level wiring works end to end**

Run: `npx vitest run --config vitest.integration.config.ts test/integration/merchant-catalog-generate.test.ts`
(from `apps/api`) — these tests already exercise the route, not just the function directly, so
this step is really just re-confirming Task 2 is still green after this change; no new test
file needed for this task.

- [x] **Step 3: Commit**

```bash
git add apps/api/src/modules/merchant/catalog.routes.ts
git commit -m "feat(merchant-catalog): forward secondFlatImageKey to the full-composite generate path"
```

---

## Task 4: Frontend — Pallu upload box in ProductModal

**Files:**
- Modify: `apps/catalogues-web/src/app/(app)/tryon/CatalogueManagerContent.tsx`
- Modify: `apps/catalogues-web/src/app/(app)/tryon/ProductModal.tsx`

- [x] **Step 1: Pass the selected subcategory's capability flag down**

In `CatalogueManagerContent.tsx`, the `<ProductModal ... subcategoryId={selectedSubcategoryId} ... />`
call (line 816) gains one prop, using the `selectedSub` object already computed at line 229:

```tsx
      <ProductModal
        open={prodModalOpen}
        onClose={() => {
          setProdModalOpen(false);
          setEditingProd(undefined);
        }}
        onSaved={handleProductSaved}
        subcategoryId={selectedSubcategoryId}
        supportsTwoInputMannequin={selectedSub?.supportsTwoInputMannequin ?? false}
        initialData={editingProd}
      />
```

- [x] **Step 2: Add the prop and state to `ProductModal.tsx`**

Add to `ProductModalProps` (currently lines 10-16):

```ts
interface ProductModalProps {
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
  subcategoryId: string | null;
  supportsTwoInputMannequin: boolean;
  initialData?: MerchantCatalogItem;
}
```

Add to the component's params (line 18-24) and add pallu file/preview state next to the
existing `selectedFile`/`previewUrl` state (currently around lines 32-33):

```ts
export function ProductModal({
  open,
  onClose,
  onSaved,
  subcategoryId,
  supportsTwoInputMannequin,
  initialData,
}: ProductModalProps) {
  // ...existing state...
  const [selectedFile, setSelectedFile] = useState<File | undefined>(undefined);
  const [previewUrl, setPreviewUrl] = useState<string | undefined>(undefined);
  // Pallu is only relevant in 'flat' imageMode for a two-input-capable subcategory —
  // mirrors Studio's Body/Pallu pair (studio/page.tsx's palluGarmentFile/palluGarmentKey).
  const [palluFile, setPalluFile] = useState<File | undefined>(undefined);
  const [palluPreviewUrl, setPalluPreviewUrl] = useState<string | undefined>(undefined);
```

Reset it alongside the other per-open state (in the existing `useEffect` at lines 49-70):

```ts
      setSelectedFile(undefined);
      setPreviewUrl(undefined);
      setPalluFile(undefined);
      setPalluPreviewUrl(undefined);
```

And revoke its object URL alongside the existing cleanup (existing `useEffect` at lines
73-77):

```ts
  useEffect(() => {
    if (open) return;
    if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current);
    if (palluPreviewUrlRef.current) URL.revokeObjectURL(palluPreviewUrlRef.current);
    if (generatedItemRef.current) void deleteProduct(generatedItemRef.current.id);
  }, [open]);
```

which needs a matching ref (next to the existing `previewUrlRef`, around line 43):

```ts
  const palluPreviewUrlRef = useRef<string | undefined>(undefined);
  palluPreviewUrlRef.current = palluPreviewUrl;
```

- [x] **Step 3: Add the upload handler**

Next to `handleFileChange` (currently lines 118-130):

```ts
  const handlePalluFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (palluPreviewUrl) URL.revokeObjectURL(palluPreviewUrl);
    setPalluFile(file);
    setPalluPreviewUrl(URL.createObjectURL(file));
    setErrorMsg(undefined);
    if (generatedItem) {
      void deleteProduct(generatedItem.id);
      setGeneratedItem(undefined);
    }
  };
```

- [x] **Step 4: Require it before Generate is enabled, and send it**

`missingImage` (currently line 166-168) needs to also require the pallu file when it's
applicable:

```ts
  const requiresPallu = imageMode === 'flat' && supportsTwoInputMannequin;
  const missingImage =
    !isEditing &&
    ((imageMode === 'catalogue' && !selectedFile) ||
      (imageMode === 'flat' && (!generatedItem && (!selectedFile || (requiresPallu && !palluFile)))));
```

(Re-derive this carefully against the actual current condition at implementation time — the
existing logic already has a `!generatedItem` implicit branch via `imageMode === 'flat' &&
!generatedItem`; the point is: in flat mode, before a `generatedItem` exists, both
`selectedFile` and — when `requiresPallu` — `palluFile` must be present.)

`handleGenerate` (currently lines 132-161) sends the second key:

```ts
  const handleGenerate = async () => {
    if (!selectedFile || !subcategoryId) return;
    if (requiresPallu && !palluFile) return;
    setIsGenerating(true);
    setErrorMsg(undefined);
    try {
      if (generatedItem) {
        await deleteProduct(generatedItem.id);
        setGeneratedItem(undefined);
      }
      const { r2Key: flatImageKey } = await presignAndUpload(selectedFile, 'flat');
      const secondFlatImageKey = requiresPallu
        ? (await presignAndUpload(palluFile as File, 'flat')).r2Key
        : undefined;
      const { jobId } = await api.post<{ jobId: string }>('/v1/merchant/catalog/generate', {
        subcategoryId,
        flatImageKey,
        ...(secondFlatImageKey ? { secondFlatImageKey } : {}),
      });
      const status = await pollGenerateJob(jobId);
      // ...rest unchanged...
```

- [x] **Step 5: Add the upload box UI**

Inside the `imageMode === 'flat'` branch (currently around lines 384-554), the "Choose a
different image" / pre-generate state (lines 472-499, the `!generatedItem` branch inside the
`previewUrl` truthy case) needs the pallu box rendered alongside the body preview. Add it
right after the existing body-image `<div>` block (the one with `width: 104, height: 130`,
lines 425-462) and before the buttons `<div>` (line 463), only when `requiresPallu`:

```tsx
                      {requiresPallu && (
                        <div
                          // biome-ignore lint/a11y/useKeyWithClickEvents: simple click trigger
                          onClick={() => !busy && palluInputRef.current?.click()}
                          style={{
                            width: 104,
                            height: 130,
                            borderRadius: 8,
                            border: `1px dashed ${C.border2}`,
                            background: palluPreviewUrl ? C.field : 'transparent',
                            position: 'relative',
                            overflow: 'hidden',
                            flexShrink: 0,
                            cursor: busy ? 'not-allowed' : 'pointer',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                        >
                          {palluPreviewUrl ? (
                            // eslint-disable-next-line @next/next/no-img-element
                            // biome-ignore lint/performance/noImgElement: local preview
                            <img
                              src={palluPreviewUrl}
                              alt="Pallu"
                              style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                            />
                          ) : (
                            <div style={{ textAlign: 'center', padding: 8 }}>
                              <UploadIcon size={20} />
                              <div style={{ fontSize: 11, color: C.mid, marginTop: 4 }}>
                                Upload Pallu
                              </div>
                            </div>
                          )}
                        </div>
                      )}
```

with a second hidden file input next to the existing one (currently lines 558-565):

```tsx
          <input
            type="file"
            ref={fileInputRef}
            onChange={handleFileChange}
            accept="image/jpeg,image/png,image/webp"
            style={{ display: 'none' }}
            tabIndex={-1}
          />
          <input
            type="file"
            ref={palluInputRef}
            onChange={handlePalluFileChange}
            accept="image/jpeg,image/png,image/webp"
            style={{ display: 'none' }}
            tabIndex={-1}
          />
```

which needs its own ref (next to `fileInputRef`, line 41):

```ts
  const palluInputRef = useRef<HTMLInputElement>(null);
```

Also update the "Click to upload product image" empty-state hint text (line 410, `Upload
flat garment photo`) to say `Upload the body (front) photo` when `requiresPallu` is true, so
the merchant understands this is now specifically the *body* half — small text-only change,
no new component needed.

- [x] **Step 6: Lint and typecheck**

Run (from repo root):
`npx biome check apps/catalogues-web/src/app/(app)/tryon/ProductModal.tsx apps/catalogues-web/src/app/(app)/tryon/CatalogueManagerContent.tsx`
and
`pnpm --filter @tryme/web typecheck`
Expected: both clean.

- [x] **Step 7: Manual verification**

Run: `pnpm --filter @tryme/web dev`. As a test merchant with a saree subcategory
configured (`requires_mannequin_step: true`, `mannequin_two_input_workflow_template_id` set),
open Add Product → Flat Image mode → confirm the Pallu box appears, confirm Generate stays
disabled until both images are chosen, confirm generating produces a job and eventually a
product exactly like the single-input path does today. Then open Add Product for a
**non**-saree subcategory and confirm the Pallu box does **not** appear and the flow is
unchanged from before this plan.

- [x] **Step 8: Commit**

```bash
git add apps/catalogues-web/src/app/(app)/tryon/ProductModal.tsx apps/catalogues-web/src/app/(app)/tryon/CatalogueManagerContent.tsx
git commit -m "feat(catalogues-web): add Pallu upload to Add Product for two-input-capable saree types"
```

---

## Explicitly out of scope

- **`sareeStyleId` picker in ProductModal.** No existing UI surface for it in this modal or
  in Studio's own two-input flow; adding one is new, unrequested UI. The garment type's
  default two-input workflow is used unconditionally when both images are present.
- **Bulk "Add Product" two-input support** (`/v1/merchant/catalog/generate-bulk`,
  `BulkUploadModal.tsx`). Bulk generate is single-flat-image-per-row by construction
  (`flatImageKeys: string[]`, no pairing concept); adding two-input there is a materially
  different UI (pairing N body images with N pallu images) and not part of this plan.
  `createMerchantCatalogJob`'s bulk caller (`apps/api/src/modules/merchant/catalog.routes.ts`,
  `/generate-bulk` handler) is untouched by this plan and never passes `secondFlatImageKey`.
- **`createMerchantSareeMannequinJob` / `mannequinOnly` branch.** Confirmed live, working,
  and serving a different product surface (99 production jobs, real merchants) — not modified.
- **`runMannequinPhase` / the shared inline single-image mannequin path.** Every other
  merchant catalog job (non-saree, or saree without a second image) keeps using it exactly as
  today. This plan adds a parallel path for the two-input case rather than extending the
  shared one, to keep the blast radius of this change confined to the new branch.
