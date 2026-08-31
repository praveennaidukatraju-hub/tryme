import { schema } from '@tryme/db';
import { keys } from '@tryme/storage';
import {
  CreateBatchJobRequest,
  CreateCatalogVideoJobRequest,
  CreateSareeJobRequest,
  CreateSareeMannequinJobRequest,
  CreateSimpleTryonRequest,
  CreateTryOnJobRequest,
  JOB_SOURCE,
  RegenerateJobRequest,
  RegenerateReasonsResponse,
  SareeConfigResponse,
} from '@tryme/types';
import { and, asc, desc, eq, isNotNull, isNull, notInArray, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getMaxBatchJobs } from '../../lib/batch-config.js';
import { isCatalogVideoAllowed } from '../../lib/catalog-video-access.js';
import { AppError } from '../../lib/errors.js';
import { withIdempotency } from '../../lib/idempotency.js';
import { sendReportReceivedEmail } from '../../lib/mailer.js';
import { getTryonCreditCost } from '../../lib/resolution-config.js';
import { getSareeSettings } from '../saree/settings.js';
import {
  createCatalogVideoJob,
  createJob,
  createSimpleTryonJob,
  updateLastUsedPosePreset,
} from './create.js';
import { createBatchJobs } from './createBatch.js';
import { createSareeJob } from './createSaree.js';
import { createSareeMannequinJob } from './createSareeMannequin.js';
import { getRegenerateReasons, regenerateJob } from './regenerate.js';
import { sseHandler, userStreamHandler } from './sse.js';

