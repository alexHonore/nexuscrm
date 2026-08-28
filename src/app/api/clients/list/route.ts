import {
  addDays,
  endOfMonth,
  endOfWeek,
  format,
  isValid,
  parseISO,
  startOfMonth,
  startOfWeek,
  subDays,
} from "date-fns";
import { fromZonedTime, toZonedTime } from "date-fns-tz";
import {
  and,
  asc,
  desc,
  eq,
  gte,
  ilike,
  inArray,
  isNotNull,
  isNull,
  like,
  lt,
  lte,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { clients } from "@/db/schema";
import { bucketFor, grantsFor } from "@/lib/permissions/access";
import type { Grants } from "@/lib/permissions/catalog";
import { apiActor, loadDirectory, withVisibility } from "@/lib/permissions/server";
import { APP_TZ, torontoDayRange } from "@/components/clients/timezone";

const MAX_PAGE_SIZE = 50;
/** Au-delà, l'OFFSET dépasse ce que le pilote sérialise proprement (500) — on borne. */
const MAX_PAGE = 1_000_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Identifiant int4 (catégorie, source) : un id hors plage ferait planter Postgres. */
const INT4_MAX = 2_147_483_647;
const INT4_RE = /^[1-9]\d{0,9}$/;

/** « Aucun » explicite pour categoryId / sourceId / assignedToId. */
const NONE = "none";

/** États de suivi acceptés pour `filter`. */
const FILTERS = new Set(["overdue", "today", "upcoming", "none", "never", "dnc"]);

/** Découpe un paramètre multi-valeurs « a,b,c » — jetons inconnus ignorés. */
function tokens(raw: string): string[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 50);
}

/** Jetons qui sont des ids int4 valides — les autres sont ignorés, pas refusés. */
function int4Ids(list: string[]): number[] {
  return list
    .filter((v) => INT4_RE.test(v))
    .map(Number)
    .filter((n) => n <= INT4_MAX);
}

// Bornes des filtres de dates (yyyy-mm-dd), interprétées en heure de Toronto —
// même convention que l'export admin. Valeur invalide : filtre ignoré.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** La regex ne vérifie que la forme : « 2026-02-30 » donne une Invalid Date
 *  (truthy !) qui ferait planter le driver Postgres — on la rejette ici. */
function validDate(d: Date): Date | undefined {
  return Number.isNaN(d.getTime()) ? undefined : d;
}

/** yyyy-mm-dd de forme valide ET existant au calendrier, sinon undefined. */
function calendarDay(raw: string | null): string | undefined {
  return raw && DATE_RE.test(raw) && isValid(parseISO(raw)) ? raw : undefined;
}

function torontoStart(raw: string | null): Date | undefined {
  return raw && DATE_RE.test(raw)
    ? validDate(fromZonedTime(`${raw}T00:00:00`, APP_TZ))
    : undefined;
}

function torontoEnd(raw: string | null): Date | undefined {
  return raw && DATE_RE.test(raw)
    ? validDate(fromZonedTime(`${raw}T23:59:59.999`, APP_TZ))
    : undefined;
}

// ── Fenêtres nommées et bornes strictes (« avant le / après le ») ────────────
// Résolues CÔTÉ SERVEUR à chaque requête : un « aujourd'hui » enregistré dans
// une vue reste vrai demain, et un onglet ouvert à cheval sur minuit se
// rafraîchit correctement au prochain sondage.

const WITHIN = new Set(["today", "yesterday", "week", "month"]);

/** Minuit (heure de Toronto) du jour civil donné, en instant UTC. */
function torontoMidnight(day: Date): Date {
  return fromZonedTime(`${format(day, "yyyy-MM-dd")}T00:00:00`, APP_TZ);
}

/**
 * Fenêtre [start, end) d'un raccourci de période, calculée dans le calendrier
 * de Toronto. Semaine du lundi au dimanche (convention d'affaires).
 */
function torontoWindow(name: string, now: Date): { start: Date; end: Date } | undefined {
  if (!WITHIN.has(name)) return undefined;
  const zoned = toZonedTime(now, APP_TZ);
  switch (name) {
    case "today":
      return { start: torontoMidnight(zoned), end: torontoMidnight(addDays(zoned, 1)) };
    case "yesterday":
      return { start: torontoMidnight(subDays(zoned, 1)), end: torontoMidnight(zoned) };
    case "week": {
      const first = startOfWeek(zoned, { weekStartsOn: 1 });
      const last = endOfWeek(zoned, { weekStartsOn: 1 });
      return { start: torontoMidnight(first), end: torontoMidnight(addDays(last, 1)) };
    }
    default: {
      const first = startOfMonth(zoned);
      const last = endOfMonth(zoned);
      return { start: torontoMidnight(first), end: torontoMidnight(addDays(last, 1)) };
    }
  }
}

