import { NextResponse } from "next/server";
import { z } from "zod";
import { logAudit } from "@/lib/audit";
import { apiAdmin } from "@/lib/auth/guards";
import { importCampaign, previewCampaignImport } from "@/lib/campaigns-server/transfer";

/**
 * POST /api/campaigns/import — prévisualise ou importe un fichier de campagne.
 * `preview` ne touche à rien et sert à vérifier les liaisons ; `commit` écrit
 * un BROUILLON.
 */
const bodySchema = z.object({
  mode: z.enum(["preview", "commit"]).default("preview"),
  bundle: z.unknown(),
  resolution: z.record(z.string(), z.string().nullable()).default({}),
  nameOverride: z.string().trim().min(1).max(120).optional(),
});

export async function POST(req: Request) {
  const admin = await apiAdmin();
  if (admin instanceof NextResponse) return admin;

  let raw: unknown;
  try {
    raw = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  const parsed = bodySchema.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json({ error: "invalid_body", issues: parsed.error.issues }, { status: 400 });
  }

  try {
    if (parsed.data.mode === "preview") {
      return NextResponse.json(await previewCampaignImport(parsed.data.bundle));
    }
    const result = await importCampaign(parsed.data.bundle, {
      actorId: admin.id,
      resolution: parsed.data.resolution,
      nameOverride: parsed.data.nameOverride,
    });
    await logAudit({
      userId: admin.id,
      action: "campaign.import",
      entity: "campaign",
      entityId: result.campaignId,
      detail: { name: result.name, warnings: result.warnings.map((w) => w.code) },
    });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return NextResponse.json({ error: "invalid_bundle", issues: err.issues }, { status: 400 });
    }
    const message = err instanceof Error ? err.message : "import_failed";
    return NextResponse.json({ error: "import_failed", message }, { status: 500 });
  }
}
