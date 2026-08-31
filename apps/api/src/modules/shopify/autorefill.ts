import { schema } from '@tryme/db';
import { SIMPLE_TRYON_COST } from '@tryme/types';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { AppError } from '../../lib/errors.js';
import { grantStore } from '../credits/shopify-ledger.js';
import {
  cancelSubscription,
  createUsageRecord,
  createUsageSubscription,
  fetchSubscriptionStatus,
  updateCappedAmount,
} from './autorefill-client.js';
import { getPack } from './packs.js';

type Store = typeof schema.shopifyStores.$inferSelect;

/** Fraction of the chosen pack at which a refill fires, when the merchant hasn't set their own. */
const DEFAULT_TRIGGER_FRACTION = 0.2;

/** 20% of the chosen pack's manual credits, or null for a pack we don't sell. */
export function defaultTriggerCredits(packId: string): number | null {
  const pack = getPack(packId);
  if (!pack) return null;
  return Math.round(pack.credits * DEFAULT_TRIGGER_FRACTION);
}

/**
 * Whether this store is due a refill right now.
 *
 * Pure so the eligibility rules are testable without a database. The ACTIVE
 * check is the load-bearing one: `autorefillStatus` is PENDING between creating
 * the subscription and the merchant approving it, and charging against an
 * unapproved authorization would be giving product away against a charge that
 * may never be accepted.
 */
export function shouldRefill(input: {
  balance: number;
  triggerCredits: number | null;
  status: string | null;
}): boolean {
  if (input.triggerCredits == null) return false;
  if (input.status !== 'ACTIVE') return false;
  return input.balance <= input.triggerCredits;
}

interface RefillDeps {
  charge?: typeof createUsageRecord;
}

/**
 * Charges and grants exactly one refill, or explains why it didn't.
 *
 * ## The three guards, and why each is needed
 *
 * A merchant being charged twice for one refill is the worst thing this feature
 * can do, and the three ways it could happen are genuinely different problems:
 *
 * 1. **A SESSION-scoped `pg_advisory_lock`** (`withAdvisoryLock`, see
 *    `packages/db/src/index.ts`), held for the *entire* function body — the
 *    insert, the Shopify `charge()` call, and the merged ACTIVE+grant
 *    transaction — not just the initial insert. Two earlier shapes of this
 *    guard were tried and both measurably failed under a real concurrent
 *    race (`Promise.all([runRefill(...), runRefill(...)])` against the same
 *    store, reproduced deterministically, hrtime-traced):
 *      - A transaction-scoped `pg_advisory_xact_lock`, held only for the
 *        insert. It releases at that transaction's own COMMIT — well before
 *        `charge()` runs — so a second caller can acquire the freed lock and
 *        run its own insert while the first caller is still mid-flight
 *        outside any lock.
 *      - The same, plus merging the ACTIVE-transition and the grant into one
 *        transaction (to remove the "ACTIVE but balance still stale" window).
 *        That closes one narrower gap but not the real one: the lock is
 *        *still* released after the insert alone. A second caller's own
 *        `SELECT` can legitimately read the pre-grant balance while the first
 *        caller's merge-transaction is open (correct, per Postgres READ
 *        COMMITTED), and then that second caller's later `INSERT` — a
 *        separate statement, its own fresh snapshot — lands *after* the first
 *        caller's merge-transaction has already committed and flipped the row
 *        off `PENDING`. Guard 2's partial index has nothing left to conflict
 *        with, the second insert succeeds, and both callers charge.
 *    A session lock doesn't release at any transaction boundary — only when
 *    `withAdvisoryLock`'s `finally` runs, after the whole callback (including
 *    `charge()`) resolves. Acquisition is non-blocking (`pg_try_advisory_lock`):
 *    a second caller for the same store doesn't wait for the first to finish —
 *    it fails to acquire immediately and `runRefill` maps that straight to
 *    `'skipped'`, the same outcome as every other "someone else is already
 *    handling this" case in this function. Either way, no second caller can
 *    make any progress — insert, charge, or grant — until the first one, in
 *    full, is done. It still uses separate,
 *    independently-committing transactions inside the callback (via the
 *    reserved connection's own `db`), so the initial `PENDING` row is durable
 *    *before* `charge()` is ever called — a mid-call crash still leaves a
 *    real audit-trail row for Guard 3 to key a retry off, exactly as before.
 * 2. **The partial unique index on one in-flight `autorefill` purchase per
 *    store** (migration 0159). A database-level backstop that still holds if a
 *    later refactor moves or drops the lock — the failure mode being guarded
 *    against is too expensive to depend on one mechanism a refactor can quietly
 *    remove.
 * 3. **Shopify's own `idempotencyKey`, keyed on our purchase row id.** The only
 *    guard that helps when we time out on a request Shopify actually accepted.
 *    No application-side locking can detect that case, because from our side a
 *    successful charge and a lost response look identical. Retrying the same
 *    row reuses the key and cannot double-charge.
 *
 * Guard 1 stops two attempts running at all. Guard 2 stops two rows existing
 * even if 1 is somehow bypassed. Guard 3 stops two *charges* for one row.
 * Removing any of them leaves a real hole.
 */