/** Strictement avant le jour J (Toronto) : instant-limite exclusif. */
function torontoBefore(raw: string | null): Date | undefined {
  const day = calendarDay(raw);
  return day ? validDate(fromZonedTime(`${day}T00:00:00`, APP_TZ)) : undefined;
}

/** Strictement après le jour J (Toronto) : premier instant du jour J+1. */
function torontoAfter(raw: string | null): Date | undefined {
  const day = calendarDay(raw);
  if (!day) return undefined;
  const next = format(addDays(parseISO(day), 1), "yyyy-MM-dd");
  return validDate(fromZonedTime(`${next}T00:00:00`, APP_TZ));
}

/** Tris acceptés — `activity` reproduit l'ordre historique du panneau. */
const SORT_COLUMNS = {
  name: clients.fullName,
  city: clients.city,
  createdAt: clients.createdAt,
  updatedAt: clients.updatedAt,
  followupAt: clients.nextFollowupAt,
  lastContact: clients.lastContactedAt,
} as const;

type SortKey = keyof typeof SORT_COLUMNS;

/**
 * GET /api/clients/list — paginated rows for the /clients left panel and the
 * table view. Every filter param accepts a comma-separated list (OR within
 * the param, AND across params); a single value still works. Params:
 * - q (name, email, phone, city)
 * - categoryId / sourceId / assignedToId — ids and/or "none" for unset
 * - filter — overdue | today | upcoming | none (no follow-up) | never
 *   (never contacted) | dnc (do-not-call list), combinable
 * - language — fr | en
 * - createdFrom / createdTo, updatedFrom / updatedTo — yyyy-mm-dd, bornes
 *   inclusives en heure de Toronto (création / dernière modification)
 * - createdWithin / updatedWithin — today | yesterday | week | month,
 *   fenêtre résolue à la requête dans le calendrier de Toronto
 * - createdBefore / createdAfter, updatedBefore / updatedAfter — yyyy-mm-dd,
 *   strictement avant / après ce jour (Toronto)
 * - sort (activity | name | city | createdAt | updatedAt | followupAt |
 *   lastContact), dir (asc|desc), page, pageSize (capped at 50).
 * Ordered by recent activity by default.
 *
 * La PORTÉE du regard s'ajoute à tout : filtres et compte total lisent le même
 * `where`, et une ligne dont le compartiment ferme les coordonnées repart avec
 * `phone: null, email: null, contactHidden: true`.
 */
