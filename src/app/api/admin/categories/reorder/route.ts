import { asc, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { categories } from "@/db/schema";
import { diffFields, logAudit } from "@/lib/audit";
import { apiPerm } from "@/lib/permissions/server";
import { readJson } from "../../_helpers";

const schema = z.object({ orderedIds: z.array(z.number().int()).min(1).max(200) });

/** Réordonne les catégories : sortOrder = index dans orderedIds. */
export async function POST(req: Request) {
  const actor = await apiPerm("admin.pipeline");
  if (actor instanceof NextResponse) return actor;

  const body = await readJson(req, schema);
  if (body instanceof NextResponse) return body;

  // Ordre courant lu AVANT l'écriture : le journal affiche des noms, pas des id.
  const before = await db.query.categories.findMany({
    columns: { id: true, nameFr: true },
    orderBy: asc(categories.sortOrder),
  });
  const nameById = new Map(before.map((c) => [c.id, c.nameFr]));

  await db.transaction(async (tx) => {
    for (let i = 0; i < body.orderedIds.length; i++) {
      await tx.update(categories).set({ sortOrder: i }).where(eq(categories.id, body.orderedIds[i]));
    }
  });

  const changes = diffFields(
    { order: before.map((c) => c.nameFr) },
    { order: body.orderedIds.map((id) => nameById.get(id) ?? String(id)) },
    ["order"],
  );
  await logAudit({
    userId: actor.user.id,
    action: "category.reorder",
    entity: "category",
    detail: { orderedIds: body.orderedIds, ...(changes ? { changes } : {}) },
  });

  return NextResponse.json({ ok: true });
}
