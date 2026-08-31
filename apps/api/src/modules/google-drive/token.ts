import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { decryptToken, encryptToken } from '../../lib/crypto.js';
import { AppError } from '../../lib/errors.js';

const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';

type Connection = typeof schema.googleDriveConnections.$inferSelect;

function encKey(app: FastifyInstance): string {
  const key = app.env.GOOGLE_DRIVE_TOKEN_ENC_KEY;
  if (!key) throw new AppError('CONFIG', 500, 'GOOGLE_DRIVE_TOKEN_ENC_KEY missing');
  return key;
}

export async function getConnection(
  app: FastifyInstance,
  userId: string,
): Promise<Connection | undefined> {
  const [row] = await app.db
    .select()
    .from(schema.googleDriveConnections)
    .where(eq(schema.googleDriveConnections.userId, userId))
    .limit(1);
  return row;
}

/**
 * Decrypted, freshly-exchanged Drive access token for `userId`.
 *
 * Unlike Shopify's getValidAccessToken, this always exchanges (Drive access
 * tokens aren't stored — only the refresh token is persisted) rather than
 * checking a cached expiry, because export is a one-off user click, not a
 * background job worth optimizing away one token exchange for.
 */
export async function getValidDriveAccessToken(
  app: FastifyInstance,
  userId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  const row = await getConnection(app, userId);
  if (!row?.refreshTokenEnc || row.revokedAt) {
    throw new AppError('GOOGLE_DRIVE_NOT_CONNECTED', 409, 'Google Drive is not connected');
  }

  let refreshToken: string;
  try {
    refreshToken = decryptToken(row.refreshTokenEnc, encKey(app));
  } catch (err) {
    app.log.error({ err, userId }, 'drive refresh token failed to decrypt — reauth required');
    await markReauthRequired(app, row.id);
    throw new AppError('GOOGLE_DRIVE_REAUTH_REQUIRED', 403, 'Reconnect Google Drive to continue');
  }

  const res = await fetchImpl(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id: app.env.GOOGLE_CLIENT_ID ?? '',
      client_secret: app.env.GOOGLE_CLIENT_SECRET ?? '',
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    }),
  });

  if (!res.ok) {
    // invalid_grant (revoked at Google, or the shared-client grant was
    // revoked by a Drive disconnect elsewhere) lands here just as much as a
    // genuinely dead token — both need the same reconnect flow.
    app.log.warn({ userId, status: res.status }, 'drive token refresh failed — reauth required');
    await markReauthRequired(app, row.id);
    throw new AppError('GOOGLE_DRIVE_REAUTH_REQUIRED', 403, 'Reconnect Google Drive to continue');
  }

  const body = (await res.json()) as { access_token: string };
  return body.access_token;
}

export async function markReauthRequired(
  app: FastifyInstance,
  connectionId: string,
): Promise<void> {
  await app.db
    .update(schema.googleDriveConnections)
    .set({ refreshTokenEnc: null, revokedAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.googleDriveConnections.id, connectionId));
}

/** Upsert after a successful connect/reconnect. */
export async function saveConnection(
  app: FastifyInstance,
  userId: string,
  googleEmail: string,
  refreshToken: string,
  scope: string,
): Promise<void> {
  const encrypted = encryptToken(refreshToken, encKey(app));
  await app.db
    .insert(schema.googleDriveConnections)
    .values({ userId, googleEmail, refreshTokenEnc: encrypted, scope })
    .onConflictDoUpdate({
      target: schema.googleDriveConnections.userId,
      set: {
        googleEmail,
        refreshTokenEnc: encrypted,
        scope,
        revokedAt: null,
        updatedAt: new Date(),
      },
    });
}

/**
 * Best-effort revoke at Google, then always clear the local credential
 * regardless of whether the HTTP call succeeded.
 *
 * Revokes the user's ENTIRE Google grant for GOOGLE_CLIENT_ID, not just
 * drive.file, because login and Drive share one OAuth client (see
 * docs/superpowers/specs/2026-08-21-google-drive-export-design.md, "Why the
 * same OAuth client"). Harmless here: auth/google.routes.ts never persists a
 * Google credential, so the only visible effect is the user's next "Continue
 * with Google" click may show Google's consent screen again instead of a
 * silent bounce. Do not "fix" this into a second OAuth client without
 * re-reading that doc.
 */
export async function disconnect(
  app: FastifyInstance,
  userId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<void> {
  const row = await getConnection(app, userId);
  if (row?.refreshTokenEnc) {
    try {
      const refreshToken = decryptToken(row.refreshTokenEnc, encKey(app));
      const res = await fetchImpl(GOOGLE_REVOKE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token: refreshToken }),
      });
      if (!res.ok) {
        app.log.warn({ userId, status: res.status }, 'drive token revoke call failed at Google');
      }
    } catch (err) {
      app.log.warn({ err, userId }, 'drive token revoke skipped — could not decrypt');
    }
  }
  if (row) {
    await app.db
      .update(schema.googleDriveConnections)
      .set({ refreshTokenEnc: null, revokedAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.googleDriveConnections.id, row.id));
  }
}
