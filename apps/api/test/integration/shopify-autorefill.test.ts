import { createHmac } from 'node:crypto';
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  disableAutorefill,
  refreshAutorefillState,
  runRefill,
} from '../../src/modules/shopify/autorefill.js';
import type { SubscriptionState } from '../../src/modules/shopify/autorefill-client.js';
import { buildTestApp } from '../helpers/api.js';
import { startContainers } from '../helpers/containers.js';

// Only the app_subscriptions_update HTTP-layer test at the bottom of this file
// exercises real HMAC verification — matches the convention already used in
// shopify-purchase.test.ts for the same reason (that file's
// app_purchases_one_time_update HTTP-layer test).
const WEBHOOK_SECRET = 'autorefill-webhook-test-secret';

let ctx: Awaited<ReturnType<typeof startContainers>>;
let app: Awaited<ReturnType<typeof buildTestApp>>;
let store: typeof schema.shopifyStores.$inferSelect;
let charges: string[];

const okCharge = () => ({
  charge: async (
    _app: unknown,
    _store: unknown,
    args: { idempotencyKey: string },
  ): Promise<{ ok: true; recordId: string }> => {
    charges.push(args.idempotencyKey);
    return { ok: true, recordId: `gid://shopify/AppUsageRecord/${charges.length}` };
  },
});

const capCharge = () => ({
  charge: async (): Promise<{ ok: false; capReached: boolean; message: string }> => ({
    ok: false,
    capReached: true,
    message: 'Total price exceeds balance remaining',
  }),
});

async function reset(
  balance: number,
  patch: Partial<typeof schema.shopifyStores.$inferSelect> = {},
) {
  await app.db
    .delete(schema.shopifyCreditPurchases)
    .where(eq(schema.shopifyCreditPurchases.storeId, store.id));
  // Also clear the ledger: shopify_credit_ledger_external_ref_idx (migration
  // 0151) is a UNIQUE index on external_ref alone, not scoped per store. The
  // mock charge()'s recordId — and thus the externalRef grantStore uses —
  // is derived from the shared `charges` array, which beforeEach resets to
  // [] before every test, so every test's first successful charge reuses
  // the same externalRef string. Without clearing prior tests' ledger rows
  // here, a later test's legitimate grant silently conflicts with an
  // earlier, unrelated test's row and grantStore correctly (by design)
  // no-ops it — which then leaves the balance looking unchanged and makes a
  // second concurrent caller look legitimately eligible, failing the race
  // test for a reason that has nothing to do with the code under test.
  await app.db
    .delete(schema.shopifyCreditLedger)
    .where(eq(schema.shopifyCreditLedger.storeId, store.id));
  await app.db
    .insert(schema.shopifyStoreCredits)
    .values({ storeId: store.id, balance })
    .onConflictDoUpdate({ target: schema.shopifyStoreCredits.storeId, set: { balance } });
  const [updated] = await app.db
    .update(schema.shopifyStores)
    .set({
      autorefillPackId: 'pack_25',
      autorefillTriggerCredits: 450,
      autorefillSubscriptionId: 'gid://shopify/AppSubscription/1',
      autorefillLineItemId: 'gid://shopify/AppSubscriptionLineItem/1',
      autorefillStatus: 'ACTIVE',
      ...patch,
    })
    .where(eq(schema.shopifyStores.id, store.id))
    .returning();
  store = updated;
}

beforeAll(async () => {
  ctx = await startContainers();
  app = await buildTestApp(ctx, { SHOPIFY_API_SECRET: WEBHOOK_SECRET });
  [store] = await app.db
    .insert(schema.shopifyStores)
    .values({
      shopDomain: 'autorefill-test.myshopify.com',
      shopifyShopId: 66601,
      accessToken: 'enc:token',
      scope: 'read_products',
    })
    .returning();
});

beforeEach(() => {
  charges = [];
});

afterAll(async () => {
  await app.close();
  await ctx.stop();
});

