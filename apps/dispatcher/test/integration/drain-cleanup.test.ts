import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { createLogger } from '@tryme/logger';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  checkAndCleanupArchiveForJob,
  maybeCleanupArchive,
} from '../../src/workflow/drain-cleanup.js';
import { setupTestEnv, type TestEnv } from '../helpers/containers.js';

describe('maybeCleanupArchive', () => {
  let env: TestEnv;

  beforeAll(async () => {
    env = await setupTestEnv();
  }, 60_000);

  afterAll(async () => {
    await env.cleanup();
  });

  async function seedTemplateWithArchive() {
    const [template] = await env.db
      .insert(schema.workflowTemplates)
      .values({
        slug: `drain-test-${randomUUID()}`,
        label: 'Drain test template',
        jsonContent: {},
        poseNodeId: 'p',
        upperNodeIds: [],
        garmentPhasePromptNode: 'g',
        version: 2,
      })
      .returning();
    if (!template) throw new Error('failed to seed template');
    await env.db.insert(schema.workflowTemplateArchives).values({
      workflowTemplateId: template.id,
      version: 1,
      jsonContent: {},
      poseNodeId: 'p',
      upperNodeIds: [],
      garmentPhasePromptNode: 'g',
    });
    return template;
  }

  async function seedJobAtVersion(templateId: string, version: number, status: string) {
    const [user] = await env.db
      .insert(schema.users)
      .values({ email: `drain-${randomUUID()}@test.com`, passwordHash: 'x', tier: 'free' })
      .returning();
    if (!user) throw new Error('failed to seed user');
    const [job] = await env.db
      .insert(schema.jobs)
      .values({ userId: user.id, status, source: 'tryon' })
      .returning();
    if (!job) throw new Error('failed to seed job');
    await env.db.insert(schema.jobInputs).values({
      jobId: job.id,
      poseNodeId: undefined,
      params: { workflowTemplateId: templateId, dispatchTemplateVersion: version },
    } as typeof schema.jobInputs.$inferInsert);
    return job;
  }

  it('does not delete the archive while a non-terminal job still references it', async () => {
    const template = await seedTemplateWithArchive();
    await seedJobAtVersion(template.id, 1, 'QUEUED');

    await maybeCleanupArchive(env.db, template.id, 1);

    const [archive] = await env.db
      .select()
      .from(schema.workflowTemplateArchives)
      .where(eq(schema.workflowTemplateArchives.workflowTemplateId, template.id));
    expect(archive).toBeDefined();
  });

  it('deletes the archive once every referencing job is terminal', async () => {
    const template = await seedTemplateWithArchive();
    await seedJobAtVersion(template.id, 1, 'COMPLETED');

    await maybeCleanupArchive(env.db, template.id, 1);

    const [archive] = await env.db
      .select()
      .from(schema.workflowTemplateArchives)
      .where(eq(schema.workflowTemplateArchives.workflowTemplateId, template.id));
    expect(archive).toBeUndefined();
  });
});

describe('checkAndCleanupArchiveForJob', () => {
  let env: TestEnv;
  const log = createLogger('test');

  beforeAll(async () => {
    env = await setupTestEnv();
  }, 60_000);

  afterAll(async () => {
    await env.cleanup();
  });

  it('resolves the job-stamped version and archive-template pair, then cleans up once no other job holds it', async () => {
    const [template] = await env.db
      .insert(schema.workflowTemplates)
      .values({
        slug: `checkcleanup-${randomUUID()}`,
        label: 'Check cleanup template',
        jsonContent: {},
        poseNodeId: 'p',
        upperNodeIds: [],
        garmentPhasePromptNode: 'g',
        version: 2,
      })
      .returning();
    if (!template) throw new Error('failed to seed template');
    await env.db.insert(schema.workflowTemplateArchives).values({
      workflowTemplateId: template.id,
      version: 1,
      jsonContent: {},
      poseNodeId: 'p',
      upperNodeIds: [],
      garmentPhasePromptNode: 'g',
    });

    const [user] = await env.db
      .insert(schema.users)
      .values({ email: `checkcleanup-${randomUUID()}@test.com`, passwordHash: 'x', tier: 'free' })
      .returning();
    if (!user) throw new Error('failed to seed user');
    const [job] = await env.db
      .insert(schema.jobs)
      .values({ userId: user.id, status: 'COMPLETED', source: 'tryon' })
      .returning();
    if (!job) throw new Error('failed to seed job');
    await env.db.insert(schema.jobInputs).values({
      jobId: job.id,
      params: { workflowTemplateId: template.id, dispatchTemplateVersion: 1 },
    });

    await checkAndCleanupArchiveForJob(env.db, job.id, log);

    const [archive] = await env.db
      .select()
      .from(schema.workflowTemplateArchives)
      .where(eq(schema.workflowTemplateArchives.workflowTemplateId, template.id));
    expect(archive).toBeUndefined();
  });

  it('is a no-op (does not throw) for a job with no dispatchTemplateVersion stamp', async () => {
    const [user] = await env.db
      .insert(schema.users)
      .values({
        email: `checkcleanup-noop-${randomUUID()}@test.com`,
        passwordHash: 'x',
        tier: 'free',
      })
      .returning();
    if (!user) throw new Error('failed to seed user');
    const [job] = await env.db
      .insert(schema.jobs)
      .values({ userId: user.id, status: 'COMPLETED', source: 'catalog' })
      .returning();
    if (!job) throw new Error('failed to seed job');
    await env.db.insert(schema.jobInputs).values({ jobId: job.id, params: {} });

    await expect(checkAndCleanupArchiveForJob(env.db, job.id, log)).resolves.toBeUndefined();
  });
});
