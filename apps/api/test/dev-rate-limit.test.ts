import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from './helpers/api.js';
import { type Containers, startContainers } from './helpers/containers.js';
import { createTestApiKey, createTestMerchant } from './helpers/merchant.js';

let c: Containers;
let app: TestApp;
let base: string;
let keyA: string;
let keyB: string;

beforeAll(async () => {
  c = await startContainers();
  app = await buildTestApp(c);
  await app.ready();
  const addr = app.server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

  const a = await createTestMerchant(app);
  const b = await createTestMerchant(app);
  ({ key: keyA } = await createTestApiKey(app, a.merchantId));
  ({ key: keyB } = await createTestApiKey(app, b.merchantId));
});

afterAll(async () => {
  await app.close();
  await c.stop();
});

const hit = (token: string) =>
  fetch(`${base}/v1/dev/categories`, { headers: { authorization: `Bearer ${token}` } });

describe('per-key rate limit', () => {
  it('allows up to 60 requests then returns 429 with Retry-After', async () => {
    let last: Response | undefined;
    for (let i = 0; i < 61; i++) last = await hit(keyA);
    expect(last?.status).toBe(429);
    expect(last?.headers.get('retry-after')).toBeTruthy();
    const body = await last!.json();
    expect(body.error.code).toBe('RATE_LIMIT');
  });

  // The limiter must bucket per key, not per IP — every test here shares one IP,
  // so an IP-keyed limiter would wrongly throttle key B after key A's burst.
  it('does not throttle a different key sharing the same IP', async () => {
    expect((await hit(keyB)).status).toBe(200);
  });
});
