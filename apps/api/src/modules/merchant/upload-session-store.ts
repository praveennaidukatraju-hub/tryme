import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';

// Ten minutes is enough for a customer to scan, take a photo, and upload it.
export const UPLOAD_SESSION_TTL_SECONDS = 600;

export interface UploadSession {
  merchantId: string;
  r2Key: string;
  status: 'pending' | 'uploaded';
}

function sessionRedisKey(tokenHash: string): string {
  return `merchant-upload-session:${tokenHash}`;
}

export function generateUploadToken(): string {
  return randomBytes(32).toString('base64url');
}

export function hashUploadToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export async function createUploadSession(
  app: FastifyInstance,
  merchantId: string,
  r2Key: string,
): Promise<string> {
  const token = generateUploadToken();
  const tokenHash = hashUploadToken(token);
  const session: UploadSession = { merchantId, r2Key, status: 'pending' };
  await app.redis.set(
    sessionRedisKey(tokenHash),
    JSON.stringify(session),
    'EX',
    UPLOAD_SESSION_TTL_SECONDS,
  );
  await app.redis.set(`upload:owner:${r2Key}`, merchantId, 'EX', UPLOAD_SESSION_TTL_SECONDS);
  return token;
}

export async function getUploadSession(
  app: FastifyInstance,
  token: string,
): Promise<UploadSession | null> {
  const raw = await app.redis.get(sessionRedisKey(hashUploadToken(token)));
  if (!raw) return null;
  return JSON.parse(raw) as UploadSession;
}

export async function markUploadSessionUploaded(
  app: FastifyInstance,
  token: string,
): Promise<void> {
  const tokenHash = hashUploadToken(token);
  const raw = await app.redis.get(sessionRedisKey(tokenHash));
  if (!raw) return;
  const session = JSON.parse(raw) as UploadSession;
  session.status = 'uploaded';
  await app.redis.set(sessionRedisKey(tokenHash), JSON.stringify(session), 'KEEPTTL');
}

export async function deleteUploadSession(app: FastifyInstance, token: string): Promise<void> {
  await app.redis.del(sessionRedisKey(hashUploadToken(token)));
}
