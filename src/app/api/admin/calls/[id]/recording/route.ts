import { NextResponse } from "next/server";
import { z } from "zod";
import { runAfterResponse } from "@/lib/after-response";
import { logAudit } from "@/lib/audit";
import { pullCallRecording } from "@/lib/cdr-sync";
import { apiPerm } from "@/lib/permissions/server";
import { keepAudio } from "@/lib/recordings/audio";
import { reachableCall } from "@/lib/recordings/library";

export const dynamic = "force-dynamic";
// Deux questions à voip.ms en même temps, dont chacune peut prendre plus
// d'une minute, et une liste d'enregistrements qui peut venir en plusieurs
// pages : la même marge que la synchro.
export const maxDuration = 300;

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
      ...(outcome.status === "not_found" ? { reason: outcome.reason } : {}),
      // Ce que voip.ms a montré — des nombres et des NOMS de champs, jamais
      // une valeur : de quoi trancher entre « il n'avait rien » et « on n'a
      // pas su rapprocher », sans avoir à rejouer la demande.
      ...((outcome.status === "attached" || outcome.status === "not_found") && outcome.diag
        ? { voipms: outcome.diag }
        : {}),
      ...(outcome.status === "upstream_error" ? { message: outcome.message } : {}),
    },
  });

  // Un appel de la bibliothèque qui reçoit enfin son enregistrement le garde
  // (`keepAudio` refuse de lui-même tout appel qui n'y est pas).
  if (outcome.status === "attached") {
    runAfterResponse(async () => {
      await keepAudio(call.id);
    });
  }

  // La référence de l'enregistrement ne part pas au navigateur : l'écran se
  // recharge et la reçoit par le même chemin que les autres lignes.
  if (outcome.status === "upstream_error") {
    return NextResponse.json({ status: outcome.status }, { status: 502 });
  }
  if (outcome.status === "not_found") {
    return NextResponse.json({ status: outcome.status, reason: outcome.reason });
  }
  return NextResponse.json({ status: outcome.status });
}
