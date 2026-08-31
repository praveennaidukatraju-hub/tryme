# Google Drive Export — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a "Save to Drive" export next to the existing Download button on
Studio results (`apps/catalogues-web`'s generation panel), so a user can push
a single completed result straight into their Google Drive without a
browser download/re-upload round trip.

**Architecture:** A new, self-contained `apps/api/src/modules/google-drive/`
module owns a separate OAuth grant (`drive.file`, `access_type=offline`) on
the **same** `GOOGLE_CLIENT_ID` the login flow already uses — no new Google
Cloud OAuth client. The refresh token is encrypted at rest with the existing
`encryptToken`/`decryptToken` helpers (`apps/api/src/lib/crypto.ts`), same as
Shopify's access tokens, under a new `GOOGLE_DRIVE_TOKEN_ENC_KEY`. Export
reads the result straight out of storage (`app.storage.getObject`) and
streams it to the Drive API — no presigned URL, no browser round trip. Drive
calls use plain `fetch` against the Drive REST API (multipart upload,
`files.list`, `files.create`), matching this codebase's existing pattern for
both Google and Shopify OAuth (hand-rolled `fetch`, no `googleapis` SDK
dependency) — nothing here justifies adding one.

**Tech Stack:** TypeScript, Fastify 5 (API), Drizzle ORM, Vitest (real
Postgres/Redis/MinIO integration tests), Next.js 15 / React (catalogues-web).

**Full design reference:**
`docs/superpowers/specs/2026-08-21-google-drive-export-design.md` — read it
once before starting; this plan implements it task-by-task and repeats every
code detail needed, but the design doc has the "why" behind each decision
(especially the shared-OAuth-client tradeoff and the revoke-caveat comment
required in Task 5).

---

## Context for the engineer (read this before starting)

- **What already exists, unmodified by this plan:** `/v1/auth/google/*`
  (`apps/api/src/modules/auth/google.routes.ts`) — login only requests
  `openid email profile` and never persists a Google token
  (`google.routes.ts:120-121` fetches the access token, uses it once for
  userinfo, discards it). This plan does not touch that file. Studio's
  existing Download / Download All (`generation-panel.tsx:186-239,
  709-737, 838-868`) also stays as-is — Save to Drive is added alongside it,
  not a replacement.
- **Crypto is 100% reuse.** `apps/api/src/lib/crypto.ts` exports generic
  `encryptToken(plaintext, keyB64)` / `decryptToken(ciphertext, keyB64)`.
  `modules/shopify/token.ts:95-96` already calls these with
  `SHOPIFY_TOKEN_ENC_KEY`. This plan calls the exact same two functions with
  a new `GOOGLE_DRIVE_TOKEN_ENC_KEY` — no new crypto code anywhere.
- **User auth in routes:** `req.userId` is set by the `app.requireUser`
  preHandler (see any route in `apps/api/src/modules/jobs/routes.ts`, e.g.
  line 30 or line 91). Every new route below uses the same preHandler.
- **`preview-panel.tsx` has no download control of its own** — only
  `generation-panel.tsx` does. The Save to Drive button only needs to be
  added there.
- **`app.storage.getObject(key): Promise<Buffer>`**
  (`packages/storage/src/index.ts:15`) — returns a `Buffer`, not a stream.
  The Drive multipart-upload body needs a `Readable`, so the service wraps
  it with `Readable.from(buffer)` at the call site — no storage-layer change
  needed.
- **No `googleapis` / `google-auth-library` dependency exists in this repo
  today** (confirmed: not in `apps/api/package.json`). Do not add one — the
  three Drive calls this feature needs (`files.list`, multipart
  `files.create`, `oauth2.googleapis.com/token` + `/revoke`) are all single
  `fetch` calls, exactly like every existing Google/Shopify OAuth call in
  this codebase.
- **Next migration number is `0168`** (confirmed: highest existing file is
  `0167_*.sql`). If another migration lands first, `pnpm db:generate` will
  pick the next free number automatically — just use whatever it generates,
  the exact number doesn't matter.

---

### Task 1: Add the `google_drive_connections` table

**Files:**
- Create: `packages/db/src/schema/google-drive.ts`
- Modify: `packages/db/src/schema/index.ts`

- [ ] **Step 1: Write the schema file**

Create `packages/db/src/schema/google-drive.ts`:

```ts
import { sql } from 'drizzle-orm';
import { pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { users } from './users.js';

// One row per user who has opted into Drive export. Separate from
// oauth_accounts (login identity) on purpose — this is a revocable,
// opt-in credential grant, not part of how the user signs in. See
// docs/superpowers/specs/2026-08-21-google-drive-export-design.md.
export const googleDriveConnections = pgTable(
  'google_drive_connections',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    googleEmail: text('google_email').notNull(),
    // AES-256-GCM via lib/crypto.ts, keyed by GOOGLE_DRIVE_TOKEN_ENC_KEY.
    // Null once revoked/disconnected — the row is kept (not deleted) so the
    // status endpoint can still say *which* Google account needs reconnecting.
    refreshTokenEnc: text('refresh_token_enc'),
    scope: text('scope').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('google_drive_connections_user_id_uniq').on(t.userId)],
);
```

- [ ] **Step 2: Export it from the schema barrel**

Open `packages/db/src/schema/index.ts`. Find:

```ts
export * from './demo-catalog.js';
export * from './dev-api.js';
```

Replace with:

```ts
export * from './demo-catalog.js';
export * from './dev-api.js';
export * from './google-drive.js';
```

- [ ] **Step 3: Typecheck the db package**

Run: `pnpm --filter @tryme/db exec tsc --noEmit -p .`
Expected: no output (clean exit).

- [ ] **Step 4: Generate the migration**

Run (requires `DATABASE_URL` set / `pnpm docker:up` running):

```bash
pnpm --filter @tryme/db run generate
```

Expected: a new `packages/db/src/migrations/0168_<name>.sql` with a
`CREATE TABLE "google_drive_connections"` statement and a unique index on
`user_id`, plus a matching `meta/_journal.json` entry and snapshot file.

- [ ] **Step 5: Apply it locally**

Run: `pnpm db:migrate`
Expected: applies without error.

- [ ] **Step 6: Commit**

```bash
git add packages/db/src/schema/google-drive.ts packages/db/src/schema/index.ts packages/db/src/migrations/0168_*.sql packages/db/src/migrations/meta/_journal.json packages/db/src/migrations/meta/0168_snapshot.json
git commit -m "feat(db): add google_drive_connections table"
```

---

### Task 2: Env var

**Files:**
- Modify: `apps/api/src/env.ts`

- [ ] **Step 1: Add `GOOGLE_DRIVE_TOKEN_ENC_KEY`**

Find (`env.ts:76-78`):

```ts
  SHOPIFY_SCOPES: z.string().default('read_products'),
  // 32-byte key, base64-encoded (44 chars). Required only when Shopify is enabled.
  SHOPIFY_TOKEN_ENC_KEY: z.string().optional(),
```

Replace with:

```ts
  SHOPIFY_SCOPES: z.string().default('read_products'),
  // 32-byte key, base64-encoded (44 chars). Required only when Shopify is enabled.
  SHOPIFY_TOKEN_ENC_KEY: z.string().optional(),
  // 32-byte key, base64-encoded (44 chars). Required only when Google Drive
  // export is enabled. Same encryptToken/decryptToken helper as the line
  // above, different key — see lib/crypto.ts.
  GOOGLE_DRIVE_TOKEN_ENC_KEY: z.string().optional(),
```

- [ ] **Step 2: Typecheck**

Run: `pnpm --filter @tryme/api run typecheck`
Expected: no errors.

- [ ] **Step 3: Add the key to `.env.production.example`**

Open `.env.production.example`, add `GOOGLE_DRIVE_TOKEN_ENC_KEY=` next to
the existing `SHOPIFY_TOKEN_ENC_KEY=` line with a one-line comment matching
its style.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/env.ts .env.production.example
git commit -m "feat(api): add GOOGLE_DRIVE_TOKEN_ENC_KEY env var"
```

---

### Task 3: Shared types

**Files:**
- Modify: `packages/types/src/index.ts` or create `packages/types/src/google-drive.ts`

- [ ] **Step 1: Create the schema file**

Create `packages/types/src/google-drive.ts`:

```ts
import { z } from 'zod';

export const GoogleDriveStatusResponse = z.object({
  status: z.enum(['NOT_CONNECTED', 'CONNECTED', 'REAUTH_REQUIRED']),
  googleEmail: z.string().nullable(),
});
export type GoogleDriveStatusResponse = z.infer<typeof GoogleDriveStatusResponse>;

export const GoogleDriveExportResponse = z.object({
  driveFileId: z.string(),
  webViewLink: z.string().url(),
});
export type GoogleDriveExportResponse = z.infer<typeof GoogleDriveExportResponse>;
```

- [ ] **Step 2: Export it from the package barrel**

Open `packages/types/src/index.ts`, add `export * from './google-drive.js';`
alongside the other `export * from './*.js'` lines (match existing
alphabetical-ish ordering in that file).

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @tryme/types exec tsc --noEmit -p .`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/types/src/google-drive.ts packages/types/src/index.ts
git commit -m "feat(types): add Google Drive status/export response schemas"
```

---

### Task 4: `google-drive` API module

**Files:**
- Create: `apps/api/src/modules/google-drive/drive-client.ts`
- Create: `apps/api/src/modules/google-drive/token.ts`
- Create: `apps/api/src/modules/google-drive/oauth.ts`
- Create: `apps/api/src/modules/google-drive/service.ts`
- Create: `apps/api/src/modules/google-drive/routes.ts`

- [ ] **Step 1: Write the raw Drive API client**

Create `apps/api/src/modules/google-drive/drive-client.ts`:

```ts
import { Readable } from 'node:stream';

const DRIVE_FILES_URL = 'https://www.googleapis.com/drive/v3/files';
const DRIVE_UPLOAD_URL = 'https://www.googleapis.com/upload/drive/v3/files';
const APP_FOLDER_NAME = 'AI Vastra';

/**
 * Finds the user's "AI Vastra" app folder, creating it on first use. drive.file
 * only sees files/folders this app created, so a stale folder from a previous
 * connection (post-disconnect/reconnect) is still visible and reused — avoids
 * littering the user's Drive with duplicate "AI Vastra" folders on reconnect.
 */
export async function findOrCreateAppFolder(accessToken: string): Promise<string> {
  const q = encodeURIComponent(
    `name='${APP_FOLDER_NAME}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
  );
  const listRes = await fetch(`${DRIVE_FILES_URL}?q=${q}&spaces=drive&fields=files(id)`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!listRes.ok) throw new Error(`drive folder lookup failed: ${listRes.status}`);
  const { files } = (await listRes.json()) as { files: Array<{ id: string }> };
  if (files[0]) return files[0].id;

  const createRes = await fetch(DRIVE_FILES_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ name: APP_FOLDER_NAME, mimeType: 'application/vnd.google-apps.folder' }),
  });
  if (!createRes.ok) throw new Error(`drive folder create failed: ${createRes.status}`);
  const created = (await createRes.json()) as { id: string };
  return created.id;
}

/** Multipart upload: JSON metadata part + binary content part. */
export async function uploadFile(
  accessToken: string,
  folderId: string,
  filename: string,
  contentType: string,
  content: Buffer,
): Promise<{ id: string; webViewLink: string }> {
  const boundary = `tryme-${Date.now()}`;
  const metadata = JSON.stringify({ name: filename, parents: [folderId] });
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${metadata}\r\n` +
        `--${boundary}\r\nContent-Type: ${contentType}\r\n\r\n`,
    ),
    content,
    Buffer.from(`\r\n--${boundary}--`),
  ]);

  const res = await fetch(`${DRIVE_UPLOAD_URL}?uploadType=multipart&fields=id,webViewLink`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': `multipart/related; boundary=${boundary}`,
    },
    body: Readable.from(body) as unknown as BodyInit,
    // @ts-expect-error -- Node's fetch requires duplex for a stream body; no
    // TS lib.dom type for it yet.
    duplex: 'half',
  });
  if (!res.ok) throw new Error(`drive upload failed: ${res.status}`);
  return (await res.json()) as { id: string; webViewLink: string };
}
```

- [ ] **Step 2: Write the token lifecycle module**

Create `apps/api/src/modules/google-drive/token.ts`:

```ts
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { decryptToken, encryptToken } from '../../lib/crypto.js';
import { AppError } from '../../lib/errors.js';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

