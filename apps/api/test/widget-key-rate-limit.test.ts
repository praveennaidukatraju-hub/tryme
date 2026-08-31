import { DEV_WIDGET_KEY_RATE_LIMIT_PER_MIN } from '@tryme/types';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppError } from '../src/lib/errors.js';
import { assertWidgetKeyRateLimit } from '../src/lib/widget-key-rate-limit.js';
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
  app = await buildTestApp(c);
  await app.ready();
  const addr = app.server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

afterAll(async () => {
  await app.close();
  await c.stop();
});

describe('assertWidgetKeyRateLimit', () => {
  it('allows up to the configured per-minute limit, then throws RATE_LIMITED', async () => {
    const apiKeyId = 'test-widget-key-rate-limit';
    for (let i = 0; i < DEV_WIDGET_KEY_RATE_LIMIT_PER_MIN; i++) {
      await expect(assertWidgetKeyRateLimit(app, apiKeyId)).resolves.toBeUndefined();
    }
    await expect(assertWidgetKeyRateLimit(app, apiKeyId)).rejects.toThrow(AppError);
    try {
      await assertWidgetKeyRateLimit(app, apiKeyId);
    } catch (err) {
      expect((err as AppError).code).toBe('RATE_LIMITED');
    }
  });

  it('does not throttle a different key sharing the same window', async () => {
    await expect(assertWidgetKeyRateLimit(app, 'other-key-1')).resolves.toBeUndefined();
    await expect(assertWidgetKeyRateLimit(app, 'other-key-2')).resolves.toBeUndefined();
  });
});

describe('widget key rate limit on /v1/dev/tryon', () => {
  it('throttles a widget key that exceeds the per-minute limit', async () => {
    const m = await createTestMerchant(app, { balance: 1000, jobRateLimitPerMin: 1000 });
    const { key } = await createTestApiKey(app, m.merchantId, {
      scope: 'widget',
      integration: 'wordpress',
    });
    await createTestDevTryonCategory(app, { slug: `rl-wp-${m.merchantId}` });

    const jpegBytes = () =>
      Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);
    const form = () => {
      const fd = new FormData();
      fd.set('category', `rl-wp-${m.merchantId}`);
      fd.set('person', new Blob([jpegBytes()], { type: 'image/jpeg' }), 'p.jpg');
      fd.set('garment', new Blob([jpegBytes()], { type: 'image/jpeg' }), 'g.jpg');
      return fd;
    };

    const responses: Response[] = [];
    for (let i = 0; i < DEV_WIDGET_KEY_RATE_LIMIT_PER_MIN + 10; i++) {
      responses.push(
        await fetch(`${base}/v1/dev/tryon`, {
          method: 'POST',
          headers: { authorization: `Bearer ${key}` },
          body: form(),
        }),
      );
    }
    expect(responses.some((r) => r.status === 429)).toBe(true);
    expect(responses.some((r) => r.status === 202)).toBe(true);
  });
});
