ALTER TABLE "workflow_templates" ALTER COLUMN "output_max_px" SET DEFAULT 2048;
UPDATE "workflow_templates" SET "output_max_px" = 2048 WHERE "output_max_px" = 1024;