type Connection = typeof schema.googleDriveConnections.$inferSelect;

function encKey(app: FastifyInstance): string {
  const key = app.env.GOOGLE_DRIVE_TOKEN_ENC_KEY;
  if (!key) throw new AppError('CONFIG', 500, 'GOOGLE_DRIVE_TOKEN_ENC_KEY missing');
  return key;
}

export async function getConnection(
  app: FastifyInstance,
  userId: string,
): Promise<Connection | undefined> {
  const [row] = await app.db
    .select()
    .from(schema.googleDriveConnections)
    .where(eq(schema.googleDriveConnections.userId, userId))
    .limit(1);
  return row;
}

/**
 * Decrypted, freshly-exchanged Drive access token for `userId`.
 *
 * Unlike Shopify's getValidAccessToken, this always exchanges (Drive access
 * tokens aren't stored — only the refresh token is persisted) rather than
 * checking a cached expiry, because export is a one-off user click, not a
 * background job worth optimizing away one token exchange for.
 */
export async function getValidDriveAccessToken(
  app: FastifyInstance,
  userId: string,
): Promise<string> {
  const row = await getConnection(app, userId);
  if (!row?.refreshTokenEnc || row.revokedAt) {
    throw new AppError('GOOGLE_DRIVE_NOT_CONNECTED', 409, 'Google Drive is not connected');
  }

  let refreshToken: string;
  try {
    refreshToken = decryptToken(row.refreshTokenEnc, encKey(app));
  } catch (err) {
    app.log.error({ err, userId }, 'drive refresh token failed to decrypt — reauth required');
    await markReauthRequired(app, row.id);
    throw new AppError('GOOGLE_DRIVE_REAUTH_REQUIRED', 403, 'Reconnect Google Drive to continue');
  }

  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: app.env.GOOGLE_CLIENT_ID ?? '',
      client_secret: app.env.GOOGLE_CLIENT_SECRET ?? '',
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });

  if (!res.ok) {
    // invalid_grant (revoked at Google, or the shared-client grant was
    // revoked by a Drive disconnect elsewhere) lands here just as much as a
    // genuinely dead token — both need the same reconnect flow.
    app.log.warn({ userId, status: res.status }, 'drive token refresh failed — reauth required');
    await markReauthRequired(app, row.id);
    throw new AppError('GOOGLE_DRIVE_REAUTH_REQUIRED', 403, 'Reconnect Google Drive to continue');
  }

  const body = (await res.json()) as { access_token: string };
  return body.access_token;
}

