import { z } from "zod";

/**
 * Guardrail contracts — framework-agnostic (no Next.js, no db, no env).
 *
 * Design rule from the mission brief: every rule and fixture is a DATABASE ROW
 * an admin can edit, disable or delete. Nothing here re-imposes a rule the
 * admin turned off — a disabled rule is simply never evaluated, and if every
 * rule is off the engine returns no verdicts at all. That is the intended
 * behaviour of the switch, not a bug.
 */

export const GUARDRAIL_KINDS = [
  "forbidden_regex",
  "forbidden_terms",
  "max_chars",
  "max_questions",
  "link_policy",
  "required_tool_on_intent",
  "llm_judge",
  "custom_instruction",
] as const;
export type GuardrailKind = (typeof GUARDRAIL_KINDS)[number];

export const GUARDRAIL_SEVERITIES = ["block", "warn", "off"] as const;
export type GuardrailSeverity = (typeof GUARDRAIL_SEVERITIES)[number];

// ── Configs typées par `kind` ────────────────────────────────────────────────

const compilableRegex = z.string().min(1).superRefine((pattern, ctx) => {
  try {
    new RegExp(pattern);
  } catch {
    ctx.addIssue({ code: "custom", message: `regex invalide : ${pattern}` });
  }
});

export const forbiddenRegexConfigSchema = z.object({
  patterns: z.array(compilableRegex).min(1),
  flags: z.string().default("iu"),
});
export const forbiddenTermsConfigSchema = z.object({
  terms: z.array(z.string().trim().min(1)).min(1),
});
export const maxCharsConfigSchema = z.object({ max: z.number().int().positive() });
export const maxQuestionsConfigSchema = z.object({ max: z.number().int().min(0) });
export const linkPolicyConfigSchema = z.object({
  /** Domaines autorisés (suffixe) — liste vide = AUCUN lien permis. */
  allowedDomains: z.array(z.string().trim().min(1)).default([]),
});
export const requiredToolOnIntentConfigSchema = z.object({
  intent: z.string().trim().min(1),
  tool: z.string().trim().min(1),
});
export const llmJudgeConfigSchema = z.object({ criterion: z.string().trim().min(1) });
export const customInstructionConfigSchema = z.object({}).loose();

const CONFIG_SCHEMAS = {
  forbidden_regex: forbiddenRegexConfigSchema,
  forbidden_terms: forbiddenTermsConfigSchema,
  max_chars: maxCharsConfigSchema,
  max_questions: maxQuestionsConfigSchema,
  link_policy: linkPolicyConfigSchema,
  required_tool_on_intent: requiredToolOnIntentConfigSchema,
  llm_judge: llmJudgeConfigSchema,
  custom_instruction: customInstructionConfigSchema,
} as const;

export type RuleConfigFor<K extends GuardrailKind> = z.infer<(typeof CONFIG_SCHEMAS)[K]>;

/** Parse (et valide) la config d'une règle selon son `kind`. Lève si invalide. */
export function parseRuleConfig<K extends GuardrailKind>(kind: K, config: unknown): RuleConfigFor<K> {
  return CONFIG_SCHEMAS[kind].parse(config) as RuleConfigFor<K>;
}

/** Variante sûre — pour l'UI et les imports, qui doivent afficher l'erreur. */
export function safeParseRuleConfig(kind: GuardrailKind, config: unknown) {
  return CONFIG_SCHEMAS[kind].safeParse(config);
}

// ── Règles ───────────────────────────────────────────────────────────────────

export interface RuleData {
  id?: string;
  scope: "core" | "assistant";
  assistantId?: string | null;
  key: string;
  label: string;
  description?: string | null;
  kind: GuardrailKind;
  config: unknown;
  /** Texte injecté en L6 du prompt compilé — null = règle purement runtime. */
  promptText: string | null;
  severity: GuardrailSeverity;
  enabled: boolean;
  /** Fork assistant d'une règle core portant cette clé. */
  overridesKey?: string | null;
  orderIndex: number;
}

export interface RuleVerdict {
  key: string;
  label: string;
  severity: GuardrailSeverity;
  passed: boolean;
  /** Jamais le brouillon lui-même : renseignements personnels. */
  reason?: string;
}

// ── Fixtures (§11.3) ─────────────────────────────────────────────────────────

export const fixtureSetupSchema = z.object({
  /** Historique : [["out","Bonjour…"],["in","Oui allo"]] */
  priorTurns: z.array(z.tuple([z.enum(["out", "in"]), z.string()])).default([]),
  qualification: z.record(z.string(), z.unknown()).default({}),
  rung: z.string().default("primary"),
  turnsUsed: z.number().int().min(0).default(0),
});
export type FixtureSetup = z.infer<typeof fixtureSetupSchema>;

export const fixtureExpectationsSchema = z.object({
  mustCallTool: z.array(z.string()).default([]),
  mustNotCallTool: z.array(z.string()).default([]),
  mustMatch: z.array(compilableRegex).default([]),
  mustNotMatch: z.array(compilableRegex).default([]),
  /** Critère évalué par le modèle classifieur, en français. */
  judge: z.string().nullable().default(null),
  maxChars: z.number().int().positive().nullable().default(null),
});
export type FixtureExpectations = z.infer<typeof fixtureExpectationsSchema>;

export interface FixtureData {
  id?: string;
  scope: "core" | "assistant";
  assistantId?: string | null;
  key?: string;
  label: string;
  setup: FixtureSetup;
  inbound: string;
  expectations: FixtureExpectations;
  severity: GuardrailSeverity;
  enabled: boolean;
  orderIndex: number;
}

/** Résultat d'une fixture dans une exécution de suite. */
export interface FixtureResult {
  fixtureId: string | null;
  label: string;
  severity: GuardrailSeverity;
  passed: boolean;
  reason: string | null;
  /** Sortie du modèle — affichée à l'admin en cas d'échec (§16.2 onglet Test). */
  output: string;
  toolsCalled: string[];
}
