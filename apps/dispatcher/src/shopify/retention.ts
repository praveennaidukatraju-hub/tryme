import { type DB, schema } from '@tryme/db';
import type { Logger } from '@tryme/logger';
import type { StorageProvider } from '@tryme/storage';
import { and, eq, inArray, isNotNull, lt, notExists, or, sql } from 'drizzle-orm';

// Bounded so one store with a long backlog cannot monopolise a pass. The
// sweeper runs hourly; anything left over is picked up next time.
const BATCH = 500;

// Upper bound on select+delete iterations for the events sweep per
// `runShopifyRetention` call — up to 100k rows/hour. A cap this generous
// should only ever be hit by a genuinely catastrophic backlog; hitting it
// logs a warning rather than looping unbounded.
const MAX_SWEEP_ITERATIONS = 200;

const daysAgo = (days: number) => new Date(Date.now() - days * 86_400_000);

/** Delete an R2 object, tolerating failure. One unreachable object must not
 *  wedge retention for an entire store — the next pass retries it. */
async function tryDelete(storage: StorageProvider, key: string, log: Logger): Promise<boolean> {
  try {
    await storage.deleteObject(key);
    return true;
  } catch (err) {
    log.warn({ err, key }, 'shopify retention: object delete failed, will retry next pass');
    return false;
  }
}

/**
 * Delete shopper PII past each store's configured retention.
 *
 * Never deletes a `jobs` row: it is a billing record tied to a credit
 * deduction and a ledger entry. Retention deletes the R2 objects and nulls the
 * key columns; the job, its cost, and its timestamp survive.
 *
 * Idempotent — a null key is skipped, so a crash mid-batch simply re-runs.
 */
