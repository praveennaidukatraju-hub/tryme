import { schema } from '@tryme/db';
import { asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { requirePermission } from './guard.js';

const RFC3339_DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;

const Rfc3339DateTime = z
  .string()
  .regex(RFC3339_DATE_TIME, 'must be an RFC3339 date-time')
  .refine((value) => {
    const match = value.match(RFC3339_DATE_TIME);
    if (!match) return true;

    const [, year, month, day] = match;
    const numericYear = Number(year);
    const numericMonth = Number(month);
    const numericDay = Number(day);
    const daysInMonth = [
      31,
      numericYear % 4 === 0 && (numericYear % 100 !== 0 || numericYear % 400 === 0) ? 29 : 28,
      31,
      30,
      31,
      30,
      31,
      31,
      30,
      31,
      30,
      31,
    ];
    return (
      numericMonth >= 1 &&
      numericMonth <= 12 &&
      numericDay >= 1 &&
      numericDay <= daysInMonth[numericMonth - 1]
    );
  }, 'must be a valid RFC3339 date-time')
  .transform((value) => new Date(value));

const CampaignBody = z.object({
  code: z
    .string()
    .min(1)
    .max(64)
    .regex(/^[a-z0-9-]+$/, 'code must be lowercase letters, numbers, hyphens only'),
  name: z.string().min(1).max(100),
  bonusPercent: z.number().int().min(0).max(100),
  startAt: Rfc3339DateTime,
  endAt: Rfc3339DateTime,
  isActive: z.boolean().default(true),
});

export async function adminSignupCampaignsRoutes(app: FastifyInstance) {
  const W = requirePermission('signup_campaigns.write');

  app.get('/admin/signup-campaigns', { preHandler: W }, async () => {
    return app.db
      .select()
      .from(schema.signupCampaigns)
      .orderBy(asc(schema.signupCampaigns.createdAt));
  });

  app.post(
    '/admin/signup-campaigns',
    { preHandler: W, schema: { body: CampaignBody } },
    async (req) => {
      const body = req.body as z.infer<typeof CampaignBody>;
      if (body.endAt <= body.startAt) {
        throw new AppError('INVALID_WINDOW', 400, 'endAt must be after startAt');
      }
      const [campaign] = await app.db.insert(schema.signupCampaigns).values(body).returning();
      return campaign;
    },
  );

  app.patch(
    '/admin/signup-campaigns/:id',
    {
      preHandler: W,
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: CampaignBody.partial(),
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const body = req.body as Partial<z.infer<typeof CampaignBody>>;
      const campaign = await app.db.transaction(async (tx) => {
        const [existing] = await tx
          .select()
          .from(schema.signupCampaigns)
          .where(eq(schema.signupCampaigns.id, id))
          .for('update');
        if (!existing) throw new AppError('NOT_FOUND', 404, 'campaign not found');

        const nextStart = body.startAt ?? existing.startAt;
        const nextEnd = body.endAt ?? existing.endAt;
        if (nextEnd <= nextStart) {
          throw new AppError('INVALID_WINDOW', 400, 'endAt must be after startAt');
        }

        const [updatedCampaign] = await tx
          .update(schema.signupCampaigns)
          .set({ ...body, updatedAt: new Date() })
          .where(eq(schema.signupCampaigns.id, id))
          .returning();
        return updatedCampaign;
      });
      if (!campaign) throw new AppError('NOT_FOUND', 404, 'campaign not found');
      return campaign;
    },
  );

  app.delete(
    '/admin/signup-campaigns/:id',
    { preHandler: W, schema: { params: z.object({ id: z.string().uuid() }) } },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      await app.db.transaction(async (tx) => {
        const [campaign] = await tx
          .select({ id: schema.signupCampaigns.id })
          .from(schema.signupCampaigns)
          .where(eq(schema.signupCampaigns.id, id))
          .for('update');
        if (!campaign) throw new AppError('NOT_FOUND', 404, 'campaign not found');

        const [attributedUser] = await tx
          .select({ id: schema.users.id })
          .from(schema.users)
          .where(eq(schema.users.signupCampaignId, id))
          .limit(1);
        if (attributedUser) {
          throw new AppError(
            'CONFLICT',
            409,
            'campaign has users attributed to it; deactivate instead of deleting',
          );
        }

        await tx.delete(schema.signupCampaigns).where(eq(schema.signupCampaigns.id, id));
      });
      reply.code(204).send();
    },
  );
}
