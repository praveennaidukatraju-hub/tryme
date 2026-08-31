import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { upsertShopifyStore } from '../src/modules/shopify/auth.routes.js';
import { buildTestApp, type TestApp } from './helpers/api.js';
import { type Containers, startContainers } from './helpers/containers.js';
import { signSessionToken } from './helpers/shopify-session.js';

const ENC_KEY = Buffer.alloc(32, 11).toString('base64');
const API_SECRET = 'test-secret';
const API_KEY = 'test-key';
let c: Containers;
let app: TestApp;
let storeId: string;
let token: string;

// Every metafieldsSet call in this file goes through the stubbed global fetch,
// following apps/api/test/shopify-catalog-publish.test.ts. Without the stub the
// tests would make real network calls to m.myshopify.com.
function stubShopifyOk() {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ data: { metafieldsSet: { userErrors: [] } } }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    ),
  );
}

function stubShopifyFailure() {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 500 })));
}

function stubShopifyUnauthorized() {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 401 })));
}

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
      shopDomain: 'w.myshopify.com',
      myshopifyDomain: 'w.myshopify.com',
      name: 'W',
      email: 'w@w.com',
    },
    'tok',
    'read_products',
  );
  storeId = store.id;
  token = signSessionToken('w.myshopify.com', API_SECRET, API_KEY);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await app.close();
  await c.stop();
});

async function patch(body: unknown) {
  return app.inject({
    method: 'PATCH',
    url: '/v1/shopify/widget-config',
    headers: { authorization: `Bearer ${token}` },
    payload: body,
  });
}

async function patchSettings(body: unknown) {
  return app.inject({
    method: 'PATCH',
    url: '/v1/shopify/settings',
    headers: { authorization: `Bearer ${token}` },
    payload: body,
  });
}

async function readSettings() {
  const [row] = await app.db
    .select({ settings: schema.shopifyStores.settings })
    .from(schema.shopifyStores)
    .where(eq(schema.shopifyStores.id, storeId));
  return row.settings;
}

