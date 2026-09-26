import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { GROUP_COLUMNS, HISTORY_CTE } from "@/lib/clients-search/plan";
import { FICHE_COLUMNS, HISTORY_COLUMNS, LOCATION_COLUMNS, recencyCutoffs } from "@/lib/clients-search/score";
import {
  MASK_COLUMNS,
  type ColumnPlan,
  type HistoryColumn,
  type MaskColumn,
  type MaskEntry,
  type SearchPlan,
} from "@/lib/clients-search/types";
import { holderScopeCondition, type HolderScope } from "@/lib/permissions/server";
import { SORT_ALIASES, type ListSort, type SortDir } from "./order";

/**
 * Recherche de clients — le STATEMENT (§3.3) : UNE requête, de la visibilité
 * jusqu'à la page, avec le total et les facettes lus au même endroit.
 *
 * Règles d'écriture, toutes vérifiées par `unit-clients-search-statement` :
 * - `sql.raw` ne reçoit QUE des entiers venus du code (bits, points, longueurs)
 *   et des constantes SQL de ce fichier (alias de colonnes d'une liste fermée).
 *   Tout motif, toute valeur tapée est un paramètre lié.
 * - Les colonnes TYPÉES de drizzle (`clients.*`, dans `where` et les gardes)
 *   n'apparaissent que dans `vis`, dont le FROM est la table `clients` nue.
 *   Partout ailleurs, des alias bruts — le piège d'alias du constructeur
 *   relationnel (`notifications-rqb-alias-bug`) ne peut pas mordre ici, et le
 *   statement ne passe jamais par `db.query`.
 * - Les masques se construisent par `* 2^i` et chaque sous-expression binaire
 *   est parenthésée : en Postgres, `<<` et `|` ont la même priorité.
 * - Une date est liée en `${iso}::timestamptz`, un entier en `${n}::int`.
 */

export type StatementInput = {
  plan: SearchPlan;
  /** Filtres de la liste ET visibilité (`withVisibility`) — colonnes typées de `clients`. */
  where: SQL | undefined;
  /** Fiches où la case `visible && contact` est ouverte (`holderGrantScope`). */
  contact: HolderScope;
  /** Fiches où `visible && history` est ouverte — `none` en mode `identity`. */
  history: HolderScope;
  /** `history` + le droit `conversations.view` — sinon `none`. */
  thread: HolderScope;
  /** `false` = repli « fiche seule » : aucune CTE d'historique. */
  deep: boolean;
  sort: ListSort;
  dir: SortDir;
  limit: number;
  offset: number;
  /** Lié UNE fois par requête : seuils de fraîcheur du score. */
  now: Date;
};

/** Ce qu'une ligne du statement rend (le pilote peut rendre les entiers en chaîne). */
export type SearchRow = Record<string, unknown> & {
  total: number | string;
  n_all: number | string | null;
  n_contact: number | string | null;
  n_profile: number | string | null;
  n_notes: number | string | null;
  id: string | null;
};

// ── Fragments bruts, tous contrôlés ──────────────────────────────────────────

/** Un entier du code, rendu en clair. Tout autre chose lève : jamais de texte ici. */
function int(n: number): SQL {
  if (!Number.isSafeInteger(n)) throw new Error(`clients-search: entier attendu, reçu ${String(n)}`);
  return sql.raw(String(n));
}

const MASK_SET: ReadonlySet<string> = new Set(MASK_COLUMNS);
const ALIAS_RE = /^[a-z][a-z0-9_]*$/;

/** Un alias de colonne d'une liste fermée (masques, sources de `vis`, tris). */
function ident(name: string): SQL {
  if (!ALIAS_RE.test(name)) throw new Error(`clients-search: alias refusé (${name})`);
  return sql.raw(name);
}

/** `a.col` — alias de table et de colonne, tous deux constants. */
function ref(alias: string, column: string): SQL {
  return sql.join([ident(alias), ident(column)], sql.raw("."));
}

function mask(column: MaskColumn): SQL {
  if (!MASK_SET.has(column)) throw new Error(`clients-search: colonne inconnue (${column})`);
  return ident(column);
}

const orJoin = (parts: SQL[]) => sql.join(parts, sql` or `);
const commaJoin = (parts: SQL[]) => sql.join(parts, sql`, `);

/** Horodatage ISO 8601 en UTC, à la milliseconde — comme `Date#toISOString`. */
const ISO_FORMAT = sql.raw(`'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`);
function iso(expr: SQL): SQL {
  return sql`to_char(${expr} at time zone 'UTC', ${ISO_FORMAT})`;
}

