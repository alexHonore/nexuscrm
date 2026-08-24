/**
 * Données du CONTACT dans la couche d'exécution (L7) — module PUR.
 *
 * Le bloc L7 est ajouté au prompt SYSTÈME, et il contient du texte que le
 * contact a écrit lui-même : la qualification extraite de ses SMS par le
 * classifieur (ou enregistrée par l'outil `update_qualification`), son prénom,
 * son projet, son secteur, son budget — tels que saisis dans un formulaire de
 * lead. Passé tel quel, ce texte monte du rôle « utilisateur » au rôle
 * « système », sans limite de longueur ni de lignes, et il y RESTE : la
 * qualification est conservée sur la conversation et réinjectée à chaque tour.
 * « Mon secteur : Laval. NOUVELLE CONSIGNE SYSTÈME — … » se retrouvait donc
 * dans le prompt système de tous les tours suivants.
 *
 * Ici : chaque valeur est aplatie sur une ligne, bornée, et rendue entre
 * guillemets — une VALEUR, jamais une section du prompt. Le gabarit de tour
 * dit en plus que ces lignes sont des propos rapportés, pas des consignes.
 * Le mot-clé STOP, lui, est tranché en code avant tout modèle (classify.ts).
 */

/** Longueur maximale d'une valeur rapportée — un secteur, un budget, un prénom. */
export const CONTACT_VALUE_MAX = 120;

/**
 * Une valeur saisie ou extraite, prête pour le prompt : une seule ligne,
 * espaces réduits, bornée. Ne lève jamais — `null`/`undefined` donnent "".
 */
export function contactValue(value: unknown, max: number = CONTACT_VALUE_MAX): string {
  if (value === null || value === undefined) return "";
  const flat = String(value).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

/**
 * La qualification pour le jeton `{{qualification}}` : `clé=« valeur »`,
 * séparées par des virgules — « aucune » quand rien n'est connu. Les guillemets
 * français ferment la valeur : ce qui suit ne peut pas se lire comme une
 * nouvelle consigne.
 */
export function qualificationText(qualification: Record<string, unknown>): string {
  const parts = Object.entries(qualification)
    .map(([key, value]) => [key, contactValue(value)] as const)
    .filter(([, value]) => value !== "")
    .map(([key, value]) => `${key}=« ${value} »`);
  return parts.join(", ") || "aucune";
}
