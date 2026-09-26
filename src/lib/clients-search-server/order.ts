import "server-only";
import { clients } from "@/db/schema";

/**
 * Les TRIS de la liste des fiches — une seule liste blanche, lue par la route
 * (`/api/clients/list`, chemin sans recherche) et par le statement de
 * recherche. Sortie de `route.ts` : un fichier de route n'a le droit
 * d'exporter que ses handlers.
 *
 * `activity` (le défaut) reproduit l'ordre historique du panneau ; `relevance`
 * n'existe qu'avec une recherche — sans terme, il retombe sur `activity`.
 */
export const SORT_COLUMNS = {
  name: clients.fullName,
  city: clients.city,
  createdAt: clients.createdAt,
  updatedAt: clients.updatedAt,
  followupAt: clients.nextFollowupAt,
  lastContact: clients.lastContactedAt,
} as const;

/** Un tri par colonne (en-têtes du tableau). */
export type ListSortKey = keyof typeof SORT_COLUMNS;

/** Tout ce que `sort=` peut demander. */
export type ListSort = ListSortKey | "activity" | "relevance";

export type SortDir = "asc" | "desc";

/**
 * La colonne de la CTE `vis` (statement de recherche) qui porte chaque tri —
 * des constantes SQL, jamais un texte reçu du client.
 */
export const SORT_ALIASES: Readonly<Record<ListSortKey, string>> = {
  name: "s_name",
  city: "s_city",
  createdAt: "s_created",
  updatedAt: "s_updated",
  followupAt: "s_followup",
  lastContact: "s_lastcontact",
};

export function isListSortKey(v: string): v is ListSortKey {
  return Object.hasOwn(SORT_COLUMNS, v);
}

/**
 * `sort=` tel que reçu → le tri appliqué. Inconnu → `activity` ; `relevance`
 * n'est gardé que si la requête a un terme à chercher (l'appelant le sait).
 */
export function parseListSort(raw: string | null, hasTerms: boolean): ListSort {
  if (raw === "relevance") return hasTerms ? "relevance" : "activity";
  return raw && isListSortKey(raw) ? raw : "activity";
}
