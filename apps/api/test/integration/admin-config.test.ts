import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_SELLER_CONFIG } from '../../src/lib/resolution-config.js';
import { adminAuthHeader } from '../helpers/admin.js';
import { buildTestApp, type TestApp } from '../helpers/api.js';
import { type Containers, startContainers } from '../helpers/containers.js';

const CONFIG_KEY = 'config:system';

describe('admin config', () => {
  let c: Containers;
  let app: TestApp;
  let adminAuth: Record<string, string>;

  beforeAll(async () => {
    c = await startContainers();
    app = await buildTestApp(c);
    adminAuth = await adminAuthHeader(app, 'SUPER_ADMIN');
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await c?.stop();
  });

  afterEach(async () => {
    await app.redis.del(CONFIG_KEY);
  });

  it('GET /admin/config default-fills uploadLimits, and PATCH persists a partial override', async () => {
    const getRes = await app.inject({
      method: 'GET',
      url: '/admin/config',
      headers: adminAuth,
    });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().uploadLimits.merchantCatalogMaxBytes).toBe(20 * 1024 * 1024);
    expect(getRes.json().uploadLimits.bulkImportMaxBytes).toBe(2.5 * 1024 * 1024 * 1024);

    const patchRes = await app.inject({
      method: 'PATCH',
      url: '/admin/config',
      headers: { ...adminAuth, 'content-type': 'application/json' },
      payload: JSON.stringify({ uploadLimits: { devApiMaxBytes: 5 * 1024 * 1024 } }),
    });
    expect(patchRes.statusCode).toBe(200);

    const getRes2 = await app.inject({
      method: 'GET',
      url: '/admin/config',
      headers: adminAuth,
    });
    expect(getRes2.json().uploadLimits.devApiMaxBytes).toBe(5 * 1024 * 1024);
    // Untouched fields still default-fill correctly alongside the override.
    expect(getRes2.json().uploadLimits.merchantCatalogMaxBytes).toBe(20 * 1024 * 1024);
  });

  it('GET /admin/config default-fills pixverse cost, and PATCH persists an override', async () => {
    const getRes = await app.inject({ method: 'GET', url: '/admin/config', headers: adminAuth });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().pixverse.creditCost).toBe(150);

    const patchRes = await app.inject({
      method: 'PATCH',
      url: '/admin/config',
      headers: { ...adminAuth, 'content-type': 'application/json' },
      payload: JSON.stringify({ pixverse: { creditCost: 35 } }),
    });
    expect(patchRes.statusCode).toBe(200);

    const getRes2 = await app.inject({ method: 'GET', url: '/admin/config', headers: adminAuth });
    expect(getRes2.json().pixverse.creditCost).toBe(35);
  });

  it('GET /admin/config default-fills shopify trial credits, and PATCH persists an override', async () => {
    const getRes = await app.inject({ method: 'GET', url: '/admin/config', headers: adminAuth });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().shopify.trialCredits).toBe(25);

    const patchRes = await app.inject({
      method: 'PATCH',
      url: '/admin/config',
      headers: { ...adminAuth, 'content-type': 'application/json' },
      payload: JSON.stringify({ shopify: { trialCredits: 50 } }),
    });
    expect(patchRes.statusCode).toBe(200);

    const getRes2 = await app.inject({ method: 'GET', url: '/admin/config', headers: adminAuth });
    expect(getRes2.json().shopify.trialCredits).toBe(50);
  });

  it('GET /admin/config default-fills shopify pack credits, and a partial PATCH keeps other packs/fields at default', async () => {
    const getRes = await app.inject({ method: 'GET', url: '/admin/config', headers: adminAuth });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().shopify.packCredits).toEqual({
      pack_10: { credits: 800, autorefillCredits: 880 },
      pack_25: { credits: 2250, autorefillCredits: 2475 },
      pack_50: { credits: 4800, autorefillCredits: 5280 },
      pack_100: { credits: 10000, autorefillCredits: 11000 },
    });

    const patchRes = await app.inject({
      method: 'PATCH',
      url: '/admin/config',
      headers: { ...adminAuth, 'content-type': 'application/json' },
      payload: JSON.stringify({ shopify: { packCredits: { pack_10: { credits: 3000 } } } }),
    });
    expect(patchRes.statusCode).toBe(200);

    const getRes2 = await app.inject({ method: 'GET', url: '/admin/config', headers: adminAuth });
    expect(getRes2.json().shopify.packCredits).toEqual({
      pack_10: { credits: 3000, autorefillCredits: 880 },
      pack_25: { credits: 2250, autorefillCredits: 2475 },
      pack_50: { credits: 4800, autorefillCredits: 5280 },
      pack_100: { credits: 10000, autorefillCredits: 11000 },
    });
  });

  it('GET /admin/config default-fills maxBatchJobs, and PATCH persists an override', async () => {
    const getRes = await app.inject({ method: 'GET', url: '/admin/config', headers: adminAuth });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().maxBatchJobs).toBe(200);

    const patchRes = await app.inject({
      method: 'PATCH',
      url: '/admin/config',
      headers: { ...adminAuth, 'content-type': 'application/json' },
      payload: JSON.stringify({ maxBatchJobs: 350 }),
    });
    expect(patchRes.statusCode).toBe(200);

    const getRes2 = await app.inject({ method: 'GET', url: '/admin/config', headers: adminAuth });
    expect(getRes2.json().maxBatchJobs).toBe(350);
  });

  it('PATCH accepts merchantCatalogDefaults with lowerCatalogId and shoeCatalogId', async () => {
    const patchRes = await app.inject({
      method: 'PATCH',
      url: '/admin/config',
      headers: { ...adminAuth, 'content-type': 'application/json' },
      payload: JSON.stringify({
        merchantCatalogDefaults: {
          men: {
            faceId: '11111111-1111-1111-1111-111111111111',
            backgroundId: '22222222-2222-2222-2222-222222222222',
            lowerCatalogId: '33333333-3333-3333-3333-333333333333',
            shoeCatalogId: '44444444-4444-4444-4444-444444444444',
          },
        },
      }),
    });
    expect(patchRes.statusCode).toBe(200);

    const getRes = await app.inject({ method: 'GET', url: '/admin/config', headers: adminAuth });
    expect(getRes.json().merchantCatalogDefaults.men.lowerCatalogId).toBe(
      '33333333-3333-3333-3333-333333333333',
    );
    expect(getRes.json().merchantCatalogDefaults.men.shoeCatalogId).toBe(
      '44444444-4444-4444-4444-444444444444',
    );
  });

  it('GET /admin/config default-fills seller details, and PATCH persists an override', async () => {
    const getRes = await app.inject({ method: 'GET', url: '/admin/config', headers: adminAuth });
    expect(getRes.statusCode).toBe(200);
    expect(getRes.json().seller).toEqual(DEFAULT_SELLER_CONFIG);

    const patchRes = await app.inject({
      method: 'PATCH',
      url: '/admin/config',
      headers: { ...adminAuth, 'content-type': 'application/json' },
      payload: JSON.stringify({
        seller: {
          gstin: '27AAPFU0939F1ZV',
          legalName: 'Tryme Technologies Pvt Ltd',
          address: '123 Example St, Mumbai',
        },
      }),
    });
    expect(patchRes.statusCode).toBe(200);

    // PATCH stores exactly the fields sent, and GET re-default-fills
    // whatever it didn't override (pan/tan/udyamRegNo here) from the same
    // DEFAULT_SELLER_CONFIG — a partial override isn't a full replacement.
    const getRes2 = await app.inject({ method: 'GET', url: '/admin/config', headers: adminAuth });
    expect(getRes2.json().seller).toEqual({
      ...DEFAULT_SELLER_CONFIG,
      gstin: '27AAPFU0939F1ZV',
      legalName: 'Tryme Technologies Pvt Ltd',
      address: '123 Example St, Mumbai',
    });
  });
});
