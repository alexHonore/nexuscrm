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
