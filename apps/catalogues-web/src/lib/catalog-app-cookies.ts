import type { NextResponse } from 'next/server';

export function setCatalogAppCookies(response: NextResponse, setCookieHeader: string | null): void {
  if (!setCookieHeader) return;
  const match = setCookieHeader.match(/catalog_app_refresh=([^;]+)/);
  if (!match?.[1]) return;
  response.cookies.set('catalog_app_refresh', match[1], {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 7 * 24 * 60 * 60,
    secure: process.env.NODE_ENV === 'production',
  });
}

export function clearCatalogAppCookies(response: NextResponse): void {
  response.cookies.set('catalog_app_refresh', '', { maxAge: 0, path: '/' });
}
