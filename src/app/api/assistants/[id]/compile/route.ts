import { NextResponse } from "next/server";
import { z } from "zod";
import { logAudit } from "@/lib/audit";
import { apiAdmin } from "@/lib/auth/guards";
import { compileAssistant } from "@/lib/assistants/service";

/**
 * POST /api/assistants/:id/compile — recompile L0-L6 et gèle un instantané de
 * version. La suite est remise à zéro : un prompt qui change doit être
 * re-testé avant toute activation.
 */
export async function POST(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;

  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  try {
    const compiled = await compileAssistant(id, admin.id);
    await logAudit({
      userId: admin.id,
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
    return NextResponse.json({ error: "compile_failed", message }, { status: 500 });
  }
}
