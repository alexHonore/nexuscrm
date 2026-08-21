import { z } from "zod";

/**
 * Assistant configuration — the single zod source of truth shared by the DB
 * jsonb columns, the compiler, the import/export path, and (phase 5) the JSON
 * tab. Framework-agnostic: no Next.js, no db, no env.
 *
 * Every path defined here must have a ParamDoc (phase 5) — CI will enforce it.
 */

// ── Vocabulaires ─────────────────────────────────────────────────────────────

/**
 * The 7 goal types. Booking-backed types (the first three) book through the
 * internal BookingProvider (Google Calendar — operator decision D4);
 * collect_* types gather a commitment or a datum; qualify_only never asks for
 * a meeting; handoff aims straight for a human takeover (hot leads).
 */
export const GOAL_TYPES = [
  "video_meeting",
  "in_person_meeting",
  "phone_call",
  "collect_email",
  "collect_callback_time",
  "qualify_only",
  "handoff",
] as const;
export type GoalType = (typeof GOAL_TYPES)[number];

/** Qualification fields a goal may require before booking. */
export const QUALIFICATION_FIELDS = [
  "project_type",
  "timing",
  "budget",
  "sector",
  "financing",
  "current_situation",
  "email",
  "preferred_time",
] as const;
export type QualificationField = (typeof QUALIFICATION_FIELDS)[number];

/** Fields a goal type mandates — checked and locked in the editor (phase 5). */
export const TYPE_MANDATED_FIELDS: Record<GoalType, QualificationField[]> = {
  video_meeting: ["project_type"],
  in_person_meeting: ["project_type"],
  phone_call: ["project_type"],
  collect_email: ["email"],
  collect_callback_time: ["preferred_time"],
  qualify_only: [],
  handoff: [],
};

/** The 8 agent tools. Runtime handlers arrive in phase 4; the suite stubs them. */
export const ASSISTANT_TOOLS = [
  "get_slots",
  "book_meeting",
  "update_qualification",
  "schedule_followup",
  "stop",
  "handoff",
  "transfer_assistant",
  "close_conversation",
] as const;
export type AssistantTool = (typeof ASSISTANT_TOOLS)[number];

export const LAYER_IDS = ["L0", "L1", "L2", "L3", "L4", "L5", "L6"] as const;
export type LayerId = (typeof LAYER_IDS)[number];

