/**
 * Recherche de clients — le PLAN d'une requête (§2.4).
 *
 * `planSearch(parsed, { mode, fuzzy })` décide, terme par terme, QUELLES
 * colonnes-masques il peut allumer et AVEC QUEL TEST, puis numérote les bits.
 * Le builder du statement (§3.3) n'a plus qu'à traduire `SearchPlan` — il ne
 * redérive aucune règle : ni la matrice nature × champ, ni les opérateurs, ni
 * le mode, ni les niveaux.
 *
 * Module PUR : les motifs sont des chaînes ; seul le serveur les compile.
 */
import {
  anyOf,
  digitsPattern,
  emailPattern,
  escapeLike,
  exactNamePattern,
  fuzzyEligible,
  fuzzyPattern,
  phraseNamePattern,
  postalPattern,
  startNamePattern,
  textLevels,
} from "./pattern";
import { contactKind, isShortOnly } from "./query";
import { LEVEL_OF, LEVELS, scoreSpec } from "./score";
import {
  FIELD_GROUP,
  MASK_COLUMNS,
  MATCH_FIELDS,
  type ColumnGate,
  type ColumnPlan,
  type HighlightPattern,
  type HistoryColumn,
  type MaskColumn,
  type MaskEntry,
  type MatchField,
  type MatchGroup,
  type ParsedQuery,
  type PlannedTerm,
  type SearchMeta,
  type SearchMode,
  type SearchPlan,
  type SearchTerm,
} from "./types";

/** Les champs qu'interroge le mode `identity` (dialogue « ajouter des clients » d'une campagne). */
export const IDENTITY_FIELDS: ReadonlySet<MatchField> = new Set(["name", "city", "phone", "email"]);

/** Le droit qui ouvre chaque champ (voir `ColumnGate`). */
export const FIELD_GATE: Readonly<Record<MatchField, ColumnGate>> = {
  name: "visible",
  city: "visible",
  address: "visible",
  notes: "visible",
  project: "visible",
  phone: "contact",
  email: "contact",
  comment: "history",
  followup: "history",
  call: "history",
  sms: "thread",
};

/** Les alias de la CTE `vis` que lit chaque champ de la fiche (vide pour l'historique). */
export const FIELD_SOURCES: Readonly<Record<MatchField, readonly string[]>> = {
  name: ["name_t"],
  city: ["city_t"],
  address: ["addr_t"],
  notes: ["notes_t"],
  project: ["proj_t"],
  phone: ["phone_t", "phone2_t"],
  email: ["email_t"],
  comment: [],
  followup: [],
  call: [],
  sms: [],
};

/** La CTE qui nourrit chaque colonne d'historique. */
export const HISTORY_CTE: Readonly<Record<HistoryColumn, "cm" | "fu" | "ca" | "sm">> = {
  com_m: "cm",
  fup_m: "fu",
  call_m: "ca",
  sms_m: "sm",
};

const HISTORY_SET: ReadonlySet<MaskColumn> = new Set(Object.keys(HISTORY_CTE) as MaskColumn[]);

/** Les colonnes de chaque famille — facettes (`facets`) et portée (`scoped`). */
export const GROUP_COLUMNS: Readonly<Record<MatchGroup, readonly MaskColumn[]>> = {
  contact: MASK_COLUMNS.filter((c) => FIELD_GROUP[LEVEL_OF[c].field] === "contact"),
  profile: MASK_COLUMNS.filter((c) => FIELD_GROUP[LEVEL_OF[c].field] === "profile"),
  notes: MASK_COLUMNS.filter((c) => FIELD_GROUP[LEVEL_OF[c].field] === "notes"),
};

/** Au plus 3 termes flous par requête. */
export const MAX_FUZZY_TERMS = 3;

/** Une entrée avant numérotation (`Omit` distribué sur l'union). */
type Draft = MaskEntry extends infer E ? (E extends MaskEntry ? Omit<E, "bit" | "term"> : never) : never;
type DraftEntries = Partial<Record<MaskColumn, Draft>>;

const regex = (pattern: string, prefilter: string | null = null): Draft => ({ op: "regex", pattern, prefilter });

/** Ce que le plan d'un terme doit savoir des AUTRES termes. */
type DraftContext = {
  /** Au moins un autre terme POSITIF l'accompagne (k ≥ 2). */
  crowded: boolean;
};

/**
 * La matrice §2.4 : pour un terme, le test de chaque colonne AVANT
 * l'intersection avec l'opérateur et le mode. Le flou est ajouté à part.
 */
