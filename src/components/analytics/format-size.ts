/**
 * Une taille d'audio lisible : « 1,3 Mo » / « 1.3 MB ». L'unité vient d'Intl,
 * jamais d'une chaîne en dur.
 *
 * Toute espace est ramenée à UNE espace insécable. Rendu au serveur puis au
 * navigateur, le même appel à Intl ne donne pas le même caractère — mesuré le
 * 2026-09-13 : l'ICU de Node (77.1) met une espace ordinaire entre « 1,3 » et
 * « Mo », Chrome une espace insécable. Le texte semblait identique et React
 * jetait quand même le rendu serveur de la jauge (erreur d'hydratation).
 * L'insécable a en prime le bon goût de ne jamais séparer « 1,3 » de son
 * unité en fin de ligne.
 *
 * Module pur — ni hook ni « use client » — pour être testé tel quel.
 */
const MB = 1024 * 1024;
const NBSP = String.fromCharCode(0xa0);

export function formatSize(bytes: number, locale: string): string {
  const inMb = bytes === 0 || bytes >= 0.1 * MB;
  return new Intl.NumberFormat(locale === "en" ? "en-CA" : "fr-CA", {
    style: "unit",
    unit: inMb ? "megabyte" : "kilobyte",
    maximumFractionDigits: 1,
  })
    .format(inMb ? bytes / MB : bytes / 1024)
    .replace(/\s/g, NBSP);
}