async function markReauthRequired(app: FastifyInstance, connectionId: string): Promise<void> {
  await app.db
    .update(schema.googleDriveConnections)
    .set({ refreshTokenEnc: null, revokedAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.googleDriveConnections.id, connectionId));
}

/** Upsert after a successful connect/reconnect. */
export async function saveConnection(
  app: FastifyInstance,
  userId: string,
  googleEmail: string,
  refreshToken: string,
  scope: string,
): Promise<void> {
  const encrypted = encryptToken(refreshToken, encKey(app));
  await app.db
    .insert(schema.googleDriveConnections)
    .values({ userId, googleEmail, refreshTokenEnc: encrypted, scope })
    .onConflictDoUpdate({
      target: schema.googleDriveConnections.userId,
      set: { googleEmail, refreshTokenEnc: encrypted, scope, revokedAt: null, updatedAt: new Date() },
    });
}

/**
 * Best-effort revoke at Google, then always clear the local credential
 * regardless of whether the HTTP call succeeded.
 *
 * Revokes the user's ENTIRE Google grant for GOOGLE_CLIENT_ID, not just
 * drive.file, because login and Drive share one OAuth client (see
 * docs/superpowers/specs/2026-08-21-google-drive-export-design.md, "Why the
 * same OAuth client"). Harmless here: auth/google.routes.ts never persists a
 * Google credential, so the only visible effect is the user's next "Continue
 * with Google" click may show Google's consent screen again instead of a
 * silent bounce. Do not "fix" this into a second OAuth client without
 * re-reading that doc.
 */
