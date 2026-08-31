# Google Drive Export Design

## Summary

Studio results (`apps/catalogues-web`'s generation panel and preview panel)
currently only support **Download** — fetch the presigned result URL as a
blob and save it via a synthetic `<a download>` click
(`generation-panel.tsx:186-206`, `230-239`). This adds a second export
target, **Save to Drive**, alongside it: a per-result button that uploads the
already-generated image directly from R2/MinIO into the user's Google Drive,
without a browser-side download/re-upload round trip.

Demand for this has been confirmed (see conversation history / product
input) — this spec is cleared to move to implementation. It does **not**
change or touch the existing `/v1/auth/google/*` login flow
(`apps/api/src/modules/auth/google.routes.ts`), which keeps requesting only
`openid email profile` and keeps discarding the Google access token after
reading userinfo. Drive access is a separate, opt-in per-user integration on
top of that, reusing the same Google OAuth **client** but a completely
independent authorization grant flow.

## Why a separate module, not an extension of `auth/google.routes.ts`

- The login flow is intentionally stateless with respect to Google: it never
  persists a Google token today (`google.routes.ts:120-121` fetches the
  access token, uses it once for userinfo, and drops it). Bolting
  `access_type=offline` onto that flow would start persisting a Google
  refresh token for every user who has ever logged in with Google, whether
  or not they want Drive — unnecessary blast radius and an unconditional new
  secret at rest.
- Drive is opt-in, per-feature, and revocable independently of the user's
  ability to log in. A separate `google-drive` module with its own
  connect/callback/disconnect routes keeps that lifecycle isolated, mirroring
  how `modules/shopify/token.ts` is already a self-contained
  credential-lifecycle module next to (not inside) `modules/shopify/auth.routes.ts`.

## Why the same OAuth client, not a second one

Reuses the existing `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET`
(`env.ts:51-53`) — only a second redirect URI needs registering in the
Google Cloud Console (external, one-time action). A second OAuth client
would avoid the shared-grant caveat below, but at the cost of a second
consent screen to configure and a second credential pair to manage
indefinitely, for a risk that is cosmetic in this codebase (see Disconnect
below). Not worth it here.

**Caveat to carry into the disconnect implementation, not work around:**
Google consolidates all scopes ever granted to one `client_id` by one user
into a single grant record. Revoking the Drive refresh token revokes that
*entire* grant, including whatever the login flow holds under the same
client for that user. Since the login flow never persists a Google
credential, the only visible effect is that the user's *next* "Continue with
Google" click may show Google's consent screen again instead of a silent
bounce — not an application failure. This must be a comment at the
revocation call site (see Disconnect below) so a future engineer doesn't
"fix" it into a second OAuth client without knowing why it was one.

## Non-goals

- No change to `/v1/auth/google/*` scope, token handling, or session
  behavior — confirmed unaffected.
- No batch/"export whole catalogue to a Drive folder" flow yet. Single-image
  export only. Batch is the natural v2 (see Open implementation details) but
  adds concurrent-refresh handling this v1 doesn't need.
- No per-store/merchant Drive connections (Shopify side) — this is scoped to
  the `apps/catalogues-web` Studio result panel and its authenticated
  `users` rows only.
- No proactive/background token refresh job. Drive access tokens are
  refreshed on demand at export time (same shape as
  `getValidAccessToken` in `modules/shopify/token.ts`, minus the
  proactive-refresh-before-expiry path — Drive exports are user-initiated
  clicks, not a background sync that needs a warm token).
- No new encryption implementation — reuses `encryptToken`/`decryptToken`
  from `apps/api/src/lib/crypto.ts` unchanged.

## Data model changes

### New table: `google_drive_connections` (new file `packages/db/src/schema/google-drive.ts`, exported from `schema/index.ts`)

| Column | Type | Purpose |
|---|---|---|
| `id` | `uuid primary key default random` | |
| `userId` | `uuid not null unique → users.id, on delete cascade` | One active connection per user. Unique enforces "connect" always upserts rather than accumulating rows. |
| `googleEmail` | `text not null` | Display-only — "Connected as x@gmail.com" in the UI. |
| `refreshTokenEnc` | `text` | `encryptToken(refreshToken, GOOGLE_DRIVE_TOKEN_ENC_KEY)`. Nullable so a revoked/disconnected row can clear the ciphertext without deleting the row (keeps `googleEmail`/history for the status UI to explain *why* it's asking to reconnect). |
| `scope` | `text not null` | Raw scope string Google returned — `drive.file` today, forward-compatible if it ever grows. |
| `createdAt` / `updatedAt` | `timestamp with time zone` | |
| `revokedAt` | `timestamp with time zone`, nullable | Set on disconnect or on a detected `invalid_grant`. Null = connected. |

No FK from any `jobs`/`job_outputs` row to this table — the export route
looks the connection up by `userId` at request time, same as every other
per-user credential in this schema.

### New env vars (`apps/api/src/env.ts`, next to `SHOPIFY_TOKEN_ENC_KEY` at line 78)

```ts
GOOGLE_DRIVE_TOKEN_ENC_KEY: z.string().optional(), // 32 bytes, base64 — same shape as SHOPIFY_TOKEN_ENC_KEY
```

`GOOGLE_CLIENT_ID`/`GOOGLE_CLIENT_SECRET` are reused as-is; no new client
credentials.

## API changes

New module `apps/api/src/modules/google-drive/`:

- `google-drive.oauth.ts` — auth-URL construction and code-exchange, mirrors
  the shape of `auth/google.routes.ts`'s init/callback pair but with
  `scope=https://www.googleapis.com/auth/drive.file`,
  `access_type=offline`, and **no** unconditional `prompt=consent` (Google
  only omits the refresh token on a repeat grant; the first-ever consent for
  this scope always returns one). `prompt=consent` is passed only when
  `/connect` is called while the existing row is in `REAUTH_REQUIRED` —
  forcing re-consent is what recovers a refresh token when Google didn't
  hand one back silently.
- `google-drive.token.ts` — `getValidDriveAccessToken(app, userId)`: reads
  the row, decrypts, exchanges the refresh token for a fresh access token
  via `https://oauth2.googleapis.com/token` (`grant_type=refresh_token`) if
  needed. A decrypt failure or an `invalid_grant` response both map to the
  same outcome as Shopify's `decryptStoredToken`
  (`modules/shopify/token.ts:250-264`): stop, mark `revokedAt`, surface
  `GOOGLE_DRIVE_REAUTH_REQUIRED` (403) rather than a bare crypto error.
- `google-drive.service.ts` — `exportResultToDrive(app, userId, jobId)`:
  looks up `job_outputs.resultKey` for a job owned by `userId`, reads it via
  `app.storage.getObject(key)` (same call `results/routes.ts` already makes
  through `presignGet` for the read path — this uses the direct
  stream/buffer read instead of presigning, since the bytes go straight to
  Google, never through the browser), finds-or-creates an "AI Vastra" folder
  in the user's Drive (`files.list` with `q: name='AI Vastra' and
  mimeType='application/vnd.google-apps.folder' and trashed=false`, create
  if absent), then `files.create` with that folder as parent.
- `google-drive.routes.ts` — registers:

  | Route | Auth | Purpose |
  |---|---|---|
  | `GET /v1/integrations/google-drive/connect` | session cookie (existing user auth) | Redirects to Google's consent screen. |
  | `GET /v1/integrations/google-drive/callback` | state param round-trip, same CSRF-state-cookie pattern as `google.routes.ts:34-46` | Exchanges code, encrypts + upserts the row, redirects back into Studio. |
  | `GET /v1/integrations/google-drive/status` | session cookie | `{ status: 'NOT_CONNECTED' \| 'CONNECTED' \| 'REAUTH_REQUIRED', googleEmail?: string }` — one collapsed status field, per the UI states discussion; internal revoked/expired/invalid_grant distinctions stay server-side. |
  | `POST /v1/integrations/google-drive/disconnect` | session cookie | See Disconnect below. |
  | `POST /v1/jobs/:id/export/google-drive` | session cookie, job ownership check (same `userId` match every other job route already does) | Runs `exportResultToDrive`. 404 if the job isn't the caller's or has no completed output; `GOOGLE_DRIVE_NOT_CONNECTED` (409) if there's no active connection; `GOOGLE_DRIVE_REAUTH_REQUIRED` (403) on a dead refresh token. Returns `{ driveFileId, webViewLink }` on success. |

Registered in `apps/api/src/server.ts` next to the other feature modules
(e.g. after `jobsRoutes` at line 360) as `await
app.register(googleDriveRoutes)`.

### Disconnect (`POST /v1/integrations/google-drive/disconnect`)

```
1. Load the connection row for userId.
2. If refreshTokenEnc present: decryptToken(), then
   POST https://oauth2.googleapis.com/revoke — best-effort (log, don't
   fail the request, on network/4xx error: Google may already consider it
   invalid).
   // Revokes the user's ENTIRE Google grant for GOOGLE_CLIENT_ID, not just
   // drive.file, because login and Drive share one OAuth client — see
   // "Why the same OAuth client" above. Harmless here because
   // auth/google.routes.ts never persists a Google credential; at worst the
   // user's next Google login re-shows Google's consent screen.
3. Regardless of step 2's outcome: refreshTokenEnc = NULL, revokedAt = NOW().
4. Never return the token (encrypted or not) to the browser at any point in
   this flow.
```

### Account deletion (`eraseUser` in `apps/api/src/modules/admin/users.routes.ts:371-433`)

Add, alongside the existing `oauthAccounts` deletion at line 409: before (or
immediately inside) the same transaction, select the user's
`google_drive_connections` row and — if `refreshTokenEnc` is set — run the
same best-effort Google revoke as Disconnect, then `tx.delete(...)` the row.
GDPR erasure must not silently leave a live Drive grant referencing a
"deleted" user; DB row deletion is not the same thing as authorization
revocation.

## Studio UI changes (`apps/catalogues-web`)

- `generation-panel.tsx` / `preview-panel.tsx`: a "Save to Drive" affordance
  next to the existing per-result download icon (line ~838-868) and next to
  "Download All" (line ~709-737), following `hideDownload`'s existing prop
  convention — add `hideGoogleDrive` so embedded contexts (Shopify plugin
  iframe, per `hideCatalogueLink`'s precedent) can suppress it the same way.
- Button states, driven by `GET /v1/integrations/google-drive/status`
  (fetched once per Studio session, react-query cached):
  - `NOT_CONNECTED` → "Save to Drive" → click starts
    `/v1/integrations/google-drive/connect` in a popup/redirect (same
    popup-based pattern the account-link Google flow already uses, per
    `google.routes.ts:29-33`'s COOP header comment), then on return calls
    the export.
  - `CONNECTED` → "Save to Drive" → directly calls
    `POST /v1/jobs/:id/export/google-drive`.
  - `REAUTH_REQUIRED` → "Reconnect Drive" → same connect flow, server adds
    `prompt=consent`.
- No new design tokens — reuse `C` from `components/tokens.ts` per the
  existing convention; no raw hex.

## Testing

- `google-drive.oauth.ts` / `.token.ts`: unit tests for auth-URL
  construction (correct scope/access_type/prompt-consent conditionality),
  and the refresh-exchange path including the `invalid_grant` →
  `REAUTH_REQUIRED` mapping (mirrors the existing
  `modules/shopify/token.ts` test coverage shape).
- Integration test for `POST /v1/jobs/:id/export/google-drive`: 403 with no
  connection, 403 for a job owned by a different user, success path with a
  mocked Drive `files.create` (same `fetchImpl` injection pattern already
  used in `modules/shopify/token.ts`'s `refreshAccessToken`/
  `exchangeSessionToken` for testability without hitting the real API).
- Integration test for disconnect: row cleared, `revokedAt` set, Google
  revoke endpoint called with the decrypted token (mocked).
- Integration test for `eraseUser`: erasing a user with an active Drive
  connection clears `refreshTokenEnc` and calls the mocked revoke endpoint;
  erasing a user with no connection is a no-op on this table.
- Manual: full connect → export → verify file lands in "AI Vastra" folder in
  a real test Google account → disconnect → confirm export then 409s →
  reconnect → confirm it works again.

## Open implementation details (for the plan, not blocking design approval)

- Exact popup vs full-page-redirect UX for `/connect` — Studio already has a
  popup-based Google account-link precedent (`google.routes.ts` COOP
  handling) to copy; plan-level decision on which existing helper to reuse.
- Whether `GET .../status` should be polled after returning from the
  connect popup, or the callback should `postMessage` back to the opener —
  plan-level UI wiring detail.
- Confirm current OAuth consent screen publishing status (testing vs
  production) in the Google Cloud Console before shipping — a `drive.file`
  scope only needs "basic" verification, but the consent screen still needs
  the scope added and, if still in "Testing" mode, either move to
  "Production" or the feature only works for allow-listed test users. This
  is an external, non-code step to confirm before this ships, not an
  engineering unknown.

## Self-review

- **Placeholders:** none — every file/line reference above
  (`generation-panel.tsx:186-239,709-868`, `google.routes.ts:29-46,120-121`,
  `modules/shopify/token.ts:95-96,250-264`, `lib/crypto.ts`, `env.ts:51-53,78`,
  `users.routes.ts:371-433`, `server.ts:360`) was confirmed against the
  current code this session, not assumed from memory.
- **Scope:** additive only — one new table, one new module, one new env var,
  one UI button state machine, one hook into the existing erasure
  transaction. No existing route, table, or the login flow is modified.
- **Backward compatibility:** a user who never connects Drive sees no schema
  or behavior change; `hideGoogleDrive` lets any embedded context opt out
  entirely, same as `hideDownload` today.
- **Carried-forward decisions from review:** shared OAuth client (with the
  revoke-caveat comment required at the disconnect call site), `drive.file`
  scope only, no proactive refresh scheduler, no batch export, no refresh
  lock until batch export actually creates concurrent refreshes.
