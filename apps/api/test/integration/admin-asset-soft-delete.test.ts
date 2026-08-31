import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminAuthHeader } from '../helpers/admin';
import { buildTestApp, type TestApp } from '../helpers/api';
import { type Containers, startContainers } from '../helpers/containers';

describe('admin asset soft delete', () => {
  let containers: Containers;
  let app: TestApp;
  let headers: Record<string, string>;

  beforeAll(async () => {
    containers = await startContainers();
    app = await buildTestApp(containers);
    headers = await adminAuthHeader(app);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await containers?.stop();
  });

  it('moves a background referenced by a historical job to the recycle bin', async () => {
    const [background] = await app.db
      .insert(schema.modelBackgrounds)
      .values({
        label: 'Historical architecture',
        r2Key: 'test/background.jpg',
        thumbnailKey: 'test/background.thumb.jpg',
      })
      .returning({ id: schema.modelBackgrounds.id });
    if (!background) throw new Error('background insert failed');

    const [job] = await app.db.insert(schema.jobs).values({}).returning({ id: schema.jobs.id });
    if (!job) throw new Error('job insert failed');

    await app.db.insert(schema.jobInputs).values({
      jobId: job.id,
      upperGarmentKey: 'test/garment.jpg',
      backgroundId: background.id,
    });

    const response = await app.inject({
      method: 'DELETE',
      url: `/admin/assets/backgrounds/${background.id}`,
      headers,
    });

    expect(response.statusCode).toBe(200);

    const [deletedBackground] = await app.db
      .select({ deletedAt: schema.modelBackgrounds.deletedAt })
      .from(schema.modelBackgrounds)
      .where(eq(schema.modelBackgrounds.id, background.id));
    expect(deletedBackground?.deletedAt).toBeInstanceOf(Date);

    const [input] = await app.db
      .select({ backgroundId: schema.jobInputs.backgroundId })
      .from(schema.jobInputs)
      .where(eq(schema.jobInputs.jobId, job.id));
    expect(input?.backgroundId).toBe(background.id);
  });
});