/**
 * Un commentaire dont le texte cherché PEUT différer du texte stocké : une
 * note IA (en-tête) ou une mention. Les autres sont cherchés tels quels.
 */
const COMMENT_DIRTY = sql.raw(`(left(c.body, 1) = '🤖' or strpos(c.body, '@[') > 0)`);

/**
 * Un commentaire dont le nettoyage peut AJOUTER une correspondance : une
 * mention (`@[Josée](uuid) demain` → `@Josée demain` rapproche « josée » de
 * « demain »). L'en-tête IA, lui, ne fait que RETIRER un préfixe, suivi d'un
 * saut de ligne ou d'une espace : aucun motif (frontières = lettres et
 * chiffres) ne peut trouver dans le reste ce qu'il ne trouvait pas dans le
 * tout. Un commentaire sans mention dont le texte BRUT ne contient aucun motif
 * n'a donc pas besoin d'être nettoyé pour être écarté.
 */
const COMMENT_MAY_GAIN = sql.raw(`strpos(c.body, '@[') > 0`);

/**
 * Le texte CHERCHÉ d'un commentaire : sans l'en-tête des notes IA (sinon
 * « appel », « sortant », « septembre » trouveraient chaque note d'appel) et
 * avec les mentions réduites à `@Nom` (sinon l'uuid d'une mention ferait
 * trouver « café » ou « bébé »). MÊME texte que `normalizeStoredBody`
 * (snippet.ts) — vérifié par `int-clients-search-parity`.
 *
 * Chaque étape n'est payée que par les lignes qu'elle concerne, et sans
 * groupe de capture : `@\1` fait passer Postgres par son chemin lent (mesuré :
 * ×2 sur 50 000 mentions). `@[` → `@` par un simple `replace`, puis
 * `](uuid)` retiré. Même résultat pour toute mention écrite par l'application
 * (`toStoredBody` retire les crochets du nom). Seuls un « @[ » ou un
 * « ](uuid) » tapés à la main HORS d'une mention diffèrent de l'extrait : la
 * recherche y perd le « [ » (aucun motif n'y tient, sauf un courriel collé
 * dessus) ou l'uuid (jamais cherchable) — au pire un surlignage manquant.
 */
export const COMMENT_TEXT = sql.raw(String.raw`case when strpos(c.body, '@[') > 0 then
      regexp_replace(replace(
        case when left(c.body, 1) = '🤖' then regexp_replace(c.body, '^🤖 (?:Notes d''appel \(IA\)|AI call notes)[^\n]*\n+|^🤖 Assistant « [^»]* » : ', '') else c.body end,
        '@[', '@'), '\]\([0-9a-fA-F-]{36}\)', '', 'g')
    when left(c.body, 1) = '🤖' then
      regexp_replace(c.body, '^🤖 (?:Notes d''appel \(IA\)|AI call notes)[^\n]*\n+|^🤖 Assistant « [^»]* » : ', '')
    else c.body end`);

// ── Masques ──────────────────────────────────────────────────────────────────

/** Le test d'UNE entrée sur ses sources (OU entre les sources : téléphone et téléphone 2). */
function entryTest(e: MaskEntry, sources: readonly SQL[]): SQL {
  const one = (x: SQL): SQL => {
    switch (e.op) {
      case "regex":
        return sql`${x} ~* ${e.pattern}`;
      case "like":
        return sql`${x} like ${e.pattern}`;
      case "right-eq":
        return sql`right(${x}, ${int(e.length)}) = ${e.value}`;
      case "eq":
        return sql`${x} = ${e.value}`;
    }
  };
  const tests = sources.map(one);
  return tests.length === 1 ? tests[0] : sql`(${orJoin(tests)})`;
}

/** `((test)::int * bit) + …` — bits distincts dans une colonne : la somme EST le OU. */
function maskSum(entries: readonly MaskEntry[], sources: readonly SQL[]): SQL {
  return sql.join(
    entries.map((e) => sql`((${entryTest(e, sources)})::int * ${int(e.bit)})`),
    sql` + `,
  );
}

/**
 * Une colonne de la fiche. Une colonne regex à plusieurs entrées est gardée par
 * son préfiltre (`any`) : la plupart des fiches ne passent qu'un test. Sans
 * entrée : la constante `0`, sans paramètre.
 */
