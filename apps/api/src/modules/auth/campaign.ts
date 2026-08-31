import { type DB, schema } from '@tryme/db';
import { and, eq, gte, lte } from 'drizzle-orm';

export type DbOrTx = DB | Parameters<Parameters<DB['transaction']>[0]>[0];

/**
 * Resolves a `?src=` signup-campaign code to its DB id — only if the campaign
 * is active and `now` falls inside its date window. Returns null for any
 * non-match (unknown code, expired, inactive, or no code at all): a bad code
 * must be indistinguishable from no code to the caller.
 */
export async function resolveCampaignId(
  db: DbOrTx,
  code: string | undefined | null,
): Promise<string | null> {
  if (!code) return null;
  const now = new Date();
  const [campaign] = await db
    .select({ id: schema.signupCampaigns.id })
    .from(schema.signupCampaigns)
    .where(
      and(
        eq(schema.signupCampaigns.code, code),
        eq(schema.signupCampaigns.isActive, true),
        lte(schema.signupCampaigns.startAt, now),
        gte(schema.signupCampaigns.endAt, now),
      ),
    )
    .for('share');
  return campaign?.id ?? null;
}
