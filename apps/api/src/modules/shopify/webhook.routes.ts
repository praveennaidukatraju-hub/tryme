import { schema } from '@tryme/db';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import { AppError } from '../../lib/errors.js';
import { sendAutorefillCapApproachingEmail } from '../../lib/mailer.js';
import { appLinkFor } from './alert-scheduler.js';
import { refreshAutorefillState } from './autorefill.js';
import { collectShopperData, type RedactResult, redactShopperData } from './gdpr.js';
import { defaultFetchPurchase, grantForPurchase, type OneTimePurchaseState } from './purchase.js';
import { enqueueSync, shopifyAdminFetch, verifyWebhookHmac } from './service.js';

// NOTE: `shopifyRegisterWebhooks` on FastifyInstance is declared once in
// `auth.routes.ts` (`declare module 'fastify' { interface FastifyInstance { ... } }`).
// Do not re-declare it here — TypeScript module augmentation is global, so a
// second declaration site is unnecessary and risks drifting out of sync with
// the original (e.g. differing parameter names/optionality).

/**
 * Marks "the outbound Shopify re-fetch for app_purchases_one_time_update
 * broke" as distinct from every other failure this route's outer try/catch
 * swallows into a 200. Only the case below throws this — every other topic,
 * and every other failure inside this same case (a missing store or purchase
 * row is a legitimate no-op, not this), keeps swallowing exactly as before.
 *
 * It has to be distinct from a bare AppError: getValidAccessToken/
 * shopifyGraphQL already throw AppError for token and GraphQL failures, and a
 * raw fetch() network error throws a plain Error, so re-throwing "any
 * AppError" or "any Error" from the switch would either miss the network case
 * or risk sweeping in an unrelated AppError some other topic starts throwing
 * later. Catching narrowly around the one risky call and wrapping it in this
 * type is what keeps the fix scoped to this one case.
 */
class WebhookOutboundFetchFailure extends Error {}

/**
 * A GDPR redaction that only half-completed must not look like a success.
 *
 * Retention has an hourly sweeper that naturally retries whatever it left
 * behind; redaction has no such loop — nothing revisits a subject whose object
 * deletes failed. So a non-zero `incomplete` is logged at `error`, with the
 * store id and topic, to be alertable and greppable against the 30-day
 * statutory deadline. Building an actual retry/reconciliation mechanism is out
 * of scope here; an operator has to see it and act.
 */
function logRedactResult(
  req: FastifyRequest,
  topic: string,
  shopDomain: string | undefined,
  storeId: string,
  result: RedactResult,
  message: string,
): void {
  if (result.incomplete > 0) {
    req.log.error(
      { topic, shopDomain, storeId, removed: result.removed, incomplete: result.incomplete },
      `gdpr: ${message} INCOMPLETE — objects left undeleted, manual follow-up required`,
    );
    return;
  }
  req.log.info({ topic, shopDomain, storeId, removed: result.removed }, `gdpr: ${message}`);
}

