import type { schema } from '@tryme/db';
import type { FastifyInstance } from 'fastify';
import { AppError } from '../../lib/errors.js';
import { shopifyGraphQL, warnIfManagedPricing } from './service.js';
import { getValidAccessToken } from './token.js';

type Store = typeof schema.shopifyStores.$inferSelect;

interface UserError {
  field: string[] | null;
  message: string;
}

/**
 * A usage-only subscription: `lineItems` carries just appUsagePricingDetails,
 * with no appRecurringPricingDetails at all. Verified supported on shopify.dev
 * — there is no $0 base line and no nominal base fee, so the merchant is billed
 * strictly for refills they actually received.
 *
 * `cappedAmount` is the ceiling the merchant approves once. Every refill after
 * that needs no approval while the cycle's cumulative total stays under it.
 */
const CREATE_SUBSCRIPTION = `
  mutation CreateAutorefillSubscription(
    $name: String!
    $returnUrl: URL!
    $test: Boolean!
    $lineItems: [AppSubscriptionLineItemInput!]!
  ) {
    appSubscriptionCreate(name: $name, returnUrl: $returnUrl, test: $test, lineItems: $lineItems) {
      confirmationUrl
      appSubscription {
        id
        status
        lineItems {
          id
        }
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const CREATE_USAGE_RECORD = `
  mutation CreateAutorefillUsageRecord(
    $subscriptionLineItemId: ID!
    $description: String!
    $price: MoneyInput!
    $idempotencyKey: String!
  ) {
    appUsageRecordCreate(
      subscriptionLineItemId: $subscriptionLineItemId
      description: $description
      price: $price
      idempotencyKey: $idempotencyKey
    ) {
      appUsageRecord {
        id
      }
      userErrors {
        field
        message
      }
    }
  }
`;

const UPDATE_CAPPED_AMOUNT = `
  mutation UpdateAutorefillCap($id: ID!, $cappedAmount: MoneyInput!) {
    appSubscriptionLineItemUpdate(id: $id, cappedAmount: $cappedAmount) {
      confirmationUrl
      userErrors {
        field
        message
      }
    }
  }
`;

const CANCEL_SUBSCRIPTION = `
  mutation CancelAutorefillSubscription($id: ID!) {
    appSubscriptionCancel(id: $id) {
      appSubscription {
        id
        status
      }
      userErrors {
        field
        message
      }
    }
  }
`;

/**
 * node(id:) rather than currentAppInstallation.activeSubscriptions — the
 * subscription may no longer be "active" (that's exactly the case this exists
 * to distinguish), and a Node lookup by id costs one round trip regardless of
 * how many subscriptions the shop has. Mirrors purchase.ts's
 * PURCHASE_STATUS_QUERY pattern for the equivalent one-time-charge case.
 */
const SUBSCRIPTION_STATUS_QUERY = `
  query AutorefillSubscriptionStatus($id: ID!) {
    node(id: $id) {
      ... on AppSubscription {
        id
        status
        lineItems {
          id
          plan {
            pricingDetails {
              ... on AppUsagePricing {
                cappedAmount { amount }
                balanceUsed { amount }
              }
            }
          }
        }
      }
    }
  }
