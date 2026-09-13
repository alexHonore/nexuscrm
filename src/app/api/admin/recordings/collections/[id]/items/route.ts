import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { readJson } from "@/app/api/admin/_helpers";
import { db } from "@/db";
import { recordingCollectionItems, recordingCollections } from "@/db/schema-library";
import { logAudit } from "@/lib/audit";
import { apiPerm } from "@/lib/permissions/server";
import { NOTE_MAX, reachableCall } from "@/lib/recordings/library";

export const dynamic = "force-dynamic";

const addSchema = z.object({
  callId: z.uuid(),
  /** Le motif d'écoute : pourquoi cet appel est ici. */
  note: z.string().trim().max(NOTE_MAX).nullish(),
});

const removeSchema = z.object({ callId: z.uuid() });

/**
 * Ranger un appel — et écrire pourquoi.
 *
 * Deux portes, pas une, parce que ce sont deux questions : le droit de ranger
 * (`clients.recordingsCurate`) et l'accès à CET appel-là (`reachableCall`).
 * Sans la seconde, un superviseur au regard restreint pourrait faire entrer
 * dans un dossier partagé un appel qu'il n'a pas le droit d'entendre — et le
 * rendre audible à qui, lui, l'a.
 */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const actor = await apiPerm("clients.recordingsCurate");
  if (actor instanceof NextResponse) return actor;

  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const body = await readJson(req, addSchema);
  if (body instanceof NextResponse) return body;

  const collection = await db.query.recordingCollections.findFirst({
    where: eq(recordingCollections.id, id),
    columns: { id: true, kind: true, name: true },
  });
  if (!collection) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const call = await reachableCall(actor, body.callId);
  if (!call) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const note = body.note?.trim() ? body.note.trim() : null;

  // Re-ranger met le motif à jour au lieu d'empiler un doublon : c'est ce que
  // fait l'écran quand on rouvre la pastille pour corriger une phrase.
  const [row] = await db
    .insert(recordingCollectionItems)
    .values({ collectionId: collection.id, callId: call.id, note, addedById: actor.user.id })
    .onConflictDoUpdate({
      target: [recordingCollectionItems.collectionId, recordingCollectionItems.callId],
      set: { note, addedById: actor.user.id, addedAt: new Date() },
    })
    .returning();

  await logAudit({
    userId: actor.user.id,
    action: "recording_collection.add",
    entity: "call",
    entityId: call.id,
    detail: {
      collectionId: collection.id,
      kind: collection.kind,
      name: collection.name,
      // Le motif lui-même reste hors de la trace : c'est un jugement sur le
      // travail d'un collègue, il se lit dans le dossier, pas dans l'audit.
      hasNote: note !== null,
    },
  });

  return NextResponse.json({ item: row }, { status: 201 });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const actor = await apiPerm("clients.recordingsCurate");
  if (actor instanceof NextResponse) return actor;

  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const body = await readJson(req, removeSchema);
  if (body instanceof NextResponse) return body;

  // Sortir un appel d'un dossier n'exige pas de pouvoir l'atteindre : un appel
  // devenu invisible doit pouvoir être retiré d'un recueil partagé, sinon il y
  // reste à jamais en gonflant un décompte que plus personne n'explique.
  const removed = await db
    .delete(recordingCollectionItems)
    .where(
      and(
        eq(recordingCollectionItems.collectionId, id),
        eq(recordingCollectionItems.callId, body.callId),
      ),
    )
    .returning({ id: recordingCollectionItems.id });

  if (removed.length === 0) return NextResponse.json({ error: "not_found" }, { status: 404 });

  await logAudit({
    userId: actor.user.id,
    action: "recording_collection.remove",
    entity: "call",
    entityId: body.callId,
    detail: { collectionId: id },
  });

  return NextResponse.json({ ok: true });
}