function ficheColumn(col: ColumnPlan, sources: readonly SQL[]): SQL {
  if (col.entries.length === 0) return sql`0`;
  const sum = maskSum(col.entries, sources);
  const allRegex = col.entries.every((e) => e.op === "regex");
  const single = col.entries.length === 1 && col.entries[0].op === "regex" && col.entries[0].pattern === col.any;
  if (!allRegex || !col.any || single) return sql`(${sum})`;
  const any = col.any;
  const pre = sources.length === 1 ? sql`${sources[0]} ~* ${any}` : sql`(${orJoin(sources.map((s) => sql`${s} ~* ${any}`))})`;
  return sql`(case when ${pre} then ${sum} else 0 end)`;
}

/** `((m & 1) <> 0)::int + …` — combien de termes positifs une ligne contient. */
function popcount(m: SQL, bits: readonly number[]): SQL {
  if (bits.length === 0) return sql`0`;
  return sql.join(
    bits.map((b) => sql`((${m} & ${int(b)}) <> 0)::int`),
    sql` + `,
  );
}

// ── Historique ───────────────────────────────────────────────────────────────

type HistorySource = {
  /** FROM de la source, sans `vis` (constante). */
  from: SQL;
  /** La fiche de la ligne (constante). */
  client: SQL;
  /** Le texte STOCKÉ (constante). */
  body: SQL;
  /**
   * Le texte CHERCHÉ quand il diffère du stocké (commentaires : `COMMENT_TEXT`,
   * sur `c.body`), avec quand il peut différer et quand il peut trouver plus.
   * Absent : le texte stocké est le texte cherché.
   */
  cleaned: { text: SQL; dirty: SQL; mayGain: SQL } | null;
  /** L'identifiant, la date et l'auteur de la ligne (constantes). */
  id: SQL;
  at: SQL;
  /** Condition supplémentaire (constante) ou `null`. */
  extra: SQL | null;
  /** La case de `vis` qui ouvre la source. */
  ok: "history_ok" | "thread_ok";
};

const HISTORY_SOURCES: Readonly<Record<HistoryColumn, HistorySource>> = {
  com_m: {
    from: sql`comments c`,
    client: sql`c.client_id`,
    body: sql`c.body`,
    cleaned: { text: COMMENT_TEXT, dirty: COMMENT_DIRTY, mayGain: COMMENT_MAY_GAIN },
    id: sql`c.id`,
    at: sql`c.created_at`,
    extra: null,
    ok: "history_ok",
  },
  fup_m: {
    from: sql`followups f`,
    client: sql`f.client_id`,
    body: sql`f.note`,
    cleaned: null,
    id: sql`f.id`,
    at: sql`f.created_at`,
    extra: null,
    ok: "history_ok",
  },
  call_m: {
    from: sql`calls k`,
    client: sql`k.client_id`,
    body: sql`k.note`,
    cleaned: null,
    id: sql`k.id`,
    at: sql`k.started_at`,
    extra: null,
    ok: "history_ok",
  },
  // SMS : ce que le client a écrit, et ce qu'une personne de l'équipe a écrit
  // à la main — jamais les gabarits (ouverture, échelle) ni l'agent, qui
  // feraient remonter toutes les fiches d'une campagne.
  sms_m: {
    from: sql`messages s join conversations cv on cv.id = s.conversation_id`,
    client: sql`cv.client_id`,
    body: sql`s.body`,
    cleaned: null,
    id: sql`s.id`,
    at: sql`s.created_at`,
    extra: sql`(s.direction = 'in' or s.source = 'human')`,
    ok: "thread_ok",
  },
};

/** La coupe `cb` d'une trace : une fiche aux coordonnées fermées perd ses bits de coordonnées. */
function contactCut(plan: SearchPlan, contactOk: SQL): SQL {
  return sql`(case when ${contactOk} then -1 else ${int(plan.nonContact)} end)`;
}

/**
 * Les bits d'une trace qui a DÉJÀ passé `text ~* any`. Une seule entrée dont
 * le motif EST `any` : le filtre l'a prouvée, son bit suffit — sinon chaque
 * trace trouvée repassait la même regex (un terme seul : le cas courant).
 */
function traceBits(plan: SearchPlan, column: HistoryColumn, text: SQL): SQL {
  const col = plan.columns[column];
  const [only] = col.entries;
  if (col.entries.length === 1 && only.op === "regex" && only.pattern === col.any) return int(only.bit);
  return sql`(${maskSum(col.entries, [text])})`;
}

