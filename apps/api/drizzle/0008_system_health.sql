CREATE TABLE "job_runs" (
	"name" text PRIMARY KEY NOT NULL,
	"last_started_at" timestamp with time zone,
	"last_succeeded_at" timestamp with time zone,
	"last_failed_at" timestamp with time zone,
	"last_error" text,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_alert_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "notifications" ADD COLUMN "next_retry_at" timestamp with time zone;