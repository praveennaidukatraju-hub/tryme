CREATE TABLE IF NOT EXISTS "catalogue_template_look_exclusions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mapping_id" uuid NOT NULL,
	"look_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "catalogue_template_look_exclusions_mapping_look_unique" UNIQUE("mapping_id","look_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "catalogue_template_look_exclusions" ADD CONSTRAINT "catalogue_template_look_exclusions_mapping_id_catalogue_template_subcategories_id_fk" FOREIGN KEY ("mapping_id") REFERENCES "public"."catalogue_template_subcategories"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "catalogue_template_look_exclusions" ADD CONSTRAINT "catalogue_template_look_exclusions_look_id_catalogue_template_looks_id_fk" FOREIGN KEY ("look_id") REFERENCES "public"."catalogue_template_looks"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "catalogue_template_look_exclusions_mapping_id_idx" ON "catalogue_template_look_exclusions" USING btree ("mapping_id");