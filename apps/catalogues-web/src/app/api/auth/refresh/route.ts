import { type NextRequest, NextResponse } from 'next/server';
import { setAuthCookies } from '@/lib/auth-cookies';
import { safeJson } from '@/lib/bff';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export async function POST(req: NextRequest) {
  try {
    const refreshToken = req.cookies.get('refresh')?.value;
    if (!refreshToken) return NextResponse.json({ error: 'no refresh token' }, { status: 401 });

    const res = await fetch(`${API_URL}/v1/auth/refresh`, {
      method: 'POST',
      headers: { Cookie: `refresh=${refreshToken}` },
    });

    const [data, ok] = await safeJson(res);
    if (!ok) return NextResponse.json(data, { status: res.status });

    const typed = data as { accessToken?: string };
    const response = NextResponse.json({ accessToken: typed.accessToken });
    const h = res.headers as Headers & { getSetCookie?: () => string[] };
    const setCookieStr = h.getSetCookie
      ? h.getSetCookie().join(', ') || null
      : res.headers.get('set-cookie');
    setAuthCookies(response, typed.accessToken ?? '', setCookieStr);
    return response;
  } catch (err) {
    console.error('refresh BFF route failed:', err);
    return NextResponse.json({ error: { message: 'Service unavailable' } }, { status: 503 });
  }
}
