import { NextResponse } from "next/server";
import { z } from "zod";
import { logAudit } from "@/lib/audit";
import { activateAssistant } from "@/lib/assistants/service";
import { apiPerm } from "@/lib/permissions/server";

/**
 * POST /api/assistants/:id/activate — porte d'activation (§11.4).
 *
 * Refuse tant que le prompt n'est pas compilé contre la version COURANTE du
 * noyau, et tant que la suite n'est pas verte quand `require_suite_pass` est
 * vrai. La même règle est doublée par un trigger en base : une écriture
 * directe ne peut pas contourner la porte.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const actor = await apiPerm("admin.assistants");
  if (actor instanceof NextResponse) return actor;

  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  try {
    const check = await activateAssistant(id);
    if (!check.allowed) {
      return NextResponse.json(
        { error: "activation_blocked", reason: check.reason, failingFixtures: check.failingFixtures },
        { status: 409 },
      );
    }
    await logAudit({
      userId: actor.user.id,
      action: "assistant.activate",
      entity: "assistant",
      entityId: id,
    });
    return NextResponse.json({ ok: true, status: "active" });
  } catch (err) {
    const message = err instanceof Error ? err.message : "activate_failed";
    if (message === "assistant_not_found") {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ error: "activate_failed", message }, { status: 500 });
  }
}
