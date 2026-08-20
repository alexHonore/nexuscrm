/**
 * Détection déterministe des mots-clés de désabonnement (opt-out) SMS.
 *
 * Sémantique CASL/Twilio : le message ENTIER (normalisé) doit être égal à un
 * mot-clé — « stop it please » ou « je veux annuler mon rdv » ne sont PAS des
 * opt-outs. Les formulations équivalentes relèvent du classificateur IA
 * (phase ultérieure) ; cette couche ne traite que les mots-clés exacts.
 *
 * Framework-agnostique : aucune dépendance, importable tel quel ailleurs.
 */

/** Mots-clés opt-out sous forme normalisée (majuscules, sans accents). */
export const OPTOUT_KEYWORDS: readonly string[] = [
  // Jeu standard anglais de Twilio
  "STOP",
  "STOPALL",
  "STOP ALL",
  "UNSUBSCRIBE",
  "CANCEL",
  "END",
  "QUIT",
  // Français — « ARRET » couvre aussi « ARRÊT » après normalisation
  "ARRET",
  "DESABONNER",
  "DESABONNEMENT",
  "ANNULER",
];

/**
 * Ponctuation (et blancs) retirée en tête et en fin de message : point,
 * virgule, point-virgule, deux-points, exclamation, interrogation,
 * guillemets (« » et droits/typographiques), apostrophes, trait d'union.
 * La classe inclut les blancs pour absorber les combinaisons du type « stop ! ».
 */
const EDGE_STRIP =
  /^[\s.,;:!?«»"'“”‘’-]+|[\s.,;:!?«»"'“”‘’-]+$/g;

/** Diacritiques combinants (bloc Unicode « Combining Diacritical Marks »). */
const COMBINING_MARKS = /[\u0300-\u036f]/g;

/**
 * Forme canonique d'un corps de message pour la comparaison aux mots-clés :
 * accents retirés (décomposition NFD + suppression des diacritiques),
 * majuscules, blancs internes réduits à une espace, ponctuation d'encadrement
 * retirée.
 */
export function normalizeOptOutInput(body: string): string {
  return body
    .normalize("NFD")
    .replace(COMBINING_MARKS, "")
    .toUpperCase()
    .replace(EDGE_STRIP, "")
    .replace(/\s+/g, " ");
}

/**
 * Détecte un opt-out par mot-clé exact. `keyword` est le mot-clé normalisé
 * apparié (ex. « ARRET » pour un « arrêt » accentué), ou null.
 */
export function detectOptOut(body: string): { optOut: boolean; keyword: string | null } {
  const normalized = normalizeOptOutInput(body);
  if (normalized === "") return { optOut: false, keyword: null };
  const keyword = OPTOUT_KEYWORDS.find((k) => k === normalized) ?? null;
  return { optOut: keyword !== null, keyword };
}
