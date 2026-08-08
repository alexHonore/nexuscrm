import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { categories, clients } from "@/db/schema";
import { diffFields, logAudit } from "@/lib/audit";
import { apiAdmin } from "@/lib/auth/guards";
import { AbortDelete, abortDeleteResponse, readJson, readReassignTarget } from "../../_helpers";

const patchSchema = z.object({
  nameFr: z.string().trim().min(1).max(80).optional(),
  nameEn: z.string().trim().min(1).max(80).optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
});

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, ctx: Ctx) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id)) return NextResponse.json({ error: "invalid_id" }, { status: 400 });

  const body = await readJson(req, patchSchema);
  if (body instanceof NextResponse) return body;

  // Lu AVANT l'écriture : le journal doit pouvoir montrer l'ancienne valeur.
  const before = await db.query.categories.findFirst({ where: eq(categories.id, id) });
  const [updated] = await db.update(categories).set(body).where(eq(categories.id, id)).returning();
  if (!updated) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const changes = diffFields(before, updated, ["nameFr", "nameEn", "color"]);
  await logAudit({
    userId: admin.id,
    action: "category.update",
    entity: "category",
    entityId: String(id),
    detail: { ...body, ...(changes ? { changes } : {}) },
  });

  return NextResponse.json({ category: updated });
}

/**
 * Supprime une catégorie NON système.
 *
 * Cohérence des données : dès qu'une fiche y est rattachée, l'admin DOIT
 * indiquer où elle part — `reassignTo` (catégorie existante) ou `null` choisi
 * explicitement pour « sans catégorie ». Un corps absent est refusé
 * (`reassign_required`) plutôt que d'orphelin­iser les fiches en silence.
 */
export async function DELETE(req: Request, ctx: Ctx) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id)) return NextResponse.json({ error: "invalid_id" }, { status: 400 });

  const { provided, reassignTo } = await readReassignTarget(req);

  const target = await db.query.categories.findFirst({ where: eq(categories.id, id) });
  if (!target) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (target.isSystem) return NextResponse.json({ error: "system_category" }, { status: 400 });
  // Se déplacer vers soi-même n'a pas de sens : la ligne disparaît juste après.
  if (reassignTo === id) return NextResponse.json({ error: "invalid_target" }, { status: 400 });

  let moved: number;
  try {
    // Tout dans une seule transaction : destination vérifiée, fiches déplacées
    // puis comptées, catégorie supprimée. Une fiche rattachée pendant
    // l'opération est donc soit déplacée avec les autres, soit à l'origine
    // d'un refus — jamais orpheline.
    moved = await db.transaction(async (tx) => {
      if (reassignTo !== null) {
        const dest = await tx.query.categories.findFirst({ where: eq(categories.id, reassignTo) });
        if (!dest) throw new AbortDelete("invalid_target");
      }
      const rows = await tx
        .update(clients)
        .set({ categoryId: reassignTo })
        .where(eq(clients.categoryId, id))
        .returning({ id: clients.id });
      if (rows.length > 0 && !provided) {
        throw new AbortDelete("reassign_required", rows.length);
      }
      await tx.delete(categories).where(eq(categories.id, id));
      return rows.length;
    });
  } catch (err) {
    return abortDeleteResponse(err);
  }

  const changes = diffFields(target, null, ["nameFr", "nameEn", "color"]);
  await logAudit({
    userId: admin.id,
    action: "category.delete",
    entity: "category",
    entityId: String(id),
    detail: { nameFr: target.nameFr, reassignTo, movedClients: moved, ...(changes ? { changes } : {}) },
  });

  return NextResponse.json({ ok: true, moved });
}