export async function disconnect(app: FastifyInstance, userId: string): Promise<void> {
  const row = await getConnection(app, userId);
  if (row?.refreshTokenEnc) {
    try {
      const refreshToken = decryptToken(row.refreshTokenEnc, encKey(app));
      const res = await fetch(GOOGLE_REVOKE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: refreshToken }),
      });
      if (!res.ok) {
        app.log.warn({ userId, status: res.status }, 'drive token revoke call failed at Google');
      }
    } catch (err) {
      app.log.warn({ err, userId }, 'drive token revoke skipped — could not decrypt');
    }
  }
  if (row) {
    await app.db
      .update(schema.googleDriveConnections)
      .set({ refreshTokenEnc: null, revokedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.googleDriveConnections.id, row.id));
  }
}
```

- [ ] **Step 3: Write the OAuth URL/exchange module**

Create `apps/api/src/modules/google-drive/oauth.ts`:

```ts
const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_USERINFO_URL = 'https://www.googleapis.com/oauth2/v3/userinfo';
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

export function buildAuthUrl(
  clientId: string,
  redirectUri: string,
  state: string,
  forceConsent: boolean,
): string {
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', DRIVE_SCOPE);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('state', state);
  // Only forced on reconnect: Google returns a refresh token on the first-ever
  // consent for this scope regardless of prompt=consent, but stays silent on
  // a repeat grant unless consent is forced — which is exactly the case where
  // markReauthRequired() has already cleared our copy and we need a new one.
  if (forceConsent) url.searchParams.set('prompt', 'consent');
  return url.toString();
}

export async function exchangeCode(
  clientId: string,
  clientSecret: string,
  redirectUri: string,
  code: string,
): Promise<{ refreshToken: string | null; scope: string; accessToken: string }> {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) throw new Error(`drive code exchange failed: ${res.status}`);
  const body = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    scope: string;
  };
  return { refreshToken: body.refresh_token ?? null, scope: body.scope, accessToken: body.access_token };
}

export async function fetchGoogleEmail(accessToken: string): Promise<string> {
  const res = await fetch(GOOGLE_USERINFO_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`drive userinfo fetch failed: ${res.status}`);
  const body = (await res.json()) as { email: string };
  return body.email.toLowerCase();
}
```

- [ ] **Step 4: Write the export service**

Create `apps/api/src/modules/google-drive/service.ts`:

```ts
import { schema } from '@tryme/db';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { AppError } from '../../lib/errors.js';
import { findOrCreateAppFolder, uploadFile } from './drive-client.js';
import { getValidDriveAccessToken } from './token.js';

