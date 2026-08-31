import { schema } from '@tryme/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveMannequinGarmentKey } from '../../src/modules/jobs/create.js';
import { buildTestApp, type TestApp } from '../helpers/api';
import { type Containers, startContainers } from '../helpers/containers';

describe('resolveMannequinGarmentKey', () => {
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

  async function seedUser(email: string) {
    const [user] = await app.db
      .insert(schema.users)
      .values({ email, emailVerified: true, tier: 'free' })
      .returning();
    return user.id;
  }

  async function seedMannequinJob(userId: string, status: string, kind = 'saree_mannequin') {
    const [job] = await app.db
      .insert(schema.jobs)
      .values({ userId, status: status as never, priority: false, creditsCharged: 0 })
      .returning();
    await app.db.insert(schema.jobInputs).values({
      jobId: job.id,
      upperGarmentKey: 'inputs/x/garment.jpg',
      params: { kind },
    });
    return job.id;
  }

  it('returns keys.output(jobId) for a completed, owned, saree_mannequin job', async () => {
    const userId = await seedUser('resolve-happy@x.com');
    const jobId = await seedMannequinJob(userId, 'COMPLETED');
    const key = await resolveMannequinGarmentKey(app, userId, jobId);
    expect(key).toBe(`outputs/${jobId}/result.png`);
  });

  it('rejects a job owned by a different user', async () => {
    const ownerId = await seedUser('resolve-owner@x.com');
    const otherId = await seedUser('resolve-other@x.com');
    const jobId = await seedMannequinJob(ownerId, 'COMPLETED');
    await expect(resolveMannequinGarmentKey(app, otherId, jobId)).rejects.toThrow();
  });

  it('rejects a job that is not yet COMPLETED', async () => {
    const userId = await seedUser('resolve-pending@x.com');
    const jobId = await seedMannequinJob(userId, 'QUEUED');
    await expect(resolveMannequinGarmentKey(app, userId, jobId)).rejects.toThrow();
  });

  it('rejects a job that is not kind=saree_mannequin', async () => {
    const userId = await seedUser('resolve-wrong-kind@x.com');
    const jobId = await seedMannequinJob(userId, 'COMPLETED', 'catalog');
    await expect(resolveMannequinGarmentKey(app, userId, jobId)).rejects.toThrow();
  });
});