export async function runShopifyRetention(
  db: DB,
  storage: StorageProvider,
  log: Logger,
): Promise<void> {
  const stores = await db.select().from(schema.shopifyStores);

  for (const store of stores) {
    const retention = store.settings?.retention;
    if (!retention) continue;

    if (retention.shopperPhotoDays != null) {
      const rows = await db
        .select({ id: schema.jobs.id, key: schema.jobs.customerPhotoKey })
        .from(schema.jobs)
        .where(
          and(
            eq(schema.jobs.shopifyStoreId, store.id),
            isNotNull(schema.jobs.customerPhotoKey),
            lt(schema.jobs.createdAt, daysAgo(retention.shopperPhotoDays)),
          ),
        )
        .limit(BATCH);

      for (const row of rows) {
        if (!row.key) continue;
        if (!(await tryDelete(storage, row.key, log))) continue;
        await db
          .update(schema.jobs)
          .set({ customerPhotoKey: null })
          .where(eq(schema.jobs.id, row.id));
      }
      if (rows.length > 0) {
        log.info({ storeId: store.id, count: rows.length }, 'shopify retention: photos purged');
      }
    }

    if (retention.resultDays != null) {
      const rows = await db
        .select({
          jobId: schema.jobOutputs.jobId,
          resultKey: schema.jobOutputs.resultKey,
          thumbnailKey: schema.jobOutputs.thumbnailKey,
        })
        .from(schema.jobOutputs)
        .innerJoin(schema.jobs, eq(schema.jobs.id, schema.jobOutputs.jobId))
        .where(
          and(
            eq(schema.jobs.shopifyStoreId, store.id),
            // Either key alone still makes this row a retry candidate: a row
            // whose resultKey delete succeeded but whose thumbnailKey delete
            // failed must stay in scope on the next pass, or the orphaned
            // thumbnail object and its stale reference are never retried.
            or(isNotNull(schema.jobOutputs.resultKey), isNotNull(schema.jobOutputs.thumbnailKey)),
            lt(schema.jobs.createdAt, daysAgo(retention.resultDays)),
          ),
        )
        .limit(BATCH);

      for (const row of rows) {
        // The two keys are nulled independently: one object may delete
        // successfully while its sibling transiently fails, and a failed
        // delete must leave its own column non-null so the next pass retries
        // just that object rather than orphaning it.
        const update: { resultKey?: null; thumbnailKey?: null } = {};
        if (row.resultKey) {
          if (await tryDelete(storage, row.resultKey, log)) update.resultKey = null;
        }
        if (row.thumbnailKey) {
          if (await tryDelete(storage, row.thumbnailKey, log)) update.thumbnailKey = null;
        }
        if (Object.keys(update).length > 0) {
          await db
            .update(schema.jobOutputs)
            .set(update)
            .where(eq(schema.jobOutputs.jobId, row.jobId));
        }
      }
      if (rows.length > 0) {
        log.info({ storeId: store.id, count: rows.length }, 'shopify retention: results purged');
      }
    }

    if (retention.shopperRecordDays != null) {
      // jobs.shopify_shopper_id is ON DELETE SET NULL, so this severs the link
      // without touching billing history.
      //
      // But that link is also the ONLY path GDPR redaction has from a data
      // subject to their stored objects (see redactShopperData in
      // apps/api/src/modules/shopify/gdpr.ts, which iterates shopifyShoppers).
      // Deleting a shopper row while any of their objects still exist would
      // orphan those objects permanently: nothing could ever find them again to
      // honour an erasure request. So a shopper is only removable once every
      // R2 reference on their jobs is gone — same "never destroy the last
      // reference to an undeleted object" invariant the photo/result branches
      // above enforce at the key-column level.
      //
      // In steady state this holds trivially: the two purge branches run
      // earlier in this same pass and shopperRecordDays is meant to be the
      // longest window. It matters when a merchant misconfigures the knobs
      // (records shorter than photos), or when an object delete has been
      // failing and leaving its key in place pass after pass.
      const shopperStillHasObjects = db
        .select({ one: sql`1` })
        .from(schema.jobs)
        .leftJoin(schema.jobOutputs, eq(schema.jobOutputs.jobId, schema.jobs.id))
        .where(
          and(
            eq(schema.jobs.shopifyShopperId, schema.shopifyShoppers.id),
            or(
              isNotNull(schema.jobs.customerPhotoKey),
              isNotNull(schema.jobOutputs.resultKey),
              isNotNull(schema.jobOutputs.thumbnailKey),
            ),
          ),
        );

      const deleted = await db
        .delete(schema.shopifyShoppers)
        .where(
          and(
            eq(schema.shopifyShoppers.storeId, store.id),
            lt(schema.shopifyShoppers.lastSeenAt, daysAgo(retention.shopperRecordDays)),
            notExists(shopperStillHasObjects),
          ),
        )
        .returning({ id: schema.shopifyShoppers.id });
      if (deleted.length > 0) {
        log.info(
          { storeId: store.id, count: deleted.length },
          'shopify retention: shopper records purged',
        );
      }
    }
  }

  // Fixed 400-day horizon, deliberately not merchant-configurable and
  // deliberately not inside the per-store loop above: that loop bails early on
  // `if (!retention) continue`, and this sweep must run for every store. 400
  // days covers an "all time" analytics range plus year-over-year comparison,
  // and it is the same ceiling the analytics endpoint enforces on a requested
  // range — a merchant who could shorten it would silently destroy their own
  // history and see it as a traffic collapse.
  //
  // Looped rather than a single BATCH-sized bite: a single store can write up
  // to 600 events/minute through the ingest endpoint's rate limit (up to
  // 36,000/hour), which one 500-row pass cannot keep up with against an
  // hourly sweeper. MAX_SWEEP_ITERATIONS bounds a single call so a
  // catastrophic backlog cannot turn one retention run into an unbounded
  // loop; hitting it means the backlog needs a manual catch-up pass.
  const eventCutoff = daysAgo(400);
  let totalSwept = 0;
  let iterations = 0;
  let hitCap = false;
  while (true) {
    iterations++;
    const stale = await db
      .select({ id: schema.shopifyWidgetEvents.id })
      .from(schema.shopifyWidgetEvents)
      .where(lt(schema.shopifyWidgetEvents.createdAt, eventCutoff))
      .limit(BATCH);

    if (stale.length === 0) break;

    await db.delete(schema.shopifyWidgetEvents).where(
      inArray(
        schema.shopifyWidgetEvents.id,
        stale.map((r) => r.id),
      ),
    );
    totalSwept += stale.length;

    if (stale.length < BATCH) break;
    if (iterations >= MAX_SWEEP_ITERATIONS) {
      hitCap = true;
      break;
    }
  }

  if (totalSwept > 0) {
    log.info({ deleted: totalSwept, iterations }, 'shopify retention: swept widget events');
  }
  if (hitCap) {
    log.warn(
      { deleted: totalSwept, iterations },
      'shopify retention: hit MAX_SWEEP_ITERATIONS while sweeping widget events — backlog likely remains, needs a manual catch-up pass',
    );
  }
}