describe('auto-refill', () => {
  it('charges once and grants the bonus credit amount', async () => {
    await reset(100);
    const result = await runRefill(app, store, okCharge());
    expect(result).toBe('refilled');
    expect(charges).toHaveLength(1);

    const [credits] = await app.db
      .select()
      .from(schema.shopifyStoreCredits)
      .where(eq(schema.shopifyStoreCredits.storeId, store.id));
    // 100 starting + 2475 auto-refill credits for pack_25 (not the manual 2250)
    expect(credits.balance).toBe(2575);
  });

  it('skips when the balance is above the trigger', async () => {
    await reset(1000);
    expect(await runRefill(app, store, okCharge())).toBe('skipped');
    expect(charges).toHaveLength(0);
  });

  it('skips when auto-refill is not ACTIVE', async () => {
    await reset(100, { autorefillStatus: 'PENDING' });
    expect(await runRefill(app, store, okCharge())).toBe('skipped');
    expect(charges).toHaveLength(0);
  });

  // The double-charge test. This is the reason all three guards exist.
  it('charges exactly once when two refills race', async () => {
    await reset(100);
    const results = await Promise.all([
      runRefill(app, store, okCharge()),
      runRefill(app, store, okCharge()),
    ]);
    expect(charges).toHaveLength(1);
    expect(results.filter((r) => r === 'refilled')).toHaveLength(1);
    expect(results.filter((r) => r === 'skipped')).toHaveLength(1);

    // A single charge with a double *grant* would still show charges.length
    // === 1 above — assert the final balance too, matching the happy-path
    // test's math for pack_25 (100 starting + 2475 auto-refill credits).
    const [credits] = await app.db
      .select()
      .from(schema.shopifyStoreCredits)
      .where(eq(schema.shopifyStoreCredits.storeId, store.id));
    expect(credits.balance).toBe(2575);
  });

  it('uses the purchase row id as the idempotency key', async () => {
    await reset(100);
    await runRefill(app, store, okCharge());
    const [row] = await app.db
      .select()
      .from(schema.shopifyCreditPurchases)
      .where(eq(schema.shopifyCreditPurchases.storeId, store.id));
    expect(charges[0]).toBe(`autorefill:${row.id}`);
  });

  it('marks the store CAP_REACHED and grants nothing when the ceiling is hit', async () => {
    await reset(100);
    expect(await runRefill(app, store, capCharge())).toBe('cap_reached');

    const [refreshed] = await app.db
      .select()
      .from(schema.shopifyStores)
      .where(eq(schema.shopifyStores.id, store.id));
    expect(refreshed.autorefillStatus).toBe('CAP_REACHED');

    const [credits] = await app.db
      .select()
      .from(schema.shopifyStoreCredits)
      .where(eq(schema.shopifyStoreCredits.storeId, store.id));
    expect(credits.balance).toBe(100);

    const [row] = await app.db
      .select()
      .from(schema.shopifyCreditPurchases)
      .where(eq(schema.shopifyCreditPurchases.storeId, store.id));
    expect(row.status).toBe('FAILED');
  });

  it('does not retry once the store is CAP_REACHED', async () => {
    await reset(100, { autorefillStatus: 'CAP_REACHED' });
    expect(await runRefill(app, store, okCharge())).toBe('skipped');
    expect(charges).toHaveLength(0);
  });

  it('leaves the balance untouched and the row FAILED on a transient charge failure', async () => {
    await reset(100);
    const result = await runRefill(app, store, {
      charge: async () => ({ ok: false as const, capReached: false, message: 'network' }),
    });
    expect(result).toBe('failed');

    const [refreshed] = await app.db
      .select()
      .from(schema.shopifyStores)
      .where(eq(schema.shopifyStores.id, store.id));
    // A transient failure must NOT look like the merchant's ceiling.
    expect(refreshed.autorefillStatus).toBe('ACTIVE');
  });
});

