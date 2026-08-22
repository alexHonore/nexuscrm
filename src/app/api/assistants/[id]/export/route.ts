import { NextResponse } from "next/server";
import { z } from "zod";
import { logAudit } from "@/lib/audit";
import { apiAdmin } from "@/lib/auth/guards";
import { exportAssistantFile } from "@/lib/assistants/transfer";
import { requestDocLocale } from "@/lib/locale-server";

/**
 * GET /api/assistants/:id/export — télécharge l'assistant en JSON.
 *
 * Annoté par défaut (`?annotate=0` pour le fichier nu). Un export est une
 * sortie de données : il est journalisé comme telle.
 */
export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;

  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  const annotate = new URL(req.url).searchParams.get("annotate") !== "0";

  try {
    // Les annotations sont lues par un humain : elles suivent la langue de
    // l'interface. La configuration exportée, elle, ne bouge pas d'un poil.
    const file = await exportAssistantFile(id, { annotate, locale: await requestDocLocale() });
    await logAudit({
      userId: admin.id,
      action: "assistant.export",
      entity: "assistant",
      entityId: id,
      detail: { annotate, bytes: file.body.length },
    });
    return new NextResponse(file.body, {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="${file.filename}"`,
        "cache-control": "no-store",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "export_failed";
    if (message === "assistant_not_found") {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ error: "export_failed", message }, { status: 500 });
  }
}
