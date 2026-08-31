# Saree Two-Step Generation Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make saree (`requiresMannequinStep`) generation resilient to navigation/tab-close between step 1 (mannequin) and step 2 (tryon), and make the Studio preview panel reflect "processing started" immediately on submit.

**Architecture:** Move step-2 job creation from client-triggered (`POST /v1/jobs/tryon` fired by browser JS after it observes step-1's SSE `COMPLETED` event) to fully server-side. `POST /v1/jobs/saree-mannequin` now validates and creates **both** the step-1 mannequin job **and** the step-2 tryon job row(s) in one Postgres transaction — step-2 rows start in a new non-terminal status `PENDING_MANNEQUIN` with credits already deducted and `upperGarmentKey` left `null`. A new dispatcher-side periodic sweep (`promoteSareeStep2Jobs`) watches for `PENDING_MANNEQUIN` jobs whose linked mannequin job has reached `COMPLETED` (fills in `upperGarmentKey`, flips to `QUEUED`, enqueues to the Redis stream) or `FAILED`/`CANCELLED` (refunds + marks the child `FAILED`). None of this depends on any HTTP/SSE client connection remaining open, mirroring how the rest of dispatcher job processing already works (see "Invariants" in `CLAUDE.md`: dispatcher/Postgres/Redis only, api never touches ComfyUI, dispatcher never touches api).

The Studio frontend collapses to a single call for the saree path (`POST /v1/jobs/saree-mannequin` with the full step-2 payload embedded) that returns `{catalogueId, jobIds}` exactly like the non-saree `POST /v1/jobs/tryon` path, so `activeGeneration` is set immediately and the right-hand preview panel switches to `GenerationPanel` on submit — fixing both reported bugs from the same root-cause change.

**Tech Stack:** Fastify 5, Zod, Drizzle ORM/Postgres, Redis Streams, Next.js 15, Vitest (existing docker-compose based integration harness — no testcontainers).

## Global Constraints

- No DB migration needed for the new `PENDING_MANNEQUIN` status — `jobs.status` is a plain `text` column (`packages/db/src/schema/jobs.ts:24`, `status: text('status').notNull().default('QUEUED')`), not a Postgres enum. Do not add a migration for this.
- `mannequinJobId` (linking a step-2 job back to its step-1 job) is stored inside `job_inputs.params` JSONB, not a new column — mirrors the existing `sourceJobId` pattern in `createSimpleTryonJob` (`apps/api/src/modules/jobs/create.ts:747`) and the existing `params->>'kind'` JSONB read pattern already used in `resolveMannequinGarmentKey` (`apps/api/src/modules/jobs/create.ts:43`). No migration needed (`params` is `jsonb`, nullable, already exists).
- Credit deduct + job insert must remain one Postgres transaction (existing invariant, `CLAUDE.md`). The new step-2 rows must be inserted and deducted in the **same transaction** as the step-1 mannequin job row.
- Do not touch `apps/admin-mobile` (paused, out of scope per `CLAUDE.md`).
- Never call from dispatcher to `apps/api` over HTTP — there is no precedent for this in the codebase (confirmed: zero `fetch()` calls from dispatcher target the API; all cross-service state goes through Postgres/Redis directly). The promoter must write directly to Postgres/Redis, not call an API route.
- Follow the existing `ProcessorConfig` container pattern (`db`, `redis`, `pub`, `storage`, `s3`, `r2Bucket`, `log`) for any new dispatcher code — do not introduce a Fastify-style app object into dispatcher.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/types/src/jobs.ts` | Modify: split `CreateTryOnJobInputs` so its base object is reusable; add `SareeStep2Inputs`; extend `CreateSareeMannequinJobRequest` with an embedded `step2` payload. |
| `apps/api/src/modules/jobs/create.ts` | Modify: extract `resolveTryonPlan()` (validation + cost/dims + pose/background/catalog resolution + workflow node resolution) out of `createJob()` so `createSareeMannequinJob()` can reuse it without duplicating ~350 lines of validation. |
| `apps/api/src/modules/jobs/createSareeMannequin.ts` | Modify: create the mannequin job row **and** N `PENDING_MANNEQUIN` step-2 job rows in one transaction; deduct credits for step-2 up front; return `{catalogueId, jobIds}`. |
| `apps/dispatcher/src/job/saree-step2-promoter.ts` | New: periodic sweep that promotes `PENDING_MANNEQUIN` jobs once their mannequin parent resolves (`COMPLETED` → fill garment key + enqueue; `FAILED`/`CANCELLED` → refund + fail child). |
| `apps/dispatcher/src/index.ts` | Modify: wire a new `setInterval` for the promoter, alongside the existing `sweeperInterval`/`recoveryInterval`. |
| `apps/dispatcher/src/job/state.ts` | Modify: add `'PENDING_MANNEQUIN'` to the `JobStatus` union. |
| `apps/api/src/modules/admin/jobs.routes.ts` | Modify: add `'PENDING_MANNEQUIN'` to the admin status-filter `z.enum`. |
| `apps/admin-web/src/types.ts` | Modify: mirror the status union for the admin panel. |
| `apps/catalogues-web/src/app/(app)/studio/page.tsx` | Modify: collapse the saree submit path into one request; delete `waitForMannequinJob`/`mannequinResolverRef`/`_mannequinWaitState`/the dedicated SSE subscribe. |
| `apps/catalogues-web/src/app/(app)/studio/generation-panel.tsx` | Modify: add `PENDING_MANNEQUIN` to `STATUS_PROGRESS`. |
| `apps/catalogues-web/src/app/(app)/catalogues/[id]/page.tsx` | Modify: add `PENDING_MANNEQUIN` to `STAGE_RANGES` + a "Preparing garment…" stage label. |
| `apps/api/test/integration/saree-mannequin-job.test.ts` | Modify: update existing tests for the new request/response contract; add new assertions for the created `PENDING_MANNEQUIN` step-2 rows. |
| `apps/dispatcher/test/*` (new file, exact path decided in Task 4) | New: unit/integration tests for `promoteSareeStep2Jobs`. |

---

### Task 1: Extend `packages/types` — step-2 payload embedded in the mannequin request

**Files:**
- Modify: `packages/types/src/jobs.ts:36-106`
- Test: `packages/types` has no dedicated test file for this; validated indirectly by Task 3's API tests. No standalone test step for this task — it is pure schema, verified by `pnpm typecheck` and by Task 3's integration tests importing it.

**Interfaces:**
- Produces: `CreateTryOnJobInputsBase` (plain `ZodObject`, no refine), `SareeStep2Inputs` (Zod schema — `CreateTryOnJobInputsBase` minus `upperGarmentKey`/`mannequinJobId`, its own XOR refine for `backgroundId+poseIds` vs `looks`), `CreateSareeMannequinJobRequest` (extended with a required `step2` field of shape `{ catalogueId?, inputs: SareeStep2Inputs, params?, userHint?, aspectRatio, resolution, platform? }`).
- Consumes: nothing new — depends only on existing `INPUT_GARMENT_KEY`.

- [ ] **Step 1: Restructure `CreateTryOnJobInputs` so its base object is extractable**

Replace `packages/types/src/jobs.ts:36-73` with:

```ts
export const CreateTryOnJobInputsBase = z.object({
  // Exactly one of upperGarmentKey (a fresh presigned upload) or mannequinJobId
  // (a completed saree-mannequin job's output, see createSareeMannequinJob) is
  // required — enforced below. mannequinJobId is only valid for garment types
  // with requiresMannequinStep=true (enforced server-side in createJob).
  upperGarmentKey: z.string().regex(INPUT_GARMENT_KEY).optional(),
  mannequinJobId: z.string().uuid().optional(),
  faceId: z.string().uuid(),
  // Legacy/custom form: a single shared background applied to every pose.
  backgroundId: z.string().uuid().optional(),
  poseIds: z.array(z.string().uuid()).min(1).optional(),
  // Template form: each pose carries its own background. Exactly one of
  // (backgroundId + poseIds) or looks must be provided — enforced below.
  looks: z
    .array(
      z.object({
        poseId: z.string().uuid(),
        backgroundId: z.string().uuid(),
      }),
    )
    .min(1)
    .max(12)
    .optional(),
  garmentTypeId: z.string().uuid().optional(),
  catalogueTemplateMappingId: z.string().uuid().optional(),
  lowerCatalogId: z.string().uuid().optional(),
  lowerGarmentKey: z.string().regex(INPUT_GARMENT_KEY).optional(),
  thirdGarmentKey: z.string().regex(INPUT_GARMENT_KEY).optional(),
  shoeCatalogId: z.string().uuid().optional(),
});

function refineLooksXor<T extends { backgroundId?: string; poseIds?: string[]; looks?: unknown }>(
  schema: z.ZodType<T>,
) {
  return schema.refine((d) => Boolean(d.backgroundId && d.poseIds) !== Boolean(d.looks), {
    message: 'Provide either (backgroundId + poseIds) or looks, not both',
  });
}

export const CreateTryOnJobInputs = refineLooksXor(CreateTryOnJobInputsBase).refine(
  (d) => Boolean(d.upperGarmentKey) !== Boolean(d.mannequinJobId),
  {
    message: 'Provide either upperGarmentKey or mannequinJobId, not both',
    path: ['upperGarmentKey'],
  },
);

// The step-2 payload embedded in POST /v1/jobs/saree-mannequin. Neither
// upperGarmentKey nor mannequinJobId is accepted from the client here — the
// dispatcher fills upperGarmentKey in once the mannequin job (created in the
// same request) completes, and mannequinJobId is derived server-side, not
// client-supplied. See createSareeMannequinJob.
export const SareeStep2Inputs = refineLooksXor(
  CreateTryOnJobInputsBase.omit({ upperGarmentKey: true, mannequinJobId: true }),
);
```

- [ ] **Step 2: Extend `CreateSareeMannequinJobRequest` with the embedded step-2 payload**

Replace `packages/types/src/jobs.ts:102-106` (the current `CreateSareeMannequinJobRequest`) with:

```ts
export const CreateSareeMannequinJobRequest = z.object({
  garmentTypeId: z.string().uuid(),
  garmentKey: z.string().regex(INPUT_GARMENT_KEY),
  faceId: z.string().uuid(),
  // Full step-2 (tryon) request, captured up front so the dispatcher can create
  // and enqueue the tryon job(s) itself once the mannequin job completes — see
  // createSareeMannequinJob and apps/dispatcher/src/job/saree-step2-promoter.ts.
  step2: z.object({
    catalogueId: z.string().uuid().optional(),
    inputs: SareeStep2Inputs,
    params: z
      .object({
        seedStage1: z.number().int().optional(),
        seedStage2: z.number().int().optional(),
        stepsStage1: z.number().int().min(1).max(30).optional(),
        stepsStage2: z.number().int().min(1).max(30).optional(),
        outputWidth: z.number().int().min(512).max(4096).optional(),
        outputHeight: z.number().int().min(512).max(4096).optional(),
      })
      .optional(),
    userHint: z.string().max(300).optional(),
    aspectRatio: z.enum(['1:1', '2:3', '3:4', '4:5']),
    resolution: z.enum(['HD', '2K', '4K']),
    platform: z.string().optional(),
  }),
});
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @tryme/types typecheck`
Expected: PASS (no consumers updated yet — that's Tasks 2/3, which will fail to typecheck until this step lands; this step only needs the package itself to compile).

- [ ] **Step 4: Commit**

```bash
git add packages/types/src/jobs.ts
git commit -m "feat(types): embed step-2 payload in saree-mannequin request schema"
```

---

### Task 2: Extract `resolveTryonPlan()` from `createJob()`

**Files:**
- Modify: `apps/api/src/modules/jobs/create.ts:60-622`
- Test: `apps/api/test/integration/jobs-tryon.test.ts` (existing — verify it still exists and covers `createJob`; if the exact filename differs, locate the real one via `grep -rl "createJob\|/v1/jobs/tryon" apps/api/test/integration/`). This task is a pure refactor — no new behavior, no new test. The existing tryon integration test suite is the regression guard.

**Interfaces:**
- Produces: `resolveTryonPlan(app, userId, body, opts): Promise<TryonPlan>` where:
  ```ts
  export interface TryonPlanLook {
    poseId: string;
    backgroundId: string;
    upperGarmentKey: string | null;
    lowerCatalogId: string | null;
    lowerGarmentKey: string | null;
    shoeCatalogId: string | null;
    workflowTemplateId: string | null;
    promptGarmentPhase: string | null;
    params: Record<string, unknown>;
  }
  export interface TryonPlan {
    catalogueId: string;
    cost: number;
    looks: TryonPlanLook[];
  }
  ```
  `opts: { resolvedUpperGarmentKey: string | null; catalogueId?: string }` — caller resolves `upperGarmentKey` (via `resolveMannequinGarmentKey` or `verifyGarmentKey`) or explicitly passes `null` when it must be filled in later (the saree-mannequin path).
- Consumes: nothing new from other tasks.

- [ ] **Step 1: Confirm the existing tryon integration test passes before refactoring (baseline)**

Run: `pnpm --filter @tryme/api test -- tryon` (adjust the `-t`/file filter to whatever matches `create.ts`'s existing coverage — inspect `apps/api/test/integration/` for the exact filename first: `grep -rl "jobs/tryon'" apps/api/test/integration/`)
Expected: PASS (establishes the safety net before moving code).

- [ ] **Step 2: Extract the validation block into `resolveTryonPlan`**

In `apps/api/src/modules/jobs/create.ts`, cut the body of `createJob` from the `requiresMannequinStep` computation (current line 113) through the end of the `poseWorkflows`/`poseWorkflowMap`/per-pose validation loop (current line 505), **excluding** the `resolvedUpperGarmentKey` resolution block (current lines 155-179, which stays a caller concern) and **excluding** the user/credit-plan/queueStream lookup (current lines 507-525, which `createSareeMannequinJob` already does once for its own mannequin job and will pass through). Paste it as the body of a new exported function:

```ts
export interface TryonPlanLook {
  poseId: string;
  backgroundId: string;
  upperGarmentKey: string | null;
  lowerCatalogId: string | null;
  lowerGarmentKey: string | null;
  shoeCatalogId: string | null;
  workflowTemplateId: string | null;
  promptGarmentPhase: string | null;
  params: Record<string, unknown>;
}

export interface TryonPlan {
  catalogueId: string;
  cost: number;
  looks: TryonPlanLook[];
}

export async function resolveTryonPlan(
  app: FastifyInstance,
  userId: string,
  body: z.infer<typeof CreateTryOnJobRequest> | {
    catalogueId?: string;
    inputs: z.infer<typeof SareeStep2Inputs>;
    params?: z.infer<typeof CreateTryOnJobRequest>['params'];
    userHint?: string;
    aspectRatio: string;
    platform?: string;
  },
  opts: { resolvedUpperGarmentKey: string | null },
): Promise<TryonPlan> {
  const {
    faceId,
    garmentTypeId,
    catalogueTemplateMappingId,
    lowerCatalogId,
    lowerGarmentKey,
    thirdGarmentKey,
    shoeCatalogId,
  } = body.inputs;
  const aspectRatio: string | undefined = body.aspectRatio;
  const platform: string | undefined = body.platform;
  const resolvedUpperGarmentKey = opts.resolvedUpperGarmentKey ?? undefined;

  // S1: compute cost server-side from actual output dims — never trust client's `resolution`.
  const customW = body.params?.outputWidth;
  const customH = body.params?.outputHeight;
  const requestedDims =
    customW && customH
      ? { width: customW, height: customH }
      : (ASPECT_DIMENSIONS[body.aspectRatio] ?? { width: 2048, height: 2048 });
  // Platform-wide resolution ceiling — admin-configured, not per-workflow (see
  // getMaxOutputPx). Only downscale, and only the long edge exceeding it; the
  // dispatcher patches the workflow with whatever dims land in job_inputs.params,
  // so this is the single enforcement point.
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
  const COST = await getResolutionCreditCost(app, resolution);

  // Flat-saree (and any future two-pass) garment types resolve their garment
  // input from a completed mannequin job instead of a fresh upload, and use a
  // single fixed step-2 workflow for every pose (its own lowerNodeId/shoeNodeId
  // govern validation below) instead of each pose's own default workflow or any
  // pose_garment_configs override.
  let requiresMannequinStep = false;
  let sareeStep2: {
    workflowTemplateId: string | null;
    upperNodeIds: string[] | null;
    lowerNodeId: string | null;
    shoeNodeId: string | null;
    sizeNodeIds: string[] | null;
  } | null = null;
  if (garmentTypeId) {
    const [gtRow] = await app.db
      .select({
        requiresMannequinStep: schema.garmentSubcategories.requiresMannequinStep,
        sareeStep2WorkflowTemplateId: schema.garmentSubcategories.sareeStep2WorkflowTemplateId,
        sareeStep2UpperNodeIds: schema.workflowTemplates.upperNodeIds,
        sareeStep2LowerNodeId: schema.workflowTemplates.lowerNodeId,
        sareeStep2ShoeNodeId: schema.workflowTemplates.shoeNodeId,
        sareeStep2SizeNodeIds: schema.workflowTemplates.sizeNodeIds,
      })
      .from(schema.garmentSubcategories)
      .leftJoin(
        schema.workflowTemplates,
        eq(schema.workflowTemplates.id, schema.garmentSubcategories.sareeStep2WorkflowTemplateId),
      )
      .where(eq(schema.garmentSubcategories.id, garmentTypeId));
    requiresMannequinStep = gtRow?.requiresMannequinStep ?? false;
    if (requiresMannequinStep) {
      sareeStep2 = {
        workflowTemplateId: gtRow?.sareeStep2WorkflowTemplateId ?? null,
        upperNodeIds: gtRow?.sareeStep2UpperNodeIds ?? null,
        lowerNodeId: gtRow?.sareeStep2LowerNodeId ?? null,
        shoeNodeId: gtRow?.sareeStep2ShoeNodeId ?? null,
        sizeNodeIds: gtRow?.sareeStep2SizeNodeIds ?? null,
      };
    }
  }

  if (requiresMannequinStep && opts.resolvedUpperGarmentKey === undefined) {
    throw new AppError('VALIDATION', 400, 'mannequinJobId required for this garment type');
  }

  if (lowerGarmentKey) await verifyGarmentKey(app, userId, lowerGarmentKey);
  if (thirdGarmentKey) await verifyGarmentKey(app, userId, thirdGarmentKey);

  // Normalize to a single per-look list. This only rejects "neither form present" —
  // it does not independently re-enforce "not both", since CreateTryOnJobInputs's
  // zod .refine() (a true XOR via !==) already guarantees that upstream of every
  // route that calls createJob (and SareeStep2Inputs' own refine does the same for
  // the saree-mannequin path). This guard exists because TS can't see the refine's
  // constraint through the optional fields on body.inputs.
  const legacyBackgroundId = body.inputs.backgroundId;
  const legacyPoseIds = body.inputs.poseIds;
  const templateLooks = body.inputs.looks;
  if (!templateLooks && !(legacyBackgroundId && legacyPoseIds)) {
    throw new AppError(
      'VALIDATION',
      400,
      'inputs must include either backgroundId+poseIds or looks',
    );
  }

  let looks: Array<{ poseId: string; backgroundId: string }>;
  if (templateLooks) {
    // Per-look backgrounds are authoritative for templates — the Amazon white-bg
    // override below must never run for this form.
    looks = templateLooks;
  } else {
    // Amazon platform requires a white background — override the single shared
    // background with the one tagged isWhiteBg in the admin panel. Only applies
    // to the legacy form; template backgrounds are never overridden.
    let effectiveBackgroundId = legacyBackgroundId as string;
    if (platform === 'Amazon') {
      const [whiteBg] = await app.db
        .select({ id: schema.modelBackgrounds.id })
        .from(schema.modelBackgrounds)
        .where(
          and(
            eq(schema.modelBackgrounds.isActive, true),
            eq(schema.modelBackgrounds.isWhiteBg, true),
          ),
        )
        .limit(1);
      if (!whiteBg) {
        throw new AppError(
          'VALIDATION',
          400,
          'Amazon platform requires a white background to be configured',
        );
      }
      effectiveBackgroundId = whiteBg.id;
      app.log.info(
        { originalBg: legacyBackgroundId, amazonBg: effectiveBackgroundId, platform },
        'amazon bg override',
      );
    }
    looks = (legacyPoseIds as string[]).map((poseId) => ({
      poseId,
      backgroundId: effectiveBackgroundId,
    }));
  }

  // Only exact (poseId, backgroundId) duplicates are rejected. Same pose with two
  // DIFFERENT backgrounds is allowed by design — a template can legitimately offer
  // "Pose A @ Background 1" and "Pose A @ Background 2" as two distinct looks.
  const dedupeKeys = new Set(looks.map((l) => `${l.poseId}::${l.backgroundId}`));
  if (dedupeKeys.size !== looks.length) {
    throw new AppError('VALIDATION', 400, 'duplicate pose+background combination in looks');
  }

  // --- Mechanical cut from here: copy current create.ts lines 245-457 VERBATIM
  // (distinctPoseIds/distinctBackgroundIds computation; the Promise.all of
  // face/backgroundRows/poses lookups; the face/backgroundRows/poses not-found
  // checks; the S6 catalogChecks Promise.all + its three not-found checks; the
  // mappingPoseWorkflows catalogueTemplateMappingId block; the defaultWorkflow/
  // overrideWorkflow aliasedTable + poseWorkflowRows query; the
  // config-disabled-pose rejection) into this exact point, unmodified — every
  // identifier it references (garmentTypeId, distinctPoseIds, distinctBackgroundIds,
  // looks, catalogueTemplateMappingId, templateLooks, mappingPoseWorkflows,
  // poseWorkflowRows) is already in scope from the code above. Do not
  // hand-retype it — open create.ts, select lines 245-457, cut, paste here. ---

  const poseWorkflows = requiresMannequinStep
    ? distinctPoseIds.map((poseId) => ({
        poseId,
        workflowTemplateId: sareeStep2?.workflowTemplateId ?? null,
        promptGarmentPhase: null,
        upperNodeIds: sareeStep2?.upperNodeIds ?? [],
        lowerNodeId: sareeStep2?.lowerNodeId ?? null,
        shoeNodeId: sareeStep2?.shoeNodeId ?? null,
        sizeNodeIds: sareeStep2?.sizeNodeIds ?? null,
      }))
    : (mappingPoseWorkflows ??
      poseWorkflowRows.map((r) => ({
        poseId: r.poseId,
        workflowTemplateId: r.configWorkflowTemplateId ?? r.defaultWorkflowTemplateId,
        promptGarmentPhase: null,
        upperNodeIds:
          r.configWorkflowTemplateId != null
            ? (r.overrideUpperNodeIds ?? [])
            : (r.defaultUpperNodeIds ?? []),
        lowerNodeId:
          r.configWorkflowTemplateId != null ? r.overrideLowerNodeId : r.defaultLowerNodeId,
        shoeNodeId: r.configWorkflowTemplateId != null ? r.overrideShoeNodeId : r.defaultShoeNodeId,
        sizeNodeIds:
          r.configWorkflowTemplateId != null ? r.overrideSizeNodeIds : r.defaultSizeNodeIds,
      })));

  const poseWorkflowMap = new Map(poseWorkflows.map((pw) => [pw.poseId, pw]));

  for (const pw of poseWorkflows) {
    if (pw.upperNodeIds.length > 0 && opts.resolvedUpperGarmentKey === undefined) {
      throw new AppError('VALIDATION', 400, 'upper garment required for this pose');
    }
    if (pw.lowerNodeId) {
      if (pw.upperNodeIds.length === 0) {
        // A sole lower hero must be the customer's upload, not a generic catalog image.
        if (!lowerGarmentKey) {
          throw new AppError('VALIDATION', 400, 'lower garment upload required for this pose');
        }
      } else if (!lowerCatalogId && !lowerGarmentKey) {
        throw new AppError('VALIDATION', 400, 'lower garment required for this pose');
      }
    }
    if (pw.shoeNodeId && !shoeCatalogId) {
      throw new AppError('VALIDATION', 400, 'shoe catalog item required for this pose');
    }
  }

  const catalogueId = ('catalogueId' in body ? body.catalogueId : undefined) ?? randomUUID();
  const looks_: TryonPlanLook[] = looks.map((look) => {
    const pw = poseWorkflowMap.get(look.poseId);
    const lookUpperGarmentKey =
      pw?.upperNodeIds && pw.upperNodeIds.length > 0 ? (resolvedUpperGarmentKey ?? null) : null;
    const effectiveLowerCatalogId =
      pw?.lowerNodeId && !lowerGarmentKey ? (lowerCatalogId ?? null) : null;
    const effectiveLowerGarmentKey = pw?.lowerNodeId && lowerGarmentKey ? lowerGarmentKey : null;
    const effectiveShoeCatalogId = pw?.shoeNodeId ? (shoeCatalogId ?? null) : null;
    return {
      poseId: look.poseId,
      backgroundId: look.backgroundId,
      upperGarmentKey: lookUpperGarmentKey,
      lowerCatalogId: effectiveLowerCatalogId,
      lowerGarmentKey: effectiveLowerGarmentKey,
      shoeCatalogId: effectiveShoeCatalogId,
      workflowTemplateId: pw?.workflowTemplateId ?? null,
      promptGarmentPhase: pw?.promptGarmentPhase ?? null,
      params: {
        ...(body.params ?? {}),
        outputWidth: outputDims.width,
        outputHeight: outputDims.height,
        ...(aspectRatio ? { aspectRatio } : {}),
        resolution,
        ...(platform ? { platform } : {}),
        ...(catalogueTemplateMappingId
          ? {
              catalogueTemplateMappingId,
              workflowTemplateId: pw?.workflowTemplateId,
              ...(pw?.promptGarmentPhase ? { promptGarmentPhase: pw.promptGarmentPhase } : {}),
            }
          : {}),
      },
    };
  });

  return { catalogueId, cost: COST, looks: looks_ };
}
```

Notes on the mechanical cut:
- The `verifyGarmentKey` closure (current lines 159-165) becomes a standalone exported helper `verifyGarmentKey(app, userId, key, trustedGarmentKeys?)` — hoist it above `resolveTryonPlan` and `createJob` both call it the same way they do today (`opts?.trustedGarmentKeys` only applies to `createJob`'s own `upperGarmentKey`/`lowerGarmentKey`/`thirdGarmentKey` resolution — those calls stay in `createJob`, not in `resolveTryonPlan`, since `resolveTryonPlan` never resolves `upperGarmentKey` itself).
- Every reference to `mannequinJobId` that previously drove `resolvedUpperGarmentKey` resolution stays OUT of `resolveTryonPlan` — that resolution (`resolveMannequinGarmentKey` vs `verifyGarmentKey`) remains exclusively in `createJob`.
- The `!requiresMannequinStep && mannequinJobId` rejection (current line 151-153) also stays in `createJob` only, since `resolveTryonPlan`'s second parameter type has no `mannequinJobId` field at all when called from the saree path.

- [ ] **Step 3: Rewrite `createJob` to call `resolveTryonPlan` then materialize QUEUED rows**

Replace the body of `createJob` (after its existing `resolvedUpperGarmentKey` resolution block, current lines 155-179) with:

```ts
  const plan = await resolveTryonPlan(app, userId, body, { resolvedUpperGarmentKey: resolvedUpperGarmentKey ?? null });

  const [[user], [planRow]] = await Promise.all([
    app.db.select().from(schema.users).where(eq(schema.users.id, userId)),
    app.db
      .select({
        queueStream: schema.creditPlans.queueStream,
        watermark: schema.creditPlans.watermark,
      })
      .from(schema.users)
      .innerJoin(schema.creditPlans, eq(schema.users.tier, schema.creditPlans.slug))
      .where(eq(schema.users.id, userId)),
  ]);
  if (!user || user.isBanned) throw new AppError('FORBIDDEN', 403, 'banned');

  const queueStream: string = planRow?.queueStream ?? 'normal';
  const priority = queueStream === 'priority';
  const watermark: boolean = planRow?.watermark ?? false;

  const jobIds = await app.db.transaction(async (tx) => {
    const created: string[] = [];
    for (const look of plan.looks) {
      const [job] = await tx
        .insert(schema.jobs)
        .values({
          userId,
          catalogueId: plan.catalogueId,
          status: 'QUEUED',
          priority,
          queueStream,
          watermark,
          creditsCharged: plan.cost,
          source: 'catalog',
        })
        .returning();
      await atomicDeduct(tx as unknown as DB, userId, plan.cost, job.id);
      await tx.insert(schema.jobInputs).values({
        jobId: job.id,
        upperGarmentKey: look.upperGarmentKey,
        faceId,
        backgroundId: look.backgroundId,
        poseId: look.poseId,
        garmentTypeId: garmentTypeId ?? null,
        lowerCatalogId: look.lowerCatalogId,
        lowerGarmentKey: look.lowerGarmentKey,
        thirdGarmentKey: thirdGarmentKey ?? null,
        shoeCatalogId: look.shoeCatalogId,
        userHint: promptGuard(body.userHint),
        params: look.params,
      });
      created.push(job.id);
    }
    return created;
  });

  const stream = `jobs:${queueStream}`;
  const failedEnqueues: string[] = [];
  for (const jobId of jobIds) {
    try {
      await app.redis.xadd(stream, 'MAXLEN', '~', 10000, '*', 'jobId', jobId, 'userId', userId);
      jobsCreatedTotal.inc({ priority: queueStream, kind: 'catalogue' });
    } catch (err) {
      app.log.error({ err, jobId }, 'redis xadd failed — job will be refunded');
      failedEnqueues.push(jobId);
    }
  }

  if (failedEnqueues.length > 0) {
    await Promise.all(
      failedEnqueues.map(async (jobId) => {
        await refund(app.db, userId, plan.cost, jobId, 'REFUND_ENQUEUE_FAIL');
        await app.db
          .update(schema.jobs)
          .set({ status: 'FAILED', errorCode: 'ENQUEUE_FAIL' })
          .where(eq(schema.jobs.id, jobId));
      }),
    );
    if (failedEnqueues.length === jobIds.length) {
      throw new AppError('ENQUEUE_FAIL', 503, 'queue unavailable');
    }
  }

  return { catalogueId: plan.catalogueId, jobIds };
```

Delete the now-dead intermediate variables/blocks this replaces (the old inline `looks`/`poseWorkflowMap`/insert-loop code, current lines 181-622 up to `createSimpleTryonJob`) — everything from that block now lives inside `resolveTryonPlan` or the new materialize block above.

- [ ] **Step 4: Run the baseline test again to confirm the refactor is behavior-preserving**

Run: same command as Step 1
Expected: PASS — identical behavior, pure refactor.

- [ ] **Step 5: Typecheck the whole api app**

Run: `pnpm --filter @tryme/api typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/jobs/create.ts
git commit -m "refactor(api): extract resolveTryonPlan from createJob for reuse by saree-mannequin"
```

---

### Task 3: `createSareeMannequinJob` creates both jobs atomically

**Files:**
- Modify: `apps/api/src/modules/jobs/createSareeMannequin.ts` (full rewrite)
- Test: `apps/api/test/integration/saree-mannequin-job.test.ts` (existing — update payloads/assertions for the new contract)

**Interfaces:**
- Consumes: `resolveTryonPlan(app, userId, body, opts)` and `TryonPlan`/`TryonPlanLook` from Task 2 (`apps/api/src/modules/jobs/create.ts`).
- Produces: `createSareeMannequinJob(app, userId, body): Promise<{ catalogueId: string; jobIds: string[] }>` — same return shape as `createJob`. The mannequin job's own id is no longer returned to the caller; it is discoverable only via `job_inputs.params->>'mannequinJobId'` on the step-2 rows (admin/debugging path).

- [ ] **Step 1: Write the failing test — update the happy-path test for the new contract**

Replace the `'creates a 0-credit job with kind=saree_mannequin, enqueued'` test in `apps/api/test/integration/saree-mannequin-job.test.ts` (current lines 66-120) with:

```ts
  async function seedActiveBackground() {
    const [bg] = await app.db
      .insert(schema.modelBackgrounds)
      .values({ genderSlug: 'women', label: 'BG', r2Key: 'bg.jpg', isActive: true })
      .returning();
    return bg.id;
  }

  async function seedActivePose() {
    const [pose] = await app.db
      .insert(schema.modelPoseAssets)
      .values({ genderSlug: 'women', label: 'Pose', r2Key: 'pose.jpg', isActive: true })
      .returning();
    return pose.id;
  }

  it('creates a 0-credit mannequin job + PENDING_MANNEQUIN step-2 job(s), only the mannequin job enqueued', async () => {
    const { token, userId } = await registerUser('mannequin-happy@x.com');
    const faceId = await seedFace();
    const backgroundId = await seedActiveBackground();
    const poseId = await seedActivePose();
    const garmentTypeId = await seedFlatSareeGarmentType(true, null);
    const [wf] = await app.db
      .insert(schema.workflowTemplates)
      .values({
        slug: `saree-step1-${Date.now()}`,
        label: 'Step1',
        jsonContent: {},
        workflowType: 'saree_step1',
        faceNodeId: '',
        poseNodeId: '',
        bgNodeId: '',
        upperNodeIds: [],
        facePhasePromptNode: '',
        garmentPhasePromptNode: '',
        tryonPersonNodeId: '1',
        tryonGarmentNodeId: '2',
        tryonOutputNodeId: '3',
      })
      .returning();
    const [step2Wf] = await app.db
      .insert(schema.workflowTemplates)
      .values({
        slug: `saree-step2-${Date.now()}`,
        label: 'Step2',
        jsonContent: {},
        workflowType: 'saree_step2',
        faceNodeId: '',
        poseNodeId: '',
        bgNodeId: '',
        upperNodeIds: ['10'],
        facePhasePromptNode: '',
        garmentPhasePromptNode: '',
        tryonPersonNodeId: '1',
        tryonGarmentNodeId: '2',
        tryonOutputNodeId: '3',
      })
      .returning();
    await app.db
      .update(schema.garmentSubcategories)
      .set({ mannequinWorkflowTemplateId: wf.id, sareeStep2WorkflowTemplateId: step2Wf.id })
      .where(eq(schema.garmentSubcategories.id, garmentTypeId));
    const garmentKey = `inputs/${userId}/garment.jpg`;
    await bindUploadKey(userId, garmentKey);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/saree-mannequin',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        garmentTypeId,
        garmentKey,
        faceId,
        step2: {
          inputs: { faceId, backgroundId, poseIds: [poseId], garmentTypeId },
          aspectRatio: '1:1',
          resolution: 'HD',
        },
      },
    });
    expect(res.statusCode).toBe(201);
    const { catalogueId, jobIds } = res.json();
    expect(jobIds).toHaveLength(1);
    expect(catalogueId).toBeTruthy();

    const [step2Job] = await app.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobIds[0]));
    expect(step2Job?.status).toBe('PENDING_MANNEQUIN');
    expect(step2Job?.creditsCharged).toBeGreaterThan(0);
    expect(step2Job?.catalogueId).toBe(catalogueId);

    const [step2Inputs] = await app.db
      .select()
      .from(schema.jobInputs)
      .where(eq(schema.jobInputs.jobId, jobIds[0]));
    expect(step2Inputs?.upperGarmentKey).toBeNull();
    const step2Params = step2Inputs?.params as { mannequinJobId?: string };
    expect(step2Params?.mannequinJobId).toBeTruthy();

    const [mannequinJob] = await app.db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.id, step2Params.mannequinJobId as string));
    expect(mannequinJob?.status).toBe('QUEUED');
    expect(mannequinJob?.source).toBe('saree_mannequin');
    expect(mannequinJob?.creditsCharged).toBe(0);

    // Only the mannequin job is enqueued — the step-2 job waits for promotion.
    const streamLen = await app.redis.xlen('jobs:normal');
    expect(streamLen).toBe(1);

    const [{ balance }] = await app.db
      .select({ balance: schema.userCredits.balance })
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, userId));
    expect(balance).toBeLessThan(1000); // whatever the seeded free-tier starting balance is — deducted once, for step2Job.creditsCharged
  });
```

(Adjust the final balance assertion to whatever the test harness's default seeded starting balance actually is — check an existing tryon test in `apps/api/test/integration/` for the exact starting balance constant before finalizing this line.)

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @tryme/api test -- saree-mannequin-job`
Expected: FAIL — `PENDING_MANNEQUIN` status doesn't exist yet, response still returns the old `{jobId}` shape, `step2` field ignored/rejected by the (already-updated in Task 1) Zod schema requiring it.

- [ ] **Step 3: Rewrite `createSareeMannequinJob`**

Replace the full contents of `apps/api/src/modules/jobs/createSareeMannequin.ts` with:

```ts
import { schema } from '@tryme/db';
import { jobsCreatedTotal } from '@tryme/observability';
import type { CreateSareeMannequinJobRequest } from '@tryme/types';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { assertOwnsUploadKey } from './create.js';
import { promptGuard } from './sanitize.js';
import { resolveTryonPlan } from './create.js';

export async function createSareeMannequinJob(
  app: FastifyInstance,
  userId: string,
  body: z.infer<typeof CreateSareeMannequinJobRequest>,
): Promise<{ catalogueId: string; jobIds: string[] }> {
  const { garmentTypeId, garmentKey, faceId, step2 } = body;

  await assertOwnsUploadKey(app, userId, garmentKey);

  const [garmentType] = await app.db
    .select({
      isActive: schema.garmentSubcategories.isActive,
      requiresMannequinStep: schema.garmentSubcategories.requiresMannequinStep,
      mannequinWorkflowTemplateId: schema.garmentSubcategories.mannequinWorkflowTemplateId,
    })
    .from(schema.garmentSubcategories)
    .where(eq(schema.garmentSubcategories.id, garmentTypeId));
  if (!garmentType?.isActive || !garmentType.requiresMannequinStep) {
    throw new AppError('BAD_CATALOG', 400, 'garment type does not use a mannequin step');
  }
  if (!garmentType.mannequinWorkflowTemplateId) {
    throw new AppError('CONFIG', 400, 'garment type missing step-1 workflow configuration');
  }

  const [face] = await app.db
    .select({ id: schema.modelFaces.id })
    .from(schema.modelFaces)
    .where(and(eq(schema.modelFaces.id, faceId), eq(schema.modelFaces.isActive, true)));
  if (!face) throw new AppError('BAD_CATALOG', 400, 'face not found or inactive');

  // Validate + resolve the step-2 plan up front (poses/backgrounds/catalog items/
  // workflow nodes) WITHOUT resolving an upperGarmentKey — it does not exist yet.
  // resolvedUpperGarmentKey: null tells resolveTryonPlan every look's garment key
  // is deferred; it still validates that the (fixed, saree) workflow requires one.
  const plan = await resolveTryonPlan(app, userId, step2, { resolvedUpperGarmentKey: null });

  const [[user], [planRow]] = await Promise.all([
    app.db.select().from(schema.users).where(eq(schema.users.id, userId)),
    app.db
      .select({
        queueStream: schema.creditPlans.queueStream,
        watermark: schema.creditPlans.watermark,
      })
      .from(schema.users)
      .innerJoin(schema.creditPlans, eq(schema.users.tier, schema.creditPlans.slug))
      .where(eq(schema.users.id, userId)),
  ]);
  if (!user || user.isBanned) throw new AppError('FORBIDDEN', 403, 'banned');

  const queueStream: string = planRow?.queueStream ?? 'normal';
  const priority = queueStream === 'priority';
  const watermark: boolean = planRow?.watermark ?? false;

  const { mannequinJobId, jobIds } = await app.db.transaction(async (tx) => {
    const [mannequinJob] = await tx
      .insert(schema.jobs)
      .values({
        userId,
        status: 'QUEUED',
        priority,
        queueStream,
        watermark,
        creditsCharged: 0,
        source: 'saree_mannequin',
      })
      .returning();
    await tx.insert(schema.jobInputs).values({
      jobId: mannequinJob.id,
      upperGarmentKey: garmentKey,
      faceId,
      garmentTypeId,
      params: { kind: 'saree_mannequin' },
    });

    const created: string[] = [];
    for (const look of plan.looks) {
      const [step2Job] = await tx
        .insert(schema.jobs)
        .values({
          userId,
          catalogueId: plan.catalogueId,
          status: 'PENDING_MANNEQUIN',
          priority,
          queueStream,
          watermark,
          creditsCharged: plan.cost,
          source: 'catalog',
        })
        .returning();
      const { atomicDeduct } = await import('../credits/ledger.js');
      await atomicDeduct(tx as unknown as Parameters<typeof atomicDeduct>[0], userId, plan.cost, step2Job.id);
      await tx.insert(schema.jobInputs).values({
        jobId: step2Job.id,
        upperGarmentKey: null,
        faceId,
        backgroundId: look.backgroundId,
        poseId: look.poseId,
        garmentTypeId,
        lowerCatalogId: look.lowerCatalogId,
        lowerGarmentKey: look.lowerGarmentKey,
        thirdGarmentKey: step2.inputs.thirdGarmentKey ?? null,
        shoeCatalogId: look.shoeCatalogId,
        userHint: promptGuard(step2.userHint),
        params: { ...look.params, mannequinJobId: mannequinJob.id },
      });
      created.push(step2Job.id);
    }
    return { mannequinJobId: mannequinJob.id, jobIds: created };
  });

  try {
    await app.redis.xadd(
      `jobs:${queueStream}`,
      'MAXLEN',
      '~',
      10000,
      '*',
      'jobId',
      mannequinJobId,
      'userId',
      userId,
    );
    jobsCreatedTotal.inc({ priority: queueStream, kind: 'saree_mannequin' });
  } catch (err) {
    app.log.error({ err, jobId: mannequinJobId }, 'redis xadd failed — mannequin job marked failed');
    // Step-2 jobs stay PENDING_MANNEQUIN pointing at a mannequin job that will
    // never run — mark the mannequin job FAILED so the dispatcher's promoter
    // sweep (which also treats a FAILED parent as "refund + fail children")
    // picks these up and refunds the user instead of leaving them stuck.
    await app.db
      .update(schema.jobs)
      .set({ status: 'FAILED', errorCode: 'ENQUEUE_FAIL' })
      .where(eq(schema.jobs.id, mannequinJobId));
    throw new AppError('ENQUEUE_FAIL', 503, 'queue unavailable');
  }

  return { catalogueId: plan.catalogueId, jobIds };
}
```

(The dynamic `await import('../credits/ledger.js')` above is a placeholder for wherever `atomicDeduct` ends up imported from after Task 2's refactor — replace with a normal top-of-file `import { atomicDeduct } from '../credits/ledger.js';` once Task 2 is confirmed merged; there is no real circular-import risk here, use a static import.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @tryme/api test -- saree-mannequin-job`
Expected: PASS.

- [ ] **Step 5: Update the remaining existing tests in the same file for the new required `step2` field**

The three `'rejects ...'` tests (current lines 122-170) fail Zod validation before reaching any of the logic they intend to test, once `step2` becomes required — add a minimal placeholder `step2` body to each so they still test the specific failure they're named for, not just "missing field". Add to each payload:

```ts
        step2: {
          inputs: { faceId, backgroundId: '00000000-0000-0000-0000-000000000000', poseIds: ['00000000-0000-0000-0000-000000000000'] },
          aspectRatio: '1:1',
          resolution: 'HD',
        },
```

- [ ] **Step 6: Run the full file**

Run: `pnpm --filter @tryme/api test -- saree-mannequin-job`
Expected: PASS (all 4 tests).

- [ ] **Step 7: Check + update the other saree-mannequin-adjacent test files for the changed contract**

Run: `grep -rl "createSareeMannequinJob\|/v1/jobs/saree-mannequin" apps/api/test/`
For each hit besides the file already updated (`apps/api/test/integration/jobs-create-mannequin.test.ts`, `apps/api/test/integration/catalogues-exclude-mannequin.test.ts`, `apps/api/test/integration/resolve-mannequin-key.test.ts`, `apps/api/test/dev-saree-mannequin-create.test.ts`): open it, check whether it calls `/v1/jobs/saree-mannequin` directly (needs `step2` added + response-shape assertions updated) or only exercises `resolveMannequinGarmentKey`/the dev API (likely unaffected — `resolveMannequinGarmentKey` itself is untouched by this plan). Fix whichever ones call the changed endpoint directly.

- [ ] **Step 8: Run the full API suite**

Run: `pnpm --filter @tryme/api test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/api/src/modules/jobs/createSareeMannequin.ts apps/api/test/
git commit -m "feat(api): create step-2 job(s) atomically with the mannequin job, deferred upperGarmentKey"
```

---

### Task 4: Dispatcher promoter — server-side step-2 chaining

**Files:**
- Create: `apps/dispatcher/src/job/saree-step2-promoter.ts`
- Create: `apps/dispatcher/test/saree-step2-promoter.test.ts`
- Modify: `apps/dispatcher/src/index.ts:106-134`
- Modify: `apps/dispatcher/src/job/state.ts:6-13`

**Interfaces:**
- Consumes: `ProcessorConfig` (`apps/dispatcher/src/job/processor.ts:41-49`), `keys.output` (`@tryme/storage`), `transitionJob` (`apps/dispatcher/src/job/state.ts`).
- Produces: `promoteSareeStep2Jobs(cfg: ProcessorConfig): Promise<void>` — called on an interval from `index.ts`.

- [ ] **Step 1: Write the failing test**

Create `apps/dispatcher/test/saree-step2-promoter.test.ts` (match the harness conventions used by other dispatcher tests — check `apps/dispatcher/test/` for an existing example of how `ProcessorConfig` is built against the docker-compose Postgres/Redis in a test; mirror that setup function verbatim rather than reinventing it):

```ts
import { schema } from '@tryme/db';
import { keys } from '@tryme/storage';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { promoteSareeStep2Jobs } from '../src/job/saree-step2-promoter.js';
// import whatever test-container/db-setup helper the existing dispatcher tests use, e.g.:
// import { startContainers, type Containers } from './helpers/containers.js';
// import { makeTestProcessorConfig } from './helpers/processor-config.js';

describe('promoteSareeStep2Jobs', () => {
  // ... beforeAll/afterAll wiring cfg (db, redis, pub) against the shared
  // docker-compose Postgres/Redis, matching the pattern in the nearest existing
  // dispatcher test file for ProcessorConfig construction.

  async function seedUser() {
    const [user] = await cfg.db
      .insert(schema.users)
      .values({ email: `p-${Date.now()}@x.com`, emailVerified: true, tier: 'free' })
      .returning();
    return user.id;
  }

  it('promotes a PENDING_MANNEQUIN job once its mannequin parent is COMPLETED', async () => {
    const userId = await seedUser();
    const [mannequinJob] = await cfg.db
      .insert(schema.jobs)
      .values({ userId, status: 'COMPLETED', source: 'saree_mannequin', creditsCharged: 0, queueStream: 'normal' })
      .returning();
    const [step2Job] = await cfg.db
      .insert(schema.jobs)
      .values({ userId, status: 'PENDING_MANNEQUIN', source: 'catalog', creditsCharged: 25, queueStream: 'normal' })
      .returning();
    await cfg.db.insert(schema.jobInputs).values({
      jobId: step2Job.id,
      upperGarmentKey: null,
      params: { mannequinJobId: mannequinJob.id },
    });

    await promoteSareeStep2Jobs(cfg);

    const [updatedJob] = await cfg.db.select().from(schema.jobs).where(eq(schema.jobs.id, step2Job.id));
    expect(updatedJob?.status).toBe('QUEUED');
    const [updatedInputs] = await cfg.db
      .select()
      .from(schema.jobInputs)
      .where(eq(schema.jobInputs.jobId, step2Job.id));
    expect(updatedInputs?.upperGarmentKey).toBe(keys.output(mannequinJob.id));
    const streamLen = await cfg.redis.xlen('jobs:normal');
    expect(streamLen).toBe(1);
  });

  it('refunds and fails a PENDING_MANNEQUIN job whose mannequin parent FAILED', async () => {
    const userId = await seedUser();
    const [mannequinJob] = await cfg.db
      .insert(schema.jobs)
      .values({ userId, status: 'FAILED', source: 'saree_mannequin', creditsCharged: 0, queueStream: 'normal' })
      .returning();
    const [step2Job] = await cfg.db
      .insert(schema.jobs)
      .values({ userId, status: 'PENDING_MANNEQUIN', source: 'catalog', creditsCharged: 25, queueStream: 'normal' })
      .returning();
    await cfg.db.insert(schema.jobInputs).values({
      jobId: step2Job.id,
      upperGarmentKey: null,
      params: { mannequinJobId: mannequinJob.id },
    });
    const [before] = await cfg.db
      .select({ balance: schema.userCredits.balance })
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, userId));

    await promoteSareeStep2Jobs(cfg);

    const [updatedJob] = await cfg.db.select().from(schema.jobs).where(eq(schema.jobs.id, step2Job.id));
    expect(updatedJob?.status).toBe('FAILED');
    expect(updatedJob?.errorCode).toBe('MANNEQUIN_STEP_FAILED');
    const [after] = await cfg.db
      .select({ balance: schema.userCredits.balance })
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, userId));
    expect(after.balance).toBe((before?.balance ?? 0) + 25);
  });

  it('leaves a PENDING_MANNEQUIN job untouched while its mannequin parent is still in flight', async () => {
    const userId = await seedUser();
    const [mannequinJob] = await cfg.db
      .insert(schema.jobs)
      .values({ userId, status: 'GENERATING', source: 'saree_mannequin', creditsCharged: 0, queueStream: 'normal' })
      .returning();
    const [step2Job] = await cfg.db
      .insert(schema.jobs)
      .values({ userId, status: 'PENDING_MANNEQUIN', source: 'catalog', creditsCharged: 25, queueStream: 'normal' })
      .returning();
    await cfg.db.insert(schema.jobInputs).values({
      jobId: step2Job.id,
      upperGarmentKey: null,
      params: { mannequinJobId: mannequinJob.id },
    });

    await promoteSareeStep2Jobs(cfg);

    const [updatedJob] = await cfg.db.select().from(schema.jobs).where(eq(schema.jobs.id, step2Job.id));
    expect(updatedJob?.status).toBe('PENDING_MANNEQUIN');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @tryme/dispatcher test -- saree-step2-promoter`
Expected: FAIL — `../src/job/saree-step2-promoter.js` does not exist yet.

- [ ] **Step 3: Implement `promoteSareeStep2Jobs`**

Create `apps/dispatcher/src/job/saree-step2-promoter.ts`:

```ts
import { schema } from '@tryme/db';
import { keys } from '@tryme/storage';
import { and, eq, inArray, sql } from 'drizzle-orm';
import type { ProcessorConfig } from './processor.js';
import { transitionJob } from './state.js';

const TERMINAL_FAILURE_STATUSES = new Set(['FAILED', 'CANCELLED']);

/**
 * Periodic sweep — promotes step-2 catalog jobs stuck in PENDING_MANNEQUIN once
 * their linked mannequin job (job_inputs.params->>'mannequinJobId') reaches a
 * terminal state. This is the ONLY thing that turns a mannequin job's success
 * into an actual queued tryon job — deliberately server-side and connection-
 * independent (no browser/SSE dependency), unlike the client-driven flow this
 * replaces. Idempotent: safe to run concurrently with itself on an interval,
 * safe to re-run after a crash (it only ever acts on rows still in
 * PENDING_MANNEQUIN, and the status flip is the first thing each branch does).
 */
export async function promoteSareeStep2Jobs(cfg: ProcessorConfig): Promise<void> {
  const { db, redis, pub, log } = cfg;

  const pending = await db
    .select({
      jobId: schema.jobs.id,
      userId: schema.jobs.userId,
      queueStream: schema.jobs.queueStream,
      creditsCharged: schema.jobs.creditsCharged,
      mannequinJobId: sql<string>`${schema.jobInputs.params}->>'mannequinJobId'`.as(
        'mannequin_job_id',
      ),
    })
    .from(schema.jobs)
    .innerJoin(schema.jobInputs, eq(schema.jobInputs.jobId, schema.jobs.id))
    .where(eq(schema.jobs.status, 'PENDING_MANNEQUIN'));

  if (pending.length === 0) return;

  const mannequinIds = Array.from(new Set(pending.map((p) => p.mannequinJobId).filter(Boolean)));
  const mannequinJobs = await db
    .select({ id: schema.jobs.id, status: schema.jobs.status })
    .from(schema.jobs)
    .where(inArray(schema.jobs.id, mannequinIds));
  const mannequinStatusById = new Map(mannequinJobs.map((m) => [m.id, m.status]));

  for (const row of pending) {
    const mannequinStatus = mannequinStatusById.get(row.mannequinJobId);
    if (!mannequinStatus) continue; // orphaned params — nothing to do, logged below if it persists

    if (mannequinStatus === 'COMPLETED') {
      const outputKey = keys.output(row.mannequinJobId);
      await db
        .update(schema.jobInputs)
        .set({ upperGarmentKey: outputKey })
        .where(eq(schema.jobInputs.jobId, row.jobId));
      await transitionJob(db, pub, row.jobId, row.userId, 'QUEUED', {}, log);
      await redis.xadd(
        `jobs:${row.queueStream}`,
        'MAXLEN',
        '~',
        10000,
        '*',
        'jobId',
        row.jobId,
        'userId',
        row.userId,
      );
      log.info({ jobId: row.jobId, mannequinJobId: row.mannequinJobId }, 'saree step-2 job promoted to QUEUED');
      continue;
    }

    if (TERMINAL_FAILURE_STATUSES.has(mannequinStatus)) {
      await db.transaction(async (tx) => {
        if (row.creditsCharged > 0) {
          const inserted = await tx
            .insert(schema.creditLedger)
            .values({
              userId: row.userId,
              delta: row.creditsCharged,
              reason: 'JOB_FAIL_REFUND',
              jobId: row.jobId,
            })
            .onConflictDoNothing()
            .returning({ id: schema.creditLedger.id });
          if (inserted.length) {
            await tx
              .update(schema.userCredits)
              .set({ balance: sql`${schema.userCredits.balance} + ${row.creditsCharged}` })
              .where(eq(schema.userCredits.userId, row.userId));
          }
        }
        await tx
          .update(schema.jobs)
          .set({ status: 'FAILED', errorCode: 'MANNEQUIN_STEP_FAILED', completedAt: new Date() })
          .where(eq(schema.jobs.id, row.jobId));
      });
      const ssePayload = JSON.stringify({
        jobId: row.jobId,
        userId: row.userId,
        type: 'STATUS',
        status: 'FAILED',
        errorCode: 'MANNEQUIN_STEP_FAILED',
      });
      await Promise.all([
        pub.publish(`sse:events:${row.userId}`, ssePayload),
        pub.publish('sse:events:admin', ssePayload),
      ]);
      log.warn(
        { jobId: row.jobId, mannequinJobId: row.mannequinJobId },
        'saree step-2 job failed — mannequin step did not complete, refunded',
      );
    }
    // Any other mannequin status (QUEUED/PREPROCESSING/GENERATING/UPLOADING) — leave as-is, checked again next sweep.
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm --filter @tryme/dispatcher test -- saree-step2-promoter`
Expected: PASS (all 3 cases).

- [ ] **Step 5: Add `PENDING_MANNEQUIN` to the dispatcher's `JobStatus` union**

In `apps/dispatcher/src/job/state.ts:6-13`, change:

```ts
export type JobStatus =
  | 'QUEUED'
  | 'PREPROCESSING'
  | 'GENERATING'
  | 'UPLOADING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';
```

to:

```ts
export type JobStatus =
  | 'PENDING_MANNEQUIN'
  | 'QUEUED'
  | 'PREPROCESSING'
  | 'GENERATING'
  | 'UPLOADING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';
```

(`transitionJob` itself is never called with `'PENDING_MANNEQUIN'` — the promoter always transitions PENDING_MANNEQUIN → QUEUED via `transitionJob`, never writes `PENDING_MANNEQUIN` through it — but the union should include it so any future code reading `jobs.status` into this type doesn't need an `as` cast.)

- [ ] **Step 6: Wire the promoter into `index.ts` on its own interval**

In `apps/dispatcher/src/index.ts`, add the import near the other job-module imports (alongside line 21-23):

```ts
import { promoteSareeStep2Jobs } from './job/saree-step2-promoter.js';
```

Add a new interval next to the existing `sweeperInterval`/`recoveryInterval` block (`apps/dispatcher/src/index.ts:125-134`):

```ts
  const sareeStep2Interval = setInterval(() => {
    void promoteSareeStep2Jobs(processorCfg);
  }, 5_000);
```

Add it to `shutdown()`'s `clearInterval` calls (`apps/dispatcher/src/index.ts:140-141`):

```ts
    clearInterval(sweeperInterval);
    clearInterval(recoveryInterval);
    clearInterval(sareeStep2Interval);
```

- [ ] **Step 7: Typecheck dispatcher**

Run: `pnpm --filter @tryme/dispatcher typecheck`
Expected: PASS.

- [ ] **Step 8: Run the full dispatcher test suite**

Run: `pnpm --filter @tryme/dispatcher test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/dispatcher/src/job/saree-step2-promoter.ts apps/dispatcher/test/saree-step2-promoter.test.ts apps/dispatcher/src/index.ts apps/dispatcher/src/job/state.ts
git commit -m "feat(dispatcher): promote saree step-2 jobs server-side once the mannequin job resolves"
```

---

### Task 5: Admin-panel status awareness

**Files:**
- Modify: `apps/api/src/modules/admin/jobs.routes.ts:13-23`
- Modify: `apps/admin-web/src/types.ts:225-231`

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing consumed by later tasks — purely additive so admin filtering/display doesn't silently drop `PENDING_MANNEQUIN` rows.

- [ ] **Step 1: Add `PENDING_MANNEQUIN` to the admin status filter enum**

In `apps/api/src/modules/admin/jobs.routes.ts:13-23`, add `'PENDING_MANNEQUIN'` to the existing `z.enum([...])` status list (keep the other 7 values unchanged).

- [ ] **Step 2: Mirror the union in the admin SPA's types**

In `apps/admin-web/src/types.ts:225-231`, add `'PENDING_MANNEQUIN'` to the mirrored status union.

- [ ] **Step 3: Typecheck both**

Run: `pnpm --filter @tryme/api typecheck && pnpm --filter @tryme/admin typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/admin/jobs.routes.ts apps/admin-web/src/types.ts
git commit -m "chore(admin): recognize PENDING_MANNEQUIN job status in filters/types"
```

---

### Task 6: Studio frontend — single-call submit, immediate preview switch

**Files:**
- Modify: `apps/catalogues-web/src/app/(app)/studio/page.tsx`

**Interfaces:**
- Consumes: the new `/v1/jobs/saree-mannequin` contract from Task 3 (`{garmentTypeId, garmentKey, faceId, step2: {...}}` → `{catalogueId, jobIds}`).
- Produces: nothing consumed by later tasks.

- [ ] **Step 1: Delete the client-side mannequin-wait machinery**

Remove from `apps/catalogues-web/src/app/(app)/studio/page.tsx`:
- The state (current lines 528-535): `_mannequinWaitState`, `setMannequinWaitState`, `mannequinResolverRef`.
- The dedicated `useJobStream` subscription that resolves `mannequinResolverRef` (current lines 537-549).
- The `waitForMannequinJob` function (current lines 551-555).

- [ ] **Step 2: Rewrite the saree branch of `handleSubmit` to fire one request**

Replace `handleSubmit`'s body from the start of the `try` block (current line 1007) through `setActiveGeneration(...)` (current line 1104) with:

```ts
    try {
      const effectivePlatform =
        platform === 'Amazon' ? (amazonUseWhiteBg ? 'Amazon' : undefined) : platform;
      const effectiveLowerId =
        lowerCatalogId ||
        (needsLower ? (selectedGarmentType?.defaultLowerCatalogId ?? undefined) : undefined);
      const effectiveShoesId =
        shoeCatalogId ||
        (needsShoes ? (selectedGarmentType?.defaultShoeCatalogId ?? undefined) : undefined);

      const step2InputsBase = {
        faceId,
        garmentTypeId: garmentTypeId || undefined,
        lowerCatalogId: effectiveLowerId,
        lowerGarmentKey: lowerGarmentKey || undefined,
        shoeCatalogId: effectiveShoesId,
        thirdGarmentKey: thirdGarmentKey || undefined,
      };
      const step2Inputs =
        catalogueTemplateId === 'custom'
          ? { ...step2InputsBase, backgroundId, poseIds }
          : {
              ...step2InputsBase,
              catalogueTemplateMappingId: activeTemplate?.mappingId,
              looks: selectedLooks.map((l) => ({ poseId: l.poseId, backgroundId: l.backgroundId })),
            };
      const step2Body = {
        inputs: step2Inputs,
        aspectRatio: effectiveAspect,
        resolution,
        ...(Object.keys(customParams).length ? { params: customParams } : {}),
        ...(effectivePlatform ? { platform: effectivePlatform } : {}),
      };

      let catalogueId: string;
      let jobIds: string[];
      if (selectedGarmentType?.requiresMannequinStep) {
        ({ catalogueId, jobIds } = await api.post<{ catalogueId: string; jobIds: string[] }>(
          '/v1/jobs/saree-mannequin',
          { garmentTypeId, garmentKey, faceId, step2: step2Body },
        ));
      } else {
        const inputs = {
          upperGarmentKey: garmentKey,
          ...step2Inputs,
        };
        ({ catalogueId, jobIds } = await api.post<{ catalogueId: string; jobIds: string[] }>(
          '/v1/jobs/tryon',
          { ...step2Body, inputs },
        ));
      }

      // Credits were deducted server-side — refresh balance + catalogues list.
      qc.invalidateQueries({ queryKey: ['credits'] });
      qc.invalidateQueries({ queryKey: ['catalogues'] });
      const submittedLooks =
        catalogueTemplateId === 'custom'
          ? poseIds.map((poseId) => {
              const pose = poses?.items.find((p) => p.id === poseId);
              return {
                poseId,
                label: pose?.label ?? 'Pose',
                thumbnailUrl: pose?.thumbnailUrl ?? '',
              };
            })
          : selectedLooks.map((l) => ({
              poseId: l.poseId,
              label: l.poseLabel,
              thumbnailUrl: l.poseThumbnailUrl,
            }));
      setActiveGeneration({
        catalogueId,
        jobs: jobIds.map((id, i) => ({
          id,
          poseId: submittedLooks[i]?.poseId ?? '',
          label: submittedLooks[i]?.label ?? `Look ${i + 1}`,
          thumbnailUrl: submittedLooks[i]?.thumbnailUrl ?? '',
        })),
      });
      setGenerationInProgress(true);
      isSubmittingRef.current = false;
      setIsSubmitting(false);
    } catch (e) {
      setSubmitError((e as Error).message);
      isSubmittingRef.current = false;
      setIsSubmitting(false);
    }
```

This sets `activeGeneration` (which drives the `GenerationPanel`/`PreviewPanel` switch at current line 3302) synchronously on the request that returns, for BOTH the saree and non-saree paths — no more multi-second gap where the button says "Generating…" but the right panel hasn't switched.

- [ ] **Step 3: Manually verify in the browser**

Run: `pnpm --filter @tryme/web dev` (per the `run` skill, use the project's own dev-launch convention if different), open Studio, select a saree/flat garment type, click Generate. Confirm the right panel switches to the AI Processing / Generated Results view immediately on click (not after step 1 finishes). Then click Generate, immediately navigate to `/catalogues`, wait for step-1 generation time to elapse, and confirm the catalogue's step-2 image eventually appears (status flips `PENDING_MANNEQUIN` → `QUEUED` → ... → `COMPLETED` without the tab ever revisiting Studio).

- [ ] **Step 4: Commit**

```bash
git add apps/catalogues-web/src/app/(app)/studio/page.tsx
git commit -m "fix(web): submit saree jobs in one request, switch preview panel immediately"
```

---

### Task 7: Preview UI — render the new `PENDING_MANNEQUIN` phase

**Files:**
- Modify: `apps/catalogues-web/src/app/(app)/studio/generation-panel.tsx:37-45`
- Modify: `apps/catalogues-web/src/app/(app)/catalogues/[id]/page.tsx:60-68,154-205`

**Interfaces:**
- Consumes: the `PENDING_MANNEQUIN` status value that can now appear in SSE `STATUS` events and in `GET /v1/catalogues/:id` job rows (both already carry whatever `jobs.status` holds — no API change needed here, purely a rendering gap).

- [ ] **Step 1: Add `PENDING_MANNEQUIN` to `GenerationPanel`'s progress map**

In `apps/catalogues-web/src/app/(app)/studio/generation-panel.tsx:37-45`, change:

```ts
const STATUS_PROGRESS: Record<string, number> = {
  QUEUED: 10,
  PREPROCESSING: 30,
  GENERATING: 60,
  UPLOADING: 85,
  COMPLETED: 100,
  FAILED: 100,
  CANCELLED: 100,
};
```

to:

```ts
const STATUS_PROGRESS: Record<string, number> = {
  PENDING_MANNEQUIN: 3,
  QUEUED: 10,
  PREPROCESSING: 30,
  GENERATING: 60,
  UPLOADING: 85,
  COMPLETED: 100,
  FAILED: 100,
  CANCELLED: 100,
};
```

- [ ] **Step 2: Add the same stage to the catalogue detail page's progress ranges + label**

In `apps/catalogues-web/src/app/(app)/catalogues/[id]/page.tsx:63-68`, change:

```ts
const STAGE_RANGES: Record<string, [number, number, number]> = {
  QUEUED: [0, 5, 0],
  PREPROCESSING: [5, 25, 30_000],
  GENERATING: [25, 88, 240_000],
  UPLOADING: [88, 96, 20_000],
};
```

to:

```ts
const STAGE_RANGES: Record<string, [number, number, number]> = {
  PENDING_MANNEQUIN: [0, 3, 0],
  QUEUED: [0, 5, 0],
  PREPROCESSING: [5, 25, 30_000],
  GENERATING: [25, 88, 240_000],
  UPLOADING: [88, 96, 20_000],
};
```

In the same file, `isQueued` (current line 156) and `stageLabel` (current lines 200-205):

```ts
  const isQueued = job.status === 'QUEUED';
```
becomes
```ts
  const isQueued = job.status === 'QUEUED' || job.status === 'PENDING_MANNEQUIN';
```

```ts
  const stageLabel =
    job.status === 'PREPROCESSING'
      ? 'Preparing…'
      : job.status === 'UPLOADING'
        ? 'Saving…'
        : 'Generating…';
```
becomes
```ts
  const stageLabel =
    job.status === 'PENDING_MANNEQUIN'
      ? 'Preparing garment…'
      : job.status === 'PREPROCESSING'
        ? 'Preparing…'
        : job.status === 'UPLOADING'
          ? 'Saving…'
          : 'Generating…';
```

- [ ] **Step 3: Manually verify**

With the dev server running (Task 6, Step 3's session), watch a saree job's card on `/catalogues/{id}` from submission through completion — confirm it shows "Preparing garment…" during the `PENDING_MANNEQUIN` phase (instead of jumping straight to the generic "Generating…" treatment) and then proceeds through the normal stages once promoted to `QUEUED`.

- [ ] **Step 4: Commit**

```bash
git add "apps/catalogues-web/src/app/(app)/studio/generation-panel.tsx" "apps/catalogues-web/src/app/(app)/catalogues/[id]/page.tsx"
git commit -m "feat(web): render a distinct 'Preparing garment…' phase for PENDING_MANNEQUIN jobs"
```

---

### Task 8: Full regression pass + progress log

**Files:**
- Modify: `docs/progress.md` (per `CLAUDE.md`'s progress-tracking rule)

- [ ] **Step 1: Run the full monorepo build/typecheck/test**

Run: `pnpm build && pnpm typecheck && pnpm --filter @tryme/api test && pnpm --filter @tryme/dispatcher test`
Expected: PASS across the board.

- [ ] **Step 2: Add a dated entry to `docs/progress.md`**

At the top of the log, add an entry summarizing: root cause (client-driven step-2 orchestration living in a component that unmounts on navigation), the fix (server-side `PENDING_MANNEQUIN` staging + dispatcher promoter sweep), and the frontend preview-panel fix (synchronous `activeGeneration` on submit for both saree and non-saree paths). List this plan's file path (`docs/superpowers/plans/2026-07-21-saree-two-step-generation-fix.md`) for reference.

- [ ] **Step 3: Commit**

```bash
git add docs/progress.md
git commit -m "docs: log saree two-step generation fix"
```

---

## Post-plan note for the executing agent

Task 2's extraction is the highest-risk step in this plan — it moves ~350 lines of existing, working validation logic. If the "PASTE UNCHANGED" cut-and-paste introduces any subtle behavior change (e.g. a variable captured from outer scope that no longer resolves the same way inside the extracted function), the Task 2 Step 1 baseline test is the safety net — do not proceed past Task 2 until that suite is green with the exact same assertions it had before the refactor. If `resolveTryonPlan`'s signature turns out to need adjustment once real TypeScript errors surface (e.g. `body.aspectRatio`'s type differs slightly between `CreateTryOnJobRequest` and the saree `step2` shape), prefer widening `resolveTryonPlan`'s second parameter to a shared narrower interface (`{ inputs, params?, userHint?, aspectRatio, platform? }`) over duplicating the function.
