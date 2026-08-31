# Custom Background Upload Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user upload a file or paste a URL to add their own private background image in the Studio wizard's "Create your own look" background step, saved to a personal library only they can see or use.

**Architecture:** Extend the existing `model_backgrounds` table with a nullable `userId` column and a new `scope='user'` value (reusing the pattern already used for `scope='template'`), instead of a new table. A new `apps/api/src/modules/backgrounds/routes.ts` module exposes list/presign/confirm/from-url/delete under `/v1/backgrounds/mine`, all scoped to the caller. `jobs/create.ts`'s background-ID validation gets a one-line ownership condition added. The Studio wizard gets a new "My backgrounds" section in its existing custom-mode background step. No dispatcher changes — it already resolves `backgroundId → r2Key` with no scope/owner filter.

**Tech Stack:** Fastify 5 + zod (`fastify-type-provider-zod`), Drizzle ORM / PostgreSQL, Redis (upload-ownership binding), R2/MinIO via `@tryme/storage`, `sharp` for thumbnailing, Node 20 native `fetch`, Next.js 15 + React Query on the frontend, Vitest for tests.

## Global Constraints

- pnpm workspaces; ESM only (`"type": "module"`); Node 20+, TypeScript 5.6.
- No `console.log` — use the existing `app.log` (pino) in API code.
- No new lockfiles; only `pnpm add` if a dependency is genuinely missing (none needed here — `sharp` is already a dependency of `@tryme/api`).
- Integration tests reuse the running `docker:up` Postgres/Redis/MinIO — no testcontainers.
- Design tokens (`C` from `tokens.ts`) for any new frontend styling — no raw hex colors.
- Full spec: `docs/superpowers/specs/2026-07-24-custom-background-upload-design.md`.

---

## Task 1: Schema — `userId` column + storage keys

**Files:**
- Modify: `packages/db/src/schema/models.ts:1-51` (add `users` import, convert `modelBackgrounds` to 3-arg `pgTable` with `userId` + partial index)
- Modify: `packages/storage/src/keys.ts` (add two key builders)
- Create: a new Drizzle migration (auto-named by `pnpm db:generate`, next index after `0120`)

**Interfaces:**
- Produces: `schema.modelBackgrounds.userId` (nullable uuid column), `keys.userBackground(userId, id): string`, `keys.userBackgroundThumb(userId, id): string` — used by Task 3 and Task 4.

- [ ] **Step 1: Add the `users` import and `userId` column to `modelBackgrounds`**

In `packages/db/src/schema/models.ts`, add the import right after the existing `catalog.js` import (line 13):

```typescript
import { catalogCategories, catalogItems } from './catalog.js';
import { users } from './users.js';
```

Then replace the entire `modelBackgrounds` definition (lines 31-51) with:

```typescript
// Global pool — no faceId FK
export const modelBackgrounds = pgTable(
  'model_backgrounds',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    label: text('label').notNull(),
    r2Key: text('r2_key').notNull(),
    thumbnailKey: text('thumbnail_key').notNull(),
    bgComfyR2Key: text('bg_comfy_r2_key'), // ComfyUI-specific background (moved from model_pose_assets)
    categoryId: integer('category_id').references(() => catalogCategories.id), // nullable — null means uncategorized (pre-existing backgrounds)
    tags: text('tags').array().notNull().default(sql`ARRAY[]::text[]`), // free-form entity tags, independent of category (e.g. "warm tone")
    specialTag: text('special_tag'), // 'featured' | 'trending' | 'popular' | null — per-asset, moved off category level
    genderSlug: text('gender_slug'), // nullable — null means shown for all genders
    // 'general' = visible in the admin Backgrounds tab and studio "create your own look";
    // 'template' = uploaded from within a catalogue template's looks builder, hidden from
    // both (managed only via the template that owns it);
    // 'user' = uploaded by a user into their own personal library (studio "create your own
    // look" -> "My backgrounds"), scoped by userId below, hidden from everyone else and from
    // the admin-curated pool. See scope column on modelPoseAssets.
    scope: text('scope').notNull().default('general'),
    // Only set when scope='user' — the owning user. ON DELETE CASCADE so a deleted user's
    // private backgrounds are cleaned up automatically.
    userId: uuid('user_id').references(() => users.id, { onDelete: 'cascade' }),
    isActive: boolean('is_active').notNull().default(true),
    isWhiteBg: boolean('is_white_bg').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    userIdIdx: index('model_backgrounds_user_id_idx')
      .on(table.userId)
      .where(sql`${table.userId} is not null`),
  }),
);
```

- [ ] **Step 2: Add storage key builders**

In `packages/storage/src/keys.ts`, add these two lines right after the existing `modelBackgroundComfy` line:

```typescript
  modelBackgroundComfy: (id: string) => `models/backgrounds/${id}.bgcomfy.jpg`,
  userBackground: (userId: string, id: string) => `user-backgrounds/${userId}/${id}.jpg`,
  userBackgroundThumb: (userId: string, id: string) => `user-backgrounds/${userId}/${id}.thumb.jpg`,
```

- [ ] **Step 3: Generate and inspect the migration**

Run:
```bash
pnpm db:generate
```

This produces a new file `packages/db/src/migrations/0121_<generated-name>.sql` (index may differ if another migration landed on `main` in the meantime — if so, follow the "Migration Index Conflicts" procedure in the root `CLAUDE.md`). Open the generated file and confirm it contains an `ALTER TABLE "model_backgrounds" ADD COLUMN "user_id" uuid;`, a `FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade`, and a partial `CREATE INDEX ... WHERE "user_id" IS NOT NULL`. It should **not** touch any other table.

- [ ] **Step 4: Apply the migration**

Run:
```bash
pnpm db:migrate
```
Expected: `Applied  0121_<name>` (or whatever index it got), `Done: 1 applied, 0 reconciled.`

- [ ] **Step 5: Verify the column exists**

```bash
docker exec tryme-postgres psql -U tryon -d tryon_dev -tAc "\d model_backgrounds" | grep user_id
```
Expected: a line showing `user_id|uuid`.

- [ ] **Step 6: Typecheck the db package**

