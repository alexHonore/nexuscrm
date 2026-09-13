import { NextResponse } from "next/server";
import { z } from "zod";
import { readJson } from "@/app/api/admin/_helpers";
import { logAudit } from "@/lib/audit";
import { apiPerm } from "@/lib/permissions/server";
import { keepAudio, removeAudio } from "@/lib/recordings/audio";
import { reachableCall } from "@/lib/recordings/library";

export const dynamic = "force-dynamic";
// Conserver télécharge l'audio chez voip.ms, dont l'API peut être lente.
export const maxDuration = 120;

const bodySchema = z.object({ callId: z.uuid() });

/**
 * L'audio conservé d'UN appel de la bibliothèque — le garder, ou rendre sa place.
 *
 * Gardé par le droit de RANGER, pas par l'étoile : la copie occupe une place
 * PARTAGÉE dans la base de toute l'équipe, ce n'est pas un signet personnel.
 * Et par l'accès à CET appel — un appel qu'on ne peut pas atteindre répond
 * « introuvable », comme un appel qui n'existe pas (règle 1).
 */
export async function POST(req: Request) {
  const actor = await apiPerm("clients.recordingsCurate");
  if (actor instanceof NextResponse) return actor;

  const body = await readJson(req, bodySchema);
  if (body instanceof NextResponse) return body;

  const call = await reachableCall(actor, body.callId);
  if (!call) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // Explicite : le seul chemin qui reprend un audio que quelqu'un a retiré.
  const outcome = await keepAudio(call.id, { explicit: true });

  await logAudit({
    userId: actor.user.id,
    action: "recording_audio.keep",
    entity: "call",
    entityId: call.id,
    detail: {
      status: outcome.status,
      ...("bytes" in outcome ? { bytes: outcome.bytes } : {}),
      ...(outcome.status === "upstream_error" ? { message: outcome.message } : {}),
    },
  });

  if (outcome.status === "upstream_error") {
    return NextResponse.json({ status: outcome.status }, { status: 502 });
  }
  return NextResponse.json({ status: outcome.status });
}

/** Rendre la place : l'audio part, l'écoute repassera par voip.ms. */
export async function DELETE(req: Request) {
  const actor = await apiPerm("clients.recordingsCurate");
  if (actor instanceof NextResponse) return actor;

  const body = await readJson(req, bodySchema);
  if (body instanceof NextResponse) return body;

  const call = await reachableCall(actor, body.callId);
  if (!call) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const removed = await removeAudio(call.id, actor.user.id);
  if (!removed) return NextResponse.json({ error: "not_found" }, { status: 404 });

  await logAudit({
    userId: actor.user.id,
    action: "recording_audio.remove",
    entity: "call",
    entityId: call.id,
    detail: { bytes: removed.bytes },
  });

  return NextResponse.json({ ok: true, bytes: removed.bytes });
}
