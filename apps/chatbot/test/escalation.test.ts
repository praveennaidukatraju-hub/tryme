import { eq, schema } from '@tryme/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { escalate, listAvailableAgents } from '../src/conversation/escalation.js';
import { getOrCreateActiveConversation, transition } from '../src/conversation/service.js';
import { runChatSweeper } from '../src/conversation/sweeper.js';
import { buildTestApp } from './helpers/app.js';
import { type Containers, startContainers } from './helpers/containers.js';

describe('escalation + sweeper', () => {
  let c: Containers;
  let t: Awaited<ReturnType<typeof buildTestApp>>;
  let userId: string;
  let agentId: string;

  beforeAll(async () => {
    c = await startContainers();
    t = await buildTestApp(c);
    const [u] = await t.deps.db
      .insert(schema.users)
      .values({ email: 'esc@test.dev', passwordHash: 'x', emailVerified: true })
      .returning();
    userId = u.id;
    const [au] = await t.deps.db
      .insert(schema.users)
      .values({ email: 'agent@test.dev', passwordHash: 'x', emailVerified: true })
      .returning();
    const [admin] = await t.deps.db
      .insert(schema.adminUsers)
      .values({ userId: au.id, role: 'SUPPORT', status: 'active' })
      .returning();
    agentId = admin.id;
  }, 60_000);

  afterAll(async () => {
    await t.stop();
    await c.stop();
  });

  it('available = duty ON ∩ fresh presence', async () => {
    await t.deps.redis.sadd('chatbot:agent:duty', agentId);
    await t.deps.redis.zadd('chatbot:agent:presence', Date.now(), agentId);
    const available = await listAvailableAgents(t.deps.redis);
    expect(available).toEqual([agentId]);
  });

  it('escalate with agent available → PENDING_HUMAN', async () => {
    await t.deps.redis.zadd('chatbot:agent:presence', Date.now(), agentId);
    const conv = await getOrCreateActiveConversation(t.deps.db, userId);
    await escalate(t.deps, conv.id, userId, 'user_request');
    const [row] = await t.deps.db
      .select()
      .from(schema.chatbotConversations)
      .where(eq(schema.chatbotConversations.id, conv.id));
    expect(row.status).toBe('PENDING_HUMAN');
    expect(row.escalationReason).toBe('user_request');
    await transition(t.deps.db, t.deps.pub, conv.id, {
      from: 'PENDING_HUMAN',
      to: 'CLOSED',
      type: 'close',
    });
  });

  it('escalate with nobody available → contact_requests + CLOSED', async () => {
    await t.deps.redis.srem('chatbot:agent:duty', agentId);
    const conv = await getOrCreateActiveConversation(t.deps.db, userId);
    await escalate(t.deps, conv.id, userId, 'user_request');
    const [row] = await t.deps.db
      .select()
      .from(schema.chatbotConversations)
      .where(eq(schema.chatbotConversations.id, conv.id));
    expect(row.status).toBe('CLOSED');
    const reqs = await t.deps.db
      .select()
      .from(schema.contactRequests)
      .where(eq(schema.contactRequests.source, 'chatbot'));
    expect(reqs.length).toBe(1);
  });

  it('sweeper closes idle BOT conv', async () => {
    const conv = await getOrCreateActiveConversation(t.deps.db, userId);
    await t.deps.db
      .update(schema.chatbotConversations)
      .set({ lastMessageAt: new Date(Date.now() - 31 * 60_000) })
      .where(eq(schema.chatbotConversations.id, conv.id));
    await runChatSweeper(t.deps);
    const [row] = await t.deps.db
      .select()
      .from(schema.chatbotConversations)
      .where(eq(schema.chatbotConversations.id, conv.id));
    expect(row.status).toBe('CLOSED');
  });
});
