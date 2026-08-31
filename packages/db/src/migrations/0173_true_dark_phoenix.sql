ALTER TABLE "workflow_templates" ADD COLUMN "stage1_positive_prompt_node" text;--> statement-breakpoint
ALTER TABLE "workflow_templates" ADD COLUMN "stage1_negative_prompt_node" text;--> statement-breakpoint
ALTER TABLE "workflow_templates" ADD COLUMN "default_stage1_positive_prompt" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_templates" ADD COLUMN "default_stage1_negative_prompt" text DEFAULT '' NOT NULL;