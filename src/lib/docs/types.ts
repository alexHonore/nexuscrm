/**
 * Documentation des paramètres — contrats.
 *
 * Une seule source de vérité (`./params`) alimente l'aide en ligne à côté de
 * chaque champ, la page de référence, l'onglet JSON et les messages d'erreur
 * d'import. Écrire le texte dans un composant le condamnerait à diverger du
 * schéma en un mois ; ici, un test échoue quand un paramètre n'est pas documenté.
 *
 * Module pur : ni Next, ni base, ni environnement.
 */

export const DOC_SECTIONS = [
  "identity",
  "goal",
  "approach",
  "knowledge",
  "objections",
  "tools",
  "guardrails",
  "model",
  "prompt",
  "campaign",
] as const;
export type DocSection = (typeof DOC_SECTIONS)[number];

export const DOC_TYPES = ["enum", "string", "int", "bool", "object", "array", "text"] as const;
export type DocType = (typeof DOC_TYPES)[number];

export interface AllowedValue {
  value: unknown;
  labelFr: string;
}

export interface ParamDoc {
  /** Chemin exact dans la config : « approach.persistence », « goal.primary.type ». */
  path: string;
  section: DocSection;
  labelFr: string;
  type: DocType;
  required: boolean;
  defaultValue?: unknown;
  /** Valeurs permises (enum) ou bornes numériques, chacune avec son libellé. */
  allowed?: AllowedValue[];
  /** Ce que le paramètre fait. */
  whatFr: string;
  /** Pourquoi il existe — quel problème il règle. */
  whyFr: string;
  /** Ce qu'il change concrètement dans le prompt compilé ou à l'exécution. */
  effectFr?: string;
  /** Ce qui va mal quand il est mal réglé, et à quoi ça ressemble du dehors. */
  pitfallsFr?: string;
  related: string[];
  example?: unknown;
  orderIndex: number;
}

// ── Langues ──────────────────────────────────────────────────────────────────

/**
 * Le registre est écrit en français ; l'anglais vit dans un fichier frère
 * (`./params.en`), exactement comme `messages/<locale>/<ns>.json`.
 *
 * Pourquoi pas des champs `labelEn` à côté de `labelFr` : la fiche française
 * fait déjà mille lignes, et une traduction insérée entre chaque champ rend
 * illisible la seule chose qui compte quand on relit le registre — ce que le
 * paramètre FAIT. Un test refuse une fiche sans traduction ; c'est la même
 * discipline que pour les messages d'interface.
 */
export type DocLocale = "fr" | "en";

/**
 * La locale de la requête, ramenée aux deux langues du registre.
 *
 * `getLocale()` et `useLocale()` rendent une chaîne : sans ce passage, une
 * locale inattendue choisirait l'anglais par accident. Le français est la
 * source, donc le repli. Elle vit ICI, dans le module de types — sans aucune
 * dépendance — pour qu'un composant client puisse l'appeler sans tirer les six
 * cents lignes du registre anglais dans son paquet.
 */
export function docLocale(locale: string): DocLocale {
  return locale === "en" ? "en" : "fr";
}

/** Le texte d'une fiche dans UNE langue, sans suffixe. */
export interface ParamDocText {
  label: string;
  what: string;
  why: string;
  effect?: string;
  pitfalls?: string;
  /** Libellés des valeurs permises, indexés par `String(value)`. */
  allowed?: Record<string, string>;
}

/** Une fiche prête à afficher : la langue est déjà tranchée. */
export interface ResolvedParamDoc {
  path: string;
  section: DocSection;
  type: DocType;
  required: boolean;
  defaultValue?: unknown;
  allowed?: { value: unknown; label: string }[];
  label: string;
  what: string;
  why: string;
  effect?: string;
  pitfalls?: string;
  related: string[];
  example?: unknown;
  orderIndex: number;
  /** Vrai quand le texte vient d'une réécriture en base (français seulement). */
  overridden?: boolean;
}
