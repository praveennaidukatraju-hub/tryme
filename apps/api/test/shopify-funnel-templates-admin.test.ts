import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminAuthHeader } from './helpers/admin.js';
import { buildTestApp, type TestApp } from './helpers/api.js';
import { type Containers, startContainers } from './helpers/containers.js';

let c: Containers;
let app: TestApp;
let adminHeaders: Record<string, string>;
let workflowTemplateId: string;

beforeAll(async () => {
  c = await startContainers();
  app = await buildTestApp(c);
  adminHeaders = await adminAuthHeader(app, 'SUPER_ADMIN');
  const [wf] = await app.db
    .insert(schema.workflowTemplates)
    .values({
      slug: 'admin-funnel-test',
      label: 'Test WF',
      jsonContent: {},
      faceNodeId: 'x',
      poseNodeId: 'x',
      bgNodeId: 'x',
      upperNodeIds: [],
      facePhasePromptNode: 'x',
      garmentPhasePromptNode: 'x',
      workflowType: 'tryon',
    })
    .returning();
  workflowTemplateId = wf.id;
});
afterAll(async () => {
  await app?.close();
  await c?.stop();
});

describe('admin shopify funnel templates CRUD', () => {
  it('creates, lists, and patches a funnel template', async () => {
    const createRes = await app.inject({
      method: 'POST',
      url: '/admin/shopify/funnel-templates',
      headers: adminHeaders,
      payload: {
        slug: 'upper-garment',
        label: 'Upper Garment',
        workflowTemplateId,
        sortOrder: 1,
      },
    });
    expect(createRes.statusCode).toBe(200);
    const created = createRes.json();
    expect(created.label).toBe('Upper Garment');
    expect(created.isActive).toBe(true);

    const listRes = await app.inject({
      method: 'GET',
      url: '/admin/shopify/funnel-templates',
      headers: adminHeaders,
    });
    expect(listRes.statusCode).toBe(200);
    expect(listRes.json().items.some((i: { id: string }) => i.id === created.id)).toBe(true);

    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/admin/shopify/funnel-templates/${created.id}`,
      headers: adminHeaders,
      payload: { label: 'Upper Garment (renamed)', isActive: false },
    });
    expect(patchRes.statusCode).toBe(200);

    const [row] = await app.db
      .select()
      .from(schema.shopifyFunnelTemplates)
      .where(eq(schema.shopifyFunnelTemplates.id, created.id));
    expect(row.label).toBe('Upper Garment (renamed)');
    expect(row.isActive).toBe(false);
  });

  it('rejects a duplicate slug', async () => {
    await app.inject({
      method: 'POST',
      url: '/admin/shopify/funnel-templates',
      headers: adminHeaders,
      payload: { slug: 'dup-slug', label: 'First', workflowTemplateId, sortOrder: 0 },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/admin/shopify/funnel-templates',
      headers: adminHeaders,
      payload: { slug: 'dup-slug', label: 'Second', workflowTemplateId, sortOrder: 0 },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toContain('dup-slug');
  });

  it('promotes a template to default and demotes the previous one atomically', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/admin/shopify/funnel-templates',
      headers: adminHeaders,
      payload: { slug: 'default-a', label: 'A', workflowTemplateId, sortOrder: 0, isDefault: true },
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().isDefault).toBe(true);

    const second = await app.inject({
      method: 'POST',
      url: '/admin/shopify/funnel-templates',
      headers: adminHeaders,
      payload: { slug: 'default-b', label: 'B', workflowTemplateId, sortOrder: 1, isDefault: true },
    });
    expect(second.statusCode).toBe(200);

    const rows = await app.db
      .select()
      .from(schema.shopifyFunnelTemplates)
      .where(eq(schema.shopifyFunnelTemplates.isDefault, true));
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(second.json().id);
  });

  it('refuses to clear the last default', async () => {
    const [current] = await app.db
      .select()
      .from(schema.shopifyFunnelTemplates)
      .where(eq(schema.shopifyFunnelTemplates.isDefault, true));
    expect(current).toBeDefined();

    const res = await app.inject({
      method: 'PATCH',
      url: `/admin/shopify/funnel-templates/${current.id}`,
      headers: adminHeaders,
      payload: { isDefault: false },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('default');

    const [still] = await app.db
      .select()
      .from(schema.shopifyFunnelTemplates)
      .where(eq(schema.shopifyFunnelTemplates.id, current.id));
    expect(still.isDefault).toBe(true);
  });

  it('refuses to deactivate the current default', async () => {
    const [current] = await app.db
      .select()
      .from(schema.shopifyFunnelTemplates)
      .where(eq(schema.shopifyFunnelTemplates.isDefault, true));
    expect(current).toBeDefined();

    const res = await app.inject({
      method: 'PATCH',
      url: `/admin/shopify/funnel-templates/${current.id}`,
      headers: adminHeaders,
      payload: { isActive: false },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.message).toContain('default');
    expect(res.json().error.message).toContain('active');

    const [still] = await app.db
      .select()
      .from(schema.shopifyFunnelTemplates)
      .where(eq(schema.shopifyFunnelTemplates.id, current.id));
    expect(still.isDefault).toBe(true);
    expect(still.isActive).toBe(true);
  });

  it('reports whether a default exists so admin can surface it', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/shopify/funnel-templates',
      headers: adminHeaders,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().hasDefault).toBe(true);
  });
});
