-- jobs.status is modeled in Drizzle as unconstrained text (see packages/db/src/schema/jobs.ts),
-- but production carries a "jobs_status_check" CHECK constraint that was added out-of-band and
-- is not created by any migration in this repo. It rejects new status values (e.g.
-- PENDING_MANNEQUIN from the saree two-step flow) with error 23514. Drop it to match the schema.
DO $$ BEGIN
 ALTER TABLE "jobs" DROP CONSTRAINT "jobs_status_check";
EXCEPTION
 WHEN undefined_object THEN null;
END $$;
