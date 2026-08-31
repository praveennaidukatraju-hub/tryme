-- Flatten backgrounds: remove location grouping, match model_faces pattern

-- Drop FK constraint first (PostgreSQL requires dropping the FK before dropping the referenced table)
ALTER TABLE "model_backgrounds" DROP CONSTRAINT IF EXISTS "model_backgrounds_location_id_fkey";

-- Drop the index on location_id
DROP INDEX IF EXISTS "backgrounds_location_id_idx";

-- Remove location_id and angle_label columns from model_backgrounds
ALTER TABLE "model_backgrounds" DROP COLUMN IF EXISTS "location_id";
ALTER TABLE "model_backgrounds" DROP COLUMN IF EXISTS "angle_label";

-- Drop the background_locations table entirely
DROP TABLE IF EXISTS "background_locations";