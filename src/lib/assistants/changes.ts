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

/**
 * Chemins dont l'effet passe par le prompt compilé (L0-L6). La liste suit
 * lib/agent/compile.ts ligne à ligne : tout ce que le compilateur RÉDIGE est
 * ici, même si l'exécution relit aussi la valeur.
 */
const PROMPT_PREFIXES = [
  "identity",
  "knowledge",
  "objectionPacks",
  "systemPromptOverride",
  "promptMode",
  "layerOverrides",
  "description",
  // L3 entier : ton, persistance, budget de questions, longueur. La
  // persistance et la longueur ne sont PAS relues à l'exécution — seul le
  // prompt les porte. Les classer « immédiates » faisait croire qu'une
  // persistance baissée s'appliquait au message suivant alors que le prompt
  // d'hier continuait d'insister.
  "approach.formality",
  "approach.warmth",
  "approach.proactivity",
  "approach.emoji",
  "approach.questionBudget",
  "approach.persistence",
  "approach.maxChars",
  // L2 : type d'objectif, durée, champs requis, chaîne de replis.
  "goal",
];

/**
 * Chemins relus à CHAQUE tour, et SEULEMENT relus : un changement ici
 * s'applique au message suivant sans qu'aucune ligne du prompt ne mente.
 */
const RUNTIME_ONLY_PREFIXES = [
  "tools",
  "model",
  "turnInstructions",
  "includeRuntimeLayer",
  "requireSuitePass",
  "approach.maxTurns",
  "approach.replySpeed",
];

/**
 * Chemins relus à CHAQUE tour — effet immédiat, même sans recompilation.
 * « goal » y figure AUSSI : le cran courant, les créneaux et les champs
 * requis viennent de la config à chaque tour. Mais L2 en parle : il est donc
 * à la fois immédiat (exécution) et en attente (texte du prompt).
 */
const RUNTIME_LIVE_PREFIXES = [...RUNTIME_ONLY_PREFIXES, "goal"];

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
    if (matches(path, PROMPT_PREFIXES)) pending.push(path);
    // Un chemin qui ne tombe dans aucune liste (« name », « language ») ne
    // change ni l'un ni l'autre : il n'apparaît que dans `changed`.
  }

  return {
    changed,
    immediate,
    pending,
    // Prudence délibérée : tout ce qui n'est pas STRICTEMENT relu à
    // l'exécution peut avoir été rédigé dans le prompt. Recompiler pour rien
    // coûte quelques secondes ; ne pas recompiler laisse un prompt qui ment —
    // et la porte d'activation laisserait passer ce prompt, faute de drapeau.
    needsRecompile: changed.some((p) => !matches(p, RUNTIME_ONLY_PREFIXES)),
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
