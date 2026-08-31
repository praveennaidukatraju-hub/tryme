import type { Env } from '../env.js';

/** No allowlist configured (CATALOG_VIDEO_ALLOWED_EMAILS unset) = open to everyone. */
export function isCatalogVideoAllowed(
  env: Pick<Env, 'CATALOG_VIDEO_ALLOWED_EMAILS'>,
  email: string | null,
): boolean {
  const allowlist = env.CATALOG_VIDEO_ALLOWED_EMAILS;
  if (!allowlist) return true;
  if (!email) return false;
  const allowed = allowlist
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  return allowed.includes(email.toLowerCase());
}
