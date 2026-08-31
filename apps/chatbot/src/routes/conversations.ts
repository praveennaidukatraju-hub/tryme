import { eq, schema } from '@tryme/db';
import type { FastifyInstance } from 'fastify';
import { jwtVerify } from 'jose';
import { listMessages } from '../conversation/service.js';
import { AppError } from '../lib/errors.js';

export interface Principal {
  role: 'user' | 'agent';
  userId: string;
  adminUserId?: string;
}

export async function verifyBearer(
  app: FastifyInstance,
  authHeader: string | undefined,
): Promise<Principal> {
  const token = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : undefined;
  if (!token) throw new AppError('UNAUTH', 401, 'missing bearer');
  const secret = new TextEncoder().encode(app.deps.env.JWT_SECRET);
  let payload: Record<string, unknown>;
  try {
    payload = (await jwtVerify(token, secret, { algorithms: ['HS256'] })).payload as Record<
      string,
      unknown
    >;
  } catch {
    throw new AppError('UNAUTH', 401, 'invalid token');
  }
  const sub = String(payload.sub);
  const aud = payload.aud;
  const isAdminToken = aud === 'admin' || (Array.isArray(aud) && aud.includes('admin'));
  if (isAdminToken) {
    const [a] = await app.deps.db
      .select()
      .from(schema.adminUsers)
      .where(eq(schema.adminUsers.userId, sub));
    if (a?.status !== 'active') throw new AppError('FORBIDDEN', 403, 'not an active admin');
    return { role: 'agent', userId: sub, adminUserId: a.id };
  }
  if (payload.kind !== 'access') throw new AppError('UNAUTH', 401, 'invalid token');
  return { role: 'user', userId: sub };
}

export async function conversationRoutes(app: FastifyInstance) {
  app.get('/conversations/:id/messages', async (req) => {
    const principal = await verifyBearer(app, req.headers.authorization);
    const { id } = req.params as { id: string };
    const { limit, before } = req.query as { limit?: string; before?: string };
    const [conv] = await app.deps.db
      .select()
      .from(schema.chatbotConversations)
      .where(eq(schema.chatbotConversations.id, id));
    if (!conv) throw new AppError('NOT_FOUND', 404, 'conversation not found');
    if (principal.role === 'user' && conv.userId !== principal.userId)
      throw new AppError('FORBIDDEN', 403, 'not your conversation');
    const messages = await listMessages(app.deps.db, id, {
      limit: limit ? Number(limit) : undefined,
      before,
    });
    return { messages };
  });
}
