import { createHash, randomBytes } from 'node:crypto';

const PREFIX = 'sk_live_';

// 32 random bytes → base64url is 43 chars, alphabet [A-Za-z0-9_-]. Deliberately
// NOT sticky (no /g flag): a sticky regex carries lastIndex between .test()
// calls and would intermittently reject valid keys.
export const API_KEY_RE = /^sk_live_[A-Za-z0-9_-]{43}$/;

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export function generateApiKey(): { key: string; keyHash: string; keyPrefix: string } {
  const key = PREFIX + randomBytes(32).toString('base64url');
  return { key, keyHash: hashApiKey(key), keyPrefix: key.slice(0, 12) };
}

export function extractBearer(header: string | undefined): string | undefined {
  if (!header?.startsWith('Bearer ')) return undefined;
  return header.slice(7) || undefined;
}
