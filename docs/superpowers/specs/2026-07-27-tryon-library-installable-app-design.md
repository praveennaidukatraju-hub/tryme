# Installable Try On Library Mini-App — Design

## Goal

A responsive, installable (Chrome "Add to Home Screen" / PWA) web page for merchant staff that shows *only* the Try On Library (product/subcategory catalog management) — no sidebar, no access to Studio/Catalogs/Settings/Pricing/etc., even via direct URL. Same underlying catalog data and UI as the existing `/catalogue-manager` page, but reached through its own dedicated login, not the regular full-site session.

## Why this needs its own login (not just a hidden sidebar)

Today, a merchant staff member logging into catalogues-web uses the *same* cookie-based session a regular customer would — `requireMerchant` (guarding the catalog APIs) and `requireUser` (guarding everything else) both call the same `verifyAccess()`, which never inspects the JWT's `aud` (audience) claim. Hiding the sidebar would only be a UI simplification; the same login could still reach every other page by URL. A real boundary needs a session that other pages' guard explicitly refuses.

This introduces a fifth "portal" (alongside the existing `web`/`admin`/`mobile`/`kiosk` portals already used for refresh-token bookkeeping), `catalog-app`:
- Its access token carries `aud: 'catalog-app'`.
- `requireMerchant` (used by the catalog APIs) doesn't check audience, so it already accepts this token unmodified.
- `requireUser` (used by Studio, Settings, Catalogs, Pricing, etc.) gets one added check: reject any token whose `aud` is `'catalog-app'`. This is the actual boundary — everything else follows from it.

## Backend changes

All three are **extensions of existing endpoints**, plus one genuinely new (but thin) route — confirmed during design that no new endpoint is needed for login or logout, and the one new endpoint for refresh reuses an already-shared, portal-parameterized rotation helper rather than new business logic.

### 1. `requireUser` — reject `catalog-app` tokens (`apps/api/src/plugins/auth.ts`)

After decoding the JWT payload, add: if `payload.aud === 'catalog-app'`, throw the same `AppError('UNAUTH', 401, 'invalid token')` used for every other invalid-token case in this guard. This is the one line that makes the restriction real.

### 2. Login — extend `POST /v1/auth/login` (`apps/api/src/modules/auth/routes.ts`)

New request field, `portal?: 'catalog-app'` (a new `WebLoginBody = LoginBody.extend({ portal: z.enum(['catalog-app']).optional() })` in `packages/types/src/auth.ts`, used only by this route — `LoginBody` itself, and `DeviceLoginBody` which extends it, stay unchanged).

When `portal === 'catalog-app'`:
- After the existing credential checks succeed, look up `schema.merchants` by the resolved `userId`. If no active merchant profile exists, throw `AppError('NOT_A_MERCHANT', 403, ...)` instead of issuing a session — matches the earlier decision that this login is merchant-accounts-only.
- Issue the session via `createSessionTokens`, extended to accept an optional `portal` parameter (default `'web'`, unchanged for every existing caller). When `'catalog-app'` is passed: `signAccess(..., 'catalog-app')` for the audience, `portal: 'catalog-app'` on the inserted `refreshTokens` row, and — per the explicit decision to keep the two session types independent in the same browser — a **different cookie name**, `catalog_app_refresh`, instead of `refresh`. Same `path: '/v1/auth'`, same `httpOnly`/`secure`/`sameSite` flags as today.
- When `portal` is absent (every existing caller), behavior is byte-for-byte unchanged.

### 3. Refresh — new thin route `POST /v1/auth/catalog-app-refresh` (`apps/api/src/modules/auth/routes.ts`)

