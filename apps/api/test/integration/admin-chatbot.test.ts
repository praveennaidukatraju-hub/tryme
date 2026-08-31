import { schema } from '@tryme/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword } from '../../src/modules/auth/service.js';
import { buildTestApp, type TestApp } from '../helpers/api';
import { type Containers, startContainers } from '../helpers/containers';

describe('admin chatbot qna', () => {
  let c: Containers;
  let app: TestApp;
  let adminToken: string;

  beforeAll(async () => {
    c = await startContainers();
    app = await buildTestApp(c);
    const passwordHash = await hashPassword('password123');
    const [user] = await app.db
      .insert(schema.users)
      .values({ email: 'chatbot-admin@x.com', passwordHash, emailVerified: true })
      .returning();
    await app.db
      .insert(schema.adminUsers)
      .values({ userId: user.id, role: 'SUPER_ADMIN', passwordHash });
    const res = await app.inject({
      method: 'POST',
      url: '/admin/auth/login',
      payload: { email: 'chatbot-admin@x.com', password: 'password123' },
    });
    adminToken = res.json().accessToken;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await c?.stop();
  });

  it('CRUD lifecycle', async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/admin/chatbot/qna',
      headers: { authorization: `Bearer ${adminToken}` },
      payload: {
        question: 'How do credits work?',
        answer: 'One credit per try-on.',
        tags: ['credits'],
        isActive: true,
      },
    });
    expect(created.statusCode).toBe(200);
    const createdBody = created.json();
    expect(createdBody.id).toBeDefined();

    const list = await app.inject({
      method: 'GET',
      url: '/admin/chatbot/qna?active=true',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().total).toBe(1);

    const patched = await app.inject({
      method: 'PATCH',
      url: `/admin/chatbot/qna/${createdBody.id}`,
      headers: { authorization: `Bearer ${adminToken}` },
      payload: { isActive: false },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.json().isActive).toBe(false);

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/admin/chatbot/qna/${createdBody.id}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(deleted.statusCode).toBe(200);

    const after = await app.inject({
      method: 'GET',
      url: '/admin/chatbot/qna',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(after.statusCode).toBe(200);
    expect(after.json().total).toBe(0);
  });

  it('ingest returns 503 when CHATBOT_URL unset', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/chatbot/ingest',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(503);
  });
});
