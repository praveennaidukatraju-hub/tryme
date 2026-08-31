import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { beforeAll, describe, expect, it } from 'vitest';
import {
  type GoogleIdentity,
  parseAcceptedAudiences,
  verifyGoogleIdToken,
} from '../src/modules/auth/google-id-token.js';

const AUD = 'test-web-client-id.apps.googleusercontent.com';
let privateKey: CryptoKey;
let getKey: ReturnType<typeof createLocalJWKSet>;

beforeAll(async () => {
  const pair = await generateKeyPair('RS256');
  privateKey = pair.privateKey;
  const jwk = await exportJWK(pair.publicKey);
  jwk.kid = 'test-kid';
  jwk.alg = 'RS256';
  getKey = createLocalJWKSet({ keys: [jwk] });
});

async function sign(
  claims: Record<string, unknown>,
  opts: { aud?: string; iss?: string; exp?: string } = {},
) {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: 'RS256', kid: 'test-kid' })
    .setIssuer(opts.iss ?? 'https://accounts.google.com')
    .setAudience(opts.aud ?? AUD)
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? '5m')
    .sign(privateKey);
}

describe('parseAcceptedAudiences', () => {
  it('merges the client id with the comma-separated extras and de-dupes', () => {
    expect(parseAcceptedAudiences('a', 'b, c ,a')).toEqual(['a', 'b', 'c']);
  });

  it('returns an empty list when nothing is configured', () => {
    expect(parseAcceptedAudiences(undefined, undefined)).toEqual([]);
  });
});

describe('verifyGoogleIdToken', () => {
  it('returns the identity for a valid token', async () => {
    const token = await sign({
      sub: '1234567890',
      email: 'Person@Example.com',
      email_verified: true,
      name: 'A Person',
      picture: 'https://example.com/p.jpg',
    });
    const identity: GoogleIdentity = await verifyGoogleIdToken(token, [AUD], getKey);
    expect(identity).toEqual({
      sub: '1234567890',
      email: 'person@example.com',
      name: 'A Person',
      picture: 'https://example.com/p.jpg',
    });
  });

  it('rejects a token minted for a different audience', async () => {
    const token = await sign(
      { sub: 's', email: 'a@b.com', email_verified: true },
      { aud: 'other' },
    );
    await expect(verifyGoogleIdToken(token, [AUD], getKey)).rejects.toMatchObject({
      code: 'INVALID_GOOGLE_TOKEN',
      statusCode: 401,
    });
  });

  it('rejects a token from a non-Google issuer', async () => {
    const token = await sign(
      { sub: 's', email: 'a@b.com', email_verified: true },
      { iss: 'https://evil.test' },
    );
    await expect(verifyGoogleIdToken(token, [AUD], getKey)).rejects.toMatchObject({
      code: 'INVALID_GOOGLE_TOKEN',
    });
  });

  it('rejects an expired token', async () => {
    const token = await sign({ sub: 's', email: 'a@b.com', email_verified: true }, { exp: '-1m' });
    await expect(verifyGoogleIdToken(token, [AUD], getKey)).rejects.toMatchObject({
      code: 'INVALID_GOOGLE_TOKEN',
    });
  });

  it('rejects an unverified Google email', async () => {
    const token = await sign({ sub: 's', email: 'a@b.com', email_verified: false });
    await expect(verifyGoogleIdToken(token, [AUD], getKey)).rejects.toMatchObject({
      code: 'GOOGLE_EMAIL_UNVERIFIED',
      statusCode: 401,
    });
  });

  it('rejects a token with no email claim', async () => {
    const token = await sign({ sub: 's', email_verified: true });
    await expect(verifyGoogleIdToken(token, [AUD], getKey)).rejects.toMatchObject({
      code: 'INVALID_GOOGLE_TOKEN',
    });
  });

  it('rejects when no audience is configured at all', async () => {
    const token = await sign({ sub: 's', email: 'a@b.com', email_verified: true });
    await expect(verifyGoogleIdToken(token, [], getKey)).rejects.toMatchObject({
      code: 'GOOGLE_NOT_CONFIGURED',
      statusCode: 503,
    });
  });
});
