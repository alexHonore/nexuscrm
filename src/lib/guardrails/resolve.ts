import type { RuleData } from "./types";

/**
 * Résolution des règles applicables à UN assistant : les règles globales
 * (`core`) d'abord, puis celles de l'assistant.
 *
 * Un fork assistant (`overridesKey = <clé core>`) REMPLACE la règle core à sa
 * place dans l'ordre — le fork gagne pour cet assistant seulement, la règle
 * globale reste intacte pour tous les autres (§11.2.1).
 */
export function resolveRules(coreRules: RuleData[], assistantRules: RuleData[]): RuleData[] {
  const byOrder = (a: RuleData, b: RuleData) =>
    a.orderIndex - b.orderIndex || a.key.localeCompare(b.key);

  const forks = new Map<string, RuleData>();
  const own: RuleData[] = [];
  for (const rule of [...assistantRules].sort(byOrder)) {
    if (rule.overridesKey) forks.set(rule.overridesKey, rule);
    else own.push(rule);
  }

  const resolved: RuleData[] = [];
  for (const core of [...coreRules].sort(byOrder)) {
    const fork = forks.get(core.key);
    resolved.push(fork ?? core);
    forks.delete(core.key);
  }
  // Un fork dont la règle core a disparu reste appliqué : l'admin l'a écrit.
  resolved.push(...forks.values(), ...own);
  return resolved;
}

/** Règles réellement évaluées : `off` et désactivées sortent du circuit. */
export function enabledRules(rules: RuleData[]): RuleData[] {
  return rules.filter((r) => r.enabled && r.severity !== "off");
}

/** Règles qui BLOQUENT un envoi ou font échouer la suite. */
export function blockingRules(rules: RuleData[]): RuleData[] {
  return rules.filter((r) => r.enabled && r.severity === "block");
}