```bash
pnpm --filter @tryme/db typecheck
```
Expected: exits 0, no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/db/src/schema/models.ts packages/storage/src/keys.ts packages/db/src/migrations/
git commit -m "feat(db): add user-scoped model_backgrounds rows for custom backgrounds"
```

---

## Task 2: SSRF guard + capped image fetch

**Files:**
- Create: `apps/api/src/lib/ssrf-guard.ts`
- Create: `apps/api/src/lib/ssrf-guard.test.ts`
- Create: `apps/api/src/lib/fetch-image.ts`

**Interfaces:**
- Consumes: `AppError` from `apps/api/src/lib/errors.ts` (`new AppError(code: string, statusCode: number, message: string)`).
- Produces: `assertPublicHttpUrl(input: string): Promise<URL>` and `fetchImageWithCap(url: URL, maxBytes: number, timeoutMs: number): Promise<Buffer>` — both consumed by Task 4's `from-url` route.

- [ ] **Step 1: Write the failing unit tests for the SSRF guard**

Create `apps/api/src/lib/ssrf-guard.test.ts`:

```typescript
import { describe, expect, it } from 'vitest';
import { assertPublicHttpUrl } from './ssrf-guard.js';

describe('assertPublicHttpUrl', () => {
  it('accepts a public IP literal', async () => {
    const url = await assertPublicHttpUrl('http://1.1.1.1/image.jpg');
    expect(url.hostname).toBe('1.1.1.1');
  });

  it('rejects loopback', async () => {
    await expect(assertPublicHttpUrl('http://127.0.0.1/x.jpg')).rejects.toThrow(/not allowed/);
  });

  it('rejects private 10.x', async () => {
    await expect(assertPublicHttpUrl('http://10.0.0.5/x.jpg')).rejects.toThrow(/not allowed/);
  });

  it('rejects private 192.168.x', async () => {
    await expect(assertPublicHttpUrl('http://192.168.1.1/x.jpg')).rejects.toThrow(/not allowed/);
  });

  it('rejects private 172.16-31.x', async () => {
    await expect(assertPublicHttpUrl('http://172.20.0.5/x.jpg')).rejects.toThrow(/not allowed/);
  });

  it('rejects link-local / cloud metadata address', async () => {
    await expect(assertPublicHttpUrl('http://169.254.169.254/x.jpg')).rejects.toThrow(
      /not allowed/,
    );
  });

  it('rejects IPv6 loopback', async () => {
    await expect(assertPublicHttpUrl('http://[::1]/x.jpg')).rejects.toThrow(/not allowed/);
  });

  it('rejects non-http(s) schemes', async () => {
    await expect(assertPublicHttpUrl('ftp://example.com/x.jpg')).rejects.toThrow(
      /only http\/https/,
    );
  });

  it('rejects a malformed URL', async () => {
    await expect(assertPublicHttpUrl('not a url')).rejects.toThrow(/not a valid URL/);
  });
});
```

- [ ] **Step 2: Run the tests to confirm they fail**

```bash
pnpm --filter @tryme/api test -- ssrf-guard
```
Expected: FAIL — `Cannot find module './ssrf-guard.js'` (file doesn't exist yet).

- [ ] **Step 3: Implement the SSRF guard**

Create `apps/api/src/lib/ssrf-guard.ts`:

```typescript
import dns from 'node:dns/promises';
import { isIP } from 'node:net';
import { AppError } from './errors.js';

const ALLOWED_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Blocks loopback, private, link-local, and other non-public ranges. Applied to
 * the actually-resolved IP (not just the hostname string) so a hostname that
 * resolves to a private address is still blocked.
 */
function isBlockedIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) {
    const parts = ip.split('.').map(Number);
    const a = parts[0];
    const b = parts[1];
    if (a === 127) return true; // loopback
    if (a === 10) return true; // private
    if (a === 172 && b >= 16 && b <= 31) return true; // private
    if (a === 192 && b === 168) return true; // private
    if (a === 169 && b === 254) return true; // link-local / cloud metadata
    if (a === 0) return true; // "this network"
    if (a >= 224) return true; // multicast/reserved
    return false;
  }
  if (family === 6) {
    const normalized = ip.toLowerCase();
    if (normalized === '::1') return true; // loopback
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true; // unique local fc00::/7
    if (
      normalized.startsWith('fe8') ||
      normalized.startsWith('fe9') ||
      normalized.startsWith('fea') ||
      normalized.startsWith('feb')
    ) {
      return true; // link-local fe80::/10
    }
    if (normalized === '::' || normalized.startsWith('::ffff:127.')) return true;
    return false;
  }
  return true; // not a recognizable IP — treat as blocked
}

/**
 * Validates a user-supplied URL is safe for the server to fetch: http(s) only,
 * and every DNS-resolved address for its hostname is a public address. Returns
 * the parsed URL for the caller to actually fetch.
 */
export async function assertPublicHttpUrl(input: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new AppError('VALIDATION', 400, 'not a valid URL');
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new AppError('VALIDATION', 400, 'only http/https URLs are supported');
  }
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '');
  const literalFamily = isIP(hostname);
  const addresses =
    literalFamily !== 0 ? [hostname] : (await dns.lookup(hostname, { all: true })).map((a) => a.address);
  if (addresses.length === 0) {
    throw new AppError('VALIDATION', 400, 'could not resolve host');
  }
  if (addresses.some((ip) => isBlockedIp(ip))) {
    throw new AppError('VALIDATION', 400, 'this URL host is not allowed');
  }
  return parsed;
}
```

- [ ] **Step 4: Run the tests to confirm they pass**

```bash
pnpm --filter @tryme/api test -- ssrf-guard
```
Expected: PASS, all 9 tests green.

- [ ] **Step 5: Implement the capped image fetch (no test yet — exercised by Task 4's integration tests)**

Create `apps/api/src/lib/fetch-image.ts`:

```typescript
import { AppError } from './errors.js';

const ALLOWED_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

/**
 * Fetches a URL with a hard byte cap enforced during the stream read (not just
 * from a possibly-absent/lying Content-Length header) and a request timeout.
 * Redirects are refused outright rather than followed, to avoid re-validating
 * a second host — from-url callers should pass the guard-checked URL from
 * assertPublicHttpUrl.
 */
