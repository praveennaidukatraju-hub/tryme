ALTER TABLE "shopify_funnel_templates" ADD COLUMN "is_default" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "shopify_funnel_templates_single_default_idx" ON "shopify_funnel_templates" ("is_default") WHERE "is_default";
--> statement-breakpoint
UPDATE "shopify_funnel_templates" SET "is_default" = true WHERE "id" = (
  SELECT "id" FROM "shopify_funnel_templates" WHERE "is_active" ORDER BY "sort_order" ASC, "created_at" ASC LIMIT 1
);
