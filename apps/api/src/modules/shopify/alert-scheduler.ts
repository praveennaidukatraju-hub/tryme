import { schema } from '@tryme/db';
import { eq, isNull } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { sendLowCreditsEmail } from '../../lib/mailer.js';
import { buildPostInstallRedirect } from './auth.routes.js';
import { refreshAutorefillState, runRefill } from './autorefill.js';
import { ALERT_LEVEL_RANK, type AlertLevel, computeRunway } from './runway.js';
import { shopifyGraphQL } from './service.js';
import { getValidAccessToken } from './token.js';

/** Every value `AlertLevel` can legitimately hold, for runtime validation. */
const KNOWN_ALERT_LEVELS: ReadonlySet<AlertLevel> = new Set(['ok', 'warning', 'critical', 'empty']);

/**
 * `last_alert_level` is a plain `text` column with no DB-level enum, so a
 * corrupt or pre-migration value is possible in principle. Trusting it
 * unchecked (`as AlertLevel`) would make `ALERT_LEVEL_RANK[previous]`
 * `undefined`, which makes `worsened` compare `number > undefined` — always
 * `false` — and permanently silences alerts for that store. Falling back to
 * 'ok' keeps the store eligible instead.
 */
function normalizeAlertLevel(value: string | null): AlertLevel {
  return value !== null && KNOWN_ALERT_LEVELS.has(value as AlertLevel)
    ? (value as AlertLevel)
    : 'ok';
}

/**
 * Deep link to the embedded app, for the email's "Add credits" button.
 *
 * SHOPIFY_API_KEY is optional in the env schema, and buildPostInstallRedirect
 * would happily produce `.../apps/` with an empty handle — a link that 404s the
 * merchant at the exact moment we are asking them to spend money. Fall back to
 * the shop's app list, which is one extra click but always works.
 */
export function appLinkFor(app: FastifyInstance, shopDomain: string): string {
  const apiKey = app.env.SHOPIFY_API_KEY;
  const storeHandle = shopDomain.replace(/\.myshopify\.com$/, '');
  return apiKey
    ? buildPostInstallRedirect(shopDomain, apiKey)
    : `https://admin.shopify.com/store/${storeHandle}/apps`;
}

interface SendEmailArgs {
  to: string;
  shopDomain: string;
  appUrl: string;
  level: 'warning' | 'critical' | 'empty';
  balance: number;
  tryOnsRemaining: number;
  daysRemaining: number | null;
}

async function defaultSendEmail(app: FastifyInstance, args: SendEmailArgs): Promise<void> {
  await sendLowCreditsEmail(app.env.RESEND_API_KEY, app.env.EMAIL_FROM, args.to, {
    shopDomain: args.shopDomain,
    appUrl: args.appUrl,
    level: args.level,
    balance: args.balance,
    tryOnsRemaining: args.tryOnsRemaining,
    daysRemaining: args.daysRemaining,
  });
}

interface TickDeps {
  sendEmail?: (app: FastifyInstance, args: SendEmailArgs) => Promise<void>;
}

const SHOP_EMAIL_QUERY = `
  query ShopEmailForAlerting {
    shop {
      email
    }
  }
`;

interface ShopEmailData {
  shop: { email: string };
}

/**
 * Backfills `shop_email` for stores provisioned before this column existed.
 *
 * `upsertShopifyStore` only writes `shop_email` on install/reinstall
 * (`auth.routes.ts`), so every store that was already installed when this
 * column was added has it `NULL` and would otherwise never become alertable —
 * an active merchant essentially never reinstalls. This reuses the same
 * token + GraphQL machinery the original install-time fetch used
 * (`getValidAccessToken`, `shopifyGraphQL`, the `shop { email }` field already
 * covered by existing scopes), and persists the result so it only runs once
 * per store, not on every tick thereafter.
 *
 * Left to the caller to catch: a dead/expired token surfaces as
 * SHOPIFY_REAUTH_REQUIRED here, same as everywhere else `getValidAccessToken`
 * is used, and that store simply stays without an email until it reauthorizes.
 */
async function backfillShopEmail(
  app: FastifyInstance,
  store: typeof schema.shopifyStores.$inferSelect,
): Promise<string> {
  const accessToken = await getValidAccessToken(app, store);
  const { shop } = await shopifyGraphQL<ShopEmailData>(
    store.shopDomain,
    accessToken,
    SHOP_EMAIL_QUERY,
  );
  await app.db
    .update(schema.shopifyStores)
    .set({ shopEmail: shop.email })
    .where(eq(schema.shopifyStores.id, store.id));
  return shop.email;
}

