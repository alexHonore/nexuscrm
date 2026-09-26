/**
 * Recherche de clients — le vocabulaire commun.
 *
 * Module PUR (ni `next-intl`, ni `server-only`, ni base, ni React) : le moteur
 * serveur, la palette ⌘K et le panneau `/clients` partagent ces types. Les
 * constantes d'ici sont des DONNÉES (listes fermées), jamais des motifs : les
 * motifs à lookbehind ne sont compilés que côté serveur (`pattern.ts`).
 */

/** Un champ où un terme peut être trouvé. */
export type MatchField =
  | "name"
  | "phone"
  | "email"
  | "city"
  | "address"
  | "project"
  | "notes"
  | "comment"
  | "followup"
  | "call"
  | "sms";

export const MATCH_FIELDS = [
  "name",
  "phone",
  "email",
  "city",
  "address",
  "project",
  "notes",
  "comment",
  "followup",
  "call",
  "sms",
] as const satisfies readonly MatchField[];

/** Les trois familles de la palette (puces de portée, facettes). */
export type MatchGroup = "contact" | "profile" | "notes";

export const MATCH_GROUPS = ["contact", "profile", "notes"] as const satisfies readonly MatchGroup[];

/** name/phone/email → contact ; city/address/project → profile ; le reste → notes. */
export const FIELD_GROUP: Record<MatchField, MatchGroup> = {
  name: "contact",
  phone: "contact",
  email: "contact",
  city: "profile",
  address: "profile",
  project: "profile",
  notes: "notes",
  comment: "notes",
  followup: "notes",
  call: "notes",
  sms: "notes",
};

/** Les champs dont un extrait (« snippet ») peut être montré sous la ligne. */
export type SnippetField = "notes" | "address" | "project" | "comment" | "followup" | "call" | "sms";

/** D'où vient un texte d'historique : humain, note IA (🤖) ou journal de rendez-vous. */
export type SnippetOrigin = "human" | "ai" | "booking";

/**
 * La nature d'un terme, qui décide des champs qu'il peut toucher (§2.4) :
 * - `text` : un mot (ou un mot entre guillemets) ;
 * - `phrase` : plusieurs mots entre guillemets ;
 * - `digits` : 3 chiffres ou plus (séparateurs de téléphone tolérés) ;
 * - `email` : contient `@` ;
 * - `postal` : code postal canadien (`G1V 4M3`, `g1v-4m3`, `g1v4m3`).
 */
export type TermKind = "text" | "phrase" | "digits" | "email" | "postal";

/** Le NIVEAU d'une correspondance, qui fixe ses points (`LEVELS`, `score.ts`). */
export type Level = "whole" | "prefix" | "infix" | "fuzzy" | "exact" | "suffix" | "text" | "postal" | "match";

/** `identity` : nom, ville, téléphone, courriel (dialogue de campagne). `all` : tout ce que la fiche montre. */
export type SearchMode = "identity" | "all";

/**
 * Une colonne-masque du statement : un entier dont le bit `2^i` dit « le terme
 * i est trouvé ici ». Liste FERMÉE — une colonne par ligne de `LEVELS`.
 */
export type MaskColumn =
  | "name_x"
  | "name_w"
  | "name_i"
  | "name_f"
  | "ph_x"
  | "ph_s"
  | "ph_i"
  | "ph_p"
  | "em_x"
  | "em_p"
  | "em_i"
  | "em_t"
  | "city_x"
  | "city_w"
  | "city_i"
  | "city_f"
  | "addr_pc"
  | "addr_m"
  | "notes_m"
  | "proj_m"
  | "com_m"
  | "fup_m"
  | "call_m"
  | "sms_m";

export const MASK_COLUMNS = [
  "name_x",
  "name_w",
  "name_i",
  "name_f",
  "ph_x",
  "ph_s",
  "ph_i",
  "ph_p",
  "em_x",
  "em_p",
  "em_i",
  "em_t",
  "city_x",
  "city_w",
  "city_i",
  "city_f",
  "addr_pc",
  "addr_m",
  "notes_m",
  "proj_m",
  "com_m",
  "fup_m",
  "call_m",
  "sms_m",
] as const satisfies readonly MaskColumn[];

/** Les quatre colonnes nourries par une CTE d'historique (`cm`, `fu`, `ca`, `sm`). */
export type HistoryColumn = "com_m" | "fup_m" | "call_m" | "sms_m";

/**
 * Le droit qui ouvre une colonne, fiche par fiche :
 * - `visible` : champ de la fiche, masqué par `cb` (un terme de coordonnées ne
 *   touche jamais une fiche dont la case `contact` est fermée) ;
 * - `contact` : téléphone / courriel, `0` quand `contact_ok` est faux ;
 * - `history` : commentaires, suivis, notes d'appel — `history_ok`, puis `& cb` ;
 * - `thread` : SMS — `thread_ok` (history + `conversations.view`), puis `& cb`.
 */
