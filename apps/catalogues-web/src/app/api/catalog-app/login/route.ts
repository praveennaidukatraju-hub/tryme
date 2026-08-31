import { type NextRequest, NextResponse } from 'next/server';
import { safeJson } from '@/lib/bff';
import { setCatalogAppCookies } from '@/lib/catalog-app-cookies';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const res = await fetch(`${API_URL}/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...body, portal: 'catalog-app' }),
    });

    const [data, ok] = await safeJson(res);
    if (!ok) return NextResponse.json(data, { status: res.status });

    const typed = data as { accessToken?: string };
    const response = NextResponse.json({ ok: true, accessToken: typed.accessToken });
    const h = res.headers as Headers & { getSetCookie?: () => string[] };
    const setCookieStr = h.getSetCookie
      ? h.getSetCookie().join(', ') || null
      : res.headers.get('set-cookie');
    setCatalogAppCookies(response, setCookieStr);
    return response;
  } catch (err) {
    console.error('catalog-app login BFF route failed:', err);
    return NextResponse.json({ error: { message: 'Service unavailable' } }, { status: 503 });
  }
}
