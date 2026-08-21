import type { FinishReason, ReasoningEffort } from "./types";

/**
 * Réflexion : budget par niveau d'effort, et marge sur le plafond de sortie.
 *
 * Quatre dialectes pour une même intention : OpenRouter (`reasoning.effort`),
 * Anthropic (`output_config.effort` sur les modèles récents, `budget_tokens`
 * sur les anciens), Google (`thinkingConfig.thinkingBudget`), OpenAI
 * (`reasoning_effort`). Quand le dialecte veut un nombre de jetons, il sort
 * d'ici — une seule table, donc un seul endroit à retoucher.
 *
 * Le budget sert AUSSI de marge ajoutée au plafond de sortie : chez tous ces
 * fournisseurs, la réflexion se paie sur le même compteur que le texte. Un
 * plafond de 300 jetons — juste ce qu'il faut pour un SMS — serait consommé
 * avant le premier mot, et le modèle rendrait une réponse vide ou coupée.
 * `maxTokens` reste donc « le texte », et la réflexion s'y ajoute.
 */
export const REASONING_BUDGET_TOKENS: Record<ReasoningEffort, number> = {
  // 1024 est le minimum accepté par Anthropic pour `budget_tokens`.
  low: 1024,
  medium: 4096,
  high: 16384,
};

/** Budget de réflexion demandé, ou 0 si aucun effort n'est demandé. */
export function reasoningBudgetTokens(effort: ReasoningEffort | undefined): number {
  return effort === undefined ? 0 : REASONING_BUDGET_TOKENS[effort];
}

/**
 * Complète un résultat avec le motif d'arrêt normalisé. `truncated` n'est posé
 * que lorsqu'on SAIT que le plafond a coupé : un fournisseur muet ne doit pas
 * faire passer une réponse pour tronquée, ni pour complète.
 */
export function finishFields(reason: FinishReason | undefined): {
  finishReason?: FinishReason;
  truncated?: boolean;
} {
  return reason === undefined ? {} : { finishReason: reason, truncated: reason === "length" };
}
