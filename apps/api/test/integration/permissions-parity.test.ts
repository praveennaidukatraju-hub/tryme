import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { adminAuthHeader } from '../helpers/admin.js';
import { buildTestApp, type TestApp } from '../helpers/api.js';
import { type Containers, startContainers } from '../helpers/containers.js';

describe('permissions parity test across all 4 admin roles', () => {
  let c: Containers;
  let app: TestApp;

  let superAuth: { authorization: string };
  let adminAuth: { authorization: string };
  let modAuth: { authorization: string };
  let supportAuth: { authorization: string };

  beforeAll(async () => {
    c = await startContainers();
    app = await buildTestApp(c);

    superAuth = await adminAuthHeader(app, 'SUPER_ADMIN');
    adminAuth = await adminAuthHeader(app, 'ADMIN');
    modAuth = await adminAuthHeader(app, 'MODERATOR');
    supportAuth = await adminAuthHeader(app, 'SUPPORT');
  }, 60000);

  afterAll(async () => {
    await app?.close();
    await c?.stop();
  });

  it('GET /admin/me: all roles succeed and receive permissions array', async () => {
    for (const [role, auth] of [
      ['SUPER_ADMIN', superAuth],
      ['ADMIN', adminAuth],
      ['MODERATOR', modAuth],
      ['SUPPORT', supportAuth],
    ] as const) {
      const res = await app.inject({ method: 'GET', url: '/admin/me', headers: auth });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.role).toBe(role);
      expect(Array.isArray(body.permissions)).toBe(true);
      expect(body.permissions.length).toBeGreaterThan(0);
      expect(body.permissions).toContain('admin.me');
    }
  });

  it('audit logs (audit.read): only SUPER_ADMIN allowed', async () => {
    const superRes = await app.inject({
      method: 'GET',
      url: '/admin/audit-logs',
      headers: superAuth,
    });
    expect(superRes.statusCode).toBe(200);

    for (const auth of [adminAuth, modAuth, supportAuth]) {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/audit-logs',
        headers: auth,
      });
      expect(res.statusCode).toBe(403);
    }
  });

  it('admin requests (admin_users.manage): only SUPER_ADMIN allowed', async () => {
    const superRes = await app.inject({
      method: 'GET',
      url: '/admin/admin-requests',
      headers: superAuth,
    });
    expect(superRes.statusCode).toBe(200);

    for (const auth of [adminAuth, modAuth, supportAuth]) {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/admin-requests',
        headers: auth,
      });
      expect(res.statusCode).toBe(403);
    }
  });

  it('credit plans (credit_plans.write): only SUPER_ADMIN allowed', async () => {
    const superRes = await app.inject({
      method: 'GET',
      url: '/admin/credit-plans',
      headers: superAuth,
    });
    expect(superRes.statusCode).toBe(200);

    for (const auth of [adminAuth, modAuth, supportAuth]) {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/credit-plans',
        headers: auth,
      });
      expect(res.statusCode).toBe(403);
    }
  });

  it('worker writes (workers.write): only SUPER_ADMIN allowed', async () => {
    for (const auth of [adminAuth, modAuth, supportAuth]) {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/workers',
        headers: auth,
        payload: { id: 'test-w', label: 'W', url: 'http://w', apiKey: 'k', allowedJobTypes: [] },
      });
      expect(res.statusCode).toBe(403);
    }
  });

  it('worker drain (workers.drain): SUPER_ADMIN, ADMIN, MODERATOR allowed; SUPPORT forbidden', async () => {
    for (const auth of [superAuth, adminAuth, modAuth]) {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/workers/non-existent/drain',
        headers: auth,
      });
      expect(res.statusCode).not.toBe(403);
    }

    const supportRes = await app.inject({
      method: 'POST',
      url: '/admin/workers/non-existent/drain',
      headers: supportAuth,
    });
    expect(supportRes.statusCode).toBe(403);
  });

  it('worker reads (workers.read): all 4 roles allowed', async () => {
    for (const auth of [superAuth, adminAuth, modAuth, supportAuth]) {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/workers',
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
    }
  });

  it('workflows read (workflows.read): SUPER_ADMIN, ADMIN, MODERATOR allowed; SUPPORT forbidden', async () => {
    for (const auth of [superAuth, adminAuth, modAuth]) {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/workflows',
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
    }

    const supportRes = await app.inject({
      method: 'GET',
      url: '/admin/workflows',
      headers: supportAuth,
    });
    expect(supportRes.statusCode).toBe(403);
  });

  it('workflows write (workflows.write): SUPER_ADMIN, MODERATOR allowed; ADMIN, SUPPORT forbidden', async () => {
    for (const auth of [superAuth, modAuth]) {
      const res = await app.inject({
        method: 'DELETE',
        url: '/admin/workflows/00000000-0000-0000-0000-000000000000',
        headers: auth,
      });
      // Not 403 (will be 404 because ID doesn't exist)
      expect(res.statusCode).not.toBe(403);
    }

    for (const auth of [adminAuth, supportAuth]) {
      const res = await app.inject({
        method: 'DELETE',
        url: '/admin/workflows/00000000-0000-0000-0000-000000000000',
        headers: auth,
      });
      expect(res.statusCode).toBe(403);
    }
  });

  it('credits write (credits.write): SUPER_ADMIN, ADMIN, MODERATOR allowed; SUPPORT forbidden', async () => {
    for (const auth of [superAuth, adminAuth, modAuth]) {
      const res = await app.inject({
        method: 'POST',
        url: '/admin/credits/grant',
        headers: auth,
        payload: { userId: '00000000-0000-0000-0000-000000000000', amount: 10 },
      });
      expect(res.statusCode).not.toBe(403);
    }

    const supportRes = await app.inject({
      method: 'POST',
      url: '/admin/credits/grant',
      headers: supportAuth,
      payload: { userId: '00000000-0000-0000-0000-000000000000', amount: 10 },
    });
    expect(supportRes.statusCode).toBe(403);
  });

  it('shopify stores (shopify_stores.read): SUPER_ADMIN, ADMIN, SUPPORT allowed; MODERATOR forbidden', async () => {
    for (const auth of [superAuth, adminAuth, supportAuth]) {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/shopify-stores',
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
    }

    const modRes = await app.inject({
      method: 'GET',
      url: '/admin/shopify-stores',
      headers: modAuth,
    });
    expect(modRes.statusCode).toBe(403);
  });

  it('users list (users.read): all 4 roles allowed', async () => {
    for (const auth of [superAuth, adminAuth, modAuth, supportAuth]) {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/users',
        headers: auth,
      });
      expect(res.statusCode).toBe(200);
    }
  });

  it('users erase (users.delete): only SUPER_ADMIN allowed', async () => {
    for (const auth of [adminAuth, modAuth, supportAuth]) {
      const res = await app.inject({
        method: 'DELETE',
        url: '/admin/users/00000000-0000-0000-0000-000000000000',
        headers: auth,
      });
      expect(res.statusCode).toBe(403);
    }

    const superRes = await app.inject({
      method: 'DELETE',
      url: '/admin/users/00000000-0000-0000-0000-000000000000',
      headers: superAuth,
    });
    // Not 403 forbidden
    expect(superRes.statusCode).not.toBe(403);
  });
});