export async function fetchImageWithCap(
  url: URL,
  maxBytes: number,
  timeoutMs: number,
): Promise<Buffer> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal, redirect: 'manual' });
    if (res.status >= 300 && res.status < 400) {
      throw new AppError('VALIDATION', 400, 'redirects are not supported for background URLs');
    }
    if (!res.ok) {
      throw new AppError('VALIDATION', 400, `failed to fetch image (status ${res.status})`);
    }
    const contentType = res.headers.get('content-type') ?? '';
    if (!ALLOWED_CONTENT_TYPES.some((t) => contentType.startsWith(t))) {
      throw new AppError('VALIDATION', 400, 'url did not return an image');
    }
    const contentLength = res.headers.get('content-length');
    if (contentLength && Number(contentLength) > maxBytes) {
      throw new AppError('VALIDATION', 413, 'image exceeds size limit');
    }
    if (!res.body) {
      throw new AppError('VALIDATION', 400, 'empty response body');
    }
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new AppError('VALIDATION', 413, 'image exceeds size limit');
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally {
    clearTimeout(timeout);
  }
}
```

- [ ] **Step 6: Typecheck**

```bash
pnpm --filter @tryme/api typecheck
```
Expected: exits 0.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/lib/ssrf-guard.ts apps/api/src/lib/ssrf-guard.test.ts apps/api/src/lib/fetch-image.ts
git commit -m "feat(api): add SSRF guard and capped image fetch for user-supplied URLs"
```

---

## Task 3: Backgrounds API — list, presign, confirm, delete

**Files:**
- Create: `packages/types/src/backgrounds.ts`
- Modify: `packages/types/src/index.ts` (add export)
- Create: `apps/api/src/modules/backgrounds/routes.ts`
- Modify: `apps/api/src/server.ts` (import + register)
- Create: `apps/api/test/integration/backgrounds-mine.test.ts`

**Interfaces:**
- Consumes: `schema.modelBackgrounds` + `userId` column from Task 1; `AppError` from `apps/api/src/lib/errors.ts`; `keys.userBackground`/`keys.userBackgroundThumb` from Task 1.
- Produces: route module `backgroundsRoutes(app: FastifyInstance)` exported from `apps/api/src/modules/backgrounds/routes.ts`, registered in `server.ts`. Response shape `{ id: string, label: string, thumbnailUrl: string }` for list/confirm items — Task 6 (frontend) consumes this exact shape. `from-url` (Task 4) reuses the same route file and the same response shape.

- [ ] **Step 1: Add request-body schemas**

Create `packages/types/src/backgrounds.ts`:

```typescript
import { z } from 'zod';
import { AssetContentType } from './admin.js';

export const PresignMyBackgroundBody = z.object({
  contentType: AssetContentType,
  contentLength: z
    .number()
    .int()
    .positive()
    .max(10 * 1024 * 1024),
});

export const ConfirmMyBackgroundBody = z.object({
  r2Key: z.string().min(1),
  label: z.string().min(1).max(120).optional(),
});

export const CreateMyBackgroundFromUrlBody = z.object({
  url: z.string().url(),
  label: z.string().min(1).max(120).optional(),
});
```

In `packages/types/src/index.ts`, add:
```typescript
export * from './backgrounds.js';
```
(insert alphabetically, right after `export * from './auth.js';` and before `export * from './catalog.js';`)

- [ ] **Step 2: Write the failing integration tests for list/presign/confirm/delete**

Create `apps/api/test/integration/backgrounds-mine.test.ts`:

```typescript
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from '../helpers/api';
import { type Containers, startContainers } from '../helpers/containers';

describe('/v1/backgrounds/mine', () => {
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

  async function getToken(email: string) {
    await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { displayName: 'BG User', email, password: 'password123' },
    });
    const [user] = await app.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, email));
    if (!user) throw new Error('user not found');
    await app.db
      .update(schema.users)
      .set({ emailVerified: true })
      .where(eq(schema.users.id, user.id));
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email, password: 'password123' },
    });
    return { token: login.json().accessToken as string, userId: user.id };
  }

  it('presign -> confirm creates a scope=user row visible only via /mine', async () => {
    const { token, userId } = await getToken('bgmine1@x.com');

    const presign = await app.inject({
      method: 'POST',
      url: '/v1/backgrounds/mine/presign',
      headers: { authorization: `Bearer ${token}` },
      payload: { contentType: 'image/jpeg', contentLength: 1024 },
    });
    expect(presign.statusCode).toBe(200);
    const { r2Key } = presign.json() as { r2Key: string };
    expect(r2Key).toBe(`user-backgrounds/${userId}/${r2Key.split('/')[1]}`);
    await app.storage.putObject(r2Key, Buffer.alloc(1024, 1), 'image/jpeg');

    const confirm = await app.inject({
      method: 'POST',
      url: '/v1/backgrounds/mine/confirm',
      headers: { authorization: `Bearer ${token}` },
      payload: { r2Key, label: 'Beach' },
    });
    expect(confirm.statusCode).toBe(200);
    const created = confirm.json();
    expect(created.id).toBeTruthy();
    expect(created.thumbnailUrl).toContain('http');

    const [row] = await app.db
      .select()
      .from(schema.modelBackgrounds)
      .where(eq(schema.modelBackgrounds.id, created.id));
    expect(row?.scope).toBe('user');
    expect(row?.userId).toBe(userId);
    expect(row?.label).toBe('Beach');

    const mine = await app.inject({
      method: 'GET',
      url: '/v1/backgrounds/mine',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(mine.json().items.map((i: { id: string }) => i.id)).toContain(created.id);

    const general = await app.inject({
      method: 'GET',
      url: '/v1/models/backgrounds?gender=women',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(general.json().items.map((i: { id: string }) => i.id)).not.toContain(created.id);
  });

  it('confirm rejects an r2Key not owned by the caller', async () => {
    const { token: tokenA } = await getToken('bgmine2a@x.com');
    const { token: tokenB } = await getToken('bgmine2b@x.com');

    const presign = await app.inject({
      method: 'POST',
      url: '/v1/backgrounds/mine/presign',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { contentType: 'image/jpeg', contentLength: 1024 },
    });
    const { r2Key } = presign.json() as { r2Key: string };
    await app.storage.putObject(r2Key, Buffer.alloc(1024, 1), 'image/jpeg');

    const confirm = await app.inject({
      method: 'POST',
      url: '/v1/backgrounds/mine/confirm',
      headers: { authorization: `Bearer ${tokenB}` },
      payload: { r2Key },
    });
    expect(confirm.statusCode).toBe(403);
  });

  it('owner can delete; a different user gets 404; deleted row disappears from /mine', async () => {
    const { token: tokenA } = await getToken('bgmine3a@x.com');
    const { token: tokenB } = await getToken('bgmine3b@x.com');

    const presign = await app.inject({
      method: 'POST',
      url: '/v1/backgrounds/mine/presign',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { contentType: 'image/jpeg', contentLength: 1024 },
    });
    const { r2Key } = presign.json() as { r2Key: string };
    await app.storage.putObject(r2Key, Buffer.alloc(1024, 1), 'image/jpeg');
    const confirm = await app.inject({
      method: 'POST',
      url: '/v1/backgrounds/mine/confirm',
      headers: { authorization: `Bearer ${tokenA}` },
      payload: { r2Key },
    });
    const { id } = confirm.json();

    const deleteAsB = await app.inject({
      method: 'DELETE',
      url: `/v1/backgrounds/mine/${id}`,
      headers: { authorization: `Bearer ${tokenB}` },
    });
    expect(deleteAsB.statusCode).toBe(404);

    const deleteAsA = await app.inject({
      method: 'DELETE',
      url: `/v1/backgrounds/mine/${id}`,
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(deleteAsA.statusCode).toBe(200);

    const mine = await app.inject({
      method: 'GET',
      url: '/v1/backgrounds/mine',
      headers: { authorization: `Bearer ${tokenA}` },
    });
    expect(mine.json().items.map((i: { id: string }) => i.id)).not.toContain(id);
  });
});
```