/**
 * Les traces d'une source qui contiennent un motif : `id, client_id, at, m`
 * (`m` AVANT la coupe `cb`, que la CTE pose après sa jointure avec `vis`).
 *
 * `narrow` : les seules fiches où la case est ouverte, D'ABORD, derrière une
 * barrière (`offset 0`) — sinon le planificateur pousse la regex dans le
 * parcours de la table et l'applique aussi aux traces des fiches qu'on ne lit
 * pas. Mesuré (10 000 fiches, 130 000 commentaires, téléphoniste qui en lit
 * 37 %) : ×2,5 plus rapide. Sans objet quand on lit tout, sans filtre.
 *
 * Commentaires : le texte BRUT filtre d'abord (seule une mention, qui peut
 * trouver plus une fois nettoyée, passe sans lui) ; le nettoyage ne tourne
 * que sur ces lignes, une fois par ligne (`offset 0`) ; le texte nettoyé
 * tranche ensuite, et seulement là où il peut différer du brut (`dirty`).
 */
function traceRows(plan: SearchPlan, column: HistoryColumn, narrow: boolean): SQL {
  const src = HISTORY_SOURCES[column];
  const any = plan.columns[column].any;
  const conds: SQL[] = [];
  if (src.extra) conds.push(src.extra);
  if (narrow) conds.push(sql`${src.client} in (select v.id from vis v where ${ref("v", src.ok)})`);
  const where = conds.length > 0 ? sql` where ${sql.join(conds, sql` and `)}` : sql``;
  // Aliasée `c` : `COMMENT_TEXT` lit `c.body`.
  const rows = sql`(select ${src.id} id, ${src.client} client_id, ${src.at} at, ${src.body} body
        from ${src.from}${where}${narrow ? sql` offset 0` : sql``}) c`;
  if (!src.cleaned) {
    return sql`select c.id, c.client_id, c.at, ${traceBits(plan, column, sql`c.body`)} m
      from ${rows}
      where c.body ~* ${any}
      offset 0`;
  }
  return sql`select c.id, c.client_id, c.at, ${traceBits(plan, column, sql`c.h`)} m
      from (
        select c.id, c.client_id, c.at, ${src.cleaned.text} h, ${src.cleaned.dirty} dirty
        from ${rows}
        where ${src.cleaned.mayGain} or c.body ~* ${any}
        offset 0
      ) c
      where not c.dirty or c.h ~* ${any}
      offset 0`;
}

/**
 * Une CTE d'historique : une ligne par fiche, avec
 * - `m` : le OU des masques des traces (déjà coupés par `cb` : un terme de
 *   coordonnées ne touche jamais la trace d'une fiche aux coordonnées fermées) ;
 * - `n`, `at`, `full_row`, `ids` : calculés SEULEMENT sur les traces qui
 *   contiennent un terme POSITIF. Une trace trouvée par une exclusion seule ne
 *   doit ni rajeunir ni « approfondir » la fiche ; son bit d'exclusion reste
 *   dans `m`, où il sert. `ids` : les traces candidates à l'extrait — la page
 *   les relit par clé primaire (`followups` n'a pas d'index sur `client_id`).
 *
 * Que des agrégats sans ORDER BY : Postgres peut hacher au lieu de trier. La
 * trace MONTRÉE (la meilleure) n'est cherchée qu'après le LIMIT, pour les
 * seules fiches de la page (`bestTrace`) — un `array_agg(… order by …)` ici
 * faisait un tri par fiche, soit 10 000 tris pour une recherche courante
 * (mesuré : 2,6 s sur 100 000 commentaires, contre 0,3 s sans).
 *
 * Les masques sont calculés dans `traceRows`, sous `offset 0` : UNE fois par
 * trace (sans barrière, le planificateur recopiait `m <> 0` dans le filtre de
 * jointure et évaluait chaque motif deux fois), et le texte ne traverse pas la
 * jointure — seuls l'id, la fiche, la date et le masque.
 */
function historyCte(plan: SearchPlan, column: HistoryColumn, narrow: boolean): SQL {
  const src = HISTORY_SOURCES[column];
  const req = int(plan.req);
  const positive = sql`(r.m & ${req}) <> 0`;
  return sql`${ident(HISTORY_CTE[column])} as (
    select r.client_id,
      bit_or(r.m) m,
      (count(*) filter (where ${positive}))::int n,
      max(r.at) filter (where ${positive}) at,
      coalesce(bool_or((r.m & ${req}) = ${req}), false) full_row,
      array_agg(r.id) filter (where ${positive}) ids
    from (
      select v.id client_id, t.id, t.at, (t.m & ${contactCut(plan, sql`v.contact_ok`)}) m
      from (
      ${traceRows(plan, column, narrow)}
      ) t
      join vis v on v.id = t.client_id and ${ref("v", src.ok)}
    ) r
    where r.m <> 0
    group by r.client_id
  )`;
}

