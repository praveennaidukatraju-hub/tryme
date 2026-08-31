-- Studio "Choose AI Model" picker groups model faces by continent. NULL means
-- unassigned -- shown under the "Global" bucket in the picker until an admin
-- categorizes the face. No CHECK constraint: the fixed continent set lives in
-- ContinentEnum (packages/types/src/admin.ts) so it can evolve without a migration.
ALTER TABLE "model_faces" ADD COLUMN "continent" text;
