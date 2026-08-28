import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { clients, sources } from "@/db/schema";
import { diffFields, logAudit } from "@/lib/audit";
import { isUniqueViolation } from "@/lib/db-errors";
import { apiPerm } from "@/lib/permissions/server";
import { AbortDelete, abortDeleteResponse, readJson, readReassignTarget } from "../../_helpers";

const patchSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  color: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}$/)
    .optional(),
});

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(req: Request, ctx: Ctx) {
  const actor = await apiPerm("admin.pipeline");
  if (actor instanceof NextResponse) return actor;
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id)) return NextResponse.json({ error: "invalid_id" }, { status: 400 });

  const body = await readJson(req, patchSchema);
  if (body instanceof NextResponse) return body;

  try {
    // Lu AVANT l'écriture : le journal doit pouvoir montrer l'ancienne valeur.
    const before = await db.query.sources.findFirst({ where: eq(sources.id, id) });
    const [updated] = await db.update(sources).set(body).where(eq(sources.id, id)).returning();
    if (!updated) return NextResponse.json({ error: "not_found" }, { status: 404 });

    const changes = diffFields(before, updated, ["name", "color"]);
    await logAudit({
      userId: actor.user.id,
      action: "source.update",
      entity: "source",
      entityId: String(id),
      detail: { ...body, ...(changes ? { changes } : {}) },
    });

    return NextResponse.json({ source: updated });
  } catch (err) {
    // Drizzle enveloppe l'erreur Postgres : le nom de la contrainte n'est que
    // dans `cause` — d'où le détecteur partagé, jamais un test sur le message.
    if (isUniqueViolation(err, "sources_name_unique")) {
      return NextResponse.json({ error: "name_taken" }, { status: 409 });
    }
    throw err;
  }
}

/**
 * Supprime une source.
 *
 * Cohérence des données : dès qu'une fiche y est rattachée, l'admin DOIT
 * indiquer où elle part — `reassignTo` (source existante) ou `null` choisi
 * explicitement pour « sans source ». Un corps absent est refusé
 * (`reassign_required`) plutôt que d'orphelin­iser les fiches en silence.
 */
export async function DELETE(req: Request, ctx: Ctx) {
  const actor = await apiPerm("admin.pipeline");
  if (actor instanceof NextResponse) return actor;
  const id = Number((await ctx.params).id);
  if (!Number.isInteger(id)) return NextResponse.json({ error: "invalid_id" }, { status: 400 });

  const { provided, reassignTo } = await readReassignTarget(req);

  const target = await db.query.sources.findFirst({ where: eq(sources.id, id) });
  if (!target) return NextResponse.json({ error: "not_found" }, { status: 404 });
  // Se déplacer vers soi-même n'a pas de sens : la ligne disparaît juste après.
  if (reassignTo === id) return NextResponse.json({ error: "invalid_target" }, { status: 400 });

  let moved: number;
  try {
    // Tout dans une seule transaction : destination vérifiée, fiches déplacées
    // puis comptées, source supprimée. Une fiche rattachée pendant l'opération
    // est donc soit déplacée avec les autres, soit à l'origine d'un refus —
    // jamais orpheline.
    moved = await db.transaction(async (tx) => {
      if (reassignTo !== null) {
        const dest = await tx.query.sources.findFirst({ where: eq(sources.id, reassignTo) });
        if (!dest) throw new AbortDelete("invalid_target");
      }
      const rows = await tx
        .update(clients)
        .set({ sourceId: reassignTo })
        .where(eq(clients.sourceId, id))
        .returning({ id: clients.id });
      if (rows.length > 0 && !provided) {
        throw new AbortDelete("reassign_required", rows.length);
      }
      await tx.delete(sources).where(eq(sources.id, id));
      return rows.length;
    });
  } catch (err) {
    return abortDeleteResponse(err);
  }

  const changes = diffFields(target, null, ["name", "color"]);
  await logAudit({
    userId: actor.user.id,
    action: "source.delete",
    entity: "source",
    entityId: String(id),
    detail: { name: target.name, reassignTo, movedClients: moved, ...(changes ? { changes } : {}) },
  });

  return NextResponse.json({ ok: true, moved });
}
