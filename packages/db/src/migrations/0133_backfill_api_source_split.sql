-- Backfill jobs.source = 'api' rows written before the three-way dev-API split
-- (api_tryon / api_saree_mannequin / api_catalog — see
-- docs/superpowers/specs/2026-07-30-job-taxonomy-registry-design.md §5-6).
-- Idempotent: each UPDATE's WHERE clause only matches remaining 'api' rows, so
-- re-running after the first pass is a no-op. Applied in specificity order so a
-- row matching an earlier, more specific signal is never reclassified by a later
-- one.

-- 1. Most specific: dev saree-mannequin jobs carry a distinctive params.kind.
UPDATE jobs SET source = 'api_saree_mannequin'
WHERE source = 'api'
  AND id IN (SELECT job_id FROM job_inputs WHERE params->>'kind' = 'saree_mannequin');

-- 2. Dev catalog jobs are the only remaining api-sourced shape with a resolved face.
UPDATE jobs SET source = 'api_catalog'
WHERE source = 'api'
  AND id IN (SELECT job_id FROM job_inputs WHERE face_id IS NOT NULL);

-- 3. Everything else was dev tryon-direct (personKey-shaped, or a job with no
--    job_inputs row at all).
UPDATE jobs SET source = 'api_tryon'
WHERE source = 'api';
