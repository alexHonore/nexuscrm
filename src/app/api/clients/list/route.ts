import { fromZonedTime } from "date-fns-tz";
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
import { apiUser } from "@/lib/auth/guards";
import { APP_TZ, torontoDayRange } from "@/components/clients/timezone";

const MAX_PAGE_SIZE = 50;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

// Bornes des filtres de dates (yyyy-mm-dd), interprétées en heure de Toronto —
// même convention que l'export admin. Valeur invalide : filtre ignoré.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** La regex ne vérifie que la forme : « 2026-02-30 » donne une Invalid Date
 *  (truthy !) qui ferait planter le driver Postgres — on la rejette ici. */
function validDate(d: Date): Date | undefined {
  return Number.isNaN(d.getTime()) ? undefined : d;
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
 * - sort (activity | name | city | createdAt | updatedAt | followupAt |
 *   lastContact), dir (asc|desc), page, pageSize (capped at 50).
 * Ordered by recent activity by default.
 */
export async function GET(req: NextRequest) {
  const auth = await apiUser();
  if (auth instanceof NextResponse) return auth;

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
  const page = Math.max(1, Number.parseInt(sp.get("page") ?? "", 10) || 1);
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Number.parseInt(sp.get("pageSize") ?? "", 10) || MAX_PAGE_SIZE),
  );

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
    const textMatchers = [
      ilike(clients.fullName, `%${q}%`),
      ilike(clients.email, `%${q}%`),
      ilike(clients.city, `%${q}%`),
    ];
    const phoneMatchers =
      digits.length >= 3
        ? [like(clients.phone, `%${digits}%`), like(clients.phoneAlt, `%${digits}%`)]
        : [];
    const merged = or(...textMatchers, ...phoneMatchers);
    if (merged) conditions.push(merged);
  }

  const catTokens = tokens(categoryParam);
  const catIds = catTokens.filter((v) => /^\d+$/.test(v)).map(Number);
  pushOr(
    catIds.length > 0 ? inArray(clients.categoryId, catIds) : undefined,
    catTokens.includes(NONE) ? isNull(clients.categoryId) : undefined,
  );

  const srcTokens = tokens(sourceParam);
  const srcIds = srcTokens.filter((v) => /^\d+$/.test(v)).map(Number);
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

  const createdFrom = torontoStart(sp.get("createdFrom"));
  if (createdFrom) conditions.push(gte(clients.createdAt, createdFrom));
  const createdTo = torontoEnd(sp.get("createdTo"));
  if (createdTo) conditions.push(lte(clients.createdAt, createdTo));
  const updatedFrom = torontoStart(sp.get("updatedFrom"));
  if (updatedFrom) conditions.push(gte(clients.updatedAt, updatedFrom));
  const updatedTo = torontoEnd(sp.get("updatedTo"));
  if (updatedTo) conditions.push(lte(clients.updatedAt, updatedTo));

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

  const where = conditions.length > 0 ? and(...conditions) : undefined;

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
    items: rows.map((r) => ({
      id: r.id,
      fullName: r.fullName,
      phone: r.phone,
      email: r.email,
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
    })),
    total,
    page,
    pageSize,
  });
}