`;

interface SubscriptionNode {
  id: string;
  status: string;
  lineItems?: Array<{
    id: string;
    plan?: {
      pricingDetails?: {
        cappedAmount?: { amount?: string | null } | null;
        balanceUsed?: { amount?: string | null } | null;
      } | null;
    } | null;
  }> | null;
}

export interface SubscriptionState {
  id: string;
  status: string;
  /**
   * The ceiling and the cycle's spend so far, as Shopify currently holds them
   * — null when the subscription has no usage line item to read them off.
   * Both are money strings ("50.00") on the wire; parsed here so no caller has
   * to remember that.
   */
  cappedAmountUsd: number | null;
  balanceUsedUsd: number | null;
}

/** Money strings arrive as "50.00"; anything unparseable is treated as absent. */
function parseMoney(amount: string | null | undefined): number | null {
  if (amount == null) return null;
  const value = Number(amount);
  return Number.isFinite(value) ? value : null;
}

function throwOnUserErrors(
  app: FastifyInstance,
  store: Store,
  errors: UserError[] | undefined,
  context: string,
): void {
  if (errors?.length) {
    const message = errors.map((e) => e.message).join('; ');
    // Every mutation in this file is a charge mutation, so all of them return
    // the Managed Pricing refusal once the app is on Shopify App Pricing —
    // see warnIfManagedPricing for why that one message deserves its own
    // signal rather than another 502 in the pile.
    warnIfManagedPricing(app.log, store.shopDomain, message);
    throw new AppError('SHOPIFY', 502, `${context}: ${message}`);
  }
}

export async function createUsageSubscription(
  app: FastifyInstance,
  store: Store,
  args: {
    name: string;
    terms: string;
    cappedAmountUsd: number;
    returnUrl: string;
    test: boolean;
  },
): Promise<{ confirmationUrl: string; subscriptionId: string; lineItemId: string }> {
  const accessToken = await getValidAccessToken(app, store);
  const data = await shopifyGraphQL<{
    appSubscriptionCreate: {
      confirmationUrl: string | null;
      appSubscription: { id: string; status: string; lineItems: Array<{ id: string }> } | null;
      userErrors: UserError[];
    };
  }>(store.shopDomain, accessToken, CREATE_SUBSCRIPTION, {
    name: args.name,
    returnUrl: args.returnUrl,
    test: args.test,
    lineItems: [
      {
        plan: {
          appUsagePricingDetails: {
            terms: args.terms,
            cappedAmount: { amount: args.cappedAmountUsd.toFixed(2), currencyCode: 'USD' },
          },
        },
      },
    ],
  });

  const payload = data.appSubscriptionCreate;
  throwOnUserErrors(app, store, payload.userErrors, 'auto-refill subscription');

  const lineItemId = payload.appSubscription?.lineItems?.[0]?.id;
  if (!payload.confirmationUrl || !payload.appSubscription || !lineItemId) {
    throw new AppError('SHOPIFY', 502, 'Shopify returned an incomplete auto-refill subscription');
  }

  return {
    confirmationUrl: payload.confirmationUrl,
    subscriptionId: payload.appSubscription.id,
    lineItemId,
  };
}

/**
 * Charges one refill.
 *
 * Returns a discriminated result rather than throwing on the cap case, because
 * hitting a merchant-set ceiling is a normal outcome — the ceiling working as
 * intended — and must not be handled by the same path as a network fault.
 *
 * `idempotencyKey` is Shopify's own duplicate-charge protection: a repeat with
 * the same key does not create a second charge. This is the only guard that
 * helps when we time out on a request Shopify actually accepted, which no
 * amount of application-side locking can detect.
 */
export async function createUsageRecord(
  app: FastifyInstance,
  store: Store,
  args: {
    lineItemId: string;
    description: string;
    amountUsd: number;
    idempotencyKey: string;
  },
): Promise<{ ok: true; recordId: string } | { ok: false; capReached: boolean; message: string }> {
  const accessToken = await getValidAccessToken(app, store);
  const data = await shopifyGraphQL<{
    appUsageRecordCreate: {
      appUsageRecord: { id: string } | null;
      userErrors: UserError[];
    };
  }>(store.shopDomain, accessToken, CREATE_USAGE_RECORD, {
    subscriptionLineItemId: args.lineItemId,
    description: args.description,
    price: { amount: args.amountUsd.toFixed(2), currencyCode: 'USD' },
    idempotencyKey: args.idempotencyKey,
  });

  const payload = data.appUsageRecordCreate;
  if (payload.userErrors?.length) {
    const message = payload.userErrors.map((e) => e.message).join('; ');
    // Shopify phrases cap exhaustion two ways depending on the surface
    // ("Failed to create usage charge" and "Total price exceeds balance
    // remaining"). Match on both rather than on one, and treat anything
    // unrecognized as a genuine failure rather than silently assuming the cap.
    const capReached =
      /exceeds balance remaining/i.test(message) || /failed to create usage charge/i.test(message);
    // This path returns rather than throws, so it never reaches
    // throwOnUserErrors — and a Managed Pricing refusal here would otherwise
    // be filed as an ordinary 'failed' refill and retried forever against an
    // app that cannot charge at all.
    warnIfManagedPricing(app.log, store.shopDomain, message);
    return { ok: false, capReached, message };
  }

  const recordId = payload.appUsageRecord?.id;
  if (!recordId) {
    return { ok: false, capReached: false, message: 'Shopify returned no usage record' };
  }
  return { ok: true, recordId };
}

/**
 * Raising the ceiling needs fresh merchant approval — Shopify returns a
 * confirmation URL and refuses further usage records until it is approved. So
 * this cannot be called to self-heal a CAP_REACHED store; it is the first half
 * of a merchant-facing flow.
 */
export async function updateCappedAmount(
  app: FastifyInstance,
  store: Store,
  args: { lineItemId: string; cappedAmountUsd: number },
): Promise<{ confirmationUrl: string }> {
  const accessToken = await getValidAccessToken(app, store);
  const data = await shopifyGraphQL<{
    appSubscriptionLineItemUpdate: {
      confirmationUrl: string | null;
      userErrors: UserError[];
    };
  }>(store.shopDomain, accessToken, UPDATE_CAPPED_AMOUNT, {
    id: args.lineItemId,
    cappedAmount: { amount: args.cappedAmountUsd.toFixed(2), currencyCode: 'USD' },
  });

  const payload = data.appSubscriptionLineItemUpdate;
  throwOnUserErrors(app, store, payload.userErrors, 'auto-refill cap update');
  if (!payload.confirmationUrl) {
    throw new AppError('SHOPIFY', 502, 'Shopify returned no confirmation URL for the cap update');
  }
  return { confirmationUrl: payload.confirmationUrl };
}

export async function cancelSubscription(
  app: FastifyInstance,
  store: Store,
  subscriptionId: string,
): Promise<void> {
  const accessToken = await getValidAccessToken(app, store);
  const data = await shopifyGraphQL<{
    appSubscriptionCancel: {
      appSubscription: { id: string; status: string } | null;
      userErrors: UserError[];
    };
  }>(store.shopDomain, accessToken, CANCEL_SUBSCRIPTION, { id: subscriptionId });
  throwOnUserErrors(app, store, data.appSubscriptionCancel.userErrors, 'auto-refill cancel');
}

/**
 * Re-fetches a subscription's real current state from Shopify. Used by
 * confirmAutorefill (autorefill.ts) because Shopify redirects the merchant
 * back to the same returnUrl whether they approved or declined — trusting our
 * own row's non-null subscription id would mark a declined subscription
 * ACTIVE, same class of bug purchase.ts's confirmPurchase already avoids for
 * one-time charges via defaultFetchPurchase.
 *
 * The cap and cycle spend come back alongside the status because Shopify is
 * authoritative for both and we are not: "merchants can use the Shopify admin
 * to change their subscription's capped amount", which happens entirely
 * outside this app. A locally-remembered ceiling is therefore a guess, and one
 * we show the merchant — see refreshAutorefillState in autorefill.ts.
 */
export async function fetchSubscriptionStatus(
  app: FastifyInstance,
  store: Store,
  subscriptionId: string,
): Promise<SubscriptionState | null> {
  const accessToken = await getValidAccessToken(app, store);
  const data = await shopifyGraphQL<{ node: SubscriptionNode | null }>(
    store.shopDomain,
    accessToken,
    SUBSCRIPTION_STATUS_QUERY,
    { id: subscriptionId },
  );
  if (!data.node) return null;

  // The usage line item is the only one this app ever creates, so the first
  // one carrying usage pricing is it. Written as a find rather than [0] so a
  // subscription that later grows a second line item doesn't silently start
  // reporting the wrong one's numbers.
  const usage = data.node.lineItems?.find((li) => li.plan?.pricingDetails?.cappedAmount != null);
  return {
    id: data.node.id,
    status: data.node.status,
    cappedAmountUsd: parseMoney(usage?.plan?.pricingDetails?.cappedAmount?.amount),
    balanceUsedUsd: parseMoney(usage?.plan?.pricingDetails?.balanceUsed?.amount),
  };
}
