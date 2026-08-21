import { relations, sql } from "drizzle-orm";
import {
  boolean,
  check,
  index,
  integer,
  jsonb,
  numeric,
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
export const assistantStatusEnum = pgEnum("assistant_status", ["draft", "active", "archived"]);

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
    activeAssistantId: uuid("active_assistant_id").references(() => assistants.id, {
      onDelete: "set null",
    }),
    activeAssistantVersion: integer("active_assistant_version"),
    /** [{assistantId, version, from, reason}] — transfer history. */
    assistantHistory: jsonb("assistant_history").notNull().default([]),
    /** 'primary' | 'fallback:0' | 'fallback:1' … — current goal rung. */
    goalRung: text("goal_rung").notNull().default("primary"),
    /**
     * Qualification extraite par l'agent au fil des tours. Colonne DEDIEE et
     * non `clients.qualification` : le formulaire de reservation humain ecrase
     * cette derniere en entier, avec des cles camelCase et des enums — melanger
     * les deux ferait disparaitre sans trace ce que l'assistant a appris.
     * La reconciliation vers la fiche client est une decision d'operateur
     * (phase 8), pas un ecrasement silencieux.
     */
    qualification: jsonb("qualification").notNull().default({}),
    /** Refus mous encaisses — pilote la chaine de reculs (voir lib/agent/goal). */
    softRefusals: integer("soft_refusals").notNull().default(0),
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
    /**
     * Job send_sms qui a produit cette rangée (garde anti-double-envoi : la
     * rangée-intention est écrite AVANT l'appel Twilio ; un job re-réclamé qui
     * retrouve sa rangée ne rappelle jamais le transport). Unique, nullable —
     * les entrants et les envois hors file n'en ont pas.
     */
    jobId: uuid("job_id").unique(),
    assistantId: uuid("assistant_id").references(() => assistants.id, { onDelete: "set null" }),
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

/**
 * File d'attente durable du moteur SMS (phase 2). Un seul système de jobs pour
 * tout le moteur : envois, tours d'agent (phase 4), relances (phase 6). Le
 * dispatcher (/api/cron/dispatch) réclame les jobs dus avec FOR UPDATE SKIP
 * LOCKED — deux dispatchers concurrents ne peuvent jamais exécuter le même job.
 */
export const scheduledJobs = pgTable(
  "scheduled_jobs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** send_sms | agent_turn (phase 4) | send_ladder (phase 6) … */
    type: text("type").notNull(),
    runAt: timestamp("run_at", { withTimezone: true }).notNull(),
    payload: jsonb("payload").notNull(),
    /**
     * Idempotence : un même dedupe_key = un seul job VIVANT (pending/running —
     * index unique partiel ci-dessous). Un job réglé ou annulé libère sa clé,
     * sinon l'interrupteur d'arrêt empoisonnerait à jamais les clés stables
     * (relances de phase 6, débounce de phase 4).
     */
    dedupeKey: text("dedupe_key"),
    /** pending | running | done | skipped | failed | cancelled */
    status: text("status").notNull().default("pending"),
    /** Nombre de réclamations (incrémenté au claim, pas à l'échec). */
    attempts: integer("attempts").notNull().default(0),
    lockedAt: timestamp("locked_at", { withTimezone: true }),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("scheduled_jobs_status_run_idx").on(t.status, t.runAt),
    uniqueIndex("scheduled_jobs_dedupe_live_uq")
      .on(t.dedupeKey)
      .where(sql`${t.status} in ('pending', 'running')`),
  ],
);

// ── Assistants IA (phase 3) ──────────────────────────────────────────────────

/**
 * Corps L0 du prompt compilé — global et versionné. Chaque bump de version
 * marque tous les assistants `needs_recompile` ; la porte d'activation exige
 * une compilation contre la version courante.
 */
