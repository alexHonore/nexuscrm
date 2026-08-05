import { fromZonedTime } from "date-fns-tz";
import { and, asc, eq, gt, gte, lte, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { categories, clients, sources, users } from "@/db/schema";
import { logAudit } from "@/lib/audit";
import { apiAdmin } from "@/lib/auth/guards";

const HEADERS = [
  "id",
  "fullName",
  "phone",
  "phoneAlt",
  "email",
  "language",
  "category",
  "source",
  "assignedTo",
  "projectType",
  "timing",
  "budget",
  "city",
  "address",
  "notes",
  "doNotCall",
  "lastDisposition",
  "lastContactedAt",
  "nextFollowupAt",
  "createdAt",
] as const;

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const s = value instanceof Date ? value.toISOString() : String(value);
  if (/[",\n\r;]/.test(s)) return `"${s.replaceAll('"', '""')}"`;
  return s;
}

/**
 * Export CSV des clients (UTF-8 avec BOM pour Excel), en flux.
 * Filtres : categoryId, sourceId, assignedToId, from, to (créés entre).
 */
export async function GET(req: Request) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;

  const url = new URL(req.url);
  const categoryId = url.searchParams.get("categoryId");
  const sourceId = url.searchParams.get("sourceId");
  const assignedToId = url.searchParams.get("assignedToId");
  const from = url.searchParams.get("from");
  const to = url.searchParams.get("to");

  const filters: SQL[] = [];
  if (categoryId) filters.push(eq(clients.categoryId, Number(categoryId)));
  if (sourceId) filters.push(eq(clients.sourceId, Number(sourceId)));
  if (assignedToId) filters.push(eq(clients.assignedToId, assignedToId));
  // Bornes interprétées en heure de Toronto (DST géré par date-fns-tz).
  if (from) filters.push(gte(clients.createdAt, fromZonedTime(`${from}T00:00:00`, "America/Toronto")));
  if (to) filters.push(lte(clients.createdAt, fromZonedTime(`${to}T23:59:59.999`, "America/Toronto")));

  const assignedUser = alias(users, "assigned_user");
  const encoder = new TextEncoder();
  let exported = 0;

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // BOM UTF-8 pour qu'Excel détecte l'encodage.
      controller.enqueue(encoder.encode("\uFEFF" + HEADERS.join(",") + "\r\n"));
      try {
        const CHUNK = 500;
        let lastId: string | null = null;
        for (;;) {
          const where: SQL | undefined = lastId
            ? and(...filters, gt(clients.id, lastId))
            : and(...filters);
          const rows = await db
            .select({
              c: clients,
              categoryFr: categories.nameFr,
              sourceName: sources.name,
              assignedName: assignedUser.name,
            })
            .from(clients)
            .leftJoin(categories, eq(clients.categoryId, categories.id))
            .leftJoin(sources, eq(clients.sourceId, sources.id))
            .leftJoin(assignedUser, eq(clients.assignedToId, assignedUser.id))
            .where(where)
            .orderBy(asc(clients.id))
            .limit(CHUNK);

          if (rows.length === 0) break;
          let buffer = "";
          for (const r of rows) {
            const cells = [
              r.c.id,
              r.c.fullName,
              r.c.phone,
              r.c.phoneAlt,
              r.c.email,
              r.c.language,
              r.categoryFr,
              r.sourceName,
              r.assignedName,
              r.c.projectType,
              r.c.timing,
              r.c.budget,
              r.c.city,
              r.c.address,
              r.c.notes,
              r.c.doNotCall ? "1" : "0",
              r.c.lastDisposition,
              r.c.lastContactedAt,
              r.c.nextFollowupAt,
              r.c.createdAt,
            ];
            buffer += cells.map(csvCell).join(",") + "\r\n";
          }
          controller.enqueue(encoder.encode(buffer));
          exported += rows.length;
          lastId = rows[rows.length - 1].c.id;
          if (rows.length < CHUNK) break;
        }
        controller.close();
      } catch (err) {
        controller.error(err);
        return;
      }

      await logAudit({
        userId: admin.id,
        action: "export.csv",
        entity: "clients",
        detail: {
          count: exported,
          filters: { categoryId, sourceId, assignedToId, from, to },
        },
      });
    },
  });

  const date = new Date().toISOString().slice(0, 10);
  return new NextResponse(stream, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="clients-${date}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
