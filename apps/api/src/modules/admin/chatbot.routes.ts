import { schema } from '@tryme/db';
import { QnaUpsert } from '@tryme/types';
import { and, desc, eq, ilike, or, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AppError } from '../../lib/errors.js';
import { requirePermission } from './guard.js';

const LIVE = requirePermission('chatbot.read');

async function adminRowId(userId: string, app: FastifyInstance) {
  const [a] = await app.db
    .select({ id: schema.adminUsers.id })
    .from(schema.adminUsers)
    .where(eq(schema.adminUsers.userId, userId));
  if (!a) throw new AppError('FORBIDDEN', 403, 'admin required');
  return a.id;
}

async function publishConv(convId: string, frame: object, app: FastifyInstance) {
  await app.redis.publish(`chatbot:conv:${convId}`, JSON.stringify(frame));
}
async function publishQueue(app: FastifyInstance) {
  await app.redis.publish('chatbot:queue', JSON.stringify({ type: 'queue_update' }));
}

async function systemMessage(convId: string, content: string, app: FastifyInstance) {
  const [row] = await app.db
    .insert(schema.chatbotMessages)
    .values({ conversationId: convId, role: 'system', content })
    .returning();
  await publishConv(
    convId,
    {
      type: 'message',
      message: {
        id: row.id,
        conversationId: convId,
        role: 'system',
        senderId: null,
        content,
        createdAt: row.createdAt.toISOString(),
      },
    },
    app,
  );
}

