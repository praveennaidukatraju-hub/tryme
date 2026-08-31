import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from './helpers/api.js';
import { type Containers, startContainers } from './helpers/containers.js';
import {
  createTestApiKey,
  createTestDevTryonCategory,
  createTestMerchant,
} from './helpers/merchant.js';

let c: Containers;
let app: TestApp;
let base: string;

beforeAll(async () => {
  c = await startContainers();
  app = await buildTestApp(
    c,
    {},
    {
      beforeListen: (a) => {
        a.get(
          '/test/full-only',
          { preHandler: [a.requireApiKey, a.requireDevScope('full')] },
          async (req) => ({ ok: true, scope: req.apiKeyScope, integration: req.integration }),
        );
        a.get('/test/either-scope', { preHandler: a.requireApiKey }, async (req) => ({
          ok: true,
          scope: req.apiKeyScope,
        }));
      },
    },
  );
  await app.ready();
  const addr = app.server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(async () => {
  await app.close();
  await c.stop();
});

describe('requireDevScope', () => {
  it('decorates the request with the key scope and integration', async () => {
    const m = await createTestMerchant(app);
    const { key } = await createTestApiKey(app, m.merchantId, {
      scope: 'widget',
      integration: 'wordpress',
    });
    const res = await fetch(`${base}/test/either-scope`, {
      headers: { authorization: `Bearer ${key}` },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).scope).toBe('widget');
  });

  it('allows a full-scoped key on a full-only route', async () => {
    const m = await createTestMerchant(app);
    const { key } = await createTestApiKey(app, m.merchantId, { scope: 'full' });
    const res = await fetch(`${base}/test/full-only`, {
      headers: { authorization: `Bearer ${key}` },
    });
    expect(res.status).toBe(200);
  });

  it('rejects a widget-scoped key on a full-only route with 403', async () => {
    const m = await createTestMerchant(app);
    const { key } = await createTestApiKey(app, m.merchantId, { scope: 'widget' });
    const res = await fetch(`${base}/test/full-only`, {
      headers: { authorization: `Bearer ${key}` },
    });
    expect(res.status).toBe(403);
  });
});

describe('full-only dev routes reject widget-scoped keys', () => {
  it('rejects GET /v1/dev/me for a widget key with 403', async () => {
    const m = await createTestMerchant(app);
    const { key } = await createTestApiKey(app, m.merchantId, { scope: 'widget' });
    const res = await fetch(`${base}/v1/dev/me`, { headers: { authorization: `Bearer ${key}` } });
    expect(res.status).toBe(403);
  });

  it('allows GET /v1/dev/me for a full key', async () => {
    const m = await createTestMerchant(app);
    const { key } = await createTestApiKey(app, m.merchantId, { scope: 'full' });
    const res = await fetch(`${base}/v1/dev/me`, { headers: { authorization: `Bearer ${key}` } });
    expect(res.status).toBe(200);
  });

  it('rejects POST /v1/dev/saree-mannequin for a widget key with 403', async () => {
    const m = await createTestMerchant(app);
    const { key } = await createTestApiKey(app, m.merchantId, { scope: 'widget' });
    const res = await fetch(`${base}/v1/dev/saree-mannequin`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: JSON.stringify({ garment: 'aGVsbG8=' }),
    });
    expect(res.status).toBe(403);
  });

  it('rejects GET /v1/dev/catalog/options for a widget key with 403', async () => {
    const m = await createTestMerchant(app);
    const { key } = await createTestApiKey(app, m.merchantId, { scope: 'widget' });
    const res = await fetch(`${base}/v1/dev/catalog/options?gender=women`, {
      headers: { authorization: `Bearer ${key}` },
    });
    expect(res.status).toBe(403);
  });
});

const jpegBytes = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);

function tryonForm(categorySlug: string) {
  const fd = new FormData();
  fd.set('category', categorySlug);
  fd.set('person', new Blob([jpegBytes()], { type: 'image/jpeg' }), 'p.jpg');
  fd.set('garment', new Blob([jpegBytes()], { type: 'image/jpeg' }), 'g.jpg');
  return fd;
}

describe('job source attribution', () => {
  it('stamps wordpress_tryon for a wordpress-integration key', async () => {
    const m = await createTestMerchant(app, { balance: 1000, jobRateLimitPerMin: 1000 });
    const { key } = await createTestApiKey(app, m.merchantId, {
      scope: 'widget',
      integration: 'wordpress',
    });
    await createTestDevTryonCategory(app, { slug: `wp-src-${m.merchantId}` });

    const res = await fetch(`${base}/v1/dev/tryon`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}` },
      body: tryonForm(`wp-src-${m.merchantId}`),
    });
    expect(res.status).toBe(202);
    const { jobId } = await res.json();

    const [job] = await app.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
    expect(job?.source).toBe('wordpress_tryon');
  });

  it('stamps api_tryon for a generic-integration key (unchanged behavior)', async () => {
    const m = await createTestMerchant(app, { balance: 1000, jobRateLimitPerMin: 1000 });
    const { key } = await createTestApiKey(app, m.merchantId, {
      scope: 'full',
      integration: 'generic',
    });
    await createTestDevTryonCategory(app, { slug: `api-src-${m.merchantId}` });

    const res = await fetch(`${base}/v1/dev/tryon`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}` },
      body: tryonForm(`api-src-${m.merchantId}`),
    });
    expect(res.status).toBe(202);
    const { jobId } = await res.json();

    const [job] = await app.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
    expect(job?.source).toBe('api_tryon');
  });
});

describe('job polling includes wordpress_tryon jobs', () => {
  it('GET /v1/dev/jobs/:id finds a wordpress_tryon job (not a 404)', async () => {
    const m = await createTestMerchant(app, { balance: 1000, jobRateLimitPerMin: 1000 });
    const { key } = await createTestApiKey(app, m.merchantId, {
      scope: 'widget',
      integration: 'wordpress',
    });
    await createTestDevTryonCategory(app, { slug: `wp-poll-${m.merchantId}` });

    const createRes = await fetch(`${base}/v1/dev/tryon`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}` },
      body: tryonForm(`wp-poll-${m.merchantId}`),
    });
    const { jobId } = await createRes.json();

    const pollRes = await fetch(`${base}/v1/dev/jobs/${jobId}`, {
      headers: { authorization: `Bearer ${key}` },
    });
    expect(pollRes.status).toBe(200);
    const body = await pollRes.json();
    expect(body.status).not.toBe(undefined);
  });
});
