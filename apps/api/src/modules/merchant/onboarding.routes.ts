import { schema } from '@tryme/db';
import { MerchantOnboardingBody } from '@tryme/types';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { assignMerchantToActiveDemoSets } from './demo-catalog-read.js';
import { resolveMerchantStatus } from './status.js';

function fallbackContactName(displayName: string | null, email: string | null): string {
  return displayName?.trim() || email?.split('@')[0] || 'Merchant';
}

/**
 * Guarded by requireDeviceUser, NOT requireMerchant — the entire point is that no
 * merchants row exists yet, so requireMerchant would 403 every caller. Restricted
 * to device-app sessions (not requireUser) because this is an Android-app-only
 * flow: onboarding creates an active, zero-review merchant profile that shares
 * the user's existing credit balance, so a plain web session must not be able
 * to reach it.
 */
export async function merchantOnboardingRoutes(app: FastifyInstance) {
  app.get('/v1/merchant/onboarding', { preHandler: app.requireDeviceUser }, async (req) => {
    const [user] = await app.db
      .select({
        displayName: schema.users.displayName,
        email: schema.users.email,
        phone: schema.users.phone,
      })
      .from(schema.users)
      .where(eq(schema.users.id, req.userId));
    if (!user) throw new AppError('UNAUTH', 401, 'user not found');

    const contactName = fallbackContactName(user.displayName, user.email);
    return {
      merchantStatus: await resolveMerchantStatus(app, req.userId),
      prefill: { contactName, companyName: contactName, phone: user.phone ?? '' },
    };
  });

  app.post(
    '/v1/merchant/onboarding',
    { preHandler: app.requireDeviceUser, schema: { body: MerchantOnboardingBody } },
    async (req, reply) => {
      const body = req.body as z.infer<typeof MerchantOnboardingBody>;

      const merchantId = await app.db.transaction(async (tx) => {
        const [existing] = await tx
          .select({ id: schema.merchants.id })
          .from(schema.merchants)
          .where(eq(schema.merchants.userId, req.userId))
          .limit(1);
        if (existing) {
          throw new AppError('CONFLICT', 409, 'This account is already registered as a merchant');
        }

        const [user] = await tx
          .select({
            displayName: schema.users.displayName,
            email: schema.users.email,
            phone: schema.users.phone,
          })
          .from(schema.users)
          .where(eq(schema.users.id, req.userId))
          .limit(1);
        if (!user) throw new AppError('UNAUTH', 401, 'user not found');

        const contactName =
          body.contactName?.trim() || fallbackContactName(user.displayName, user.email);

        const [created] = await tx
          .insert(schema.merchants)
          .values({
            companyName: body.companyName?.trim() || contactName,
            contactName,
            phone: body.phone,
            // Same placeholder convention as POST /admin/merchants.
            businessAddress: body.businessAddress?.trim() || 'Not Provided',
            isActive: true,
            demoData: false,
            signupSource: 'android_google',
            userId: req.userId,
          })
          .returning({ id: schema.merchants.id });
        if (!created) throw new AppError('INTERNAL', 500, 'failed to create merchant');

        if (!user.phone) {
          await tx
            .update(schema.users)
            .set({ phone: body.phone })
            .where(eq(schema.users.id, req.userId));
        }

        return created.id;
      });

      await assignMerchantToActiveDemoSets(app.db, merchantId, req.userId);

      app.log.info(
        { userId: req.userId, merchantId, signupSource: 'android_google' },
        'merchant onboarding completed',
      );
      reply.code(201);
      return { merchantStatus: 'ACTIVE' as const, merchantId };
    },
  );
}
