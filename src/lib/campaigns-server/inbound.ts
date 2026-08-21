import "server-only";
import { and, eq, gte, inArray, isNotNull, or } from "drizzle-orm";
import { db } from "@/db";
import { campaignEnrollments } from "@/db/schema-sms";
import { REPLY_ATTRIBUTION_WINDOW_MS } from "@/lib/campaigns/eligibility";

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

/**
 * Inscriptions qu'une réponse peut encore qualifier : celles en vol, et celles
 * dont l'échelle vient de se terminer. Le dernier barreau clôt l'inscription
 * sur-le-champ — un test A/B à un seul barreau était donc « completed » avant
 * la moindre réponse, et ne comptait jamais aucune réponse : la comparaison
 * donnait 0 contre 0. La fenêtre d'attribution borne le rattachement : une
 * réponse des mois plus tard ne crédite plus le barreau.
 */
function attributable(now: Date) {
  const since = new Date(now.getTime() - REPLY_ATTRIBUTION_WINDOW_MS);
  return or(
    inArray(campaignEnrollments.status, ["pending", "active"]),
    and(
      eq(campaignEnrollments.status, "completed"),
      isNotNull(campaignEnrollments.lastTouchAt),
      gte(campaignEnrollments.lastTouchAt, since),
    ),
  )!;
}

export async function markEnrollmentsReplied(conversationId: string, now = new Date()) {
  await db
    .update(campaignEnrollments)
    .set({ status: "replied", endedAt: now, endReason: "replied", nextTouchAt: null, updatedAt: now })
    .where(and(eq(campaignEnrollments.conversationId, conversationId), attributable(now)));
}

/**
 * Un rendez-vous pris dans ce fil : la conversion que la campagne cherchait.
 *
 * Inclut « replied » — le webhook entrant a déjà basculé l'inscription à la
 * première réponse, et c'est justement cette inscription-là qui convertit.
 * Sans cette écriture, `booked` restait à zéro partout et l'on ne pouvait
 * jamais dire quelle ouverture prend réellement des rendez-vous. Appelée par
 * le moteur de réservation après un `book()` réussi.
 */
export async function markEnrollmentsBooked(conversationId: string, now = new Date()) {
  await db
    .update(campaignEnrollments)
    .set({ status: "booked", endedAt: now, endReason: "booked", nextTouchAt: null, updatedAt: now })
    .where(
      and(
        eq(campaignEnrollments.conversationId, conversationId),
        or(eq(campaignEnrollments.status, "replied"), attributable(now)),
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
