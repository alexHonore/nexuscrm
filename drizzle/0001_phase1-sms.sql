CREATE TYPE "public"."consent_channel" AS ENUM('sms', 'email', 'call');--> statement-breakpoint
CREATE TYPE "public"."consent_kind" AS ENUM('express', 'implied_inquiry');--> statement-breakpoint
CREATE TYPE "public"."sms_direction" AS ENUM('in', 'out');--> statement-breakpoint
CREATE TABLE "consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"channel" "consent_channel" NOT NULL,
	"kind" "consent_kind" NOT NULL,
	"source" text NOT NULL,
	"consent_text_version" text,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client_id" uuid NOT NULL,
	"client_phone" text NOT NULL,
	"sms_number_id" uuid NOT NULL,
	"active_assistant_id" uuid,
	"active_assistant_version" integer,
	"assistant_history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"goal_rung" text DEFAULT 'primary' NOT NULL,
	"ai_enabled" boolean DEFAULT true NOT NULL,
	"paused_by_id" uuid,
	"paused_at" timestamp with time zone,
	"pause_reason" text,
	"assigned_to_id" uuid,
	"needs_attention" boolean DEFAULT false NOT NULL,
	"attention_reason" text,
	"last_inbound_at" timestamp with time zone,
	"last_outbound_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"direction" "sms_direction" NOT NULL,
	"body" text NOT NULL,
	"segments" integer,
	"encoding" text,
	"twilio_sid" text,
	"status" text,
	"error_code" integer,
	"ai_generated" boolean DEFAULT false NOT NULL,
	"assistant_id" uuid,
	"assistant_version" integer,
	"model" text,
	"source" text NOT NULL,
	"sent_by_id" uuid,
	"latency_ms" integer,
	"processed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_twilio_sid_unique" UNIQUE("twilio_sid")
);
--> statement-breakpoint
CREATE TABLE "sms_numbers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"e164" text NOT NULL,
	"messaging_service_sid" text DEFAULT '' NOT NULL,
	"assigned_to_id" uuid,
	"label" text,
	"daily_cap" integer DEFAULT 200 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sms_numbers_e164_unique" UNIQUE("e164")
);
--> statement-breakpoint
CREATE TABLE "suppressions" (
	"phone_e164" text PRIMARY KEY NOT NULL,
	"reason" text NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_sms_number_id_sms_numbers_id_fk" FOREIGN KEY ("sms_number_id") REFERENCES "public"."sms_numbers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_paused_by_id_users_id_fk" FOREIGN KEY ("paused_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_assigned_to_id_users_id_fk" FOREIGN KEY ("assigned_to_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_sent_by_id_users_id_fk" FOREIGN KEY ("sent_by_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sms_numbers" ADD CONSTRAINT "sms_numbers_assigned_to_id_users_id_fk" FOREIGN KEY ("assigned_to_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "consents_client_channel_idx" ON "consents" USING btree ("client_id","channel");--> statement-breakpoint
CREATE UNIQUE INDEX "conversations_phone_number_uq" ON "conversations" USING btree ("client_phone","sms_number_id");--> statement-breakpoint
CREATE INDEX "conversations_client_idx" ON "conversations" USING btree ("client_id");--> statement-breakpoint
CREATE INDEX "conversations_attention_idx" ON "conversations" USING btree ("needs_attention");--> statement-breakpoint
CREATE INDEX "messages_conversation_idx" ON "messages" USING btree ("conversation_id","created_at");--> statement-breakpoint
CREATE INDEX "messages_unprocessed_in_idx" ON "messages" USING btree ("conversation_id") WHERE "messages"."processed_at" is null and "messages"."direction" = 'in';