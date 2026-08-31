import { schema } from '@tryme/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { signAccess } from '../../src/modules/auth/service.js';
import { buildTestApp, type TestApp } from '../helpers/api.js';
import { type Containers, startContainers } from '../helpers/containers.js';

// Regression coverage for the personal-background leak into admin-facing
// curated-asset surfaces: model_backgrounds.scope='user' rows (private,
// per-user uploads) must never be returned by the admin scope=all escape
// hatch, the recycle bin, or catalogue-template look validation.
//
// Mints the admin JWT directly (DB insert + signAccess with the 'admin'
// audience, matching apps/api/src/modules/admin/auth.routes.ts) instead of
// going through /v1/auth/register + /admin/auth/login — that HTTP path hits
// a rate-limited login route and is flaky under concurrent test files.
describe('admin backgrounds — scope=user leak regression', () => {
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

  async function makeAdminHeaders(
    role: 'SUPER_ADMIN' | 'MODERATOR' | 'SUPPORT' | 'ADMIN' = 'SUPER_ADMIN',
  ) {
    const [user] = await app.db
      .insert(schema.users)
      .values({
        email: `admin-scope-leak-${Date.now()}-${Math.random()}@x.com`,
        emailVerified: true,
        tier: 'free',
      })
      .returning();
    if (!user) throw new Error('admin user insert failed');
    await app.db.insert(schema.adminUsers).values({
      userId: user.id,
      role,
      status: 'active',
    });
    const secret = new TextEncoder().encode(app.env.JWT_SECRET);
    const accessToken = await signAccess(
      secret,
      user.id,
      { kind: 'access' },
      app.env.JWT_EXPIRY,
      'admin',
    );
    return { authorization: `Bearer ${accessToken}` };
  }

  async function makeOwner() {
    const [user] = await app.db
      .insert(schema.users)
      .values({
        email: `scope-leak-owner-${Date.now()}-${Math.random()}@x.com`,
        emailVerified: true,
        tier: 'free',
      })
      .returning();
    if (!user) throw new Error('owner user insert failed');
    return user.id;
  }

  it('GET /admin/assets/backgrounds?scope=all excludes scope=user rows but still includes general/template rows', async () => {
    const headers = await makeAdminHeaders();
    const ownerId = await makeOwner();

    const [userBg] = await app.db
      .insert(schema.modelBackgrounds)
      .values({
        label: 'Personal',
        r2Key: 'scope-leak/personal.jpg',
        thumbnailKey: 'scope-leak/personal.jpg',
        scope: 'user',
        userId: ownerId,
      })
      .returning();
    const [generalBg] = await app.db
      .insert(schema.modelBackgrounds)
      .values({
        label: 'General',
        r2Key: 'scope-leak/general.jpg',
        thumbnailKey: 'scope-leak/general.jpg',
        scope: 'general',
      })
      .returning();
    const [templateBg] = await app.db
      .insert(schema.modelBackgrounds)
      .values({
        label: 'Template',
        r2Key: 'scope-leak/template.jpg',
        thumbnailKey: 'scope-leak/template.jpg',
        scope: 'template',
      })
      .returning();

    const res = await app.inject({
      method: 'GET',
      url: '/admin/assets/backgrounds?scope=all',
      headers,
    });
    expect(res.statusCode).toBe(200);
    const { items } = res.json();
    const ids = items.map((i: { id: string }) => i.id);
    expect(ids).not.toContain(userBg.id);
    expect(ids).toContain(generalBg.id);
    expect(ids).toContain(templateBg.id);
  });

  it('GET /admin/assets/recycle-bin excludes soft-deleted scope=user backgrounds', async () => {
    const headers = await makeAdminHeaders();
    const ownerId = await makeOwner();

    const [userBg] = await app.db
      .insert(schema.modelBackgrounds)
      .values({
        label: 'Personal deleted',
        r2Key: 'scope-leak/personal-deleted.jpg',
        thumbnailKey: 'scope-leak/personal-deleted.jpg',
        scope: 'user',
        userId: ownerId,
        deletedAt: new Date(),
      })
      .returning();
    const [generalBg] = await app.db
      .insert(schema.modelBackgrounds)
      .values({
        label: 'General deleted',
        r2Key: 'scope-leak/general-deleted.jpg',
        thumbnailKey: 'scope-leak/general-deleted.jpg',
        scope: 'general',
        deletedAt: new Date(),
      })
      .returning();

    const res = await app.inject({
      method: 'GET',
      url: '/admin/assets/recycle-bin',
      headers,
    });
    expect(res.statusCode).toBe(200);
    const { backgrounds } = res.json();
    const ids = backgrounds.map((i: { id: string }) => i.id);
    expect(ids).not.toContain(userBg.id);
    expect(ids).toContain(generalBg.id);
  });

  it('PUT .../looks rejects a scope=user backgroundId as not found, even for its owner-submitted id', async () => {
    const headers = await makeAdminHeaders();
    const ownerId = await makeOwner();

    const [pose] = await app.db
      .insert(schema.modelPoseAssets)
      .values({ label: 'P', r2Key: 'p.jpg', thumbnailKey: 'p.jpg' })
      .returning();
    const [userBg] = await app.db
      .insert(schema.modelBackgrounds)
      .values({
        label: 'Personal',
        r2Key: 'scope-leak/personal-template.jpg',
        thumbnailKey: 'scope-leak/personal-template.jpg',
        scope: 'user',
        userId: ownerId,
      })
      .returning();

    const createRes = await app.inject({
      method: 'POST',
      url: '/admin/assets/catalogue-templates',
      headers,
      payload: { genderSlug: 'men', label: 'Scope leak template', sortOrder: 0 },
    });
    expect(createRes.statusCode).toBe(200);
    const { id: templateId } = createRes.json();

    const putRes = await app.inject({
      method: 'PUT',
      url: `/admin/assets/catalogue-templates/${templateId}/looks`,
      headers,
      payload: { looks: [{ poseAssetId: pose.id, backgroundId: userBg.id }] },
    });
    expect(putRes.statusCode).toBe(400);
  });
});
