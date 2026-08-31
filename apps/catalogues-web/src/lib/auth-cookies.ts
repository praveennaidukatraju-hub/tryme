import type { NextResponse } from 'next/server';

export function setAuthCookies(
  response: NextResponse,
  _accessToken: string,
  setCookieHeader: string | null,
): void {
  // access_token is kept in JS module memory (see api.ts), not in a cookie,
  // so that XSS cannot steal a bearer token and forge requests indefinitely.

  if (setCookieHeader) {
    const refreshMatch = setCookieHeader.match(/refresh=([^;]+)/);
    if (refreshMatch?.[1]) {
      response.cookies.set('refresh', refreshMatch[1], {
        httpOnly: true,
        sameSite: 'lax',
        // Path '/' (not '/api/auth') so the browser sends it on protected-page
        // navigations too — lets middleware silently refresh before redirecting.
        path: '/',
        // 7-day lifetime matches REFRESH_TOKEN_EXPIRY in the API. Each refresh
        // rotates the token with a fresh 7-day window, so an active user stays
        // logged in. The DB token itself enforces the true expiry.
        maxAge: 7 * 24 * 60 * 60,
        secure: process.env.NODE_ENV === 'production',
      });
    }
  }
}

export function clearAuthCookies(response: NextResponse): void {
  response.cookies.set('access_token', '', { maxAge: 0, path: '/' });
  response.cookies.set('refresh', '', { maxAge: 0, path: '/' });
  // Also clear the legacy '/api/auth'-scoped refresh cookie from older sessions.
  response.cookies.set('refresh', '', { maxAge: 0, path: '/api/auth' });
}
