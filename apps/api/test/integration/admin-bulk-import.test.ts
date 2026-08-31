import AdmZip from 'adm-zip';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { adminAuthHeader } from '../helpers/admin.js';
import { buildTestApp, type TestApp } from '../helpers/api.js';
import { type Containers, startContainers } from '../helpers/containers.js';

const CONFIG_KEY = 'config:system';

describe('POST /admin/assets/bulk-import', () => {
  let c: Containers;
  let app: TestApp;
  let adminAuth: Record<string, string>;
  let base: string;

  beforeAll(async () => {
    c = await startContainers();
    app = await buildTestApp(c);
    adminAuth = await adminAuthHeader(app, 'SUPER_ADMIN');
    await app.ready();
    const addr = app.server.address();
    base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await c?.stop();
  });

  afterEach(async () => {
    await app.redis.del(CONFIG_KEY);
  });

  function zipWithEntry(entryName: string, content: Buffer): Buffer {
    const zip = new AdmZip();
    zip.addFile(entryName, content);
    return zip.toBuffer();
  }

  it('rejects a ZIP above the admin-configured bulk-import limit', async () => {
    await app.redis.set(CONFIG_KEY, JSON.stringify({ uploadLimits: { bulkImportMaxBytes: 100 } }));

    const zipBuf = zipWithEntry('backgrounds/bg1.jpg', Buffer.alloc(1000, 1));
    const form = new FormData();
    form.set('file', new Blob([zipBuf], { type: 'application/zip' }), 'assets.zip');

    const res = await fetch(`${base}/admin/assets/bulk-import`, {
      method: 'POST',
      headers: adminAuth,
      body: form,
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toContain('MB limit');
  });

  it('accepts a ZIP within the admin-configured bulk-import limit', async () => {
    await app.redis.set(
      CONFIG_KEY,
      JSON.stringify({ uploadLimits: { bulkImportMaxBytes: 10 * 1024 * 1024 } }),
    );

    const zipBuf = zipWithEntry('backgrounds/bg2.jpg', Buffer.alloc(1000, 1));
    const form = new FormData();
    form.set('file', new Blob([zipBuf], { type: 'application/zip' }), 'assets.zip');
    form.set('genderSlug', 'men');

    const res = await fetch(`${base}/admin/assets/bulk-import`, {
      method: 'POST',
      headers: adminAuth,
      body: form,
    });
    expect(res.status).toBe(200);
  });
});
