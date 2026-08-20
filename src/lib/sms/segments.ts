/**
 * Analyse de segmentation SMS — GSM 03.38 exact.
 *
 * Pur et sans dépendance (règle du module : aucun import Next.js, aucun accès
 * base de données). Détermine l'encodage (GSM-7 ou UCS-2), le coût en unités
 * et le nombre de segments facturés, et signale les caractères typographiques
 * qui forcent l'UCS-2 avec une suggestion ASCII quand un équivalent sûr existe.
 */
import type { SmsEncoding } from "./types";

// Table de base GSM 03.38 (1 septet chacun) — les 127 caractères imprimables
// ou de contrôle du jeu par défaut, ESC (0x1B) exclu puisqu'il ne correspond à
// aucun caractère saisissable. Notons que é è à ù ì ò sont ici : le français
// « sans circonflexe » reste en GSM-7.
const GSM_BASIC_CHARS =
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ" +
  " !\"#¤%&'()*+,-./0123456789:;<=>?" +
  "¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§" +
  "¿abcdefghijklmnopqrstuvwxyzäöñüà";

// Table d'extension GSM 03.38 (préfixe ESC → 2 septets chacun).
const GSM_EXTENSION_CHARS = "\f^{}\\[~]|€";

const GSM_BASIC = new Set(GSM_BASIC_CHARS);
const GSM_EXTENSION = new Set(GSM_EXTENSION_CHARS);

// Limites d'unités par segment (septets en GSM-7, unités UTF-16 en UCS-2).
// Un message multi-segments perd 6 octets d'en-tête UDH par segment.
const GSM7_SINGLE = 160;
const GSM7_MULTI = 153;
const UCS2_SINGLE = 70;
const UCS2_MULTI = 67;

/**
 * Substituts ASCII sûrs pour les caractères typographiques courants qui
 * feraient basculer le message en UCS-2. Les caractères sans équivalent fidèle
 * (lettres accentuées hors GSM, émojis…) n'apparaissent pas ici : les proposer
 * altérerait le sens.
 */
const ASCII_FALLBACKS: ReadonlyMap<string, string> = new Map([
  // Apostrophes courbes → apostrophe droite
  ["‘", "'"], // ‘
  ["’", "'"], // ’
  // Guillemets courbes et guillemets français → guillemet droit
  ["“", '"'], // “
  ["”", '"'], // ”
  ["„", '"'], // „
  ["«", '"'], // «
  ["»", '"'], // »
  // Tirets demi-cadratin et cadratin → trait d'union
  ["–", "-"], // –
  ["—", "-"], // —
  // Points de suspension → trois points
  ["…", "..."], // …
  // Espaces insécables (U+00A0, U+202F) et fine (U+2009) → espace ordinaire
  [" ", " "],
  [" ", " "],
  [" ", " "],
]);

export interface SmsAnalysis {
  encoding: SmsEncoding;
  /** Septets en GSM-7, unités de code UTF-16 en UCS-2 (une paire de substitution = 2). */
  units: number;
  segments: number;
  /** Capacité d'un segment pour cet encodage et ce nombre de segments. */
  perSegment: number;
}

export interface SmsLintWarning {
  char: string;
  /** Position de la première occurrence, en unités de code UTF-16. */
  index: number;
  suggestion?: string;
}

export interface SmsLintResult {
  encoding: SmsEncoding;
  segments: number;
  warnings: SmsLintWarning[];
}

/**
 * Calcule l'encodage, le coût en unités et le nombre de segments d'un corps de
 * message. Un seul caractère hors des tables GSM fait basculer TOUT le message
 * en UCS-2 — c'est la règle du standard, et la source classique de SMS trois
 * fois plus chers pour un « ê ».
 */
export function analyzeSms(body: string): SmsAnalysis {
  let septets = 0;
  let isGsm = true;
  for (const char of body) {
    if (GSM_BASIC.has(char)) {
      septets += 1;
    } else if (GSM_EXTENSION.has(char)) {
      septets += 2;
    } else {
      isGsm = false;
      break;
    }
  }

  const encoding: SmsEncoding = isGsm ? "GSM-7" : "UCS-2";
  const units = isGsm ? septets : body.length;
  const single = isGsm ? GSM7_SINGLE : UCS2_SINGLE;
  const multi = isGsm ? GSM7_MULTI : UCS2_MULTI;
  const segments = units === 0 ? 0 : units <= single ? 1 : Math.ceil(units / multi);
  const perSegment = segments > 1 ? multi : single;

  return { encoding, units, segments, perSegment };
}

/**
 * Signale chaque caractère qui force l'UCS-2 (une entrée par caractère
 * distinct, à sa première position), avec un substitut ASCII quand il en
 * existe un sans perte de sens.
 */
export function lintSms(body: string): SmsLintResult {
  const { encoding, segments } = analyzeSms(body);
  const warnings: SmsLintWarning[] = [];
  const seen = new Set<string>();
  let index = 0;
  for (const char of body) {
    if (!GSM_BASIC.has(char) && !GSM_EXTENSION.has(char) && !seen.has(char)) {
      seen.add(char);
      const suggestion = ASCII_FALLBACKS.get(char);
      warnings.push(suggestion === undefined ? { char, index } : { char, index, suggestion });
    }
    index += char.length;
  }
  return { encoding, segments, warnings };
}
