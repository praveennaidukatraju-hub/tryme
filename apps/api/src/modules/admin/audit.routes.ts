import { schema } from '@tryme/db';
import { and, count, desc, eq, gte, ilike, inArray, lte } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requirePermission } from './guard.js';

// resourceId is stored as plain text (workers.id is text, users/workflow_templates
// ids are uuid) so there's no single FK to join generically — resolve a
// human-readable label per resourceType with one batched lookup query each,
// rather than a fragile cross-type SQL join.
const USER_SHAPED_RESOURCE_TYPES = new Set(['user', 'admin_user', 'user_credits']);

async function resolveResourceLabels(
  app: FastifyInstance,
  rows: Array<{ resourceType: string; resourceId: string | null }>,
): Promise<Map<string, string>> {
  const labels = new Map<string, string>();

  const userIds = rows
    .filter((r) => USER_SHAPED_RESOURCE_TYPES.has(r.resourceType) && r.resourceId)
    .map((r) => r.resourceId as string);
  const workerIds = rows
    .filter((r) => r.resourceType === 'worker' && r.resourceId)
    .map((r) => r.resourceId as string);
  const workflowIds = rows
    .filter((r) => r.resourceType === 'workflow' && r.resourceId)
    .map((r) => r.resourceId as string);

  if (userIds.length > 0) {
    const users = await app.db
      .select({ id: schema.users.id, email: schema.users.email, username: schema.users.username })
      .from(schema.users)
      .where(inArray(schema.users.id, userIds));
    for (const u of users) labels.set(u.id, u.email ?? u.username ?? u.id);
  }
  if (workerIds.length > 0) {
    const workers = await app.db
      .select({ id: schema.workers.id, label: schema.workers.label })
      .from(schema.workers)
      .where(inArray(schema.workers.id, workerIds));
    for (const w of workers) labels.set(w.id, w.label || w.id);
  }
  if (workflowIds.length > 0) {
    const workflows = await app.db
      .select({ id: schema.workflowTemplates.id, label: schema.workflowTemplates.label })
      .from(schema.workflowTemplates)
      .where(inArray(schema.workflowTemplates.id, workflowIds));
    for (const wf of workflows) labels.set(wf.id, wf.label || wf.id);
  }

  return labels;
}

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

const AuditLogsQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(20),
  actorUserId: z.string().uuid().optional(),
  action: z.string().optional(),
  resourceType: z.string().optional(),
  resourceId: z.string().optional(),
  startDate: z.string().datetime({ offset: true }).or(z.string().date()).optional(),
  endDate: z.string().datetime({ offset: true }).or(z.string().date()).optional(),
});

export async function adminAuditRoutes(app: FastifyInstance) {
  const GUARD = requirePermission('audit.read');

  app.get(
    '/admin/audit-logs',
    {
      preHandler: GUARD,
      schema: { querystring: AuditLogsQuery },
    },
    async (req) => {
      const query = req.query as z.infer<typeof AuditLogsQuery>;
      const { page, pageSize, actorUserId, action, resourceType, resourceId, startDate, endDate } =
        query;

      const conditions = [];

      if (actorUserId) conditions.push(eq(schema.auditLogs.actorUserId, actorUserId));
      if (action) conditions.push(ilike(schema.auditLogs.action, `%${action}%`));
      if (resourceType) conditions.push(eq(schema.auditLogs.resourceType, resourceType));
      if (resourceId) conditions.push(eq(schema.auditLogs.resourceId, resourceId));
      if (startDate) {
        const fromInclusive = new Date(
          DATE_ONLY.test(startDate) ? `${startDate}T00:00:00.000Z` : startDate,
        );
        conditions.push(gte(schema.auditLogs.createdAt, fromInclusive));
      }
      if (endDate) {
        const toInclusive = new Date(
          DATE_ONLY.test(endDate) ? `${endDate}T23:59:59.999Z` : endDate,
        );
        conditions.push(lte(schema.auditLogs.createdAt, toInclusive));
      }

      const where = conditions.length > 0 ? and(...conditions) : undefined;

      const [{ total }] = await app.db
        .select({ total: count() })
        .from(schema.auditLogs)
        .where(where);

      const rows = await app.db
        .select({
          id: schema.auditLogs.id,
          actorUserId: schema.auditLogs.actorUserId,
          actorRole: schema.auditLogs.actorRole,
          actorEmail: schema.users.email,
          actorDisplayName: schema.users.displayName,
          action: schema.auditLogs.action,
          resourceType: schema.auditLogs.resourceType,
          resourceId: schema.auditLogs.resourceId,
          before: schema.auditLogs.before,
          after: schema.auditLogs.after,
          ipAddress: schema.auditLogs.ipAddress,
          userAgent: schema.auditLogs.userAgent,
          requestId: schema.auditLogs.requestId,
          createdAt: schema.auditLogs.createdAt,
        })
        .from(schema.auditLogs)
        .leftJoin(schema.users, eq(schema.auditLogs.actorUserId, schema.users.id))
        .where(where)
        .orderBy(desc(schema.auditLogs.createdAt))
        .limit(pageSize)
        .offset((page - 1) * pageSize);

      const resourceLabels = await resolveResourceLabels(app, rows);
      const items = rows.map((row) => ({
        ...row,
        resourceLabel: row.resourceId ? (resourceLabels.get(row.resourceId) ?? null) : null,
      }));

      return {
        page,
        pageSize,
        total: Number(total),
        items,
      };
    },
  );
}