/**
 * Evaluates every installed store's runway and emails the ones that have got
 * worse since we last told them.
 *
 * Escalation, not state: the email fires only when the current level ranks
 * strictly worse than `last_alert_level`. `last_alert_level` is then rewritten
 * — including down to 'ok' on recovery — so a merchant who tops up is
 * automatically re-armed and will be warned again the next time they decline.
 * Storing "have we ever warned this store" instead would alert once per install
 * and then go quiet forever.
 *
 * Critically, `last_alert_level` is only advanced to a level the merchant
 * could actually have been told about. A store with no reachable email that
 * gets skipped must NOT be stamped as alerted — doing so would permanently
 * suppress that level (escalation-only means it never re-fires unless the
 * level gets strictly worse, or recovers to 'ok' and declines again), which is
 * exactly what happened to the entire pre-existing install base the first
 * tick after `shop_email` was introduced.
 *
 * One pass, continue past a single failure, never throw — mirrors the shape of
 * the billing sync tick this replaces.
 */
export async function runAlertTick(app: FastifyInstance, deps: TickDeps = {}): Promise<void> {
  const sendEmail = deps.sendEmail ?? defaultSendEmail;

  const stores = await app.db
    .select()
    .from(schema.shopifyStores)
    .where(isNull(schema.shopifyStores.uninstalledAt));

  for (const store of stores) {
    try {
      const runway = await computeRunway(app, store.id);

      // Safety net for a refill that was lost to a process restart between the
      // job committing and its fire-and-forget promise settling. runRefill is
      // idempotent on all three of its guards, so calling it here when one
      // already succeeded is a cheap no-op.
      //
      // `autorefillStatus` is tracked locally rather than read straight off
      // `store` below: `store` is this tick's pre-sweep snapshot, and a
      // 'cap_reached' outcome here means runRefill just flipped the row to
      // CAP_REACHED in the DB — `store.autorefillStatus` won't reflect that
      // without a re-fetch we don't otherwise need. Keeping this local avoids
      // the auto-refill-suppresses-the-email logic below being fooled by its
      // own stale read in the one tick where the store actually needs the
      // email most.
      // Reconcile with Shopify before deciding anything, because two of the
      // inputs below are things only Shopify knows: the merchant may have
      // changed the capped amount from the Shopify admin, and a CAP_REACHED
      // store whose ceiling was raised there (or whose 30-day cycle simply
      // rolled over) has headroom again and should resume refilling. Failure
      // here is not fatal to the tick — the store keeps whatever state it had,
      // which is the same position this loop was in before the refresh
      // existed.
      if (store.autorefillSubscriptionId) {
        try {
          const refreshed = await refreshAutorefillState(app, store);
          if (refreshed) store.autorefillStatus = refreshed.status;
        } catch (err) {
          app.log.warn(
            { err, storeId: store.id, shopDomain: store.shopDomain },
            'auto-refill state refresh failed — continuing with the stored state',
          );
        }
      }

      let autorefillStatus = store.autorefillStatus;
      // Hoisted out of the `if` below so the suppression check further down
      // can see this tick's own refill outcome — not just the resulting
      // status. A 'failed' outcome (expired card, declined payment method,
      // any transient Shopify error) leaves autorefillStatus at 'ACTIVE'
      // (only 'cap_reached' changes it), which would otherwise suppress the
      // alert on the exact tick where the merchant most needs to hear about
      // it — see C2.
      let outcome: Awaited<ReturnType<typeof runRefill>> | undefined;
      if (autorefillStatus === 'ACTIVE') {
        outcome = await runRefill(app, store);
        if (outcome === 'refilled') {
          // The balance just changed underneath us; alerting on the stale value
          // would email a merchant about a shortfall that no longer exists.
          await app.db
            .update(schema.shopifyStores)
            .set({ lastAlertLevel: 'ok' })
            .where(eq(schema.shopifyStores.id, store.id));
          continue;
        }
        if (outcome === 'cap_reached') {
          autorefillStatus = 'CAP_REACHED';
        }
      }

      const previous = normalizeAlertLevel(store.lastAlertLevel);
      const worsened = ALERT_LEVEL_RANK[runway.level] > ALERT_LEVEL_RANK[previous];
      // An ACTIVE auto-refill store is not "running low" in any sense the
      // merchant needs to act on — the refill fires before they run out. The
      // exception is CAP_REACHED, where auto-refill has stopped and they very
      // much do need to know — and this tick's own 'failed' outcome, which
      // means ACTIVE is not actually keeping this store topped up right now
      // (stuck-PENDING purchase row, expired card, or any other charge()
      // failure). Suppressing the alert in that case would go silent exactly
      // when the merchant needs the warning most.
      const autorefillHandlesIt = autorefillStatus === 'ACTIVE' && outcome !== 'failed';
      // Re-checked (not just `needsNotification`) at the send call below so
      // TypeScript can narrow `runway.level` away from 'ok' — SendEmailArgs
      // deliberately excludes 'ok' as a level, since 'ok' never sends.
      const needsNotification = worsened && runway.level !== 'ok' && !autorefillHandlesIt;

      let shopEmail = store.shopEmail;
      let notified = false;

      if (needsNotification) {
        if (!shopEmail) {
          try {
            shopEmail = await backfillShopEmail(app, store);
          } catch (err) {
            // Token dead, needs reauth, or Shopify unreachable — this store
            // stays without an email for this tick. Caught locally (rather
            // than relying solely on the outer catch) so a backfill failure
            // does not also swallow this store's recovery-to-'ok' handling.
            app.log.warn(
              { err, storeId: store.id, shopDomain: store.shopDomain },
              'shop email backfill failed — store needs reauth or is unreachable',
            );
          }
        }

        if (!shopEmail) {
          // Nothing we can do about it here — install-time capture and the
          // backfill above both came up empty. Logged rather than silent so a
          // store that can never be reached is visible to an operator.
          app.log.warn(
            { storeId: store.id, shopDomain: store.shopDomain, level: runway.level },
            'low-credit alert not sent — store has no shop email on record',
          );
        } else if (runway.level !== 'ok') {
          await sendEmail(app, {
            to: shopEmail,
            shopDomain: store.shopDomain,
            appUrl: appLinkFor(app, store.shopDomain),
            level: runway.level,
            balance: runway.balance,
            tryOnsRemaining: runway.tryOnsRemaining,
            daysRemaining: runway.daysRemaining,
          });
          notified = true;
          app.log.info(
            { storeId: store.id, level: runway.level, balance: runway.balance },
            'low-credit alert sent',
          );
        }
      }

      // Nothing was actually communicated — leave last_alert_level where it was
      // so this level is still eligible to fire once the store does get an
      // email (a future backfill success, or a reauth) OR once auto-refill
      // stops covering it (CAP_REACHED, or the merchant cancels). Written as
      // `worsened && runway.level !== 'ok' && !notified` rather than
      // `needsNotification && !notified`, deliberately: `needsNotification`
      // is already false in the autorefillHandlesIt-suppressed case, which
      // would let a suppressed tick fall through to the unconditional write
      // below and silently stamp last_alert_level forward — through
      // warning/critical/empty — across every tick a failing-but-still-ACTIVE
      // refill (e.g. an expired card, never reaching capReached) keeps
      // draining the balance. Once stamped at 'empty' (the worst tier),
      // `worsened` can never be true again, so a LATER genuine state change —
      // a webhook cancellation, or finally hitting CAP_REACHED — would never
      // re-fire, because nothing ranks worse than 'empty'. `notified` stays
      // `false` in that suppressed branch (the `if (needsNotification)` block
      // never runs), so this condition skips it exactly like the
      // no-email-available case, without needing a second, separate check.
      if (worsened && runway.level !== 'ok' && !notified) {
        continue;
      }

      await app.db
        .update(schema.shopifyStores)
        .set({
          lastAlertLevel: runway.level,
          // Only stamped when something was actually sent, so this stays a
          // record of "when we last contacted them" rather than "when the
          // scheduler last ran", which the logs already tell us.
          ...(notified ? { lastAlertAt: new Date() } : {}),
        })
        .where(eq(schema.shopifyStores.id, store.id));
    } catch (err) {
      app.log.error({ err, storeId: store.id }, 'low-credit alert evaluation failed');
    }
  }
}

const ONE_HOUR_MS = 60 * 60 * 1000;

/**
 * Hourly is deliberate. Unlike a spend cap, where staleness has a direct dollar
 * cost, a runway measured in days does not become materially wrong inside an
 * hour — and a tighter interval would only increase the chance of emailing a
 * merchant twice about the same decline.
 *
 * Call once after `app.listen(...)`.
 */
export function startAlertScheduler(
  app: FastifyInstance,
  intervalMs: number = ONE_HOUR_MS,
): () => void {
  let running = false;
  const timer = setInterval(() => {
    if (running) {
      app.log.warn('alert tick still running — skipping this interval');
      return;
    }
    running = true;
    void runAlertTick(app)
      .catch((err) => {
        app.log.error({ err }, 'alert tick failed');
      })
      .finally(() => {
        running = false;
      });
  }, intervalMs);
  return () => clearInterval(timer);
}
