import { NextResponse } from "next/server";
import { z } from "zod";
import { apiAdmin } from "@/lib/auth/guards";
import { exampleAssistantFile, exampleCampaignFile } from "@/lib/docs/examples";

/**
 * GET /api/docs/examples/:kind — un fichier d'exemple (assistant ou campagne),
 * généré à la demande par les mêmes fonctions que les vrais exports.
 */
const kindSchema = z.enum(["assistant", "campaign"]);

export async function GET(_req: Request, ctx: { params: Promise<{ kind: string }> }) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;

  const { kind } = await ctx.params;
  const parsed = kindSchema.safeParse(kind);
  if (!parsed.success) return NextResponse.json({ error: "invalid_kind" }, { status: 400 });

  // Date fixe : le fichier d'exemple est STABLE d'un téléchargement à l'autre.
  const now = new Date("2026-01-01T12:00:00.000Z");
  const body = parsed.data === "assistant" ? exampleAssistantFile(now) : exampleCampaignFile(now);
  const filename = parsed.data === "assistant" ? "exemple-assistant.json" : "exemple-campagne.json";
  return new NextResponse(body, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
      "cache-control": "no-store",
    },
  });
}
