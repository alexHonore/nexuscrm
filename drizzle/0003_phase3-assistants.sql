CREATE TYPE "public"."assistant_status" AS ENUM('draft', 'active', 'archived');--> statement-breakpoint
CREATE TABLE "assistant_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"assistant_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"snapshot" jsonb NOT NULL,
	"compiled_prompt" text NOT NULL,
	"core_version" integer NOT NULL,
	"suite_results" jsonb,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "assistants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"status" "assistant_status" DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"language" text DEFAULT 'fr-CA' NOT NULL,
	"identity" jsonb NOT NULL,
	"goal" jsonb NOT NULL,
	"approach" jsonb NOT NULL,
	"knowledge" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"objection_packs" text[] DEFAULT '{}'::text[] NOT NULL,
	"tools" text[] DEFAULT '{}'::text[] NOT NULL,
	"model" jsonb NOT NULL,
	"prompt_mode" text DEFAULT 'composed' NOT NULL,
	"system_prompt_override" text,
	"layer_overrides" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"turn_instructions" text,
	"include_runtime_layer" boolean DEFAULT true NOT NULL,
	"require_suite_pass" boolean DEFAULT true NOT NULL,
	"compiled_prompt" text,
	"compiled_core_version" integer,
	"compiled_at" timestamp with time zone,
	"suite_passed" boolean DEFAULT false NOT NULL,
	"suite_run_id" uuid,
	"needs_recompile" boolean DEFAULT true NOT NULL,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guardrail_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"target" text NOT NULL,
	"before" jsonb,
	"after" jsonb,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guardrail_fixtures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" text NOT NULL,
	"assistant_id" uuid,
	"key" text,
	"label" text NOT NULL,
	"setup" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"inbound" text NOT NULL,
	"expectations" jsonb NOT NULL,
	"severity" text DEFAULT 'block' NOT NULL,
	"origin" text DEFAULT 'custom' NOT NULL,
	"default_snapshot" jsonb,
	"modified_from_default" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"order_index" integer DEFAULT 0 NOT NULL,
	"updated_by_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guardrail_fixtures_scope_ck" CHECK (("guardrail_fixtures"."scope" = 'assistant') = ("guardrail_fixtures"."assistant_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "guardrail_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope" text NOT NULL,
	"assistant_id" uuid,
	"key" text NOT NULL,
	"label" text NOT NULL,
	"description" text,
	"kind" text NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"prompt_text" text,
	"severity" text DEFAULT 'block' NOT NULL,
	"origin" text DEFAULT 'custom' NOT NULL,
	"default_snapshot" jsonb,
	"modified_from_default" boolean DEFAULT false NOT NULL,
	"overrides_key" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"order_index" integer DEFAULT 0 NOT NULL,
	"updated_by_id" uuid,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "guardrail_rules_scope_ck" CHECK (("guardrail_rules"."scope" = 'assistant') = ("guardrail_rules"."assistant_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "guardrail_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"assistant_id" uuid NOT NULL,
	"assistant_version" integer NOT NULL,
	"core_version" integer NOT NULL,
	"model" text NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone,
	"passed" boolean,
	"results" jsonb,
	"cost_usd" numeric(10, 4),
	"triggered_by_id" uuid
);
--> statement-breakpoint
CREATE TABLE "objection_packs" (
	"id" text PRIMARY KEY NOT NULL,
	"label" text NOT NULL,
	"language" text DEFAULT 'fr-CA' NOT NULL,
	"items" jsonb NOT NULL,
	"is_builtin" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "prompt_cores" (
	"version" integer PRIMARY KEY NOT NULL,
	"body" text NOT NULL,
	"notes" text,
	"created_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "assistant_versions" ADD CONSTRAINT "assistant_versions_assistant_id_assistants_id_fk" FOREIGN KEY ("assistant_id") REFERENCES "public"."assistants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistant_versions" ADD CONSTRAINT "assistant_versions_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistants" ADD CONSTRAINT "assistants_compiled_core_version_prompt_cores_version_fk" FOREIGN KEY ("compiled_core_version") REFERENCES "public"."prompt_cores"("version") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "assistants" ADD CONSTRAINT "assistants_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guardrail_audit" ADD CONSTRAINT "guardrail_audit_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guardrail_fixtures" ADD CONSTRAINT "guardrail_fixtures_assistant_id_assistants_id_fk" FOREIGN KEY ("assistant_id") REFERENCES "public"."assistants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guardrail_fixtures" ADD CONSTRAINT "guardrail_fixtures_updated_by_id_users_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guardrail_rules" ADD CONSTRAINT "guardrail_rules_assistant_id_assistants_id_fk" FOREIGN KEY ("assistant_id") REFERENCES "public"."assistants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guardrail_rules" ADD CONSTRAINT "guardrail_rules_updated_by_id_users_id_fk" FOREIGN KEY ("updated_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guardrail_runs" ADD CONSTRAINT "guardrail_runs_assistant_id_assistants_id_fk" FOREIGN KEY ("assistant_id") REFERENCES "public"."assistants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "guardrail_runs" ADD CONSTRAINT "guardrail_runs_triggered_by_id_users_id_fk" FOREIGN KEY ("triggered_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "prompt_cores" ADD CONSTRAINT "prompt_cores_created_by_id_users_id_fk" FOREIGN KEY ("created_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "assistant_versions_uq" ON "assistant_versions" USING btree ("assistant_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "guardrail_fixtures_core_key_uq" ON "guardrail_fixtures" USING btree ("key") WHERE "guardrail_fixtures"."assistant_id" is null and "guardrail_fixtures"."key" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "guardrail_rules_core_key_uq" ON "guardrail_rules" USING btree ("key") WHERE "guardrail_rules"."assistant_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "guardrail_rules_assistant_key_uq" ON "guardrail_rules" USING btree ("assistant_id","key") WHERE "guardrail_rules"."assistant_id" is not null;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_active_assistant_id_assistants_id_fk" FOREIGN KEY ("active_assistant_id") REFERENCES "public"."assistants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_assistant_id_assistants_id_fk" FOREIGN KEY ("assistant_id") REFERENCES "public"."assistants"("id") ON DELETE set null ON UPDATE no action;