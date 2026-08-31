import { schema } from '@tryme/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../../src/modules/auth/service.js';
import { buildTestApp, type TestApp } from '../helpers/api';
import { type Containers, startContainers } from '../helpers/containers';

describe('admin chatbot hitl', () => {
  let c: Containers;
  let app: TestApp;
  let adminToken: string;

  beforeAll(async () => {
    c = await startContainers();
    app = await buildTestApp(c);
    const passwordHash = await hashPassword('password123');
    const [user] = await app.db
      .insert(schema.users)
      .values({ email: 'hitl-admin@x.com', passwordHash, emailVerified: true })
      .returning();
    await app.db
      .insert(schema.adminUsers)
      .values({ userId: user.id, role: 'SUPER_ADMIN', passwordHash });
    const res = await app.inject({
      method: 'POST',
      url: '/admin/auth/login',
      payload: { email: 'hitl-admin@x.com', password: 'password123' },
    });
    adminToken = res.json().accessToken;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await c?.stop();
  });

  async function seedConv(status: string) {
    const [u] = await app.db
      .insert(schema.users)
      .values({ email: `hitl-user-${Date.now()}@x.com`, passwordHash: '', emailVerified: true })
      .returning();
    const [conv] = await app.db
      .insert(schema.chatbotConversations)
      .values({ userId: u.id, status })
      .returning();
    return { user: u, conv };
  }

  it('claim sets PENDING_HUMAN→HUMAN', async () => {
    const { conv } = await seedConv('PENDING_HUMAN');
    const res = await app.inject({
      method: 'POST',
      url: `/admin/chatbot/conversations/${conv.id}/claim`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('HUMAN');
  });

  it('second claim 409', async () => {
    const { conv } = await seedConv('PENDING_HUMAN');
    await app.inject({
      method: 'POST',
      url: `/admin/chatbot/conversations/${conv.id}/claim`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    const res2 = await app.inject({
      method: 'POST',
      url: `/admin/chatbot/conversations/${conv.id}/claim`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res2.statusCode).toBe(409);
  });

  it('end sets HUMAN→CLOSED (assigned agent only)', async () => {
    const { conv } = await seedConv('PENDING_HUMAN');
    const claimed = await app.inject({
      method: 'POST',
      url: `/admin/chatbot/conversations/${conv.id}/claim`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(claimed.statusCode).toBe(200);

    const res = await app.inject({
      method: 'POST',
      url: `/admin/chatbot/conversations/${conv.id}/end`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('CLOSED');
    expect(res.json().closedAt).toBeTruthy();
  });

  it('end fails for unassigned agent', async () => {
    const { conv } = await seedConv('HUMAN');
    const res = await app.inject({
      method: 'POST',
      url: `/admin/chatbot/conversations/${conv.id}/end`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(409);
  });

  it('duty toggle round-trips', async () => {
    const on = await app.inject({
      method: 'GET',
      url: '/admin/chatbot/duty',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(on.json().on).toBe(false);

    await app.inject({
      method: 'POST',
      url: '/admin/chatbot/duty',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { on: true },
    });

    const after = await app.inject({
      method: 'GET',
      url: '/admin/chatbot/duty',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(after.json().on).toBe(true);
  });
});
