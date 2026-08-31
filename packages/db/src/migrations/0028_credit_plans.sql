CREATE TABLE credit_plans (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  subtext       TEXT NOT NULL DEFAULT '',
  credits       INTEGER NOT NULL,
  base_paise    INTEGER NOT NULL,
  is_active     BOOLEAN NOT NULL DEFAULT TRUE,
  is_highlighted BOOLEAN NOT NULL DEFAULT FALSE,
  badge         TEXT,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
