import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { messages } from "@/db/schema-sms";

/**
 * Ce que NOUS avions envoyé juste avant le dernier message du client.
 *
 * Une carte de la boîte ne montrait que le DERNIER message. « Oui toujours! »
 * ou « Non merci » se lisent alors sans la question qui les a provoqués : il
 * fallait ouvrir la fiche pour savoir si le client répondait à une ouverture de
 * campagne, à une proposition de rendez-vous ou à une relance. Une ligne de
 * contexte au-dessus règle ça sans quitter la liste.
 *
 * Le dernier entrant est recalculé depuis les MESSAGES et non lu dans
 * `conversations.last_inbound_at` : la colonne dénormalisée ne recule jamais
 * (`greatest`, voir `sms-server/inbound.ts`), ce qui est le bon comportement
 * pour l'ordre de la boîte mais ferait mentir cette requête après un backfill.
 * Ici, ce qu'on affiche doit être ce que le fil contient.
 *
 * Deux passes groupées sur `messages` — l'index `messages_conversation_idx`
 * (conversation_id, created_at) les porte. C'est le prix d'une ligne de
 * contexte sur 200 cartes ; le mesurer avant de l'optimiser.
 */
export function previousOutboundByConversation() {
  const lastInbound = db
    .select({
      conversationId: messages.conversationId,
      at: sql<Date>`max(${messages.createdAt})`.as("last_inbound_at"),
    })
    .from(messages)
    .where(eq(messages.direction, "in"))
    .groupBy(messages.conversationId)
    .as("last_inbound");

  return db
    .select({
      conversationId: messages.conversationId,
      body: sql<string>`(array_agg(${messages.body} order by ${messages.createdAt} desc))[1]`.as(
        "previous_body",
      ),
      // QUI l'avait écrit : une ouverture de campagne, une réponse d'assistant
      // et un message tapé par un collègue n'appellent pas la même suite.
      source: sql<string>`(array_agg(${messages.source} order by ${messages.createdAt} desc))[1]`.as(
        "previous_source",
      ),
    })
    .from(messages)
    .innerJoin(lastInbound, eq(lastInbound.conversationId, messages.conversationId))
    .where(and(eq(messages.direction, "out"), sql`${messages.createdAt} < ${lastInbound.at}`))
    .groupBy(messages.conversationId)
    .as("previous_outbound");
}
