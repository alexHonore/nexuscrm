import type { NoResultSuggestion } from "@/lib/clients-search/palette";
import type { SearchMeta } from "@/lib/clients-search/types";

/**
 * Palette ⌘K — ce que font Entrée et la sélection d'office, en fonctions PURES
 * (la palette les appelle, les tests les vérifient sans navigateur).
 *
 * UNE règle pour tous les écrans : **Entrée n'ouvre jamais une fiche que la
 * personne n'a pas vue.**
 *
 * - Une ligne choisie aux flèches s'ouvre TOUT DE SUITE, même grisée pendant
 *   qu'un nouveau terme charge : c'est elle qu'on a vue et visée, et un clic
 *   sur la même ligne l'ouvre aussi — clavier et souris disent la même chose.
 *   « Voir tous les résultats » de même : son adresse ne dépend que du terme.
 * - Au toucher, sans flèches, Entrée RANGE le clavier et n'ouvre rien : la
 *   touche « Rechercher » du clavier virtuel envoie Entrée, et on la touche
 *   pour VOIR la liste. On touche ensuite la bonne fiche.
 * - Au clavier, sans flèches : si les résultats de CE terme sont à l'écran, la
 *   ligne sélectionnée (le meilleur résultat, choisi d'office) s'ouvre. S'ils
 *   ne le sont pas encore, l'Entrée est retenu pour CE terme et, à l'arrivée,
 *   n'ouvre qu'une fiche qui ne laisse RIEN à deviner : l'unique résultat,
 *   exact. Sinon la liste s'affiche, meilleur résultat sélectionné — un second
 *   Entrée l'ouvre.
 *
 * Avant : « tremblay » sur un cellulaire, puis « Rechercher » pour voir la
 * liste — la palette sautait dans le premier des 57 Tremblay avant d'en avoir
 * montré un seul ; et un Entrée sur une ligne choisie aux flèches pendant un
 * chargement ouvrait le premier résultat arrivé ensuite, pas cette ligne.
 */

/** Valeurs cmdk des lignes que la palette sélectionne elle-même. */
export const ALL_RECORDS = "all-records";
export const RETRY = "retry";
export const clientValue = (id: string) => `client-${id}`;
export const suggestionValue = (index: number) => `suggest-${index}`;

/** Une proposition qu'on peut choisir (les deux aides, elles, sont du texte fixe). */
export type SelectableSuggestion = Exclude<NoResultSuggestion, { kind: "contactHint" | "shortHint" }>;

export function isSelectableSuggestion(suggestion: NoResultSuggestion): suggestion is SelectableSuggestion {
  return suggestion.kind !== "contactHint" && suggestion.kind !== "shortHint";
}

/**
 * - `select` : laisser cmdk ouvrir la ligne sélectionnée ;
 * - `dismiss` : ranger le clavier virtuel, rien d'autre ;
 * - `wait` : retenir l'Entrée pour le terme en cours (voir `pendingOpenTarget`).
 */
export type PaletteEnterAction = "select" | "dismiss" | "wait";

export function paletteEnterAction({
  moved,
  touch,
  awaiting,
}: {
  /** ↑ ↓ (ou Début / Fin) utilisés depuis la dernière frappe : la sélection est un CHOIX. */
  moved: boolean;
  /** Pointeur grossier — un doigt, pas une souris (`(pointer: coarse)`). */
  touch: boolean;
  /** Un terme cherchable dont la réponse n'est pas encore arrivée. */
  awaiting: boolean;
}): PaletteEnterAction {
  if (moved) return "select";
  if (touch) return "dismiss";
  return awaiting ? "wait" : "select";
}

/**
 * À l'arrivée d'une réponse qu'un Entrée attendait : la fiche à ouvrir, ou
 * `null` — on montre la liste. Seule l'UNIQUE fiche trouvée, et trouvée pour
 * de bon, s'ouvre sans avoir été vue : un numéro tapé puis Entrée mène à sa
 * fiche. Une correspondance approchée (faute de frappe) ou une recherche
 * rapide (historique non parcouru) n'est pas une certitude ; zéro résultat ou
 * un échec non plus — la palette les montre, avec leurs propositions.
 */
export function pendingOpenTarget<T>(result: {
  failed: boolean;
  total: number;
  items: readonly T[];
  search: Pick<SearchMeta, "approximate" | "degraded"> | null;
}): T | null {
  if (result.failed || result.total !== 1 || result.items.length !== 1) return null;
  if (result.search?.approximate || result.search?.degraded) return null;
  return result.items[0];
}

/**
 * La ligne sélectionnée d'office quand une réponse arrive : TOUJOURS la
 * première ligne sélectionnable, dans l'ordre d'affichage — « Réessayer »
 * après un échec, sinon la meilleure fiche, sinon la première proposition,
 * sinon « Voir tous les résultats ».
 *
 * Pourquoi la première : quand la ligne sélectionnée disparaît (les fiches
 * du terme précédent, « Réessayer »), cmdk se rabat de lui-même sur la
 * première ligne, APRÈS notre choix. En visant la même, le résultat ne dépend
 * plus de ce qui était à l'écran juste avant — un « rien trouvé » ne
 * sélectionnait pas la même ligne selon qu'une fiche l'avait précédé ou non.
 */
export function autoSelection(
  result: { failed: boolean; items: readonly { id: string }[] },
  suggestions: readonly NoResultSuggestion[],
): string {
  if (result.failed) return RETRY;
  const top = result.items[0];
  if (top) return clientValue(top.id);
  const first = suggestions.findIndex(isSelectableSuggestion);
  return first >= 0 ? suggestionValue(first) : ALL_RECORDS;
}
