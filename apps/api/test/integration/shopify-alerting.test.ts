import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { encryptToken } from '../../src/lib/crypto.js';
import { sendLowCreditsEmail } from '../../src/lib/mailer.js';
import { runAlertTick } from '../../src/modules/shopify/alert-scheduler.js';
import { buildTestApp } from '../helpers/api.js';
import { type Containers, startContainers } from '../helpers/containers.js';

// Only sendLowCreditsEmail is mocked (real module otherwise) — this is what
// lets one test below exercise `defaultSendEmail`'s real argument mapping
// (alert-scheduler.ts) rather than always going through the deps.sendEmail
// injection seam every other test in this file uses.
vi.mock('../../src/lib/mailer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/mailer.js')>();
  return { ...actual, sendLowCreditsEmail: vi.fn().mockResolvedValue(undefined) };
});

let ctx: Containers;
let app: Awaited<ReturnType<typeof buildTestApp>>;
let store: typeof schema.shopifyStores.$inferSelect;
let sent: Array<{ to: string; level: string }>;

// Fixed 32-byte key so a store's accessToken can be round-tripped through
// getValidAccessToken for the shop-email backfill tests below — same
// convention as shopify-purchase.test.ts.
const TOKEN_ENC_KEY = Buffer.alloc(32, 22).toString('base64');

const deps = () => ({
  sendEmail: async (_app: unknown, args: { to: string; level: string }) => {
    sent.push({ to: args.to, level: args.level });
  },
});

/** Puts the store at a chosen balance with a burn history that yields `days` of runway. */
async function seedStore(balance: number, creditsSpentInWindow: number, jobCount = 3) {
  await app.db.delete(schema.jobs).where(eq(schema.jobs.shopifyStoreId, store.id));
  await app.db
    .insert(schema.shopifyStoreCredits)
    .values({ storeId: store.id, balance })
    .onConflictDoUpdate({
      target: schema.shopifyStoreCredits.storeId,
      set: { balance },
    });
  if (jobCount > 0) {
    const per = Math.floor(creditsSpentInWindow / jobCount);
    await app.db.insert(schema.jobs).values(
      Array.from({ length: jobCount }, () => ({
        shopifyStoreId: store.id,
        status: 'COMPLETED' as const,
        creditsCharged: per,
      })),
    );
  }
  await app.db
    .update(schema.shopifyStores)
    .set({ lastAlertLevel: null, lastAlertAt: null })
    .where(eq(schema.shopifyStores.id, store.id));
}

beforeAll(async () => {
  ctx = await startContainers();
  app = await buildTestApp(ctx, { SHOPIFY_TOKEN_ENC_KEY: TOKEN_ENC_KEY });
  [store] = await app.db
    .insert(schema.shopifyStores)
    .values({
      shopDomain: 'alerting-test.myshopify.com',
      shopifyShopId: 55501,
      accessToken: 'enc:token',
      scope: 'read_products',
      shopEmail: 'owner@alerting-test.example',
    })
    .returning();
});

beforeEach(() => {
  sent = [];
  vi.mocked(sendLowCreditsEmail).mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await app.close();
  await ctx.stop();
});