/**
 * La trace à montrer pour UNE fiche de la page : celle qui contient le plus
 * de termes positifs, puis la plus récente, puis le plus petit id — sous les
 * mêmes cases que la CTE (`pg.<ok>` et `pg.<col> <> 0`, déjà coupés). Les
 * seules traces relues sont celles de `ids` (clé primaire) : le nettoyage d'un
 * commentaire ne coûte ici que pour elles.
 */
function bestTrace(plan: SearchPlan, column: HistoryColumn, alias: string, cols: SQL): SQL {
  const src = HISTORY_SOURCES[column];
  const req = int(plan.req);
  const text = src.cleaned ? sql`n.h` : src.body;
  const cleaned = src.cleaned ? sql` cross join lateral (select ${src.cleaned.text} h offset 0) n` : sql``;
  const found = sql`${text} ~* ${plan.columns[column].any}`;
  return sql`left join lateral (
    select ${cols}
    from ${src.from}${cleaned}
    cross join lateral (select (${traceBits(plan, column, text)} & ${contactCut(plan, sql`pg.contact_ok`)}) m offset 0) mm
    where ${ref("pg", src.ok)} and ${ref("pg", column)} <> 0
      and ${src.id} = any(${ref("pg", `${column.slice(0, -2)}_ids`)}) and ${src.client} = pg.id
      and ${src.extra ? sql`${src.extra} and ${found}` : found} and (mm.m & ${req}) <> 0
    order by ${popcount(sql`mm.m`, plan.positiveBits)} desc, ${src.at} desc, ${src.id}
    limit 1
  ) ${ident(alias)} on true`;
}

// ── Score (§4), généré du barème en données ──────────────────────────────────

function scoreSql(plan: SearchPlan, now: Date): SQL {
  const spec = plan.score;
  const parts: SQL[] = spec.terms.map((t) =>
    t.columns.length === 0
      ? sql`0`
      : sql`greatest(0, ${commaJoin(
          t.columns.map(
            (c) => sql`case when (s.${mask(c.column)} & ${int(t.bit)}) <> 0 then ${int(c.points)} else 0 end`,
          ),
        )})`,
  );
  const bonus = (flag: string, points: number | null) => {
    if (points !== null) parts.push(sql`case when s.${ident(flag)} then ${int(points)} else 0 end`);
  };
  bonus("name_exact", spec.nameExact);
  bonus("name_phrase", spec.namePhrase);
  bonus("name_start", spec.nameStart);
  bonus("same_record", spec.sameRecord);
  bonus("same_address", spec.sameAddress);

  const cuts = recencyCutoffs(now);
  const tiers = spec.history.recency.map(
    (tier, i) => sql`when s.hist_at >= ${cuts[i].toISOString()}::timestamptz then ${int(tier.points)}`,
  );
  const recency = tiers.length > 0 ? sql`(case ${sql.join(tiers, sql` `)} else 0 end)` : sql`0`;
  parts.push(sql`case when ((s.hist_m & ${int(spec.history.req)}) & (~ s.fiche_m)) <> 0 then
      ${recency} + least(${int(spec.history.depthMax)}, ${int(spec.history.depthPer)} * greatest(0, s.hist_n - 1))
    else 0 end`);
  return sql`(${sql.join(parts, sql` + `)})`;
}

// ── Tri ──────────────────────────────────────────────────────────────────────

/** Liste blanche fixe ; `id` toujours en dernier pour une pagination stable. */
function orderSql(alias: string, sort: ListSort, dir: SortDir): SQL {
  const id = sql`${ref(alias, "id")} asc`;
  switch (sort) {
    case "relevance":
      return sql`${ref(alias, "score")} desc, ${ref(alias, "act")} desc, ${id}`;
    case "activity":
      return sql`${ref(alias, "act")} desc, ${id}`;
    default: {
      const col = ref(alias, SORT_ALIASES[sort]);
      // Colonnes nullables : NULLS LAST dans les deux sens (même règle que la
      // liste sans recherche).
      return dir === "asc" ? sql`${col} asc, ${id}` : sql`${col} desc nulls last, ${id}`;
    }
  }
}

// ── Le statement ─────────────────────────────────────────────────────────────

/** Les CTE d'historique que ce statement générera — `[]` en identité ou en repli. */
export function historyCtes(input: Pick<StatementInput, "plan" | "history" | "thread" | "deep">): HistoryColumn[] {
  const { plan } = input;
  if (!input.deep || plan.mode !== "all" || plan.deepBits === 0 || input.history.kind === "none") return [];
  return HISTORY_COLUMNS.filter((c) => {
    const col = plan.columns[c];
    if (col.entries.length === 0 || !col.any) return false;
    return c !== "sms_m" || input.thread.kind !== "none";
  });
}

