import "server-only";
import { sql, type SQL } from "drizzle-orm";
import { db } from "@/db";
import { planSearch, searchMetaBase } from "@/lib/clients-search/plan";
import { parseSearchQuery } from "@/lib/clients-search/query";
import { featuresFromRow, matchReasons } from "@/lib/clients-search/score";
import {
  buildSnippet,
  coveredBits,
  highlightRanges,
  normalizeStoredBody,
  pickSnippetSource,
  redactContact,
  type NormalizedBody,
} from "@/lib/clients-search/snippet";
import type {
  ClientMatch,
  HighlightPattern,
  MatchFeatures,
  MatchField,
  SearchMeta,
  SearchMode,
  SearchPlan,
  SnippetField,
} from "@/lib/clients-search/types";
import {
  holderGrants,
  holderGrantScope,
  withVisibility,
  type Actor,
  type HolderGrants,
  type HolderScope,
} from "@/lib/permissions/server";
import { acquireDeep, DEEP_WAIT_MS, type Acquire } from "./limiter";
import type { ListSort, SortDir } from "./order";
import { buildSearchStatement, historyCtes, type SearchRow } from "./statement";

/**
 * Recherche de clients — l'EXÉCUTION (§3.4) et la relecture des lignes (§3.5).
 *
 * `searchClients` pose les cases (coordonnées, historique, fil SMS) détenteur
 * par détenteur, écrit UN statement, le lance sous un plafond de temps et de
 * concurrence, retente une fois « faute de frappe » quand rien n'est trouvé,
 * puis relit chaque ligne en revérifiant les cases côté TypeScript : ce qui
 * sort d'ici a passé deux gardes, la SQL et celle-ci.
 */

/** Plafond d'une recherche profonde : au-delà, repli « fiche seule ». */
export const DEEP_TIMEOUT_MS = 3000;

/** Le code Postgres d'une requête annulée — ici, par `statement_timeout`. */
const QUERY_CANCELED = "57014";

export type SearchInput = {
  q: string;
  /** Les filtres de la liste (catégorie, source, campagne, dates…) — SANS la visibilité. */
  filters: SQL | undefined;
  mode: SearchMode;
  sort: ListSort;
  dir: SortDir;
  page: number;
  pageSize: number;
  signal?: AbortSignal;
  /** Pour les tests ; sinon l'heure de la requête. */
  now?: Date;
};

/** Qui exécute : la base par défaut, un double dans les tests. */
export type SearchExecutor = {
  /** Un statement seul, hors transaction (identité, fiche seule). */
  run(stmt: SQL): Promise<SearchRow[]>;
  /** Une transaction dont chaque statement est borné à `timeoutMs`. */
  withTimeout<T>(timeoutMs: number, fn: (run: (stmt: SQL) => Promise<SearchRow[]>) => Promise<T>): Promise<T>;
};

export type SearchDeps = { executor: SearchExecutor; acquire: Acquire };

const dbExecutor: SearchExecutor = {
  run: async (stmt) => Array.from(await db.execute<SearchRow>(stmt)),
  withTimeout: (timeoutMs, fn) =>
    db.transaction(async (tx) => {
      // `true` = local à la transaction : la connexion rend son réglage au pool.
      await tx.execute(sql`select set_config('statement_timeout', ${String(timeoutMs)}, true)`);
      return fn(async (stmt) => Array.from(await tx.execute<SearchRow>(stmt)));
    }),
};

const DEFAULT_DEPS: SearchDeps = { executor: dbExecutor, acquire: acquireDeep };

/** Une ligne de la liste — la forme d'aujourd'hui, plus `match`. */
export type SearchListItem = {
  id: string;
  fullName: string;
  phone: string | null;
  email: string | null;
  contactHidden: boolean;
  categoryId: number | null;
  categoryColor: string | null;
  sourceId: number | null;
  assignedToId: string | null;
  nextFollowupAt: string | null;
  lastContactedAt: string | null;
  doNotCall: boolean;
  city: string | null;
  createdAt: string;
  updatedAt: string;
  match: ClientMatch;
};

