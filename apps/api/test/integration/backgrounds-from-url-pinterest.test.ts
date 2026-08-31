import dns from 'node:dns/promises';
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { pinnedFetch } from '../../src/lib/pinned-fetch.js';
import { signAccess } from '../../src/modules/auth/service.js';
import { buildTestApp, type TestApp } from '../helpers/api';
import { type Containers, startContainers } from '../helpers/containers';

vi.mock('../../src/lib/pinned-fetch.js', () => ({ pinnedFetch: vi.fn() }));

// DNS lookups are stubbed so tests don't depend on real network/DNS resolution --
// only the real Pinterest response *shapes* observed via live curl during development
// (redirect chain, og:image meta tag attribute layout) are what's under test here.
const PUBLIC_IP = '203.0.113.10';

describe('POST /v1/backgrounds/mine/from-url (Pinterest links)', () => {
  let c: Containers;
  let app: TestApp;
  let fixtureJpeg: Buffer;
  beforeAll(async () => {
    c = await startContainers();
    app = await buildTestApp(c);
    fixtureJpeg = await sharp({
      create: { width: 32, height: 32, channels: 3, background: { r: 10, g: 200, b: 30 } },
    })
      .jpeg()
      .toBuffer();
  }, 60000);
  afterAll(async () => {
    await app?.close();
    await c?.stop();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  async function getToken(email: string) {
    const [user] = await app.db
      .insert(schema.users)
      .values({ email, emailVerified: true, tier: 'free' })
      .returning();
    const secret = new TextEncoder().encode(app.env.JWT_SECRET);
    return signAccess(secret, user.id, { kind: 'access' }, app.env.JWT_EXPIRY);
  }

  function stubDns() {
    vi.spyOn(dns, 'lookup').mockResolvedValue([{ address: PUBLIC_IP, family: 4 }]);
  }

  const OG_IMAGE_HTML = `<html><head>
    <meta content="https://i.pinimg.com/736x/fake.jpg" data-app="true" name="og:image" property="og:image"/>
    <meta content="1308" data-app="true" name="og:image:height" property="og:image:height"/>
  </head></html>`;

  it('scrapes og:image from a direct pinterest.com pin page URL', async () => {
    const token = await getToken('bgpin1@x.com');
    stubDns();
    vi.mocked(pinnedFetch).mockImplementation(async (url: URL) => {
      const href = url.toString();
      if (href.startsWith('https://in.pinterest.com/pin/998814023593088411/')) {
        return new Response(OG_IMAGE_HTML, {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
      if (href === 'https://i.pinimg.com/736x/fake.jpg') {
        return new Response(fixtureJpeg, {
          status: 200,
          headers: {
            'content-type': 'image/jpeg',
            'content-length': String(fixtureJpeg.length),
          },
        });
      }
      throw new Error(`unexpected fetch: ${href}`);
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/backgrounds/mine/from-url',
      headers: { authorization: `Bearer ${token}` },
      payload: { url: 'https://in.pinterest.com/pin/998814023593088411/' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    const [row] = await app.db
      .select()
      .from(schema.modelBackgrounds)
      .where(eq(schema.modelBackgrounds.id, body.id));
    expect(row?.scope).toBe('user');
  });

  it('follows a pin.it short link through multiple redirect hops before scraping og:image', async () => {
    const token = await getToken('bgpin2@x.com');
    stubDns();
    vi.mocked(pinnedFetch).mockImplementation(async (url: URL) => {
      const href = url.toString();
      if (href === 'https://pin.it/j99OcC4Y4') {
        return new Response(null, {
          status: 308,
          headers: { location: 'https://api.pinterest.com/url_shortener/j99OcC4Y4/redirect/' },
        });
      }
      if (href === 'https://api.pinterest.com/url_shortener/j99OcC4Y4/redirect/') {
        return new Response(null, {
          status: 302,
          headers: {
            location:
              'https://www.pinterest.com/pin/998814023593088411/sent/?invite_code=abc&sender=1&sfo=1',
          },
        });
      }
      if (
        href ===
        'https://www.pinterest.com/pin/998814023593088411/sent/?invite_code=abc&sender=1&sfo=1'
      ) {
        return new Response(OG_IMAGE_HTML, {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
      if (href === 'https://i.pinimg.com/736x/fake.jpg') {
        return new Response(fixtureJpeg, {
          status: 200,
          headers: {
            'content-type': 'image/jpeg',
            'content-length': String(fixtureJpeg.length),
          },
        });
      }
      throw new Error(`unexpected fetch: ${href}`);
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/backgrounds/mine/from-url',
      headers: { authorization: `Bearer ${token}` },
      payload: { url: 'https://pin.it/j99OcC4Y4' },
    });
    expect(res.statusCode).toBe(200);
  });

  it('rejects a pinterest page with no og:image meta tag', async () => {
    const token = await getToken('bgpin3@x.com');
    stubDns();
    vi.mocked(pinnedFetch).mockResolvedValue(
      new Response('<html><head></head></html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      }),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/v1/backgrounds/mine/from-url',
      headers: { authorization: `Bearer ${token}` },
      payload: { url: 'https://in.pinterest.com/pin/000000000000000000/' },
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a redirect chain exceeding the hop cap', async () => {
    const token = await getToken('bgpin4@x.com');
    stubDns();
    vi.mocked(pinnedFetch).mockImplementation(async () => {
      return new Response(null, {
        status: 302,
        headers: { location: 'https://pin.it/loop' },
      });
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/backgrounds/mine/from-url',
      headers: { authorization: `Bearer ${token}` },
      payload: { url: 'https://pin.it/loop' },
    });
    expect(res.statusCode).toBe(400);
  });
});
