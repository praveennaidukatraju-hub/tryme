import { createHmac } from 'node:crypto';
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { upsertShopifyStore } from '../../src/modules/shopify/auth.routes.js';
import {
  confirmPurchase,
  createPurchase,
  grantForPurchase,
} from '../../src/modules/shopify/purchase.js';
import { buildTestApp } from '../helpers/api.js';
import { type Containers, startContainers } from '../helpers/containers.js';

let ctx: Containers;
let app: Awaited<ReturnType<typeof buildTestApp>>;
let store: typeof schema.shopifyStores.$inferSelect;

// Fixed 32-byte key so upsertShopifyStore's encryptToken round-trips through
// getValidAccessToken in the webhook-route test below — see
// shopify-widget-config.test.ts for the same convention.
const TOKEN_ENC_KEY = Buffer.alloc(32, 11).toString('base64');
const WEBHOOK_SECRET = 'webhook-test-secret';

const fakeCharge = (overrides: Partial<{ id: string; status: string; test: boolean }> = {}) => ({
  id: 'gid://shopify/AppPurchaseOneTime/1',
  status: 'ACTIVE',
  test: false,
  ...overrides,
});

beforeAll(async () => {
  ctx = await startContainers();
  // createPurchase (purchase.ts, Task 3) requires SHOPIFY_APP_URL to build the
  // Shopify return URL — buildTestApp does not set it by default, so it must be
  // supplied here or every createPurchase call in this file throws CONFIG 500.
  // SHOPIFY_API_SECRET/SHOPIFY_TOKEN_ENC_KEY are only exercised by the HTTP-layer
  // webhook test below (real HMAC verification + real token decryption) — every
  // other test in this file goes through dependency-injected fakes and never
  // touches either.
  app = await buildTestApp(ctx, {
    SHOPIFY_APP_URL: 'https://app.tryme.test',
    SHOPIFY_API_SECRET: WEBHOOK_SECRET,
    SHOPIFY_TOKEN_ENC_KEY: TOKEN_ENC_KEY,
  });
  [store] = await app.db
    .insert(schema.shopifyStores)
    .values({
      shopDomain: 'purchase-test.myshopify.com',
      shopifyShopId: 987654321,
      accessToken: 'enc:token',
      scope: 'read_products',
    })
    .returning();
}, 60000);

