-- Data cleanup: any user whose tier doesn't match a known plan slug (stale/garbage
-- data from before credit_plans existed, or a manually-edited row) falls back to
-- the free plan rather than leaving an orphaned value that a FK could reject.
UPDATE users SET tier = 'free' WHERE tier NOT IN (SELECT slug FROM credit_plans);

-- Enforce at the DB level what the API has only enforced by convention until now:
-- users.tier must always reference a real credit_plans row. ON DELETE RESTRICT
-- means Postgres itself refuses to delete a plan that users are still on, as a
-- backstop behind the application-level check in creditPlans.routes.ts.
ALTER TABLE users
  ADD CONSTRAINT users_tier_credit_plans_slug_fkey
  FOREIGN KEY (tier) REFERENCES credit_plans(slug)
  ON DELETE RESTRICT;
