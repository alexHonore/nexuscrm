import { NextResponse } from "next/server";
import { z } from "zod";
import { logAudit } from "@/lib/audit";
import { apiAdmin } from "@/lib/auth/guards";
import { campaignFieldText, getCampaignFieldDoc } from "@/lib/campaigns/docs";
import { importCampaign, previewCampaignImport } from "@/lib/campaigns-server/transfer";
import { glossIssues, normalizeIssues, withReceivedValues } from "@/lib/import-diagnostics";
import { requestDocLocale } from "@/lib/locale-server";

/**
 * POST /api/campaigns/import — prévisualise ou importe un fichier de campagne.
 * `preview` ne touche à rien et sert à vérifier les liaisons ; `commit` écrit
 * un BROUILLON.
 */
/**
 * Une erreur de schéma, rendue exploitable : le chemin, ce que le fichier
 * contenait vraiment à cet endroit, et le NOM du champ tel que la référence
 * des campagnes l'écrit, dans la langue de l'écran. La ligne est calculée
 * côté client, qui a le texte du fichier.
 */
async function describeBundleIssues(error: z.ZodError, bundle: unknown) {
  const locale = await requestDocLocale();
  return glossIssues(withReceivedValues(normalizeIssues(error.issues), bundle), (path) => {
    // SEULEMENT sous « campaign. » : la référence documente la configuration,
    // pas l'enveloppe du document.
    if (!path.startsWith("campaign.")) return undefined;
    const doc = getCampaignFieldDoc(path.slice("campaign.".length));
    if (!doc) return undefined;
    const text = campaignFieldText(doc, locale);
    return { label: text.label, what: text.what };
  });
}

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
      return NextResponse.json(
        { error: "invalid_bundle", issues: await describeBundleIssues(err, parsed.data.bundle) },
        { status: 400 },
      );
    }
    const message = err instanceof Error ? err.message : "import_failed";
    return NextResponse.json({ error: "import_failed", message }, { status: 500 });
  }
}
