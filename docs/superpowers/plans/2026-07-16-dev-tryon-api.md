# Developer Try-On API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let third-party developers POST a person image + garment image + category with an API key and poll for a generated try-on image.

**Architecture:** The generation pipeline already exists — `apps/dispatcher/src/job/processor.ts:134` routes any job whose `job_inputs` has `params.personKey` and no `faceId`/`backgroundId`/`poseId` to the person+garment tryon workflow. This plan adds only an API-key auth layer, a new `apps/api/src/modules/dev/` route module that writes that exact job shape, merchant key-management routes, and a dashboard. **No dispatcher changes.**

**Tech Stack:** Fastify 5, `fastify-type-provider-zod`, Drizzle ORM (Postgres 16), Redis 7, `@fastify/multipart` (already a dep), `@fastify/rate-limit` (already registered), Vitest, Next.js 15 (`apps/catalogues-web`).

## Global Constraints

- ESM only. Every relative import ends in `.js`, even from `.ts` files.
- pnpm workspaces only. Never create npm/yarn lockfiles.
- No `console.log`. Use `app.log` / `@tryme/logger`.
- Credit deduct + job insert must be one Postgres transaction.
- Errors: throw `AppError(code, statusCode, message)` from `apps/api/src/lib/errors.js`. The global handler in `server.ts` renders `{ error: { code, message } }`.
- Zod schemas live in `packages/types/src/`. They are the single source of truth for request/response shapes.
- `pnpm docker:up` must be running before any test.
- Key format is exactly `sk_live_` + `crypto.randomBytes(32).toString('base64url')` (43 chars) → regex `/^sk_live_[A-Za-z0-9_-]{43}$/`.
- Per-key rate limit: **60 requests / 1 minute**.
- Upload limits: max 2 files, **10 MiB each**, `image/jpeg` | `image/png` | `image/webp` only, validated by magic bytes.
- Presigned result URLs expire in **900 seconds** (15 min).
- Never log a full API key. Never store one in plaintext.
- Spec: `docs/superpowers/specs/2026-07-16-dev-tryon-api-design.md`.

---

## File Structure

**Create:**
- `packages/db/src/schema/api-keys.ts` — `apiKeys` table only.
- `packages/types/src/dev.ts` — Zod schemas for the `/v1/dev/*` contract.
- `apps/api/src/modules/dev/keys.ts` — key generation/hashing/format. Pure, no I/O.
- `apps/api/src/modules/dev/image-sniff.ts` — magic-byte MIME detection. Pure, no I/O.
- `apps/api/src/plugins/dev-api-auth.ts` — `app.requireApiKey`.
- `apps/api/src/modules/dev/create-job.ts` — `createDevTryonJob`.
- `apps/api/src/modules/dev/routes.ts` — the four `/v1/dev/*` routes.
- `apps/api/src/modules/merchant/api-keys.routes.ts` — dashboard key CRUD under `requireMerchant`.
- `apps/api/test/helpers/merchant.ts` — test merchant + credits + key factory.
- `apps/catalogues-web/src/app/(app)/developers/` — dashboard route.

**Modify:**
- `packages/db/src/schema/index.ts` — re-export `./api-keys.js`.
- `packages/db/src/schema/jobs.ts:18-40` — add `apiKeyId` column.
- `packages/types/src/index.ts` — re-export `./dev.js`.
- `apps/api/src/server.ts:138` (multipart), `:145` (plugins), `:190` (routes).

Rationale: `keys.ts` and `image-sniff.ts` are pure and get fast unit tests with no containers. `create-job.ts` is separate from `routes.ts` because it is the transactional, security-load-bearing part — the same split `merchant/create-job.ts` already uses. It is deliberately **not** a branch inside `jobs/create.ts`, which is long and handles multi-pose/lower/shoe cases this flow never needs.

---

### Task 1: Schema — `api_keys` table + `jobs.apiKeyId`