export async function exportResultToDrive(
  app: FastifyInstance,
  userId: string,
  jobId: string,
): Promise<{ driveFileId: string; webViewLink: string }> {
  const [row] = await app.db
    .select({ resultKey: schema.jobOutputs.resultKey })
    .from(schema.jobs)
    .innerJoin(schema.jobOutputs, eq(schema.jobOutputs.jobId, schema.jobs.id))
    .where(and(eq(schema.jobs.id, jobId), eq(schema.jobs.userId, userId)))
    .limit(1);
  if (!row?.resultKey) throw new AppError('NOT_FOUND', 404, 'result not found');

  const accessToken = await getValidDriveAccessToken(app, userId);
  const content = await app.storage.getObject(row.resultKey);
  const folderId = await findOrCreateAppFolder(accessToken);
  const filename = `tryme-${jobId.slice(0, 8)}.jpg`;

  try {
    const uploaded = await uploadFile(accessToken, folderId, filename, 'image/jpeg', content);
    return { driveFileId: uploaded.id, webViewLink: uploaded.webViewLink };
  } catch (err) {
    app.log.error({ err, userId, jobId }, 'drive export failed');
    throw new AppError('GOOGLE_DRIVE_EXPORT_FAILED', 502, 'Could not save to Google Drive');
  }
}
```

- [ ] **Step 5: Write the routes**

Create `apps/api/src/modules/google-drive/routes.ts`:

```ts
import { randomBytes } from 'node:crypto';
import { GoogleDriveExportResponse, GoogleDriveStatusResponse } from '@tryme/types';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { buildAuthUrl, exchangeCode, fetchGoogleEmail } from './oauth.js';
import { exportResultToDrive } from './service.js';
import { disconnect, getConnection, saveConnection } from './token.js';

export async function googleDriveRoutes(app: FastifyInstance) {
  if (!app.env.GOOGLE_CLIENT_ID || !app.env.GOOGLE_CLIENT_SECRET) {
    app.log.warn('Google OAuth not configured — /v1/integrations/google-drive/* routes disabled');
    return;
  }
  const clientId = app.env.GOOGLE_CLIENT_ID;
  const clientSecret = app.env.GOOGLE_CLIENT_SECRET;
  const redirectUri = new URL(
    '/v1/integrations/google-drive/callback',
    app.env.GOOGLE_CALLBACK_URL ?? app.env.WEB_URL,
  ).toString();

  app.get(
    '/v1/integrations/google-drive/connect',
    { preHandler: app.requireUser },
    async (req, reply) => {
      const state = randomBytes(32).toString('base64url');
      await app.redis.set(`gdrive:oauth:state:${state}`, req.userId, 'EX', 300);
      const [row] = await getConnection(app, req.userId).then((c) => [c]);
      const forceConsent = Boolean(row?.revokedAt);
      return reply.redirect(buildAuthUrl(clientId, redirectUri, state, forceConsent), 302);
    },
  );

  app.get('/v1/integrations/google-drive/callback', async (req, reply) => {
    const { code, state } = req.query as { code?: string; state?: string };
    const failRedirect = (reason: string) => {
      const url = new URL('/studio', app.env.WEB_URL);
      url.searchParams.set('drive_error', reason);
      return reply.redirect(url.toString(), 302);
    };
    if (!code || !state) return failRedirect('invalid_request');

    const userId = await app.redis.getdel(`gdrive:oauth:state:${state}`);
    if (!userId) return failRedirect('invalid_state');

    try {
      const { refreshToken, scope, accessToken } = await exchangeCode(
        clientId,
        clientSecret,
        redirectUri,
        code,
      );
      if (!refreshToken) return failRedirect('no_refresh_token');
      const email = await fetchGoogleEmail(accessToken);
      await saveConnection(app, userId, email, refreshToken, scope);
    } catch (err) {
      app.log.error({ err }, 'drive connect callback failed');
      return failRedirect('exchange_failed');
    }

    const url = new URL('/studio', app.env.WEB_URL);
    url.searchParams.set('drive_connected', '1');
    return reply.redirect(url.toString(), 302);
  });

  app.get(
    '/v1/integrations/google-drive/status',
    { preHandler: app.requireUser },
    async (req): Promise<GoogleDriveStatusResponse> => {
      const row = await getConnection(app, req.userId);
      if (!row || !row.refreshTokenEnc) {
        return {
          status: row?.revokedAt ? 'REAUTH_REQUIRED' : 'NOT_CONNECTED',
          googleEmail: row?.googleEmail ?? null,
        };
      }
      return { status: 'CONNECTED', googleEmail: row.googleEmail };
    },
  );

  app.post(
    '/v1/integrations/google-drive/disconnect',
    { preHandler: app.requireUser },
    async (req) => {
      await disconnect(app, req.userId);
      return { ok: true };
    },
  );

  app.post(
    '/v1/jobs/:id/export/google-drive',
    { preHandler: app.requireUser, schema: { params: z.object({ id: z.string().uuid() }) } },
    async (req): Promise<GoogleDriveExportResponse> => {
      const { id } = req.params as { id: string };
      return exportResultToDrive(app, req.userId, id);
    },
  );
}
```

- [ ] **Step 6: Typecheck the API package**

Run: `pnpm --filter @tryme/api run typecheck`
Expected: no errors. (If the `duplex: 'half'` cast in `drive-client.ts`
still errors under this repo's TS/lib target, drop the multipart stream body
in favor of passing `content` — the `Buffer` — directly as `body` instead of
wrapping it in `Readable.from`; `fetch`'s `BodyInit` accepts a `Buffer`
directly and the `duplex` workaround becomes unnecessary. Prefer that
simpler form if it typechecks cleanly — do not fight the stream typing for
its own sake.)

- [ ] **Step 7: Commit**

```bash
git add apps/api/src/modules/google-drive/
git commit -m "feat(api): add Google Drive export module (connect/callback/status/disconnect/export)"
```

---

### Task 5: Register the routes and add the account-deletion hook

**Files:**
- Modify: `apps/api/src/server.ts`
- Modify: `apps/api/src/modules/admin/users.routes.ts`

- [ ] **Step 1: Register the module**

Open `apps/api/src/server.ts`. Add the import near the other module imports
(alongside `import { resultsRoutes } from './modules/results/routes.js';` at
line 75):

```ts
import { googleDriveRoutes } from './modules/google-drive/routes.js';
```

Find (`server.ts:360-361`):

```ts
  await app.register(jobsRoutes);
  await app.register(merchantCatalogRoutes);