- [ ] **Step 3: Run the tests to confirm they fail**

```bash
pnpm --filter @tryme/api exec vitest run --config vitest.integration.config.ts -t "backgrounds/mine"
```
Expected: FAIL — 404s, since the route doesn't exist yet.

- [ ] **Step 4: Implement the route module**

Create `apps/api/src/modules/backgrounds/routes.ts`:

```typescript
import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { keys } from '@tryme/storage';
import {
  ConfirmMyBackgroundBody,
  CreateMyBackgroundFromUrlBody,
  PresignMyBackgroundBody,
} from '@tryme/types';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import sharp from 'sharp';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { fetchImageWithCap } from '../../lib/fetch-image.js';
import { assertPublicHttpUrl } from '../../lib/ssrf-guard.js';

const UPLOAD_OWNER_TTL_SEC = 24 * 60 * 60;
const MAX_URL_IMAGE_BYTES = 15 * 1024 * 1024;
const ALLOWED_FORMATS = new Set(['jpeg', 'png', 'webp']);

async function makeThumb(buf: Buffer): Promise<Buffer> {
  return sharp(buf)
    .rotate()
    .resize({ width: 512, height: 512, fit: 'inside', withoutEnlargement: true })
    .jpeg({ quality: 78 })
    .toBuffer();
}

function toItem(
  app: FastifyInstance,
  row: { id: string; label: string; thumbnailKey: string },
) {
  return { id: row.id, label: row.label, thumbnailUrl: app.storage.publicUrl(row.thumbnailKey) };
}

const BACKGROUND_ROW_COLUMNS = {
  id: schema.modelBackgrounds.id,
  label: schema.modelBackgrounds.label,
  thumbnailKey: schema.modelBackgrounds.thumbnailKey,
};

export async function backgroundsRoutes(app: FastifyInstance) {
  app.get('/v1/backgrounds/mine', { preHandler: app.requireUser }, async (req) => {
    const rows = await app.db
      .select(BACKGROUND_ROW_COLUMNS)
      .from(schema.modelBackgrounds)
      .where(
        and(
          eq(schema.modelBackgrounds.scope, 'user'),
          eq(schema.modelBackgrounds.userId, req.userId),
          isNull(schema.modelBackgrounds.deletedAt),
        ),
      )
      .orderBy(desc(schema.modelBackgrounds.createdAt));
    return { items: rows.map((r) => toItem(app, r)) };
  });

  app.post(
    '/v1/backgrounds/mine/presign',
    { preHandler: app.requireUser, schema: { body: PresignMyBackgroundBody } },
    async (req) => {
      const { contentType, contentLength } = req.body as z.infer<typeof PresignMyBackgroundBody>;
      const id = randomUUID();
      const r2Key = keys.userBackground(req.userId, id);
      const { url, expiresIn } = await app.storage.presignPut(
        r2Key,
        contentType,
        contentLength,
        300,
      );
      await app.redis.set(`upload:owner:${r2Key}`, req.userId, 'EX', UPLOAD_OWNER_TTL_SEC);
      return { uploadUrl: url, r2Key, id, expiresIn };
    },
  );

  app.post(
    '/v1/backgrounds/mine/confirm',
    { preHandler: app.requireUser, schema: { body: ConfirmMyBackgroundBody } },
    async (req) => {
      const { r2Key, label } = req.body as z.infer<typeof ConfirmMyBackgroundBody>;
      const owner = await app.redis.get(`upload:owner:${r2Key}`);
      if (owner !== req.userId) {
        throw new AppError('FORBIDDEN', 403, 'upload key not owned by caller');
      }
      let buf: Buffer;
      try {
        buf = await app.storage.getObject(r2Key);
      } catch {
        throw new AppError('BAD_UPLOAD', 400, 'uploaded background not found');
      }
      let thumb: Buffer;
      try {
        thumb = await makeThumb(buf);
      } catch {
        throw new AppError('BAD_UPLOAD', 400, 'uploaded file is not a valid image');
      }
      const thumbnailKey = r2Key.replace(/\.jpg$/, '.thumb.jpg');
      await app.storage.putObject(thumbnailKey, thumb, 'image/jpeg');
      const [row] = await app.db
        .insert(schema.modelBackgrounds)
        .values({
          label: label ?? 'My background',
          r2Key,
          thumbnailKey,
          scope: 'user',
          userId: req.userId,
        })
        .returning();
      return toItem(app, row);
    },
  );

  app.post(
    '/v1/backgrounds/mine/from-url',
    { preHandler: app.requireUser, schema: { body: CreateMyBackgroundFromUrlBody } },
    async (req) => {
      const { url, label } = req.body as z.infer<typeof CreateMyBackgroundFromUrlBody>;
      const parsedUrl = await assertPublicHttpUrl(url);
      const buf = await fetchImageWithCap(parsedUrl, MAX_URL_IMAGE_BYTES, 10_000);
      let format: string | undefined;
      try {
        format = (await sharp(buf).metadata()).format;
      } catch {
        throw new AppError('VALIDATION', 400, 'url did not return a valid image');
      }
      if (!format || !ALLOWED_FORMATS.has(format)) {
        throw new AppError('VALIDATION', 400, 'unsupported image format');
      }
      const id = randomUUID();
      const r2Key = keys.userBackground(req.userId, id);
      const thumbnailKey = keys.userBackgroundThumb(req.userId, id);
      const normalized = await sharp(buf).jpeg({ quality: 90 }).toBuffer();
      await app.storage.putObject(r2Key, normalized, 'image/jpeg');
      const thumb = await makeThumb(buf);
      await app.storage.putObject(thumbnailKey, thumb, 'image/jpeg');
      const [row] = await app.db
        .insert(schema.modelBackgrounds)
        .values({
          label: label ?? 'My background',
          r2Key,
          thumbnailKey,
          scope: 'user',
          userId: req.userId,
        })
        .returning();
      return toItem(app, row);
    },
  );

  app.delete(
    '/v1/backgrounds/mine/:id',
    { preHandler: app.requireUser, schema: { params: z.object({ id: z.string().uuid() }) } },
    async (req) => {
      const { id } = req.params as { id: string };
      const [row] = await app.db
        .update(schema.modelBackgrounds)
        .set({ deletedAt: new Date() })
        .where(
          and(
            eq(schema.modelBackgrounds.id, id),
            eq(schema.modelBackgrounds.scope, 'user'),
            eq(schema.modelBackgrounds.userId, req.userId),
            isNull(schema.modelBackgrounds.deletedAt),
          ),
        )
        .returning({ id: schema.modelBackgrounds.id });
      if (!row) throw new AppError('NOT_FOUND', 404, 'background not found');
      return { deleted: true };
    },
  );
}
```

