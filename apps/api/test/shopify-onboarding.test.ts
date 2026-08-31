import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { upsertShopifyStore } from '../src/modules/shopify/auth.routes.js';
import { buildThemeEditorDeepLink } from '../src/modules/shopify/onboarding.routes.js';
import { buildTestApp, type TestApp } from './helpers/api.js';
import { type Containers, startContainers } from './helpers/containers.js';
import { signSessionToken } from './helpers/shopify-session.js';

const ENC_KEY = Buffer.alloc(32, 12).toString('base64');
const API_SECRET = 'test-secret';
const API_KEY = 'test-key';
let c: Containers;
let app: TestApp;
let storeId: string;
let token: string;

beforeAll(async () => {
  c = await startContainers();
  app = await buildTestApp(c, {
    SHOPIFY_TOKEN_ENC_KEY: ENC_KEY,
    SHOPIFY_API_SECRET: API_SECRET,
    SHOPIFY_API_KEY: API_KEY,
  });
  const store = await upsertShopifyStore(
    app,
    {
      shopifyShopId: 77,
      shopDomain: 'o.myshopify.com',
      myshopifyDomain: 'o.myshopify.com',
      name: 'O',
      email: 'o@o.com',
    },
    'tok',
    'read_products',
  );
  storeId = store.id;
  token = signSessionToken('o.myshopify.com', API_SECRET, API_KEY);
});
afterAll(async () => {
  await app?.close();
  await c?.stop();
});

describe('buildThemeEditorDeepLink', () => {
  it('targets themes/current and stages the app block', () => {
    expect(buildThemeEditorDeepLink('o.myshopify.com', 'abc123')).toBe(
      'https://o.myshopify.com/admin/themes/current/editor?template=product&addAppBlockId=abc123/tryon-button&target=mainSection',
    );
  });

  it('never needs a theme ID — that lookup requires the read_themes scope we do not hold', () => {
    const url = buildThemeEditorDeepLink('o.myshopify.com', 'abc123');
    expect(url).toContain('/themes/current/');
    expect(url).not.toMatch(/\/themes\/\d+\//);
  });
});

describe('GET /v1/shopify/onboarding/theme-editor-url', () => {
  it('returns the deep link without calling the Shopify Admin API', async () => {
    // A real fetch here would 403 for want of read_themes; the route is pure, so
    // this passes with no network stub in place at all.
    const res = await app.inject({
      method: 'GET',
      url: '/v1/shopify/onboarding/theme-editor-url',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().url).toBe(
      `https://o.myshopify.com/admin/themes/current/editor?template=product&addAppBlockId=${API_KEY}/tryon-button&target=mainSection`,
    );
  });
});

describe('POST /v1/shopify/onboarding/confirm-theme-block', () => {
  it('sets settings.themeBlockConfirmed to true', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/shopify/onboarding/confirm-theme-block',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().settings.themeBlockConfirmed).toBe(true);

    const [row] = await app.db
      .select()
      .from(schema.shopifyStores)
      .where(eq(schema.shopifyStores.id, storeId));
    expect(row.settings.themeBlockConfirmed).toBe(true);
  });

  it('is idempotent — calling it twice does not error', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/v1/shopify/onboarding/confirm-theme-block',
      headers: { authorization: `Bearer ${token}` },
    });
    const second = await app.inject({
      method: 'POST',
      url: '/v1/shopify/onboarding/confirm-theme-block',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().settings.themeBlockConfirmed).toBe(true);
  });
});
