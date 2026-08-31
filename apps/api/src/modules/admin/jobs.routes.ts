import { schema } from '@tryme/db';
import { JOB_SOURCE, jobSourceSchema } from '@tryme/types';
import { aliasedTable, and, count, desc, eq, gte, ilike, lte, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { verifyPassword } from '../auth/service.js';
import { refund } from '../credits/ledger.js';
import { adminStreamHandler } from '../jobs/sse.js';
import { recordAudit } from './audit.js';
import { requireAdmin, requirePermission } from './guard.js';
import { jobTypeSql } from './job-type.js';
import {
  describeJobsExportFilters,
  JobsExportQuery,
  loadJobsForExport,
} from './jobs-export-query.js';
import { renderJobsExportXlsx } from './jobs-export-xlsx.js';

const JobsQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  status: z
    .enum([
      'HELD',
      'QUEUED',
      'PREPROCESSING',
      'GENERATING',
      'UPLOADING',
      'COMPLETED',
      'FAILED',
      'CANCELLED',
      'PENDING_MANNEQUIN',
    ])
    .optional(),
  search: z.string().optional(),
  date: z.string().optional(),
  jobType: jobSourceSchema.optional(),
  workerId: z.string().optional(),
  // Created-at range filter (datetime-local input values, e.g. "2026-08-18T14:30") —
  // separate from `date` above (exact-day match), which other admin pages already
  // navigate here with via router state and must keep working unchanged.
  createdFrom: z.string().optional(),
  createdTo: z.string().optional(),
});

const DELETE_ASSETS_TARGETS = ['result', 'person'] as const;
type DeleteAssetsTarget = (typeof DELETE_ASSETS_TARGETS)[number];

const DeleteAssetsBody = z.object({
  password: z.string().min(1),
  targets: z.array(z.enum(DELETE_ASSETS_TARGETS)).min(1),
});

const TERMINAL_JOB_STATUSES = ['COMPLETED', 'FAILED', 'CANCELLED'] as const;

/**
 * Deletes one R2 object if a key is given. Never throws — a failed delete is
 * reported via `ok: false` so the caller can decide whether to null the
 * corresponding DB pointer (never null a pointer whose object is still there).
 */
async function purgeKeyIfPresent(
  app: FastifyInstance,
  key: string | null | undefined,
): Promise<{ ok: boolean; shouldClear: boolean }> {
  if (!key) return { ok: true, shouldClear: false };
  try {
    await app.storage.deleteObject(key);
    return { ok: true, shouldClear: true };
  } catch (err) {
    app.log.warn({ err, key }, 'admin delete-assets: object delete failed');
    return { ok: false, shouldClear: false };
  }
}

