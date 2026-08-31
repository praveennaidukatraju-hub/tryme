import { FakeStreamingChatModel } from '@langchain/core/utils/testing';
import { schema } from '@tryme/db';
import { SignJWT } from 'jose';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { buildTestApp } from './helpers/app.js';
import { type Containers, startContainers } from './helpers/containers.js';

const SECRET = new TextEncoder().encode('test-jwt-secret-test-jwt-secret');

async function userToken(sub: string) {
  return new SignJWT({ kind: 'access' })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(sub)
    .setIssuedAt()
    .setExpirationTime('10m')
    .sign(SECRET);
}

describe('rate limit', () => {
  let c: Containers;
  let t: Awaited<ReturnType<typeof buildTestApp>>;
  let userId: string;

  beforeAll(async () => {
    c = await startContainers();
    t = await buildTestApp(c, {
      makeGenModel: () => new FakeStreamingChatModel({ responses: ['ok'] }),
    });
    const [u] = await t.deps.db
      .insert(schema.users)
      .values({ email: 'rl@test.dev', passwordHash: 'x', emailVerified: true })
      .returning();
    userId = u.id;
  }, 60_000);

  afterAll(async () => {
    await t.stop();
    await c.stop();
  });

  it('rate limits user messages 10 per 30s', async () => {
    const token = await userToken(userId);
    const res = await fetch(`${t.baseUrl}/ws-ticket`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    const { ticket } = (await res.json()) as { ticket: string };
    const ws = new WebSocket(`${t.baseUrl.replace('http', 'ws')}/ws?ticket=${ticket}`);

    // wait for ready
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timeout')), 10_000);
      ws.on('message', (buf) => {
        const f = JSON.parse(buf.toString());
        if (f.type === 'ready') {
          clearTimeout(timer);
          resolve();
        }
      });
    });

    const errors: string[] = [];
    ws.on('message', (buf) => {
      const f = JSON.parse(buf.toString());
      if (f.type === 'error' && f.code === 'RATE_LIMITED') errors.push(f.message as string);
    });

    for (let i = 0; i < 11; i++) {
      ws.send(JSON.stringify({ type: 'message', content: `msg ${i}` }));
      await new Promise((r) => setTimeout(r, 50));
    }

    await new Promise((r) => setTimeout(r, 200));
    expect(errors.length).toBeGreaterThan(0);
    ws.close();
  });
});