**Files:**
- Create: `packages/db/src/schema/api-keys.ts`
- Modify: `packages/db/src/schema/index.ts`
- Modify: `packages/db/src/schema/jobs.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `schema.apiKeys` with columns `id, merchantId, label, keyHash, keyPrefix, lastUsedAt, revokedAt, createdAt`; `schema.jobs.apiKeyId`.

- [ ] **Step 1: Create the table**

Create `packages/db/src/schema/api-keys.ts`:

```ts
import { pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { merchants } from './merchant.js';

export const apiKeys = pgTable('api_keys', {
  id: uuid('id').primaryKey().defaultRandom(),
  merchantId: uuid('merchant_id')
    .notNull()
    .references(() => merchants.id, { onDelete: 'cascade' }),
  label: text('label').notNull(),
  // sha256(full key), hex. Unique so auth is a single index probe — and so a DB
  // dump never yields a usable key. The plaintext key exists only in the create
  // response.
  keyHash: text('key_hash').notNull().unique(),
  // e.g. "sk_live_a1b2" — dashboard display only, never sufficient to authenticate.
  keyPrefix: text('key_prefix').notNull(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }),
  revokedAt: timestamp('revoked_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});
```

- [ ] **Step 2: Re-export it**

In `packages/db/src/schema/index.ts`, add in alphabetical position (first line, before `./admin.js`):

```ts
export * from './api-keys.js';
```

- [ ] **Step 3: Add `jobs.apiKeyId`**

In `packages/db/src/schema/jobs.ts`, add to the imports:

```ts
import { apiKeys } from './api-keys.js';
```

Then inside the `jobs` table, immediately after the `merchantId` column:

```ts
  // Set only by /v1/dev/* jobs — stamps which API key created the job so the
  // developer dashboard can report per-key usage without a second credit balance.
  apiKeyId: uuid('api_key_id').references(() => apiKeys.id, { onDelete: 'set null' }),
```

Also extend the existing `source` comment above it to list `'api'`:

```ts
  // Which flow created this job — 'catalog' | 'tryon' | 'saree' | 'shopify' | 'api'.
```

`source` is free-text (`text('source')`), so `'api'` needs no enum migration.

- [ ] **Step 4: Generate the migration**

Run: `pnpm db:generate`

Expected: a new `packages/db/src/migrations/NNNN_*.sql` containing `CREATE TABLE "api_keys"` and `ALTER TABLE "jobs" ADD COLUMN "api_key_id"`, plus an updated `meta/_journal.json`.

Note the index it picks. If `origin/master` later lands the same index, the branch renumbers upward — server index is canonical (see CLAUDE.md "Migration Index Conflicts").

- [ ] **Step 5: Apply and typecheck**

Run: `pnpm db:migrate && pnpm --filter @tryme/db typecheck`
Expected: migration applies, typecheck passes.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema/api-keys.ts packages/db/src/schema/index.ts packages/db/src/schema/jobs.ts packages/db/src/migrations/
git commit -m "feat(db): add api_keys table and jobs.api_key_id"
```

---

### Task 2: Key generation and hashing (pure)

**Files:**
- Create: `apps/api/src/modules/dev/keys.ts`
- Test: `apps/api/test/dev-keys.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `generateApiKey(): { key: string; keyHash: string; keyPrefix: string }`
  - `hashApiKey(key: string): string`
  - `API_KEY_RE: RegExp`
  - `extractBearer(header: string | undefined): string | undefined`

No containers needed — this file is pure, so the test runs in milliseconds.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/dev-keys.test.ts`:

```ts
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { API_KEY_RE, extractBearer, generateApiKey, hashApiKey } from '../src/modules/dev/keys.js';

describe('generateApiKey', () => {
  it('produces a key matching the documented format', () => {
    const { key } = generateApiKey();
    expect(key).toMatch(API_KEY_RE);
    expect(key.startsWith('sk_live_')).toBe(true);
    expect(key.length).toBe(8 + 43);
  });

  it('returns the sha256 hex of the key as keyHash', () => {
    const { key, keyHash } = generateApiKey();
    expect(keyHash).toBe(createHash('sha256').update(key).digest('hex'));
  });

  it('returns a prefix that is a strict, non-authenticating substring', () => {
    const { key, keyPrefix } = generateApiKey();
    expect(keyPrefix).toBe(key.slice(0, 12));
    expect(keyPrefix.length).toBeLessThan(key.length);
  });

  it('never repeats a key', () => {
    const keys = new Set(Array.from({ length: 500 }, () => generateApiKey().key));
    expect(keys.size).toBe(500);
  });
});

describe('hashApiKey', () => {
  it('is deterministic', () => {
    expect(hashApiKey('sk_live_abc')).toBe(hashApiKey('sk_live_abc'));
  });

  it('differs for different keys', () => {
    expect(hashApiKey('sk_live_abc')).not.toBe(hashApiKey('sk_live_abd'));
  });
});

describe('API_KEY_RE', () => {
  it('rejects malformed keys', () => {
    expect(API_KEY_RE.test('sk_live_short')).toBe(false);
    expect(API_KEY_RE.test('sk_test_' + 'a'.repeat(43))).toBe(false);
    expect(API_KEY_RE.test('a'.repeat(43))).toBe(false);
    expect(API_KEY_RE.test("sk_live_' OR 1=1--")).toBe(false);
    expect(API_KEY_RE.test('sk_live_' + 'a'.repeat(44))).toBe(false);
  });

  it('is not sticky (safe to reuse across calls)', () => {
    const { key } = generateApiKey();
    expect(API_KEY_RE.test(key)).toBe(true);
    expect(API_KEY_RE.test(key)).toBe(true);
  });
});

describe('extractBearer', () => {
  it('extracts a bearer token', () => {
    expect(extractBearer('Bearer sk_live_x')).toBe('sk_live_x');
  });

  it('returns undefined for missing or non-bearer headers', () => {
    expect(extractBearer(undefined)).toBeUndefined();
    expect(extractBearer('Basic abc')).toBeUndefined();
    expect(extractBearer('sk_live_x')).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- dev-keys`
Expected: FAIL — cannot resolve `../src/modules/dev/keys.js`.

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/modules/dev/keys.ts`:

```ts
import { createHash, randomBytes } from 'node:crypto';

const PREFIX = 'sk_live_';

// 32 random bytes → base64url is 43 chars, alphabet [A-Za-z0-9_-]. Deliberately
// NOT sticky (no /g flag): a sticky regex carries lastIndex between .test()
// calls and would intermittently reject valid keys.
export const API_KEY_RE = /^sk_live_[A-Za-z0-9_-]{43}$/;

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export function generateApiKey(): { key: string; keyHash: string; keyPrefix: string } {
  const key = PREFIX + randomBytes(32).toString('base64url');
  return { key, keyHash: hashApiKey(key), keyPrefix: key.slice(0, 12) };
}

export function extractBearer(header: string | undefined): string | undefined {
  if (!header?.startsWith('Bearer ')) return undefined;
  return header.slice(7) || undefined;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @tryme/api test -- dev-keys`
Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/dev/keys.ts apps/api/test/dev-keys.test.ts
git commit -m "feat(api): add API key generation and hashing"
```

---

### Task 3: Image magic-byte sniffing (pure)

**Files:**
- Create: `apps/api/src/modules/dev/image-sniff.ts`
- Test: `apps/api/test/dev-image-sniff.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `sniffImageMime(buf: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | undefined`

Why this exists: a client-declared `Content-Type` is attacker-controlled. Trusting it would let anyone store arbitrary bytes in R2 under an image key. Magic bytes are the actual file contents.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/dev-image-sniff.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { sniffImageMime } from '../src/modules/dev/image-sniff.js';

const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(20)]);
const png = () =>
  Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(20),
  ]);
const webp = () => {
  const b = Buffer.alloc(20);
  b.write('RIFF', 0, 'ascii');
  b.writeUInt32LE(12, 4);
  b.write('WEBP', 8, 'ascii');
  return b;
};

describe('sniffImageMime', () => {
  it('detects jpeg', () => {
    expect(sniffImageMime(jpeg())).toBe('image/jpeg');
  });

  it('detects png', () => {
    expect(sniffImageMime(png())).toBe('image/png');
  });

  it('detects webp', () => {
    expect(sniffImageMime(webp())).toBe('image/webp');
  });

  it('rejects a non-image', () => {
    expect(sniffImageMime(Buffer.from('#!/bin/sh\nrm -rf /', 'utf8'))).toBeUndefined();
  });

  it('rejects a RIFF container that is not WEBP (e.g. a wav)', () => {
    const b = Buffer.alloc(20);
    b.write('RIFF', 0, 'ascii');
    b.write('WAVE', 8, 'ascii');
    expect(sniffImageMime(b)).toBeUndefined();
  });

  it('rejects a buffer too short to hold a signature', () => {
    expect(sniffImageMime(Buffer.from([0xff, 0xd8]))).toBeUndefined();
    expect(sniffImageMime(Buffer.alloc(0))).toBeUndefined();
  });

  it('rejects an SVG (an image type we do not allow — it can carry script)', () => {
    expect(sniffImageMime(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg">', 'utf8'))).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- dev-image-sniff`
Expected: FAIL — cannot resolve `../src/modules/dev/image-sniff.js`.

- [ ] **Step 3: Write the implementation**

Create `apps/api/src/modules/dev/image-sniff.ts`:

```ts
export type AllowedImageMime = 'image/jpeg' | 'image/png' | 'image/webp';

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * Detects image type from magic bytes. Returns undefined for anything that is
 * not one of the three allowed types.
 *
 * The client-declared Content-Type is attacker-controlled and is never consulted:
 * this reads what the bytes actually are. SVG is intentionally absent — it is
 * XML that can carry script, and ComfyUI cannot consume it anyway.
 */
export function sniffImageMime(buf: Buffer): AllowedImageMime | undefined {
  if (buf.length < 12) return undefined;
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.subarray(0, 8).equals(PNG_SIG)) return 'image/png';
  if (buf.subarray(0, 4).toString('ascii') === 'RIFF' && buf.subarray(8, 12).toString('ascii') === 'WEBP') {
    return 'image/webp';
  }
  return undefined;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @tryme/api test -- dev-image-sniff`
Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/dev/image-sniff.ts apps/api/test/dev-image-sniff.test.ts
git commit -m "feat(api): add magic-byte image type sniffing"
```

---

### Task 4: Storage key builder

**Files:**
- Modify: `packages/storage/src/keys.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `keys.devUpload(merchantId: string, id: string, ext: string) => string`

- [ ] **Step 1: Add the builder**

In `packages/storage/src/keys.ts`, add inside the `keys` object after `merchantCatalogFlatGarment`:

```ts
  devUpload: (merchantId: string, id: string, ext: string) => `dev/${merchantId}/${id}.${ext}`,
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @tryme/storage typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/storage/src/keys.ts
git commit -m "feat(storage): add devUpload key builder"
```

---

### Task 5: Shared Zod contract

**Files:**
- Create: `packages/types/src/dev.ts`
- Modify: `packages/types/src/index.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `DevTryonResponse`, `DevJobResponse`, `DevCategoriesResponse`, `DevMeResponse`, `DevJobParams`, `ApiKeyCreateBody`, `ApiKeyCreateResponse`, `ApiKeyListResponse`.

- [ ] **Step 1: Write the schemas**

Create `packages/types/src/dev.ts`:

```ts
import { z } from 'zod';

export const DevJobStatus = z.enum(['QUEUED', 'RUNNING', 'COMPLETED', 'FAILED']);

export const DevTryonResponse = z.object({
  jobId: z.string().uuid(),
  status: DevJobStatus,
});

export const DevJobResponse = z.object({
  jobId: z.string().uuid(),
  status: DevJobStatus,
  imageUrl: z.string().url().optional(),
  error: z.string().optional(),
});

export const DevJobParams = z.object({ id: z.string().uuid() });

export const DevCategoriesResponse = z.object({
  categories: z.array(z.object({ slug: z.string(), name: z.string() })),
});

export const DevMeResponse = z.object({
  merchantId: z.string().uuid(),
  companyName: z.string(),
  credits: z.number().int(),
});

export const ApiKeyCreateBody = z.object({
  label: z.string().min(1).max(64),
});

// `key` is present ONLY here — the one and only time the plaintext is returned.
export const ApiKeyCreateResponse = z.object({
  id: z.string().uuid(),
  label: z.string(),
  key: z.string(),
  keyPrefix: z.string(),
  createdAt: z.string(),
});

export const ApiKeyListResponse = z.object({
  keys: z.array(
    z.object({
      id: z.string().uuid(),
      label: z.string(),
      keyPrefix: z.string(),
      lastUsedAt: z.string().nullable(),
      createdAt: z.string(),
    }),
  ),
});
```

- [ ] **Step 2: Re-export**

In `packages/types/src/index.ts`, add:

```ts
export * from './dev.js';
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @tryme/types typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/types/src/dev.ts packages/types/src/index.ts
git commit -m "feat(types): add dev API zod contract"
```

---

### Task 6: Test helper — merchant + key factory

**Files:**
- Create: `apps/api/test/helpers/merchant.ts`

**Interfaces:**
- Consumes: `generateApiKey` (Task 2), `schema.apiKeys` (Task 1).
- Produces:
  - `createTestMerchant(app, opts?): Promise<{ merchantId, userId, credits(n): Promise<void> }>`
  - `createTestApiKey(app, merchantId, opts?): Promise<{ id, key }>`
  - `createTestTryonCategory(app, opts): Promise<{ categoryId, workflowTemplateId }>`

Every later task depends on this, so it lands before the routes.

`workflow_templates` has six NOT NULL columns with no default (`slug`, `label`, `jsonContent`,
`poseNodeId`, `upperNodeIds`, `garmentPhasePromptNode`), so a bare insert fails. The factory exists so
that shape lives in exactly one place instead of being copy-pasted into every test file — see
`apps/api/test/shopify-me.test.ts:112` for the established insert shape.

- [ ] **Step 1: Write the helper**

Create `apps/api/test/helpers/merchant.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { generateApiKey } from '../../src/modules/dev/keys.js';
import type { TestApp } from './api.js';

export async function createTestMerchant(
  app: TestApp,
  opts: { isActive?: boolean; balance?: number } = {},
) {
  const [user] = await app.db
    .insert(schema.users)
    .values({
      email: `merchant-${randomUUID()}@test.com`,
      displayName: 'Test Merchant',
      emailVerified: true,
    })
    .returning();
  if (!user) throw new Error('failed to create test user');

  const [merchant] = await app.db
    .insert(schema.merchants)
    .values({
      companyName: 'Test Co',
      contactName: 'Test Person',
      phone: '0000000000',
      businessAddress: 'Test Address',
      isActive: opts.isActive ?? true,
      userId: user.id,
    })
    .returning();
  if (!merchant) throw new Error('failed to create test merchant');

  await app.db
    .insert(schema.userCredits)
    .values({ userId: user.id, balance: opts.balance ?? 100 });

  return {
    merchantId: merchant.id,
    userId: user.id,
    async credits(n: number) {
      await app.db
        .update(schema.userCredits)
        .set({ balance: n })
        .where(eq(schema.userCredits.userId, user.id));
    },
  };
}

export async function createTestApiKey(
  app: TestApp,
  merchantId: string,
  opts: { revoked?: boolean; label?: string } = {},
) {
  const { key, keyHash, keyPrefix } = generateApiKey();
  const [row] = await app.db
    .insert(schema.apiKeys)
    .values({
      merchantId,
      label: opts.label ?? 'test',
      keyHash,
      keyPrefix,
      revokedAt: opts.revoked ? new Date() : null,
    })
    .returning();
  if (!row) throw new Error('failed to create test api key');
  return { id: row.id, key };
}

/**
 * Creates a tryon category plus the workflow template it points at.
 *
 * workflow_templates has six NOT NULL columns with no default — slug, label,
 * jsonContent, poseNodeId, upperNodeIds, garmentPhasePromptNode — so the filler
 * values below are mandatory, not decorative. Shape follows the existing inserts
 * in apps/api/test/shopify-me.test.ts:112.
 */
export async function createTestTryonCategory(
  app: TestApp,
  opts: {
    slug: string;
    name?: string;
    isActive?: boolean;
    templateIsActive?: boolean;
    sortOrder?: number;
  },
) {
  const [wf] = await app.db
    .insert(schema.workflowTemplates)
    .values({
      slug: `wf-${randomUUID()}`,
      label: 'Test Tryon WF',
      jsonContent: {},
      poseNodeId: 'x',
      upperNodeIds: [],
      garmentPhasePromptNode: 'x',
      workflowType: 'tryon',
      isActive: opts.templateIsActive ?? true,
    })
    .returning();
  if (!wf) throw new Error('failed to create test workflow template');

  const [cat] = await app.db
    .insert(schema.tryonCategories)
    .values({
      name: opts.name ?? 'Test Category',
      slug: opts.slug,
      workflowTemplateId: wf.id,
      isActive: opts.isActive ?? true,
      sortOrder: opts.sortOrder ?? 0,
    })
    .returning();
  if (!cat) throw new Error('failed to create test tryon category');

  return { categoryId: cat.id, workflowTemplateId: wf.id };
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @tryme/api typecheck`
Expected: PASS. If a NOT NULL column is still missing, read `packages/db/src/schema/models.ts:96` and add it — do not relax the schema.

- [ ] **Step 3: Commit**

```bash
git add apps/api/test/helpers/merchant.ts
git commit -m "test(api): add merchant and api key test factories"
```

---

### Task 7: Auth plugin — `app.requireApiKey`

**Files:**
- Create: `apps/api/src/plugins/dev-api-auth.ts`
- Modify: `apps/api/src/server.ts`
- Test: `apps/api/test/dev-api-auth.test.ts`

**Interfaces:**
- Consumes: `API_KEY_RE`, `extractBearer`, `hashApiKey` (Task 2); `schema.apiKeys` (Task 1); `createTestMerchant`, `createTestApiKey` (Task 6).
- Produces: `app.requireApiKey` preHandler; decorates `req.apiKeyId`, `req.merchantId`, `req.merchantUserId`.

The test needs a route to hit, so it registers a throwaway route on the test app — the plugin's contract is testable before any real route exists.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/dev-api-auth.test.ts`:

```ts
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from './helpers/api.js';
import { type Containers, startContainers } from './helpers/containers.js';
import { createTestApiKey, createTestMerchant } from './helpers/merchant.js';

let c: Containers;
let app: TestApp;
let base: string;
let activeKey: string;
let merchantId: string;

beforeAll(async () => {
  c = await startContainers();
  app = await buildTestApp(c);
  app.get('/test/whoami', { preHandler: app.requireApiKey }, async (req) => ({
    apiKeyId: req.apiKeyId,
    merchantId: req.merchantId,
    merchantUserId: req.merchantUserId,
  }));
  await app.ready();
  const addr = app.server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

  const m = await createTestMerchant(app);
  merchantId = m.merchantId;
  ({ key: activeKey } = await createTestApiKey(app, merchantId));
});

afterAll(async () => {
  await app.close();
  await c.stop();
});

const call = (headers: Record<string, string> = {}) =>
  fetch(`${base}/test/whoami`, { headers });

describe('requireApiKey', () => {
  it('accepts a valid key and decorates the request', async () => {
    const res = await call({ authorization: `Bearer ${activeKey}` });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.merchantId).toBe(merchantId);
    expect(body.apiKeyId).toBeTruthy();
    expect(body.merchantUserId).toBeTruthy();
  });

  it('rejects a missing header with 401', async () => {
    expect((await call()).status).toBe(401);
  });

  it('rejects a non-bearer header with 401', async () => {
    expect((await call({ authorization: 'Basic abc' })).status).toBe(401);
  });

  // Regression: a malformed key must be rejected by the format guard BEFORE it
  // reaches Postgres. Without the guard this is an unhandled 500, not a 401.
  it('rejects a malformed key with 401, not 500', async () => {
    for (const bad of ["sk_live_'; DROP TABLE api_keys;--", 'sk_live_short', 'garbage']) {
      const res = await call({ authorization: `Bearer ${bad}` });
      expect(res.status).toBe(401);
    }
  });

  it('rejects a well-formed but unknown key with 401', async () => {
    const res = await call({ authorization: `Bearer sk_live_${'a'.repeat(43)}` });
    expect(res.status).toBe(401);
  });

  it('rejects a revoked key with 401', async () => {
    const { key } = await createTestApiKey(app, merchantId, { revoked: true });
    const res = await call({ authorization: `Bearer ${key}` });
    expect(res.status).toBe(401);
  });

  it('rejects a key whose merchant is inactive with 401', async () => {
    const m = await createTestMerchant(app, { isActive: false });
    const { key } = await createTestApiKey(app, m.merchantId);
    const res = await call({ authorization: `Bearer ${key}` });
    expect(res.status).toBe(401);
  });

  it('records lastUsedAt on first use', async () => {
    const m = await createTestMerchant(app);
    const { id, key } = await createTestApiKey(app, m.merchantId);
    await call({ authorization: `Bearer ${key}` });
    await new Promise((r) => setTimeout(r, 200));
    const [row] = await app.db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, id));
    expect(row?.lastUsedAt).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- dev-api-auth`
Expected: FAIL — `app.requireApiKey is not a function`.

- [ ] **Step 3: Write the plugin**

Create `apps/api/src/plugins/dev-api-auth.ts`:

```ts
import { schema } from '@tryme/db';
import { and, eq } from 'drizzle-orm';
import fp from 'fastify-plugin';
import { AppError } from '../lib/errors.js';
import { API_KEY_RE, extractBearer, hashApiKey } from '../modules/dev/keys.js';

export const devApiAuthPlugin = fp(async (app) => {
  app.decorate('requireApiKey', async (req, _reply) => {
    const key = extractBearer(req.headers.authorization);
    if (!key) throw new AppError('UNAUTHORIZED', 401, 'Missing Authorization: Bearer <api key>');

    // Format guard BEFORE the DB round trip. Same reasoning as the UUID guard in
    // shopify-widget-auth.ts: a malformed value must not reach Postgres, where it
    // would surface as an unhandled error (500) instead of the intended 401. It
    // also keeps junk traffic off the database entirely.
    if (!API_KEY_RE.test(key)) throw new AppError('UNAUTHORIZED', 401, 'Invalid API key');

    // Lookup is by hash on a unique index — an index probe, not a string compare,
    // so there is no timing oracle on the key material.
    const [row] = await app.db
      .select({
        id: schema.apiKeys.id,
        revokedAt: schema.apiKeys.revokedAt,
        merchantId: schema.merchants.id,
        merchantIsActive: schema.merchants.isActive,
        merchantUserId: schema.merchants.userId,
      })
      .from(schema.apiKeys)
      .innerJoin(schema.merchants, eq(schema.merchants.id, schema.apiKeys.merchantId))
      .where(eq(schema.apiKeys.keyHash, hashApiKey(key)))
      .limit(1);

    // One opaque message for every failure mode — never reveal whether a key
    // exists, is revoked, or belongs to a deactivated merchant.
    if (!row || row.revokedAt || !row.merchantIsActive) {
      throw new AppError('UNAUTHORIZED', 401, 'Invalid API key');
    }

    req.apiKeyId = row.id;
    req.merchantId = row.merchantId;
    req.merchantUserId = row.merchantUserId;

    // lastUsedAt is dashboard telemetry, not a security control: throttle to ~1
    // write/min/key so a busy key does not add a write to every request, and never
    // let a failure here break the request.
    void (async () => {
      try {
        const ok = await app.redis.set(`apikey:lastused:${row.id}`, '1', 'EX', 60, 'NX');
        if (ok === 'OK') {
          await app.db
            .update(schema.apiKeys)
            .set({ lastUsedAt: new Date() })
            .where(and(eq(schema.apiKeys.id, row.id)));
        }
      } catch (err) {
        app.log.warn({ err, apiKeyId: row.id }, 'failed to record api key lastUsedAt');
      }
    })();
  });
});

declare module 'fastify' {
  interface FastifyRequest {
    apiKeyId?: string;
    merchantId?: string;
    merchantUserId?: string;
  }
  interface FastifyInstance {
    requireApiKey: (req: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}
```

- [ ] **Step 4: Register the plugin**

In `apps/api/src/server.ts`, add the import beside the other plugin imports:

```ts
import { devApiAuthPlugin } from './plugins/dev-api-auth.js';
```

And register it immediately after `shopifyWidgetAuthPlugin` (~line 147):

```ts
  await app.register(devApiAuthPlugin);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @tryme/api test -- dev-api-auth`
Expected: PASS, all cases. Confirm the malformed-key case returns 401 and not 500.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/plugins/dev-api-auth.ts apps/api/src/server.ts apps/api/test/dev-api-auth.test.ts
git commit -m "feat(api): add API key auth plugin"
```

---

### Task 8: `createDevTryonJob` — the transactional core

**Files:**
- Create: `apps/api/src/modules/dev/create-job.ts`

**Interfaces:**
- Consumes: `schema.tryonCategories`, `schema.workflowTemplates`, `atomicDeduct`, `refund`, `getTryonCreditCost`.
- Produces: `createDevTryonJob(app, params: { merchantId, merchantUserId, apiKeyId, categorySlug, personKey, garmentKey }): Promise<{ jobId: string }>`

This has no test of its own — it is exercised through the route in Task 9, where the HTTP contract and credit side effects are asserted together. Splitting them would test the same transaction twice.

- [ ] **Step 1: Write the implementation**

Create `apps/api/src/modules/dev/create-job.ts`:

```ts
import { randomUUID } from 'node:crypto';
import type { DB } from '@tryme/db';
import { schema } from '@tryme/db';
import { jobsCreatedTotal } from '@tryme/observability';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { AppError } from '../../lib/errors.js';
import { getTryonCreditCost } from '../../lib/resolution-config.js';
import { atomicDeduct, refund } from '../credits/ledger.js';

/**
 * Creates a developer-API try-on job from a raw person image + raw garment image
 * + category slug.
 *
 * Deliberately NOT part of jobs/create.ts::createSimpleTryonJob. That function
 * requires the garment to be a prior COMPLETED job of the caller (sourceJobId)
 * and resolves the workflow through a garment-type → tryon-category chain. A
 * third-party developer has neither, so this resolves the workflow straight off
 * tryon_categories.slug. Same reasoning merchant/create-job.ts documents at its top.
 *
 * The job row is userId-owned (the merchant's user) so the dispatcher's existing
 * transactional refund-on-terminal-failure path applies with no changes.
 */
export async function createDevTryonJob(
  app: FastifyInstance,
  params: {
    merchantId: string;
    merchantUserId: string;
    apiKeyId: string;
    categorySlug: string;
    personKey: string;
    garmentKey: string;
  },
): Promise<{ jobId: string }> {
  const cost = await getTryonCreditCost(app);

  // Kill-switch parity with createSimpleTryonJob: a category an admin deactivated,
  // or one whose workflow template is inactive, must not resolve. This runs before
  // any credit movement, so a rejected request is always free.
  const [category] = await app.db
    .select({
      workflowTemplateId: schema.tryonCategories.workflowTemplateId,
      templateIsActive: schema.workflowTemplates.isActive,
    })
    .from(schema.tryonCategories)
    .leftJoin(
      schema.workflowTemplates,
      eq(schema.workflowTemplates.id, schema.tryonCategories.workflowTemplateId),
    )
    .where(
      and(
        eq(schema.tryonCategories.slug, params.categorySlug),
        eq(schema.tryonCategories.isActive, true),
      ),
    )
    .limit(1);

  if (!category) throw new AppError('BAD_CATEGORY', 400, 'unknown or inactive category');
  if (!category.workflowTemplateId || !category.templateIsActive) {
    throw new AppError('BAD_CATEGORY', 400, 'category has no active workflow configured');
  }

  const [user] = await app.db
    .select({ isBanned: schema.users.isBanned })
    .from(schema.users)
    .where(eq(schema.users.id, params.merchantUserId))
    .limit(1);
  if (!user || user.isBanned) throw new AppError('FORBIDDEN', 403, 'account suspended');

  const catalogueId = randomUUID();
  const [job] = await app.db.transaction(async (tx) => {
    const [newJob] = await tx
      .insert(schema.jobs)
      .values({
        userId: params.merchantUserId,
        merchantId: params.merchantId,
        apiKeyId: params.apiKeyId,
        catalogueId,
        status: 'QUEUED',
        priority: false,
        queueStream: 'normal',
        watermark: false,
        creditsCharged: cost,
        source: 'api',
      })
      .returning();
    if (!newJob) throw new AppError('INTERNAL', 500, 'failed to create job');

    await atomicDeduct(tx as unknown as DB, params.merchantUserId, cost, newJob.id);

    // No faceId/backgroundId/poseId: that absence, plus params.personKey, is
    // exactly what routes this job to the tryon path in the dispatcher
    // (apps/dispatcher/src/job/processor.ts:134). Do not add those fields here.
    await tx.insert(schema.jobInputs).values({
      jobId: newJob.id,
      upperGarmentKey: params.garmentKey,
      params: { personKey: params.personKey, workflowTemplateId: category.workflowTemplateId },
    });
    return [newJob];
  });
  if (!job) throw new AppError('INTERNAL', 500, 'failed to create job');

  try {
    await app.redis.xadd(
      'jobs:normal',
      'MAXLEN',
      '~',
      10000,
      '*',
      'jobId',
      job.id,
      'userId',
      params.merchantUserId,
    );
    jobsCreatedTotal.inc({ priority: 'normal', kind: 'tryon' });
  } catch (err) {
    app.log.error({ err, jobId: job.id }, 'redis xadd failed — dev tryon job will be refunded');
    await refund(app.db, params.merchantUserId, cost, job.id, 'REFUND_ENQUEUE_FAIL');
    await app.db
      .update(schema.jobs)
      .set({ status: 'FAILED', errorCode: 'ENQUEUE_FAIL' })
      .where(eq(schema.jobs.id, job.id));
    throw new AppError('ENQUEUE_FAIL', 503, 'queue unavailable');
  }

  return { jobId: job.id };
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @tryme/api typecheck`
Expected: PASS. If `refund`'s exported signature differs, read `apps/api/src/modules/credits/ledger.ts` and match it — do not change `ledger.ts`.

- [ ] **Step 3: Commit**

```bash
git add apps/api/src/modules/dev/create-job.ts
git commit -m "feat(api): add dev tryon job creation"
```

---

### Task 9: `POST /v1/dev/tryon`

**Files:**
- Create: `apps/api/src/modules/dev/routes.ts`
- Modify: `apps/api/src/server.ts`
- Test: `apps/api/test/dev-tryon-create.test.ts`

**Interfaces:**
- Consumes: `createDevTryonJob` (Task 8), `sniffImageMime` (Task 3), `keys.devUpload` (Task 4), `app.requireApiKey` (Task 7), `hashApiKey` (Task 2).
- Produces: `devRoutes` Fastify plugin; `POST /v1/dev/tryon` → `202 { jobId, status }`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/dev-tryon-create.test.ts`:

```ts
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from './helpers/api.js';
import { type Containers, startContainers } from './helpers/containers.js';
import { createTestApiKey, createTestMerchant, createTestTryonCategory } from './helpers/merchant.js';

let c: Containers;
let app: TestApp;
let base: string;
let key: string;
let merchantId: string;
let userId: string;
let setCredits: (n: number) => Promise<void>;

const jpegBytes = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);

function form(opts: { category?: string; person?: Buffer; garment?: Buffer; personType?: string } = {}) {
  const fd = new FormData();
  fd.set('category', opts.category ?? 'upper');
  fd.set(
    'person',
    new Blob([opts.person ?? jpegBytes()], { type: opts.personType ?? 'image/jpeg' }),
    'person.jpg',
  );
  fd.set('garment', new Blob([opts.garment ?? jpegBytes()], { type: 'image/jpeg' }), 'garment.jpg');
  return fd;
}

const post = (fd: FormData, token = key) =>
  fetch(`${base}/v1/dev/tryon`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: fd,
  });

beforeAll(async () => {
  c = await startContainers();
  app = await buildTestApp(c);
  await app.ready();
  const addr = app.server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

  const m = await createTestMerchant(app, { balance: 100 });
  merchantId = m.merchantId;
  userId = m.userId;
  setCredits = m.credits;
  ({ key } = await createTestApiKey(app, merchantId));

  await createTestTryonCategory(app, { slug: 'upper', name: 'Upper' });
  await createTestTryonCategory(app, { slug: 'inactive-cat', name: 'Off', isActive: false });
  await createTestTryonCategory(app, {
    slug: 'dead-workflow',
    name: 'Dead WF',
    templateIsActive: false,
  });
});

afterAll(async () => {
  await app.close();
  await c.stop();
});

const balance = async () => {
  const [row] = await app.db
    .select()
    .from(schema.userCredits)
    .where(eq(schema.userCredits.userId, userId));
  return row?.balance ?? 0;
};

describe('POST /v1/dev/tryon', () => {
  it('creates a queued job, deducts credits, and writes the tryon job shape', async () => {
    const before = await balance();
    const res = await post(form());
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.status).toBe('QUEUED');

    const [job] = await app.db.select().from(schema.jobs).where(eq(schema.jobs.id, body.jobId));
    expect(job?.source).toBe('api');
    expect(job?.merchantId).toBe(merchantId);
    expect(job?.apiKeyId).toBeTruthy();
    expect(await balance()).toBe(before - job!.creditsCharged);

    const [inputs] = await app.db
      .select()
      .from(schema.jobInputs)
      .where(eq(schema.jobInputs.jobId, body.jobId));
    const params = inputs!.params as Record<string, unknown>;
    expect(params.personKey).toBeTruthy();
    expect(params.workflowTemplateId).toBeTruthy();
    expect(inputs!.upperGarmentKey).toBeTruthy();
    // The absence of these is what routes the job to the dispatcher's tryon path.
    expect(inputs!.faceId).toBeNull();
    expect(inputs!.backgroundId).toBeNull();
    expect(inputs!.poseId).toBeNull();
  });

  it('enqueues the job on jobs:normal', async () => {
    const res = await post(form());
    const { jobId } = await res.json();
    const entries = await app.redis.xrange('jobs:normal', '-', '+');
    const ids = entries.flatMap(([, fields]) => {
      const i = fields.indexOf('jobId');
      return i >= 0 ? [fields[i + 1]] : [];
    });
    expect(ids).toContain(jobId);
  });

  it('rejects an unauthenticated request with 401', async () => {
    const res = await fetch(`${base}/v1/dev/tryon`, { method: 'POST', body: form() });
    expect(res.status).toBe(401);
  });

  it('rejects an inactive category with 400 and does not move credits', async () => {
    const before = await balance();
    const res = await post(form({ category: 'inactive-cat' }));
    expect(res.status).toBe(400);
    expect(await balance()).toBe(before);
  });

  it('rejects an unknown category with 400 and does not move credits', async () => {
    const before = await balance();
    const res = await post(form({ category: 'nope' }));
    expect(res.status).toBe(400);
    expect(await balance()).toBe(before);
  });

  // Kill-switch parity: deactivating the workflow template must disable the
  // category even though the category row itself is still active.
  it('rejects a category whose workflow template is inactive, without moving credits', async () => {
    const before = await balance();
    const res = await post(form({ category: 'dead-workflow' }));
    expect(res.status).toBe(400);
    expect(await balance()).toBe(before);
  });

  // Security regression: the declared Content-Type is attacker-controlled, so a
  // shell script announced as image/jpeg must still be rejected on its bytes.
  it('rejects a non-image disguised with an image content-type', async () => {
    const before = await balance();
    const res = await post(
      form({ person: Buffer.from('#!/bin/sh\nrm -rf /', 'utf8'), personType: 'image/jpeg' }),
    );
    expect(res.status).toBe(400);
    expect(await balance()).toBe(before);
  });

  it('rejects a request missing the garment file with 400', async () => {
    const fd = new FormData();
    fd.set('category', 'upper');
    fd.set('person', new Blob([jpegBytes()], { type: 'image/jpeg' }), 'person.jpg');
    expect((await post(fd)).status).toBe(400);
  });

  it('returns 402 when the merchant has insufficient credits', async () => {
    await setCredits(0);
    const res = await post(form());
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error.code).toBe('INSUFFICIENT_CREDITS');
    await setCredits(100);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- dev-tryon-create`
Expected: FAIL — 404 on `/v1/dev/tryon`, route not registered.

- [ ] **Step 3: Write the route**

Create `apps/api/src/modules/dev/routes.ts`:

```ts
import { randomUUID } from 'node:crypto';
import { keys } from '@tryme/storage';
import type { FastifyInstance } from 'fastify';
import { AppError } from '../../lib/errors.js';
import { createDevTryonJob } from './create-job.js';
import { sniffImageMime } from './image-sniff.js';
import { hashApiKey } from './keys.js';

const MAX_FILE_BYTES = 10 * 1024 * 1024;
const EXT_BY_MIME = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
} as const;

// The per-key limiter runs at onRequest, BEFORE preHandler auth — so req.apiKeyId
// is not populated yet. Hashing the raw bearer gives a stable per-key bucket with
// no DB hit and without ever using the raw key as a Redis key. Unauthenticated
// junk falls back to per-IP.
const rateLimitConfig = {
  rateLimit: {
    max: 60,
    timeWindow: '1 minute',
    keyGenerator: (req: { headers: Record<string, unknown>; ip: string }) => {
      const h = req.headers.authorization;
      return typeof h === 'string' && h.startsWith('Bearer ') ? hashApiKey(h.slice(7)) : req.ip;
    },
  },
};

export async function devRoutes(app: FastifyInstance) {
  app.post(
    '/v1/dev/tryon',
    { preHandler: app.requireApiKey, config: rateLimitConfig },
    async (req, reply) => {
      const merchantId = req.merchantId as string;
      const merchantUserId = req.merchantUserId as string;
      const apiKeyId = req.apiKeyId as string;

      let categorySlug: string | undefined;
      const files: Record<string, { buf: Buffer; mime: string }> = {};

      // The global multipart limit is 2.5GB (server.ts) for the admin zip-import
      // route, so this route MUST set its own limits — it does not inherit a safe
      // default.
      const parts = req.parts({ limits: { fileSize: MAX_FILE_BYTES, files: 2 } });
      for await (const part of parts) {
        if (part.type === 'field' && part.fieldname === 'category') {
          categorySlug = String(part.value);
          continue;
        }
        if (part.type !== 'file') continue;
        if (part.fieldname !== 'person' && part.fieldname !== 'garment') {
          throw new AppError('VALIDATION', 400, `unexpected file field: ${part.fieldname}`);
        }
        const buf = await part.toBuffer().catch(() => {
          throw new AppError('VALIDATION', 400, `${part.fieldname} exceeds the 10MB limit`);
        });
        if (part.file.truncated) {
          throw new AppError('VALIDATION', 400, `${part.fieldname} exceeds the 10MB limit`);
        }
        // Magic bytes only — part.mimetype is client-declared and untrusted.
        const mime = sniffImageMime(buf);
        if (!mime) {
          throw new AppError(
            'VALIDATION',
            400,
            `${part.fieldname} must be a JPEG, PNG, or WebP image`,
          );
        }
        files[part.fieldname] = { buf, mime };
      }

      if (!categorySlug) throw new AppError('VALIDATION', 400, 'category is required');
      if (!files.person) throw new AppError('VALIDATION', 400, 'person image is required');
      if (!files.garment) throw new AppError('VALIDATION', 400, 'garment image is required');

      // Upload before the credit transaction: an orphaned R2 object on a later
      // failure is harmless, a charge for a job whose inputs are missing is not.
      const personKey = keys.devUpload(
        merchantId,
        randomUUID(),
        EXT_BY_MIME[files.person.mime as keyof typeof EXT_BY_MIME],
      );
      const garmentKey = keys.devUpload(
        merchantId,
        randomUUID(),
        EXT_BY_MIME[files.garment.mime as keyof typeof EXT_BY_MIME],
      );
      await Promise.all([
        app.storage.putObject(personKey, files.person.buf, files.person.mime),
        app.storage.putObject(garmentKey, files.garment.buf, files.garment.mime),
      ]);

      const { jobId } = await createDevTryonJob(app, {
        merchantId,
        merchantUserId,
        apiKeyId,
        categorySlug,
        personKey,
        garmentKey,
      });

      return reply.code(202).send({ jobId, status: 'QUEUED' });
    },
  );
}
```

- [ ] **Step 4: Register the routes**

In `apps/api/src/server.ts`, add the import beside the other route imports:

```ts
import { devRoutes } from './modules/dev/routes.js';
```

And register it after `merchantPaymentsRoutes` (~line 192):

```ts
  await app.register(devRoutes);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @tryme/api test -- dev-tryon-create`
Expected: PASS, all cases. The disguised-non-image and inactive-category cases must both show credits unchanged.

- [ ] **Step 6: Commit**

```bash
git add apps/api/src/modules/dev/routes.ts apps/api/src/server.ts apps/api/test/dev-tryon-create.test.ts
git commit -m "feat(api): add POST /v1/dev/tryon"
```

---

### Task 10: `GET /v1/dev/jobs/:id`, `/v1/dev/categories`, `/v1/dev/me`

**Files:**
- Modify: `apps/api/src/modules/dev/routes.ts`
- Test: `apps/api/test/dev-read-routes.test.ts`

**Interfaces:**
- Consumes: `app.requireApiKey`, `app.storage.presignGet`, `schema.jobs`, `schema.jobOutputs`, `schema.tryonCategories`, `schema.userCredits`.
- Produces: three GET routes.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/dev-read-routes.test.ts`:

```ts
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from './helpers/api.js';
import { type Containers, startContainers } from './helpers/containers.js';
import { createTestApiKey, createTestMerchant, createTestTryonCategory } from './helpers/merchant.js';

let c: Containers;
let app: TestApp;
let base: string;
let key: string;
let merchantId: string;
let userId: string;
let otherKey: string;

beforeAll(async () => {
  c = await startContainers();
  app = await buildTestApp(c);
  await app.ready();
  const addr = app.server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

  const m = await createTestMerchant(app, { balance: 42 });
  merchantId = m.merchantId;
  userId = m.userId;
  ({ key } = await createTestApiKey(app, merchantId));

  const other = await createTestMerchant(app);
  ({ key: otherKey } = await createTestApiKey(app, other.merchantId));

  await createTestTryonCategory(app, { slug: 'upper', name: 'Upper', sortOrder: 1 });
  await createTestTryonCategory(app, {
    slug: 'hidden',
    name: 'Hidden',
    isActive: false,
    sortOrder: 2,
  });
});

afterAll(async () => {
  await app.close();
  await c.stop();
});

const get = (path: string, token = key) =>
  fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });

async function makeJob(status: string, opts: { withOutput?: boolean; errorCode?: string } = {}) {
  const [job] = await app.db
    .insert(schema.jobs)
    .values({
      userId,
      merchantId,
      status,
      source: 'api',
      creditsCharged: 1,
      errorCode: opts.errorCode ?? null,
    })
    .returning();
  if (opts.withOutput) {
    await app.db
      .insert(schema.jobOutputs)
      .values({ jobId: job!.id, resultKey: `outputs/${job!.id}/result.png` });
  }
  return job!.id;
}

describe('GET /v1/dev/jobs/:id', () => {
  it('returns QUEUED with no imageUrl', async () => {
    const id = await makeJob('QUEUED');
    const body = await (await get(`/v1/dev/jobs/${id}`)).json();
    expect(body.status).toBe('QUEUED');
    expect(body.imageUrl).toBeUndefined();
  });

  it('returns COMPLETED with a presigned imageUrl', async () => {
    const id = await makeJob('COMPLETED', { withOutput: true });
    const body = await (await get(`/v1/dev/jobs/${id}`)).json();
    expect(body.status).toBe('COMPLETED');
    expect(body.imageUrl).toContain('http');
    // Presigned, not public — must carry a signature and expiry.
    expect(body.imageUrl).toContain('X-Amz-Signature');
  });

  it('returns FAILED with the error code', async () => {
    const id = await makeJob('FAILED', { errorCode: 'COMFY_TIMEOUT' });
    const body = await (await get(`/v1/dev/jobs/${id}`)).json();
    expect(body.status).toBe('FAILED');
    expect(body.error).toBe('COMFY_TIMEOUT');
  });

  // Security: cross-merchant reads must be indistinguishable from nonexistent
  // jobs, or job IDs become an enumeration oracle.
  it("returns 404 for another merchant's job", async () => {
    const id = await makeJob('COMPLETED', { withOutput: true });
    expect((await get(`/v1/dev/jobs/${id}`, otherKey)).status).toBe(404);
  });

  it('returns 404 for an unknown job', async () => {
    const res = await get('/v1/dev/jobs/00000000-0000-0000-0000-000000000000');
    expect(res.status).toBe(404);
  });

  it('returns 400 for a malformed id', async () => {
    expect((await get('/v1/dev/jobs/not-a-uuid')).status).toBe(400);
  });
});

describe('GET /v1/dev/categories', () => {
  it('returns only active categories', async () => {
    const body = await (await get('/v1/dev/categories')).json();
    const slugs = body.categories.map((x: { slug: string }) => x.slug);
    expect(slugs).toContain('upper');
    expect(slugs).not.toContain('hidden');
  });

  it('requires a key', async () => {
    expect((await fetch(`${base}/v1/dev/categories`)).status).toBe(401);
  });
});

describe('GET /v1/dev/me', () => {
  it('returns merchant identity and balance', async () => {
    const body = await (await get('/v1/dev/me')).json();
    expect(body.merchantId).toBe(merchantId);
    expect(body.companyName).toBe('Test Co');
    expect(body.credits).toBe(42);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- dev-read-routes`
Expected: FAIL — 404 on all three routes.

- [ ] **Step 3: Add the routes**

Append inside `devRoutes` in `apps/api/src/modules/dev/routes.ts`. Add these imports at the top of the file:

```ts
import { schema } from '@tryme/db';
import { DevJobParams } from '@tryme/types';
import { and, asc, eq } from 'drizzle-orm';
```

Then, inside `devRoutes`:

```ts
  app.get(
    '/v1/dev/jobs/:id',
    { preHandler: app.requireApiKey, config: rateLimitConfig, schema: { params: DevJobParams } },
    async (req) => {
      const { id } = req.params as { id: string };
      const [job] = await app.db
        .select({
          id: schema.jobs.id,
          status: schema.jobs.status,
          errorCode: schema.jobs.errorCode,
          merchantId: schema.jobs.merchantId,
          // NOTE: the column is `result_key` / resultKey — job_outputs has no r2Key.
          outputKey: schema.jobOutputs.resultKey,
        })
        .from(schema.jobs)
        .leftJoin(schema.jobOutputs, eq(schema.jobOutputs.jobId, schema.jobs.id))
        .where(and(eq(schema.jobs.id, id), eq(schema.jobs.source, 'api')))
        .limit(1);

      // Scoped by merchant, not by key: a merchant that rotates keys must still be
      // able to read its older jobs. 404 (not 403) on someone else's job so job IDs
      // are not enumerable.
      if (!job || job.merchantId !== req.merchantId) {
        throw new AppError('NOT_FOUND', 404, 'job not found');
      }

      if (job.status === 'COMPLETED' && job.outputKey) {
        // Presigned + short-lived: API results stay private to the owning merchant.
        const { url } = await app.storage.presignGet(job.outputKey, 900);
        return { jobId: job.id, status: job.status, imageUrl: url };
      }
      if (job.status === 'FAILED') {
        return { jobId: job.id, status: job.status, error: job.errorCode ?? 'JOB_FAILED' };
      }
      return { jobId: job.id, status: job.status };
    },
  );

  app.get(
    '/v1/dev/categories',
    { preHandler: app.requireApiKey, config: rateLimitConfig },
    async () => {
      const rows = await app.db
        .select({ slug: schema.tryonCategories.slug, name: schema.tryonCategories.name })
        .from(schema.tryonCategories)
        .where(eq(schema.tryonCategories.isActive, true))
        .orderBy(asc(schema.tryonCategories.sortOrder));
      return { categories: rows };
    },
  );

  app.get('/v1/dev/me', { preHandler: app.requireApiKey, config: rateLimitConfig }, async (req) => {
    const [row] = await app.db
      .select({
        merchantId: schema.merchants.id,
        companyName: schema.merchants.companyName,
        credits: schema.userCredits.balance,
      })
      .from(schema.merchants)
      .leftJoin(schema.userCredits, eq(schema.userCredits.userId, schema.merchants.userId))
      .where(eq(schema.merchants.id, req.merchantId as string))
      .limit(1);
    if (!row) throw new AppError('NOT_FOUND', 404, 'merchant not found');
    return { merchantId: row.merchantId, companyName: row.companyName, credits: row.credits ?? 0 };
  });
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @tryme/api test -- dev-read-routes`
Expected: PASS, all cases. If the presigned URL assertion fails, log the URL and match the actual signature parameter MinIO returns.

- [ ] **Step 5: Commit**

```bash
git add apps/api/src/modules/dev/routes.ts apps/api/test/dev-read-routes.test.ts
git commit -m "feat(api): add dev job polling, categories, and me routes"
```

---

### Task 11: Per-key rate limiting

**Files:**
- Test: `apps/api/test/dev-rate-limit.test.ts`

**Interfaces:**
- Consumes: `rateLimitConfig` (already wired to every route in Tasks 9-10).
- Produces: verified 429 behavior.

The config was written in Task 9. This task proves it actually buckets per key rather than per IP — the whole point, and the part most likely to be silently wrong, since every test request shares one IP.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/dev-rate-limit.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from './helpers/api.js';
import { type Containers, startContainers } from './helpers/containers.js';
import { createTestApiKey, createTestMerchant } from './helpers/merchant.js';

let c: Containers;
let app: TestApp;
let base: string;
let keyA: string;
let keyB: string;

beforeAll(async () => {
  c = await startContainers();
  app = await buildTestApp(c);
  await app.ready();
  const addr = app.server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

  const a = await createTestMerchant(app);
  const b = await createTestMerchant(app);
  ({ key: keyA } = await createTestApiKey(app, a.merchantId));
  ({ key: keyB } = await createTestApiKey(app, b.merchantId));
});

afterAll(async () => {
  await app.close();
  await c.stop();
});

const hit = (token: string) =>
  fetch(`${base}/v1/dev/categories`, { headers: { authorization: `Bearer ${token}` } });

describe('per-key rate limit', () => {
  it('allows up to 60 requests then returns 429 with Retry-After', async () => {
    let last: Response | undefined;
    for (let i = 0; i < 61; i++) last = await hit(keyA);
    expect(last?.status).toBe(429);
    expect(last?.headers.get('retry-after')).toBeTruthy();
    const body = await last!.json();
    expect(body.error.code).toBe('RATE_LIMIT');
  });

  // The limiter must bucket per key, not per IP — every test here shares one IP,
  // so an IP-keyed limiter would wrongly throttle key B after key A's burst.
  it('does not throttle a different key sharing the same IP', async () => {
    expect((await hit(keyB)).status).toBe(200);
  });
});
```

- [ ] **Step 2: Run the test**

Run: `pnpm --filter @tryme/api test -- dev-rate-limit`
Expected: PASS if the Task 9 config is correct.

If the second case fails with 429, the `keyGenerator` is not being applied — confirm it is under `config.rateLimit` on the route, and that `@fastify/rate-limit` is registered globally in `server.ts` (it is, ~line 124) so route-level config is honored.

If the first case never reaches 429, check that `allowList` in the global registration does not cover `/v1/dev/*` (it covers `/admin/*` and the payments webhook only).

- [ ] **Step 3: Commit**

```bash
git add apps/api/test/dev-rate-limit.test.ts
git commit -m "test(api): verify per-key rate limiting"
```

---

### Task 12: Merchant key management routes

**Files:**
- Create: `apps/api/src/modules/merchant/api-keys.routes.ts`
- Modify: `apps/api/src/server.ts`
- Test: `apps/api/test/merchant-api-keys.test.ts`

**Interfaces:**
- Consumes: `app.requireMerchant` (sets `req.merchantClientId`), `generateApiKey` (Task 2), `ApiKeyCreateBody` (Task 5).
- Produces: `merchantApiKeysRoutes`; `GET/POST /v1/merchant/api-keys`, `DELETE /v1/merchant/api-keys/:id`.

These are authed by the **merchant JWT**, never by an API key — a leaked key must not be able to mint more keys or inspect its siblings.

Note `requireMerchant` reads a `Bearer` access token and sets `req.merchantClientId` (**not** `req.merchantId`) — see `apps/api/src/plugins/portal-auth.ts:13`.

- [ ] **Step 1: Write the failing test**

Create `apps/api/test/merchant-api-keys.test.ts`:

```ts
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signAccess } from '../src/modules/auth/service.js';
import { buildTestApp, type TestApp } from './helpers/api.js';
import { type Containers, startContainers } from './helpers/containers.js';
import { createTestMerchant } from './helpers/merchant.js';

let c: Containers;
let app: TestApp;
let base: string;
let token: string;
let merchantId: string;

async function tokenFor(userId: string) {
  return signAccess(
    new TextEncoder().encode(app.env.JWT_SECRET),
    userId,
    { kind: 'access' },
    app.env.JWT_EXPIRY,
    'user',
  );
}

beforeAll(async () => {
  c = await startContainers();
  app = await buildTestApp(c);
  await app.ready();
  const addr = app.server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

  const m = await createTestMerchant(app);
  merchantId = m.merchantId;
  token = await tokenFor(m.userId);
});

afterAll(async () => {
  await app.close();
  await c.stop();
});

const call = (path: string, init: RequestInit = {}) =>
  fetch(`${base}${path}`, {
    ...init,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(init.headers ?? {}) },
  });

describe('POST /v1/merchant/api-keys', () => {
  it('creates a key and returns the plaintext exactly once', async () => {
    const res = await call('/v1/merchant/api-keys', {
      method: 'POST',
      body: JSON.stringify({ label: 'production' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.key).toMatch(/^sk_live_[A-Za-z0-9_-]{43}$/);
    expect(body.keyPrefix).toBe(body.key.slice(0, 12));

    // The plaintext must never be stored — only its hash.
    const [row] = await app.db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, body.id));
    expect(row?.keyHash).not.toBe(body.key);
    expect(row?.keyHash).toHaveLength(64);

    // ...and must never be retrievable again.
    const list = await (await call('/v1/merchant/api-keys')).json();
    expect(JSON.stringify(list)).not.toContain(body.key);
  });

  it('rejects an empty label with 400', async () => {
    const res = await call('/v1/merchant/api-keys', {
      method: 'POST',
      body: JSON.stringify({ label: '' }),
    });
    expect(res.status).toBe(400);
  });

  it('requires merchant auth', async () => {
    const res = await fetch(`${base}/v1/merchant/api-keys`, { method: 'POST' });
    expect(res.status).toBe(401);
  });
});

describe('GET /v1/merchant/api-keys', () => {
  it('lists only this merchant keys, without plaintext', async () => {
    const other = await createTestMerchant(app);
    const otherToken = await tokenFor(other.userId);
    await fetch(`${base}/v1/merchant/api-keys`, {
      method: 'POST',
      headers: { authorization: `Bearer ${otherToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'theirs' }),
    });

    const body = await (await call('/v1/merchant/api-keys')).json();
    for (const k of body.keys) {
      expect(k.label).not.toBe('theirs');
      expect(k).not.toHaveProperty('key');
      expect(k).not.toHaveProperty('keyHash');
    }
  });

  it('excludes revoked keys', async () => {
    const created = await (
      await call('/v1/merchant/api-keys', { method: 'POST', body: JSON.stringify({ label: 'temp' }) })
    ).json();
    await call(`/v1/merchant/api-keys/${created.id}`, { method: 'DELETE' });
    const body = await (await call('/v1/merchant/api-keys')).json();
    expect(body.keys.map((k: { id: string }) => k.id)).not.toContain(created.id);
  });
});

describe('DELETE /v1/merchant/api-keys/:id', () => {
  it('revokes a key so it stops authenticating', async () => {
    const created = await (
      await call('/v1/merchant/api-keys', { method: 'POST', body: JSON.stringify({ label: 'doomed' }) })
    ).json();

    const before = await fetch(`${base}/v1/dev/me`, {
      headers: { authorization: `Bearer ${created.key}` },
    });
    expect(before.status).toBe(200);

    expect((await call(`/v1/merchant/api-keys/${created.id}`, { method: 'DELETE' })).status).toBe(204);

    const after = await fetch(`${base}/v1/dev/me`, {
      headers: { authorization: `Bearer ${created.key}` },
    });
    expect(after.status).toBe(401);
  });

  // Security: revoking must be scoped to the caller's own keys.
  it("cannot revoke another merchant's key", async () => {
    const other = await createTestMerchant(app);
    const otherToken = await tokenFor(other.userId);
    const theirs = await (
      await fetch(`${base}/v1/merchant/api-keys`, {
        method: 'POST',
        headers: { authorization: `Bearer ${otherToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ label: 'theirs' }),
      })
    ).json();

    expect((await call(`/v1/merchant/api-keys/${theirs.id}`, { method: 'DELETE' })).status).toBe(404);

    const still = await fetch(`${base}/v1/dev/me`, {
      headers: { authorization: `Bearer ${theirs.key}` },
    });
    expect(still.status).toBe(200);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- merchant-api-keys`
Expected: FAIL — 404, routes not registered.

- [ ] **Step 3: Write the routes**

Create `apps/api/src/modules/merchant/api-keys.routes.ts`:

```ts
import { schema } from '@tryme/db';
import { ApiKeyCreateBody } from '@tryme/types';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { generateApiKey } from '../dev/keys.js';

const IdParams = z.object({ id: z.string().uuid() });

/**
 * Developer API key management. Authed by the merchant's session JWT
 * (requireMerchant), NEVER by an API key — a leaked key must not be able to mint
 * more keys or enumerate its siblings.
 */
export async function merchantApiKeysRoutes(app: FastifyInstance) {
  app.get('/v1/merchant/api-keys', { preHandler: app.requireMerchant }, async (req) => {
    const rows = await app.db
      .select({
        id: schema.apiKeys.id,
        label: schema.apiKeys.label,
        keyPrefix: schema.apiKeys.keyPrefix,
        lastUsedAt: schema.apiKeys.lastUsedAt,
        createdAt: schema.apiKeys.createdAt,
      })
      .from(schema.apiKeys)
      .where(
        and(
          eq(schema.apiKeys.merchantId, req.merchantClientId as string),
          isNull(schema.apiKeys.revokedAt),
        ),
      )
      .orderBy(desc(schema.apiKeys.createdAt));
    return {
      keys: rows.map((r) => ({
        ...r,
        lastUsedAt: r.lastUsedAt?.toISOString() ?? null,
        createdAt: r.createdAt.toISOString(),
      })),
    };
  });

  app.post(
    '/v1/merchant/api-keys',
    { preHandler: app.requireMerchant, schema: { body: ApiKeyCreateBody } },
    async (req, reply) => {
      const { label } = req.body as z.infer<typeof ApiKeyCreateBody>;
      const { key, keyHash, keyPrefix } = generateApiKey();
      const [row] = await app.db
        .insert(schema.apiKeys)
        .values({ merchantId: req.merchantClientId as string, label, keyHash, keyPrefix })
        .returning();
      if (!row) throw new AppError('INTERNAL', 500, 'failed to create key');

      // The ONLY place the plaintext key is ever returned. It is not stored and
      // cannot be recovered — the dashboard must tell the user so.
      return reply.code(201).send({
        id: row.id,
        label: row.label,
        key,
        keyPrefix: row.keyPrefix,
        createdAt: row.createdAt.toISOString(),
      });
    },
  );

  app.delete(
    '/v1/merchant/api-keys/:id',
    { preHandler: app.requireMerchant, schema: { params: IdParams } },
    async (req, reply) => {
      const { id } = req.params as z.infer<typeof IdParams>;
      // merchantId in the WHERE clause is the ownership check: another merchant's
      // key id simply matches nothing → 404.
      const revoked = await app.db
        .update(schema.apiKeys)
        .set({ revokedAt: new Date() })
        .where(
          and(
            eq(schema.apiKeys.id, id),
            eq(schema.apiKeys.merchantId, req.merchantClientId as string),
            isNull(schema.apiKeys.revokedAt),
          ),
        )
        .returning({ id: schema.apiKeys.id });
      if (!revoked.length) throw new AppError('NOT_FOUND', 404, 'key not found');
      return reply.code(204).send();
    },
  );
}
```

- [ ] **Step 4: Register the routes**

In `apps/api/src/server.ts`, add the import beside the other merchant route imports:

```ts
import { merchantApiKeysRoutes } from './modules/merchant/api-keys.routes.js';
```

And register it after `merchantPaymentsRoutes`:

```ts
  await app.register(merchantApiKeysRoutes);
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm --filter @tryme/api test -- merchant-api-keys`
Expected: PASS, all cases.

- [ ] **Step 6: Run the whole API suite for regressions**

Run: `pnpm --filter @tryme/api test`
Expected: PASS. The `jobs.apiKeyId` column and the new plugin must not disturb existing job tests.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/merchant/api-keys.routes.ts apps/api/src/server.ts apps/api/test/merchant-api-keys.test.ts
git commit -m "feat(api): add merchant API key management routes"
```

---

### Task 13: OpenAPI spec + reference UI

**Files:**
- Modify: `apps/api/package.json`
- Modify: `apps/api/src/server.ts`
- Modify: `apps/api/src/modules/dev/routes.ts`
- Test: `apps/api/test/dev-openapi.test.ts`

**Interfaces:**
- Consumes: the Zod route schemas from Tasks 9-10.
- Produces: `GET /v1/dev/openapi.json`, `GET /v1/dev/docs`.

The spec is derived from the route schemas, so it cannot drift. The test enforces that only `/v1/dev/*` is exposed — leaking `/admin/*` into a public spec would be an information disclosure.

- [ ] **Step 1: Add tags to the dev routes**

In `apps/api/src/modules/dev/routes.ts`, add `schema.tags` and response schemas so the generated spec is complete. For `POST /v1/dev/tryon`, change its options to:

```ts
    {
      preHandler: app.requireApiKey,
      config: rateLimitConfig,
      schema: {
        tags: ['dev'],
        summary: 'Create a try-on job',
        description:
          'Upload a person image and a garment image as multipart/form-data. Returns a job id to poll.',
        consumes: ['multipart/form-data'],
        response: { 202: DevTryonResponse },
      },
    },
```

For `GET /v1/dev/jobs/:id`:

```ts
    {
      preHandler: app.requireApiKey,
      config: rateLimitConfig,
      schema: {
        tags: ['dev'],
        summary: 'Get try-on job status and result',
        params: DevJobParams,
        response: { 200: DevJobResponse },
      },
    },
```

For `GET /v1/dev/categories`:

```ts
    {
      preHandler: app.requireApiKey,
      config: rateLimitConfig,
      schema: { tags: ['dev'], summary: 'List try-on categories', response: { 200: DevCategoriesResponse } },
    },
```

For `GET /v1/dev/me`:

```ts
    {
      preHandler: app.requireApiKey,
      config: rateLimitConfig,
      schema: { tags: ['dev'], summary: 'Get account info', response: { 200: DevMeResponse } },
    },
```

Extend the `@tryme/types` import:

```ts
import {
  DevCategoriesResponse,
  DevJobParams,
  DevJobResponse,
  DevMeResponse,
  DevTryonResponse,
} from '@tryme/types';
```

- [ ] **Step 2: Add the dependencies**

Run: `pnpm --filter @tryme/api add @fastify/swagger @scalar/fastify-api-reference`
Expected: both appear in `apps/api/package.json` dependencies. Do not hand-edit the lockfile.

- [ ] **Step 3: Write the failing test**

Create `apps/api/test/dev-openapi.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from './helpers/api.js';
import { type Containers, startContainers } from './helpers/containers.js';

let c: Containers;
let app: TestApp;
let base: string;

beforeAll(async () => {
  c = await startContainers();
  app = await buildTestApp(c);
  await app.ready();
  const addr = app.server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(async () => {
  await app.close();
  await c.stop();
});

describe('GET /v1/dev/openapi.json', () => {
  it('documents every dev endpoint', async () => {
    const res = await fetch(`${base}/v1/dev/openapi.json`);
    expect(res.status).toBe(200);
    const spec = await res.json();
    expect(Object.keys(spec.paths)).toEqual(
      expect.arrayContaining(['/v1/dev/tryon', '/v1/dev/jobs/{id}', '/v1/dev/categories', '/v1/dev/me']),
    );
  });

  // Information disclosure: the spec is public, so it must never describe the
  // admin, auth, or merchant surface.
  it('exposes no non-dev routes', async () => {
    const spec = await (await fetch(`${base}/v1/dev/openapi.json`)).json();
    for (const path of Object.keys(spec.paths)) {
      expect(path.startsWith('/v1/dev/')).toBe(true);
    }
  });

  it('declares bearer API key security', async () => {
    const spec = await (await fetch(`${base}/v1/dev/openapi.json`)).json();
    expect(spec.components.securitySchemes).toHaveProperty('apiKey');
  });
});

describe('GET /v1/dev/docs', () => {
  it('serves the reference UI', async () => {
    const res = await fetch(`${base}/v1/dev/docs`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });
});
```

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm --filter @tryme/api test -- dev-openapi`
Expected: FAIL — 404 on `/v1/dev/openapi.json`.

- [ ] **Step 5: Register swagger**

In `apps/api/src/server.ts`, add the imports:

```ts
import swagger from '@fastify/swagger';
import scalar from '@scalar/fastify-api-reference';
import { jsonSchemaTransform } from 'fastify-type-provider-zod';
```

Register **before** the route registrations (right after `await app.register(devApiAuthPlugin);`):

```ts
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Try-On API',
        description: 'Generate a virtual try-on image from a person image and a garment image.',
        version: '1.0.0',
      },
      components: {
        securitySchemes: {
          apiKey: { type: 'http', scheme: 'bearer', description: 'Your sk_live_… API key' },
        },
      },
      security: [{ apiKey: [] }],
    },
    // The spec is public, so it must describe ONLY the developer surface. Every
    // route without the 'dev' tag is hidden — admin/auth/merchant routes must never
    // appear here.
    transform: ({ schema: s, url }) => {
      const out = jsonSchemaTransform({ schema: s, url });
      if (!s?.tags?.includes('dev')) out.schema = { ...out.schema, hide: true };
      return out;
    },
  });
  await app.register(scalar, {
    routePrefix: '/v1/dev/docs',
    configuration: { url: '/v1/dev/openapi.json' },
  });
  app.get('/v1/dev/openapi.json', { schema: { hide: true } }, async () => app.swagger());
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm --filter @tryme/api test -- dev-openapi`
Expected: PASS. If the "exposes no non-dev routes" case fails, the `transform` is not hiding untagged routes — check the `hide` flag placement against the installed `@fastify/swagger` version's docs rather than loosening the test.

- [ ] **Step 7: Commit**

```bash
git add apps/api/package.json pnpm-lock.yaml apps/api/src/server.ts apps/api/src/modules/dev/routes.ts apps/api/test/dev-openapi.test.ts
git commit -m "feat(api): serve OpenAPI spec and reference UI for dev API"
```

---

### Task 14: Developer dashboard

**Files:**
- Create: `apps/catalogues-web/src/app/(app)/developers/page.tsx`
- Create: `apps/catalogues-web/src/app/(app)/developers/api.ts`
- Create: `apps/catalogues-web/src/app/(app)/developers/KeysPanel.tsx`
- Create: `apps/catalogues-web/src/app/(app)/developers/UsagePanel.tsx`

**Interfaces:**
- Consumes: `GET/POST/DELETE /v1/merchant/api-keys` (Task 12).
- Produces: the `/developers` dashboard route.

Read `apps/catalogues-web/src/app/(app)/catalogue-manager/api.ts` and `CatalogueManagerContent.tsx` first and **follow their patterns exactly** — the api-client wrapper, loading/error handling, and `C` token usage. Do not introduce a new data-fetching approach.

Hard rules: all colors come from `C` in `apps/catalogues-web/src/components/tokens.ts` — never raw hex. All paths must respect `NEXT_PUBLIC_BASE_PATH`.

- [ ] **Step 1: Read the existing patterns**

Run: `sed -n 1,60p apps/catalogues-web/src/app/\(app\)/catalogue-manager/api.ts`
Expected: shows the fetch wrapper and auth-token handling to mirror.

- [ ] **Step 2: Write the API client**

Create `apps/catalogues-web/src/app/(app)/developers/api.ts`, mirroring the import style and fetch wrapper of `catalogue-manager/api.ts`:

```ts
import { api } from '@/lib/api';

export interface ApiKey {
  id: string;
  label: string;
  keyPrefix: string;
  lastUsedAt: string | null;
  createdAt: string;
}

export interface CreatedApiKey extends ApiKey {
  key: string;
}

export async function listApiKeys(): Promise<{ keys: ApiKey[] }> {
  return api('/v1/merchant/api-keys');
}

export async function createApiKey(label: string): Promise<CreatedApiKey> {
  return api('/v1/merchant/api-keys', { method: 'POST', body: JSON.stringify({ label }) });
}

export async function revokeApiKey(id: string): Promise<void> {
  await api(`/v1/merchant/api-keys/${id}`, { method: 'DELETE' });
}
```

If `@/lib/api`'s exported helper has a different name or signature, match `catalogue-manager/api.ts` instead — that file is the authority.

- [ ] **Step 3: Write the keys panel**

Create `apps/catalogues-web/src/app/(app)/developers/KeysPanel.tsx`. Requirements — implement, don't approximate:

- Lists keys: `keyPrefix` + `…`, label, created date, last used (`Never` when null).
- "Create key" opens a label input; on submit calls `createApiKey`.
- On success shows the full key **once** in a copy-to-clipboard box with the exact text: **"Copy this key now — you will not be able to see it again."** The key must disappear from component state once dismissed.
- Each row has a Revoke action with a confirmation step, calling `revokeApiKey` then refetching.
- Surface real backend errors from the response body — never a generic "Something went wrong" toast.
- All colors from `C`.

- [ ] **Step 4: Write the usage panel**

Create `apps/catalogues-web/src/app/(app)/developers/UsagePanel.tsx` showing recent API jobs (status, category, credits, timestamp).

This needs a backing route that does not exist yet. Add to `apps/api/src/modules/merchant/api-keys.routes.ts`:

```ts
  app.get('/v1/merchant/api-usage', { preHandler: app.requireMerchant }, async (req) => {
    const rows = await app.db
      .select({
        jobId: schema.jobs.id,
        status: schema.jobs.status,
        creditsCharged: schema.jobs.creditsCharged,
        createdAt: schema.jobs.createdAt,
        keyLabel: schema.apiKeys.label,
        keyPrefix: schema.apiKeys.keyPrefix,
      })
      .from(schema.jobs)
      .innerJoin(schema.apiKeys, eq(schema.apiKeys.id, schema.jobs.apiKeyId))
      .where(
        and(
          eq(schema.jobs.merchantId, req.merchantClientId as string),
          eq(schema.jobs.source, 'api'),
        ),
      )
      .orderBy(desc(schema.jobs.createdAt))
      .limit(50);
    return { usage: rows };
  });
```

- [ ] **Step 5: Write the page**

Create `apps/catalogues-web/src/app/(app)/developers/page.tsx` composing both panels under a heading, plus a quickstart block showing a working curl:

```bash
curl -X POST https://<API_HOST>/v1/dev/tryon \
  -H "Authorization: Bearer sk_live_..." \
  -F person=@person.jpg \
  -F garment=@garment.jpg \
  -F category=upper
```

and a link to `/v1/dev/docs`.

- [ ] **Step 6: Verify it builds and renders**

Run: `pnpm --filter @tryme/web build`
Expected: build passes.

Then run the app (`pnpm --filter @tryme/web dev`), log in as a merchant, visit `/developers`, and confirm: create a key → full key shown once with the warning → reload → only the prefix is visible → revoke → the key disappears from the list.

- [ ] **Step 7: Commit**

```bash
git add apps/catalogues-web/src/app/\(app\)/developers apps/api/src/modules/merchant/api-keys.routes.ts
git commit -m "feat(web): add developer dashboard with API key management"
```

---

### Task 15: Quickstart documentation

**Files:**
- Create: `docs/dev-api-quickstart.md`
- Modify: `CLAUDE.md`
- Modify: `docs/progress.md`

**Interfaces:**
- Consumes: the finished API.
- Produces: developer-facing docs + updated repo docs.

- [ ] **Step 1: Write the quickstart**

Create `docs/dev-api-quickstart.md` covering, in order:

1. **Authentication** — `Authorization: Bearer sk_live_…`, where to get a key (`/developers`), shown once, treat as a secret, never ship in client-side code.
2. **The three-call flow** — `GET /v1/dev/categories` → `POST /v1/dev/tryon` → poll `GET /v1/dev/jobs/:id`.
3. **curl example** — the full flow, copy-pasteable.
4. **Node example** — `FormData` + `fetch`, with a poll loop that backs off and gives up.
5. **Errors** — table of `UNAUTHORIZED` (401), `VALIDATION` (400), `BAD_CATEGORY` (400), `INSUFFICIENT_CREDITS` (402), `NOT_FOUND` (404), `RATE_LIMIT` (429), `ENQUEUE_FAIL` (503).
6. **Limits** — 60 req/min per key; 10MB per image; JPEG/PNG/WebP only; result URLs expire in 15 minutes (re-poll to get a fresh one).
7. **Credits** — each job costs the admin-configured try-on cost; failed jobs are refunded automatically.

Every example must be one a developer can paste and run. No pseudocode.

- [ ] **Step 2: Update CLAUDE.md**

Add to the API Route Modules table:

```markdown
| `dev/` | `/v1/dev/tryon`, `/v1/dev/jobs/:id`, `/v1/dev/categories`, `/v1/dev/me` — public developer API, API-key authed |
```

Add to the Auth & Users schema table:

```markdown
| `api_keys` | Developer API keys per merchant — sha256 `keyHash`, display-only `keyPrefix`, revocable |
```

- [ ] **Step 3: Update progress.md**

Add a dated entry at the top of `docs/progress.md` with **Done**, **Failed / Not Done**, and **Open Questions / Decisions** sections. Record that webhooks and test-mode keys were deliberately deferred (see the spec's Deferred section).

- [ ] **Step 4: Full verification**

Run: `pnpm typecheck && pnpm lint && pnpm --filter @tryme/api test`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add docs/dev-api-quickstart.md CLAUDE.md docs/progress.md
git commit -m "docs: add developer API quickstart"
```

---

## Self-Review Notes

**Spec coverage:** `api_keys` + `jobs.apiKeyId` → T1. Key format/hashing → T2. Magic-byte sniff → T3. R2 key builder → T4. Zod contract → T5. Test factories → T6. Auth plugin (format guard, revoked, inactive merchant, `lastUsedAt` throttle) → T7. Transactional create with kill-switch parity → T8. `POST /v1/dev/tryon` with upload limits → T9. Poll + categories + me, presigned 15-min URLs, 404-not-403 → T10. Per-key rate limit → T11. Merchant key CRUD → T12. OpenAPI + Scalar → T13. Dashboard → T14. Quickstart + CLAUDE.md + progress → T15.

**Deviations from the spec, corrected here after reading the code:**
- The spec said uploads "stream to R2". `StorageProvider.putObject(key, body: Buffer, contentType)` takes a **Buffer**, so the plan buffers with an explicit per-route `fileSize` limit instead. The global multipart limit is 2.5GB, so a per-route limit is mandatory, not optional.
- The spec described the dashboard as cookie-authed. `requireMerchant` reads a **Bearer** access token and sets `req.merchantClientId` (not `req.merchantId`) — the plan uses the real name.
- The spec resolved job ownership via `apiKeyId → merchantId`. `jobs.merchantId` **already exists**, so ownership is a direct column check; `apiKeyId` is kept for per-key usage reporting only.
- The rate limiter keys off `sha256(bearer)` rather than `req.apiKeyId`: `@fastify/rate-limit` runs at `onRequest`, before the `preHandler` that populates `req.apiKeyId`.
- `sharp` is imported by `admin/models.routes.ts` but is **not** declared in `apps/api/package.json` (hoisted transitive dep). The plan therefore avoids depending on it and uses a dependency-free magic-byte sniff.

**Column-name errors caught during self-review (do not reintroduce):**
- `job_outputs` has **`resultKey`** (`result_key`), *not* `r2Key`. Task 10 and its test use `resultKey`.
- `workflow_templates` has **no `name` column** — it is `slug` + `label`, and six columns are NOT NULL with no default (`slug`, `label`, `jsonContent`, `poseNodeId`, `upperNodeIds`, `garmentPhasePromptNode`). A bare `{ name, jsonContent }` insert fails at runtime. `createTestTryonCategory` (Task 6) is the single place that shape lives.

**Deferred, per the spec:** webhooks, `sk_test_` keys, per-key configurable limits, separate merchant credit balance, key scopes, SDKs, image-URL input.
