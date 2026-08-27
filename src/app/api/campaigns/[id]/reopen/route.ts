import { NextResponse } from "next/server";
import { z } from "zod";
import { logAudit } from "@/lib/audit";
import { apiAdmin } from "@/lib/auth/guards";
import { MAX_REOPEN } from "@/lib/campaigns/reopen";
import { reopenEnrollments } from "@/lib/campaigns-server/reopen";

/**
 * POST /api/campaigns/:id/reopen
 *
 * Relance les inscriptions TERMINÉES d'une campagne dont l'échelle a grandi :
 * elles repartent au barreau où elles s'étaient arrêtées, sans jamais renvoyer
 * un message déjà parti.
 *
 * Une route à part, et non une action de plus sur la collection des
 * inscriptions, pour une raison de portée : l'écran d'édition n'affiche que
 * les cent inscriptions les plus récentes. Un geste qui ne porterait que sur
 * des identifiants cochés laisserait silencieusement derrière lui tous ceux
 * qu'on ne voit pas — c'est-à-dire l'essentiel d'une vieille campagne.
 *
 * `dryRun` calcule TOUT sans rien écrire : combien repartent, quand, et qui
 * est écarté pour quel motif. C'est ce que la confirmation affiche, et c'est
 * le même chemin que le geste réel — un aperçu qui compterait autrement
 * mentirait.
 *
 * Réservé à l'admin. Le geste réel est audité ; l'aperçu ne l'est pas — il
 * n'écrit rien, et le journal d'audit doit rester lisible.
 */

const UUID = z.uuid();

const bodySchema = z.object({
  dryRun: z.boolean().default(false),
  /** Portée restreinte à ces inscriptions. Absent = toute la campagne. */
  enrollmentIds: z.array(UUID).min(1).max(MAX_REOPEN).optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;

  const { id } = await ctx.params;
  if (!UUID.safeParse(id).success) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  // Corps facultatif : « relancer tout, pour de vrai » se demande sans rien.
  let raw: unknown = {};
  try {
    const text = await req.text();
    if (text.trim() !== "") raw = JSON.parse(text);
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "validation", issues: parsed.error.issues }, { status: 422 });
  }

  const result = await reopenEnrollments(id, {
    dryRun: parsed.data.dryRun,
    enrollmentIds: parsed.data.enrollmentIds,
  });
  if (!result.ok) {
    const status = result.error === "campaign_not_found" ? 404 : 409;
    return NextResponse.json({ error: result.error }, { status });
  }

  if (!result.dryRun && result.reopened > 0) {
    await logAudit({
      userId: admin.id,
      action: "campaign.enrollment.reopen_all",
      entity: "campaign",
      entityId: id,
      detail: {
        reopened: result.reopened,
        refused: result.refused,
        remaining: result.remaining,
        // Ce que le geste a réellement programmé — la seule trace qui dira,
        // dans trois mois, quels barreaux venaient d'une relance.
        firstAt: result.planned[0]?.dueAt.toISOString() ?? null,
        lastAt: result.planned.at(-1)?.dueAt.toISOString() ?? null,
      },
    });
  }

  return NextResponse.json({
    dryRun: result.dryRun,
    /** Combien repartiraient (aperçu) ou viennent de repartir. */
    candidates: result.planned.length,
    reopened: result.reopened,
    refused: result.refused,
    remaining: result.remaining,
    firstAt: result.planned[0]?.dueAt.toISOString() ?? null,
    lastAt: result.planned.at(-1)?.dueAt.toISOString() ?? null,
  });
}

/** Une relance peut toucher des centaines d'inscriptions. */
export const maxDuration = 300;
