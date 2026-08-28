import { NextResponse } from "next/server";
import { z } from "zod";
import { logAudit } from "@/lib/audit";
import { deactivateAssistant } from "@/lib/assistants/service";
import { apiPerm } from "@/lib/permissions/server";

/**
 * POST /api/assistants/:id/deactivate — retire un assistant du service : il
 * repasse en BROUILLON.
 *
 * C'est le geste inverse de l'activation, et il n'avait pas d'entrée : un
 * assistant actif qui dérape ne pouvait être arrêté qu'en l'archivant (s'il
 * avait écrit) ou par une écriture SQL. Repasser en brouillon garde la fiche
 * et son historique ; la réactivation repasse par la porte (§11.4). Un
 * assistant archivé reste archivé : l'archivage est terminal.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const actor = await apiPerm("admin.assistants");
  if (actor instanceof NextResponse) return actor;

  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  try {
    const result = await deactivateAssistant(id);
    if (!result.ok) {
      return NextResponse.json({ error: result.reason }, { status: 409 });
    }
    if (result.changed) {
      await logAudit({
        userId: actor.user.id,
        action: "assistant.deactivate",
        entity: "assistant",
        entityId: id,
      });
    }
    return NextResponse.json({ ok: true, status: result.status, changed: result.changed });
  } catch (err) {
    const message = err instanceof Error ? err.message : "deactivate_failed";
    if (message === "assistant_not_found") {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ error: "deactivate_failed", message }, { status: 500 });
  }
}
