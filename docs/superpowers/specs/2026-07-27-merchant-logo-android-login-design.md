# Merchant Logo on Android Login — Design

## Goal

The Android app (one codebase, used both as a mounted in-store kiosk and as a merchant staff member's own phone — there is no separate kiosk backend or "mode") currently hardcodes the Tryme logo. Replace that with the logged-in merchant's own uploaded logo, falling back to the app's existing bundled Tryme default when no merchant logo is configured.

## Scope

- Single login surface: `POST /v1/auth/device-login` (`apps/api/src/modules/auth/routes.ts`). This is the only endpoint the Android app authenticates through — confirmed there is no separate kiosk-pairing backend in active use, so `/v1/kiosk/auth/*` (`apps/api/src/modules/kiosk/auth.routes.ts`) is untouched by this work.
- `/v1/auth/device-refresh` is explicitly **not** changed — confirmed sufficient for the logo to only refresh at next login, not on token refresh.
- Admin uploads the logo through the existing merchant-edit UI already embedded in a user's detail page in admin-web (`apps/admin-web/src/pages/UsersPage.tsx`) — no new admin page.

## Data model

Add one nullable column to `merchants` (`packages/db/src/schema/merchant.ts`):

```ts
logoKey: text('logo_key'), // nullable — R2 object key; null means "no merchant logo, app uses its bundled default"
```

New migration via `pnpm db:generate` (see `CLAUDE.md`'s migration-conflict procedure if the snapshot chain collides).

New R2 key builder in `packages/storage/src/keys.ts`, following the existing convention:
```ts
merchantLogo: (merchantId: string) => `merchant-logo/${merchantId}/logo.png`,
```

## Admin upload flow

Reuses the exact presigned-PUT pattern already used throughout `apps/api/src/modules/admin/*.routes.ts` (e.g. `apps/api/src/modules/admin/models.routes.ts`): `app.storage.presignPut(key, contentType, maxBytes, expirySeconds)`.

1. New route `POST /admin/merchants/:id/logo/presign` (`apps/api/src/modules/admin/merchants.routes.ts`) — body `{ contentType: 'image/png' | 'image/jpeg' }` (restricted to these two — no SVG, so the Android app can load the result straight into a standard image view with no special handling), returns `{ uploadUrl, logoKey }` where `logoKey = keys.merchantLogo(merchantId)`. Max size 2 MB (logos are small) and a 300s presign expiry, matching every other admin presign call in this file.
2. admin-web PUTs the file directly to R2 via `uploadUrl` (bypassing the API for the bytes — same as every other admin image upload in this codebase).
3. admin-web then calls the **existing** `PATCH /admin/merchants/:id` with `{ logoKey }` to persist it — `AdminMerchantUpdateBody` (`packages/types/src/widget.ts`) gains one new optional field: `logoKey: z.string().max(500).nullable().optional()`. Setting it to `null` explicitly clears the merchant's logo (reverts the app to its bundled default).
4. UI: a logo upload/preview control added to the existing "Edit merchant" modal in `apps/admin-web/src/pages/UsersPage.tsx`, alongside the company name/contact/phone/address fields it already edits.

## Backend delivery

`device-login` authenticates a `users` row (via `authenticateDeviceUser`/`findUserByIdentifier`) but never looks up that user's `merchants` row today — merchant identity is normally only resolved request-by-request via the `requireMerchant` guard (`apps/api/src/plugins/portal-auth.ts`), which queries `merchants` **by `userId`**:
```ts
const [client] = await app.db
  .select({ id: schema.merchants.id, isActive: schema.merchants.isActive })
  .from(schema.merchants)
  .where(eq(schema.merchants.userId, userId))
  .limit(1);
```
This is the same query shape the new resolver needs, keyed by `userId` (which `device-login` already has as `user.id`) rather than `merchantId`:

```ts
async function resolveMerchantLogoUrl(app: FastifyInstance, userId: string): Promise<string | null> {
  const [row] = await app.db
    .select({ logoKey: schema.merchants.logoKey })
    .from(schema.merchants)
    .where(eq(schema.merchants.userId, userId));
  return row?.logoKey ? app.storage.publicUrl(row.logoKey) : null;
}
```

`POST /v1/auth/device-login`'s response gains one new field: `logoUrl: string | null`, resolved via `resolveMerchantLogoUrl(app, user.id)` right after the existing authentication succeeds. If the logged-in account has no `merchants` row at all (the query returns nothing), `logoUrl` is `null` — same as "merchant exists but has no logo uploaded."

## API contract to hand off to the Android developer

```
POST /v1/auth/device-login
Body:  { "email": "<username-or-email>", "password": "...", "deviceId": "...", "deviceName": "...", "platform": "mobile" | "kiosk" }
Response 200: {
  "accessToken": "...",
  "refreshToken": "...",
  "user": { "id", "email", "displayName", "tier", "maxActiveDevices" },
  "logoUrl": "https://..." | null
}
```

**Contract for the app:** if `logoUrl` is non-null, fetch and display that image in place of the bundled default logo. If it's `null`, keep using the already-bundled default exactly as today — no network call needed for the default case, and no separate "get merchant profile" endpoint to integrate.

## Error handling / edge cases

- No logo uploaded → `logoUrl: null` (not an error).
- Logo deleted/cleared by admin (`PATCH` with `logoKey: null`) → next `device-login` returns `null` again; already-cached copies on the device simply aren't refreshed until next login (accepted trade-off, per the "device-refresh not touched" decision above).
- Presign/upload failures are handled entirely within the existing admin-web upload flow already used for every other admin image upload in this codebase — no new error-handling pattern needed.

## Testing plan

- API integration test: seed a merchant with a `logoKey` set, log in via `/v1/auth/device-login`, assert `logoUrl` is a non-empty string. Seed a second merchant with no `logoKey`, assert `logoUrl` is `null`.
- API integration test: `POST /admin/merchants/:id/logo/presign` returns an upload URL; `PATCH /admin/merchants/:id` with `logoKey` persists it and is reflected in the next `device-login` response; `PATCH` with `logoKey: null` clears it.
- No frontend test framework changes needed — this is a small, additive UI control following an existing pattern already used elsewhere in `UsersPage.tsx`.
