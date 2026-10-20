CREATE TABLE "stripe_subscriptions" (
	"id" text PRIMARY KEY NOT NULL,
	"student_id" uuid NOT NULL,
	"stopped_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "failed_totp_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "accounts" ADD COLUMN "totp_last_step" integer;--> statement-breakpoint
ALTER TABLE "stripe_subscriptions" ADD CONSTRAINT "stripe_subscriptions_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "stripe_subscriptions_student_idx" ON "stripe_subscriptions" USING btree ("student_id");--> statement-breakpoint
INSERT INTO "stripe_subscriptions" ("id", "student_id") SELECT "stripe_subscription_id", "id" FROM "students" WHERE "stripe_subscription_id" IS NOT NULL ON CONFLICT DO NOTHING;