function draftEntries(term: SearchTerm, ctx: DraftContext): DraftEntries {
  const out: DraftEntries = {};
  switch (term.kind) {
    case "text":
    case "phrase": {
      const lv = textLevels(term.value, term.kind);
      if (!lv) return out;
      const long = term.kind === "phrase" || Array.from(term.value).length >= 3;
      if (long) {
        out.name_i = regex(lv.infix);
        out.city_i = regex(lv.infix);
      }
      out.name_w = regex(lv.wordStart);
      out.name_x = regex(lv.whole);
      out.city_w = regex(lv.wordStart);
      out.city_x = regex(lv.whole);
      out.addr_m = regex(lv.text);
      out.proj_m = regex(lv.text);
      if (long) {
        out.notes_m = regex(lv.text);
        if (!/\s/.test(term.value)) out.em_t = { op: "like", pattern: `%${escapeLike(term.value)}%` };
        out.com_m = regex(lv.text);
        out.fup_m = regex(lv.text);
        out.call_m = regex(lv.text);
        out.sms_m = regex(lv.text);
      }
      return out;
    }
    case "digits": {
      const d = term.value;
      const p = digitsPattern(d);
      out.name_i = regex(p);
      out.addr_m = regex(p);
      out.notes_m = regex(p);
      out.proj_m = regex(p);
      // Téléphone : 10 chiffres = le numéro entier ; 4–9 = sa fin ; plus de 10
      // (international) = la fin sur toute la longueur tapée.
      if (d.length >= 10) out.ph_x = { op: "right-eq", value: d, length: d.length };
      else if (d.length >= 4) out.ph_s = { op: "right-eq", value: d, length: d.length };
      // L'infixe (« le numéro contient ces chiffres quelque part ») : pour un
      // numéro (7 chiffres et plus), pour des chiffres tapés SEULS (« 418 »),
      // avec `tel:`, et pour une exclusion. PARMI d'autres termes, 3–6 chiffres
      // sont un numéro civique (« 412 rue tremblay ») ou un indicatif
      // (« marc 514 ») : 412 est DANS un numéro sur 125, une coïncidence qui
      // passait devant la fiche qui habite au 412. Restent la fin du numéro
      // (`ph_s`, « tremblay 5551 ») et son DÉBUT national (`ph_p` : l'indicatif,
      // « tremblay 418 555 »). Les numéros sont en E.164 (`normalizePhone`).
      const explicit = term.fields?.includes("phone") === true;
      if (d.length >= 7 || !ctx.crowded || term.negated || explicit) {
        out.ph_i = { op: "like", pattern: `%${d}%` };
      } else {
        out.ph_p = { op: "like", pattern: `+1${d}%` };
      }
      out.com_m = regex(p);
      out.fup_m = regex(p);
      out.call_m = regex(p);
      out.sms_m = regex(p);
      return out;
    }
    case "email": {
      const e = term.value;
      const p = emailPattern(e);
      out.notes_m = regex(p);
      out.em_x = { op: "eq", value: e };
      out.em_p = { op: "like", pattern: `${escapeLike(e)}%` };
      out.em_i = { op: "like", pattern: `%${escapeLike(e)}%` };
      out.com_m = regex(p);
      out.fup_m = regex(p);
      out.call_m = regex(p);
      out.sms_m = regex(p);
      return out;
    }
    case "postal": {
      const p = postalPattern(term.value);
      out.addr_pc = regex(p);
      out.notes_m = regex(p);
      out.com_m = regex(p);
      out.fup_m = regex(p);
      out.call_m = regex(p);
      out.sms_m = regex(p);
      return out;
    }
  }
}

/** Opérateur × mode : les champs qu'un terme a le droit de toucher. */
function allowedFields(term: SearchTerm, mode: SearchMode): (field: MatchField) => boolean {
  const op = term.fields ? new Set(term.fields) : null;
  return (field) => (!op || op.has(field)) && (mode === "all" || IDENTITY_FIELDS.has(field));
}

function filterDraft(draft: DraftEntries, allow: (f: MatchField) => boolean): DraftEntries {
  const out: DraftEntries = {};
  for (const c of MASK_COLUMNS) {
    const d = draft[c];
    if (d && allow(LEVEL_OF[c].field)) out[c] = d;
  }
  return out;
}

/**
 * Une exclusion n'a pas de niveau : elle ne compte pas au score, seule sa
 * PRÉSENCE compte. Elle garde donc, par champ, la colonne la plus large
 * (`name_i` plutôt que `name_w`/`name_x`, `ph_i`, `em_i`) — un niveau étroit
 * implique le large. Moins de motifs distincts : Postgres ne garde que 32
 * expressions compilées par session (`MAX_CACHED_RES`).
 */
function broadestPerField(draft: DraftEntries): DraftEntries {
  const out: DraftEntries = {};
  const byField = new Map<MatchField, MaskColumn>();
  for (const c of MASK_COLUMNS) {
    if (!draft[c]) continue;
    const field = LEVEL_OF[c].field;
    const kept = byField.get(field);
    if (!kept || LEVEL_OF[c].points < LEVEL_OF[kept].points) byField.set(field, c);
  }
  for (const c of byField.values()) out[c] = draft[c];
  return out;
}

