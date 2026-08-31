import { type NextRequest, NextResponse } from 'next/server';
import { setCatalogAppCookies } from '@/lib/catalog-app-cookies';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export async function POST(req: NextRequest) {
  const refreshToken = req.cookies.get('catalog_app_refresh')?.value;
  if (!refreshToken)
    return NextResponse.json({ error: { message: 'no refresh token' } }, { status: 401 });

  const res = await fetch(`${API_URL}/v1/auth/catalog-app-refresh`, {
    method: 'POST',
    headers: { Cookie: `catalog_app_refresh=${refreshToken}` },
  });
  if (!res.ok)
    return NextResponse.json({ error: { message: 'refresh failed' } }, { status: res.status });

  const data = (await res.json()) as { accessToken?: string };
  const response = NextResponse.json({ accessToken: data.accessToken });
  const h = res.headers as Headers & { getSetCookie?: () => string[] };
  const setCookieStr = h.getSetCookie
    ? h.getSetCookie().join(', ') || null
    : res.headers.get('set-cookie');
  setCatalogAppCookies(response, setCookieStr);
  return response;
}
