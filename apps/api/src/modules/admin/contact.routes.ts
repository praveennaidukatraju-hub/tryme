import { schema } from '@tryme/db';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { requirePermission } from './guard.js';

export async function adminContactRoutes(app: FastifyInstance) {
  const R = requirePermission('contact.read');
  const W = requirePermission('contact.write');

  // GET /admin/contact-requests?status=new|read|done|all&source=<value>|__null__|all&limit=50&offset=0
  app.get('/admin/contact-requests', { preHandler: R }, async (req) => {
    const {
      status = 'all',
      source = 'all',
      limit = '50',
      offset = '0',
    } = req.query as Record<string, string>;
    const lim = Math.min(Number(limit) || 50, 200);
    const off = Number(offset) || 0;

    const statusCond = status !== 'all' ? eq(schema.contactRequests.status, status) : undefined;
    const sourceCond =
      source === '__null__'
        ? isNull(schema.contactRequests.source)
        : source !== 'all'
          ? eq(schema.contactRequests.source, source)
          : undefined;

    const where =
      statusCond && sourceCond
        ? and(statusCond, sourceCond)
        : (statusCond ?? sourceCond ?? undefined);

    const [rawRows, [countRow]] = await Promise.all([
      app.db
        .select()
        .from(schema.contactRequests)
        .where(where)
        .orderBy(desc(schema.contactRequests.createdAt))
        .limit(lim)
        .offset(off),
      app.db
        .select({ total: sql<number>`count(*)::int` })
        .from(schema.contactRequests)
        .where(where),
    ]);

    const rows = await Promise.all(
      rawRows.map(async ({ attachmentKey, ...row }) => ({
        ...row,
        attachmentKey,
        attachmentUrl: attachmentKey
          ? (await app.storage.presignGet(attachmentKey, 3600)).url
          : null,
      })),
    );

    return { rows, total: countRow?.total ?? 0 };
  });

  // GET /admin/contact-requests/unread-count — for badge
  app.get('/admin/contact-requests/unread-count', { preHandler: R }, async () => {
    const [row] = await app.db
      .select({ count: sql<number>`count(*)::int` })
      .from(schema.contactRequests)
      .where(eq(schema.contactRequests.status, 'new'));
    return { count: row?.count ?? 0 };
  });

  // GET /admin/contact-requests/sources — distinct sources + new count per source
  app.get('/admin/contact-requests/sources', { preHandler: R }, async () => {
    const [distinctRows, countRows] = await Promise.all([
      app.db
        .selectDistinct({ source: schema.contactRequests.source })
        .from(schema.contactRequests)
        .orderBy(schema.contactRequests.source),
      app.db
        .select({
          source: schema.contactRequests.source,
          newCount: sql<number>`count(*) filter (where ${schema.contactRequests.status} = 'new')::int`,
          total: sql<number>`count(*)::int`,
        })
        .from(schema.contactRequests)
        .groupBy(schema.contactRequests.source),
    ]);

    const newBySource: Record<string, number> = {};
    const totalBySource: Record<string, number> = {};
    let totalNew = 0;
    for (const row of countRows) {
      const key = row.source === null ? '__null__' : row.source;
      newBySource[key] = row.newCount;
      totalBySource[key] = row.total;
      totalNew += row.newCount;
    }
    newBySource.__total__ = totalNew;

    return {
      sources: distinctRows.map((r) => r.source),
      newBySource,
      totalBySource,
    };
  });

  // PATCH /admin/contact-requests/:id — update status
  app.patch(
    '/admin/contact-requests/:id',
    {
      preHandler: W,
      schema: {
        params: z.object({ id: z.string().uuid() }),
        body: z.object({ status: z.enum(['new', 'read', 'done']) }),
      },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const { status } = req.body as { status: string };
      const [row] = await app.db
        .update(schema.contactRequests)
        .set({ status })
        .where(eq(schema.contactRequests.id, id))
        .returning();
      if (!row) throw new AppError('NOT_FOUND', 404, 'contact request not found');
      const { attachmentKey, ...rest } = row;
      return {
        ...rest,
        attachmentKey,
        attachmentUrl: attachmentKey
          ? (await app.storage.presignGet(attachmentKey, 3600)).url
          : null,
      };
    },
  );
}