export async function runRefill(
  app: FastifyInstance,
  store: Store,
  deps: RefillDeps = {},
): Promise<'refilled' | 'skipped' | 'cap_reached' | 'failed'> {
  const charge = deps.charge ?? createUsageRecord;

  // Pre-lock gate only: decides whether it's worth attempting a refill at
  // all. Everything that actually decides ELIGIBILITY (status, trigger,
  // lineItemId, packId) is re-read fresh from inside the lock below — see the
  // I2 note there for why the pre-lock `store` snapshot can't be trusted for
  // that. `pack` here is ONLY used for this cheap pre-check; it must never be
  // the one used for money-relevant decisions past this point.
  const packId = store.autorefillPackId;
  if (!packId || !store.autorefillLineItemId) return 'skipped';

  const pack = getPack(packId);
  if (!pack) {
    app.log.error(
      { storeId: store.id, packId },
      'auto-refill configured with a pack we no longer sell — refill skipped',
    );
    return 'skipped';
  }

  const outcome = await app.withAdvisoryLock(`shopify-autorefill:${store.id}`, async (lockedDb) => {
    // Guard 1 is this lock itself, held for everything below. The old
    // per-transaction pg_advisory_xact_lock is gone — nothing else needs it,
    // since only one caller can be inside this callback for this store's key
    // at a time.
    const eligibility = await lockedDb.transaction(async (tx) => {
      // Re-read balance AND everything else `shouldRefill` depends on inside
      // the lock, in one round trip — not the `store` param captured before
      // the lock was acquired. Only `balance` used to be re-read here; the
      // rest came from the stale pre-lock snapshot. That's most dangerous for
      // the hourly safety-net sweep: it loads all stores up front, then loops
      // with per-store network work, so a store's snapshot could be minutes
      // stale by the time its runRefill call actually runs here — e.g. a
      // merchant who disabled auto-refill in that window could still get
      // charged off the stale ACTIVE status otherwise. `autorefillPackId` is
      // included in this re-read for the same reason: an admin could pull a
      // pack from sale, or the merchant could switch packs, in the window
      // between the pre-lock snapshot and here, and the pre-lock `pack`
      // resolved from `store.autorefillPackId` must not be the one that
      // decides the charge amount, the credits granted, or the purchase
      // row's recorded packId.
      const [row] = await tx
        .select({
          balance: schema.shopifyStoreCredits.balance,
          autorefillStatus: schema.shopifyStores.autorefillStatus,
          autorefillTriggerCredits: schema.shopifyStores.autorefillTriggerCredits,
          autorefillLineItemId: schema.shopifyStores.autorefillLineItemId,
          autorefillPackId: schema.shopifyStores.autorefillPackId,
        })
        .from(schema.shopifyStores)
        .leftJoin(
          schema.shopifyStoreCredits,
          eq(schema.shopifyStoreCredits.storeId, schema.shopifyStores.id),
        )
        .where(eq(schema.shopifyStores.id, store.id));

      const eligible = shouldRefill({
        balance: row?.balance ?? 0,
        triggerCredits: row?.autorefillTriggerCredits ?? null,
        status: row?.autorefillStatus ?? null,
      });
      // A lineItemId can only disappear between the pre-lock gate and here if
      // the merchant's subscription changed out from under us mid-flight —
      // treat that the same as "not eligible" since there's nothing to charge
      // against.
      if (!eligible || !row?.autorefillLineItemId) {
        return null;
      }

      // Re-resolve the pack from the freshly-read packId, not the pre-lock
      // `pack` closed over from the function argument. Same "no longer sold"
      // possibility as the pre-lock check above, just re-checked against the
      // value that's actually about to be charged.
      const freshPack = row.autorefillPackId ? getPack(row.autorefillPackId) : null;
      if (!freshPack) {
        app.log.error(
          { storeId: store.id, packId: row.autorefillPackId },
          'auto-refill pack no longer sold as of the locked re-read — refill skipped',
        );
        return null;
      }

      // Guard 2: the partial unique index rejects a second in-flight
      // autorefill row for this store — a backstop, per the reasoning above,
      // not the thing actually doing the work now.
      const inserted = await tx
        .insert(schema.shopifyCreditPurchases)
        .values({
          storeId: store.id,
          source: 'autorefill',
          packId: freshPack.id,
          // Snapshotted at INSERT exactly like a manual purchase — the grant
          // reads this column, never CREDIT_PACKS, so an admin editing pack
          // generosity mid-flight cannot change what this refill delivers.
          credits: freshPack.autorefillCredits,
          priceUsdCents: Math.round(freshPack.priceUsd * 100),
          status: 'PENDING',
        })
        .onConflictDoNothing()
        .returning({ id: schema.shopifyCreditPurchases.id });

      const purchaseId = inserted[0]?.id;
      if (!purchaseId) return null;
      return { purchaseId, lineItemId: row.autorefillLineItemId, pack: freshPack };
    });

    if (!eligibility) return 'skipped';
    // Shadows the pre-lock `pack` on purpose — everything below must use the
    // freshly-resolved one from inside the lock, never the pre-lock snapshot.
    const { purchaseId, lineItemId, pack } = eligibility;

    const tryOns = Math.floor(pack.autorefillCredits / SIMPLE_TRYON_COST);

    // Guard 3: Shopify's idempotency key, keyed on the row. A retry after a
    // timeout reuses it and cannot produce a second charge.
    //
    // createUsageRecord can THROW (auth failure, non-2xx, GraphQL transport
    // error, throttle exhaustion) rather than resolve to `{ ok: false }`. A
    // throw here leaves the purchase row PENDING forever — Guard 2's partial
    // unique index then silently blocks every future refill attempt for this
    // store, since a second insert keeps conflicting with the stuck row. We
    // deliberately do NOT mark the row FAILED on this path: doing so would
    // let a future retry mint a NEW purchase row with a NEW idempotency key,
    // which reopens the exact double-charge risk Guard 3 exists to prevent,
    // in case Shopify actually processed this attempt despite the throw. So
    // this is scoped to just giving an operator visibility — log loudly and
    // re-throw — not to reconciling stale PENDING rows, which is real,
    // separate future work.
    let result: Awaited<ReturnType<typeof charge>>;
    try {
      result = await charge(app, store, {
        lineItemId,
        description: `TryMe auto-refill — ${tryOns} try-ons`,
        amountUsd: pack.priceUsd,
        idempotencyKey: `autorefill:${purchaseId}`,
      });
    } catch (err) {
      app.log.error(
        { err, storeId: store.id, purchaseId },
        'auto-refill charge() threw — purchase row stays PENDING and will block future refills for this store until reconciled manually',
      );
      throw err;
    }

    if (!result.ok) {
      if (result.capReached) {
        // The FAILED purchase-row update and the store's CAP_REACHED
        // transition are combined into one transaction here (unlike the
        // plain 'failed' branch below) because a crash between the two
        // separate statements could leave the store retrying into a ceiling
        // we already know it hit.
        await lockedDb.transaction(async (tx) => {
          await tx
            .update(schema.shopifyCreditPurchases)
            .set({ status: 'FAILED', updatedAt: new Date() })
            .where(eq(schema.shopifyCreditPurchases.id, purchaseId));
          await tx
            .update(schema.shopifyStores)
            .set({ autorefillStatus: 'CAP_REACHED', updatedAt: new Date() })
            .where(eq(schema.shopifyStores.id, store.id));
        });
        // warn, not error: the merchant set this ceiling and it is doing its job.
        app.log.warn(
          { storeId: store.id, shopDomain: store.shopDomain },
          'auto-refill stopped — monthly spend ceiling reached',
        );
        return 'cap_reached';
      }

      await lockedDb
        .update(schema.shopifyCreditPurchases)
        .set({ status: 'FAILED', updatedAt: new Date() })
        .where(eq(schema.shopifyCreditPurchases.id, purchaseId));

      app.log.error(
        { storeId: store.id, message: result.message },
        'auto-refill charge failed — will retry on the next trigger',
      );
      return 'failed';
    }

    // The ACTIVE transition and the grant stay merged into one transaction —
    // it's still correct for a single reader to never observe "ACTIVE, stale
    // balance" — but the thing actually preventing a second refill here is
    // the session lock held around this whole callback, not this merge.
    const { granted } = await lockedDb.transaction(async (tx) => {
      await tx
        .update(schema.shopifyCreditPurchases)
        .set({ shopifyChargeId: result.recordId, status: 'ACTIVE', updatedAt: new Date() })
        .where(eq(schema.shopifyCreditPurchases.id, purchaseId));

      return grantStore(
        tx as never,
        store.id,
        pack.autorefillCredits,
        // A refill on a development store is charged against a test
        // subscription, so no money backs it. Distinct reason for the same
        // purpose SHOPIFY_PACK_TEST serves on the manual path: test-funded
        // credits stay separable from paid ones in the ledger forever.
        store.partnerDevelopment ? 'SHOPIFY_AUTOREFILL_TEST' : 'SHOPIFY_AUTOREFILL',
        `shopify_autorefill:${result.recordId}`,
      );
    });

    app.log.info(
      { storeId: store.id, purchaseId, credits: pack.autorefillCredits, granted },
      'auto-refill completed',
    );
    return 'refilled';
  });

  // withAdvisoryLock resolves to `undefined` when a second concurrent caller
  // for this store couldn't acquire the (now non-blocking) session lock —
  // that's the same "someone else is already handling this" case every other
  // early-return in this function already treats as 'skipped'.
  return outcome ?? 'skipped';
}

