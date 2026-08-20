import { relations, sql } from "drizzle-orm";
import {
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { clients, users } from "./schema";

// ── SMS engine — phase 1 (numbers, consent ledger, suppressions, threads) ────
// Separate module so src/db/schema.ts stays untouched; merged in src/db/index.ts
// and registered in drizzle.config.ts. Assistant/campaign tables arrive in later
// phases — until then the assistant columns below are plain uuids (FK added when
// the referenced table exists).

export const consentChannelEnum = pgEnum("consent_channel", ["sms", "email", "call"]);
export const consentKindEnum = pgEnum("consent_kind", ["express", "implied_inquiry"]);
export const smsDirectionEnum = pgEnum("sms_direction", ["in", "out"]);

// ── Tables ───────────────────────────────────────────────────────────────────

export const smsNumbers = pgTable("sms_numbers", {
  id: uuid("id").primaryKey().defaultRandom(),
  /** E.164 (+1XXXXXXXXXX) — the DID that sends and receives. */
  e164: text("e164").notNull().unique(),
  /** Twilio Messaging Service SID. Empty string until the service is created. */
  messagingServiceSid: text("messaging_service_sid").notNull().default(""),
  assignedToId: uuid("assigned_to_id").references(() => users.id, { onDelete: "set null" }),
  label: text("label"),
  /** Max outbound messages per Toronto day — campaign enrollment guard. */
  dailyCap: integer("daily_cap").notNull().default(200),
  active: boolean("active").notNull().default(true),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const consents = pgTable(
  "consents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    channel: consentChannelEnum("channel").notNull(),
    kind: consentKindEnum("kind").notNull(),
    /** Where the consent comes from, e.g. "webhook:n8n / Facebook Lead Ads". */
    source: text("source").notNull(),
    consentTextVersion: text("consent_text_version"),
    evidence: jsonb("evidence").notNull().default({}),
    grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
    /** CASL: implied consent from an inquiry lapses 6 months after grantedAt. */
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
  },
  (t) => [index("consents_client_channel_idx").on(t.clientId, t.channel)],
);

/**
 * Keyed by phone, not client id, on purpose: a suppression must survive client
 * deletion and re-import. Nothing sends to a number present here, ever.
 */
export const suppressions = pgTable("suppressions", {
  phoneE164: text("phone_e164").primaryKey(),
  /** sms_stop | carrier_error | manual | complaint */
  reason: text("reason").notNull(),
  note: text("note"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const conversations = pgTable(
  "conversations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    /** E.164 of the client at enrollment time (survives edits to clients.phone). */
    clientPhone: text("client_phone").notNull(),
    smsNumberId: uuid("sms_number_id")
      .notNull()
      .references(() => smsNumbers.id),
    /** FK to assistants added in phase 3 (table does not exist yet). */
    activeAssistantId: uuid("active_assistant_id"),
    activeAssistantVersion: integer("active_assistant_version"),
    /** [{assistantId, version, from, reason}] — transfer history. */
    assistantHistory: jsonb("assistant_history").notNull().default([]),
    /** 'primary' | 'fallback:0' | 'fallback:1' … — current goal rung. */
    goalRung: text("goal_rung").notNull().default("primary"),
    /** false = a human has taken over; every automated path must exit. */
    aiEnabled: boolean("ai_enabled").notNull().default(true),
    pausedById: uuid("paused_by_id").references(() => users.id, { onDelete: "set null" }),
    pausedAt: timestamp("paused_at", { withTimezone: true }),
    pauseReason: text("pause_reason"),
    assignedToId: uuid("assigned_to_id").references(() => users.id, { onDelete: "set null" }),
    needsAttention: boolean("needs_attention").notNull().default(false),
    attentionReason: text("attention_reason"),
    lastInboundAt: timestamp("last_inbound_at", { withTimezone: true }),
    lastOutboundAt: timestamp("last_outbound_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("conversations_phone_number_uq").on(t.clientPhone, t.smsNumberId),
    index("conversations_client_idx").on(t.clientId),
    index("conversations_attention_idx").on(t.needsAttention),
  ],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    direction: smsDirectionEnum("direction").notNull(),
    body: text("body").notNull(),
    segments: integer("segments"),
    /** GSM-7 | UCS-2 */
    encoding: text("encoding"),
    twilioSid: text("twilio_sid").unique(),
    /** Twilio delivery status: queued | sent | delivered | undelivered | failed … */
    status: text("status"),
    errorCode: integer("error_code"),
    aiGenerated: boolean("ai_generated").notNull().default(false),
    /** FK to assistants added in phase 3. */
    assistantId: uuid("assistant_id"),
    assistantVersion: integer("assistant_version"),
    model: text("model"),
    /** opener | ladder | agent | human | system — text so the list stays extensible. */
    source: text("source").notNull(),
    sentById: uuid("sent_by_id").references(() => users.id, { onDelete: "set null" }),
    latencyMs: integer("latency_ms"),
    /** Inbound only: set when the agent runtime has consumed this message as a turn. */
    processedAt: timestamp("processed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("messages_conversation_idx").on(t.conversationId, t.createdAt),
    index("messages_unprocessed_in_idx")
      .on(t.conversationId)
      .where(sql`${t.processedAt} is null and ${t.direction} = 'in'`),
  ],
);

// ── Relations ────────────────────────────────────────────────────────────────

export const smsNumbersRelations = relations(smsNumbers, ({ one, many }) => ({
  assignedTo: one(users, { fields: [smsNumbers.assignedToId], references: [users.id] }),
  conversations: many(conversations),
}));

export const consentsRelations = relations(consents, ({ one }) => ({
  client: one(clients, { fields: [consents.clientId], references: [clients.id] }),
}));

export const conversationsRelations = relations(conversations, ({ one, many }) => ({
  client: one(clients, { fields: [conversations.clientId], references: [clients.id] }),
  smsNumber: one(smsNumbers, { fields: [conversations.smsNumberId], references: [smsNumbers.id] }),
  pausedBy: one(users, { fields: [conversations.pausedById], references: [users.id] }),
  assignedTo: one(users, { fields: [conversations.assignedToId], references: [users.id] }),
  messages: many(messages),
}));

export const messagesRelations = relations(messages, ({ one }) => ({
  conversation: one(conversations, { fields: [messages.conversationId], references: [conversations.id] }),
  sentBy: one(users, { fields: [messages.sentById], references: [users.id] }),
}));
