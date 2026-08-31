import { createHmac } from 'node:crypto';
import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildTestApp, type TestApp } from '../helpers/api';
import { type Containers, startContainers } from '../helpers/containers';

const RAZORPAY_KEY_SECRET = 'test-razorpay-key-secret';

describe('payments -> tier promotion', () => {
  let c: Containers;
  let app: TestApp;
  let nextTestClient = 1;

  beforeAll(async () => {
    c = await startContainers();
    app = await buildTestApp(c, {
      RAZORPAY_KEY_SECRET,
      RAZORPAY_KEY_ID: 'test-razorpay-key-id',
    });
  }, 60000);

  afterAll(async () => {
    await app?.close();
    await c?.stop();
  });

  // /v1/auth/register no longer returns a token — it only sends a verification
  // email — and /v1/auth/login requires emailVerified=true. Bypass the email
  // step directly in the DB, then log in for a real accessToken.
  async function registerUser(email: string) {
    const remoteAddress = `127.0.0.${nextTestClient++}`;
    await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      remoteAddress,
      payload: { displayName: 'Payments Tier User', email, password: 'password123' },
    });
    const [user] = await app.db.select().from(schema.users).where(eq(schema.users.email, email));
    await app.db
      .update(schema.users)
      .set({ emailVerified: true })
      .where(eq(schema.users.id, user?.id));

    const loginRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      remoteAddress,
      payload: { email, password: 'password123' },
    });
    return { token: loginRes.json().accessToken as string, userId: user?.id };
  }

  async function seedPlan(slug: string) {
    const [plan] = await app.db
      .insert(schema.creditPlans)
      .values({
        slug,
        name: slug,
        credits: 1000,
        basePaise: 250000,
        queueStream: 'priority',
      })
      .returning();
    return plan;
  }

  async function seedPendingPayment(opts: {
    userId: string;
    planId: string;
    razorpayOrderId: string;
    credits: number;
  }) {
    const [payment] = await app.db
      .insert(schema.payments)
      .values({
        userId: opts.userId,
        planId: opts.planId,
        razorpayOrderId: opts.razorpayOrderId,
        basePaise: 250000,
        gstPaise: 45000,
        totalPaise: 295000,
        credits: opts.credits,
        status: 'created',
      })
      .returning();
    return payment;
  }

  function signature(orderId: string, paymentId: string) {
    return createHmac('sha256', RAZORPAY_KEY_SECRET)
      .update(`${orderId}|${paymentId}`)
      .digest('hex');
  }

  it('promotes tier, credits the user, and writes a ledger entry on successful verify', async () => {
    const { token, userId } = await registerUser('tier-promo@x.com');
    const plan = await seedPlan('promo-plan');
    const orderId = 'order_promo_1';
    await seedPendingPayment({
      userId,
      planId: plan?.slug,
      razorpayOrderId: orderId,
      credits: 1000,
    });

    const paymentId = 'pay_promo_1';
    const res = await app.inject({
      method: 'POST',
      url: '/v1/payments/verify',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        razorpayOrderId: orderId,
        razorpayPaymentId: paymentId,
        razorpaySignature: signature(orderId, paymentId),
      },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(res.json().creditsGranted).toBe(1000); // no campaign bonus — matches the base plan credits

    const [user] = await app.db.select().from(schema.users).where(eq(schema.users.id, userId));
    expect(user?.tier).toBe(plan?.slug);

    const [credits] = await app.db
      .select()
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, userId));
    expect(credits?.balance).toBe(1000);

    const ledger = await app.db
      .select()
      .from(schema.creditLedger)
      .where(eq(schema.creditLedger.userId, userId));
    expect(ledger.some((l) => l.delta === 1000 && l.reason === 'PAYMENT')).toBe(true);
  });

  it('rejects an invalid signature (400) and does not promote the tier', async () => {
    const { token, userId } = await registerUser('tier-badsig@x.com');
    const plan = await seedPlan('badsig-plan');
    const orderId = 'order_badsig_1';
    await seedPendingPayment({
      userId,
      planId: plan?.slug,
      razorpayOrderId: orderId,
      credits: 500,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/payments/verify',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        razorpayOrderId: orderId,
        razorpayPaymentId: 'pay_badsig_1',
        razorpaySignature: 'not-a-valid-signature-not-a-valid-signature',
      },
    });

    expect(res.statusCode).toBe(400);
    const [user] = await app.db.select().from(schema.users).where(eq(schema.users.id, userId));
    expect(user?.tier).toBe('free');
  });

  it('is idempotent — calling verify twice only credits once', async () => {
    const { token, userId } = await registerUser('tier-idempotent@x.com');
    const plan = await seedPlan('idempotent-plan');
    const orderId = 'order_idempotent_1';
    await seedPendingPayment({
      userId,
      planId: plan?.slug,
      razorpayOrderId: orderId,
      credits: 750,
    });

    const paymentId = 'pay_idempotent_1';
    const payload = {
      razorpayOrderId: orderId,
      razorpayPaymentId: paymentId,
      razorpaySignature: signature(orderId, paymentId),
    };

    const first = await app.inject({
      method: 'POST',
      url: '/v1/payments/verify',
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
    expect(first.statusCode).toBe(200);
    expect(first.json().alreadyCredited).toBeFalsy();

    const second = await app.inject({
      method: 'POST',
      url: '/v1/payments/verify',
      headers: { authorization: `Bearer ${token}` },
      payload,
    });
    expect(second.statusCode).toBe(200);
    expect(second.json().alreadyCredited).toBe(true);

    const [credits] = await app.db
      .select()
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, userId));
    expect(credits?.balance).toBe(750);
  });

  async function seedCampaign(overrides: Partial<{ code: string; bonusPercent: number }> = {}) {
    const now = new Date();
    const [campaign] = await app.db
      .insert(schema.signupCampaigns)
      .values({
        code: overrides.code ?? 'gartex2026',
        name: 'Gartex Expo Delhi 2026',
        bonusPercent: overrides.bonusPercent ?? 25,
        startAt: new Date(now.getTime() - 86_400_000),
        endAt: new Date(now.getTime() + 86_400_000),
        isActive: true,
      })
      .returning();
    return campaign;
  }

  it("grants a 25% CAMPAIGN_BONUS on top of PAYMENT for a campaign-attributed user's first purchase", async () => {
    const campaign = await seedCampaign({ code: 'purchase-bonus-1' });
    const { token, userId } = await registerUser('campaign-purchase@x.com');
    await app.db
      .update(schema.users)
      .set({ signupCampaignId: campaign?.id })
      .where(eq(schema.users.id, userId));

    const plan = await seedPlan('campaign-bonus-plan');
    const orderId = 'order_campaign_bonus_1';
    await seedPendingPayment({
      userId,
      planId: plan?.slug,
      razorpayOrderId: orderId,
      credits: 1000,
    });

    const paymentId = 'pay_campaign_bonus_1';
    const res = await app.inject({
      method: 'POST',
      url: '/v1/payments/verify',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        razorpayOrderId: orderId,
        razorpayPaymentId: paymentId,
        razorpaySignature: signature(orderId, paymentId),
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().creditsGranted).toBe(1250); // reported total must include the bonus

    const [credits] = await app.db
      .select()
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, userId));
    expect(credits?.balance).toBe(1250); // 1000 PAYMENT + 250 CAMPAIGN_BONUS (25%)

    const ledger = await app.db
      .select()
      .from(schema.creditLedger)
      .where(eq(schema.creditLedger.userId, userId));
    expect(ledger.some((l) => l.delta === 1000 && l.reason === 'PAYMENT')).toBe(true);
    expect(ledger.some((l) => l.delta === 250 && l.reason === 'CAMPAIGN_BONUS')).toBe(true);
  });

  it("does not grant a second CAMPAIGN_BONUS on a campaign-attributed user's second purchase", async () => {
    const campaign = await seedCampaign({ code: 'purchase-bonus-2' });
    const { token, userId } = await registerUser('campaign-second-purchase@x.com');
    await app.db
      .update(schema.users)
      .set({ signupCampaignId: campaign?.id })
      .where(eq(schema.users.id, userId));

    const plan = await seedPlan('campaign-bonus-plan-2');

    const firstOrderId = 'order_second_purchase_first';
    await seedPendingPayment({
      userId,
      planId: plan?.slug,
      razorpayOrderId: firstOrderId,
      credits: 500,
    });
    await app.inject({
      method: 'POST',
      url: '/v1/payments/verify',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        razorpayOrderId: firstOrderId,
        razorpayPaymentId: 'pay_second_purchase_first',
        razorpaySignature: signature(firstOrderId, 'pay_second_purchase_first'),
      },
    });

    const secondOrderId = 'order_second_purchase_second';
    await seedPendingPayment({
      userId,
      planId: plan?.slug,
      razorpayOrderId: secondOrderId,
      credits: 500,
    });
    await app.inject({
      method: 'POST',
      url: '/v1/payments/verify',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        razorpayOrderId: secondOrderId,
        razorpayPaymentId: 'pay_second_purchase_second',
        razorpaySignature: signature(secondOrderId, 'pay_second_purchase_second'),
      },
    });

    const ledger = await app.db
      .select()
      .from(schema.creditLedger)
      .where(eq(schema.creditLedger.userId, userId));
    const bonusEntries = ledger.filter((l) => l.reason === 'CAMPAIGN_BONUS');
    expect(bonusEntries).toHaveLength(1);
    expect(bonusEntries[0]?.delta).toBe(125); // 25% of the FIRST purchase's 500 credits only

    const [credits] = await app.db
      .select()
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, userId));
    expect(credits?.balance).toBe(1125); // 500 + 500 + 125
  });

  it("grants no CAMPAIGN_BONUS for a non-attributed user's purchase", async () => {
    const { token, userId } = await registerUser('no-campaign-purchase@x.com');
    const plan = await seedPlan('no-campaign-plan');
    const orderId = 'order_no_campaign_1';
    await seedPendingPayment({
      userId,
      planId: plan?.slug,
      razorpayOrderId: orderId,
      credits: 800,
    });

    await app.inject({
      method: 'POST',
      url: '/v1/payments/verify',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        razorpayOrderId: orderId,
        razorpayPaymentId: 'pay_no_campaign_1',
        razorpaySignature: signature(orderId, 'pay_no_campaign_1'),
      },
    });

    const [credits] = await app.db
      .select()
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, userId));
    expect(credits?.balance).toBe(800);

    const ledger = await app.db
      .select()
      .from(schema.creditLedger)
      .where(eq(schema.creditLedger.userId, userId));
    expect(ledger.some((l) => l.reason === 'CAMPAIGN_BONUS')).toBe(false);
  });

  function mockRazorpayOrderCreate() {
    vi.spyOn(global, 'fetch').mockImplementation(async (url: string | URL | Request) => {
      const urlStr = typeof url === 'string' ? url : url.toString();
      if (urlStr === 'https://api.razorpay.com/v1/orders') {
        return new Response(JSON.stringify({ id: `order_mock_${Date.now()}` }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      throw new Error(`Unexpected fetch to: ${urlStr}`);
    });
  }

  it('stores the provided GSTIN on the payments row at order creation', async () => {
    mockRazorpayOrderCreate();
    const { token } = await registerUser('order-gstin@x.com');
    await seedPlan('gstin-plan');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/payments/orders',
      headers: { authorization: `Bearer ${token}` },
      payload: { planId: 'gstin-plan', gstin: '27AAPFU0939F1ZV' },
    });
    expect(res.statusCode).toBe(200);

    const [payment] = await app.db
      .select()
      .from(schema.payments)
      .where(eq(schema.payments.razorpayOrderId, res.json().orderId));
    expect(payment?.gstin).toBe('27AAPFU0939F1ZV');

    vi.restoreAllMocks();
  });

  it('rejects order creation with a malformed GSTIN', async () => {
    mockRazorpayOrderCreate();
    const { token } = await registerUser('order-badgstin@x.com');
    await seedPlan('badgstin-plan');

    const res = await app.inject({
      method: 'POST',
      url: '/v1/payments/orders',
      headers: { authorization: `Bearer ${token}` },
      payload: { planId: 'badgstin-plan', gstin: 'not-a-gstin' },
    });
    expect(res.statusCode).toBe(400);

    vi.restoreAllMocks();
  });

  it('issues an invoice as part of a successful /verify call', async () => {
    const { token, userId } = await registerUser('verify-invoice@x.com');
    const plan = await seedPlan('verify-invoice-plan');
    const orderId = 'order_verify_invoice_1';
    const payment = await seedPendingPayment({
      userId,
      planId: plan?.slug,
      razorpayOrderId: orderId,
      credits: 1000,
    });

    const paymentId = 'pay_verify_invoice_1';
    await app.inject({
      method: 'POST',
      url: '/v1/payments/verify',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        razorpayOrderId: orderId,
        razorpayPaymentId: paymentId,
        razorpaySignature: signature(orderId, paymentId),
      },
    });

    // issueInvoiceIfNeeded is fire-and-forget (non-fatal, not awaited by the
    // route) — poll briefly for the row to appear instead of asserting
    // immediately after the response.
    let invoiceRow: { invoiceNumber: string } | undefined;
    for (let i = 0; i < 20 && !invoiceRow; i++) {
      const [row] = await app.db
        .select()
        .from(schema.invoices)
        .where(eq(schema.invoices.paymentId, payment.id));
      invoiceRow = row;
      if (!invoiceRow) await new Promise((r) => setTimeout(r, 100));
    }
    expect(invoiceRow?.invoiceNumber).toMatch(/^INV-\d{4}-\d{2}-\d{6}$/);
  });
});