export type ColumnGate = "visible" | "contact" | "history" | "thread";

/** Une ligne de la table des niveaux (`LEVELS`). */
export type LevelRow = { column: MaskColumn; field: MatchField; level: Level; points: number };

// ─── Requête analysée (`query.ts`) ─────────────────────────────────────────────

/** Un terme de la requête, tel que `parseSearchQuery` l'a compris. */
export type SearchTerm = {
  kind: TermKind;
  /** Ce que la personne a tapé, sans `-`, sans `op:` ni guillemets — pour l'afficher (« Ignorés », « Chercher seulement »). */
  text: string;
  /** La tranche EXACTE de `ParsedQuery.source` (avec `-`, `op:`, guillemets) — pour réécrire la requête. */
  raw: string;
  /** [début, fin) de `raw` dans `ParsedQuery.source` (offsets UTF-16). */
  span: [number, number];
  /**
   * La valeur dont les motifs sont construits :
   * - text / phrase : `foldSearch` (phrase : espaces simples entre les mots) ;
   * - digits : les chiffres seuls (règle des 11 chiffres appliquée) ;
   * - email : en minuscules, NON plié ;
   * - postal : `g1v4m3` (minuscules, sans séparateur).
   */
  value: string;
  /** Les champs imposés par un opérateur (`ville:`, `note:`…) ; `null` = aucun opérateur. */
  fields: MatchField[] | null;
  negated: boolean;
  /** Tapé entre guillemets (un mot seul entre guillemets reste un `text`, exempté des mots vides). */
  quoted: boolean;
};

/** Le résultat de `parseSearchQuery(raw)`. */
export type ParsedQuery = {
  /** La requête après NFKC, `trim` et coupe à 200 caractères — référentiel de tous les `span`. */
  source: string;
  /** Termes à trouver, dans l'ordre tapé (au plus 5). */
  positive: SearchTerm[];
  /** Termes à exclure (`-mot`), dans l'ordre tapé (au plus 3). */
  negative: SearchTerm[];
  /** Morceaux mis de côté, tels que tapés (mots vides, lettres seules, dépassements, portée invalide…). */
  ignored: string[];
  /** Portée `dans:` / `in:` — la dernière gagne. */
  scope: MatchGroup | null;
  /**
   * Les mots en texte libre, pliés, dans l'ordre tapé — mots vides compris,
   * sans les exclusions ni les termes à opérateur. Sert SEULEMENT aux bonus de
   * nom (exact, expression, début).
   */
  sequence: string[];
  /** Tous les termes positifs sont des mots de 1–2 lettres. */
  shortOnly: boolean;
  /** Aucun terme positif mais au moins une exclusion. */
  onlyExclusions: boolean;
};

// ─── Plan (`plan.ts`) : de quoi générer le statement §3.3 sans rien redériver ──

/**
 * Une contribution à une colonne-masque : « si ce test réussit, ajouter `bit` ».
 *
 * `bit` est la VALEUR du bit (1, 2, 4… pour les termes positifs 0..4 ; 256,
 * 512, 1024 pour les exclusions 0..2), à émettre avec `sql.raw(String(bit))`.
 * `pattern` / `value` sont des TEXTES DE L'UTILISATEUR : toujours des
 * paramètres liés (`${…}`), jamais `sql.raw`.
 *
 * Traduction SQL (colonne source `X` — voir `ColumnPlan.sources`) :
 * - `regex`    → `(X ~* ${pattern})::int * «bit»`
 * - `like`     → `(X like ${pattern})::int * «bit»` — `pattern` contient déjà
 *                ses `%` et l'échappement `\` (`escapeLike`)
 * - `right-eq` → `(right(X, «length») = ${value})::int * «bit»`
 * - `eq`       → `(X = ${value})::int * «bit»`
 *
 * Quand une colonne a DEUX sources (téléphone : `phone_t`, `phone2_t`), le test
 * est le OU des deux : `(right(v.phone_t,«n»)=${d} or right(v.phone2_t,«n»)=${d})`.
 */
export type MaskEntry =
  | {
      op: "regex";
      bit: number;
      /** Index du terme dans `SearchPlan.terms`. */
      term: number;
      pattern: string;
      /**
       * Motif moins cher, IMPLIQUÉ par `pattern` (tout texte qui satisfait
       * `pattern` satisfait `prefilter`) — seulement pour le flou ; `null` sinon.
       */
      prefilter: string | null;
    }
  | { op: "like"; bit: number; term: number; pattern: string }
  | { op: "right-eq"; bit: number; term: number; value: string; length: number }
  | { op: "eq"; bit: number; term: number; value: string };

