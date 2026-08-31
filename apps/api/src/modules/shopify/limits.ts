import type { DB } from '@tryme/db';
import { schema } from '@tryme/db';
import { and, count, gte, inArray, ne, sql } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { countingIdentity, type ShopperRow, shopperIdFilter } from './shopper.js';
import { storeDayKey, windowStart } from './store-day.js';

type Store = typeof schema.shopifyStores.$inferSelect;

export interface LimitRefusal {
  reason: 'email_required' | 'shopper_limit' | 'store_limit';
  message: string;
}

/**
 * Thrown by `lockAndRecheckShopperLimits` when a concurrent request won the
 * race for this shopper's quota. Caught in the route handler and turned into
 * the normal 202 refusal — never surfaced as a 500.
 */
export class ShopperLimitRaceRefusal extends Error {
  constructor(public readonly refusal: LimitRefusal) {
    super(`shopper limit refusal under lock: ${refusal.reason}`);
    this.name = 'ShopperLimitRaceRefusal';
  }
}

/** Every shopper row in this store sharing the shopper's counting identity. */
async function siblingShopperIds(db: DB, store: Store, shopper: ShopperRow): Promise<string[]> {
  const rows = await db
    .select({ id: schema.shopifyShoppers.id })
    .from(schema.shopifyShoppers)
    .where(shopperIdFilter(store.id, countingIdentity(shopper)));
  return rows.map((row) => row.id);
}

/** Non-failed jobs by this shopper, optionally bounded to a calendar-window start. */
async function countShopperJobs(db: DB, shopperIds: string[], since: Date | null): Promise<number> {
  if (shopperIds.length === 0) return 0;

  const clauses = [
    inArray(schema.jobs.shopifyShopperId, shopperIds),
    ne(schema.jobs.status, 'FAILED'),
  ];
  if (since) clauses.push(gte(schema.jobs.createdAt, since));
  const [row] = await db
    .select({ n: count() })
    .from(schema.jobs)
    .where(and(...clauses));
  return row.n;
}

/**
 * Check the actionable email gate before the merchant's per-shopper ceiling.
 *
 * `db` accepts either the pooled connection or an in-flight transaction (cast
 * `tx as never` at the call site, matching the rest of this module's
 * transaction-passing convention — see `atomicDeduct` usage in
 * customer.routes.ts) so the same logic serves both the pre-transaction fast
 * path and the locked recheck in `lockAndRecheckShopperLimits`.
 */
export async function checkShopperLimits(
  db: DB,
  store: Store,
  shopper: ShopperRow,
): Promise<LimitRefusal | null> {
  const limits = store.settings.limits;
  if (!limits) return null;

  const shopperIds = await siblingShopperIds(db, store, shopper);
  const emailAfter = limits.emailAfterNTryOns;
  if (emailAfter != null && !shopper.email) {
    const lifetime = await countShopperJobs(db, shopperIds, null);
    if (lifetime >= emailAfter) {
      return { reason: 'email_required', message: 'Enter your email to continue.' };
    }
  }

  const cap = limits.perShopperCap;
  if (cap != null) {
    const since = windowStart(store.ianaTimezone, limits.perShopperWindow ?? 'week');
    const used = await countShopperJobs(db, shopperIds, since);
    if (used >= cap) {
      return {
        reason: 'shopper_limit',
        message: "You've reached your try-on limit. Check back later.",
      };
    }
  }

  return null;
}

/**
 * Serializes per-shopper limit enforcement against concurrent requests from
 * the same shopper.
 *
 * The fast-path `checkShopperLimits` call in the route runs BEFORE the
 * job-creation transaction opens, purely so an obviously-doomed request never
 * pays for a Redis slot reservation or an open transaction. It is not safe
 * on its own: two concurrent requests from the same shopper can both observe
 * capacity there and both go on to create a job, exceeding a cap of 1.
 *
 * This function must run inside that same transaction, immediately before
 * the job insert. It takes a transaction-scoped Postgres advisory lock
 * (`pg_advisory_xact_lock`, auto-released at COMMIT/ROLLBACK) keyed on
 * (store, counting identity) — the same identity `checkShopperLimits` counts
 * against — so a second concurrent request blocks until the first commits or
 * rolls back, then rechecks the limit having observed the first request's
 * outcome. `hashtextextended` folds the composite key into the single bigint
 * `pg_advisory_xact_lock` takes; a rare hash collision only ever
 * over-serializes two unrelated shoppers, it can never under-serialize one.
 */
export async function lockAndRecheckShopperLimits(
  db: DB,
  store: Store,
  shopper: ShopperRow,
): Promise<void> {
  if (!store.settings.limits) return;

  const identity = countingIdentity(shopper);
  const lockKey = `shopify-shopper:${store.id}:${identity.kind}:${identity.value}`;
  await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);

  const refusal = await checkShopperLimits(db, store, shopper);
  if (refusal) throw new ShopperLimitRaceRefusal(refusal);
}

// KEYS[1] = per-store-day counter key
// ARGV[1] = cap, ARGV[2] = TTL seconds (only applied on the increment that
//   creates the key)
//
// INCR, the first-use EXPIRE, and the over-cap DECR rollback were previously
// three independently-failable round trips: a crash or network blip between
// any two of them could leave an incremented-but-never-expiring counter, or
// an over-cap increment that never got rolled back. A single EVAL is one
// round trip and Redis executes the whole script without interleaving other
// commands, so there is no window in which a partial effect can be observed
// or lost.
const RESERVE_SLOT_LUA = `
local used = redis.call('INCR', KEYS[1])
if used == 1 then
  redis.call('EXPIRE', KEYS[1], ARGV[2])
end
if used > tonumber(ARGV[1]) then
  redis.call('DECR', KEYS[1])
  return -1
end
return used
`;

/** Atomically reserve one slot against the store's local-calendar daily cap. */
export async function reserveStoreDailySlot(
  app: FastifyInstance,
  store: Store,
): Promise<{ ok: true; release: () => Promise<void> } | { ok: false }> {
  const cap = store.settings.limits?.storeDailyCap;
  if (cap == null) return { ok: true, release: async () => {} };

  const key = `shopify:cap:store:${store.id}:${storeDayKey(store.ianaTimezone)}`;
  // 48h, not 24: covers any timezone's day plus DST slack, and the key is
  // day-scoped so a stale one is never read again.
  const used = (await app.redis.eval(RESERVE_SLOT_LUA, 1, key, cap, 48 * 60 * 60)) as number;

  if (used === -1) return { ok: false };

  let released = false;
  let releaseInFlight: Promise<void> | null = null;
  return {
    ok: true,
    release: async () => {
      if (released) return;
      if (!releaseInFlight) {
        releaseInFlight = app.redis
          .decr(key)
          .then(() => {
            released = true;
          })
          .catch((err) => {
            releaseInFlight = null;
            throw err;
          });
      }
      await releaseInFlight;
    },
  };
}