export async function shopifyWebhookRoutes(app: FastifyInstance) {
  // Capture raw body for HMAC (scoped to this encapsulated plugin instance only,
  // since this is a plain async function registered via app.register() — Fastify
  // gives it its own encapsulation context, so this parser does not leak to
  // sibling/parent routes that still use the default JSON parser).
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body); // hand the raw Buffer to handlers as req.body
  });

  const topics = [
    'app_uninstalled',
    'products_update',
    'products_delete',
    'customers_data_request',
    'customers_redact',
    'shop_redact',
    'app_purchases_one_time_update',
    'app_subscriptions_update',
    'app_subscriptions_approaching_capped_amount',
  ] as const;

  for (const topic of topics) {
    app.post(`/v1/shopify/webhooks/${topic}`, async (req, reply) => {
      const raw = req.body as Buffer;
      const hmac = req.headers['x-shopify-hmac-sha256'] as string | undefined;
      if (!verifyWebhookHmac(raw, hmac ?? '', app.env.SHOPIFY_API_SECRET ?? '')) {
        throw new AppError('UNAUTHORIZED', 401, 'bad webhook hmac');
      }
      const shopDomain = req.headers['x-shopify-shop-domain'] as string | undefined;
      const payload = JSON.parse(raw.toString() || '{}') as {
        id?: number;
        customer?: { id?: number; email?: string };
        // Shopify nests the whole resource one level down under this key —
        // see the app_purchases_one_time_update branch below for why only
        // admin_graphql_api_id (never status/test) is read from it.
        app_purchase_one_time?: { admin_graphql_api_id?: string };
      };

      // Post-processing here is fast local work (a 1-2 row Postgres UPDATE or a
      // Redis XADD), never a slow outbound call — so we await it before
      // responding instead of deferring it to a fire-and-forget continuation.
      // That avoids both a race (tests/observers reading DB state right after
      // the 200) and a reliability gap (crash between send() and the
      // continuation finishing would silently drop the post-processing, and
      // Shopify won't retry since it already got a 200).
      try {
        const [store] = shopDomain
          ? await app.db
              .select()
              .from(schema.shopifyStores)
              .where(eq(schema.shopifyStores.shopDomain, shopDomain))
              .limit(1)
          : [undefined];

        switch (topic) {
          case 'app_uninstalled':
            if (store) {
              // The auto-refill columns are cleared alongside uninstalledAt,
              // not left standing. Shopify cancels the app subscription itself
              // when the app is uninstalled, and our app_subscriptions/update
              // subscription dies with the install — so that correction never
              // arrives and nothing else would ever reset these. Leaving them
              // set makes a reinstalled store show auto-refill as ACTIVE
              // against a subscription that no longer exists, and makes
              // runRefill charge a dead line item on every trigger. Shopify's
              // own requirement is that an app re-requests approval for
              // charges after a reinstall, which is exactly what clearing
              // these forces.
              await app.db
                .update(schema.shopifyStores)
                .set({
                  uninstalledAt: new Date(),
                  autorefillPackId: null,
                  autorefillTriggerCredits: null,
                  autorefillSubscriptionId: null,
                  autorefillLineItemId: null,
                  autorefillCappedAmountCents: null,
                  autorefillBalanceUsedCents: null,
                  autorefillCapWarnedAt: null,
                  autorefillStatus: null,
                })
                .where(eq(schema.shopifyStores.id, store.id));
            }
            break;
          case 'products_update':
            if (store)
              await enqueueSync(app.redis, {
                storeId: store.id,
                mode: 'product',
                shopifyProductId: payload.id,
              });
            break;
          case 'products_delete':
            if (store && payload.id != null) {
              await app.db
                .update(schema.shopifyProductGarments)
                .set({ status: 'deleted' })
                .where(
                  and(
                    eq(schema.shopifyProductGarments.storeId, store.id),
                    eq(schema.shopifyProductGarments.shopifyProductId, payload.id),
                  ),
                );
            }
            break;
          case 'customers_redact': {
            if (store) {
              const result = await redactShopperData(app, store.id, {
                shopifyCustomerId: payload.customer?.id ?? null,
                email: payload.customer?.email ?? null,
              });
              logRedactResult(req, topic, shopDomain, store.id, result, 'shopper data redacted');
            }
            break;
          }
          case 'shop_redact': {
            if (store) {
              const result = await redactShopperData(app, store.id, { matchAll: true });
              // Shoppers and job objects are only half of what this webhook is
              // supposed to purge — shop_email is the shop owner's own PII,
              // introduced this phase, and was left untouched here. Clear it
              // along with the alert state that was derived from it, so a
              // redacted store carries no residual contact info.
              await app.db
                .update(schema.shopifyStores)
                .set({ shopEmail: null, lastAlertLevel: null, lastAlertAt: null })
                .where(eq(schema.shopifyStores.id, store.id));
              logRedactResult(req, topic, shopDomain, store.id, result, 'store data purged');
            }
            break;
          }
          case 'customers_data_request': {
            if (store) {
              const found = await collectShopperData(app, store.id, {
                shopifyCustomerId: payload.customer?.id ?? null,
                email: payload.customer?.email ?? null,
              });
              // Shopify allows 30 days to respond and expects the merchant to
              // relay the data; log enough to fulfil it without dumping PII
              // into the log itself.
              req.log.info(
                { topic, shopDomain, shopperIds: found.shopperIds },
                'gdpr: data request received',
              );
            }
            break;
          }
          case 'app_purchases_one_time_update': {
            // The payload's charge id is the only field we trust — everything
            // else (status, test) is re-fetched live from Shopify via the same
            // node(id:) query confirmPurchase uses, never parsed off the
            // webhook body. The grant is idempotent on the charge id, so a
            // replayed or spoofed duplicate cannot double-grant. HMAC has
            // already been verified above, but defence in depth is cheap here.
            const chargeGid = payload.app_purchase_one_time?.admin_graphql_api_id;
            if (!store || !chargeGid) break;

            const [purchaseRow] = await app.db
              .select()
              .from(schema.shopifyCreditPurchases)
              .where(eq(schema.shopifyCreditPurchases.shopifyChargeId, chargeGid))
              .limit(1);
            // No row for this charge id is a genuine no-op (stray/unrelated
            // delivery, or one that raced ahead of createPurchase's own
            // UPDATE) — nothing a retry could fix, so this stays a break, not
            // an error.
            if (!purchaseRow || purchaseRow.storeId !== store.id) break;

            // Unlike the lookups above, a failure here is NOT "nothing to
            // do": Shopify itself just told us this exact charge changed, so
            // we already know the row exists on both sides — we simply
            // couldn't confirm its new state. That can be a transient
            // 429/5xx, a network blip, or a SHOPIFY_REAUTH_REQUIRED throw
            // from token refresh. node(id:) coming back null for a charge
            // Shopify just told us about is the same kind of anomaly (wrong
            // store token, propagation delay), not a legitimate miss —
            // confirmPurchase (purchase.ts) already treats that identically,
            // throwing SHOPIFY 502 rather than treating it as a no-op.
            let observed: OneTimePurchaseState | null;
            try {
              observed = await defaultFetchPurchase(app, store, chargeGid);
            } catch (err) {
              throw new WebhookOutboundFetchFailure(
                `defaultFetchPurchase threw for charge ${chargeGid}: ${
                  err instanceof Error ? err.message : String(err)
                }`,
                { cause: err },
              );
            }
            if (!observed) {
              throw new WebhookOutboundFetchFailure(
                `defaultFetchPurchase returned no purchase for charge ${chargeGid}`,
              );
            }

            const granted = await grantForPurchase(app, store, purchaseRow, observed);
            await app.db
              .update(schema.shopifyCreditPurchases)
              .set({ status: observed.status, updatedAt: new Date() })
              .where(eq(schema.shopifyCreditPurchases.id, purchaseRow.id));
            req.log.info(
              { topic, storeId: store.id, purchaseId: purchaseRow.id, granted },
              'one-time purchase webhook processed',
            );
            break;
          }
          case 'app_subscriptions_update': {
            // The merchant can cancel or decline the auto-refill subscription
            // from Shopify's own billing screen, where our app never sees the
            // click. Without this the store would keep believing it has a live
            // charge authorization and every refill would fail confusingly.
            const subId = (payload as { admin_graphql_api_id?: string }).admin_graphql_api_id;
            const rawStatus = (payload as { status?: string }).status;
            if (!store || !subId || !rawStatus) break;
            if (store.autorefillSubscriptionId !== subId) break;

            const status = rawStatus.toUpperCase();
            const mapped =
              status === 'ACTIVE' ? 'ACTIVE' : status === 'DECLINED' ? 'DECLINED' : 'CANCELLED';
            await app.db
              .update(schema.shopifyStores)
              .set({ autorefillStatus: mapped, updatedAt: new Date() })
              .where(eq(schema.shopifyStores.id, store.id));
            req.log.info(
              { topic, storeId: store.id, status: mapped },
              'auto-refill subscription status updated',
            );
            break;
          }
          case 'app_subscriptions_approaching_capped_amount': {
            // Shopify fires this at 90% of the ceiling. Without it the merchant
            // first learns about the limit when auto-refill has already stopped
            // and their balance is draining — this is the only chance to tell
            // them while raising it still prevents that.
            const subId = (payload as { admin_graphql_api_id?: string }).admin_graphql_api_id;
            if (!store || !subId) break;
            if (store.autorefillSubscriptionId !== subId) break;
            // Shopify may re-deliver this across a cycle; one email per
            // ceiling is enough. The stamp is cleared whenever the cap is
            // raised or the store recovers from CAP_REACHED, so the next
            // approach warns again.
            if (store.autorefillCapWarnedAt) break;

            // The payload carries a capped amount, but it is not read: the
            // amounts Shopify holds are re-fetched live, exactly as the
            // one-time purchase branch above re-fetches rather than trusting
            // the delivery body. Unlike that branch this failing is not worth
            // a retry — we already hold a stored ceiling good enough to warn
            // against, and dropping the warning because Shopify was briefly
            // unreachable is strictly worse for the merchant than warning with
            // a slightly stale figure.
            let refreshed: Awaited<ReturnType<typeof refreshAutorefillState>> = null;
            try {
              refreshed = await refreshAutorefillState(app, store);
            } catch (err) {
              req.log.warn(
                { err, topic, storeId: store.id },
                'auto-refill state refresh failed while warning about the cap — using the stored ceiling',
              );
            }
            const cappedAmountUsd =
              refreshed?.cappedAmountUsd ??
              (store.autorefillCappedAmountCents != null
                ? store.autorefillCappedAmountCents / 100
                : null);
            if (cappedAmountUsd == null) break;

            if (store.shopEmail) {
              await sendAutorefillCapApproachingEmail(
                app.env.RESEND_API_KEY,
                app.env.EMAIL_FROM,
                store.shopEmail,
                {
                  shopDomain: store.shopDomain,
                  appUrl: appLinkFor(app, store.shopDomain),
                  cappedAmountUsd,
                  balanceUsedUsd: refreshed?.balanceUsedUsd ?? null,
                },
              );
            } else {
              req.log.warn(
                { topic, storeId: store.id },
                'auto-refill cap warning not emailed — store has no shop email on record',
              );
            }
            // Stamped either way. An unreachable store would otherwise re-enter
            // this branch on every redelivery and retry an email that cannot
            // succeed; the in-app figures (refreshed just above) still tell
            // them, and the warn line above is what an operator acts on.
            await app.db
              .update(schema.shopifyStores)
              .set({ autorefillCapWarnedAt: new Date() })
              .where(eq(schema.shopifyStores.id, store.id));
            req.log.info(
              { topic, storeId: store.id, cappedAmountUsd },
              'auto-refill approaching cap — merchant warned',
            );
            break;
          }
        }
      } catch (err) {
        if (err instanceof WebhookOutboundFetchFailure) {
          // The one case in this switch where swallowing into a 200 would be
          // wrong: Shopify never retries a 2xx delivery, and nothing else
          // reconciles a purchase whose webhook landed during a Shopify-side
          // outage. Re-throwing here (past this catch, to Fastify's
          // setErrorHandler) answers with a 5xx so Shopify's own webhook
          // retry re-delivers later. Safe to retry any number of times —
          // grantForPurchase is idempotent on external_ref, and can also race
          // the merchant's own confirm-route visit without double-granting.
          req.log.error(
            { err, topic },
            'webhook post-processing failed — outbound Shopify call broke, returning non-2xx so Shopify retries',
          );
          throw new AppError('SHOPIFY', 502, 'temporary failure verifying Shopify purchase state');
        }
        req.log.error({ err, topic }, 'webhook post-processing failed');
      }

      // Shopify shouldn't get a 4xx/5xx for a webhook it delivered correctly
      // just because our internal post-processing had a hiccup — the catch
      // above already logs the error and swallows it, so we always reach here
      // (except for WebhookOutboundFetchFailure above, which rethrows before
      // this point precisely so Shopify's retry mechanism kicks in).
      reply.code(200).send({ ok: true });
    });
  }
}