export async function adminChatbotRoutes(app: FastifyInstance) {
  const QNA = requirePermission('chatbot.manage');

  app.get('/admin/chatbot/qna', { preHandler: QNA }, async (req) => {
    const { active = 'all', q = '' } = req.query as Record<string, string>;
    const conds = [];
    if (active === 'true') conds.push(eq(schema.chatbotQna.isActive, true));
    if (active === 'false') conds.push(eq(schema.chatbotQna.isActive, false));
    if (q)
      conds.push(
        or(ilike(schema.chatbotQna.question, `%${q}%`), ilike(schema.chatbotQna.answer, `%${q}%`)),
      );
    const where = conds.length ? and(...conds) : undefined;
    const [rows, [countRow]] = await Promise.all([
      app.db
        .select()
        .from(schema.chatbotQna)
        .where(where)
        .orderBy(desc(schema.chatbotQna.updatedAt))
        .limit(500),
      app.db.select({ total: sql<number>`count(*)::int` }).from(schema.chatbotQna).where(where),
    ]);
    return { rows, total: countRow?.total ?? 0 };
  });

  app.post('/admin/chatbot/qna', { preHandler: QNA, schema: { body: QnaUpsert } }, async (req) => {
    const body = req.body as z.infer<typeof QnaUpsert>;
    const [row] = await app.db.insert(schema.chatbotQna).values(body).returning();
    return row;
  });

  app.patch(
    '/admin/chatbot/qna/:id',
    {
      preHandler: QNA,
      schema: { params: z.object({ id: z.string().uuid() }), body: QnaUpsert.partial() },
    },
    async (req) => {
      const { id } = req.params as { id: string };
      const [row] = await app.db
        .update(schema.chatbotQna)
        .set({ ...(req.body as object), updatedAt: new Date() })
        .where(eq(schema.chatbotQna.id, id))
        .returning();
      if (!row) throw new AppError('NOT_FOUND', 404, 'qna not found');
      return row;
    },
  );

  app.delete(
    '/admin/chatbot/qna/:id',
    { preHandler: QNA, schema: { params: z.object({ id: z.string().uuid() }) } },
    async (req) => {
      const { id } = req.params as { id: string };
      const [row] = await app.db
        .delete(schema.chatbotQna)
        .where(eq(schema.chatbotQna.id, id))
        .returning();
      if (!row) throw new AppError('NOT_FOUND', 404, 'qna not found');
      return { ok: true };
    },
  );

  app.post('/admin/chatbot/ingest', { preHandler: QNA }, async () => {
    if (!app.env.CHATBOT_URL || !app.env.CHATBOT_SERVICE_TOKEN)
      throw new AppError('CHATBOT_UNCONFIGURED', 503, 'chatbot service not configured');
    const res = await fetch(`${app.env.CHATBOT_URL}/ingest`, {
      method: 'POST',
      headers: { 'x-service-token': app.env.CHATBOT_SERVICE_TOKEN },
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new AppError('INGEST_FAILED', res.status === 409 ? 409 : 502, text.slice(0, 300));
    }
    return res.json();
  });

  app.get('/admin/chatbot/status', { preHandler: QNA }, async () => {
    const [activeRow] = await app.db
      .select({ n: sql<number>`count(*)::int` })
      .from(schema.chatbotQna)
      .where(eq(schema.chatbotQna.isActive, true));
    let embedded = 0;
    if (app.env.CHATBOT_URL) {
      try {
        const res = await fetch(`${app.env.CHATBOT_URL}/health`, {
          signal: AbortSignal.timeout(5_000),
        });
        if (res.ok) embedded = ((await res.json()) as { embedded: number }).embedded;
      } catch {
        /* chatbot down — show 0 */
      }
    }
    return { activeQna: activeRow?.n ?? 0, embedded };
  });

  app.get('/admin/chatbot/conversations', { preHandler: LIVE }, async (req) => {
    const { status = 'all', limit = '50', offset = '0' } = req.query as Record<string, string>;
    const lim = Math.min(Number(limit) || 50, 200);
    const off = Number(offset) || 0;
    const where = status !== 'all' ? eq(schema.chatbotConversations.status, status) : undefined;
    const [rows, [countRow]] = await Promise.all([
      app.db
        .select({
          conv: schema.chatbotConversations,
          userEmail: schema.users.email,
        })
        .from(schema.chatbotConversations)
        .innerJoin(schema.users, eq(schema.users.id, schema.chatbotConversations.userId))
        .where(where)
        .orderBy(desc(schema.chatbotConversations.lastMessageAt))
        .limit(lim)
        .offset(off),
      app.db
        .select({ total: sql<number>`count(*)::int` })
        .from(schema.chatbotConversations)
        .where(where),
    ]);
    return {
      rows: rows.map((r) => ({ ...r.conv, userEmail: r.userEmail })),
      total: countRow?.total ?? 0,
    };
  });

  async function assign(
    convId: string,
    fromStatus: string,
    type: 'claim' | 'takeover',
    userId: string,
  ) {
    const agentId = await adminRowId(userId, app);
    const got = await app.redis.set(`chatbot:conv:${convId}:lock`, agentId, 'NX');
    if (!got) throw new AppError('ALREADY_CLAIMED', 409, 'conversation already claimed');
    const [row] = await app.db
      .update(schema.chatbotConversations)
      .set({
        status: 'HUMAN',
        assignedAgentId: agentId,
        ...(type === 'takeover' ? { escalationReason: 'agent_join' } : {}),
      })
      .where(
        and(
          eq(schema.chatbotConversations.id, convId),
          eq(schema.chatbotConversations.status, fromStatus),
        ),
      )
      .returning();
    if (!row) {
      await app.redis.del(`chatbot:conv:${convId}:lock`);
      throw new AppError('BAD_STATE', 409, `conversation is not ${fromStatus}`);
    }
    await app.db.insert(schema.chatbotEvents).values({
      conversationId: convId,
      type,
      actorId: agentId,
      fromStatus,
      toStatus: 'HUMAN',
      reason: type === 'takeover' ? 'agent_join' : null,
    });
    await publishConv(convId, { type: 'terminate' }, app);
    await publishConv(
      convId,
      {
        type: 'state_change',
        conversationId: convId,
        status: 'HUMAN',
        reason: type === 'takeover' ? 'agent_join' : null,
      },
      app,
    );
    await systemMessage(convId, 'A support agent has joined the conversation.', app);
    await publishQueue(app);
    return row;
  }

  app.post(
    '/admin/chatbot/conversations/:id/claim',
    { preHandler: LIVE, schema: { params: z.object({ id: z.string().uuid() }) } },
    async (req) => assign((req.params as { id: string }).id, 'PENDING_HUMAN', 'claim', req.userId),
  );

  app.post(
    '/admin/chatbot/conversations/:id/takeover',
    { preHandler: LIVE, schema: { params: z.object({ id: z.string().uuid() }) } },
    async (req) => assign((req.params as { id: string }).id, 'BOT', 'takeover', req.userId),
  );

  app.post(
    '/admin/chatbot/conversations/:id/end',
    { preHandler: LIVE, schema: { params: z.object({ id: z.string().uuid() }) } },
    async (req) => {
      const { id } = req.params as { id: string };
      const agentId = await adminRowId(req.userId, app);
      const [row] = await app.db
        .update(schema.chatbotConversations)
        .set({ status: 'CLOSED', closedAt: new Date() })
        .where(
          and(
            eq(schema.chatbotConversations.id, id),
            eq(schema.chatbotConversations.status, 'HUMAN'),
            eq(schema.chatbotConversations.assignedAgentId, agentId),
          ),
        )
        .returning();
      if (!row) throw new AppError('BAD_STATE', 409, 'not your active HUMAN conversation');
      await app.db.insert(schema.chatbotEvents).values({
        conversationId: id,
        type: 'close',
        actorId: agentId,
        fromStatus: 'HUMAN',
        toStatus: 'CLOSED',
      });
      await app.redis.del(`chatbot:conv:${id}:lock`);
      await systemMessage(id, 'The agent ended this conversation.', app);
      await publishConv(
        id,
        {
          type: 'state_change',
          conversationId: id,
          status: 'CLOSED',
          reason: null,
        },
        app,
      );
      return row;
    },
  );

  app.post(
    '/admin/chatbot/duty',
    { preHandler: LIVE, schema: { body: z.object({ on: z.boolean() }) } },
    async (req) => {
      const agentId = await adminRowId(req.userId, app);
      const { on } = req.body as { on: boolean };
      if (on) await app.redis.sadd('chatbot:agent:duty', agentId);
      else await app.redis.srem('chatbot:agent:duty', agentId);
      return { on };
    },
  );

  app.get('/admin/chatbot/duty', { preHandler: LIVE }, async (req) => {
    const agentId = await adminRowId(req.userId, app);
    const on = (await app.redis.sismember('chatbot:agent:duty', agentId)) === 1;
    return { on };
  });
}
