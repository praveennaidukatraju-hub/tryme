CREATE EXTENSION IF NOT EXISTS vector;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chatbot_qna" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "question" text NOT NULL,
  "answer" text NOT NULL,
  "tags" text[] DEFAULT '{}'::text[] NOT NULL,
  "is_active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chatbot_embeddings" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "qna_id" uuid NOT NULL,
  "content" text NOT NULL,
  "content_tsv" tsvector GENERATED ALWAYS AS (to_tsvector('english', content)) STORED,
  "embedding" vector(1536) NOT NULL,
  "embedded_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "chatbot_embeddings_qna_id_fk" FOREIGN KEY ("qna_id") REFERENCES "chatbot_qna"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chatbot_conversations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL,
  "status" text DEFAULT 'BOT' NOT NULL,
  "assigned_agent_id" uuid,
  "escalation_reason" text,
  "last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "closed_at" timestamp with time zone,
  CONSTRAINT "chatbot_conversations_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE cascade,
  CONSTRAINT "chatbot_conversations_agent_fk" FOREIGN KEY ("assigned_agent_id") REFERENCES "admin_users"("id") ON DELETE set null
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chatbot_messages" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "conversation_id" uuid NOT NULL,
  "role" text NOT NULL,
  "sender_id" uuid,
  "content" text NOT NULL,
  "meta" jsonb,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "chatbot_messages_conv_fk" FOREIGN KEY ("conversation_id") REFERENCES "chatbot_conversations"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chatbot_events" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "conversation_id" uuid NOT NULL,
  "type" text NOT NULL,
  "actor_id" uuid,
  "from_status" text,
  "to_status" text,
  "reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "chatbot_events_conv_fk" FOREIGN KEY ("conversation_id") REFERENCES "chatbot_conversations"("id") ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chatbot_embeddings_hnsw_idx" ON "chatbot_embeddings" USING hnsw ("embedding" vector_cosine_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chatbot_embeddings_tsv_idx" ON "chatbot_embeddings" USING gin ("content_tsv");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "chatbot_conversations_one_active_idx" ON "chatbot_conversations" ("user_id") WHERE "status" <> 'CLOSED';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chatbot_conversations_status_idx" ON "chatbot_conversations" ("status","last_message_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "chatbot_messages_conv_idx" ON "chatbot_messages" ("conversation_id","created_at");