describe('PATCH /v1/shopify/widget-config', () => {
  it('stores config and reports synced', async () => {
    stubShopifyOk();
    const res = await patch({ theme: { accentColor: '#123abc' } });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({
      widget: { theme: { accentColor: '#123abc' } },
      synced: true,
    });
    const settings = await readSettings();
    expect(settings.widget?.theme?.accentColor).toBe('#123abc');
    expect(settings.widgetConfigSynced).toBe(true);
  });

  it('merges within a sub-object instead of replacing it', async () => {
    stubShopifyOk();
    await patch({ copy: { heading: 'Hello' } });
    await patch({ copy: { subheading: 'World' } });
    const settings = await readSettings();
    expect(settings.widget?.copy).toEqual({ heading: 'Hello', subheading: 'World' });
  });

  it('serializes concurrent patches so neither config change is lost', async () => {
    stubShopifyOk();
    await app.db
      .update(schema.shopifyStores)
      .set({ settings: {} })
      .where(eq(schema.shopifyStores.id, storeId));

    const [first, second] = await Promise.all([
      patch({ copy: { heading: 'First' } }),
      patch({ copy: { subheading: 'Second' } }),
    ]);

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect((await readSettings()).widget?.copy).toEqual({
      heading: 'First',
      subheading: 'Second',
    });
  });

  it('preserves a concurrent store settings patch', async () => {
    stubShopifyOk();
    await app.db
      .update(schema.shopifyStores)
      .set({ settings: {} })
      .where(eq(schema.shopifyStores.id, storeId));

    const [settingsRes, widgetRes] = await Promise.all([
      patchSettings({ limits: { storeDailyCap: 50 } }),
      patch({ copy: { heading: 'Concurrent' } }),
    ]);

    expect(settingsRes.statusCode).toBe(200);
    expect(widgetRes.statusCode).toBe(200);
    const settings = await readSettings();
    expect(settings.limits?.storeDailyCap).toBe(50);
    expect(settings.widget?.copy?.heading).toBe('Concurrent');
  });

  it('waits to publish the combined config after an in-flight patch', async () => {
    await app.db
      .update(schema.shopifyStores)
      .set({ settings: {} })
      .where(eq(schema.shopifyStores.id, storeId));

    let releaseFirst!: () => void;
    const firstWrite = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted!: () => void;
    const firstStartedPromise = new Promise<void>((resolve) => {
      firstStarted = resolve;
    });
    const published: unknown[] = [];
    const fetchMock = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as {
        variables: { metafields: { value: string }[] };
      };
      const config = JSON.parse(body.variables.metafields[0].value);
      if (published.length === 0) {
        firstStarted();
        await firstWrite;
      }
      published.push(config);
      return new Response(JSON.stringify({ data: { metafieldsSet: { userErrors: [] } } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const first = patch({ copy: { heading: 'First' } });
    await firstStartedPromise;
    const second = patch({ copy: { subheading: 'Second' } });

    await expect
      .poll(async () => (await readSettings()).widget?.copy?.subheading, {
        interval: 10,
        timeout: 1000,
      })
      .toBe('Second');
    expect(fetchMock).toHaveBeenCalledTimes(1);

    releaseFirst();
    const [firstRes, secondRes] = await Promise.all([first, second]);
    expect(firstRes.json().widget).toEqual({ copy: { heading: 'First' } });
    expect(firstRes.json().synced).toBe(false);
    expect(secondRes.json().widget).toEqual({
      copy: { heading: 'First', subheading: 'Second' },
    });
    expect(secondRes.json().synced).toBe(true);
    expect(published).toEqual([
      { copy: { heading: 'First' } },
      { copy: { heading: 'First', subheading: 'Second' } },
    ]);
  });

  it('keeps the Shopify timeout active while parsing the response body', async () => {
    const realSetTimeout = globalThis.setTimeout;
    const realClearTimeout = globalThis.clearTimeout;
    const timeoutHandle = { shopifyTimeout: true } as unknown as ReturnType<typeof setTimeout>;
    let timeoutCancelled = false;
    let fireTimeout!: () => void;
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((
      callback,
      delay,
      ...args
    ) => {
      if (delay === 10_000) {
        fireTimeout = () => {
          if (!timeoutCancelled) (callback as (...callbackArgs: unknown[]) => void)(...args);
        };
        return timeoutHandle;
      }
      return realSetTimeout(callback, delay, ...args);
    }) as typeof setTimeout);
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout').mockImplementation(((handle) => {
      if (handle === timeoutHandle) {
        timeoutCancelled = true;
        return;
      }
      realClearTimeout(handle);
    }) as typeof clearTimeout);

    let bodyStarted!: () => void;
    const bodyStartedPromise = new Promise<void>((resolve) => {
      bodyStarted = resolve;
    });
    let finishBody!: (body: unknown) => void;
    let signal: AbortSignal | null = null;

    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string | URL | Request, init?: RequestInit) => {
        signal = init?.signal ?? null;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            new Promise((resolve, reject) => {
              finishBody = resolve;
              bodyStarted();
              if (signal?.aborted) {
                reject(signal.reason);
                return;
              }
              signal?.addEventListener('abort', () => reject(signal?.reason), { once: true });
            }),
        } as Response);
      }),
    );

    const responsePromise = patch({ copy: { heading: 'Slow body' } });
    await bodyStartedPromise;

    try {
      fireTimeout();
      expect(signal?.aborted).toBe(true);
    } finally {
      finishBody({ data: { metafieldsSet: { userErrors: [] } } });
      await responsePromise;
      setTimeoutSpy.mockRestore();
      clearTimeoutSpy.mockRestore();
    }
  });

  it('does not clobber sibling settings keys', async () => {
    stubShopifyOk();
    await app.db
      .update(schema.shopifyStores)
      .set({
        settings: {
          themeBlockConfirmed: true,
          limits: { storeDailyCap: 50 },
          retention: { resultDays: 30 },
        },
      })
      .where(eq(schema.shopifyStores.id, storeId));

    await patch({ behavior: { addToCart: false } });

    const settings = await readSettings();
    expect(settings.themeBlockConfirmed).toBe(true);
    expect(settings.limits?.storeDailyCap).toBe(50);
    expect(settings.retention?.resultDays).toBe(30);
    expect(settings.widget?.behavior?.addToCart).toBe(false);
  });

  it('rejects a malformed accent color', async () => {
    stubShopifyOk();
    const res = await patch({ theme: { accentColor: 'red' } });
    expect(res.statusCode).toBe(400);
  });

  it('rejects over-length copy', async () => {
    stubShopifyOk();
    const res = await patch({ copy: { heading: 'x'.repeat(61) } });
    expect(res.statusCode).toBe(400);
  });

  it('still saves and returns synced:false when the metafield write fails', async () => {
    stubShopifyFailure();
    const res = await patch({ copy: { ctaLabel: 'Go' } });
    expect(res.statusCode).toBe(200);
    expect(res.json().synced).toBe(false);
    expect((await readSettings()).widget?.copy?.ctaLabel).toBe('Go');
  });

  it('still saves and returns synced:false when the publication lock is unavailable', async () => {
    stubShopifyOk();
    const setSpy = vi.spyOn(app.redis, 'set').mockRejectedValueOnce(new Error('redis unavailable'));

    try {
      const res = await patch({ copy: { heading: 'Saved before Redis failed' } });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({
        widget: { copy: { heading: 'Saved before Redis failed' } },
        synced: false,
      });
      expect((await readSettings()).widget?.copy?.heading).toBe('Saved before Redis failed');
    } finally {
      setSpy.mockRestore();
    }
  });

  it('propagates Shopify reauthorization after saving the config', async () => {
    stubShopifyUnauthorized();

    const res = await patch({ copy: { heading: 'Saved before reauthorization' } });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ error: { code: 'SHOPIFY_REAUTH_REQUIRED' } });
    const settings = await readSettings();
    expect(settings.widget?.copy?.heading).toBe('Saved before reauthorization');
    expect(settings.widgetConfigSynced).toBe(false);
  });
});

describe('POST /v1/shopify/widget-config/republish', () => {
  it('pushes the stored config without writing the row', async () => {
    stubShopifyOk();
    await patch({ copy: { heading: 'Stable' } });
    const before = await readSettings();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/shopify/widget-config/republish',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ synced: true });
    expect(await readSettings()).toEqual(before);
  });
});
