# Saree Try-On Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a temporary "Saree Try-On" feature — user uploads one flat saree image, gets back a draped-saree result on a static model person image set by the admin. The ComfyUI workflow is uploaded once by the admin and routed to a worker that has opted into the `saree` job type.

**Architecture:** New vertical slice parallel to tryon. New `saree_settings` table (single row, holds the static model image key). New Zod types in `@tryme/types/saree`. New api routes (admin + user) and a new `createSareeJob` helper mirroring `createSimpleTryonJob`. New `saree-detect.ts` that wraps `tryon-detect.ts` and adds a `flatsaree` title alias. New dispatcher branch `processSareeJob` mirroring `processTryonDirectJob` — workers with `saree` in their `allowedJobTypes` claim the job and run the Qwen-Image-Edit-2509 saree workflow. Two new pages: `/saree` (web) and `/saree` (admin). Reuses: upload presign, SSE, credit cost (35), priority/normal queue streams, `workerJobTypes` routing, `tryon-detect.ts` core.

**Tech Stack:** Fastify 5 + Zod, Drizzle ORM (Postgres), Vitest, React 19 + Vite (admin SPA), Next.js 15 (web), pnpm workspaces, R2/MinIO presigned uploads, ComfyUI via dispatcher.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-06-30-saree-tryon-design.md`. Reference workflow: `templates/saree.json`.
- ESM only, TypeScript 5.6, Node 20+. pnpm only — never npm/yarn.
- **Migration flow (CRITICAL — repo does NOT use `drizzle-kit generate`):** edit schema TS → `pnpm --filter @tryme/db build` → hand-write `<seq>_<name>.sql` in `packages/db/src/migrations/` → manually append entry to `meta/_journal.json` → `pnpm db:migrate`. Every migration from 0046 onward follows this pattern (see `0070_worker_job_types.sql`). The runtime runner (`packages/db/src/migrate.ts`) is hash-based and does not read snapshots. `pnpm db:generate` produces a bloated diff because intermediate snapshots (0046-0070) are missing. **NEVER run `pnpm db:generate` in this repo.**
- `@tryme/db` exports `* as schema` from `packages/db/src/index.ts` — do not add a duplicate schema re-export. New tables go in their own schema file, re-exported from `packages/db/src/schema/index.js`.
- All `/admin/*` routes use `requireAdmin([...])`. Saree admin routes use `requireAdmin(['SUPER_ADMIN','MODERATOR'])` for writes, add `'ADMIN'` for reads (mirror `tryon.routes.ts` `W`/`R`).
- Admin UI: use CSS-var design tokens, no raw hex. Logger: pino via `@tryme/logger`, no `console.log` in committed API code (admin SPA `console.error` is fine).
- Worker job-type routing already supports the string `'saree'` — the `selectWorker(redis, 'saree')` call needs no other dispatcher change.
- Commit after each task. Run `pnpm --filter @tryme/api typecheck`, `pnpm --filter @tryme/dispatcher typecheck`, `pnpm --filter @tryme/web typecheck`, `pnpm --filter @tryme/admin typecheck`, `pnpm --filter @tryme/types typecheck` and the relevant package build/typecheck before each commit.
- `templates/` is gitignored — tests must inline JSON fixtures, never `fs.readFileSync`.

---

# INCREMENT 1 — Schema, types, detector

### Task 1: `saree_settings` table

**Files:**
- Create: `packages/db/src/schema/saree.ts`
- Modify: `packages/db/src/schema/index.ts` (insert `export * from './saree.js';` alphabetically before `tryon.js`)
- Create: `packages/db/src/migrations/0071_saree_settings.sql` (HAND-WRITTEN — see Step 4)
- Modify: `packages/db/src/migrations/meta/_journal.json` (append a new entry with `idx: 71`)

**Interfaces:**
- Produces: `schema.sareeSettings.modelImageKey`, `.modelImageThumbKey`, `.id`, `.updatedAt`

- [ ] **Step 1: Create the schema file**

Create `packages/db/src/schema/saree.ts`:

```ts
import { sql } from 'drizzle-orm';
import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

// Single-row global settings for the saree try-on feature.
// Mirrors tryon_settings — only one row ever exists, upsert with fixed id
// '00000000-0000-0000-0000-000000000001'.
export const sareeSettings = pgTable('saree_settings', {
  id: uuid('id').primaryKey().default(sql`'00000000-0000-0000-0000-000000000001'::uuid`),
  modelImageKey: text('model_image_key'),
  modelImageThumbKey: text('model_image_thumb_key'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});
```

- [ ] **Step 2: Re-export from the schema barrel**

In `packages/db/src/schema/index.ts`, insert `export * from './saree.js';` alphabetically between `models.js` and `tryon.js`. The final file should be:

```ts
export * from './admin.js';
export * from './catalog.js';
export * from './contact.js';
export * from './credits.js';
export * from './jobs.js';
export * from './models.js';
export * from './saree.js';
export * from './tryon.js';
export * from './users.js';
export * from './widget.js';
export * from './workers.js';
```

- [ ] **Step 3: Build the db package**

Run: `pnpm --filter @tryme/db build`
Expected: `tsc` completes, no errors.

- [ ] **Step 4: Hand-write the migration (NOT drizzle-kit generate)**

**Important: this repo does NOT use `pnpm db:generate`.** The repo's `meta/_journal.json` has 71 entries but only snapshots 0000, 0001, 0032, 0045 are checked in — `drizzle-kit generate` produces a bloated migration that tries to replay all of 0046-0070. The repo's actual pattern (used by every migration from 0046 onward, including `0070_worker_job_types.sql`) is **hand-written SQL + manual journal entry**. The runtime migration runner (`packages/db/src/migrate.ts`) is hash-based and does not read snapshots — it just runs `<tag>.sql` files in journal order.

Create `packages/db/src/migrations/0071_saree_settings.sql`:

```sql
CREATE TABLE "saree_settings" (
  "id" uuid PRIMARY KEY DEFAULT '00000000-0000-0000-0000-000000000001'::uuid NOT NULL,
  "model_image_key" text,
  "model_image_thumb_key" text,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
```

- [ ] **Step 5: Append the journal entry**

In `packages/db/src/migrations/meta/_journal.json`, append a new entry to the `entries` array (just before the closing `]`). Use a `when` value larger than the last entry (currently `1783000000000` for 0070). Use `1783100000000` for consistency with the recent pattern (entries 0067-0070 are spaced 1,000,000 ms apart):

```json
,
    {
      "idx": 71,
      "version": "7",
      "when": 1783100000000,
      "tag": "0071_saree_settings",
      "breakpoints": true
    }
  ]
```

- [ ] **Step 6: Apply the migration locally**

**INFRA CHECK FIRST:** Run `docker ps --filter name=tryme-postgres --format '{{.Names}}' 2>&1` to confirm Postgres is up. If empty, STOP and report BLOCKED — the user will start infra. If up, proceed.

Run: `pnpm db:migrate`
Expected: prints `Applied  0071_saree_settings` and exits cleanly.

- [ ] **Step 7: Verify the table exists**

Run: `docker exec tryme-postgres psql -U tryon -d tryon_dev -c "\d saree_settings"`
Expected: shows 4 columns (`id`, `model_image_key`, `model_image_thumb_key`, `updated_at`) and the PK on `id`.

- [ ] **Step 8: Commit**

```bash
git add packages/db/src/schema/saree.ts packages/db/src/schema/index.ts packages/db/src/migrations/0071_saree_settings.sql packages/db/src/migrations/meta/_journal.json
git commit -m "feat(db): add saree_settings table"
```

---

### Task 2: Saree Zod types

**Files:**
- Create: `packages/types/src/saree.ts`
- Modify: `packages/types/src/index.ts:7` (insert re-export alphabetically before `tryon`)

**Interfaces:**
- Produces: `CreateSareeJobRequest`, `SareeConfigResponse`, `AdminSareeSettings`, `AdminSareeSettingsPatch`, `AdminSareeSettingsPresignBody`, `AdminSareeSettingsPresignResponse`, `AdminSareeWorkflow`, `AdminSareeWorkflowCreateBody`, `SareeDetectedNodes`

- [ ] **Step 1: Create the types file**

Create `packages/types/src/saree.ts`:

```ts
import { z } from 'zod';

// ── User-facing ────────────────────────────────────────────────────────────

export const CreateSareeJobRequest = z.object({
  garmentKey: z.string().min(1).max(512),
});

export const SareeConfigResponse = z.object({
  modelImageUrl: z.string().url().nullable(),
  isConfigured: z.boolean(),
  creditsCost: z.literal(35),
});

// ── Admin: settings ────────────────────────────────────────────────────────

export const AdminSareeSettings = z.object({
  modelImageKey: z.string().nullable(),
  modelImageThumbKey: z.string().nullable(),
  modelImageUrl: z.string().url().nullable(),
  modelImageThumbUrl: z.string().url().nullable(),
  isConfigured: z.boolean(),
});

export const AdminSareeSettingsPatch = z.object({
  modelImageKey: z.string().nullable().optional(),
  modelImageThumbKey: z.string().nullable().optional(),
});

export const AdminSareeSettingsPresignBody = z.object({
  contentType: z.enum(['image/jpeg', 'image/png', 'image/webp']),
});

export const AdminSareeSettingsPresignResponse = z.object({
  r2Key: z.string(),
  uploadUrl: z.string().url(),
  thumbnailKey: z.string(),
  thumbnailUploadUrl: z.string().url(),
});

// ── Admin: workflow ────────────────────────────────────────────────────────

export const SareeDetectedNodes = z.object({
  modelImageNode: z.string().nullable(),
  sareeImageNode: z.string().nullable(),
  outputNode: z.string().nullable(),
  positivePromptNode: z.string().nullable(),
  negativePromptNode: z.string().nullable(),
  defaultPositivePrompt: z.string(),
  defaultNegativePrompt: z.string(),
});

export const AdminSareeWorkflowCreateBody = z.object({
  label: z.string().min(1).max(120),
  slug: z
    .string()
    .min(1)
    .max(120)
    .regex(/^[a-z0-9_-]+$/, 'slug must be lowercase letters, digits, _ or -'),
  jsonContent: z.record(z.unknown()),
});

export const AdminSareeWorkflow = z.object({
  id: z.string().uuid(),
  slug: z.string(),
  label: z.string(),
  isActive: z.boolean(),
  jsonContent: z.record(z.unknown()),
  detected: SareeDetectedNodes,
});

// ── Admin: workers list ────────────────────────────────────────────────────

export const AdminSareeWorker = z.object({
  id: z.string(),
  label: z.string(),
  url: z.string(),
  isActive: z.boolean(),
  allowedJobTypes: z.array(z.string()),
  status: z.string().nullable(),
});
```

- [ ] **Step 2: Re-export from the types barrel**

In `packages/types/src/index.ts`, replace the line `export * from './tryon.js';` with the two lines (alphabetical: `saree` before `tryon`):

```ts
export * from './saree.js';
export * from './tryon.js';
```

- [ ] **Step 3: Build the types package**

Run: `pnpm --filter @tryme/types build`
Expected: `tsc` completes, no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/types/src/saree.ts packages/types/src/index.ts
git commit -m "feat(types): add saree Zod schemas"
```

---

### Task 3: Saree node detector + tests

**Files:**
- Create: `apps/api/src/modules/admin/saree-detect.ts`
- Create: `apps/api/src/modules/admin/saree-detect.test.ts`

**Interfaces:**
- Produces: `detectSareeMappings(json): { detected: SareeDetectedNodes, allImageNodes, allPromptNodes }`

- [ ] **Step 1: Write the failing test**

Create `apps/api/src/modules/admin/saree-detect.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { detectSareeMappings } from './saree-detect.js';

// Minimal inline fixture mirroring templates/saree.json. Templates are gitignored
// so tests must not read from disk.
const sample: Record<string, unknown> = {
  '950': {
    inputs: { filename_prefix: 'sareedraping', images: ['949:8', 0] },
    class_type: 'SaveImage',
    _meta: { title: 'save-result' },
  },
  '951': {
    inputs: { image: '1782279578.png' },
    class_type: 'LoadImage',
    _meta: { title: 'person' },
  },
  '952': {
    inputs: { image: 'image (1).jpg' },
    class_type: 'LoadImage',
    _meta: { title: 'flatsaree' },
  },
  '949:111': {
    inputs: {
      prompt: 'image 3 full body person nivi Style draped saree complete body and pleats.',
      clip: ['949:499', 1],
      vae: ['949:39', 0],
      image1: ['1014:1007', 0],
      image2: ['1014:1008', 0],
      image3: ['970', 0],
    },
    class_type: 'TextEncodeQwenImageEditPlus',
    _meta: { title: 'TextEncodeQwenImageEditPlus' },
  },
  '949:110': {
    inputs: {
      prompt: 'low quality, worst quality, blurry, soft focus, noise.',
      clip: ['949:499', 1],
      vae: ['949:39', 0],
      image1: ['1014:1007', 0],
      image2: ['1014:1008', 0],
      image3: ['970', 0],
    },
    class_type: 'TextEncodeQwenImageEditPlus',
    _meta: { title: 'TextEncodeQwenImageEditPlus' },
  },
  '949:3': {
    inputs: {
      seed: 667676120053242,
      steps: 8,
      cfg: 1,
      sampler_name: 'dpmpp_2m',
      scheduler: 'karras',
      denoise: 1,
      model: ['949:75', 0],
      positive: ['949:111', 0],
      negative: ['949:110', 0],
      latent_image: ['949:874', 0],
    },
    class_type: 'KSampler',
    _meta: { title: 'KSampler' },
  },
};

describe('detectSareeMappings', () => {
  it('detects model (person) and saree (flatsaree) image nodes', () => {
    const { detected } = detectSareeMappings(sample);
    expect(detected.modelImageNode).toBe('951');
    expect(detected.sareeImageNode).toBe('952');
  });

  it('detects output node', () => {
    const { detected } = detectSareeMappings(sample);
    expect(detected.outputNode).toBe('950');
  });

  it('detects positive and negative prompt nodes via input links', () => {
    const { detected } = detectSareeMappings(sample);
    expect(detected.positivePromptNode).toBe('949:111');
    expect(detected.negativePromptNode).toBe('949:110');
  });

  it('extracts default prompt text', () => {
    const { detected } = detectSareeMappings(sample);
    expect(detected.defaultPositivePrompt).toContain('nivi Style');
    expect(detected.defaultNegativePrompt).toContain('low quality');
  });

  it('returns null for missing nodes on a sparse JSON', () => {
    const { detected } = detectSareeMappings({});
    expect(detected.modelImageNode).toBeNull();
    expect(detected.sareeImageNode).toBeNull();
    expect(detected.outputNode).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- saree-detect`
Expected: FAIL — `Cannot find module './saree-detect.js'` or similar.

- [ ] **Step 3: Implement the detector**

Create `apps/api/src/modules/admin/saree-detect.ts`:

```ts
// Saree workflow node auto-detection.
//
// Wraps the existing tryon-detect logic — both flows are structurally identical:
// two LoadImage inputs ("person" + "garment/saree") and a single SaveImage output
// with positive/negative prompts feeding a sampler. The only delta is that the
// saree flow titles the user-uploaded image "flatsaree" (or "saree") and we
// surface the person input as `modelImageNode` to make the static/admin
// distinction explicit at the call site.

import { classifyNode, normaliseTitle, type ParsedNode } from './workflow-detect.js';

export interface DetectedSareeMappings {
  modelImageNode: string | null;
  sareeImageNode: string | null;
  outputNode: string | null;
  positivePromptNode: string | null;
  negativePromptNode: string | null;
  defaultPositivePrompt: string;
  defaultNegativePrompt: string;
}

type WorkflowNode = {
  class_type?: string;
  _meta?: { title?: string };
  inputs?: Record<string, unknown>;
};

function promptText(node: WorkflowNode | undefined): string {
  const inputs = node?.inputs;
  return (inputs?.prompt as string | undefined) ?? (inputs?.text as string | undefined) ?? '';
}

// Map a normalised LoadImage title to the saree slot. `garment` is the canonical
// tryon term; `saree` and `flatsaree` are saree-specific synonyms. The saree
// detector exposes `sareeImageNode` (user-uploaded) and `modelImageNode` (the
// static "person" image set by admin).
function isSareeTitle(norm: string): boolean {
  return norm === 'garment' || norm === 'saree' || norm === 'flatsaree';
}

function isModelTitle(norm: string): boolean {
  return norm === 'person' || norm === 'model';
}

function buildReverseLinks(
  json: Record<string, unknown>,
): Map<string, { consumerId: string; inputName: string }[]> {
  const rev = new Map<string, { consumerId: string; inputName: string }[]>();
  for (const [consumerId, raw] of Object.entries(json)) {
    const node = raw as WorkflowNode;
    if (!node?.inputs) continue;
    for (const [inputName, val] of Object.entries(node.inputs)) {
      if (Array.isArray(val) && val.length === 2 && typeof val[0] === 'string') {
        const srcId = val[0] as string;
        if (!rev.has(srcId)) rev.set(srcId, []);
        rev.get(srcId)?.push({ consumerId, inputName });
      }
    }
  }
  return rev;
}

export function detectSareeMappings(json: Record<string, unknown>): {
  detected: DetectedSareeMappings;
  allImageNodes: ParsedNode[];
  allPromptNodes: ParsedNode[];
} {
  const detected: DetectedSareeMappings = {
    modelImageNode: null,
    sareeImageNode: null,
    outputNode: null,
    positivePromptNode: null,
    negativePromptNode: null,
    defaultPositivePrompt: '',
    defaultNegativePrompt: '',
  };
  const allImageNodes: ParsedNode[] = [];
  const allPromptNodes: ParsedNode[] = [];

  // Pass 1: title / class_type detection
  for (const [nodeId, raw] of Object.entries(json)) {
    const node = raw as WorkflowNode;
    if (!node?.class_type) continue;
    const classType = node.class_type;
    const title = node._meta?.title ?? nodeId;
    const norm = normaliseTitle(title);
    const category = classifyNode(classType);

    if (category === 'image') {
      allImageNodes.push({ id: nodeId, class_type: classType, title, category });
      if (isModelTitle(norm)) detected.modelImageNode = nodeId;
      else if (isSareeTitle(norm)) detected.sareeImageNode = nodeId;
    } else if (category === 'prompt') {
      allPromptNodes.push({ id: nodeId, class_type: classType, title, category });
      if (norm === 'positive_prompt') detected.positivePromptNode = nodeId;
      else if (norm === 'negative_prompt') detected.negativePromptNode = nodeId;
    }

    if (!detected.outputNode && classType.includes('Save Image')) {
      detected.outputNode = nodeId;
    }
  }

  // Fallback: a single SaveImage node when no "Save Image*" custom node matched.
  if (!detected.outputNode) {
    for (const [nodeId, raw] of Object.entries(json)) {
      if ((raw as WorkflowNode)?.class_type === 'SaveImage') {
        detected.outputNode = nodeId;
        break;
      }
    }
  }

  // Fallback: if exactly one of the two image slots is missing a title match,
  // the un-titled image is the missing slot.
  if (!detected.modelImageNode) {
    const candidate = allImageNodes.find((n) => n.id !== detected.sareeImageNode);
    if (candidate) detected.modelImageNode = candidate.id;
  } else if (!detected.sareeImageNode) {
    const candidate = allImageNodes.find((n) => n.id !== detected.modelImageNode);
    if (candidate) detected.sareeImageNode = candidate.id;
  }

  // Pass 2: connection-based prompt detection
  if (!detected.positivePromptNode || !detected.negativePromptNode) {
    const rev = buildReverseLinks(json);
    for (const node of allPromptNodes) {
      if (detected.positivePromptNode && detected.negativePromptNode) break;
      for (const { inputName } of rev.get(node.id) ?? []) {
        if (inputName === 'positive' && !detected.positivePromptNode) {
          detected.positivePromptNode = node.id;
        } else if (inputName === 'negative' && !detected.negativePromptNode) {
          detected.negativePromptNode = node.id;
        }
      }
    }
  }

  if (detected.positivePromptNode) {
    detected.defaultPositivePrompt = promptText(json[detected.positivePromptNode] as WorkflowNode);
  }
  if (detected.negativePromptNode) {
    detected.defaultNegativePrompt = promptText(json[detected.negativePromptNode] as WorkflowNode);
  }

  allImageNodes.sort((a, b) => a.title.localeCompare(b.title));
  allPromptNodes.sort((a, b) => a.title.localeCompare(b.title));

  return { detected, allImageNodes, allPromptNodes };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @tryme/api test -- saree-detect`
Expected: 5 tests pass.

- [ ] **Step 5: Typecheck**

Run: `pnpm --filter @tryme/api typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/admin/saree-detect.ts apps/api/src/modules/admin/saree-detect.test.ts
git commit -m "feat(api): add saree node detector"
```

---

# INCREMENT 2 — Admin API

### Task 4: Saree storage keys

**Files:**
- Modify: `packages/storage/src/keys.ts` (append two new key builders)

- [ ] **Step 1: Add the keys**

In `packages/storage/src/keys.ts`, after the `tryonGarmentSampleThumb` line (currently line 28), add:

```ts
  sareeModelImage: () => `saree/global/model.jpg`,
  sareeModelImageThumb: () => `saree/global/model.thumb.jpg`,
```

- [ ] **Step 2: Build and commit**

Run:
```bash
pnpm --filter @tryme/storage build
git add packages/storage/src/keys.ts
git commit -m "feat(storage): add saree model image keys"
```

---

### Task 5: Saree settings helper

**Files:**
- Create: `apps/api/src/modules/saree/settings.ts`

**Interfaces:**
- Produces: `getSareeSettings(db): Promise<{ modelImageKey, modelImageThumbKey } | null>`, `upsertSareeSettings(db, patch): Promise<void>`

- [ ] **Step 1: Create the helper file**

Create `apps/api/src/modules/saree/settings.ts`:

```ts
import { schema } from '@tryme/db';
import type { DB } from '@tryme/db';
import { eq } from 'drizzle-orm';

const SETTINGS_ID = '00000000-0000-0000-0000-000000000001';

export interface SareeSettingsRow {
  modelImageKey: string | null;
  modelImageThumbKey: string | null;
}

export async function getSareeSettings(db: DB): Promise<SareeSettingsRow | null> {
  const [row] = await db
    .select({
      modelImageKey: schema.sareeSettings.modelImageKey,
      modelImageThumbKey: schema.sareeSettings.modelImageThumbKey,
    })
    .from(schema.sareeSettings)
    .where(eq(schema.sareeSettings.id, SETTINGS_ID));
  return row ?? null;
}

export async function upsertSareeSettings(
  db: DB,
  patch: { modelImageKey?: string | null; modelImageThumbKey?: string | null },
): Promise<void> {
  await db
    .insert(schema.sareeSettings)
    .values({ id: SETTINGS_ID, ...patch, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: schema.sareeSettings.id,
      set: { ...patch, updatedAt: new Date() },
    });
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @tryme/api typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/modules/saree/settings.ts
git commit -m "feat(api): add saree settings helper"
```

---

### Task 6: Admin saree routes

**Files:**
- Create: `apps/api/src/modules/admin/saree.routes.ts`
- Modify: `apps/api/src/server.ts:31` (insert import alphabetically) and `:131` (register route after `adminTryonRoutes`)

- [ ] **Step 1: Create the admin route file**

Create `apps/api/src/modules/admin/saree.routes.ts`:

```ts
import { schema } from '@tryme/db';
import { keys } from '@tryme/storage';
import {
  AdminSareeSettingsPatch,
  AdminSareeSettingsPresignBody,
  AdminSareeSettingsPresignResponse,
  AdminSareeWorkflow,
  AdminSareeWorkflowCreateBody,
  type SareeDetectedNodes,
} from '@tryme/types';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { getSareeSettings, upsertSareeSettings } from '../saree/settings.js';
import { requireAdmin } from './guard.js';
import { detectSareeMappings } from './saree-detect.js';

export async function adminSareeRoutes(app: FastifyInstance) {
  const W = requireAdmin(['SUPER_ADMIN', 'MODERATOR']);
  const R = requireAdmin(['SUPER_ADMIN', 'MODERATOR', 'ADMIN']);

  // ── Workflows ─────────────────────────────────────────────────────────────

  // GET /admin/saree-workflows/active
  app.get('/admin/saree-workflows/active', { preHandler: R }, async () => {
    const [row] = await db()
      .select()
      .from(schema.workflowTemplates)
      .where(
        and(
          eq(schema.workflowTemplates.workflowType, 'saree'),
          eq(schema.workflowTemplates.isActive, true),
        ),
      )
      .limit(1);
    if (!row) throw new AppError('NOT_FOUND', 404, 'no active saree workflow');
    const { detected } = detectSareeMappings(row.jsonContent as Record<string, unknown>);
    return {
      id: row.id,
      slug: row.slug,
      label: row.label,
      isActive: row.isActive,
      jsonContent: row.jsonContent,
      detected,
    } satisfies AdminSareeWorkflow;
  });

  // POST /admin/saree-workflows
  app.post(
    '/admin/saree-workflows',
    { preHandler: W, schema: { body: AdminSareeWorkflowCreateBody } },
    async (req) => {
      const body = req.body as z.infer<typeof AdminSareeWorkflowCreateBody>;
      const { detected } = detectSareeMappings(body.jsonContent);
      if (!detected.modelImageNode || !detected.sareeImageNode) {
        throw new AppError(
          'VALIDATION',
          400,
          'saree workflow must contain a "person"/"model" LoadImage and a "flatsaree"/"saree" LoadImage',
        );
      }
      const result = await db().transaction(async (tx) => {
        // Demote any existing active saree workflow (single-active invariant for the temp feature).
        await tx
          .update(schema.workflowTemplates)
          .set({ isActive: false, updatedAt: new Date() })
          .where(
            and(
              eq(schema.workflowTemplates.workflowType, 'saree'),
              eq(schema.workflowTemplates.isActive, true),
            ),
          );
        try {
          const [created] = await tx
            .insert(schema.workflowTemplates)
            .values({
              slug: body.slug,
              label: body.label,
              workflowType: 'saree',
              jsonContent: body.jsonContent,
              isActive: true,
              // The saree flow uses the same node-ID columns as tryon — both flows
              // are 2-image-input + 1-output. The dispatcher's processSareeJob
              // reads tryonPersonNodeId / tryonGarmentNodeId / tryonOutputNodeId
              // for saree workflows too.
              tryonPersonNodeId: detected.modelImageNode,
              tryonGarmentNodeId: detected.sareeImageNode,
              tryonOutputNodeId: detected.outputNode,
            })
            .returning();
          return created;
        } catch (err) {
          if ((err as { code?: string }).code === '23505') {
            throw new AppError('CONFLICT', 409, `slug "${body.slug}" already exists`);
          }
          throw err;
        }
      });
      return {
        id: result.id,
        slug: result.slug,
        label: result.label,
        isActive: result.isActive,
        jsonContent: result.jsonContent,
        detected,
      } satisfies AdminSareeWorkflow;
    },
  );

  // DELETE /admin/saree-workflows/:id
  app.delete(
    '/admin/saree-workflows/:id',
    { preHandler: W, schema: { params: z.object({ id: z.string().uuid() }) } },
    async (req) => {
      const { id } = req.params as { id: string };
      const [updated] = await db()
        .update(schema.workflowTemplates)
        .set({ isActive: false, updatedAt: new Date() })
        .where(
          and(
            eq(schema.workflowTemplates.id, id),
            eq(schema.workflowTemplates.workflowType, 'saree'),
          ),
        )
        .returning({ id: schema.workflowTemplates.id });
      if (!updated) throw new AppError('NOT_FOUND', 404, 'saree workflow not found');
      return { ok: true };
    },
  );

  // ── Settings ──────────────────────────────────────────────────────────────

  // GET /admin/saree-settings
  app.get('/admin/saree-settings', { preHandler: R }, async () => {
    const row = await getSareeSettings(db());
    const modelImageKey = row?.modelImageKey ?? null;
    const modelImageThumbKey = row?.modelImageThumbKey ?? null;
    const presign = async (key: string | null) => {
      if (!key) return null;
      try {
        return (await app.storage.presignGet(key, 3600)).url;
      } catch {
        return null;
      }
    };
    const [modelImageUrl, modelImageThumbUrl] = await Promise.all([
      presign(modelImageThumbKey ?? modelImageKey),
      presign(modelImageThumbKey),
    ]);
    return {
      modelImageKey,
      modelImageThumbKey,
      modelImageUrl,
      modelImageThumbUrl,
      isConfigured: !!modelImageKey,
    };
  });

  // POST /admin/saree-settings/presign
  app.post(
    '/admin/saree-settings/presign',
    { preHandler: W, schema: { body: AdminSareeSettingsPresignBody } },
    async (req) => {
      const { contentType } = req.body as z.infer<typeof AdminSareeSettingsPresignBody>;
      const r2Key = keys.sareeModelImage();
      const thumbKey = keys.sareeModelImageThumb();
      const [main, thumb] = await Promise.all([
        app.storage.presignPut(r2Key, contentType, 10_000_000, 300),
        app.storage.presignPut(thumbKey, 'image/jpeg', 1_000_000, 300),
      ]);
      return {
        r2Key,
        uploadUrl: main.url,
        thumbnailKey: thumbKey,
        thumbnailUploadUrl: thumb.url,
      } satisfies AdminSareeSettingsPresignResponse;
    },
  );

  // PATCH /admin/saree-settings
  app.patch(
    '/admin/saree-settings',
    { preHandler: W, schema: { body: AdminSareeSettingsPatch } },
    async (req) => {
      const body = req.body as z.infer<typeof AdminSareeSettingsPatch>;
      await upsertSareeSettings(db(), body);
      return { ok: true };
    },
  );

  // ── Workers (informational) ───────────────────────────────────────────────

  // GET /admin/saree-workers
  app.get('/admin/saree-workers', { preHandler: R }, async () => {
    const all = await db().select().from(schema.workers).orderBy(schema.workers.label);
    return all.map((w) => ({
      id: w.id,
      label: w.label,
      url: w.url,
      isActive: w.isActive,
      allowedJobTypes: w.allowedJobTypes,
      status: null, // Live worker status lives in Redis (worker:health:); skip the round-trip here.
    }));
  });

  function db() {
    return app.db;
  }
}
```

- [ ] **Step 2: Register the routes**

In `apps/api/src/server.ts`:

After the import block (line 31, the line `import { adminWorkflowsRoutes }`), add the new import alphabetically:

```ts
import { adminSareeRoutes } from './modules/admin/saree.routes.js';
```

After the `adminTryonRoutes` registration (currently line 129), add:

```ts
  await app.register(adminSareeRoutes);
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @tryme/api typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/admin/saree.routes.ts apps/api/src/server.ts
git commit -m "feat(api): add admin saree routes"
```

---

# INCREMENT 3 — User API + job creator

### Task 7: Saree job creator

**Files:**
- Create: `apps/api/src/modules/jobs/createSaree.ts`

**Interfaces:**
- Produces: `createSareeJob(app, userId, body): Promise<{ jobId, catalogueId }>`

- [ ] **Step 1: Create the file**

Create `apps/api/src/modules/jobs/createSaree.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { type DB, schema } from '@tryme/db';
import { jobsCreatedTotal } from '@tryme/observability';
import { type CreateSareeJobRequest, SIMPLE_TRYON_COST } from '@tryme/types';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { getSareeSettings } from '../saree/settings.js';
import { atomicDeduct, refund } from '../credits/ledger.js';

// Re-uses the same 10 MB cap as regular tryon (assertOwnsUploadKey is defined
// in create.ts — import the same function for consistency).
import { assertOwnsUploadKey } from './create.js';

export async function createSareeJob(
  app: FastifyInstance,
  userId: string,
  body: z.infer<typeof CreateSareeJobRequest>,
) {
  const { garmentKey } = body;
  const COST = SIMPLE_TRYON_COST;

  // 1. Ownership + existence + size check on the user-uploaded saree.
  await assertOwnsUploadKey(app, userId, garmentKey);

  // 2. Saree must be configured (admin uploaded a model image).
  const settings = await getSareeSettings(app.db);
  if (!settings?.modelImageKey) {
    throw new AppError('NOT_CONFIGURED', 400, 'saree try-on is not configured by admin');
  }

  // 3. Must be an active saree workflow.
  const [wf] = await app.db
    .select({ id: schema.workflowTemplates.id })
    .from(schema.workflowTemplates)
    .where(
      and(
        eq(schema.workflowTemplates.workflowType, 'saree'),
        eq(schema.workflowTemplates.isActive, true),
      ),
    )
    .limit(1);
  if (!wf) {
    throw new AppError('CONFIG', 400, 'no active saree workflow template configured');
  }

  // 4. User must exist and not be banned.
  const [[user], [planRow]] = await Promise.all([
    app.db.select().from(schema.users).where(eq(schema.users.id, userId)),
    app.db
      .select({ queueStream: schema.creditPlans.queueStream })
      .from(schema.users)
      .innerJoin(schema.creditPlans, eq(schema.users.tier, schema.creditPlans.slug))
      .where(eq(schema.users.id, userId)),
  ]);
  if (!user || user.isBanned) throw new AppError('FORBIDDEN', 403, 'banned');

  const queueStream: string = planRow?.queueStream ?? 'normal';
  const priority = queueStream === 'priority';

  // 5. Deduct + insert in a single txn (mirrors createSimpleTryonJob).
  const catalogueId = randomUUID();
  const job = await app.db.transaction(async (tx) => {
    const [newJob] = await tx
      .insert(schema.jobs)
      .values({
        userId,
        catalogueId,
        status: 'QUEUED',
        priority,
        creditsCharged: COST,
      })
      .returning();
    await atomicDeduct(tx as unknown as DB, userId, COST, newJob.id);
    await tx.insert(schema.jobInputs).values({
      jobId: newJob.id,
      upperGarmentKey: garmentKey,
      params: {
        modelKey: settings.modelImageKey,
        workflowTemplateId: wf.id,
        kind: 'saree',
      },
    });
    return newJob;
  });

  // 6. XADD to the right stream. Refund on failure.
  const stream = `jobs:${queueStream}`;
  try {
    await app.redis.xadd(stream, '*', 'jobId', job.id, 'userId', userId);
    jobsCreatedTotal.inc({ priority: queueStream, kind: 'saree' });
  } catch (err) {
    app.log.error({ err, jobId: job.id }, 'redis xadd failed — saree job will be refunded');
    await refund(app.db, userId, COST, job.id, 'REFUND_ENQUEUE_FAIL');
    await app.db
      .update(schema.jobs)
      .set({ status: 'FAILED', errorCode: 'ENQUEUE_FAIL' })
      .where(eq(schema.jobs.id, job.id));
    throw new AppError('ENQUEUE_FAIL', 503, 'queue unavailable');
  }

  return { jobId: job.id, catalogueId };
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @tryme/api typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/modules/jobs/createSaree.ts
git commit -m "feat(api): add createSareeJob"
```

---

### Task 8: Extend observability counter with `kind` label

**Files:**
- Modify: `packages/observability/src/metrics.ts:25-30` (change `labelNames` on `jobsCreatedTotal`)

- [ ] **Step 1: Add the new label**

In `packages/observability/src/metrics.ts`, change the `jobsCreatedTotal` definition to:

```ts
export const jobsCreatedTotal = new Counter({
  name: 'jobs_created_total',
  help: 'Jobs enqueued by the API',
  labelNames: ['priority', 'kind'] as const,
  registers: [register],
});
```

- [ ] **Step 2: Update existing callers**

In `apps/api/src/modules/jobs/create.ts` (the only existing caller of `jobsCreatedTotal.inc` other than saree), find:

```ts
jobsCreatedTotal.inc({ priority: queueStream });
```

There are two occurrences (one in the catalogue job loop, one in `createSimpleTryonJob`). Update both to:

```ts
jobsCreatedTotal.inc({ priority: queueStream, kind: 'catalogue' });
```

and for the simple-tryon one:

```ts
jobsCreatedTotal.inc({ priority: queueStream, kind: 'tryon' });
```

- [ ] **Step 3: Build + typecheck**

Run:
```bash
pnpm --filter @tryme/observability build
pnpm --filter @tryme/api typecheck
```
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/observability/src/metrics.ts apps/api/src/modules/jobs/create.ts
git commit -m "feat(observability): add kind label to jobsCreatedTotal"
```

---

### Task 9: User-facing job route + config route

**Files:**
- Modify: `apps/api/src/modules/jobs/routes.ts:1-10` (imports) and `:38` (add routes after `createSimpleTryonJob` route)

- [ ] **Step 1: Add the imports**

In `apps/api/src/modules/jobs/routes.ts`, change the `@tryme/types` import line to include `CreateSareeJobRequest` and `SareeConfigResponse`:

```ts
import {
  CreateSimpleTryonRequest,
  CreateSareeJobRequest,
  CreateTryOnJobRequest,
  SareeConfigResponse,
} from '@tryme/types';
```

Change the local import to add `createSareeJob`:

```ts
import { createJob, createSareeJob, createSimpleTryonJob } from './create.js';
```

Add a settings import:

```ts
import { getSareeSettings } from '../saree/settings.js';
```

- [ ] **Step 2: Add the routes**

After the `POST /v1/jobs/simple-tryon` route (currently ends at line 38), add:

```ts
  // GET /v1/saree/config — exposed to the user page; tells the client whether the
  // admin has configured saree try-on (model image + active workflow).
  app.get(
    '/v1/saree/config',
    { preHandler: app.requireUser, schema: { response: { 200: SareeConfigResponse } } },
    async () => {
      const row = await getSareeSettings(app.db);
      const modelImageKey = row?.modelImageKey ?? null;
      let modelImageUrl: string | null = null;
      if (modelImageKey) {
        try {
          const { url } = await app.storage.presignGet(
            row?.modelImageThumbKey ?? modelImageKey,
            3600,
          );
          modelImageUrl = url;
        } catch {
          modelImageUrl = null;
        }
      }
      return {
        modelImageUrl,
        isConfigured: !!modelImageKey,
        creditsCost: 35 as const,
      };
    },
  );

  // POST /v1/jobs/saree
  app.post(
    '/v1/jobs/saree',
    { preHandler: app.requireUser, schema: { body: CreateSareeJobRequest } },
    async (req, reply) => {
      const result = await createSareeJob(
        app,
        req.userId,
        req.body as z.infer<typeof CreateSareeJobRequest>,
      );
      reply.code(201);
      return result;
    },
  );
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @tryme/api typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/modules/jobs/routes.ts
git commit -m "feat(api): add user-facing saree job + config routes"
```

---

### Task 10: Saree job creator integration tests

**Files:**
- Create: `apps/api/test/integration/saree-jobs.test.ts`

- [ ] **Step 1: Create the test file**

Create `apps/api/test/integration/saree-jobs.test.ts`:

```ts
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from '../helpers/api';
import { type Containers, startContainers } from '../helpers/containers';

const SAMPLE_SAREE_JSON: Record<string, unknown> = {
  '950': {
    inputs: { filename_prefix: 'sareedraping', images: ['949:8', 0] },
    class_type: 'SaveImage',
    _meta: { title: 'save-result' },
  },
  '951': {
    inputs: { image: 'person.png' },
    class_type: 'LoadImage',
    _meta: { title: 'person' },
  },
  '952': {
    inputs: { image: 'saree.jpg' },
    class_type: 'LoadImage',
    _meta: { title: 'flatsaree' },
  },
};

describe('saree jobs', () => {
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
  beforeEach(async () => {
    await app.redis.del('jobs:normal');
    await app.redis.del('jobs:priority');
    // Clean any prior saree_settings / saree workflow rows.
    await app.db.delete(schema.sareeSettings);
    await app.db
      .delete(schema.workflowTemplates)
      .where(eq(schema.workflowTemplates.workflowType, 'saree'));
  });

  async function registerUser(email: string) {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email, password: 'password123' },
    });
    return {
      token: res.json().accessToken,
      userId: JSON.parse(atob(res.json().accessToken.split('.')[1])).sub,
    };
  }

  async function grantCredits(userId: string, amount: number) {
    await app.db
      .insert(schema.userCredits)
      .values({ userId, balance: amount })
      .onConflictDoUpdate({ target: schema.userCredits.userId, set: { balance: amount } });
  }

  // Mocks the upload-ownership check by binding a fake key to the user in Redis.
  async function bindUploadKey(userId: string, key: string) {
    await app.redis.set(`upload:owner:${key}`, userId, 'EX', 3600);
    await app.storage.putObject?.(key, Buffer.from('fake-jpeg-bytes'), 'image/jpeg');
  }

  async function seedSareeConfig() {
    await app.db.insert(schema.sareeSettings).values({
      modelImageKey: 'saree/global/model.jpg',
      modelImageThumbKey: 'saree/global/model.thumb.jpg',
    });
    await app.db.insert(schema.workflowTemplates).values({
      slug: 'saree-default',
      label: 'Saree default',
      workflowType: 'saree',
      jsonContent: SAMPLE_SAREE_JSON,
      isActive: true,
      tryonPersonNodeId: '951',
      tryonGarmentNodeId: '952',
      tryonOutputNodeId: '950',
    });
  }

  it('rejects with NOT_CONFIGURED when model image is missing', async () => {
    const { token, userId } = await registerUser('saree-noconf@x.com');
    await grantCredits(userId, 100);
    const key = `inputs/${userId}/garment.jpg`;
    await bindUploadKey(userId, key);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/saree',
      headers: { authorization: `Bearer ${token}` },
      payload: { garmentKey: key },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('NOT_CONFIGURED');
  });

  it('rejects with CONFIG when active workflow is missing', async () => {
    const { token, userId } = await registerUser('saree-nowf@x.com');
    await grantCredits(userId, 100);
    // Set settings but no workflow.
    await app.db.insert(schema.sareeSettings).values({ modelImageKey: 'saree/global/model.jpg' });
    const key = `inputs/${userId}/garment.jpg`;
    await bindUploadKey(userId, key);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/saree',
      headers: { authorization: `Bearer ${token}` },
      payload: { garmentKey: key },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('CONFIG');
  });

  it('rejects with FORBIDDEN when garmentKey is owned by another user', async () => {
    const { token, userId } = await registerUser('saree-other@x.com');
    await grantCredits(userId, 100);
    await seedSareeConfig();
    const foreignKey = `inputs/other-user/garment.jpg`;
    await app.redis.set(`upload:owner:${foreignKey}`, 'someone-else', 'EX', 3600);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/saree',
      headers: { authorization: `Bearer ${token}` },
      payload: { garmentKey: foreignKey },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });

  it('happy path: deducts 35 credits, inserts job+inputs, XADDs to jobs:normal', async () => {
    const { token, userId } = await registerUser('saree-happy@x.com');
    await grantCredits(userId, 100);
    await seedSareeConfig();
    const key = `inputs/${userId}/garment.jpg`;
    await bindUploadKey(userId, key);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/saree',
      headers: { authorization: `Bearer ${token}` },
      payload: { garmentKey: key },
    });
    expect(res.statusCode).toBe(201);
    const { jobId, catalogueId } = res.json();
    expect(jobId).toBeTruthy();
    expect(catalogueId).toBeTruthy();

    const [job] = await app.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
    expect(job.status).toBe('QUEUED');
    expect(job.creditsCharged).toBe(35);

    const [bal] = await app.db
      .select()
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, userId));
    expect(bal.balance).toBe(65);

    const [inputs] = await app.db
      .select()
      .from(schema.jobInputs)
      .where(eq(schema.jobInputs.jobId, jobId));
    expect(inputs.upperGarmentKey).toBe(key);
    const params = inputs.params as Record<string, unknown>;
    expect(params.kind).toBe('saree');
    expect(params.modelKey).toBe('saree/global/model.jpg');
    expect(typeof params.workflowTemplateId).toBe('string');

    const len = await app.redis.xlen('jobs:normal');
    expect(len).toBeGreaterThanOrEqual(1);
  });

  it('refunds credits and marks FAILED on enqueue failure', async () => {
    const { token, userId } = await registerUser('saree-fail@x.com');
    await grantCredits(userId, 100);
    await seedSareeConfig();
    const key = `inputs/${userId}/garment.jpg`;
    await bindUploadKey(userId, key);

    // Force xadd to throw.
    const realXadd = app.redis.xadd.bind(app.redis);
    app.redis.xadd = async () => {
      throw new Error('redis down');
    };

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/jobs/saree',
        headers: { authorization: `Bearer ${token}` },
        payload: { garmentKey: key },
      });
      expect(res.statusCode).toBe(503);

      const [bal] = await app.db
        .select()
        .from(schema.userCredits)
        .where(eq(schema.userCredits.userId, userId));
      expect(bal.balance).toBe(100); // refund

      const [job] = await app.db
        .select()
        .from(schema.jobs)
        .where(eq(schema.jobs.userId, userId));
      expect(job.status).toBe('FAILED');
      expect(job.errorCode).toBe('ENQUEUE_FAIL');
    } finally {
      app.redis.xadd = realXadd;
    }
  });
});
```

- [ ] **Step 2: Run the tests**

Run: `pnpm --filter @tryme/api test -- saree-jobs`
Expected: 5 tests pass. (If `app.storage.putObject` is not exposed on the test harness, the alternative is to rely on `assertOwnsUploadKey` HEAD check failing — adjust the binding helper to not require HEAD by mocking `storage.headObject` to return a 1024-byte fake; or check the existing jobs-create.test.ts for how uploads are faked. The integration test harness uses MinIO so real R2 writes work — the helper above is correct as written.)

If `app.storage` does not expose `putObject`, replace `bindUploadKey` with:

```ts
async function bindUploadKey(userId: string, key: string) {
  await app.redis.set(`upload:owner:${key}`, userId, 'EX', 3600);
}
```

and mock the HEAD check separately — examine how `jobs-create.test.ts` handles the headObject check. If the test harness skips HEAD validation in tests, no further change is needed.

- [ ] **Step 3: Commit**

```bash
git add apps/api/test/integration/saree-jobs.test.ts
git commit -m "test(api): add saree job creator integration tests"
```

---

# INCREMENT 4 — Dispatcher

### Task 11: Saree job processor

**Files:**
- Modify: `apps/dispatcher/src/job/processor.ts:108-122` (add a third branch before the tryon direct branch — wait, saree branch goes AFTER tryon in the if-chain)
- Modify: `apps/dispatcher/src/job/processor.ts:481-673` (clone the `processTryonDirectJob` function as `processSareeJob`)

- [ ] **Step 1: Add the branch in `processJob`**

In `apps/dispatcher/src/job/processor.ts`, replace the existing block:

```ts
  if (!inputs.faceId && !inputs.backgroundId && !inputs.poseId && rawParams.personKey) {
    await processTryonDirectJob(
      cfg,
      job,
      inputs,
      rawParams,
      userId,
      stream,
      messageId,
      jobLog,
      startedAt,
    );
    return;
  }
```

with:

```ts
  if (!inputs.faceId && !inputs.backgroundId && !inputs.poseId && rawParams.personKey) {
    await processTryonDirectJob(
      cfg,
      job,
      inputs,
      rawParams,
      userId,
      stream,
      messageId,
      jobLog,
      startedAt,
    );
    return;
  }

  // Saree jobs: kind === 'saree' in jobInputs.params. Two image inputs (model + saree),
  // admin-configured modelKey and user-uploaded garmentKey. Saree jobs route to
  // workers with 'saree' in their allowedJobTypes (selectWorker below).
  if (
    !inputs.faceId &&
    !inputs.backgroundId &&
    !inputs.poseId &&
    rawParams.kind === 'saree'
  ) {
    await processSareeJob(
      cfg,
      job,
      inputs,
      rawParams,
      userId,
      stream,
      messageId,
      jobLog,
      startedAt,
    );
    return;
  }
```

- [ ] **Step 2: Add `processSareeJob` to the bottom of the file**

Append the following function to `apps/dispatcher/src/job/processor.ts`, after `processTryonDirectJob` ends (line 673) and before `// ── Widget job processor ────` comment. The function is a structural clone of `processTryonDirectJob` with three differences: it routes to `selectWorker(redis, 'saree')`, it patches the model image instead of the person image, and the inputs come from `params.modelKey` (admin) + `inputs.upperGarmentKey` (user saree):

```ts
// ── Saree job processor ────────────────────────────────────────────────────

type SareeJob = {
  id: string;
  creditsCharged: number;
  attempts: number;
};

async function processSareeJob(
  cfg: ProcessorConfig,
  job: SareeJob,
  inputs: typeof schema.jobInputs.$inferSelect,
  params: Record<string, unknown>,
  userId: string,
  stream: string,
  messageId: string,
  jobLog: Logger,
  startedAt: number,
): Promise<void> {
  const { db, redis, pub, s3, r2Bucket } = cfg;
  const jobId = job.id;

  const modelKey = params.modelKey as string | undefined;
  const workflowTemplateId = params.workflowTemplateId as string | undefined;
  const garmentKey = inputs.upperGarmentKey;

  if (!modelKey || !workflowTemplateId || !garmentKey) {
    await markFailed(
      cfg,
      jobId,
      userId,
      stream,
      messageId,
      'SARE_INPUTS_MISSING',
      jobLog,
      startedAt,
    );
    return;
  }

  // Load saree workflow template. Saree flows reuse the tryon*_node_id columns
  // on workflow_templates (the dispatcher writes those columns at admin upload time).
  const [template] = await db
    .select({
      jsonContent: schema.workflowTemplates.jsonContent,
      tryonPersonNodeId: schema.workflowTemplates.tryonPersonNodeId,
      tryonGarmentNodeId: schema.workflowTemplates.tryonGarmentNodeId,
      tryonOutputNodeId: schema.workflowTemplates.tryonOutputNodeId,
    })
    .from(schema.workflowTemplates)
    .where(eq(schema.workflowTemplates.id, workflowTemplateId));

  if (!template) {
    await markFailed(
      cfg,
      jobId,
      userId,
      stream,
      messageId,
      'WORKFLOW_NOT_FOUND',
      jobLog,
      startedAt,
    );
    return;
  }

  const modelNodeId = template.tryonPersonNodeId;
  const sareeNodeId = template.tryonGarmentNodeId;
  const outputNodeId = template.tryonOutputNodeId;

  if (!modelNodeId || !sareeNodeId || !outputNodeId) {
    await markFailed(
      cfg,
      jobId,
      userId,
      stream,
      messageId,
      'SARE_NODES_NOT_CONFIGURED',
      jobLog,
      startedAt,
    );
    return;
  }

  await transitionJob(db, pub, jobId, userId, 'PREPROCESSING', {}, jobLog);

  // Saree jobs route to workers with 'saree' in their allowedJobTypes. Workers
  // self-declare this in the workers table (admin can edit from the Workers page).
  const worker = await selectWorker(redis, 'saree');
  if (!worker) {
    jobLog.warn('no idle saree worker — re-enqueuing with backoff');
    await db.update(schema.jobs).set({ status: 'QUEUED' }).where(eq(schema.jobs.id, jobId));
    await new Promise((resolve) => setTimeout(resolve, 10_000));
    await redis.xadd(stream, '*', 'jobId', jobId, 'userId', userId);
    await redis.xack(stream, 'dispatcher-cg', messageId);
    recordJobOutcome('retried', startedAt);
    return;
  }
  const w = worker;
  jobLog.info({ workerId: w.id }, 'worker claimed for saree');

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
      return uploadImageToComfy(w.url, w.apiKey, bytes, `${prefix}_${jobId}.${ext}`, mime, jobLog);
    }

    jobLog.info('uploading saree inputs to ComfyUI');
    const [modelFile, sareeFile] = await Promise.all([
      uploadToComfy(modelKey, 'saree_model'),
      uploadToComfy(garmentKey, 'saree_garment'),
    ]);
    jobLog.info({ modelFile, sareeFile }, 'saree inputs uploaded');

    // Clone and patch workflow
    const workflow = structuredClone(template.jsonContent) as Record<
      string,
      { inputs?: Record<string, unknown> }
    >;
    if (workflow[modelNodeId]?.inputs) {
      // biome-ignore lint/style/noNonNullAssertion: guarded by optional-chain check above
      workflow[modelNodeId].inputs!.image = modelFile;
    }
    if (workflow[sareeNodeId]?.inputs) {
      // biome-ignore lint/style/noNonNullAssertion: guarded by optional-chain check above
      workflow[sareeNodeId].inputs!.image = sareeFile;
    }

    await transitionJob(db, pub, jobId, userId, 'GENERATING', { workerId: w.id }, jobLog);
    const clientUuid = randomUUID();
    const comfyStartedAt = Date.now();
    const { promptId } = await submitPrompt(w.url, w.apiKey, clientUuid, workflow, jobLog);
    jobLog.info({ promptId }, 'saree prompt submitted');

    await db.insert(schema.jobEvents).values({
      jobId,
      eventType: 'COMFY_DISPATCH',
      payload: {
        promptId,
        workerId: w.id,
        workerUrl: w.url,
        workflowTemplateId,
        inputs: { modelKey, garmentKey, modelFile, sareeFile },
      },
    });

    await waitForCompletion(
      w.url,
      w.apiKey,
      clientUuid,
      promptId,
      300_000,
      (update) => jobLog.debug(update, 'comfyui progress'),
      { info: jobLog.info.bind(jobLog), debug: jobLog.debug.bind(jobLog) },
    );
    comfyRequestDuration.observe((Date.now() - comfyStartedAt) / 1000);

    await transitionJob(db, pub, jobId, userId, 'UPLOADING', {}, jobLog);
    const outputImages = await fetchHistory(w.url, w.apiKey, promptId, jobLog, outputNodeId);
    const [firstImage] = outputImages;
    if (!firstImage) throw new Error('ComfyUI returned no output images for saree job');

    const imageBytes = await downloadOutputImage(w.url, w.apiKey, firstImage.filename);
    const resultKey = keys.output(jobId);
    await s3.send(
      new PutObjectCommand({
        Bucket: r2Bucket,
        Key: resultKey,
        Body: imageBytes,
        ContentType: 'image/png',
      }),
    );

    let thumbnailKey: string | undefined;
    try {
      const thumbBytes = await sharp(imageBytes)
        .rotate()
        .resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 80 })
        .toBuffer();
      thumbnailKey = keys.outputThumb(jobId);
      await s3.send(
        new PutObjectCommand({
          Bucket: r2Bucket,
          Key: thumbnailKey,
          Body: thumbBytes,
          ContentType: 'image/jpeg',
        }),
      );
    } catch (thumbErr) {
      jobLog.warn({ err: thumbErr }, 'thumbnail generation failed for saree job');
    }

    await transitionJob(db, pub, jobId, userId, 'COMPLETED', { resultKey, thumbnailKey }, jobLog);
    await redis.xack(stream, 'dispatcher-cg', messageId);
    await setWorkerStatus(redis, w.id, 'IDLE');
    recordJobOutcome('success', startedAt);
    jobLog.info({ resultKey }, 'saree job completed successfully');
  } catch (err) {
    jobLog.error({ err }, 'saree job processing error');
    await setWorkerStatus(redis, w.id, 'IDLE');
    const errMsg = err instanceof Error ? err.message : String(err);
    await handleFailure(cfg, jobId, userId, stream, messageId, jobLog, startedAt, errMsg);
  }
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @tryme/dispatcher typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/dispatcher/src/job/processor.ts
git commit -m "feat(dispatcher): add saree job processor"
```

---

# INCREMENT 5 — User page

### Task 12: `/saree` page

**Files:**
- Create: `apps/web/src/app/(app)/saree/page.tsx`
- Create: `apps/web/public/assets/saree-icon.svg`

- [ ] **Step 1: Create the icon**

Create `apps/web/public/assets/saree-icon.svg` (simple dress/saree silhouette, 24×24 stroke-only, matching the other sidebar icons):

```svg
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
  <path d="M9 3h6l-1 4 4 14H6l4-14z" />
  <path d="M9 7h6" />
  <path d="M9 12h6" />
  <path d="M9 17h6" />
</svg>
```

- [ ] **Step 2: Create the user page**

Create `apps/web/src/app/(app)/saree/page.tsx`. This is a clone of the existing `/tryon` page with the second upload zone removed and a saree-specific message:

```tsx
'use client';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';
import { InfoIcon } from '@/components/icons';
import { C, grad } from '@/components/tokens';
import { TopBar } from '@/components/topbar';
import { useJobStream } from '@/hooks/use-job-stream';
import { api } from '@/lib/api';

const CREDITS_COST = 35;

type SareeConfig = {
  modelImageUrl: string | null;
  isConfigured: boolean;
  creditsCost: 35;
};

function SareeUploadZone({
  file,
  preview,
  progress,
  label,
  tip,
  onFile,
  disabled,
  sampleUrl,
}: {
  file: File | null;
  preview: string | null;
  progress: number;
  label: string;
  tip: string;
  onFile: (f: File) => void;
  disabled?: boolean;
  sampleUrl?: string | null;
}) {
  const [showSamples, setShowSamples] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  const accept = (f: File) => {
    if (!f.type.startsWith('image/')) return;
    onFile(f);
  };

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragging(false);
      const f = e.dataTransfer.files[0];
      if (f) accept(f);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [accept],
  );

  return (
    <div
      style={{
        flex: 1,
        minHeight: 0,
        borderRadius: 12,
        background: C.bg,
        boxShadow: `inset 0 0 0 1px ${C.border}`,
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'space-between',
        padding: 12,
        boxSizing: 'border-box',
        position: 'relative',
      }}
    >
      {sampleUrl && (
        <div style={{ position: 'absolute', top: 10, right: 10, zIndex: 10 }}>
          <button
            type="button"
            onMouseEnter={() => setShowSamples(true)}
            onMouseLeave={() => setShowSamples(false)}
            style={{
              width: 22,
              height: 22,
              borderRadius: '50%',
              border: 'none',
              background: 'transparent',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              cursor: 'pointer',
              padding: 0,
            }}
          >
            <InfoIcon size={16} color={C.mid} />
          </button>
          {showSamples && (
            <div
              onMouseEnter={() => setShowSamples(true)}
              onMouseLeave={() => setShowSamples(false)}
              style={{
                position: 'absolute',
                top: 26,
                right: 0,
                zIndex: 100,
                background: C.white,
                boxShadow: `0 8px 24px rgba(0,0,0,0.18), inset 0 0 0 1px ${C.border}`,
                borderRadius: 12,
                padding: 10,
              }}
            >
              <span style={{ fontSize: 11, fontWeight: 600, color: C.mid, display: 'block', marginBottom: 6 }}>
                Model reference
              </span>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={sampleUrl}
                alt=""
                style={{ width: 220, height: 220, objectFit: 'cover', borderRadius: 8, display: 'block' }}
              />
            </div>
          )}
        </div>
      )}

      <div>
        <span style={{ fontSize: 14, fontWeight: 600, color: C.text }}>{label}</span>
      </div>

      {/* biome-ignore lint/a11y/useSemanticElements: drag-and-drop zone needs div for layout */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => !disabled && inputRef.current?.click()}
        onKeyDown={(e) => e.key === 'Enter' && !disabled && inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        style={{
          flex: 1,
          margin: '12px 0',
          borderRadius: 12,
          outline: `1px dashed ${dragging ? C.pink : preview ? 'transparent' : C.lighter}`,
          outlineOffset: -1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 12,
          padding: 12,
          boxSizing: 'border-box',
          cursor: disabled ? 'default' : 'pointer',
          overflow: 'hidden',
          position: 'relative',
          transition: 'outline-color .15s',
        }}
      >
        {preview ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={preview}
            alt="preview"
            style={{ width: '100%', height: '100%', objectFit: 'contain', borderRadius: 8 }}
          />
        ) : (
          <>
            <div
              style={{
                width: 56,
                height: 56,
                borderRadius: '50%',
                background: C.white,
                boxShadow: `inset 0 0 0 1px ${C.border2}`,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                <path
                  d="M9 3h6l-1 4 4 14H6l4-14z"
                  stroke={C.mid}
                  strokeWidth="1.2"
                  strokeLinejoin="round"
                />
              </svg>
            </div>
            <span
              style={{
                fontSize: 10,
                fontWeight: 500,
                textAlign: 'center',
                color: C.light,
                lineHeight: 1.5,
              }}
            >
              Drag and drop an image here · JPG, PNG · Max 10MB
            </span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: C.text }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/assets/image-upload.svg"
                alt=""
                width={14}
                height={14}
                style={{ opacity: 0.7, filter: 'var(--icon-invert)' }}
              />
              <span style={{ fontSize: 12, fontWeight: 500 }}>Browse Image</span>
            </div>
          </>
        )}

        {progress > 0 && progress < 100 && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              background: 'rgba(0,0,0,0.45)',
              borderRadius: 12,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
            }}
          >
            <span style={{ color: '#fff', fontSize: 13, fontWeight: 600 }}>{progress}%</span>
            <div
              style={{
                width: '60%',
                height: 4,
                background: 'rgba(255,255,255,0.2)',
                borderRadius: 4,
              }}
            >
              <div
                style={{
                  width: `${progress}%`,
                  height: '100%',
                  background: grad,
                  borderRadius: 4,
                  transition: 'width .2s',
                }}
              />
            </div>
          </div>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 4 }}>
        {/* biome-ignore lint/performance/noImgElement: static SVG asset */}
        <img
          src="/assets/bulb.svg"
          alt=""
          width={12}
          height={14}
          style={{ flexShrink: 0, marginTop: 1 }}
        />
        <span style={{ fontSize: 10, fontWeight: 600, color: C.pink, flexShrink: 0 }}>Tips</span>
        <span style={{ fontSize: 10, fontWeight: 400, lineHeight: '16px', color: C.mid }}>{tip}</span>
      </div>

      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        style={{ display: 'none' }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) accept(f);
          e.target.value = '';
        }}
      />
    </div>
  );
}

