CREATE TABLE "param_docs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"path" text NOT NULL,
	"label_fr" text,
	"what_fr" text,
	"why_fr" text,
	"effect_fr" text,
	"pitfalls_fr" text,
	"updated_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "param_docs_path_unique" UNIQUE("path")
);
--> statement-breakpoint
ALTER TABLE "param_docs" ADD CONSTRAINT "param_docs_updated_by_id_users_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;