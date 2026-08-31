ALTER TABLE "merchants" ALTER COLUMN "demo_data" SET DEFAULT false;
UPDATE "merchants" SET "demo_data" = false;