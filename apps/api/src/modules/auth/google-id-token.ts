import { createRemoteJWKSet, type JWTVerifyGetKey, jwtVerify } from 'jose';
import { AppError } from '../../lib/errors.js';

export interface GoogleIdentity {
  sub: string;
  email: string;
  name?: string;
  picture?: string;
}

// Google publishes both spellings in the `iss` claim depending on the flow.
const GOOGLE_ISSUERS = ['accounts.google.com', 'https://accounts.google.com'];
const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';

// Module-level so the key set is fetched once per process and cached by jose.
// Building it per request would refetch Google's certs on every single login.
let remoteJwks: JWTVerifyGetKey | undefined;
let keyGetterOverride: JWTVerifyGetKey | undefined;

function googleJwks(): JWTVerifyGetKey {
  if (!remoteJwks) remoteJwks = createRemoteJWKSet(new URL(GOOGLE_JWKS_URL));
  return remoteJwks;
}

/**
 * Test seam: lets the suite verify against a locally generated JWKS instead of
 * Google's, so the real issuer/audience/expiry checks still run for real.
 */
export function setGoogleKeyGetterForTests(getKey: JWTVerifyGetKey | undefined): void {
  keyGetterOverride = getKey;
}

/**
 * Accepted `aud` values. With Android Credential Manager configured with
 * serverClientId = the Web client ID, the ID token's aud IS that web client ID,
 * so GOOGLE_CLIENT_ID alone is normally enough. GOOGLE_DEVICE_AUDIENCES exists so
 * a separately-issued Android client ID can be accepted without a code change.
 */
export function parseAcceptedAudiences(clientId?: string, extra?: string): string[] {
  const candidates = [clientId, ...(extra ?? '').split(',')]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  return [...new Set(candidates)];
}

export async function verifyGoogleIdToken(
  idToken: string,
  audiences: string[],
  getKey?: JWTVerifyGetKey,
): Promise<GoogleIdentity> {
  if (audiences.length === 0) {
    throw new AppError('GOOGLE_NOT_CONFIGURED', 503, 'google sign-in is not configured');
  }

  let payload: Record<string, unknown>;
  try {
    ({ payload } = await jwtVerify(idToken, getKey ?? keyGetterOverride ?? googleJwks(), {
      issuer: GOOGLE_ISSUERS,
      audience: audiences,
      algorithms: ['RS256'],
    }));
  } catch {
    throw new AppError('INVALID_GOOGLE_TOKEN', 401, 'google id token is invalid or expired');
  }

  const sub = typeof payload.sub === 'string' ? payload.sub : '';
  const email = typeof payload.email === 'string' ? payload.email : '';
  if (!sub || !email) {
    throw new AppError('INVALID_GOOGLE_TOKEN', 401, 'google id token is missing sub or email');
  }
  // Google sets email_verified as a boolean, but some legacy responses stringify it.
  if (payload.email_verified !== true && payload.email_verified !== 'true') {
    throw new AppError('GOOGLE_EMAIL_UNVERIFIED', 401, 'google email is not verified');
  }

  return {
    sub,
    email: email.toLowerCase(),
    name: typeof payload.name === 'string' ? payload.name : undefined,
    picture: typeof payload.picture === 'string' ? payload.picture : undefined,
  };
}
