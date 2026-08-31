import { type NextRequest, NextResponse } from 'next/server';
import { setAuthCookies } from '@/lib/auth-cookies';
import { setCatalogAppCookies } from '@/lib/catalog-app-cookies';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';
const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

/** Reconstruct the public origin from nginx forwarded headers, falling back to the internal URL origin. */
function getWebOrigin(req: NextRequest): string {
  const proto = req.headers.get('x-forwarded-proto');
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host');
  if (proto && host) return `${proto}://${host}`;
  return req.nextUrl.origin;
}

export async function GET(req: NextRequest) {
  const webOrigin = getWebOrigin(req);
  const code = req.nextUrl.searchParams.get('code');
  const next = req.nextUrl.searchParams.get('next');
  const portal: 'web' | 'catalog-app' = next?.startsWith('/tryon-library-app')
    ? 'catalog-app'
    : 'web';
  const errorBase = portal === 'catalog-app' ? '/tryon-library-app' : '/login';

  function oauthFailedRedirect(reason: string): NextResponse {
    const url = new URL(`${BASE_PATH}${errorBase}`, webOrigin);
    url.searchParams.set('error', reason);
    return NextResponse.redirect(url);
  }

  if (!code) return oauthFailedRedirect('oauth_failed');

  let data: { accessToken?: string };
  let setCookieHeader: string | null = null;

  try {
    const res = await fetch(`${API_URL}/v1/auth/google/exchange`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code, portal }),
    });

    if (!res.ok) {
      let reason = 'oauth_failed';
      try {
        const body = (await res.json()) as { error?: { code?: string } };
        if (body.error?.code === 'NOT_A_MERCHANT') reason = 'not_a_merchant';
      } catch {
        // response wasn't JSON — keep the generic reason
      }
      return oauthFailedRedirect(reason);
    }

    data = (await res.json()) as { accessToken?: string };
    const h = res.headers as Headers & { getSetCookie?: () => string[] };
    setCookieHeader = h.getSetCookie
      ? h.getSetCookie().join(', ') || null
      : res.headers.get('set-cookie');
  } catch {
    return oauthFailedRedirect('oauth_failed');
  }

  if (!data.accessToken) return oauthFailedRedirect('oauth_failed');

  const target = next ? `${BASE_PATH}${next}` : `${BASE_PATH}/studio`;
  const response = NextResponse.redirect(new URL(target, webOrigin));
  if (portal === 'catalog-app') {
    setCatalogAppCookies(response, setCookieHeader);
  } else {
    setAuthCookies(response, data.accessToken, setCookieHeader);
  }
  return response;
}