/**
 * Starts enrolment. The merchant approves a monthly ceiling once on Shopify's
 * own page; every refill after that is silent.
 *
 * The cap may not be lower than one refill — a ceiling that cannot fund a
 * single pack would enrol the merchant into something that can never fire, and
 * they would discover it only by running out.
 */
export async function enrolAutorefill(
  app: FastifyInstance,
  store: Store,
  args: { packId: string; triggerCredits?: number; cappedAmountUsd: number },
): Promise<{ confirmationUrl: string }> {
  const pack = getPack(args.packId);
  if (!pack) throw new AppError('BAD_REQUEST', 400, 'unknown pack');

  if (args.cappedAmountUsd < pack.priceUsd) {
    throw new AppError(
      'BAD_REQUEST',
      400,
      `Monthly limit must be at least $${pack.priceUsd}, the price of one refill`,
    );
  }
  if (!app.env.SHOPIFY_APP_URL) {
    throw new AppError('CONFIG', 500, 'SHOPIFY_APP_URL is not configured');
  }

  // A double-submit or a re-enrol-to-switch-packs without disabling first
  // would otherwise overwrite autorefillSubscriptionId with no cancel call —
  // orphaning the prior subscription at Shopify, since disableAutorefill can
  // only ever reach whatever subscription id is currently on the row. Same
  // try/catch-and-continue-anyway pattern as disableAutorefill: blocking
  // re-enrolment entirely over a cancel failure is worse for the merchant
  // than a possibly-orphaned old subscription logged for an operator to
  // notice.
  //
  // CAP_REACHED is included alongside PENDING/ACTIVE deliberately: it is this
  // codebase's own status for "the subscription is still ACTIVE at Shopify's
  // end, refills just hit the merchant's ceiling." Skipping the cancel for it
  // would orphan a live standing charge authorization exactly as badly as
  // skipping it for ACTIVE would.
  if (
    store.autorefillSubscriptionId &&
    (store.autorefillStatus === 'PENDING' ||
      store.autorefillStatus === 'ACTIVE' ||
      store.autorefillStatus === 'CAP_REACHED')
  ) {
    try {
      await cancelSubscription(app, store, store.autorefillSubscriptionId);
    } catch (err) {
      app.log.error(
        { err, storeId: store.id, subscriptionId: store.autorefillSubscriptionId },
        'failed to cancel prior auto-refill subscription at Shopify before re-enrolling — proceeding anyway, prior subscription may be orphaned',
      );
    }
  }

  const trigger = args.triggerCredits ?? defaultTriggerCredits(pack.id);
  const tryOns = Math.floor(pack.autorefillCredits / SIMPLE_TRYON_COST);

  const { confirmationUrl, subscriptionId, lineItemId } = await createUsageSubscription(
    app,
    store,
    {
      name: 'TryMe auto-refill',
      terms: `$${pack.priceUsd} per ${tryOns} try-ons, charged automatically when your balance runs low`,
      cappedAmountUsd: args.cappedAmountUsd,
      // Points at our own API, not the SPA directly — same reasoning as
      // purchase.ts's createCharge call (see its comment): Shopify's
      // post-approval redirect is a top-level navigation outside the embedded
      // iframe, so the SPA would land with no App Bridge and no way to call
      // confirmAutorefill. Also covers raiseCap: Shopify reuses this same
      // returnUrl for any later appSubscriptionLineItemUpdate confirmation on
      // this subscription, so this fix applies there too without separate
      // wiring.
      returnUrl: `${app.env.SHOPIFY_APP_URL}/v1/shopify/billing/autorefill/return?shop=${encodeURIComponent(store.shopDomain)}`,
      // Per-store for the same reason as purchase.ts's createCharge call — see
      // the comment there. A development store can only ever hold a test
      // subscription, and a real merchant must hold a real one.
      test: store.partnerDevelopment || app.env.SHOPIFY_ALLOW_TEST_SUBSCRIPTIONS === true,
    },
  );

  // PENDING until the merchant approves. shouldRefill refuses to charge against
  // anything but ACTIVE, so nothing can fire in this window.
  await app.db
    .update(schema.shopifyStores)
    .set({
      autorefillPackId: pack.id,
      autorefillTriggerCredits: trigger,
      autorefillSubscriptionId: subscriptionId,
      autorefillLineItemId: lineItemId,
      autorefillCappedAmountCents: Math.round(args.cappedAmountUsd * 100),
      // A fresh subscription starts a fresh cycle: nothing spent, nothing
      // warned about. Both are explicitly reset rather than left carrying the
      // previous enrolment's figures, since re-enrolling reuses this same row.
      autorefillBalanceUsedCents: 0,
      autorefillCapWarnedAt: null,
      autorefillStatus: 'PENDING',
      updatedAt: new Date(),
    })
    .where(eq(schema.shopifyStores.id, store.id));

  return { confirmationUrl };
}