```

Replace with:

```ts
  await app.register(jobsRoutes);
  await app.register(googleDriveRoutes);
  await app.register(merchantCatalogRoutes);
```

- [ ] **Step 2: Hook Drive revoke into `eraseUser`**

Open `apps/api/src/modules/admin/users.routes.ts`. Add the import at the top
of the file alongside the other module imports:

```ts
import { disconnect as disconnectGoogleDrive } from '../google-drive/token.js';
```

Find (`users.routes.ts:407-409`):

```ts
        .where(eq(schema.users.id, id));

      await tx.delete(schema.oauthAccounts).where(eq(schema.oauthAccounts.userId, id));
```

Replace with:

```ts
        .where(eq(schema.users.id, id));

      await tx.delete(schema.oauthAccounts).where(eq(schema.oauthAccounts.userId, id));
      // Revoke before delete: dropping the row is not the same as revoking
      // authorization at Google. Runs against app.db directly (not tx) since
      // it's an external HTTP call — deliberately outside the transaction so
      // a Google outage can't roll back the erasure of PII we're obligated
      // to remove regardless. disconnect() clears the row itself.
      await disconnectGoogleDrive(app, id);
```

- [ ] **Step 3: Typecheck**

Run: `pnpm --filter @tryme/api run typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add apps/api/src/server.ts apps/api/src/modules/admin/users.routes.ts
git commit -m "feat(api): register google-drive routes, revoke Drive grant on user erasure"
```

---

### Task 6: Integration tests

**Files:**
- Create: `apps/api/test/integration/google-drive.test.ts`

- [ ] **Step 1: Write the test file**

Follow the harness conventions in `apps/api/test/helpers/containers.ts` /
`apps/api/test/helpers/api.ts` (fresh DB + MinIO bucket per file,
`buildTestApp()`). Mock every Google/Drive HTTP call via a `fetch`
injection — `modules/shopify/token.ts`'s `refreshAccessToken`/
`exchangeSessionToken` already establish the `fetchImpl` pattern for this;
since `oauth.ts`/`token.ts`/`drive-client.ts` above call the global `fetch`
directly rather than taking an injected one, either (a) add the same
optional `fetchImpl` parameter to each exported function there before
writing these tests, mirroring Shopify's shape exactly, or (b) stub global
`fetch` for the duration of each test (`vi.stubGlobal('fetch', ...)`,
restored in `afterEach`) — prefer (a) for consistency with the existing
Shopify module unless it meaningfully bloats the module's signatures.

Cover:
- `POST /v1/jobs/:id/export/google-drive` with no connection row → 409
  `GOOGLE_DRIVE_NOT_CONNECTED`.
- Same route for a job belonging to a different user → 404.
- Happy path: seed a `google_drive_connections` row with a real
  `encryptToken`-encrypted refresh token, mock the token-exchange and
  `files.list`/`files.create` calls, assert `{ driveFileId, webViewLink }`
  is returned and matches the mocked response.
- Token refresh returning a non-OK status → row's `revokedAt` gets set,
  route returns 403 `GOOGLE_DRIVE_REAUTH_REQUIRED`.
- `POST /v1/integrations/google-drive/disconnect` → mocked revoke endpoint
  is called with the decrypted token, row's `refreshTokenEnc` becomes null
  and `revokedAt` is set.
- `GET /v1/integrations/google-drive/status` → correctly reports
  `NOT_CONNECTED` / `CONNECTED` / `REAUTH_REQUIRED` for the three row states.
- `eraseUser` (via the existing admin delete-user test file, or a new case
  in it): erasing a user with an active connection calls the mocked revoke
  endpoint and leaves no decryptable `refreshTokenEnc`.

- [ ] **Step 2: Run the new file**

From `apps/api/`, temporarily lift the integration exclude (per this repo's
`vitest.config.ts` gotcha — `exclude: ['test/integration/**', ...]` blocks
even explicit file args):

```bash
node -e "const fs=require('fs');const p='vitest.config.ts';const s=fs.readFileSync(p,'utf8');fs.writeFileSync(p+'.bak',s);fs.writeFileSync(p,s.replace(\"'test/integration/**', \",''))"
npx vitest run test/integration/google-drive.test.ts
```

Expected: all tests PASS.

- [ ] **Step 3: Revert the temporary config edit**

Run: `mv vitest.config.ts.bak vitest.config.ts` (from `apps/api/`), then
`git diff --stat vitest.config.ts` from repo root — expect no output.

- [ ] **Step 4: Commit**

```bash
git add apps/api/test/integration/google-drive.test.ts
git commit -m "test(api): cover google-drive connect/export/disconnect/erasure lifecycle"
```

---

### Task 7: Studio UI — status hook and "Save to Drive" button

**Files:**
- Create: `apps/catalogues-web/src/hooks/use-google-drive-status.ts`
- Modify: `apps/catalogues-web/src/components/icons.tsx`
- Modify: `apps/catalogues-web/src/app/(app)/studio/generation-panel.tsx`

- [ ] **Step 1: Add the status hook**

Create `apps/catalogues-web/src/hooks/use-google-drive-status.ts`:

```ts
import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

