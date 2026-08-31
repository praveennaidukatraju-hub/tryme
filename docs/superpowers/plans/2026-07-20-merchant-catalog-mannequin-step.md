# Merchant Catalog Mannequin Step-1 Orchestration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix a confirmed production bug where merchant-catalog saree jobs crash in ComfyUI (`Bounded Image Crop with Mask: index is out of bounds for dimension with size 0`) because the dispatcher routes them to the `saree_step2` workflow template while still feeding it the merchant's raw flat-lay photo — `saree_step2` expects a mannequin-composited image, not a flat product photo.

**Architecture:** Extract the existing mannequin-generation ComfyUI submission logic (currently only reachable as a standalone job via `processSareeMannequinJob`) into a reusable function, `runMannequinPhase`. The dispatcher's main job processor calls it inline — before the existing `saree_step2` submission — whenever a job's `job_inputs.params.needsMannequinStep` flag is `true`. That flag is set only by callers (starting with the merchant-catalog flow) that hand the dispatcher a raw flat photo; the existing web studio flow keeps pre-resolving the mannequin step client-side exactly as it does today and never sets the flag, so its behavior is unchanged. One user-visible job throughout — no new job rows, no API/Android contract changes, no new `jobs.status` values. A failed mannequin phase fails/retries the outer job through the exact same `handleFailure` path every other failure already uses, so a retry naturally re-runs the mannequin phase from scratch (no caching — matches how every other job type in this codebase already retries).

**Tech Stack:** TypeScript, Fastify 5 (API), Drizzle ORM, Redis Streams, Vitest (real Postgres/Redis/MinIO integration tests, no testcontainers — see `apps/dispatcher/test/helpers/containers.ts`).

---

## Context for the engineer (read this before starting)

- **Confirmed root cause (from production logs, prompt `cde931f0-2fa5-4c27-9820-5ba3f6c96d8d` and others on `2026-07-20`):** ComfyUI's `Bounded Image Crop with Mask` node (node `1068:657`) received an all-white image and an all-zero mask, crashing with `IndexError: index is out of bounds for dimension with size 0` in `torch.where(rows)[0][[0, -1]]`. The workflow template involved is `saree_step2` (id on production: `831d69ab-cf12-47b8-9748-6dd5eb8c9116`).
- **Why:** `apps/dispatcher/src/job/processor.ts` already has logic (around line 241) that swaps a job's workflow template to `garmentSubcategories.sareeStep2WorkflowTemplateId` whenever `garmentSubcategories.requiresMannequinStep` is true — but it does this *unconditionally*, assuming the caller already ran the mannequin step and substituted its output into `job_inputs.upperGarmentKey`. The **web studio flow** (`apps/api/src/modules/jobs/create.ts`) does this correctly: it requires a completed `mannequinJobId`, calls `resolveMannequinGarmentKey()` to get that job's output R2 key, and uses that as `upperGarmentKey` before creating the real job. The **merchant-catalog flow** (`apps/api/src/modules/merchant/create-job.ts`) has no equivalent — it passes the merchant's raw flat photo straight through as `upperGarmentKey`, so `saree_step2` receives a flat product photo instead of a mannequin-draped one.
- **Why a flag, not an unconditional fix:** `apps/dispatcher/test/integration/saree-step2-workflow-override.test.ts` (existing, must keep passing unmodified) seeds a job whose `upperGarmentKey` is already a pre-resolved mannequin output (`outputs/${job.id}-mannequin/result.png`) with **no** `params.needsMannequinStep` set, and asserts the job completes using that key directly. If the dispatcher unconditionally re-ran the mannequin step for every `requiresMannequinStep` job, it would break this already-correct web-flow behavior by re-processing an already-processed image. The flag lets the merchant-catalog flow opt in without touching the web flow's contract.
- **Existing code you'll be extracting from:** `processSareeMannequinJob` in `apps/dispatcher/src/job/processor.ts` (currently spans roughly lines 789–1039) already contains the exact ComfyUI submission logic needed (upload person+garment images, patch two node IDs directly — this template type does **not** use the shared `patchWorkflow()` helper, unlike the regular job flow — submit, poll, fetch output). You are extracting the *submission* part only, not the job-lifecycle bookkeeping (worker claim retry/backoff loop, `transitionJob`, `finalizeOutput`, `xack`) — that stays owned by whichever caller invokes it.

---

### Task 1: Add the mannequin-intermediate R2 key builder

**Files:**
- Modify: `packages/storage/src/keys.ts`

- [ ] **Step 1: Add the key builder**

Open `packages/storage/src/keys.ts`. Add a new entry to the `keys` object, right after the existing `outputThumb` entry:

```ts
  output: (jobId: string) => `outputs/${jobId}/result.png`,
  outputThumb: (jobId: string) => `outputs/${jobId}/result.thumb.jpg`,
  mannequinIntermediate: (jobId: string) => `outputs/${jobId}/mannequin-intermediate.png`,
```

(Insert the new line immediately after `outputThumb`, keeping every other line in the file exactly as-is.)