Note: this task implements `/presign`, `/confirm`, `GET /mine`, and `DELETE /mine/:id` — the `/from-url` handler is included in this same file now (simplest to write once) but is only exercised by Task 4's tests; this task's tests (Step 2 above) don't touch it.

- [ ] **Step 5: Register the route module in `server.ts`**

Add the import in `apps/api/src/server.ts` alphabetically among the existing module imports (right after `import { authRoutes } from './modules/auth/routes.js';` and before `import { catalogRoutes } from './modules/catalog/routes.js';`):

```typescript
import { backgroundsRoutes } from './modules/backgrounds/routes.js';
```

Add the registration call right after `await app.register(uploadsRoutes);` (line 261):

```typescript
  await app.register(uploadsRoutes);
  await app.register(backgroundsRoutes);
```

- [ ] **Step 6: Run the tests to confirm they pass**

```bash
pnpm --filter @tryme/api exec vitest run --config vitest.integration.config.ts -t "backgrounds/mine"
```
Expected: PASS, all 3 tests green.

- [ ] **Step 7: Typecheck**

```bash
pnpm --filter @tryme/types typecheck && pnpm --filter @tryme/api typecheck
```
Expected: both exit 0.

- [ ] **Step 8: Commit**

```bash
git add packages/types/src/backgrounds.ts packages/types/src/index.ts apps/api/src/modules/backgrounds/routes.ts apps/api/src/server.ts apps/api/test/integration/backgrounds-mine.test.ts
git commit -m "feat(api): add /v1/backgrounds/mine list, presign, confirm, delete routes"
```

---

## Task 4: Backgrounds API — `from-url`

**Files:**
- Test only: `apps/api/test/integration/backgrounds-from-url.test.ts` (the route handler was already written in Task 3, Step 4)

**Interfaces:**
- Consumes: `assertPublicHttpUrl` and `fetchImageWithCap` from Task 2; the `/v1/backgrounds/mine/from-url` handler from Task 3.

- [ ] **Step 1: Write the failing integration tests**

Create `apps/api/test/integration/backgrounds-from-url.test.ts`:

```typescript
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildTestApp, type TestApp } from '../helpers/api';
import { type Containers, startContainers } from '../helpers/containers';

describe('POST /v1/backgrounds/mine/from-url', () => {
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
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  async function getToken(email: string) {
    await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { displayName: 'BG URL User', email, password: 'password123' },
    });
    const [user] = await app.db
      .select({ id: schema.users.id })
      .from(schema.users)
      .where(eq(schema.users.email, email));
    if (!user) throw new Error('user not found');
    await app.db
      .update(schema.users)
      .set({ emailVerified: true })
      .where(eq(schema.users.id, user.id));
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email, password: 'password123' },
    });
    return login.json().accessToken as string;
  }

  it('fetches a public-IP image URL, stores it as scope=user, and returns the item', async () => {
    const token = await getToken('bgfromurl1@x.com');
    const fixture = await sharp({
      create: { width: 64, height: 64, channels: 3, background: { r: 200, g: 50, b: 50 } },
    })
      .jpeg()
      .toBuffer();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(fixture, {
          status: 200,
          headers: { 'content-type': 'image/jpeg', 'content-length': String(fixture.length) },
        }),
      ),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/v1/backgrounds/mine/from-url',
      headers: { authorization: `Bearer ${token}` },
      payload: { url: 'http://1.1.1.1/photo.jpg' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBeTruthy();
    expect(body.thumbnailUrl).toContain('http');

    const [row] = await app.db
      .select()
      .from(schema.modelBackgrounds)
      .where(eq(schema.modelBackgrounds.id, body.id));
    expect(row?.scope).toBe('user');
  });

  it('rejects a URL resolving to a private/loopback address without calling fetch', async () => {
    const token = await getToken('bgfromurl2@x.com');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/backgrounds/mine/from-url',
      headers: { authorization: `Bearer ${token}` },
      payload: { url: 'http://127.0.0.1/x.jpg' },
    });
    expect(res.statusCode).toBe(400);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('rejects a non-image content-type', async () => {
    const token = await getToken('bgfromurl3@x.com');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response('not an image', { status: 200, headers: { 'content-type': 'text/plain' } }),
      ),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/v1/backgrounds/mine/from-url',
      headers: { authorization: `Bearer ${token}` },
      payload: { url: 'http://1.1.1.1/notanimage' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects an oversized image via content-length', async () => {
    const token = await getToken('bgfromurl4@x.com');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(new Uint8Array(10), {
          status: 200,
          headers: {
            'content-type': 'image/jpeg',
            'content-length': String(20 * 1024 * 1024),
          },
        }),
      ),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/v1/backgrounds/mine/from-url',
      headers: { authorization: `Bearer ${token}` },
      payload: { url: 'http://1.1.1.1/big.jpg' },
    });
    expect(res.statusCode).toBe(413);
  });
});
```

