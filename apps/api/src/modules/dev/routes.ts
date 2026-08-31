import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { keys } from '@tryme/storage';
import {
  DevBalanceResponse,
  DevCategoriesResponse,
  DevErrorResponse,
  DevJobParams,
  DevJobResponse,
  DevMeResponse,
  DevPhotoPreviewRequest,
  DevPhotoPreviewResponse,
  DevSareeMannequinJsonBody,
  DevTryonJsonBody,
  DevTryonResponse,
  JOB_SOURCE,
  LEGACY_JOB_SOURCE,
} from '@tryme/types';
import { and, asc, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { AppError } from '../../lib/errors.js';
import { getUploadLimitBytes } from '../../lib/upload-limits-config.js';
import { assertWidgetKeyRateLimit } from '../../lib/widget-key-rate-limit.js';
import { createDevTryonJob } from './create-job.js';
import { createDevSareeMannequinJob } from './create-saree-mannequin-job.js';
import { sniffImageMime } from './image-sniff.js';
import { hashApiKey } from './keys.js';

const EXT_BY_MIME = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
} as const;

// The per-key limiter runs at onRequest, BEFORE preHandler auth — so req.apiKeyId
// is not populated yet. Hashing the raw bearer gives a stable per-key bucket with
// no DB hit and without ever using the raw key as a Redis key. Unauthenticated
// junk falls back to per-IP.
const rateLimitConfig = {
  rateLimit: {
    max: 60,
    timeWindow: '1 minute',
    keyGenerator: (req: { headers: Record<string, unknown>; ip: string }) => {
      const h = req.headers.authorization;
      return typeof h === 'string' && h.startsWith('Bearer ') ? hashApiKey(h.slice(7)) : req.ip;
    },
  },
};

