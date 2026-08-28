import { NextResponse } from "next/server";
import { z } from "zod";
import { logAudit } from "@/lib/audit";
import { compileAssistant } from "@/lib/assistants/service";
import { apiPerm } from "@/lib/permissions/server";

/**
 * POST /api/assistants/:id/compile — recompile L0-L6 et gèle un instantané de
 * version. La suite est remise à zéro : un prompt qui change doit être
 * re-testé avant toute activation.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const actor = await apiPerm("admin.assistants");
  if (actor instanceof NextResponse) return actor;

  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  try {
    const compiled = await compileAssistant(id, actor.user.id);
    await logAudit({
      userId: actor.user.id,
      action: "assistant.compile",
      entity: "assistant",
      entityId: id,
      detail: { coreVersion: compiled.coreVersion, version: compiled.version },
    });
    return NextResponse.json(compiled);
  } catch (err) {
    const message = err instanceof Error ? err.message : "compile_failed";
    if (message === "assistant_not_found") {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    // La configuration a bougé entre la lecture et l'écriture (autre onglet,
    // import, collègue) : le prompt compilé ne correspond plus — recompiler.
    if (message === "assistant_changed_during_compile") {
      return NextResponse.json({ error: "assistant_changed" }, { status: 409 });
    }
    // Mode libre sans texte : rien à compiler, et on ne l'enregistre pas.
    if (message === "empty_prompt") {
      return NextResponse.json({ error: "empty_prompt" }, { status: 409 });
    }
    if (message.startsWith("objection_pack_invalid:")) {
      return NextResponse.json(
        { error: "objection_pack_invalid", pack: message.slice("objection_pack_invalid:".length) },
        { status: 409 },
      );
    }
    return NextResponse.json({ error: "compile_failed", message }, { status: 500 });
  }
}