interface ConfirmDeps {
  fetchStatus?: typeof fetchSubscriptionStatus;
}

/**
 * Maps Shopify's raw AppSubscription status to this codebase's status
 * vocabulary. Mirrors the equivalent switch in the app_subscriptions_update
 * webhook handler (webhook.routes.ts) so the webhook and this route can never
 * disagree about what the same raw status means. Anything other than
 * ACTIVE/DECLINED (EXPIRED, FROZEN, an actual CANCELLED, ...) collapses to
 * CANCELLED — none of those states can fund a further refill, and the only
 * distinction this codebase acts on beyond "not active" is "the merchant
 * explicitly declined."
 */
function mapSubscriptionStatus(rawStatus: string): 'ACTIVE' | 'DECLINED' | 'CANCELLED' {
  const status = rawStatus.toUpperCase();
  return status === 'ACTIVE' ? 'ACTIVE' : status === 'DECLINED' ? 'DECLINED' : 'CANCELLED';
}

/**
 * Called when the merchant returns from Shopify's approval page. Shopify
 * redirects here whether the merchant approved OR declined — the returnUrl is
 * identical either way — so the row's non-null autorefillSubscriptionId alone
 * cannot tell the two apart. This re-fetches the subscription's real status
 * via node(id:) (fetchSubscriptionStatus, autorefill-client.ts) and writes
 * whatever Shopify actually reports, the same pattern purchase.ts's
 * confirmPurchase already uses for one-time charges.
 *
 * The app_subscriptions_update webhook (webhook.routes.ts) is a second,
 * independent path to the same correction — this route just means the
 * merchant doesn't have to wait for it.
 */
