import { schema } from '@tryme/db';
import { and, asc, count, desc, eq, gte, ilike, isNotNull, lte, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';

// createdFrom/createdTo are plain YYYY-MM-DD dates from the admin's date
// pickers — see DATE_ONLY below for how "to" is made inclusive of the whole day.
export const UsersExportQuery = z.object({
  search: z.string().optional(),
  merchant: z.coerce.boolean().optional(),
  showBanned: z.coerce.boolean().optional(),
  createdFrom: z.string().optional(),
  createdTo: z.string().optional(),
  tier: z.string().optional(),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
});
export type UsersExportQuery = z.infer<typeof UsersExportQuery>;

export interface UserExportRow {
  displayName: string | null;
  username: string | null;
  email: string | null;
  phone: string | null;
  tier: string;
  planName: string | null;
  companyName: string | null;
  isMerchant: boolean;
  isBanned: boolean;
  createdAt: Date;
  balance: number;
  totalJobs: number;
  lastJobAt: Date | string | null;
}

// Safety valve, not a real-world limit — rendering a few thousand single-line
// rows (PDF or Excel) is cheap; this just stops a pathological unfiltered
// export on a huge table from blocking the event loop for a long time.
const MAX_EXPORT_ROWS = 20_000;
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

// Shared by both GET /admin/users/export.pdf and export.xlsx — same filters,
// same rows, only the rendering differs.
export async function loadUsersForExport(
  app: FastifyInstance,
  { search, merchant, showBanned, createdFrom, createdTo, tier, sortDir }: UsersExportQuery,
): Promise<UserExportRow[]> {
  const searchWhere = search
    ? or(
        ilike(schema.users.email, `%${search}%`),
        ilike(schema.users.displayName, `%${search}%`),
        ilike(schema.users.username, `%${search}%`),
      )
    : undefined;
  const bannedWhere = showBanned === true ? undefined : eq(schema.users.isBanned, false);
  // "to" must include the whole day, not just its midnight instant, or
  // same-day signups on the end date are silently dropped.
  const toInclusive = createdTo
    ? new Date(DATE_ONLY.test(createdTo) ? `${createdTo}T23:59:59.999Z` : createdTo)
    : undefined;
  const fromInclusive = createdFrom
    ? new Date(DATE_ONLY.test(createdFrom) ? `${createdFrom}T00:00:00.000Z` : createdFrom)
    : undefined;
  const where = and(
    searchWhere,
    bannedWhere,
    merchant === true ? isNotNull(schema.merchants.id) : undefined,
    fromInclusive ? gte(schema.users.createdAt, fromInclusive) : undefined,
    toInclusive ? lte(schema.users.createdAt, toInclusive) : undefined,
    tier ? eq(schema.users.tier, tier) : undefined,
  );

  const [{ total }] = await app.db
    .select({ total: count() })
    .from(schema.users)
    .leftJoin(schema.merchants, eq(schema.merchants.userId, schema.users.id))
    .where(where);

  if (total > MAX_EXPORT_ROWS) {
    throw new AppError(
      'EXPORT_TOO_LARGE',
      400,
      `${total.toLocaleString('en-IN')} users match these filters — narrow the search or date range to ${MAX_EXPORT_ROWS.toLocaleString('en-IN')} or fewer before exporting`,
    );
  }

  const rows = await app.db
    .select({
      displayName: schema.users.displayName,
      username: schema.users.username,
      email: schema.users.email,
      phone: schema.users.phone,
      tier: schema.users.tier,
      planName: schema.creditPlans.name,
      companyName: sql<
        string | null
      >`COALESCE(${schema.merchants.companyName}, ${schema.users.companyName})`,
      isMerchant: isNotNull(schema.merchants.id),
      isBanned: schema.users.isBanned,
      createdAt: schema.users.createdAt,
      balance: sql<number>`COALESCE(${schema.userCredits.balance}, 0)`,
      totalJobs: sql<number>`COUNT(${schema.jobs.id})::int`,
      lastJobAt: sql<Date | null>`MAX(${schema.jobs.createdAt})`,
    })
    .from(schema.users)
    .leftJoin(schema.merchants, eq(schema.merchants.userId, schema.users.id))
    .leftJoin(schema.userCredits, eq(schema.userCredits.userId, schema.users.id))
    .leftJoin(schema.jobs, eq(schema.jobs.userId, schema.users.id))
    .leftJoin(schema.creditPlans, eq(schema.creditPlans.slug, schema.users.tier))
    .where(where)
    .groupBy(
      schema.users.id,
      schema.userCredits.balance,
      schema.merchants.id,
      schema.creditPlans.name,
    )
    .orderBy(sortDir === 'asc' ? asc(schema.users.createdAt) : desc(schema.users.createdAt));

  return rows.map((r) => ({ ...r, isMerchant: Boolean(r.isMerchant) }));
}