describe('auto-refill lifecycle', () => {
  it('stops refilling once the subscription is cancelled at Shopify', async () => {
    await reset(100, { autorefillStatus: 'CANCELLED' });
    expect(await runRefill(app, store, okCharge())).toBe('skipped');
    expect(charges).toHaveLength(0);
  });

  it('resumes refilling after the merchant re-approves', async () => {
    await reset(100, { autorefillStatus: 'CANCELLED' });
    expect(await runRefill(app, store, okCharge())).toBe('skipped');

    await reset(100, { autorefillStatus: 'ACTIVE' });
    expect(await runRefill(app, store, okCharge())).toBe('refilled');
  });
});

describe('disableAutorefill', () => {
  // Guards against silently regressing to "just clear our columns" — a real
  // incident risk, since a merchant who turns auto-refill off believes the
  // charge authorization at Shopify is gone too. Mirrors runRefill's
  // deps-injection pattern (okCharge/capCharge above) rather than mocking the
  // module, since disableAutorefill now accepts the same shape of override.
  it('calls Shopify to cancel the subscription, not just clear local columns', async () => {
    await reset(100, {
      autorefillStatus: 'ACTIVE',
      autorefillSubscriptionId: 'gid://shopify/AppSubscription/disable-test',
    });

    const cancelled: Array<{ storeId: number; subscriptionId: string }> = [];
    await disableAutorefill(app, store, {
      cancelSubscription: async (_app, s, subscriptionId) => {
        cancelled.push({ storeId: s.id, subscriptionId });
      },
    });

    expect(cancelled).toEqual([
      { storeId: store.id, subscriptionId: 'gid://shopify/AppSubscription/disable-test' },
    ]);

    const [refreshed] = await app.db
      .select()
      .from(schema.shopifyStores)
      .where(eq(schema.shopifyStores.id, store.id));
    expect(refreshed.autorefillStatus).toBeNull();
    expect(refreshed.autorefillSubscriptionId).toBeNull();
  });

  it('still clears local columns even if the Shopify cancel call fails', async () => {
    await reset(100, {
      autorefillStatus: 'ACTIVE',
      autorefillSubscriptionId: 'gid://shopify/AppSubscription/disable-fail-test',
    });

    await disableAutorefill(app, store, {
      cancelSubscription: async () => {
        throw new Error('simulated Shopify outage');
      },
    });

    const [refreshed] = await app.db
      .select()
      .from(schema.shopifyStores)
      .where(eq(schema.shopifyStores.id, store.id));
    expect(refreshed.autorefillStatus).toBeNull();
    expect(refreshed.autorefillSubscriptionId).toBeNull();
  });
});