export async function confirmAutorefill(
  app: FastifyInstance,
  store: Store,
  deps: ConfirmDeps = {},
): Promise<{ status: string }> {
  const fetchStatus = deps.fetchStatus ?? fetchSubscriptionStatus;

  if (!store.autorefillSubscriptionId) {
    throw new AppError('BAD_STATE', 400, 'no auto-refill enrolment to confirm');
  }

  const observed = await fetchStatus(app, store, store.autorefillSubscriptionId);
  if (!observed) {
    throw new AppError('SHOPIFY', 502, 'subscription not found at Shopify');
  }

  const status = mapSubscriptionStatus(observed.status);
  await app.db
    .update(schema.shopifyStores)
    .set({ autorefillStatus: status, ...capColumns(observed), updatedAt: new Date() })
    .where(eq(schema.shopifyStores.id, store.id));
  return { status };
}

/** The cap/spend columns to write from a Shopify read, skipping fields it didn't report. */
function capColumns(observed: {
  cappedAmountUsd: number | null;
  balanceUsedUsd: number | null;
}): Partial<typeof schema.shopifyStores.$inferInsert> {
  return {
    ...(observed.cappedAmountUsd != null
      ? { autorefillCappedAmountCents: Math.round(observed.cappedAmountUsd * 100) }
      : {}),
    ...(observed.balanceUsedUsd != null
      ? { autorefillBalanceUsedCents: Math.round(observed.balanceUsedUsd * 100) }
      : {}),
  };
}

