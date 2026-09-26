/**
 * Recherche de clients — ce que la personne a tapé, en termes (§2.2).
 *
 * Module PUR et sans motif à lookbehind : la palette l'importe aussi dans le
 * navigateur (suggestions « rien trouvé », puces de portée). Il ne construit
 * AUCUN motif — c'est le rôle de `pattern.ts`, côté serveur.
 */
import { foldSearch } from "./fold";
import type { MatchField, MatchGroup, ParsedQuery, SearchTerm, TermKind } from "./types";

/** Longueur maximale d'une requête (après NFKC et `trim`). */
export const QUERY_MAX_LENGTH = 200;
export const MAX_POSITIVE_TERMS = 5;
export const MAX_NEGATIVE_TERMS = 3;

const NOTE_FIELDS: MatchField[] = ["notes", "comment", "followup", "call", "sms"];

/** Opérateurs de champ, clés PLIÉES (`tél:` → `tel`). */
export const FIELD_OPERATORS: Readonly<Record<string, readonly MatchField[]>> = {
  nom: ["name"],
  name: ["name"],
  tel: ["phone"],
  telephone: ["phone"],
  phone: ["phone"],
  courriel: ["email"],
  email: ["email"],
  mail: ["email"],
  ville: ["city"],
  city: ["city"],
  adresse: ["address"],
  address: ["address"],
  projet: ["project"],
  project: ["project"],
  budget: ["project"],
  note: NOTE_FIELDS,
  notes: NOTE_FIELDS,
  commentaire: ["comment"],
  comment: ["comment"],
  com: ["comment"],
  sms: ["sms"],
  texto: ["sms"],
};

/** Opérateurs de portée (`dans:notes`, `in:contact`). */
export const SCOPE_OPERATORS: ReadonlySet<string> = new Set(["dans", "in"]);

/** Valeurs de portée acceptées, clés PLIÉES. */
export const SCOPE_VALUES: Readonly<Record<string, MatchGroup>> = {
  contact: "contact",
  coord: "contact",
  coordonnees: "contact",
  profil: "profile",
  profile: "profile",
  lieu: "profile",
  place: "profile",
  notes: "notes",
  commentaires: "notes",
  comments: "notes",
  historique: "notes",
  history: "notes",
};

/** Mots vides (fr + en) : ignorés hors guillemets tant qu'il reste un autre terme. */
export const STOP_WORDS: ReadonlySet<string> = new Set([
  "le", "la", "les", "l", "de", "du", "des", "d", "un", "une", "et", "a", "au", "aux", "en", "pour", "sur",
  "the", "of", "and", "an", "in", "to", "at", "on",
]);

export type QueryOperator =
  | { kind: "fields"; name: string; fields: readonly MatchField[] }
  | { kind: "scope"; name: string };

/**
 * Un jeton brut : un mot, ou une expression entre guillemets, avec son
 * éventuel `-` et son éventuel opérateur CONNU (un `x:y` inconnu, comme
 * `14:05`, reste du texte). `op: valeur` (valeur vide) a déjà absorbé le jeton
 * suivant.
 */
export type SearchToken = {
  /** [start, end) dans la source (offsets UTF-16) — couvre `-`, `op:`, guillemets et valeur absorbée. */
  start: number;
  end: number;
  raw: string;
  negated: boolean;
  operator: QueryOperator | null;
  /** La valeur, sans `-`, sans `op:` ni guillemets. */
  value: string;
  quoted: boolean;
};

const CLOSING_QUOTE: Readonly<Record<string, readonly string[]>> = {
  '"': ['"'],
  "“": ["”", '"'],
  "«": ["»"],
};

const isSpace = (ch: string | undefined) => ch !== undefined && /\s/.test(ch);

function resolveOperator(name: string): QueryOperator | null {
  const key = foldSearch(name);
  const fields = FIELD_OPERATORS[key];
  if (fields) return { kind: "fields", name: key, fields };
  if (SCOPE_OPERATORS.has(key)) return { kind: "scope", name: key };
  return null;
}

