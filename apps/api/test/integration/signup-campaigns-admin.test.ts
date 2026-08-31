import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildTestApp, type TestApp } from '../helpers/api';
import { type Containers, startContainers } from '../helpers/containers';

describe('signup-campaigns admin CRUD', () => {
  let c: Containers;
  let app: TestApp;
  let adminToken: string;

  beforeAll(async () => {
    c = await startContainers();
    app = await buildTestApp(c);

    await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        displayName: 'Campaigns Admin',
        email: 'campaigns-admin@x.com',
        password: 'password123',
      },
    });
    const [user] = await app.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, 'campaigns-admin@x.com'));
    const userId = user?.id;
    await app.db
      .update(schema.users)
      .set({ emailVerified: true })
      .where(eq(schema.users.id, userId));
    await app.db.insert(schema.adminUsers).values({
      userId,
      role: 'SUPER_ADMIN',
      passwordHash: user?.passwordHash,
    });

    const loginRes = await app.inject({
      method: 'POST',
      url: '/admin/auth/login',
      payload: { email: 'campaigns-admin@x.com', password: 'password123' },
    });
    adminToken = loginRes.json().accessToken;
  }, 60000);

  afterAll(async () => {
    await app?.close();
    await c?.stop();
  });

  function authed(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) {
    return app.inject({
      method,
      url,
      headers: { authorization: `Bearer ${adminToken}` },
      payload,
    });
  }

  it('creates, lists, updates, and deletes a campaign', async () => {
    const created = await authed('POST', '/admin/signup-campaigns', {
      code: 'crud-test-1',
      name: 'CRUD Test Campaign',
      bonusPercent: 25,
      startAt: '2026-08-06T00:00:00.000Z',
      endAt: '2026-08-08T23:59:59.000Z',
      isActive: true,
    });
    expect(created.statusCode).toBe(200);
    const campaign = created.json();
    expect(campaign.code).toBe('crud-test-1');
    expect(campaign.bonusPercent).toBe(25);

    const list = await authed('GET', '/admin/signup-campaigns');
    expect(list.statusCode).toBe(200);
    expect(list.json().some((c: { id: string }) => c.id === campaign.id)).toBe(true);

    const updated = await authed('PATCH', `/admin/signup-campaigns/${campaign.id}`, {
      bonusPercent: 30,
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().bonusPercent).toBe(30);

    const deleted = await authed('DELETE', `/admin/signup-campaigns/${campaign.id}`);
    expect(deleted.statusCode).toBe(204);
  });

  it('rejects a window where endAt is before startAt (400)', async () => {
    const res = await authed('POST', '/admin/signup-campaigns', {
      code: 'bad-window',
      name: 'Bad Window',
      bonusPercent: 25,
      startAt: '2026-08-08T00:00:00.000Z',
      endAt: '2026-08-06T00:00:00.000Z',
      isActive: true,
    });
    expect(res.statusCode).toBe(400);
  });

  it.each([
    { field: 'startAt', startAt: null, endAt: '2026-08-08T00:00:00.000Z' },
    { field: 'startAt', startAt: false, endAt: '2026-08-08T00:00:00.000Z' },
    { field: 'startAt', startAt: 0, endAt: '2026-08-08T00:00:00.000Z' },
    { field: 'endAt', startAt: '1960-08-06T00:00:00.000Z', endAt: null },
    { field: 'endAt', startAt: '1960-08-06T00:00:00.000Z', endAt: false },
    { field: 'endAt', startAt: '1960-08-06T00:00:00.000Z', endAt: 0 },
    { field: 'startAt', startAt: '2026-08-06T00:00:00+0530', endAt: '2026-08-08T00:00:00Z' },
    { field: 'startAt', startAt: '2026-08-06T00:00:00+99:99', endAt: '2026-08-08T00:00:00Z' },
  ])('rejects invalid $field values on create', async ({ startAt, endAt }) => {
    const res = await authed('POST', '/admin/signup-campaigns', {
      code: `invalid-date-${Math.random().toString(36).slice(2, 8)}`,
      name: 'Invalid Date Type',
      bonusPercent: 25,
      startAt,
      endAt,
      isActive: true,
    });
    expect(res.statusCode).toBe(400);
  });

  it('rejects a non-string date value on partial update', async () => {
    const created = await authed('POST', '/admin/signup-campaigns', {
      code: 'invalid-patch-date',
      name: 'Invalid Patch Date',
      bonusPercent: 25,
      startAt: '2026-08-06T00:00:00.000Z',
      endAt: '2026-08-08T00:00:00.000Z',
      isActive: true,
    });
    const res = await authed('PATCH', `/admin/signup-campaigns/${created.json().id}`, {
      startAt: false,
    });
    expect(res.statusCode).toBe(400);
  });

  it('blocks deleting a campaign that a user is attributed to (409)', async () => {
    const created = await authed('POST', '/admin/signup-campaigns', {
      code: 'attributed-delete-test',
      name: 'Attributed Delete Test',
      bonusPercent: 25,
      startAt: '2026-08-06T00:00:00.000Z',
      endAt: '2026-08-08T23:59:59.000Z',
      isActive: true,
    });
    const campaign = created.json();

    await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        displayName: 'Attributed User',
        email: 'attributed-delete-user@x.com',
        password: 'password123',
      },
    });
    const [user] = await app.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, 'attributed-delete-user@x.com'));
    await app.db
      .update(schema.users)
      .set({ signupCampaignId: campaign.id })
      .where(eq(schema.users.id, user?.id));

    const delRes = await authed('DELETE', `/admin/signup-campaigns/${campaign.id}`);
    expect(delRes.statusCode).toBe(409);
  });

  it('preserves an attribution that commits while delete is waiting for its campaign lock', async () => {
    const created = await authed('POST', '/admin/signup-campaigns', {
      code: 'attribution-delete-race',
      name: 'Attribution Delete Race',
      bonusPercent: 25,
      startAt: '2026-08-06T00:00:00.000Z',
      endAt: '2026-08-08T23:59:59.000Z',
      isActive: true,
    });
    const campaign = created.json();
    await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        displayName: 'Race Attributed User',
        email: 'race-attributed-user@x.com',
        password: 'password123',
      },
    });
    const [user] = await app.db
      .select()
      .from(schema.users)
      .where(eq(schema.users.email, 'race-attributed-user@x.com'));
    const writer = postgres(c.pgUrl, { max: 1 });
    const observer = postgres(c.pgUrl, { max: 1 });
    let releaseWriter!: () => void;
    const writerCanCommit = new Promise<void>((resolve) => {
      releaseWriter = resolve;
    });
    let writerReady!: () => void;
    const writerHasAttribution = new Promise<void>((resolve) => {
      writerReady = resolve;
    });

    try {
      const writerTransaction = writer.begin(async (tx) => {
        await tx`select id from signup_campaigns where id = ${campaign.id} for key share`;
        await tx`update users set signup_campaign_id = ${campaign.id} where id = ${user?.id}`;
        writerReady();
        await writerCanCommit;
      });
      await writerHasAttribution;

      const deleting = authed('DELETE', `/admin/signup-campaigns/${campaign.id}`);
      const deadline = Date.now() + 5_000;
      while (true) {
        const [waitingDelete] = await observer`
          select pid
          from pg_stat_activity
          where datname = current_database()
            and state = 'active'
            and wait_event_type = 'Lock'
            and query like '%signup_campaigns%'
          limit 1
        `;
        if (waitingDelete) break;
        if (Date.now() >= deadline) throw new Error('delete did not wait for the campaign lock');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }

      releaseWriter();
      await writerTransaction;
      const deleted = await deleting;
      expect(deleted.statusCode).toBe(409);

      const [attributedUser] = await app.db
        .select({ signupCampaignId: schema.users.signupCampaignId })
        .from(schema.users)
        .where(eq(schema.users.id, user?.id));
      expect(attributedUser?.signupCampaignId).toBe(campaign.id);
    } finally {
      await writer.end();
      await observer.end();
    }
  });

  it('serializes email campaign attribution with admin deletion', async () => {
    const now = Date.now();
    const created = await authed('POST', '/admin/signup-campaigns', {
      code: 'email-signup-delete-race',
      name: 'Email Signup Delete Race',
      bonusPercent: 25,
      startAt: new Date(now - 86_400_000).toISOString(),
      endAt: new Date(now + 86_400_000).toISOString(),
      isActive: true,
    });
    const campaign = created.json();
    const blocker = postgres(c.pgUrl, { max: 1 });
    const observer = postgres(c.pgUrl, { max: 1 });
    let registering!: ReturnType<typeof app.inject>;
    let deleting!: ReturnType<typeof app.inject>;
    let deleteCompleted = false;
    let deleteCompletedBeforeSignupCouldCommit = false;

    try {
      await blocker.begin(async (tx) => {
        // INSERT takes ROW EXCLUSIVE, so this lets registration resolve its
        // campaign but deterministically pauses before the user FK is written.
        await tx`lock table users in share mode`;
        registering = app.inject({
          method: 'POST',
          url: '/v1/auth/register',
          payload: {
            displayName: 'Email Delete Race User',
            email: 'email-delete-race-user@x.com',
            password: 'password123',
            signupSource: 'email-signup-delete-race',
          },
        });

        const insertDeadline = Date.now() + 5_000;
        while (true) {
          const [waitingInsert] = await observer`
            select pid
            from pg_stat_activity
            where datname = current_database()
              and state = 'active'
              and wait_event_type = 'Lock'
              and query like 'insert into "users"%'
            limit 1
          `;
          if (waitingInsert) break;
          if (Date.now() >= insertDeadline) throw new Error('signup did not reach the user insert');
          await new Promise((resolve) => setTimeout(resolve, 10));
        }

        deleting = authed('DELETE', `/admin/signup-campaigns/${campaign.id}`);
        void deleting.then(() => {
          deleteCompleted = true;
        });

        const deleteDeadline = Date.now() + 5_000;
        while (!deleteCompleted) {
          const [waitingDelete] = await observer`
            select pid
            from pg_stat_activity
            where datname = current_database()
              and state = 'active'
              and wait_event_type = 'Lock'
              and query like '%signup_campaigns%'
            limit 1
          `;
          if (waitingDelete) break;
          if (Date.now() >= deleteDeadline) {
            throw new Error('delete neither completed nor waited for the campaign lock');
          }
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        deleteCompletedBeforeSignupCouldCommit = deleteCompleted;
      });

      const [registerResponse, deleteResponse] = await Promise.all([registering, deleting]);
      expect(deleteCompletedBeforeSignupCouldCommit).toBe(false);
      expect(registerResponse.statusCode).toBe(201);
      expect(deleteResponse.statusCode).toBe(409);

      const [attributedUser] = await app.db
        .select({ signupCampaignId: schema.users.signupCampaignId })
        .from(schema.users)
        .where(eq(schema.users.email, 'email-delete-race-user@x.com'));
      expect(attributedUser?.signupCampaignId).toBe(campaign.id);
    } finally {
      await blocker.end();
      await observer.end();
    }
  }, 15_000);

  it('serializes concurrent partial window updates', async () => {
    const created = await authed('POST', '/admin/signup-campaigns', {
      code: 'concurrent-window-test',
      name: 'Concurrent Window Test',
      bonusPercent: 25,
      startAt: '2026-08-06T00:00:00.000Z',
      endAt: '2026-08-08T00:00:00.000Z',
      isActive: true,
    });
    const campaign = created.json();
    const locker = postgres(c.pgUrl, { max: 1 });

    try {
      let updates: [ReturnType<typeof authed>, ReturnType<typeof authed>] | undefined;
      await locker.begin(async (tx) => {
        await tx`select id from signup_campaigns where id = ${campaign.id} for update`;
        updates = [
          authed('PATCH', `/admin/signup-campaigns/${campaign.id}`, {
            startAt: '2026-08-07T00:00:00.000Z',
          }),
          authed('PATCH', `/admin/signup-campaigns/${campaign.id}`, {
            endAt: '2026-08-07T00:00:00.000Z',
          }),
        ];
        await new Promise((resolve) => setTimeout(resolve, 100));
      });

      if (!updates) throw new Error('concurrent updates did not start');
      const results = await Promise.all(updates);
      expect(results.map((res) => res.statusCode).sort()).toEqual([200, 400]);
      const [stored] = await app.db
        .select()
        .from(schema.signupCampaigns)
        .where(eq(schema.signupCampaigns.id, campaign.id));
      expect(stored?.endAt.getTime()).toBeGreaterThan(stored?.startAt.getTime() ?? 0);
    } finally {
      await locker.end();
    }
  });
});
