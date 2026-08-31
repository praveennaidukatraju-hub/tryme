import { schema } from '@tryme/db';
import { BulkGrantBody, DeductCreditsBody, GrantCreditsBody } from '@tryme/types';
import { desc, eq, sql, sum } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { recordAudit } from './audit.js';
import { requirePermission } from './guard.js';

export async function adminCreditsRoutes(app: FastifyInstance) {
  const W = requirePermission('credits.write');

  app.post(
    '/admin/credits/grant',
    { preHandler: W, schema: { body: GrantCreditsBody } },
    async (req) => {
      const { userId, amount, reason } = req.body as z.infer<typeof GrantCreditsBody>;
      const grantReason = reason || 'Manual credit grant';
      await app.db.transaction(async (tx) => {
        await tx
          .insert(schema.userCredits)
          .values({ userId, balance: amount })
          .onConflictDoUpdate({
            target: schema.userCredits.userId,
            set: { balance: sql`${schema.userCredits.balance} + ${amount}`, updatedAt: new Date() },
          });
        await tx.insert(schema.creditLedger).values({
          userId,
          delta: amount,
          reason: grantReason,
          adminId: req.userId,
        });
        await recordAudit(tx, {
          actor: { userId: req.userId, role: req.adminRole! },
          action: 'credits.grant',
          resourceType: 'user_credits',
          resourceId: userId,
          after: { amount, reason: grantReason },
          request: req,
        });
      });
      return { ok: true };
    },
  );

  app.post(
    '/admin/credits/bulk-grant',
    { preHandler: W, schema: { body: BulkGrantBody } },
    async (req) => {
      const { tier, amount, reason } = req.body as z.infer<typeof BulkGrantBody>;
      const grantReason = reason || `Bulk grant to tier: ${tier}`;
      const targets = await app.db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.tier, tier));
      for (const t of targets) {
        await app.db.transaction(async (tx) => {
          await tx
            .insert(schema.userCredits)
            .values({ userId: t.id, balance: amount })
            .onConflictDoUpdate({
              target: schema.userCredits.userId,
              set: {
                balance: sql`${schema.userCredits.balance} + ${amount}`,
                updatedAt: new Date(),
              },
            });
          await tx.insert(schema.creditLedger).values({
            userId: t.id,
            delta: amount,
            reason: grantReason,
            adminId: req.userId,
          });
          await recordAudit(tx, {
            actor: { userId: req.userId, role: req.adminRole! },
            action: 'credits.grant',
            resourceType: 'user_credits',
            resourceId: t.id,
            after: { amount, reason: grantReason, tier },
            request: req,
          });
        });
      }
      return { ok: true, count: targets.length };
    },
  );

  app.post(
    '/admin/credits/deduct',
    { preHandler: W, schema: { body: DeductCreditsBody } },
    async (req) => {
      const { userId, amount, reason } = req.body as z.infer<typeof DeductCreditsBody>;
      const deductReason = reason || 'Manual credit deduction';
      await app.db.transaction(async (tx) => {
        const res = await tx
          .update(schema.userCredits)
          .set({ balance: sql`${schema.userCredits.balance} - ${amount}`, updatedAt: new Date() })
          .where(
            sql`${schema.userCredits.userId}=${userId} AND ${schema.userCredits.balance} >= ${amount}`,
          )
          .returning();
        if (!res.length) throw new AppError('INSUFFICIENT', 409, 'cannot deduct below zero');
        await tx.insert(schema.creditLedger).values({
          userId,
          delta: -amount,
          reason: deductReason,
          adminId: req.userId,
        });
        await recordAudit(tx, {
          actor: { userId: req.userId, role: req.adminRole! },
          action: 'credits.deduct',
          resourceType: 'user_credits',
          resourceId: userId,
          after: { amount, reason: deductReason },
          request: req,
        });
      });
      return { ok: true };
    },
  );

  app.get(
    '/admin/credits/ledger/:userId',
    {
      preHandler: requirePermission('credits.read'),
      schema: { params: z.object({ userId: z.string().uuid() }) },
    },
    async (req) => {
      const { userId } = req.params as { userId: string };
      return app.db
        .select()
        .from(schema.creditLedger)
        .where(eq(schema.creditLedger.userId, userId))
        .orderBy(desc(schema.creditLedger.createdAt))
        .limit(200);
    },
  );

  app.get(
    '/admin/credits/stats',
    {
      preHandler: requirePermission('credits.read'),
    },
    async () => {
      const [issued] = await app.db
        .select({ s: sum(schema.creditLedger.delta) })
        .from(schema.creditLedger)
        .where(sql`${schema.creditLedger.delta} > 0`);
      const [consumed] = await app.db
        .select({ s: sum(schema.creditLedger.delta) })
        .from(schema.creditLedger)
        .where(sql`${schema.creditLedger.delta} < 0`);
      return { issued: Number(issued?.s ?? 0), consumed: Number(consumed?.s ?? 0) };
    },
  );
}
