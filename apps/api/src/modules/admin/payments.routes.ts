import { schema } from '@tryme/db';
import { and, desc, eq, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdmin } from './guard.js';

const STATUSES = ['created', 'paid', 'failed'] as const;

const ListQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  // Matches invoice number, Razorpay order/payment id, or user email —
  // whichever a support agent has on hand when a customer asks about a charge.
  search: z.string().optional(),
  status: z.enum(['all', ...STATUSES]).default('all'),
});

export async function adminPaymentsRoutes(app: FastifyInstance) {
  const ALL = requireAdmin(['SUPER_ADMIN', 'SUPPORT', 'ADMIN']);

  app.get(
    '/admin/payments',
    { preHandler: ALL, schema: { querystring: ListQuery } },
    async (req) => {
      const { page, pageSize, search, status } = req.query as z.infer<typeof ListQuery>;

      const conditions = [];
      if (status !== 'all') conditions.push(eq(schema.payments.status, status));
      if (search) {
        const term = `%${search}%`;
        conditions.push(
          or(
            sql`${schema.invoices.invoiceNumber} ILIKE ${term}`,
            sql`${schema.payments.razorpayOrderId} ILIKE ${term}`,
            sql`${schema.payments.razorpayPaymentId} ILIKE ${term}`,
            sql`${schema.users.email} ILIKE ${term}`,
          ),
        );
      }
      const where = conditions.length ? and(...conditions) : undefined;

      // Joins duplicated across the count and the page query — this repo's
      // query builder can't share a partial `.from()...where()` between two
      // different `.select()` projections (see credit-analysis.routes.ts).
      const [{ count }] = await app.db
        .select({ count: sql<number>`count(*)::int` })
        .from(schema.payments)
        .leftJoin(schema.users, eq(schema.users.id, schema.payments.userId))
        .leftJoin(schema.creditPlans, eq(schema.creditPlans.slug, schema.payments.planId))
        .leftJoin(schema.invoices, eq(schema.invoices.paymentId, schema.payments.id))
        .where(where);

      const rows = await app.db
        .select({
          id: schema.payments.id,
          userId: schema.payments.userId,
          userEmail: schema.users.email,
          userDisplayName: schema.users.displayName,
          userTier: schema.users.tier,
          planId: schema.payments.planId,
          planName: schema.creditPlans.name,
          credits: schema.payments.credits,
          basePaise: schema.payments.basePaise,
          gstPaise: schema.payments.gstPaise,
          totalPaise: schema.payments.totalPaise,
          gstin: schema.payments.gstin,
          razorpayOrderId: schema.payments.razorpayOrderId,
          razorpayPaymentId: schema.payments.razorpayPaymentId,
          status: schema.payments.status,
          createdAt: schema.payments.createdAt,
          paidAt: schema.payments.paidAt,
          invoiceNumber: schema.invoices.invoiceNumber,
          invoiceR2Key: schema.invoices.r2Key,
        })
        .from(schema.payments)
        .leftJoin(schema.users, eq(schema.users.id, schema.payments.userId))
        .leftJoin(schema.creditPlans, eq(schema.creditPlans.slug, schema.payments.planId))
        .leftJoin(schema.invoices, eq(schema.invoices.paymentId, schema.payments.id))
        .where(where)
        .orderBy(desc(schema.payments.createdAt))
        .limit(pageSize)
        .offset((page - 1) * pageSize);

      const items = await Promise.all(
        rows.map(async ({ invoiceR2Key, ...row }) => ({
          ...row,
          invoiceUrl: invoiceR2Key ? (await app.storage.presignGet(invoiceR2Key, 3600)).url : null,
        })),
      );

      return { page, pageSize, total: count, items };
    },
  );
}
