/**
 * Plier un texte pour la recherche : sans accents, sans ligatures, en minuscules.
 *
 * Module PUR, sans motif à lookbehind — la palette l'importe dans le
 * navigateur pour filtrer ses destinations, le moteur serveur pour plier la
 * requête. UN seul pliage pour les deux : « Cœur » et « coeur » se rejoignent
 * partout, pas seulement d'un côté.
 */
export function foldSearch(s: string): string {
  return s
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/œ/g, "oe")
    .replace(/Œ/g, "OE")
    .replace(/æ/g, "ae")
    .replace(/Æ/g, "AE")
    .replace(/ß/g, "ss")
    .toLowerCase();
}
