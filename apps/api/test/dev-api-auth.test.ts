import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from './helpers/api.js';
import { type Containers, startContainers } from './helpers/containers.js';
import { createTestApiKey, createTestMerchant } from './helpers/merchant.js';

let c: Containers;
let app: TestApp;
let base: string;
let activeKey: string;
let merchantId: string;

beforeAll(async () => {
  c = await startContainers();
  app = await buildTestApp(
    c,
    {},
    {
      beforeListen: (a) => {
        a.get('/test/whoami', { preHandler: a.requireApiKey }, async (req) => ({
          apiKeyId: req.apiKeyId,
          merchantId: req.merchantId,
          merchantUserId: req.merchantUserId,
        }));
      },
    },
  );
  await app.ready();
  const addr = app.server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

  const m = await createTestMerchant(app);
  merchantId = m.merchantId;
  ({ key: activeKey } = await createTestApiKey(app, merchantId));
});

afterAll(async () => {
  await app.close();
  await c.stop();
});

const call = (headers: Record<string, string> = {}) => fetch(`${base}/test/whoami`, { headers });

describe('requireApiKey', () => {
  it('accepts a valid key and decorates the request', async () => {
    const res = await call({ authorization: `Bearer ${activeKey}` });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.merchantId).toBe(merchantId);
    expect(body.apiKeyId).toBeTruthy();
    expect(body.merchantUserId).toBeTruthy();
  });

  it('rejects a missing header with 401', async () => {
    expect((await call()).status).toBe(401);
  });

  it('rejects a non-bearer header with 401', async () => {
    expect((await call({ authorization: 'Basic abc' })).status).toBe(401);
  });

  // Regression: a malformed key must be rejected by the format guard BEFORE it
  // reaches Postgres. Without the guard this is an unhandled 500, not a 401.
  it('rejects a malformed key with 401, not 500', async () => {
    for (const bad of ["sk_live_'; DROP TABLE api_keys;--", 'sk_live_short', 'garbage']) {
      const res = await call({ authorization: `Bearer ${bad}` });
      expect(res.status).toBe(401);
    }
  });

  it('rejects a well-formed but unknown key with 401', async () => {
    const res = await call({ authorization: `Bearer sk_live_${'a'.repeat(43)}` });
    expect(res.status).toBe(401);
  });

  it('rejects a revoked key with 401', async () => {
    const { key } = await createTestApiKey(app, merchantId, { revoked: true });
    const res = await call({ authorization: `Bearer ${key}` });
    expect(res.status).toBe(401);
  });

  it('rejects a key whose merchant is inactive with 401', async () => {
    const m = await createTestMerchant(app, { isActive: false });
    const { key } = await createTestApiKey(app, m.merchantId);
    const res = await call({ authorization: `Bearer ${key}` });
    expect(res.status).toBe(401);
  });

  it('records lastUsedAt on first use', async () => {
    const m = await createTestMerchant(app);
    const { id, key } = await createTestApiKey(app, m.merchantId);
    await call({ authorization: `Bearer ${key}` });
    await new Promise((r) => setTimeout(r, 200));
    const [row] = await app.db.select().from(schema.apiKeys).where(eq(schema.apiKeys.id, id));
    expect(row?.lastUsedAt).toBeTruthy();
  });
});