// Wrapped in fp() (matching every other decorator plugin in this codebase —
// see plugins/db.ts, plugins/redis.ts, plugins/auth.ts): without it, this would
// be registered as a plain function and get its own encapsulated child context,
// so `app.decorate('shopifyRegisterWebhooks', ...)` would only be visible inside
// that context — NOT to the sibling `shopifyAuthRoutes` context that actually
// calls `app.shopifyRegisterWebhooks?.()`. Because the call site uses optional
// chaining, that failure mode is silent (webhook registration just never fires).
export const registerWebhooksDecorator = fp(async (app: FastifyInstance) => {
  app.decorate('shopifyRegisterWebhooks', async (shop: string, token: string) => {
    const base = `${app.env.SHOPIFY_APP_URL}/v1/shopify/webhooks`;
    // GDPR/compliance topics (customers/data_request, customers/redact, shop/redact)
    // are NOT registered here — Shopify's webhooks.json API rejects them with a 404
    // ("Could not find the webhook topic"), confirmed live. Those three are
    // configured once, app-wide, in Partners → app → Configuration →
    // "Compliance webhooks" (or shopify.app.toml's webhooks.privacy_compliance
    // for CLI-managed apps) — they apply automatically to every install, no
    // per-shop registration call exists for them.
    const map: Record<string, string> = {
      'app/uninstalled': `${base}/app_uninstalled`,
      'products/update': `${base}/products_update`,
      'products/delete': `${base}/products_delete`,
      'app_purchases_one_time/update': `${base}/app_purchases_one_time_update`,
      'app_subscriptions/update': `${base}/app_subscriptions_update`,
      'app_subscriptions/approaching_capped_amount': `${base}/app_subscriptions_approaching_capped_amount`,
    };
    for (const [topic, address] of Object.entries(map)) {
      try {
        const res = await shopifyAdminFetch(shop, token, '/webhooks.json', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ webhook: { topic, address, format: 'json' } }),
        });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          app.log.error({ topic, status: res.status, body }, 'webhook registration failed');
        }
      } catch (err) {
        app.log.error({ err, topic }, 'webhook registration failed');
      }
    }
  });
});
