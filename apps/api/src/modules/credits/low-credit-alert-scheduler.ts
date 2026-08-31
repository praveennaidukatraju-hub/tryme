import { schema } from '@tryme/db';
import { and, eq, gte, isNotNull, isNull, lt } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { sendUserLowCreditsEmail } from '../../lib/mailer.js';

/** Below this balance, a user gets the "credits are running low" email. */
export const LOW_CREDIT_THRESHOLD = 20;

interface TickDeps {
  sendEmail?: (app: FastifyInstance, to: string) => Promise<void>;
}

async function defaultSendEmail(app: FastifyInstance, to: string): Promise<void> {
  await sendUserLowCreditsEmail(app.env.RESEND_API_KEY, app.env.EMAIL_FROM, to);
}

/**
 * Crossing-based, not level-based (unlike the Shopify store alert this
 * mirrors): there is only one threshold here, so "already alerted and still
 * below it" needs no email, and "recovered back above it" just re-arms for a
 * future dip. `low_credit_alert_sent_at` is the single flag that captures
 * both: set on send, cleared on recovery.
 */
export async function runUserLowCreditAlertTick(
  app: FastifyInstance,
  deps: TickDeps = {},
): Promise<void> {
  const sendEmail = deps.sendEmail ?? defaultSendEmail;

  const toAlert = await app.db
    .select({
      userId: schema.userCredits.userId,
      email: schema.users.email,
    })
    .from(schema.userCredits)
    .innerJoin(schema.users, eq(schema.users.id, schema.userCredits.userId))
    .where(
      and(
        lt(schema.userCredits.balance, LOW_CREDIT_THRESHOLD),
        isNull(schema.userCredits.lowCreditAlertSentAt),
        isNotNull(schema.users.email),
        eq(schema.users.isBanned, false),
      ),
    );

  for (const row of toAlert) {
    try {
      // email is guaranteed non-null by the isNotNull filter above.
      await sendEmail(app, row.email as string);
      await app.db
        .update(schema.userCredits)
        .set({ lowCreditAlertSentAt: new Date() })
        .where(eq(schema.userCredits.userId, row.userId));
      app.log.info({ userId: row.userId }, 'low-credit alert sent');
    } catch (err) {
      app.log.error({ err, userId: row.userId }, 'low-credit alert send failed');
    }
  }

  // Recovery: a top-up back above the threshold re-arms the alert for a future dip.
  await app.db
    .update(schema.userCredits)
    .set({ lowCreditAlertSentAt: null })
    .where(
      and(
        gte(schema.userCredits.balance, LOW_CREDIT_THRESHOLD),
        isNotNull(schema.userCredits.lowCreditAlertSentAt),
      ),
    );
}

const ONE_HOUR_MS = 60 * 60 * 1000;

/** Call once after `app.listen(...)`. Mirrors startAlertScheduler's shape (shopify/alert-scheduler.ts). */
export function startUserLowCreditAlertScheduler(
  app: FastifyInstance,
  intervalMs: number = ONE_HOUR_MS,
): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) {
      app.log.warn('user low-credit alert tick still running — skipping this interval');
      return;
    }
    running = true;
    void runUserLowCreditAlertTick(app)
      .catch((err) => {
        app.log.error({ err }, 'user low-credit alert tick failed');
      })
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  return () => clearInterval(timer);
}
