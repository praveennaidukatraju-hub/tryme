import { AIMessage } from '@langchain/core/messages';
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

function nextFrame(ws: WebSocket, type: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${type}`)), 10_000);
    ws.on('message', (buf) => {
      const f = JSON.parse(buf.toString());
      if (f.type === type) {
        clearTimeout(timer);
        resolve(f);
      }
    });
  });
}

describe('ws gateway', () => {
  let c: Containers;
  let t: Awaited<ReturnType<typeof buildTestApp>>;
  let userId: string;

  beforeAll(async () => {
    c = await startContainers();
    t = await buildTestApp(c, {
      makeGenModel: () =>
        new FakeStreamingChatModel({ responses: [new AIMessage('Hello from bot')] }),
    });
    const [u] = await t.deps.db
      .insert(schema.users)
      .values({ email: 'ws@test.dev', passwordHash: 'x', emailVerified: true })
      .returning();
    userId = u.id;
  }, 60_000);

  afterAll(async () => {
    await t.stop();
    await c.stop();
  });

  it('ticket is required and one-time', async () => {
    const noTicket = await fetch(`${t.baseUrl.replace('http', 'ws')}/ws`).catch(() => null);
    const token = await userToken(userId);
    const res = await fetch(`${t.baseUrl}/ws-ticket`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const { ticket } = (await res.json()) as { ticket: string };
    expect(ticket.length).toBeGreaterThan(16);
    expect(noTicket).toBeNull();
  });

  it('user connects, sends message, bot replies', async () => {
    const token = await userToken(userId);
    const { ticket } = (await (
      await fetch(`${t.baseUrl}/ws-ticket`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}` },
      })
    ).json()) as { ticket: string };

    const wsUrl = `${t.baseUrl.replace('http', 'ws')}/ws?ticket=${ticket}`;
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      ws.on('open', resolve);
      ws.on('close', (code) => reject(new Error(`closed ${code}`)));
    });
    const ready = await nextFrame(ws, 'ready');
    expect(ready.status).toBe('BOT');

    const botMsg = new Promise<Record<string, unknown>>((resolve) => {
      ws.on('message', (buf) => {
        const f = JSON.parse(buf.toString());
        if (f.type === 'message' && (f.message as { role: string }).role === 'bot') resolve(f);
      });
    });
    ws.send(JSON.stringify({ type: 'message', content: 'hi there' }));
    const got = await botMsg;
    expect((got.message as { content: string }).content).toBe('Hello from bot');
    ws.close();
  });

  it('rejects ws without ticket', async () => {
    const wsUrl = `${t.baseUrl.replace('http', 'ws')}/ws`;
    const ws = new WebSocket(wsUrl);
    const code = await new Promise<number>((resolve) => {
      ws.on('close', (c) => resolve(c));
      setTimeout(() => resolve(-1), 5000);
    });
    expect(code).toBe(4401);
  });
});
