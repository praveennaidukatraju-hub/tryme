import { schema } from '@tryme/db';
import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { requirePermission } from './guard.js';

const PlanBody = z.object({
  slug: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/, 'slug must be lowercase letters, numbers, hyphens only'),
  name: z.string().min(1).max(100),
  subtext: z.string().max(200).default(''),
  // .nonnegative() not .positive() — the free plan legitimately costs 0 paise,
  // and 0 credits is a valid "free signups get nothing right now" state.
  credits: z.number().int().nonnegative(),
  basePaise: z.number().int().nonnegative(),
  isActive: z.boolean().default(true),
  isHighlighted: z.boolean().default(false),
  badge: z.string().max(50).nullable().default(null),
  sortOrder: z.number().int().default(0),
  queueStream: z.enum(['priority', 'normal', 'low']).default('normal'),
  watermark: z.boolean().default(false),
  // Which pricing tab this plan is sold under — each type is a fully
  // independent SKU (own slug/price/credits), never shared across tabs.
  planType: z.enum(['catalogue', 'tryon']).default('catalogue'),
  // Freeform marketing labels shown on the public pricing card — optional,
  // null clears the row entirely rather than hiding an empty string.
  perUnitPriceLabel: z.string().max(100).nullable().default(null),
  unitCountLabel: z.string().max(50).nullable().default(null),
});

export async function adminCreditPlansRoutes(app: FastifyInstance) {
  const W = requirePermission('credit_plans.write');

  app.get('/admin/credit-plans', { preHandler: W }, async () => {
    return app.db.select().from(schema.creditPlans).orderBy(asc(schema.creditPlans.sortOrder));
  });

  app.post('/admin/credit-plans', { preHandler: W, schema: { body: PlanBody } }, async (req) => {
    const body = req.body as z.infer<typeof PlanBody>;
    const [plan] = await app.db.insert(schema.creditPlans).values(body).returning();
    return plan;
  });

  app.patch(
    '/admin/credit-plans/:id',
    {
      preHandler: W,
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: PlanBody.partial(),
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const body = req.body as Partial<z.infer<typeof PlanBody>>;
      const [existing] = await app.db
        .select({ slug: schema.creditPlans.slug })
        .from(schema.creditPlans)
        .where(eq(schema.creditPlans.id, id));
      if (!existing) throw new AppError('NOT_FOUND', 404, 'plan not found');
      if (existing.slug === 'free' && body.slug && body.slug !== 'free')
        throw new AppError('FORBIDDEN', 403, 'cannot change the free plan slug');
      if (existing.slug === 'free' && body.isActive === false)
        throw new AppError(
          'FORBIDDEN',
          403,
          'cannot deactivate the free plan — new signups would silently get 0 free credits',
        );
      const [plan] = await app.db
        .update(schema.creditPlans)
        .set({ ...body, updatedAt: new Date() })
        .where(eq(schema.creditPlans.id, id))
        .returning();
      if (!plan) throw new AppError('NOT_FOUND', 404, 'plan not found');
      return plan;
    },
  );

  app.delete(
    '/admin/credit-plans/:id',
    {
      preHandler: W,
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const [plan] = await app.db
        .select({ slug: schema.creditPlans.slug })
        .from(schema.creditPlans)
        .where(eq(schema.creditPlans.id, id));
      if (!plan) throw new AppError('NOT_FOUND', 404, 'plan not found');
      if (plan.slug === 'free') throw new AppError('FORBIDDEN', 403, 'cannot delete the free plan');

      const [payment] = await app.db
        .select({ id: schema.payments.id })
        .from(schema.payments)
        .where(eq(schema.payments.planId, plan.slug))
        .limit(1);
      if (payment) {
        throw new AppError(
          'CONFLICT',
          409,
          'plan has existing payments; deactivate instead of deleting',
        );
      }

      // users.tier has a DB-level FK to credit_plans.slug (ON DELETE RESTRICT) as a
      // backstop, but check here first so the admin gets a clear 409 instead of a
      // raw Postgres constraint-violation error.
      const [userOnPlan] = await app.db
        .select({ id: schema.users.id })
        .from(schema.users)
        .where(eq(schema.users.tier, plan.slug))
        .limit(1);
      if (userOnPlan) {
        throw new AppError(
          'CONFLICT',
          409,
          'plan has users currently on it; deactivate instead of deleting',
        );
      }

      await app.db.delete(schema.creditPlans).where(eq(schema.creditPlans.id, id));
      reply.code(204).send();
    },
  );
}