- [ ] **Step 2: Run the tests**

```bash
pnpm --filter @tryme/api exec vitest run --config vitest.integration.config.ts -t "from-url"
```
Expected: PASS, all 4 tests green (the handler already exists from Task 3 — this task only adds coverage for it). If any fail, debug against the `backgroundsRoutes` `from-url` handler in `apps/api/src/modules/backgrounds/routes.ts` before proceeding — do not modify the test to fit a broken handler.

- [ ] **Step 3: Commit**

```bash
git add apps/api/test/integration/backgrounds-from-url.test.ts
git commit -m "test(api): cover /v1/backgrounds/mine/from-url happy path and SSRF/size/type rejections"
```

---

## Task 5: Job creation — ownership gate on `backgroundId`

**Files:**
- Modify: `apps/api/src/modules/jobs/create.ts:13` (add `or` to the drizzle-orm import), `:306-314` (add ownership condition)
- Create: `apps/api/test/integration/jobs-create-background-ownership.test.ts`

**Interfaces:**
- Consumes: `schema.modelBackgrounds.scope` / `.userId` from Task 1.

- [ ] **Step 1: Write the failing integration tests**

Create `apps/api/test/integration/jobs-create-background-ownership.test.ts`:

```typescript
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { signAccess } from '../../src/modules/auth/service.js';
import { buildTestApp, type TestApp } from '../helpers/api';
import { type Containers, startContainers } from '../helpers/containers';

describe('createJob — user-scoped background ownership', () => {
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
    app.storage.headObject = (async () => ({ contentLength: 1024 })) as typeof app.storage.headObject;
  });

  async function registerUser(email: string) {
    const [user] = await app.db
      .insert(schema.users)
      .values({ email, emailVerified: true, tier: 'free' })
      .returning();
    const secret = new TextEncoder().encode(app.env.JWT_SECRET);
    const accessToken = await signAccess(secret, user.id, { kind: 'access' }, app.env.JWT_EXPIRY);
    return { token: accessToken, userId: user.id };
  }

  async function grantCredits(userId: string, amount: number) {
    await app.db
      .insert(schema.userCredits)
      .values({ userId, balance: amount })
      .onConflictDoUpdate({ target: schema.userCredits.userId, set: { balance: amount } });
  }

  async function seedCreditPlan() {
    await app.db
      .insert(schema.creditPlans)
      .values({ slug: 'free', name: 'free', credits: 1000, basePaise: 0, watermark: false })
      .onConflictDoUpdate({ target: schema.creditPlans.slug, set: { watermark: false } });
  }

  async function bindUploadKey(userId: string, key: string) {
    await app.redis.set(`upload:owner:${key}`, userId, 'EX', 3600);
  }

  async function seedFaceAndPose() {
    const [face] = await app.db
      .insert(schema.modelFaces)
      .values({ gender: 'men', label: 'F', r2Key: 'f.jpg', thumbnailKey: 'f.jpg' })
      .returning();
    const [pose] = await app.db
      .insert(schema.modelPoseAssets)
      .values({ label: 'P', r2Key: 'p.jpg', thumbnailKey: 'p.jpg' })
      .returning();
    return { faceId: face.id, poseId: pose.id };
  }

  it('accepts a job that references the caller\'s own scope=user background', async () => {
    await seedCreditPlan();
    const { token, userId } = await registerUser('bgown-self@x.com');
    await grantCredits(userId, 100);
    const { faceId, poseId } = await seedFaceAndPose();
    const [myBg] = await app.db
      .insert(schema.modelBackgrounds)
      .values({ label: 'Mine', r2Key: 'mine.jpg', thumbnailKey: 'mine.jpg', scope: 'user', userId })
      .returning();
    const garmentKey = `inputs/${userId}/garment.jpg`;
    await bindUploadKey(userId, garmentKey);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/tryon',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        inputs: { upperGarmentKey: garmentKey, faceId, backgroundId: myBg.id, poseIds: [poseId] },
        aspectRatio: '1:1',
        resolution: '2K',
      },
    });
    expect(res.statusCode).toBe(201);
  });

  it('rejects a job that references another user\'s scope=user background', async () => {
    await seedCreditPlan();
    const { userId: ownerId } = await registerUser('bgown-owner@x.com');
    const [otherBg] = await app.db
      .insert(schema.modelBackgrounds)
      .values({
        label: 'Not yours',
        r2Key: 'notyours.jpg',
        thumbnailKey: 'notyours.jpg',
        scope: 'user',
        userId: ownerId,
      })
      .returning();

    const { token, userId } = await registerUser('bgown-attacker@x.com');
    await grantCredits(userId, 100);
    const { faceId, poseId } = await seedFaceAndPose();
    const garmentKey = `inputs/${userId}/garment.jpg`;
    await bindUploadKey(userId, garmentKey);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/tryon',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        inputs: {
          upperGarmentKey: garmentKey,
          faceId,
          backgroundId: otherBg.id,
          poseIds: [poseId],
        },
        aspectRatio: '1:1',
        resolution: '2K',
      },
    });
    expect(res.statusCode).toBe(400);

    const [bal] = await app.db
      .select()
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, userId));
    expect(bal.balance).toBe(100); // nothing charged
  });
});
```

- [ ] **Step 2: Run the tests to confirm the second one currently fails (no ownership gate yet)**

