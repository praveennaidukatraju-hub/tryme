import { and, eq, schema } from '@tryme/db';
import { chatbotActiveSockets } from '@tryme/observability';
import { WsAgentFrame, WsClientFrame } from '@tryme/types';
import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import type { Orchestrator } from '../conversation/orchestrator.js';
import { appendMessage, getOrCreateActiveConversation } from '../conversation/service.js';
import type { Principal } from '../routes/conversations.js';
import { redeemTicket } from './tickets.js';

interface SocketCtx {
  principal: Principal;
  convIds: Set<string>;
}

export function setupGateway(app: FastifyInstance, orchestrator: Orchestrator) {
  const { deps } = app;
  const subscribers = new Map<string, Set<WebSocket>>();
  const agentSockets = new Map<WebSocket, string>();

  // Redis fanout
  void deps.sub.psubscribe('chatbot:conv:*');
  void deps.sub.subscribe('chatbot:queue');
  deps.sub.on('pmessage', (_pat, channel, raw) => {
    const convId = channel.slice('chatbot:conv:'.length);
    const frame = JSON.parse(raw) as { type: string };
    if (frame.type === 'terminate') {
      orchestrator.terminate(convId);
      return;
    }
    for (const ws of subscribers.get(convId) ?? []) ws.send(raw);
  });
  deps.sub.on('message', (channel, raw) => {
    if (channel !== 'chatbot:queue') return;
    for (const ws of agentSockets.keys()) ws.send(raw);
  });

  function subscribe(convId: string, ws: WebSocket, ctx: SocketCtx) {
    if (!subscribers.has(convId)) subscribers.set(convId, new Set());
    subscribers.get(convId)?.add(ws);
    ctx.convIds.add(convId);
  }

  function cleanup(ws: WebSocket, ctx: SocketCtx) {
    for (const id of ctx.convIds) subscribers.get(id)?.delete(ws);
    const agentId = agentSockets.get(ws);
    if (agentId) {
      agentSockets.delete(ws);
      void deps.redis.zrem('chatbot:agent:presence', agentId);
    }
  }

  const beat = setInterval(() => {
    for (const [ws, agentId] of agentSockets) {
      ws.ping();
      void deps.redis.zadd('chatbot:agent:presence', Date.now(), agentId);
    }
  }, 15_000);
  app.addHook('onClose', async () => clearInterval(beat));

  app.get('/ws', { websocket: true }, async (socket, req) => {
    const { ticket } = req.query as { ticket?: string };
    let principal: Principal;
    try {
      principal = await redeemTicket(app, ticket ?? '');
    } catch {
      socket.close(4401, 'unauthorized');
      return;
    }
    const ctx: SocketCtx = { principal, convIds: new Set() };
    const kind = principal.role === 'agent' ? 'agent' : 'user';
    chatbotActiveSockets.inc({ kind });
    socket.on('close', () => {
      cleanup(socket, ctx);
      chatbotActiveSockets.dec({ kind });
    });

    if (principal.role === 'user') {
      const conv = await getOrCreateActiveConversation(deps.db, principal.userId);
      subscribe(conv.id, socket, ctx);
      socket.send(JSON.stringify({ type: 'ready', conversationId: conv.id, status: conv.status }));
      socket.on('message', (buf) => {
        void (async () => {
          const parsed = WsClientFrame.safeParse(JSON.parse(buf.toString()));
          if (!parsed.success) {
            socket.send(
              JSON.stringify({ type: 'error', code: 'BAD_FRAME', message: 'invalid frame' }),
            );
            return;
          }
          const f = parsed.data;
          if (f.type === 'message') {
            const rlKey = `chatbot:rl:${principal.userId}`;
            const n = await deps.redis.incr(rlKey);
            if (n === 1) await deps.redis.expire(rlKey, 30);
            if (n > 10) {
              socket.send(
                JSON.stringify({ type: 'error', code: 'RATE_LIMITED', message: 'slow down' }),
              );
              return;
            }
            await orchestrator.handleUserMessage(conv.id, principal.userId, f.content);
          } else if (f.type === 'typing')
            await deps.pub.publish(
              `chatbot:conv:${conv.id}`,
              JSON.stringify({ type: 'typing', conversationId: conv.id, role: 'user' }),
            );
          else if (f.type === 'escalate')
            await orchestrator.handleUserEscalate(conv.id, principal.userId);
        })().catch((err) => app.log.error({ err }, 'user frame failed'));
      });
      return;
    }

    // agent socket — principal.role is 'agent' so adminUserId is set
    const adminUserId = principal.adminUserId as string;
    agentSockets.set(socket, adminUserId);
    await deps.redis.zadd('chatbot:agent:presence', Date.now(), adminUserId);
    socket.on('message', (buf) => {
      void (async () => {
        const parsed = WsAgentFrame.safeParse(JSON.parse(buf.toString()));
        if (!parsed.success) {
          socket.send(
            JSON.stringify({ type: 'error', code: 'BAD_FRAME', message: 'invalid frame' }),
          );
          return;
        }
        const f = parsed.data;
        if (f.type === 'join') {
          subscribe(f.conversationId, socket, ctx);
        } else if (f.type === 'leave') {
          subscribers.get(f.conversationId)?.delete(socket);
          ctx.convIds.delete(f.conversationId);
        } else if (f.type === 'message') {
          const [conv] = await deps.db
            .select()
            .from(schema.chatbotConversations)
            .where(
              and(
                eq(schema.chatbotConversations.id, f.conversationId),
                eq(schema.chatbotConversations.status, 'HUMAN'),
                eq(schema.chatbotConversations.assignedAgentId, adminUserId),
              ),
            );
          if (!conv) {
            socket.send(
              JSON.stringify({ type: 'error', code: 'FORBIDDEN', message: 'not assigned' }),
            );
            return;
          }
          await appendMessage(deps.db, deps.pub, f.conversationId, {
            role: 'agent',
            senderId: adminUserId,
            content: f.content,
          });
        } else if (f.type === 'typing') {
          await deps.pub.publish(
            `chatbot:conv:${f.conversationId}`,
            JSON.stringify({ type: 'typing', conversationId: f.conversationId, role: 'agent' }),
          );
        }
      })().catch((err) => app.log.error({ err }, 'agent frame failed'));
    });
  });
}
