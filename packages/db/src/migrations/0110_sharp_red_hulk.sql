ALTER TABLE "job_inputs" ALTER COLUMN "upper_garment_key" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_templates" ALTER COLUMN "face_node_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_templates" ALTER COLUMN "bg_node_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "workflow_templates" ALTER COLUMN "face_phase_prompt_node" DROP NOT NULL;