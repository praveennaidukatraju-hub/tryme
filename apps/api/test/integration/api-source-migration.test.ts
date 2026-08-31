import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { schema } from '@tryme/db';
import { LEGACY_JOB_SOURCE } from '@tryme/types';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from '../helpers/api.js';
import { type Containers, startContainers } from '../helpers/containers.js';

const MIGRATION_PATH = fileURLToPath(
  new URL(
    '../../../../packages/db/src/migrations/0133_backfill_api_source_split.sql',
    import.meta.url,
  ),
);

describe('0133_backfill_api_source_split.sql — classification', () => {
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

  it('classifies legacy api rows into api_saree_mannequin / api_catalog / api_tryon', async () => {
    // Row A: saree-mannequin shape (params.kind)
    const [jobA] = await app.db
      .insert(schema.jobs)
      .values({ source: LEGACY_JOB_SOURCE.API, creditsCharged: 1 })
      .returning();
    await app.db.insert(schema.jobInputs).values({
      jobId: jobA.id,
      params: { kind: 'saree_mannequin' },
    });

    // Row B: catalog shape (resolved face)
    const [face] = await app.db
      .insert(schema.modelFaces)
      .values({
        gender: 'women',
        label: 'test face',
        r2Key: 'test/face.jpg',
        thumbnailKey: 'test/face-thumb.jpg',
      })
      .returning();
    const [jobB] = await app.db
      .insert(schema.jobs)
      .values({ source: LEGACY_JOB_SOURCE.API, creditsCharged: 1 })
      .returning();
    await app.db.insert(schema.jobInputs).values({
      jobId: jobB.id,
      faceId: face.id,
    });

    // Row C: tryon-direct shape (neither signal — no job_inputs row at all,
    // matching the two real test fixtures updated in Task 11)
    const [jobC] = await app.db
      .insert(schema.jobs)
      .values({ source: LEGACY_JOB_SOURCE.API, creditsCharged: 1 })
      .returning();

    const sql = postgres(c.pgUrl, { max: 1 });
    const migrationSql = readFileSync(MIGRATION_PATH, 'utf8');
    await sql.unsafe(migrationSql);
    await sql.end();

    const [rowA] = await app.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobA.id));
    const [rowB] = await app.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobB.id));
    const [rowC] = await app.db.select().from(schema.jobs).where(eq(schema.jobs.id, jobC.id));

    expect(rowA.source).toBe('api_saree_mannequin');
    expect(rowB.source).toBe('api_catalog');
    expect(rowC.source).toBe('api_tryon');
  });
});
