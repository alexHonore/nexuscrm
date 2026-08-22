import { NextResponse } from "next/server";
import { getLocale } from "next-intl/server";
import { z } from "zod";
import { logAudit } from "@/lib/audit";
import { apiAdmin } from "@/lib/auth/guards";
import { exportCampaignFile } from "@/lib/campaigns-server/transfer";
import { docLocale } from "@/lib/docs/locale";

/**
 * GET /api/campaigns/:id/export — télécharge la campagne en JSON, annotée par
 * défaut (`?annotate=0` pour le fichier nu). Journalisé comme une sortie.
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
    // Annotations = texte lu par un humain : langue de l'interface.
    const file = await exportCampaignFile(id, { annotate, locale: docLocale(await getLocale()) });
    await logAudit({
      userId: admin.id,
      action: "campaign.export",
      entity: "campaign",
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
    if (message === "campaign_not_found") {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ error: "export_failed", message }, { status: 500 });
  }
}