export async function GET(req: NextRequest) {
  const actor = await apiActor();
  if (actor instanceof NextResponse) return actor;

  const sp = req.nextUrl.searchParams;
  const q = (sp.get("q") ?? "").trim().slice(0, 200);
  const categoryParam = sp.get("categoryId") ?? "";
  const sourceParam = sp.get("sourceId") ?? "";
  const assignedParam = sp.get("assignedToId") ?? "";
  const filterParam = sp.get("filter") ?? "";
  const languageParam = sp.get("language") ?? "";
  const sortParam = sp.get("sort") ?? "activity";
  const sort: SortKey | "activity" =
    sortParam in SORT_COLUMNS ? (sortParam as SortKey) : "activity";
  const dir = sp.get("dir") === "asc" ? "asc" : "desc";
  const page = Math.min(MAX_PAGE, Math.max(1, Number.parseInt(sp.get("page") ?? "", 10) || 1));
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Number.parseInt(sp.get("pageSize") ?? "", 10) || MAX_PAGE_SIZE),
  );

  // ── Ce que ce regard a le droit de lire ───────────────────────────────────
  // Le compartiment d'une fiche ne dépend que de son DÉTENTEUR : on le résout
  // une fois par détenteur et non une fois par ligne — une page de 50 fiches
  // ne coûte donc pas 50 questions de plus à la matrice.
  const { cfg, roleOf, rows: accounts } = await loadDirectory();
  const grantsCache = new Map<string, Grants>();
  const grantsOfHolder = (assignedToId: string | null): Grants => {
    const key = assignedToId ?? "";
    const hit = grantsCache.get(key);
    if (hit) return hit;
    const holder = assignedToId ? (roleOf.get(assignedToId) ?? null) : null;
    const g = grantsFor(cfg, actor.role, bucketFor(actor.user.id, { assignedToId }, holder));
    grantsCache.set(key, g);
    return g;
  };

  // Chercher « 5145551234 » et voir une fiche remonter DIT le numéro : la
  // recherche ne compare téléphone et courriel que sur les fiches dont le
  // compartiment ouvre les coordonnées. Le nom et la ville restent cherchables
  // partout — c'est ce qui permet de ne pas rappeler un lead déjà pris.
  const contactHolders = accounts.filter((a) => grantsOfHolder(a.id).contact).map((a) => a.id);
  const contactOpen: SQL | undefined =
    grantsOfHolder(null).contact && contactHolders.length === accounts.length
      ? undefined
      : (() => {
          const parts: SQL[] = [];
          if (grantsOfHolder(null).contact) parts.push(isNull(clients.assignedToId));
          if (contactHolders.length > 0) parts.push(inArray(clients.assignedToId, contactHolders));
          if (parts.length === 0) return sql`false`;
          return parts.length === 1 ? parts[0] : or(...parts)!;
        })();

  const now = new Date();
  const conditions: SQL[] = [];

  /** OU entre les branches d'un même paramètre (ET entre paramètres). */
  const pushOr = (...parts: Array<SQL | undefined>) => {
    const kept = parts.filter((p): p is SQL => p !== undefined);
    if (kept.length === 1) conditions.push(kept[0]);
    else if (kept.length > 1) conditions.push(or(...kept)!);
  };

  if (q) {
    const digits = q.replace(/\D/g, "");
    const openMatchers = [ilike(clients.fullName, `%${q}%`), ilike(clients.city, `%${q}%`)];
    const contactMatchers = [
      ilike(clients.email, `%${q}%`),
      ...(digits.length >= 3
        ? [like(clients.phone, `%${digits}%`), like(clients.phoneAlt, `%${digits}%`)]
        : []),
    ];
    const guardedContact = or(...contactMatchers)!;
    const merged = or(
      ...openMatchers,
      contactOpen ? and(contactOpen, guardedContact)! : guardedContact,
    );
    if (merged) conditions.push(merged);
  }

  const catTokens = tokens(categoryParam);
  const catIds = int4Ids(catTokens);
  pushOr(
    catIds.length > 0 ? inArray(clients.categoryId, catIds) : undefined,
    catTokens.includes(NONE) ? isNull(clients.categoryId) : undefined,
  );

  const srcTokens = tokens(sourceParam);
  const srcIds = int4Ids(srcTokens);
  pushOr(
    srcIds.length > 0 ? inArray(clients.sourceId, srcIds) : undefined,
    srcTokens.includes(NONE) ? isNull(clients.sourceId) : undefined,
  );

  const userTokens = tokens(assignedParam);
  const userIds = userTokens.filter((v) => UUID_RE.test(v));
  pushOr(
    userIds.length > 0 ? inArray(clients.assignedToId, userIds) : undefined,
    userTokens.includes(NONE) ? isNull(clients.assignedToId) : undefined,
  );

  const langs = tokens(languageParam).filter((l) => l === "fr" || l === "en");
  if (langs.length > 0) conditions.push(inArray(clients.language, langs));

  // Filtre par CAMPAGNE affiliée : « qui est dans telle campagne », et
  // « qui n'est dans aucune ». N'importe quel statut d'inscription compte —
  // terminée, arrêtée, écartée : la question posée est l'appartenance, pas
  // l'activité. Sans ça, une fiche sortie d'une campagne disparaîtrait du
  // filtre alors qu'elle en a bel et bien fait partie.
  const campaignTokens = tokens(sp.get("campaignId") ?? "");
  const campaignIds = campaignTokens.filter((v) => UUID_RE.test(v));
  pushOr(
    campaignIds.length > 0
      ? sql`exists (select 1 from campaign_enrollments
          where client_id = ${clients.id} and campaign_id in ${campaignIds})`
      : undefined,
    campaignTokens.includes(NONE)
      ? sql`not exists (select 1 from campaign_enrollments where client_id = ${clients.id})`
      : undefined,
  );

  // « Ajouter des clients » d'une campagne : écarte ceux qui y sont DÉJÀ
  // inscrits — n'importe quel statut, car l'index unique (campagne, client)
  // rend toute ré-inscription impossible ; les proposer ne ferait que gonfler
  // « ignorés » au moment d'ajouter. Même règle que l'audience programmée
  // (campaigns-server/audience.ts).
  const excludeCampaignId = sp.get("excludeCampaignId");
  if (excludeCampaignId && UUID_RE.test(excludeCampaignId)) {
    conditions.push(
      sql`not exists (select 1 from campaign_enrollments
        where campaign_id = ${excludeCampaignId} and client_id = ${clients.id})`,
    );
  }

  // Filtres de dates : mêmes options pour la création et la modification —
  // fenêtre nommée (createdWithin), borne stricte (createdBefore/After) ou
  // plage inclusive libre (createdFrom/To).
  for (const [prefix, column] of [
    ["created", clients.createdAt],
    ["updated", clients.updatedAt],
  ] as const) {
    const win = torontoWindow(sp.get(`${prefix}Within`) ?? "", now);
    if (win) {
      conditions.push(gte(column, win.start), lt(column, win.end));
    }
    const before = torontoBefore(sp.get(`${prefix}Before`));
    if (before) conditions.push(lt(column, before));
    const after = torontoAfter(sp.get(`${prefix}After`));
    if (after) conditions.push(gte(column, after));
    const from = torontoStart(sp.get(`${prefix}From`));
    if (from) conditions.push(gte(column, from));
    const to = torontoEnd(sp.get(`${prefix}To`));
    if (to) conditions.push(lte(column, to));
  }

  /** Condition d'UN état de suivi — les états cochés se cumulent en OU. */
  const followupState = (state: string): SQL | undefined => {
    switch (state) {
      case "overdue":
        return and(isNotNull(clients.nextFollowupAt), lt(clients.nextFollowupAt, now));
      case "today": {
        const { start, end } = torontoDayRange(now);
        return and(gte(clients.nextFollowupAt, start), lt(clients.nextFollowupAt, end));
      }
      case "upcoming":
        return gte(clients.nextFollowupAt, now);
      case "none":
        return isNull(clients.nextFollowupAt);
      case "never":
        return isNull(clients.lastContactedAt);
      case "dnc":
        return eq(clients.doNotCall, true);
      default:
        return undefined;
    }
  };
  pushOr(...tokens(filterParam).filter((f) => FILTERS.has(f)).map(followupState));

  // La visibilité s'ajoute EN DERNIER et ne se négocie pas : un filtre reçu du
  // client (assignedToId = le patron, par exemple) ne peut que rétrécir ce que
  // la portée autorise déjà. Le compte total lit le MÊME `where` — un total non
  // filtré serait à lui seul une fuite : il dirait combien de fiches on cache.
  const where = await withVisibility(actor, conditions.length > 0 ? and(...conditions) : undefined);

  // Activité récente par défaut (même tri que l'ancienne liste) ; la vue
  // tableau peut trier par nom / ville / dates / suivi / dernier contact.
  // Colonnes nullables : NULLS LAST dans les deux sens (Postgres met les NULL
  // en premier sur un DESC par défaut — on veut les fiches sans valeur à la
  // fin, pas en tête). Toujours `id` en dernier pour une pagination stable.
  const orderBy =
    sort === "activity"
      ? [
          desc(
            sql`GREATEST(COALESCE(${clients.lastContactedAt}, to_timestamp(0)), ${clients.updatedAt})`,
          ),
          asc(clients.id),
        ]
      : [
          dir === "asc"
            ? asc(SORT_COLUMNS[sort])
            : sql`${SORT_COLUMNS[sort]} DESC NULLS LAST`,
          asc(clients.id),
        ];

  const [total, rows] = await Promise.all([
    db.$count(clients, where),
    db.query.clients.findMany({
      where,
      columns: {
        id: true,
        fullName: true,
        phone: true,
        email: true,
        categoryId: true,
        sourceId: true,
        assignedToId: true,
        nextFollowupAt: true,
        lastContactedAt: true,
        doNotCall: true,
        city: true,
        createdAt: true,
        updatedAt: true,
      },
      with: { category: { columns: { color: true } } },
      orderBy,
      limit: pageSize,
      offset: (page - 1) * pageSize,
    }),
  ]);

  return NextResponse.json({
    items: rows.map((r) => {
      // Coordonnées : la case `contact` du compartiment, déjà plafonnée par le
      // droit `clients.contact`. Fermée, elles ne partent PAS — on n'envoie pas
      // un numéro masqué à l'écran, on n'envoie rien du tout.
      const contact = grantsOfHolder(r.assignedToId).contact;
      return {
        id: r.id,
        fullName: r.fullName,
        phone: contact ? r.phone : null,
        email: contact ? r.email : null,
        /** Coordonnées absentes par droit, pas par manque de données. */
        contactHidden: !contact,
        categoryId: r.categoryId,
        categoryColor: r.category?.color ?? null,
        sourceId: r.sourceId,
        assignedToId: r.assignedToId,
        nextFollowupAt: r.nextFollowupAt?.toISOString() ?? null,
        lastContactedAt: r.lastContactedAt?.toISOString() ?? null,
        doNotCall: r.doNotCall,
        city: r.city,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
      };
    }),
    total,
    page,
    pageSize,
  });
}
