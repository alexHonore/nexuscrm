import { NextResponse } from "next/server";
import { z } from "zod";
import { logAudit } from "@/lib/audit";
import { runAssistantSuite } from "@/lib/assistants/service";
import { apiPerm } from "@/lib/permissions/server";

/** Une suite complète enchaîne ~14 appels modèle : il lui faut du temps. */
export const maxDuration = 300;

/**
 * POST /api/assistants/:id/suite — rejoue toutes les fixtures activées contre
 * le prompt compilé, outils SIMULÉS (aucun rendez-vous créé, aucun SMS envoyé),
 * et consigne l'exécution dans `guardrail_runs`.
 *
 * Droit d'ÉCRITURE (`admin.assistantsEdit`) : ~14 appels modèle facturés, et le
 * vert obtenu ouvre la porte d'activation (§11.4). LIRE les résultats d'une
 * suite déjà passée n'a jamais coûté ça — c'est l'autre droit.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const actor = await apiPerm("admin.assistantsEdit");
  if (actor instanceof NextResponse) return actor;

  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  try {
    const outcome = await runAssistantSuite(id, actor.user.id);
    await logAudit({
      userId: actor.user.id,
      action: "assistant.suite_run",
      entity: "assistant",
      entityId: id,
      detail: {
        runId: outcome.runId,
        passed: outcome.passed,
        failed: outcome.results.filter((r) => !r.passed).length,
      },
    });
    return NextResponse.json(outcome);
  } catch (err) {
    const message = err instanceof Error ? err.message : "suite_failed";
    if (message === "assistant_not_found") {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    if (message === "assistant_not_compiled") {
      return NextResponse.json({ error: "not_compiled" }, { status: 409 });
    }
    if (message.startsWith("llm_provider_unconfigured")) {
      return NextResponse.json({ error: "provider_unconfigured", message }, { status: 503 });
    }
    return NextResponse.json({ error: "suite_failed", message }, { status: 500 });
  }
}
