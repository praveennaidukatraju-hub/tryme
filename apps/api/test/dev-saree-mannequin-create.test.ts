import { schema } from '@tryme/db';
import { JOB_SOURCE } from '@tryme/types';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from './helpers/api.js';
import { type Containers, startContainers } from './helpers/containers.js';
import {
  createTestApiKey,
  createTestDevSareeMannequinConfig,
  createTestMerchant,
} from './helpers/merchant.js';

let c: Containers;
let app: TestApp;
let base: string;
let key: string;
let userId: string;
let setCredits: (n: number) => Promise<void>;

const jpegBytes = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(64)]);

function form(opts: { garment?: Buffer; garmentType?: string } = {}) {
  const fd = new FormData();
  fd.set(
    'garment',
    new Blob([opts.garment ?? jpegBytes()], { type: opts.garmentType ?? 'image/jpeg' }),
    'garment.jpg',
  );
  return fd;
}

const post = (fd: FormData, token = key) =>
  fetch(`${base}/v1/dev/saree-mannequin`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
    body: fd,
  });

const postJson = (body: unknown, token = key) =>
  fetch(`${base}/v1/dev/saree-mannequin`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

beforeAll(async () => {
  c = await startContainers();
  app = await buildTestApp(c);
  await app.ready();
  const addr = app.server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

  const m = await createTestMerchant(app, { balance: 100 });
  userId = m.userId;
  setCredits = m.credits;
  ({ key } = await createTestApiKey(app, m.merchantId));

  await createTestDevSareeMannequinConfig(app);
});

afterAll(async () => {
  await app.close();
  await c.stop();
});

const balance = async () => {
  const [row] = await app.db
    .select()
    .from(schema.userCredits)
    .where(eq(schema.userCredits.userId, userId));
  return row?.balance ?? 0;
};

describe('POST /v1/dev/saree-mannequin', () => {
  it('creates a queued job, deducts credits, and writes the saree_mannequin job shape', async () => {
    const before = await balance();
    const res = await post(form());
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.status).toBe('QUEUED');

    const [job] = await app.db.select().from(schema.jobs).where(eq(schema.jobs.id, body.jobId));
    expect(job?.source).toBe(JOB_SOURCE.API_SAREE_MANNEQUIN);
    expect(job?.apiKeyId).toBeTruthy();
    expect(job?.watermark).toBe(false);
    expect(await balance()).toBe(before - job!.creditsCharged);

    const [inputs] = await app.db
      .select()
      .from(schema.jobInputs)
      .where(eq(schema.jobInputs.jobId, body.jobId));
    expect(inputs!.upperGarmentKey).toBeTruthy();
    expect(inputs!.garmentTypeId).toBeNull();
    expect(inputs!.faceId).toBeNull();
    expect(inputs!.backgroundId).toBeNull();
    expect(inputs!.poseId).toBeNull();
    const params = inputs!.params as Record<string, unknown>;
    expect(params.kind).toBe('saree_mannequin');
    expect(params.workflowTemplateId).toBeTruthy();
  });

  it('enqueues the job on jobs:normal', async () => {
    const res = await post(form());
    const { jobId } = await res.json();
    const entries = await app.redis.xrange('jobs:normal', '-', '+');
    const ids = entries.flatMap(([, fields]) => {
      const i = fields.indexOf('jobId');
      return i >= 0 ? [fields[i + 1]] : [];
    });
    expect(ids).toContain(jobId);
  });

  it('rejects an unauthenticated request with 401', async () => {
    const res = await fetch(`${base}/v1/dev/saree-mannequin`, { method: 'POST', body: form() });
    expect(res.status).toBe(401);
  });

  it('rejects a non-image disguised with an image content-type', async () => {
    const before = await balance();
    const res = await post(
      form({ garment: Buffer.from('#!/bin/sh\nrm -rf /', 'utf8'), garmentType: 'image/jpeg' }),
    );
    expect(res.status).toBe(400);
    expect(await balance()).toBe(before);
  });

  it('rejects a request missing the garment file with 400', async () => {
    const fd = new FormData();
    expect((await post(fd)).status).toBe(400);
  });

  it('returns 402 when the merchant has insufficient credits', async () => {
    await setCredits(0);
    const res = await post(form());
    expect(res.status).toBe(402);
    const body = await res.json();
    expect(body.error.code).toBe('INSUFFICIENT_CREDITS');
    await setCredits(100);
  });
});

describe('POST /v1/dev/saree-mannequin upload limit', () => {
  afterEach(async () => {
    await app.redis.del('config:system');
  });

  it('rejects a garment file above the admin-configured limit', async () => {
    await app.redis.set('config:system', JSON.stringify({ uploadLimits: { devApiMaxBytes: 10 } }));
    const res = await post(form({ garment: Buffer.alloc(1024) }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.message).toContain('MB limit');
  });
});

describe('POST /v1/dev/saree-mannequin (JSON/base64 body)', () => {
  it('creates a queued job', async () => {
    const before = await balance();
    const res = await postJson({ garment: jpegBytes().toString('base64') });
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.status).toBe('QUEUED');
    expect(await balance()).toBeLessThan(before);
  });

  it('accepts a data: URI prefix', async () => {
    const b64 = jpegBytes().toString('base64');
    const res = await postJson({ garment: `data:image/jpeg;base64,${b64}` });
    expect(res.status).toBe(202);
  });

  it('rejects malformed base64 with 400', async () => {
    const res = await postJson({ garment: '!!!not-base64!!!' });
    expect(res.status).toBe(400);
  });
});

describe('POST /v1/dev/saree-mannequin (unconfigured)', () => {
  it('rejects with 400 and does not move credits when no dev saree mannequin config is active', async () => {
    // Fresh merchant/app instance with no createTestDevSareeMannequinConfig call.
    const c2 = await startContainers();
    const app2 = await buildTestApp(c2);
    try {
      await app2.ready();
      const addr2 = app2.server.address();
      const base2 = `http://127.0.0.1:${typeof addr2 === 'object' && addr2 ? addr2.port : 0}`;
      const m2 = await createTestMerchant(app2, { balance: 100 });
      const { key: key2 } = await createTestApiKey(app2, m2.merchantId);

      const before = await app2.db
        .select()
        .from(schema.userCredits)
        .where(eq(schema.userCredits.userId, m2.userId));

      const res = await fetch(`${base2}/v1/dev/saree-mannequin`, {
        method: 'POST',
        headers: { authorization: `Bearer ${key2}` },
        body: form(),
      });
      expect(res.status).toBe(400);

      const after = await app2.db
        .select()
        .from(schema.userCredits)
        .where(eq(schema.userCredits.userId, m2.userId));
      expect(after[0]?.balance).toBe(before[0]?.balance);
    } finally {
      await app2.close();
      await c2.stop();
    }
  });
});
