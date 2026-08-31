import { schema } from '@tryme/db';
import { keys } from '@tryme/storage';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signAccess } from '../../src/modules/auth/service.js';
import { buildTestApp, type TestApp } from '../helpers/api.js';
import { type Containers, startContainers } from '../helpers/containers.js';

// Tryon-direct results (source='tryon'/'api_tryon') are stored WebP-encoded, not
// PNG (see apps/dispatcher/src/workflow/finalize.ts). GET /result, GET /thumbnail
// (fallback), and DELETE must all read the job's actual job_outputs.resultKey
// instead of reconstructing keys.output(id) — otherwise they operate on a .png
// key that was never uploaded: broken presigned URLs, and a silent R2 leak on
// delete (the wrong-key deleteObject call fails and is swallowed).
describe('GET /v1/jobs/:id/result, /thumbnail, DELETE /v1/jobs/:id — webp-aware key resolution', () => {
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

  async function registerUser(email: string) {
    const [user] = await app.db
      .insert(schema.users)
      .values({ email, emailVerified: true })
      .returning();
    const token = await signAccess(
      new TextEncoder().encode(app.env.JWT_SECRET),
      user.id,
      { kind: 'access' },
      app.env.JWT_EXPIRY,
    );
    return { token, userId: user.id };
  }

  // Seeds a COMPLETED job whose job_outputs.resultKey is a webp key that differs
  // from what keys.output(jobId) would reconstruct — the exact shape a real
  // tryon-direct job leaves behind.
  async function seedCompletedWebpJob(userId: string, opts?: { withThumbnail?: boolean }) {
    const [job] = await app.db
      .insert(schema.jobs)
      .values({ userId, status: 'COMPLETED', creditsCharged: 5, source: 'tryon' })
      .returning();
    const resultKey = keys.output(job.id, 'webp');
    await app.storage.putObject(resultKey, Buffer.from('stub-webp-bytes'), 'image/webp');
    await app.db.insert(schema.jobOutputs).values({
      jobId: job.id,
      resultKey,
      thumbnailKey: opts?.withThumbnail ? keys.outputThumb(job.id) : null,
    });
    return { jobId: job.id as string, resultKey };
  }

  it('GET /result presigns the stored webp resultKey, not a reconstructed .png key', async () => {
    const { token, userId } = await registerUser('result-webp@x.com');
    const { jobId } = await seedCompletedWebpJob(userId);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/jobs/${jobId}/result`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const { url } = res.json();
    expect(url).toContain(`${jobId}/result.webp`);
    expect(url).not.toContain(`${jobId}/result.png`);
  });

  it('GET /thumbnail falls back to the stored webp resultKey when no thumbnail was generated', async () => {
    const { token, userId } = await registerUser('thumb-webp-fallback@x.com');
    const { jobId } = await seedCompletedWebpJob(userId, { withThumbnail: false });

    const res = await app.inject({
      method: 'GET',
      url: `/v1/jobs/${jobId}/thumbnail`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    const { url } = res.json();
    expect(url).toContain(`${jobId}/result.webp`);
    expect(url).not.toContain(`${jobId}/result.png`);
  });

  it('DELETE removes the actual stored webp object, not a nonexistent .png key', async () => {
    const { token, userId } = await registerUser('delete-webp@x.com');
    const { jobId, resultKey } = await seedCompletedWebpJob(userId);

    // Sanity: the real object exists before delete.
    await expect(app.storage.headObject(resultKey)).resolves.toBeDefined();

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/jobs/${jobId}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(204);

    // The critical assertion: the correct (webp) object was actually deleted.
    // Before the fix, DELETE targeted keys.output(id) (.png), which never
    // existed — the object at resultKey would silently leak forever.
    await expect(app.storage.headObject(resultKey)).rejects.toThrow();

    const [job] = await app.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobId));
    expect(job).toBeUndefined();
  });
});
