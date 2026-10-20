ALTER TYPE "public"."availability_exception_kind" ADD VALUE 'override';--> statement-breakpoint
CREATE TABLE "school_hours" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"date" text NOT NULL,
	"start_time" text NOT NULL,
	"end_time" text NOT NULL,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "school_hours" ADD CONSTRAINT "school_hours_updated_by_accounts_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "school_hours_date_start_idx" ON "school_hours" USING btree ("date","start_time");