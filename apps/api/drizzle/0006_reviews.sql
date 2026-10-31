CREATE TABLE "reviews" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"teacher_name" text NOT NULL,
	"teacher_id" uuid,
	"student_id" uuid,
	"author_name" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"checked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_teacher_id_teachers_id_fk" FOREIGN KEY ("teacher_id") REFERENCES "public"."teachers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reviews" ADD CONSTRAINT "reviews_student_id_students_id_fk" FOREIGN KEY ("student_id") REFERENCES "public"."students"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "reviews_teacher_name_idx" ON "reviews" USING btree ("teacher_name");--> statement-breakpoint
CREATE INDEX "reviews_student_idx" ON "reviews" USING btree ("student_id");