/**
 * Ce qu'une colonne-masque calcule. Une colonne sans entrée est la constante
 * `0` (et n'a aucun paramètre).
 *
 * SQL d'une colonne `regex` (fiche) :
 * `case when X ~* ${any} then «Σ (X ~* ${p})::int * bit» else 0 end`
 * (avec une seule entrée, l'enveloppe `case` est redondante et peut sauter).
 * Les colonnes `like` / `right-eq` / `eq` n'ont pas de préfiltre : `any` est `null`.
 */
export type ColumnPlan = {
  column: MaskColumn;
  field: MatchField;
  gate: ColumnGate;
  /**
   * Les alias de `vis` lus par la colonne (`["name_t"]`, `["phone_t","phone2_t"]`…).
   * Vide pour une colonne d'historique : sa source est le texte de sa CTE
   * (`HISTORY_CTE`) — `COMMENT_TEXT(c.body)`, `f.note`, `k.note`, `s.body`.
   */
  sources: readonly string[];
  entries: MaskEntry[];
  /**
   * Préfiltre de la colonne : l'alternance `(?:p1)|(?:p2)…` des entrées regex
   * (le `prefilter` d'une entrée floue remplace son motif) ; avec UNE seule
   * entrée non floue, c'est son motif lui-même (même chaîne = même entrée du
   * cache d'expressions de Postgres, 32 par session). Pour une colonne
   * d'historique, c'est le `where … ~* ${any}` de SA CTE. `null` sans entrée regex.
   */
  any: string | null;
};

/** Un terme retenu par le plan, avec son bit. */
export type PlannedTerm = SearchTerm & {
  /** Index dans `SearchPlan.terms` (positifs 0..k-1, puis exclusions). */
  index: number;
  /** Valeur du bit : `1<<i` pour le positif i, `1<<(8+j)` pour l'exclusion j. */
  bit: number;
  /** Terme « de coordonnées » : courriel, ou 7 chiffres et plus. */
  contactKind: boolean;
  /** Les colonnes où ce terme a au moins une entrée (ordre de `MASK_COLUMNS`). */
  columns: MaskColumn[];
};

/** Un motif de surlignage (serveur seulement : il peut contenir un lookbehind). */
export type HighlightPattern = {
  /** Index du terme dans `SearchPlan.terms` — pour compter les termes DISTINCTS d'une fenêtre. */
  term: number;
  bit: number;
  pattern: string;
  /** À sauter quand la case `contact` de la fiche est fermée. */
  contactKind: boolean;
};

/**
 * Le score décrit comme des DONNÉES — le builder SQL en génère l'arithmétique,
 * `scoreFeatures` l'applique en TS ; la parité SQL = TS en dépend.
 *
 * SQL (tout en entiers) :
 * ```
 *   Σ_terms greatest(0, case when (s.<col> & «bit») <> 0 then «points» else 0 end, …)
 * + case when s.name_exact then «nameExact» else 0 end          -- si non null
 * + case when s.name_phrase then «namePhrase» else 0 end        -- si non null
 * + case when s.name_start then «nameStart» else 0 end          -- si non null
 * + case when s.same_record then «sameRecord» else 0 end        -- si non null
 * + case when s.same_address then «sameAddress» else 0 end      -- si non null
 * + case when (s.hist_m & «req» & ~s.fiche_m) <> 0 then
 *       (case when s.hist_at >= ${cut[0]}::timestamptz then «points[0]»
 *             when s.hist_at >= ${cut[1]}::timestamptz then «points[1]» else 0 end)
 *     + least(«depthMax», «depthPer» * greatest(0, s.hist_n - 1))
 *   else 0 end
 * ```
 * où `cut[i] = recencyCutoffs(now)[i]` (`score.ts`), `now` lié UNE fois par requête.
 */
export type ScoreSpec = {
  /** Un élément par terme POSITIF : ses colonnes possibles, points décroissants. */
  terms: { term: number; bit: number; columns: { column: MaskColumn; points: number }[] }[];
  /** Points du bonus, ou `null` quand le motif correspondant est absent du plan. */
  nameExact: number | null;
  namePhrase: number | null;
  nameStart: number | null;
  /** `null` quand k < 2 (le bonus n'existe pas). */
  sameRecord: number | null;
  /**
   * « Toute l'adresse » : k ≥ 2 et un terme positif est un NUMÉRO CIVIQUE qui lit
   * l'adresse (`412 rue tremblay`) — `null` sinon. Le drapeau SQL `same_address`
   * dit que TOUS les termes tombent dans le lieu de la fiche (`LOCATION_COLUMNS`).
   */
  sameAddress: number | null;
  history: {
    /** Le REQ du plan : l'historique « porte » la fiche quand `(hist_m & req & ~fiche_m) <> 0`. */
    req: number;
    /** Paliers de fraîcheur, du plus récent au plus ancien ; le premier atteint gagne. */
    recency: { days: number; points: number }[];
    depthPer: number;
    depthMax: number;
  };
};

