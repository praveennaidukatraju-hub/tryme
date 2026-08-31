import { type NextRequest, NextResponse } from 'next/server';
import { setAuthCookies } from '@/lib/auth-cookies';
import { safeJson } from '@/lib/bff';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const res = await fetch(`${API_URL}/v1/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const [data, ok] = await safeJson(res);
    if (!ok) return NextResponse.json(data, { status: res.status });

    const typed = data as { accessToken?: string };
    // Return accessToken in the body so the client can hold it in module memory
    // instead of a JS-readable cookie (see apps/catalogues-web/src/lib/api.ts initToken).
    const response = NextResponse.json({ ok: true, accessToken: typed.accessToken });
    const h = res.headers as Headers & { getSetCookie?: () => string[] };
    const setCookieStr = h.getSetCookie
      ? h.getSetCookie().join(', ') || null
      : res.headers.get('set-cookie');
    setAuthCookies(response, typed.accessToken ?? '', setCookieStr);
    return response;
  } catch (err) {
    console.error('login BFF route failed:', err);
    return NextResponse.json({ error: { message: 'Service unavailable' } }, { status: 503 });
  }
}
