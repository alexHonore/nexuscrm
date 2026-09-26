import type { SearchMeta } from "@/lib/clients-search/types";

type Degradable = Pick<SearchMeta, "degraded">;

/**
 * Un rafraîchissement de FOND (sondage de 20 s, mutation d'un autre écran)
 * dégraderait-il ce qui est affiché ?
 *
 * Le moteur répond volontairement en recherche rapide (`degraded: "busy" |
 * "timeout"` : nom et coordonnées seulement, sans l'historique) quand le
 * limiteur est plein ou que le budget de la requête est épuisé. C'est honnête
 * pour une recherche qu'on vient de taper — l'avis le dit. Mais un sondage qui
 * tombe sur ce repli REMPLAÇAIT des résultats complets par le jeu réduit : une
 * recherche trouvée seulement dans les notes (« piscine ») se vidait, avec
 * « Rien trouvé », jusqu'au sondage suivant. Personne ne l'avait demandé.
 *
 * Vrai → la réponse est jetée, l'écran garde ses résultats complets ; le
 * prochain sondage réessaie. Un écran déjà dégradé, lui, accepte tout : une
 * réponse complète l'améliore, une autre dégradée ne lui retire rien. Seul un
 * rechargement demandé (frappe, filtre, « Réessayer ») montre un repli par-dessus
 * des résultats complets.
 */
export function refreshDegradesShown(
  shown: Degradable | null,
  incoming: Degradable | null | undefined,
): boolean {
  return Boolean(incoming?.degraded) && shown !== null && !shown.degraded;
}
