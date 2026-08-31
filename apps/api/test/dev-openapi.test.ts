import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from './helpers/api.js';
import { type Containers, startContainers } from './helpers/containers.js';

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

describe('GET /v1/dev/openapi.json', () => {
  it('documents every dev endpoint', async () => {
    const res = await fetch(`${base}/v1/dev/openapi.json`);
    expect(res.status).toBe(200);
    const spec = await res.json();
    expect(Object.keys(spec.paths)).toEqual(
      expect.arrayContaining([
        '/v1/dev/tryon',
        '/v1/dev/jobs/{id}',
        '/v1/dev/categories',
        '/v1/dev/me',
      ]),
    );
  });

  // Information disclosure: the spec is public, so it must never describe the
  // admin, auth, or merchant surface.
  it('exposes no non-dev routes', async () => {
    const spec = await (await fetch(`${base}/v1/dev/openapi.json`)).json();
    for (const path of Object.keys(spec.paths)) {
      expect(path.startsWith('/v1/dev/')).toBe(true);
    }
  });

  it('declares bearer API key security', async () => {
    const spec = await (await fetch(`${base}/v1/dev/openapi.json`)).json();
    expect(spec.components.securitySchemes).toHaveProperty('apiKey');
  });
});

describe('GET /v1/dev/docs', () => {
  it('serves the reference UI', async () => {
    const res = await fetch(`${base}/v1/dev/docs`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });
});