export interface GoogleDriveStatus {
  status: 'NOT_CONNECTED' | 'CONNECTED' | 'REAUTH_REQUIRED';
  googleEmail: string | null;
}

export function useGoogleDriveStatus() {
  return useQuery({
    queryKey: ['google-drive-status'],
    queryFn: () => api.get<GoogleDriveStatus>('/v1/integrations/google-drive/status'),
    staleTime: 60_000,
  });
}
```

- [ ] **Step 2: Add a Drive icon**

Open `apps/catalogues-web/src/components/icons.tsx`. Find the
`DownloadIcon` definition (line 98) and add a new icon immediately after its
closing `);`:

```tsx
export const DriveIcon = ({ size = 14 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
    <path
      d="M8 3h8l6 10.5-4 7H6l-4-7L8 3z"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinejoin="round"
    />
    <path d="M8 3l8 14M16 3l-8 14M4 13.5h16" stroke="currentColor" strokeWidth="1.6" />
  </svg>
);
```

(Placeholder glyph — swap for whatever icon set/asset the design pass
prefers; not load-bearing for the feature.)

- [ ] **Step 3: Wire the button into the per-result actions**

Open `generation-panel.tsx`. Add the import and hook:

Find (line 5-9):

```ts
import { DownloadIcon, FullscreenIcon, SpinnerIcon, XIcon } from '@/components/icons';
import { C } from '@/components/tokens';
import { useJobStream } from '@/hooks/use-job-stream';
import { api } from '@/lib/api';
import { downloadErrorMessage } from '@/lib/errors';
```

Replace with:

```ts
import { DownloadIcon, DriveIcon, FullscreenIcon, SpinnerIcon, XIcon } from '@/components/icons';
import { C } from '@/components/tokens';
import { useGoogleDriveStatus } from '@/hooks/use-google-drive-status';
import { useJobStream } from '@/hooks/use-job-stream';
import { api } from '@/lib/api';
import { downloadErrorMessage } from '@/lib/errors';
```

Find the `hideDownload` prop (lines 29-30) and add a sibling prop:

```ts
  /** Hides the "Download All" button and each result tile's download icon. */
  hideDownload?: boolean;
```

Replace with:

```ts
  /** Hides the "Download All" button and each result tile's download icon. */
  hideDownload?: boolean;
  /** Hides the "Save to Drive" action on each result tile. */
  hideGoogleDrive?: boolean;
```

Thread the new prop through the destructured props list (line 62-67,
alongside `hideDownload`), and add the export handler next to
`downloadImage` (after line 206):

```ts
  const driveStatus = useGoogleDriveStatus();
  const [exportingToDrive, setExportingToDrive] = useState<string | null>(null);

  async function saveToDrive(jobId: string) {
    if (exportingToDrive) return;
    if (driveStatus.data?.status !== 'CONNECTED') {
      window.location.href = '/api/integrations/google-drive/connect';
      return;
    }
    setExportingToDrive(jobId);
    try {
      await api.post(`/v1/jobs/${jobId}/export/google-drive`, {});
    } catch (e) {
      alert(e instanceof Error ? e.message : 'Could not save to Google Drive. Try again.');
    } finally {
      setExportingToDrive(null);
    }
  }
```

Then add a button next to the existing per-tile download icon (the block at
lines 837-868 — insert immediately after that button's closing `)}` and
before `{onUseImage && ...}` at line 869):

```tsx
                    {!hideGoogleDrive && (
                      <button
                        type="button"
                        disabled={!isCompleted || !resultUrl || exportingToDrive === job.id}
                        onClick={(e) => {
                          e.stopPropagation();
                          saveToDrive(job.id);
                        }}
                        title="Save to Drive"
                        style={{
                          position: 'absolute',
                          top: 8,
                          right: 40,
                          width: 28,
                          height: 28,
                          borderRadius: 6,
                          border: `1px solid ${C.border}`,
                          background: '#fff',
                          display: 'grid',
                          placeItems: 'center',
                          cursor: isCompleted && resultUrl ? 'pointer' : 'not-allowed',
                          opacity: isCompleted && resultUrl ? 1 : 0.5,
                          zIndex: 2,
                        }}
                      >
                        {exportingToDrive === job.id ? (
                          <SpinnerIcon size={14} />
                        ) : (
                          <DriveIcon size={14} />
                        )}
                      </button>
                    )}
