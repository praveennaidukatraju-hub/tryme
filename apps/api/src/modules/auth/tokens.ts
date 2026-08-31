import { schema } from '@tryme/db';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { newRefreshToken, signAccess } from './service.js';

export async function createSessionTokens(
  app: FastifyInstance,
  userId: string,
  reply: FastifyReply,
  status: number,
  portal: 'web' | 'catalog-app' = 'web',
) {
  const secret = new TextEncoder().encode(app.env.JWT_SECRET);
  const audience = portal === 'catalog-app' ? 'catalog-app' : undefined;
  const accessToken = await signAccess(
    secret,
    userId,
    { kind: 'access' },
    app.env.JWT_EXPIRY,
    audience,
  );
  const r = newRefreshToken();
  const expiresAt = new Date(Date.now() + parseDuration(app.env.REFRESH_TOKEN_EXPIRY));
  await app.db.insert(schema.refreshTokens).values({
    userId,
    familyId: crypto.randomUUID(),
    generation: 1,
    tokenHash: r.hash,
    expiresAt,
    portal,
  });
  const cookieName = portal === 'catalog-app' ? 'catalog_app_refresh' : 'refresh';
  reply.setCookie(cookieName, r.plain, {
    httpOnly: true,
    secure: app.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/v1/auth',
    expires: expiresAt,
    signed: false,
  });
  reply.code(status);
  return { accessToken };
}

export async function createAdminSessionTokens(
  app: FastifyInstance,
  userId: string,
  reply: FastifyReply,
  status: number,
) {
  const secret = new TextEncoder().encode(app.env.JWT_SECRET);
  const accessToken = await signAccess(
    secret,
    userId,
    { kind: 'access' },
    app.env.JWT_EXPIRY,
    'admin',
  );
  const r = newRefreshToken();
  const expiresAt = new Date(Date.now() + parseDuration(app.env.REFRESH_TOKEN_EXPIRY));
  await app.db.insert(schema.refreshTokens).values({
    userId,
    familyId: crypto.randomUUID(),
    generation: 1,
    tokenHash: r.hash,
    expiresAt,
    portal: 'admin',
  });
  reply.setCookie('refresh', r.plain, {
    httpOnly: true,
    secure: app.env.NODE_ENV === 'production',
    sameSite: 'lax',
    path: '/admin/auth',
    expires: expiresAt,
    signed: false,
  });
  reply.code(status);
  return { accessToken };
}

const DURATION_UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

export function parseDuration(s: string): number {
  const m = /^(\d+)(s|m|h|d)$/.exec(s);
  const count = m?.[1];
  const unit = m?.[2];
  if (!count || !unit) throw new Error(`bad duration: ${s}`);
  return Number(count) * DURATION_UNIT_MS[unit];
}