/**
 * Re-reads the subscription from Shopify and reconciles what only Shopify can
 * know.
 *
 * Two things drift without this, both of them silently:
 *
 * 1. **The ceiling.** Merchants can change the capped amount from the Shopify
 *    admin, where this app never sees the click. Our stored figure is shown to
 *    the merchant in the app, so a stale one is the app confidently telling
 *    them a number that is wrong.
 * 2. **CAP_REACHED.** That status is ours, not Shopify's, and nothing else ever
 *    clears it. A merchant who responds to hitting the ceiling by raising it in
 *    the Shopify admin — the obvious place to do it — would otherwise stay
 *    CAP_REACHED forever, with auto-refill permanently off despite headroom
 *    they already paid for. Recovery is gated on Shopify reporting the
 *    subscription ACTIVE *and* real headroom, so this can never re-arm a
 *    subscription the merchant actually cancelled.
 *
 * Returns the observed state, or null when it couldn't be read — callers treat
 * that as "leave everything as it was" rather than as a change.
 */
export async function refreshAutorefillState(
  app: FastifyInstance,
  store: Store,
  deps: ConfirmDeps = {},
): Promise<{
  status: string;
  cappedAmountUsd: number | null;
  balanceUsedUsd: number | null;
} | null> {
  const fetchStatus = deps.fetchStatus ?? fetchSubscriptionStatus;
  if (!store.autorefillSubscriptionId) return null;

  const observed = await fetchStatus(app, store, store.autorefillSubscriptionId);
  if (!observed) return null;

  const shopifyStatus = mapSubscriptionStatus(observed.status);
  const patch: Partial<typeof schema.shopifyStores.$inferInsert> = {
    ...capColumns(observed),
    updatedAt: new Date(),
  };

  const hasHeadroom =
    observed.cappedAmountUsd != null &&
    observed.balanceUsedUsd != null &&
    observed.balanceUsedUsd < observed.cappedAmountUsd;

  if (shopifyStatus !== 'ACTIVE') {
    // Cancelled, declined or expired at Shopify's end — that's authoritative
    // over anything we hold, CAP_REACHED included.
    patch.autorefillStatus = shopifyStatus;
  } else if (store.autorefillStatus === 'CAP_REACHED' && hasHeadroom) {
    patch.autorefillStatus = 'ACTIVE';
    // Re-arm the approaching-cap warning: the ceiling this store was warned
    // about is not the ceiling it now has.
    patch.autorefillCapWarnedAt = null;
    app.log.info(
      { storeId: store.id, shopDomain: store.shopDomain },
      'auto-refill recovered from CAP_REACHED — ceiling raised or cycle rolled over',
    );
  }

  await app.db.update(schema.shopifyStores).set(patch).where(eq(schema.shopifyStores.id, store.id));

  return {
    status: patch.autorefillStatus ?? store.autorefillStatus ?? shopifyStatus,
    cappedAmountUsd: observed.cappedAmountUsd,
    balanceUsedUsd: observed.balanceUsedUsd,
  };
}

