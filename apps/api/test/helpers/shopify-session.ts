import { createHmac } from 'node:crypto';

function b64(o: unknown): string {
  return Buffer.from(JSON.stringify(o)).toString('base64url');
}

/** Raw signer — takes an arbitrary claims object, useful for constructing
 *  deliberately-invalid tokens (wrong aud, expired, etc.) in negative tests. */
export function signHs256(payloadObj: Record<string, unknown>, secret: string): string {
  const head = b64({ alg: 'HS256', typ: 'JWT' });
  const body = b64(payloadObj);
  const sig = createHmac('sha256', secret).update(`${head}.${body}`).digest('base64url');
  return `${head}.${body}.${sig}`;
}

/** Convenience wrapper over signHs256 for the common case: a valid,
 *  currently-live session token for a given shop. */
export function signSessionToken(shopDomain: string, secret: string, apiKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  return signHs256(
    {
      iss: `https://${shopDomain}/admin`,
      dest: `https://${shopDomain}`,
      aud: apiKey,
      exp: now + 60,
      nbf: now - 5,
      iat: now,
    },
    secret,
  );
}
