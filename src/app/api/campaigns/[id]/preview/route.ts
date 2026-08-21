import { NextResponse } from "next/server";
import { z } from "zod";
import { apiAdmin } from "@/lib/auth/guards";
import { audienceCount } from "@/lib/campaigns-server/enroll";

/**
 * GET /api/campaigns/:id/preview — combien de personnes l'audience vise.
 *
 * Le compte passe par la MÊME requête que le balayage : un aperçu qui
 * divergerait de la population réellement inscrite est pire qu'aucun aperçu.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;

  const { id } = await ctx.params;
  if (!z.uuid().safeParse(id).success) {
    return NextResponse.json({ error: "invalid_id" }, { status: 400 });
  }

  try {
    return NextResponse.json({ count: await audienceCount(id) });
  } catch (err) {
    const message = err instanceof Error ? err.message : "preview_failed";
    if (message === "campaign_not_found") {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    return NextResponse.json({ error: "preview_failed", message }, { status: 500 });
  }
}