export async function devRoutes(app: FastifyInstance) {
  app.get(
    '/v1/dev/categories',
    {
      preHandler: app.requireApiKey,
      config: rateLimitConfig,
      schema: {
        tags: ['dev'],
        summary: 'List try-on categories',
        response: { 200: DevCategoriesResponse, 401: DevErrorResponse, 429: DevErrorResponse },
      },
    },
    async () => {
      const rows = await app.db
        .select({ slug: schema.devTryonCategories.slug, name: schema.devTryonCategories.name })
        .from(schema.devTryonCategories)
        .where(eq(schema.devTryonCategories.isActive, true))
        .orderBy(asc(schema.devTryonCategories.sortOrder));
      return { categories: rows };
    },
  );

  app.get(
    '/v1/dev/me',
    {
      preHandler: [app.requireApiKey, app.requireDevScope('full')],
      config: rateLimitConfig,
      schema: {
        tags: ['dev'],
        summary: 'Get account info',
        response: {
          200: DevMeResponse,
          401: DevErrorResponse,
          404: DevErrorResponse,
          429: DevErrorResponse,
        },
      },
    },
    async (req) => {
      const [row] = await app.db
        .select({
          merchantId: schema.merchants.id,
          companyName: schema.merchants.companyName,
          credits: schema.userCredits.balance,
        })
        .from(schema.merchants)
        .leftJoin(schema.userCredits, eq(schema.userCredits.userId, schema.merchants.userId))
        .where(eq(schema.merchants.id, req.merchantId as string))
        .limit(1);
      if (!row) throw new AppError('NOT_FOUND', 404, 'merchant not found');
      return {
        merchantId: row.merchantId,
        companyName: row.companyName,
        credits: row.credits ?? 0,
      };
    },
  );

  app.get(
    '/v1/dev/balance',
    {
      // No requireDevScope() — a credit count is not sensitive, and this is
      // the one dev-API read a widget-scoped key needs directly (e.g. the
      // WordPress plugin's "Refresh balance" button, which only ever holds
      // the widget key day-to-day). Full-scoped keys may call it too.
      preHandler: app.requireApiKey,
      config: rateLimitConfig,
      schema: {
        tags: ['dev'],
        summary: 'Get the current credit balance',
        response: {
          200: DevBalanceResponse,
          401: DevErrorResponse,
          404: DevErrorResponse,
          429: DevErrorResponse,
        },
      },
    },
    async (req) => {
      const [row] = await app.db
        .select({ credits: schema.userCredits.balance })
        .from(schema.merchants)
        .leftJoin(schema.userCredits, eq(schema.userCredits.userId, schema.merchants.userId))
        .where(eq(schema.merchants.id, req.merchantId as string))
        .limit(1);
      if (!row) throw new AppError('NOT_FOUND', 404, 'merchant not found');
      return { credits: row.credits ?? 0 };
    },
  );

  app.post(
    '/v1/dev/tryon',
    {
      preHandler: app.requireApiKey,
      config: rateLimitConfig,
      // Base64 inflates each 20MB image to ~26.8MB of JSON text; the two-image
      // JSON path needs more than Fastify's 1MB default. Multipart is unaffected —
      // @fastify/multipart streams via its own `fileSize` limit above, not this.
      bodyLimit: 60 * 1024 * 1024,
      // attachValidation, not the default auto-reject: this route handles multipart
      // and JSON itself (see below) and does its own DevTryonJsonBody.safeParse for
      // the JSON path. `body` here exists so Scalar/the OpenAPI spec can generate a
      // real request-body snippet -- Fastify still runs it against the multipart
      // request too (where it will never match), so its result must stay unused;
      // wiring it in as the actual gate would 400 every multipart upload.
      attachValidation: true,
      schema: {
        tags: ['dev'],
        summary: 'Create a try-on job',
        description:
          'Upload a person image and a garment image, either as multipart/form-data ' +
          '(fields: category, person, garment) or as a JSON body with base64-encoded ' +
          'images (fields: category, person, garment — plain base64 or a data: URI). ' +
          'Returns a job id to poll.',
        consumes: ['multipart/form-data', 'application/json'],
        body: DevTryonJsonBody,
        response: {
          202: DevTryonResponse,
          400: DevErrorResponse,
          401: DevErrorResponse,
          402: DevErrorResponse,
          403: DevErrorResponse,
          429: DevErrorResponse,
          503: DevErrorResponse,
        },
      },
    },
    async (req, reply) => {
      const merchantId = req.merchantId as string;
      const merchantUserId = req.merchantUserId as string;
      const apiKeyId = req.apiKeyId as string;

      if (req.apiKeyScope === 'widget') {
        await assertWidgetKeyRateLimit(app, apiKeyId);
      }

      const maxFileBytes = await getUploadLimitBytes(req.server, 'devApiMaxBytes');

      let categorySlug: string | undefined;
      const files: Record<string, { buf: Buffer; mime: string }> = {};

      const isJson = (req.headers['content-type'] ?? '').startsWith('application/json');

      if (isJson) {
        const parsed = DevTryonJsonBody.safeParse(req.body);
        if (!parsed.success) {
          throw new AppError(
            'VALIDATION',
            400,
            parsed.error.issues[0]?.message ?? 'invalid request body',
          );
        }
        categorySlug = parsed.data.category;
        for (const fieldname of ['person', 'garment'] as const) {
          const raw = parsed.data[fieldname].replace(/^data:[^;]+;base64,/, '');
          const buf = Buffer.from(raw, 'base64');
          if (buf.length === 0 || buf.length > maxFileBytes) {
            throw new AppError(
              'VALIDATION',
              400,
              `${fieldname} exceeds the ${maxFileBytes / (1024 * 1024)}MB limit`,
            );
          }
          // Magic bytes only — decoding garbage base64 still yields *some* buffer.
          const mime = sniffImageMime(buf);
          if (!mime) {
            throw new AppError(
              'VALIDATION',
              400,
              `${fieldname} must be a JPEG, PNG, or WebP image`,
            );
          }
          files[fieldname] = { buf, mime };
        }
      } else {
        // The global multipart limit is 2.5GB (server.ts) for the admin zip-import
        // route, so this route MUST set its own limits — it does not inherit a safe
        // default.
        const parts = req.parts({ limits: { fileSize: maxFileBytes, files: 2 } });
        for await (const part of parts) {
          if (part.type === 'field' && part.fieldname === 'category') {
            categorySlug = String(part.value);
            continue;
          }
          if (part.type !== 'file') continue;
          if (part.fieldname !== 'person' && part.fieldname !== 'garment') {
            throw new AppError('VALIDATION', 400, `unexpected file field: ${part.fieldname}`);
          }
          const buf = await part.toBuffer().catch(() => {
            throw new AppError(
              'VALIDATION',
              400,
              `${part.fieldname} exceeds the ${maxFileBytes / (1024 * 1024)}MB limit`,
            );
          });
          if (part.file.truncated) {
            throw new AppError(
              'VALIDATION',
              400,
              `${part.fieldname} exceeds the ${maxFileBytes / (1024 * 1024)}MB limit`,
            );
          }
          // Magic bytes only — part.mimetype is client-declared and untrusted.
          const mime = sniffImageMime(buf);
          if (!mime) {
            throw new AppError(
              'VALIDATION',
              400,
              `${part.fieldname} must be a JPEG, PNG, or WebP image`,
            );
          }
          files[part.fieldname] = { buf, mime };
        }
      }

      if (!categorySlug) throw new AppError('VALIDATION', 400, 'category is required');
      if (!files.person) throw new AppError('VALIDATION', 400, 'person image is required');
      if (!files.garment) throw new AppError('VALIDATION', 400, 'garment image is required');

      // Upload before the credit transaction: an orphaned R2 object on a later
      // failure is harmless, a charge for a job whose inputs are missing is not.
      const personKey = keys.devUpload(
        merchantId,
        randomUUID(),
        EXT_BY_MIME[files.person.mime as keyof typeof EXT_BY_MIME],
      );
      const garmentKey = keys.devUpload(
        merchantId,
        randomUUID(),
        EXT_BY_MIME[files.garment.mime as keyof typeof EXT_BY_MIME],
      );
      await Promise.all([
        app.storage.putObject(personKey, files.person.buf, files.person.mime),
        app.storage.putObject(garmentKey, files.garment.buf, files.garment.mime),
      ]);

      const { jobId } = await createDevTryonJob(app, {
        merchantId,
        merchantUserId,
        apiKeyId,
        integration: (req.integration as 'generic' | 'wordpress') ?? 'generic',
        categorySlug,
        personKey,
        garmentKey,
      });

      // Lets a later /v1/dev/photo/preview call offer "reuse this photo"
      // without re-uploading it — same 24h renewable window as the Shopify
      // widget's equivalent (customer.routes.ts), refreshed on every reuse.
      await app.redis.set(`dev:person-photo:${merchantId}:${personKey}`, '1', 'EX', 86400);

      return reply.code(202).send({ jobId, status: 'QUEUED', personKey });
    },
  );

  app.post(
    '/v1/dev/photo/preview',
    {
      preHandler: app.requireApiKey,
      config: rateLimitConfig,
      schema: {
        tags: ['dev'],
        summary: 'Re-sign a previously uploaded person photo for reuse on a new job',
        body: DevPhotoPreviewRequest,
        response: {
          200: DevPhotoPreviewResponse,
          401: DevErrorResponse,
          404: DevErrorResponse,
          429: DevErrorResponse,
        },
      },
    },
    async (req) => {
      const merchantId = req.merchantId as string;
      if (req.apiKeyScope === 'widget') {
        await assertWidgetKeyRateLimit(app, req.apiKeyId as string);
      }
      const { personKey } = req.body as { personKey: string };

      // The dev/ key prefix embeds the owning merchant (keys.devUpload), so this
      // also rejects a photo key from a different merchant outright, before ever
      // touching Redis.
      if (!personKey.startsWith(`dev/${merchantId}/`)) {
        throw new AppError('NOT_FOUND', 404, 'photo not available');
      }
      const owned = await app.redis.get(`dev:person-photo:${merchantId}:${personKey}`);
      if (!owned) {
        throw new AppError('NOT_FOUND', 404, 'photo not available');
      }

      const { url } = await app.storage.presignGet(personKey, 300);
      return { previewUrl: url };
    },
  );

  app.post(
    '/v1/dev/saree-mannequin',
    {
      preHandler: [app.requireApiKey, app.requireDevScope('full')],
      config: rateLimitConfig,
      // One image, base64-inflated ~1.34x — 20MB source caps around 26.8MB of JSON text.
      bodyLimit: 30 * 1024 * 1024,
      attachValidation: true,
      schema: {
        tags: ['dev'],
        summary: 'Generate a saree-draped mannequin image from a garment cloth photo',
        description:
          'Upload a saree/garment cloth image, either as multipart/form-data (field: garment) ' +
          'or as a JSON body with a base64-encoded image (field: garment — plain base64 or a ' +
          'data: URI). The face/model is fixed by the configured workflow, not caller-supplied. ' +
          'Returns a job id to poll.',
        consumes: ['multipart/form-data', 'application/json'],
        body: DevSareeMannequinJsonBody,
        response: {
          202: DevTryonResponse,
          400: DevErrorResponse,
          401: DevErrorResponse,
          402: DevErrorResponse,
          403: DevErrorResponse,
          429: DevErrorResponse,
          503: DevErrorResponse,
        },
      },
    },
    async (req, reply) => {
      const merchantId = req.merchantId as string;
      const merchantUserId = req.merchantUserId as string;
      const apiKeyId = req.apiKeyId as string;
      const maxFileBytes = await getUploadLimitBytes(req.server, 'devApiMaxBytes');

      let garmentFile: { buf: Buffer; mime: string } | undefined;

      const isJson = (req.headers['content-type'] ?? '').startsWith('application/json');

      if (isJson) {
        const parsed = DevSareeMannequinJsonBody.safeParse(req.body);
        if (!parsed.success) {
          throw new AppError(
            'VALIDATION',
            400,
            parsed.error.issues[0]?.message ?? 'invalid request body',
          );
        }
        const raw = parsed.data.garment.replace(/^data:[^;]+;base64,/, '');
        const buf = Buffer.from(raw, 'base64');
        if (buf.length === 0 || buf.length > maxFileBytes) {
          throw new AppError(
            'VALIDATION',
            400,
            `garment exceeds the ${maxFileBytes / (1024 * 1024)}MB limit`,
          );
        }
        const mime = sniffImageMime(buf);
        if (!mime) {
          throw new AppError('VALIDATION', 400, 'garment must be a JPEG, PNG, or WebP image');
        }
        garmentFile = { buf, mime };
      } else {
        const parts = req.parts({ limits: { fileSize: maxFileBytes, files: 1 } });
        for await (const part of parts) {
          if (part.type !== 'file') continue;
          if (part.fieldname !== 'garment') {
            throw new AppError('VALIDATION', 400, `unexpected file field: ${part.fieldname}`);
          }
          const buf = await part.toBuffer().catch(() => {
            throw new AppError(
              'VALIDATION',
              400,
              `garment exceeds the ${maxFileBytes / (1024 * 1024)}MB limit`,
            );
          });
          if (part.file.truncated) {
            throw new AppError(
              'VALIDATION',
              400,
              `garment exceeds the ${maxFileBytes / (1024 * 1024)}MB limit`,
            );
          }
          const mime = sniffImageMime(buf);
          if (!mime) {
            throw new AppError('VALIDATION', 400, 'garment must be a JPEG, PNG, or WebP image');
          }
          garmentFile = { buf, mime };
        }
      }

      if (!garmentFile) throw new AppError('VALIDATION', 400, 'garment image is required');

      const garmentKey = keys.devUpload(
        merchantId,
        randomUUID(),
        EXT_BY_MIME[garmentFile.mime as keyof typeof EXT_BY_MIME],
      );
      await app.storage.putObject(garmentKey, garmentFile.buf, garmentFile.mime);

      const { jobId } = await createDevSareeMannequinJob(app, {
        merchantUserId,
        apiKeyId,
        garmentKey,
      });

      return reply.code(202).send({ jobId, status: 'QUEUED' });
    },
  );

  app.get(
    '/v1/dev/jobs/:id',
    {
      preHandler: app.requireApiKey,
      config: rateLimitConfig,
      schema: {
        tags: ['dev'],
        summary: 'Get try-on job status and result',
        params: DevJobParams,
        response: {
          200: DevJobResponse,
          401: DevErrorResponse,
          404: DevErrorResponse,
          429: DevErrorResponse,
        },
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      if (req.apiKeyScope === 'widget') {
        await assertWidgetKeyRateLimit(app, req.apiKeyId as string);
      }
      const [job] = await app.db
        .select({
          id: schema.jobs.id,
          status: schema.jobs.status,
          errorCode: schema.jobs.errorCode,
          apiKeyMerchantId: schema.apiKeys.merchantId,
          // NOTE: the column is `result_key` / resultKey — job_outputs has no r2Key.
          outputKey: schema.jobOutputs.resultKey,
        })
        .from(schema.jobs)
        .innerJoin(schema.apiKeys, eq(schema.apiKeys.id, schema.jobs.apiKeyId))
        .leftJoin(schema.jobOutputs, eq(schema.jobOutputs.jobId, schema.jobs.id))
        .where(
          and(
            eq(schema.jobs.id, id),
            inArray(schema.jobs.source, [
              JOB_SOURCE.API_TRYON,
              JOB_SOURCE.API_SAREE_MANNEQUIN,
              JOB_SOURCE.API_CATALOG,
              JOB_SOURCE.WORDPRESS_TRYON,
              LEGACY_JOB_SOURCE.API,
            ]),
          ),
        )
        .limit(1);

      // Scoped by merchant (via the owning API key), not by key itself: a merchant
      // that rotates keys must still be able to read its older jobs. 404 (not 403)
      // on someone else's job so job IDs are not enumerable.
      if (!job || job.apiKeyMerchantId !== req.merchantId) {
        throw new AppError('NOT_FOUND', 404, 'job not found');
      }

      if (job.status === 'COMPLETED' && job.outputKey) {
        // Presigned + short-lived: API results stay private to the owning merchant.
        const { url } = await app.storage.presignGet(job.outputKey, 900);
        return { jobId: job.id, status: 'COMPLETED' as const, imageUrl: url };
      }
      if (job.status === 'FAILED') {
        return { jobId: job.id, status: 'FAILED' as const, error: job.errorCode ?? 'JOB_FAILED' };
      }
      if (job.status === 'CANCELLED') {
        return { jobId: job.id, status: 'FAILED' as const, error: 'JOB_CANCELLED' };
      }
      // Internal pipeline stages (PREPROCESSING/GENERATING/UPLOADING) collapse to
      // RUNNING on the public surface — DevJobStatus only exposes QUEUED/RUNNING/
      // COMPLETED/FAILED, so a raw passthrough of job.status here would fail response
      // schema validation with a 500 for the entire duration a job is processing.
      return {
        jobId: job.id,
        status: job.status === 'QUEUED' ? ('QUEUED' as const) : ('RUNNING' as const),
      };
    },
  );
}
