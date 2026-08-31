import { and, eq, schema } from '@tryme/db';
import { lt } from 'drizzle-orm';
import type { ChatbotDeps } from '../server.js';
import { emailFallback } from './escalation.js';
import { appendMessage, transition } from './service.js';

const AGENT_OFFLINE_GRACE_MS = 60_000;

export async function runChatSweeper(deps: ChatbotDeps): Promise<void> {
  const idleCutoff = new Date(Date.now() - deps.env.CHATBOT_IDLE_TIMEOUT_MIN * 60_000);

  const idleBot = await deps.db
    .select({ id: schema.chatbotConversations.id })
    .from(schema.chatbotConversations)
    .where(
      and(
        eq(schema.chatbotConversations.status, 'BOT'),
        lt(schema.chatbotConversations.lastMessageAt, idleCutoff),
      ),
    );
  for (const { id } of idleBot) {
    await appendMessage(deps.db, deps.pub, id, {
      role: 'system',
      content: 'This conversation was closed due to inactivity.',
    });
    await transition(deps.db, deps.pub, id, {
      from: 'BOT',
      to: 'CLOSED',
      type: 'close',
      reason: 'idle',
    });
  }

  const stalePending = await deps.db
    .select({
      id: schema.chatbotConversations.id,
      userId: schema.chatbotConversations.userId,
    })
    .from(schema.chatbotConversations)
    .where(
      and(
        eq(schema.chatbotConversations.status, 'PENDING_HUMAN'),
        lt(schema.chatbotConversations.lastMessageAt, idleCutoff),
      ),
    );
  for (const conv of stalePending) {
    await emailFallback(deps, conv.id, conv.userId, 'pending_timeout');
  }

  await deps.redis.zremrangebyscore(
    'chatbot:agent:presence',
    '-inf',
    Date.now() - AGENT_OFFLINE_GRACE_MS,
  );

  const humanConvs = await deps.db
    .select({
      id: schema.chatbotConversations.id,
      agentId: schema.chatbotConversations.assignedAgentId,
    })
    .from(schema.chatbotConversations)
    .where(eq(schema.chatbotConversations.status, 'HUMAN'));
  for (const conv of humanConvs) {
    if (!conv.agentId) continue;
    const score = await deps.redis.zscore('chatbot:agent:presence', conv.agentId);
    if (score && Number(score) > Date.now() - AGENT_OFFLINE_GRACE_MS) continue;
    await deps.redis.del(`chatbot:conv:${conv.id}:lock`);
    await deps.db
      .update(schema.chatbotConversations)
      .set({ assignedAgentId: null })
      .where(eq(schema.chatbotConversations.id, conv.id));
    await appendMessage(deps.db, deps.pub, conv.id, {
      role: 'system',
      content: 'Your agent got disconnected — reconnecting you…',
    });
    await transition(deps.db, deps.pub, conv.id, {
      from: 'HUMAN',
      to: 'PENDING_HUMAN',
      type: 'escalate',
      reason: 'agent_drop',
    });
    await deps.pub.publish('chatbot:queue', JSON.stringify({ type: 'queue_update' }));
  }
}
