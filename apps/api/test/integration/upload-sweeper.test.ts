import { schema } from '@tryme/db';
import { keys } from '@tryme/storage';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runUploadSweepTick } from '../../src/modules/uploads/sweeper.js';
import { buildTestApp, type TestApp } from '../helpers/api';
import { type Containers, startContainers } from '../helpers/containers';

describe('runUploadSweepTick', () => {
  let c: Containers;
  let app: TestApp;
  beforeAll(async () => {
    c = await startContainers();
    app = await buildTestApp(c);
  }, 60000);
  afterAll(async () => {
    await app?.close();
    await c?.stop();
  });

  it('deletes an unreferenced inputs/ object once past the age cutoff', async () => {
    const orphanKey = keys.inputGarment('sweeper-orphan');
    await app.storage.putObject(orphanKey, Buffer.from('x'), 'image/jpeg');

    const result = await runUploadSweepTick(app, { maxAgeMs: 0 });
    expect(result.deleted).toBeGreaterThanOrEqual(1);

    await expect(app.storage.headObject(orphanKey)).rejects.toThrow();
  });

  it('leaves an object alone when a job_inputs row still references it', async () => {
    const referencedKey = keys.inputGarment('sweeper-referenced');
    await app.storage.putObject(referencedKey, Buffer.from('x'), 'image/jpeg');

    const [user] = await app.db
      .insert(schema.users)
      .values({ email: 'sweeper-owner@x.com', emailVerified: true, tier: 'free' })
      .returning();
    const [job] = await app.db.insert(schema.jobs).values({ userId: user.id }).returning();
    await app.db.insert(schema.jobInputs).values({
      jobId: job.id,
      upperGarmentKey: referencedKey,
    });

    await runUploadSweepTick(app, { maxAgeMs: 0 });

    const head = await app.storage.headObject(referencedKey);
    expect(head.contentLength).toBeGreaterThan(0);
  });

  it('leaves a recent unreferenced object alone (default 24h cutoff)', async () => {
    const freshKey = keys.inputGarment('sweeper-fresh');
    await app.storage.putObject(freshKey, Buffer.from('x'), 'image/jpeg');

    await runUploadSweepTick(app);

    const head = await app.storage.headObject(freshKey);
    expect(head.contentLength).toBeGreaterThan(0);
  });
});
