import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { keys } from '@tryme/storage';
import {
  DevCatalogGenerateJsonBody,
  DevCatalogGenerateResponse,
  DevCatalogOptionsQuery,
  DevCatalogOptionsResponse,
  DevCatalogueParams,
  DevCatalogueResponse,
  DevErrorResponse,
  JOB_SOURCE,
  LEGACY_JOB_SOURCE,
} from '@tryme/types';
import { and, eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getCatalogOptions } from '../../lib/catalog-options-cache.js';
import { AppError } from '../../lib/errors.js';
import { getUploadLimitBytes } from '../../lib/upload-limits-config.js';
import { createJob } from '../jobs/create.js';
import { sniffImageMime } from './image-sniff.js';
import { hashApiKey } from './keys.js';
import { resolveCatalogSelection, toPublicOptions } from './resolve-slugs.js';

const EXT_BY_MIME = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
} as const;

/** Same per-key bucketing rationale as devRoutes' rateLimitConfig (see routes.ts):
 *  the limiter runs at onRequest, before auth populates req.apiKeyId. */
function keyGenerator(req: { headers: Record<string, unknown>; ip: string }) {
  const h = req.headers.authorization;
  return typeof h === 'string' && h.startsWith('Bearer ') ? hashApiKey(h.slice(7)) : req.ip;
}

// Discovery is a Redis hit, not a database round trip, and integrations legitimately
// re-fetch it on page load — so it gets a much larger allowance than the 60/min the
// GPU-bound routes use.
const optionsRateLimit = {
  rateLimit: { max: 600, timeWindow: '1 minute', keyGenerator },
};

// Generation costs credits and occupies a worker; matches the existing dev limit.
const generateRateLimit = {
  rateLimit: { max: 60, timeWindow: '1 minute', keyGenerator },
};

// Replaces what would otherwise be N per-job polls, so it is deliberately generous —
// throttling it here just pushes callers back onto /v1/dev/jobs/:id, which is worse
// for the database.
const statusRateLimit = {
  rateLimit: { max: 600, timeWindow: '1 minute', keyGenerator },
};

