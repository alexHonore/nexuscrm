import "server-only";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { campaignEnrollments } from "@/db/schema-sms";

/**
 * Effet d'un message ENTRANT sur les inscriptions en cours.
 *
 * Marquer tout de suite plutôt qu'au prochain barreau, pour deux raisons :
 *
 *  · **La mesure.** Une échelle terminée avant que la personne réponde
 *    resterait « completed », et sa réponse ne compterait dans aucune variante.
 *    Le taux de réponse d'un test A/B serait sous-estimé, d'autant plus que
 *    l'échelle est courte — c'est-à-dire justement là où on compare.
 *  · **Le silence.** Attendre la prochaine relance pour constater la réponse,
 *    c'est laisser une relance programmée planer au-dessus d'une conversation
 *    déjà rendue à l'assistant.
 */

export async function markEnrollmentsReplied(conversationId: string, now = new Date()) {
  await db
    .update(campaignEnrollments)
    .set({ status: "replied", endedAt: now, endReason: "replied", nextTouchAt: null, updatedAt: now })
    .where(
      and(
        eq(campaignEnrollments.conversationId, conversationId),
        inArray(campaignEnrollments.status, ["pending", "active"]),
      ),
    );
}

/**
 * Un désabonnement arrête TOUTES les inscriptions du client, pas seulement
 * celle de la campagne qui écrivait : le refus porte sur le numéro.
 */
export async function markEnrollmentsStopped(clientId: string, now = new Date()) {
  await db
    .update(campaignEnrollments)
    .set({ status: "stopped", endedAt: now, endReason: "opted_out", nextTouchAt: null, updatedAt: now })
    .where(
      and(
        eq(campaignEnrollments.clientId, clientId),
        inArray(campaignEnrollments.status, ["pending", "active"]),
      ),
    );
}
