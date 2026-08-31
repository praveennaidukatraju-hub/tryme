import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signAccess } from '../../src/modules/auth/service.js';
import { buildTestApp, type TestApp } from '../helpers/api';
import { type Containers, startContainers } from '../helpers/containers';

describe('PATCH /admin/assets/garment-types/:id — mannequin-step fields', () => {
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

  async function registerAdmin(email: string) {
    const [user] = await app.db
      .insert(schema.users)
      .values({ email, emailVerified: true, tier: 'free' })
      .returning();
    await app.db.insert(schema.adminUsers).values({ userId: user.id, role: 'SUPER_ADMIN' });
    const secret = new TextEncoder().encode(app.env.JWT_SECRET);
    const accessToken = await signAccess(
      secret,
      user.id,
      { kind: 'access' },
      app.env.JWT_EXPIRY,
      'admin',
    );
    return accessToken;
  }

  async function seedWorkflow(workflowType: string) {
    const [row] = await app.db
      .insert(schema.workflowTemplates)
      .values({
        slug: `wf-${workflowType}-${Date.now()}`,
        label: 'WF',
        jsonContent: {},
        workflowType,
        faceNodeId: '',
        poseNodeId: '',
        bgNodeId: '',
        upperNodeIds: [],
        facePhasePromptNode: '',
        garmentPhasePromptNode: '',
      })
      .returning();
    return row.id;
  }

  it('persists requiresMannequinStep + both workflow template FKs', async () => {
    const token = await registerAdmin('gt-mannequin-admin@x.com');
    const step1Id = await seedWorkflow('saree_step1');
    const step2Id = await seedWorkflow('regular');
    const [gt] = await app.db
      .insert(schema.garmentSubcategories)
      .values({ genderSlug: 'women', slug: 'flat-saree-test', label: 'Flat Saree' })
      .returning();

    const res = await app.inject({
      method: 'PATCH',
      url: `/admin/assets/garment-types/${gt.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        requiresMannequinStep: true,
        mannequinWorkflowTemplateId: step1Id,
        sareeStep2WorkflowTemplateId: step2Id,
      },
    });
    expect(res.statusCode).toBe(200);

    const [row] = await app.db
      .select()
      .from(schema.garmentSubcategories)
      .where(eq(schema.garmentSubcategories.id, gt.id));
    expect(row?.requiresMannequinStep).toBe(true);
    expect(row?.mannequinWorkflowTemplateId).toBe(step1Id);
    expect(row?.sareeStep2WorkflowTemplateId).toBe(step2Id);
  });

  it('persists mannequinTwoInputWorkflowTemplateId', async () => {
    const token = await registerAdmin('gt-mannequin-two-input-admin@x.com');
    const twoInputId = await seedWorkflow('saree_step1_two_input');
    const [gt] = await app.db
      .insert(schema.garmentSubcategories)
      .values({ genderSlug: 'women', slug: 'flat-saree-two-input-test', label: 'Flat Saree' })
      .returning();

    const res = await app.inject({
      method: 'PATCH',
      url: `/admin/assets/garment-types/${gt.id}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { mannequinTwoInputWorkflowTemplateId: twoInputId },
    });
    expect(res.statusCode).toBe(200);

    const [row] = await app.db
      .select()
      .from(schema.garmentSubcategories)
      .where(eq(schema.garmentSubcategories.id, gt.id));
    expect(row?.mannequinTwoInputWorkflowTemplateId).toBe(twoInputId);
  });
});
