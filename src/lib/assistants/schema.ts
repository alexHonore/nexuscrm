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

/**
 * Fields a goal type mandates. Enforced by `goalStepSchema` (the list is
 * completed at parse time — API, import, JSON tab and editor all go through
 * it) and shown checked + locked in the editor. Without this, a
 * « collect_email » assistant could be saved with no required field at all and
 * would book before ever asking for the e-mail it exists to collect.
 */
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
  /**
   * Ranger la fiche dans une catégorie du pipeline.
   *
   * L'assistant apprend en deux messages ce qu'un téléphoniste met un appel à
   * découvrir — « je veux acheter, mais l'an prochain », « je suis au
   * Saguenay ». Sans cet outil, l'information restait dans le fil et la fiche
   * dormait dans « Non contacté » jusqu'à ce que quelqu'un la relise.
   *
   * Les catégories qu'il a le droit de poser sont celles que nomment les
   * règles de classement — voir `classificationSettingsSchema`.
   */
  "set_category",
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

/**
 * Les langues dans lesquelles un assistant peut écrire.
 *
 * Étiquettes régionales et non « fr » / « en » : ce qu'on demande au modèle,
 * c'est le français QUÉBÉCOIS (« bonjour », « à quelle heure ça vous
 * convient ») et non le français de France, et l'anglais canadien plutôt que
 * l'américain. La différence s'entend dès la première phrase d'un SMS.
 */
export const ASSISTANT_LANGUAGES = ["fr-CA", "en-CA"] as const;
export type AssistantLanguage = (typeof ASSISTANT_LANGUAGES)[number];

// ── Identité (L1) ────────────────────────────────────────────────────────────

export const identitySchema = z.object({
  /** team = « l'équipe de… » ; named_person exige un utilisateur réel (phase 5). */
  mode: z.enum(["team", "named_person"]).default("team"),
  orgName: z.string().trim().min(1).max(80).default("Groupe Nexus"),
  brokerName: z.string().trim().min(1).max(80).default("Alex-Honoré"),
  /** users.id when mode = named_person — remapped at import (bindings). */
  brokerUserId: z.uuid().nullable().default(null),
  /**
   * Comment l'assistant signe. « custom » utilise `signatureText` : une équipe
   * qui signe « — L'équipe Nexus » n'entre dans aucune des formes dérivées.
   */
  signature: z.enum(["none", "first_name", "full_name", "org", "custom"]).default("none"),
  /** Signature libre — n'a d'effet qu'avec `signature: "custom"`. */
  signatureText: z.string().trim().max(60).nullable().default(null),
  /** upfront = s'annonce IA au premier message ; on_request = si on demande. */
  aiDisclosure: z.enum(["on_request", "upfront"]).default("on_request"),
});
export type IdentityConfig = z.infer<typeof identitySchema>;

// ── Objectif (L2 + runtime) ──────────────────────────────────────────────────

/** Goal types that actually book something in the calendar. */
export const BOOKING_GOAL_TYPES: readonly GoalType[] = [
  "video_meeting",
  "in_person_meeting",
  "phone_call",
];

/**
 * Type de rendez-vous CRM qu'un cran de réservation utilise quand rien n'est
 * précisé : la visio et l'appel passent par « meet », la rencontre en personne
 * par « inperson ». Un cran de réservation SANS type de rendez-vous est un
 * cran que les outils d'agenda refusent de servir — le prompt promet alors un
 * appel que personne ne peut réserver.
 */
export function defaultAppointmentTypeFor(type: GoalType): "meet" | "inperson" | null {
  if (type === "in_person_meeting") return "inperson";
  if (type === "video_meeting" || type === "phone_call") return "meet";
  return null;
}

/**
 * Champs requis complétés des champs que le type impose (ordre conservé).
 *
 * `string[]` et non `QualificationField[]` : la liste accepte des exigences
 * libres (« nombre de chambres »). Les clés imposées par le type restent, elles,
 * prises dans le vocabulaire connu.
 */
export function withMandatedFields(
  type: GoalType,
  fields: readonly string[],
): string[] {
  const out: string[] = [...fields];
  for (const field of TYPE_MANDATED_FIELDS[type]) if (!out.includes(field)) out.push(field);
  return out;
}

