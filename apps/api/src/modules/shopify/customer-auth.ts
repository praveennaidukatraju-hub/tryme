import { randomUUID } from 'node:crypto';
import type { Redis } from 'ioredis';

const LINK_CODE_TTL_SECS = 60;

export async function mintAccountLinkCode(redis: Redis, userId: string): Promise<string> {
  const code = randomUUID();
  await redis.set(`shopify:link:${code}`, userId, 'EX', LINK_CODE_TTL_SECS);
  return code;
}

export async function resolveAccountLinkCode(redis: Redis, code: string): Promise<string | null> {
  const key = `shopify:link:${code}`;
  const userId = await redis.get(key);
  if (userId) await redis.del(key);
  return userId;
}
