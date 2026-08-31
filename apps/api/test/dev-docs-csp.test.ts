import { createHash } from 'node:crypto';
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

// Scalar's docs page inlines a bootstrap <script> (Scalar.createApiReference(...)).
// helmet's CSP hash-pins it in server.ts rather than using 'unsafe-inline' -- if the
// pinned hash ever drifts from the script's actual content (Scalar package bump, a
// registration option change, anything), the browser silently blocks the script and
// the page renders blank. No API-level error, no console log a curl/fetch check would
// ever see -- this test exists so that drift fails CI instead of shipping a white
// screen to production.
describe('GET /v1/dev/docs CSP', () => {
  it('the pinned script-src hash matches the actual inline bootstrap script', async () => {
    const res = await fetch(`${base}/v1/dev/docs/`);
    expect(res.status).toBe(200);
    const html = await res.text();

    // One <script>...</script> at a time -- (?:(?!<\/script>)[\s\S])* stops at the
    // first </script> it sees, so this never spans across separate script tags the
    // way a naive non-greedy [\s\S]*? can (that bug shipped a wrong hash once already).
    const scriptTagRe = /<script(?:\s[^>]*)?>((?:(?!<\/script>)[\s\S])*)<\/script>/g;
    const bootstrapScript = [...html.matchAll(scriptTagRe)]
      .map((m) => m[1])
      .find((content) => content.includes('Scalar.createApiReference'));
    if (!bootstrapScript) {
      throw new Error('expected to find the Scalar bootstrap <script> in the page');
    }

    const actualHash = createHash('sha256').update(bootstrapScript).digest('base64');

    const csp = res.headers.get('content-security-policy') ?? '';
    expect(csp, 'expected a content-security-policy header on the docs page').not.toBe('');
    expect(
      csp,
      `pinned script-src hash in server.ts is stale -- update it to 'sha256-${actualHash}'`,
    ).toContain(`'sha256-${actualHash}'`);
  });
});