export type PlanOptions = {
  mode: SearchMode;
  /** Remplir `name_f` / `city_f` (relance « faute de frappe ») — ignoré en `identity`. */
  fuzzy?: boolean;
};

/**
 * Le plan d'une requête analysée. Ne lève jamais ; un plan sans terme positif
 * (`termCount === 0`) ne doit lancer AUCUNE requête SQL.
 */
export function planSearch(parsed: ParsedQuery, opts: PlanOptions): SearchPlan {
  const mode = opts.mode;
  const fuzzy = mode === "all" && opts.fuzzy === true;
  const ignored = [...parsed.ignored];

  // 1. Chaque terme, filtré par son opérateur et le mode ; vide → mis de côté.
  // Un terme de chiffres se planifie selon qu'il est SEUL ou non : on compte
  // d'abord les positifs qui survivent (leur survie, elle, n'en dépend pas).
  const survives = (term: SearchTerm) =>
    Object.keys(filterDraft(draftEntries(term, { crowded: true }), allowedFields(term, mode))).length > 0;
  const ctx: DraftContext = { crowded: parsed.positive.filter(survives).length >= 2 };
  const kept: { term: SearchTerm; draft: DraftEntries }[] = [];
  for (const term of [...parsed.positive, ...parsed.negative]) {
    const allowed = filterDraft(draftEntries(term, ctx), allowedFields(term, mode));
    const draft = term.negated ? broadestPerField(allowed) : allowed;
    if (Object.keys(draft).length === 0) ignored.push(term.raw);
    else kept.push({ term, draft });
  }

  // 2. Les bits : positif i → 1<<i ; exclusion j → 1<<(8+j).
  const terms: PlannedTerm[] = [];
  const drafts: DraftEntries[] = [];
  let pos = 0;
  let negIdx = 0;
  for (const { term, draft } of kept.filter((k) => !k.term.negated).concat(kept.filter((k) => k.term.negated))) {
    const bit = term.negated ? 1 << (8 + negIdx++) : 1 << pos++;
    terms.push({ ...term, index: terms.length, bit, contactKind: contactKind(term), columns: [] });
    drafts.push(draft);
  }
  const positive = terms.filter((t) => !t.negated);
  const negative = terms.filter((t) => t.negated);

  // 3. Le flou : les 3 premiers termes positifs éligibles, sur le nom et la ville.
  let fuzzyCandidates = 0;
  if (mode === "all") {
    for (const t of positive) {
      if (fuzzyCandidates >= MAX_FUZZY_TERMS) break;
      if (t.kind !== "text" || !fuzzyEligible(t.value)) continue;
      const allow = allowedFields(t, mode);
      if (!allow("name") && !allow("city")) continue;
      fuzzyCandidates++;
      if (!fuzzy) continue;
      const fz = fuzzyPattern(t.value);
      if (!fz) continue;
      if (allow("name")) drafts[t.index].name_f = regex(fz.pattern, fz.prefilter);
      if (allow("city")) drafts[t.index].city_f = regex(fz.pattern, fz.prefilter);
    }
  }

  // 4. Les colonnes.
  const columns = {} as Record<MaskColumn, ColumnPlan>;
  for (const c of MASK_COLUMNS) {
    const field = LEVEL_OF[c].field;
    columns[c] = { column: c, field, gate: FIELD_GATE[field], sources: FIELD_SOURCES[field], entries: [], any: null };
  }
  terms.forEach((t, idx) => {
    for (const c of MASK_COLUMNS) {
      const d = drafts[idx][c];
      if (!d) continue;
      columns[c].entries.push({ ...d, bit: t.bit, term: t.index } as MaskEntry);
      t.columns.push(c);
    }
  });
  for (const c of MASK_COLUMNS) {
    const col = columns[c];
    col.entries.sort((a, b) => a.bit - b.bit);
    col.any = anyOf(col.entries.flatMap((e) => (e.op === "regex" ? [e.prefilter ?? e.pattern] : [])));
  }

  // 5. Les bits dérivés.
  const termCount = positive.length;
  const req = (1 << termCount) - 1;
  const neg = negative.reduce((m, t) => m | t.bit, 0);
  const contactBits = terms.reduce((m, t) => (t.contactKind ? m | t.bit : m), 0);
  const historyEntries = [...HISTORY_SET].flatMap((c) => columns[c].entries);
  const deepBits = historyEntries.reduce((m, e) => m | e.bit, 0);
  const deepAny = anyOf(historyEntries.flatMap((e) => (e.op === "regex" ? [e.pattern] : [])));

  // 6. Les bonus de nom — seulement quand la séquence n'est pas vide.
  const hasSequence = parsed.sequence.length > 0 && termCount > 0;
  const firstText = positive.find(
    (t) => (t.kind === "text" || t.kind === "phrase") && t.columns.some((c) => LEVEL_OF[c].field === "name"),
  );
  const exactName = hasSequence ? exactNamePattern(parsed.sequence) : null;
  const phraseName = hasSequence ? phraseNamePattern(parsed.sequence) : null;
  const startName =
    hasSequence && firstText ? startNamePattern(firstText.value, firstText.kind === "phrase" ? "phrase" : "text") : null;

  const scope = mode === "all" ? parsed.scope : null;

  return {
    mode,
    fuzzy,
    terms,
    positive,
    negative,
    ignored,
    scope,
    scopeColumns: scope ? [...GROUP_COLUMNS[scope]] : null,
    termCount,
    req,
    neg,
    contactBits,
    nonContact: 0x7ff & ~contactBits,
    deepBits,
    deepAny,
    positiveBits: positive.map((t) => t.bit),
    columns,
    exactName,
    phraseName,
    startName,
    fuzzyEligible: fuzzyCandidates > 0,
    highlight: highlightPatterns(positive, columns),
    score: scoreSpec({ positive, columns, exactName, phraseName, startName, req }),
    shortOnly: isShortOnly(positive),
    onlyExclusions: positive.length === 0 && negative.length > 0,
  };
}

