import { schema } from '@tryme/db';
import { JOB_SOURCE } from '@tryme/types';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signAccess } from '../src/modules/auth/service.js';
import { buildTestApp, type TestApp } from './helpers/api.js';
import { type Containers, startContainers } from './helpers/containers.js';
import { createTestMerchant } from './helpers/merchant.js';

let c: Containers;
let app: TestApp;
let base: string;
let token: string;
let _merchantId: string;

async function tokenFor(userId: string) {
  return signAccess(
    new TextEncoder().encode(app.env.JWT_SECRET),
    userId,
    { kind: 'access' },
    app.env.JWT_EXPIRY,
    'user',
  );
}

beforeAll(async () => {
  c = await startContainers();
  app = await buildTestApp(c);
  await app.ready();
  const addr = app.server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

  const m = await createTestMerchant(app);
  _merchantId = m.merchantId;
  token = await tokenFor(m.userId);
});

afterAll(async () => {
  await app.close();
  await c.stop();
});

const call = (path: string, init: RequestInit = {}) =>
  fetch(`${base}${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });

describe('POST /v1/merchant/api-keys', () => {
  it('creates a key and returns the plaintext exactly once', async () => {
    const res = await call('/v1/merchant/api-keys', {
      method: 'POST',
      body: JSON.stringify({ label: 'production' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.key).toMatch(/^sk_live_[A-Za-z0-9_-]{43}$/);
    expect(body.keyPrefix).toBe(body.key.slice(0, 12));

    // The plaintext key must never be stored — only its hash.
    const [row] = await app.db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, body.id));
    expect(row?.keyHash).not.toBe(body.key);
    expect(row?.keyHash).toHaveLength(64);

    // ...and must never be retrievable again.
    const list = await (await call('/v1/merchant/api-keys')).json();
    expect(JSON.stringify(list)).not.toContain(body.key);
  });

  it('rejects an empty label with 400', async () => {
    const res = await call('/v1/merchant/api-keys', {
      method: 'POST',
      body: JSON.stringify({ label: '' }),
    });
    expect(res.status).toBe(400);
  });

  it('requires merchant auth', async () => {
    const res = await fetch(`${base}/v1/merchant/api-keys`, { method: 'POST' });
    expect(res.status).toBe(401);
  });
});

describe('GET /v1/merchant/api-keys', () => {
  it('lists only this merchant keys, without plaintext', async () => {
    const other = await createTestMerchant(app);
    const otherToken = await tokenFor(other.userId);
    await fetch(`${base}/v1/merchant/api-keys`, {
      method: 'POST',
      headers: { authorization: `Bearer ${otherToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'theirs' }),
    });

    const body = await (await call('/v1/merchant/api-keys')).json();
    for (const k of body.keys) {
      expect(k.label).not.toBe('theirs');
      expect(k).not.toHaveProperty('key');
      expect(k).not.toHaveProperty('keyHash');
    }
  });

  it('excludes revoked keys', async () => {
    const created = await (
      await call('/v1/merchant/api-keys', {
        method: 'POST',
        body: JSON.stringify({ label: 'temp' }),
      })
    ).json();
    await call(`/v1/merchant/api-keys/${created.id}`, { method: 'DELETE' });
    const body = await (await call('/v1/merchant/api-keys')).json();
    expect(body.keys.map((k: { id: string }) => k.id)).not.toContain(created.id);
  });
});

