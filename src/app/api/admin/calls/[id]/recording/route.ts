import { NextResponse } from "next/server";
import { z } from "zod";
import { logAudit } from "@/lib/audit";
import { pullCallRecording } from "@/lib/cdr-sync";
import { apiPerm } from "@/lib/permissions/server";
import { reachableCall } from "@/lib/recordings/library";

export const dynamic = "force-dynamic";
// Une seule question à voip.ms, mais son API peut mettre plus d'une minute.
export const maxDuration = 120;

/**
 * POST /api/admin/calls/[id]/recording — va chercher chez voip.ms
 * l'enregistrement de CET appel, sans attendre la synchro de toute la journée.
 *
 * Gardé comme l'écoute, pas comme la synchro : qui peut écouter un appel peut
 * demander son audio. Deux portes, parce que ce sont deux questions — le droit
 * d'écouter (`clients.recordings`) et l'accès à CET appel (`reachableCall`,
 * historique ouvert sur sa fiche). Un appel qu'on n'a pas le droit d'atteindre
 * répond « introuvable », comme un appel qui n'existe pas (règle 1).
 *
 * Chaque demande est tracée, trouvée ou non : c'est une question posée à un
 * service extérieur au nom de quelqu'un.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const actor = await apiPerm("clients.recordings");
  if (actor instanceof NextResponse) return actor;

  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const call = await reachableCall(actor, id);
  if (!call) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const outcome = await pullCallRecording(call.id);
  if (!outcome) return NextResponse.json({ error: "not_found" }, { status: 404 });

  await logAudit({
    userId: actor.user.id,
    action: "recording.pull",
    entity: "call",
    entityId: call.id,
    detail: {
      status: outcome.status,
      clientId: call.clientId,
      ...(outcome.status === "upstream_error" ? { message: outcome.message } : {}),
    },
  });

  // La référence de l'enregistrement ne part pas au navigateur : l'écran se
  // recharge et la reçoit par le même chemin que les autres lignes.
  if (outcome.status === "upstream_error") {
    return NextResponse.json({ status: outcome.status }, { status: 502 });
  }
  return NextResponse.json({ status: outcome.status });
}
