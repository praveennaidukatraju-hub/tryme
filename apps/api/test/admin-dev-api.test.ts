import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminAuthHeader } from './helpers/admin.js';
import { buildTestApp, type TestApp } from './helpers/api.js';
import { type Containers, startContainers } from './helpers/containers.js';
import { createTestDevTryonCategory } from './helpers/merchant.js';

let c: Containers;
let app: TestApp;
let adminHeaders: Record<string, string>;
let wfId: string;

beforeAll(async () => {
  c = await startContainers();
  app = await buildTestApp(c);
  adminHeaders = await adminAuthHeader(app, 'SUPER_ADMIN');
  ({ workflowTemplateId: wfId } = await createTestDevTryonCategory(app, { slug: 'seed-cat' }));
});
afterAll(async () => {
  await app?.close();
  await c?.stop();
});

describe('admin dev-api routes', () => {
  it('creates a dev tryon category', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/dev-api/tryon-categories',
      headers: adminHeaders,
      payload: { name: 'API Upper', slug: 'api-upper', workflowTemplateId: wfId },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().slug).toBe('api-upper');
  });

  it('rejects a duplicate slug with 409', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/admin/dev-api/tryon-categories',
      headers: adminHeaders,
      payload: { name: 'Dup', slug: 'api-upper', workflowTemplateId: wfId },
    });
    expect(res.statusCode).toBe(409);
  });

  it('patches isActive', async () => {
    const [row] = await app.db
      .select({ id: schema.devTryonCategories.id })
      .from(schema.devTryonCategories)
      .where(eq(schema.devTryonCategories.slug, 'api-upper'));
    const res = await app.inject({
      method: 'PATCH',
      url: `/admin/dev-api/tryon-categories/${row!.id}`,
      headers: adminHeaders,
      payload: { isActive: false },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().isActive).toBe(false);
  });

  it('404s patching an unknown category', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/admin/dev-api/tryon-categories/00000000-0000-0000-0000-000000000000',
      headers: adminHeaders,
      payload: { isActive: false },
    });
    expect(res.statusCode).toBe(404);
  });

  it('lists dev tryon categories', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/dev-api/tryon-categories',
      headers: adminHeaders,
    });
    expect(res.statusCode).toBe(200);
    const slugs = res.json().map((c: { slug: string }) => c.slug);
    expect(slugs).toContain('api-upper');
  });

  it('upserts the saree config', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/admin/dev-api/saree-config',
      headers: adminHeaders,
      payload: { workflowTemplateId: wfId, isActive: true },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().workflowTemplateId).toBe(wfId);
  });

  it('reads back the saree config', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/dev-api/saree-config',
      headers: adminHeaders,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().workflowTemplateId).toBe(wfId);
  });

  it('deletes a dev tryon category', async () => {
    const { categoryId } = await createTestDevTryonCategory(app, { slug: 'to-delete' });
    const res = await app.inject({
      method: 'DELETE',
      url: `/admin/dev-api/tryon-categories/${categoryId}`,
      headers: adminHeaders,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
  });

  it('401s without an admin token', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/admin/dev-api/tryon-categories',
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('POST /admin/dev-api/catalog/backfill-slugs', () => {
  it('publishes every eligible unpublished row and skips ineligible ones', async () => {
    const [publishableFace] = await app.db
      .insert(schema.modelFaces)
      .values({
        gender: 'men',
        label: 'Backfill Face',
        r2Key: 'bf-face.jpg',
        thumbnailKey: 'bf-face-t.jpg',
        isActive: true,
      })
      .returning();

    // Ineligible: inactive. Must be left untouched (still no slug).
    const [inactiveFace] = await app.db
      .insert(schema.modelFaces)
      .values({
        gender: 'men',
        label: 'Inactive Face',
        r2Key: 'bf-face-inactive.jpg',
        thumbnailKey: 'bf-face-inactive-t.jpg',
        isActive: false,
      })
      .returning();

    // Already published: must be left exactly as-is, not re-slugged.
    const [alreadyPublished] = await app.db
      .insert(schema.modelFaces)
      .values({
        gender: 'men',
        label: 'Already Published',
        r2Key: 'bf-face-pub.jpg',
        thumbnailKey: 'bf-face-pub-t.jpg',
        isActive: true,
        publicApiSlug: 'do-not-touch',
      })
      .returning();

    const [publishableBackground] = await app.db
      .insert(schema.modelBackgrounds)
      .values({
        label: 'Backfill Background',
        r2Key: 'bf-bg.jpg',
        thumbnailKey: 'bf-bg-t.jpg',
        isActive: true,
        scope: 'general',
      })
      .returning();

    // Ineligible: template scope. buildCatalogOptions() can never surface it, so it
    // must be left unpublished even though it's active.
    const [templateBackground] = await app.db
      .insert(schema.modelBackgrounds)
      .values({
        label: 'Template Background',
        r2Key: 'bf-bg-tpl.jpg',
        thumbnailKey: 'bf-bg-tpl-t.jpg',
        isActive: true,
        scope: 'template',
      })
      .returning();

    const [poseA] = await app.db
      .insert(schema.modelPoseAssets)
      .values({
        label: 'pose13',
        genderSlug: 'men',
        r2Key: 'bf-pose-a.jpg',
        thumbnailKey: 'bf-pose-a-t.jpg',
        isActive: true,
        scope: 'general',
      })
      .returning();
    // Same label, same gender as poseA — must not collide (proves makeUniqueSlug's
    // id-suffix fallback is actually reached in a real DB transaction, not just unit tests).
    const [poseB] = await app.db
      .insert(schema.modelPoseAssets)
      .values({
        label: 'pose13',
        genderSlug: 'men',
        r2Key: 'bf-pose-b.jpg',
        thumbnailKey: 'bf-pose-b-t.jpg',
        isActive: true,
        scope: 'general',
      })
      .returning();

    const [lowerItem] = await app.db
      .insert(schema.catalogItems)
      .values({
        type: 'lower',
        genderSlug: 'men',
        label: 'Backfill Item',
        r2Key: 'bf-lower.jpg',
        thumbnailKey: 'bf-lower-t.jpg',
        isActive: true,
      })
      .returning();
    // Same label, same gender, different type — must not collide with lowerItem.
    const [shoeItem] = await app.db
      .insert(schema.catalogItems)
      .values({
        type: 'shoe',
        genderSlug: 'men',
        label: 'Backfill Item',
        r2Key: 'bf-shoe.jpg',
        thumbnailKey: 'bf-shoe-t.jpg',
        isActive: true,
      })
      .returning();

    const [garmentType] = await app.db
      .insert(schema.garmentSubcategories)
      .values({
        genderSlug: 'men',
        slug: 'bf-internal-slug',
        label: 'Backfill Garment Type',
        isActive: true,
      })
      .returning();

    const res = await app.inject({
      method: 'POST',
      url: '/admin/dev-api/catalog/backfill-slugs',
      headers: adminHeaders,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.ok).toBe(true);
    expect(body.counts.modelFaces).toBeGreaterThanOrEqual(1);
    expect(body.counts.modelBackgrounds).toBeGreaterThanOrEqual(1);
    expect(body.counts.modelPoseAssets).toBeGreaterThanOrEqual(2);
    expect(body.counts.catalogItems).toBeGreaterThanOrEqual(2);
    expect(body.counts.garmentSubcategories).toBeGreaterThanOrEqual(1);

    const [face] = await app.db
      .select()
      .from(schema.modelFaces)
      .where(eq(schema.modelFaces.id, publishableFace.id));
    expect(face!.publicApiSlug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);

    const [inactive] = await app.db
      .select()
      .from(schema.modelFaces)
      .where(eq(schema.modelFaces.id, inactiveFace.id));
    expect(inactive!.publicApiSlug).toBeNull();

    const [untouched] = await app.db
      .select()
      .from(schema.modelFaces)
      .where(eq(schema.modelFaces.id, alreadyPublished.id));
    expect(untouched!.publicApiSlug).toBe('do-not-touch');

    const [bg] = await app.db
      .select()
      .from(schema.modelBackgrounds)
      .where(eq(schema.modelBackgrounds.id, publishableBackground.id));
    expect(bg!.publicApiSlug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);

    const [tplBg] = await app.db
      .select()
      .from(schema.modelBackgrounds)
      .where(eq(schema.modelBackgrounds.id, templateBackground.id));
    expect(tplBg!.publicApiSlug).toBeNull();

    const [pA] = await app.db
      .select()
      .from(schema.modelPoseAssets)
      .where(eq(schema.modelPoseAssets.id, poseA.id));
    const [pB] = await app.db
      .select()
      .from(schema.modelPoseAssets)
      .where(eq(schema.modelPoseAssets.id, poseB.id));
    expect(pA!.publicApiSlug).not.toBeNull();
    expect(pB!.publicApiSlug).not.toBeNull();
    expect(pA!.publicApiSlug).not.toBe(pB!.publicApiSlug);

    const [lower] = await app.db
      .select()
      .from(schema.catalogItems)
      .where(eq(schema.catalogItems.id, lowerItem.id));
    const [shoe] = await app.db
      .select()
      .from(schema.catalogItems)
      .where(eq(schema.catalogItems.id, shoeItem.id));
    expect(lower!.publicApiSlug).not.toBeNull();
    expect(shoe!.publicApiSlug).not.toBeNull();
    expect(lower!.publicApiSlug).not.toBe(shoe!.publicApiSlug);

    const [gt] = await app.db
      .select()
      .from(schema.garmentSubcategories)
      .where(eq(schema.garmentSubcategories.id, garmentType.id));
    expect(gt!.publicApiSlug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it('bumps the catalog options cache version', async () => {
    const before = await app.inject({
      method: 'POST',
      url: '/admin/dev-api/catalog/rebuild-cache',
      headers: adminHeaders,
    });
    const versionBefore = before.json().version;

    await app.db.insert(schema.modelFaces).values({
      gender: 'women',
      label: 'Version Bump Face',
      r2Key: 'bf-vb.jpg',
      thumbnailKey: 'bf-vb-t.jpg',
      isActive: true,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/admin/dev-api/catalog/backfill-slugs',
      headers: adminHeaders,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().version).toBeGreaterThan(versionBefore);
  });

  it('re-running is a no-op on rows it already slugged', async () => {
    const first = await app.inject({
      method: 'POST',
      url: '/admin/dev-api/catalog/backfill-slugs',
      headers: adminHeaders,
    });
    const second = await app.inject({
      method: 'POST',
      url: '/admin/dev-api/catalog/backfill-slugs',
      headers: adminHeaders,
    });
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(second.json().total).toBe(0);
  });

  it('401s without an admin token', async () => {
    const res = await app.inject({ method: 'POST', url: '/admin/dev-api/catalog/backfill-slugs' });
    expect(res.statusCode).toBe(401);
  });
});
