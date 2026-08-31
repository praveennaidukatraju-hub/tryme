import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from '../helpers/api';
import { type Containers, startContainers } from '../helpers/containers';

const SAMPLE_SAREE_JSON: Record<string, unknown> = {
  '950': {
    inputs: { filename_prefix: 'sareedraping', images: ['949:8', 0] },
    class_type: 'SaveImage',
    _meta: { title: 'save-result' },
  },
  '951': {
    inputs: { image: 'person.png' },
    class_type: 'LoadImage',
    _meta: { title: 'person' },
  },
  '952': {
    inputs: { image: 'saree.jpg' },
    class_type: 'LoadImage',
    _meta: { title: 'flatsaree' },
  },
};

describe('saree jobs', () => {
  let c: Containers;
  let app: TestApp;
  let realHeadObject: typeof app.storage.headObject | undefined;
  beforeAll(async () => {
    c = await startContainers();
    app = await buildTestApp(c);
    realHeadObject = app.storage.headObject?.bind(app.storage);
  }, 60_000);
  afterAll(async () => {
    await app?.close();
    await c?.stop();
  });
  beforeEach(async () => {
    await app.redis.del('jobs:normal');
    await app.redis.del('jobs:priority');
    // Clean any prior saree_settings / saree workflow rows.
    await app.db.delete(schema.sareeSettings);
    await app.db
      .delete(schema.workflowTemplates)
      .where(eq(schema.workflowTemplates.workflowType, 'saree'));
    // Stub HEAD so assertOwnsUploadKey's existence check passes without a real upload.
    // For the FORBIDDEN path the owner check throws before HEAD anyway.
    app.storage.headObject = (async () => ({
      contentLength: 1024,
    })) as typeof app.storage.headObject;
  });
  afterEach(() => {
    if (realHeadObject) app.storage.headObject = realHeadObject;
  });

  async function registerUser(email: string) {
    await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { displayName: 'Saree User', email, password: 'password123' },
    });
    // Skip the email verification round-trip — mark verified in DB and login for a real JWT.
    await app.db
      .update(schema.users)
      .set({ emailVerified: true })
      .where(eq(schema.users.email, email));
    const login = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { email, password: 'password123' },
    });
    const accessToken = login.json().accessToken as string;
    const userId = JSON.parse(atob(accessToken.split('.')[1])).sub as string;
    return { token: accessToken, userId };
  }

  async function grantCredits(userId: string, amount: number) {
    await app.db
      .insert(schema.userCredits)
      .values({ userId, balance: amount })
      .onConflictDoUpdate({ target: schema.userCredits.userId, set: { balance: amount } });
  }

  // Binds an upload key in Redis so assertOwnsUploadKey's owner check passes.
  // The HEAD check is stubbed in beforeEach, so no real R2 object is needed.
  async function bindUploadKey(userId: string, key: string) {
    await app.redis.set(`upload:owner:${key}`, userId, 'EX', 3600);
  }

  async function seedSareeConfig() {
    await app.db.insert(schema.sareeSettings).values({
      modelImageKey: 'saree/global/model.jpg',
      modelImageThumbKey: 'saree/global/model.thumb.jpg',
    });
    await app.db.insert(schema.workflowTemplates).values({
      slug: 'saree-default',
      label: 'Saree default',
      workflowType: 'saree',
      jsonContent: SAMPLE_SAREE_JSON,
      isActive: true,
      // The saree flow uses the tryon*_node_id columns (per spec).
      tryonPersonNodeId: '951',
      tryonGarmentNodeId: '952',
      tryonOutputNodeId: '950',
      // workflowTemplates has several NOT NULL columns without defaults that
      // the saree flow doesn't actually use. Stub them to satisfy the schema.
      faceNodeId: '951',
      poseNodeId: '951',
      bgNodeId: '951',
      upperNodeIds: ['952'],
      facePhasePromptNode: '951',
      garmentPhasePromptNode: '951',
    });
  }

  it('rejects with NOT_CONFIGURED when model image is missing', async () => {
    const { token, userId } = await registerUser('saree-noconf@x.com');
    await grantCredits(userId, 100);
    const key = `inputs/${userId}/garment.jpg`;
    await bindUploadKey(userId, key);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/saree',
      headers: { authorization: `Bearer ${token}` },
      payload: { garmentKey: key },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('NOT_CONFIGURED');
  });

  it('rejects with CONFIG when active workflow is missing', async () => {
    const { token, userId } = await registerUser('saree-nowf@x.com');
    await grantCredits(userId, 100);
    await app.db.insert(schema.sareeSettings).values({ modelImageKey: 'saree/global/model.jpg' });
    const key = `inputs/${userId}/garment.jpg`;
    await bindUploadKey(userId, key);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/saree',
      headers: { authorization: `Bearer ${token}` },
      payload: { garmentKey: key },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('CONFIG');
  });

  it('rejects with FORBIDDEN when garmentKey is owned by another user', async () => {
    const { token, userId } = await registerUser('saree-other@x.com');
    await grantCredits(userId, 100);
    await seedSareeConfig();
    const foreignKey = `inputs/other-user/garment.jpg`;
    await app.redis.set(`upload:owner:${foreignKey}`, 'someone-else', 'EX', 3600);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/saree',
      headers: { authorization: `Bearer ${token}` },
      payload: { garmentKey: foreignKey },
    });
    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('FORBIDDEN');
  });

  it('happy path: deducts 5 credits, inserts job+inputs, XADDs to jobs:normal', async () => {
    const { token, userId } = await registerUser('saree-happy@x.com');
    await grantCredits(userId, 100);
    await seedSareeConfig();
    const key = `inputs/${userId}/garment.jpg`;
    await bindUploadKey(userId, key);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/jobs/saree',
      headers: { authorization: `Bearer ${token}` },
      payload: { garmentKey: key },
    });
    expect(res.statusCode).toBe(201);
    const { jobId, catalogueId } = res.json();
    expect(jobId).toBeTruthy();
    expect(catalogueId).toBeTruthy();

    const [job] = await app.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
    expect(job.status).toBe('QUEUED');
    expect(job.creditsCharged).toBe(5);
    expect(job.source).toBe('saree');

    const [bal] = await app.db
      .select()
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, userId));
    expect(bal.balance).toBe(95);

    const [inputs] = await app.db
      .select()
      .from(schema.jobInputs)
      .where(eq(schema.jobInputs.jobId, jobId));
    expect(inputs.upperGarmentKey).toBe(key);
    const params = inputs.params as Record<string, unknown>;
    expect(params.kind).toBe('saree');
    expect(params.modelKey).toBe('saree/global/model.jpg');
    expect(typeof params.workflowTemplateId).toBe('string');

    const len = await app.redis.xlen('jobs:normal');
    expect(len).toBeGreaterThanOrEqual(1);
  });

  it('refunds credits and marks FAILED on enqueue failure', async () => {
    const { token, userId } = await registerUser('saree-fail@x.com');
    await grantCredits(userId, 100);
    await seedSareeConfig();
    const key = `inputs/${userId}/garment.jpg`;
    await bindUploadKey(userId, key);

    // Force xadd to throw.
    const realXadd = app.redis.xadd.bind(app.redis);
    app.redis.xadd = (async () => {
      throw new Error('redis down');
    }) as typeof app.redis.xadd;

    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/jobs/saree',
        headers: { authorization: `Bearer ${token}` },
        payload: { garmentKey: key },
      });
      expect(res.statusCode).toBe(503);

      const [bal] = await app.db
        .select()
        .from(schema.userCredits)
        .where(eq(schema.userCredits.userId, userId));
      expect(bal.balance).toBe(100); // refund

      const [job] = await app.db.select().from(schema.jobs).where(eq(schema.jobs.userId, userId));
      expect(job.status).toBe('FAILED');
      expect(job.errorCode).toBe('ENQUEUE_FAIL');
    } finally {
      app.redis.xadd = realXadd;
    }
  });
});
