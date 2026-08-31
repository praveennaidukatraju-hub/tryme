import { randomUUID } from 'node:crypto';
import { keys } from '@tryme/storage';
import { PresignUploadBody } from '@tryme/types';
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';

/** How long an issued upload key stays bound to its user (24h) — covers slow wizard sessions. */
const UPLOAD_OWNER_TTL_SEC = 24 * 60 * 60;

export async function uploadsRoutes(app: FastifyInstance) {
  app.post(
    '/v1/uploads/presign',
    {
      preHandler: app.requireUser,
      schema: { body: PresignUploadBody },
    },
    async (req) => {
      const { contentType, contentLength } = req.body as z.infer<typeof PresignUploadBody>;
      const jobToken = randomUUID(); // pre-job upload identifier
      const r2Key = keys.inputGarment(jobToken);
      const { url, expiresIn } = await app.storage.presignPut(
        r2Key,
        contentType,
        contentLength,
        1800,
      );
      // Bind the issued key to this user so createJob can reject keys the caller
      // was never granted (prevents using another user's / an internal asset key
      // as a job input — H2). TTL covers the time a user spends in the wizard
      // between upload and submit.
      await app.redis.set(`upload:owner:${r2Key}`, req.userId, 'EX', UPLOAD_OWNER_TTL_SEC);
      return { uploadUrl: url, r2Key, expiresIn };
    },
  );
}