/**
 * Le plan d'une requête — tout ce qu'il faut pour écrire le statement §3.3
 * SANS rien redériver, et pour relire ses lignes.
 */
export type SearchPlan = {
  mode: SearchMode;
  /** Les colonnes `name_f` / `city_f` sont remplies (relance « faute de frappe »). */
  fuzzy: boolean;
  /** Positifs (bits 1,2,4…) puis exclusions (bits 256,512,1024). */
  terms: PlannedTerm[];
  positive: PlannedTerm[];
  negative: PlannedTerm[];
  /** `ParsedQuery.ignored` + les termes que l'intersection opérateur × mode a vidés. */
  ignored: string[];
  /** Portée effective — toujours `null` en mode `identity`. */
  scope: MatchGroup | null;
  /** Colonnes dont le OU doit couvrir REQ quand une portée est posée (`scoped`). */
  scopeColumns: MaskColumn[] | null;
  /** k = nombre de termes positifs. */
  termCount: number;
  /** `(1<<k)-1`. */
  req: number;
  /** OU des bits d'exclusion (0 sans exclusion). */
  neg: number;
  /** Bits des termes de coordonnées (positifs ET exclusions). */
  contactBits: number;
  /** `0x7FF & ~contactBits` — la valeur de `cb` quand `contact_ok` est faux. */
  nonContact: number;
  /** Bits (positifs et exclusions) présents sur au moins une colonne d'historique ; 0 en `identity`. */
  deepBits: number;
  /** Alternance de TOUS les motifs d'historique (exclusions comprises) ; `null` sans historique. */
  deepAny: string | null;
  /** Bits des termes positifs, croissants — pour `POP(m)`. */
  positiveBits: number[];
  /** Chaque colonne-masque, dans l'ordre de `MASK_COLUMNS`. */
  columns: Record<MaskColumn, ColumnPlan>;
  /** `name_t ~* exactName` → bonus `nameExact` ; `null` = constante `false`. */
  exactName: string | null;
  phraseName: string | null;
  startName: string | null;
  /** Une relance floue pourrait aider (mode `all`, un terme éligible au moins) — indépendant de `fuzzy`. */
  fuzzyEligible: boolean;
  /** Motifs de surlignage par champ (termes positifs seulement ; vide pour phone/email). */
  highlight: Record<MatchField, HighlightPattern[]>;
  score: ScoreSpec;
  shortOnly: boolean;
  onlyExclusions: boolean;
};

// ─── Lignes et réponse ─────────────────────────────────────────────────────────

/** Ce qu'une ligne du statement dit d'une fiche — entrée de `scoreFeatures` et `matchReasons`. */
export type MatchFeatures = {
  /** k (termes positifs) — les bits au-delà ne comptent jamais. */
  termCount: number;
  /** Les colonnes-masques de `feat` (déjà masquées par `cb` et les gardes). */
  masks: Record<MaskColumn, number>;
  nameExact: boolean;
  namePhrase: boolean;
  nameStart: boolean;
  /** `same_record` du statement (k ≥ 2 déjà vérifié en SQL). */
  sameRecord: boolean;
  /** `same_address` du statement : tous les termes dans le lieu, numéro civique compris. */
  sameAddress: boolean;
  /** `hist_at` : la trace d'historique correspondante la plus récente. */
  histAt: Date | string | null;
  /** `hist_n` : nombre de traces d'historique correspondantes. */
  histN: number;
};

export type MatchReason = { field: MatchField; level: Level; terms: number[] };

export type ClientMatch = {
  score: number;
  /** Niveau gagnant par terme, regroupé par champ, points décroissants. */
  reasons: MatchReason[];
  /** Offsets UTF-16 dans `fullName` / `city`. */
  nameRanges: [number, number][];
  cityRanges: [number, number][];
  snippet: null | {
    field: SnippetField;
    text: string;
    ranges: [number, number][];
    clippedStart: boolean;
    clippedEnd: boolean;
    origin: SnippetOrigin;
    at: string | null;
    author: string | null;
    commentId: string | null;
  };
  href: string;
};

export type SearchMeta = {
  terms: { text: string; kind: TermKind; fields: MatchField[] | null; negated: boolean }[];
  ignored: string[];
  scope: MatchGroup | null;
  match: SearchMode;
  approximate: boolean;
  degraded: null | "timeout" | "busy";
  shortOnly: boolean;
  onlyExclusions: boolean;
  facets: null | { all: number; contact: number; profile: number; notes: number };
};
