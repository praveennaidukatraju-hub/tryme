/**
 * Answers one question: can this app still create charges through the Billing API?
 *
 * There is no read-only way to ask. Shopify exposes no field — not on the Admin
 * API, not on the Partner API — for whether an app is on Manual pricing or on
 * Shopify App Pricing (formerly Managed Pricing). The only authoritative signal
 * is what a charge mutation actually answers, because the refusal is a
 * userError on the mutation itself:
 *
 *   "Managed Pricing Apps cannot use the Billing API (to create charges)."
 *
 * That matters because the Partner Dashboard can flip the app onto Shopify App
 * Pricing as a side effect of editing the public plans on the App Store
 * listing, and when it does, EVERY charge in this app dies at once — one-time
 * pack purchases and auto-refill subscriptions alike — with no deploy, no code
 * change, and nothing visibly different until a merchant clicks Buy. Run this
 * after any Partner Dashboard pricing or listing edit, and before submitting
 * for review.
 *
 * What it does: creates a REAL one-time charge on the given store and reads the
 * answer. Nothing is billed — the merchant is never sent to the confirmation
 * URL, so the charge stays PENDING forever and expires on its own. On a partner
 * development store the charge is a test charge regardless. It writes no row to
 * shopify_credit_purchases: it calls Shopify directly rather than going through
 * createPurchase, precisely so a probe never looks like a merchant's purchase.
 *
 * Lives under apps/api rather than the repo-root scripts/ directory because it
 * imports the api's own token and GraphQL modules, plus ioredis — none of which
 * resolve from the root package, which depends only on @tryme/db.
 *
 * Usage:
 *   pnpm check:billing                                  # first installed store
 *   pnpm check:billing my-dev-store.myshopify.com       # a specific store
 *
 * Requires env: DATABASE_URL, SHOPIFY_TOKEN_ENC_KEY (to decrypt the store's
 * access token), and whatever getValidAccessToken needs to refresh it.
 */

import { createDb, eq, isNull, schema } from '@tryme/db';
import Redis from 'ioredis';

const PROBE_MUTATION = `
  mutation BillingApiProbe($name: String!, $price: MoneyInput!, $returnUrl: URL!, $test: Boolean!) {
    appPurchaseOneTimeCreate(name: $name, price: $price, returnUrl: $returnUrl, test: $test) {
      confirmationUrl
      appPurchaseOneTime { id status test }
      userErrors { field message }
    }
  }
`;

// Output goes through console rather than the pino logger the services use:
// this is an ops script read by a human at a terminal, and the root package
// deliberately depends only on @tryme/db. Same convention as
// scripts/backfill-thumbnails.mts.
const shopArg = process.argv[2];

const { db, close } = createDb(process.env.DATABASE_URL ?? '');

try {
  const stores = await db
    .select()
    .from(schema.shopifyStores)
    .where(
      shopArg
        ? eq(schema.shopifyStores.shopDomain, shopArg)
        : isNull(schema.shopifyStores.uninstalledAt),
    )
    .limit(1);

  const store = stores[0];
  if (!store) {
    console.error('no installed store found to probe against', { shopArg });
    process.exit(2);
  }

  // Imported lazily and by path: this script is an ops tool run from the repo
  // root, and pulling in the api module graph at the top would make a missing
  // env var fail before the friendlier checks above ever run.
  const { getValidAccessToken } = await import('../src/modules/shopify/token.js');
  const { shopifyGraphQL } = await import('../src/modules/shopify/service.js');

  // getValidAccessToken wants a Fastify instance for its env, db, logger and
  // redis — redis included because a token close to expiry is refreshed under
  // a Redis lock, and a stub without it throws only on the stores whose token
  // happens to need refreshing, which is the worst possible time to discover
  // the gap.
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379');
  const app = {
    env: process.env,
    db,
    redis,
    log: { info: console.log, warn: console.warn, error: console.error },
  } as never;
  let accessToken: string;
  try {
    accessToken = await getValidAccessToken(app, store);
  } finally {
    redis.disconnect();
  }

  const data = await shopifyGraphQL<{
    appPurchaseOneTimeCreate: {
      confirmationUrl: string | null;
      appPurchaseOneTime: { id: string; status: string; test: boolean } | null;
      userErrors: Array<{ field: string[] | null; message: string }>;
    };
  }>(store.shopDomain, accessToken, PROBE_MUTATION, {
    name: 'TryMe billing-API probe (never approved)',
    price: { amount: '1.00', currencyCode: 'USD' },
    // Deliberately not a real app route. The merchant is never sent here — this
    // exists only because the mutation requires the argument.
    returnUrl: 'https://example.com/billing-api-probe',
    test: true,
  });

  const payload = data.appPurchaseOneTimeCreate;
  const errors = payload.userErrors ?? [];
  const managed = errors.some((e) => /managed pricing/i.test(e.message));

  if (managed) {
    console.error(
      'BILLING DISABLED — the app is on Shopify App Pricing. Every charge in the app fails until it is switched back to Manual pricing in the Partner Dashboard.',
      { shopDomain: store.shopDomain, errors: errors.map((e) => e.message) },
    );
    process.exit(1);
  }
  if (errors.length) {
    console.error('charge mutation refused for some other reason — read the messages', {
      shopDomain: store.shopDomain,
      errors: errors.map((e) => e.message),
    });
    process.exit(1);
  }
  if (!payload.confirmationUrl || !payload.appPurchaseOneTime) {
    console.error('Shopify returned neither an error nor a charge', {
      shopDomain: store.shopDomain,
    });
    process.exit(1);
  }

  console.log(
    'Billing API is enabled — the app is on Manual pricing. The probe charge stays PENDING and is never approved.',
    {
      shopDomain: store.shopDomain,
      chargeId: payload.appPurchaseOneTime.id,
      test: payload.appPurchaseOneTime.test,
      partnerDevelopment: store.partnerDevelopment,
    },
  );
} finally {
  await close();
}
