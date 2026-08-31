import { schema } from '@tryme/db';
import { and, eq, sql } from 'drizzle-orm';
import { AppError } from '../../lib/errors.js';
import type { DbOrTx } from './campaign.js';
import type { GoogleIdentity } from './google-id-token.js';

/**
 * Credits granted to a brand-new account, from the active `free` credit plan --
 * boosted by campaignId's bonusPercent if the signup is campaign-attributed.
 * campaignId is null for the native Android device-login route (no QR concept
 * there) and for any signup that didn't carry a matching ?src=.
 */
export async function resolveFreeCredits(
  db: DbOrTx,
  campaignId: string | null = null,
): Promise<number> {
  const [plan] = await db
    .select({ credits: schema.creditPlans.credits })
    .from(schema.creditPlans)
    .where(and(eq(schema.creditPlans.slug, 'free'), eq(schema.creditPlans.isActive, true)));
  const baseCredits = plan?.credits ?? 0;
  if (baseCredits <= 0 || !campaignId) return baseCredits;

  const [campaign] = await db
    .select({ bonusPercent: schema.signupCampaigns.bonusPercent })
    .from(schema.signupCampaigns)
    .where(eq(schema.signupCampaigns.id, campaignId));
  if (!campaign) return baseCredits;

  return Math.round(baseCredits * (1 + campaign.bonusPercent / 100));
}

/**
 * Find-link-create ladder for a verified Google identity. Shared by the browser
 * OAuth callback (/v1/auth/google/callback) and the native device route
 * (/v1/auth/device-login/google) so the two can never drift apart.
 *
 * Must be called inside a transaction — it writes across users, user_credits,
 * credit_ledger and oauth_accounts.
 */
export async function upsertGoogleUser(
  tx: DbOrTx,
  googleUser: GoogleIdentity,
  freeCredits: number,
  campaignId: string | null = null,
): Promise<{ userId: string; isNewUser: boolean }> {
  // 1. Existing OAuth link wins outright.
  const [existingLink] = await tx
    .select({ userId: schema.oauthAccounts.userId })
    .from(schema.oauthAccounts)
    .where(
      and(
        eq(schema.oauthAccounts.provider, 'google'),
        eq(schema.oauthAccounts.providerId, googleUser.sub),
      ),
    );

  if (existingLink) {
    await tx
      .update(schema.oauthAccounts)
      .set({ displayName: googleUser.name, avatarUrl: googleUser.picture })
      .where(
        and(
          eq(schema.oauthAccounts.provider, 'google'),
          eq(schema.oauthAccounts.providerId, googleUser.sub),
        ),
      );
    const [user] = await tx
      .select({ isBanned: schema.users.isBanned })
      .from(schema.users)
      .where(eq(schema.users.id, existingLink.userId));
    if (user?.isBanned) throw new AppError('BANNED', 403, 'account banned');
    // Ensure emailVerified on every Google login (handles pre-existing unverified accounts).
    await tx
      .update(schema.users)
      .set({ emailVerified: true })
      .where(eq(schema.users.id, existingLink.userId));
    return { userId: existingLink.userId, isNewUser: false };
  }

  // 2. Same email — link Google onto the existing account.
  let uid: string;
  let isNewUser = false;
  const [byEmail] = await tx
    .select({ id: schema.users.id, isBanned: schema.users.isBanned })
    .from(schema.users)
    .where(eq(schema.users.email, googleUser.email));

  if (byEmail) {
    if (byEmail.isBanned) throw new AppError('BANNED', 403, 'account banned');
    uid = byEmail.id;
    // Google confirmed ownership of the address.
    await tx.update(schema.users).set({ emailVerified: true }).where(eq(schema.users.id, uid));
  } else {
    // 3. Brand-new account — Google accounts are pre-verified and passwordless.
    const [newUser] = await tx
      .insert(schema.users)
      .values({
        email: googleUser.email,
        passwordHash: null,
        displayName: googleUser.name ?? null,
        companyName: null,
        emailVerified: true,
        tier: 'free',
        signupCampaignId: campaignId,
      })
      .returning({ id: schema.users.id });
    if (!newUser) throw new AppError('INTERNAL', 500, 'failed to create user');
    uid = newUser.id;
    isNewUser = true;
    await tx.insert(schema.userCredits).values({ userId: uid, balance: 0 });
    if (freeCredits > 0) {
      await tx
        .update(schema.userCredits)
        .set({
          balance: sql`${schema.userCredits.balance} + ${freeCredits}`,
          updatedAt: new Date(),
        })
        .where(eq(schema.userCredits.userId, uid));
      await tx
        .insert(schema.creditLedger)
        .values({ userId: uid, delta: freeCredits, reason: 'FREE_TRIAL' });
    }
  }

  // 4. Create the OAuth link. onConflictDoNothing + re-select handles the race
  // where a concurrent request already inserted the same (provider, providerId).
  await tx
    .insert(schema.oauthAccounts)
    .values({
      userId: uid,
      provider: 'google',
      providerId: googleUser.sub,
      email: googleUser.email,
      displayName: googleUser.name ?? null,
      avatarUrl: googleUser.picture ?? null,
    })
    .onConflictDoNothing();

  const [linked] = await tx
    .select({ userId: schema.oauthAccounts.userId })
    .from(schema.oauthAccounts)
    .where(
      and(
        eq(schema.oauthAccounts.provider, 'google'),
        eq(schema.oauthAccounts.providerId, googleUser.sub),
      ),
    );
  if (!linked) throw new AppError('INTERNAL', 500, 'failed to link google account');
  return { userId: linked.userId, isNewUser };
}
