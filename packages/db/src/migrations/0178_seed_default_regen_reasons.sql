-- One-time backfill: every workflow template that has never had any
-- regeneration reasons configured (regeneration_reason_prompts still at its
-- '[]' column default) gets seeded with a fixed set of 5 default reason
-- labels, each with an empty prompt. An empty prompt means "no override" —
-- regenerateJob() (apps/api/src/modules/jobs/regenerate.ts) already falls
-- back to rerunning the original prompt whenever a matched reason has a
-- blank/missing prompt, so this only makes reasons visible in the picker; it
-- does not change what a regenerate actually produces until an admin fills
-- in a prompt for one. Templates that already have custom reasons configured
-- are left untouched by the WHERE clause.
UPDATE workflow_templates
SET regeneration_reason_prompts = '[
  {"reason": "Multiple body parts", "prompt": ""},
  {"reason": "Nudity", "prompt": ""},
  {"reason": "Draping issue", "prompt": ""},
  {"reason": "Additional assets", "prompt": ""},
  {"reason": "Texture issue", "prompt": ""}
]'::jsonb
WHERE regeneration_reason_prompts = '[]'::jsonb;