/**
 * Les motifs de surlignage de chaque champ : pour chaque terme positif, le
 * motif le plus LARGE de ce champ (infixe avant début de mot avant mot
 * entier), plus le motif flou s'il existe. Téléphone et courriel n'en ont pas
 * (tests `LIKE` / égalité, et l'interface formate le numéro).
 */
function highlightPatterns(
  positive: readonly PlannedTerm[],
  columns: Readonly<Record<MaskColumn, ColumnPlan>>,
): Record<MatchField, HighlightPattern[]> {
  const out = Object.fromEntries(MATCH_FIELDS.map((f) => [f, [] as HighlightPattern[]])) as Record<
    MatchField,
    HighlightPattern[]
  >;
  // Colonnes par champ, de la moins payée (la plus large) à la mieux payée ; le flou à part.
  const byField = new Map<MatchField, MaskColumn[]>();
  for (const row of [...LEVELS].sort((a, b) => a.points - b.points)) {
    if (row.level === "fuzzy") continue;
    const list = byField.get(row.field) ?? [];
    list.push(row.column);
    byField.set(row.field, list);
  }
  for (const t of positive) {
    for (const field of MATCH_FIELDS) {
      const patterns: string[] = [];
      // Un terme n'a qu'UNE colonne d'adresse (texte ou code postal) : « la plus
      // large » vaut aussi pour elle.
      for (const c of byField.get(field) ?? []) {
        const e = columns[c].entries.find((x) => x.term === t.index);
        if (e?.op === "regex") {
          patterns.push(e.pattern);
          break;
        }
      }
      const fuzzyCol = field === "name" ? "name_f" : field === "city" ? "city_f" : null;
      const fz = fuzzyCol ? columns[fuzzyCol].entries.find((x) => x.term === t.index) : undefined;
      if (fz?.op === "regex") patterns.push(fz.pattern);
      for (const pattern of new Set(patterns)) {
        out[field].push({ term: t.index, bit: t.bit, pattern, contactKind: t.contactKind });
      }
    }
  }
  return out;
}

/** La part de `SearchMeta` que le plan connaît déjà (le serveur ajoute `approximate`, `degraded`, `facets`). */
export function searchMetaBase(
  plan: SearchPlan,
): Pick<SearchMeta, "terms" | "ignored" | "scope" | "match" | "shortOnly" | "onlyExclusions"> {
  return {
    terms: plan.terms.map((t) => ({ text: t.text, kind: t.kind, fields: t.fields, negated: t.negated })),
    ignored: plan.ignored,
    scope: plan.scope,
    match: plan.mode,
    shortOnly: plan.shortOnly,
    onlyExclusions: plan.onlyExclusions,
  };
}

/**
 * Les chaînes d'expression DISTINCTES que le statement enverra (entrées,
 * préfiltres de colonne, `deepAny`, bonus de nom). Postgres garde 32
 * expressions compilées par session : au-delà, chaque ligne recompilerait.
 */
export function regexStrings(plan: SearchPlan): string[] {
  const out = new Set<string>();
  for (const c of MASK_COLUMNS) {
    const col = plan.columns[c];
    for (const e of col.entries) if (e.op === "regex") out.add(e.pattern);
    if (col.any) out.add(col.any);
  }
  for (const p of [plan.deepAny, plan.exactName, plan.phraseName, plan.startName]) if (p) out.add(p);
  return [...out];
}
