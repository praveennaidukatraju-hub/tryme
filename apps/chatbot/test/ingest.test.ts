import { schema } from '@tryme/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp } from './helpers/app.js';
import { type Containers, startContainers } from './helpers/containers.js';

const fakeEmbed = async (texts: string[]) => texts.map((t) => [t.length, ...Array(1535).fill(0)]);

describe('ingest', () => {
  let c: Containers;
  let t: Awaited<ReturnType<typeof buildTestApp>>;

  beforeAll(async () => {
    c = await startContainers();
    t = await buildTestApp(c, { embed: fakeEmbed });
    await t.deps.db.insert(schema.chatbotQna).values([
      { question: 'How do credits work?', answer: 'One credit per try-on.' },
      { question: 'Inactive q', answer: 'skip me', isActive: false },
    ]);
  }, 60_000);

  afterAll(async () => {
    await t.stop();
    await c.stop();
  });

  it('rejects without service token', async () => {
    const res = await fetch(`${t.baseUrl}/ingest`, { method: 'POST' });
    expect(res.status).toBe(401);
  });

  it('embeds only active rows, atomic swap', async () => {
    const res = await fetch(`${t.baseUrl}/ingest`, {
      method: 'POST',
      headers: { 'x-service-token': 'test-service-token-123456' },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ingested: number };
    expect(body.ingested).toBe(1);
    const rows = await t.deps.db.select().from(schema.chatbotEmbeddings);
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe('How do credits work?\nOne credit per try-on.');
  });

  it('re-ingest replaces, not appends', async () => {
    await fetch(`${t.baseUrl}/ingest`, {
      method: 'POST',
      headers: { 'x-service-token': 'test-service-token-123456' },
    });
    const rows = await t.deps.db.select().from(schema.chatbotEmbeddings);
    expect(rows).toHaveLength(1);
  });

  it('conflicts while lock held', async () => {
    await t.deps.redis.set('chatbot:ingest:lock', '1', 'EX', 60, 'NX');
    const res = await fetch(`${t.baseUrl}/ingest`, {
      method: 'POST',
      headers: { 'x-service-token': 'test-service-token-123456' },
    });
    expect(res.status).toBe(409);
    await t.deps.redis.del('chatbot:ingest:lock');
  });
});
