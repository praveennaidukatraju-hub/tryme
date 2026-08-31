CREATE TABLE IF NOT EXISTS "catalogue_template_subcategories" (
	"template_id" uuid NOT NULL,
	"subcategory_id" uuid NOT NULL,
	CONSTRAINT "catalogue_template_subcategories_template_id_subcategory_id_pk" PRIMARY KEY("template_id","subcategory_id")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "catalogue_template_subcategories" ADD CONSTRAINT "catalogue_template_subcategories_template_id_catalogue_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."catalogue_templates"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "catalogue_template_subcategories" ADD CONSTRAINT "catalogue_template_subcategories_subcategory_id_garment_subcategories_id_fk" FOREIGN KEY ("subcategory_id") REFERENCES "public"."garment_subcategories"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