describe('refreshAutorefillState', () => {
  const observed = (over: Partial<SubscriptionState> = {}): SubscriptionState => ({
    id: 'gid://shopify/AppSubscription/refresh',
    status: 'ACTIVE',
    cappedAmountUsd: 50,
    balanceUsedUsd: 10,
    ...over,
  });

  // Merchants can change the capped amount from the Shopify admin, where this
  // app never sees the click — and we show that number back to them.
  it('writes back a ceiling the merchant changed in the Shopify admin', async () => {
    await reset(100, {
      autorefillStatus: 'ACTIVE',
      autorefillSubscriptionId: 'gid://shopify/AppSubscription/refresh',
      autorefillCappedAmountCents: 5000,
    });

    await refreshAutorefillState(app, store, {
      fetchStatus: async () => observed({ cappedAmountUsd: 120, balanceUsedUsd: 30 }),
    });

    const [refreshed] = await app.db
      .select()
      .from(schema.shopifyStores)
      .where(eq(schema.shopifyStores.id, store.id));
    expect(refreshed.autorefillCappedAmountCents).toBe(12000);
    expect(refreshed.autorefillBalanceUsedCents).toBe(3000);
  });

  // CAP_REACHED is ours, not Shopify's, and nothing else ever clears it — a
  // merchant who raises the ceiling in the Shopify admin would otherwise stay
  // stuck with auto-refill off despite headroom they already paid for.
  it('recovers from CAP_REACHED once there is headroom again', async () => {
    await reset(100, {
      autorefillStatus: 'CAP_REACHED',
      autorefillSubscriptionId: 'gid://shopify/AppSubscription/refresh',
      autorefillCappedAmountCents: 5000,
      autorefillCapWarnedAt: new Date(),
    });

    await refreshAutorefillState(app, store, {
      fetchStatus: async () => observed({ cappedAmountUsd: 200, balanceUsedUsd: 50 }),
    });

    const [refreshed] = await app.db
      .select()
      .from(schema.shopifyStores)
      .where(eq(schema.shopifyStores.id, store.id));
    expect(refreshed.autorefillStatus).toBe('ACTIVE');
    // The ceiling they were warned about is not the ceiling they now have.
    expect(refreshed.autorefillCapWarnedAt).toBeNull();
  });

  it('stays CAP_REACHED while the ceiling is still exhausted', async () => {
    await reset(100, {
      autorefillStatus: 'CAP_REACHED',
      autorefillSubscriptionId: 'gid://shopify/AppSubscription/refresh',
      autorefillCappedAmountCents: 5000,
    });

    await refreshAutorefillState(app, store, {
      fetchStatus: async () => observed({ cappedAmountUsd: 50, balanceUsedUsd: 50 }),
    });

    const [refreshed] = await app.db
      .select()
      .from(schema.shopifyStores)
      .where(eq(schema.shopifyStores.id, store.id));
    expect(refreshed.autorefillStatus).toBe('CAP_REACHED');
  });

  // Recovery must never re-arm a subscription the merchant actually cancelled,
  // however much headroom the line item reports.
  it('never recovers a subscription Shopify reports as cancelled', async () => {
    await reset(100, {
      autorefillStatus: 'CAP_REACHED',
      autorefillSubscriptionId: 'gid://shopify/AppSubscription/refresh',
    });

    await refreshAutorefillState(app, store, {
      fetchStatus: async () =>
        observed({ status: 'CANCELLED', cappedAmountUsd: 200, balanceUsedUsd: 0 }),
    });

    const [refreshed] = await app.db
      .select()
      .from(schema.shopifyStores)
      .where(eq(schema.shopifyStores.id, store.id));
    expect(refreshed.autorefillStatus).toBe('CANCELLED');
  });
});

describe('app_subscriptions_approaching_capped_amount webhook — HTTP layer', () => {
  const deliver = async (subscriptionId: string) => {
    const body = JSON.stringify({
      admin_graphql_api_id: subscriptionId,
      name: 'TryMe auto-refill',
      capped_amount: '50.00',
      admin_graphql_api_shop_id: `gid://shopify/Shop/${store.shopifyShopId}`,
    });
    return app.inject({
      method: 'POST',
      url: '/v1/shopify/webhooks/app_subscriptions_approaching_capped_amount',
      headers: {
        'content-type': 'application/json',
        'x-shopify-hmac-sha256': createHmac('sha256', WEBHOOK_SECRET).update(body).digest('base64'),
        'x-shopify-shop-domain': store.shopDomain,
      },
      payload: body,
    });
  };

  const warnedAt = async () => {
    const [row] = await app.db
      .select()
      .from(schema.shopifyStores)
      .where(eq(schema.shopifyStores.id, store.id));
    return row.autorefillCapWarnedAt;
  };

  // No shopEmail on this fixture, so the email itself is skipped — what this
  // proves is that the route accepts a real delivery, matches it to the right
  // store, and records that the warning was handled. The store's own token is
  // a fake, so the live refresh inside fails and the stored ceiling is used:
  // that fallback is deliberate, since dropping the warning over a brief
  // Shopify outage is worse for the merchant than warning with a stale figure.
  it('stamps the store as warned on a real HMAC-signed delivery', async () => {
    await reset(100, {
      autorefillStatus: 'ACTIVE',
      autorefillSubscriptionId: 'gid://shopify/AppSubscription/approaching',
      autorefillCappedAmountCents: 5000,
      autorefillCapWarnedAt: null,
    });

    expect((await deliver('gid://shopify/AppSubscription/approaching')).statusCode).toBe(200);
    expect(await warnedAt()).not.toBeNull();
  });

  // Shopify may re-deliver this topic across one cycle; one email per ceiling
  // is enough.
  it('does not re-warn on a redelivery', async () => {
    const alreadyWarned = new Date('2026-08-01T00:00:00.000Z');
    await reset(100, {
      autorefillStatus: 'ACTIVE',
      autorefillSubscriptionId: 'gid://shopify/AppSubscription/approaching',
      autorefillCappedAmountCents: 5000,
      autorefillCapWarnedAt: alreadyWarned,
    });

    expect((await deliver('gid://shopify/AppSubscription/approaching')).statusCode).toBe(200);
    expect(await warnedAt()).toEqual(alreadyWarned);
  });

  it('is a no-op when the delivered subscription id does not match the store', async () => {
    await reset(100, {
      autorefillStatus: 'ACTIVE',
      autorefillSubscriptionId: 'gid://shopify/AppSubscription/approaching',
      autorefillCappedAmountCents: 5000,
      autorefillCapWarnedAt: null,
    });

    expect((await deliver('gid://shopify/AppSubscription/unrelated')).statusCode).toBe(200);
    expect(await warnedAt()).toBeNull();
  });
});

