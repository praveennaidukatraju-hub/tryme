import { schema } from '@tryme/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  appendMessage,
  getOrCreateActiveConversation,
  listMessages,
  transition,
} from '../src/conversation/service.js';
import { buildTestApp } from './helpers/app.js';
import { type Containers, startContainers } from './helpers/containers.js';

describe('conversation service', () => {
  let c: Containers;
  let t: Awaited<ReturnType<typeof buildTestApp>>;
  let userId: string;

  beforeAll(async () => {
    c = await startContainers();
    t = await buildTestApp(c);
    const [u] = await t.deps.db
      .insert(schema.users)
      .values({ email: 'chat@test.dev', passwordHash: 'x', emailVerified: true })
      .returning();
    userId = u.id;
  }, 60_000);

  afterAll(async () => {
    await t.stop();
    await c.stop();
  });

  it('creates one active conversation, resumes it', async () => {
    const a = await getOrCreateActiveConversation(t.deps.db, userId);
    const b = await getOrCreateActiveConversation(t.deps.db, userId);
    expect(a.id).toBe(b.id);
    expect(a.status).toBe('BOT');
  });

  it('append + list messages ordered', async () => {
    const conv = await getOrCreateActiveConversation(t.deps.db, userId);
    await appendMessage(t.deps.db, t.deps.pub, conv.id, {
      role: 'user',
      senderId: userId,
      content: 'hi',
    });
    await appendMessage(t.deps.db, t.deps.pub, conv.id, { role: 'bot', content: 'hello!' });
    const msgs = await listMessages(t.deps.db, conv.id);
    expect(msgs.map((m) => m.role)).toEqual(['user', 'bot']);
  });

  it('guarded transition: wrong from-status is a no-op', async () => {
    const conv = await getOrCreateActiveConversation(t.deps.db, userId);
    const bad = await transition(t.deps.db, t.deps.pub, conv.id, {
      from: 'HUMAN',
      to: 'CLOSED',
      type: 'close',
    });
    expect(bad).toBe(false);
    const ok = await transition(t.deps.db, t.deps.pub, conv.id, {
      from: 'BOT',
      to: 'PENDING_HUMAN',
      type: 'escalate',
      reason: 'user_request',
    });
    expect(ok).toBe(true);
    const events = await t.deps.db.select().from(schema.chatbotEvents);
    expect(events.some((e) => e.type === 'escalate' && e.toStatus === 'PENDING_HUMAN')).toBe(true);
  });

  it('CLOSED never resumes — new conversation created', async () => {
    const conv = await getOrCreateActiveConversation(t.deps.db, userId);
    await transition(t.deps.db, t.deps.pub, conv.id, {
      from: ['BOT', 'PENDING_HUMAN'],
      to: 'CLOSED',
      type: 'close',
    });
    const fresh = await getOrCreateActiveConversation(t.deps.db, userId);
    expect(fresh.id).not.toBe(conv.id);
  });
});