```bash
pnpm --filter @tryme/api exec vitest run --config vitest.integration.config.ts -t "user-scoped background ownership"
```
Expected: first test passes (a `scope='user'` row with `isActive=true` currently validates fine, since the pre-fix query only checks `isActive`), second test **fails** — currently returns 201 instead of 400, because nothing today checks `userId` ownership.

- [ ] **Step 3: Add the ownership condition in `jobs/create.ts`**

In `apps/api/src/modules/jobs/create.ts`, change the drizzle-orm import (line 13) from:
```typescript
import { aliasedTable, and, eq, inArray, isNull, sql } from 'drizzle-orm';
```
to:
```typescript
import { aliasedTable, and, eq, inArray, isNull, or, sql } from 'drizzle-orm';
```

Then replace the background-rows query (lines 306-314):
```typescript
    app.db
      .select({ id: schema.modelBackgrounds.id })
      .from(schema.modelBackgrounds)
      .where(
        and(
          inArray(schema.modelBackgrounds.id, distinctBackgroundIds),
          eq(schema.modelBackgrounds.isActive, true),
        ),
      ),
```
with:
```typescript
    app.db
      .select({ id: schema.modelBackgrounds.id })
      .from(schema.modelBackgrounds)
      .where(
        and(
          inArray(schema.modelBackgrounds.id, distinctBackgroundIds),
          eq(schema.modelBackgrounds.isActive, true),
          or(
            eq(schema.modelBackgrounds.scope, 'general'),
            and(
              eq(schema.modelBackgrounds.scope, 'user'),
              eq(schema.modelBackgrounds.userId, userId),
            ),
          ),
        ),
      ),
```

(`userId` is already in scope in this function — it's the parameter used two lines above for `verifyGarmentKey(app, userId, ...)`.)

- [ ] **Step 4: Run the tests to confirm both pass**

```bash
pnpm --filter @tryme/api exec vitest run --config vitest.integration.config.ts -t "user-scoped background ownership"
```
Expected: PASS, both tests green.

- [ ] **Step 5: Run the existing looks/create test suites to confirm no regression**

```bash
pnpm --filter @tryme/api exec vitest run --config vitest.integration.config.ts -t "createJob"
```
Expected: all pre-existing `jobs-create-looks.test.ts` tests still PASS (the added `or(...)` condition is a superset — every `scope='general'` background still matches unconditionally).

- [ ] **Step 6: Typecheck**

```bash
pnpm --filter @tryme/api typecheck
```
Expected: exits 0.

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/jobs/create.ts apps/api/test/integration/jobs-create-background-ownership.test.ts
git commit -m "fix(api): reject job creation against another user's private background"
```

---

## Task 6: Studio wizard — "My backgrounds" UI

**Files:**
- Modify: `apps/catalogues-web/src/app/(app)/studio/page.tsx` (new queries/mutations + new section in the Step 2 background block)

**Interfaces:**
- Consumes: `GET /v1/backgrounds/mine`, `POST /v1/backgrounds/mine/presign`, `POST /v1/backgrounds/mine/confirm`, `POST /v1/backgrounds/mine/from-url`, `DELETE /v1/backgrounds/mine/:id` from Task 3/4 — response item shape `{ id: string, label: string, thumbnailUrl: string }`.
- Reuses: `api.post`/`api.get`/`api.del`/`api.uploadToR2WithProgress` from `apps/catalogues-web/src/lib/api.ts`; `SelCard` from `./shared-cards.tsx`; `showToast` (defined at `page.tsx:537`); `isSupportedImageBytes` (defined near `page.tsx:800`, magic-byte sniff already used for garment upload); `handleBackgroundSelect` (`page.tsx:942`).

- [ ] **Step 1: Add the `my backgrounds` query and mutations**

In `apps/catalogues-web/src/app/(app)/studio/page.tsx`, right after the existing `backgrounds` query (the one at line 599 querying `/v1/models/backgrounds`), add:

```typescript
  const { data: myBackgrounds, refetch: refetchMyBackgrounds } = useQuery<{
    items: { id: string; label: string; thumbnailUrl: string }[];
  }>({
    queryKey: ['backgrounds', 'mine'],
    queryFn: () => api.get('/v1/backgrounds/mine'),
  });
  const [isUploadingBackground, setIsUploadingBackground] = useState(false);
  const [backgroundUrlInput, setBackgroundUrlInput] = useState('');
  const [isFetchingBackgroundUrl, setIsFetchingBackgroundUrl] = useState(false);

  async function handleMyBackgroundUpload(file: File) {
    if (isUploadingBackground) return;
    if (file.size > 10 * 1024 * 1024) {
      showToast('File exceeds 10 MB. Please choose a smaller image.');
      return;
    }
    if (!(await isSupportedImageBytes(file))) {
      showToast('Unsupported file type. Please upload a JPEG, PNG, or WebP image.');
      return;
    }
    setIsUploadingBackground(true);
    try {
      const { uploadUrl, r2Key } = await api.post<{
        uploadUrl: string;
        r2Key: string;
        id: string;
        expiresIn: number;
      }>('/v1/backgrounds/mine/presign', { contentType: file.type, contentLength: file.size });
      await api.uploadToR2WithProgress(uploadUrl, file, () => {});
      const created = await api.post<{ id: string; label: string; thumbnailUrl: string }>(
        '/v1/backgrounds/mine/confirm',
        { r2Key },
      );
      await refetchMyBackgrounds();
      setBackgroundId(created.id);
    } catch (e) {
      showToast(`Upload failed: ${(e as Error).message ?? 'please try again'}`);
    } finally {
      setIsUploadingBackground(false);
    }
  }

  async function handleMyBackgroundFromUrl() {
    if (isFetchingBackgroundUrl || !backgroundUrlInput.trim()) return;
    setIsFetchingBackgroundUrl(true);
    try {
      const created = await api.post<{ id: string; label: string; thumbnailUrl: string }>(
        '/v1/backgrounds/mine/from-url',
        { url: backgroundUrlInput.trim() },
      );
      await refetchMyBackgrounds();
      setBackgroundId(created.id);
      setBackgroundUrlInput('');
    } catch (e) {
      showToast(`Couldn't load that image: ${(e as Error).message ?? 'please try again'}`);
    } finally {
      setIsFetchingBackgroundUrl(false);
    }
  }

  async function handleDeleteMyBackground(id: string) {
    try {
      await api.del(`/v1/backgrounds/mine/${id}`);
      if (backgroundId === id) setBackgroundId('');
      await refetchMyBackgrounds();
    } catch (e) {
      showToast(`Couldn't delete: ${(e as Error).message ?? 'please try again'}`);
    }
  }
```

`uploadToR2WithProgress`'s third parameter (`onProgress`) is required by its signature (`apps/catalogues-web/src/lib/api.ts:144`) — pass a no-op `() => {}` since this section has no progress bar, matching the existing lower/third-garment uploads which do the same (`page.tsx:881`, `:918`).

- [ ] **Step 2: Add the "My backgrounds" section to the Step 2 background block**

In `apps/catalogues-web/src/app/(app)/studio/page.tsx`, inside the `{/* ── Background (custom mode only) ── */}` block (starts at line 2348), insert this new subsection immediately after the closing `</SectionHead>`'s parent — i.e. right before the existing `{backgroundsError ? (` conditional at line 2380:

```typescript
                <div style={{ marginBottom: 20 }}>
                  <p style={{ fontSize: 12, fontWeight: 600, color: C.mid, marginBottom: 8 }}>
                    My backgrounds
                  </p>
                  <div
                    style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}
                  >
                    {(myBackgrounds?.items ?? []).map((b) => (
                      <div key={b.id} style={{ position: 'relative' }}>
                        <SelCard
                          selected={backgroundId === b.id}
                          onClick={() => handleBackgroundSelect(b.id)}
                          imageUrl={b.thumbnailUrl}
                          label={b.label}
                          w={130}
                          ratio={215.2 / 212.67}
                        />
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            handleDeleteMyBackground(b.id);
                          }}
                          style={{
                            position: 'absolute',
                            top: 4,
                            right: 4,
                            width: 22,
                            height: 22,
                            borderRadius: '50%',
                            border: 'none',
                            background: 'rgba(0,0,0,0.55)',
                            color: C.white,
                            cursor: 'pointer',
                            fontSize: 12,
                            lineHeight: 1,
                          }}
                          aria-label={`Delete ${b.label}`}
                        >
                          ✕
                        </button>
                      </div>
                    ))}
                    <label
                      style={{
                        width: 130,
                        height: 170,
                        borderRadius: 12,
                        border: `1.5px dashed ${C.border}`,
                        display: 'flex',
                        flexDirection: 'column',
                        alignItems: 'center',
                        justifyContent: 'center',
                        gap: 6,
                        cursor: isUploadingBackground ? 'wait' : 'pointer',
                        fontSize: 12,
                        color: C.mid,
                        textAlign: 'center',
                        padding: 8,
                      }}
                    >
                      {isUploadingBackground ? 'Uploading…' : 'Upload image'}
                      <input
                        type="file"
                        accept="image/jpeg,image/png,image/webp"
                        style={{ display: 'none' }}
                        disabled={isUploadingBackground}
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) handleMyBackgroundUpload(file);
                          e.target.value = '';
                        }}
                      />
                    </label>
                  </div>
                  <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                    <input
                      type="text"
                      value={backgroundUrlInput}
                      onChange={(e) => setBackgroundUrlInput(e.target.value)}
                      placeholder="Paste an image URL"
                      disabled={isFetchingBackgroundUrl}
                      style={{
                        flex: 1,
                        padding: '8px 12px',
                        borderRadius: 8,
                        border: `1px solid ${C.border}`,
                        fontSize: 13,
                        background: C.card,
                        color: C.text,
                      }}
                    />
                    <button
                      type="button"
                      onClick={handleMyBackgroundFromUrl}
                      disabled={isFetchingBackgroundUrl || !backgroundUrlInput.trim()}
                      style={{
                        padding: '8px 16px',
                        borderRadius: 8,
                        border: 'none',
                        background: grad,
                        color: C.white,
                        fontWeight: 600,
                        fontSize: 13,
                        cursor: isFetchingBackgroundUrl ? 'wait' : 'pointer',
                        opacity: isFetchingBackgroundUrl || !backgroundUrlInput.trim() ? 0.6 : 1,
                      }}
                    >
                      {isFetchingBackgroundUrl ? 'Loading…' : 'Add'}
                    </button>
                  </div>
                </div>
