import { type NextRequest, NextResponse } from 'next/server';
import { setAuthCookies } from '@/lib/auth-cookies';
import { safeJson } from '@/lib/bff';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export async function GET(req: NextRequest) {
  try {
    const token = req.nextUrl.searchParams.get('token') ?? '';
    const res = await fetch(`${API_URL}/v1/auth/verify-email?token=${encodeURIComponent(token)}`);

    const [data, ok] = await safeJson(res);
    if (!ok) return NextResponse.json(data, { status: res.status });

    const typed = data as { accessToken?: string };
    const response = NextResponse.json({ ok: true });
    const h = res.headers as Headers & { getSetCookie?: () => string[] };
    const setCookieStr = h.getSetCookie
      ? h.getSetCookie().join(', ') || null
      : res.headers.get('set-cookie');
    setAuthCookies(response, typed.accessToken ?? '', setCookieStr);
    return response;
  } catch (err) {
    console.error('verify-email BFF route failed:', err);
    return NextResponse.json({ error: { message: 'Service unavailable' } }, { status: 503 });
  }
}