export async function devCatalogRoutes(app: FastifyInstance) {
  app.get(
    '/v1/dev/catalog/options',
    {
      preHandler: [app.requireApiKey, app.requireDevScope('full')],
      config: optionsRateLimit,
      schema: {
        tags: ['dev'],
        summary: 'List selectable catalog assets',
        description:
          'Returns the admin-curated models, backgrounds, poses, lower garments and ' +
          'shoes available to your account, addressed by stable slug. Feed those slugs ' +
          'to POST /v1/dev/catalog/generate. Responses carry an ETag — send it back as ' +
          'If-None-Match to get a 304 when nothing has changed.\n\n' +
          'Pass `garmentType` to narrow poses, lower garments and shoes to the ones ' +
          'configured for that garment type — some poses are disabled per garment type ' +
          'and will not resolve on /v1/dev/catalog/generate even though they appear in ' +
          'the unfiltered (no `garmentType`) list. If you plan to submit a `garmentType` ' +
          'to generate, fetch options with that same `garmentType` first.',
        querystring: DevCatalogOptionsQuery,
        // 304 is declared so the zod type provider allows reply.code(304). Node
        // suppresses the body for that status, so the declared shape is never
        // actually serialized.
        response: {
          200: DevCatalogOptionsResponse,
          304: z.null(),
          400: DevErrorResponse,
          401: DevErrorResponse,
          429: DevErrorResponse,
        },
      },
    },
    async (req, reply) => {
      const { gender, garmentType } = req.query as { gender: string; garmentType?: string };

      // Resolve the garment-type slug against the unfiltered pool first — the pose,
      // lower and shoe lists below are narrowed by it.
      let garmentTypeId: string | undefined;
      if (garmentType) {
        const base = await getCatalogOptions(app, { gender, publicOnly: true });
        const hit = base.options.garmentTypes.find((g) => g.slug === garmentType);
        if (!hit) {
          throw new AppError('BAD_SLUG', 400, `unknown garmentType "${garmentType}"`);
        }
        garmentTypeId = hit.id;
      }

      const { options, version } = await getCatalogOptions(app, {
        gender,
        garmentTypeId,
        publicOnly: true,
      });

      // The cache generation is a valid ETag on its own: it changes on every admin
      // asset mutation, and a given URL's payload is a pure function of (generation,
      // query). Weak, because the JSON is not byte-stable across serializations.
      const etag = `W/"${version}"`;
      reply.header('ETag', etag);
      reply.header('Cache-Control', 'private, max-age=60');
      if (req.headers['if-none-match'] === etag) return reply.code(304).send(null);

      return toPublicOptions(options);
    },
  );

  app.post(
    '/v1/dev/catalog/generate',
    {
      preHandler: [app.requireApiKey, app.requireDevScope('full')],
      config: generateRateLimit,
      // Base64 inflates a 20MB image to ~26.8MB of JSON text — same reasoning as
      // /v1/dev/tryon, which this route mirrors. Only one image here, not two.
      bodyLimit: 40 * 1024 * 1024,
      // attachValidation, not auto-reject: this route serves multipart AND JSON and
      // validates the JSON path itself below. Declaring `body` is what gives Scalar a
      // real request snippet; Fastify also runs it against multipart requests (where
      // it can never match), so its result must stay unused. See the longer note on
      // /v1/dev/tryon in routes.ts.
      attachValidation: true,
      schema: {
        tags: ['dev'],
        summary: 'Generate a catalog from admin-curated assets',
        description:
          'Upload one garment image and pick a model, plus up to 12 pose/background ' +
          'combinations, using slugs from GET /v1/dev/catalog/options. Each combination ' +
          'becomes its own job and its own credit charge, so each pose/background pair ' +
          'must be unique within a request. Accepts multipart/form-data ' +
          '(with `looks` as a JSON-encoded string) or a JSON body with a base64 garment. ' +
          'Poll the returned catalogueId via GET /v1/dev/catalogues/{id}.\n\n' +
          'If `garmentType` is set, pose/lower/shoe slugs are validated against that ' +
          "garment type's narrowed set, not the full gender list — a slug from an " +
          'unfiltered GET /v1/dev/catalog/options call can be rejected as BAD_SLUG here ' +
          'if it is disabled for the garmentType you send. Fetch options with the same ' +
          '`garmentType` first to avoid this.',
        consumes: ['multipart/form-data', 'application/json'],
        body: DevCatalogGenerateJsonBody,
        response: {
          202: DevCatalogGenerateResponse,
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

      const isJson = (req.headers['content-type'] ?? '').startsWith('application/json');

      let fields: Record<string, unknown>;
      let garmentFile: { buf: Buffer; mime: string } | undefined;

      if (isJson) {
        fields = (req.body ?? {}) as Record<string, unknown>;
      } else {
        // The global multipart limit is 2.5GB (server.ts) for the admin zip-import
        // route, so this route MUST set its own limits — it does not inherit a safe
        // default.
        const collected: Record<string, unknown> = {};
        const parts = req.parts({ limits: { fileSize: maxFileBytes, files: 1 } });
        for await (const part of parts) {
          if (part.type === 'field') {
            // `looks` is structured, so multipart callers send it JSON-encoded.
            if (part.fieldname === 'looks') {
              try {
                collected.looks = JSON.parse(String(part.value));
              } catch {
                throw new AppError('VALIDATION', 400, 'looks must be a JSON array');
              }
            } else {
              collected[part.fieldname] = String(part.value);
            }
            continue;
          }
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
          // Magic bytes only — part.mimetype is client-declared and untrusted.
          const mime = sniffImageMime(buf);
          if (!mime) {
            throw new AppError('VALIDATION', 400, 'garment must be a JPEG, PNG, or WebP image');
          }
          garmentFile = { buf, mime };
        }
        // Satisfy the shared schema, which models the JSON shape where `garment` is
        // the base64 payload. The real bytes came through the file part above.
        collected.garment = garmentFile ? 'multipart' : '';
        fields = collected;
      }

      const parsed = DevCatalogGenerateJsonBody.safeParse(fields);
      if (!parsed.success) {
        throw new AppError(
          'VALIDATION',
          400,
          parsed.error.issues[0]?.message ?? 'invalid request body',
        );
      }
      const body = parsed.data;

      if (isJson) {
        const raw = body.garment.replace(/^data:[^;]+;base64,/, '');
        const buf = Buffer.from(raw, 'base64');
        if (buf.length === 0 || buf.length > maxFileBytes) {
          throw new AppError(
            'VALIDATION',
            400,
            `garment exceeds the ${maxFileBytes / (1024 * 1024)}MB limit`,
          );
        }
        // Magic bytes only — decoding garbage base64 still yields *some* buffer.
        const mime = sniffImageMime(buf);
        if (!mime) {
          throw new AppError('VALIDATION', 400, 'garment must be a JPEG, PNG, or WebP image');
        }
        garmentFile = { buf, mime };
      }
      if (!garmentFile) throw new AppError('VALIDATION', 400, 'garment image is required');

      // Resolve slugs BEFORE uploading: a typo'd slug should cost neither an R2 write
      // nor a credit.
      const selection = await resolveCatalogSelection(app, body);

      const garmentKey = keys.devUpload(
        merchantId,
        randomUUID(),
        EXT_BY_MIME[garmentFile.mime as keyof typeof EXT_BY_MIME],
      );
      await app.storage.putObject(garmentKey, garmentFile.buf, garmentFile.mime);

      let result: Awaited<ReturnType<typeof createJob>>;
      try {
        result = await createJob(
          app,
          merchantUserId,
          {
            inputs: {
              upperGarmentKey: garmentKey,
              faceId: selection.faceId,
              garmentTypeId: selection.garmentTypeId,
              looks: selection.looks,
              lowerCatalogId: selection.lowerCatalogId,
              shoeCatalogId: selection.shoeCatalogId,
            },
            aspectRatio: body.aspectRatio,
            resolution: body.resolution,
          },
          {
            // The garment was written straight through putObject with no presign, so
            // the Redis upload-ownership binding verifyGarmentKey looks for does not
            // exist. Shopify's catalog route does the same for the same reason.
            trustedGarmentKeys: new Set([garmentKey]),
            // Without both of these the resulting jobs are invisible to
            // /v1/dev/jobs/:id and /v1/dev/catalogues/:id, which scope by merchant
            // through api_keys and filter source = 'api'.
            apiKeyId,
            source: JOB_SOURCE.API_CATALOG,
          },
        );
      } catch (err) {
        // Nothing has been charged at this point; drop the orphaned upload.
        await app.storage.deleteObject(garmentKey).catch(() => {});
        throw err;
      }

      return reply.code(202).send({
        catalogueId: result.catalogueId,
        jobs: result.jobIds.map((jobId, i) => ({
          jobId,
          pose: body.looks[i]?.pose ?? '',
          background: body.looks[i]?.background ?? '',
        })),
      });
    },
  );

  app.get(
    '/v1/dev/catalogues/:id',
    {
      preHandler: [app.requireApiKey, app.requireDevScope('full')],
      config: statusRateLimit,
      schema: {
        tags: ['dev'],
        summary: 'Get status of every job in a catalog',
        description:
          'Returns all jobs created by one /v1/dev/catalog/generate call. Poll this ' +
          'instead of polling each job individually.',
        params: DevCatalogueParams,
        response: {
          200: DevCatalogueResponse,
          401: DevErrorResponse,
          404: DevErrorResponse,
          429: DevErrorResponse,
        },
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };

      // One query for all N jobs — the whole point of this route. Scoped by merchant
      // through the owning API key (not the key itself, so a rotated key still reads
      // its older catalogues), mirroring /v1/dev/jobs/:id.
      const rows = await app.db
        .select({
          id: schema.jobs.id,
          status: schema.jobs.status,
          errorCode: schema.jobs.errorCode,
          apiKeyMerchantId: schema.apiKeys.merchantId,
          outputKey: schema.jobOutputs.resultKey,
        })
        .from(schema.jobs)
        .innerJoin(schema.apiKeys, eq(schema.apiKeys.id, schema.jobs.apiKeyId))
        .leftJoin(schema.jobOutputs, eq(schema.jobOutputs.jobId, schema.jobs.id))
        .where(
          and(
            eq(schema.jobs.catalogueId, id),
            inArray(schema.jobs.source, [
              JOB_SOURCE.API_TRYON,
              JOB_SOURCE.API_SAREE_MANNEQUIN,
              JOB_SOURCE.API_CATALOG,
              LEGACY_JOB_SOURCE.API,
            ]),
          ),
        )
        .orderBy(schema.jobs.createdAt);

      // 404 (not 403) on someone else's catalogue so ids are not enumerable.
      const owned = rows.filter((r) => r.apiKeyMerchantId === req.merchantId);
      if (owned.length === 0) throw new AppError('NOT_FOUND', 404, 'catalogue not found');

      const jobs = await Promise.all(
        owned.map(async (r) => {
          if (r.status === 'COMPLETED' && r.outputKey) {
            const { url } = await app.storage.presignGet(r.outputKey, 900);
            return { jobId: r.id, status: 'COMPLETED' as const, imageUrl: url };
          }
          if (r.status === 'FAILED') {
            return {
              jobId: r.id,
              status: 'FAILED' as const,
              error: r.errorCode ?? 'JOB_FAILED',
            };
          }
          if (r.status === 'CANCELLED') {
            return { jobId: r.id, status: 'FAILED' as const, error: 'JOB_CANCELLED' };
          }
          // Internal pipeline stages collapse to RUNNING — DevJobStatus only admits
          // QUEUED/RUNNING/COMPLETED/FAILED and a raw passthrough would fail response
          // validation with a 500 for the whole time a job is processing.
          return {
            jobId: r.id,
            status: r.status === 'QUEUED' ? ('QUEUED' as const) : ('RUNNING' as const),
          };
        }),
      );

      return { catalogueId: id, jobs };
    },
  );
}
