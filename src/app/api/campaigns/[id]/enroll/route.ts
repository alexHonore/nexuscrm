import { NextResponse } from "next/server";
import { z } from "zod";
import { logAudit } from "@/lib/audit";
import { sweepCampaign } from "@/lib/campaigns-server/match";
import { apiPerm } from "@/lib/permissions/server";

/**
 * POST /api/campaigns/:id/enroll — inscrit l'audience courante.
 *
 * La réponse détaille les refus PAR MOTIF. Un simple « 37 inscrits sur 200 »
 * laisserait l'administrateur sans moyen de savoir s'il doit relever un
 * plafond, élargir une audience, ou constater que 160 personnes n'ont jamais
 * un numéro joignable et non désabonné.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const actor = await apiPerm("admin.campaigns");
  if (actor instanceof NextResponse) return actor;

  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  try {
    const result = await sweepCampaign(id);
    await logAudit({
      userId: actor.user.id,
      action: "campaign.enroll",
      entity: "campaign",
      entityId: id,
      detail: { enrolled: result.enrolled, considered: result.considered, refusals: result.refusals },
    });
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "enroll_failed";
    if (message === "campaign_not_found") {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ error: "enroll_failed", message }, { status: 500 });
  }
}

/** Un balayage peut toucher des centaines de lignes. */
export const maxDuration = 300;
