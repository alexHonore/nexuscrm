import type { ProviderId } from "./types";

/**
 * Modèle « utilitaire » par fournisseur — pour les tâches qui ne sont PAS une
 * conversation avec un client : la création assistée (extraction guidée d'un
 * brief), où un modèle économique suffit.
 *
 * Une seule table plutôt qu'un branchement sur l'ordre des fournisseurs :
 * quand seule la clé Google (ou OpenAI) est configurée, c'est un identifiant
 * de CE fournisseur qui part — pas un identifiant Claude qui ferait échouer
 * chaque tentative de « créer avec l'IA » sur un 404.
 */
export const UTILITY_MODEL_BY_PROVIDER: Record<ProviderId, string> = {
  openrouter: "google/gemini-2.5-flash",
  anthropic: "claude-sonnet-5",
  google: "gemini-2.5-flash",
  openai: "gpt-5-mini",
};
