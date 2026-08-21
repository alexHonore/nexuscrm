CREATE TABLE "agent_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_turn_traces" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"message_id" uuid,
	"assistant_id" uuid,
	"assistant_version" integer,
	"core_version" integer,
	"inbound_batch" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"system_prompt" text NOT NULL,
	"runtime_block" text DEFAULT '' NOT NULL,
	"message_array" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"tools_offered" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"provider" text NOT NULL,
	"model_requested" text NOT NULL,
	"model_served" text,
	"upstream_provider" text,
	"raw_response" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"tool_calls" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"guardrail_results" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"regenerations" integer DEFAULT 0 NOT NULL,
	"outcome" text NOT NULL,
	"latency_ms" integer,
	"tokens_in" integer,
	"tokens_out" integer,
	"cost_usd" numeric(10, 5),
	"is_replay" boolean DEFAULT false NOT NULL,
	"replay_of" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "qualification" jsonb DEFAULT '{}'::jsonb NOT NULL;--> statement-breakpoint
ALTER TABLE "conversations" ADD COLUMN "soft_refusals" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agent_events" ADD CONSTRAINT "agent_events_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_turn_traces" ADD CONSTRAINT "agent_turn_traces_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_turn_traces" ADD CONSTRAINT "agent_turn_traces_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_turn_traces" ADD CONSTRAINT "agent_turn_traces_assistant_id_assistants_id_fk" FOREIGN KEY ("assistant_id") REFERENCES "public"."assistants"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_events_conversation_idx" ON "agent_events" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_turn_traces_conversation_idx" ON "agent_turn_traces" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_turn_traces_created_idx" ON "agent_turn_traces" USING btree ("created_at");