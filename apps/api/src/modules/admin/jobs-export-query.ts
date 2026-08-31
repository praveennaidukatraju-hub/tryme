import { schema } from '@tryme/db';
import { jobSourceSchema } from '@tryme/types';
import { and, count, desc, eq, gte, ilike, lte, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { jobTypeSql } from './job-type.js';

// Same filters as GET /admin/jobs (see JobsQuery there) so the export always
// matches whatever the admin currently has the Jobs table filtered to.
export const JobsExportQuery = z.object({
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
  createdFrom: z.string().optional(),
  createdTo: z.string().optional(),
});
export type JobsExportQuery = z.infer<typeof JobsExportQuery>;

function fmtFilterDate(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function describeJobsExportFilters(query: JobsExportQuery): string {
  const parts: string[] = [];
  if (query.search) parts.push(`Search: "${query.search}"`);
  if (query.status) parts.push(`Status: ${query.status}`);
  if (query.jobType) parts.push(`Type: ${query.jobType}`);
  if (query.workerId) parts.push(`Worker: ${query.workerId}`);
  if (query.date) parts.push(`Date: ${query.date}`);
  if (query.createdFrom || query.createdTo) {
    const from = query.createdFrom ? fmtFilterDate(query.createdFrom) : 'the start';
    const to = query.createdTo ? fmtFilterDate(query.createdTo) : 'now';
    parts.push(`Created ${from} – ${to}`);
  }
  return parts.length > 0 ? parts.join(' · ') : 'All jobs';
}

export interface JobExportRow {
  jobId: string;
  userName: string;
  userEmail: string | null;
  jobType: string;
  startedAt: Date | null;
  completedAt: Date | null;
  creditsUsed: number;
  creditsRemaining: number | null;
  status: string;
  errorCode: string | null;
}

// Safety valve, not a real-world limit — see the identical comment on the
// users export; same reasoning applies here.
const MAX_EXPORT_ROWS = 20_000;

interface LedgerSnapshotRow {
  jobId: string;
  runningBalance: number;
  jobNetDelta: number;
}

/**
 * For each job, "credits used" is the NET of that job's own ledger rows
 * (JOB_DISPATCH always exists; a refund row on failure/cancellation shares the
 * same job_id under a different `reason`, per the (job_id, reason) partial
 * unique index — refunds are always full, never partial, so a refunded job's
 * net is exactly 0) and "credits remaining" is the user's running balance
 * immediately after that job's last ledger event. The running balance can only
 * be computed correctly from each user's FULL ledger history (ordered by
 * time), not just the rows tied to these jobs — so this scans each affected
 * user's whole ledger, but only for the handful of users on this export, not
 * the whole table.
 */
async function loadCreditSnapshots(
  app: FastifyInstance,
  userIds: string[],
): Promise<Map<string, { creditsUsed: number; creditsRemaining: number }>> {
  const map = new Map<string, { creditsUsed: number; creditsRemaining: number }>();
  if (userIds.length === 0) return map;

  // A plain JS array bound through `= ANY(${userIds})` doesn't serialize as a
  // Postgres array literal with this drizzle/postgres-js combo (each element
  // gets sent as a single unbracketed parameter and array_in() rejects it) —
  // build an IN-list of individually-bound scalars instead.
  const idList = sql.join(
    userIds.map((id) => sql`${id}::uuid`),
    sql`, `,
  );
  const rows = (await app.db.execute(sql`
    SELECT DISTINCT ON (job_id)
      job_id AS "jobId",
      (SUM(delta) OVER (
        PARTITION BY user_id ORDER BY created_at, id
        ROWS BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW
      ))::int AS "runningBalance",
      (SUM(delta) OVER (PARTITION BY job_id))::int AS "jobNetDelta"
    FROM credit_ledger
    WHERE user_id IN (${idList}) AND job_id IS NOT NULL
    ORDER BY job_id, created_at DESC, id DESC
  `)) as unknown as LedgerSnapshotRow[];

  for (const row of rows) {
    map.set(row.jobId, { creditsUsed: -row.jobNetDelta, creditsRemaining: row.runningBalance });
  }
  return map;
}

export async function loadJobsForExport(
  app: FastifyInstance,
  { status, search, date, jobType, workerId, createdFrom, createdTo }: JobsExportQuery,
): Promise<JobExportRow[]> {
  const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
  const conditions = [
    status ? eq(schema.jobs.status, status) : undefined,
    date ? sql`${schema.jobs.createdAt}::date = ${date}::date` : undefined,
    jobType ? sql`${jobTypeSql()} = ${jobType}` : undefined,
    workerId ? eq(schema.jobs.workerId, workerId) : undefined,
    createdFrom
      ? gte(
          schema.jobs.createdAt,
          new Date(DATE_ONLY.test(createdFrom) ? `${createdFrom}T00:00:00.000Z` : createdFrom),
        )
      : undefined,
    createdTo
      ? lte(
          schema.jobs.createdAt,
          new Date(DATE_ONLY.test(createdTo) ? `${createdTo}T23:59:59.999Z` : createdTo),
        )
      : undefined,
    search
      ? or(
          ilike(sql`${schema.jobs.id}::text`, `%${search}%`),
          ilike(schema.users.email, `%${search}%`),
          ilike(schema.users.username, `%${search}%`),
        )
      : undefined,
  ];
  const where = and(...conditions);

  // jobType filtering (jobTypeSql) reads job_inputs, so the count query needs
  // the same join as the row query below — see the identical warning on
  // GET /admin/jobs.
  const [{ total }] = await app.db
    .select({ total: count() })
    .from(schema.jobs)
    .leftJoin(schema.users, eq(schema.users.id, schema.jobs.userId))
    .leftJoin(schema.jobInputs, eq(schema.jobInputs.jobId, schema.jobs.id))
    .where(where);

  if (total > MAX_EXPORT_ROWS) {
    throw new AppError(
      'EXPORT_TOO_LARGE',
      400,
      `${total.toLocaleString('en-IN')} jobs match these filters — narrow the search or date range to ${MAX_EXPORT_ROWS.toLocaleString('en-IN')} or fewer before exporting`,
    );
  }

  const rows = await app.db
    .select({
      jobId: schema.jobs.id,
      userId: schema.jobs.userId,
      displayName: schema.users.displayName,
      username: schema.users.username,
      email: schema.users.email,
      startedAt: schema.jobs.startedAt,
      completedAt: schema.jobs.completedAt,
      status: schema.jobs.status,
      errorCode: schema.jobs.errorCode,
      jobType: jobTypeSql(),
    })
    .from(schema.jobs)
    .leftJoin(schema.users, eq(schema.users.id, schema.jobs.userId))
    .leftJoin(schema.jobInputs, eq(schema.jobInputs.jobId, schema.jobs.id))
    .where(where)
    .orderBy(desc(schema.jobs.createdAt));

  const userIds = [...new Set(rows.map((r) => r.userId).filter((id): id is string => id != null))];
  const snapshots = await loadCreditSnapshots(app, userIds);

  return rows.map((r) => {
    const snapshot = snapshots.get(r.jobId);
    return {
      jobId: r.jobId,
      userName: r.displayName || r.username || r.email || 'User',
      userEmail: r.email,
      jobType: r.jobType,
      startedAt: r.startedAt,
      completedAt: r.completedAt,
      creditsUsed: snapshot?.creditsUsed ?? 0,
      creditsRemaining: snapshot?.creditsRemaining ?? null,
      status: r.status,
      errorCode: r.errorCode,
    };
  });
}