export type SearchHit = {
  item: SearchListItem;
  /** Interne : ne quitte jamais le serveur (test de parité du score seulement). */
  features: MatchFeatures;
};

export type SearchOutcome = {
  hits: SearchHit[];
  total: number;
  meta: SearchMeta;
  /** Le plan des lignes rendues (strict, ou flou quand `meta.approximate`). */
  plan: SearchPlan;
  now: Date;
};

const NONE: HolderScope = { kind: "none" };

/** Le code SQLSTATE d'une erreur — drizzle enveloppe l'erreur du pilote (`DrizzleQueryError.cause`). */
export function isStatementTimeout(e: unknown): boolean {
  const codeOf = (x: unknown): unknown =>
    x !== null && typeof x === "object" && "code" in x ? (x as { code?: unknown }).code : undefined;
  if (codeOf(e) === QUERY_CANCELED) return true;
  const cause = e !== null && typeof e === "object" && "cause" in e ? (e as { cause?: unknown }).cause : undefined;
  return codeOf(cause) === QUERY_CANCELED;
}

const num = (v: unknown): number => {
  const n = Number(v ?? 0);
  return Number.isFinite(n) ? n : 0;
};
const numOrNull = (v: unknown): number | null => (v === null || v === undefined ? null : num(v));
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);

export async function searchClients(
  actor: Actor,
  input: SearchInput,
  deps: SearchDeps = DEFAULT_DEPS,
): Promise<SearchOutcome> {
  const now = input.now ?? new Date();
  const parsed = parseSearchQuery(input.q);
  const strict = planSearch(parsed, { mode: input.mode });
  const meta: SearchMeta = { ...searchMetaBase(strict), approximate: false, degraded: null, facets: null };
  const empty = (): SearchOutcome => ({ hits: [], total: 0, meta, plan: strict, now });

  // Rien à trouver (« -mot » seul, mots vides…) : aucune requête. Personne
  // n'attend plus la réponse (frappe suivante, palette fermée) : non plus.
  const aborted = () => input.signal?.aborted === true;
  if (strict.termCount === 0 || aborted()) return empty();

  // ── Les cases, détenteur par détenteur ─────────────────────────────────────
  const [of, where] = await Promise.all([holderGrants(actor), withVisibility(actor, input.filters)]);
  const contact = await holderGrantScope(actor, (g) => g.visible && g.contact, of);
  const history = input.mode === "all" ? await holderGrantScope(actor, (g) => g.visible && g.history, of) : NONE;
  const thread = input.mode === "all" && actor.can("conversations.view") ? history : NONE;

  const pageSize = input.pageSize;
  const offset = (input.page - 1) * pageSize;
  const statement = (plan: SearchPlan, deep: boolean) =>
    buildSearchStatement({
      plan,
      where,
      contact,
      history,
      thread,
      deep,
      sort: input.sort,
      dir: input.dir,
      limit: pageSize,
      offset,
      now,
    });
  const totalOf = (rows: readonly SearchRow[]) => (rows.length > 0 ? num(rows[0].total) : 0);

  /**
   * La relance « faute de frappe » : jamais en identité, jamais après un
   * repli, et pas sous `dans:notes` — le flou ne lit que le nom et la ville,
   * que cette portée écarte de toute façon.
   */
  const fuzzyPlan = (): SearchPlan | null =>
    input.mode === "all" && strict.fuzzyEligible && strict.scope !== "notes"
      ? planSearch(parsed, { mode: "all", fuzzy: true })
      : null;

  let rows: SearchRow[];
  let plan = strict;
  const deep = historyCtes({ plan: strict, history, thread, deep: true }).length > 0;

  if (!deep) {
    // Identité, ou rien à lire dans l'historique : un seul aller-retour.
    rows = await deps.executor.run(statement(strict, false));
    const fz = totalOf(rows) === 0 && !aborted() ? fuzzyPlan() : null;
    if (fz) {
      const retry = await deps.executor.run(statement(fz, false));
      if (totalOf(retry) > 0) {
        rows = retry;
        plan = fz;
        meta.approximate = true;
      }
    }
  } else {
    if (aborted()) return empty();
    const release = await deps.acquire(DEEP_WAIT_MS);
    // L'attente peut durer 750 ms : assez pour que la frappe suivante annule
    // celle-ci. Une recherche morte qui garderait sa place tiendrait une
    // connexion jusqu'à 3 s et pousserait la recherche VIVANTE vers « busy ».
    if (aborted()) {
      release?.();
      return empty();
    }
    if (!release) {
      meta.degraded = "busy";
      rows = await deps.executor.run(statement(strict, false));
    } else {
      let deepRows: SearchRow[] | null = null;
      try {
        deepRows = await deps.executor.withTimeout(DEEP_TIMEOUT_MS, (run) => run(statement(strict, true)));
        const fz = totalOf(deepRows) === 0 && !aborted() ? fuzzyPlan() : null;
        if (fz) {
          // Même place au robinet. Une relance trop lente n'efface pas le
          // résultat strict (complet, et vide) : on le garde tel quel.
          try {
            const retry = await deps.executor.withTimeout(DEEP_TIMEOUT_MS, (run) => run(statement(fz, true)));
            if (totalOf(retry) > 0) {
              deepRows = retry;
              plan = fz;
              meta.approximate = true;
            }
          } catch (e) {
            if (!isStatementTimeout(e)) throw e;
          }
        }
      } catch (e) {
        if (!isStatementTimeout(e)) throw e;
        deepRows = null;
      } finally {
        release();
      }
      if (deepRows) {
        rows = deepRows;
      } else {
        // Même règle après 3 s perdues : personne n'attend plus le repli.
        if (aborted()) return empty();
        meta.degraded = "timeout";
        rows = await deps.executor.run(statement(strict, false));
      }
    }
  }

  const first = rows[0];
  const total = totalOf(rows);
  if (plan.mode === "all" && first && first.n_all !== null && first.n_all !== undefined) {
    meta.facets = {
      all: num(first.n_all),
      contact: num(first.n_contact),
      profile: num(first.n_profile),
      notes: num(first.n_notes),
    };
  }

  const canThread = actor.can("conversations.view");
  const hits = rows.filter((r) => typeof r.id === "string").map((r) => mapRow(r, plan, of, canThread));
  return { hits, total, meta, plan, now };
}

