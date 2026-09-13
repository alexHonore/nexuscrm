import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { callStars } from "@/db/schema-library";
import { logAudit } from "@/lib/audit";
import { readJson } from "@/app/api/admin/_helpers";
import { runAfterResponse } from "@/lib/after-response";
import { apiPerm } from "@/lib/permissions/server";
import { keepAudio, pruneOrphanAudio } from "@/lib/recordings/audio";
import { reachableCall } from "@/lib/recordings/library";

const bodySchema = z.object({ callId: z.uuid() });

/**
 * L'étoile : marquer un appel pour soi, et rien que pour soi.
 *
 * Pas de droit dédié — `clients.recordings` suffit. Un signet privé n'affecte
 * personne, et exiger une case de plus aurait fait du geste le plus fréquent
 * de la bibliothèque le plus difficile à obtenir. Ce qui est vérifié, en
 * revanche, c'est que l'appel EXISTE pour ce regard : sans ça, on pourrait
 * sonder la base un identifiant à la fois et apprendre quels appels existent.
 *
 * Réponse indistincte (« introuvable ») pour un appel absent comme pour un
 * appel dont la fiche est fermée — dire « interdit » confirmerait la fiche.
 */
export async function POST(req: Request) {
  const actor = await apiPerm("clients.recordings");
  if (actor instanceof NextResponse) return actor;

  const body = await readJson(req, bodySchema);
  if (body instanceof NextResponse) return body;

  const call = await reachableCall(actor, body.callId);
  if (!call) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // Marquer deux fois est le même geste : l'index unique rend le bouton
  // rejouable (double-tap, requête réémise après une réponse perdue).
  await db
    .insert(callStars)
    .values({ callId: call.id, userId: actor.user.id })
    .onConflictDoNothing({ target: [callStars.userId, callStars.callId] });

  await logAudit({
    userId: actor.user.id,
    action: "recording.star",
    entity: "call",
    entityId: call.id,
    detail: { clientId: call.clientId },
  });

  // Marquer, c'est promettre d'y revenir : l'audio est gardé tout de suite —
  // après la réponse, pour que l'étoile se remplisse sans attendre voip.ms.
  if (call.recordingUrl) {
    runAfterResponse(async () => {
      await keepAudio(call.id);
    });
  }

  return NextResponse.json({ ok: true, starred: true });
}

export async function DELETE(req: Request) {
  const actor = await apiPerm("clients.recordings");
  if (actor instanceof NextResponse) return actor;

  const body = await readJson(req, bodySchema);
  if (body instanceof NextResponse) return body;

  // Retirer SA propre étoile ne demande pas d'atteindre l'appel : une fiche
  // qui vient de se fermer ne doit pas laisser un marque-page indélogeable.
  const removed = await db
    .delete(callStars)
    .where(and(eq(callStars.userId, actor.user.id), eq(callStars.callId, body.callId)))
    .returning({ id: callStars.id });

  if (removed.length > 0) {
    await logAudit({
      userId: actor.user.id,
      action: "recording.unstar",
      entity: "call",
      entityId: body.callId,
    });
    // Plus marqué par personne ni rangé nulle part : sa copie rend la place.
    runAfterResponse(async () => {
      await pruneOrphanAudio([body.callId]);
    });
  }

  return NextResponse.json({ ok: true, starred: false });
}
