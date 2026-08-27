import { NextResponse } from "next/server";
import { z } from "zod";
import { logAudit } from "@/lib/audit";
import { apiAdmin } from "@/lib/auth/guards";
import { applyEnrollmentAction } from "@/lib/campaigns-server/enrollment-admin";

/**
 * PATCH /api/campaigns/:id/enrollments/:enrollmentId
 *
 * Actions manuelles de l'administrateur sur UNE inscription :
 *  - `pause`  : l'inscription reste inscrite mais sort de la file d'envoi.
 *  - `resume` : elle repart où elle en était.
 *  - `remove` : le client est retiré de la campagne (inscription close).
 *  - `reopen` : une inscription TERMINÉE repart au barreau où elle s'était
 *               arrêtée, parce que l'échelle a grandi depuis.
 *
 * Réservé à l'admin (les téléphonistes ne touchent jamais aux campagnes), et
 * l'inscription doit appartenir à CETTE campagne — sinon 404, jamais un accès
 * croisé. Chaque geste est audité.
 */

const bodySchema = z.object({ action: z.enum(["pause", "resume", "remove", "reopen"]) });

const UUID = z.uuid();

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ id: string; enrollmentId: string }> },
) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;

  const { id, enrollmentId } = await ctx.params;
  if (!UUID.safeParse(id).success || !UUID.safeParse(enrollmentId).success) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "validation", issues: parsed.error.issues }, { status: 422 });
  }

  const result = await applyEnrollmentAction(id, enrollmentId, parsed.data.action);
  if (!result.ok) {
    // Une seule règle, et elle vaut pour tous les motifs présents et à venir :
    // l'inscription n'existe pas (ou pas ici) → 404 ; sinon l'état refuse le
    // geste → 409. Une table motif par motif finissait par oublier le dernier
    // ajouté, et l'oubli sortait en `undefined` — donc en 200.
    const status = result.error === "not_found" ? 404 : 409;
    return NextResponse.json({ error: result.error }, { status });
  }

  await logAudit({
    userId: admin.id,
    action: `campaign.enrollment.${parsed.data.action}`,
    entity: "campaign",
    entityId: id,
    detail: { enrollmentId, clientId: result.clientId },
  });

  return NextResponse.json({ ok: true });
}