describe('alert scheduler', () => {
  it("defaultSendEmail forwards runAlertTick's arguments to sendLowCreditsEmail correctly", async () => {
    // No deps.sendEmail stub here on purpose — every other test in this file
    // injects one, which means the real defaultSendEmail → sendLowCreditsEmail
    // mapping in alert-scheduler.ts has never actually run under test. Runs
    // first in this describe block so `store` is the only installed store and
    // this call produces exactly one send.
    await seedStore(300, 350);
    await runAlertTick(app);

    expect(sendLowCreditsEmail).toHaveBeenCalledTimes(1);
    const [apiKey, from, to, params] = vi.mocked(sendLowCreditsEmail).mock.calls[0];
    expect(apiKey).toBe(app.env.RESEND_API_KEY);
    expect(from).toBe(app.env.EMAIL_FROM);
    expect(to).toBe('owner@alerting-test.example');
    expect(params).toMatchObject({
      shopDomain: 'alerting-test.myshopify.com',
      level: 'warning',
      balance: 300,
    });
    expect(params.tryOnsRemaining).toBeGreaterThan(0);
    expect(params.appUrl).toContain('alerting-test');
  });

  it('emails once when a store first crosses into warning', async () => {
    // 350 credits, 350 spent over the 7-day window = 50/day = 7 days... just under.
    await seedStore(300, 350);
    await runAlertTick(app, deps());
    expect(sent).toHaveLength(1);
    expect(sent[0].level).toBe('warning');
    expect(sent[0].to).toBe('owner@alerting-test.example');
  });

  it('does not email again while the level is unchanged', async () => {
    await seedStore(300, 350);
    await runAlertTick(app, deps());
    expect(sent).toHaveLength(1);

    sent = [];
    await runAlertTick(app, deps());
    expect(sent).toHaveLength(0);
  });

  it('emails again when the level escalates', async () => {
    await seedStore(300, 350);
    await runAlertTick(app, deps());
    expect(sent[0].level).toBe('warning');

    sent = [];
    // Same burn, far less balance — now under two days.
    await app.db
      .update(schema.shopifyStoreCredits)
      .set({ balance: 50 })
      .where(eq(schema.shopifyStoreCredits.storeId, store.id));
    await runAlertTick(app, deps());
    expect(sent).toHaveLength(1);
    expect(sent[0].level).toBe('critical');
  });

  it('re-arms after a merchant recovers, so a later decline alerts again', async () => {
    await seedStore(300, 350);
    await runAlertTick(app, deps());

    sent = [];
    // Merchant buys a pack.
    await app.db
      .update(schema.shopifyStoreCredits)
      .set({ balance: 5000 })
      .where(eq(schema.shopifyStoreCredits.storeId, store.id));
    await runAlertTick(app, deps());
    expect(sent).toHaveLength(0);

    const [recovered] = await app.db
      .select()
      .from(schema.shopifyStores)
      .where(eq(schema.shopifyStores.id, store.id));
    expect(recovered.lastAlertLevel).toBe('ok');

    // ...then burns back down.
    await app.db
      .update(schema.shopifyStoreCredits)
      .set({ balance: 300 })
      .where(eq(schema.shopifyStoreCredits.storeId, store.id));
    await runAlertTick(app, deps());
    expect(sent).toHaveLength(1);
  });

  it('never emails a store that has never run a job', async () => {
    await seedStore(25, 0, 0);
    await runAlertTick(app, deps());
    expect(sent).toHaveLength(0);
  });

  it('skips a store with no shop email whose backfill fails, without blocking the others', async () => {
    // accessToken is 'enc:token' — not real ciphertext, so the backfill
    // attempt (getValidAccessToken → decrypt) throws and this store is
    // skipped, exercising the "backfill fails → skip gracefully" path.
    const [noEmail] = await app.db
      .insert(schema.shopifyStores)
      .values({
        shopDomain: 'no-email-test.myshopify.com',
        shopifyShopId: 55502,
        accessToken: 'enc:token',
        scope: 'read_products',
        shopEmail: null,
      })
      .returning();
    await app.db.insert(schema.shopifyStoreCredits).values({ storeId: noEmail.id, balance: 10 });
    await app.db
      .insert(schema.jobs)
      .values({ shopifyStoreId: noEmail.id, status: 'COMPLETED', creditsCharged: 100 });

    await seedStore(300, 350);
    await runAlertTick(app, deps());

    // The email-less store produced no send, but the healthy one still did.
    expect(sent.every((s) => s.to === 'owner@alerting-test.example')).toBe(true);
    expect(sent.length).toBeGreaterThan(0);

    // Bug B regression check: a store that could not actually be told must
    // not be stamped as if it had been — otherwise this alert level is
    // permanently suppressed for it (escalation-only re-fires only on a
    // strictly worse level, or after a recovery-to-'ok').
    const [persisted] = await app.db
      .select()
      .from(schema.shopifyStores)
      .where(eq(schema.shopifyStores.id, noEmail.id));
    expect(persisted.lastAlertLevel).toBeNull();
    expect(persisted.shopEmail).toBeNull();

    await app.db.delete(schema.shopifyStores).where(eq(schema.shopifyStores.id, noEmail.id));
  });

  it('backfills a missing shop email from Shopify, persists it once, and sends the alert', async () => {
    const [backfilled] = await app.db
      .insert(schema.shopifyStores)
      .values({
        shopDomain: 'backfill-test.myshopify.com',
        shopifyShopId: 55503,
        accessToken: encryptToken('real-offline-token', TOKEN_ENC_KEY),
        scope: 'read_products',
        shopEmail: null,
      })
      .returning();
    await app.db
      .insert(schema.shopifyStoreCredits)
      .values({ storeId: backfilled.id, balance: 300 });
    // Same shape as seedStore(300, 350): ~50/day burn, balance 300 -> warning.
    await app.db.insert(schema.jobs).values(
      Array.from({ length: 3 }, () => ({
        shopifyStoreId: backfilled.id,
        status: 'COMPLETED' as const,
        creditsCharged: 117,
      })),
    );

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ data: { shop: { email: 'owner@backfill-test.example' } } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await runAlertTick(app, deps());

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sent.some((s) => s.to === 'owner@backfill-test.example')).toBe(true);

    const [persisted] = await app.db
      .select()
      .from(schema.shopifyStores)
      .where(eq(schema.shopifyStores.id, backfilled.id));
    expect(persisted.shopEmail).toBe('owner@backfill-test.example');
    expect(persisted.lastAlertLevel).toBe('warning');
    expect(persisted.lastAlertAt).not.toBeNull();

    // Second tick, level unchanged: no re-fetch (email already persisted, and
    // the level hasn't worsened so it wouldn't attempt one anyway) — confirms
    // this is a one-time backfill, not a retry every tick.
    fetchMock.mockClear();
    const sentBefore = sent.length;
    await runAlertTick(app, deps());
    expect(fetchMock).not.toHaveBeenCalled();
    expect(sent.length).toBe(sentBefore);

    await app.db.delete(schema.shopifyStores).where(eq(schema.shopifyStores.id, backfilled.id));
  });

  it('ignores uninstalled stores', async () => {
    await seedStore(300, 350);
    await app.db
      .update(schema.shopifyStores)
      .set({ uninstalledAt: new Date() })
      .where(eq(schema.shopifyStores.id, store.id));

    await runAlertTick(app, deps());
    expect(sent).toHaveLength(0);

    await app.db
      .update(schema.shopifyStores)
      .set({ uninstalledAt: null })
      .where(eq(schema.shopifyStores.id, store.id));
  });
});
