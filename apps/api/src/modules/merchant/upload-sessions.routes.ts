import { randomUUID } from 'node:crypto';
import { PublicUploadSessionPresignBody } from '@tryme/types';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import {
  createUploadSession,
  deleteUploadSession,
  getUploadSession,
  markUploadSessionUploaded,
  UPLOAD_SESSION_TTL_SECONDS,
} from './upload-session-store.js';

export async function merchantUploadSessionRoutes(app: FastifyInstance) {
  app.post(
    '/v1/merchant/tryon/upload-sessions',
    { preHandler: app.requireMerchant, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (req, reply) => {
      const merchantId = req.merchantClientId;
      if (!merchantId) throw new AppError('UNAUTH', 401, 'missing merchant');

      const sessionId = randomUUID();
      const r2Key = `merchant-inputs/${merchantId}/qr/${sessionId}/photo.jpg`;
      const token = await createUploadSession(app, merchantId, r2Key);

      reply.code(201);
      return {
        token,
        qrUrl: `${app.env.WEB_URL}/kiosk-upload/${token}`,
        expiresIn: UPLOAD_SESSION_TTL_SECONDS,
      };
    },
  );

  app.get(
    '/v1/merchant/tryon/upload-sessions/:token',
    { preHandler: app.requireMerchant, schema: { params: z.object({ token: z.string().min(1) }) } },
    async (req) => {
      const merchantId = req.merchantClientId;
      if (!merchantId) throw new AppError('UNAUTH', 401, 'missing merchant');
      const { token } = req.params as { token: string };

      const session = await getUploadSession(app, token);
      if (!session || session.merchantId !== merchantId) {
        throw new AppError(
          'SESSION_EXPIRED',
          404,
          'this upload session has expired or does not exist',
        );
      }
      return {
        status: session.status,
        r2Key: session.status === 'uploaded' ? session.r2Key : null,
      };
    },
  );

  app.delete(
    '/v1/merchant/tryon/upload-sessions/:token',
    { preHandler: app.requireMerchant, schema: { params: z.object({ token: z.string().min(1) }) } },
    async (req, reply) => {
      const merchantId = req.merchantClientId;
      if (!merchantId) throw new AppError('UNAUTH', 401, 'missing merchant');
      const { token } = req.params as { token: string };

      const session = await getUploadSession(app, token);
      if (session && session.merchantId !== merchantId) {
        throw new AppError('FORBIDDEN', 403, 'upload session does not belong to this merchant');
      }
      await deleteUploadSession(app, token);

      reply.code(204);
      return reply.send();
    },
  );
  // Public routes use the random session token as their only credential.
  app.post(
    '/v1/kiosk-upload-sessions/:token/presign',
    {
      schema: {
        params: z.object({ token: z.string().min(1) }),
        body: PublicUploadSessionPresignBody,
      },
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (req) => {
      const { token } = req.params as { token: string };
      const { contentType, contentLength } = req.body as z.infer<
        typeof PublicUploadSessionPresignBody
      >;

      const session = await getUploadSession(app, token);
      if (!session) throw new AppError('SESSION_EXPIRED', 404, 'this upload link has expired');

      const { url, expiresIn } = await app.storage.presignPut(
        session.r2Key,
        contentType,
        contentLength,
        600,
      );
      return { uploadUrl: url, expiresIn };
    },
  );

  app.post(
    '/v1/kiosk-upload-sessions/:token/complete',
    {
      schema: { params: z.object({ token: z.string().min(1) }) },
      config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
    },
    async (req) => {
      const { token } = req.params as { token: string };
      const session = await getUploadSession(app, token);
      if (!session) throw new AppError('SESSION_EXPIRED', 404, 'this upload link has expired');

      let head: { contentLength: number };
      try {
        head = await app.storage.headObject(session.r2Key);
      } catch {
        throw new AppError('BAD_UPLOAD', 400, 'photo not found - please retry the upload');
      }
      if (head.contentLength > 20 * 1024 * 1024) {
        throw new AppError('BAD_UPLOAD', 413, 'photo exceeds 20MB limit');
      }

      await markUploadSessionUploaded(app, token);
      return { ok: true };
    },
  );
}
