import { type NextRequest, NextResponse } from 'next/server';
import { setAuthCookies } from '@/lib/auth-cookies';
import { safeJson } from '@/lib/bff';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const res = await fetch(`${API_URL}/v1/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    const [data, ok] = await safeJson(res);
    if (!ok) return NextResponse.json(data, { status: res.status });

    const typed = data as { accessToken?: string; requiresEmailVerification?: boolean };
    if (typed.requiresEmailVerification) {
      return NextResponse.json({ requiresEmailVerification: true }, { status: 201 });
    }

    const response = NextResponse.json({ ok: true });
    setAuthCookies(response, typed.accessToken ?? '', res.headers.get('set-cookie'));
    return response;
  } catch (err) {
    console.error('register BFF route failed:', err);
    return NextResponse.json({ error: { message: 'Service unavailable' } }, { status: 503 });
  }
}
