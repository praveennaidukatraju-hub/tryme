import { schema } from '@tryme/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { searchKnowledge } from '../src/agent/search.js';
import { buildTestApp } from './helpers/app.js';
import { type Containers, startContainers } from './helpers/containers.js';

function unit(axis: number): number[] {
  const v = Array(1536).fill(0);
  v[axis] = 1;
  return v;
}
const vocab: Record<string, number> = { credits: 0, refund: 1 };
const fakeEmbed = async (texts: string[]) =>
  texts.map((t) => {
    const hit = Object.keys(vocab).find((w) => t.toLowerCase().includes(w));
    return unit(hit ? vocab[hit] : 99);
  });

describe('hybrid search', () => {
  let c: Containers;
  let t: Awaited<ReturnType<typeof buildTestApp>>;

  beforeAll(async () => {
    c = await startContainers();
    t = await buildTestApp(c, { embed: fakeEmbed });
    const [q1] = await t.deps.db
      .insert(schema.chatbotQna)
      .values({ question: 'How do credits work?', answer: 'One credit per try-on job.' })
      .returning();
    const [q2] = await t.deps.db
      .insert(schema.chatbotQna)
      .values({ question: 'Refund policy', answer: 'Refunds within 7 days.' })
      .returning();
    const [v1, v2] = await fakeEmbed([
      'How do credits work?\nOne credit per try-on job.',
      'Refund policy\nRefunds within 7 days.',
    ]);
    await t.deps.db.insert(schema.chatbotEmbeddings).values([
      { qnaId: q1.id, content: 'How do credits work?\nOne credit per try-on job.', embedding: v1 },
      { qnaId: q2.id, content: 'Refund policy\nRefunds within 7 days.', embedding: v2 },
    ]);
  }, 60_000);

  afterAll(async () => {
    await t.stop();
    await c.stop();
  });

  it('vector leg ranks matching doc first, grounded=true', async () => {
    const r = await searchKnowledge(t.deps.db, fakeEmbed, 'tell me about credits', 5, 0.4);
    expect(r.grounded).toBe(true);
    expect(r.hits[0].content).toContain('credit per try-on');
  });

  it('text leg finds keyword match even with off-axis embedding', async () => {
    const r = await searchKnowledge(t.deps.db, fakeEmbed, 'seven days policy', 5, 0.4);
    expect(r.hits.some((h) => h.content.includes('Refunds'))).toBe(true);
  });

  it('nonsense query is ungrounded', async () => {
    const r = await searchKnowledge(t.deps.db, fakeEmbed, 'zzz qqq xyzzy', 5, 0.4);
    expect(r.grounded).toBe(false);
  });
});
