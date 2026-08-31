import { randomUUID } from 'node:crypto';
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveWorkflowTemplateVersion } from '../../src/workflow/resolve-template-version.js';
import { setupTestEnv, type TestEnv } from '../helpers/containers.js';

describe('resolveWorkflowTemplateVersion', () => {
  let env: TestEnv;

  beforeAll(async () => {
    env = await setupTestEnv();
  }, 60_000);

  afterAll(async () => {
    await env.cleanup();
  });

  async function seedTemplate(
    overrides: Partial<typeof schema.workflowTemplates.$inferInsert> = {},
  ) {
    const [row] = await env.db
      .insert(schema.workflowTemplates)
      .values({
        slug: `resolver-test-${randomUUID()}`,
        label: 'Resolver test template',
        jsonContent: { live: true },
        poseNodeId: 'live-pose',
        upperNodeIds: ['live-upper'],
        garmentPhasePromptNode: 'live-prompt',
        ...overrides,
      })
      .returning();
    if (!row) throw new Error('failed to seed template');
    return row;
  }

  it('returns the live row when snapshotVersion is null', async () => {
    const template = await seedTemplate();
    const resolved = await resolveWorkflowTemplateVersion(env.db, template.id, null);
    expect(resolved?.jsonContent).toEqual({ live: true });
    expect(resolved?.version).toBe(1);
  });

  it('returns the live row when snapshotVersion matches the current version', async () => {
    const template = await seedTemplate();
    const resolved = await resolveWorkflowTemplateVersion(env.db, template.id, 1);
    expect(resolved?.jsonContent).toEqual({ live: true });
  });

  it('returns the archived row when snapshotVersion is older than the live version', async () => {
    const template = await seedTemplate();
    await env.db.insert(schema.workflowTemplateArchives).values({
      workflowTemplateId: template.id,
      version: 1,
      jsonContent: { archived: true },
      poseNodeId: 'archived-pose',
      upperNodeIds: ['archived-upper'],
      garmentPhasePromptNode: 'archived-prompt',
    });
    await env.db
      .update(schema.workflowTemplates)
      .set({ jsonContent: { live: 'new' }, version: 2, poseNodeId: 'new-pose' })
      .where(eq(schema.workflowTemplates.id, template.id));

    const resolved = await resolveWorkflowTemplateVersion(env.db, template.id, 1);
    expect(resolved?.jsonContent).toEqual({ archived: true });
    expect(resolved?.poseNodeId).toBe('archived-pose');
    // Fields the archive doesn't own (id, isActive, slug) still come from the live row.
    expect(resolved?.id).toBe(template.id);
  });

  it('throws a clear error when the referenced archive no longer exists', async () => {
    const template = await seedTemplate();
    await env.db
      .update(schema.workflowTemplates)
      .set({ version: 2 })
      .where(eq(schema.workflowTemplates.id, template.id));

    await expect(resolveWorkflowTemplateVersion(env.db, template.id, 1)).rejects.toThrow(
      /version 1 was archived but no longer exists/,
    );
  });

  it('returns undefined when the template does not exist at all', async () => {
    const resolved = await resolveWorkflowTemplateVersion(env.db, randomUUID(), null);
    expect(resolved).toBeUndefined();
  });
});