The existing `/v1/auth/refresh` hardcodes the `refresh` cookie name and a `portal !== 'web'` rejection inline (it doesn't use the shared `rotateTokenFamily` helper at all — it has its own bespoke rotation/theft-detection logic). Because the separate-cookie decision means this route can't also read `catalog_app_refresh`, the new route is a *thin wrapper*, not new logic:

```ts
app.post('/v1/auth/catalog-app-refresh', async (req, reply) => {
  const plain = req.cookies.catalog_app_refresh;
  if (!plain) throw new AppError('NO_REFRESH', 401, 'no refresh token');
  const result = await rotateTokenFamily(app, plain, 'catalog-app');
  if (result.kind === 'invalid') throw new AppError('INVALID_REFRESH', 401, 'refresh invalid');
  const secret = new TextEncoder().encode(app.env.JWT_SECRET);
  if (result.kind === 'reissue') {
    return { accessToken: await signAccess(secret, result.userId, { kind: 'access' }, app.env.JWT_EXPIRY, 'catalog-app') };
  }
  reply.setCookie('catalog_app_refresh', result.refreshPlain, {
    httpOnly: true, secure: app.env.NODE_ENV === 'production', sameSite: 'lax', path: '/v1/auth', expires: result.expiresAt, signed: false,
  });
  return { accessToken: await signAccess(secret, result.userId, { kind: 'access' }, app.env.JWT_EXPIRY, 'catalog-app') };
});
```
(`rotateTokenFamily`, `signAccess` are already imported/exported in this file; no new dependencies.) This reuses 100% of the actual rotation and stale-token-theft-detection logic already exercised by kiosk's own refresh route — the only new code is cookie plumbing and audience-tagging the reissued token.

### 4. Logout — widen `POST /v1/auth/logout` (`apps/api/src/modules/auth/routes.ts`)

Currently reads `req.cookies.refresh` only. Change to `req.cookies.refresh ?? req.cookies.catalog_app_refresh` — revocation is already by refresh-token family (portal-agnostic), so no other change is needed. Whichever cookie was actually present gets cleared/revoked correctly.

### 5. Catalog data APIs (`/v1/merchant/catalog/*`)

No changes. `requireMerchant` doesn't check audience, so a `catalog-app`-audience token already satisfies it today.

## Frontend

### Route structure

New top-level route `apps/catalogues-web/src/app/tryon-library-app/page.tsx` — **outside** the `(app)` route group, so it does not inherit `AppShell` (Sidebar) or `ProfileGate`. This mirrors how `/kiosk-upload/[token]` and `/widget-link-complete` already exist as standalone pages outside `(app)` in this codebase.

The page is a single client component that:
- On mount, attempts a silent refresh against `/v1/auth/catalog-app-refresh` (its own small API client module, `apps/catalogues-web/src/app/tryon-library-app/catalog-app-api.ts`, holding its own in-memory access token — completely separate from `lib/api.ts`'s module-level token, so the two session types can't cross-contaminate within the same tab).
- If that fails (no valid `catalog_app_refresh` cookie), renders a login form (username-or-email + password) posting to `/v1/auth/login` with `{ ..., portal: 'catalog-app' }`. On success, shows the library content.
- If it succeeds, renders the library content — visually matching the existing `CatalogueManagerContent`'s subcategory/product grid and header bar (Add Subcategory, credits, support, avatar; no sidebar, no other nav).

**Why this can't just import the existing components as-is:** `CatalogueManagerContent`, `SubcategoryModal`, `ProductModal`, and `BulkUploadModal` all directly `import { api } from '@/lib/api'`. That singleton isn't just a fetch wrapper — on a failed silent refresh it hardcodes `window.location.href = '/login'` (the *wrong* login page for this route) and holds its token/`BroadcastChannel('tryme-auth')` state at module scope, which would cross-talk with a regular full-site session open in another tab of the same browser. Swapping in a different client would mean either (a) duplicating these ~4 components into `apps/catalogues-web/src/app/tryon-library-app/` pointed at `catalog-app-api.ts`, or (b) refactoring `lib/api.ts` and its consumers to accept an injectable client. (b) touches a file used by nearly every page in the app for one new consumer — out of proportion to this feature. Going with (a): duplicate the four components (renamed to avoid confusion, e.g. `LibraryContent`, `LibrarySubcategoryModal`, etc.), each importing `catalog-app-api.ts` instead of `lib/api.ts`. Accepted trade-off: this is real UI duplication (~1,000 lines) that won't automatically stay in sync with `/catalogue-manager` if that page's catalog-management UI changes later — acceptable since this UI isn't expected to change often, but worth knowing going in.

### Middleware (`apps/catalogues-web/src/middleware.ts`)

Add `/tryon-library-app` to `PUBLIC_PATHS`. This isn't really "public" — it bypasses the regular `access_token`-cookie redirect-to-`/login` logic (which is the *wrong* login page for this route) so the page's own client-side auth check (above) decides whether to show its login form or its content.

### PWA installability

- New `apps/catalogues-web/src/app/tryon-library-app/manifest.webmanifest` (Next.js App Router route-segment manifest) — `name: "Try On Library"`, `short_name: "Try On"`, `start_url: "/tryon-library-app"`, `scope: "/tryon-library-app"` (so the installed app's own navigation can never leave this route even if a link existed), `display: "standalone"`, `theme_color`/`background_color` matching the app's existing pink/dark tokens, and `icons` at 192×192 and 512×512.
- **New asset needed**: no square PNG app-icon currently exists in `apps/catalogues-web/public/assets/` (only `logo.svg`). Two PNGs (192×192, 512×512) need to be generated from the existing logo for the manifest's `icons` array.
- A minimal service worker (`apps/catalogues-web/public/tryon-library-app-sw.js`, registered only from this page) is required for Chrome's install-eligibility criteria — a bare pass-through fetch handler is sufficient, no offline caching strategy is being built here.

## Testing plan

- API integration tests: `/v1/auth/login` with `portal: 'catalog-app'` for a merchant account issues a token whose `aud` is `catalog-app` and sets `catalog_app_refresh` (not `refresh`); the same call for a non-merchant account returns 403; `requireUser`-guarded routes (e.g. `/v1/me`) reject a `catalog-app` token; `requireMerchant`-guarded routes accept it; `/v1/auth/catalog-app-refresh` rotates correctly and rejects a `web`-portal refresh token presented at this endpoint; `/v1/auth/logout` clears whichever cookie was present.
- No new frontend test framework changes — the duplicated catalog UI components carry over their existing behavior unchanged, just pointed at a different API client; manual verification (no browser automation available) of: install prompt appears in Chrome, installed window has no browser chrome/sidebar, login works, logging out of the main site in the same browser doesn't affect this session and vice versa.

## Open trade-offs (confirmed during design, not to relitigate without asking)

- Merchant-only login: non-merchant accounts get a clear 403 at login, not a post-login empty state.
- Separate `catalog_app_refresh` cookie: the two session types (full site vs. this installed app) can coexist independently in the same browser, at the cost of one new thin refresh route.
- No offline support: the service worker exists only to satisfy Chrome's install-eligibility check, not to cache anything for offline use.