afterAll(async () => {
  await app.close();
  await ctx.stop();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('credit pack purchase', () => {
  it('writes a PENDING row and returns the confirmation URL', async () => {
    const result = await createPurchase(app, store, 'pack_25', {
      createCharge: async () => ({
        confirmationUrl: 'https://shopify.test/confirm',
        purchase: fakeCharge(),
      }),
    });

    expect(result.confirmationUrl).toBe('https://shopify.test/confirm');

    const [row] = await app.db
      .select()
      .from(schema.shopifyCreditPurchases)
      .where(eq(schema.shopifyCreditPurchases.id, result.purchaseId));

    expect(row.status).toBe('PENDING');
    expect(row.credits).toBe(2250);
    expect(row.priceUsdCents).toBe(2500);
    expect(row.source).toBe('manual');
  });

  it('rejects an unknown pack id without writing a row', async () => {
    const before = await app.db.select().from(schema.shopifyCreditPurchases);
    await expect(createPurchase(app, store, 'pack_999')).rejects.toThrow();
    const after = await app.db.select().from(schema.shopifyCreditPurchases);
    expect(after.length).toBe(before.length);
  });

  it('grants credits once on an ACTIVE charge, and never twice', async () => {
    const chargeId = 'gid://shopify/AppPurchaseOneTime/double';
    const { purchaseId } = await createPurchase(app, store, 'pack_10', {
      createCharge: async () => ({
        confirmationUrl: 'https://shopify.test/c',
        purchase: fakeCharge({ id: chargeId }),
      }),
    });
    const deps = { fetchPurchase: async () => fakeCharge({ id: chargeId }) };

    const first = await confirmPurchase(app, store, purchaseId, deps);
    expect(first.creditsGranted).toBe(800);

    const second = await confirmPurchase(app, store, purchaseId, deps);
    expect(second.creditsGranted).toBe(0);
    expect(second.creditBalance).toBe(first.creditBalance);
  });

  it('grants nothing while the charge is still PENDING', async () => {
    const { purchaseId } = await createPurchase(app, store, 'pack_10', {
      createCharge: async () => ({
        confirmationUrl: 'https://shopify.test/c',
        purchase: fakeCharge({ id: 'gid://shopify/AppPurchaseOneTime/pending' }),
      }),
    });
    const result = await confirmPurchase(app, store, purchaseId, {
      fetchPurchase: async () =>
        fakeCharge({ id: 'gid://shopify/AppPurchaseOneTime/pending', status: 'PENDING' }),
    });
    expect(result.creditsGranted).toBe(0);
    expect(result.status).toBe('PENDING');
  });

  it('grants nothing for a DECLINED charge', async () => {
    const { purchaseId } = await createPurchase(app, store, 'pack_10', {
      createCharge: async () => ({
        confirmationUrl: 'https://shopify.test/c',
        purchase: fakeCharge({ id: 'gid://shopify/AppPurchaseOneTime/declined' }),
      }),
    });
    const result = await confirmPurchase(app, store, purchaseId, {
      fetchPurchase: async () =>
        fakeCharge({ id: 'gid://shopify/AppPurchaseOneTime/declined', status: 'DECLINED' }),
    });
    expect(result.creditsGranted).toBe(0);
  });

  // App Store reviewers test on a development store, where Shopify makes every
  // charge a test charge. Refusing those outright is what makes the app look
  // broken during review, so these two cover the narrow allowance and the bound
  // that keeps it from being a free-credit faucet.
  it('grants a test charge on a partner development store', async () => {
    const [devStore] = await app.db
      .insert(schema.shopifyStores)
      .values({
        shopDomain: 'dev-store-grant.myshopify.com',
        shopifyShopId: 987654330,
        accessToken: 'enc:token',
        scope: 'read_products',
        partnerDevelopment: true,
      })
      .returning();

    const { purchaseId } = await createPurchase(app, devStore, 'pack_10', {
      createCharge: async () => ({
        confirmationUrl: 'https://shopify.test/c',
        purchase: fakeCharge({ id: 'gid://shopify/AppPurchaseOneTime/dev-1', test: true }),
      }),
    });
    const result = await confirmPurchase(app, devStore, purchaseId, {
      fetchPurchase: async () =>
        fakeCharge({ id: 'gid://shopify/AppPurchaseOneTime/dev-1', test: true }),
    });
    expect(result.creditsGranted).toBe(800);
  });

  it('stops granting test charges on a development store past the lifetime limit', async () => {
    const [devStore] = await app.db
      .insert(schema.shopifyStores)
      .values({
        shopDomain: 'dev-store-limit.myshopify.com',
        shopifyShopId: 987654331,
        accessToken: 'enc:token',
        scope: 'read_products',
        partnerDevelopment: true,
      })
      .returning();

    const buy = async (n: number) => {
      const chargeId = `gid://shopify/AppPurchaseOneTime/dev-limit-${n}`;
      const { purchaseId } = await createPurchase(app, devStore, 'pack_10', {
        createCharge: async () => ({
          confirmationUrl: 'https://shopify.test/c',
          purchase: fakeCharge({ id: chargeId, test: true }),
        }),
      });
      return confirmPurchase(app, devStore, purchaseId, {
        fetchPurchase: async () => fakeCharge({ id: chargeId, test: true }),
      });
    };

    // TEST_GRANT_LIMIT is 3.
    expect((await buy(1)).creditsGranted).toBe(800);
    expect((await buy(2)).creditsGranted).toBe(800);
    expect((await buy(3)).creditsGranted).toBe(800);
    expect((await buy(4)).creditsGranted).toBe(0);
  });

  // The limit exists for development stores we did not choose to trust — a
  // reviewer's, or anyone's once the app is publicly installable. An operator
  // who sets the flag has opted in deliberately, and capping them there strands
  // local testing of the low-balance and auto-refill paths halfway through.
  it('does not apply the test-grant limit when the env gate is explicitly on', async () => {
    const flagged = await buildTestApp(ctx, {
      SHOPIFY_APP_URL: 'https://app.tryme.test',
      SHOPIFY_ALLOW_TEST_SUBSCRIPTIONS: true,
    });
    try {
      const [devStore] = await flagged.db
        .insert(schema.shopifyStores)
        .values({
          shopDomain: 'dev-store-unbounded.myshopify.com',
          shopifyShopId: 987654332,
          accessToken: 'enc:token',
          scope: 'read_products',
          partnerDevelopment: true,
        })
        .returning();

      let granted = 0;
      for (let n = 1; n <= 5; n++) {
        const chargeId = `gid://shopify/AppPurchaseOneTime/unbounded-${n}`;
        const { purchaseId } = await createPurchase(flagged, devStore, 'pack_10', {
          createCharge: async () => ({
            confirmationUrl: 'https://shopify.test/c',
            purchase: fakeCharge({ id: chargeId, test: true }),
          }),
        });
        const result = await confirmPurchase(flagged, devStore, purchaseId, {
          fetchPurchase: async () => fakeCharge({ id: chargeId, test: true }),
        });
        granted += result.creditsGranted;
      }
      // 5 packs, all granted — past TEST_GRANT_LIMIT of 3.
      expect(granted).toBe(4000);
    } finally {
      await flagged.close();
    }
  });

  it('grants nothing for a test charge on a real store when the env gate is off', async () => {
    const { purchaseId } = await createPurchase(app, store, 'pack_10', {
      createCharge: async () => ({
        confirmationUrl: 'https://shopify.test/c',
        purchase: fakeCharge({ id: 'gid://shopify/AppPurchaseOneTime/test' }),
      }),
    });
    const result = await confirmPurchase(app, store, purchaseId, {
      fetchPurchase: async () =>
        fakeCharge({ id: 'gid://shopify/AppPurchaseOneTime/test', test: true }),
    });
    expect(result.creditsGranted).toBe(0);
  });

  it("returns 404 for another store's purchase row", async () => {
    const [other] = await app.db
      .insert(schema.shopifyStores)
      .values({
        shopDomain: 'other-purchase-test.myshopify.com',
        shopifyShopId: 987654322,
        accessToken: 'enc:token',
        scope: 'read_products',
      })
      .returning();
    const { purchaseId } = await createPurchase(app, store, 'pack_10', {
      createCharge: async () => ({
        confirmationUrl: 'https://shopify.test/c',
        purchase: fakeCharge({ id: 'gid://shopify/AppPurchaseOneTime/other' }),
      }),
    });
    await expect(confirmPurchase(app, other, purchaseId)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  // The one guarantee in this module a future refactor could quietly undo.
  it('grants the snapshotted credits even after an admin edits the pack', async () => {
    const { purchaseId } = await createPurchase(app, store, 'pack_10', {
      createCharge: async () => ({
        confirmationUrl: 'https://shopify.test/c',
        purchase: fakeCharge({ id: 'gid://shopify/AppPurchaseOneTime/snapshot' }),
      }),
    });

    await app.redis.set(
      'config:system',
      JSON.stringify({ shopify: { packCredits: { pack_10: { credits: 999999 } } } }),
    );

    const result = await confirmPurchase(app, store, purchaseId, {
      fetchPurchase: async () => fakeCharge({ id: 'gid://shopify/AppPurchaseOneTime/snapshot' }),
    });
    expect(result.creditsGranted).toBe(800);

    await app.redis.del('config:system');
  });
});

describe('one-time purchase webhook', () => {
  it('grants credits for a merchant who never returned to the confirm route', async () => {
    const chargeId = 'gid://shopify/AppPurchaseOneTime/webhook';
    const { purchaseId } = await createPurchase(app, store, 'pack_50', {
      createCharge: async () => ({
        confirmationUrl: 'https://shopify.test/c',
        purchase: fakeCharge({ id: chargeId }),
      }),
    });

    const [row] = await app.db
      .select()
      .from(schema.shopifyCreditPurchases)
      .where(eq(schema.shopifyCreditPurchases.id, purchaseId));

    const granted = await grantForPurchase(app, store, row, {
      id: chargeId,
      status: 'ACTIVE',
      test: false,
    });
    expect(granted).toBe(4800);

    // The merchant later opens the app and hits confirm — must not double-grant.
    const confirmResult = await confirmPurchase(app, store, purchaseId, {
      fetchPurchase: async () => fakeCharge({ id: chargeId }),
    });
    expect(confirmResult.creditsGranted).toBe(0);
  });
});

describe('app_purchases_one_time_update webhook — HTTP layer', () => {
  // Everything above this block exercises grantForPurchase/confirmPurchase
  // directly, hand-constructing the {id, status, test} shape the route is
  // actually responsible for producing — it never proves the route parses a
  // real Shopify delivery correctly. This is the test that would have caught
  // C1 (payload nested under app_purchase_one_time, not at the root) and C2
  // (no `test` field on the payload at all — reading one off it silently
  // defeats the dev-store abuse gate). It POSTs an HMAC-signed, correctly
  // shaped body straight at the registered route.
  it("grants credits for a real, HMAC-signed webhook delivery shaped like Shopify's documented sample payload", async () => {
    const webhookStore = await upsertShopifyStore(
      app,
      {
        shopifyShopId: 555111222,
        shopDomain: 'webhook-http-test.myshopify.com',
        myshopifyDomain: 'webhook-http-test.myshopify.com',
        name: 'Webhook HTTP Test',
        email: 'webhook-http-test@example.com',
      },
      'real-offline-token',
      'read_products',
    );

    const chargeId = 'gid://shopify/AppPurchaseOneTime/http-webhook';
    const { purchaseId } = await createPurchase(app, webhookStore, 'pack_50', {
      createCharge: async () => ({
        confirmationUrl: 'https://shopify.test/c',
        purchase: fakeCharge({ id: chargeId, status: 'PENDING' }),
      }),
    });

    // The webhook handler re-fetches the charge's real state from Shopify via
    // node(id:) (purchase.ts's defaultFetchPurchase) rather than trusting
    // anything in the delivered payload except the charge id — this stubs
    // that GraphQL call. Never inspects the webhook body itself.
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            data: { node: { id: chargeId, status: 'ACTIVE', test: false } },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      ),
    );

    // Shopify's documented sample shape for app_purchases_one_time/update —
    // the whole resource nested under app_purchase_one_time, not at the
    // payload root, and with no `test` field at all.
    const body = JSON.stringify({
      app_purchase_one_time: {
        admin_graphql_api_id: chargeId,
        name: 'Webhook Test',
        status: 'ACTIVE',
        admin_graphql_api_shop_id: 'gid://shopify/Shop/555111222',
        created_at: '2026-08-19T00:00:00-04:00',
        updated_at: '2026-08-19T00:00:01-04:00',
      },
    });
    const hmac = createHmac('sha256', WEBHOOK_SECRET).update(body).digest('base64');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/shopify/webhooks/app_purchases_one_time_update',
      headers: {
        'content-type': 'application/json',
        'x-shopify-hmac-sha256': hmac,
        'x-shopify-shop-domain': webhookStore.shopDomain,
      },
      payload: body,
    });

    expect(res.statusCode).toBe(200);

    const [purchaseRow] = await app.db
      .select()
      .from(schema.shopifyCreditPurchases)
      .where(eq(schema.shopifyCreditPurchases.id, purchaseId));
    expect(purchaseRow.status).toBe('ACTIVE');

    const [creditRow] = await app.db
      .select()
      .from(schema.shopifyStoreCredits)
      .where(eq(schema.shopifyStoreCredits.storeId, webhookStore.id));
    expect(creditRow.balance).toBe(4800);
  });

  // The finding this test guards: the webhook's own try/catch used to swallow
  // *every* post-processing failure into a 200, including this one — so a
  // transient Shopify outage on the re-fetch meant Shopify saw success, never
  // retried (it only retries non-2xx), and the merchant's credits were lost
  // for good if their own confirm-route visit also failed. The fix scopes a
  // WebhookOutboundFetchFailure to just this call so it escapes as a non-2xx,
  // which is safe because grantForPurchase is idempotent on external_ref —
  // Shopify redelivering this webhook any number of times cannot double-grant.
  it('returns a non-2xx (not a swallowed 200) when the outbound Shopify re-fetch fails, so Shopify retries', async () => {
    const webhookStore = await upsertShopifyStore(
      app,
      {
        shopifyShopId: 555111223,
        shopDomain: 'webhook-fetch-fail-test.myshopify.com',
        myshopifyDomain: 'webhook-fetch-fail-test.myshopify.com',
        name: 'Webhook Fetch Fail Test',
        email: 'webhook-fetch-fail-test@example.com',
      },
      'real-offline-token',
      'read_products',
    );

    const chargeId = 'gid://shopify/AppPurchaseOneTime/http-webhook-fail';
    const { purchaseId } = await createPurchase(app, webhookStore, 'pack_50', {
      createCharge: async () => ({
        confirmationUrl: 'https://shopify.test/c',
        purchase: fakeCharge({ id: chargeId, status: 'PENDING' }),
      }),
    });

    // Simulate a transient outbound failure (network blip / 5xx) on the
    // node(id:) re-fetch — same injection point (global fetch) the passing
    // HTTP-layer test above uses to stub a successful re-fetch.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('simulated network failure')));

    const body = JSON.stringify({
      app_purchase_one_time: {
        admin_graphql_api_id: chargeId,
        name: 'Webhook Fetch Fail Test',
        status: 'ACTIVE',
        admin_graphql_api_shop_id: 'gid://shopify/Shop/555111223',
        created_at: '2026-08-19T00:00:00-04:00',
        updated_at: '2026-08-19T00:00:01-04:00',
      },
    });
    const hmac = createHmac('sha256', WEBHOOK_SECRET).update(body).digest('base64');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/shopify/webhooks/app_purchases_one_time_update',
      headers: {
        'content-type': 'application/json',
        'x-shopify-hmac-sha256': hmac,
        'x-shopify-shop-domain': webhookStore.shopDomain,
      },
      payload: body,
    });

    expect(res.statusCode).not.toBe(200);
    expect(res.statusCode).toBeGreaterThanOrEqual(500);

    // No grant happened and the row was never advanced past PENDING — proof
    // the failure short-circuited before grantForPurchase, not just that the
    // HTTP response happened to be non-200.
    const [purchaseRow] = await app.db
      .select()
      .from(schema.shopifyCreditPurchases)
      .where(eq(schema.shopifyCreditPurchases.id, purchaseId));
    expect(purchaseRow.status).toBe('PENDING');

    const [creditRow] = await app.db
      .select()
      .from(schema.shopifyStoreCredits)
      .where(eq(schema.shopifyStoreCredits.storeId, webhookStore.id));
    expect(creditRow?.balance ?? 0).toBe(0);
  });

  // The distinguishing half of the same finding: a webhook for a charge id
  // this store has no purchase row for (stray delivery, unrelated charge) is
  // genuinely nothing to do — it must stay a normal 200 no-op, not be swept
  // into the same retry-triggering error path as an actual outbound failure.
  it('is a no-op 200 (not an error) when the charge id matches no purchase row', async () => {
    const webhookStore = await upsertShopifyStore(
      app,
      {
        shopifyShopId: 555111224,
        shopDomain: 'webhook-no-match-test.myshopify.com',
        myshopifyDomain: 'webhook-no-match-test.myshopify.com',
        name: 'Webhook No Match Test',
        email: 'webhook-no-match-test@example.com',
      },
      'real-offline-token',
      'read_products',
    );

    // Prove the outbound Shopify call is never reached for this case: if it
    // were, this stub would make the test fail loudly instead of silently
    // passing for the wrong reason.
    const fetchStub = vi.fn().mockRejectedValue(new Error('should not be called'));
    vi.stubGlobal('fetch', fetchStub);

    const body = JSON.stringify({
      app_purchase_one_time: {
        admin_graphql_api_id: 'gid://shopify/AppPurchaseOneTime/no-such-row',
        name: 'Webhook No Match Test',
        status: 'ACTIVE',
        admin_graphql_api_shop_id: 'gid://shopify/Shop/555111224',
        created_at: '2026-08-19T00:00:00-04:00',
        updated_at: '2026-08-19T00:00:01-04:00',
      },
    });
    const hmac = createHmac('sha256', WEBHOOK_SECRET).update(body).digest('base64');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/shopify/webhooks/app_purchases_one_time_update',
      headers: {
        'content-type': 'application/json',
        'x-shopify-hmac-sha256': hmac,
        'x-shopify-shop-domain': webhookStore.shopDomain,
      },
      payload: body,
    });

    expect(res.statusCode).toBe(200);
    expect(fetchStub).not.toHaveBeenCalled();
  });
});
