import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { readJson } from "@/app/api/admin/_helpers";
import { db } from "@/db";
import { recordingCollections } from "@/db/schema-library";
import { diffFields, logAudit } from "@/lib/audit";
import { isUniqueViolation } from "@/lib/db-errors";
import { apiPerm } from "@/lib/permissions/server";
import { DESCRIPTION_MAX, NAME_MAX } from "@/lib/recordings/library";

export const dynamic = "force-dynamic";

const patchSchema = z
  .object({
    name: z.string().trim().min(1).max(NAME_MAX).optional(),
    description: z.string().trim().max(DESCRIPTION_MAX).nullish(),
  })
  // Le GENRE ne change jamais : un dossier devenu étiquette emporterait avec
  // lui des motifs d'écoute écrits pour être lus dossier ouvert, dans une
  // pastille qui ne les affiche pas. Recréer est plus honnête que convertir.
  .strict();

/** Un recueil n'est pas une fiche : son inexistence ne révèle rien de personne. */
export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const actor = await apiPerm("clients.recordingsCurate");
  if (actor instanceof NextResponse) return actor;

  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const body = await readJson(req, patchSchema);
  if (body instanceof NextResponse) return body;

  const before = await db.query.recordingCollections.findFirst({
    where: eq(recordingCollections.id, id),
  });
  if (!before) return NextResponse.json({ error: "not_found" }, { status: 404 });

  let updated;
  try {
    [updated] = await db
      .update(recordingCollections)
      .set({
        ...(body.name !== undefined ? { name: body.name } : {}),
        ...(body.description !== undefined ? { description: body.description ?? null } : {}),
        updatedAt: new Date(),
      })
      .where(eq(recordingCollections.id, id))
      .returning();
  } catch (err) {
    if (isUniqueViolation(err, "recording_collections_kind_name_uq")) {
      return NextResponse.json({ error: "name_taken" }, { status: 409 });
    }
    throw err;
  }

  await logAudit({
    userId: actor.user.id,
    action: "recording_collection.update",
    entity: "recording_collection",
    entityId: id,
    detail: { changes: diffFields(before, updated, ["name", "description"]) },
  });

  return NextResponse.json({ collection: updated });
}

/**
 * Supprimer efface le CLASSEMENT de tout le monde, pas le sien — les appels
 * eux-mêmes survivent (`on delete cascade` ne touche que les lignes de
 * rangement). Le décompte part dans la trace : c'est la seule façon de savoir
 * après coup ce qu'on a perdu.
 */
export async function DELETE(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const actor = await apiPerm("clients.recordingsCurate");
  if (actor instanceof NextResponse) return actor;

  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const before = await db.query.recordingCollections.findFirst({
    where: eq(recordingCollections.id, id),
    with: { items: { columns: { id: true } } },
  });
  if (!before) return NextResponse.json({ error: "not_found" }, { status: 404 });

  await db.delete(recordingCollections).where(eq(recordingCollections.id, id));

  await logAudit({
    userId: actor.user.id,
    action: "recording_collection.delete",
    entity: "recording_collection",
    entityId: id,
    detail: { kind: before.kind, name: before.name, filed: before.items.length },
  });

  return NextResponse.json({ ok: true, filed: before.items.length });
}