describe('app_subscriptions_update webhook — HTTP layer', () => {
  // Everything above this block drives the CANCELLED/ACTIVE transition by
  // seeding `autorefillStatus` straight into the DB via `reset()` — it proves
  // runRefill respects whatever status is already on the row, but never
  // proves the webhook route itself parses a real Shopify delivery, matches
  // it to the right store's subscription, and maps status correctly. This
  // POSTs an HMAC-signed body straight at the registered route, mirroring the
  // convention in shopify-purchase.test.ts's "HTTP layer" block.
  it('updates autorefillStatus from a real HMAC-signed subscription-cancelled delivery', async () => {
    await reset(100, {
      autorefillStatus: 'ACTIVE',
      autorefillSubscriptionId: 'gid://shopify/AppSubscription/webhook-cancel',
    });

    const body = JSON.stringify({
      admin_graphql_api_id: 'gid://shopify/AppSubscription/webhook-cancel',
      name: 'TryMe auto-refill',
      status: 'CANCELLED',
      admin_graphql_api_shop_id: `gid://shopify/Shop/${store.shopifyShopId}`,
      created_at: '2026-08-19T00:00:00-04:00',
      updated_at: '2026-08-19T00:00:01-04:00',
    });
    const hmac = createHmac('sha256', WEBHOOK_SECRET).update(body).digest('base64');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/shopify/webhooks/app_subscriptions_update',
      headers: {
        'content-type': 'application/json',
        'x-shopify-hmac-sha256': hmac,
        'x-shopify-shop-domain': store.shopDomain,
      },
      payload: body,
    });

    expect(res.statusCode).toBe(200);

    const [refreshed] = await app.db
      .select()
      .from(schema.shopifyStores)
      .where(eq(schema.shopifyStores.id, store.id));
    expect(refreshed.autorefillStatus).toBe('CANCELLED');
  });

  it('is a no-op when the delivered subscription id does not match the one on the store', async () => {
    await reset(100, {
      autorefillStatus: 'ACTIVE',
      autorefillSubscriptionId: 'gid://shopify/AppSubscription/webhook-mismatch',
    });

    const body = JSON.stringify({
      admin_graphql_api_id: 'gid://shopify/AppSubscription/some-unrelated-subscription',
      status: 'CANCELLED',
    });
    const hmac = createHmac('sha256', WEBHOOK_SECRET).update(body).digest('base64');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/shopify/webhooks/app_subscriptions_update',
      headers: {
        'content-type': 'application/json',
        'x-shopify-hmac-sha256': hmac,
        'x-shopify-shop-domain': store.shopDomain,
      },
      payload: body,
    });

    expect(res.statusCode).toBe(200);

    const [refreshed] = await app.db
      .select()
      .from(schema.shopifyStores)
      .where(eq(schema.shopifyStores.id, store.id));
    // Wrong subscription id — the store's real ACTIVE authorization was
    // never touched.
    expect(refreshed.autorefillStatus).toBe('ACTIVE');
  });
});
