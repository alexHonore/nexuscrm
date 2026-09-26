/**
 * Recherche de clients — les MOTIFS (§2.3).
 *
 * Chaque fonction rend une CHAÎNE qui se comporte à l'identique dans Postgres
 * (`~*`, ARE) et dans `new RegExp(p, "iu")` : c'est la même chaîne qui filtre
 * en SQL et qui surligne en TS, pour que les deux ne dérivent jamais.
 *
 * - Le pliage des accents vit dans la REQUÊTE, pas dans les données : chaque
 *   lettre tapée devient une classe qui liste toutes ses variantes, DANS LES
 *   DEUX CASSES — `~*` sous `COLLATE "C"` ne plie que l'ASCII, et la collation
 *   de la prod n'est pas vérifiée.
 * - Les frontières de mot sont des lookbehind explicites : `\m` / `\b` jugent
 *   « É » non-lettre sous C.
 * - Le texte de l'utilisateur est toujours échappé : il ne devient jamais un
 *   quantificateur ni un groupe ; `%` et `_` sont des caractères ordinaires.
 *
 * ⚠️ Ces motifs contiennent des lookbehind : les navigateurs ne les compilent
 * JAMAIS (Safari < 16.4 lève). Seul le serveur les exécute.
 */

/** Les caractères « de mot » (frontières). `Ÿ` ajouté : `~*` sous C ne le plie pas vers `ÿ`, `iu` si. */
export const WORD_CHARS = "0-9A-Za-zÀ-ÖØ-öø-ÿŒœŸ";
const NOT_AFTER_WORD = `(?<![${WORD_CHARS}])`;
const NOT_BEFORE_WORD = `(?![${WORD_CHARS}])`;

/**
 * Espaces insécables écrites en toutes lettres : `\s` les couvre en JS mais pas
 * forcément en Postgres (sous C, `[[:space:]]` s'arrête à l'ASCII). Le français
 * en met partout (« 650 000 $ », « « … » »).
 */
const NBSP = "\u00A0\u202F\u2009";

/** Entre deux morceaux d'un mot (`l'île`, `jean-marc`, `a.b`) : zéro ou plusieurs séparateurs. */
export const PIECE_JOIN = `[-\\s${NBSP}'’.]*`;
/** Entre deux mots d'une expression : au moins un séparateur. */
export const WORD_JOIN = `[-\\s${NBSP}'’.,]+`;
/** Entre deux chiffres dans un texte libre (« 650 000 $ », « (418) 476-1542 »). */
export const DIGIT_JOIN = `[\\s${NBSP}().+-]{0,3}`;

const A = "[aàâäáãåAÀÂÄÁÃÅ]";
const E = "[eéèêëEÉÈÊË]";
const O = "[oóòôöõOÓÒÔÖÕ]";

/** Les lettres qui portent des accents en français, dans les deux casses. */
export const LETTER_CLASSES: Readonly<Record<string, string>> = {
  a: A,
  c: "[cçCÇ]",
  e: E,
  i: "[iíìîïIÍÌÎÏ]",
  n: "[nñNÑ]",
  o: O,
  u: "[uúùûüUÚÙÛÜ]",
  y: "[yýÿYÝŸ]",
};

/**
 * `oe` / `ae` pliés : la ligature OU les deux lettres. Les lettres gardent leur
 * classe COMPLÈTE — « noel » doit trouver « Noël », « raphael » « Raphaël ».
 */
const OE = `(?:${O}${E}|[œŒ])`;
const AE = `(?:${A}${E}|[æÆ])`;

const META = /[\^$\\.*+?()[\]{}|/]/g;

/** Échappe exactement `^ $ \ . * + ? ( ) [ ] { } | /` — le reste est littéral dans les deux moteurs. */
export function escapeRegex(s: string): string {
  return s.replace(META, "\\$&");
}

/** Échappe `\`, `%` et `_` pour un `LIKE` (caractère d'échappement par défaut : `\`). */
export function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, "\\$&");
}

/** Un caractère plié → sa classe (lettres accentuables), ses deux casses (autres lettres) ou lui-même échappé. */
export function expandChar(ch: string): string {
  const cls = LETTER_CLASSES[ch];
  if (cls) return cls;
  if (/^[a-z0-9]$/.test(ch)) return ch;
  const upper = ch.toUpperCase();
  const lower = ch.toLowerCase();
  if (upper !== lower && Array.from(upper).length === 1 && Array.from(lower).length === 1) {
    return `[${lower}${upper}]`;
  }
  return escapeRegex(ch);
}

/** Un morceau plié, caractère par caractère, avec les digrammes `oe` / `ae`. */
export function expandText(folded: string): string {
  const chars = Array.from(folded);
  let out = "";
  for (let k = 0; k < chars.length; k++) {
    const pair = chars[k] + (chars[k + 1] ?? "");
    if (pair === "oe") {
      out += OE;
      k++;
    } else if (pair === "ae") {
      out += AE;
      k++;
    } else {
      out += expandChar(chars[k]);
    }
  }
  return out;
}

/** `C()` du flou : classe par caractère, SANS digramme (chaque position reste une position). */
function expandChars(chars: readonly string[]): string {
  return chars.map(expandChar).join("");
}

