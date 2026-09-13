import { NextResponse } from "next/server";
import { z } from "zod";
import { readJson } from "@/app/api/admin/_helpers";
import { db } from "@/db";
import { recordingCollections } from "@/db/schema-library";
import { logAudit } from "@/lib/audit";
import { isUniqueViolation } from "@/lib/db-errors";
import { apiPerm } from "@/lib/permissions/server";
import { DESCRIPTION_MAX, NAME_MAX, loadCollections } from "@/lib/recordings/library";

export const dynamic = "force-dynamic";

const createSchema = z.object({
  kind: z.enum(["folder", "tag"]),
  name: z.string().trim().min(1).max(NAME_MAX),
  description: z.string().trim().max(DESCRIPTION_MAX).nullish(),
});

/**
 * La liste des dossiers et des étiquettes, avec le décompte de CE regard.
 *
 * Lire la bibliothèque demande le droit d'écouter — pas celui de la ranger :
 * un téléphoniste doit pouvoir ouvrir « Formation — objections prix » sans
 * pouvoir y ajouter quoi que ce soit. C'est tout l'intérêt d'un recueil.
 */
export async function GET() {
  const actor = await apiPerm("clients.recordings");
  if (actor instanceof NextResponse) return actor;
  return NextResponse.json({ collections: await loadCollections(actor) });
}

export async function POST(req: Request) {
  const actor = await apiPerm("clients.recordingsCurate");
  if (actor instanceof NextResponse) return actor;

  const body = await readJson(req, createSchema);
  if (body instanceof NextResponse) return body;

  let created;
  try {
    [created] = await db
      .insert(recordingCollections)
      .values({
        kind: body.kind,
        name: body.name,
        description: body.description ?? null,
        createdById: actor.user.id,
      })
      .returning();
  } catch (err) {
    // Deux dossiers du même nom sont une faute de frappe, jamais une
    // intention : l'un se remplirait et l'autre resterait vide.
    if (isUniqueViolation(err, "recording_collections_kind_name_uq")) {
      return NextResponse.json({ error: "name_taken" }, { status: 409 });
    }
    throw err;
  }

  await logAudit({
    userId: actor.user.id,
    action: "recording_collection.create",
    entity: "recording_collection",
    entityId: created.id,
    detail: { kind: created.kind, name: created.name },
  });

  return NextResponse.json({ collection: { ...created, count: 0 } }, { status: 201 });
}