- [ ] **Step 2: Typecheck the storage package**

Run: `pnpm --filter @tryme/storage exec tsc --noEmit -p .`
Expected: no output (clean exit).

- [ ] **Step 3: Commit**

```bash
git add packages/storage/src/keys.ts
git commit -m "feat(storage): add R2 key builder for mannequin-phase intermediate output"
```

---

### Task 2: Extract the reusable mannequin-phase execution function

**Files:**
- Create: `apps/dispatcher/src/job/mannequin-phase.ts`

This function does ONE thing: given a raw garment image key (and optional face id), submit the mannequin-compositing job to ComfyUI, wait for it, and return the R2 key of the result. It does **not** touch job status, does **not** call `finalizeOutput`, does **not** `xack` anything, and does **not** implement its own worker-wait retry loop (if no worker is available, it throws immediately — the caller's existing `handleFailure` retry path handles that exactly like any other transient failure).

- [ ] **Step 1: Write the file**

```ts
// apps/dispatcher/src/job/mannequin-phase.ts
import { randomUUID } from 'node:crypto';
import { type DB, schema } from '@tryme/db';
import type { Logger } from '@tryme/logger';
import { comfyRequestDuration } from '@tryme/observability';
import { keys } from '@tryme/storage';
import type { S3Client } from '@aws-sdk/client-s3';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { eq } from 'drizzle-orm';
import type { Redis } from 'ioredis';

import {
  downloadOutputImage,
  fetchHistory,
  submitPrompt,
  uploadImageToComfy,
} from '../comfyui/client.js';
import { waitForCompletion } from '../comfyui/progress.js';
import { setWorkerStatus } from '../worker/registry.js';
import { selectWorker } from '../worker/selector.js';

export interface MannequinPhaseConfig {
  db: DB;
  redis: Redis;
  s3: S3Client;
  r2Bucket: string;
}

export interface MannequinPhaseParams {
  jobId: string;
  /** Raw flat-photo R2 key (the merchant's upload, never previously processed). */
  garmentKey: string;
  faceId: string | null;
  mannequinWorkflowTemplateId: string;
  jobLog: Logger;
}

/**
 * Runs the saree mannequin-compositing step standalone (no job-status side
 * effects) and returns the R2 key of its output image. Throws on any failure
 * — callers route that through their own job-failure/retry handling, so a
 * retry of the outer job re-runs this from scratch (same as every other job
 * type's full-restart retry model in this codebase).
 */
export async function runMannequinPhase(
  cfg: MannequinPhaseConfig,
  params: MannequinPhaseParams,
): Promise<string> {
  const { db, redis, s3, r2Bucket } = cfg;
  const { jobId, garmentKey, faceId, mannequinWorkflowTemplateId, jobLog } = params;

  const [template] = await db
    .select({
      jsonContent: schema.workflowTemplates.jsonContent,
      tryonPersonNodeId: schema.workflowTemplates.tryonPersonNodeId,
      tryonGarmentNodeId: schema.workflowTemplates.tryonGarmentNodeId,
      tryonOutputNodeId: schema.workflowTemplates.tryonOutputNodeId,
    })
    .from(schema.workflowTemplates)
    .where(eq(schema.workflowTemplates.id, mannequinWorkflowTemplateId));
  if (!template) throw new Error('MANNEQUIN_WORKFLOW_NOT_FOUND');

  const personNodeId = template.tryonPersonNodeId;
  const garmentNodeId = template.tryonGarmentNodeId;
  const outputNodeId = template.tryonOutputNodeId;
  if (!garmentNodeId || !outputNodeId) throw new Error('MANNEQUIN_NODES_NOT_CONFIGURED');

  // Templates with no person node bake the face in directly (e.g. a fixed URL
  // node) — nothing to resolve, faceId is accepted but unused in that case.
  let personKey: string | undefined;
  if (personNodeId) {
    if (!faceId) throw new Error('MANNEQUIN_NO_FACE_IMAGE');
    const [faceRow] = await db
      .select({ r2Key: schema.modelFaces.r2Key, faceSideR2Key: schema.modelFaces.faceSideR2Key })
      .from(schema.modelFaces)
      .where(eq(schema.modelFaces.id, faceId));
    if (!faceRow) throw new Error('MANNEQUIN_NO_FACE_IMAGE');
    personKey = faceRow.faceSideR2Key ?? faceRow.r2Key;
  }

  const worker = await selectWorker(redis, 'saree');
  if (!worker) throw new Error('MANNEQUIN_NO_WORKER');

  try {
    async function r2Download(key: string): Promise<Uint8Array> {
      const res = await s3.send(new GetObjectCommand({ Bucket: r2Bucket, Key: key }));
      if (!res.Body) throw new Error(`R2 object missing: ${key}`);
      return res.Body.transformToByteArray();
    }

    async function uploadToComfy(key: string, prefix: string): Promise<string> {
      const bytes = await r2Download(key);
      const rawExt = key.split('.').pop()?.toLowerCase() ?? '';
      const ext = rawExt === 'png' ? 'png' : rawExt === 'webp' ? 'webp' : 'jpg';
      const mime = ext === 'png' ? 'image/png' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
      return uploadImageToComfy(
        worker.url,
        worker.apiKey,
        bytes,
        `${prefix}_${jobId}.${ext}`,
        mime,
        jobLog,
      );
    }

    jobLog.info('uploading mannequin-phase inputs to ComfyUI');
    const [personFile, garmentFile] = await Promise.all([
      personKey ? uploadToComfy(personKey, 'mannequin_person') : Promise.resolve(undefined),
      uploadToComfy(garmentKey, 'mannequin_garment'),
    ]);
    jobLog.info({ personFile, garmentFile }, 'mannequin-phase inputs uploaded');

    const workflow = structuredClone(template.jsonContent) as Record<
      string,
      { inputs?: Record<string, unknown> }
    >;
    if (personNodeId && personFile && workflow[personNodeId]?.inputs) {
      // biome-ignore lint/style/noNonNullAssertion: guarded by optional-chain check above
      workflow[personNodeId].inputs!.image = personFile;
    }
    if (workflow[garmentNodeId]?.inputs) {
      // biome-ignore lint/style/noNonNullAssertion: guarded by optional-chain check above
      workflow[garmentNodeId].inputs!.image = garmentFile;
    }

    const clientUuid = randomUUID();
    const comfyStartedAt = Date.now();
    const { promptId } = await submitPrompt(worker.url, worker.apiKey, clientUuid, workflow, jobLog);
    jobLog.info({ promptId }, 'mannequin-phase prompt submitted');

    await db.insert(schema.jobEvents).values({
      jobId,
      eventType: 'COMFY_DISPATCH',
      payload: {
        promptId,
        workerId: worker.id,
        workerUrl: worker.url,
        workflowTemplateId: mannequinWorkflowTemplateId,
        phase: 'mannequin',
        inputs: { garmentKey, personKey, personFile, garmentFile },
      },
    });

    await waitForCompletion(
      worker.url,
      worker.apiKey,
      clientUuid,
      promptId,
      300_000,
      (update) => jobLog.debug(update, 'comfyui progress'),
      { info: jobLog.info.bind(jobLog), debug: jobLog.debug.bind(jobLog) },
    );
    comfyRequestDuration.observe((Date.now() - comfyStartedAt) / 1000);

    const outputImages = await fetchHistory(worker.url, worker.apiKey, promptId, jobLog, outputNodeId);
    const [firstImage] = outputImages;
    if (!firstImage) throw new Error('ComfyUI returned no output images for mannequin phase');

    const imageBytes = await downloadOutputImage(worker.url, worker.apiKey, firstImage.filename);

    const intermediateKey = keys.mannequinIntermediate(jobId);
    await s3.send(
      new PutObjectCommand({
        Bucket: r2Bucket,
        Key: intermediateKey,
        Body: imageBytes,
        ContentType: 'image/png',
      }),
    );
    jobLog.info({ intermediateKey }, 'mannequin phase complete');
    return intermediateKey;
  } finally {
    await setWorkerStatus(redis, worker.id, 'IDLE');
  }
}
```

- [ ] **Step 2: Typecheck the dispatcher package**

Run: `pnpm --filter @tryme/dispatcher exec tsc --noEmit -p .`
Expected: no output (clean exit). This file isn't wired into anything yet, so it should compile standalone with zero errors.

- [ ] **Step 3: Commit**

```bash
git add apps/dispatcher/src/job/mannequin-phase.ts
git commit -m "feat(dispatcher): extract reusable mannequin-phase ComfyUI submission"
```

---

### Task 3: Set `needsMannequinStep` on merchant-catalog jobs

**Files:**
- Modify: `apps/api/src/modules/merchant/create-job.ts`

- [ ] **Step 1: Select `requiresMannequinStep` alongside `defaultPoseId`**

In `apps/api/src/modules/merchant/create-job.ts`, find:

```ts
  const [garmentType] = await app.db
    .select({ defaultPoseId: schema.garmentSubcategories.defaultPoseId })
    .from(schema.garmentSubcategories)
    .where(
      and(
        eq(schema.garmentSubcategories.id, params.garmentSubcategoryId),
        eq(schema.garmentSubcategories.isActive, true),
      ),
    )
    .limit(1);
```

Replace with:

```ts
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
```

- [ ] **Step 2: Set the flag on `job_inputs.params`**

Find:

```ts
    await tx.insert(schema.jobInputs).values({
      jobId,
      upperGarmentKey: params.flatImageKey,
      faceId: face.id,
      backgroundId: background.id,
      poseId: pose.id,
      garmentTypeId: params.garmentSubcategoryId,
      params: {
        kind: 'merchant_catalog',
        subcategoryId: params.subcategoryId,
        outputWidth: outputDims.width,
        outputHeight: outputDims.height,
        aspectRatio,
        resolution,
      },
    });
```

Replace with:

```ts
    await tx.insert(schema.jobInputs).values({
      jobId,
      upperGarmentKey: params.flatImageKey,
      faceId: face.id,
      backgroundId: background.id,
      poseId: pose.id,
      garmentTypeId: params.garmentSubcategoryId,
      params: {
        kind: 'merchant_catalog',
        subcategoryId: params.subcategoryId,
        outputWidth: outputDims.width,
        outputHeight: outputDims.height,
        aspectRatio,
        resolution,
        // The merchant's flatImageKey is always a raw, never-processed photo —
        // tells the dispatcher to run the mannequin compositing step inline
        // before the real generation. See apps/dispatcher/src/job/processor.ts's
        // requiresMannequinStep branch.
        needsMannequinStep: garmentType.requiresMannequinStep,
      },
    });
```

- [ ] **Step 3: Typecheck the API package**

Run: `pnpm --filter @tryme/api exec tsc --noEmit -p .`
Expected: no output (clean exit).

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/merchant/create-job.ts
git commit -m "feat(api): flag merchant-catalog jobs that need the mannequin step"
```

---

### Task 4: Wire the dispatcher to run the mannequin phase inline

**Files:**
- Modify: `apps/dispatcher/src/job/processor.ts`

This is the actual bug fix. Five precise edits to the same function (`processJob`).

- [ ] **Step 1: Import `runMannequinPhase`**

In `apps/dispatcher/src/job/processor.ts`, find the existing import block:

```ts
import {
  downloadOutputImage,
  fetchHistory,
  submitPrompt,
  uploadImageToComfy,
} from '../comfyui/client.js';
import { waitForCompletion } from '../comfyui/progress.js';
import { setWorkerStatus } from '../worker/registry.js';
import { selectWorker } from '../worker/selector.js';
import { finalizeOutput } from '../workflow/finalize.js';
import { patchWorkflow } from '../workflow/patcher.js';
import { transitionJob } from './state.js';
```

Add one line, right after the `patchWorkflow` import:

```ts
import {
  downloadOutputImage,
  fetchHistory,
  submitPrompt,
  uploadImageToComfy,
} from '../comfyui/client.js';
import { waitForCompletion } from '../comfyui/progress.js';
import { setWorkerStatus } from '../worker/registry.js';
import { selectWorker } from '../worker/selector.js';
import { finalizeOutput } from '../workflow/finalize.js';
import { patchWorkflow } from '../workflow/patcher.js';
import { runMannequinPhase } from './mannequin-phase.js';
import { transitionJob } from './state.js';
```

- [ ] **Step 2: Declare `effectiveUpperGarmentKey` alongside the other `effective*` variables**

Find:

```ts
  // If job has a garmentTypeId, check for per-type workflow/prompt overrides.
  let effectiveWorkflowTemplateId = poseRow.workflowTemplateId;
  let effectivePromptFacePhase = poseRow.promptFacePhase;
  let effectivePromptGarmentPhase = poseRow.promptGarmentPhase;
  const snapshottedWorkflowTemplateId =
```

Replace with:

```ts
  // If job has a garmentTypeId, check for per-type workflow/prompt overrides.
  let effectiveWorkflowTemplateId = poseRow.workflowTemplateId;
  let effectivePromptFacePhase = poseRow.promptFacePhase;
  let effectivePromptGarmentPhase = poseRow.promptGarmentPhase;
  let effectiveUpperGarmentKey = inputs.upperGarmentKey;
  const snapshottedWorkflowTemplateId =
```

- [ ] **Step 3: Add `mannequinWorkflowTemplateId` to the garment-type select, and run the mannequin phase when opted in**

Find:

```ts
  } else if (inputs.garmentTypeId) {
    const [garmentTypeRow] = await db
      .select({
        requiresMannequinStep: schema.garmentSubcategories.requiresMannequinStep,
        sareeStep2WorkflowTemplateId: schema.garmentSubcategories.sareeStep2WorkflowTemplateId,
      })
      .from(schema.garmentSubcategories)
      .where(eq(schema.garmentSubcategories.id, inputs.garmentTypeId));
    if (garmentTypeRow?.requiresMannequinStep) {
      // Flat-saree (and any future two-pass) garment types use ONE workflow for
      // every pose, set directly on the garment type — bypasses the normal
      // per-pose pose_garment_configs override entirely (a saree pose's own
      // workflow assignment, if any, is ignored). Flat-saree jobs never carry
      // a catalogue-template-mapping snapshot, so in practice this is the
      // top-precedence tier whenever it applies.
      effectiveWorkflowTemplateId = garmentTypeRow.sareeStep2WorkflowTemplateId;
    } else {
```

Replace with:

```ts
  } else if (inputs.garmentTypeId) {
    const [garmentTypeRow] = await db
      .select({
        requiresMannequinStep: schema.garmentSubcategories.requiresMannequinStep,
        sareeStep2WorkflowTemplateId: schema.garmentSubcategories.sareeStep2WorkflowTemplateId,
        mannequinWorkflowTemplateId: schema.garmentSubcategories.mannequinWorkflowTemplateId,
      })
      .from(schema.garmentSubcategories)
      .where(eq(schema.garmentSubcategories.id, inputs.garmentTypeId));
    if (garmentTypeRow?.requiresMannequinStep) {
      // Flat-saree (and any future two-pass) garment types use ONE workflow for
      // every pose, set directly on the garment type — bypasses the normal
      // per-pose pose_garment_configs override entirely (a saree pose's own
      // workflow assignment, if any, is ignored). Flat-saree jobs never carry
      // a catalogue-template-mapping snapshot, so in practice this is the
      // top-precedence tier whenever it applies.
      effectiveWorkflowTemplateId = garmentTypeRow.sareeStep2WorkflowTemplateId;

      // Callers that hand the dispatcher a raw (never-mannequin-processed) flat
      // photo opt in via params.needsMannequinStep — the web studio flow instead
      // pre-resolves this client-side (resolveMannequinGarmentKey) BEFORE the
      // job is even created, so its upperGarmentKey is already a mannequin
      // output and this branch must NOT be entered for it (see
      // saree-step2-workflow-override.test.ts, which asserts that exact
      // pre-resolved-key behavior and has no needsMannequinStep set).
      if (rawParams.needsMannequinStep === true) {
        if (!garmentTypeRow.mannequinWorkflowTemplateId) {
          await markFailed(
            cfg,
            jobId,
            userId,
            stream,
            messageId,
            'MANNEQUIN_WORKFLOW_NOT_CONFIGURED',
            jobLog,
            startedAt,
          );
          return;
        }
        if (!inputs.upperGarmentKey) {
          await markFailed(
            cfg,
            jobId,
            userId,
            stream,
            messageId,
            'MANNEQUIN_INPUTS_MISSING',
            jobLog,
            startedAt,
          );
          return;
        }
        try {
          effectiveUpperGarmentKey = await runMannequinPhase(cfg, {
            jobId,
            garmentKey: inputs.upperGarmentKey,
            faceId: inputs.faceId,
            mannequinWorkflowTemplateId: garmentTypeRow.mannequinWorkflowTemplateId,
            jobLog,
          });
        } catch (err) {
          jobLog.error({ err }, 'mannequin phase failed');
          const errMsg = err instanceof Error ? err.message : String(err);
          await handleFailure(cfg, jobId, userId, stream, messageId, jobLog, startedAt, errMsg);
          return;
        }
      }
    } else {
```

- [ ] **Step 4: Use `effectiveUpperGarmentKey` instead of `inputs.upperGarmentKey` in the upload/patch section**

Find:

```ts
    const baseTasks: Promise<string>[] = [uploadToComfy(poseKey, 'pose')];
    if (needsUpper && inputs.upperGarmentKey)
      baseTasks.push(uploadToComfy(inputs.upperGarmentKey, 'garment'));
```

Replace with:

```ts
    const baseTasks: Promise<string>[] = [uploadToComfy(poseKey, 'pose')];
    if (needsUpper && effectiveUpperGarmentKey)
      baseTasks.push(uploadToComfy(effectiveUpperGarmentKey, 'garment'));
```

Find:

```ts
    const upperGarmentFile = needsUpper && inputs.upperGarmentKey ? uploaded[idx++] : undefined;
```

Replace with:

```ts
    const upperGarmentFile = needsUpper && effectiveUpperGarmentKey ? uploaded[idx++] : undefined;
```

- [ ] **Step 5: Log both the original and effective garment key in the dispatch event (debugging aid)**

Find:

```ts
          _r2Keys: {
            upperGarmentKey: inputs.upperGarmentKey,
            faceSideKey,
```

Replace with:

```ts
          _r2Keys: {
            upperGarmentKey: inputs.upperGarmentKey,
            effectiveUpperGarmentKey,
            faceSideKey,
```

- [ ] **Step 6: Typecheck the dispatcher package**

Run: `pnpm --filter @tryme/dispatcher exec tsc --noEmit -p .`
Expected: no output (clean exit).

- [ ] **Step 7: Commit**

```bash
git add apps/dispatcher/src/job/processor.ts
git commit -m "fix(dispatcher): run mannequin phase inline before saree_step2 when opted in"
```

---

### Task 5: Integration test for the new embedded flow

**Files:**
- Create: `apps/dispatcher/test/integration/merchant-catalog-mannequin.test.ts`

This mirrors the existing pattern in `apps/dispatcher/test/integration/saree-mannequin.test.ts` and `saree-step2-workflow-override.test.ts` exactly — real Postgres/Redis/MinIO via `setupTestEnv()`, a mock ComfyUI HTTP server via `startComfyMock()`, direct Drizzle seeding, then a single `processJob()` call with assertions on the resulting DB/R2 state.

- [ ] **Step 1: Write the test file**

```ts
// apps/dispatcher/test/integration/merchant-catalog-mannequin.test.ts
import { schema } from '@tryme/db';
import { createLogger } from '@tryme/logger';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { and, eq } from 'drizzle-orm';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { processJob } from '../../src/job/processor.js';
import { deregisterWorker, registerWorkers, setWorkerStatus } from '../../src/worker/registry.js';
import { type ComfyMock, startComfyMock } from '../helpers/comfy-mock.js';
import { setupTestEnv, type TestEnv } from '../helpers/containers.js';

const WORKER_ID = 'test-worker-merchant-mannequin';

describe('dispatcher — merchant-catalog job with needsMannequinStep', () => {
  let env: TestEnv;
  let redis: Redis;
  let pub: Redis;
  let comfy: ComfyMock;

  beforeAll(async () => {
    env = await setupTestEnv();
    redis = new Redis('redis://127.0.0.1:6379');
    pub = new Redis('redis://127.0.0.1:6379');
    comfy = await startComfyMock();

    await registerWorkers(redis, [
      { id: WORKER_ID, url: comfy.url, apiKey: 'test-key', allowedJobTypes: ['saree', 'catalogue'] },
    ]);
    await redis.setex(`worker:health:${WORKER_ID}`, 30, '1');
  }, 60_000);

  afterAll(async () => {
    await deregisterWorker(redis, WORKER_ID);
    await comfy.close();
    redis.disconnect();
    pub.disconnect();
    await env.cleanup();
  });

  beforeEach(async () => {
    comfy.setOptions({});
    await setWorkerStatus(redis, WORKER_ID, 'IDLE');
  });

  function templateFields(overrides: Partial<typeof schema.workflowTemplates.$inferInsert>) {
    return {
      jsonContent: {
        f: { class_type: 'LoadImage', inputs: { image: 'x.jpg' } },
        p: { class_type: 'LoadImage', inputs: { image: 'x.jpg' } },
        b: { class_type: 'LoadImage', inputs: { image: 'x.jpg' } },
        g: { class_type: 'LoadImage', inputs: { image: 'x.jpg' } },
        out: { class_type: 'SaveImage', inputs: { images: ['f', 0] } },
      },
      workflowType: 'regular',
      faceNodeId: 'f',
      poseNodeId: 'p',
      bgNodeId: 'b',
      upperNodeIds: ['g'],
      facePhasePromptNode: 'f',
      garmentPhasePromptNode: 'f',
      resultNodeId: '10',
      ...overrides,
    };
  }

  it('runs the mannequin phase inline, then saree_step2, ending COMPLETED with both outputs in R2', async () => {
    const [user] = await env.db
      .insert(schema.users)
      .values({ email: `merchant-mannequin-${Date.now()}@test.com`, passwordHash: 'x', tier: 'free' })
      .returning();
    await env.db.insert(schema.userCredits).values({ userId: user.id, balance: 100 });

    const [mannequinTemplate] = await env.db
      .insert(schema.workflowTemplates)
      .values({
        slug: `merchant-step1-${Date.now()}`,
        label: 'Merchant Step1',
        jsonContent: {
          '1': { class_type: 'LoadImage', inputs: { image: 'placeholder.jpg' } },
          '2': { class_type: 'LoadImage', inputs: { image: 'placeholder.jpg' } },
        },
        workflowType: 'saree_step1',
        faceNodeId: '',
        poseNodeId: '',
        bgNodeId: '',
        upperNodeIds: [],
        facePhasePromptNode: '',
        garmentPhasePromptNode: '',
        tryonPersonNodeId: '1',
        tryonGarmentNodeId: '2',
        tryonOutputNodeId: '10',
      })
      .returning();

    const [step2Template] = await env.db
      .insert(schema.workflowTemplates)
      .values({ slug: `merchant-step2-${Date.now()}`, label: 'Merchant Step2', ...templateFields({}) })
      .returning();

    const [garmentType] = await env.db
      .insert(schema.garmentSubcategories)
      .values({
        genderSlug: 'women',
        slug: `merchant-flat-saree-${Date.now()}`,
        label: 'Merchant Flat Saree',
        requiresMannequinStep: true,
        mannequinWorkflowTemplateId: mannequinTemplate.id,
        sareeStep2WorkflowTemplateId: step2Template.id,
      })
      .returning();

    const [face] = await env.db
      .insert(schema.modelFaces)
      .values({
        gender: 'women',
        label: 'F',
        r2Key: 'f.jpg',
        thumbnailKey: 'f.jpg',
        faceSideR2Key: 'f.jpg',
      })
      .returning();
    const [bg] = await env.db
      .insert(schema.modelBackgrounds)
      .values({ label: 'Bg', r2Key: 'b.jpg', thumbnailKey: 'b.jpg' })
      .returning();
    const [pose] = await env.db
      .insert(schema.modelPoseAssets)
      .values({ label: 'Pose', r2Key: 'p.jpg', thumbnailKey: 'p.jpg' })
      .returning();

    const [job] = await env.db
      .insert(schema.jobs)
      .values({ userId: user.id, status: 'QUEUED', priority: false, creditsCharged: 1 })
      .returning();

    // The raw flat photo — NEVER mannequin-processed, unlike
    // saree-step2-workflow-override.test.ts which seeds an already-resolved key.
    const rawGarmentKey = `merchant-catalog/flat/${job.id}/garment.jpg`;
    await env.db.insert(schema.jobInputs).values({
      jobId: job.id,
      upperGarmentKey: rawGarmentKey,
      faceId: face.id,
      backgroundId: bg.id,
      poseId: pose.id,
      garmentTypeId: garmentType.id,
      params: { kind: 'merchant_catalog', needsMannequinStep: true },
    });

    for (const key of [rawGarmentKey, 'f.jpg', 'b.jpg', 'p.jpg']) {
      await env.s3.send(
        new PutObjectCommand({
          Bucket: env.r2Bucket,
          Key: key,
          Body: Buffer.from('stub'),
          ContentType: 'image/jpeg',
        }),
      );
    }

    const log = createLogger('test');
    await processJob(
      { db: env.db, redis, pub, storage: env.storage, s3: env.s3, r2Bucket: env.r2Bucket, log },
      job.id,
      user.id,
      'jobs:normal',
      '1-1',
    );

    const [completedJob] = await env.db.select().from(schema.jobs).where(eq(schema.jobs.id, job.id));
    expect(completedJob?.status).toBe('COMPLETED');

    // Mannequin phase actually ran and uploaded its intermediate output.
    const intermediate = await env.s3.send(
      new GetObjectCommand({
        Bucket: env.r2Bucket,
        Key: `outputs/${job.id}/mannequin-intermediate.png`,
      }),
    );
    expect(intermediate.$metadata.httpStatusCode).toBe(200);

    // Final saree_step2 output also exists.
    const finalOutput = await env.s3.send(
      new GetObjectCommand({ Bucket: env.r2Bucket, Key: `outputs/${job.id}/result.png` }),
    );
    expect(finalOutput.$metadata.httpStatusCode).toBe(200);

    // Two separate ComfyUI submissions happened — one per phase.
    const dispatchEvents = await env.db
      .select()
      .from(schema.jobEvents)
      .where(and(eq(schema.jobEvents.jobId, job.id), eq(schema.jobEvents.eventType, 'COMFY_DISPATCH')));
    expect(dispatchEvents).toHaveLength(2);
    const mannequinEvent = dispatchEvents.find(
      (e) => (e.payload as { phase?: string }).phase === 'mannequin',
    );
    expect(mannequinEvent).toBeTruthy();
    expect(
      (mannequinEvent?.payload as { workflowTemplateId?: string }).workflowTemplateId,
    ).toBe(mannequinTemplate.id);
    const step2Event = dispatchEvents.find((e) => e !== mannequinEvent);
    expect((step2Event?.payload as { workflowTemplateId?: string }).workflowTemplateId).toBe(
      step2Template.id,
    );
    // saree_step2 received the mannequin's OUTPUT key, not the raw flat photo.
    expect(
      (step2Event?.payload as { inputs?: { _r2Keys?: { effectiveUpperGarmentKey?: string } } })
        .inputs?._r2Keys?.effectiveUpperGarmentKey,
    ).toBe(`outputs/${job.id}/mannequin-intermediate.png`);
  });

  it('fails the job (with retry) when the garment type has no mannequinWorkflowTemplateId configured', async () => {
    const [user] = await env.db
      .insert(schema.users)
      .values({
        email: `merchant-mannequin-noconfig-${Date.now()}@test.com`,
        passwordHash: 'x',
        tier: 'free',
      })
      .returning();
    await env.db.insert(schema.userCredits).values({ userId: user.id, balance: 100 });

    const [step2Template] = await env.db
      .insert(schema.workflowTemplates)
      .values({
        slug: `merchant-noconfig-step2-${Date.now()}`,
        label: 'Merchant Step2 NoConfig',
        ...templateFields({}),
      })
      .returning();

    const [garmentType] = await env.db
      .insert(schema.garmentSubcategories)
      .values({
        genderSlug: 'women',
        slug: `merchant-noconfig-${Date.now()}`,
        label: 'Merchant NoConfig',
        requiresMannequinStep: true,
        // mannequinWorkflowTemplateId intentionally left null
        sareeStep2WorkflowTemplateId: step2Template.id,
      })
      .returning();

    const [face] = await env.db
      .insert(schema.modelFaces)
      .values({ gender: 'women', label: 'F', r2Key: 'f2.jpg', thumbnailKey: 'f2.jpg' })
      .returning();
    const [bg] = await env.db
      .insert(schema.modelBackgrounds)
      .values({ label: 'Bg2', r2Key: 'b2.jpg', thumbnailKey: 'b2.jpg' })
      .returning();
    const [pose] = await env.db
      .insert(schema.modelPoseAssets)
      .values({ label: 'Pose2', r2Key: 'p2.jpg', thumbnailKey: 'p2.jpg' })
      .returning();

    const [job] = await env.db
      .insert(schema.jobs)
      .values({ userId: user.id, status: 'QUEUED', priority: false, creditsCharged: 1 })
      .returning();
    const rawGarmentKey = `merchant-catalog/flat/${job.id}/garment.jpg`;
    await env.db.insert(schema.jobInputs).values({
      jobId: job.id,
      upperGarmentKey: rawGarmentKey,
      faceId: face.id,
      backgroundId: bg.id,
      poseId: pose.id,
      garmentTypeId: garmentType.id,
      params: { kind: 'merchant_catalog', needsMannequinStep: true },
    });

    const log = createLogger('test');
    await processJob(
      { db: env.db, redis, pub, storage: env.storage, s3: env.s3, r2Bucket: env.r2Bucket, log },
      job.id,
      user.id,
      'jobs:normal',
      '1-2',
    );

    // markFailed is used for this pre-flight config error — terminal immediately,
    // not a retryable failure (retrying can't fix a missing config value).
    const [failedJob] = await env.db.select().from(schema.jobs).where(eq(schema.jobs.id, job.id));
    expect(failedJob?.status).toBe('FAILED');
    expect(failedJob?.errorCode).toBe('MANNEQUIN_WORKFLOW_NOT_CONFIGURED');
  });
});
```

- [ ] **Step 2: Run the new tests**

Run: `pnpm --filter @tryme/dispatcher test -- merchant-catalog-mannequin`
Expected: both tests PASS.

If the first test fails on the `effectiveUpperGarmentKey` assertion, double-check Task 4 Step 5 was applied exactly (the `_r2Keys` payload must include `effectiveUpperGarmentKey`, not just `upperGarmentKey`).

- [ ] **Step 3: Commit**

```bash
git add apps/dispatcher/test/integration/merchant-catalog-mannequin.test.ts
git commit -m "test(dispatcher): cover merchant-catalog inline mannequin-phase orchestration"
```

---

### Task 6: Regression-verify the existing saree tests are unaffected

**Files:**
- None (verification only — no code changes in this task)

- [ ] **Step 1: Run the existing mannequin and step2-override tests**

Run: `pnpm --filter @tryme/dispatcher test -- saree-mannequin saree-step2-workflow-override`
Expected: all pre-existing tests in both files still PASS, unmodified.

This confirms the `needsMannequinStep` opt-in didn't change behavior for jobs that don't set it (the web-flow's existing pre-resolved-key pattern), and that standalone `saree_mannequin`-kind jobs (`processSareeMannequinJob`, untouched by this plan) still work.

- [ ] **Step 2: If either test fails**

Stop and re-read Task 4's diff against the actual current file — a failure here means the edit was applied somewhere it shouldn't have been (e.g. inside the `else` branch instead of the `if (garmentTypeRow?.requiresMannequinStep)` branch, or the `rawParams.needsMannequinStep === true` check is missing/inverted). Do not proceed to Task 7 until both files pass unmodified.

---

### Task 7: Full verification and final commit

**Files:**
- None (verification only)

- [ ] **Step 1: Full typecheck**

Run: `pnpm -r --filter "!@tryme/admin-mobile" run typecheck`
Expected: all packages report success, no errors.

- [ ] **Step 2: Full lint**

Run: `pnpm biome check . --diagnostic-level=error`
Expected: no errors.

- [ ] **Step 3: Full dispatcher unit + integration suite**

Run: `pnpm --filter @tryme/dispatcher test`
Expected: all tests pass, no regressions anywhere else in the suite (this run includes every other dispatcher test file, not just the saree-related ones touched above).

- [ ] **Step 4: Full API unit suite**

Run: `pnpm --filter @tryme/api test:unit`
Expected: all tests pass.

- [ ] **Step 5: Confirm working tree is clean**

Run: `git status --short`
Expected: no output (everything from Tasks 1–5 already committed).

---

## Deployment note (not part of this plan's tasks — for whoever deploys)

After merging, this needs a real production walkthrough to confirm the fix: create a merchant-catalog job for a `requiresMannequinStep` garment type (e.g. "B2 Acceptance Flat Saree" on production) and confirm it reaches `COMPLETED` instead of crashing with the `Bounded Image Crop with Mask` error. The two prior production fixes already deployed this session (`fix(dispatcher): surface ComfyUI execution_error detail`, the merchant-catalog subcategory auto-provisioning fix) remain in place and are unaffected by this plan.

## Explicitly out of scope (accepted trade-offs, not gaps to fix here)

- **Widget and Shopify job creation** do not set `needsMannequinStep` and will still hit the original bug if ever pointed at a `requiresMannequinStep` garment type. The dispatcher-side fix is available to them for free — they just need to set the flag the same way Task 3 does for the merchant flow, whenever that becomes relevant. Not addressed now because no such job type is in use today.
- **No caching/skipping of the mannequin phase on retry.** A retry re-runs both phases from scratch. Explicitly chosen — matches this codebase's existing full-restart retry model everywhere else, and mannequin generation is fast relative to the 2-attempt cap.
- **No new job-status/progress signal during the mannequin phase.** The job stays at whatever status it was in before `PREPROCESSING` begins for the ~30-60s the mannequin phase runs. SSE progress may feel briefly stalled during that window. A future enhancement, not required to fix the crash.