// ─── Abréviations st / ste / saint / sainte ────────────────────────────────────

const altOf = (words: readonly string[]) => `(?:${words.map(expandText).join("|")})`;
/** `st` / `saint` : toutes les formes. `ste` / `sainte` : les féminines seulement. */
const ABBR_ANY = `${NOT_AFTER_WORD}${altOf(["sainte", "saint", "ste", "st"])}${NOT_BEFORE_WORD}\\.?`;
const ABBR_FEM = `${NOT_AFTER_WORD}${altOf(["sainte", "ste"])}${NOT_BEFORE_WORD}\\.?`;

const ABBREVIATIONS: Readonly<Record<string, string>> = {
  st: ABBR_ANY,
  saint: ABBR_ANY,
  ste: ABBR_FEM,
  sainte: ABBR_FEM,
};

/** Un morceau exactement égal à une abréviation : ancré aux deux bouts (« st » ne trouve pas « Christine »). */
export function isAbbreviation(piece: string): boolean {
  return piece in ABBREVIATIONS;
}

/**
 * Un morceau → son motif. Trois cas :
 * - une abréviation (`st`, `ste`, `saint`, `sainte`) → l'alternance ancrée ;
 * - un composé collé `saint…` / `sainte…` (« saintefoy », « saintjean ») →
 *   le texte tel quel OU l'abréviation suivie du reste (« Sainte-Foy ») ;
 * - sinon, les classes de lettres.
 */
function piecePattern(piece: string): string {
  const abbr = ABBREVIATIONS[piece];
  if (abbr) return abbr;
  const alts = [expandText(piece)];
  if (piece.startsWith("sainte") && piece.length >= 8) {
    alts.push(`${ABBR_FEM}${PIECE_JOIN}${expandText(piece.slice(6))}`);
  }
  if (piece.startsWith("saint") && piece.length >= 7) {
    alts.push(`${ABBR_ANY}${PIECE_JOIN}${expandText(piece.slice(5))}`);
  }
  return alts.length === 1 ? alts[0] : `(?:${alts.join("|")})`;
}

