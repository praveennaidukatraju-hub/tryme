import { schema } from '@tryme/db';
import { eq } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sendUserLowCreditsEmail } from '../../src/lib/mailer.js';
import {
  LOW_CREDIT_THRESHOLD,
  runUserLowCreditAlertTick,
} from '../../src/modules/credits/low-credit-alert-scheduler.js';
import { buildTestApp } from '../helpers/api.js';
import { type Containers, startContainers } from '../helpers/containers.js';

// Only sendUserLowCreditsEmail is mocked (real module otherwise) — lets one
// test exercise defaultSendEmail's real argument mapping (low-credit-alert-
// scheduler.ts) rather than always going through the deps.sendEmail seam
// every other test in this file uses. Same convention as shopify-alerting.test.ts.
vi.mock('../../src/lib/mailer.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/mailer.js')>();
  return { ...actual, sendUserLowCreditsEmail: vi.fn().mockResolvedValue(undefined) };
});

let ctx: Containers;
let app: Awaited<ReturnType<typeof buildTestApp>>;
let sent: string[];

const deps = () => ({
  sendEmail: async (_app: unknown, to: string) => {
    sent.push(to);
  },
});

async function seedUser(opts: {
  email: string | null;
  balance: number;
  isBanned?: boolean;
  lowCreditAlertSentAt?: Date | null;
}) {
  const [user] = await app.db
    .insert(schema.users)
    .values({
      email: opts.email,
      displayName: 'Low Credit Test User',
      tier: 'free',
      emailVerified: true,
      isBanned: opts.isBanned ?? false,
    })
    .returning();
  await app.db.insert(schema.userCredits).values({
    userId: user.id,
    balance: opts.balance,
    lowCreditAlertSentAt: opts.lowCreditAlertSentAt ?? null,
  });
  return user;
}

beforeAll(async () => {
  ctx = await startContainers();
  app = await buildTestApp(ctx);
});

beforeEach(() => {
  sent = [];
  vi.mocked(sendUserLowCreditsEmail).mockClear();
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await app.db.delete(schema.userCredits);
  await app.db.delete(schema.users);
});

afterAll(async () => {
  await app.close();
  await ctx.stop();
});

describe('user low-credit alert scheduler', () => {
  it('defaultSendEmail forwards the recipient to sendUserLowCreditsEmail correctly', async () => {
    const user = await seedUser({ email: 'below-threshold@example.com', balance: 10 });
    await runUserLowCreditAlertTick(app);

    expect(sendUserLowCreditsEmail).toHaveBeenCalledTimes(1);
    expect(sendUserLowCreditsEmail).toHaveBeenCalledWith(
      app.env.RESEND_API_KEY,
      app.env.EMAIL_FROM,
      'below-threshold@example.com',
    );

    const [row] = await app.db
      .select()
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, user.id));
    expect(row?.lowCreditAlertSentAt).not.toBeNull();
  });

  it('does not alert a user at or above the threshold', async () => {
    await seedUser({ email: 'plenty@example.com', balance: LOW_CREDIT_THRESHOLD });
    await runUserLowCreditAlertTick(app, deps());
    expect(sent).toEqual([]);
  });

  it('does not re-alert a user already alerted while still below the threshold', async () => {
    await seedUser({
      email: 'already-alerted@example.com',
      balance: 5,
      lowCreditAlertSentAt: new Date(),
    });
    await runUserLowCreditAlertTick(app, deps());
    expect(sent).toEqual([]);
  });

  it('re-arms the alert once balance recovers back to the threshold', async () => {
    const user = await seedUser({
      email: 'recovered@example.com',
      balance: LOW_CREDIT_THRESHOLD,
      lowCreditAlertSentAt: new Date(),
    });
    await runUserLowCreditAlertTick(app, deps());
    expect(sent).toEqual([]);

    const [row] = await app.db
      .select()
      .from(schema.userCredits)
      .where(eq(schema.userCredits.userId, user.id));
    expect(row?.lowCreditAlertSentAt).toBeNull();

    // Dipping below again after recovery must alert again — proves the flag
    // was genuinely cleared, not just left alone.
    await app.db
      .update(schema.userCredits)
      .set({ balance: 5 })
      .where(eq(schema.userCredits.userId, user.id));
    await runUserLowCreditAlertTick(app, deps());
    expect(sent).toEqual(['recovered@example.com']);
  });

  it('does not alert a banned user', async () => {
    await seedUser({ email: 'banned@example.com', balance: 5, isBanned: true });
    await runUserLowCreditAlertTick(app, deps());
    expect(sent).toEqual([]);
  });

  it('does not alert a user with no email on file', async () => {
    await seedUser({ email: null, balance: 5 });
    await runUserLowCreditAlertTick(app, deps());
    expect(sent).toEqual([]);
  });

  it('alerts multiple eligible users in one tick', async () => {
    await seedUser({ email: 'user-a@example.com', balance: 1 });
    await seedUser({ email: 'user-b@example.com', balance: LOW_CREDIT_THRESHOLD - 1 });
    await runUserLowCreditAlertTick(app, deps());
    expect(sent.sort()).toEqual(['user-a@example.com', 'user-b@example.com']);
  });
});
