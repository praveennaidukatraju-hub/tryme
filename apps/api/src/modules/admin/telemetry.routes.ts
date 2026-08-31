import { schema } from '@tryme/db';
import { count, gte, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { requirePermission } from './guard.js';

// Mirrors JOB_STREAMS in apps/dispatcher/src/worker/health-monitor.ts — the same
// four Redis Streams the dispatcher's queue_depth gauge reports via XLEN.
const JOB_STREAMS = ['jobs:priority', 'jobs:normal', 'jobs:low', 'jobs:video'] as const;

interface TelemetryRow {
  [key: string]: unknown;
  job_type: string;
  sample_count: number;
  processing_p50_ms: number | null;
  processing_p95_ms: number | null;
  e2e_p50_ms: number | null;
  e2e_p95_ms: number | null;
  comfy_sample_count: number;
  comfy_p50_ms: number | null;
  comfy_p95_ms: number | null;
}

// One job. The three phase durations are returned together because they
// compose: a job waits in the queue, then runs, and the ComfyUI round-trip is
// the dominant span inside that run. E2E is the total the other two sit inside.
interface DistributionPoint {
  jobId: string;
  jobType: string;
  workerId: string | null;
  e2eMs: number;
  comfyMs: number | null;
  queueMs: number | null;
  attempts: number;
  errorCode: string | null;
  createdAt: string;
  isOutlier: boolean;
}

interface DistributionRow {
  [key: string]: unknown;
  bucket: string;
  job_type: string;
  n: number;
  q1: number;
  med: number;
  q3: number;
  upper_fence: number;
  whisker_low: number;
  whisker_high: number;
  points: DistributionPoint[];
}

// Tukey's rule: anything above Q3 + 1.5*IQR is an outlier. Only the upper fence
// matters here — a suspiciously *fast* job isn't a debugging target.
const IQR_FENCE_MULTIPLIER = 1.5;

// Every job in the window is returned as its own point while the total fits in
// this budget. Past it, non-outliers are sampled per bucket — but outliers are
// ALWAYS returned in full, since they're the reason to open this panel. Box
// statistics are computed over every row either way and never sampled.
const POINT_BUDGET = 1500;

// Floor on the per-bucket sample so a very wide window still shows the shape of
// each bucket rather than one lonely dot.
const MIN_POINTS_PER_BUCKET = 8;

// Zooming in narrows the span, which refines the buckets AND cuts the job count
// — so a deep enough zoom drops below POINT_BUDGET and stops sampling entirely.
// That's the point of re-querying on zoom rather than magnifying pixels.
const TARGET_BUCKETS = 60;

// Human-readable bucket widths. Picking the nearest of these to span/60 keeps
// bucket boundaries on round clock values at every zoom level.
const BUCKET_STEPS_SECONDS = [
  15, 30, 60, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 604800,
] as const;

const MIN_SPAN_MS = 5 * 60_000; // 5 minutes — below this the panel shows noise
const MAX_SPAN_MS = 90 * 86_400_000; // 90 days, matching the old day cap

function bucketSecondsForSpan(spanMs: number): number {
  const ideal = spanMs / 1000 / TARGET_BUCKETS;
  return (
    BUCKET_STEPS_SECONDS.find((s) => s >= ideal) ??
    BUCKET_STEPS_SECONDS[BUCKET_STEPS_SECONDS.length - 1]
  );
}

export async function adminTelemetryRoutes(app: FastifyInstance) {
  // Portable subset of the Grafana "Pipeline Overview" dashboard — everything
  // that's derivable from Postgres/Redis without a Grafana Cloud round-trip:
  // job-type duration breakdown, queue depth per stream (mirrors the
  // queue_depth gauge), and jobs-by-outcome/success-rate over the window.
  // HTTP-request-level panels (req rate, status codes, per-route p95) only
  // exist in Prometheus — the api doesn't persist per-request logs anywhere —
  // and are deliberately not reproduced here.
  // processing_* approximates the dispatcher's per-attempt wall time as
  // started_at (GENERATING transition) -> completed_at; it excludes
  // queue-wait/worker-selection time that the Prometheus histogram includes,
  // so the two won't match exactly.
  app.get('/admin/telemetry', { preHandler: requirePermission('telemetry.read') }, async (req) => {
    const query = req.query as { days?: string };
    const days = parseInt(query.days || '7', 10);
    const validDays = Number.isNaN(days) || days < 1 ? 7 : days > 90 ? 90 : days;
    const sinceDate = new Date(Date.now() - validDays * 86400000);
    const since = sinceDate.toISOString();

    const [rows, queueDepthByStream, outcomeRows] = await Promise.all([
      app.db.execute<TelemetryRow>(sql`
        SELECT
          COALESCE(source, 'unknown') AS job_type,
          count(*) FILTER (WHERE started_at IS NOT NULL AND completed_at IS NOT NULL)::int
            AS sample_count,
          percentile_cont(0.5) WITHIN GROUP (
            ORDER BY EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000
          ) FILTER (WHERE started_at IS NOT NULL AND completed_at IS NOT NULL) AS processing_p50_ms,
          percentile_cont(0.95) WITHIN GROUP (
            ORDER BY EXTRACT(EPOCH FROM (completed_at - started_at)) * 1000
          ) FILTER (WHERE started_at IS NOT NULL AND completed_at IS NOT NULL) AS processing_p95_ms,
          percentile_cont(0.5) WITHIN GROUP (
            ORDER BY EXTRACT(EPOCH FROM (completed_at - created_at)) * 1000
          ) FILTER (WHERE completed_at IS NOT NULL) AS e2e_p50_ms,
          percentile_cont(0.95) WITHIN GROUP (
            ORDER BY EXTRACT(EPOCH FROM (completed_at - created_at)) * 1000
          ) FILTER (WHERE completed_at IS NOT NULL) AS e2e_p95_ms,
          count(*) FILTER (WHERE comfy_duration_ms IS NOT NULL)::int AS comfy_sample_count,
          percentile_cont(0.5) WITHIN GROUP (ORDER BY comfy_duration_ms)
            FILTER (WHERE comfy_duration_ms IS NOT NULL) AS comfy_p50_ms,
          percentile_cont(0.95) WITHIN GROUP (ORDER BY comfy_duration_ms)
            FILTER (WHERE comfy_duration_ms IS NOT NULL) AS comfy_p95_ms
        FROM jobs
        WHERE created_at >= ${since}
        GROUP BY source
        ORDER BY sample_count DESC
      `),
      Promise.all(
        JOB_STREAMS.map(async (stream) => ({ stream, depth: await app.redis.xlen(stream) })),
      ),
      app.db
        .select({ status: schema.jobs.status, c: count() })
        .from(schema.jobs)
        .where(gte(schema.jobs.createdAt, sinceDate))
        .groupBy(schema.jobs.status),
    ]);

    const completed = outcomeRows.find((r) => r.status === 'COMPLETED')?.c ?? 0;
    const failed = outcomeRows.find((r) => r.status === 'FAILED')?.c ?? 0;
    const terminal = completed + failed;

    return {
      days: validDays,
      jobTypes: rows.map((r) => ({
        jobType: r.job_type,
        sampleCount: r.sample_count,
        processingP50Ms: r.processing_p50_ms === null ? null : Math.round(r.processing_p50_ms),
        processingP95Ms: r.processing_p95_ms === null ? null : Math.round(r.processing_p95_ms),
        e2eP50Ms: r.e2e_p50_ms === null ? null : Math.round(r.e2e_p50_ms),
        e2eP95Ms: r.e2e_p95_ms === null ? null : Math.round(r.e2e_p95_ms),
        comfySampleCount: r.comfy_sample_count,
        comfyP50Ms: r.comfy_p50_ms === null ? null : Math.round(r.comfy_p50_ms),
        comfyP95Ms: r.comfy_p95_ms === null ? null : Math.round(r.comfy_p95_ms),
      })),
      queueDepthByStream,
      outcomes: outcomeRows.map((r) => ({ status: r.status, count: r.c })),
      successRate: terminal > 0 ? completed / terminal : null,
    };
  });

  // Per-bucket duration distribution for the box-plot panel. The aggregate
  // route above answers "is the pipeline slow"; this one answers "which
  // specific jobs blew up, and on which worker".
  //
  // Returns every job as its own point, plus the box statistics for its bucket.
  //
  // The naive alternative — ORDER BY created_at DESC LIMIT n — is what this
  // deliberately avoids: at 12 production workers a 7-day window can hold tens
  // of thousands of jobs, so a capped raw list silently shows the most recent
  // few minutes on a panel labelled "last N days". Here the cap instead
  // *samples* across the whole window, keeps every outlier regardless, and
  // reports `sampled`/`totalJobs` so the UI never implies the dots are the
  // whole population. Box statistics are always computed over every row.
  app.get(
    '/admin/telemetry/distribution',
    { preHandler: requirePermission('telemetry.read') },
    async (req) => {
      const query = req.query as { days?: string; from?: string; to?: string };

      // `from`/`to` drive the zoomable view; `days` remains the entry point for
      // the initial load and is just a shorthand for a window ending now.
      const days = parseInt(query.days || '7', 10);
      const validDays = Number.isNaN(days) || days < 1 ? 7 : days > 90 ? 90 : days;

      const rawTo = Number(query.to);
      const rawFrom = Number(query.from);
      const hasRange = Number.isFinite(rawFrom) && Number.isFinite(rawTo) && rawTo > rawFrom;

      const toMs = hasRange ? Math.min(rawTo, Date.now()) : Date.now();
      const fromMs = hasRange
        ? Math.min(
            Math.max(rawFrom, toMs - MAX_SPAN_MS),
            // Guarantee a usable span even if the client sends a degenerate one.
            toMs - MIN_SPAN_MS,
          )
        : toMs - validDays * 86_400_000;

      const since = new Date(fromMs).toISOString();
      const until = new Date(toMs).toISOString();
      const bucketSeconds = bucketSecondsForSpan(toMs - fromMs);

      // Box statistics and the outlier fence are computed on E2E: it's the
      // total the other two phases sit inside, so "slow job" means slow E2E.
      // Shared by the sizing probe and the main query — one definition so the
      // two can't drift on which rows they consider.
      const valsCte = sql`
        vals AS (
          SELECT
            id,
            COALESCE(source, 'unknown') AS job_type,
            worker_id,
            attempts,
            error_code,
            created_at,
            to_timestamp(
              floor(EXTRACT(EPOCH FROM created_at) / ${bucketSeconds}) * ${bucketSeconds}
            ) AS bucket,
            EXTRACT(EPOCH FROM (completed_at - created_at)) * 1000 AS e2e_ms,
            comfy_duration_ms AS comfy_ms,
            EXTRACT(EPOCH FROM (started_at - created_at)) * 1000 AS queue_ms
          FROM jobs
          WHERE created_at >= ${since} AND created_at < ${until} AND completed_at IS NOT NULL
        )
      `;

      // Decide the per-bucket sample cap before the main query: with the group
      // count in hand the budget can be split evenly instead of guessed at.
      const [size] = await app.db.execute<{ total: number; groups: number }>(sql`
        WITH ${valsCte}
        SELECT
          count(*)::int AS total,
          count(DISTINCT (bucket, job_type))::int AS groups
        FROM vals
      `);

      const total = size?.total ?? 0;
      const groups = size?.groups ?? 0;
      const sampled = total > POINT_BUDGET;
      // No cap at all when everything fits — the common case, where every job
      // really is on the chart.
      const perBucketCap = !sampled
        ? Number.MAX_SAFE_INTEGER
        : Math.max(MIN_POINTS_PER_BUCKET, Math.floor(POINT_BUDGET / Math.max(groups, 1)));

      const rows = await app.db.execute<DistributionRow>(sql`
        WITH ${valsCte},
        stats AS (
          SELECT
            bucket,
            job_type,
            count(*)::int AS n,
            percentile_cont(0.25) WITHIN GROUP (ORDER BY e2e_ms) AS q1,
            percentile_cont(0.5) WITHIN GROUP (ORDER BY e2e_ms) AS med,
            percentile_cont(0.75) WITHIN GROUP (ORDER BY e2e_ms) AS q3
          FROM vals
          GROUP BY bucket, job_type
        ),
        fenced AS (
          SELECT *, q3 + ${IQR_FENCE_MULTIPLIER} * (q3 - q1) AS upper_fence FROM stats
        ),
        ranked AS (
          SELECT
            v.*,
            f.upper_fence,
            v.e2e_ms > f.upper_fence AS is_outlier,
            row_number() OVER (PARTITION BY v.bucket, v.job_type ORDER BY random()) AS rn
          FROM vals v
          JOIN fenced f ON v.bucket = f.bucket AND v.job_type = f.job_type
        )
        SELECT
          f.bucket,
          f.job_type,
          f.n,
          f.q1,
          f.med,
          f.q3,
          f.upper_fence,
          min(v.e2e_ms) AS whisker_low,
          max(v.e2e_ms) FILTER (WHERE v.e2e_ms <= f.upper_fence) AS whisker_high,
          COALESCE((
            SELECT json_agg(p)
            FROM (
              SELECT
                r.id AS "jobId",
                r.job_type AS "jobType",
                r.worker_id AS "workerId",
                round(r.e2e_ms)::int AS "e2eMs",
                r.comfy_ms AS "comfyMs",
                round(r.queue_ms)::int AS "queueMs",
                r.attempts,
                r.error_code AS "errorCode",
                r.created_at AS "createdAt",
                r.is_outlier AS "isOutlier"
              FROM ranked r
              WHERE r.bucket = f.bucket
                AND r.job_type = f.job_type
                -- Outliers bypass the sample entirely; they are the payload
                -- that matters and are rare when the system is healthy.
                AND (r.is_outlier OR r.rn <= ${perBucketCap})
              ORDER BY r.e2e_ms DESC
            ) p
          ), '[]'::json) AS points
        FROM fenced f
        JOIN vals v ON v.bucket = f.bucket AND v.job_type = f.job_type
        GROUP BY f.bucket, f.job_type, f.n, f.q1, f.med, f.q3, f.upper_fence
        ORDER BY f.bucket ASC
      `);

      const buckets = rows.map((r) => ({
        bucketMs: new Date(r.bucket).getTime(),
        jobType: r.job_type,
        count: r.n,
        q1: Math.round(r.q1),
        median: Math.round(r.med),
        q3: Math.round(r.q3),
        whiskerLow: Math.round(r.whisker_low),
        whiskerHigh: Math.round(r.whisker_high),
        points: r.points,
      }));

      return {
        days: validDays,
        // Echoed back so the client can reconcile its view with what the server
        // actually clamped the range to, rather than assuming its request stood.
        fromMs,
        toMs,
        bucketSeconds,
        totalJobs: total,
        // Lets the UI say "showing N of M" rather than implying the dots are
        // the whole population when they aren't.
        shownJobs: buckets.reduce((sum, b) => sum + b.points.length, 0),
        sampled,
        buckets,
      };
    },
  );
}