export const goalStepSchema = z
  .object({
    type: z.enum(GOAL_TYPES),
    /** Meeting length in minutes — meaningful for booking-backed types only. */
    durationMin: z.number().int().min(5).max(240).nullable().default(null),
    /** Internal booking binding (D4): existing appointment kinds. */
    appointmentType: z.enum(["meet", "inperson"]).nullable().default(null),
    /** Broker the meeting is booked with — binding remapped at import. */
    withUserId: z.uuid().nullable().default(null),
    /**
     * Ce qu'il faut avoir recueilli avant que `book_meeting` accepte.
     *
     * Des chaînes LIBRES, pas une énumération fermée : les huit clés connues
     * (`QUALIFICATION_FIELDS`) ont un libellé traduit et des cases à cocher,
     * mais un courtier a le droit d'exiger « nombre de chambres » ou « budget
     * de rénovation » sans qu'on ait prévu la clé. Une valeur inconnue est
     * rendue telle quelle dans le prompt — c'est la personne qui l'a écrite
     * qui sait ce qu'elle veut dire.
     */
    requiredFields: z.array(z.string().trim().min(1).max(80)).default([]),
    /** Real slots offered per ask (brief: 2-3). */
    slotOfferCount: z.number().int().min(1).max(3).default(2),
    /** Confirmation copy with {{variables}} — falls back to a built-in default. */
    confirmationTemplate: z.string().max(600).nullable().default(null),
    /**
     * Comment DIRE ce cran, en toutes lettres.
     *
     * L'objectif dit ce qu'on cherche à obtenir ; il ne dit pas comment le
     * demander. « Propose l'appel comme un dépannage de quinze minutes, pas
     * comme une rencontre » est le genre de consigne qui change tout et qui
     * n'entrait dans aucun réglage — il fallait réécrire une couche entière
     * du prompt pour l'exprimer.
     */
    instruction: z.string().trim().max(400).nullable().default(null),
  })
  // Normalisation à la frontière, PAS un rejet : des configurations déjà en
  // base (et des tests) décrivent un appel sans type de rendez-vous ou un
  // objectif « courriel » sans le champ courriel. Les refuser rendrait ces
  // fiches illisibles ; les compléter rend chaque chemin (éditeur, import,
  // créateur, onglet JSON) d'accord sur ce que le moteur exécute. `.overwrite`
  // garde le schéma introspectable (la doc des paramètres le parcourt).
  .overwrite((step) => ({
    ...step,
    appointmentType:
      step.appointmentType ??
      (BOOKING_GOAL_TYPES.includes(step.type) ? defaultAppointmentTypeFor(step.type) : null),
    requiredFields: withMandatedFields(step.type, step.requiredFields),
  }));
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
  /**
   * Le nombre TOTAL de questions de qualification que l'assistant a le droit
   * de poser — pas « avant la première demande », comme c'était le cas.
   *
   * L'ancienne lecture laissait l'assistant reprendre son interrogatoire après
   * un premier refus : le budget était consommé, puis repartait de zéro. Le
   * plafond est maintenant absolu — au-delà, il propose avec ce qu'il a.
   */
  questionBudget: z.number().int().min(1).max(10).default(3),
  /** Longueur maximale d'un SMS sortant (caractères). */
  maxChars: z.number().int().min(120).max(480).default(300),
  proactivity: z.number().int().min(1).max(5).default(3),
  warmth: z.number().int().min(1).max(5).default(3),
  emoji: z.enum(["none", "rare", "moderate", "lots"]).default("none"),
  /** Délai humanisé avant l'envoi d'une réponse de l'agent. */
  replySpeed: z.enum(["instant", "natural", "deliberate"]).default("natural"),
  /** Budget total de messages sortants de l'agent — au-delà : handoff (§12.5). */
  maxTurns: z.number().int().min(4).max(40).default(16),
});
export type ApproachConfig = z.infer<typeof approachSchema>;

// ── Connaissances et consignes (L4) ──────────────────────────────────────────

export const knowledgeSchema = z.object({
  /**
   * Ce que l'assistant SAIT et ce qu'il DOIT FAIRE — une liste ordonnée.
   *
   * Une entrée énonce un fait d'affaires que l'assistant a le droit
   * d'affirmer (tout ce qui n'y figure pas est interdit par L0 : pas
   * d'invention), OU décrit une conduite à tenir (« si la personne demande le
   * prix, réponds que c'est Alex qui en parle »). L'ordre compte : en cas de
   * contradiction, la première entrée l'emporte (rendu tel quel en L4).
   *
   * Le champ garde le nom `claims` : c'est la clé déjà écrite dans la colonne
   * jsonb `knowledge` de toutes les fiches en base, la renommer les rendrait
   * illisibles. 600 caractères parce qu'une consigne conditionnelle (« si…,
   * alors… , sauf si… ») ne tient pas dans la longueur d'un fait.
   */
  claims: z.array(z.string().trim().min(1).max(600)).max(50).default([]),
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
  /**
   * Niveau de réflexion, quand le modèle le gère. « none » = on ne l'envoie
   * pas du tout — le transmettre à un modèle qui l'ignore fait rejeter la
   * requête entière.
   */
  reasoningEffort: z.enum(["none", "low", "medium", "high"]).default("none"),
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
  /** Langue de rédaction — celle de TOUS les messages sortants. */
  language: z.enum(ASSISTANT_LANGUAGES).default("fr-CA"),
  /**
   * Seconde langue, facultative : l'assistant y BASCULE si la personne y
   * écrit, sans jamais ouvrir avec. `null` = une seule langue, et une réponse
   * dans une autre langue reste dans la principale.
   */
  secondaryLanguage: z.enum(ASSISTANT_LANGUAGES).nullable().default(null),
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
 * Schéma d'ENTRÉE (création, sauvegarde) : identique à la forme stockée, plus
 * les refus qui ne valent que pour ce qui ARRIVE. Un prompt libre vide est
 * refusé ici plutôt qu'à la compilation — l'administrateur voit le champ en
 * cause au moment où il enregistre. La lecture d'une rangée existante reste
 * sur `assistantConfigSchema` : une refonte de règle ne doit jamais rendre une
 * fiche déjà en base impossible à ouvrir.
 */
export const assistantConfigInputSchema = assistantConfigSchema.superRefine((config, ctx) => {
  if (config.secondaryLanguage !== null && config.secondaryLanguage === config.language) {
    ctx.addIssue({
      code: "custom",
      path: ["secondaryLanguage"],
      message:
        "La seconde langue doit différer de la principale — sinon le réglage n'a aucun effet.",
    });
  }
  if (config.promptMode === "raw" && (config.systemPromptOverride ?? "").trim() === "") {
    ctx.addIssue({
      code: "custom",
      path: ["systemPromptOverride"],
      message:
        "Le mode libre exige un prompt : sans texte, l'assistant n'aurait aucune instruction.",
    });
  }
});

/**
 * The config as stored across the assistants row's columns — helper to
 * assemble/spread. Kept as one object so compile, export, and the JSON tab
 * all see the same shape.
 */
export function assistantRowToConfig(row: {
  name: string;
  description: string | null;
  language: string;
  secondaryLanguage: string | null;
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
    secondaryLanguage: row.secondaryLanguage,
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