describe('DELETE /v1/merchant/api-keys/:id', () => {
  it('revokes a key so it stops authenticating', async () => {
    const created = await (
      await call('/v1/merchant/api-keys', {
        method: 'POST',
        body: JSON.stringify({ label: 'doomed' }),
      })
    ).json();

    const before = await fetch(`${base}/v1/dev/me`, {
      headers: { authorization: `Bearer ${created.key}` },
    });
    expect(before.status).toBe(200);

    expect((await call(`/v1/merchant/api-keys/${created.id}`, { method: 'DELETE' })).status).toBe(
      204,
    );

    const after = await fetch(`${base}/v1/dev/me`, {
      headers: { authorization: `Bearer ${created.key}` },
    });
    expect(after.status).toBe(401);
  });

  // Security: revoking must be scoped to the caller's own keys.
  it("cannot revoke another merchant's key", async () => {
    const other = await createTestMerchant(app);
    const otherToken = await tokenFor(other.userId);
    const theirs = await (
      await fetch(`${base}/v1/merchant/api-keys`, {
        method: 'POST',
        headers: { authorization: `Bearer ${otherToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ label: 'theirs' }),
      })
    ).json();

    expect((await call(`/v1/merchant/api-keys/${theirs.id}`, { method: 'DELETE' })).status).toBe(
      404,
    );

    const still = await fetch(`${base}/v1/dev/me`, {
      headers: { authorization: `Bearer ${theirs.key}` },
    });
    expect(still.status).toBe(200);
  });
});

describe('GET /v1/merchant/api-usage', () => {
  it('returns recent api-sourced jobs for this merchant, joined with the key used', async () => {
    const created = await (
      await call('/v1/merchant/api-keys', {
        method: 'POST',
        body: JSON.stringify({ label: 'usage-test' }),
      })
    ).json();

    // No merchantId on the job row — dev-API jobs identify their owning merchant
    // solely via apiKeyId → api_keys.merchantId (see dev-tryon-create.test.ts).
    const [job] = await app.db
      .insert(schema.jobs)
      .values({
        apiKeyId: created.id,
        status: 'COMPLETED',
        source: JOB_SOURCE.API_TRYON,
        creditsCharged: 3,
      })
      .returning();
    if (!job) throw new Error('failed to seed test job');

    const body = await (await call('/v1/merchant/api-usage')).json();
    const row = body.usage.find((u: { jobId: string }) => u.jobId === job.id);
    expect(row).toBeTruthy();
    expect(row.status).toBe('COMPLETED');
    expect(row.creditsCharged).toBe(3);
    expect(row.keyLabel).toBe('usage-test');
    expect(row.keyPrefix).toBe(created.keyPrefix);
    expect(typeof row.createdAt).toBe('string');
  });

  it('excludes jobs from other merchants and non-api sources', async () => {
    const other = await createTestMerchant(app);
    const otherToken = await tokenFor(other.userId);
    const otherKey = await (
      await fetch(`${base}/v1/merchant/api-keys`, {
        method: 'POST',
        headers: { authorization: `Bearer ${otherToken}`, 'content-type': 'application/json' },
        body: JSON.stringify({ label: 'other' }),
      })
    ).json();
    await app.db.insert(schema.jobs).values({
      apiKeyId: otherKey.id,
      status: 'COMPLETED',
      source: JOB_SOURCE.API_TRYON,
      creditsCharged: 1,
    });

    // Same merchant/key as the "usage-test" job above, but created via the
    // catalog flow rather than the dev API — must be excluded by the
    // route's dev-API-source `inArray` filter, not just the merchantId
    // scoping exercised above.
    const own = await (
      await call('/v1/merchant/api-keys', {
        method: 'POST',
        body: JSON.stringify({ label: 'non-api-source' }),
      })
    ).json();
    const [catalogJob] = await app.db
      .insert(schema.jobs)
      .values({
        apiKeyId: own.id,
        status: 'COMPLETED',
        source: 'catalog',
        creditsCharged: 2,
      })
      .returning();
    if (!catalogJob) throw new Error('failed to seed test job');

    const body = await (await call('/v1/merchant/api-usage')).json();
    for (const u of body.usage) {
      expect(u.keyLabel).not.toBe('other');
    }
    expect(body.usage.map((u: { jobId: string }) => u.jobId)).not.toContain(catalogJob.id);
  });

  it('requires merchant auth', async () => {
    const res = await fetch(`${base}/v1/merchant/api-usage`);
    expect(res.status).toBe(401);
  });
});

describe('POST /v1/merchant/api-keys with kind: wordpress_widget', () => {
  it('atomically sets scope=widget and integration=wordpress, normalizing siteUrl to its origin', async () => {
    const createRes = await call('/v1/merchant/api-keys', {
      method: 'POST',
      body: JSON.stringify({
        label: 'My WooCommerce Store',
        kind: 'wordpress_widget',
        siteUrl: 'https://my-shop.example.com/wp-admin/',
      }),
    });
    expect(createRes.status).toBe(201);
    const created = await createRes.json();
    expect(created.scope).toBe('widget');
    expect(created.integration).toBe('wordpress');
    expect(created.allowedOrigin).toBe('https://my-shop.example.com');

    const list = await (await call('/v1/merchant/api-keys')).json();
    const row = list.keys.find((k: { id: string }) => k.id === created.id);
    expect(row.scope).toBe('widget');
    expect(row.integration).toBe('wordpress');
    expect(row.allowedOrigin).toBe('https://my-shop.example.com');
  });

  it('rejects a wordpress_widget key with no siteUrl', async () => {
    const res = await call('/v1/merchant/api-keys', {
      method: 'POST',
      body: JSON.stringify({ label: 'Missing site', kind: 'wordpress_widget' }),
    });
    expect(res.status).toBe(400);
  });

  it('rejects a wordpress_widget key with a malformed siteUrl', async () => {
    const res = await call('/v1/merchant/api-keys', {
      method: 'POST',
      body: JSON.stringify({
        label: 'Bad site',
        kind: 'wordpress_widget',
        siteUrl: 'not-a-url',
      }),
    });
    expect(res.status).toBe(400);
  });

  it('defaults to full/generic/no-origin when kind is omitted (unchanged behavior)', async () => {
    const createRes = await call('/v1/merchant/api-keys', {
      method: 'POST',
      body: JSON.stringify({ label: 'Regular key' }),
    });
    const created = await createRes.json();
    expect(created.scope).toBe('full');
    expect(created.integration).toBe('generic');
    expect(created.allowedOrigin).toBeNull();
  });
});
