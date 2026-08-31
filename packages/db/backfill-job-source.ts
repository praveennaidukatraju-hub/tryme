/**
 * Backfill jobs.source for historical rows created before the column existed.
 *
 * jobs.source is set going forward at 4 job-creation call sites (catalog, tryon,
 * saree, shopify — see docs/superpowers/specs/2026-07-10-admin-credit-analysis-design.md).
 *
 * Idempotent + re-runnable: only touches rows where source IS NULL. Run this once
 * per environment (dev already done; run again against staging/prod before/at deploy,
 * since the admin Credit Analysis page's catalog/tryon/saree filters otherwise
 * silently omit pre-deploy historical jobs there).
 *
 * Usage:
 *   node_modules/.bin/tsx --env-file=.env packages/db/backfill-job-source.ts
 *
 * Requires env: DATABASE_URL.
 */
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL as string);

async function main() {
  const result = await sql`
    UPDATE jobs j SET source = CASE
      WHEN j.shopify_store_id IS NOT NULL THEN 'shopify'
      WHEN EXISTS (
        SELECT 1 FROM job_inputs ji WHERE ji.job_id = j.id AND ji.params->>'kind' = 'saree'
      ) THEN 'saree'
      WHEN EXISTS (
        SELECT 1 FROM job_inputs ji WHERE ji.job_id = j.id AND ji.params->>'personKey' IS NOT NULL
      ) THEN 'tryon'
      ELSE 'catalog'
    END
    WHERE j.source IS NULL
  `;
  console.log(`Backfilled ${result.count} rows`);
  await sql.end();
}

main();