/** Lit une expression entre guillemets qui s'ouvre en `at` ; non fermée, elle court jusqu'au bout. */
function readQuoted(s: string, at: number): { value: string; end: number } {
  const closers = CLOSING_QUOTE[s[at]] ?? ['"'];
  for (let k = at + 1; k < s.length; k++) {
    if (closers.includes(s[k])) return { value: s.slice(at + 1, k), end: k + 1 };
  }
  return { value: s.slice(at + 1), end: s.length };
}

/**
 * Découpe la source en jetons (§2.2 étape 3). Pur et sans motif exotique : la
 * palette s'en sert pour réécrire la portée sans toucher aux guillemets.
 */
export function tokenizeSearch(source: string): SearchToken[] {
  const tokens: SearchToken[] = [];
  const n = source.length;
  let i = 0;
  while (i < n) {
    while (i < n && isSpace(source[i])) i++;
    if (i >= n) break;
    const start = i;
    let j = i;
    let negated = source[j] === "-" && j + 1 < n && !isSpace(source[j + 1]);
    if (negated) j++;

    // `op:"…"`, `-op:"…"` ou `op:-"…"` : opérateur connu suivi d'une expression.
    const opMatch = /^([^\s:"“”«»]+):/.exec(source.slice(j));
    const knownOp = opMatch ? resolveOperator(opMatch[1]) : null;
    let quoteAt = knownOp && opMatch ? j + opMatch[0].length : j;
    if (knownOp && source[quoteAt] === "-" && quoteAt + 1 < n && CLOSING_QUOTE[source[quoteAt + 1]]) {
      negated = true;
      quoteAt++;
    }
    if (source[quoteAt] !== undefined && CLOSING_QUOTE[source[quoteAt]]) {
      const { value, end } = readQuoted(source, quoteAt);
      tokens.push({ start, end, raw: source.slice(start, end), negated, operator: knownOp, value, quoted: true });
      i = end;
      continue;
    }

    let end = start;
    while (end < n && !isSpace(source[end])) end++;
    const word = source.slice(start, end);
    const rest = negated ? word.slice(1) : word;
    const colon = rest.indexOf(":");
    const operator = colon > 0 ? resolveOperator(rest.slice(0, colon)) : null;
    tokens.push({
      start,
      end,
      raw: word,
      negated,
      operator,
      value: operator ? rest.slice(colon + 1) : rest,
      quoted: false,
    });
    i = end;
  }

  // `ville: laval` — un opérateur connu sans valeur prend le jeton suivant.
  // Le `-` de ce jeton reste une EXCLUSION (`ville: -laval`) : sinon le `-`
  // tombait avec la ponctuation et l'exclusion devenait une exigence.
  const joined: SearchToken[] = [];
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    const next = tokens[k + 1];
    if (t.operator && !t.quoted && t.value === "" && next) {
      joined.push({
        ...t,
        end: next.end,
        raw: source.slice(t.start, next.end),
        negated: t.negated || next.negated,
        value: next.quoted ? next.value : next.negated ? next.raw.slice(1) : next.raw,
        quoted: next.quoted,
      });
      k++;
      continue;
    }
    joined.push(negatedValue(t));
  }
  return joined;
}

/** `ville:-laval` : une valeur d'opérateur qui commence par `-` est une exclusion, comme `-ville:laval`. */
function negatedValue(t: SearchToken): SearchToken {
  if (!t.operator || t.quoted || t.value.length < 2 || !t.value.startsWith("-")) return t;
  return { ...t, negated: true, value: t.value.slice(1) };
}

/**
 * Caractères retirés aux deux bouts d'un mot (ponctuation, guillemets,
 * apostrophes orphelines, chevrons d'un courriel copié : `Nom <x@y.ca>`).
 */
const EDGE = /^[,.;:!?«»()[\]{}<>"“”'’‘]+|[,.;:!?«»()[\]{}<>"“”'’‘]+$/g;

export function trimEdges(s: string): string {
  return s.replace(EDGE, "");
}

/**
 * La ponctuation qu'un numéro COPIÉ traîne avec lui (« 418-542-8728, »,
 * « (418) 542-8728; », « <418…> ») — retirée AVANT de décider si c'est un
 * numéro. Sans `(`, `)` ni `.` : ils appartiennent au numéro, et le texte
 * montré (« (418) 542-8728 ») doit les garder. Sans guillemets : entre
 * guillemets, c'est du texte littéral.
 */
const PHONE_EDGE = /^[,;:!?[\]{}<>]+|[,;:!?[\]{}<>]+$/g;
const trimPhone = (s: string) => s.replace(PHONE_EDGE, "");

const PHONE_LIKE = /^[+()\d.-]+$/;
const POSTAL_FULL = /^[a-z]\d[a-z]-?\d[a-z]\d$/i;
const POSTAL_HEAD = /^[a-z]\d[a-z]$/i;
const POSTAL_TAIL = /^\d[a-z]\d$/i;

const isPhoneLike = (s: string) => PHONE_LIKE.test(s) && /\d/.test(s);
const digitsOf = (s: string) => s.replace(/\D/g, "");

/**
 * Les caractères de contrôle (hors tabulation et retours de ligne, qui sont des
 * espaces) : jamais utiles dans une recherche, et Postgres refuse un octet NUL
 * dans un paramètre (22021) — la route répondait 500.
 */
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** 11 chiffres qui commencent par 1 (indicatif nord-américain) → les 10 du numéro. */
export function nationalDigits(digits: string): string {
  return digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
}

/**
 * Les formes « coordonnées » d'un TEXTE : un courriel (`x@y`), ou 7 chiffres et
 * plus séparés au plus par 3 caractères parmi ` ().+-`. Ce sont les formes que
 * `redactContact` (snippet.ts) masque — ce que l'extrait cache, la recherche ne
 * doit pas le trouver.
 */
export const CONTACT_EMAIL_SHAPE = /[^\s@]+@[^\s@]+/;
export const CONTACT_DIGIT_RUN = /\d(?:[\s().+-]{0,3}\d){6,}/;

/**
 * Terme « de coordonnées » : il ne touche JAMAIS une fiche dont la case
 * `contact` est fermée. Jugé sur le CONTENU, pas sur la façon de l'écrire :
 * `"colette@exemple.com"` ou `"418-555-2222"` entre guillemets restent du texte
 * (ils ne lisent pas les colonnes téléphone et courriel), mais un texte qui
 * contient un courriel ou un numéro ne doit pas faire trouver, dans un
 * commentaire ou les notes, la fiche dont on cache justement ces coordonnées.
 */
export function contactKind(t: Pick<SearchTerm, "kind" | "value">): boolean {
  switch (t.kind) {
    case "email":
      return true;
    case "digits":
      return t.value.length >= 7;
    case "text":
    case "phrase":
      return CONTACT_EMAIL_SHAPE.test(t.value) || CONTACT_DIGIT_RUN.test(t.value);
    case "postal":
      return false;
  }
}

/** Des morceaux significatifs après découpe `[-'’.\s]+` — sinon le terme est vide. */
const hasPieces = (folded: string) => folded.split(/[-'’.\s]+/).some((p) => p.length > 0);

/** Longueur en caractères (points de code), pas en unités UTF-16. */
const charLength = (s: string) => Array.from(s).length;

/** Coupe à `max` sans laisser une demi-paire de substitution au bout. */
function clip(s: string, max: number): string {
  if (s.length <= max) return s;
  const cut = s.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}

type Candidate = SearchTerm & { stop: boolean };

function makeTerm(
  kind: TermKind,
  source: string,
  start: number,
  end: number,
  text: string,
  value: string,
  fields: readonly MatchField[] | null,
  negated: boolean,
  quoted: boolean,
): Candidate {
  return {
    kind,
    text,
    raw: source.slice(start, end),
    span: [start, end],
    value,
    fields: fields ? [...fields] : null,
    negated,
    quoted,
    stop: false,
  };
}

/**
 * Analyse une requête (§2.2). Ne lève jamais : une requête vide ou illisible
 * donne zéro terme.
 */
export function parseSearchQuery(raw: string): ParsedQuery {
  // Un contrôle devient une espace (même longueur) AVANT tout le reste.
  const source = clip(raw.replace(CONTROL, " ").normalize("NFKC").trim(), QUERY_MAX_LENGTH);
  const out: ParsedQuery = {
    source,
    positive: [],
    negative: [],
    ignored: [],
    scope: null,
    sequence: [],
    shortOnly: false,
    onlyExclusions: false,
  };
  if (!source) return out;

  // 2. La requête entière est un numéro : un seul terme `digits` — ponctuation
  // collée par un copier-coller comprise (« 418-542-8728, »).
  const phoneSource = trimPhone(source);
  const bare = phoneSource.replace(/[\s().+-]/g, "");
  if (/^\d{3,}$/.test(bare)) {
    out.positive.push(
      stripCandidate(makeTerm("digits", source, 0, source.length, phoneSource, nationalDigits(bare), null, false, false)),
    );
    return out;
  }

  const tokens = tokenizeSearch(source);
  const candidates: Candidate[] = [];
  const ignored: string[] = [];

  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    const fields = t.operator?.kind === "fields" ? t.operator.fields : null;

    if (t.operator?.kind === "scope") {
      const group = SCOPE_VALUES[foldSearch(trimEdges(t.value))];
      if (group && !t.negated) out.scope = group;
      else ignored.push(t.raw);
      continue;
    }
    if (t.operator && trimEdges(t.value).trim() === "") {
      ignored.push(t.raw);
      continue;
    }

    // 4. Fusion des jetons « téléphone » consécutifs : `(418) 476-1542`. La
    // ponctuation collée (« 8728, ») est retirée AVANT le test : sinon le
    // numéro devenait du texte, qui ne lit jamais la colonne téléphone.
    if (!t.quoted && isPhoneLike(trimPhone(t.value))) {
      let last = k;
      while (
        last + 1 < tokens.length &&
        !tokens[last + 1].quoted &&
        !tokens[last + 1].negated &&
        !tokens[last + 1].operator &&
        isPhoneLike(trimPhone(tokens[last + 1].value))
      ) {
        last++;
      }
      const run = tokens.slice(k, last + 1);
      const digits = run.map((r) => digitsOf(r.value)).join("");
      if (digits.length >= 3) {
        const text = run.map((r) => trimPhone(r.value)).join(" ");
        candidates.push(
          makeTerm("digits", source, t.start, tokens[last].end, text, nationalDigits(digits), fields, t.negated, false),
        );
        k = last;
        continue;
      }
    }

    const value = t.quoted ? t.value.trim().replace(/\s+/g, " ") : t.value;
    // « @Josée » — une arobase sans partie locale ni domaine — cherche la
    // MENTION écrite dans un commentaire, pas un courriel : on garde le nom, en
    // texte (plié, cherché partout). `@gmail.com`, lui, reste un bout de courriel.
    const mention = !t.quoted && /^@+[^@.\s]+$/.test(trimEdges(value));
    const trimmed = mention ? trimEdges(value).replace(/^@+/, "") : trimEdges(value);

    // 5. Code postal en deux jetons : `G1V 4M3`.
    const next = tokens[k + 1];
    if (
      !t.quoted &&
      POSTAL_HEAD.test(trimmed) &&
      next &&
      !next.quoted &&
      !next.negated &&
      !next.operator &&
      POSTAL_TAIL.test(trimEdges(next.value))
    ) {
      const tail = trimEdges(next.value);
      candidates.push(
        makeTerm(
          "postal",
          source,
          t.start,
          next.end,
          `${trimmed} ${tail}`,
          `${trimmed}${tail}`.toLowerCase(),
          fields,
          t.negated,
          false,
        ),
      );
      k++;
      continue;
    }

    if (!t.quoted && trimmed.includes("@")) {
      const email = trimmed.toLowerCase();
      if (email.replace(/@/g, "").length > 0) {
        candidates.push(makeTerm("email", source, t.start, t.end, trimmed, email, fields, t.negated, false));
      }
      continue;
    }
    if (!t.quoted && POSTAL_FULL.test(trimmed)) {
      candidates.push(
        makeTerm(
          "postal",
          source,
          t.start,
          t.end,
          trimmed,
          trimmed.replace("-", "").toLowerCase(),
          fields,
          t.negated,
          false,
        ),
      );
      continue;
    }

    const folded = foldSearch(trimmed);
    if (!hasPieces(folded)) continue; // vide : abandonné sans bruit
    const kind: TermKind = t.quoted && /\s/.test(folded) ? "phrase" : "text";
    const cand = makeTerm(kind, source, t.start, t.end, trimmed, folded, fields, t.negated, t.quoted);
    // 6. La séquence des bonus de nom : texte libre positif, mots vides compris.
    if (!t.negated && !fields) out.sequence.push(folded);
    cand.stop = kind === "text" && !t.quoted && !fields && STOP_WORDS.has(folded);
    candidates.push(cand);
  }

  // 7. Mots vides : mis de côté tant qu'il reste un autre terme positif.
  let kept = candidates;
  const positiveNonStop = kept.filter((c) => !c.negated && !c.stop);
  if (positiveNonStop.length > 0) {
    kept = kept.filter((c) => {
      if (c.stop && !c.negated) {
        ignored.push(c.raw);
        return false;
      }
      return true;
    });
  }

  // 8. Une lettre seule : mise de côté, sauf si c'est le SEUL terme positif.
  const positiveCount = kept.filter((c) => !c.negated).length;
  kept = kept.filter((c) => {
    if (c.kind === "text" && charLength(c.value) === 1 && (c.negated || positiveCount > 1)) {
      ignored.push(c.raw);
      return false;
    }
    return true;
  });

  // 9. Doublons : même nature, même valeur, mêmes champs, même signe.
  const seen = new Set<string>();
  kept = kept.filter((c) => {
    const key = `${c.kind}\u0000${c.value}\u0000${c.fields?.join(",") ?? ""}\u0000${c.negated ? 1 : 0}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // 10. Plafonds : 5 positifs, 3 exclusions — le reste est mis de côté.
  for (const c of kept) {
    const list = c.negated ? out.negative : out.positive;
    const max = c.negated ? MAX_NEGATIVE_TERMS : MAX_POSITIVE_TERMS;
    if (list.length < max) list.push(stripCandidate(c));
    else ignored.push(c.raw);
  }

  out.ignored = ignored;
  out.shortOnly = isShortOnly(out.positive);
  out.onlyExclusions = out.positive.length === 0 && out.negative.length > 0;
  return out;
}

function stripCandidate(c: Candidate): SearchTerm {
  // `stop` n'est qu'un marqueur interne : la réponse garde la forme de `SearchTerm`.
  return {
    kind: c.kind,
    text: c.text,
    raw: c.raw,
    span: c.span,
    value: c.value,
    fields: c.fields,
    negated: c.negated,
    quoted: c.quoted,
  };
}

/** Tous les termes positifs sont des mots de 1–2 lettres (aucun ne descend dans l'historique). */
export function isShortOnly(positive: readonly Pick<SearchTerm, "kind" | "value">[]): boolean {
  return positive.length > 0 && positive.every((t) => t.kind === "text" && charLength(t.value) <= 2);
}
