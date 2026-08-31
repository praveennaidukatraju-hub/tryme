import { schema } from '@tryme/db';
import { and, eq, inArray, isNotNull, isNull, or } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { normalizeEmail } from './shopper.js';

export interface ShopperMatch {
  shopifyCustomerId?: number | null;
  email?: string | null;
  /** shop_redact: every shopper for the store, ignoring the other fields. */
  matchAll?: boolean;
}

/** Match on customer id first, then email: a shopper may have supplied an
 *  email without ever logging in, and the webhook payload carries both.
 *  Returns null when nothing identifies a subject, so an empty payload can
 *  never be read as "match everything". */
function matchFilter(storeId: string, match: ShopperMatch) {
  const storeScope = eq(schema.shopifyShoppers.storeId, storeId);
  if (match.matchAll) return storeScope;

  const email = normalizeEmail(match.email);
  const clauses = [];
  if (match.shopifyCustomerId != null) {
    clauses.push(eq(schema.shopifyShoppers.shopifyCustomerId, match.shopifyCustomerId));
  }
  if (email) clauses.push(eq(schema.shopifyShoppers.email, email));
  if (clauses.length === 0) return null;
  return and(storeScope, or(...clauses));
}

/** Rows and stored R2 keys for a data-subject access request. */
export async function collectShopperData(
  app: FastifyInstance,
  storeId: string,
  match: ShopperMatch,
): Promise<{ shopperIds: string[]; emails: string[] }> {
  const filter = matchFilter(storeId, match);
  if (!filter) return { shopperIds: [], emails: [] };
  const rows = await app.db
    .select({ id: schema.shopifyShoppers.id, email: schema.shopifyShoppers.email })
    .from(schema.shopifyShoppers)
    .where(filter);
  return {
    shopperIds: rows.map((r) => r.id),
    emails: rows.map((r) => r.email).filter((e): e is string => !!e),
  };
}

export interface RedactResult {
  /** Shopper rows fully erased (every object of theirs is gone). */
  removed: number;
  /**
   * Subjects left partially redacted because at least one object delete
   * failed. Non-zero means the erasure is NOT complete and something has to
   * chase it: unlike retention, nothing re-runs GDPR redaction automatically.
   * Counts shopper rows left in place, plus (for a store-wide purge) each
   * unlinked job whose objects could not all be removed.
   */
  incomplete: number;
}

/**
 * Delete every R2 object referenced by one job, nulling only the key columns
 * whose own delete succeeded.
 *
 * Returns true when the job holds no surviving object reference. A false
 * return means a database reference to a live object is still on this row —
 * deliberately, so a retry can find it. Never null a column whose object is
 * still there: that pointer is the only way back to it.
 */
async function purgeJobObjects(
  app: FastifyInstance,
  job: { id: string; photoKey: string | null },
): Promise<boolean> {
  let clean = true;

  if (job.photoKey) {
    let photoDeleted = false;
    try {
      await app.storage.deleteObject(job.photoKey);
      photoDeleted = true;
    } catch (err) {
      app.log.warn({ err, jobId: job.id }, 'gdpr redact: photo delete failed');
    }
    if (photoDeleted) {
      await app.db
        .update(schema.jobs)
        .set({ customerPhotoKey: null })
        .where(eq(schema.jobs.id, job.id));
    } else {
      clean = false;
    }
  }

  const [out] = await app.db
    .select()
    .from(schema.jobOutputs)
    .where(eq(schema.jobOutputs.jobId, job.id));
  if (out) {
    const patch: { resultKey?: null; thumbnailKey?: null } = {};
    if (out.resultKey) {
      try {
        await app.storage.deleteObject(out.resultKey);
        patch.resultKey = null;
      } catch (err) {
        app.log.warn({ err, jobId: job.id }, 'gdpr redact: result delete failed');
        clean = false;
      }
    }
    if (out.thumbnailKey) {
      try {
        await app.storage.deleteObject(out.thumbnailKey);
        patch.thumbnailKey = null;
      } catch (err) {
        app.log.warn({ err, jobId: job.id }, 'gdpr redact: result delete failed');
        clean = false;
      }
    }
    if (Object.keys(patch).length > 0) {
      await app.db.update(schema.jobOutputs).set(patch).where(eq(schema.jobOutputs.jobId, job.id));
    }
  }

  return clean;
}

