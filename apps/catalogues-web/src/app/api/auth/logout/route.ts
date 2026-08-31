import { type NextRequest, NextResponse } from 'next/server';
import { clearAuthCookies } from '@/lib/auth-cookies';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export async function POST(req: NextRequest) {
  const refreshToken = req.cookies.get('refresh')?.value;
  if (refreshToken) {
    await fetch(`${API_URL}/v1/auth/logout`, {
      method: 'POST',
      headers: { Cookie: `refresh=${refreshToken}` },
    }).catch(() => {});
  }
  const response = NextResponse.json({ ok: true });
  clearAuthCookies(response);
  return response;
}
