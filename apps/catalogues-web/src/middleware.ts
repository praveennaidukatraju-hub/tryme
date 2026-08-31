import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { setAuthCookies } from '@/lib/auth-cookies';
import { setCatalogAppCookies } from '@/lib/catalog-app-cookies';
import { buildCsp } from '@/lib/csp';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH || '';
const PUBLIC_PATHS = [
  '/login',
  '/register',
  '/home',
  '/verify-email',
  '/forgot-password',
  '/reset-password',
  '/kiosk-upload',
  '/kiosk-download',
  '/tryon-library-app',
];
// Features not ready for real users — hidden from the sidebar (see sidebar.tsx
// devOnly) and blocked here so direct navigation can't reach them either.
const DEV_ONLY_PATHS: string[] = [];
// Features hidden in every environment (not just production) — still fully
// present in the codebase, just not reachable via nav or direct URL. See
// sidebar.tsx for the matching nav-item removal.
const ALWAYS_BLOCKED_PATHS: string[] = ['/sellio'];

// Gartex Expo Delhi campaign (docs/superpowers/specs/2026-08-01-gartex-expo-qr-campaign-design.md)
// — send /pricing traffic straight to signup with the already-configured
// gartex2026delhi campaign code instead of a page that requires login.
// Self-expiring: no follow-up deploy needed to remove it once the window
// closes. IST bounds, matching the expo's own timezone.
const GARTEX_REDIRECT_START = new Date('2026-08-05T00:00:00+05:30');
const GARTEX_REDIRECT_END = new Date('2026-08-09T23:59:59+05:30');

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl;

  // Fresh per-request nonce (SEC-H2 CSP). Threaded to the app via an
  // `x-nonce` request header so the root layout can read it via next/headers
  // and put it on the theme-flash inline script — Next.js auto-applies the
  // same nonce to its own inline/streaming scripts once it sees this header.
  // btoa/crypto are Web APIs (not Buffer) — middleware runs in the Edge runtime.
  const nonce = btoa(crypto.randomUUID());
  const csp = buildCsp(nonce);
  const requestHeaders = new Headers(request.headers);
  requestHeaders.set('x-nonce', nonce);

  const withCsp = (response: NextResponse): NextResponse => {
    response.headers.set('Content-Security-Policy', csp);
    return response;
  };
  const next = (): NextResponse =>
    withCsp(NextResponse.next({ request: { headers: requestHeaders } }));
  const redirect = (url: URL): NextResponse => withCsp(NextResponse.redirect(url));

  // Next.js strips basePath before middleware receives pathname.
  // Strip manually too in case it doesn't (varies by version/config).
  const path =
    BASE_PATH && pathname.startsWith(BASE_PATH)
      ? pathname.slice(BASE_PATH.length) || '/'
      : pathname;

  // Android app WebView SSO bypass
  // (docs/superpowers/specs/2026-08-18-android-tryon-library-app-sso-design.md):
  // the native app sends its device access token as a header on the WebView's
  // first navigation only. Exchange it for a catalog_app_refresh cookie before
  // AuthGate's own client-side check ever runs, so an already-signed-in
  // merchant never sees this PWA's separate login form. No-op for every other
  // visitor (no header). Always attempted when the header is present, even if a
  // catalog_app_refresh cookie already exists — that cookie's 7-day lifetime is
  // independent of the server-side session it points at (native logout, family-
  // reuse revocation), so a present-but-stale cookie must not skip the exchange.
  if (path === '/tryon-library-app' || path.startsWith('/tryon-library-app/')) {
    // Second entry point, for WebView wrappers that can't set a custom header
    // on the initial load: the app calls POST /v1/auth/catalog-app-device-code
    // itself (bearer device token, never in a URL) to get a short-lived
    // single-use code, then opens this page at ?code=<code>. Checked first —
    // if present it's the explicit signal the app just minted, whereas the
    // header below is opportunistic on every load.
    const code = request.nextUrl.searchParams.get('code');
    if (code) {
      try {
        const res = await fetch(`${API_URL}/v1/auth/catalog-app-code-exchange`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ code }),
          signal: AbortSignal.timeout(3000),
        });
        if (res.ok) {
          const h = res.headers as Headers & { getSetCookie?: () => string[] };
          const setCookieStr = h.getSetCookie
            ? h.getSetCookie().join(', ') || null
            : res.headers.get('set-cookie');
          // Strip the (already single-use, now-consumed) code from the URL so
          // it doesn't linger in WebView history or get resent on a refresh.
          const cleanUrl = new URL(request.url);
          cleanUrl.searchParams.delete('code');
          const response = NextResponse.redirect(cleanUrl);
          setCatalogAppCookies(response, setCookieStr);
          return withCsp(response);
        }
      } catch {
        // Code invalid/expired/already used/network error — fall through to
        // the header check below, then the page's own login form.
      }
    }

    // Android app WebView SSO bypass
    // (docs/superpowers/specs/2026-08-18-android-tryon-library-app-sso-design.md):
    // the native app sends its device access token as a header on the WebView's
    // first navigation only. Exchange it for a catalog_app_refresh cookie before
    // AuthGate's own client-side check ever runs, so an already-signed-in
    // merchant never sees this PWA's separate login form. No-op for every other
    // visitor (no header). Always attempted when the header is present, even if a
    // catalog_app_refresh cookie already exists — that cookie's 7-day lifetime is
    // independent of the server-side session it points at (native logout, family-
    // reuse revocation), so a present-but-stale cookie must not skip the exchange.
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
        // Exchange failed (expired token, not a merchant, network error) — fall
        // through to the page's own client-side login form, same as today.
      }
    }
    return next();
  }

  if (path.startsWith('/api/auth')) return next();
  if (path.startsWith('/api/catalog-app')) return next();

  if (
    process.env.NODE_ENV === 'production' &&
    DEV_ONLY_PATHS.some((p) => path === p || path.startsWith(`${p}/`))
  ) {
    return redirect(new URL(`${BASE_PATH}/studio`, request.url));
  }

  if (ALWAYS_BLOCKED_PATHS.some((p) => path === p || path.startsWith(`${p}/`))) {
    return redirect(new URL(`${BASE_PATH}/studio`, request.url));
  }

  const isPublic = PUBLIC_PATHS.some((p) => path === p || path.startsWith(`${p}/`));
  if (isPublic) return next();
  if (path === '/') return next();

  const token = request.cookies.get('access_token')?.value;

  if (token) return next();

  // Access token expired/missing. Before bouncing to login, try a silent
  // refresh using the (httpOnly, 1-hour) refresh cookie. This is what stops the
  // "logged out on reload/navigation after 15 min" problem — middleware runs on
  // server navigations where the client-side 401→refresh path never fires.
  const refresh = request.cookies.get('refresh')?.value;
  if (refresh) {
    try {
      const res = await fetch(`${API_URL}/v1/auth/refresh`, {
        method: 'POST',
        headers: { Cookie: `refresh=${refresh}` },
      });
      if (res.ok) {
        const data = (await res.json()) as { accessToken?: string };
        if (data.accessToken) {
          // Edge Runtime treats 'set-cookie' as a forbidden response-header name,
          // so res.headers.get('set-cookie') returns null there. Use getSetCookie()
          // (WinterCG / Node 20 API) which bypasses the restriction, falling back
          // to get() for environments that do expose it via the standard path.
          const h = res.headers as Headers & { getSetCookie?: () => string[] };
          const setCookieStr = h.getSetCookie
            ? h.getSetCookie().join(', ') || null
            : res.headers.get('set-cookie');

          const response = NextResponse.next({ request: { headers: requestHeaders } });
          setAuthCookies(response, data.accessToken, setCookieStr);
          return withCsp(response);
        }
      }
    } catch {
      // fall through to login/gartex redirect below
    }
  }

  // Real auth resolution (token, then refresh) has failed at this point --
  // this visitor is genuinely anonymous, not just carrying a stale cookie
  // from an earlier session. Gartex Expo Delhi campaign
  // (docs/superpowers/specs/2026-08-01-gartex-expo-qr-campaign-design.md):
  // send /pricing traffic straight to signup with the already-configured
  // gartex2026delhi campaign code instead of a login wall. Self-expiring --
  // no follow-up deploy needed once the window closes.
  const now = new Date();
  if (path === '/pricing' && now >= GARTEX_REDIRECT_START && now <= GARTEX_REDIRECT_END) {
    const url = new URL(`${BASE_PATH}/register`, request.url);
    url.searchParams.set('src', 'gartex2026delhi');
    return redirect(url);
  }

  // Use absolute URL to avoid Next.js basePath double-prefix issues
  const loginUrl = new URL(`${BASE_PATH}/login`, request.url);
  // Preserve the query string too (e.g. ?plan=<slug> for the pricing
  // deep-link) so it survives the login round trip — path without basePath;
  // router.push handles it.
  loginUrl.searchParams.set('next', `${path}${request.nextUrl.search}`);
  return redirect(loginUrl);
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|assets/|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
