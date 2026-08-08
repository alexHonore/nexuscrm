import {
  and,
  asc,
  desc,
  eq,
  gte,
  ilike,
  isNotNull,
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

/** Tris acceptés — `activity` reproduit l'ordre historique du panneau. */
const SORTS = new Set(["activity", "name", "createdAt", "updatedAt"]);

/**
 * GET /api/clients/list — paginated rows for the /clients left panel and the
 * table view. Params: q, categoryId, sourceId, assignedToId,
 * filter (overdue|today), sort (activity|name|createdAt|updatedAt), dir
 * (asc|desc), page, pageSize (capped at 50). Ordered by recent activity by
 * default.
 */
export async function GET(req: NextRequest) {
  const auth = await apiUser();
  if (auth instanceof NextResponse) return auth;

  const sp = req.nextUrl.searchParams;
  const q = (sp.get("q") ?? "").trim().slice(0, 200);
  const categoryParam = sp.get("categoryId") ?? "";
  const sourceParam = sp.get("sourceId") ?? "";
  const assignedParam = sp.get("assignedToId") ?? "";
  const filter = sp.get("filter") ?? "";
  const sortParam = sp.get("sort") ?? "activity";
  const sort = SORTS.has(sortParam) ? sortParam : "activity";
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
    const textMatchers = [ilike(clients.fullName, `%${q}%`), ilike(clients.email, `%${q}%`)];
    const phoneMatchers =
      digits.length >= 3
        ? [like(clients.phone, `%${digits}%`), like(clients.phoneAlt, `%${digits}%`)]
        : [];
    const merged = or(...textMatchers, ...phoneMatchers);
    if (merged) conditions.push(merged);
  }
  if (/^\d+$/.test(categoryParam)) conditions.push(eq(clients.categoryId, Number(categoryParam)));
  if (/^\d+$/.test(sourceParam)) conditions.push(eq(clients.sourceId, Number(sourceParam)));
  if (UUID_RE.test(assignedParam)) conditions.push(eq(clients.assignedToId, assignedParam));
  if (filter === "overdue") {
    conditions.push(isNotNull(clients.nextFollowupAt), lt(clients.nextFollowupAt, now));
  } else if (filter === "today") {
    const { start, end } = torontoDayRange(now);
    conditions.push(gte(clients.nextFollowupAt, start), lt(clients.nextFollowupAt, end));
  }
  const where = conditions.length > 0 ? and(...conditions) : undefined;

  // Activité récente par défaut (même tri que l'ancienne liste) ; la vue
  // tableau peut trier par nom / création / modification. Toujours `id` en
  // dernier pour une pagination stable.
  const sortColumn =
    sort === "name" ? clients.fullName : sort === "createdAt" ? clients.createdAt : clients.updatedAt;
  const orderBy =
    sort === "activity"
      ? [
          desc(
            sql`GREATEST(COALESCE(${clients.lastContactedAt}, to_timestamp(0)), ${clients.updatedAt})`,
          ),
          asc(clients.id),
        ]
      : [dir === "asc" ? asc(sortColumn) : desc(sortColumn), asc(clients.id)];

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
