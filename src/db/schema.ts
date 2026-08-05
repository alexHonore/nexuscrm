import { relations } from "drizzle-orm";
import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  serial,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";

// ── Enums ────────────────────────────────────────────────────────────────────

export const userRoleEnum = pgEnum("user_role", ["admin", "caller"]);
export const localeEnum = pgEnum("locale", ["fr", "en"]);
export const callDirectionEnum = pgEnum("call_direction", ["outbound", "inbound"]);
export const telephonyProviderEnum = pgEnum("telephony_provider", ["voipms", "twilio"]);
export const appointmentTypeEnum = pgEnum("appointment_type", ["meet", "inperson"]);
export const appointmentStatusEnum = pgEnum("appointment_status", [
  "scheduled",
  "cancelled",
  "completed",
  "noshow",
]);

/**
 * Call dispositions — the colored buttons in the post-call popup.
 * Stored as text (not enum) so the list stays extensible from the admin panel.
 */
export const DISPOSITIONS = [
  "voicemail",
  "booked",
  "callback",
  "not_interested",
  "dncl",
  "not_qualified",
  "no_answer",
] as const;
export type Disposition = (typeof DISPOSITIONS)[number];

// ── Tables ───────────────────────────────────────────────────────────────────

export const users = pgTable(
  "users",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    name: text("name").notNull(),
    email: text("email").notNull().unique(),
    passwordHash: text("password_hash").notNull(),
    role: userRoleEnum("role").notNull().default("caller"),
    locale: localeEnum("locale").notNull().default("fr"),
    isActive: boolean("is_active").notNull().default(true),
    /** Bumped to invalidate all existing sessions of this user. */
    tokenVersion: integer("token_version").notNull().default(1),
    // ── VoIP (voip.ms subaccount allocated by the admin) ──
    sipUsername: text("sip_username"),
    /** AES-256-GCM encrypted — see src/lib/crypto.ts */
    sipPasswordEnc: text("sip_password_enc"),
    /** DID allocated to this user, E.164 (e.g. +14184761542). Used as caller ID. */
    didNumber: text("did_number"),
    lastLoginAt: timestamp("last_login_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
);

export const categories = pgTable("categories", {
  id: serial("id").primaryKey(),
  /** Stable key for system categories mapped to dispositions (e.g. "callback"). Null for custom ones. */
  key: text("key").unique(),
  nameFr: text("name_fr").notNull(),
  nameEn: text("name_en").notNull(),
  /** Hex color, e.g. #16a34a */
  color: text("color").notNull().default("#64748b"),
  sortOrder: integer("sort_order").notNull().default(0),
  /** System categories cannot be deleted (dispositions depend on them). */
  isSystem: boolean("is_system").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const sources = pgTable("sources", {
  id: serial("id").primaryKey(),
  name: text("name").notNull().unique(),
  color: text("color").notNull().default("#64748b"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const clients = pgTable(
  "clients",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    fullName: text("full_name").notNull(),
    /** E.164 normalized (+1XXXXXXXXXX) — see src/lib/phone.ts */
    phone: text("phone").notNull(),
    phoneAlt: text("phone_alt"),
    email: text("email"),
    language: localeEnum("language").notNull().default("fr"),
    categoryId: integer("category_id").references(() => categories.id, { onDelete: "set null" }),
    sourceId: integer("source_id").references(() => sources.id, { onDelete: "set null" }),
    assignedToId: uuid("assigned_to_id").references(() => users.id, { onDelete: "set null" }),
    /** acheter | vendre | les_deux | free text from lead forms */
    projectType: text("project_type"),
    /** e.g. "0-3 mois", "12 mois +" — free text from lead forms */
    timing: text("timing"),
    budget: text("budget"),
    city: text("city"),
    address: text("address"),
    notes: text("notes"),
    doNotCall: boolean("do_not_call").notNull().default(false),
    nextFollowupAt: timestamp("next_followup_at", { withTimezone: true }),
    lastContactedAt: timestamp("last_contacted_at", { withTimezone: true }),
    lastDisposition: text("last_disposition"),
    /** Answers of the qualification form (filled before booking). */
    qualification: jsonb("qualification"),
    /** Raw payload of the webhook/import that created the client. */
    meta: jsonb("meta"),
    createdById: uuid("created_by_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("clients_phone_idx").on(t.phone),
    index("clients_category_idx").on(t.categoryId),
    index("clients_assigned_idx").on(t.assignedToId),
    index("clients_followup_idx").on(t.nextFollowupAt),
  ],
);

export const calls = pgTable(
  "calls",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    clientId: uuid("client_id").references(() => clients.id, { onDelete: "set null" }),
    direction: callDirectionEnum("direction").notNull(),
    fromNumber: text("from_number"),
    toNumber: text("to_number"),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    answeredAt: timestamp("answered_at", { withTimezone: true }),
    endedAt: timestamp("ended_at", { withTimezone: true }),
    durationSec: integer("duration_sec").notNull().default(0),
    disposition: text("disposition"),
    note: text("note"),
    provider: telephonyProviderEnum("provider").notNull().default("voipms"),
    /** voip.ms CDR uniqueid / Twilio Call SID — used to attach recordings. */
    providerCallId: text("provider_call_id"),
    recordingUrl: text("recording_url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("calls_user_started_idx").on(t.userId, t.startedAt),
    index("calls_client_idx").on(t.clientId),
    index("calls_provider_call_idx").on(t.providerCallId),
  ],
);

export const appointments = pgTable(
  "appointments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    /** The caller who booked it. */
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    type: appointmentTypeEnum("type").notNull(),
    title: text("title").notNull(),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    googleEventId: text("google_event_id"),
    meetLink: text("meet_link"),
    location: text("location"),
    status: appointmentStatusEnum("status").notNull().default("scheduled"),
    /** Snapshot of the qualification form answers at booking time. */
    qualification: jsonb("qualification"),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("appointments_starts_idx").on(t.startsAt), index("appointments_client_idx").on(t.clientId)],
);

export const comments = pgTable(
  "comments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** Plain text; mentions are written as @[Name](userId). */
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("comments_client_idx").on(t.clientId, t.createdAt)],
);

export const followups = pgTable(
  "followups",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    clientId: uuid("client_id")
      .notNull()
      .references(() => clients.id, { onDelete: "cascade" }),
    assignedToId: uuid("assigned_to_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    dueAt: timestamp("due_at", { withTimezone: true }).notNull(),
    note: text("note"),
    doneAt: timestamp("done_at", { withTimezone: true }),
    createdById: uuid("created_by_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("followups_assigned_due_idx").on(t.assignedToId, t.dueAt)],
);

export const notifications = pgTable(
  "notifications",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /** mention | followup_due | incoming_lead | appointment | system */
    type: text("type").notNull(),
    title: text("title").notNull(),
    body: text("body"),
    /** In-app link, e.g. /clients/<id> */
    link: text("link"),
    readAt: timestamp("read_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("notifications_user_idx").on(t.userId, t.createdAt)],
);

export const webhookKeys = pgTable("webhook_keys", {
  id: serial("id").primaryKey(),
  name: text("name").notNull(),
  /** AES-256-GCM encrypted full key (admin can reveal it to configure n8n). */
  keyEnc: text("key_enc").notNull(),
  /** SHA-256 of the key — used for constant-time lookup on inbound requests. */
  keyHash: text("key_hash").notNull().unique(),
  keyLast4: text("key_last4").notNull(),
  /** Defaults applied to leads created via this key: { categoryId, sourceId, assignedToId } */
  defaults: jsonb("defaults"),
  isActive: boolean("is_active").notNull().default(true),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/** Free-form typed app settings — see src/lib/settings.ts for keys & schemas. */
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const auditLogs = pgTable(
  "audit_logs",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    /** e.g. client.update, client.delete, user.create, export.csv, login.success */
    action: text("action").notNull(),
    entity: text("entity"),
    entityId: text("entity_id"),
    detail: jsonb("detail"),
    ip: text("ip"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("audit_user_idx").on(t.userId, t.createdAt), index("audit_action_idx").on(t.action)],
);

/** Simple DB-backed login throttling (per email and per IP). */
export const loginThrottle = pgTable("login_throttle", {
  key: text("key").primaryKey(),
  count: integer("count").notNull().default(0),
  resetAt: timestamp("reset_at", { withTimezone: true }).notNull(),
});

// ── Relations ────────────────────────────────────────────────────────────────

export const usersRelations = relations(users, ({ many }) => ({
  calls: many(calls),
  appointments: many(appointments),
  comments: many(comments),
  followups: many(followups, { relationName: "assignee" }),
  notifications: many(notifications),
}));

export const clientsRelations = relations(clients, ({ one, many }) => ({
  category: one(categories, { fields: [clients.categoryId], references: [categories.id] }),
  source: one(sources, { fields: [clients.sourceId], references: [sources.id] }),
  assignedTo: one(users, { fields: [clients.assignedToId], references: [users.id] }),
  createdBy: one(users, { fields: [clients.createdById], references: [users.id] }),
  calls: many(calls),
  appointments: many(appointments),
  comments: many(comments),
  followups: many(followups),
}));

export const callsRelations = relations(calls, ({ one }) => ({
  user: one(users, { fields: [calls.userId], references: [users.id] }),
  client: one(clients, { fields: [calls.clientId], references: [clients.id] }),
}));

export const appointmentsRelations = relations(appointments, ({ one }) => ({
  client: one(clients, { fields: [appointments.clientId], references: [clients.id] }),
  user: one(users, { fields: [appointments.userId], references: [users.id] }),
}));

export const commentsRelations = relations(comments, ({ one }) => ({
  client: one(clients, { fields: [comments.clientId], references: [clients.id] }),
  user: one(users, { fields: [comments.userId], references: [users.id] }),
}));

export const followupsRelations = relations(followups, ({ one }) => ({
  client: one(clients, { fields: [followups.clientId], references: [clients.id] }),
  assignedTo: one(users, {
    fields: [followups.assignedToId],
    references: [users.id],
    relationName: "assignee",
  }),
  createdBy: one(users, { fields: [followups.createdById], references: [users.id] }),
}));

export const notificationsRelations = relations(notifications, ({ one }) => ({
  user: one(users, { fields: [notifications.userId], references: [users.id] }),
}));

export const categoriesRelations = relations(categories, ({ many }) => ({
  clients: many(clients),
}));

export const sourcesRelations = relations(sources, ({ many }) => ({
  clients: many(clients),
}));