```

- [ ] **Step 3: Start the dev servers and test in the browser**

```bash
pnpm dev
```
Then, in a browser:
1. Log in, go to Studio, pick gender `women`, garment type `chudidar` (or `custom` from-scratch flow — any garment type works for custom mode), reach the "Select Background" step.
2. Confirm a new "My backgrounds" row appears above the curated grid, with an "Upload image" tile and a URL input below.
3. Upload a JPEG/PNG — confirm it appears as a new tile, auto-selected (pink border), and that submitting a job with it succeeds end to end.
4. Paste a public image URL (e.g. a Wikimedia Commons direct image link) and click Add — confirm it fetches and appears as a tile.
5. Paste `http://127.0.0.1/x.jpg` or `http://169.254.169.254/x.jpg` — confirm it's rejected with a toast, not a silent failure or crash.
6. Click the ✕ on an uploaded tile — confirm it disappears from the grid; if it was selected, confirm the selection clears.
7. Reload the page — confirm "My backgrounds" persists (backed by the DB, not client state).

- [ ] **Step 4: Typecheck the web app**

```bash
pnpm --filter @tryme/web typecheck
```
Expected: exits 0.

- [ ] **Step 5: Commit**

```bash
git add apps/catalogues-web/src/app/\(app\)/studio/page.tsx
git commit -m "feat(web): add custom background upload/URL to Studio's background step"
```

---

## Final check

- [ ] Run the full API integration suite once more to confirm nothing regressed:
```bash
pnpm --filter @tryme/api exec vitest run --config vitest.integration.config.ts
```
- [ ] Run the full unit suite:
```bash
pnpm --filter @tryme/api test
```
- [ ] Update `docs/progress.md` with a dated entry per the root `CLAUDE.md`'s Progress Tracking convention (Done / Failed-Not Done / Open Questions).
