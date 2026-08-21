import type { AssistantConfig } from "./schema";

/**
 * Ce qu'une sauvegarde change VRAIMENT, et quand.
 *
 * Le moteur relit la configuration à chaque tour pour les outils, le modèle,
 * les champs requis et les budgets ; mais le texte du prompt, lui, vient de
 * `compiled_prompt`, figé à la dernière compilation. Sauvegarder un assistant
 * ACTIF a donc deux effets de vitesses différentes : certains réglages
 * s'appliquent au message suivant, d'autres attendent une recompilation.
 *
 * Laisser ça implicite serait le pire des deux mondes : l'administrateur baisse
 * la persistance, voit la fiche enregistrée, et l'assistant continue d'insister
 * parce que c'est le prompt d'hier qui parle. On calcule donc la liste des
 * chemins modifiés et on dit lesquels attendent quoi.
 */

/** Chemins dont l'effet passe UNIQUEMENT par le prompt compilé (L0-L6). */
const PROMPT_ONLY_PREFIXES = [
  "identity",
  "knowledge",
  "objectionPacks",
  "systemPromptOverride",
  "promptMode",
  "layerOverrides",
  "description",
  // Le ton : rédigé dans L3, jamais relu à l'exécution.
  "approach.formality",
  "approach.warmth",
  "approach.proactivity",
  "approach.emoji",
  "approach.questionBudget",
];

/**
 * Chemins relus à CHAQUE tour — effet immédiat, même sans recompilation.
 * (Le prompt les mentionne aussi ; c'est l'exécution qui tranche.)
 */
const RUNTIME_LIVE_PREFIXES = [
  "tools",
  "model",
  "turnInstructions",
  "includeRuntimeLayer",
  "requireSuitePass",
  "approach.maxTurns",
  "approach.maxChars",
  "approach.replySpeed",
  "approach.persistence",
  "goal",
];

export interface ChangeSummary {
  /** Chemins modifiés, à plat. */
  changed: string[];
  /** Modifications qui s'appliquent dès le prochain message. */
  immediate: string[];
  /** Modifications qui attendent une recompilation. */
  pending: string[];
  /** Vrai dès qu'un chemin touche le prompt : le drapeau de recompilation. */
  needsRecompile: boolean;
}

export function diffConfig(before: AssistantConfig, after: AssistantConfig): ChangeSummary {
  const changed = [...collect(before, after, "")].sort();
  const immediate: string[] = [];
  const pending: string[] = [];

  for (const path of changed) {
    if (matches(path, RUNTIME_LIVE_PREFIXES)) immediate.push(path);
    if (matches(path, PROMPT_ONLY_PREFIXES)) pending.push(path);
    // Un chemin qui ne tombe dans aucune liste (« name », « language ») ne
    // change ni l'un ni l'autre : il n'apparaît que dans `changed`.
  }

  return {
    changed,
    immediate,
    pending,
    // Prudence délibérée : tout ce qui n'est pas strictement relu à l'exécution
    // peut avoir été rédigé dans le prompt. Recompiler pour rien coûte quelques
    // secondes ; ne pas recompiler laisse un prompt qui ment.
    needsRecompile: changed.some((p) => !matches(p, RUNTIME_LIVE_PREFIXES)),
  };
}

function matches(path: string, prefixes: string[]): boolean {
  return prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}.`) || path.startsWith(`${prefix}[`));
}

function* collect(before: unknown, after: unknown, prefix: string): Generator<string> {
  if (before === after) return;

  const bothObjects =
    before !== null &&
    after !== null &&
    typeof before === "object" &&
    typeof after === "object" &&
    Array.isArray(before) === Array.isArray(after);

  if (!bothObjects) {
    if (JSON.stringify(before) !== JSON.stringify(after)) yield prefix || "(racine)";
    return;
  }

  if (Array.isArray(before) && Array.isArray(after)) {
    // Un tableau est comparé en bloc : réordonner les replis ou les outils est
    // un changement, et détailler « [2] » n'apprendrait rien de plus.
    if (JSON.stringify(before) !== JSON.stringify(after)) yield prefix || "(racine)";
    return;
  }

  const b = before as Record<string, unknown>;
  const a = after as Record<string, unknown>;
  for (const key of new Set([...Object.keys(b), ...Object.keys(a)])) {
    yield* collect(b[key], a[key], prefix ? `${prefix}.${key}` : key);
  }
}
