CREATE TABLE "teacher_photos" (
	"teacher_id" uuid PRIMARY KEY NOT NULL,
	"content_type" text NOT NULL,
	"data" bytea NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "teachers" ALTER COLUMN "profile_slug" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "teachers" ADD COLUMN "instruments" text[] DEFAULT '{}'::text[] NOT NULL;--> statement-breakpoint
ALTER TABLE "teachers" ADD COLUMN "career" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "teachers" ADD COLUMN "message" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "teacher_photos" ADD CONSTRAINT "teacher_photos_teacher_id_teachers_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "public"."teachers"("id") ON DELETE cascade ON UPDATE no action;