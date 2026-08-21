import "server-only";
import { and, eq, gte, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { clients } from "@/db/schema";
import { campaignEnrollments, campaigns, suppressions } from "@/db/schema-sms";
import type { CampaignAudience, CampaignTrigger } from "@/lib/campaigns/schema";

/**
 * Traduction du filtre d'audience en conditions SQL.
 *
 * Ce module est le SEUL endroit qui sait comment un filtre devient une requête.
 * L'aperçu de l'écran d'édition, le balayage périodique et l'inscription en
 * masse passent tous par ici — sinon le nombre annoncé à l'administrateur
 * finirait par différer de la population réellement inscrite, ce qui est
 * exactement le genre d'écart que personne ne remarque avant la facture.
 *
 * Les exclusions QUI ONT UN MOTIF (consentement, suppression) ne sont PAS
 * appliquées ici. L'audience dit qui est visé ; l'éligibilité dit pourquoi on
 * n'écrit pas. Les mélanger ferait disparaître les gens sans laisser de trace
 * du motif — et on ne saurait plus si une campagne vise trop peu de monde ou
 * n'a simplement pas le droit de leur écrire.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export function audienceConditions(
  audience: CampaignAudience,
  now: Date,
  options: { campaignId?: string } = {},
): SQL[] {
  const conditions: SQL[] = [];

  // Un client sans numéro n'est pas une audience SMS.
  conditions.push(sql`${clients.phone} <> ''`);

  if (audience.categoryIds.length > 0) {
    conditions.push(inArray(clients.categoryId, audience.categoryIds));
  }
  if (audience.sourceIds.length > 0) {
    conditions.push(inArray(clients.sourceId, audience.sourceIds));
  }
  if (audience.assignedToIds.length > 0) {
    conditions.push(inArray(clients.assignedToId, audience.assignedToIds));
  }
  if (audience.languages.length > 0) {
    conditions.push(inArray(clients.language, audience.languages));
  }

  if (audience.createdWithinDays !== null) {
    conditions.push(gte(clients.createdAt, new Date(now.getTime() - audience.createdWithinDays * DAY_MS)));
  }
  if (audience.createdBeforeDays !== null) {
    conditions.push(lte(clients.createdAt, new Date(now.getTime() - audience.createdBeforeDays * DAY_MS)));
  }
  if (audience.notContactedForDays !== null) {
    const cutoff = new Date(now.getTime() - audience.notContactedForDays * DAY_MS);
    // Jamais contacté COMPTE comme « pas contacté depuis N jours » : sinon une
    // campagne de réactivation rate exactement les leads les plus froids, ceux
    // que personne n'a jamais rappelés.
    conditions.push(or(isNull(clients.lastContactedAt), lte(clients.lastContactedAt, cutoff))!);
  }

  if (audience.excludeDoNotCall) {
    conditions.push(eq(clients.doNotCall, false));
  }

  if (options.campaignId !== undefined) {
    // Déjà inscrit à CETTE campagne — l'index unique le refuserait de toute
    // façon, mais l'exclure ici évite de compter des gens qu'on n'inscrira pas.
    conditions.push(
      sql`not exists (
        select 1 from ${campaignEnrollments}
        where ${campaignEnrollments.campaignId} = ${options.campaignId}
          and ${campaignEnrollments.clientId} = ${clients.id}
      )`,
    );
  }

  if (audience.excludeActiveInOtherCampaign) {
    conditions.push(
      sql`not exists (
        select 1 from ${campaignEnrollments}
        join ${campaigns} on ${campaigns.id} = ${campaignEnrollments.campaignId}
        where ${campaignEnrollments.clientId} = ${clients.id}
          and ${campaignEnrollments.status} in ('pending', 'active')
          and ${campaigns.status} = 'active'
          ${options.campaignId === undefined ? sql`` : sql`and ${campaigns.id} <> ${options.campaignId}`}
      )`,
    );
  }

  // Un numéro supprimé ne fait jamais partie d'une audience : le compter
  // gonflerait l'aperçu de gens à qui on n'écrira jamais.
  conditions.push(
    // Parenthèses écrites à la main : `notExists()` ne les ajoute pas autour
    // d'un `sql` brut, et le SQL produit est alors syntaxiquement invalide.
    sql`not exists (
      select 1 from ${suppressions} where ${suppressions.phoneE164} = ${clients.phone}
    )`,
  );

  return conditions;
}

/** Conditions supplémentaires imposées par le déclencheur lui-même. */
export function triggerConditions(trigger: CampaignTrigger): SQL[] {
  switch (trigger.kind) {
    case "lead_created":
      return trigger.sourceIds.length > 0 ? [inArray(clients.sourceId, trigger.sourceIds)] : [];
    case "category_changed":
      return trigger.toCategoryIds.length > 0
        ? [inArray(clients.categoryId, trigger.toCategoryIds)]
        : [];
    case "manual":
    case "scheduled":
      return [];
  }
}

export function audienceWhere(
  audience: CampaignAudience,
  trigger: CampaignTrigger,
  now: Date,
  options: { campaignId?: string } = {},
): SQL {
  return and(...audienceConditions(audience, now, options), ...triggerConditions(trigger))!;
}

