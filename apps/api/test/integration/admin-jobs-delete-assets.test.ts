import { schema } from '@tryme/db';
import { keys } from '@tryme/storage';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminAuthHeader } from '../helpers/admin.js';
import { buildTestApp, type TestApp } from '../helpers/api.js';
import { type Containers, startContainers } from '../helpers/containers.js';

describe('POST /admin/jobs/:id/delete-assets', () => {
  let c: Containers;
  let app: TestApp;
  let superAdminHeader: Record<string, string>;

  beforeAll(async () => {
    c = await startContainers();
    app = await buildTestApp(c);
    superAdminHeader = await adminAuthHeader(app, 'SUPER_ADMIN');
  }, 60_000);
  afterAll(async () => {
    await app?.close();
    await c?.stop();
  });

  // adminAuthHeader always seeds the test admin with this password (see
  // apps/api/test/helpers/admin.ts) — the endpoint re-verifies it, so every
  // test that expects success must pass it back.
  const ADMIN_PASSWORD = 'password123';

  async function seedJob(status: string, source = 'tryon') {
    const [job] = await app.db
      .insert(schema.jobs)
      .values({ status, creditsCharged: 1, source })
      .returning();
    return job;
  }

  async function seedOutput(jobId: string, opts?: { withThumbnail?: boolean }) {
    const resultKey = keys.output(jobId, 'webp');
    await app.storage.putObject(resultKey, Buffer.from('stub-result'), 'image/webp');
    const thumbnailKey = opts?.withThumbnail === false ? null : keys.outputThumb(jobId);
    if (thumbnailKey) {
      await app.storage.putObject(thumbnailKey, Buffer.from('stub-thumb'), 'image/jpeg');
    }
    await app.db.insert(schema.jobOutputs).values({ jobId, resultKey, thumbnailKey });
    return { resultKey, thumbnailKey };
  }

  it('rejects an incorrect password with 403 and changes nothing', async () => {
    const job = await seedJob('COMPLETED');
    const { resultKey } = await seedOutput(job.id);

    const res = await app.inject({
      method: 'POST',
      url: `/admin/jobs/${job.id}/delete-assets`,
      headers: superAdminHeader,
      payload: { password: 'wrong-password', targets: ['result'] },
    });
    expect(res.statusCode).toBe(403);

    await expect(app.storage.headObject(resultKey)).resolves.toBeDefined();
    const [output] = await app.db
      .select()
      .from(schema.jobOutputs)
      .where(eq(schema.jobOutputs.jobId, job.id));
    expect(output?.resultKey).toBe(resultKey);
  });

  it('rejects a non-SUPER_ADMIN caller with 403', async () => {
    const job = await seedJob('COMPLETED');
    await seedOutput(job.id);
    const moderatorHeader = await adminAuthHeader(app, 'MODERATOR');

    const res = await app.inject({
      method: 'POST',
      url: `/admin/jobs/${job.id}/delete-assets`,
      headers: moderatorHeader,
      payload: { password: ADMIN_PASSWORD, targets: ['result'] },
    });
    expect(res.statusCode).toBe(403);
  });

  it('rejects a non-terminal job status with 409', async () => {
    const job = await seedJob('GENERATING');
    await seedOutput(job.id);

    const res = await app.inject({
      method: 'POST',
      url: `/admin/jobs/${job.id}/delete-assets`,
      headers: superAdminHeader,
      payload: { password: ADMIN_PASSWORD, targets: ['result'] },
    });
    expect(res.statusCode).toBe(409);
  });

  it('deletes only the result image + thumbnail, leaving person data and job_inputs alone', async () => {
    const job = await seedJob('COMPLETED');
    const { resultKey, thumbnailKey } = await seedOutput(job.id);
    const customerPhotoKey = `test-photos/${job.id}-customer.jpg`;
    await app.storage.putObject(customerPhotoKey, Buffer.from('stub-photo'), 'image/jpeg');
    await app.db.update(schema.jobs).set({ customerPhotoKey }).where(eq(schema.jobs.id, job.id));
    await app.db
      .insert(schema.jobInputs)
      .values({ jobId: job.id, params: { workflowTemplateId: 'wt-1' } });

    const res = await app.inject({
      method: 'POST',
      url: `/admin/jobs/${job.id}/delete-assets`,
      headers: superAdminHeader,
      payload: { password: ADMIN_PASSWORD, targets: ['result'] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, deleted: ['result'] });

    await expect(app.storage.headObject(resultKey)).rejects.toThrow();
    await expect(app.storage.headObject(thumbnailKey as string)).rejects.toThrow();
    await expect(app.storage.headObject(customerPhotoKey)).resolves.toBeDefined();

    const [output] = await app.db
      .select()
      .from(schema.jobOutputs)
      .where(eq(schema.jobOutputs.jobId, job.id));
    expect(output?.resultKey).toBeNull();
    expect(output?.thumbnailKey).toBeNull();

    const [refreshedJob] = await app.db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.id, job.id));
    expect(refreshedJob?.customerPhotoKey).toBe(customerPhotoKey);
    expect(refreshedJob?.status).toBe('COMPLETED');

    const [inputs] = await app.db
      .select()
      .from(schema.jobInputs)
      .where(eq(schema.jobInputs.jobId, job.id));
    expect(inputs?.params).toEqual({ workflowTemplateId: 'wt-1' });
  });

  it('deletes the customerPhotoKey person image on a merchant-style job', async () => {
    const job = await seedJob('COMPLETED', 'merchant_tryon');
    const customerPhotoKey = `test-photos/${job.id}-customer.jpg`;
    await app.storage.putObject(customerPhotoKey, Buffer.from('stub-photo'), 'image/jpeg');
    await app.db.update(schema.jobs).set({ customerPhotoKey }).where(eq(schema.jobs.id, job.id));

    const res = await app.inject({
      method: 'POST',
      url: `/admin/jobs/${job.id}/delete-assets`,
      headers: superAdminHeader,
      payload: { password: ADMIN_PASSWORD, targets: ['person'] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, deleted: ['person'] });

    await expect(app.storage.headObject(customerPhotoKey)).rejects.toThrow();
    const [refreshedJob] = await app.db
      .select()
      .from(schema.jobs)
      .where(eq(schema.jobs.id, job.id));
    expect(refreshedJob?.customerPhotoKey).toBeNull();
  });

  it('deletes the params.personKey person image on a tryon-direct-style job, keeping other params keys', async () => {
    const job = await seedJob('COMPLETED', 'tryon');
    const personKey = `test-photos/${job.id}-person.jpg`;
    await app.storage.putObject(personKey, Buffer.from('stub-photo'), 'image/jpeg');
    await app.db
      .insert(schema.jobInputs)
      .values({ jobId: job.id, params: { personKey, workflowTemplateId: 'wt-1' } });

    const res = await app.inject({
      method: 'POST',
      url: `/admin/jobs/${job.id}/delete-assets`,
      headers: superAdminHeader,
      payload: { password: ADMIN_PASSWORD, targets: ['person'] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, deleted: ['person'] });

    await expect(app.storage.headObject(personKey)).rejects.toThrow();
    const [inputs] = await app.db
      .select()
      .from(schema.jobInputs)
      .where(eq(schema.jobInputs.jobId, job.id));
    expect(inputs?.params).toEqual({ workflowTemplateId: 'wt-1' });
  });

  it('deletes both result and person in one call and writes an audit row', async () => {
    const job = await seedJob('FAILED', 'merchant_tryon');
    const { resultKey } = await seedOutput(job.id);
    const customerPhotoKey = `test-photos/${job.id}-customer.jpg`;
    await app.storage.putObject(customerPhotoKey, Buffer.from('stub-photo'), 'image/jpeg');
    await app.db.update(schema.jobs).set({ customerPhotoKey }).where(eq(schema.jobs.id, job.id));

    const res = await app.inject({
      method: 'POST',
      url: `/admin/jobs/${job.id}/delete-assets`,
      headers: superAdminHeader,
      payload: { password: ADMIN_PASSWORD, targets: ['result', 'person'] },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { ok: boolean; deleted: string[] };
    expect(body.ok).toBe(true);
    expect(new Set(body.deleted)).toEqual(new Set(['result', 'person']));

    await expect(app.storage.headObject(resultKey)).rejects.toThrow();
    await expect(app.storage.headObject(customerPhotoKey)).rejects.toThrow();

    const auditRows = await app.db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.resourceId, job.id));
    const row = auditRows.find((r) => r.action === 'jobs.delete_assets');
    expect(row).toBeDefined();
    expect(row?.actorRole).toBe('SUPER_ADMIN');
    expect((row?.before as { requestedTargets: string[] })?.requestedTargets).toEqual([
      'result',
      'person',
    ]);
  });
});