export const promptCores = pgTable("prompt_cores", {
  version: integer("version").primaryKey(),
  body: text("body").notNull(),
  notes: text("notes"),
  createdById: uuid("created_by_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const assistants = pgTable("assistants", {
  id: uuid("id").primaryKey().defaultRandom(),
  name: text("name").notNull(),
  description: text("description"),
  status: assistantStatusEnum("status").notNull().default("draft"),
  version: integer("version").notNull().default(1),
  language: text("language").notNull().default("fr-CA"),
  /** Config structurée — formes zod dans src/lib/assistants/schema.ts. */
  identity: jsonb("identity").notNull(),
  goal: jsonb("goal").notNull(),
  approach: jsonb("approach").notNull(),
  knowledge: jsonb("knowledge").notNull().default({}),
  objectionPacks: text("objection_packs")
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  tools: text("tools")
    .array()
    .notNull()
    .default(sql`'{}'::text[]`),
  model: jsonb("model").notNull(),
  /** composed = compilé par couches ; raw = system_prompt_override intégral. */
  promptMode: text("prompt_mode").notNull().default("composed"),
  systemPromptOverride: text("system_prompt_override"),
  /** {"L3": {"mode": "replace"|"append", "text": "…"}} */
  layerOverrides: jsonb("layer_overrides").notNull().default({}),
  /** Gabarit L7 éditable ; null = gabarit intégré par défaut. */
  turnInstructions: text("turn_instructions"),
  includeRuntimeLayer: boolean("include_runtime_layer").notNull().default(true),
  /** false = la porte d'activation devient consultative (§11.2.3). */
  requireSuitePass: boolean("require_suite_pass").notNull().default(true),
  compiledPrompt: text("compiled_prompt"),
  compiledCoreVersion: integer("compiled_core_version").references(() => promptCores.version),
  compiledAt: timestamp("compiled_at", { withTimezone: true }),
  suitePassed: boolean("suite_passed").notNull().default(false),
  suiteRunId: uuid("suite_run_id"),
  /** Posé à chaque sauvegarde/bump de core ; effacé par la compilation. */
  needsRecompile: boolean("needs_recompile").notNull().default(true),
  createdById: uuid("created_by_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const assistantVersions = pgTable(
  "assistant_versions",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    assistantId: uuid("assistant_id")
      .notNull()
      .references(() => assistants.id, { onDelete: "cascade" }),
    version: integer("version").notNull(),
    /** Config complète au moment du gel — la reconstitution exacte d'un envoi. */
    snapshot: jsonb("snapshot").notNull(),
    compiledPrompt: text("compiled_prompt").notNull(),
    coreVersion: integer("core_version").notNull(),
    suiteResults: jsonb("suite_results"),
    createdById: uuid("created_by_id").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("assistant_versions_uq").on(t.assistantId, t.version)],
);

export const objectionPacks = pgTable("objection_packs", {
  /** Identifiant stable (buyer_fr…) — référencé par assistants.objection_packs. */
  id: text("id").primaryKey(),
  label: text("label").notNull(),
  language: text("language").notNull().default("fr-CA"),
  /** [{key, triggerHint, acknowledge, reframe, ask}] */
  items: jsonb("items").notNull(),
  isBuiltin: boolean("is_builtin").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Garde-fous — entièrement éditables par l'admin, AUCUNE règle codée en dur ─

export const guardrailRules = pgTable(
  "guardrail_rules",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** core = tous les assistants ; assistant = un seul. */
    scope: text("scope").notNull(),
    assistantId: uuid("assistant_id").references(() => assistants.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    label: text("label").notNull(),
    description: text("description"),
    /**
     * forbidden_regex | forbidden_terms | max_chars | max_questions |
     * link_policy | required_tool_on_intent | llm_judge | custom_instruction
     */
    kind: text("kind").notNull(),
    config: jsonb("config").notNull().default({}),
    /** Texte FR injecté dans la couche L6 du prompt compilé. */
    promptText: text("prompt_text"),
    /** block = bloque l'envoi et la suite ; warn = journalise ; off = inerte. */
    severity: text("severity").notNull().default("block"),
    origin: text("origin").notNull().default("custom"),
    /** État semé — alimente « Réinitialiser » sur les règles par défaut. */
    defaultSnapshot: jsonb("default_snapshot"),
    modifiedFromDefault: boolean("modified_from_default").notNull().default(false),
    /** Fork assistant d'une règle core portant cette clé — le fork gagne. */
    overridesKey: text("overrides_key"),
    enabled: boolean("enabled").notNull().default(true),
    orderIndex: integer("order_index").notNull().default(0),
    updatedById: uuid("updated_by_id").references(() => users.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Une clé unique par portée : les règles core entre elles, et par assistant.
    uniqueIndex("guardrail_rules_core_key_uq").on(t.key).where(sql`${t.assistantId} is null`),
    uniqueIndex("guardrail_rules_assistant_key_uq")
      .on(t.assistantId, t.key)
      .where(sql`${t.assistantId} is not null`),
    check("guardrail_rules_scope_ck", sql`(${t.scope} = 'assistant') = (${t.assistantId} is not null)`),
  ],
);

export const guardrailFixtures = pgTable(
  "guardrail_fixtures",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    scope: text("scope").notNull(),
    assistantId: uuid("assistant_id").references(() => assistants.id, { onDelete: "cascade" }),
    /** Clé stable de la semence — le libellé est renommable, pas elle. */
    key: text("key"),
    label: text("label").notNull(),
    /** {priorTurns: [["out","…"],["in","…"]], qualification: {}, rung, turnsUsed} */
    setup: jsonb("setup").notNull().default({}),
    inbound: text("inbound").notNull(),
    /** §11.3 : mustCallTool, mustNotCallTool, mustMatch, mustNotMatch, judge, maxChars */
    expectations: jsonb("expectations").notNull(),
    severity: text("severity").notNull().default("block"),
    origin: text("origin").notNull().default("custom"),
    defaultSnapshot: jsonb("default_snapshot"),
    modifiedFromDefault: boolean("modified_from_default").notNull().default(false),
    enabled: boolean("enabled").notNull().default(true),
    orderIndex: integer("order_index").notNull().default(0),
    updatedById: uuid("updated_by_id").references(() => users.id, { onDelete: "set null" }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    check(
      "guardrail_fixtures_scope_ck",
      sql`(${t.scope} = 'assistant') = (${t.assistantId} is not null)`,
    ),
    // Une clé semée n'existe qu'une fois par portée : renommer un libellé ne
    // doit jamais faire réapparaître un doublon au prochain seed.
    uniqueIndex("guardrail_fixtures_core_key_uq")
      .on(t.key)
      .where(sql`${t.assistantId} is null and ${t.key} is not null`),
  ],
);

export const guardrailRuns = pgTable("guardrail_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  assistantId: uuid("assistant_id")
    .notNull()
    .references(() => assistants.id, { onDelete: "cascade" }),
  assistantVersion: integer("assistant_version").notNull(),
  coreVersion: integer("core_version").notNull(),
  model: text("model").notNull(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  passed: boolean("passed"),
  /** [{fixtureId, label, severity, passed, reason, output, toolsCalled}] */
  results: jsonb("results"),
  costUsd: numeric("cost_usd", { precision: 10, scale: 4 }),
  triggeredById: uuid("triggered_by_id").references(() => users.id, { onDelete: "set null" }),
});

export const guardrailAudit = pgTable("guardrail_audit", {
  id: uuid("id").primaryKey().defaultRandom(),
  actorId: uuid("actor_id").references(() => users.id, { onDelete: "set null" }),
  /**
   * rule_edited | rule_disabled | rule_reset | rule_created | rule_deleted |
   * fixture_edited | fixture_created | fixture_deleted | core_body_edited |
   * core_version_bump | reset_all | assistant_imported
   */
  action: text("action").notNull(),
  target: text("target").notNull(),
  before: jsonb("before"),
  after: jsonb("after"),
  reason: text("reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * Journal des évènements d'une conversation (§5.4) — ce que l'opérateur voit
 * inséré dans le fil : outil appelé, sortie bloquée, escalade, transfert,
 * rétrogradation d'objectif, reprise humaine. Aucune donnée personnelle au-delà
 * de ce que la conversation contient déjà.
 */
export const agentEvents = pgTable(
  "agent_events",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    /**
     * tool_call | blocked_output | escalation | transfer | goal_downgrade |
     * llm_error | takeover | resume | stop | hard_refusal | max_turns
     */
    type: text("type").notNull(),
    payload: jsonb("payload").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("agent_events_conversation_idx").on(t.conversationId, t.createdAt)],
);

/**
 * Trace complète d'UN tour d'agent (§5.5) — écrite même (surtout) quand le tour
 * finit bloqué, escaladé ou en erreur. C'est la pièce qui permet de répondre à
 * « pourquoi a-t-il écrit ça » : le prompt EXACT envoyé et le modèle qui a
 * VRAIMENT répondu (sur un routeur, ce n'est pas la même question que « lequel
 * ai-je demandé »).
 *
 * Contient des renseignements personnels : purgée après TRACE_RETENTION_DAYS
 * par le dispatcher, et supprimée avec le client (cascade via conversations).
 */
export const agentTurnTraces = pgTable(
  "agent_turn_traces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    messageId: uuid("message_id").references(() => messages.id, { onDelete: "set null" }),
    assistantId: uuid("assistant_id").references(() => assistants.id, { onDelete: "set null" }),
    assistantVersion: integer("assistant_version"),
    coreVersion: integer("core_version"),
    /** Les messages entrants consommés comme UN seul tour (rafale débouncée). */
    inboundBatch: jsonb("inbound_batch").notNull().default([]),
    /** Exactement ce qui a été envoyé, L0-L6. */
    systemPrompt: text("system_prompt").notNull(),
    /** L7 tel que rendu pour ce tour. */
    runtimeBlock: text("runtime_block").notNull().default(""),
    messageArray: jsonb("message_array").notNull().default([]),
    toolsOffered: jsonb("tools_offered").notNull().default([]),
    provider: text("provider").notNull(),
    modelRequested: text("model_requested").notNull(),
    /** Ce que le routeur a réellement servi — diverge du demandé sur OpenRouter. */
    modelServed: text("model_served"),
    upstreamProvider: text("upstream_provider"),
    rawResponse: jsonb("raw_response").notNull().default({}),
    toolCalls: jsonb("tool_calls").notNull().default([]),
    /** Par règle : key, severity, passed, reason. */
    guardrailResults: jsonb("guardrail_results").notNull().default([]),
    regenerations: integer("regenerations").notNull().default(0),
    /** sent | blocked | handoff | stopped | error | skipped */
    outcome: text("outcome").notNull(),
    latencyMs: integer("latency_ms"),
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    costUsd: numeric("cost_usd", { precision: 10, scale: 5 }),
    isReplay: boolean("is_replay").notNull().default(false),
    replayOf: uuid("replay_of"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("agent_turn_traces_conversation_idx").on(t.conversationId, t.createdAt),
    index("agent_turn_traces_created_idx").on(t.createdAt),
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
  assistant: one(assistants, { fields: [messages.assistantId], references: [assistants.id] }),
}));

export const assistantsRelations = relations(assistants, ({ one, many }) => ({
  compiledCore: one(promptCores, {
    fields: [assistants.compiledCoreVersion],
    references: [promptCores.version],
  }),
  createdBy: one(users, { fields: [assistants.createdById], references: [users.id] }),
  versions: many(assistantVersions),
  guardrailRules: many(guardrailRules),
  guardrailFixtures: many(guardrailFixtures),
  guardrailRuns: many(guardrailRuns),
}));

export const assistantVersionsRelations = relations(assistantVersions, ({ one }) => ({
  assistant: one(assistants, {
    fields: [assistantVersions.assistantId],
    references: [assistants.id],
  }),
}));

export const guardrailRulesRelations = relations(guardrailRules, ({ one }) => ({
  assistant: one(assistants, { fields: [guardrailRules.assistantId], references: [assistants.id] }),
}));

export const guardrailFixturesRelations = relations(guardrailFixtures, ({ one }) => ({
  assistant: one(assistants, {
    fields: [guardrailFixtures.assistantId],
    references: [assistants.id],
  }),
}));

export const agentEventsRelations = relations(agentEvents, ({ one }) => ({
  conversation: one(conversations, {
    fields: [agentEvents.conversationId],
    references: [conversations.id],
  }),
}));

export const agentTurnTracesRelations = relations(agentTurnTraces, ({ one }) => ({
  conversation: one(conversations, {
    fields: [agentTurnTraces.conversationId],
    references: [conversations.id],
  }),
  assistant: one(assistants, {
    fields: [agentTurnTraces.assistantId],
    references: [assistants.id],
  }),
}));

export const guardrailRunsRelations = relations(guardrailRuns, ({ one }) => ({
  assistant: one(assistants, { fields: [guardrailRuns.assistantId], references: [assistants.id] }),
}));