export const PROVIDER_IDS = ["openrouter", "anthropic", "google", "openai"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

// ── Identité (L1) ────────────────────────────────────────────────────────────

export const identitySchema = z.object({
  /** team = « l'équipe de… » ; named_person exige un utilisateur réel (phase 5). */
  mode: z.enum(["team", "named_person"]).default("team"),
  orgName: z.string().trim().min(1).max(80).default("Groupe Nexus"),
  brokerName: z.string().trim().min(1).max(80).default("Alex-Honoré"),
  /** users.id when mode = named_person — remapped at import (bindings). */
  brokerUserId: z.uuid().nullable().default(null),
  signature: z.enum(["none", "first_name"]).default("none"),
  /** upfront = s'annonce IA au premier message ; on_request = si on demande. */
  aiDisclosure: z.enum(["on_request", "upfront"]).default("on_request"),
});
export type IdentityConfig = z.infer<typeof identitySchema>;

// ── Objectif (L2 + runtime) ──────────────────────────────────────────────────

export const goalStepSchema = z.object({
  type: z.enum(GOAL_TYPES),
  /** Meeting length in minutes — meaningful for booking-backed types only. */
  durationMin: z.number().int().min(5).max(240).nullable().default(null),
  /** Internal booking binding (D4): existing appointment kinds. */
  appointmentType: z.enum(["meet", "inperson"]).nullable().default(null),
  /** Broker the meeting is booked with — binding remapped at import. */
  withUserId: z.uuid().nullable().default(null),
  /** Qualification fields required before book_meeting accepts. */
  requiredFields: z.array(z.enum(QUALIFICATION_FIELDS)).default([]),
  /** Real slots offered per ask (brief: 2-3). */
  slotOfferCount: z.number().int().min(1).max(3).default(2),
  /** Confirmation copy with {{variables}} — falls back to a built-in default. */
  confirmationTemplate: z.string().max(600).nullable().default(null),
});
export type GoalStep = z.infer<typeof goalStepSchema>;

export const goalConfigSchema = z.object({
  primary: goalStepSchema,
  /**
   * Downgrade chain — one rung per SOFT refusal (§12); a hard refusal exits
   * without ever touching the chain. Rung resolution lives in lib/agent/goal.
   */
  fallbacks: z.array(goalStepSchema).max(3).default([]),
});
export type GoalConfig = z.infer<typeof goalConfigSchema>;

// ── Approche (L3) ────────────────────────────────────────────────────────────

export const approachSchema = z.object({
  /** fr-CA : vouvoiement par défaut — non négociable pour le premier contact. */
  formality: z.enum(["vous", "tu"]).default("vous"),
  /** 1 = une seule demande, 5 = insiste. Pilote aussi l'échelle de relances. */
  persistence: z.number().int().min(1).max(5).default(3),
  /** Questions de qualification avant la PREMIÈRE demande de rendez-vous. */
  questionBudget: z.number().int().min(1).max(6).default(3),
  /** Longueur maximale d'un SMS sortant (caractères). */
  maxChars: z.number().int().min(120).max(480).default(300),
  proactivity: z.number().int().min(1).max(5).default(3),
  warmth: z.number().int().min(1).max(5).default(3),
  emoji: z.enum(["none", "rare"]).default("none"),
  /** Délai humanisé avant l'envoi d'une réponse de l'agent. */
  replySpeed: z.enum(["instant", "natural", "deliberate"]).default("natural"),
  /** Budget total de messages sortants de l'agent — au-delà : handoff (§12.5). */
  maxTurns: z.number().int().min(4).max(40).default(16),
});
export type ApproachConfig = z.infer<typeof approachSchema>;

// ── Connaissances (L4) ───────────────────────────────────────────────────────

export const knowledgeSchema = z.object({
  /**
   * Allowed-claims list — the ONLY facts the assistant may state about the
   * business. Everything else is forbidden by L0 (no invented facts).
   */
  claims: z.array(z.string().trim().min(1).max(300)).max(50).default([]),
});
export type KnowledgeConfig = z.infer<typeof knowledgeSchema>;

// ── Modèle (§18.1) ───────────────────────────────────────────────────────────

const modelRefSchema = z.object({
  provider: z.enum(PROVIDER_IDS),
  model: z.string().trim().min(1),
});

export const modelConfigSchema = z.object({
  provider: z.enum(PROVIDER_IDS).default("openrouter"),
  model: z.string().trim().min(1).default("anthropic/claude-sonnet-5"),
  temperature: z.number().min(0).max(1).default(0.6),
  maxTokens: z.number().int().min(50).max(2000).default(300),
  /** Classifieur séparé — le duo classifieur-économique + générateur-fort est
   * la configuration NORMALE, pas un cas limite. */
  // Identifiant EPINGLE, pas un alias « -latest » : `google/gemini-flash-latest`
  // (valeur litterale du cahier) n'existe pas chez OpenRouter et faisait echouer
  // tous les appels classifieur et juge — donc tout bloquer.
  classifier: modelRefSchema.default({ provider: "openrouter", model: "google/gemini-2.5-flash" }),
  fallback: modelRefSchema.nullable().default({ provider: "anthropic", model: "claude-sonnet-5" }),
  /** OpenRouter uniquement — ignoré par les fournisseurs directs. Défauts non
   * négociables pour ces données (noms, numéros, projets de Québécois) :
   * deny + ZDR + pas de reroutage silencieux (§18.3). */
  routing: z
    .object({
      dataCollection: z.enum(["deny", "allow"]).default("deny"),
      zdr: z.boolean().default(true),
      allowFallbacks: z.boolean().default(false),
      only: z.array(z.string()).default([]),
    })
    .default({ dataCollection: "deny", zdr: true, allowFallbacks: false, only: [] }),
});
export type ModelConfig = z.infer<typeof modelConfigSchema>;

// ── Prompt (modes, surcouches, L7) ───────────────────────────────────────────

export const layerOverrideSchema = z.object({
  mode: z.enum(["replace", "append"]),
  text: z.string().max(8000),
});
export type LayerOverride = z.infer<typeof layerOverrideSchema>;

export const layerOverridesSchema = z.object({
  L0: layerOverrideSchema.optional(),
  L1: layerOverrideSchema.optional(),
  L2: layerOverrideSchema.optional(),
  L3: layerOverrideSchema.optional(),
  L4: layerOverrideSchema.optional(),
  L5: layerOverrideSchema.optional(),
  L6: layerOverrideSchema.optional(),
});
export type LayerOverrides = z.infer<typeof layerOverridesSchema>;

// ── Config complète ──────────────────────────────────────────────────────────

export const assistantConfigSchema = z.object({
  name: z.string().trim().min(1).max(120),
  description: z.string().trim().max(500).nullable().default(null),
  language: z.literal("fr-CA").default("fr-CA"),
  identity: identitySchema,
  goal: goalConfigSchema,
  approach: approachSchema,
  knowledge: knowledgeSchema.default({ claims: [] }),
  objectionPacks: z.array(z.string()).default([]),
  tools: z.array(z.enum(ASSISTANT_TOOLS)).default([...ASSISTANT_TOOLS]),
  model: modelConfigSchema,
  promptMode: z.enum(["composed", "raw"]).default("composed"),
  systemPromptOverride: z.string().max(40_000).nullable().default(null),
  layerOverrides: layerOverridesSchema.default({}),
  turnInstructions: z.string().max(4000).nullable().default(null),
  includeRuntimeLayer: z.boolean().default(true),
  requireSuitePass: z.boolean().default(true),
});
export type AssistantConfig = z.infer<typeof assistantConfigSchema>;

/**
 * The config as stored across the assistants row's columns — helper to
 * assemble/spread. Kept as one object so compile, export, and the JSON tab
 * all see the same shape.
 */
export function assistantRowToConfig(row: {
  name: string;
  description: string | null;
  language: string;
  identity: unknown;
  goal: unknown;
  approach: unknown;
  knowledge: unknown;
  objectionPacks: string[];
  tools: string[];
  model: unknown;
  promptMode: string;
  systemPromptOverride: string | null;
  layerOverrides: unknown;
  turnInstructions: string | null;
  includeRuntimeLayer: boolean;
  requireSuitePass: boolean;
}): AssistantConfig {
  return assistantConfigSchema.parse({
    name: row.name,
    description: row.description,
    language: row.language,
    identity: row.identity,
    goal: row.goal,
    approach: row.approach,
    knowledge: row.knowledge,
    objectionPacks: row.objectionPacks,
    tools: row.tools,
    model: row.model,
    promptMode: row.promptMode,
    systemPromptOverride: row.systemPromptOverride,
    layerOverrides: row.layerOverrides,
    turnInstructions: row.turnInstructions,
    includeRuntimeLayer: row.includeRuntimeLayer,
    requireSuitePass: row.requireSuitePass,
  });
}
