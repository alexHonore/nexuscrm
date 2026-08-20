CREATE TABLE "scheduled_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"type" text NOT NULL,
	"run_at" timestamp with time zone NOT NULL,
	"payload" jsonb NOT NULL,
	"dedupe_key" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"locked_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "messages" ADD COLUMN "job_id" uuid;--> statement-breakpoint
CREATE INDEX "scheduled_jobs_status_run_idx" ON "scheduled_jobs" USING btree ("status","run_at");--> statement-breakpoint
CREATE UNIQUE INDEX "scheduled_jobs_dedupe_live_uq" ON "scheduled_jobs" USING btree ("dedupe_key") WHERE "scheduled_jobs"."status" in ('pending', 'running');--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_job_id_unique" UNIQUE("job_id");