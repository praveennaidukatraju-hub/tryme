# Android device-session bypass for `/tryon-library-app` — Design

## Goal

When the native Android app opens its embedded WebView at `https://app.tryme.com/tryon-library-app`, a merchant who is already signed into the native app must not see the Try On Library's own login form. The WebView should silently pick up a `catalog-app` session derived from the native app's existing device session.

## Why the login wall shows today

`/tryon-library-app` is a separate installable PWA with its own cookie-based session (`catalog_app_refresh`, portal `catalog-app` — see `docs/superpowers/specs/2026-07-27-tryon-library-installable-app-design.md`). The native Android app authenticates independently via device tokens (`POST /v1/auth/device-login` or `/device-login/google`, `aud: 'device'`), held in the app, never as a cookie. The two sessions have no relationship today, so a WebView opened fresh has no `catalog_app_refresh` cookie and `AuthGate.tsx` always renders its login form first.

## Scope

Backend (`apps/api`) and web (`apps/catalogues-web`) only. The native Android app lives in a separate repository and is out of scope for implementation here — this spec includes an "Android integration contract" section documenting exactly what the native side must send, for whoever implements that side.

## Architecture / data flow

1. The native app authenticates as it already does (unchanged), holding a short-lived device access token (`aud: 'device'`) and a refresh token.
2. When opening the WebView, the native app calls `webView.loadUrl(url, mapOf("X-Tryme-Device-Token" to deviceAccessToken))` — the header is sent only on that first top-level navigation, never appended to the URL.
3. Next.js middleware sees the header on `/tryon-library-app` and exchanges the device token for a catalog-app session server-to-server, calling the API directly — no BFF hop (see "Web changes" below for why).
4. `AuthGate.tsx` requires **no changes**: its existing mount-time call to `/api/catalog-app/refresh` finds the cookie already set by the middleware and renders the library directly, with no flash of the login form.
5. After the first successful exchange, the WebView's persistent cookie store carries the session like a normal browser tab. The header is not needed again unless the WebView's cookies are cleared (e.g. on native logout).

This deliberately keeps the device token out of the URL, browser history, and Referer headers — it only ever travels as a header on a same-origin top-level navigation to our own domain.

## Backend changes

### New endpoint: `POST /v1/auth/catalog-app-device-exchange`

Location: `apps/api/src/modules/auth/routes.ts`, placed next to the existing `POST /v1/auth/catalog-app-refresh`.

- `preHandler: app.requireDeviceUser` — this guard already exists (`apps/api/src/plugins/auth.ts:85`) and does exactly what's needed here: verifies the bearer token has `aud: 'device'`, `kind: 'access'`, and resolves to a real, email-verified user — but **not** a non-banned one (`requireDeviceUser` has no `isBanned` check, unlike the password-based `portal: 'catalog-app'` login this route mirrors). The route adds its own explicit ban check for this reason — see the implementation.
- No request body — `req.userId` comes from the guard.
- Logic, mirroring the existing `portal: 'catalog-app'` branch of `POST /v1/auth/login` (`routes.ts:395-403`):
  ```ts
  app.post(
    '/v1/auth/catalog-app-device-exchange',
    {
      preHandler: app.requireDeviceUser,
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (req, reply) => {
      const [merchantRow] = await app.db
        .select({ isActive: schema.merchants.isActive })
        .from(schema.merchants)
        .where(eq(schema.merchants.userId, req.userId));
      if (!merchantRow?.isActive) {
        throw new AppError('NOT_A_MERCHANT', 403, 'This account has no Try On Library access.');
      }
      return createSessionTokens(app, req.userId, reply, 200, 'catalog-app');
    },
  );
  ```
- `createSessionTokens` (`apps/api/src/modules/auth/tokens.ts`) is reused unchanged, so the cookie name (`catalog_app_refresh`), flags, and JWT audience are byte-for-byte identical to the password-login path — this is a new *entry point* into an existing session type, not a new session type.

No changes to `requireDeviceUser`, `createSessionTokens`, or any existing route.

## Web changes

No new BFF route is needed here, unlike the password-login and refresh flows. Those go through `api/catalog-app/login` and `api/catalog-app/refresh` because they're initiated by client-side JS in `AuthGate.tsx`, which can't reach the Fastify API cross-origin without a same-origin proxy. This flow is different: the exchange is driven entirely by the middleware itself (server-side, on the Edge), which can call the Fastify API directly — a same-origin BFF hop in between would add nothing. The only new web-side change is to `middleware.ts`.

### `middleware.ts` change

Add a branch scoped to `/tryon-library-app`, evaluated before/alongside the existing `PUBLIC_PATHS` short-circuit (`middleware.ts:76-77`). Pseudocode:

