import {
  and,
  asc,
  desc,
  eq,
  gte,
  ilike,
  isNotNull,
  isNull,
  like,
  lt,
  or,
  sql,
  type SQL,
} from "drizzle-orm";
import { type NextRequest, NextResponse } from "next/server";
import { db } from "@/db";
import { clients } from "@/db/schema";
import { apiUser } from "@/lib/auth/guards";
import { torontoDayRange } from "@/components/clients/timezone";

const MAX_PAGE_SIZE = 50;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** « Aucun » explicite pour categoryId / sourceId / assignedToId. */
const NONE = "none";

/** États de suivi acceptés pour `filter`. */
const FILTERS = new Set(["overdue", "today", "upcoming", "none", "never", "dnc"]);

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
 * table view. Params:
 * - q (name, email, phone, city)
 * - categoryId / sourceId / assignedToId — id, or "none" for unset
 * - filter — overdue | today | upcoming | none (no follow-up) | never
 *   (never contacted) | dnc (do-not-call list)
 * - language — fr | en
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
  const filter = FILTERS.has(filterParam) ? filterParam : "";
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
  if (categoryParam === NONE) conditions.push(isNull(clients.categoryId));
  else if (/^\d+$/.test(categoryParam)) conditions.push(eq(clients.categoryId, Number(categoryParam)));
  if (sourceParam === NONE) conditions.push(isNull(clients.sourceId));
  else if (/^\d+$/.test(sourceParam)) conditions.push(eq(clients.sourceId, Number(sourceParam)));
  if (assignedParam === NONE) conditions.push(isNull(clients.assignedToId));
  else if (UUID_RE.test(assignedParam)) conditions.push(eq(clients.assignedToId, assignedParam));
  if (languageParam === "fr" || languageParam === "en") {
    conditions.push(eq(clients.language, languageParam));
  }
  if (filter === "overdue") {
    conditions.push(isNotNull(clients.nextFollowupAt), lt(clients.nextFollowupAt, now));
  } else if (filter === "today") {
    const { start, end } = torontoDayRange(now);
    conditions.push(gte(clients.nextFollowupAt, start), lt(clients.nextFollowupAt, end));
  } else if (filter === "upcoming") {
    conditions.push(gte(clients.nextFollowupAt, now));
  } else if (filter === "none") {
    conditions.push(isNull(clients.nextFollowupAt));
  } else if (filter === "never") {
    conditions.push(isNull(clients.lastContactedAt));
  } else if (filter === "dnc") {
    conditions.push(eq(clients.doNotCall, true));
  }
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
