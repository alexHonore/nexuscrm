import "server-only";
import { and, eq, gte, inArray, isNull, lte, or, sql, type SQL } from "drizzle-orm";
import { clients } from "@/db/schema";
import { campaignEnrollments, campaigns, consents, suppressions } from "@/db/schema-sms";
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
 * Les exclusions QUI ONT UN MOTIF sont en principe laissées à l'éligibilité
 * (`enroll.ts` + `eligibility.ts`) : l'audience dit qui est visé, l'éligibilité
 * dit pourquoi on n'écrit pas. Deux exceptions, toutes deux parce qu'un motif
 * PERMANENT qui resterait dans l'audience rendrait le balayage inutile :
 *
 *  · le numéro supprimé — rien ne partira jamais, compter la personne gonfle
 *    l'aperçu ;
 *  · l'absence de consentement quand la campagne l'exige — le balayage prend
 *    les N plus anciens de l'audience et les refuse un à un ; si ces N-là
 *    n'ont pas de consentement, il repêche les MÊMES à chaque cycle et la
 *    campagne n'inscrit plus jamais personne, alors que l'aperçu annonce des
 *    milliers de gens. Une base importée sans consentement (le cas réel) aurait
 *    stoppé net toute réactivation, sans rien dire.
 *
 * Les autres motifs (déjà ailleurs, plafonds) restent hors audience : ils
 * changent d'un jour à l'autre, donc ne peuvent pas empoisonner la tête de
 * liste durablement.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export interface AudienceOptions {
  campaignId?: string;
  /** `campaign.requireConsent` — applique le filtre de consentement SMS valide. */
  requireConsent?: boolean;
}

export function audienceConditions(
  audience: CampaignAudience,
  now: Date,
  options: AudienceOptions = {},
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
    // Une campagne EN PAUSE compte comme « ailleurs » : ses inscriptions sont
    // toujours en vol et reprendront à la reprise. Ne compter que les campagnes
    // actives ferait inscrire les mêmes gens ailleurs pendant la pause, puis
    // deux échelles leur écriraient en même temps au retour.
    conditions.push(
      sql`not exists (
        select 1 from ${campaignEnrollments}
        join ${campaigns} on ${campaigns.id} = ${campaignEnrollments.campaignId}
        where ${campaignEnrollments.clientId} = ${clients.id}
          and ${campaignEnrollments.status} in ('pending', 'active')
          and ${campaigns.status} in ('active', 'paused')
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

  if (options.requireConsent) {
    // Même définition que `consentedClientIds` (enroll.ts) : accordé, non
    // révoqué, non expiré. Le constructeur drizzle et non un paramètre brut
    // pour la date — dans un `sql` template, une Date part sans type.
    conditions.push(
      sql`exists (
        select 1 from ${consents}
        where ${consents.clientId} = ${clients.id}
          and ${consents.channel} = 'sms'
          and ${consents.revokedAt} is null
          and ${or(isNull(consents.expiresAt), gte(consents.expiresAt, now))}
      )`,
    );
  }

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
  options: AudienceOptions = {},
): SQL {
  return and(...audienceConditions(audience, now, options), ...triggerConditions(trigger))!;
}
