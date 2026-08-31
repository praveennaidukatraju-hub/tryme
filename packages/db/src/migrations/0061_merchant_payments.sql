CREATE TABLE IF NOT EXISTS "merchant_payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"widget_client_id" uuid NOT NULL,
	"plan_id" text NOT NULL,
	"razorpay_order_id" text NOT NULL,
	"razorpay_payment_id" text,
	"razorpay_signature" text,
	"base_paise" integer NOT NULL,
	"gst_paise" integer NOT NULL,
	"total_paise" integer NOT NULL,
	"credits" integer NOT NULL,
	"status" text DEFAULT 'created' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_at" timestamp with time zone,
	CONSTRAINT "merchant_payments_razorpay_order_id_unique" UNIQUE("razorpay_order_id")
);
--> statement-breakpoint
ALTER TABLE "merchant_payments" ADD CONSTRAINT "merchant_payments_widget_client_id_fkey" FOREIGN KEY ("widget_client_id") REFERENCES "widget_clients"("id") ON DELETE cascade ON UPDATE no action;
