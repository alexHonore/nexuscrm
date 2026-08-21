import { NextResponse } from "next/server";
import { z } from "zod";
import { apiAdmin } from "@/lib/auth/guards";
import { campaignConfigSchema } from "@/lib/campaigns/schema";
import { audienceCount, audienceCountFor } from "@/lib/campaigns-server/enroll";

/**
 * /api/campaigns/:id/preview — combien de personnes l'audience vise.
 *
 * Le compte passe par la MÊME requête que le balayage : un aperçu qui
 * divergerait de la population réellement inscrite est pire qu'aucun aperçu.
 *
 *  · GET  — la configuration ENREGISTRÉE.
 *  · POST — la configuration envoyée (`{ config }`), pas encore enregistrée :
 *    l'écran d'édition recalcule ce qu'il affiche. Compter la version en base
 *    pendant que l'administrateur ajuste ses filtres lui montrait un chiffre
 *    qui ne correspondait à rien de ce qu'il voyait.
 */

function badId(id: string): NextResponse | null {
  return z.uuid().safeParse(id).success
    ? null
    : NextResponse.json({ error: "invalid_id" }, { status: 400 });
}

function failure(err: unknown): NextResponse {
  const message = err instanceof Error ? err.message : "preview_failed";
  if (message === "campaign_not_found") {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({ error: "preview_failed", message }, { status: 500 });
}

export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;

  const { id } = await ctx.params;
  const invalid = badId(id);
  if (invalid) return invalid;

  try {
    return NextResponse.json({ count: await audienceCount(id) });
  } catch (err) {
    return failure(err);
  }
}

const previewBodySchema = z.object({ config: campaignConfigSchema });

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;

  const { id } = await ctx.params;
  const invalid = badId(id);
  if (invalid) return invalid;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = previewBodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", issues: parsed.error.issues }, { status: 400 });
  }

  try {
    return NextResponse.json({
      count: await audienceCountFor(parsed.data.config, { campaignId: id }),
    });
  } catch (err) {
    return failure(err);
  }
}
