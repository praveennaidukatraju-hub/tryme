import { schema } from '@tryme/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveQueueRouting } from '../../src/modules/jobs/create.js';
import { buildTestApp, type TestApp } from '../helpers/api';
import { type Containers, startContainers } from '../helpers/containers';

describe('resolveQueueRouting — PIPE-9 balance-gated priority', () => {
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

  async function seedPlan(slug: string, queueStream: string, watermark = false) {
    await app.db
      .insert(schema.creditPlans)
      .values({ slug, name: slug, credits: 1000, basePaise: 0, queueStream, watermark })
      .onConflictDoUpdate({ target: schema.creditPlans.slug, set: { queueStream, watermark } });
  }

  async function registerUser(email: string, tier: string, balance: number) {
    const [user] = await app.db
      .insert(schema.users)
      .values({ email, emailVerified: true, tier })
      .returning();
    await app.db.insert(schema.userCredits).values({ userId: user.id, balance });
    return user.id;
  }

  it('routes to priority when the plan grants it and the user has a positive balance', async () => {
    await seedPlan('priority-plan-1', 'priority');
    const userId = await registerUser('routing-priority-balance@x.com', 'priority-plan-1', 50);

    const routing = await resolveQueueRouting(app, userId);
    expect(routing.queueStream).toBe('priority');
    expect(routing.priority).toBe(true);
  });

  it('demotes to normal when the plan grants priority but the balance is exhausted', async () => {
    await seedPlan('priority-plan-2', 'priority');
    const userId = await registerUser('routing-priority-zero-balance@x.com', 'priority-plan-2', 0);

    const routing = await resolveQueueRouting(app, userId);
    expect(routing.queueStream).toBe('normal');
    expect(routing.priority).toBe(false);
  });

  it('leaves a normal-tier plan alone regardless of balance', async () => {
    await seedPlan('normal-plan-1', 'normal');
    const userId = await registerUser('routing-normal@x.com', 'normal-plan-1', 0);

    const routing = await resolveQueueRouting(app, userId);
    expect(routing.queueStream).toBe('normal');
    expect(routing.priority).toBe(false);
  });

  it('leaves a low-tier plan alone regardless of balance — the balance gate only demotes priority', async () => {
    await seedPlan('low-plan-1', 'low');
    const userId = await registerUser('routing-low@x.com', 'low-plan-1', 0);

    const routing = await resolveQueueRouting(app, userId);
    expect(routing.queueStream).toBe('low');
    expect(routing.priority).toBe(false);
  });

  it('watermark entitlement is unaffected by the balance gate — still derives from tier alone', async () => {
    await seedPlan('priority-plan-3', 'priority', true);
    const userId = await registerUser('routing-watermark@x.com', 'priority-plan-3', 0);

    const routing = await resolveQueueRouting(app, userId);
    expect(routing.queueStream).toBe('normal'); // demoted — no balance
    expect(routing.watermark).toBe(true); // watermark still reflects the plan, unaffected
  });
});