```ts
if (path === '/tryon-library-app' || path.startsWith('/tryon-library-app/')) {
  const deviceToken = request.headers.get('x-tryme-device-token');
  if (deviceToken) {
    try {
      const cfIp = request.headers.get('cf-connecting-ip');
      const res = await fetch(`${API_URL}/v1/auth/catalog-app-device-exchange`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${deviceToken}`,
          ...(cfIp ? { 'cf-connecting-ip': cfIp } : {}),
        },
        signal: AbortSignal.timeout(3000),
      });
      if (res.ok) {
        const h = res.headers as Headers & { getSetCookie?: () => string[] };
        const setCookieStr = h.getSetCookie
          ? h.getSetCookie().join(', ') || null
          : res.headers.get('set-cookie');
        const response = NextResponse.next({ request: { headers: requestHeaders } });
        setCatalogAppCookies(response, setCookieStr);
        return withCsp(response);
      }
    } catch {
      // fall through — page's own client-side login form is the fallback
    }
  }
  return next();
}
```

`setCatalogAppCookies` (`apps/catalogues-web/src/lib/catalog-app-cookies.ts`) is already Edge-runtime-safe (no Node-only APIs), so it can be called directly from middleware, the same way `setAuthCookies` already is for the main-site refresh flow just below it in this file.

This branch replaces (for this one path) the existing bare `if (isPublic) return next();` handling — `/tryon-library-app` stays in `PUBLIC_PATHS` (unauthenticated visitors still reach the page and its own login form), this only adds an opportunistic cookie-mint step ahead of that.

## Android integration contract (spec only — implemented in the separate Android repo)

- Send `X-Tryme-Device-Token: <deviceAccessToken>` only on the WebView's initial `loadUrl` call for `/tryon-library-app`. Do not add it to subsequent same-page navigations — the cookie set on the first exchange persists in the WebView's cookie jar exactly like a browser tab's.
- If the device access token is close to expiry, refresh it first (the app already manages this token's lifecycle for its other API calls) — an expired token here just falls back to the existing login form, it doesn't error loudly.
- On native app logout, clear this origin's WebView cookies (`CookieManager.removeAllCookies()` or an origin-scoped equivalent) and ideally also call `POST /api/catalog-app/logout` so the refresh-token family is revoked server-side too — otherwise a shared/kiosk device could leave the previous merchant's Try On Library session live in the WebView after the native app itself has logged out.

## Error handling

- Expired/invalid device token → `requireDeviceUser` throws 401 → exchange fails → middleware leaves no cookie → existing login form renders. No behavior change from today for this case.
- Valid device user with no active merchant profile → `NOT_A_MERCHANT` 403 → same fallback to the login form. Matches the existing password-login behavior for non-merchants (`routes.ts:395-403`) — no new UX to design for this edge case.
- Network failure calling the exchange endpoint from middleware → caught, falls through to `next()` — page loads normally and behaves exactly as it does today (client-side login form).

## Testing plan

- API integration tests (new file, e.g. `apps/api/test/catalog-app-device-exchange.test.ts`):
  - valid device-portal access token (`aud: 'device'`) + active merchant → 200, `Set-Cookie: catalog_app_refresh=...`, and the reissued access token verifies with `aud: 'catalog-app'`.
  - valid device token, no merchant row → 403 `NOT_A_MERCHANT`.
  - valid device token, inactive merchant → 403 `NOT_A_MERCHANT`.
  - non-device-portal token presented (plain web session, admin, or an existing `catalog-app` token) → 401 (rejected by `requireDeviceUser`'s `aud !== 'device'` check).
  - expired device token → 401.
  - banned user → whatever `requireDeviceUser`'s existing user lookup already does today (no special-casing needed; verify it matches existing device-route behavior).
- No new frontend test framework needed. Manual verification: `curl` (or a browser dev-tools request) against `/tryon-library-app` with the `X-Tryme-Device-Token` header set to a real device access token, confirming the `catalog_app_refresh` cookie appears in the response and a subsequent load renders the library with no login form. No Android WebView exists in this repo to test end-to-end.

## Open trade-offs (confirmed during design)

- Header-based, not URL-param-based: keeps the device token out of browser history and Referer headers, at the cost of requiring the Android side to use `loadUrl`'s `extraHeaders` overload rather than plain string concatenation.
- The exchange endpoint is intentionally generic ("upgrade a device session to a catalog-app session for the same user") rather than Android-specific — any valid `aud: 'device'` token can call it, matching the trust level the device-login flow already grants those tokens elsewhere in the API.
- Native-side WebView cookie clearing on logout is documented here as a requirement but not implemented in this repo — flagged so it isn't silently dropped when the Android side picks this up.
