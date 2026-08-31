# Custom Background Upload (User Personal Library)

## Goal

Let a user add their own background image to the Studio wizard's "Create your own look" background step (Step 2, custom mode only) — either by uploading a file directly or pasting an image URL. The background becomes part of that user's private personal library: visible and selectable only by them, never shown in the admin-curated pool or to other users. Template mode, the widget, and admin-curated backgrounds are untouched.

## Data model

No new table. Extend `model_backgrounds` (`packages/db/src/schema/models.ts`), reusing the existing `scope` column (currently `'general' | 'template'`) with a new value `'user'`, plus a nullable owner column:

```sql
ALTER TABLE model_backgrounds ADD COLUMN user_id uuid REFERENCES users(id) ON DELETE CASCADE;
CREATE INDEX model_backgrounds_user_id_idx ON model_backgrounds(user_id) WHERE user_id IS NOT NULL;
```

Rationale: `scope='template'` already exists for exactly this shape of problem (a background owned by and visible only within one context, hidden from the general admin-curated pool and from "create your own look"). `scope='user'` is the same pattern with `user_id` as the owner instead of a template.

Rows: `label`, `r2Key`, `thumbnailKey`, `isActive=true`, `scope='user'`, `userId`. `bgComfyR2Key`, `categoryId`, `tags`, `specialTag`, `genderSlug`, `isWhiteBg` stay null/default — none of these are read for user-scoped rows.

No dispatcher changes: `apps/dispatcher/src/job/processor.ts:212-217` resolves `backgroundId → r2Key` with a plain `where(eq(id, ...))`, no scope/owner filter, and doesn't touch `bgComfyR2Key` (legacy, unused — see comment at `processor.ts:346`). A user-scoped row resolves identically to a curated one.

No change needed to `GET /v1/models/backgrounds` — it already hard-filters `eq(scope, 'general')` (`apps/api/src/modules/models/routes.ts:121`), so `scope='user'` rows are invisible there for free.

## Storage

Add to `packages/storage/src/keys.ts`:

```typescript
userBackground: (userId: string, id: string) => `user-backgrounds/${userId}/${id}.jpg`,
userBackgroundThumb: (userId: string, id: string) => `user-backgrounds/${userId}/${id}.thumb.jpg`,
```

## API — new module `apps/api/src/modules/backgrounds/routes.ts`, mounted in `server.ts`

All routes `preHandler: app.requireUser`.

- `GET /v1/backgrounds/mine` — list caller's own backgrounds (`scope='user' AND userId=req.userId AND deletedAt IS NULL`, ordered `createdAt desc`). Same response shape as `/v1/models/backgrounds` items (`id`, `label`, `thumbnailUrl`).

- `POST /v1/backgrounds/mine/presign` — body `{ contentType, contentLength }` (reuse `PresignUploadBody` shape from `@tryme/types`). Generates `id = randomUUID()`, `r2Key = keys.userBackground(req.userId, id)`, presigns a PUT (10MB cap, 300s expiry — mirrors admin background presign). Binds `upload:owner:{r2Key} = req.userId` in Redis (24h TTL), same H2 pattern as `uploads/routes.ts`. Returns `{ uploadUrl, r2Key, id, expiresIn }`.

- `POST /v1/backgrounds/mine/confirm` — body `{ r2Key, label? }`. Verifies `upload:owner:{r2Key}` in Redis equals `req.userId` (rejects otherwise — same ownership-binding check as garment uploads). Reads the uploaded object, generates a thumbnail server-side via the existing `makeThumb` helper (do not trust a client-supplied thumbnail), uploads it to `keys.userBackgroundThumb(...)`, inserts the `model_backgrounds` row (`scope:'user'`, `userId: req.userId`, `label: body.label ?? 'My background'`). Returns the created item in the same shape as the list endpoint.

- `POST /v1/backgrounds/mine/from-url` — body `{ url, label? }`. Server-side fetch, validate, store — see Security section below for the fetch guard. On success: uploads original + generated thumbnail to R2 under the same `keys.userBackground(...)` paths, inserts the row identically to `confirm`. On any validation failure, return a 400 with a specific reason (`INVALID_URL`, `BLOCKED_HOST`, `NOT_AN_IMAGE`, `TOO_LARGE`, `FETCH_FAILED`) — no partial R2 write on failure.

