import { eq, schema } from '@tryme/db';
import { chatbotEscalationsTotal } from '@tryme/observability';
import type { Redis } from 'ioredis';
import type { ChatbotDeps } from '../server.js';
import { appendMessage, transition } from './service.js';

const PRESENCE_FRESH_MS = 30_000;

export async function listAvailableAgents(redis: Redis): Promise<string[]> {
  const [duty, online] = await Promise.all([
    redis.smembers('chatbot:agent:duty'),
    redis.zrangebyscore('chatbot:agent:presence', Date.now() - PRESENCE_FRESH_MS, '+inf'),
  ]);
  const onlineSet = new Set(online);
  return duty.filter((id) => onlineSet.has(id));
}

export async function escalate(
  deps: ChatbotDeps,
  convId: string,
  userId: string,
  reason: 'user_request' | 'low_confidence' | 'agent_join',
): Promise<void> {
  const available = await listAvailableAgents(deps.redis);

  if (available.length > 0) {
    const ok = await transition(deps.db, deps.pub, convId, {
      from: 'BOT',
      to: 'PENDING_HUMAN',
      type: 'escalate',
      reason,
    });
    if (!ok) return;
    await appendMessage(deps.db, deps.pub, convId, {
      role: 'system',
      content: 'Connecting you to a human agent…',
    });
    chatbotEscalationsTotal.inc({ reason });
    await deps.pub.publish('chatbot:queue', JSON.stringify({ type: 'queue_update' }));
    return;
  }

  chatbotEscalationsTotal.inc({ reason });
  await emailFallback(deps, convId, userId, reason);
}

export async function emailFallback(
  deps: ChatbotDeps,
  convId: string,
  userId: string,
  reason: string,
): Promise<void> {
  const [user] = await deps.db
    .select({ email: schema.users.email, displayName: schema.users.displayName })
    .from(schema.users)
    .where(eq(schema.users.id, userId));
  const lastMsgs = await deps.db
    .select({ role: schema.chatbotMessages.role, content: schema.chatbotMessages.content })
    .from(schema.chatbotMessages)
    .where(eq(schema.chatbotMessages.conversationId, convId))
    .limit(20);
  await deps.db.insert(schema.contactRequests).values({
    userId,
    name: user?.displayName ?? user?.email ?? 'chat user',
    email: user?.email ?? '',
    phone: '',
    source: 'chatbot',
    message: `Chat escalation (${reason}), conversation ${convId}:\n${lastMsgs
      .map((m) => `${m.role}: ${m.content}`)
      .join('\n')
      .slice(0, 4000)}`,
  });
  await appendMessage(deps.db, deps.pub, convId, {
    role: 'system',
    content: 'No agents are available right now — our team will follow up by email.',
  });
  await transition(deps.db, deps.pub, convId, {
    from: ['BOT', 'PENDING_HUMAN'],
    to: 'CLOSED',
    type: 'close',
    reason: 'email_fallback',
  });
}
