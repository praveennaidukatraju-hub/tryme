import { schema } from '@tryme/db';
import { eq, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { AppError } from '../../lib/errors.js';

export async function merchantMeRoutes(app: FastifyInstance) {
  app.get('/v1/merchant/me', { preHandler: app.requireMerchant }, async (req) => {
    const merchantId = req.merchantClientId;
    if (!merchantId) throw new AppError('UNAUTH', 401, 'missing merchant');

    const [row] = await app.db
      .select({
        displayName: schema.users.displayName,
        email: schema.users.email,
        balance: sql<number>`COALESCE(${schema.userCredits.balance}, 0)`,
      })
      .from(schema.merchants)
      .innerJoin(schema.users, eq(schema.users.id, schema.merchants.userId))
      .leftJoin(schema.userCredits, eq(schema.userCredits.userId, schema.merchants.userId))
      .where(eq(schema.merchants.id, merchantId));
    if (!row) throw new AppError('NOT_FOUND', 404, 'merchant not found');

    // Lifetime spend, not a rolling window — matches the "available vs used"
    // framing the merchant portal shows credits with.
    const [usage] = await app.db
      .select({
        used: sql<number>`COALESCE(SUM(CASE WHEN ${schema.creditLedger.delta} < 0 THEN -${schema.creditLedger.delta} ELSE 0 END), 0)::int`,
      })
      .from(schema.creditLedger)
      .innerJoin(schema.merchants, eq(schema.merchants.userId, schema.creditLedger.userId))
      .where(eq(schema.merchants.id, merchantId));

    return { ...row, used: usage?.used ?? 0 };
  });
}