export default function SareePage() {
  const [sareeFile, setSareeFile] = useState<File | null>(null);
  const [sareePreview, setSareePreview] = useState<string | null>(null);
  const [sareeProgress, setSareeProgress] = useState(0);
  const [generating, setGenerating] = useState(false);
  const [resultUrl, setResultUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pendingJobId, setPendingJobId] = useState<string | null>(null);

  const { data: cfg } = useQuery<SareeConfig>({
    queryKey: ['saree-config'],
    queryFn: () => api.get('/v1/saree/config'),
    staleTime: 5 * 60_000,
  });
  const modelImageUrl = cfg?.modelImageUrl ?? null;
  const isConfigured = cfg?.isConfigured ?? false;

  const { data: credits } = useQuery<{ balance: number }>({
    queryKey: ['credits'],
    queryFn: () => api.get('/v1/credits'),
  });

  useJobStream(
    useCallback(
      (evt) => {
        if (!pendingJobId || evt.jobId !== pendingJobId) return;
        if (evt.status === 'COMPLETED') {
          setPendingJobId(null);
          api
            .get<{ url: string }>(`/v1/jobs/${pendingJobId}/result`)
            .then(({ url }) => setResultUrl(url))
            .catch(() => setError('Generation failed. Please try again.'))
            .finally(() => {
              setGenerating(false);
              setSareeProgress(0);
            });
        } else if (evt.status === 'FAILED') {
          setPendingJobId(null);
          setError('Generation failed. Please try again.');
          setGenerating(false);
          setSareeProgress(0);
        }
      },
      [pendingJobId],
    ),
  );

  const pickFile = (file: File, setFile: (f: File) => void, setPreview: (s: string) => void) => {
    setFile(file);
    const reader = new FileReader();
    reader.onload = (e) => setPreview(e.target?.result as string);
    reader.readAsDataURL(file);
    setError(null);
    setResultUrl(null);
  };

  const handleGenerate = async () => {
    if (!sareeFile) {
      setError('Upload a saree image first.');
      return;
    }
    setGenerating(true);
    setError(null);
    setResultUrl(null);
    setSareeProgress(1);
    try {
      const presign = await api.post<{ uploadUrl: string; r2Key: string }>(
        '/v1/uploads/presign',
        { contentType: sareeFile.type, contentLength: sareeFile.size },
      );
      await api.uploadToR2WithProgress(presign.uploadUrl, sareeFile, setSareeProgress);
      setSareeProgress(100);
      const { jobId } = await api.post<{ jobId: string; catalogueId: string }>(
        '/v1/jobs/saree',
        { garmentKey: presign.r2Key },
      );
      setPendingJobId(jobId);
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      const safe = /upload|credit|image|file|size|format/i.test(msg);
      setError(safe ? msg : 'Something went wrong. Please try again.');
      setGenerating(false);
      setSareeProgress(0);
    }
  };

  const canGenerate = !generating && !!sareeFile && isConfigured;

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      <TopBar title="Saree Try-On" subtitle="" />

      <div
        style={{
          flex: 1,
          minHeight: 0,
          overflowY: 'auto',
          padding: '20px 20px 24px',
          boxSizing: 'border-box',
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gridTemplateRows: '1fr 170px',
          gap: 20,
        }}
      >
        {/* ── Upload panel ── */}
        <div
          style={{
            borderRadius: 24,
            background: C.white,
            boxShadow: `inset 0 0 0 1px ${C.border}, 0 4px 15px rgba(0,0,0,0.04)`,
            display: 'flex',
            flexDirection: 'column',
            gap: 16,
            padding: 16,
            boxSizing: 'border-box',
            minHeight: 400,
            minWidth: 320,
          }}
        >
          {/* Not-configured banner */}
          {!isConfigured && (
            <div
              style={{
                fontSize: 13,
                fontWeight: 500,
                color: '#b45309',
                background: 'rgba(245,158,11,0.12)',
                borderRadius: 8,
                padding: '10px 12px',
              }}
            >
              Saree try-on is not yet configured by the admin. Check back soon.
            </div>
          )}

          <SareeUploadZone
            file={sareeFile}
            preview={sareePreview}
            progress={sareeProgress}
            label="Upload Saree Image"
            tip="Use a flat, top-down photo of the saree for best draping results."
            disabled={generating || !isConfigured}
            sampleUrl={modelImageUrl}
            onFile={(f) => pickFile(f, setSareeFile, setSareePreview)}
          />

          {error && (
            <div
              style={{
                fontSize: 13,
                color: '#f87171',
                padding: '6px 10px',
                background: 'rgba(220,38,38,0.12)',
                borderRadius: 8,
              }}
            >
              {error}
            </div>
          )}

          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              height: 52,
              flexShrink: 0,
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flex: 1 }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src="/assets/credit.png"
                alt=""
                width={16}
                height={16}
                style={{ opacity: 0.6 }}
              />
              <span style={{ fontSize: 14, fontWeight: 500, color: C.mid }}>
                Uses {CREDITS_COST} credits
                {credits && (
                  <span style={{ color: C.light, marginLeft: 6 }}>
                    ({credits.balance} available)
                  </span>
                )}
              </span>
            </div>
            <button
              onClick={handleGenerate}
              disabled={!canGenerate}
              style={{
                height: 52,
                paddingInline: 32,
                borderRadius: 12,
                background: canGenerate ? grad : C.border,
                border: 'none',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                gap: 10,
                cursor: canGenerate ? 'pointer' : 'not-allowed',
                boxShadow: canGenerate ? '0 6px 18px rgba(245,92,122,0.28)' : 'none',
                transition: 'opacity .15s',
                flexShrink: 0,
              }}
            >
              <span
                style={{ fontSize: 15, fontWeight: 600, color: canGenerate ? '#fff' : C.light }}
              >
                {generating ? 'Generating…' : 'Generate Saree Try-On'}
              </span>
              {!generating && (
                /* biome-ignore lint/performance/noImgElement: static SVG asset */
                <img
                  src="/assets/generate-icon.svg"
                  alt=""
                  width={20}
                  height={20}
                  style={{ opacity: canGenerate ? 1 : 0.4 }}
                />
              )}
            </button>
          </div>
        </div>

        {/* ── Preview panel ── */}
        <div
          style={{
            borderRadius: 24,
            background: C.bg,
            boxShadow: `inset 0 0 0 1px ${C.border}, 0 4px 15px rgba(0,0,0,0.04)`,
            display: 'flex',
            flexDirection: 'column',
            overflow: 'hidden',
            minHeight: 400,
            minWidth: 320,
          }}
        >
          <div
            style={{
              borderBottom: `1px solid ${C.border}`,
              padding: 16,
              boxSizing: 'border-box',
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
              justifyContent: 'center',
              flexShrink: 0,
              height: 76,
            }}
          >
            <span style={{ fontSize: 18, fontWeight: 600, color: C.text }}>
              Your Saree Try-On Preview
            </span>
            {resultUrl && (
              <span style={{ fontSize: 13, fontWeight: 500, color: C.mid }}>
                Saree generated successfully.
              </span>
            )}
          </div>

          <div
            style={{
              flex: 1,
              minHeight: 0,
              padding: 16,
              boxSizing: 'border-box',
              display: 'flex',
              flexDirection: 'column',
            }}
          >
            {resultUrl ? (
              <div style={{ flex: 1, borderRadius: 8, overflow: 'hidden', position: 'relative' }}>
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={resultUrl}
                  alt="Saree result"
                  style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                />
              </div>
            ) : (
              <div
                style={{
                  flex: 1,
                  borderRadius: 8,
                  outline: `2px dashed ${C.border2}`,
                  outlineOffset: -2,
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 16,
                  padding: 24,
                  boxSizing: 'border-box',
                }}
              >
                <div
                  style={{
                    width: 120,
                    height: 120,
                    borderRadius: '50%',
                    background: C.bg,
                    boxShadow: `inset 0 0 0 1px ${C.border}`,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  {generating ? (
                    <svg aria-hidden="true" width="40" height="40" viewBox="0 0 40 40" fill="none">
                      <circle cx="20" cy="20" r="16" stroke={C.border2} strokeWidth="3" />
                      <path d="M20 4 A16 16 0 0 1 36 20" stroke={C.pink} strokeWidth="3" strokeLinecap="round">
                        <animateTransform attributeName="transform" type="rotate" from="0 20 20" to="360 20 20" dur="1s" repeatCount="indefinite" />
                      </path>
                    </svg>
                  ) : (
                    <svg aria-hidden="true" width="48" height="48" viewBox="0 0 48 48" fill="none">
                      <path d="M18 6h12l-2 8 8 28H12l8-28z" stroke={C.border2} strokeWidth="2" strokeLinejoin="round" />
                      <path d="M18 14h12" stroke={C.border2} strokeWidth="2" strokeLinecap="round" />
                      <path d="M18 24h12" stroke={C.border2} strokeWidth="2" strokeLinecap="round" />
                      <path d="M18 34h12" stroke={C.border2} strokeWidth="2" strokeLinecap="round" />
                    </svg>
                  )}
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'center' }}>
                  <span style={{ fontSize: 16, fontWeight: 600, color: C.text, textAlign: 'center' }}>
                    {generating ? 'Generating your saree try-on…' : 'No saree generated yet'}
                  </span>
                  <span style={{ fontSize: 13, fontWeight: 500, color: C.mid, textAlign: 'center', maxWidth: 340, lineHeight: 1.5 }}>
                    {generating
                      ? 'This may take a moment. Please wait.'
                      : 'Upload a flat saree image and click Generate Saree Try-On to preview the result here.'}
                  </span>
                </div>
              </div>
            )}
          </div>
        </div>

        {/* Saree +1 spacer cards (placeholder — could be Integrate/Kiosk later) */}
        <div
          style={{
            borderRadius: 24,
            background: 'rgba(124,58,237,0.08)',
            boxShadow: `inset 0 0 0 1px rgba(124,58,237,0.18), inset 0 0 0 1px ${C.border}`,
            padding: '14px 16px',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <span style={{ fontSize: 14, fontWeight: 600, color: C.text }}>
            Saree Try-On powered by Qwen-Image-Edit
          </span>
        </div>
        <div
          style={{
            borderRadius: 24,
            background: 'rgba(249,115,22,0.08)',
            boxShadow: `inset 0 0 0 1px rgba(249,115,22,0.18), inset 0 0 0 1px ${C.border}`,
            padding: '14px 16px',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <span style={{ fontSize: 14, fontWeight: 600, color: C.text }}>
            Temporary feature — subject to change
          </span>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Add to web sidebar**

In `apps/web/src/components/sidebar.tsx`, modify the `NAV` array (currently has 5 entries). Insert a new entry after the `tryon` entry:

```ts
const NAV = [
  { id: 'studio', href: '/studio', label: 'Studio', icon: `${BASE}/assets/studio-icon.svg` },
  {
    id: 'tryon',
    href: '/tryon',
    label: 'Try-On',
    icon: `${BASE}/assets/tryon-icon.svg`,
    badge: 'New',
  },
  {
    id: 'saree',
    href: '/saree',
    label: 'Saree',
    icon: `${BASE}/assets/saree-icon.svg`,
    badge: 'New',
  },
  {
    id: 'catalogues',
    href: '/catalogues',
    label: 'Catalogues',
    icon: `${BASE}/assets/catalog-icon.svg`,
  },
  { id: 'assets', href: '/assets', label: 'My Products', icon: `${BASE}/assets/asset-icon.svg` },
  { id: 'pricing', href: '/pricing', label: 'Pricing', icon: `${BASE}/assets/pricing-icon.svg` },
];
```

Update the `prefetchRoute` function to add a `saree` branch:

```ts
function prefetchRoute(id: string) {
  // ...existing branches...
  else if (id === 'saree') {
    qc.prefetchQuery({ queryKey: ['saree-config'], queryFn: () => api.get('/v1/saree/config') });
  }
}
```

- [ ] **Step 4: Typecheck + build**

Run:
```bash
pnpm --filter @tryme/web typecheck
pnpm --filter @tryme/web build
```
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/app/(app)/saree apps/web/src/components/sidebar.tsx apps/web/public/assets/saree-icon.svg
git commit -m "feat(web): add /saree page and sidebar entry"
```

---

# INCREMENT 6 — Admin page

### Task 13: Saree admin page

**Files:**
- Create: `apps/admin/src/pages/SareePage.tsx`

- [ ] **Step 1: Create the page**

Create `apps/admin/src/pages/SareePage.tsx`:

```tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { apiFetch } from '../lib/data';
import { makeThumbnail } from '../lib/thumbnail';
import { Icon } from '../components/Icons';
import type { AdminSareeSettings, AdminSareeWorker, AdminSareeWorkflow } from '../types';

async function putFile(url: string, file: Blob): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    xhr.setRequestHeader('Content-Type', file.type);
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve()
        : reject(new Error(`Upload failed: HTTP ${xhr.status}`));
    xhr.onerror = () => reject(new Error('Network error during upload'));
    xhr.send(file);
  });
}

interface Props {
  toast: (t: { kind?: 'error'; title: string; body?: string }) => void;
  onNav: (_page: string, _filter?: { page: string; filter?: string }) => void;
}

function toSnakeSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export default function SareePage({ toast, onNav }: Props) {
  const { token: _token } = useAuth();
  const [workflow, setWorkflow] = useState<AdminSareeWorkflow | null>(null);
  const [loadingWorkflow, setLoadingWorkflow] = useState(true);
  const [settings, setSettings] = useState<AdminSareeSettings | null>(null);
  const [workers, setWorkers] = useState<AdminSareeWorker[]>([]);

  // Workflow upload modal
  const [wfModal, setWfModal] = useState(false);
  const [wfLabel, setWfLabel] = useState('');
  const [wfSlug, setWfSlug] = useState('');
  const [wfFile, setWfFile] = useState<File | null>(null);
  const [wfSaving, setWfSaving] = useState(false);
  const [slugEdited, setSlugEdited] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Model image upload
  const [uploadingModel, setUploadingModel] = useState(false);
  const modelInputRef = useRef<HTMLInputElement>(null);

  const loadData = useCallback(async () => {
    setLoadingWorkflow(true);
    try {
      const [wf, st, ws] = await Promise.allSettled([
        apiFetch<AdminSareeWorkflow>('/admin/saree-workflows/active'),
        apiFetch<AdminSareeSettings>('/admin/saree-settings'),
        apiFetch<AdminSareeWorker[]>('/admin/saree-workers'),
      ]);
      if (wf.status === 'fulfilled') setWorkflow(wf.value);
      else setWorkflow(null);
      if (st.status === 'fulfilled') setSettings(st.value);
      else setSettings(null);
      if (ws.status === 'fulfilled') setWorkers(ws.value);
      else setWorkers([]);
    } finally {
      setLoadingWorkflow(false);
    }
  }, []);

  useEffect(() => {
    void loadData();
  }, [loadData]);

  const openWfModal = () => {
    setWfLabel('');
    setWfSlug('');
    setWfFile(null);
    setSlugEdited(false);
    setWfModal(true);
  };

  const handleWfLabelChange = (value: string) => {
    setWfLabel(value);
    if (!slugEdited) setWfSlug(toSnakeSlug(value));
  };

  const handleUploadWorkflow = async () => {
    if (!wfFile || !wfLabel.trim() || !wfSlug.trim()) return;
    setWfSaving(true);
    try {
      const text = await wfFile.text();
      const jsonContent = JSON.parse(text) as Record<string, unknown>;
      const created = await apiFetch<AdminSareeWorkflow>('/admin/saree-workflows', {
        method: 'POST',
        body: JSON.stringify({ label: wfLabel.trim(), slug: wfSlug.trim(), jsonContent }),
      });
      setWorkflow(created);
      toast({ title: 'Saree workflow uploaded' });
      setWfModal(false);
    } catch (e) {
      toast({
        kind: 'error',
        title: 'Failed to upload workflow',
        body: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setWfSaving(false);
    }
  };

  const handleDeactivateWorkflow = async () => {
    if (!workflow) return;
    try {
      await apiFetch(`/admin/saree-workflows/${workflow.id}`, { method: 'DELETE' });
      setWorkflow(null);
      toast({ title: 'Saree workflow deactivated' });
    } catch (e) {
      toast({
        kind: 'error',
        title: 'Failed to deactivate workflow',
        body: e instanceof Error ? e.message : String(e),
      });
    }
  };

  const handleModelUpload = async (file: File) => {
    setUploadingModel(true);
    try {
      const presign = await apiFetch<{
        r2Key: string;
        uploadUrl: string;
        thumbnailKey: string;
        thumbnailUploadUrl: string;
      }>('/admin/saree-settings/presign', {
        method: 'POST',
        body: JSON.stringify({ contentType: file.type }),
      });
      const thumb = await makeThumbnail(file, 800);
      await Promise.all([putFile(presign.uploadUrl, file), putFile(presign.thumbnailUploadUrl, thumb)]);
      await apiFetch('/admin/saree-settings', {
        method: 'PATCH',
        body: JSON.stringify({ modelImageKey: presign.r2Key, modelImageThumbKey: presign.thumbnailKey }),
      });
      const updated = await apiFetch<AdminSareeSettings>('/admin/saree-settings');
      setSettings(updated);
      toast({ title: 'Model image updated' });
    } catch (e) {
      toast({
        kind: 'error',
        title: 'Failed to upload model image',
        body: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setUploadingModel(false);
    }
  };

  const handleRemoveModel = async () => {
    try {
      await apiFetch('/admin/saree-settings', {
        method: 'PATCH',
        body: JSON.stringify({ modelImageKey: null, modelImageThumbKey: null }),
      });
      const updated = await apiFetch<AdminSareeSettings>('/admin/saree-settings');
      setSettings(updated);
      toast({ title: 'Model image removed' });
    } catch (e) {
      toast({
        kind: 'error',
        title: 'Failed to remove model image',
        body: e instanceof Error ? e.message : String(e),
      });
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
        <div>
          <h2 style={{ margin: 0, fontSize: '1.125rem', fontWeight: 600 }}>Saree Try-On</h2>
          <p style={{ margin: '4px 0 0', fontSize: 13, color: 'var(--muted)' }}>
            Temporary feature — upload the ComfyUI workflow and the static model image.
          </p>
        </div>
      </div>

      {/* Section 1: Workflow */}
      <div className="card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>1. ComfyUI Workflow</span>
          <div style={{ display: 'flex', gap: 8 }}>
            {workflow && (
              <button className="btn ghost" onClick={handleDeactivateWorkflow}>
                Deactivate
              </button>
            )}
            <button className="btn primary" onClick={openWfModal}>
              <Icon.Plus /> {workflow ? 'Replace workflow' : 'Upload workflow'}
            </button>
          </div>
        </div>

        {loadingWorkflow ? (
          <div style={{ color: 'var(--muted)', fontSize: 12 }}>Loading…</div>
        ) : workflow ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, fontSize: 12, color: 'var(--muted)' }}>
            <div>
              <strong style={{ color: 'var(--text)' }}>{workflow.label}</strong>{' '}
              <code style={{ background: 'var(--bg-2)', padding: '1px 5px', borderRadius: 3 }}>{workflow.slug}</code>{' '}
              <span
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  padding: '2px 7px',
                  borderRadius: 10,
                  background: 'rgba(76,175,80,0.12)',
                  color: '#4caf50',
                }}
              >
                Active
              </span>
            </div>
            <div>
              Model: <code>{workflow.detected.modelImageNode ?? '—'}</code> · Saree:{' '}
              <code>{workflow.detected.sareeImageNode ?? '—'}</code> · Output:{' '}
              <code>{workflow.detected.outputNode ?? '—'}</code> · Prompts:{' '}
              <code>{workflow.detected.positivePromptNode ?? '—'}</code> /{' '}
              <code>{workflow.detected.negativePromptNode ?? '—'}</code>
            </div>
          </div>
        ) : (
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>No active workflow.</div>
        )}
      </div>

      {/* Section 2: Model image */}
      <div className="card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>2. Model Image</span>
        </div>
        <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
          <div
            style={{
              width: 100,
              height: 100,
              borderRadius: 8,
              border: '1px solid var(--border)',
              background: 'var(--bg-2)',
              flexShrink: 0,
              overflow: 'hidden',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {settings?.modelImageThumbUrl ?? settings?.modelImageUrl ? (
              // biome-ignore lint/performance/noImgElement: admin thumbnail
              <img
                src={settings.modelImageThumbUrl ?? settings.modelImageUrl ?? ''}
                alt=""
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              />
            ) : (
              <Icon.Image />
            )}
          </div>
          <div style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>Static model person</div>
            <div style={{ fontSize: 11, color: 'var(--muted)' }}>
              {settings?.isConfigured
                ? 'Image uploaded — used as the model for every saree job.'
                : 'No image yet — saree try-on is disabled for users until you upload one.'}
            </div>
            <div style={{ display: 'flex', gap: 8 }}>
              <label
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  padding: '6px 12px',
                  border: '1.5px dashed var(--border)',
                  borderRadius: 7,
                  cursor: uploadingModel ? 'not-allowed' : 'pointer',
                  opacity: uploadingModel ? 0.6 : 1,
                  background: 'var(--surface-2)',
                  fontSize: 12,
                  color: 'var(--muted)',
                  userSelect: 'none',
                }}
              >
                <Icon.Image />
                {uploadingModel ? 'Uploading…' : settings?.isConfigured ? 'Replace image' : 'Upload image'}
                <input
                  ref={modelInputRef}
                  type="file"
                  accept="image/jpeg,image/png,image/webp"
                  disabled={uploadingModel}
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) void handleModelUpload(file);
                    if (modelInputRef.current) modelInputRef.current.value = '';
                  }}
                />
              </label>
              {settings?.isConfigured && (
                <button className="btn sm ghost" style={{ color: 'var(--danger)' }} onClick={handleRemoveModel}>
                  Remove
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Section 3: Worker selection (informational) */}
      <div className="card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 14, fontWeight: 600 }}>3. Worker Selection</span>
          <button className="btn ghost sm" onClick={() => onNav('workers')}>
            Edit workers →
          </button>
        </div>
        <p style={{ margin: 0, fontSize: 11, color: 'var(--muted)' }}>
          Workers self-declare which job types they accept. Saree jobs route to workers with{' '}
          <code>saree</code> in their <code>allowedJobTypes</code>. To enable a worker for saree,
          add <code>saree</code> on the Workers page.
        </p>
        {workers.length === 0 ? (
          <div style={{ fontSize: 12, color: 'var(--muted)' }}>No workers registered.</div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ textAlign: 'left', color: 'var(--muted)' }}>
                <th style={{ padding: '6px 8px' }}>Label</th>
                <th style={{ padding: '6px 8px' }}>URL</th>
                <th style={{ padding: '6px 8px' }}>Active</th>
                <th style={{ padding: '6px 8px' }}>Job types</th>
                <th style={{ padding: '6px 8px' }}>Saree-capable</th>
              </tr>
            </thead>
            <tbody>
              {workers.map((w) => {
                const capable = w.allowedJobTypes.includes('saree');
                return (
                  <tr key={w.id} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={{ padding: '6px 8px' }}>{w.label || w.id}</td>
                    <td style={{ padding: '6px 8px' }}>
                      <code style={{ fontSize: 10 }}>{w.url}</code>
                    </td>
                    <td style={{ padding: '6px 8px' }}>{w.isActive ? 'Yes' : 'No'}</td>
                    <td style={{ padding: '6px 8px' }}>
                      {(w.allowedJobTypes ?? []).join(', ') || '(any)'}
                    </td>
                    <td style={{ padding: '6px 8px' }}>
                      {capable ? (
                        <span
                          style={{
                            fontSize: 10,
                            fontWeight: 600,
                            padding: '2px 7px',
                            borderRadius: 10,
                            background: 'rgba(76,175,80,0.12)',
                            color: '#4caf50',
                          }}
                        >
                          Yes
                        </span>
                      ) : (
                        <span style={{ fontSize: 10, color: 'var(--muted)' }}>No</span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {/* Workflow upload modal */}
      {wfModal && (
        <div className="modal-overlay" onClick={() => !wfSaving && setWfModal(false)}>
          <div
            className="modal"
            onClick={(e) => e.stopPropagation()}
            style={{ width: 'min(520px, calc(100vw - 40px))' }}
          >
            <div className="modal-head">
              <h3>Upload saree workflow JSON</h3>
              <button
                className="btn sm ghost"
                onClick={() => setWfModal(false)}
                disabled={wfSaving}
                style={{ marginLeft: 'auto' }}
              >
                <Icon.Close />
              </button>
            </div>
            <div className="modal-body" style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
              <div className="field">
                <label>Label</label>
                <input
                  className="input"
                  value={wfLabel}
                  disabled={wfSaving}
                  placeholder="e.g. Saree default"
                  onChange={(e) => handleWfLabelChange(e.target.value)}
                />
              </div>
              <div className="field">
                <label>
                  Slug{' '}
                  <span style={{ fontSize: 10, color: 'var(--muted)', fontWeight: 400 }}>
                    (auto-derived, editable)
                  </span>
                </label>
                <input
                  className="input"
                  value={wfSlug}
                  disabled={wfSaving}
                  placeholder="kebab-case"
                  onChange={(e) => {
                    setSlugEdited(true);
                    setWfSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'));
                  }}
                />
              </div>
              <div className="field">
                <label>ComfyUI JSON file</label>
                <label
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 6,
                    padding: '6px 12px',
                    border: '1.5px dashed var(--border)',
                    borderRadius: 7,
                    cursor: wfSaving ? 'not-allowed' : 'pointer',
                    background: 'var(--surface-2)',
                    fontSize: 12,
                    color: 'var(--muted)',
                    userSelect: 'none',
                    width: 'fit-content',
                  }}
                >
                  <Icon.Workflow />
                  {wfFile ? wfFile.name : 'Choose .json file'}
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="application/json"
                    disabled={wfSaving}
                    style={{ display: 'none' }}
                    onChange={(e) => setWfFile(e.target.files?.[0] ?? null)}
                  />
                </label>
              </div>
            </div>
            <div className="modal-foot">
              <button className="btn ghost" onClick={() => setWfModal(false)} disabled={wfSaving}>
                Cancel
              </button>
              <button
                className="btn primary"
                disabled={wfSaving || !wfFile || !wfLabel.trim() || !wfSlug.trim()}
                onClick={() => void handleUploadWorkflow()}
              >
                {wfSaving ? 'Uploading…' : 'Upload'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 2: Register the page**

In `apps/admin/src/App.tsx` (or wherever pages are mapped to `page` keys), add a mapping for `page === 'saree'` → `<SareePage ... />`. Also add the import. The exact import line depends on the existing structure — read the file first if it doesn't follow the pattern shown.

- [ ] **Step 3: Add to admin sidebar**

In `apps/admin/src/components/Sidebar.tsx`, add to the `items` array (after the `tryon` entry, line 39):

```ts
{ k: 'saree', label: 'Saree', icon: Icon.Workflow, roles: ['SUPER_ADMIN', 'MODERATOR'] },
```

- [ ] **Step 4: Typecheck + build**

Run:
```bash
pnpm --filter @tryme/admin typecheck
pnpm --filter @tryme/admin build
```
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add apps/admin/src/pages/SareePage.tsx apps/admin/src/App.tsx apps/admin/src/components/Sidebar.tsx
git commit -m "feat(admin): add saree admin page + sidebar entry"
```

---

# INCREMENT 7 — Manual smoke test + docs

### Task 14: Manual smoke test (record results in `docs/progress.md`)

- [ ] **Step 1: Bring up the dev stack**

Run:
```bash
pnpm docker:up
pnpm db:migrate
pnpm dev
```

- [ ] **Step 2: Run the full test suite**

Run:
```bash
pnpm --filter @tryme/api test
pnpm --filter @tryme/dispatcher test
```
Expected: all tests pass, including the new `saree-detect` and `saree-jobs` files.

- [ ] **Step 3: Manual admin flow**

1. Open `http://localhost:5173`, log in as a SUPER_ADMIN
2. Click "Saree" in the sidebar
3. In section 1, click "Upload workflow", pick `templates/saree.json`, label "Saree test", slug auto-fills
4. Verify the card shows detected nodes: `Model: 951 · Saree: 952 · Output: 950 · Prompts: 949:111 / 949:110`
5. In section 2, upload any JPG/PNG as the model image. Verify the thumbnail appears
6. In section 3, verify the worker table shows the "Saree-capable" badge correctly based on `allowedJobTypes`

- [ ] **Step 4: Manual user flow**

1. Open `http://localhost:3000/saree` in a regular browser (not the admin)
2. Verify the "not configured" banner is GONE (since admin uploaded model image)
3. Upload a flat saree image
4. Click "Generate Saree Try-On"
5. Watch the spinner, then the result image
6. Verify credits decreased by 35
7. Verify the Jobs admin page shows the saree job with the right kind

- [ ] **Step 5: Failure paths**

1. Set `modelImageKey = null` in `saree_settings`, refresh `/saree` — verify "not configured" banner returns
2. Deactivate the workflow, try to generate from `/saree` — should fail with 400 `CONFIG`
3. Test with a banned user (set `is_banned=true` in DB) — should fail with 403

- [ ] **Step 6: Update `docs/progress.md`**

Add a dated entry at the top of `docs/progress.md`:

```markdown
## 2026-06-30 — Saree Try-On (temporary feature)

**Done**
- New `saree_settings` table + migration
- Saree Zod types in `@tryme/types`
- `saree-detect.ts` auto-detects person + saree LoadImage nodes
- Admin routes: upload workflow, set model image, list workers
- User route: `POST /v1/jobs/saree` (35 credits, normal/priority queue)
- Dispatcher `processSareeJob` routes to workers with `saree` in `allowedJobTypes`
- User page at `/saree`, admin page at `/saree`
- Integration tests for createSareeJob (5 cases)
- Detector unit tests (5 cases)

**Tested manually**
- Admin upload of `templates/saree.json` → nodes detected
- Admin upload of model image → thumbnail visible
- User upload + generate → result image renders, credits deducted
- Failure paths: not-configured, missing workflow, banned user
```

- [ ] **Step 7: Commit progress doc**

```bash
git add docs/progress.md
git commit -m "docs(progress): log saree try-on completion"
```

---

## Self-Review

**1. Spec coverage** — checked against `docs/superpowers/specs/2026-06-30-saree-tryon-design.md`:

| Spec section | Plan task(s) |
|---|---|
| New `saree_settings` table | Task 1 |
| New `workflowType='saree'` value | Tasks 1, 6 (no schema change, write through) |
| Admin routes (workflow active/upload/deactivate, settings GET/presign/PATCH, workers list) | Task 6 |
| User routes (config + job) | Tasks 8, 9 |
| `SareeConfigResponse` etc. Zod schemas | Task 2 |
| `saree-detect.ts` wraps tryon-detect | Task 3 |
| Dispatcher `processSareeJob` | Task 11 |
| Worker jobType affinity (uses existing `allowedJobTypes`) | Task 11 (no dispatcher change needed beyond `selectWorker(redis, 'saree')`) |
| `/saree` user page | Task 12 |
| `/saree` admin page (3 sections) | Task 13 |
| Sidebar entries (admin + web) | Tasks 12, 13 |
| `jobsCreatedTotal` `kind` label | Task 8 |
| Tests: detector + integration | Tasks 3, 10 |
| Manual test plan | Task 14 |
| Migration rollout | Task 1 |
| Rollback (drop table, remove files) | Documented in spec; not a plan task (instructions in spec) |

**2. Placeholder scan** — no "TBD"/"TODO"/"implement later" left in the plan. Every code block is complete. The one diagnostic note in Task 10 ("If `app.storage` does not expose `putObject`, …") is a real fallback that ships in the same task.

**3. Type consistency** —
- `detectSareeMappings` returns `DetectedSareeMappings` (Task 3) — used identically in Tasks 6, 10, 13.
- `CreateSareeJobRequest` (Task 2) — used in Tasks 7, 9.
- `SareeConfigResponse` (Task 2) — used in Task 9.
- `getSareeSettings` / `upsertSareeSettings` (Task 5) — used in Tasks 6, 7, 9.
- `keys.sareeModelImage()` / `keys.sareeModelImageThumb()` (Task 4) — used in Task 6.
- `processSareeJob` (Task 11) — referenced by name only, defined in the same task.
- The saree workflow's `tryonPersonNodeId` / `tryonGarmentNodeId` / `tryonOutputNodeId` columns are set in Task 6 and read in Task 11 — names match exactly.

**4. Ambiguity check** — Task 11's `processSareeJob` calls `selectWorker(redis, 'saree')` — verified against `apps/dispatcher/src/worker/selector.ts:49` which accepts any string `jobType`. The `CLAIM_LUA` script in `selector.ts:10-41` checks `allowed.includes(t)` for the string match, so `'saree'` is valid out of the box. No dispatcher change required.