- `DELETE /v1/backgrounds/mine/:id` — soft delete (`deletedAt = now()`). 404 if the row doesn't exist or `userId !== req.userId` (do not distinguish "not found" from "not yours" in the response — avoids leaking existence of other users' rows).

## Required change to existing code — ownership gate in job creation

`apps/api/src/modules/jobs/create.ts` currently validates every distinct `backgroundId` against `model_backgrounds` with only `isActive=true` (~line 307-312). With user-owned rows now living in the same table, this must become:

```typescript
and(
  inArray(schema.modelBackgrounds.id, distinctBackgroundIds),
  eq(schema.modelBackgrounds.isActive, true),
  or(
    eq(schema.modelBackgrounds.scope, 'general'),
    and(eq(schema.modelBackgrounds.scope, 'user'), eq(schema.modelBackgrounds.userId, req.userId)),
  ),
)
```

Without this, a user could reference another user's private background by guessing/observing its UUID (e.g. from a shared/public result image). This is the one existing file this feature must touch.

## Security — SSRF guard on `from-url`

The API server fetches an arbitrary user-supplied URL — this needs a real guard, not a try/catch:

- Scheme allowlist: `http`/`https` only.
- Resolve DNS before connecting; reject if the resolved IP falls in a private/loopback/link-local/metadata range (`127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, and IPv6 equivalents `::1`, `fc00::/7`, `fe80::/10`). Validate the IP actually connected to, not just the pre-DNS hostname (guards against DNS rebinding).
- Do not auto-follow redirects to an unvalidated host — if a redirect is returned, re-run the same host/IP validation on the redirect target before following (or simply refuse redirects; either is acceptable, implementer's call, capped at one hop if followed).
- Size cap ~15MB on the download; abort over that. Request timeout (~10s).
- Validate `Content-Type` is an actual allowed image type (`image/jpeg`, `image/png`, `image/webp`) from the response, not trusted from the URL string or client claim; sniff actual bytes via `sharp`'s metadata read (same library already used for `makeThumb`) rather than trusting the header alone.

## Frontend — `apps/catalogues-web/src/app/(app)/studio/page.tsx`, Step 2 (custom mode only)

New "My backgrounds" section rendered above the existing curated background grid, only when `catalogueTemplateId === 'custom'`:

- `useQuery(['backgrounds', 'mine'], ...)` against `GET /v1/backgrounds/mine`.
- "Upload image" control: request presign → `PUT` the file directly to R2 (identical pattern to the existing garment upload in this same file) → call `confirm` → invalidate `['backgrounds', 'mine']` → auto-select the new background (`setBackgroundId`).
- "Paste URL" control: a text input + submit button → call `from-url` directly (single request, server does the fetch) → same invalidate + auto-select on success. Show a loading state — the server-side fetch can take a few seconds.
- Each tile in "My backgrounds" gets a small delete (trash) affordance → `DELETE /v1/backgrounds/mine/:id` → invalidate `['backgrounds', 'mine']`; if the deleted background was the currently selected `backgroundId`, clear the selection.
- Errors (bad URL, not an image, too large) surface as a toast with the specific reason from the API.

## Testing

New integration test file (e.g. `apps/api/test/integration/backgrounds-mine.test.ts`):

- Presign → confirm happy path: row created with correct `scope`/`userId`, appears in `GET /v1/backgrounds/mine`, invisible in `GET /v1/models/backgrounds`.
- `confirm` rejects an `r2Key` not owned by the caller (no Redis binding, or bound to a different user).
- `from-url` happy path with a small test-fixture image served from a local test HTTP server.
- `from-url` rejects: non-image content-type, oversized response, and a URL resolving to a private IP (e.g. `http://127.0.0.1/...` or `http://169.254.169.254/...`).
- `DELETE` — owner can delete; a different user gets 404, not 403 (existence not leaked); deleted row excluded from subsequent `GET /v1/backgrounds/mine`.
- `jobs/create.ts` — a job can reference the caller's own `scope='user'` background; referencing another user's `scope='user'` background is rejected the same way an inactive/nonexistent background ID is today.

## Out of scope

Widget flow, template-mode looks, admin panel changes, and any change to `bgComfyR2Key` handling (confirmed unused/legacy in the dispatcher).
