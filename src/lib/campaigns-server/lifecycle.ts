import "server-only";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { campaignEnrollments, campaignTouches, scheduledJobs } from "@/db/schema-sms";

/**
 * Fin de vie d'une campagne.
 *
 * Archiver ne changeait que `campaigns.status` : ses inscriptions restaient
 * « active » pour toujours — la liste et le bilan continuaient de les compter
 * en cours, et comme « actif ailleurs » elles empêchaient d'autres campagnes
 * d'écrire à ces gens. Les jobs de barreau déjà en file, eux, auraient tourné
 * pour se faire refuser un à un.
 */

export interface CloseResult {
  closed: number;
  cancelledJobs: number;
}

/**
 * Clôt toutes les inscriptions en vol d'une campagne et annule les jobs de
 * barreau encore en attente.
 *
 * Statut « completed », motif `campaign_archived`, et non « stopped » : un
 * arrêt compte comme la contrepartie des réponses dans le bilan (désabonnement,
 * refus ferme). Fermer une campagne n'est pas un refus de la personne — la
 * compter ainsi ferait grimper le taux d'arrêts de 200 points le jour de
 * l'archivage.
 *
 * Les envois déjà en file (`csend:`) ne sont PAS annulés : leur barreau est
 * déjà tracé « envoyé » et le message part dans la minute (le barreau n'est
 * mis en file que dans la fenêtre d'envoi). Annuler laisserait une trace qui
 * ment. Les réveils de l'assistant (`outreach:`) le sont : rien n'est encore
 * parti, et le barreau passe « cancelled ».
 */
export async function closeCampaignEnrollments(
  campaignId: string,
  now = new Date(),
): Promise<CloseResult> {
  const closed = await db
    .update(campaignEnrollments)
    .set({
      status: "completed",
      endReason: "campaign_archived",
      endedAt: now,
      nextTouchAt: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(campaignEnrollments.campaignId, campaignId),
        inArray(campaignEnrollments.status, ["pending", "active"]),
      ),
    )
    .returning({ id: campaignEnrollments.id });

  if (closed.length === 0) return { closed: 0, cancelledJobs: 0 };
  const ids = closed.map((r) => r.id);

  // Les clés de barreau portent l'inscription : `ctouch:<id>:<step>` et
  // `outreach:<id>:<step>`. On annule par clé plutôt que par charge utile —
  // c'est la clé qui est indexée et stable.
  const cancelled = await db
    .update(scheduledJobs)
    .set({ status: "cancelled" })
    .where(
      and(
        eq(scheduledJobs.status, "pending"),
        sql`(${scheduledJobs.dedupeKey} like 'ctouch:%' or ${scheduledJobs.dedupeKey} like 'outreach:%')`,
        sql`split_part(${scheduledJobs.dedupeKey}, ':', 2) in ${ids}`,
      ),
    )
    .returning({ id: scheduledJobs.id });

  // Un barreau « queued » dont le réveil vient d'être annulé ne partira jamais.
  await db
    .update(campaignTouches)
    .set({ status: "cancelled" })
    .where(and(inArray(campaignTouches.enrollmentId, ids), eq(campaignTouches.status, "queued")));

  return { closed: ids.length, cancelledJobs: cancelled.length };
}
