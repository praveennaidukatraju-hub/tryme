import { schema } from '@tryme/db';
import { keys } from '@tryme/storage';
import {
  DEFAULT_MAX_BATCH_JOBS,
  DEFAULT_MAX_QUEUE_DEPTH,
  PresignAppVideoBody,
  SystemConfigBody,
} from '@tryme/types';
import { and, count, countDistinct, eq, gte, lt, lte, sql, sum } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import {
  DEFAULT_MAX_OUTPUT_PX,
  DEFAULT_PIXVERSE_CONFIG,
  DEFAULT_RESOLUTION_CONFIG,
  DEFAULT_SAREE_MANNEQUIN_DEV_CONFIG,
  DEFAULT_SELLER_CONFIG,
  DEFAULT_SHOPIFY_TRIAL_CONFIG,
  DEFAULT_TRYON_CONFIG,
} from '../../lib/resolution-config.js';
import { DEFAULT_UPLOAD_LIMITS } from '../../lib/upload-limits-config.js';
import { CREDIT_PACKS } from '../shopify/packs.js';
import { requirePermission } from './guard.js';

const KEY = 'config:system';

export async function adminConfigRoutes(app: FastifyInstance) {
  // Public — used by the web pricing page and studio custom-resolution input (no auth required)
  app.get('/v1/config/resolutions', async () => {
    const raw = await app.redis.get(KEY);
    const cfg = raw ? JSON.parse(raw) : {};
    return {
      resolutions: cfg.resolutions ?? DEFAULT_RESOLUTION_CONFIG,
      maxOutputPx: cfg.maxOutputPx ?? DEFAULT_MAX_OUTPUT_PX,
    };
  });

  // Public — used by the login/register pages so the advertised signup bonus
  // never drifts from what PATCH /v1/me actually grants (both read the same
  // credit_plans row).
  app.get('/v1/config/free-plan', async () => {
    const [plan] = await app.db
      .select({ credits: schema.creditPlans.credits })
      .from(schema.creditPlans)
      .where(eq(schema.creditPlans.slug, 'free'));
    return { credits: plan?.credits ?? 0 };
  });

  app.get('/admin/config', { preHandler: requirePermission('config.read') }, async () => {
    const raw = await app.redis.get(KEY);
    const cfg = raw ? JSON.parse(raw) : {};
    cfg.resolutions = cfg.resolutions ?? DEFAULT_RESOLUTION_CONFIG;
    cfg.maxOutputPx = cfg.maxOutputPx ?? DEFAULT_MAX_OUTPUT_PX;
    cfg.maxBatchJobs = cfg.maxBatchJobs ?? DEFAULT_MAX_BATCH_JOBS;
    cfg.maxQueueDepth = cfg.maxQueueDepth ?? DEFAULT_MAX_QUEUE_DEPTH;
    cfg.tryon = cfg.tryon ?? DEFAULT_TRYON_CONFIG;
    cfg.sareeMannequinDev = cfg.sareeMannequinDev ?? DEFAULT_SAREE_MANNEQUIN_DEV_CONFIG;
    cfg.pixverse = cfg.pixverse ?? DEFAULT_PIXVERSE_CONFIG;
    cfg.shopify = {
      trialCredits: cfg.shopify?.trialCredits ?? DEFAULT_SHOPIFY_TRIAL_CONFIG.trialCredits,
      packCredits: Object.fromEntries(
        Object.entries(CREDIT_PACKS).map(([id, pack]) => [
          id,
          {
            credits: cfg.shopify?.packCredits?.[id]?.credits ?? pack.credits,
            autorefillCredits:
              cfg.shopify?.packCredits?.[id]?.autorefillCredits ?? pack.autorefillCredits,
          },
        ]),
      ),
    };
    cfg.uploadLimits = { ...DEFAULT_UPLOAD_LIMITS, ...cfg.uploadLimits };
    cfg.seller = { ...DEFAULT_SELLER_CONFIG, ...cfg.seller };
    return cfg;
  });

  app.patch(
    '/admin/config',
    {
      preHandler: requirePermission('config.write'),
      schema: { body: SystemConfigBody },
    },
    async (req) => {
      const cur = JSON.parse((await app.redis.get(KEY)) ?? '{}') as Record<string, unknown>;
      const next = { ...cur, ...(req.body as Record<string, unknown>) };
      await app.redis.set(KEY, JSON.stringify(next));
      return next;
    },
  );

  // ── App video (single global clip, e.g. Android app intro/promo) ─────────

  app.post(
    '/admin/config/app-video/presign',
    {
      preHandler: requirePermission('config.manage'),
      schema: { body: PresignAppVideoBody },
    },
    async (req) => {
      const { contentType } = req.body as { contentType: string };
      const key = keys.appVideo();
      const { url } = await app.storage.presignPut(key, contentType, 50_000_000, 300);
      return { uploadUrl: url, key };
    },
  );

  app.post(
    '/admin/config/app-video/confirm',
    { preHandler: requirePermission('config.manage') },
    async () => {
      const key = keys.appVideo();
      const cur = JSON.parse((await app.redis.get(KEY)) ?? '{}') as Record<string, unknown>;
      const updatedAt = new Date().toISOString();
      cur.appVideo = { key, updatedAt };
      await app.redis.set(KEY, JSON.stringify(cur));
      return { videoUrl: await appVideoUrl(app, key), updatedAt };
    },
  );

  app.get('/admin/config/app-video', { preHandler: requirePermission('config.read') }, async () => {
    const cfg = await readAppVideoConfig(app, KEY);
    if (!cfg) return { videoUrl: null, updatedAt: null };
    return { videoUrl: await appVideoUrl(app, cfg.key), updatedAt: cfg.updatedAt };
  });

  // Public — used by the Android app to fetch the current intro/promo video (no auth)
  app.get('/v1/config/app-video', async () => {
    const cfg = await readAppVideoConfig(app, KEY);
    return { videoUrl: cfg ? await appVideoUrl(app, cfg.key) : null };
  });

  app.get('/admin/stats', { preHandler: requirePermission('config.read') }, async (req) => {
    const query = req.query as { days?: string };
    const days = parseInt(query.days || '7', 10);
    const validDays = Number.isNaN(days) || days < 1 ? 7 : days > 30 ? 30 : days;

    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const yesterday = new Date(todayStart.getTime() - 86400000);
    const h24ago = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const dNago = new Date(todayStart.getTime() - (validDays - 1) * 86400000);
    const stuckThreshold = new Date(now.getTime() - 10 * 60 * 1000);

    const [
      queueDepthRow,
      workersRaw,
      jobsTodayRows,
      jobsYesterdayRows,
      activeUsersTodayRows,
      activeUsersYesterdayRows,
      creditsTodayRows,
      creditsYesterdayRows,
      failed24hRows,
      jobsPerDayRows,
      recentFailures,
      stuckJobs,
      newUsersRows,
      newContactsRows,
    ] = await Promise.all([
      app.db.select({ c: count() }).from(schema.jobs).where(eq(schema.jobs.status, 'QUEUED')),
      app.redis.hgetall('worker:registry'),

      app.db.select({ c: count() }).from(schema.jobs).where(gte(schema.jobs.createdAt, todayStart)),
      app.db
        .select({ c: count() })
        .from(schema.jobs)
        .where(and(gte(schema.jobs.createdAt, yesterday), lt(schema.jobs.createdAt, todayStart))),

      app.db
        .select({ c: countDistinct(schema.jobs.userId) })
        .from(schema.jobs)
        .where(gte(schema.jobs.createdAt, todayStart)),
      app.db
        .select({ c: countDistinct(schema.jobs.userId) })
        .from(schema.jobs)
        .where(and(gte(schema.jobs.createdAt, yesterday), lt(schema.jobs.createdAt, todayStart))),

      app.db
        .select({ c: sum(schema.jobs.creditsCharged) })
        .from(schema.jobs)
        .where(and(eq(schema.jobs.status, 'COMPLETED'), gte(schema.jobs.completedAt, todayStart))),
      app.db
        .select({ c: sum(schema.jobs.creditsCharged) })
        .from(schema.jobs)
        .where(
          and(
            eq(schema.jobs.status, 'COMPLETED'),
            gte(schema.jobs.completedAt, yesterday),
            lt(schema.jobs.completedAt, todayStart),
          ),
        ),

      app.db
        .select({ c: count() })
        .from(schema.jobs)
        .where(and(eq(schema.jobs.status, 'FAILED'), gte(schema.jobs.createdAt, h24ago))),

      app.db
        .select({
          day: sql<string>`DATE(${schema.jobs.createdAt})`,
          c: count(),
        })
        .from(schema.jobs)
        .where(gte(schema.jobs.createdAt, dNago))
        .groupBy(sql`DATE(${schema.jobs.createdAt})`)
        .orderBy(sql`DATE(${schema.jobs.createdAt})`),

      app.db
        .select({
          id: schema.jobs.id,
          errorCode: schema.jobs.errorCode,
          createdAt: schema.jobs.createdAt,
          userEmail: schema.users.email,
        })
        .from(schema.jobs)
        .leftJoin(schema.users, eq(schema.users.id, schema.jobs.userId))
        .where(and(eq(schema.jobs.status, 'FAILED'), gte(schema.jobs.createdAt, h24ago)))
        .orderBy(sql`${schema.jobs.createdAt} DESC`)
        .limit(5),

      app.db
        .select({
          id: schema.jobs.id,
          createdAt: schema.jobs.createdAt,
          userEmail: schema.users.email,
        })
        .from(schema.jobs)
        .leftJoin(schema.users, eq(schema.users.id, schema.jobs.userId))
        .where(and(eq(schema.jobs.status, 'QUEUED'), lte(schema.jobs.createdAt, stuckThreshold)))
        .orderBy(schema.jobs.createdAt)
        .limit(5),

      app.db
        .select({ c: count() })
        .from(schema.users)
        .where(gte(schema.users.createdAt, todayStart)),

      app.db
        .select({ c: count() })
        .from(schema.contactRequests)
        .where(eq(schema.contactRequests.status, 'new')),
    ]);

    // Workers from Redis
    const workers: { id: string; status: string; healthy: boolean; lastSeen?: string }[] = [];
    for (const [id, v] of Object.entries(workersRaw)) {
      try {
        const info = JSON.parse(v);
        const healthKey = await app.redis.get(`worker:health:${id}`);
        workers.push({
          id,
          status: info.status ?? 'UNKNOWN',
          healthy: !!healthKey,
          lastSeen: info.lastSeen,
        });
      } catch {
        /* skip malformed */
      }
    }

    const delta = (today: number, yesterday: number) =>
      yesterday > 0 ? Math.round(((today - yesterday) / yesterday) * 100 * 10) / 10 : null;

    const jobsToday = jobsTodayRows[0]?.c ?? 0;
    const jobsYesterday = jobsYesterdayRows[0]?.c ?? 0;
    const activeUsersToday = activeUsersTodayRows[0]?.c ?? 0;
    const activeUsersYesterday = activeUsersYesterdayRows[0]?.c ?? 0;
    const creditsToday = Number(creditsTodayRows[0]?.c ?? 0);
    const creditsYesterday = Number(creditsYesterdayRows[0]?.c ?? 0);

    // Build chart (fill missing days with 0)
    const dayMap = new Map(jobsPerDayRows.map((r) => [r.day, Number(r.c)]));
    const jobsPerDay: number[] = [];
    const jobsPerDayLabels: string[] = [];
    for (let i = validDays - 1; i >= 0; i--) {
      const d = new Date(todayStart.getTime() - i * 86400000);
      const key = d.toISOString().slice(0, 10);
      jobsPerDay.push(dayMap.get(key) ?? 0);
      jobsPerDayLabels.push(
        i === 0 ? 'Today' : d.toLocaleDateString('en', { month: 'short', day: 'numeric' }),
      );
    }

    const periodTotal = jobsPerDay.reduce((a, b) => a + b, 0);
    const failed24h = failed24hRows[0]?.c ?? 0;
    const newUsersToday = newUsersRows[0]?.c ?? 0;
    const newContacts = Number(newContactsRows[0]?.c ?? 0);

    return {
      jobsToday,
      jobsTodayDelta: delta(jobsToday, jobsYesterday),
      creditsToday,
      creditsTodayDelta: delta(creditsToday, creditsYesterday),
      activeUsersToday,
      activeUsersDelta: delta(activeUsersToday, activeUsersYesterday),
      workersHealthy: workers.filter((w) => w.healthy).length,
      workersTotal: workers.length,
      workers,
      queueDepth: queueDepthRow[0]?.c ?? 0,
      failed24h,
      jobsPerDay,
      jobsPerDayLabels,
      periodTotal,
      recentFailures: recentFailures.map((j) => ({
        id: j.id.slice(0, 12),
        user: j.userEmail ?? '—',
        error: j.errorCode ?? 'unknown',
        age: formatAge(j.createdAt),
      })),
      stuckJobs: stuckJobs.map((j) => ({
        id: j.id.slice(0, 12),
        user: j.userEmail ?? '—',
        age: formatAge(j.createdAt),
      })),
      newUsersToday,
      newContacts,
    };
  });
}

async function readAppVideoConfig(
  app: FastifyInstance,
  redisKey: string,
): Promise<{ key: string; updatedAt: string } | null> {
  const cur = JSON.parse((await app.redis.get(redisKey)) ?? '{}') as Record<string, unknown>;
  const appVideo = cur.appVideo as { key: string; updatedAt: string } | undefined;
  return appVideo ?? null;
}

// No manual cache-bust needed: presignGet() embeds a fresh X-Amz-Date/X-Amz-Signature
// on every call, so the URL changes on every re-fetch regardless of the fixed object
// key. Appending an extra query param here previously broke SigV4 validation (403
// SignatureDoesNotMatch) — the signature only covers the exact query string present
// when it was signed.
async function appVideoUrl(app: FastifyInstance, key: string): Promise<string> {
  const { url } = await app.storage.presignGet(key, 3600);
  return url;
}

function formatAge(d: Date | null): string {
  if (!d) return '?';
  const secs = Math.floor((Date.now() - new Date(d).getTime()) / 1000);
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  return `${Math.floor(secs / 3600)}h`;
}
