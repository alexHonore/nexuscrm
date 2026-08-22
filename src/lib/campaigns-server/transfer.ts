import "server-only";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { categories, sources, users } from "@/db/schema";
import { assistants, campaigns, smsNumbers } from "@/db/schema-sms";
import { campaignRowToConfig } from "@/lib/campaigns/schema";
import type { DocsLocale } from "@/lib/campaigns/docs";
import {
  buildCampaignBundle,
  parseCampaignBundle,
  planCampaignImport,
  serializeCampaignBundle,
  type BindingLabels,
  type CampaignBinding,
  type CampaignBundle,
  type CampaignImportCatalog,
  type CampaignImportWarning,
} from "@/lib/campaigns/portable";

/**
 * Import / export d'une campagne côté serveur : lit la base, appelle le module
 * pur, écrit. Un import produit TOUJOURS un brouillon non inscrit — activer
 * est un geste d'administrateur, ici, après relecture.
 */

async function localCatalog(): Promise<CampaignImportCatalog> {
  const [assistantRows, numberRows, categoryRows, sourceRows, userRows] = await Promise.all([
    db.select({ id: assistants.id, name: assistants.name }).from(assistants),
    db.select({ id: smsNumbers.id, e164: smsNumbers.e164, label: smsNumbers.label }).from(smsNumbers),
    db.select({ id: categories.id, name: categories.nameFr }).from(categories),
    db.select({ id: sources.id, name: sources.name }).from(sources),
    db
      .select({ id: users.id, name: users.name, email: users.email })
      .from(users)
      .where(eq(users.isActive, true)),
  ]);
  return {
    assistants: assistantRows,
    smsNumbers: numberRows.map((n) => ({ ...n, label: n.label ?? "" })),
    categories: categoryRows,
    sources: sourceRows,
    users: userRows,
  };
}

function labelsFrom(catalog: CampaignImportCatalog): BindingLabels {
  return {
    assistant: Object.fromEntries(catalog.assistants.map((a) => [a.id, { label: a.name, hint: "assistant" }])),
    sms_number: Object.fromEntries(
      catalog.smsNumbers.map((n) => [n.id, { label: n.e164, hint: n.label }]),
    ),
    category: Object.fromEntries(
      catalog.categories.map((c) => [String(c.id), { label: c.name, hint: "catégorie" }]),
    ),
    source: Object.fromEntries(catalog.sources.map((s) => [String(s.id), { label: s.name, hint: "source" }])),
    user: Object.fromEntries(catalog.users.map((u) => [u.id, { label: u.email, hint: u.name }])),
  };
}

export async function exportCampaign(
  campaignId: string,
  options: { annotate?: boolean; now?: Date; locale?: DocsLocale } = {},
): Promise<CampaignBundle> {
  const row = await db.query.campaigns.findFirst({ where: eq(campaigns.id, campaignId) });
  if (!row) throw new Error("campaign_not_found");
  const catalog = await localCatalog();
  return buildCampaignBundle({
    config: campaignRowToConfig(row),
    labels: labelsFrom(catalog),
    sourceOrg: "",
    now: options.now ?? new Date(),
    annotate: options.annotate,
    locale: options.locale,
  });
}

export async function exportCampaignFile(
  campaignId: string,
  options: { annotate?: boolean; now?: Date; locale?: DocsLocale } = {},
): Promise<{ filename: string; body: string }> {
  const bundle = await exportCampaign(campaignId, options);
  const slug = bundle.campaign.name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-|-$/g, "")
    .toLowerCase();
  // Le nom du fichier suit la langue de qui télécharge : « campagne-… » dans
  // un dossier de téléchargements anglais n'aide personne à le retrouver.
  const stem = options.locale === "en" ? "campaign" : "campagne";
  const fallback = options.locale === "en" ? "untitled" : "sans-nom";
  return {
    filename: `${stem}-${slug || fallback}.json`,
    body: serializeCampaignBundle(bundle),
  };
}

export interface CampaignImportPreview {
  bundle: CampaignBundle;
  bindings: CampaignBinding[];
  /** Ce que la résolution automatique a trouvé, par valeur d'origine. */
  resolved: Record<string, string | null>;
  catalog: CampaignImportCatalog;
  warnings: CampaignImportWarning[];
}

/** Relit un fichier et prépare l'écran de liaison, SANS rien écrire. */
export async function previewCampaignImport(raw: unknown): Promise<CampaignImportPreview> {
  const { bundle, warnings } = parseCampaignBundle(raw);
  const catalog = await localCatalog();
  const plan = planCampaignImport(bundle, catalog, {});
  return {
    bundle,
    bindings: bundle.bindings,
    resolved: plan.resolved,
    catalog,
    warnings: [...warnings, ...plan.warnings],
  };
}

export interface CampaignImportResult {
  campaignId: string;
  name: string;
  warnings: CampaignImportWarning[];
}

export async function importCampaign(
  raw: unknown,
  options: { resolution?: Record<string, string | null>; actorId: string | null; nameOverride?: string },
): Promise<CampaignImportResult> {
  const { bundle, warnings: parseWarnings } = parseCampaignBundle(raw);
  const catalog = await localCatalog();
  const plan = planCampaignImport(bundle, catalog, options.resolution ?? {});
  const config = plan.config;
  config.name = options.nameOverride ?? (await uniqueName(config.name));

  const [row] = await db
    .insert(campaigns)
    .values({
      name: config.name,
      description: config.description,
      // Brouillon imposé : voir l'en-tête.
      status: "draft",
      assistantId: config.assistantId,
      smsNumberId: config.smsNumberId,
      trigger: config.trigger,
      audience: config.audience,
      ladder: config.ladder,
      variants: config.variants,
      dailyEnrollmentCap: config.dailyEnrollmentCap,
      totalEnrollmentCap: config.totalEnrollmentCap,
      startsAt: config.startsAt,
      endsAt: config.endsAt,
      createdById: options.actorId,
    })
    .returning({ id: campaigns.id, name: campaigns.name });

  return { campaignId: row.id, name: row.name, warnings: [...parseWarnings, ...plan.warnings] };
}

/** « Réactivation 90 j » importée deux fois donne « Réactivation 90 j (2) ». */
async function uniqueName(base: string): Promise<string> {
  const rows = await db.select({ name: campaigns.name }).from(campaigns);
  const taken = new Set(rows.map((r) => r.name));
  if (!taken.has(base)) return base;
  for (let n = 2; n < 100; n += 1) {
    const candidate = `${base} (${n})`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base} (${Date.now()})`;
}