/**
 * Erase a shopper: their R2 photos and results, then the row itself.
 *
 * jobs.shopify_shopper_id is ON DELETE SET NULL, so the billing rows survive
 * with the link severed.
 *
 * Retry-safe by construction: a database reference to an R2 object (a job's
 * customerPhotoKey, a jobOutputs row's resultKey/thumbnailKey) is only
 * cleared once its own delete actually succeeded (or the key was already
 * absent) — never as an all-or-nothing pair. And a shopifyShoppers row is
 * only deleted once every object-delete attempt for that shopper's jobs
 * succeeded; if any failed, the row (and whichever keys are still non-null)
 * is left in place so a future retry can find and finish the job.
 *
 * `match.matchAll` (shop_redact — the whole shop is erased, not one subject)
 * additionally sweeps jobs that no shopper row points at: a job created before
 * the widget sent a clientId, or one whose link was already severed by
 * retention, is invisible to the per-shopper walk and would otherwise keep its
 * photo and result forever. That extra sweep is deliberately NOT done for
 * customers_redact, which must only touch the one data subject named in the
 * payload.
 */
export async function redactShopperData(
  app: FastifyInstance,
  storeId: string,
  match: ShopperMatch,
): Promise<RedactResult> {
  const filter = matchFilter(storeId, match);
  if (!filter) return { removed: 0, incomplete: 0 };

  const shoppers = await app.db
    .select({ id: schema.shopifyShoppers.id })
    .from(schema.shopifyShoppers)
    .where(filter);
  const ids = shoppers.map((s) => s.id);

  // Per-shopper "every object delete succeeded (or had nothing to delete)"
  // flag. Only shoppers that stay true across their whole job set are
  // eligible for row deletion below.
  const shopperClean = new Map<string, boolean>();
  for (const id of ids) shopperClean.set(id, true);

  for (const shopperId of ids) {
    const jobRows = await app.db
      .select({ id: schema.jobs.id, photoKey: schema.jobs.customerPhotoKey })
      .from(schema.jobs)
      .where(and(eq(schema.jobs.shopifyShopperId, shopperId), isNotNull(schema.jobs.id)));

    for (const job of jobRows) {
      if (!(await purgeJobObjects(app, job))) shopperClean.set(shopperId, false);
    }
  }

  const removableIds = ids.filter((id) => shopperClean.get(id));
  if (removableIds.length > 0) {
    await app.db
      .delete(schema.shopifyShoppers)
      .where(inArray(schema.shopifyShoppers.id, removableIds));
  }
  let incomplete = ids.length - removableIds.length;

  if (match.matchAll) incomplete += await purgeUnlinkedStoreJobs(app, storeId);

  return { removed: removableIds.length, incomplete };
}

/**
 * Delete the R2 objects of every job for a store that no shopper row points at.
 *
 * Only for full-store erasure (shop_redact). The per-shopper walk in
 * `redactShopperData` reaches jobs through `jobs.shopify_shopper_id`; a job
 * with that column NULL is unreachable from any shopper row, so without this
 * its photo and result survive an "erase everything for this shop" request
 * indefinitely.
 *
 * Returns the number of jobs still holding a live object reference after the
 * attempt, so the caller can surface an incomplete erasure.
 */
async function purgeUnlinkedStoreJobs(app: FastifyInstance, storeId: string): Promise<number> {
  const jobRows = await app.db
    .select({ id: schema.jobs.id, photoKey: schema.jobs.customerPhotoKey })
    .from(schema.jobs)
    .leftJoin(schema.jobOutputs, eq(schema.jobOutputs.jobId, schema.jobs.id))
    .where(
      and(
        eq(schema.jobs.shopifyStoreId, storeId),
        isNull(schema.jobs.shopifyShopperId),
        // Rows with nothing left to delete are skipped rather than re-walked:
        // a shop with a long history would otherwise re-read every job on
        // every redelivery of the webhook.
        or(
          isNotNull(schema.jobs.customerPhotoKey),
          isNotNull(schema.jobOutputs.resultKey),
          isNotNull(schema.jobOutputs.thumbnailKey),
        ),
      ),
    );

  let incomplete = 0;
  for (const job of jobRows) {
    if (!(await purgeJobObjects(app, job))) incomplete += 1;
  }
  return incomplete;
}