export function buildSearchStatement(input: StatementInput): SQL {
  const { plan } = input;
  if (plan.termCount === 0) throw new Error("clients-search: aucun terme positif — aucune requête à écrire");
  if (!Number.isSafeInteger(input.limit) || !Number.isSafeInteger(input.offset)) {
    throw new Error("clients-search: limit / offset invalides");
  }

  const deep = historyCtes(input);
  const needThread = deep.includes("sms_m");
  // Le fil SMS s'ouvre SOUS la case `history` (portée `thread` = portée
  // `history` + un droit) : `sms:mot` seul doit encore rendre la vraie case
  // `history_ok`, sinon `mapRow` jette la raison et l'extrait SMS.
  const needHistory = deep.some((c) => c !== "sms_m") || needThread;
  const contactOpenAnywhere = input.contact.kind !== "none";

  // ── vis : les fiches visibles, et les cases par fiche ──────────────────────
  const gate = (scope: HolderScope, needed: boolean): SQL => {
    if (!needed || scope.kind === "none") return sql`false`;
    const cond = holderScopeCondition(scope);
    return cond ? sql`coalesce((${cond}), false)` : sql`true`;
  };
  const vis = sql`vis as materialized (
    select clients.id, clients.assigned_to_id,
      coalesce(clients.full_name, '') name_t,
      coalesce(clients.city, '') city_t,
      coalesce(clients.address, '') addr_t,
      coalesce(clients.notes, '') notes_t,
      concat_ws(' · ', clients.project_type, clients.timing, clients.budget) proj_t,
      coalesce(clients.phone, '') phone_t,
      coalesce(clients.phone_alt, '') phone2_t,
      lower(coalesce(clients.email, '')) email_t,
      clients.full_name s_name, clients.city s_city, clients.created_at s_created, clients.updated_at s_updated,
      clients.next_followup_at s_followup, clients.last_contacted_at s_lastcontact,
      greatest(coalesce(clients.last_contacted_at, to_timestamp(0)), clients.updated_at) act,
      ${gate(input.contact, true)} contact_ok,
      ${gate(input.history, needHistory)} history_ok,
      ${gate(input.thread, needThread)} thread_ok
    from clients
    where ${input.where ?? sql`true`}
  )`;

  // ── hit : les colonnes de la fiche ─────────────────────────────────────────
  const hitCols: SQL[] = [];
  for (const c of FICHE_COLUMNS) {
    const col = plan.columns[c];
    const sources = col.sources.map((s) => ref("v", s));
    if (col.gate === "contact") {
      const body = contactOpenAnywhere && col.entries.length > 0 ? ficheColumn(col, sources) : null;
      hitCols.push(body ? sql`(case when v.contact_ok then ${body} else 0 end) ${mask(c)}` : sql`0 ${mask(c)}`);
    } else {
      hitCols.push(sql`${ficheColumn(col, sources)} ${mask(c)}`);
    }
  }
  const nameBonus = (pattern: string | null, alias: string) =>
    pattern ? sql`(v.name_t ~* ${pattern}) ${ident(alias)}` : sql`false ${ident(alias)}`;
  const hit = sql`hit as (
    select v.*,
      (case when v.contact_ok then -1 else ${int(plan.nonContact)} end) cb,
      ${commaJoin(hitCols)},
      ${nameBonus(plan.exactName, "name_exact")},
      ${nameBonus(plan.phraseName, "name_phrase")},
      ${nameBonus(plan.startName, "name_start")}
    from vis v
  )`;

  // ── feat : les masques COUPÉS par les cases de chaque fiche ────────────────
  const featCols: SQL[] = [];
  for (const c of FICHE_COLUMNS) {
    featCols.push(
      plan.columns[c].gate === "contact" ? sql`h.${mask(c)}` : sql`(h.${mask(c)} & h.cb) ${mask(c)}`,
    );
  }
  const joins: SQL[] = [];
  for (const c of HISTORY_COLUMNS) {
    const cte = HISTORY_CTE[c];
    const p = c.slice(0, -2); // com_m → com
    if (deep.includes(c)) {
      const ok = c === "sms_m" ? sql`h.thread_ok` : sql`h.history_ok`;
      featCols.push(
        sql`case when ${ok} then (coalesce(${ref(cte, "m")}, 0) & h.cb) else 0 end ${mask(c)}`,
        sql`${ref(cte, "n")} ${ident(`${p}_n`)}`,
        sql`${ref(cte, "at")} ${ident(`${p}_at`)}`,
        sql`${ref(cte, "full_row")} ${ident(`${p}_full`)}`,
        sql`${ref(cte, "ids")} ${ident(`${p}_ids`)}`,
      );
      joins.push(sql`left join ${ident(cte)} on ${ref(cte, "client_id")} = h.id`);
    } else {
      featCols.push(
        sql`0 ${mask(c)}`,
        sql`0 ${ident(`${p}_n`)}`,
        sql`null::timestamptz ${ident(`${p}_at`)}`,
        sql`false ${ident(`${p}_full`)}`,
        sql`null::uuid[] ${ident(`${p}_ids`)}`,
      );
    }
  }
  const feat = sql`feat as (
    select h.id, h.act, h.contact_ok, h.history_ok, h.thread_ok,
      h.s_name, h.s_city, h.s_created, h.s_updated, h.s_followup, h.s_lastcontact,
      ${commaJoin(featCols)},
      h.name_exact, h.name_phrase, h.name_start
    from hit h
    ${sql.join(joins, sql` `)}
  )`;

  // ── cand : fiche, historique, « même trace » ───────────────────────────────
  const req = int(plan.req);
  const ficheOr = sql.join(
    FICHE_COLUMNS.map((c) => sql`f.${mask(c)}`),
    sql` | `,
  );
  const histOr = sql.join(
    HISTORY_COLUMNS.map((c) => sql`f.${mask(c)}`),
    sql` | `,
  );
  const hp = (c: HistoryColumn) => c.slice(0, -2);
  const histAt = sql`greatest(${commaJoin(
    HISTORY_COLUMNS.map((c) => sql`case when f.${mask(c)} <> 0 then f.${ident(`${hp(c)}_at`)} end`),
  )})`;
  const histN = sql.join(
    HISTORY_COLUMNS.map((c) => sql`(case when f.${mask(c)} <> 0 then f.${ident(`${hp(c)}_n`)} else 0 end)`),
    sql` + `,
  );
  const sameRecord =
    plan.termCount >= 2
      ? sql`coalesce(((f.notes_m & ${req}) = ${req}) or ${orJoin(
          HISTORY_COLUMNS.map((c) => sql`(f.${mask(c)} <> 0 and f.${ident(`${hp(c)}_full`)})`),
        )}, false)`
      : sql`false`;
  // « Toute l'adresse » : chaque terme dans le lieu de la fiche (masques déjà
  // coupés par `cb`, comme ceux du score). Constante quand le barème n'a pas le
  // bonus — le drapeau et les points viennent du MÊME `ScoreSpec`.
  const sameAddress =
    plan.score.sameAddress !== null
      ? sql`(((${sql.join(
          LOCATION_COLUMNS.map((c) => sql`f.${mask(c)}`),
          sql` | `,
        )}) & ${req}) = ${req})`
      : sql`false`;
  const cand = sql`cand as (
    select f.*,
      (${ficheOr}) fiche_m,
      (${histOr}) hist_m,
      ${histAt} hist_at,
      (${histN}) hist_n,
      ${sameRecord} same_record,
      ${sameAddress} same_address
    from feat f
  )`;

  // ── matched : ET entre les termes, aucune exclusion ────────────────────────
  const neg = plan.neg !== 0 ? sql` and ((c.fiche_m | c.hist_m) & ${int(plan.neg)}) = 0` : sql``;
  const matched = sql`matched as materialized (
    select * from cand c
    where ((c.fiche_m | c.hist_m) & ${req}) = ${req}${neg}
  )`;

  // ── facets (mode all) : lues AVANT la portée — les puces montrent l'ailleurs ──
  const groupCovers = (columns: readonly MaskColumn[]) =>
    sql`((${sql.join(
      columns.map((c) => sql`c.${mask(c)}`),
      sql` | `,
    )}) & ${req}) = ${req}`;
  const facets =
    plan.mode === "all"
      ? sql`facets as (
    select count(*)::int n_all,
      (count(*) filter (where ${groupCovers(GROUP_COLUMNS.contact)}))::int n_contact,
      (count(*) filter (where ${groupCovers(GROUP_COLUMNS.profile)}))::int n_profile,
      (count(*) filter (where ${groupCovers(GROUP_COLUMNS.notes)}))::int n_notes
    from matched c
  )`
      : sql`facets as (select null::int n_all, null::int n_contact, null::int n_profile, null::int n_notes)`;

  const scoped = plan.scopeColumns
    ? sql`scoped as (select * from matched c where ${groupCovers(plan.scopeColumns)})`
    : sql`scoped as (select * from matched c)`;

  const scored = sql`scored as (select s.*, ${scoreSql(plan, input.now)} score from scoped s)`;

  // ── la page : LIMIT d'abord, les textes des extraits ensuite ───────────────
  const pageMasks = commaJoin(MASK_COLUMNS.map((c) => sql`pg.${mask(c)}`));
  const has = (c: HistoryColumn) => deep.includes(c);
  const pageCols = sql`pg.id, pg.score, pg.act, pg.s_name, pg.s_city, pg.s_created, pg.s_updated,
      pg.s_followup, pg.s_lastcontact, pg.contact_ok, pg.history_ok, pg.thread_ok,
      ${pageMasks},
      pg.name_exact, pg.name_phrase, pg.name_start, pg.same_record, pg.same_address, pg.hist_n,
      ${iso(sql`pg.hist_at`)} hist_at,
      cl.full_name,
      case when pg.contact_ok then cl.phone end phone,
      case when pg.contact_ok then cl.email end email,
      cl.category_id, cat.color category_color, cl.source_id, cl.assigned_to_id, cl.do_not_call, cl.city,
      ${iso(sql`cl.next_followup_at`)} next_followup_at,
      ${iso(sql`cl.last_contacted_at`)} last_contacted_at,
      ${iso(sql`cl.created_at`)} created_at,
      ${iso(sql`cl.updated_at`)} updated_at,
      case when pg.notes_m <> 0 then left(cl.notes, 4000) end notes_text,
      case when (pg.addr_m | pg.addr_pc) <> 0 then left(cl.address, 500) end address_text,
      case when pg.proj_m <> 0 then concat_ws(' · ', cl.project_type, cl.timing, cl.budget) end project_text,
      ${has("com_m") ? sql`sc.id com_id, left(sc.body, 4000) com_text, ${iso(sql`sc.created_at`)} com_at_iso, uc.name com_author` : sql`null::uuid com_id, null::text com_text, null::text com_at_iso, null::text com_author`},
      ${has("fup_m") ? sql`left(sf.note, 4000) fup_text, ${iso(sql`sf.created_at`)} fup_at_iso` : sql`null::text fup_text, null::text fup_at_iso`},
      ${has("call_m") ? sql`left(sk.note, 4000) call_text, ${iso(sql`sk.started_at`)} call_at_iso, uk.name call_author` : sql`null::text call_text, null::text call_at_iso, null::text call_author`},
      ${has("sms_m") ? sql`left(ss.body, 1000) sms_text, ${iso(sql`ss.created_at`)} sms_at_iso` : sql`null::text sms_text, null::text sms_at_iso`}`;
  const pageJoins: SQL[] = [];
  if (has("com_m")) {
    pageJoins.push(
      bestTrace(plan, "com_m", "sc", sql`c.id, c.body, c.created_at, c.user_id`),
      sql`left join users uc on uc.id = sc.user_id`,
    );
  }
  if (has("fup_m")) pageJoins.push(bestTrace(plan, "fup_m", "sf", sql`f.note, f.created_at`));
  if (has("call_m")) {
    pageJoins.push(
      bestTrace(plan, "call_m", "sk", sql`k.note, k.started_at, k.user_id`),
      sql`left join users uk on uk.id = sk.user_id`,
    );
  }
  if (has("sms_m")) pageJoins.push(bestTrace(plan, "sms_m", "ss", sql`s.body, s.created_at`));

  // Les traces des fiches lues d'abord, sauf quand on lit TOUT sans filtre
  // (l'administrateur) : la semi-jointure n'écarterait rien et coûterait
  // (mesuré : +80 ms sur 130 000 commentaires).
  const narrow = (c: HistoryColumn) =>
    (c === "sms_m" ? input.thread : input.history).kind !== "all" || input.where !== undefined;
  const ctes = [vis, ...deep.map((c) => historyCte(plan, c, narrow(c))), hit, feat, cand, matched, facets, scoped, scored];

  return sql`with
  ${commaJoin(ctes)}
select t.total, fc.n_all, fc.n_contact, fc.n_profile, fc.n_notes, p.*
from (select count(*)::int total from scored) t
cross join facets fc
left join lateral (
  select ${pageCols}
  from (select * from scored s order by ${orderSql("s", input.sort, input.dir)} limit ${input.limit}::int offset ${input.offset}::int) pg
  join clients cl on cl.id = pg.id
  left join categories cat on cat.id = cl.category_id
  ${sql.join(pageJoins, sql` `)}
) p on true
order by ${orderSql("p", input.sort, input.dir)}`;
}
