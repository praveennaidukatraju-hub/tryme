import { schema } from '@tryme/db';
import { auditLogWriteFailuresTotal } from '@tryme/observability';
import { eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { recordAudit } from '../../src/modules/admin/audit.js';
import { adminAuthHeader } from '../helpers/admin.js';
import { buildTestApp, type TestApp } from '../helpers/api.js';
import { type Containers, startContainers } from '../helpers/containers.js';

describe('admin audit logs and append-only trigger', () => {
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

  it('proves trigger-based append-only enforcement: UPDATE and DELETE raise exceptions', async () => {
    const authHeaders = await adminAuthHeader(app, 'SUPER_ADMIN');

    // Create a worker to produce an audit log
    const workerId = `audit-test-w-${Date.now()}`;
    const createRes = await app.inject({
      method: 'POST',
      url: '/admin/workers',
      headers: authHeaders,
      payload: {
        id: workerId,
        label: 'Audit Test Worker',
        url: 'https://worker1.example.com',
        apiKey: 'secretkey123',
        allowedJobTypes: ['tryon'],
      },
    });
    expect(createRes.statusCode).toBe(201);

    const [auditRow] = await app.db
      .select()
      .from(schema.auditLogs)
      .where(eq(schema.auditLogs.resourceId, workerId));
    expect(auditRow).toBeDefined();
    expect(auditRow.action).toBe('worker.create');

    // Attempting UPDATE on audit_logs triggers exception
    await expect(
      app.db
        .update(schema.auditLogs)
        .set({ action: 'tampered.action' })
        .where(eq(schema.auditLogs.id, auditRow.id)),
    ).rejects.toThrow(/audit_logs is append-only/);

    // Attempting DELETE on audit_logs triggers exception
    await expect(
      app.db.delete(schema.auditLogs).where(eq(schema.auditLogs.id, auditRow.id)),
    ).rejects.toThrow(/audit_logs is append-only/);
  });

  it('enforces fail-closed behavior: failed audit insert rolls back mutation and increments metric', async () => {
    const prevFailureCount = (await auditLogWriteFailuresTotal.get()).values[0]?.value ?? 0;

    const fakeWorkerId = `fail-closed-w-${Date.now()}`;

    // Execute a transaction where recordAudit throws due to invalid non-existent actorUserId
    await expect(
      app.db.transaction(async (tx) => {
        await tx.insert(schema.workers).values({
          id: fakeWorkerId,
          label: 'Should Rollback',
          url: 'https://fail.example.com',
          apiKey: 'key',
          isActive: true,
          allowedJobTypes: [],
        });

        // Intentional FK failure on audit insert (non-existent user ID)
        await recordAudit(tx, {
          actor: { userId: '00000000-0000-0000-0000-000000000000', role: 'SUPER_ADMIN' },
          action: 'worker.create',
          resourceType: 'worker',
          resourceId: fakeWorkerId,
        });
      }),
    ).rejects.toThrow();

    // Verify worker row was NOT committed
    const [worker] = await app.db
      .select()
      .from(schema.workers)
      .where(eq(schema.workers.id, fakeWorkerId));
    expect(worker).toBeUndefined();

    // Verify Prometheus metric was incremented
    const newFailureCount = (await auditLogWriteFailuresTotal.get()).values[0]?.value ?? 0;
    expect(newFailureCount).toBe(prevFailureCount + 1);
  });

  it('records full audit lifecycle for worker create, update, and delete', async () => {
    const authHeaders = await adminAuthHeader(app, 'SUPER_ADMIN');
    const workerId = `lifecycle-w-${Date.now()}`;

    // 1. Create
    await app.inject({
      method: 'POST',
      url: '/admin/workers',
      headers: authHeaders,
      payload: {
        id: workerId,
        label: 'Lifecycle Worker',
        url: 'https://lifecycle.example.com',
        apiKey: 'lifecycle-key',
        allowedJobTypes: ['saree'],
      },
    });

    // 2. Update
    await app.inject({
      method: 'PATCH',
      url: `/admin/workers/${workerId}`,
      headers: authHeaders,
      payload: {
        label: 'Lifecycle Worker Renamed',
      },
    });

    // 3. Delete
    await app.inject({
      method: 'DELETE',
      url: `/admin/workers/${workerId}`,
      headers: authHeaders,
    });

    // 4. Query GET /admin/audit-logs
    const res = await app.inject({
      method: 'GET',
      url: `/admin/audit-logs?resourceId=${workerId}`,
      headers: authHeaders,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.total).toBe(3);
    expect(body.items.map((i: { action: string }) => i.action)).toEqual([
      'worker.delete',
      'worker.update',
      'worker.create',
    ]);
  });
});
