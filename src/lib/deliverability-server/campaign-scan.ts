import "server-only";
import { inArray } from "drizzle-orm";
import { db } from "@/db";
import { assistants, campaigns } from "@/db/schema-sms";
import { ladderSchema, variantsSchema } from "@/lib/campaigns/schema";
import { scanBody } from "@/lib/deliverability/content";
import type { CampaignBodyIssue } from "@/lib/deliverability/types";

/**
 * Analyse des textes de campagne AU REPOS — le contrôle le plus rentable de
 * l'écran, et le seul qui soit préventif.
 *
 * Le fait qui justifie ce fichier : un barreau d'échelle écrit à la main
 * n'est vu par AUCUN garde-fou. Le chemin `runTouch` → job `send_sms` →
 * `handleSendSms` ne fait aucune vérification de contenu ; `max_chars`,
 * `link_policy`, `no_price_opinion` et `identify_sender` ne s'appliquent qu'au
 * brouillon d'un ASSISTANT. Un `{{prenom}}` oublié, un lien `bit.ly` ou une
 * apostrophe courbe dans un barreau part donc tel quel, à toute l'audience,
 * sans qu'une seule alerte ne se lève.
 *
 * Ici, le problème est vu AVANT le premier envoi — pas dans les statistiques
 * de la semaine suivante.
 *
 * Les campagnes archivées ne sont pas lues : corriger un texte qui ne partira
 * plus est du bruit, et le bruit est ce qui fait fermer un tableau de bord.
 */

/**
 * Les marques que l'analyseur accepte comme « l'expéditeur s'est identifié ».
 * Elles viennent des assistants ACTIFS, pas d'une constante : le nom de
 * l'organisation est un réglage, et une constante en dur dans ce fichier
 * commencerait à mentir le jour où il change.
 */
export async function brandTokens(): Promise<string[]> {
  const rows = await db.select({ identity: assistants.identity }).from(assistants);
  const tokens = new Set<string>();
  for (const row of rows) {
    const identity = row.identity as Record<string, unknown> | null;
    for (const key of ["orgName", "brokerName"]) {
      const value = identity?.[key];
      if (typeof value === "string" && value.trim().length >= 3) tokens.add(value.trim());
    }
  }
  return [...tokens];
}

export interface CampaignScan {
  issues: CampaignBodyIssue[];
  /** Campagnes vivantes portant au moins un barreau écrit à la main. */
  unguarded: { campaignId: string; campaignName: string; rungs: number }[];
}

export async function scanCampaignBodies(tokens: string[]): Promise<CampaignScan> {
  const rows = await db
    .select({
      id: campaigns.id,
      name: campaigns.name,
      ladder: campaigns.ladder,
      variants: campaigns.variants,
    })
    .from(campaigns)
    .where(inArray(campaigns.status, ["draft", "active", "paused"]));

  const issues: CampaignBodyIssue[] = [];
  const unguarded: CampaignScan["unguarded"] = [];

  for (const row of rows) {
    const ladder = ladderSchema.safeParse(row.ladder);
    const variants = variantsSchema.safeParse(row.variants);
    let handWritten = 0;

    if (ladder.success) {
      ladder.data.forEach((step, index) => {
        if (!step.body) return;
        handWritten += 1;
        issues.push({
          campaignId: row.id,
          campaignName: row.name,
          origin: "ladder",
          slot: String(index),
          excerpt: step.body.slice(0, 200),
          // Le barreau 0 est l'ouverture : c'est le seul message où l'absence
          // de marque et de mention d'arrêt est un vrai manquement.
          flags: scanBody(step.body, { brandTokens: tokens, isOpener: index === 0 }),
        });
      });
    }

    if (variants.success) {
      for (const variant of variants.data) {
        if (!variant.body) continue;
        handWritten += 1;
        issues.push({
          campaignId: row.id,
          campaignName: row.name,
          origin: "variant",
          slot: variant.key,
          excerpt: variant.body.slice(0, 200),
          // Une variante ne fait varier QUE l'ouverture — toujours un opener.
          flags: scanBody(variant.body, { brandTokens: tokens, isOpener: true }),
        });
      }
    }

    if (handWritten > 0) {
      unguarded.push({ campaignId: row.id, campaignName: row.name, rungs: handWritten });
    }
  }

  return { issues, unguarded };
}
