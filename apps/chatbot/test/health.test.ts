import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp } from './helpers/app.js';
import { type Containers, startContainers } from './helpers/containers.js';

describe('health', () => {
  let c: Containers;
  let t: Awaited<ReturnType<typeof buildTestApp>>;

  beforeAll(async () => {
    c = await startContainers();
    t = await buildTestApp(c);
  }, 60_000);

  afterAll(async () => {
    await t.stop();
    await c.stop();
  });

  it('GET /health returns ok + counts', async () => {
    const res = await fetch(`${t.baseUrl}/health`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; qna: number; embedded: number };
    expect(body.ok).toBe(true);
    expect(body.qna).toBe(0);
    expect(body.embedded).toBe(0);
  });
});
