import { schema } from '@tryme/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateApiKey } from '../src/modules/dev/keys.js';
import { buildTestApp, type TestApp } from './helpers/api.js';
import { type Containers, startContainers } from './helpers/containers.js';
import { createTestMerchant } from './helpers/merchant.js';

let c: Containers;
let app: TestApp;

beforeAll(async () => {
  c = await startContainers();
  app = await buildTestApp(c);
  await app.ready();
});

afterAll(async () => {
  await app.close();
  await c.stop();
});

describe('api_keys scope/integration columns', () => {
  it('defaults to full scope and generic integration', async () => {
    const m = await createTestMerchant(app);
    const { keyHash, keyPrefix } = generateApiKey();
    const [row] = await app.db
      .insert(schema.apiKeys)
      .values({ merchantId: m.merchantId, label: 'test', keyHash, keyPrefix })
      .returning();
    expect(row?.scope).toBe('full');
    expect(row?.integration).toBe('generic');
  });

  it('persists an explicit widget scope and wordpress integration', async () => {
    const m = await createTestMerchant(app);
    const { keyHash, keyPrefix } = generateApiKey();
    const [row] = await app.db
      .insert(schema.apiKeys)
      .values({
        merchantId: m.merchantId,
        label: 'wp widget',
        keyHash,
        keyPrefix,
        scope: 'widget',
        integration: 'wordpress',
      })
      .returning();
    expect(row?.scope).toBe('widget');
    expect(row?.integration).toBe('wordpress');
  });
});