/** `left(body, 4000)` a pu couper une mention : jamais un bout d'uuid à l'écran. */
function dropCutMention(text: string, cap: number): string {
  if (Array.from(text).length < cap) return text;
  return text.replace(/@\[[^\]\n]*(?:\]\([0-9a-fA-F-]*)?$/, "");
}

type Candidate = {
  field: SnippetField;
  mask: number;
  text: string;
  body: NormalizedBody;
  at: string | null;
  author: string | null;
  commentId: string | null;
};

/**
 * Une ligne SQL → une ligne de liste. Seconde garde : les cases sont relues
 * pour CE détenteur ; une colonne que la SQL aurait laissé passer à tort ne
 * sortirait toujours pas (raisons, extrait, coordonnées).
 */
function mapRow(r: SearchRow, plan: SearchPlan, of: HolderGrants, canThread: boolean): SearchHit {
  const id = r.id as string;
  const assignedToId = str(r.assigned_to_id);
  const g = of(assignedToId);
  const contactOpen = g.visible && g.contact && r.contact_ok === true;
  const historyOpen = g.visible && g.history && r.history_ok === true;
  const smsOpen = historyOpen && canThread && r.thread_ok === true;

  const features = featuresFromRow(r, plan.termCount);
  const allowed = (field: MatchField): boolean => {
    switch (field) {
      case "phone":
      case "email":
        return contactOpen;
      case "comment":
      case "followup":
      case "call":
        return historyOpen;
      case "sms":
        return smsOpen;
      default:
        return true;
    }
  };
  const patterns = (field: MatchField): HighlightPattern[] =>
    plan.highlight[field].filter((p) => contactOpen || !p.contactKind);

  const fullName = str(r.full_name) ?? "";
  const city = str(r.city);

  // ── L'extrait ──────────────────────────────────────────────────────────────
  const cands: Candidate[] = [];
  const add = (
    field: SnippetField,
    mask: number,
    raw: unknown,
    extra: { at?: unknown; author?: unknown; commentId?: unknown; cap?: number } = {},
  ) => {
    const text = str(raw);
    if (!text || mask === 0) return;
    let body = normalizeStoredBody(extra.cap ? dropCutMention(text, extra.cap) : text);
    if (!contactOpen) body = redactContact(body);
    if (!body.text) return;
    cands.push({
      field,
      mask,
      text: body.text,
      body,
      at: str(extra.at),
      author: str(extra.author),
      commentId: str(extra.commentId),
    });
  };
  const m = features.masks;
  add("notes", m.notes_m, r.notes_text);
  add("address", m.addr_m | m.addr_pc, r.address_text);
  add("project", m.proj_m, r.project_text);
  if (historyOpen) {
    add("comment", m.com_m, r.com_text, { at: r.com_at_iso, author: r.com_author, commentId: r.com_id, cap: 4000 });
    add("followup", m.fup_m, r.fup_text, { at: r.fup_at_iso });
    add("call", m.call_m, r.call_text, { at: r.call_at_iso, author: r.call_author });
  }
  if (smsOpen) add("sms", m.sms_m, r.sms_text, { at: r.sms_at_iso });

  const source = pickSnippetSource(cands, { req: plan.req, covered: coveredBits(m, contactOpen) });
  let snippet: ClientMatch["snippet"] = null;
  if (source) {
    const built = buildSnippet(source.text, patterns(source.field), { atomic: source.body.mentions });
    snippet = {
      field: source.field,
      text: built.text,
      ranges: built.ranges,
      clippedStart: built.clippedStart,
      clippedEnd: built.clippedEnd,
      origin: source.body.origin,
      at: source.at,
      author: source.author,
      commentId: source.field === "comment" ? source.commentId : null,
    };
  }

  const match: ClientMatch = {
    score: num(r.score),
    reasons: matchReasons(features).filter((reason) => allowed(reason.field)),
    nameRanges: highlightRanges(fullName, patterns("name")),
    cityRanges: city ? highlightRanges(city, patterns("city")) : [],
    snippet,
    href: snippet?.commentId ? `/clients/${id}#comment-${snippet.commentId}` : `/clients/${id}`,
  };

  const item: SearchListItem = {
    id,
    fullName,
    phone: contactOpen ? str(r.phone) : null,
    email: contactOpen ? str(r.email) : null,
    contactHidden: !contactOpen,
    categoryId: numOrNull(r.category_id),
    categoryColor: str(r.category_color),
    sourceId: numOrNull(r.source_id),
    assignedToId,
    nextFollowupAt: str(r.next_followup_at),
    lastContactedAt: str(r.last_contacted_at),
    doNotCall: r.do_not_call === true,
    city,
    createdAt: str(r.created_at) ?? "",
    updatedAt: str(r.updated_at) ?? "",
    match,
  };
  return { item, features };
}

/**
 * La réponse de `GET /api/clients/list` quand `q` est posé : la forme
 * d'aujourd'hui (`items`, `total`, `page`, `pageSize`), plus `items[].match`
 * et `search`. Les `features` restent ici.
 */
export async function listSearchResponse(
  actor: Actor,
  input: SearchInput,
  deps: SearchDeps = DEFAULT_DEPS,
): Promise<{ items: SearchListItem[]; total: number; page: number; pageSize: number; search: SearchMeta }> {
  const out = await searchClients(actor, input, deps);
  return {
    items: out.hits.map((h) => h.item),
    total: out.total,
    page: input.page,
    pageSize: input.pageSize,
    search: out.meta,
  };
}