const splitPieces = (word: string) => word.split(/[-'’.\s]+/).filter((p) => p.length > 0);

/** Le cœur d'un terme texte/expression, sans ancrage. `anchored` : il contient une abréviation. */
export type Core = { core: string; anchored: boolean };

/**
 * `core(term)` : les morceaux (découpe `[-'’.\s]+`) joints par `PIECE_JOIN` ;
 * une expression joint ses MOTS par `WORD_JOIN`. `null` quand il ne reste rien.
 */
export function coreOf(folded: string, kind: "text" | "phrase" = "text"): Core | null {
  const words = kind === "phrase" ? folded.split(/\s+/) : [folded];
  let anchored = false;
  const parts: string[] = [];
  for (const word of words) {
    const pieces = splitPieces(word);
    if (pieces.length === 0) continue;
    if (pieces.some(isAbbreviation)) anchored = true;
    parts.push(pieces.map(piecePattern).join(PIECE_JOIN));
  }
  if (parts.length === 0) return null;
  return { core: parts.join(WORD_JOIN), anchored };
}

/** Les quatre niveaux d'un terme texte/expression. */
export type TextLevels = {
  /** Où que ce soit dans le mot. Un terme à abréviation garde l'ancrage de début. */
  infix: string;
  /** Au début d'un mot. */
  wordStart: string;
  /** Le mot entier. */
  whole: string;
  /** Le niveau des champs de texte libre : `infix` dès 3 caractères, `wordStart` en dessous. */
  text: string;
};

export function textLevels(folded: string, kind: "text" | "phrase" = "text"): TextLevels | null {
  const c = coreOf(folded, kind);
  if (!c) return null;
  const wordStart = `${NOT_AFTER_WORD}(?:${c.core})`;
  const whole = `${wordStart}${NOT_BEFORE_WORD}`;
  const infix = c.anchored ? wordStart : c.core;
  const long = kind === "phrase" || Array.from(folded).length >= 3;
  return { infix, wordStart, whole, text: long ? infix : wordStart };
}

/** Un nombre court : au-delà, c'est un numéro de téléphone (`contactKind`). */
const SHORT_NUMBER_MAX = 6;

/**
 * Des chiffres dans un texte libre : `4[\s().+-]{0,3}1[…]8…`, qui FINISSENT où le
 * nombre écrit finit (`(?![0-9])`).
 * - 3–6 chiffres (numéro civique, prix, fin de numéro) : le nombre ENTIER,
 *   ancré aussi au début — « 412 » ne trouve ni « 6412 rue Bédard » ni
 *   « 4127 ». Un séparateur compte comme une frontière (« app. 3, 412 rue »).
 * - 7 chiffres et plus (un numéro) : peut être la FIN d'un nombre plus long,
 *   comme `ph_s` — « 4761542 » trouve « 4184761542 », et un numéro à 10
 *   chiffres trouve « +1 418 476-1542 ».
 */
export function digitsPattern(digits: string): string {
  const d = Array.from(digits.replace(/\D/g, ""));
  const core = `${d.join(DIGIT_JOIN)}(?![0-9])`;
  return d.length <= SHORT_NUMBER_MAX ? `(?<![0-9])${core}` : core;
}

/** Un courriel dans un texte libre : le littéral échappé (`~*` plie la casse ASCII). */
export function emailPattern(email: string): string {
  return escapeRegex(email);
}

/** Un code postal `g1v4m3` → `g1v[\s-]?4m3` (lettres littérales, `~*` plie la casse). */
export function postalPattern(postal: string): string {
  const p = postal.replace(/[^0-9a-z]/gi, "").toLowerCase();
  return `${p.slice(0, 3)}[\\s${NBSP}-]?${p.slice(3)}`;
}

// ─── Bonus de nom ──────────────────────────────────────────────────────────────

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [items.slice()];
  const out: T[][] = [];
  items.forEach((item, k) => {
    const rest = [...items.slice(0, k), ...items.slice(k + 1)];
    for (const p of permutations(rest)) out.push([item, ...p]);
  });
  return out;
}

/** Les cœurs d'une séquence (un élément avec espace est une expression). */
function sequenceCores(sequence: readonly string[]): string[] {
  const cores: string[] = [];
  for (const s of sequence) {
    const c = coreOf(s, /\s/.test(s) ? "phrase" : "text");
    if (c) cores.push(`(?:${c.core})`);
  }
  return cores;
}

/**
 * Le nom EST la séquence : `^\s*(?:P1|P2|…)[\s.]*$`, chaque `Pk` une
 * permutation des cœurs (3 éléments au plus ; au-delà, l'ordre tapé seul).
 */
export function exactNamePattern(sequence: readonly string[]): string | null {
  const cores = sequenceCores(sequence);
  if (cores.length === 0) return null;
  const orders = cores.length <= 3 ? permutations(cores) : [cores];
  const alts = [...new Set(orders.map((o) => o.join(WORD_JOIN)))];
  return `^\\s*(?:${alts.join("|")})[\\s.]*$`;
}

/** La séquence (2 éléments ou plus), dans l'ordre tapé, à un début de mot. */
export function phraseNamePattern(sequence: readonly string[]): string | null {
  const cores = sequenceCores(sequence);
  if (cores.length < 2) return null;
  return `${NOT_AFTER_WORD}${cores.join(WORD_JOIN)}`;
}

/** Le nom COMMENCE par ce terme. */
export function startNamePattern(folded: string, kind: "text" | "phrase" = "text"): string | null {
  const c = coreOf(folded, kind);
  return c ? `^\\s*(?:${c.core})` : null;
}

// ─── Flou (relance « faute de frappe ») ────────────────────────────────────────

export const FUZZY_MIN_LENGTH = 5;
export const FUZZY_MAX_LENGTH = 12;

/** Éligible au flou : un seul morceau (ni espace, ni `-'’.`) de 5 à 12 caractères. */
export function fuzzyEligible(folded: string): boolean {
  if (/[-'’.\s]/.test(folded)) return false;
  const n = Array.from(folded).length;
  return n >= FUZZY_MIN_LENGTH && n <= FUZZY_MAX_LENGTH;
}

/**
 * Toutes les variantes à une modification près (substitution, insertion,
 * suppression, inversion de deux voisines), à un début de mot. `prefilter`
 * est IMPLIQUÉ par `pattern` : toute variante garde intacte soit la première
 * moitié `t[0..h)`, soit la fin `t[h+1..L)` (h = ⌊L/2⌋).
 */
export function fuzzyPattern(folded: string): { pattern: string; prefilter: string } | null {
  if (!fuzzyEligible(folded)) return null;
  const t = Array.from(folded);
  const L = t.length;
  const C = (from: number, to?: number) => expandChars(t.slice(from, to));
  const alts: string[] = [];
  for (let i = 0; i < L; i++) alts.push(`${C(0, i)}\\S${C(i + 1)}`); // substitution
  for (let i = 0; i <= L; i++) alts.push(`${C(0, i)}\\S${C(i)}`); // insertion
  for (let i = 0; i < L; i++) alts.push(`${C(0, i)}${C(i + 1)}`); // suppression
  for (let i = 0; i + 1 < L; i++) {
    if (t[i] !== t[i + 1]) alts.push(`${C(0, i)}${expandChar(t[i + 1])}${expandChar(t[i])}${C(i + 2)}`); // inversion
  }
  const h = Math.floor(L / 2);
  return {
    pattern: `${NOT_AFTER_WORD}(?:${[...new Set(alts)].join("|")})`,
    prefilter: `(?:${C(0, h)}|${C(h + 1)})`,
  };
}

/**
 * `(?:p1)|(?:p2)|…` sans doublon — `null` pour une liste vide, le motif LUI-MÊME
 * pour un seul (même chaîne = même entrée du cache d'expressions de Postgres).
 */
export function anyOf(patterns: readonly string[]): string | null {
  const unique = [...new Set(patterns)];
  if (unique.length === 0) return null;
  if (unique.length === 1) return unique[0];
  return unique.map((p) => `(?:${p})`).join("|");
}