```

(The `top`/`right`/`width`/`height` values above are placeholders to sit
beside the existing download icon at line 837-868 — read that block's actual
current positioning before finalizing so the two icons don't overlap; this
plan intentionally doesn't hand-guess exact pixel offsets it hasn't
re-verified against the file as edited so far in this task.)

- [ ] **Step 4: Handle the `drive_connected` / `drive_error` return params**

The OAuth callback (Task 4, Step 5) redirects back to `/studio` with
`?drive_connected=1` or `?drive_error=<reason>`. Wherever the Studio page
component reads its search params on mount (check
`apps/catalogues-web/src/app/(app)/studio/page.tsx` for its existing
`useSearchParams`/effect pattern, if any — otherwise add one), invalidate
the `['google-drive-status']` react-query key on `drive_connected=1` so the
button immediately reflects `CONNECTED`, and surface `drive_error` via
whatever toast/alert convention that page already uses.

- [ ] **Step 5: Typecheck and lint the web app**

Run: `pnpm --filter @tryme/web run typecheck` and
`pnpm --filter @tryme/web run lint`
Expected: no errors.

- [ ] **Step 6: Manual verification**

Start the app (`pnpm --filter @tryme/api dev` and
`pnpm --filter @tryme/web dev`), generate a result in Studio, click
"Save to Drive": confirm it redirects through Google consent on first use,
lands back on Studio connected, and a second click uploads the result into
an "AI Vastra" folder in a real test Google account. Disconnect (add a
disconnect entry point wherever account/settings actions live — e.g.
`apps/catalogues-web/src/app/(app)/settings/page.tsx`, per its existing
`download`-related settings section found earlier — and confirm export then
409s until reconnected).

- [ ] **Step 7: Commit**

```bash
git add apps/catalogues-web/src/hooks/use-google-drive-status.ts apps/catalogues-web/src/components/icons.tsx apps/catalogues-web/src/app/\(app\)/studio/generation-panel.tsx
git commit -m "feat(web): add Save to Drive action to Studio results"
```

---

### Task 8: External, non-code setup (do before Task 7's manual verification)

- [ ] In Google Cloud Console, add
  `https://<api-host>/v1/integrations/google-drive/callback` (and the
  staging equivalent) as an authorized redirect URI on the **existing**
  OAuth client (`GOOGLE_CLIENT_ID`) — no new client.
- [ ] Confirm the OAuth consent screen has `drive.file` added to its scope
  list and is in "Production" publishing status (or the feature only works
  for allow-listed test users while in "Testing"). `drive.file` only needs
  Google's basic verification tier, not the sensitive/restricted flow.
- [ ] Generate and set `GOOGLE_DRIVE_TOKEN_ENC_KEY` in each environment
  (`openssl rand -base64 32`), same as `SHOPIFY_TOKEN_ENC_KEY` was
  provisioned.

---

## Self-review

- **Placeholders:** the per-tile button's exact pixel offsets (Task 7, Step
  3) and the settings-page disconnect entry point (Task 7, Step 6) are
  explicitly flagged as needing a fresh read of the file at implementation
  time rather than guessed — everything else (route paths, schema, crypto
  reuse, migration number, preHandler name, storage return type, absence of
  a `googleapis` dependency) was confirmed against the current repo this
  session.
- **Scope:** matches the design doc exactly — one table, one env var, one
  new API module, one hook into `eraseUser`, one Studio button. No batch
  export, no refresh-lock, no changes to `auth/google.routes.ts`.
- **Backward compatibility:** every change is additive; a user who never
  clicks "Save to Drive" never creates a `google_drive_connections` row and
  sees no behavior change.
