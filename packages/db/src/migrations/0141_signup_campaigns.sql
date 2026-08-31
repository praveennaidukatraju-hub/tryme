CREATE TABLE "signup_campaigns" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"code" text NOT NULL,
	"name" text NOT NULL,
	"bonus_percent" integer NOT NULL,
	"start_at" timestamp with time zone NOT NULL,
	"end_at" timestamp with time zone NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "signup_campaigns_code_unique" UNIQUE("code")
);
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "signup_campaign_id" uuid;
--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_signup_campaign_id_signup_campaigns_id_fk" FOREIGN KEY ("signup_campaign_id") REFERENCES "public"."signup_campaigns"("id") ON DELETE set null ON UPDATE no action;
