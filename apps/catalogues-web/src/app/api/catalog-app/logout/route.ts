import { type NextRequest, NextResponse } from 'next/server';
import { clearCatalogAppCookies } from '@/lib/catalog-app-cookies';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export async function POST(req: NextRequest) {
  const refreshToken = req.cookies.get('catalog_app_refresh')?.value;
  if (refreshToken) {
    await fetch(`${API_URL}/v1/auth/logout`, {
      method: 'POST',
      headers: { Cookie: `catalog_app_refresh=${refreshToken}` },
    }).catch(() => {});
  }
  const response = NextResponse.json({ ok: true });
  clearCatalogAppCookies(response);
  return response;
}