interface DisableDeps {
  cancelSubscription?: typeof cancelSubscription;
}

/**
 * Turning auto-refill off must cancel the Shopify subscription, not merely
 * clear our columns. Leaving an approved charge authorization live at Shopify
 * for a merchant who believes they revoked it is the kind of thing that ends up
 * in a review.
 *
 * Our columns are cleared even if the cancel call fails: the merchant asked for
 * this to stop, and it stopping locally is the part we control. The orphaned
 * subscription is logged for an operator.
 */
export async function disableAutorefill(
  app: FastifyInstance,
  store: Store,
  deps: DisableDeps = {},
): Promise<void> {
  const doCancel = deps.cancelSubscription ?? cancelSubscription;
  if (store.autorefillSubscriptionId) {
    try {
      await doCancel(app, store, store.autorefillSubscriptionId);
    } catch (err) {
      app.log.error(
        { err, storeId: store.id, subscriptionId: store.autorefillSubscriptionId },
        'failed to cancel auto-refill subscription at Shopify — clearing locally anyway, subscription may be orphaned',
      );
    }
  }
  await app.db
    .update(schema.shopifyStores)
    .set({
      autorefillPackId: null,
      autorefillTriggerCredits: null,
      autorefillSubscriptionId: null,
      autorefillLineItemId: null,
      autorefillCappedAmountCents: null,
      autorefillBalanceUsedCents: null,
      autorefillCapWarnedAt: null,
      autorefillStatus: null,
      updatedAt: new Date(),
    })
    .where(eq(schema.shopifyStores.id, store.id));
}

/**
 * First half of CAP_REACHED recovery. Shopify requires fresh merchant approval
 * for a higher ceiling and refuses usage records until it is granted, so this
 * returns a confirmation URL rather than fixing anything on its own.
 */
export async function raiseCap(
  app: FastifyInstance,
  store: Store,
  cappedAmountUsd: number,
): Promise<{ confirmationUrl: string }> {
  if (!store.autorefillLineItemId) {
    throw new AppError('BAD_STATE', 400, 'auto-refill is not enabled');
  }
  const current = (store.autorefillCappedAmountCents ?? 0) / 100;
  if (cappedAmountUsd <= current) {
    throw new AppError('BAD_REQUEST', 400, 'new monthly limit must be higher than the current one');
  }

  const { confirmationUrl } = await updateCappedAmount(app, store, {
    lineItemId: store.autorefillLineItemId,
    cappedAmountUsd,
  });

  // Not applied until approval lands — recorded as pending so the UI can say
  // "waiting for your approval" rather than showing a ceiling that isn't real.
  await app.db
    .update(schema.shopifyStores)
    .set({
      autorefillCappedAmountCents: Math.round(cappedAmountUsd * 100),
      autorefillStatus: 'PENDING',
      // The merchant was warned about the old ceiling; the new one deserves its
      // own warning when they approach it.
      autorefillCapWarnedAt: null,
      updatedAt: new Date(),
    })
    .where(eq(schema.shopifyStores.id, store.id));

  return { confirmationUrl };
}
