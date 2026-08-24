import { fromZonedTime } from "date-fns-tz";
import { and, asc, eq, gt, gte, lte, type SQL } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { categories, clients, sources, users } from "@/db/schema";
import { runAfterResponse } from "@/lib/after-response";
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

/**
 * Début de formule tableur (CWE-1236) : Excel, Numbers, LibreOffice et Sheets
 * ÉVALUENT une cellule qui commence par = @ TAB CR, ou par + / - — même entre
 * guillemets. Ces cellules viennent en partie de l'extérieur (formulaire de
 * lead via le webhook, notes des téléphonistes) : on les neutralise d'une
 * apostrophe en tête (convention OWASP) et on les force entre guillemets.
 *
 * Exception : un nombre signé pur (« +14184761542 » en E.164, « -3 ») ne peut
 * rien invoquer — il reste tel quel, lisible et réimportable.
 */
const FORMULA_START = /^\s*(?:[=@\t\r]|[+-](?!\d+$))/;

function csvCell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const raw = value instanceof Date ? value.toISOString() : String(value);
  const neutralised = FORMULA_START.test(raw) ? `'${raw}` : raw;
  if (neutralised !== raw || /[",\n\r;]/.test(neutralised)) {
    return `"${neutralised.replaceAll('"', '""')}"`;
  }
  return neutralised;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TZ = "America/Toronto";

/**
 * Filtres de l'URL — validés AVANT d'ouvrir le flux : une fois les en-têtes
 * partis (200, pièce jointe), une valeur qui fait lever Postgres ne peut plus
 * devenir un 4xx, seulement un téléchargement tronqué.
 */
const querySchema = z.object({
  categoryId: z.string().regex(/^\d+$/).transform(Number).optional(),
  sourceId: z.string().regex(/^\d+$/).transform(Number).optional(),
  assignedToId: z.uuid().optional(),
  from: z.string().regex(DATE_RE).optional(),
  to: z.string().regex(DATE_RE).optional(),
});
type ExportQuery = z.infer<typeof querySchema>;

/**
 * Borne d'une journée en heure de Toronto (DST géré par date-fns-tz), ou null
 * si la date n'existe pas (2026-02-30) : le pilote ne sait pas sérialiser ça.
 */
function dayBound(day: string, suffix: "T00:00:00" | "T23:59:59.999"): Date | null {
  const d = fromZonedTime(`${day}${suffix}`, TZ);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Export CSV des clients (UTF-8 avec BOM pour Excel), en flux.
 * Filtres : categoryId, sourceId, assignedToId, from, to (créés entre).
 */
export async function GET(req: Request) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;

  const url = new URL(req.url);
  // Un paramètre vide (« ?from= ») vaut « pas de filtre », comme avant.
  const raw: Record<string, string> = {};
  for (const key of ["categoryId", "sourceId", "assignedToId", "from", "to"] as const) {
    const value = url.searchParams.get(key);
    if (value) raw[key] = value;
  }
  const parsed = querySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "validation", issues: parsed.error.issues }, { status: 422 });
  }
  const query: ExportQuery = parsed.data;
  const fromDate = query.from ? dayBound(query.from, "T00:00:00") : undefined;
  const toDate = query.to ? dayBound(query.to, "T23:59:59.999") : undefined;
  if (fromDate === null || toDate === null) {
    const issues = [{ path: [fromDate === null ? "from" : "to"], message: "invalid_date" }];
    return NextResponse.json({ error: "validation", issues }, { status: 422 });
  }

  const filters: SQL[] = [];
  if (query.categoryId !== undefined) filters.push(eq(clients.categoryId, query.categoryId));
  if (query.sourceId !== undefined) filters.push(eq(clients.sourceId, query.sourceId));
  if (query.assignedToId) filters.push(eq(clients.assignedToId, query.assignedToId));
  if (fromDate) filters.push(gte(clients.createdAt, fromDate));
  if (toDate) filters.push(lte(clients.createdAt, toDate));

  // Journalisé AVANT le premier octet : un export interrompu (connexion
  // coupée, requête en échec à mi-parcours) a déjà livré des données
  // personnelles — il doit laisser une trace quoi qu'il arrive.
  const auditFilters = {
    categoryId: query.categoryId ?? null,
    sourceId: query.sourceId ?? null,
    assignedToId: query.assignedToId ?? null,
    from: query.from ?? null,
    to: query.to ?? null,
  };
  await logAudit({
    userId: admin.id,
    action: "export.csv",
    entity: "clients",
    detail: { filters: auditFilters },
  });

  const assignedUser = alias(users, "assigned_user");
  const encoder = new TextEncoder();
  let exported = 0;
  let finish!: (partial: boolean) => void;
  const finished = new Promise<boolean>((resolve) => {
    finish = resolve;
  });

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        // BOM UTF-8 pour qu'Excel détecte l'encodage.
        controller.enqueue(encoder.encode("\uFEFF" + HEADERS.join(",") + "\r\n"));
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
        finish(false);
      } catch (err) {
        // Connexion coupée (le flux refuse alors d'écrire) ou requête en échec :
        // ce qui est déjà parti est parti — on le consigne comme partiel.
        finish(true);
        controller.error(err);
      }
    },
  });

  // Bilan une fois le flux terminé, réussi ou non : combien de fiches sont
  // sorties. `after()` garde la fonction en vie jusqu'à l'écriture.
  runAfterResponse(async () => {
    const partial = await finished;
    await logAudit({
      userId: admin.id,
      action: "export.csv",
      entity: "clients",
      detail: { count: exported, partial, filters: auditFilters },
    });
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
