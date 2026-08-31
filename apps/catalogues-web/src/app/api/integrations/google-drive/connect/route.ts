import { type NextRequest, NextResponse } from 'next/server';

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000';

export async function GET(req: NextRequest) {
  const refreshToken = req.cookies.get('refresh')?.value;
  if (!refreshToken) {
    return NextResponse.redirect(new URL('/login', req.url));
  }

  const refreshRes = await fetch(`${API_URL}/v1/auth/refresh`, {
    method: 'POST',
    headers: { Cookie: `refresh=${refreshToken}` },
  });
  if (!refreshRes.ok) {
    return NextResponse.redirect(new URL('/login', req.url));
  }
  const data = (await refreshRes.json()) as { accessToken: string };

  const apiUrl = new URL('/v1/integrations/google-drive/connect', API_URL);
  const forceConsent = req.nextUrl.searchParams.get('forceConsent');
  if (forceConsent) apiUrl.searchParams.set('forceConsent', forceConsent);

  const connectRes = await fetch(apiUrl, {
    headers: { Authorization: `Bearer ${data.accessToken}` },
    redirect: 'manual',
  });

  const location = connectRes.headers.get('location');
  if (location) {
    return NextResponse.redirect(location);
  }
  return NextResponse.redirect(new URL('/studio?drive_error=connect_failed', req.url));
}