export async function jobsRoutes(app: FastifyInstance) {
  app.get('/v1/catalog-videos', { preHandler: app.requireUser }, async (req) => {
    const [caller] = await app.db
      .select({ email: schema.users.email })
      .from(schema.users)
      .where(eq(schema.users.id, req.userId));
    if (!isCatalogVideoAllowed(app.env, caller?.email ?? null)) {
      throw new AppError('FORBIDDEN', 403, 'catalog video is not enabled for this account');
    }
    const rows = await app.db
      .select({
        id: schema.jobs.id,
        status: schema.jobs.status,
        createdAt: schema.jobs.createdAt,
        params: schema.jobInputs.params,
      })
      .from(schema.jobs)
      .innerJoin(schema.jobInputs, eq(schema.jobInputs.jobId, schema.jobs.id))
      .where(
        and(eq(schema.jobs.userId, req.userId), sql`${schema.jobInputs.params}->>'kind' = 'video'`),
      )
      .orderBy(desc(schema.jobs.createdAt))
      .limit(200);

    return Promise.all(
      rows.map(async (row) => {
        const [output] = await app.db
          .select({
            resultKey: schema.jobOutputs.resultKey,
            thumbnailKey: schema.jobOutputs.thumbnailKey,
          })
          .from(schema.jobOutputs)
          .where(eq(schema.jobOutputs.jobId, row.id));
        let videoUrl: string | null = null;
        let thumbnailUrl: string | null = null;
        if (output?.resultKey) {
          try {
            const [video, thumb] = await Promise.all([
              app.storage.presignGet(output.resultKey, 3600),
              output.thumbnailKey ? app.storage.presignGet(output.thumbnailKey, 3600) : null,
            ]);
            videoUrl = video.url;
            thumbnailUrl = thumb?.url ?? null;
          } catch {
            // Missing result object: leave URLs null so the UI shows its placeholder.
          }
        }
        const params = row.params as Record<string, unknown> | null;
        return {
          id: row.id,
          status: row.status,
          createdAt: row.createdAt,
          sampleVideoId: params?.sampleVideoId ?? null,
          videoUrl,
          thumbnailUrl,
        };
      }),
    );
  });

  app.post(
    '/v1/jobs/tryon',
    { preHandler: app.requireUser, schema: { body: CreateTryOnJobRequest } },
    async (req, reply) => {
      const result = await withIdempotency(
        app,
        'jobs',
        req.userId,
        req.headers['idempotency-key'] as string | undefined,
        () => createJob(app, req.userId, req.body as z.infer<typeof CreateTryOnJobRequest>),
      );
      // Best-effort "last used" pose preset tracking — scoped to this route only
      // (see updateLastUsedPosePreset's doc comment for why regenerate.ts and the
      // dev API must not trigger it). Never throws, so it can't turn a successful
      // job-creation response into an error; awaited so tests/response ordering
      // stay deterministic, not to gate the response on it succeeding.
      await updateLastUsedPosePreset(
        app,
        req.userId,
        result.gender,
        result.garmentTypeId,
        result.poseIds,
      );
      reply.code(201);
      return result;
    },
  );

  app.post(
    '/v1/jobs/batch',
    { preHandler: app.requireUser, schema: { body: CreateBatchJobRequest } },
    async (req, reply) => {
      const result = await withIdempotency(
        app,
        'jobs',
        req.userId,
        req.headers['idempotency-key'] as string | undefined,
        () => createBatchJobs(app, req.userId, req.body as z.infer<typeof CreateBatchJobRequest>),
      );
      reply.code(201);
      return result;
    },
  );

  app.post(
    '/v1/jobs/catalog-video',
    { preHandler: app.requireUser, schema: { body: CreateCatalogVideoJobRequest } },
    async (req, reply) => {
      const result = await withIdempotency(
        app,
        'jobs',
        req.userId,
        req.headers['idempotency-key'] as string | undefined,
        () =>
          createCatalogVideoJob(
            app,
            req.userId,
            req.body as z.infer<typeof CreateCatalogVideoJobRequest>,
          ),
      );
      reply.code(201);
      return result;
    },
  );

  app.get(
    '/v1/jobs/:id/regenerate-reasons',
    {
      preHandler: app.requireUser,
      schema: {
        params: z.object({ id: z.string().uuid() }),
        response: { 200: RegenerateReasonsResponse },
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const reasons = await getRegenerateReasons(app, req.userId, id);
      return { reasons };
    },
  );

  app.post(
    '/v1/jobs/:id/regenerate',
    {
      preHandler: app.requireUser,
      schema: { params: z.object({ id: z.string().uuid() }), body: RegenerateJobRequest },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const { reason } = req.body as z.infer<typeof RegenerateJobRequest>;
      // Same protection every other job-creation route has: a repeated click
      // (or a retried request) carrying the same Idempotency-Key returns the
      // cached result instead of creating — and charging/refunding — a second job.
      const result = await withIdempotency(
        app,
        'jobs',
        req.userId,
        req.headers['idempotency-key'] as string | undefined,
        () => regenerateJob(app, req.userId, id, reason),
      );
      reply.code(201);
      return result;
    },
  );

  app.post(
    '/v1/jobs/simple-tryon',
    { preHandler: app.requireUser, schema: { body: CreateSimpleTryonRequest } },
    async (req, reply) => {
      const result = await withIdempotency(
        app,
        'jobs',
        req.userId,
        req.headers['idempotency-key'] as string | undefined,
        () =>
          createSimpleTryonJob(
            app,
            req.userId,
            req.body as z.infer<typeof CreateSimpleTryonRequest>,
          ),
      );
      reply.code(201);
      return result;
    },
  );

  app.post(
    '/v1/jobs/saree-mannequin',
    { preHandler: app.requireUser, schema: { body: CreateSareeMannequinJobRequest } },
    async (req, reply) => {
      const result = await withIdempotency(
        app,
        'jobs',
        req.userId,
        req.headers['idempotency-key'] as string | undefined,
        () =>
          createSareeMannequinJob(
            app,
            req.userId,
            req.body as z.infer<typeof CreateSareeMannequinJobRequest>,
          ),
      );
      reply.code(201);
      return result;
    },
  );

  // GET /v1/saree/config — exposed to the user page; tells the client whether the
  // admin has configured saree try-on (model image + active workflow).
  app.get(
    '/v1/saree/config',
    { preHandler: app.requireUser, schema: { response: { 200: SareeConfigResponse } } },
    async () => {
      const row = await getSareeSettings(app.db);
      const modelImageKey = row?.modelImageKey ?? null;
      const sampleSareeImageKey = row?.sampleSareeImageKey ?? null;
      const presign = async (key: string | null) => {
        if (!key) return null;
        try {
          const { url } = await app.storage.presignGet(key, 3600);
          return url;
        } catch {
          return null;
        }
      };
      const [modelImageUrl, sampleSareeImageUrl, creditsCost] = await Promise.all([
        presign(row?.modelImageThumbKey ?? modelImageKey),
        presign(row?.sampleSareeImageThumbKey ?? sampleSareeImageKey),
        getTryonCreditCost(app),
      ]);
      return {
        modelImageUrl,
        sampleSareeImageUrl,
        isConfigured: !!modelImageKey,
        creditsCost,
      };
    },
  );

  // POST /v1/jobs/saree
  app.post(
    '/v1/jobs/saree',
    { preHandler: app.requireUser, schema: { body: CreateSareeJobRequest } },
    async (req, reply) => {
      const result = await withIdempotency(
        app,
        'jobs',
        req.userId,
        req.headers['idempotency-key'] as string | undefined,
        () => createSareeJob(app, req.userId, req.body as z.infer<typeof CreateSareeJobRequest>),
      );
      reply.code(201);
      return result;
    },
  );

  // GET /v1/tryon/categories — active categories + global person/garment sample URLs
  app.get('/v1/tryon/categories', { preHandler: app.requireUser }, async () => {
    const SETTINGS_ID = '00000000-0000-0000-0000-000000000001';
    const [cats, [settings]] = await Promise.all([
      app.db
        .select()
        .from(schema.tryonCategories)
        .where(eq(schema.tryonCategories.isActive, true))
        .orderBy(asc(schema.tryonCategories.sortOrder)),
      app.db.select().from(schema.tryonSettings).where(eq(schema.tryonSettings.id, SETTINGS_ID)),
    ]);

    const presign = async (key: string | null | undefined) => {
      if (!key) return null;
      try {
        return (await app.storage.presignGet(key, 3600)).url;
      } catch {
        return null;
      }
    };

    const [personSampleUrl, garmentSampleUrl, creditsCost] = await Promise.all([
      presign(settings?.personSampleThumbKey ?? settings?.personSampleKey),
      presign(settings?.garmentSampleThumbKey ?? settings?.garmentSampleKey),
      getTryonCreditCost(app),
    ]);

    return {
      categories: cats.map((c) => ({ id: c.id, name: c.name, slug: c.slug })),
      personSampleUrl,
      garmentSampleUrl,
      creditsCost,
    };
  });

  // GET /v1/tryon/garment-images — caller's own completed catalog images eligible
  // for reuse as a simple-tryon garment: Studio-flow jobs with an active tryon category
  // chain, plus saree catalogue jobs whose saree_settings has an active tryon workflow
  // mapped (see createSimpleTryonJob). Inner joins do the eligibility filtering.
  // poseId IS NOT NULL restricts the Studio path to jobs created via createJob (which
  // always sets poseId; simple-tryon jobs never do) — excludes tryon-generated images
  // from chaining into further tryon jobs.
  app.get('/v1/tryon/garment-images', { preHandler: app.requireUser }, async (req) => {
    const [studioRows, sareeRows] = await Promise.all([
      app.db
        .select({
          jobId: schema.jobs.id,
          thumbnailKey: schema.jobOutputs.thumbnailKey,
          resultKey: schema.jobOutputs.resultKey,
          garmentTypeName: schema.garmentSubcategories.label,
          tryonCategoryName: schema.tryonCategories.name,
          createdAt: schema.jobs.createdAt,
        })
        .from(schema.jobs)
        .innerJoin(schema.jobOutputs, eq(schema.jobOutputs.jobId, schema.jobs.id))
        .innerJoin(schema.jobInputs, eq(schema.jobInputs.jobId, schema.jobs.id))
        .innerJoin(
          schema.garmentSubcategories,
          eq(schema.garmentSubcategories.id, schema.jobInputs.garmentTypeId),
        )
        .innerJoin(
          schema.tryonCategories,
          and(
            eq(schema.tryonCategories.id, schema.garmentSubcategories.tryonCategoryId),
            eq(schema.tryonCategories.isActive, true),
          ),
        )
        .innerJoin(
          schema.workflowTemplates,
          and(
            eq(schema.workflowTemplates.id, schema.tryonCategories.workflowTemplateId),
            eq(schema.workflowTemplates.isActive, true),
          ),
        )
        .where(
          and(
            eq(schema.jobs.userId, req.userId),
            eq(schema.jobs.status, 'COMPLETED'),
            isNotNull(schema.jobInputs.poseId),
          ),
        ),
      app.db
        .select({
          jobId: schema.jobs.id,
          thumbnailKey: schema.jobOutputs.thumbnailKey,
          resultKey: schema.jobOutputs.resultKey,
          garmentTypeName: sql<string>`'Saree'`.as('garment_type_name'),
          tryonCategoryName: sql<string>`'Saree Catalogue'`.as('tryon_category_name'),
          createdAt: schema.jobs.createdAt,
        })
        .from(schema.jobs)
        .innerJoin(schema.jobOutputs, eq(schema.jobOutputs.jobId, schema.jobs.id))
        .innerJoin(schema.jobInputs, eq(schema.jobInputs.jobId, schema.jobs.id))
        .where(
          and(
            eq(schema.jobs.userId, req.userId),
            eq(schema.jobs.status, 'COMPLETED'),
            sql`${schema.jobInputs.params}->>'kind' = 'saree'`,
          ),
        ),
    ]);

    const merged = [...studioRows, ...sareeRows]
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      // 200 matches the cap already used by GET /v1/catalogues — was 50, which
      // silently dropped older eligible images once a user's combined
      // studio+saree catalogue grew past it (no pagination in the picker UI).
      .slice(0, 200);

    return Promise.all(
      merged.map(async (r) => {
        const thumbKey = r.thumbnailKey ?? keys.output(r.jobId);
        // Legacy rows (predating job_outputs.resultKey being populated for every job)
        // fall back to the PNG convention — mirrors createSimpleTryonJob's garmentKey.
        const fullKey = r.resultKey ?? keys.output(r.jobId);
        let thumbnailUrl: string | null = null;
        let imageUrl: string | null = null;
        try {
          thumbnailUrl = (await app.storage.presignGet(thumbKey, 3600)).url;
        } catch {
          /* missing object — leave null, client shows placeholder */
        }
        try {
          imageUrl = (await app.storage.presignGet(fullKey, 3600)).url;
        } catch {
          /* missing object — leave null, client falls back to thumbnailUrl */
        }
        return {
          jobId: r.jobId,
          thumbnailUrl,
          imageUrl,
          garmentTypeName: r.garmentTypeName,
          tryonCategoryName: r.tryonCategoryName,
          createdAt: r.createdAt.toISOString(),
        };
      }),
    );
  });

  // List catalogues — grouped by catalogue_id, ordered newest first.
  // Optional ?batchId scopes to one batch: without it, a batch at the platform's own
  // max size (maxBatchJobs, same as the .limit(200) below) can fill this entire
  // window by itself, silently pushing older batch catalogues out of the list. The
  // batchId equality filter already bounds the row count to that one batch's size,
  // so the limit is set from the same admin-configured ceiling the batch itself is
  // capped by (getMaxBatchJobs) rather than the general 200.
  app.get(
    '/v1/catalogues',
    {
      preHandler: app.requireUser,
      schema: { querystring: z.object({ batchId: z.string().uuid().optional() }) },
    },
    async (req) => {
      const { batchId } = req.query as { batchId?: string };
      const batchLimit = batchId ? await getMaxBatchJobs(app) : 200;
      const rows = await app.db
        .select({
          id: schema.jobs.id,
          catalogueId: schema.jobs.catalogueId,
          status: schema.jobs.status,
          createdAt: schema.jobs.createdAt,
          creditsCharged: schema.jobs.creditsCharged,
          genderSlug: schema.modelPoseAssets.genderSlug,
          params: schema.jobInputs.params,
          garmentTypeLabel: schema.garmentSubcategories.label,
        })
        .from(schema.jobs)
        .leftJoin(schema.jobInputs, eq(schema.jobInputs.jobId, schema.jobs.id))
        .leftJoin(schema.modelPoseAssets, eq(schema.modelPoseAssets.id, schema.jobInputs.poseId))
        .leftJoin(
          schema.garmentSubcategories,
          eq(schema.garmentSubcategories.id, schema.jobInputs.garmentTypeId),
        )
        .where(
          and(
            eq(schema.jobs.userId, req.userId),
            sql`${schema.jobInputs.params}->>'sourceJobId' is null`,
            sql`${schema.jobInputs.params}->>'kind' is distinct from 'saree_mannequin'`,
            // Catalog-video jobs always set kind='video' regardless of source
            // (an existing AI Vastra job vs. a fresh upload) — the sourceJobId-is-null
            // check above only excludes them by coincidence (today sourceJobId is
            // always set on these jobs) and stops working once sourceJobId becomes
            // optional for the upload path. Exclude by kind explicitly instead.
            sql`${schema.jobInputs.params}->>'kind' is distinct from 'video'`,
            // This gallery is for the account's own first-party catalog/try-on work —
            // exclude jobs created through an external channel (WordPress plugin,
            // Shopify widget, a merchant's own integration, or the public dev API).
            // Those still bill the same userId/user_credits (merchants are 1:1 with
            // users), so without this filter every storefront shopper's try-on click
            // shows up mixed into the merchant's own curated catalog gallery.
            // source is nullable (legacy jobs predate source tracking) — NOT IN
            // against a NULL column evaluates to NULL/excluded in SQL, so the NULL
            // case is kept explicitly rather than silently dropping those jobs.
            or(
              isNull(schema.jobs.source),
              notInArray(schema.jobs.source, [
                JOB_SOURCE.WORDPRESS_TRYON,
                JOB_SOURCE.API_TRYON,
                JOB_SOURCE.API_CATALOG,
                JOB_SOURCE.API_SAREE_MANNEQUIN,
                JOB_SOURCE.MERCHANT_TRYON,
                JOB_SOURCE.MERCHANT_CATALOG,
                JOB_SOURCE.MERCHANT_CATALOG_SAREE_MANNEQUIN,
                JOB_SOURCE.SHOPIFY,
              ]),
            ),
            ...(batchId ? [eq(schema.jobs.batchId, batchId)] : []),
          ),
        )
        .orderBy(desc(schema.jobs.createdAt))
        .limit(batchLimit);

      // Group by catalogueId; jobs without catalogueId use their own id
      type Row = (typeof rows)[number];
      const map = new Map<string, Row[]>();
      for (const row of rows) {
        const key = row.catalogueId ?? row.id;
        if (!map.has(key)) map.set(key, []);
        map.get(key)?.push(row);
      }

      const groups = Array.from(map.entries()).map(([catalogueId, cJobs]) => ({
        catalogueId,
        // genderSlug + platform + garmentType come from the first job that has one
        // (all jobs in a catalogue share these — one Studio submission per catalogue)
        genderSlug: cJobs.find((j) => j.genderSlug)?.genderSlug ?? null,
        platform:
          ((cJobs[0]?.params as Record<string, unknown> | null)?.platform as string) ?? null,
        garmentType: cJobs.find((j) => j.garmentTypeLabel)?.garmentTypeLabel ?? null,
        jobs: cJobs.map(({ genderSlug: _g, params: _p, garmentTypeLabel: _gt, ...j }) => j),
        createdAt: cJobs[cJobs.length - 1].createdAt,
      }));

      // Presign cover + cover thumbnail per catalogue server-side (fast local crypto, no network).
      // coverThumbUrl uses the 512px JPEG thumbnail; coverUrl is the full-size fallback.
      return Promise.all(
        groups.map(async (g) => {
          const cover = g.jobs.find((j) => j.status === 'COMPLETED');
          let coverUrl: string | null = null;
          let coverThumbUrl: string | null = null;
          if (cover) {
            try {
              const [output] = await app.db
                .select({ thumbnailKey: schema.jobOutputs.thumbnailKey })
                .from(schema.jobOutputs)
                .where(eq(schema.jobOutputs.jobId, cover.id));
              const thumbKey = output?.thumbnailKey;
              const [full, thumb] = await Promise.all([
                app.storage.presignGet(keys.output(cover.id), 3600),
                thumbKey ? app.storage.presignGet(thumbKey, 3600) : null,
              ]);
              coverUrl = full.url;
              coverThumbUrl = thumb?.url ?? null;
            } catch {
              /* missing object — leave null, client shows placeholder */
            }
          }
          return { ...g, coverUrl, coverThumbUrl };
        }),
      );
    },
  );

  // Single catalogue — all jobs for a catalogueId
  app.get(
    '/v1/catalogues/:id',
    {
      preHandler: app.requireUser,
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const rows = await app.db
        .select({
          job: schema.jobs,
          assetKind: schema.jobOutputs.assetKind,
          watermarkVersion: schema.jobOutputs.watermarkVersion,
          downloadedAt: schema.jobOutputs.downloadedAt,
        })
        .from(schema.jobs)
        .innerJoin(schema.jobInputs, eq(schema.jobs.id, schema.jobInputs.jobId))
        .leftJoin(schema.jobOutputs, eq(schema.jobs.id, schema.jobOutputs.jobId))
        .where(
          and(
            eq(schema.jobs.catalogueId, id),
            eq(schema.jobs.userId, req.userId),
            sql`${schema.jobInputs.params}->>'sourceJobId' is null`,
            sql`${schema.jobInputs.params}->>'kind' is distinct from 'saree_mannequin'`,
          ),
        )
        .orderBy(schema.jobs.createdAt);
      if (rows.length === 0) throw new AppError('NOT_FOUND', 404, 'catalogue not found');

      const jobs = rows.map((r) => ({
        ...r.job,
        assetKind: r.assetKind,
        watermarkVersion: r.watermarkVersion,
        alreadyDownloaded: r.downloadedAt != null,
      }));

      // All jobs in a catalogue share the same aspectRatio and garment (set once at creation).
      // Pull both from any one job's inputs.
      const [anyInput] = await app.db
        .select({
          params: schema.jobInputs.params,
          upperGarmentKey: schema.jobInputs.upperGarmentKey,
          lowerGarmentKey: schema.jobInputs.lowerGarmentKey,
          lowerCatalogId: schema.jobInputs.lowerCatalogId,
          genderSlug: schema.garmentSubcategories.genderSlug,
          garmentLabel: schema.garmentSubcategories.label,
        })
        .from(schema.jobInputs)
        .innerJoin(schema.jobs, eq(schema.jobInputs.jobId, schema.jobs.id))
        .leftJoin(
          schema.garmentSubcategories,
          eq(schema.jobInputs.garmentTypeId, schema.garmentSubcategories.id),
        )
        .where(and(eq(schema.jobs.catalogueId, id), eq(schema.jobs.userId, req.userId)))
        .limit(1);
      const aspectRatio =
        (anyInput?.params as { aspectRatio?: string } | null)?.aspectRatio ?? null;
      const platform = (anyInput?.params as { platform?: string } | null)?.platform ?? null;

      let garmentUrl: string | null = null;
      const heroKey = anyInput?.upperGarmentKey ?? anyInput?.lowerGarmentKey ?? null;
      if (heroKey) {
        try {
          const { url } = await app.storage.presignGet(heroKey, 3600);
          garmentUrl = url;
        } catch {
          // non-fatal
        }
      } else if (anyInput?.lowerCatalogId) {
        const [catalogItem] = await app.db
          .select({ thumbnailKey: schema.catalogItems.thumbnailKey })
          .from(schema.catalogItems)
          .where(eq(schema.catalogItems.id, anyInput.lowerCatalogId));
        if (catalogItem?.thumbnailKey) {
          garmentUrl = (await app.storage.presignGet(catalogItem.thumbnailKey, 3600)).url;
        }
      }

      // Current plan's watermark entitlement — NOT the per-job snapshot. The UI
      // needs both: assetKind (what was actually delivered) tells it whether to
      // show the watermark banner at all, and this tells it whether the viewer
      // is still on a watermarked plan (so "Regenerate without Watermark" is
      // actually worth offering, vs. already-paid users seeing a stale CTA).
      const [planRow] = await app.db
        .select({ watermark: schema.creditPlans.watermark })
        .from(schema.users)
        .innerJoin(schema.creditPlans, eq(schema.users.tier, schema.creditPlans.slug))
        .where(eq(schema.users.id, req.userId));
      const currentPlanWatermark = planRow?.watermark ?? false;

      return {
        catalogueId: id,
        jobs,
        aspectRatio,
        platform,
        garmentUrl,
        currentPlanWatermark,
        gender: anyInput?.genderSlug ?? null,
        garmentName: anyInput?.garmentLabel ?? null,
      };
    },
  );

  // List user's unique uploaded garments — deduplicated by R2 key
  app.get('/v1/assets', { preHandler: app.requireUser }, async (req) => {
    // Try-on jobs set upperGarmentKey to keys.output(sourceJobId) — a prior job's
    // GENERATED result reused as the "garment" input, not a real upload. Hidden
    // internal mannequin-generation jobs (see createSareeMannequinJob) are never
    // a real product photo either. Exclude both so this page only lists actual
    // product photos.
    const excludeReuse = and(
      sql`${schema.jobInputs.params}->>'sourceJobId' is null`,
      sql`${schema.jobInputs.params}->>'kind' is distinct from 'saree_mannequin'`,
    );
    const [upperRows, lowerRows] = await Promise.all([
      app.db
        .select({
          r2Key: schema.jobInputs.upperGarmentKey,
          uploadedAt: sql<Date>`MAX(${schema.jobs.createdAt})`.as('uploadedAt'),
          jobCount: sql<number>`COUNT(${schema.jobs.id})`.as('jobCount'),
        })
        .from(schema.jobInputs)
        .innerJoin(schema.jobs, eq(schema.jobInputs.jobId, schema.jobs.id))
        .where(
          and(
            eq(schema.jobs.userId, req.userId),
            sql`${schema.jobInputs.upperGarmentKey} is not null`,
            excludeReuse,
          ),
        )
        .groupBy(schema.jobInputs.upperGarmentKey),
      app.db
        .select({
          r2Key: schema.jobInputs.lowerGarmentKey,
          uploadedAt: sql<Date>`MAX(${schema.jobs.createdAt})`.as('uploadedAt'),
          jobCount: sql<number>`COUNT(${schema.jobs.id})`.as('jobCount'),
        })
        .from(schema.jobInputs)
        .innerJoin(schema.jobs, eq(schema.jobInputs.jobId, schema.jobs.id))
        .where(
          and(
            eq(schema.jobs.userId, req.userId),
            sql`${schema.jobInputs.lowerGarmentKey} is not null`,
            excludeReuse,
          ),
        )
        .groupBy(schema.jobInputs.lowerGarmentKey),
    ]);

    // Merge, de-duplicating by r2Key - a garment could theoretically appear as
    // both an upper and lower upload across different jobs. Keep the most
    // recent uploadedAt and sum jobCount when a key appears in both sets.
    // Raw sql`` fragments (MAX/COUNT above) come back from the driver as strings
    // regardless of the sql<Date>/sql<number> type annotations — those generics
    // are TypeScript-only and do nothing at runtime — so both must be coerced
    // here rather than trusted as already being a Date/number.
    const merged = new Map<string, { r2Key: string; uploadedAt: Date; jobCount: number }>();
    for (const row of [...upperRows, ...lowerRows]) {
      if (!row.r2Key) continue;
      const uploadedAt = new Date(row.uploadedAt);
      const jobCount = Number(row.jobCount);
      const existing = merged.get(row.r2Key);
      if (existing) {
        existing.jobCount += jobCount;
        if (uploadedAt > existing.uploadedAt) existing.uploadedAt = uploadedAt;
      } else {
        merged.set(row.r2Key, { r2Key: row.r2Key, uploadedAt, jobCount });
      }
    }
    const result = [...merged.values()].sort(
      (a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime(),
    );

    // Presign each thumbnail server-side so the client gets URLs in one response
    // instead of firing a /v1/uploads/thumbnail request per asset (N+1).
    return Promise.all(
      result.map(async (asset) => {
        let thumbnailUrl: string | null = null;
        try {
          const { url } = await app.storage.presignGet(asset.r2Key, 3600);
          thumbnailUrl = url;
        } catch {
          /* missing object - leave null, client shows placeholder */
        }
        return {
          r2Key: asset.r2Key,
          uploadedAt: asset.uploadedAt,
          jobsCount: asset.jobCount,
          thumbnailUrl,
        };
      }),
    );
  });

  // Batch progress. There is no batches table — every field here is derived from
  // jobs grouped by (batch_id, catalogue_id). A batch belonging to another user
  // is a 404 rather than a 403 so the ID's existence is not disclosed.
  app.get(
    '/v1/batches/:id',
    {
      preHandler: app.requireUser,
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const rows = await app.db
        .select({
          catalogueId: schema.jobs.catalogueId,
          total: sql<number>`COUNT(*)`.as('total'),
          completed: sql<number>`COUNT(*) FILTER (WHERE ${schema.jobs.status} = 'COMPLETED')`.as(
            'completed',
          ),
          failed: sql<number>`COUNT(*) FILTER (WHERE ${schema.jobs.status} = 'FAILED')`.as(
            'failed',
          ),
          createdAt: sql<Date>`MIN(${schema.jobs.createdAt})`.as('createdAt'),
        })
        .from(schema.jobs)
        .where(and(eq(schema.jobs.batchId, id), eq(schema.jobs.userId, req.userId)))
        .groupBy(schema.jobs.catalogueId)
        .orderBy(asc(sql`MIN(${schema.jobs.createdAt})`));

      if (rows.length === 0) throw new AppError('NOT_FOUND', 404, 'batch not found');

      // Raw sql`` aggregates come back from the driver as strings regardless of
      // the sql<number> annotations — those generics are TypeScript-only.
      const catalogues = rows.map((r) => ({
        catalogueId: r.catalogueId,
        total: Number(r.total),
        completed: Number(r.completed),
        failed: Number(r.failed),
        createdAt: new Date(r.createdAt).toISOString(),
      }));

      return {
        batchId: id,
        totalJobs: catalogues.reduce((n, c) => n + c.total, 0),
        catalogues,
      };
    },
  );

  app.get('/v1/jobs', { preHandler: app.requireUser }, async (req) => {
    return app.db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.userId, req.userId))
      .orderBy(desc(schema.jobs.createdAt))
      .limit(50);
  });

  app.get(
    '/v1/jobs/:id',
    {
      preHandler: app.requireUser,
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const [job] = await app.db
        .select()
        .from(schema.jobs)
        .where(and(eq(schema.jobs.id, id), eq(schema.jobs.userId, req.userId)));
      if (!job) throw new AppError('NOT_FOUND', 404, 'job not found');
      return job;
    },
  );

  app.get(
    '/v1/jobs/:id/result',
    {
      preHandler: app.requireUser,
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const [job] = await app.db
        .select()
        .from(schema.jobs)
        .where(and(eq(schema.jobs.id, id), eq(schema.jobs.userId, req.userId)));
      if (!job) throw new AppError('NOT_FOUND', 404, 'job not found');
      if (job.status !== 'COMPLETED') throw new AppError('NOT_READY', 409, 'job not complete');

      // Tryon-direct results (source='tryon'/'api_tryon') are stored WebP-encoded,
      // not PNG (see apps/dispatcher/src/workflow/finalize.ts) — the actual
      // uploaded key must come from job_outputs, not a reconstructed keys.output(id).
      const [output] = await app.db
        .select({ resultKey: schema.jobOutputs.resultKey })
        .from(schema.jobOutputs)
        .where(eq(schema.jobOutputs.jobId, id));
      const r2Key = output?.resultKey ?? keys.output(id);
      const { url, expiresIn } = await app.storage.presignGet(r2Key, 3600);
      return { url, expiresIn };
    },
  );

  // POST /v1/jobs/:id/download — the real "I'm downloading this" signal, deliberately
  // separate from GET /result above. /result is called constantly just to display or
  // zoom a result (studio panel, catalogue grid, preview page all fetch it on render),
  // so stamping downloadedAt there would mark almost every image "downloaded" the
  // instant it's shown, defeating the regenerate-disabled-after-download rule. Only
  // the frontend's actual download buttons call this endpoint.
  app.post(
    '/v1/jobs/:id/download',
    {
      preHandler: app.requireUser,
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const [job] = await app.db
        .select()
        .from(schema.jobs)
        .where(and(eq(schema.jobs.id, id), eq(schema.jobs.userId, req.userId)));
      if (!job) throw new AppError('NOT_FOUND', 404, 'job not found');
      if (job.status !== 'COMPLETED') throw new AppError('NOT_READY', 409, 'job not complete');

      const [output] = await app.db
        .select({ resultKey: schema.jobOutputs.resultKey })
        .from(schema.jobOutputs)
        .where(eq(schema.jobOutputs.jobId, id));
      const r2Key = output?.resultKey ?? keys.output(id);
      const { url, expiresIn } = await app.storage.presignGet(r2Key, 3600);

      // First download wins — never overwrite an earlier timestamp.
      await app.db
        .update(schema.jobOutputs)
        .set({ downloadedAt: sql`coalesce(${schema.jobOutputs.downloadedAt}, now())` })
        .where(eq(schema.jobOutputs.jobId, id));

      return { url, expiresIn };
    },
  );

  app.get(
    '/v1/jobs/:id/thumbnail',
    {
      preHandler: app.requireUser,
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const [job] = await app.db
        .select()
        .from(schema.jobs)
        .where(and(eq(schema.jobs.id, id), eq(schema.jobs.userId, req.userId)));
      if (!job) throw new AppError('NOT_FOUND', 404, 'job not found');
      if (job.status !== 'COMPLETED') throw new AppError('NOT_READY', 409, 'job not complete');

      const [output] = await app.db
        .select({
          thumbnailKey: schema.jobOutputs.thumbnailKey,
          resultKey: schema.jobOutputs.resultKey,
        })
        .from(schema.jobOutputs)
        .where(eq(schema.jobOutputs.jobId, id));

      // Fall back to the full result if no thumbnail generated yet (e.g. backfill
      // pending) — use the job's actual stored resultKey (tryon-direct results are
      // WebP, not PNG; see apps/dispatcher/src/workflow/finalize.ts), only falling
      // back further to the reconstructed PNG key for legacy rows with no output row.
      const r2Key = output?.thumbnailKey ?? output?.resultKey ?? keys.output(id);
      const { url, expiresIn } = await app.storage.presignGet(r2Key, 3600);
      return { url, expiresIn };
    },
  );

  // Cancel a QUEUED job — refunds credits atomically, publishes SSE
  app.post(
    '/v1/jobs/:id/cancel',
    {
      preHandler: app.requireUser,
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };

      let creditsCharged = 0;
      // 'cancelled' — job was QUEUED, transitioned + refunded synchronously below.
      // 'pending' — job was in-flight on the standard tryon pipeline; a Redis flag
      // was set for the dispatcher to pick up on its next GENERATING poll tick, but
      // nothing in Postgres has changed yet, so the SSE/200 path below must be skipped.
      let outcome: 'cancelled' | 'pending' | undefined;
      await app.db.transaction(async (tx) => {
        // Conditional UPDATE — only succeeds if the job is still QUEUED.
        // If the dispatcher has already moved it to PREPROCESSING this returns 0 rows → 409.
        const cancelled = await tx
          .update(schema.jobs)
          .set({ status: 'CANCELLED', completedAt: new Date() } as Parameters<
            ReturnType<typeof tx.update>['set']
          >[0])
          .where(
            and(
              eq(schema.jobs.id, id),
              eq(schema.jobs.userId, req.userId),
              eq(schema.jobs.status, 'QUEUED'),
            ),
          )
          .returning({ creditsCharged: schema.jobs.creditsCharged });

        if (!cancelled.length) {
          // Job not found, not owned by this user, or no longer QUEUED
          const [job] = await tx
            .select({ status: schema.jobs.status, source: schema.jobs.source })
            .from(schema.jobs)
            .where(and(eq(schema.jobs.id, id), eq(schema.jobs.userId, req.userId)));
          if (!job) throw new AppError('NOT_FOUND', 404, 'job not found');

          // In-flight cancellation: only wired up for the standard studio pipeline
          // (apps/dispatcher/src/job/processor.ts's processJob main body — the only
          // processor that checks this flag, in its GENERATING poll loop). That
          // body is reached when jobInputs has faceId+backgroundId+poseId all set,
          // which is what JOB_SOURCE.CATALOG jobs (the /v1/jobs/tryon route, batch,
          // and saree-mannequin step-2) have — NOT JOB_SOURCE.TRYON, which is the
          // "regenerate this look" /v1/jobs/simple-tryon endpoint and is routed to
          // processTryonDirectJob instead, which never wires this flag at all.
          // Saree-mannequin/widget/shopify/merchant/kiosk jobs fall through to the
          // 409 below unchanged; see docs/audits/open-findings.md 7.5/9.1 for why
          // that scope was chosen.
          if (
            (job.status === 'PREPROCESSING' || job.status === 'GENERATING') &&
            job.source === JOB_SOURCE.CATALOG
          ) {
            outcome = 'pending';
            return;
          }

          throw new AppError('CONFLICT', 409, 'only queued jobs can be cancelled');
        }

        outcome = 'cancelled';
        creditsCharged = cancelled[0]?.creditsCharged;

        await tx.insert(schema.jobEvents).values({
          jobId: id,
          eventType: 'CANCELLED',
          payload: {} as Record<string, unknown>,
        });

        // Refund credits — unique index on (job_id, reason) makes this safe against replays
        if (creditsCharged > 0) {
          const inserted = await tx
            .insert(schema.creditLedger)
            .values({
              userId: req.userId,
              delta: creditsCharged,
              reason: 'JOB_CANCEL_REFUND',
              jobId: id,
            })
            .onConflictDoNothing()
            .returning({ id: schema.creditLedger.id });
          if (inserted.length) {
            await tx
              .update(schema.userCredits)
              .set({ balance: sql`${schema.userCredits.balance} + ${creditsCharged}` })
              .where(eq(schema.userCredits.userId, req.userId));
          }
        }
      });

      if (outcome === 'pending') {
        // TTL bounds how long a stale flag can linger if the job finishes (or
        // crashes) before the dispatcher's next poll tick ever reads it. Set
        // outside the transaction — Redis isn't transactional with Postgres here,
        // and nothing above depends on this having landed.
        await app.redis.set(`job:cancel:${id}`, '1', 'EX', 600);
        reply.code(202).send({ ok: true, pending: true });
        return;
      }

      // Publish SSE so open tabs update immediately
      const ssePayload = JSON.stringify({
        jobId: id,
        userId: req.userId,
        type: 'STATUS',
        status: 'CANCELLED',
      });
      await Promise.all([
        app.redis.publish(`sse:events:${req.userId}`, ssePayload),
        app.redis.publish('sse:events:admin', ssePayload),
      ]);

      reply.code(200).send({ ok: true, creditsRefunded: creditsCharged });
    },
  );

  // Delete a terminal job (COMPLETED / FAILED / CANCELLED) — also removes R2 output
  app.delete(
    '/v1/jobs/:id',
    {
      preHandler: app.requireUser,
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    async (req, reply) => {
      const { id } = req.params as { id: string };
      const [job] = await app.db
        .select()
        .from(schema.jobs)
        .where(and(eq(schema.jobs.id, id), eq(schema.jobs.userId, req.userId)));
      if (!job) throw new AppError('NOT_FOUND', 404, 'job not found');
      const TERMINAL = ['COMPLETED', 'FAILED', 'CANCELLED'];
      if (!TERMINAL.includes(job.status)) {
        throw new AppError('CONFLICT', 409, 'cannot delete an active job');
      }
      // Delete R2 output object if it exists. Tryon-direct results
      // (source='tryon'/'api_tryon') are stored WebP-encoded, not PNG (see
      // apps/dispatcher/src/workflow/finalize.ts) — the actual uploaded key
      // must come from job_outputs, not a reconstructed keys.output(id), or
      // this silently no-ops (catch below) and leaks the real object forever.
      if (job.status === 'COMPLETED') {
        try {
          const [output] = await app.db
            .select({ resultKey: schema.jobOutputs.resultKey })
            .from(schema.jobOutputs)
            .where(eq(schema.jobOutputs.jobId, id));
          await app.storage.deleteObject(output?.resultKey ?? keys.output(id));
        } catch {
          /* ignore if missing */
        }
      }
      // Delete child rows explicitly before the parent to avoid FK ordering issues
      await app.db.delete(schema.jobInputs).where(eq(schema.jobInputs.jobId, id));
      await app.db.delete(schema.jobEvents).where(eq(schema.jobEvents.jobId, id));
      await app.db.delete(schema.jobOutputs).where(eq(schema.jobOutputs.jobId, id));
      await app.db.delete(schema.jobs).where(eq(schema.jobs.id, id));
      reply.code(204).send();
    },
  );

  // Contact form — auth required (tryon page is inside protected app shell)
  app.post(
    '/v1/contact',
    {
      preHandler: app.requireUser,
      schema: {
        body: z.object({
          name: z.string().min(1).max(200),
          email: z.string().email().max(200),
          phone: z.string().min(1).max(50),
          source: z.string().max(200).optional(),
          message: z.string().max(2000).optional(),
        }),
      },
    },
    async (req, reply) => {
      const body = req.body as {
        name: string;
        email: string;
        phone: string;
        source?: string;
        message?: string;
      };
      await app.db.insert(schema.contactRequests).values({
        userId: req.userId,
        name: body.name,
        email: body.email,
        phone: body.phone,
        source: body.source ?? null,
        message: body.message ?? null,
      });

      try {
        await sendReportReceivedEmail(app.env.RESEND_API_KEY, app.env.EMAIL_FROM, body.email);
      } catch (err) {
        app.log.error({ err }, 'Failed to send report-received acknowledgment email');
      }

      reply.code(204).send();
    },
  );

  // User-level stream: all job events for the authenticated user (single connection replaces per-job SSE)
  app.get('/v1/jobs/stream', { preHandler: app.requireUser }, userStreamHandler);

  // Per-job SSE kept for backward compatibility
  app.get(
    '/v1/jobs/:id/events',
    {
      preHandler: app.requireUser,
      schema: { params: z.object({ id: z.string().uuid() }) },
    },
    sseHandler,
  );
}
