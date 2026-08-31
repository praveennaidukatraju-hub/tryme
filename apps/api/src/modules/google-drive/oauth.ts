const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
// Not Google's general /oauth2/v3/userinfo — that endpoint requires an
// email/openid scope this token deliberately doesn't carry (drive.file only,
// see DRIVE_SCOPE below). Drive's own `about` endpoint returns the connected
// account's email and is covered by drive.file, so it gets us the email
// without widening the OAuth consent beyond what Drive export actually needs.
const GOOGLE_DRIVE_ABOUT_URL = 'https://www.googleapis.com/drive/v3/about?fields=user';
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

export function buildAuthUrl(
  clientId: string,
  redirectUri: string,
  state: string,
  forceConsent: boolean,
): string {
  const url = new URL(GOOGLE_AUTH_URL);
  url.searchParams.set('client_id', clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', DRIVE_SCOPE);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('state', state);
  // Only forced on reconnect: Google returns a refresh token on the first-ever
  // consent for this scope regardless of prompt=consent, but stays silent on
  // a repeat grant unless consent is forced — which is exactly the case where
  // markReauthRequired() has already cleared our copy and we need a new one.
  if (forceConsent) url.searchParams.set('prompt', 'consent');
  return url.toString();
}

export async function exchangeCode(
  clientId: string,
  clientSecret: string,
  redirectUri: string,
  code: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ refreshToken: string | null; scope: string; accessToken: string }> {
  const res = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret,
      redirect_uri: redirectUri,
      grant_type: 'authorization_code',
    }),
  });
  if (!res.ok) throw new Error(`drive code exchange failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as {
    access_token: string;
    refresh_token?: string;
    scope: string;
  };
  return {
    refreshToken: body.refresh_token ?? null,
    scope: body.scope,
    accessToken: body.access_token,
  };
}

export async function fetchGoogleEmail(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const res = await fetchImpl(GOOGLE_DRIVE_ABOUT_URL, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`drive about fetch failed: ${res.status} ${await res.text()}`);
  const body = (await res.json()) as { user: { emailAddress: string } };
  return body.user.emailAddress.toLowerCase();
}
