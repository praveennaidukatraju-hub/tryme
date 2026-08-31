import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { keys } from '@tryme/storage';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { sendReportReceivedEmail } from '../../lib/mailer.js';

const CONTENT_TYPE_TO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'application/pdf': 'pdf',
};

export async function supportRoutes(app: FastifyInstance) {
  // POST /v1/support/presign — get a presigned URL for an optional attachment
  app.post(
    '/v1/support/presign',
    {
      preHandler: app.requireUser,
      schema: {
        body: z.object({
          contentType: z.enum(['image/jpeg', 'image/png', 'image/webp', 'application/pdf']),
        }),
      },
    },
    async (req) => {
      const { contentType } = req.body as { contentType: string };
      const ext = CONTENT_TYPE_TO_EXT[contentType] ?? 'bin';
      const id = randomUUID();
      const attachmentKey = keys.supportAttachment(id, ext);
      const { url } = await app.storage.presignPut(attachmentKey, contentType, 0, 900);
      return { uploadUrl: url, attachmentKey };
    },
  );

  // POST /v1/support — submit a support ticket (authenticated)
  app.post(
    '/v1/support',
    {
      preHandler: app.requireUser,
      schema: {
        body: z.object({
          message: z.string().min(1).max(3000),
          attachmentKey: z.string().optional(),
        }),
      },
    },
    async (req) => {
      const { message, attachmentKey } = req.body as { message: string; attachmentKey?: string };

      const [user] = await app.db
        .select({
          name: schema.users.displayName,
          email: schema.users.email,
          phone: schema.users.phone,
        })
        .from(schema.users)
        .where(eq(schema.users.id, req.userId))
        .limit(1);

      const name = user?.name ?? user?.email?.split('@')[0] ?? 'App User';
      const email = user?.email ?? '';
      const phone = user?.phone ?? '';

      const [row] = await app.db
        .insert(schema.contactRequests)
        .values({
          userId: req.userId,
          name,
          email,
          phone,
          message,
          attachmentKey: attachmentKey ?? null,
          source: 'app-support',
          status: 'new',
        })
        .returning({ id: schema.contactRequests.id });

      if (email) {
        try {
          await sendReportReceivedEmail(app.env.RESEND_API_KEY, app.env.EMAIL_FROM, email);
        } catch (err) {
          app.log.error({ err }, 'Failed to send report-received acknowledgment email');
        }
      }

      return { id: row?.id ?? '' };
    },
  );
}
