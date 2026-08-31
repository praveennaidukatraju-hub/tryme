import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { getShopifyPackCredits, getShopifyTrialCredits } from '../src/lib/resolution-config.js';
import { buildTestApp, type TestApp } from './helpers/api.js';
import { type Containers, startContainers } from './helpers/containers.js';

const CONFIG_KEY = 'config:system';

describe('getShopifyTrialCredits', () => {
  let c: Containers;
  let app: TestApp;

  beforeAll(async () => {
    c = await startContainers();
    app = await buildTestApp(c);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await c?.stop();
  });

  afterEach(async () => {
    await app.redis.del(CONFIG_KEY);
  });

  it('falls back to the default (25) when nothing is stored', async () => {
    expect(await getShopifyTrialCredits(app)).toBe(25);
  });

  it('reads the admin-configured value', async () => {
    await app.redis.set(CONFIG_KEY, JSON.stringify({ shopify: { trialCredits: 40 } }));
    expect(await getShopifyTrialCredits(app)).toBe(40);
  });

  it('falls back to the default when the stored value is malformed', async () => {
    await app.redis.set(CONFIG_KEY, 'not json');
    expect(await getShopifyTrialCredits(app)).toBe(25);
  });

  it('falls back to the default when shopify.trialCredits is not a number', async () => {
    await app.redis.set(CONFIG_KEY, JSON.stringify({ shopify: { trialCredits: 'lots' } }));
    expect(await getShopifyTrialCredits(app)).toBe(25);
  });
});

describe('getShopifyPackCredits', () => {
  let c: Containers;
  let app: TestApp;

  beforeAll(async () => {
    c = await startContainers();
    app = await buildTestApp(c);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await c?.stop();
  });

  afterEach(async () => {
    await app.redis.del(CONFIG_KEY);
  });

  it('falls back to the default amount for each known pack id when nothing is stored', async () => {
    expect(await getShopifyPackCredits(app, 'pack_10', 'manual')).toBe(800);
    expect(await getShopifyPackCredits(app, 'pack_25', 'manual')).toBe(2250);
    expect(await getShopifyPackCredits(app, 'pack_50', 'manual')).toBe(4800);
  });

  it('reads the autorefill figure, distinct from the manual one, when nothing is stored', async () => {
    expect(await getShopifyPackCredits(app, 'pack_10', 'autorefill')).toBe(880);
    expect(await getShopifyPackCredits(app, 'pack_25', 'autorefill')).toBe(2475);
  });

  it('returns null for an unrecognized pack id', async () => {
    expect(await getShopifyPackCredits(app, 'pack_999', 'manual')).toBeNull();
    expect(await getShopifyPackCredits(app, '', 'manual')).toBeNull();
  });

  it('reads an admin-configured override for one pack, leaving others at default', async () => {
    await app.redis.set(
      CONFIG_KEY,
      JSON.stringify({ shopify: { packCredits: { pack_10: { credits: 900 } } } }),
    );
    expect(await getShopifyPackCredits(app, 'pack_10', 'manual')).toBe(900);
    expect(await getShopifyPackCredits(app, 'pack_25', 'manual')).toBe(2250);
    // Overriding the manual figure must not affect the separate autorefill one.
    expect(await getShopifyPackCredits(app, 'pack_10', 'autorefill')).toBe(880);
  });

  it('falls back to the default when the stored value is malformed', async () => {
    await app.redis.set(CONFIG_KEY, 'not json');
    expect(await getShopifyPackCredits(app, 'pack_50', 'manual')).toBe(4800);
  });
});