export async function adminJobsRoutes(app: FastifyInstance) {
  const R = requirePermission('jobs.read');
  const W = requirePermission('jobs.write');

  app.get('/admin/jobs/sources', { preHandler: R }, async () => Object.values(JOB_SOURCE));

  // Full (unpaginated) filtered export for developers to see how a user's
  // jobs and credit balance evolved over time — same filters as the Jobs
  // table above. Excel only, no PDF (a wide time-series/credit table reads
  // far better as a spreadsheet than a printable page).
  app.get(
    '/admin/jobs/export.xlsx',
    { preHandler: R, schema: { querystring: JobsExportQuery } },
    async (req, reply) => {
      const query = req.query as JobsExportQuery;
      const rows = await loadJobsForExport(app, query);
      const xlsx = await renderJobsExportXlsx(rows, {
        generatedAt: new Date(),
        filterDescription: describeJobsExportFilters(query),
      });

      const filename = `jobs-export-${new Date().toISOString().slice(0, 10)}.xlsx`;
      return reply
        .header('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
        .header('Content-Disposition', `attachment; filename="${filename}"`)
        .send(xlsx);
    },
  );

  app.get('/admin/jobs', { preHandler: R, schema: { querystring: JobsQuery } }, async (req) => {
    const query =
      // biome-ignore lint/suspicious/noExplicitAny: Fastify typed-provider workaround
      req.query as any;
    const { page, pageSize, status, search, date, jobType, workerId, createdFrom, createdTo } =
      query;

    const conditions: ReturnType<typeof eq>[] = [];
    if (status) conditions.push(eq(schema.jobs.status, status));
    if (date) {
      // Postgres exact date match for UTC createdAt
      conditions.push(sql`${schema.jobs.createdAt}::date = ${date}::date` as ReturnType<typeof eq>);
    }
    if (jobType) {
      conditions.push(sql`${jobTypeSql()} = ${jobType}` as ReturnType<typeof eq>);
    }
    const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
    if (createdFrom) {
      const fromInclusive = new Date(
        DATE_ONLY.test(createdFrom) ? `${createdFrom}T00:00:00.000Z` : createdFrom,
      );
      conditions.push(gte(schema.jobs.createdAt, fromInclusive));
    }
    if (createdTo) {
      const toInclusive = new Date(
        DATE_ONLY.test(createdTo) ? `${createdTo}T23:59:59.999Z` : createdTo,
      );
      conditions.push(lte(schema.jobs.createdAt, toInclusive));
    }
    if (search) {
      conditions.push(
        or(
          ilike(sql`${schema.jobs.id}::text`, `%${search}%`),
          ilike(schema.users.email, `%${search}%`),
          ilike(schema.users.username, `%${search}%`),
        ) as ReturnType<typeof eq>,
      );
    }
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    // jobType filtering (jobTypeSql) reads job_inputs.face_id, so the count query
    // needs the same join as the row query below or it 500s whenever jobType is set.
    const [{ total }] = await app.db
      .select({ total: count() })
      .from(schema.jobs)
      .leftJoin(schema.users, eq(schema.users.id, schema.jobs.userId))
      .leftJoin(schema.jobInputs, eq(schema.jobInputs.jobId, schema.jobs.id))
      .where(where);

    const rows = await app.db
      .select({
        id: schema.jobs.id,
        status: schema.jobs.status,
        userId: schema.jobs.userId,
        userEmail: schema.users.email,
        workerId: schema.jobs.workerId,
        priority: schema.jobs.priority,
        creditsCharged: schema.jobs.creditsCharged,
        attempts: schema.jobs.attempts,
        errorCode: schema.jobs.errorCode,
        createdAt: schema.jobs.createdAt,
        startedAt: schema.jobs.startedAt,
        completedAt: schema.jobs.completedAt,
        // Non-null = this job was created by the regenerate flow, not a fresh
        // submission — surfaced in the table as a "Regenerated" badge.
        parentJobId: schema.jobs.parentJobId,
        faceLabel: schema.modelFaces.label,
        faceThumbnailKey: schema.modelFaces.thumbnailKey,
        backgroundLabel: schema.modelBackgrounds.label,
        poseLabel: schema.modelPoseAssets.displayName,
        hasLower: sql<boolean>`(${schema.jobInputs.lowerCatalogId} IS NOT NULL)`,
        hasShoe: sql<boolean>`(${schema.jobInputs.shoeCatalogId} IS NOT NULL)`,
        outputKey: schema.jobOutputs.resultKey,
        jobType: jobTypeSql(),
      })
      .from(schema.jobs)
      .leftJoin(schema.users, eq(schema.users.id, schema.jobs.userId))
      .leftJoin(schema.jobInputs, eq(schema.jobInputs.jobId, schema.jobs.id))
      .leftJoin(schema.modelFaces, eq(schema.modelFaces.id, schema.jobInputs.faceId))
      .leftJoin(
        schema.modelBackgrounds,
        eq(schema.modelBackgrounds.id, schema.jobInputs.backgroundId),
      )
      .leftJoin(schema.modelPoseAssets, eq(schema.modelPoseAssets.id, schema.jobInputs.poseId))
      .leftJoin(schema.jobOutputs, eq(schema.jobOutputs.jobId, schema.jobs.id))
      .where(where)
      .orderBy(desc(schema.jobs.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    return {
      page,
      pageSize,
      total,
      items: await Promise.all(
        rows.map(async (r) => ({
          ...r,
          outputUrl: r.outputKey
            ? (await app.storage.presignGet(r.outputKey, 3600)).url
            : undefined,
          faceThumbnailUrl: r.faceThumbnailKey
            ? (await app.storage.presignGet(r.faceThumbnailKey, 3600)).url
            : undefined,
          outputKey: undefined,
          faceThumbnailKey: undefined,
        })),
      ),
    };
  });

  app.get(
    '/admin/jobs/:id',
    { preHandler: R, schema: { params: z.object({ id: z.string().uuid() }) } },
    async (req) => {
      // biome-ignore lint/suspicious/noExplicitAny: Fastify typed-provider workaround
      const { id } = req.params as any;
      const lowerCatalog = aliasedTable(schema.catalogItems, 'lower_catalog');
      const shoeCatalog = aliasedTable(schema.catalogItems, 'shoe_catalog');
      const defaultWorkflow = aliasedTable(schema.workflowTemplates, 'default_workflow');
      const overrideWorkflow = aliasedTable(schema.workflowTemplates, 'override_workflow');

      const [row] = await app.db
        .select({
          id: schema.jobs.id,
          status: schema.jobs.status,
          userId: schema.jobs.userId,
          userEmail: schema.users.email,
          workerId: schema.jobs.workerId,
          priority: schema.jobs.priority,
          creditsCharged: schema.jobs.creditsCharged,
          attempts: schema.jobs.attempts,
          errorCode: schema.jobs.errorCode,
          createdAt: schema.jobs.createdAt,
          startedAt: schema.jobs.startedAt,
          completedAt: schema.jobs.completedAt,
          parentJobId: schema.jobs.parentJobId,
          faceLabel: schema.modelFaces.label,
          backgroundLabel: schema.modelBackgrounds.label,
          poseLabel: schema.modelPoseAssets.displayName,
          hasLower: sql<boolean>`(${schema.jobInputs.lowerCatalogId} IS NOT NULL)`,
          hasShoe: sql<boolean>`(${schema.jobInputs.shoeCatalogId} IS NOT NULL)`,
          jobType: jobTypeSql(),
          userHint: schema.jobInputs.userHint,
          outputKey: schema.jobOutputs.resultKey,
          customerPhotoKey: schema.jobs.customerPhotoKey,
          // ComfyUI-actual inputs — mirrors dispatcher's key resolution exactly
          // faceSideKey lives on model_faces, bgComfyKey lives on model_backgrounds
          faceSideKey: schema.modelFaces.faceSideR2Key,
          faceDisplayKey: schema.modelFaces.r2Key,
          bgComfyKey: schema.modelBackgrounds.bgComfyR2Key,
          bgFallbackKey: schema.modelBackgrounds.r2Key,
          poseKey: schema.modelPoseAssets.r2Key,
          upperGarmentKey: schema.jobInputs.upperGarmentKey,
          lowerGarmentKey: schema.jobInputs.lowerGarmentKey,
          lowerCatalogKey: lowerCatalog.r2Key,
          shoeCatalogKey: shoeCatalog.r2Key,
          jobParams: schema.jobInputs.params,
          defaultWorkflowLabel: defaultWorkflow.label,
          overrideWorkflowLabel: overrideWorkflow.label,
        })
        .from(schema.jobs)
        .leftJoin(schema.users, eq(schema.users.id, schema.jobs.userId))
        .leftJoin(schema.jobInputs, eq(schema.jobInputs.jobId, schema.jobs.id))
        .leftJoin(schema.modelFaces, eq(schema.modelFaces.id, schema.jobInputs.faceId))
        .leftJoin(
          schema.modelBackgrounds,
          eq(schema.modelBackgrounds.id, schema.jobInputs.backgroundId),
        )
        .leftJoin(schema.modelPoseAssets, eq(schema.modelPoseAssets.id, schema.jobInputs.poseId))
        .leftJoin(schema.jobOutputs, eq(schema.jobOutputs.jobId, schema.jobs.id))
        .leftJoin(lowerCatalog, eq(lowerCatalog.id, schema.jobInputs.lowerCatalogId))
        .leftJoin(shoeCatalog, eq(shoeCatalog.id, schema.jobInputs.shoeCatalogId))
        .leftJoin(
          defaultWorkflow,
          eq(defaultWorkflow.id, schema.modelPoseAssets.workflowTemplateId),
        )
        .leftJoin(
          schema.poseGarmentConfigs,
          and(
            eq(schema.poseGarmentConfigs.poseAssetId, schema.jobInputs.poseId),
            eq(schema.poseGarmentConfigs.subcategoryId, schema.jobInputs.garmentTypeId),
          ),
        )
        .leftJoin(
          overrideWorkflow,
          eq(overrideWorkflow.id, schema.poseGarmentConfigs.workflowTemplateId),
        )
        .where(eq(schema.jobs.id, id));

      if (!row) throw new AppError('NOT_FOUND', 404, 'job not found');

      const events = await app.db
        .select()
        .from(schema.jobEvents)
        .where(eq(schema.jobEvents.jobId, id))
        .orderBy(desc(schema.jobEvents.createdAt))
        .limit(50);

      // Pulled out to a top-level field so the admin UI doesn't need to parse
      // the raw event log just to show why this regeneration happened.
      const regenerateReason =
        (
          events.find((e) => e.eventType === 'REGENERATE_REASON')?.payload as
            | { reason?: string }
            | undefined
        )?.reason ?? null;

      const pu = async (key: string | null | undefined) =>
        key ? (await app.storage.presignGet(key, 3600)).url : undefined;

      // Mirrors dispatcher resolution: lowerGarmentKey (user-upload) takes priority over catalog
      const lowerKey = row.lowerGarmentKey ?? row.lowerCatalogKey;
      const shoeKey = row.shoeCatalogKey;

      // Mirror dispatcher's bg key logic exactly:
      // Amazon always uses the white BG (bgFallbackKey = modelBackgrounds.r2Key, already overridden to white BG at job creation)
      // Non-Amazon uses pose's ComfyUI-specific bg key, falling back to display bg
      const params = (row.jobParams ?? {}) as Record<string, unknown>;
      const isAmazon = params.platform === 'Amazon';
      const bgKey = isAmazon ? row.bgFallbackKey : (row.bgComfyKey ?? row.bgFallbackKey);

      // For tryon-direct jobs, person image is stored in params.personKey.
      // Merchant/Shopify tryon jobs instead store it on jobs.customerPhotoKey.
      const personKey =
        (typeof params.personKey === 'string' ? params.personKey : undefined) ??
        row.customerPhotoKey ??
        undefined;

      // For tryon-direct jobs the workflow comes from params.workflowTemplateId, not pose join
      let workflowLabel = row.overrideWorkflowLabel ?? row.defaultWorkflowLabel ?? null;
      if (!workflowLabel && typeof params.workflowTemplateId === 'string') {
        const [wt] = await app.db
          .select({ label: schema.workflowTemplates.label })
          .from(schema.workflowTemplates)
          .where(eq(schema.workflowTemplates.id, params.workflowTemplateId));
        workflowLabel = wt?.label ?? null;
      }

      return {
        ...row,
        outputUrl: await pu(row.outputKey),
        outputKey: undefined,
        faceSideKey: undefined,
        faceDisplayKey: undefined,
        bgComfyKey: undefined,
        bgFallbackKey: undefined,
        poseKey: undefined,
        upperGarmentKey: undefined,
        lowerGarmentKey: undefined,
        lowerCatalogKey: undefined,
        shoeCatalogKey: undefined,
        jobParams: undefined,
        customerPhotoKey: undefined,
        workflowLabel,
        regenerateReason,
        defaultWorkflowLabel: undefined,
        overrideWorkflowLabel: undefined,
        inputImages: {
          person: await pu(personKey),
          face: await pu(row.faceSideKey ?? row.faceDisplayKey),
          background: await pu(bgKey),
          pose: await pu(row.poseKey),
          upper: await pu(row.upperGarmentKey),
          lower: await pu(lowerKey),
          shoe: await pu(shoeKey),
        },
        events,
      };
    },
  );

  app.post('/admin/jobs/flush-queue', { preHandler: W }, async () => {
    const queued = await app.db
      .select({
        id: schema.jobs.id,
        userId: schema.jobs.userId,
        creditsCharged: schema.jobs.creditsCharged,
      })
      .from(schema.jobs)
      .where(eq(schema.jobs.status, 'QUEUED'));

    if (queued.length === 0) return { flushed: 0 };

    await app.db
      .update(schema.jobs)
      .set({ status: 'CANCELLED', errorCode: 'ADMIN_FLUSH' })
      .where(eq(schema.jobs.status, 'QUEUED'));

    await Promise.all(
      queued
        .filter((j) => j.userId && j.creditsCharged > 0)
        .map((j) =>
          refund(app.db, j.userId as string, j.creditsCharged, j.id, 'REFUND_ADMIN_CANCEL'),
        ),
    );

    return { flushed: queued.length };
  });

  app.post(
    '/admin/jobs/:id/retry',
    { preHandler: W, schema: { params: z.object({ id: z.string().uuid() }) } },
    async (req) => {
      // biome-ignore lint/suspicious/noExplicitAny: Fastify typed-provider workaround
      const { id } = req.params as any;
      const [job] = await app.db.select().from(schema.jobs).where(eq(schema.jobs.id, id));
      if (!job) throw new AppError('NOT_FOUND', 404, 'no job');
      if (job.status !== 'FAILED') throw new AppError('BAD_STATE', 409, 'only FAILED can retry');
      await app.db
        .update(schema.jobs)
        .set({ status: 'QUEUED', errorCode: null, attempts: 0 })
        .where(eq(schema.jobs.id, id));
      const stream = `jobs:${job.queueStream ?? (job.priority ? 'priority' : 'normal')}`;
      await app.redis.xadd(
        stream,
        'MAXLEN',
        '~',
        10000,
        '*',
        'jobId',
        id,
        'userId',
        job.userId ?? '',
      );
      return { ok: true };
    },
  );

  app.post(
    '/admin/jobs/:id/cancel',
    { preHandler: W, schema: { params: z.object({ id: z.string().uuid() }) } },
    async (req) => {
      // biome-ignore lint/suspicious/noExplicitAny: Fastify typed-provider workaround
      const { id } = req.params as any;
      const [job] = await app.db.select().from(schema.jobs).where(eq(schema.jobs.id, id));
      if (!job) throw new AppError('NOT_FOUND', 404, 'no job');
      if (['COMPLETED', 'CANCELLED'].includes(job.status)) return { ok: true };
      await app.db
        .update(schema.jobs)
        .set({ status: 'CANCELLED', errorCode: 'ADMIN_CANCEL' })
        .where(eq(schema.jobs.id, id));
      if (job.userId) {
        await refund(app.db, job.userId, job.creditsCharged, id, 'REFUND_ADMIN_CANCEL');
      }
      return { ok: true };
    },
  );

  app.post(
    '/admin/jobs/:id/delete-assets',
    {
      preHandler: requireAdmin(['SUPER_ADMIN']),
      schema: { params: z.object({ id: z.string().uuid() }), body: DeleteAssetsBody },
    },
    async (req) => {
      // biome-ignore lint/suspicious/noExplicitAny: Fastify typed-provider workaround
      const { id } = req.params as any;
      const { password, targets: rawTargets } = req.body as z.infer<typeof DeleteAssetsBody>;
      const targets = [...new Set(rawTargets)] as DeleteAssetsTarget[];

      const [caller] = await app.db
        .select({ passwordHash: schema.users.passwordHash })
        .from(schema.users)
        .where(eq(schema.users.id, req.userId));
      if (!caller?.passwordHash || !(await verifyPassword(caller.passwordHash, password))) {
        throw new AppError('FORBIDDEN', 403, 'incorrect password');
      }

      const [job] = await app.db.select().from(schema.jobs).where(eq(schema.jobs.id, id));
      if (!job) throw new AppError('NOT_FOUND', 404, 'no job');
      if (!(TERMINAL_JOB_STATUSES as readonly string[]).includes(job.status)) {
        throw new AppError('BAD_STATE', 409, 'job must be COMPLETED, FAILED, or CANCELLED');
      }

      const [output] = await app.db
        .select({
          resultKey: schema.jobOutputs.resultKey,
          thumbnailKey: schema.jobOutputs.thumbnailKey,
        })
        .from(schema.jobOutputs)
        .where(eq(schema.jobOutputs.jobId, id));
      const [inputRow] = await app.db
        .select({ params: schema.jobInputs.params })
        .from(schema.jobInputs)
        .where(eq(schema.jobInputs.jobId, id));
      const paramsBefore = (inputRow?.params ?? {}) as Record<string, unknown>;
      const paramsPersonKey =
        typeof paramsBefore.personKey === 'string' ? paramsBefore.personKey : null;

      const before = {
        requestedTargets: targets,
        hadResult: !!output?.resultKey,
        hadThumbnail: !!output?.thumbnailKey,
        hadCustomerPhotoKey: !!job.customerPhotoKey,
        hadParamsPersonKey: !!paramsPersonKey,
      };

      const deleted: DeleteAssetsTarget[] = [];
      const outputPatch: { resultKey?: null; thumbnailKey?: null } = {};
      let clearCustomerPhoto = false;
      let clearParamsPersonKey = false;

      if (targets.includes('result')) {
        const r = await purgeKeyIfPresent(app, output?.resultKey);
        const t = await purgeKeyIfPresent(app, output?.thumbnailKey);
        if (r.shouldClear) outputPatch.resultKey = null;
        if (t.shouldClear) outputPatch.thumbnailKey = null;
        if (r.ok && t.ok) deleted.push('result');
      }

      if (targets.includes('person')) {
        const c = await purgeKeyIfPresent(app, job.customerPhotoKey);
        const p = await purgeKeyIfPresent(app, paramsPersonKey);
        if (c.shouldClear) clearCustomerPhoto = true;
        if (p.shouldClear) clearParamsPersonKey = true;
        if (c.ok && p.ok) deleted.push('person');
      }

      await app.db.transaction(async (tx) => {
        if (Object.keys(outputPatch).length > 0) {
          await tx
            .update(schema.jobOutputs)
            .set(outputPatch)
            .where(eq(schema.jobOutputs.jobId, id));
        }
        if (clearCustomerPhoto) {
          await tx
            .update(schema.jobs)
            .set({ customerPhotoKey: null })
            .where(eq(schema.jobs.id, id));
        }
        if (clearParamsPersonKey) {
          await tx
            .update(schema.jobInputs)
            .set({ params: sql`${schema.jobInputs.params} - 'personKey'` })
            .where(eq(schema.jobInputs.jobId, id));
        }
        await recordAudit(tx, {
          actor: { userId: req.userId, role: req.adminRole ?? 'SUPER_ADMIN' },
          action: 'jobs.delete_assets',
          resourceType: 'job',
          resourceId: id,
          before,
          after: { deleted },
          request: req,
        });
      });

      return { ok: deleted.length === targets.length, deleted };
    },
  );

  // Admin real-time job event stream — delivers all job transitions across all users
  app.get('/admin/jobs/stream', { preHandler: R }, adminStreamHandler);
}
