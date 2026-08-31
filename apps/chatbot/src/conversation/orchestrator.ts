import { eq, schema } from '@tryme/db';
import { chatbotBotTurnDuration, chatbotFallbacksTotal } from '@tryme/observability';
import { runBotTurn } from '../agent/bot.js';
import type { ChatbotDeps } from '../server.js';
import { escalate } from './escalation.js';
import {
  appendMessage,
  getOrCreateActiveConversation,
  listMessages,
  publishConv,
} from './service.js';

const HISTORY_N = 12;

export class Orchestrator {
  private inflight = new Map<string, AbortController>();
  private chains = new Map<string, Promise<void>>();

  constructor(private deps: ChatbotDeps) {}

  private enqueue(convId: string, fn: () => Promise<void>): Promise<void> {
    const next = (this.chains.get(convId) ?? Promise.resolve()).then(fn, fn);
    this.chains.set(convId, next);
    return next;
  }

  terminate(convId: string): void {
    this.inflight.get(convId)?.abort();
    this.inflight.delete(convId);
  }

  async fallbackCount(convId: string): Promise<number> {
    const n = await this.deps.redis.get(`chatbot:conv:${convId}:fallbacks`);
    return Number(n ?? 0);
  }

  async handleUserMessage(convId: string, userId: string, content: string): Promise<void> {
    const { deps } = this;
    await appendMessage(deps.db, deps.pub, convId, { role: 'user', senderId: userId, content });

    const [conv] = await deps.db
      .select()
      .from(schema.chatbotConversations)
      .where(eq(schema.chatbotConversations.id, convId));
    if (conv?.status !== 'BOT') return;

    await this.enqueue(convId, async () => {
      const ac = new AbortController();
      this.inflight.set(convId, ac);
      try {
        await publishConv(deps.pub, convId, {
          type: 'typing',
          conversationId: convId,
          role: 'bot',
        });
        const history = await listMessages(deps.db, convId, { limit: HISTORY_N });
        const botTimer = chatbotBotTurnDuration.startTimer();
        const result = await runBotTurn({
          deps,
          toolModel: deps.makeToolModel(),
          genModel: deps.makeGenModel(),
          userId,
          convId,
          history: history.slice(0, -1),
          userMessage: content,
          signal: ac.signal,
        });
        botTimer();

        if (result.kind === 'escalate') {
          await escalate(this.deps, convId, userId, 'user_request');
          return;
        }

        if (result.kind === 'fallback') {
          chatbotFallbacksTotal.inc();
          const n = await deps.redis.incr(`chatbot:conv:${convId}:fallbacks`);
          await deps.redis.expire(`chatbot:conv:${convId}:fallbacks`, 3600);
          if (n >= deps.env.CHATBOT_FALLBACK_LIMIT) {
            await escalate(this.deps, convId, userId, 'low_confidence');
            return;
          }
        } else {
          await deps.redis.del(`chatbot:conv:${convId}:fallbacks`);
        }

        await deps.db.transaction(async (tx) => {
          const [row] = await tx
            .select({ status: schema.chatbotConversations.status })
            .from(schema.chatbotConversations)
            .where(eq(schema.chatbotConversations.id, convId))
            .for('update');
          if (row?.status !== 'BOT') return;
          await tx.insert(schema.chatbotMessages).values({
            conversationId: convId,
            role: 'bot',
            content: result.content,
            meta: result.meta,
          });
          await tx
            .update(schema.chatbotConversations)
            .set({ lastMessageAt: new Date() })
            .where(eq(schema.chatbotConversations.id, convId));
        });
        const [persisted] = await listMessages(deps.db, convId, { limit: 1 });
        if (persisted?.role === 'bot' && persisted.content === result.content) {
          await publishConv(deps.pub, convId, { type: 'message', message: persisted });
        }
      } catch (err) {
        if (ac.signal.aborted) return;
        this.deps.log.error({ err, convId }, 'bot turn failed');
        await appendMessage(deps.db, deps.pub, convId, {
          role: 'system',
          content: 'Something went wrong answering that. You can try again or talk to a human.',
        });
      } finally {
        this.inflight.delete(convId);
      }
    });
  }

  async handleUserEscalate(convId: string, userId: string): Promise<void> {
    await escalate(this.deps, convId, userId, 'user_request');
  }
}

export { getOrCreateActiveConversation };
